// The only translator between the Realtime API and the voice: server events in, as voice events
// (toFloor), and the floor's effects out, as client events (toClient). Nothing else knows a
// Realtime event name, and nothing else knows the tool name `pass` (prompts/butler-tools.json
// defines it): a pass call is an item of kind 'pass', never a tool call. Tool arguments are
// parsed here, once: anything but a JSON object is no arguments.

/** A Realtime server event as a voice event, or null when the voice does not use it. */
export function toFloor(e) {
  switch (e.type) {
    case 'input_audio_buffer.speech_started': return { type: 'turn.started', id: e.item_id }
    case 'input_audio_buffer.speech_stopped': return { type: 'turn.stopped', id: e.item_id }
    case 'input_audio_buffer.committed': return { type: 'turn.committed', id: e.item_id }
    case 'conversation.item.input_audio_transcription.completed': return { type: 'turn.transcript', id: e.item_id, text: (e.transcript || '').trim() }
    case 'conversation.item.input_audio_transcription.failed': return { type: 'turn.transcript', id: e.item_id, text: null }
    case 'response.created': return { type: 'response.started', response: e.response.id }
    case 'response.output_item.added': {
      const it = item(e.item)
      return it && { type: 'response.item', response: e.response_id, kind: it.kind }
    }
    case 'response.output_audio_transcript.delta': return { type: 'butler.said', response: e.response_id, text: e.delta || '', final: false }
    case 'response.output_audio_transcript.done': return { type: 'butler.said', response: e.response_id, text: e.transcript || '', final: true }
    case 'response.done': {
      const r = e.response
      const reason = r.status_details ? JSON.stringify(r.status_details) : ''
      return { type: 'response.done', response: r.id, status: r.status, items: (r.output || []).map(item).filter(Boolean), reason }
    }
    case 'output_audio_buffer.started': return { type: 'audio.started', response: e.response_id }
    case 'output_audio_buffer.stopped': return { type: 'audio.stopped', response: e.response_id }
    case 'output_audio_buffer.cleared': return { type: 'audio.cleared', response: e.response_id }
    case 'error': return { type: 'error', eventId: e.error?.event_id ?? null, message: e.error?.message || JSON.stringify(e) }
    default: return null
  }
}

/** One output item: { kind: 'message' } | { kind: 'pass', id } | { kind: 'call', id, callId, name, args, complete }. */
function item(i) {
  if (i.type === 'message') return { kind: 'message' }
  if (i.type !== 'function_call') return null
  if (i.name === 'pass') return { kind: 'pass', id: i.id }
  return { kind: 'call', id: i.id, callId: i.call_id, name: i.name, args: parseArgs(i.arguments), complete: i.status !== 'incomplete' }
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
 * A floor effect as Realtime client events.
 * @param {object} effect     create { kind, eventId } | tell { texts } | drop { items } | output { results }
 * @param {object} responses  per-reply parameters from the key, by reply kind (core/voice-key.mjs)
 */
export function toClient(effect, responses) {
  switch (effect.type) {
    // No instructions, ever: the session's own prompt always applies.
    case 'create': return [{ type: 'response.create', event_id: effect.eventId, response: responses[effect.kind] }]
    case 'tell': return effect.texts.map(text => ({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }))
    case 'drop': return effect.items.map(id => ({ type: 'conversation.item.delete', item_id: id }))
    case 'output': return effect.results.map(r => ({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: r.callId, output: JSON.stringify(r.output) } }))
  }
}
