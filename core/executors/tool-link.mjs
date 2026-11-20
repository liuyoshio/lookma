// The adapter's side of mcp-bridge.mjs, on its /ws/executor socket: a `say` becomes a say event,
// and a hands call runs through ctx.hands, its result or error going back as `res`.
// Returns false for any other message, which is the adapter's own.
export function serveTools(ctx, ws, msg) {
  if (msg.type === 'say') {
    ctx.emit({ type: 'say', speech: msg.speech, display: msg.display, kind: msg.kind })
    return true
  }
  if (msg.type !== 'hands') return false
  runHands(ctx, ws, msg)
  return true
}

async function runHands(ctx, ws, msg) {
  let reply
  try {
    reply = { type: 'res', id: msg.id, ok: true, result: await ctx.hands(msg.tool, msg.args) }
  } catch (err) {
    reply = { type: 'res', id: msg.id, ok: false, error: err.message }
  }
  if (ws.readyState === 1) ws.send(JSON.stringify(reply))
}
