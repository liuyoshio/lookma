// The OpenAI Realtime voice, page half (the contract: overlay/voice/contract.js). One WebRTC call
// to OpenAI with the grant's ephemeral key, which already carries the butler's instructions,
// tools and turn detection (mint.mjs). The call's audio sender starts with no track: `listen`
// puts the microphone on it and takes it off (replaceTrack, no renegotiation), so while the
// microphone is closed no audio of any kind reaches OpenAI. The butler's voice comes back on an
// <audio> element, and the Realtime events run on the `oai-events` data channel.
//
// Turns: in `auto` the server's VAD finds them. In `hold` the key does: the VAD is switched off
// (session.update), the page begins the turn under its own id, or adopts the one the VAD has
// open, and commits the input buffer at release. Where the server's item id for it differs, it
// is an alias of the turn's, so the floor sees one id per turn. The VAD is switched back on, with
// the minted detection, at the next `auto`.
//
// Here is the only translator between the Realtime API and the voice: server events in, as voice
// events (heard, toFloor), and the effects out, as client events (listen, toClient). Nothing else
// knows a Realtime event name. The dev fake (dev/fake.mjs) relies on: `new RTCPeerConnection()`
// with no arguments, `addTransceiver('audio', init)` and its `sender.replaceTrack(track)`, data
// channel handlers assigned as properties, and `fetch` read at call time.
//
// Served at /voices/openai/page.js, beside the overlay at /: the contract is imported by URL.
import { item } from '/voice/contract.js'

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls'
const DRAIN_MS = 150 // after a hold ends, audio still in flight lands in the buffer before it is committed

/**
 * One live Realtime call. grant.session: `responses`, the per-reply parameters by reply kind, and
 * `detection`, the minted turn detection, restored after a hold.
 */
