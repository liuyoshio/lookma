#!/usr/bin/env node
// End to end with a real interactive Claude Code in tmux, the fake app and an overlay client.
//   node core/dev/e2e.mjs [port]     (default 8791; tmux session lookma-test; model sonnet)
// Starts `core/cli.mjs start`, answers every card yes through the overlay socket (logged), then:
//   1. the startup development-channel warning shows up as a card;
//   2. "say hello in one short sentence" → a say event;
//   3. "look at the screen and tell me what app is in front" → see through the pipeline;
//   4. a Bash permission prompt gives exactly one card, answered through the relay;
//   5. cancel interrupts a running turn.
// The test session runs in permission mode "default" so that step 4 has a prompt to answer.
// Cleans up the tmux session and its processes at the end.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import WebSocket from 'ws'
import { ROOT } from '../config.mjs'

const PORT = Number(process.argv[2] || 8791)
const SESSION = 'lookma-test'
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
const pane = () => {
  try {
    return execFileSync('tmux', ['capture-pane', '-p', '-t', `=${SESSION}:`], { encoding: 'utf8' })
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- processes

function run(name, args, env) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, LOOKMA_NO_APP: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const lines = []
  const take = buf => {
    for (const line of String(buf).split('\n').filter(Boolean)) {
      lines.push(line)
      process.stdout.write(`${line.startsWith('0') || line.startsWith('1') || line.startsWith('2') ? '' : `${stamp()} ${name} `}${line}\n`)
    }
  }
  child.stdout.on('data', take)
  child.stderr.on('data', take)
  return { child, lines }
}

const core = run('core', ['core/cli.mjs', 'start'], { LOOKMA_PORT: String(PORT), LOOKMA_EXEC_SESSION: SESSION, LOOKMA_MODEL: 'sonnet', LOOKMA_DATA: DATA, LOOKMA_PERMISSION_MODE: 'default' })
const app = run('fake-app', ['core/dev/fake-app.mjs', '--port', String(PORT), '--idle', '10'], {})

async function cleanup() {
  core.child.kill('SIGTERM')
  app.child.kill('SIGTERM')
  await sleep(1500)
  let left = true
  try {
    execFileSync('tmux', ['has-session', '-t', `=${SESSION}`], { stdio: 'ignore' })
  } catch {
    left = false
  }
  if (left) execFileSync('tmux', ['kill-session', '-t', `=${SESSION}`])
  check('cleanup: the core stopped its tmux session', !left)
  fs.rmSync(DATA, { recursive: true, force: true })
}

// ---------------------------------------------------------------- overlay client

const states = []
const events = []
const answered = new Set()
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
if (!ws) {
  check('overlay connects', false)
  await cleanup()
  process.exit(1)
}
const last = () => states.at(-1)
ws.on('message', raw => {
  const m = JSON.parse(raw)
  if (m.type !== 'state') {
    events.push({ ...m, at: Date.now() })
    say(`event ${m.type} ${m.kind || ''} ${JSON.stringify(m.display || m.speech)}`)
    return
  }
  states.push(m)
  for (const c of m.cards) {
    if (answered.has(c.id)) continue
    answered.add(c.id)
    cards.push(c)
    say(`card ${c.id} [${c.source}] ${JSON.stringify(c.title)} → answering yes`)
    setTimeout(() => ws.send(JSON.stringify({ type: 'answer', cardId: c.id, allow: true, via: 'voice' })), 500)
  }
})
const tell = async text => {
  say(`tell ${JSON.stringify(text)}`)
  const r = await fetch(`${BASE}/api/tell`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  return r.ok
}
const turnEnded = ms => until(() => last()?.turn && last().turn.phase !== 'working' && last().turn, ms)

try {
  // 1. Startup warning as a card, answered through the overlay socket.
  const warn = await until(() => cards.find(c => /development channels/i.test(`${c.title} ${c.detail}`)), 60000)
  check('startup dev-channel warning arrives as a card', !!warn, warn ? warn.title : pane().slice(-600))
  const ready = await until(() => last()?.executor.status === 'ready', 90000)
  check('executor ready after the card is answered (channel connected)', !!ready, last()?.executor.detail)
  if (!ready) throw new Error('not ready:\n' + pane())

  // 2. Say hello.
  let n = events.length
  await tell('say hello in one short sentence')
  const hello = await until(() => events.slice(n).find(e => e.type === 'say'), 90000)
  check('tell "say hello" → a say event reaches the overlay', !!hello, hello?.speech)
  const t1 = await turnEnded(60000)
  check('the Stop hook ends the turn (hooks reach /hook)', t1?.phase === 'done', t1?.phase)

  // 3. See through the pipeline.
  n = events.length
  const opsBefore = app.lines.length
  await tell('look at the screen and tell me what app is in front')
  const seen = await until(() => app.lines.slice(opsBefore).find(l => / op see /.test(l)), 120000)
  check('tell "look at the screen" → a see call reaches the fake app', !!seen, seen || '')
  const grant = cards.find(c => c.title === 'Allow controlling Finder?')
  check('the first see raised the core grant card', !!grant)
  const answer = await until(() => events.slice(n).find(e => e.type === 'say' && /finder/i.test(`${e.speech} ${e.display}`)), 90000)
  check('Claude says the front app is Finder', !!answer, answer?.speech)
  const focus = states.findLast(s => s.focus?.action === 'see')?.focus
  check('focus showed the see step with its label', !!focus?.label && focus.app === 'Finder', JSON.stringify(focus && { label: focus.label, phase: focus.phase }))
  await turnEnded(60000)

  // 4. A permission prompt: relayed and drawn in the terminal, one card, answered by relay.
  n = events.length
  const cardsBefore = cards.length
  await tell('Use the Bash tool to run the command `ls /tmp` exactly once, then say how many entries it printed.')
  const counted = await until(() => events.slice(n).find(e => e.type === 'say'), 120000)
  await sleep(3000) // two more polls: a duplicate terminal card would show up by now
  const asked = cards.slice(cardsBefore)
  check('Bash prompt → exactly one card, from the relay', asked.length === 1 && asked[0].title === 'Allow Bash?', asked.map(c => c.title).join(' | '))
  check('answered yes → the command ran and Claude reported', !!counted, counted?.speech)
  await turnEnded(60000)

  // 5. Cancel.
  n = events.length
  await tell('Count from 1 to 40. Call say once per number, one call at a time, and nothing else.')
  const first = await until(() => events.slice(n).find(e => e.type === 'say'), 90000)
  check('a long turn starts saying numbers', !!first, first?.speech)
  ws.send(JSON.stringify({ type: 'cancel' }))
  const cancelAt = Date.now()
  say('sent cancel')
  const c = await until(() => last().turn?.phase === 'cancelled' && last().turn, 5000)
  check('cancel → turn.phase cancelled', !!c)
  await sleep(8000)
  const after = events.filter(e => e.type === 'say' && e.at > cancelAt + 1500)
  const screen = pane()
  check('cancel stops Claude (no more says, terminal shows the interrupt)', after.length === 0 && /Interrupted/i.test(screen), `${after.length} says after; ${/Interrupted/i.test(screen) ? 'interrupted' : 'no interrupt mark'}`)
} catch (err) {
  check('e2e ran to the end', false, err.message)
} finally {
  ws.close()
  await cleanup()
  console.log('\n' + results.join('\n'))
  console.log(failures ? `${failures} FAILED` : 'all passed')
  process.exit(failures ? 1 : 0)
}
