// The OpenAI Realtime voice, core half (the contract: core/voice/host.mjs). Mints a short-lived
// Realtime key for the page with the butler's session baked in (set up for a room or a headset),
// and hands the page the parameters each kind of reply is asked for with, and the session's turn
// detection, which the page switches off while the key holds a turn and restores after. The talk
// mode is not an input: one grant serves both. The real key never leaves the core.

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

// A new session, while idle, before the Realtime limit of 60 minutes.
const RENEW_AFTER_MS = 50 * 60000

// Per-reply parameters, by the kind of reply the overlay's floor asks for (overlay/voice/floor.js):
// a reply to the user's turns may call tools; every other reply (an announcement, a tool result
// to say) is speak-only, which assumes tool_choice 'none' still yields speech.
export const RESPONSES = { turn: {}, speak: { tool_choice: 'none' } }

/** The butler's Realtime session: the server finds the turns, and replies only when the overlay asks. */
export function butlerSession({ options, instructions, tools, audio, language }) {
  const setup = SETUPS[audio]
  // No transcription prompt: it makes the transcriber drop the "?" the approval check relies on.
  const transcription = { model: options.transcribeModel, ...(language && { language }) }
  return {
    type: 'realtime',
    model: options.model,
    instructions,
    tools: tools.map(tool => ({ type: 'function', ...tool })),
    tool_choice: 'auto',
    max_output_tokens: options.maxTokens,
    audio: {
      input: {
        transcription,
        noise_reduction: { type: setup.noise },
        // The server finds each turn and never replies by itself: the overlay asks for every reply.
        turn_detection: { type: 'semantic_vad', eagerness: EAGERNESS, create_response: false, interrupt_response: setup.interrupt },
      },
      output: { voice: options.voice },
    },
  }
}

/** One grant: an ephemeral key, usable to start a call until it expires. */
export async function mint(ctx) {
  const session = butlerSession(ctx)
  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.options.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error?.message || `key request failed (${res.status})`)
  return {
    credential: data.value,
    startBy: data.expires_at * 1000,
    renewAfter: RENEW_AFTER_MS,
    label: ctx.options.model,
    session: { responses: RESPONSES, detection: session.audio.input.turn_detection },
  }
}
