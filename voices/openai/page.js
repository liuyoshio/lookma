// The OpenAI Realtime voice, page half (the contract: overlay/voice/contract.js). One WebRTC call
// to OpenAI with the grant's ephemeral key, which already carries the butler's instructions,
// tools and turn detection (mint.mjs): the microphone goes up as the call's audio track, the
// butler's voice comes back on an <audio> element, and the Realtime events run on the
// `oai-events` data channel. The server's VAD is the turn source.
//
// Here is the only translator between the Realtime API and the voice: server events in, as voice
// events (toFloor), and the floor's effects out, as client events (toClient). Nothing else knows
// a Realtime event name. The dev fake (dev/fake.mjs) relies on: `new RTCPeerConnection()` with no
// arguments, `addTrack(track, stream)`, data channel handlers assigned as properties, and `fetch`
// read at call time.
//
// Served at /voices/openai/page.js, beside the overlay at /: the contract is imported by URL.
import { item } from '/voice/contract.js'

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls'

/** One live Realtime call. grant.session.responses: the per-reply parameters, by reply kind. */
export async function connect(grant, io) {
  const stream = await io.openMic()
  const pc = new RTCPeerConnection()
  const audio = new Audio()
  audio.autoplay = true
  io.signal.addEventListener('abort', () => {
    pc.close()
    audio.srcObject = null
  })
  pc.ontrack = e => { audio.srcObject = e.streams[0] }
  pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) io.onClose(`connection ${pc.connectionState}`) }
  pc.addTrack(stream.getAudioTracks()[0], stream)
  const dc = pc.createDataChannel('oai-events')
  const open = new Promise(resolve => { dc.onopen = resolve })
  dc.onclose = () => io.onClose('channel closed')
  dc.onmessage = e => {
    const ev = toFloor(JSON.parse(e.data))
    if (ev) io.onEvent(ev)
  }

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  const res = await fetch(CALLS_URL, {
    method: 'POST', body: offer.sdp, signal: io.signal,
    headers: { Authorization: `Bearer ${grant.credential}`, 'Content-Type': 'application/sdp' },
  })
  if (!res.ok) throw new Error(`realtime: HTTP ${res.status}`)
  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })
  await open

  const { responses } = grant.session
  return {
    send(effect) {
      if (dc.readyState !== 'open') return // closing: its onclose is on the way
      for (const e of toClient(effect, responses)) dc.send(JSON.stringify(e))
    },
  }
}

/** A Realtime server event as a voice event, or null when the voice does not use it. */
function toFloor(e) {
  switch (e.type) {
    case 'input_audio_buffer.speech_started': return { type: 'turn.started', id: e.item_id }
    case 'input_audio_buffer.speech_stopped': return { type: 'turn.stopped', id: e.item_id }
    case 'input_audio_buffer.committed': return { type: 'turn.committed', id: e.item_id }
    case 'conversation.item.input_audio_transcription.completed': return { type: 'turn.transcript', id: e.item_id, text: (e.transcript || '').trim() }
    case 'conversation.item.input_audio_transcription.failed': return { type: 'turn.transcript', id: e.item_id, text: null }
    case 'response.created': return { type: 'response.started', response: e.response.id }
    case 'response.output_item.added': {
      const it = outputItem(e.item)
      return it && { type: 'response.item', response: e.response_id, kind: it.kind }
    }
    case 'response.output_audio_transcript.delta': return { type: 'butler.said', response: e.response_id, text: e.delta || '', final: false }
    case 'response.output_audio_transcript.done': return { type: 'butler.said', response: e.response_id, text: e.transcript || '', final: true }
    case 'response.done': {
      const r = e.response
      const reason = r.status_details ? JSON.stringify(r.status_details) : ''
      return { type: 'response.done', response: r.id, status: r.status, items: (r.output || []).map(outputItem).filter(Boolean), reason }
    }
    case 'output_audio_buffer.started': return { type: 'audio.started', response: e.response_id }
    case 'output_audio_buffer.stopped': return { type: 'audio.stopped', response: e.response_id }
    case 'output_audio_buffer.cleared': return { type: 'audio.cleared', response: e.response_id }
    case 'error': return { type: 'error', eventId: e.error?.event_id ?? null, message: e.error?.message || JSON.stringify(e) }
    default: return null
  }
}

/** A Realtime output item in the floor's terms: a function call is a call, a message a message. */
function outputItem(i) {
  if (i.type !== 'function_call') return item({ type: i.type })
  return item({ type: 'call', id: i.id, callId: i.call_id, name: i.name, args: i.arguments, complete: i.status !== 'incomplete' })
}

/** A floor effect as Realtime client events. */
function toClient(effect, responses) {
  switch (effect.type) {
    // No instructions, ever: the session's own prompt always applies.
    case 'create': return [{ type: 'response.create', event_id: effect.eventId, response: responses[effect.kind] }]
    case 'tell': return effect.texts.map(text => ({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }))
    case 'drop': return effect.items.map(id => ({ type: 'conversation.item.delete', item_id: id }))
    case 'output': return effect.results.map(r => ({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: r.callId, output: JSON.stringify(r.output) } }))
  }
}
