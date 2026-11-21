// Claude Code adapter. Interactive `claude` runs in tmux; channel.mjs (spawned by Claude Code)
// connects back on /ws/executor; http hooks arrive through the core's /hook.
//   prompt → channel message        cancel → Escape in tmux
//   answer → relay or terminal keys (approvals.mjs)
import fs from 'node:fs'
import path from 'node:path'
import { logUnknown } from '../../core/util.mjs'
import { serveTools } from '../../core/executor/tool-link.mjs'
import { createTmux } from './tmux.mjs'
import { parse, choose, escape } from './dialog.mjs'
import { createApprovals } from './approvals.mjs'
import { createHookHandler } from './hooks.mjs'
import { writeSession } from './session.mjs'

const POLL_MS = 1000

function findClaude(searchPath) {
  for (const dir of searchPath.split(':')) {
    const file = path.join(dir, 'claude')
    if (dir && fs.existsSync(file)) return file
  }
  throw new Error('claude is not on PATH')
}

export function create(ctx) {
  const { emit, config, options: opts, log } = ctx
  const tmux = createTmux(opts.session)
  const queue = [] // prompts told before the channel connected
  const unknown = logUnknown(log, 'channel')
  let proxy = null
  let status = null
  let polling = false
  let timer = null

  function setStatus(next, detail = '') {
    if (next === status) return
    status = next
    emit({ type: 'status', status: next, detail })
  }

  function send(msg) {
    if (proxy?.readyState !== 1) return false
    proxy.send(JSON.stringify(msg))
    return true
  }

  const approvals = createApprovals({
    emit,
    log,
    relayAnswer: (request_id, behavior) => send({ type: 'permissionAnswer', request_id, behavior }),
    choose: (sig, n) => choose(tmux, sig, n),
    escape: sig => escape(tmux, sig),
  })
  const hook = createHookHandler({ emit, approvals })

  // While the session lives: read the terminal every second for dialogs only it shows.
  async function poll() {
    if (!polling) return
    try {
      if (!(await tmux.alive())) {
        polling = false
        approvals.clear()
        setStatus('down', 'Claude Code exited')
        return
      }
      approvals.screen(parse(await tmux.capture()))
    } catch (err) {
      log('poll failed', err.message)
    }
    if (polling) timer = setTimeout(poll, POLL_MS)
  }

  function onProxyMessage(ws, raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (serveTools(ctx, ws, msg)) return
    if (msg.type === 'permission') approvals.relay(msg)
    else unknown(msg.type)
  }

  return {
    async start({ dirs = [] }) {
      const dir = writeSession(config, opts.session, dirs)
      await tmux.kill() // our own session left over from an earlier run
      const PATH = process.env.PATH // where claude is found; Claude Code runs with the same PATH
      const argv = [
        findClaude(PATH),
        '--model', opts.model,
        '--permission-mode', opts.permissionMode,
        '--settings', path.join(dir, 'settings.json'),
        '--append-system-prompt-file', path.join(dir, 'executor.md'),
        '--dangerously-load-development-channels', 'server:lookma',
        ...opts.flags.split(/\s+/).filter(Boolean),
      ]
      await tmux.start({ cwd: dir, argv, env: { PATH } })
      log(`Claude Code is starting in tmux session ${opts.session} (watch: tmux attach -t ${opts.session})`)
      setStatus('starting', 'waiting for Claude Code')
      polling = true
      poll()
      return { name: 'claude' }
    },

    // The channel proxy connected on /ws/executor.
    connect(ws) {
      if (proxy) proxy.close(4000, 'replaced by a new channel connection')
      proxy = ws
      ws.on('message', raw => onProxyMessage(ws, raw))
      ws.on('close', () => {
        if (proxy !== ws) return
        proxy = null
        if (status !== 'down') setStatus('starting', 'channel disconnected')
      })
      setStatus('ready')
      while (queue.length) send({ type: 'prompt', text: queue.shift() })
    },

    hook,

    // Steering needs nothing of its own: Claude Code takes a message that arrives during a turn into
    // that turn, so a correction is sent like any prompt.
    prompt(text) {
      if (!send({ type: 'prompt', text })) queue.push(text)
    },
    cancel() {
      tmux.keys('Escape').catch(err => log('cancel failed', err.message))
    },
    answer: (id, allow) => approvals.answer(id, allow),

    async stop() {
      polling = false
      clearTimeout(timer)
      proxy?.close()
      await tmux.kill()
      setStatus('down', 'stopped')
    },
  }
}
