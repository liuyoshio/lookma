#!/usr/bin/env node
// Development harness for the overlay. Serves overlay/ (and each voice provider's page.js) and
// plays the core's side of /ws/overlay (docs/protocol.md) from the script in scenario.mjs,
// against the fake desktop in desk.js (open the page with ?backdrop=1 to see it). It has no
// voice: POST /api/voice/grant is a 503 (check-voices.mjs fakes the grant in the page).
//
//   node overlay/dev/mock-core.mjs [--port 8797] [--speed 1] [--from <mark>] [--hold]
//
//   --from <mark>  fast-forward to that mark (cards are approved, waits resumed), then play.
//                  Only the state is fast-forwarded: says, reports and heard lines on the way
//                  are left out, so nothing from the skipped part is owed to the voice.
//   --hold         stop at the --from mark
//
// stdout is JSON lines: {"mark":…} when the script passes a mark, {"from":"overlay","msg":…}
// for every overlay -> core message, {"auto":…} for what the fast-forward answered itself.
// Requests (tell, answer, control) are acked to the requester, as the core does. What the work
// says goes into the outbox (the core's own core/outbox.mjs), with an entry for the card on screen,
// and the page's receipts (delivered) are applied to it.
// The scenario starts when the first overlay connects; POST /dev/restart {from?, hold?}
// starts it again (the outbox lives on, as the core's would). POST /dev/paused {paused} stands in
// for the app's menu bar and ⌃⌥P. POST /dev/say {speech, display?, kind?} posts one executor
// `say` now. POST /dev/drop closes the overlay sockets, as a dropped link would.
// GET /api/state returns the current snapshot.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { scenario } from './scenario.mjs'
import { createOutbox } from '../../core/outbox.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VOICES = path.resolve(ROOT, '..', 'voices')
const opts = parseArgs(process.argv.slice(2))
const PORT = opts.port

function parseArgs(argv) {
  const o = { port: 8797, speed: 1, from: null, hold: false }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--port') o.port = Number(argv[++i])
    else if (k === '--speed') o.speed = Number(argv[++i])
    else if (k === '--from') o.from = argv[++i]
    else if (k === '--hold') o.hold = true
    else throw new Error(`unknown argument ${k}`)
  }
  return o
}

const out = obj => process.stdout.write(JSON.stringify(obj) + '\n')

// ------------------------------------------------------------ core state

const state = {
  executor: { name: 'claude', status: 'ready', detail: '' },
  turn: null,
  focus: null,
  attention: { busy: false, idle: 30 },
  cards: [],
  tasks: [],
  outbox: [],
  paused: false,
}

const clients = new Set()
let pending = false
function changed() { // coalesced, like the real core
  if (pending) return
  pending = true
  setImmediate(() => { pending = false; broadcast({ type: 'state', ...state }) })
}
function broadcast(msg) {
  const data = JSON.stringify(msg)
  for (const ws of clients) ws.send(data)
}

// ------------------------------------------------------------ outbox and cards

let ids = 0
const outbox = createOutbox({ store: { data: state, update: fn => { fn(state); changed() } }, nextId: prefix => `${prefix}${++ids}` })

/** What the work says: an entry of the working turn, if any. */
function say(speech, display = speech, kind = 'info') {
  outbox.post({ kind, speech, display, turnId: state.turn?.phase === 'working' ? state.turn.id : null })
}

// Like the core's changeCards: the card on screen (the head) has an outbox entry, held, and an
// entry goes when its card goes.
function changeCards(fn) {
  state.cards = fn(state.cards)
  outbox.drop(e => e.cardId && !state.cards.some(c => c.id === e.cardId))
  const head = state.cards[0]
  if (head && !state.outbox.some(e => e.cardId === head.id)) {
    outbox.post({ kind: 'card', cardId: head.id, turnId: head.turnId, held: true, speech: [head.title, head.detail].filter(Boolean).join('\n') })
  }
  changed()
}

// ------------------------------------------------------------ the script's side

class Aborted extends Error {}
class Cancelled extends Error {}

let run = null // { gen, ff, from, hold, waits: Map }
let gen = 0

function startScenario({ from = null, hold = false } = {}) {
  if (run) for (const w of run.waits.values()) w.reject(new Aborted())
  Object.assign(state, { turn: null, focus: null, attention: { busy: false, idle: 30 }, tasks: [], paused: false })
  changeCards(() => [])
  const r = run = { gen: ++gen, ff: !!from, from, hold, waits: new Map() }
  const ctx = makeContext(r)
  scenario(ctx).then(() => out({ done: true }), err => { if (!(err instanceof Aborted)) out({ error: String(err.stack || err) }) })
}

