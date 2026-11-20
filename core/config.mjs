// Configuration: environment variables (and .env at the repo root) with defaults. The only module
// of the core that reads the environment. An adapter reads its own settings in its config.mjs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Merged into process.env, so an adapter's config.mjs sees .env too. Real environment variables win.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

export function loadConfig() {
  loadEnvFile(path.join(ROOT, '.env'))
  const env = process.env
  const dataDir = env.LOOKMA_DATA || path.join(os.homedir(), '.lookma')
  return {
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
      noise: env.LOOKMA_VOICE_NOISE === 'near_field' ? 'near_field' : 'far_field', // near_field: a headset
      maxTokens: Number(env.LOOKMA_VOICE_MAX_TOKENS) || 200, // the longest a spoken reply can be
    },
  }
}
