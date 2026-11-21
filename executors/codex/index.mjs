// Codex adapter (executor contract v2, docs/protocol.md). `codex app-server` runs as a child
// process and speaks JSON-RPC on stdio (rpc.mjs), with one thread per session. Codex spawns the
// tools bridge from the thread config (ctx.tools.mcp()).
//   start      initialize, thread/start; resolves once the tools' MCP server is up
//   prompt     turn/start, or turn/steer while a Codex turn runs
//   interrupt  turn/interrupt; resolves on that turn's turn/completed
//   item/started → step     server requests → cards (approvals.mjs)     turn/completed → turnEnd
// After close, start begins a fresh thread.
import { clip } from '../../core/util.mjs'
import { openServer } from './rpc.mjs'
import { writeSession, appServer, initializeParams, threadParams } from './session.mjs'
import { stepTitle } from './events.mjs'
import { createApprovals } from './approvals.mjs'

export function create(ctx) {
  const { emit, options, log } = ctx
  const server = ctx.tools.server
  let rpc = null
  let approvals = null
  let threadId = null
  let turnId = null // the Codex turn running now
  let said = '' // the last message of the running turn: its summary, for the log
  let sending = Promise.resolve() // the prompt being delivered
  let toolsUp = null // settles the start's wait for the tools
  let closing = false
  const ending = new Map() // turn id -> resolve, for the interrupt waiting on that turn's end

  const NOTIFICATIONS = {
    // Also for a turn Lookma did not start: a refused steer, or Codex going on by itself.
    'turn/started'({ turn }) {
      log('turn started', turn.id)
      if (turnId === turn.id) return
      turnId = turn.id
      said = ''
      emit({ type: 'turnStart' })
    },
    'turn/completed'({ turn }) {
      if (turnId === turn.id) turnId = null
      approvals.closeTurn(turn.id)
      log(`turn ${turn.status} ${turn.id}${turn.error ? `: ${turn.error.message}` : ''}`)
      emit({ type: 'turnEnd', ok: turn.status === 'completed', summary: said, error: turn.error?.message })
      ending.get(turn.id)?.()
      ending.delete(turn.id)
    },
    'item/started'({ item, turnId: itemTurn }) {
      if (item.type === 'fileChange') approvals.fileChange(item, itemTurn)
      const title = stepTitle(item, server)
      if (title) emit({ type: 'step', title })
    },
    // The model is told to speak only with say; its text replies are for this log.
    'item/completed'({ item }) {
      if (item.type !== 'agentMessage') return
      said = item.text
      log('message', clip(item.text, 200))
    },
    'serverRequest/resolved': ({ requestId }) => approvals.resolved(requestId),
    'mcpServer/startupStatus/updated'({ name, status, error }) {
      log(`mcp server ${name} ${status}${error ? `: ${error}` : ''}`)
      if (name !== server) return
      if (status === 'ready') toolsUp.resolve()
      else if (status !== 'starting') toolsUp.reject(new Error(`the tools did not start (${status}${error ? `: ${error}` : ''})`))
    },
    error: ({ error, willRetry }) => log(`error: ${error.message}${willRetry ? ' (retrying)' : ''}`),
  }

  function exited(code) {
    approvals.clear()
    toolsUp.reject(new Error(`Codex exited (${code}).`))
    for (const resolve of ending.values()) resolve()
    ending.clear()
    turnId = null
    if (!closing) emit({ type: 'down', detail: `Codex exited (${code})` })
  }

  async function handshake(dirs, work) {
    await rpc.request('initialize', initializeParams())
    rpc.notify('initialized')
    const r = await rpc.request('thread/start', threadParams({ options, dirs, work, instructions: ctx.instructions, tools: ctx.tools }))
    threadId = r.thread.id
    log(`thread ${threadId}, model ${r.model}${r.serviceTier ? `, ${r.serviceTier} tier` : ''}`)
  }

  async function deliver(text) {
    const input = [{ type: 'text', text, text_elements: [] }]
    if (turnId) {
      try {
        await rpc.request('turn/steer', { threadId, input, expectedTurnId: turnId })
        return log('steered', turnId)
      } catch (err) {
        log('steer refused, starting a new turn:', err.message) // the turn has just ended
      }
    }
    said = ''
    turnId = (await rpc.request('turn/start', { threadId, input })).turn.id
  }

  return {
    // `lookma start` has checked the codex binary and the login already (manifest.mjs).
    async start({ dirs }) {
      closing = false
      const { home, work } = writeSession(ctx.sessionDir, options.home)
      const up = new Promise((resolve, reject) => (toolsUp = { resolve, reject }))
      rpc = openServer({
        ...appServer(home, ctx.env),
        log,
        onNotification: ({ method, params }) => NOTIFICATIONS[method]?.(params),
        onRequest: req => approvals.request(req),
        onExit: exited,
      })
      approvals = createApprovals({ ask: ctx.ask, log, respond: rpc.respond, fail: rpc.fail })
      log(`Codex app-server is starting (session folder ${ctx.sessionDir})`)
      await Promise.all([handshake(dirs, work), up])
    },

    prompt(text) {
      const p = deliver(text)
      sending = p.catch(() => {}) // its failure is the host's to report
      return p
    },

    async interrupt() {
      await sending
      const id = turnId
      if (!id) return
      const end = new Promise(resolve => ending.set(id, resolve))
      // Refused when the turn has just completed by itself: its end is then here already.
      const sent = rpc.request('turn/interrupt', { threadId, turnId: id }).catch(err => log('interrupt refused:', err.message))
      await Promise.all([sent, end])
    },

    async close() {
      closing = true
      approvals?.clear()
      await rpc?.close()
      rpc = approvals = threadId = turnId = null
    },
  }
}
