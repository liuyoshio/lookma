// The executor host: the only code that loads an executor adapter (executors/<name>/index.mjs)
// and the one owner, between the core and the adapter, of:
//   status       starting until the adapter's start() resolves, then ready; down when a start
//                fails, when recovery is used up, or after close
//   the prompt line   prompts go to the adapter one at a time, in order, only while ready and
//                not stopping; told earlier, they wait here
//   the tools    the socket on /ws/executor where the tools bridge (bridge.mjs) calls say and
//                the hands; the adapter only gets the bridge's spawn spec, tools.mcp()
//   cards        ctx.ask, through the core's cards
//   the stop gate     from interrupt() until the adapter's interrupt() resolves (and across a
//                restart): the adapter's events are dropped, tool calls are refused, open cards
//                are withdrawn and the hands stop, so nothing of the stopped work reaches the
//                user or the screen. Order is enough: outside the gate, an event belongs to the
//                work that is running.
//   recovery     a session that dies (`down`) or does not stop in INTERRUPT_MS is closed and
//                started again, once: a second failure within RESTART_WINDOW_MS leaves it down
// The contract an adapter keeps is in docs/protocol.md (Executor contract).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cancelled, logUnknown } from '../util.mjs'
import { SAY, HANDS } from '../tools.mjs'

const INTERRUPT_MS = 10000
const RESTART_WINDOW_MS = 60000
const SERVER = 'lookma' // the tools' MCP server name
const BRIDGE = fileURLToPath(new URL('bridge.mjs', import.meta.url))
const KINDS = ['info', 'question', 'confirm']

/**
 * config: the core's (config.executor is the loaded plug-in).
 * onEvent(e): turnStart, turnEnd { ok, error? }, step and task, outside the gate.
 * onStatus(status, detail). say({ speech, display?, kind? }): the say tool.
 * hands: { run(tool, args), abort() }. ask(card, signal): a core card, resolving with the
 * answer and rejecting when signal aborts. log: the core's; the host's lines start "executor", the
 * adapter's its name. create: a stand-in for the adapter's own (checks). timing: the two limits
 * above, shorter in checks.
 */
