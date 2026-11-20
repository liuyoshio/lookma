// Mints short-lived OpenAI Realtime keys for the overlay, with the butler session baked in.
// The real key never leaves the core.
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

/** The butler's Realtime session: always listening, and replying only when the overlay asks. */
export function butlerSession(config) {
  const { model, voice, transcribe, language, noise, maxTokens } = config.voice
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
        noise_reduction: { type: noise },
        // The server finds each turn, patiently, and stops the butler when the user talks over it.
        // It never replies by itself: the overlay asks only for turns worth answering.
        turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: false, interrupt_response: true },
      },
      output: { voice },
    },
  }
}

// → { value, model, expiresAt }, or throws an error with a status.
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
  return { value: data.value, model, expiresAt: data.expires_at }
}
