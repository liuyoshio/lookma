// Configuration. Every setting is one name (LOOKMA_EXECUTOR, LOOKMA_AUDIO, ...) with three sources,
// first wins: a command-line flag, the environment, .env at the repo root; then the default. All
// three end up in process.env, so an adapter's config.mjs sees them too. The only module of the
// core that reads the environment.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const usage = message => Object.assign(new Error(`${message} (see lookma --help)`), { exitCode: 2 })

// The named flags, each a shorthand for one setting. --set NAME=value sets any other.
const FLAGS = {
  '--agent': name => ({ LOOKMA_EXECUTOR: name }),
  '--voice': name => {
    if (!['openai', 'off'].includes(name)) throw usage(`--voice ${name}: use openai or off`)
    return { LOOKMA_NO_VOICE: name === 'off' ? '1' : '0' }
  },
  '--audio': setup => ({ LOOKMA_AUDIO: setup }),
  '--set': pair => {
    const m = pair.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (!m) throw usage(`--set ${pair}: use --set NAME=value`)
    return { [m[1]]: m[2] }
  },
}

/**
 * Split command-line arguments into settings (from the flags above, as `--flag value` or
 * `--flag=value`) and the rest. `allowed` lists a command's own options, passed through in rest.
 */
export function parseArgs(args, allowed = []) {
  const settings = {}
  const rest = []
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s)
    if (FLAGS[flag]) {
      const value = inline ?? args[++i]
      if (value == null || value.startsWith('--')) throw usage(`${flag} needs a value`)
      Object.assign(settings, FLAGS[flag](value))
    } else if (args[i].startsWith('-') && !allowed.includes(args[i])) {
      throw usage(`unknown option ${args[i]}`)
    } else rest.push(args[i])
  }
  return { settings, rest }
}

// Read into process.env, without overriding what is already there. Calls set(name) for each it sets.
function loadEnvFile(file, set) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      set(m[1])
    }
  }
}

const ours = name => name.startsWith('LOOKMA_') || name === 'OPENAI_API_KEY'

function oneOf(name, values) {
  const v = process.env[name]
  if (v === undefined || values.includes(v)) return v ?? values[0]
  throw usage(`${name}=${v}: use ${values.join(' or ')}`)
}

/** settings: from parseArgs. The result's `sources` says, per setting that is set, where it came from. */
export function loadConfig(settings = {}) {
  const sources = {}
  for (const name of Object.keys(process.env)) if (ours(name)) sources[name] = 'environment'
  for (const [name, value] of Object.entries(settings)) {
    process.env[name] = value
    sources[name] = 'flag'
  }
  loadEnvFile(path.join(ROOT, '.env'), name => ours(name) && (sources[name] = '.env'))
  const env = process.env
  const dataDir = env.LOOKMA_DATA || path.join(os.homedir(), '.lookma')
  return {
    sources,
    root: ROOT,
    app: path.join(ROOT, 'app', 'build', 'Lookma.app'), // built by app/build.sh
    // LOOKMA_NO_APP=1: start without the app, e.g. to run it from a shell (its permissions are then
    // the terminal's) or to use core/dev/fake-app.mjs.
    launchApp: env.LOOKMA_NO_APP !== '1',
    port: Number(env.LOOKMA_PORT || 8790),
    dataDir,
    appsFile: path.join(dataDir, 'apps.json'),
    executor: env.LOOKMA_EXECUTOR || 'claude', // core/executors/<name>
    voice: {
      enabled: env.LOOKMA_NO_VOICE !== '1', // LOOKMA_NO_VOICE=1: text only, no OpenAI calls (self-tests)
      apiKey: env.OPENAI_API_KEY || '',
      model: env.LOOKMA_REALTIME_MODEL || 'gpt-realtime-2.1',
      voice: env.LOOKMA_VOICE || 'marin',
      transcribe: env.LOOKMA_TRANSCRIBE_MODEL || 'gpt-4o-transcribe',
      language: env.LOOKMA_VOICE_LANGUAGE || '', // ISO 639-1, e.g. zh; unset, the transcriber detects it
      audio: oneOf('LOOKMA_AUDIO', ['room', 'headset']), // the setup in core/voice-key.mjs
      maxTokens: Number(env.LOOKMA_VOICE_MAX_TOKENS) || 200, // the longest a spoken reply can be
    },
  }
}
