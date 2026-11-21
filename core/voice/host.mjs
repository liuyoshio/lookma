// The voice host: the core's side of the voice provider selected by LOOKMA_VOICE
// (voices/<name>/, loaded and checked by core/config.mjs). It hands the overlay one grant per
// session, POST /api/voice/grant, from the provider's mint.mjs; the overlay's session.js then
// imports the provider's page.js (served at /voices/<name>/page.js) and connects with it.
// Provisional until a second provider exists.
//
//   // voices/<name>/mint.mjs
//   export async function mint(ctx) -> { credential?, startBy?, renewAfter, label, session? }
//
//   ctx: { options      the provider's settings, checked (its API key among them)
//          instructions prompts/butler.md
//          tools        prompts/butler-tools.json: [{ name, description, parameters }]
//          audio        'room' | 'headset' (LOOKMA_AUDIO)
//          language     ISO 639-1, or '' (LOOKMA_VOICE_LANGUAGE)
//          log }
//
//   credential  what the page needs to open a connection (an ephemeral key), never the real key
//   startBy     epoch ms after which no connection may be started with this grant
//   renewAfter  ms after which the session is swapped at the next idle moment
//   label       for the page's log line, e.g. the model
//   session     the provider's own data for its page.js, opaque to everyone else
//
// A mint that throws is a 502: the page tries again later. No voice at all (LOOKMA_VOICE=off, a
// required setting unset) is a 503, and the page stops asking.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// An error the server answers with this HTTP status.
const fail = (status, message) => Object.assign(new Error(message), { status })

/**
 * The butler's prompts, read and checked: { instructions, tools }. Read for every grant, so an
 * edit applies to the next session.
 */
export function readPrompts(root) {
  const read = name => {
    const file = path.join(root, 'prompts', name)
    if (!fs.existsSync(file)) throw fail(500, `prompts/${name} is missing`)
    return fs.readFileSync(file, 'utf8')
  }
  const instructions = read('butler.md')
  let tools
  try {
    tools = JSON.parse(read('butler-tools.json'))
  } catch (err) {
    throw fail(500, `prompts/butler-tools.json is not valid JSON: ${err.message}`)
  }
  const isTool = t => typeof t?.name === 'string' && typeof t.description === 'string' && typeof t.parameters === 'object'
  if (!Array.isArray(tools) || !tools.every(isTool)) throw fail(500, 'prompts/butler-tools.json must be a JSON array of { name, description, parameters }')
  return { instructions, tools }
}

export function createVoiceHost(config, { log }) {
  const { provider, off, audio, language } = config.voice
  return {
    /** → { provider, credential?, startBy?, renewAfter, label, session? }, or throws an error with a status. */
    async grant() {
      if (off) throw fail(503, off)
      const prompts = readPrompts(config.root)
      const { mint } = await import(pathToFileURL(path.join(provider.dir, 'mint.mjs')).href)
      try {
        return { provider: provider.name, ...(await mint({ options: provider.options, ...prompts, audio, language, log })) }
      } catch (err) {
        throw fail(502, err.message)
      }
    },
  }
}
