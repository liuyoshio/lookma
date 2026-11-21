// The voice provider contract, page half: what a voice provider's page.js (voices/<name>/page.js)
// gives the session (voice/session.js) and the floor (voice/floor.js), and the only code they
// share. The core half, mint.mjs, is described in core/voice/host.mjs. Provisional until a second
// provider exists. docs/protocol.md has the obligations behind each event and effect.
//
//   export function connect(grant, io) -> Promise<Connection>   resolves once live; rejects in words
//
// grant: what the core minted (POST /api/voice/grant): { provider, credential?, startBy?,
// renewAfter, label, session? }. `session` is the provider's own, opaque to everyone else.
//
// io:
//   signal       aborts when the session ends the connection, live or not yet: release
//                everything at once. From then on the session ignores the connection
//   openMic()    -> Promise<MediaStream>, the session's microphone, kept open across reconnects.
//                Rejects if the session ended meanwhile. A provider that captures natively never calls it
//   onEvent(ev)  one voice event (below)
//   onClose(why) the connection ended by itself
//   log(msg)
//
// Connection: { send(effect) }, one of the four effects (below). The provider owns turn detection.

/** The one tool a provider turns into an item, never a call: the butler's "not for me". */
export const PASS = 'pass'

/**
 * A model output item in the floor's terms. `type` is 'message', 'call' or anything else (not
 * used: null). `args` are a call's raw JSON arguments, parsed here once: anything but a JSON
 * object is no arguments.
 * @returns {Item | null}
 */
export function item({ type, id, callId, name, args, complete }) {
  if (type === 'message') return { kind: 'message' }
  if (type !== 'call') return null
  if (name === PASS) return { kind: 'pass', id }
  return { kind: 'call', id, callId, name, args: parseArgs(args), complete }
}

function parseArgs(raw) {
  try {
    const args = JSON.parse(raw || '{}')
    return args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  } catch {
    return {}
  }
}

/**
 * @typedef {{ kind: 'message' } | { kind: 'pass', id: string }
 *   | { kind: 'call', id: string, callId: string, name: string, args: object, complete: boolean }} Item
 *
 * Voice events, provider -> session -> floor. Turn ids and response ids are the provider's.
 * @typedef {{ type: 'turn.started' | 'turn.stopped' | 'turn.committed', id: string }
 *   | { type: 'turn.transcript', id: string, text: string | null }
 *   | { type: 'response.started', response: string }
 *   | { type: 'response.item', response: string, kind: Item['kind'] }
 *   | { type: 'butler.said', response: string, text: string, final: boolean }
 *   | { type: 'response.done', response: string, status: 'completed' | 'cancelled' | 'failed' | 'incomplete', items: Item[], reason?: string }
 *   | { type: 'audio.started' | 'audio.stopped' | 'audio.cleared', response: string }
 *   | { type: 'error', eventId: string | null, message: string }} VoiceEvent
 *
 * Effects, floor -> session -> provider.
 * @typedef {{ type: 'create', kind: 'turn' | 'speak', eventId: string }
 *   | { type: 'tell', texts: string[] }
 *   | { type: 'drop', items: string[] }
 *   | { type: 'output', results: { callId: string, output: object }[] }} Effect
 */