export async function createExecutorHost(config, { onEvent, onStatus, say, hands, ask, log: coreLog, create, timing = {} }) {
  const { name, title, dir, options, env } = config.executor
  const log = (...args) => coreLog('executor', ...args)
  const { interruptMs = INTERRUPT_MS, restartWindowMs = RESTART_WINDOW_MS } = timing
  create ??= (await import(pathToFileURL(path.join(dir, 'index.mjs')).href)).create
  const sessionDir = path.join(config.dataDir, 'sessions', name)
  fs.mkdirSync(sessionDir, { recursive: true })
  const coreUrl = `ws://127.0.0.1:${config.port}/ws/executor`
  const unknownCall = logUnknown(log, 'tools bridge')

  let status = 'starting'
  let shown = null // the status detail last reported
  let gated = false // the stop gate is closed
  let run = 0 // the session: a restart or close makes what an older one still returns moot
  let dirs = []
  let failedAt = -Infinity
  let pumping = null // the session whose prompts are being delivered
  let stopping = Promise.resolve() // the last interrupt: settles when its gate opens or recovery takes over
  const line = [] // prompts waiting for the adapter
  const asks = new Set() // the AbortControllers of open cards

  function setStatus(next, detail = '') {
    if (next === status && detail === shown) return
    status = next
    shown = detail
    log(`status ${next}${detail ? ` (${detail})` : ''}`)
    onStatus(next, detail)
  }

  // ---------------------------------------------------------------- the adapter's ctx

  function emit(e) {
    if (e.type === 'down') {
      if (status === 'ready') recover(e.detail) // a session still starting rejects its start instead
      return
    }
    if (gated || status !== 'ready') return log('dropped', e.type)
    if (e.type === 'turnEnd' && e.summary) log('summary', e.summary)
    onEvent(e)
  }

  // A card for the user: true or false, or null when it is withdrawn (stop, restart, close, or
  // the adapter's own signal).
  function cardFor(card, signal) {
    if (gated || signal?.aborted) return Promise.resolve(null)
    const ctl = new AbortController()
    const withdraw = () => ctl.abort()
    signal?.addEventListener('abort', withdraw, { once: true })
    asks.add(ctl)
    return ask({ title: card.title, detail: card.detail || '', source: 'executor' }, ctl.signal).then(
      allow => allow,
      () => null,
    ).finally(() => {
      asks.delete(ctl)
      signal?.removeEventListener('abort', withdraw)
    })
  }

  // The spawn spec of the tools bridge. extras: what one agent's MCP client wants on top, its
  // tools' _meta (toolMeta) and the server's instructions.
  function mcp({ toolMeta, instructions } = {}) {
    const tools = [SAY, ...HANDS].map(t => (toolMeta ? { ...t, _meta: toolMeta } : t))
    return {
      command: process.execPath,
      args: [BRIDGE],
      env: { LOOKMA_CORE_URL: coreUrl, LOOKMA_TOOLS: JSON.stringify({ name: SERVER, tools, instructions }) },
    }
  }

  const adapter = create({
    emit,
    tools: { server: SERVER, mcp },
    ask: cardFor,
    options,
    instructions: fs.readFileSync(path.join(config.root, 'prompts', 'executor.md'), 'utf8'),
    sessionDir,
    env,
    log: (...args) => coreLog(name, ...args),
  })

  // ---------------------------------------------------------------- the prompt line

  async function pump() {
    if (pumping === run) return
    const r = (pumping = run)
    while (r === run && status === 'ready' && !gated && line.length) {
      try {
        await adapter.prompt(line.shift())
      } catch (err) {
        if (r === run && !gated) fail(err.message)
      }
    }
    if (pumping === r) pumping = null
  }

  // The running turn fails with a reason, and what was told for it is moot.
  function fail(reason) {
    line.length = 0
    onEvent({ type: 'turnEnd', ok: false, error: reason })
  }

  // ---------------------------------------------------------------- the gate, recovery

  // Everything of the work so far stops: waiting prompts, open cards, the hands.
  function drop() {
    line.length = 0
    for (const ctl of asks) ctl.abort()
    hands.abort()
  }

  async function begin(detail) {
    setStatus('starting', detail)
    const r = run
    try {
      await adapter.start({ dirs })
    } catch (err) {
      if (r !== run) return
      run++
      gated = true
      drop()
      fail(err.message)
      setStatus('down', err.message)
      await adapter.close()
      return
    }
    if (r !== run) return
    gated = false
    setStatus('ready')
    pump()
  }

  // The session cannot be trusted: close it and start a new one, once a minute at most. The gate
  // stays closed until the new one is ready, since it holds none of the old work.
  async function recover(reason) {
    const again = Date.now() - failedAt < restartWindowMs
    failedAt = Date.now()
    run++
    gated = true
    drop()
    fail(reason)
    if (again) setStatus('down', reason)
    else setStatus('starting', `${reason}; restarting`)
    await adapter.close()
    if (!again) begin(`${reason}; restarting`)
  }

  // Resolves when the gate opens again, or when recovery took over (checks wait for it; the core
  // does not).
  function interrupt() {
    drop()
    if (status !== 'ready' || gated) return stopping // nothing runs in a session not ready; a stop is already under way
    gated = true
    const r = run
    let timer
    const late = new Promise((resolve, reject) => (timer = setTimeout(() => reject(new Error(`${title} stopped responding`)), interruptMs)))
    stopping = Promise.race([adapter.interrupt(), late]).finally(() => clearTimeout(timer)).then(
      () => {
        if (r !== run) return
        gated = false
        pump()
      },
      err => r === run && recover(err.message),
    )
    return stopping
  }

  // ---------------------------------------------------------------- the tools

  // A call from the bridge; the result is { text, image? }.
  function call(tool, args) {
    if (gated) throw cancelled()
    if (tool !== SAY.name) return hands.run(tool, args)
    if (typeof args.speech !== 'string' || !args.speech.trim()) throw new Error('say needs speech.')
    if (args.display !== undefined && typeof args.display !== 'string') throw new Error('say: display is a string.')
    if (args.kind !== undefined && !KINDS.includes(args.kind)) throw new Error(`say: kind is one of ${KINDS.join(', ')}.`)
    say({ speech: args.speech, display: args.display, kind: args.kind })
    return { text: 'said' }
  }

  async function serve(ws, { id, tool, args }) {
    let reply
    try {
      reply = { type: 'res', id, ok: true, result: await call(tool, args) }
    } catch (err) {
      reply = { type: 'res', id, ok: false, error: err.message }
    }
    if (ws.readyState === 1) ws.send(JSON.stringify(reply))
  }

  return {
    // Starts the session; resolves once it is ready or down, never rejects (the status says why).
    start(folders) {
      dirs = folders
      return begin('')
    },
    prompt(text) {
      line.push(text)
      pump()
    },
    interrupt,
    async close() {
      run++
      gated = true
      drop()
      setStatus('down', 'stopped')
      await adapter.close()
    },
    // A tools bridge connected on /ws/executor. Every bridge is served alike, however many.
    connect(ws) {
      ws.on('message', raw => {
        let msg
        try {
          msg = JSON.parse(raw)
        } catch {
          return log('the tools bridge sent bad JSON')
        }
        if (msg.type !== 'call') return unknownCall(msg.type)
        if (typeof msg.tool !== 'string' || typeof msg.args !== 'object' || msg.args === null) return log('the tools bridge sent a bad call', String(raw).slice(0, 200))
        serve(ws, msg)
      })
    },
  }
}
