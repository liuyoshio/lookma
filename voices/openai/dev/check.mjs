#!/usr/bin/env node
// The OpenAI Realtime voice's own check: the butler's session the core would mint (mint.mjs),
// with no OpenAI call, only the config it would send. Semantic VAD with medium eagerness that
// never replies by itself; for a room far-field noise reduction and no barge-in, for a headset
// near-field and barge-in; the max output tokens; the transcription language only when set and
// no transcription prompt; the butler's tools as Realtime functions, the control and pass tools
// among them; and the per-reply parameters the grant carries (RESPONSES). How the page behaves
// with this voice is overlay/dev/check-voices.mjs, against dev/fake.mjs.
//
//   node voices/openai/dev/check.mjs

import { butlerSession, RESPONSES } from '../mint.mjs'
import { readPrompts } from '../../../core/voice/host.mjs'
import { ROOT } from '../../../core/config.mjs'

let failed = 0
function check(ok, what) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) failed++
}

const options = { model: 'gpt-realtime', voice: 'marin', transcribeModel: 'gpt-4o-transcribe', maxTokens: 200 }
const ctx = { options, ...readPrompts(ROOT), audio: 'room', language: '' }
const s = butlerSession(ctx)
const td = s.audio.input.turn_detection
check(td?.type === 'semantic_vad' && td.eagerness === 'medium' && td.create_response === false && td.interrupt_response === false && s.audio.input.noise_reduction?.type === 'far_field',
  `session, room: semantic VAD, eagerness medium, no reply by itself, no barge-in, far_field ${JSON.stringify(s.audio.input)}`)
check(s.max_output_tokens === 200 && s.model === 'gpt-realtime' && s.audio.output.voice === 'marin', 'session: max output tokens 200, the model and the voice')
check(JSON.stringify(s.audio.input.transcription) === '{"model":"gpt-4o-transcribe"}', `session: no language unless set, no transcription prompt ${JSON.stringify(s.audio.input.transcription)}`)
const headset = butlerSession({ ...ctx, audio: 'headset' }).audio.input
check(headset.turn_detection.interrupt_response === true && headset.noise_reduction.type === 'near_field' && headset.turn_detection.eagerness === 'medium',
  `session, headset: barge-in, near_field ${JSON.stringify(headset)}`)
const zh = butlerSession({ ...ctx, language: 'zh', options: { ...options, maxTokens: 150 } })
check(JSON.stringify(zh.audio.input.transcription) === '{"model":"gpt-4o-transcribe","language":"zh"}' && zh.max_output_tokens === 150,
  `session: LOOKMA_VOICE_LANGUAGE=zh goes to the transcription, max tokens configurable ${JSON.stringify(zh.audio.input.transcription)}`)
check(s.tools.length === ctx.tools.length && s.tools.every(t => t.type === 'function'), 'session: every butler tool, as a Realtime function')
const control = s.tools.find(t => t.name === 'control')
check(JSON.stringify(control?.parameters.properties.action.enum) === '["stop","go_ahead","pause"]', `session: the control tool, with stop, go_ahead and pause ${JSON.stringify(control?.parameters)}`)
const pass = s.tools.find(t => t.name === 'pass')
check(!!pass && JSON.stringify(pass.parameters.properties) === '{}', `session: the pass tool, with no arguments ${JSON.stringify(pass?.parameters)}`)
check(JSON.stringify(RESPONSES) === '{"turn":{},"speak":{"tool_choice":"none"}}', `grant: a turn reply may call tools, every other reply is speak-only ${JSON.stringify(RESPONSES)}`)

console.log(failed ? `${failed} FAILED` : 'all passed')
process.exit(failed ? 1 : 0)
