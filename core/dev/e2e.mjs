#!/usr/bin/env node
// End to end with a real Claude Code, headless through the Agent SDK, the fake app and an overlay
// client. Voice off, so nothing goes to OpenAI; one short Sonnet turn on your Claude plan.
//   node core/dev/e2e.mjs [port]     (default 8791, a scratch data dir)
// Starts `core/cli.mjs start`, then:
//   1. the executor gets ready, with no card on the way;
//   2. "say hello" → a say in the outbox, with no card (say never asks), and the turn ends done;
//   3. the core stops on SIGTERM and takes its Claude Code and tools bridge with it.
// Started from inside another agent's session, run it with a plain environment (env -i HOME=...
// USER=... PATH=...), so the Claude Code session does not inherit that session's API settings.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import WebSocket from 'ws'
import { ROOT } from '../config.mjs'

const PORT = Number(process.argv[2] || 8791)
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lookma-e2e-'))
const BASE = `http://127.0.0.1:${PORT}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
const stamp = () => new Date().toISOString().slice(11, 23)
const say = line => process.stdout.write(`${stamp()} e2e ${line}\n`)

let failures = 0
const results = []
function check(name, ok, detail = '') {
  if (!ok) failures++
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  say(results.at(-1))
}
async function until(pred, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = pred()
    if (v) return v
  }
  return null
}
const alive = pid => {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}
// The process tree under pid.
function descendants(pid) {
  let out = ''
  try {
    out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
  } catch {} // pgrep exits 1 when there is none
  return out.split('\n').filter(Boolean).map(Number).flatMap(p => [p, ...descendants(p)])
}

// ---------------------------------------------------------------- processes

function run(name, args, env) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const take = buf => {
    for (const line of String(buf).split('\n').filter(Boolean)) process.stdout.write(`${/^\d/.test(line) ? '' : `${stamp()} ${name} `}${line}\n`)
  }
  child.stdout.on('data', take)
  child.stderr.on('data', take)
  return child
}

const core = run('core', ['core/cli.mjs', 'start'], {
  LOOKMA_PORT: String(PORT),
  LOOKMA_DATA: DATA,
  LOOKMA_NO_APP: '1',
  LOOKMA_VOICE: 'off',
  LOOKMA_EXECUTOR: 'claude',
  LOOKMA_CLAUDE_MODEL: 'sonnet',
})
const app = run('fake-app', ['core/dev/fake-app.mjs', '--port', String(PORT), '--idle', '10'], {})

// ---------------------------------------------------------------- overlay client

const states = []
const says = []
const cards = []
let ws
for (let i = 0; i < 50 && !ws; i++) {
  await sleep(200)
  ws = await new Promise(resolve => {
    const sock = new WebSocket(`${BASE.replace('http', 'ws')}/ws/overlay`, { origin: BASE })
    sock.on('open', () => resolve(sock))
    sock.on('error', () => resolve(null))
  })
}
const last = () => states.at(-1)
const seen = new Set() // outbox entry ids and card ids
ws?.on('message', raw => {
  const m = JSON.parse(raw)
  if (m.type !== 'state') return
  states.push(m)
  for (const e of m.outbox) {
    if (seen.has(e.id) || e.kind === 'card' || e.kind === 'report') continue
    seen.add(e.id)
    says.push(e)
    say(`say ${e.kind} ${JSON.stringify(e.display)}`)
  }
  for (const c of m.cards) {
    if (seen.has(c.id)) continue
    seen.add(c.id)
    cards.push(c)
    say(`card ${c.id} [${c.source}] ${JSON.stringify(c.title)}`)
  }
})

let tree = []
try {
  check('overlay connects', !!ws)
  if (!ws) throw new Error('no overlay socket')

  // 1. Ready.
  const ready = await until(() => last()?.executor.status === 'ready' && last(), 60000)
  check('the executor gets ready, with no card on the way', !!ready && cards.length === 0, JSON.stringify(last()?.executor))
  if (!ready) throw new Error('not ready')
  tree = descendants(core.pid)

  // 2. Say hello.
  const r = await fetch(`${BASE}/api/tell`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Say hello in one short sentence with the say tool, and do nothing else.' }) })
  check('tell is accepted', r.ok, String(r.status))
  const hello = await until(() => says[0], 90000)
  check('a say reaches the outbox, with no card', !!hello && cards.length === 0, hello?.speech)
  const end = await until(() => last()?.turn?.phase !== 'working' && last().turn, 60000)
  check('the turn ends done', end?.phase === 'done', end?.phase)
} catch (err) {
  check('e2e ran to the end', false, err.message)
} finally {
  ws?.close()
  core.kill('SIGTERM')
  app.kill('SIGTERM')
  const gone = await until(() => tree.every(p => !alive(p)) && !alive(core.pid), 10000)
  check('SIGTERM: the core, its Claude Code and its tools bridge are gone', !!gone && tree.length > 0, `${tree.length} children, alive ${tree.filter(alive)}`)
  fs.rmSync(DATA, { recursive: true, force: true })
  console.log('\n' + results.join('\n'))
  console.log(failures ? `${failures} FAILED` : 'all passed')
  process.exit(failures ? 1 : 0)
}
