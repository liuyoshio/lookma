// The overlay's one connection to the core: /ws/overlay on the page's own origin.
// Snapshots and events come in. Requests (tell, answer, control) go out with an id and get
// exactly one ack each (docs/protocol.md); log lines go out with none.
// Reconnects forever, so the overlay survives a core restart.

const REQUEST_MS = 3000 // an ack not in by then is "no answer"; a request is never resent

export function connect({ onMessage, onLink }) {
  let ws = null
  let retry = 500
  let seq = 0
  const pending = new Map() // request id -> resolve(ack)

  function settle(id, ack) {
    const resolve = pending.get(id)
    if (!resolve) return
    pending.delete(id)
    resolve(ack)
  }

  function open() {
    const url = new URL('/ws/overlay', location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(url)
    onLink('connecting')
    ws.onopen = () => { retry = 500; onLink('open') }
    ws.onmessage = e => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg.type !== 'ack') return onMessage(msg)
      const { type, id, ...ack } = msg
      settle(id, ack)
    }
    ws.onclose = () => {
      for (const id of pending.keys()) settle(id, { ok: false, error: 'not connected' })
      onLink('closed')
      setTimeout(open, retry)
      retry = Math.min(retry * 2, 5000)
    }
  }
  open()

  function send(msg) {
    if (ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(msg))
    return true
  }

  return {
    send,
    /** Resolves with the core's ack: { ok: true, ... } | { ok: false, error }. Never rejects. */
    request(msg) {
      const id = `r${++seq}`
      if (!send({ ...msg, id })) return Promise.resolve({ ok: false, error: 'not connected' })
      return new Promise(resolve => {
        const timer = setTimeout(() => settle(id, { ok: false, error: 'no answer' }), REQUEST_MS)
        pending.set(id, ack => { clearTimeout(timer); resolve(ack) })
      })
    },
  }
}
