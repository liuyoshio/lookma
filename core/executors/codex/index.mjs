// Codex adapter. `codex app-server` runs as a child process and speaks JSON-RPC on stdio (rpc.mjs),
// with one thread for the whole run. Codex spawns mcp.mjs, which gives the model say and the hands
// and connects back on /ws/executor.
//   prompt → turn/start, or turn/steer while a Codex turn runs     cancel → turn/interrupt
//   item/started → step     server requests → cards (approvals.mjs)     turn/completed → turnEnd
import fs from 'node:fs'
import path from 'node:path'
import { clip, logUnknown } from '../../util.mjs'
import { serveTools } from '../tool-link.mjs'
import { loadConfig } from './config.mjs'
import { openServer as spawnServer } from './rpc.mjs'
import { writeSession, appServer, initializeParams, threadParams } from './session.mjs'
import { stepTitle } from './events.mjs'
import { createApprovals } from './approvals.mjs'

// How long a cancel waits for its turn to end before the next prompt goes out anyway.
const INTERRUPT_WAIT_MS = 5000

// openServer: rpc.mjs's, or a stand-in for core/dev/check-codex.mjs.
export function create(ctx, { openServer = spawnServer } = {}) {
  const { emit, config, log } = ctx
  const opts = loadConfig()
  const unknown = logUnknown(log, 'tools bridge')
  const queue = [] // prompts told before the thread and the tools were ready
  const dropped = new Set() // turns the core already ended with a cancel: their end is not reported
  const ending = new Map() // turn id -> resolve, for the cancel waiting on that turn's end
  let rpc = null
  let threadId = null
  let bridge = null // mcp.mjs's socket
  let turnId = null // the Codex turn running now
  let status = null
  let stopping = false
  let tail = Promise.resolve()

  function setStatus(next, detail = '') {
    if (next === status) return
    status = next
    emit({ type: 'status', status: next, detail })
  }

  const approvals = createApprovals({ emit, log, respond: (id, result) => rpc.respond(id, result), fail: (id, error) => rpc.fail(id, error) })

  // ---------------------------------------------------------------- prompts and cancels
  //
  // They run one after another, and the adapter decides steer or start from its own turnId, not
  // from the core's steer flag. After a cancel the core has already ended its turn and may start
  // the next one before Codex reports the old one interrupted: the chain keeps the new prompt out
  // of the dying turn, and `dropped` keeps that late end from ending the new one.

  const run = fn => (tail = tail.then(fn).catch(err => log('failed:', err.message)))
  const isReady = () => threadId && bridge

  async function deliver(text) {
    const input = [{ type: 'text', text, text_elements: [] }]
    if (turnId && !dropped.has(turnId)) {
      try {
        await rpc.request('turn/steer', { threadId, input, expectedTurnId: turnId })
        return log('steered', turnId)
      } catch (err) {
        log('steer refused, starting a new turn:', err.message) // the turn has just ended
      }
    }
    try {
      turnId = (await rpc.request('turn/start', { threadId, input })).turn.id
    } catch (err) {
      log('turn/start failed:', err.message)
      emit({ type: 'turnEnd', ok: false })
    }
  }

  async function interrupt() {
    const id = turnId
    if (!id) return
    dropped.add(id)
    const end = new Promise(resolve => {
      ending.set(id, resolve)
      setTimeout(resolve, INTERRUPT_WAIT_MS)
    })
    await rpc.request('turn/interrupt', { threadId, turnId: id })
    await end
  }

  function becomeReady() {
    if (!isReady()) return
    setStatus('ready')
    for (const text of queue.splice(0)) run(() => deliver(text))
  }

  // ---------------------------------------------------------------- app-server

  const NOTIFICATIONS = {
    'turn/started'({ turn }) {
      if (dropped.has(turn.id)) return // cancelled before it got going
      turnId = turn.id
      log('turn started', turn.id)
      emit({ type: 'turnStart' }) // a no-op for the core's own turn; a new turn after a refused steer
    },
    'turn/completed'({ turn }) {
      if (turnId === turn.id) turnId = null
      approvals.closeTurn(turn.id)
      ending.get(turn.id)?.()
      ending.delete(turn.id)
      log(`turn ${turn.status} ${turn.id}${turn.error ? `: ${turn.error.message}` : ''}`)
      if (!dropped.delete(turn.id)) emit({ type: 'turnEnd', ok: turn.status === 'completed' })
    },
    'item/started'({ item, turnId: itemTurn }) {
      if (item.type === 'fileChange') approvals.fileChange(item, itemTurn)
      const title = !dropped.has(itemTurn) && stepTitle(item) // a cancelled turn's steps would land on the next one
      if (!title) return
      log('step', title)
      emit({ type: 'step', title })
    },
    // The model is told to speak only with say; its text replies are for this log.
    'item/completed'({ item }) {
      if (item.type === 'agentMessage') log('message', clip(item.text, 200))
    },
    'serverRequest/resolved': ({ requestId }) => approvals.resolved(requestId),
    'mcpServer/startupStatus/updated'({ name, status: s, error }) {
      log(`mcp server ${name} ${s}${error ? `: ${error}` : ''}`)
      if (name === 'lookma' && s === 'failed') setStatus('down', `the tools did not start: ${error}`)
    },
    error: ({ error, willRetry }) => log(`error: ${error.message}${willRetry ? ' (retrying)' : ''}`),
  }

  async function handshake(params) {
    await rpc.request('initialize', initializeParams())
    rpc.notify('initialized')
    const r = await rpc.request('thread/start', params)
    threadId = r.thread.id
    log(`thread ${threadId}, model ${r.model}${r.serviceTier ? `, ${r.serviceTier} tier` : ''}`)
    becomeReady()
  }

  function exited(code) {
    approvals.clear()
    if (turnId && !dropped.has(turnId)) emit({ type: 'turnEnd', ok: false })
    turnId = null
    for (const resolve of ending.values()) resolve()
    setStatus('down', stopping ? 'stopped' : `Codex exited (${code})`)
  }

  // ---------------------------------------------------------------- the bridge

  function onBridgeMessage(ws, raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return log('the tools bridge sent bad JSON')
    }
    if (!serveTools(ctx, ws, msg)) unknown(msg.type)
  }

  return {
    // Resolves once app-server is spawned; ready is reported when the thread and the tools are.
    // `lookma start` has checked the codex binary and the login already (checks.mjs).
    async start({ dirs }) {
      const session = writeSession(config, opts)
      const instructions = fs.readFileSync(path.join(config.root, 'prompts', 'executor.md'), 'utf8')
      rpc = openServer({
        ...appServer(session.home),
        log,
        onNotification: ({ method, params }) => NOTIFICATIONS[method]?.(params),
        onRequest: approvals.request,
        onExit: exited,
      })
      log(`Codex app-server is starting (session folder ${session.dir})`)
      setStatus('starting', 'waiting for Codex')
      handshake(threadParams({ config, opts, dirs, work: session.work, instructions })).catch(err => setStatus('down', err.message))
      return { name: 'codex' }
    },

    // mcp.mjs connected on /ws/executor.
    connect(ws) {
      if (bridge) bridge.close(4000, 'replaced by a new tools connection')
      bridge = ws
      ws.on('message', raw => onBridgeMessage(ws, raw))
      ws.on('close', () => {
        if (bridge !== ws) return
        bridge = null
        if (!stopping && status !== 'down') setStatus('starting', 'tools disconnected')
      })
      becomeReady()
    },

    prompt(text) {
      if (isReady()) run(() => deliver(text))
      else queue.push(text)
    },
    cancel() {
      queue.length = 0
      run(interrupt)
    },
    answer: (id, allow) => approvals.answer(id, allow),

    async stop() {
      stopping = true
      bridge?.close()
      await rpc?.close()
      setStatus('down', 'stopped')
    },
  }
}
