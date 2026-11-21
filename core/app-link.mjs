// The link to the Swift app over /ws/app: requests and notices out; replies, attention and the
// user's commands from the menu bar and hotkey (pause, resume, quit, and the talk mode) in.
import { logUnknown } from './util.mjs'
import { TALK } from './config.mjs'

const TIMEOUT_MS = { see: 20000, default: 15000 }
const COMMANDS = new Set(['pause', 'resume', 'quit'])

export function createAppLink({ log, onAttention, onChange, onCommand, onTalk }) {
  let ws = null
  let info = null // the app's hello
  let seq = 0
  const pending = new Map() // id -> { resolve, reject, timer }
  const unknown = logUnknown(log, 'app')

  function failAll(reason) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
      pending.delete(id)
    }
  }

  function attach(sock) {
    if (ws) ws.close(4000, 'replaced by a new app connection')
    ws = sock
    log('app connected')
    sock.on('message', raw => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg.type === 'hello') {
        info = msg
        log('app hello', { version: msg.version, permissions: msg.permissions, screen: msg.screen })
        onChange?.()
      } else if (msg.type === 'attention') {
        onAttention(Number(msg.idle))
      } else if (COMMANDS.has(msg.type)) {
        onCommand?.(msg.type)
      } else if (msg.type === 'talk') {
        if (TALK.includes(msg.mode)) onTalk(msg.mode)
        else log(`bad app message: talk mode ${JSON.stringify(msg.mode)}, ignored`)
      } else if (msg.type === 'res') {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.result ?? {})
        else p.reject(new Error(msg.error || 'The app reported an error.'))
      } else {
        unknown(msg.type)
      }
    })
    sock.on('close', () => {
      if (ws !== sock) return
      ws = null
      info = null
      log('app disconnected')
      failAll('The Lookma app disconnected.')
      onAttention(null)
      onChange?.()
    })
  }

  function request(op, args = {}) {
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('The Lookma app is not connected.'))
    const id = ++seq
    return new Promise((resolve, reject) => {
      const ms = TIMEOUT_MS[op] || TIMEOUT_MS.default
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`The app did not answer ${op} within ${ms / 1000} s.`))
      }, ms)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ type: 'req', id, op, args }))
    })
  }

  // A notice that needs no reply, e.g. { type: 'paused', paused }. Dropped while not connected.
  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg))
  }

  return {
    attach,
    request,
    send,
    // The core owns the app's lifetime: when the core stops, the app quits too.
    quit: () => send({ type: 'quit' }),
    get connected() {
      return !!ws
    },
    get info() {
      return info
    },
  }
}