function makeContext(r) {
  const live = () => { if (r !== run) throw new Aborted() }
  const now = () => Date.now()
  const guard = () => { live(); if (r.turnId && state.turn?.id === r.turnId && state.turn.phase === 'cancelled') throw new Cancelled() }

  const wait = (key, ms) => new Promise((resolve, reject) => {
    const timer = ms ? setTimeout(() => { r.waits.delete(key); resolve(null) }, ms) : null
    r.waits.set(key, { resolve: v => { clearTimeout(timer); r.waits.delete(key); resolve(v) }, reject: e => { clearTimeout(timer); reject(e) } })
  })

  const s = {
    async sleep(sec) {
      guard()
      if (r.holding) await wait('hold') // --hold: stay here until restarted
      if (!r.ff) await new Promise(res => setTimeout(res, (sec * 1000) / opts.speed))
      guard()
    },
    mark(name) {
      live()
      out({ mark: name })
      if (r.ff && name === r.from) {
        r.ff = false
        r.holding = r.hold
      }
    },
    heard(text) { live(); if (!r.ff) broadcast({ type: 'mock:heard', text }) },
    say(display, speech = display, kind = 'info') { live(); if (!r.ff) say(speech, display, kind) },
    attention(busy) { live(); state.attention = { busy, idle: busy ? 0.3 : 30 }; changed() },
    status(text) { guard(); state.turn.status = text; changed() },
    steer(sent) { guard(); state.turn.sent = sent; changed() },

    async turn(sent, body) {
      live()
      const id = `turn-${++ids}`
      r.turnId = id
      state.turn = { id, sent, status: '', phase: 'working', startedAt: now(), endedAt: null }
      changed()
      let phase = 'done'
      try { await body() } catch (err) {
        if (err instanceof Cancelled) phase = 'cancelled'
        else throw err
      }
      if (state.turn?.id === id && state.turn.phase === 'working') {
        state.turn.phase = phase
        state.turn.endedAt = now()
      }
      r.turnId = null
      changed()
    },

    // One hands step, the way the core's pipeline marks it.
    async step({ action, app, label, rect, point = null, background = false, needsFront = false, mark, hold = 0.7 }) {
      guard()
      const f = state.focus = { id: `step-${++ids}`, label, action, app, rect, point, phase: 'moving', background, at: now() }
      state.turn.status = label
      if (needsFront && state.attention.busy) {
        f.phase = 'waiting'
        changed()
        s.mark('waiting')
        // The user says go ahead, or stops for a while (idle).
        const how = r.ff ? 'auto' : (await wait('resume', 12000 / opts.speed)) || 'idle'
        out({ resumed: how })
        guard()
        s.attention(false)
        f.phase = 'moving'
        f.at = now()
      }
      changed()
      await s.sleep(0.4)
      f.phase = 'acting'; f.at = now(); changed()
      if (mark) s.mark(mark)
      await s.sleep(hold)
      f.phase = 'done'; f.at = now(); changed()
      await s.sleep(1.1)
    },

    // An approval card; resolves with the user's answer.
    async card({ title, detail, options = null, source = 'executor', mark }) {
      guard()
      const c = { id: `card-${++ids}`, title, detail, options, source, turnId: r.turnId ?? null, createdAt: now() }
      changeCards(cards => [...cards, c])
      if (mark) s.mark(mark)
      let allow = true
      if (r.ff) out({ auto: 'answer', cardId: c.id, allow })
      else allow = await wait(`answer:${c.id}`)
      changeCards(cards => cards.filter(x => x.id !== c.id))
      guard()
      return allow
    },

    task(id, title, action) {
      live()
      const t = state.tasks.find(x => x.id === id)
      if (t) Object.assign(t, { title, action })
      else state.tasks.push({ id, title, status: 'running', action, startedAt: now(), endedAt: null })
      changed()
    },
    taskDone(id, display, speech = display) {
      live()
      const t = state.tasks.find(x => x.id === id)
      Object.assign(t, { status: 'done', action: '', endedAt: now() })
      changed()
      if (!r.ff) outbox.post({ kind: 'report', taskId: id, title: t.title, speech, display })
    },
  }
  return s
}

// ------------------------------------------------------------ overlay -> core

// Like the core's stop(): false when no turn is working; the stopped turn's cards and untold
// lines go with it.
function stopTurn() {
  if (state.turn?.phase !== 'working') return false
  const id = state.turn.id
  Object.assign(state.turn, { phase: 'cancelled', endedAt: Date.now() })
  if (state.focus) state.focus.phase = 'done'
  outbox.drop(e => e.turnId === id && !e.delivered)
  changeCards(cards => cards.filter(c => c.turnId !== id))
  for (const [k, w] of run?.waits || []) if (k.startsWith('answer:') || k === 'resume') w.resolve(null)
  return true
}

