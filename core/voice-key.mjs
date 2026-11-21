// Mints short-lived OpenAI Realtime keys for the overlay, with the butler session baked in (set
// up for a room or a headset), and the parameters each kind of reply is asked for with. The real
// key never leaves the core.
import fs from 'node:fs'
import path from 'node:path'

// An error the server answers with this HTTP status.
const fail = (status, message) => Object.assign(new Error(message), { status })

function readPrompt(root, name, parse) {
  const file = path.join(root, 'prompts', name)
  if (!fs.existsSync(file)) throw fail(500, `prompts/${name} is missing`)
  const text = fs.readFileSync(file, 'utf8')
  if (!parse) return text
  try {
    return JSON.parse(text)
  } catch (err) {
    throw fail(500, `prompts/${name} is not valid JSON: ${err.message}`)
  }
}

// Each constant below is the single place to change if the OpenAI behaviour it assumes proves wrong.

// Audio setups (LOOKMA_AUDIO). In a room the butler's voice comes back through the microphone, so
// sound never cancels a reply: it finishes its one or two sentences. With a headset the user's
// voice cuts it off (barge-in). Noise reduction matches the microphone's distance.
const SETUPS = {
  room: { noise: 'far_field', interrupt: false },
  headset: { noise: 'near_field', interrupt: true },
}

// How soon the server ends a turn at a pause. A sentence split in two is still one reply: the
// floor's next reply covers every turn that is owed.
const EAGERNESS = 'medium'

// Per-reply parameters, by the kind of reply the overlay's floor asks for (overlay/voice/floor.js):
// a reply to the user's turns may call tools; every other reply (an announcement, a tool result
// to say) is speak-only, which assumes tool_choice 'none' still yields speech.
export const RESPONSES = { turn: {}, speak: { tool_choice: 'none' } }

/** The butler's Realtime session: always listening, and replying only when the overlay asks. */
export function butlerSession(config) {
  const { model, voice, transcribe, language, audio, maxTokens } = config.voice
  const setup = SETUPS[audio]
  const tools = readPrompt(config.root, 'butler-tools.json', true)
  if (!Array.isArray(tools)) throw fail(500, 'prompts/butler-tools.json must be a JSON array of tools')
  // No transcription prompt: it makes the transcriber drop the "?" the approval check relies on.
  const transcription = { model: transcribe, ...(language && { language }) }
  return {
    type: 'realtime',
    model,
    instructions: readPrompt(config.root, 'butler.md'),
    tools,
    tool_choice: 'auto',
    max_output_tokens: maxTokens,
    audio: {
      input: {
        transcription,
        noise_reduction: { type: setup.noise },
        // The server finds each turn and never replies by itself: the overlay asks for every reply.
        turn_detection: { type: 'semantic_vad', eagerness: EAGERNESS, create_response: false, interrupt_response: setup.interrupt },
      },
      output: { voice },
    },
  }
}

// → { value, model, expiresAt, responses }, or throws an error with a status.
export async function mintVoiceKey(config) {
  const { enabled, apiKey, model } = config.voice
  // Voice off: the overlay falls back to captions and typed input, and nothing reaches OpenAI.
  if (!enabled) throw fail(503, 'voice is off (LOOKMA_NO_VOICE=1)')
  if (!apiKey) throw fail(503, 'OPENAI_API_KEY is not set (see .env.example)')
  const session = butlerSession(config)
  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw fail(res.status, data.error?.message || `key request failed (${res.status})`)
  return { value: data.value, model, expiresAt: data.expires_at, responses: RESPONSES }
}
