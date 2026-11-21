// JSON-RPC 2.0 over a child process's stdio, one message per line, as `codex app-server` speaks it.
// request() returns the result, or rejects with the error. The server's own requests go to
// onRequest, which must answer each with respond() or fail(): an unanswered one blocks its turn.
// Notifications go to onNotification, stderr lines to the log, and the exit to onExit.
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { clip } from '../../core/util.mjs'

export function openServer({ command, args, env, log, onNotification, onRequest, onExit }) {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map() // our request id -> { resolve, reject }
  let seq = 0
  let exited = false

  const write = msg => child.stdin.write(JSON.stringify(msg) + '\n')

  readline.createInterface({ input: child.stdout }).on('line', line => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return log('app-server wrote', clip(line, 200))
    }
    if (msg.method && msg.id !== undefined) return onRequest(msg)
    if (msg.method) return onNotification(msg)
    const p = pending.get(msg.id)
    if (!p) return log('app-server answered an unknown request', msg.id)
    pending.delete(msg.id)
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }))
    else p.resolve(msg.result)
  })
  readline.createInterface({ input: child.stderr }).on('line', line => log('app-server', line))

  // 'error' alone when the spawn fails, else 'exit'; either may come with the other.
  function gone(code) {
    if (exited) return
    exited = true
    for (const p of pending.values()) p.reject(new Error(`Codex exited (${code}).`))
    pending.clear()
    onExit(code)
  }
  child.on('exit', (code, signal) => gone(code ?? signal))
  child.on('error', err => {
    log('app-server', err.message)
    gone(err.code)
  })
  // A write racing the exit fails with EPIPE; the exit itself is reported above.
  child.stdin.on('error', err => log('app-server input', err.message))

  return {
    request(method, params) {
      if (exited) return Promise.reject(new Error('Codex exited.'))
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        write({ id, method, params })
      })
    },
    notify: (method, params) => write({ method, params }),
    respond: (id, result) => write({ id, result }),
    fail: (id, error) => write({ id, error }),

    // app-server exits when its input ends; one still running after 1 s gets SIGTERM.
    close() {
      if (exited) return Promise.resolve()
      const done = new Promise(resolve => child.once('exit', resolve))
      child.stdin.end()
      const term = setTimeout(() => child.kill('SIGTERM'), 1000)
      return done.finally(() => clearTimeout(term))
    },
  }
}
