// What the Codex adapter needs, for lookma doctor and the start's preflight: Codex CLI, recent
// enough for its app-server, logged in, with the login in auth.json (session.mjs links that file).
// Node built-ins and the doctor's helpers only, so it runs before npm install.
import fs from 'node:fs'
import path from 'node:path'
import { ok, fail, sh, atLeast } from '../../doctor.mjs'
import { loadConfig } from './config.mjs'

// app-server is experimental and changes between releases: the version this adapter was checked against.
const NEEDS = { codex: '0.163.0' }

function checkCodex() {
  const v = sh('codex', ['--version'])
  if (!v.ok) return fail('Codex CLI (codex) is not on PATH', 'npm install -g @openai/codex')
  const version = v.out.match(/\d+\.\d+\.\d+/)?.[0] || v.out
  if (!atLeast(version, NEEDS.codex)) return fail(`Codex ${version}: Lookma needs ${NEEDS.codex} or later`, 'codex update')
  // Reads the stored login; makes no model call.
  if (!sh('codex', ['login', 'status']).ok) return fail(`Codex ${version} is not logged in`, 'codex login')
  const { codexHome } = loadConfig()
  if (!fs.existsSync(path.join(codexHome, 'auth.json'))) {
    return fail(`Codex ${version} keeps its login outside auth.json; Lookma needs the file`, [
      `Put cli_auth_credentials_store = "file" in ${path.join(codexHome, 'config.toml')},`,
      'then log in again: codex login',
    ])
  }
  return ok(`Codex ${version}, logged in`)
}

export const checks = [checkCodex]