export async function connect(grant, io) {
  const { responses, detection } = grant.session
  const pc = new RTCPeerConnection()
  const audio = new Audio()
  audio.autoplay = true
  // What the call is doing, for listen and cut.
  const call = {
    how: 'off',          // the last listen
    detecting: true,     // the server's VAD is on, as minted
    turn: null,          // the turn begun and not committed: { id, manual }; manual: the key holds it
    committing: null,    // a held turn on its way in, { id, eventId }, until the server commits it
    drain: 0,            // the timer that sends its commit
    alias: new Map(),    // the server's item id -> the held turn's id, where they differ
    holds: 0,            // held turns so far, for their ids
    responding: false,   // response.created to response.done
    audible: false,      // output_audio_buffer.started to stopped or cleared
  }
  io.signal.addEventListener('abort', () => {
    clearTimeout(call.drain)
    pc.close()
    audio.srcObject = null
  })
  pc.ontrack = e => { audio.srcObject = e.streams[0] }
  pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) io.onClose(`connection ${pc.connectionState}`) }
  const { sender } = pc.addTransceiver('audio', { direction: 'sendrecv' })
  const dc = pc.createDataChannel('oai-events')
  const open = new Promise(resolve => { dc.onopen = resolve })
  dc.onclose = () => io.onClose('channel closed')
  dc.onmessage = e => {
    const msg = JSON.parse(e.data)
    follow(call, msg)
    for (const ev of [heard(msg), toFloor(msg)]) if (ev) io.onEvent(ev)
  }
  const sendAll = events => { for (const e of events) dc.send(JSON.stringify(e)) }
  const turnOf = itemId => call.alias.get(itemId) ?? itemId
  const itemOf = turnId => [...call.alias].find(([, t]) => t === turnId)?.[0] ?? turnId

  /** A server event about the user's turns, as a voice event under the turn's own id, or null. */
  function heard(e) {
    switch (e.type) {
      // While the key holds the turn, the VAD's own events (in flight as it was switched off) begin nothing.
      case 'input_audio_buffer.speech_started':
        if (call.turn?.manual) return null
        call.turn = { id: e.item_id, manual: false }
        return { type: 'turn.started', id: e.item_id }
      case 'input_audio_buffer.speech_stopped':
        return call.turn?.manual ? null : { type: 'turn.stopped', id: e.item_id }
      case 'input_audio_buffer.committed': {
        // The held turn's commit, else the turn the VAD began.
        const t = call.committing ?? call.turn
        if (call.committing) call.committing = null
        else call.turn = null
        const id = t?.id ?? e.item_id
        if (id !== e.item_id) call.alias.set(e.item_id, id)
        return { type: 'turn.committed', id }
      }
      case 'conversation.item.input_audio_transcription.completed': return { type: 'turn.transcript', id: turnOf(e.item_id), text: (e.transcript || '').trim() }
      case 'conversation.item.input_audio_transcription.failed': return { type: 'turn.transcript', id: turnOf(e.item_id), text: null }
      case 'error': {
        // The commit refused (the buffer held too little audio): the held turn never comes in.
        if (!call.committing || e.error?.event_id !== call.committing.eventId) return null
        const { id } = call.committing
        call.committing = null
        return { type: 'turn.dropped', id }
      }
      default: return null
    }
  }

  /** The microphone's level (contract.js, How). A repeat of the current one only puts `mic` on again. */
  function listen({ how, mic, drop }) {
    if (call.drain) commit() // a held turn still draining goes in before anything else
    const from = call.how
    call.how = how
    if (how === 'off') sender.replaceTrack(null)
    if (how !== from) {
      if (from === 'hold') release(drop)
      if (how === 'hold') hold(from)
      else if (how === 'auto' && !call.drain) detect(true) // after a release: once its commit is sent
      else if (how === 'off' && call.turn) { // a VAD turn that can no longer finish is discarded
        sendAll([{ type: 'input_audio_buffer.clear' }])
        io.onEvent({ type: 'turn.dropped', id: call.turn.id })
        call.turn = null
      }
    }
    if (how !== 'off') sender.replaceTrack(mic.getAudioTracks()[0])
  }

  /** The key holds the turn: the VAD off; the turn it has open is adopted, else a new one begins. */
  function hold(from) {
    detect(false)
    if (call.turn) {
      call.turn.manual = true // the user began speaking as they pressed: the same id, no new event
      return
    }
    if (from === 'off') sendAll([{ type: 'input_audio_buffer.clear' }]) // nothing sent before the hold is part of it
    call.turn = { id: `hold_${++call.holds}`, manual: true }
    io.onEvent({ type: 'turn.started', id: call.turn.id })
  }

  /** The hold ended: its turn is committed once the audio in flight has landed, or discarded (drop). */
  function release(drop) {
    const t = call.turn
    if (!t) return // the VAD committed it before it was switched off
    call.turn = null
    if (drop) {
      sendAll([{ type: 'input_audio_buffer.clear' }])
      io.onEvent({ type: 'turn.dropped', id: t.id })
      return
    }
    io.onEvent({ type: 'turn.stopped', id: t.id })
    call.committing = { id: t.id, eventId: `${t.id}_commit` }
    call.drain = setTimeout(commit, DRAIN_MS)
  }

  /** The held turn's commit; then the VAD back on if the hold returned to auto. */
  function commit() {
    clearTimeout(call.drain)
    call.drain = 0
    sendAll([{ type: 'input_audio_buffer.commit', event_id: call.committing.eventId }])
    if (call.how === 'auto') detect(true)
  }

  // The VAD on or off on the live call. Not yet checked against the service: should it refuse,
  // the fallback is the contract's nearest behaviour, a hold heard as auto, in this file alone.
  function detect(on) {
    if (call.detecting === on) return
    call.detecting = on
    sendAll([{ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: on ? detection : null } } } }])
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

  return {
    send(effect) {
      if (dc.readyState !== 'open') return // closing: its onclose is on the way
      if (effect.type === 'listen') listen(effect)
      else sendAll(toClient(effect, responses, call, itemOf))
    },
  }
}

/** Keeps `call` true to the server's replies and playback, for cut. */
function follow(call, e) {
  switch (e.type) {
    case 'response.created': call.responding = true; break
    case 'response.done': call.responding = false; break
    case 'output_audio_buffer.started': call.audible = true; break
    case 'output_audio_buffer.stopped':
    case 'output_audio_buffer.cleared': call.audible = false; break
  }
}

/** A Realtime server event about the butler as a voice event, or null when the voice does not use it. */
function toFloor(e) {
  switch (e.type) {
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

/** An effect other than listen as Realtime client events. itemOf: a turn's item id on the server. */
function toClient(effect, responses, call, itemOf) {
  switch (effect.type) {
    // No instructions, ever: the session's own prompt always applies.
    case 'create': return [{ type: 'response.create', event_id: effect.eventId, response: responses[effect.kind] }]
    case 'tell': return effect.texts.map(text => ({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }))
    case 'drop': return effect.items.map(id => ({ type: 'conversation.item.delete', item_id: itemOf(id) }))
    case 'output': return effect.results.map(r => ({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: r.callId, output: JSON.stringify(r.output) } }))
    // Two independent parts: audio outlasts the reply that made it. The server answers with
    // response.done cancelled and output_audio_buffer.cleared.
    case 'cut': return [
      ...(call.responding ? [{ type: 'response.cancel' }] : []),
      ...(call.audible ? [{ type: 'output_audio_buffer.clear' }] : []),
    ]
  }
}
