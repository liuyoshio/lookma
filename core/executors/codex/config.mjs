// The Codex adapter's settings, from the environment. The core's loadConfig() has merged .env into
// it before any adapter is created. Node built-ins only: checks.mjs uses this before npm install.
import os from 'node:os'
import path from 'node:path'

export function loadConfig(env = process.env) {
  return {
    model: env.LOOKMA_CODEX_MODEL || null, // null: Codex's default model
    fast: env.LOOKMA_CODEX_FAST === '1', // Codex's Fast speed tier: quicker, uses more of the plan
    codexHome: env.CODEX_HOME || path.join(os.homedir(), '.codex'), // the user's own Codex, for its login
  }
}