// Like the core: pausing stops a working turn as "stop" does.
function setPaused(paused) {
  if (state.paused === paused) return
  if (paused) stopTurn()
  state.paused = paused
  changed()
}

const ok = (extra = {}) => ({ ok: true, ...extra })
const fail = error => ({ ok: false, error })

// Each returns the request's ack, as the core's REQUESTS do.
const REQUESTS = {
  tell(m) {
    if (state.paused) return fail('Paused. Resume from the menu bar or with ⌃⌥P first.')
    // Steer a running turn; otherwise answer with a tiny turn so typed input shows something.
    if (state.turn?.phase === 'working') { state.turn.sent = m.text; changed(); return ok({ state: 'added' }) }
    const id = `turn-${++ids}`
    state.turn = { id, sent: m.text, status: 'Mock core: no executor here', phase: 'working', startedAt: Date.now(), endedAt: null }
    changed()
    setTimeout(() => {
      if (state.turn?.id !== id || state.turn.phase !== 'working') return // stopped meanwhile
      say(`Got it: ${m.text}`, `(mock) Got: ${m.text}`)
      Object.assign(state.turn, { phase: 'done', endedAt: Date.now() })
      changed()
    }, 1500)
    return ok({ state: 'started' })
  },
  answer(m) {
    if (!state.cards.some(c => c.id === m.cardId)) return fail('gone')
    run?.waits.get(`answer:${m.cardId}`)?.resolve(m.allow === true)
    return ok()
  },
  control: m => (Object.hasOwn(CONTROLS, m.action) ? CONTROLS[m.action]() : fail('unknown_action')),
}
const CONTROLS = {
  stop: () => (stopTurn() ? ok() : fail('nothing_running')),
  go_ahead() {
    const w = run?.waits.get('resume')
    if (!w) return fail('not_waiting')
    w.resolve('resume')
    return ok()
  },
  pause: () => (setPaused(true), ok()),
}

function onOverlayMessage(msg, reply) {
  out({ from: 'overlay', msg })
  if (Object.hasOwn(REQUESTS, msg.type)) reply({ type: 'ack', id: msg.id, ...REQUESTS[msg.type](msg) })
  if (msg.type === 'delivered') outbox.deliver(msg.ids, msg.how)
}

// ------------------------------------------------------------ HTTP + WebSocket

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`])

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readJson(req) {
  return new Promise(resolve => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')) } catch { resolve({}) } })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'JSON only' })
  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state)
  if (req.method === 'POST' && url.pathname === '/api/voice/grant') return json(res, 503, { error: 'The mock core has no voice; open the page with ?voice=0.' })
  if (req.method === 'POST' && url.pathname === '/dev/restart') {
    const b = await readJson(req)
    startScenario({ from: b.from || null, hold: !!b.hold })
    return json(res, 200, { ok: true })
  }
  if (req.method === 'POST' && url.pathname === '/dev/say') {
    const b = await readJson(req)
    say(b.speech, b.display || b.speech, b.kind || 'info')
    return json(res, 200, { ok: true })
  }
  if (req.method === 'POST' && url.pathname === '/dev/drop') {
    for (const ws of clients) ws.close()
    return json(res, 200, { ok: true })
  }
  if (req.method === 'POST' && url.pathname === '/dev/paused') {
    setPaused(!!(await readJson(req)).paused)
    return json(res, 200, { ok: true })
  }
  if (req.method !== 'GET') return json(res, 404, { error: 'not found' })
  // The overlay at /, and a voice provider's page half at /voices/<name>/page.js, as the core serves them.
  const voice = url.pathname.match(/^\/voices\/([a-z0-9-]+)\/page\.js$/)
  const dir = voice ? VOICES : ROOT
  const file = voice ? path.join(VOICES, voice[1], 'page.js') : path.join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname))
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'not found' })
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  fs.createReadStream(file).pipe(res)
})

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x')
  const origin = req.headers.origin
  if (pathname !== '/ws/overlay' || (origin && !ORIGINS.has(origin))) { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, ws => {
    clients.add(ws)
    ws.send(JSON.stringify({ type: 'state', ...state }))
    const reply = body => ws.send(JSON.stringify(body))
    ws.on('message', data => { try { onOverlayMessage(JSON.parse(data), reply) } catch {} })
    ws.on('close', () => clients.delete(ws))
    if (!run) startScenario({ from: opts.from, hold: opts.hold })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`mock core: http://127.0.0.1:${PORT}/?backdrop=1&voice=0\n`)
})
