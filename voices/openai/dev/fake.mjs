// A fake OpenAI Realtime service, for overlay/dev/check-voices.mjs: the shape every voice
// provider's dev/fake.mjs has. Nothing reaches OpenAI.
//
//   grant         a grant as mint.mjs returns it, minus startBy (the check adds one)
//   page          a script (a block) run in the page before it loads: it replaces WebRTC and the call's SDP
//                 POST with a fake peer connection and data channel, and defines window.__fake:
//                   connections  [{ tracks: [track id], closed }], one per connection the page made
//                   sent         [{ connection, event }], every client event, in order
//                   emit(events) plays server events in, on the newest connection
//                   drop()       the service goes away: the newest connection closes by itself
//   toService(ev) a scripted voice event as the server events the service would send. The script
//                 is voice events (overlay/voice/contract.js), except that response.item and
//                 response.done carry whole items with their ids ({ item } and { items }), and
//                 a call's args are an object
//   fromService({ connection, event })  a client event as the effect it carries, one per event
//                 ({ type: 'tell', texts: [text] }, ...) with its connection; anything else is
//                 { type: 'other', event }
import { RESPONSES } from '../mint.mjs'

export const grant = { credential: 'fake', label: 'fake-realtime', renewAfter: 50 * 60000, session: { responses: RESPONSES } }

export const page = `{
  window.__fake = { connections: [], sent: [], ch: null }
  const fetchBefore = window.fetch.bind(window)
  window.fetch = (url, opts) => String(url).startsWith('https://api.openai.com/') ? Promise.resolve(new Response('v=0', { status: 201 })) : fetchBefore(url, opts)
  window.RTCPeerConnection = class {
    constructor() {
      this.connectionState = 'new'
      this.i = window.__fake.connections.length
      this.rec = { tracks: [], closed: false }
      window.__fake.connections.push(this.rec)
    }
    addTrack(track) { this.rec.tracks.push(track.id) }
    createDataChannel() {
      const i = this.i, rec = this.rec
      const ch = {
        readyState: 'connecting',
        close() {},
        send(d) { window.__fake.sent.push({ connection: i, event: JSON.parse(d) }) },
      }
      window.__fake.ch = this.ch = ch
      setTimeout(() => { if (!rec.closed) { ch.readyState = 'open'; ch.onopen && ch.onopen() } }, 50)
      return ch
    }
    async createOffer() { return { type: 'offer', sdp: 'v=0' } }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() { this.rec.closed = true; if (this.ch) this.ch.readyState = 'closed' }
  }
  window.__fake.emit = events => { for (const e of events) window.__fake.ch.onmessage({ data: JSON.stringify(e) }) }
  window.__fake.drop = () => { const ch = window.__fake.ch; ch.readyState = 'closed'; ch.onclose && ch.onclose() }
}`

/** A scripted item as a Realtime output item. */
function outputItem(i) {
  if (i.kind === 'message') return { type: 'message', id: i.id, role: 'assistant', status: 'completed', content: [] }
  const call = i.kind === 'pass' ? { name: 'pass', callId: `${i.id}_c`, args: {} } : i
  return { type: 'function_call', id: i.id, name: call.name, call_id: call.callId, arguments: JSON.stringify(call.args), status: i.complete === false ? 'incomplete' : 'completed' }
}

export function toService(ev) {
  const r = ev.response
  switch (ev.type) {
    case 'turn.started': return [{ type: 'input_audio_buffer.speech_started', item_id: ev.id, audio_start_ms: 0 }]
    case 'turn.stopped': return [{ type: 'input_audio_buffer.speech_stopped', item_id: ev.id }]
    case 'turn.committed': return [{ type: 'input_audio_buffer.committed', item_id: ev.id }]
    case 'turn.transcript': return [ev.text == null
      ? { type: 'conversation.item.input_audio_transcription.failed', item_id: ev.id }
      : { type: 'conversation.item.input_audio_transcription.completed', item_id: ev.id, transcript: ev.text }]
    case 'response.started': return [{ type: 'response.created', response: { id: r } }]
    case 'response.item': return [{ type: 'response.output_item.added', response_id: r, item: outputItem(ev.item) }]
    case 'butler.said': return [ev.final
      ? { type: 'response.output_audio_transcript.done', response_id: r, transcript: ev.text }
      : { type: 'response.output_audio_transcript.delta', response_id: r, delta: ev.text }]
    case 'response.done': return [{ type: 'response.done', response: { id: r, status: ev.status, output: ev.items.map(outputItem) } }]
    case 'audio.started': return [{ type: 'output_audio_buffer.started', response_id: r }]
    case 'audio.stopped': return [{ type: 'output_audio_buffer.stopped', response_id: r }]
    case 'audio.cleared': return [{ type: 'output_audio_buffer.cleared', response_id: r }]
    case 'error': return [{ type: 'error', error: { event_id: ev.eventId, message: ev.message } }]
  }
  throw new Error(`fake: no Realtime event for ${ev.type}`)
}

// The kind of reply a response.create asks for: the one whose parameters it carries exactly
// (instructions or anything else added would match none).
const kindOf = response => Object.keys(RESPONSES).find(k => JSON.stringify(RESPONSES[k]) === JSON.stringify(response)) ?? null

export function fromService({ connection, event: e }) {
  const effect = (() => {
    if (e.type === 'response.create') return { type: 'create', kind: kindOf(e.response), eventId: e.event_id }
    if (e.type === 'conversation.item.delete') return { type: 'drop', items: [e.item_id] }
    if (e.type === 'conversation.item.create' && e.item.type === 'message' && e.item.role === 'user') return { type: 'tell', texts: [e.item.content[0].text] }
    if (e.type === 'conversation.item.create' && e.item.type === 'function_call_output') return { type: 'output', results: [{ callId: e.item.call_id, output: JSON.parse(e.item.output) }] }
    return { type: 'other', event: e }
  })()
  return { ...effect, connection }
}
