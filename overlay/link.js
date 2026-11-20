// The overlay's one connection to the core: /ws/overlay on the page's own origin.
// Snapshots and events come in; tell / answer / cancel / goAhead / pause go out.
// Reconnects forever, so the overlay survives a core restart.

export function connect({ onMessage, onLink }) {
  let ws = null
  let retry = 500

  function open() {
    const url = new URL('/ws/overlay', location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(url)
    onLink('connecting')
    ws.onopen = () => { retry = 500; onLink('open') }
    ws.onmessage = e => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      onMessage(msg)
    }
    ws.onclose = () => {
      onLink('closed')
      setTimeout(open, retry)
      retry = Math.min(retry * 2, 5000)
    }
  }
  open()

  return {
    send(msg) {
      if (ws?.readyState !== WebSocket.OPEN) return false
      ws.send(JSON.stringify(msg))
      return true
    },
  }
}
