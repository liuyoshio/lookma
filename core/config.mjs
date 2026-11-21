// Configuration. Every setting is one name (LOOKMA_EXECUTOR, LOOKMA_AUDIO, ...) with three sources,
// first wins: a command-line flag, the environment, .env at the repo root; then the default. The
// core's own settings are read here. A plug-in (an executor in executors/, a voice in voices/)
// declares its own in its manifest.mjs, and core/plugins.mjs reads them from the environment this
// module has filled. The only module of the core that reads the environment.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { usage } from './util.mjs'
import { list, load, manifests } from './plugins.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The core's own settings. A plug-in declares its own in its manifest; lookma doctor warns about
// any other LOOKMA_* that is set. LOOKMA_SIGN_IDENTITY is app/build.sh's, LOOKMA_LIVE_TESTS the
// dev checks'.
const CORE = ['LOOKMA_EXECUTOR', 'LOOKMA_VOICE', 'LOOKMA_AUDIO', 'LOOKMA_VOICE_LANGUAGE', 'LOOKMA_PORT', 'LOOKMA_DATA', 'LOOKMA_NO_APP', 'LOOKMA_SIGN_IDENTITY', 'LOOKMA_LIVE_TESTS']

// The named flags, each a shorthand for one setting. --set NAME=value sets any other.
const FLAGS = {
  '--agent': name => ({ LOOKMA_EXECUTOR: name }),
  '--voice': name => ({ LOOKMA_VOICE: name }),
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

// Every setting name anyone reads -> { owner, secret }: the core's and each plug-in's. Two owners
// of one name would read each other's value, so that is an error.
async function declared() {
  const names = new Map(CORE.map(name => [name, { owner: 'core', secret: false }]))
  for (const plugin of await manifests()) {
    for (const s of plugin.settings) {
      const owner = `${plugin.kind}/${plugin.name}`
      if (names.has(s.name)) throw new Error(`${s.name} is declared by both ${names.get(s.name).owner} and ${owner}`)
      names.set(s.name, { owner, secret: !!s.secret })
    }
  }
  return names
}

function envFor(names, owner) {
  const theirs = name => names.get(name)?.secret && names.get(name).owner !== owner
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !theirs(name)))
}

// An empty value counts as unset, as for every setting.
function oneOf(name, values, fallback = values[0]) {
  const v = process.env[name]
  if (!v) return fallback
  if (values.includes(v)) return v
  throw usage(`${name}=${v}: use ${values.join(' or ')}`)
}

/**
 * settings: from parseArgs. The result's `sources` says, per setting that is set, where it came
 * from; `declared` maps every setting name anyone reads to { owner, secret }.
 */
export async function loadConfig(settings = {}) {
  const names = await declared()
  const ours = name => name.startsWith('LOOKMA_') || names.has(name)
  const sources = {}
  for (const name of Object.keys(process.env)) if (ours(name)) sources[name] = 'environment'
  for (const [name, value] of Object.entries(settings)) {
    process.env[name] = value
    sources[name] = 'flag'
  }
  loadEnvFile(path.join(ROOT, '.env'), name => ours(name) && (sources[name] = '.env'))
  const env = process.env
  const dataDir = env.LOOKMA_DATA || path.join(os.homedir(), '.lookma')
  // The defaults are the one place the core names a plug-in.
  const executor = await load('executors', oneOf('LOOKMA_EXECUTOR', list('executors'), 'claude'), env)
  if (executor.missing.length) throw usage(`${executor.missing[0]} is not set (${executor.title} needs it)`)
  const voice = oneOf('LOOKMA_VOICE', [...list('voices'), 'off'], 'openai')
  const provider = voice === 'off' ? null : await load('voices', voice, env)
  return {
    sources,
    declared: names,
    root: ROOT,
    app: path.join(ROOT, 'app', 'build', 'Lookma.app'), // built by app/build.sh
    // LOOKMA_NO_APP=1: start without the app, e.g. to run it from a shell (its permissions are then
    // the terminal's) or to use core/dev/fake-app.mjs.
    launchApp: env.LOOKMA_NO_APP !== '1',
    port: Number(env.LOOKMA_PORT || 8790),
    dataDir,
    appsFile: path.join(dataDir, 'apps.json'),
    // executors/<name>, loaded (core/plugins.mjs), with the environment for its child processes:
    // everything but the secrets other plug-ins declared (the voice's API key stays with the core).
    executor: { ...executor, env: envFor(names, `executors/${executor.name}`) },
    voice: {
      provider, // voices/<name>, loaded; null with LOOKMA_VOICE=off (text only, nothing goes to a voice service)
      // Why there is no voice, or null. The overlay then shows captions and takes typed requests.
      off: !provider ? 'voice is off (LOOKMA_VOICE=off)' : provider.missing.length ? `${provider.missing[0]} is not set (see .env.example)` : null,
      language: env.LOOKMA_VOICE_LANGUAGE || '', // ISO 639-1, e.g. zh; unset, the transcriber detects it
      audio: oneOf('LOOKMA_AUDIO', ['room', 'headset']), // the provider's mint.mjs sets the service up for it
    },
  }
}
