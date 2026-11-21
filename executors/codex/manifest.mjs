// What the Codex adapter needs (core/plugins.mjs reads this): its settings, and the checks lookma
// doctor and the start's preflight run: Codex CLI, recent enough for its app-server, logged in,
// with the login in auth.json (session.mjs links that file). Node built-ins and the doctor's
// helpers only, so it runs before npm install.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ok, fail, sh, atLeast } from '../../core/doctor.mjs'

// app-server is experimental and changes between releases: the version this adapter was checked against.
const NEEDS = { codex: '0.163.0' }

function checkCodex({ home }) {
  const v = sh('codex', ['--version'])
  if (!v.ok) return fail('Codex CLI (codex) is not on PATH', 'npm install -g @openai/codex')
  const version = v.out.match(/\d+\.\d+\.\d+/)?.[0] || v.out
  if (!atLeast(version, NEEDS.codex)) return fail(`Codex ${version}: Lookma needs ${NEEDS.codex} or later`, 'codex update')
  // Reads the stored login; makes no model call.
  if (!sh('codex', ['login', 'status']).ok) return fail(`Codex ${version} is not logged in`, 'codex login')
  if (!fs.existsSync(path.join(home, 'auth.json'))) {
    return fail(`Codex ${version} keeps its login outside auth.json; Lookma needs the file`, [
      `Put cli_auth_credentials_store = "file" in ${path.join(home, 'config.toml')},`,
      'then log in again: codex login',
    ])
  }
  return ok(`Codex ${version}, logged in`)
}

export default {
  title: 'Codex',
  settings: {
    model: { default: '', help: "the Codex model; empty, Codex's default" },
    fast: { default: false, help: "1: Codex's Fast speed tier, quicker and uses more of your ChatGPT plan" },
    // Codex's own variable: the user's Codex, whose login the session shares.
    home: { default: path.join(os.homedir(), '.codex'), env: 'CODEX_HOME', help: "the user's Codex folder, with its login (auth.json)" },
  },
  checks: [checkCodex],
}
