#!/usr/bin/env node
// Checks the core against the fake app and a stub executor adapter, with this script as its tools
// bridge on /ws/executor: server rules, snapshot coalescing, routing (with the outbox's say and
// report entries, and the executor's cards), the overlay's requests and their acks, unknown
// messages, the hands pipeline (grant, see with and without a screenshot, busy vs idle, the mark
// wait only before an act, the list after every act and a failed list after a done act, ids kept
// across lists, two queued clicks from one list, a right click and its menu, a drag and its two
// ends, waiting plus go ahead, stale element, bad args, scroll, open, stop, one step at a time),
// pause and resume, and quit.
//   node core/dev/check-pipeline.mjs [port]      (default 8792; a scratch data dir is used)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { loadConfig } from '../config.mjs'
import { createCore } from '../core.mjs'
import { TOOL_NAMES } from '../hands.mjs'
import { startServer } from '../server.mjs'
import { HANDS } from '../tools.mjs'
import { createVoiceHost } from '../voice/host.mjs'
import { startFakeApp } from './fake-app.mjs'

const PORT = Number(process.argv[2] || 8792)
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lookma-check-'))
process.env.LOOKMA_PORT = String(PORT)
process.env.LOOKMA_DATA = DATA

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(pred, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) {
    const v = pred()
    if (v) return v
  }
  return null
}
const settle = p => p.then(v => ({ ok: true, v }), e => ({ ok: false, e }))

// ---------------------------------------------------------------- setup

// The stub adapter records what the host asks of it and keeps the ctx: emit its events, and ask
// the user as an agent's question would.
const calls = []
let emit, ask
function stubExecutor(ctx) {
  ;({ emit, ask } = ctx)
  const rec = name => async (...args) => void calls.push({ name, args })
  return { start: rec('start'), prompt: rec('prompt'), interrupt: rec('interrupt'), close: rec('close') }
}

const config = await loadConfig()
const quiet = () => {}
const logs = [] // the core's log lines
const log = (...args) => logs.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
// Quit in the app's menu bar: what cli.mjs's shutdown does, without process.exit.
let quitDone = false
async function shutdown() {
  await core.stop()
  server.close()
  quitDone = true
}
const core = await createCore(config, { log, createExecutor: stubExecutor, onQuit: shutdown })
const server = await startServer({ config, core, log: quiet })
await core.startExecutor([])
fs.writeFileSync(config.appsFile, JSON.stringify({ Notes: true, Finder: true }))

const app = startFakeApp({ port: PORT, idle: 10 })
await app.ready

// The tools bridge's side of /ws/executor: say and the hands, as the agent's tool calls would.
const bridge = new WebSocket(`ws://127.0.0.1:${PORT}/ws/executor`)
await new Promise(r => bridge.on('open', r))
const replies = new Map() // call id -> { resolve, reject }
bridge.on('message', raw => {
  const m = JSON.parse(raw)
  if (m.ok) replies.get(m.id).resolve(m.result)
  else replies.get(m.id).reject(new Error(m.error))
})
let callIds = 0
function hands(tool, args) {
  const id = ++callIds
  bridge.send(JSON.stringify({ type: 'call', id, tool, args }))
  return new Promise((resolve, reject) => replies.set(id, { resolve, reject }))
}
const say = (speech, extra) => hands('say', { speech, ...extra })

const overlay = new WebSocket(`ws://127.0.0.1:${PORT}/ws/overlay`, { origin: `http://127.0.0.1:${PORT}` })
const states = []
const events = []
overlay.on('message', raw => {
  const m = JSON.parse(raw)
  ;(m.type === 'state' ? states : events).push(m)
})
await new Promise(r => overlay.on('open', r))
const last = () => states[states.length - 1]
const tellOverlay = msg => overlay.send(JSON.stringify(msg))
// An overlay request: sent with an id; resolves with its ack (null: none in time).
let requests = 0
async function request(msg) {
  const id = `t${++requests}`
  tellOverlay({ ...msg, id })
  const ack = await until(() => events.find(e => e.type === 'ack' && e.id === id))
  return ack && (({ type, id, ...rest }) => rest)(ack)
}
const acked = (ack, want) => JSON.stringify(ack) === JSON.stringify(want)
await until(() => last()?.attention?.idle === 10)

const post = (p, body, type = 'application/json') =>
  fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { 'Content-Type': type }, body })

// ---------------------------------------------------------------- server rules

{
  const r = await post('/api/tell', 'hello', 'text/plain')
  check('POST without application/json is refused', r.status === 415, `status ${r.status}`)
  const opened = origin =>
    new Promise(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/overlay`, origin ? { origin } : {})
      ws.on('open', () => (ws.close(), resolve(true)))
      ws.on('error', () => resolve(false))
    })
  check('websocket from a foreign origin is refused', !(await opened('https://example.com')))
  check('websocket from our own origin is accepted', await opened(`http://localhost:${PORT}`))
  check('websocket without an origin is accepted', await opened(null))
  const s = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json()
  check('GET /api/state is a full snapshot', ['executor', 'turn', 'focus', 'attention', 'cards', 'tasks'].every(k => k in s), Object.keys(s).join(','))
}

// ---------------------------------------------------------------- coalescing

{
  await sleep(50)
  const before = states.length
  for (let i = 0; i < 30; i++) core.store.update(s => (s.attention = { ...s.attention }))
  await sleep(80)
  check('30 changes in one frame give one snapshot', states.length - before === 1, `${states.length - before} snapshots`)
}

// ---------------------------------------------------------------- routing

{
  const r = await post('/api/tell', JSON.stringify({ text: 'open slack' }))
  check('POST /api/tell starts a turn and prompts', r.ok && JSON.stringify(calls.at(-1)) === '{"name":"prompt","args":["open slack"]}' && !!(await until(() => last().turn?.phase === 'working')), `status ${r.status}`)
  await until(() => last().executor.status === 'busy')
  check('executor shows busy during a turn', last().executor.status === 'busy')
  const steered = await request({ type: 'tell', text: 'actually open notes', source: 'voice' })
  check('tell during a turn goes to the agent as a prompt too, acked "added"', acked(steered, { ok: true, state: 'added' }) && JSON.stringify(calls.at(-1)?.args) === '["actually open notes"]' && !!(await until(() => last().turn.sent === 'actually open notes')), JSON.stringify(steered))
  emit({ type: 'step', title: 'Read notes.txt' })
  check('a step updates turn.status', !!(await until(() => last().turn.status === 'Read notes.txt')))
  const said = await say('On it.')
  check('say through the bridge is in the snapshot\'s outbox, as an entry of the turn', said.text === 'said' && !!(await until(() => last().outbox?.find(e => e.speech === 'On it.' && e.display === 'On it.' && e.kind === 'info' && e.turnId === last().turn.id && e.delivered === null))))
  const bad = await settle(say('Hm.', { kind: 'shout' }))
  check('a say with a bad kind is refused, in words the agent reads', !bad.ok && /kind is one of info, question, confirm/.test(bad.e.message), bad.e?.message)
  emit({ type: 'task', id: 'a1', title: 'Sum receipts', status: 'running' })
  emit({ type: 'task', id: 'a1', status: 'done', result: { speech: 'Twelve thousand yen.', display: '¥12,000' } })
  check('the report is in the snapshot\'s outbox with taskId and title', !!(await until(() => last().outbox?.find(e => e.kind === 'report' && e.taskId === 'a1' && e.title === 'Sum receipts' && e.display === '¥12,000'))))
  check('the task row is done', !!(await until(() => last().tasks.find(t => t.id === 'a1')?.status === 'done')))
  const asked = ask({ title: 'Allow Bash?', detail: 'ls' })
  const ap1 = (await until(() => last().cards.find(c => c.title === 'Allow Bash?')))?.id
  const { cards } = await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json()
  check('a card is id, title, detail, source, turnId and createdAt, nothing else; raised in a turn, it is that turn\'s', JSON.stringify(Object.keys(cards.find(c => c.id === ap1)).sort()) === '["createdAt","detail","id","source","title","turnId"]' && cards.find(c => c.id === ap1).turnId === last().turn.id && cards.find(c => c.id === ap1).source === 'executor', JSON.stringify(cards))
  const answered = await request({ type: 'answer', cardId: ap1, allow: true, via: 'voice' })
  check('answering an executor card resolves its ask, acked', acked(answered, { ok: true }) && (await asked) === true && !!(await until(() => !last().cards.some(c => c.id === ap1))), JSON.stringify(answered))
  const again = await request({ type: 'answer', cardId: ap1, allow: true, via: 'click' })
  check('answering a card that is gone: acked "gone"', acked(again, { ok: false, error: 'gone' }), JSON.stringify(again))
  const ctl = new AbortController()
  const closed = ask({ title: 'x' }, ctl.signal)
  await until(() => last().cards.some(c => c.title === 'x'))
  ctl.abort()
  check('a card the agent closes itself goes, and its ask is null', (await closed) === null && !!(await until(() => !last().cards.some(c => c.title === 'x'))))
  emit({ type: 'turnEnd', ok: true })
  check('turnEnd ends the turn', !!(await until(() => last().turn.phase === 'done')))
}

// ---------------------------------------------------------------- unknown messages

{
  const unknown = from => logs.filter(l => l === `unknown ${from} message type "nope", ignored`).length
  emit({ type: 'nope' })
  emit({ type: 'nope' })
  tellOverlay({ type: 'nope' })
  tellOverlay({ type: 'nope' })
  app.send({ type: 'nope' })
  app.send({ type: 'nope' })
  await until(() => unknown('overlay') && unknown('app'))
  check('an unknown executor event is logged once', unknown('executor') === 1, logs.filter(l => /unknown/.test(l)).join('; '))
  check('an unknown overlay or app message type is logged once', unknown('overlay') === 1 && unknown('app') === 1)
}

// ---------------------------------------------------------------- hands

const opsSince = n => app.ops.slice(n).map(o => o.op)

check('the pipeline runs exactly the hands tools core/tools.mjs describes', TOOL_NAMES.join() === HANDS.map(t => t.name).join(), `${TOOL_NAMES} vs ${HANDS.map(t => t.name)}`)

{
  // Grant: yes, persisted.
  fs.writeFileSync(config.appsFile, JSON.stringify({ Notes: true }))
  const p = settle(hands('see', { label: 'Look at the screen' }))
  const card = await until(() => last().cards.find(c => c.source === 'core'))
  check('first touch of an app raises a core card', card?.title === 'Allow controlling Finder?', card?.title)
  tellOverlay({ type: 'answer', cardId: card?.id, allow: true, via: 'click' })
  const r = await p
  check('grant yes: see returns the element text, states and facts, and no image unless asked', r.ok && !r.v.image && /App: Finder/.test(r.v.text) && /No screenshot/.test(r.v.text) && /e\d+ button "Back"\n/.test(r.v.text) && /e\d+ row "report.pdf" \(selected\)/.test(r.v.text) && /1 element has no label/.test(r.v.text), r.v?.text || r.e?.message)
  check('grant yes is saved in apps.json', JSON.parse(fs.readFileSync(config.appsFile, 'utf8')).Finder === true)
  const n = app.ops.length
  const s = await settle(hands('see', { label: 'Look closer', screenshot: true }))
  check('see with screenshot: true asks the app for one and returns the image', s.ok && app.ops.slice(n).find(o => o.op === 'see')?.args.screenshot === true && s.v.image?.length > 100 && /Screenshot: 640x400 px/.test(s.v.text), s.v?.text || s.e?.message)
}

{
  // Grant: no.
  const p = settle(hands('see', { label: 'Look at Slack', app: 'Slack' }))
  const card = await until(() => last().cards.find(c => c.title === 'Allow controlling Slack?')) // see is quick: the last snapshot may still show Finder's
  tellOverlay({ type: 'answer', cardId: card?.id, allow: false, via: 'voice' })
  const r = await p
  check('grant no: the step fails with a readable error', !r.ok && /did not allow controlling Slack/.test(r.e.message), r.e?.message)
  check('grant no is saved', JSON.parse(fs.readFileSync(config.appsFile, 'utf8')).Slack === false)
  const n = states.length
  const again = await settle(hands('see', { label: 'Look at Slack', app: 'Slack' }))
  await sleep(50)
  check('a saved no fails at once, without a card', !again.ok && !states.slice(n).some(s => s.cards.length))
}

{
  // Idle: bring the target forward, mark ~350 ms, then act.
  app.setIdle(10)
  await until(() => !last().attention.busy)
  const n = app.ops.length
  const r = await settle(hands('see', { label: 'Look at Notes', app: 'Notes' }))
  const ops = app.ops.slice(n)
  const resolveAt = ops.find(o => o.op === 'resolve')?.at
  const seeAt = ops.find(o => o.op === 'see')?.at
  check('idle: see of a background app brings it forward', r.ok && JSON.stringify(opsSince(n).slice(0, 3)) === '["resolve","front","see"]', opsSince(n).join(','))
  check('idle: see has no mark wait: it only looks', seeAt - resolveAt < 340, `${seeAt - resolveAt} ms`)
  check('idle: focus is done and not background', !!(await until(() => last().focus?.phase === 'done' && last().focus.background === false && last().focus.app === 'Notes')))
  const id = app.elementIds().find(Boolean)
  const m = app.ops.length
  const c = await settle(hands('click', { label: 'Press New Note', element: id }))
  const at = op => app.ops.slice(m).find(o => o.op === op)?.at
  check('click on a pressable element uses AX press, then lists the app', c.ok && JSON.stringify(opsSince(m)) === '["resolve","press","see"]' && /^Clicked e\d+ in Notes\.\nApp: Notes — window "Notes"\. Frontmost: Notes\./.test(c.v.text) && c.v.text.includes(`${id} button "New Note"`), c.v?.text || c.e?.message)
  check('idle: ~350 ms between resolve and an act, and no wait before the list', at('press') - at('resolve') >= 340 && at('see') - at('press') < 100, `${at('press') - at('resolve')} ms, ${at('see') - at('press')} ms`)
}

{
  // Busy: see works in the background; type waits until the user stops.
  app.setIdle(0)
  await until(() => last().attention.busy)
  const n = app.ops.length
  const r = await settle(hands('see', { label: 'Look at Finder', app: 'Finder' }))
  check('busy: see proceeds in the background without front', r.ok && !opsSince(n).includes('front') && !!(await until(() => last().focus.app === 'Finder' && last().focus.background === true)), opsSince(n).join(','))

  const m = app.ops.length
  const p = settle(hands('type', { label: 'Type the title', text: 'hello' }))
  const waiting = await until(() => last().focus?.phase === 'waiting' && last().focus.action === 'type')
  await sleep(300)
  check('busy: type waits with focus.phase waiting', !!waiting && !opsSince(m).includes('type'), opsSince(m).join(','))
  app.setIdle(5)
  const t = await p
  check('busy: type goes ahead once the user is idle', t.ok && opsSince(m).includes('type') && /Typed 5 characters/.test(t.v.text), t.v?.text || t.e?.message)
}

{
  // Waiting plus go ahead.
  app.setIdle(0)
  await until(() => last().attention.busy)
  const m = app.ops.length
  const p = settle(hands('key', { label: 'New tab', combo: 'cmd+t' }))
  await until(() => last().focus?.phase === 'waiting' && last().focus.action === 'key')
  const ack = await request({ type: 'control', action: 'go_ahead' })
  const r = await p
  check('waiting plus go ahead: "go ahead" lets the step act while busy, acked', acked(ack, { ok: true }) && r.ok && opsSince(m).includes('key'), r.v?.text || r.e?.message)
  const late = await request({ type: 'control', action: 'go_ahead' })
  check('go ahead with nothing waiting: acked "not_waiting"', acked(late, { ok: false, error: 'not_waiting' }), JSON.stringify(late))
}

{
  // Ids last while their element is listed; an id of an element no longer listed is stale.
  app.setIdle(10)
  await until(() => !last().attention.busy)
  await hands('see', { label: 'Look', app: 'Finder' })
  const old = app.elementIds()[0]
  const again = await hands('see', { label: 'Look again', app: 'Finder' })
  check('a list of an unchanged window keeps the ids', again.text.includes(`${old} button "Back"`), again.text)
  await hands('see', { label: 'Look at Notes', app: 'Notes' })
  await hands('see', { label: 'Back to Finder', app: 'Finder' })
  const r = await settle(hands('click', { label: 'Press Back', element: old }))
  check('stale element: a readable error that says to call see again', !r.ok && /call see again/.test(r.e.message), r.e?.message)
}

{
  // Observe after an act: two clicks sent from one list both land, each followed by its list.
  await hands('see', { label: 'Look', app: 'Finder' })
  const [back, , row] = app.elementIds() // a button and a row, both pressable
  const n = app.ops.length
  const [a, b] = await Promise.all([settle(hands('click', { label: 'Back', element: back })), settle(hands('click', { label: 'Row', element: row }))])
  const seq = opsSince(n).join(',')
  check('two clicks queued from one list both act, with a list after each', a.ok && b.ok && seq === 'resolve,press,see,resolve,press,see' && b.v.text.startsWith(`Clicked ${row} in Finder.`), seq + (a.e?.message || b.e?.message || ''))

  // screenshot: true on an acting tool reaches the list; without it, the list says the screenshot is older.
  const m = app.ops.length
  const shot = await settle(hands('click', { label: 'Back', element: back, screenshot: true }))
  check('screenshot: true on an action returns the list with the image', shot.ok && app.ops.slice(m).find(o => o.op === 'see')?.args.screenshot === true && shot.v.image?.length > 100 && /Screenshot: 640x400 px/.test(shot.v.text), shot.v?.text || shot.e?.message)
  const plain = await settle(hands('key', { label: 'Escape', combo: 'escape' }))
  check('an action without screenshot: no image, and the old screenshot is called older', plain.ok && !plain.v.image && /^Pressed escape in Finder\.\n/.test(plain.v.text) && /The last screenshot is older than this list/.test(plain.v.text), plain.v?.text || plain.e?.message)

  // A list that fails after a done act: the action is reported done, never as failed.
  app.failSee('Finder has no open window.')
  const done = await settle(hands('click', { label: 'Back', element: back }))
  check('a failed list after an act: the action line plus "Could not list", not an error', done.ok && done.v.text === `Clicked ${back} in Finder.\nCould not list Finder: Finder has no open window.` && !!(await until(() => last().focus?.phase === 'done' && last().focus.label === 'Back')), done.v?.text || done.e?.message)
  const looked = await settle(hands('see', { label: 'Look', app: 'Finder' }))
  check('a failed see is a failed step', !looked.ok && /no open window/.test(looked.e.message), looked.v?.text)
  app.failSee(null)
}

{
  // Right click: always a real click in front, never an AX press; the menu it opened leads the list.
  await hands('see', { label: 'Look', app: 'Finder' })
  const row = app.elementIds()[2] // pressable
  const n = app.ops.length
  const r = await settle(hands('click', { label: 'Menu of the row', element: row, button: 'right' }))
  const click = app.ops.slice(n).find(o => o.op === 'click')
  check('right click on a pressable element: a real right click, never press', r.ok && !opsSince(n).includes('press') && click?.args.button === 'right' && Array.isArray(click.args.point) && opsSince(n).at(-1) === 'see', opsSince(n).join(','))
  check('right click: the menu items are listed first', r.ok && r.v.text.startsWith(`Right-clicked ${row} in Finder.\n`) && /\nMenu open:\ne\d+ menuitem "Open"\ne\d+ menuitem "Get Info"\ne\d+ menuitem "Move to Trash" \(disabled\)\nWindow:\ne\d+ button "Back"/.test(r.v.text), r.v?.text || r.e?.message)
  const esc = await hands('key', { label: 'Close the menu', combo: 'escape' })
  check('a closed menu is no longer listed', !/Menu open|menuitem/.test(esc.text), esc.text)
  await hands('see', { label: 'Look', app: 'Notes' })
  const none = await settle(hands('click', { label: 'Menu', element: app.elementIds()[0], button: 'right' }))
  check('right click where no menu opens: says so', none.ok && /^Right-clicked e\d+ in Notes; no menu opened\.\n/.test(none.v.text), none.v?.text || none.e?.message)
}

{
  // Drag: both ends resolved in one app and both marked before the act; then a drag between their
  // points and the list.
  await hands('see', { label: 'Look', app: 'Finder' })
  const ids = app.elementIds()
  const n = app.ops.length
  const s0 = states.length
  const r = await settle(hands('drag', { label: 'Drag the file', from: { element: ids[2] }, to: { element: ids[0] } }))
  const ops = app.ops.slice(n)
  const drag = ops.find(o => o.op === 'drag')
  const resolved = ops.filter(o => o.op === 'resolve').map(o => o.args.element)
  check('drag: both ends resolved, then one drag between their points, then the list', r.ok && opsSince(n).join() === 'resolve,resolve,drag,see' && JSON.stringify(resolved) === JSON.stringify([ids[2], ids[0]]) && Array.isArray(drag.args.from) && Array.isArray(drag.args.to) && r.v.text.startsWith(`Dragged ${ids[2]} to ${ids[0]} in Finder.\nApp: Finder`), opsSince(n).join() + (r.v?.text || r.e?.message))
  const marked = states.slice(s0).find(st => st.focus?.action === 'drag' && st.focus.phase === 'moving')
  check('drag: the drop end is in focus while the step is still moving, and ~350 ms before the act', JSON.stringify(marked?.focus.to?.point) === JSON.stringify(drag?.args.to) && JSON.stringify(marked.focus.point) === JSON.stringify(drag.args.from) && drag.at - ops.findLast(o => o.op === 'resolve').at >= 340, JSON.stringify(marked?.focus))

  // The two ends in two apps: refused before anything is marked or done.
  await hands('see', { label: 'Look', app: 'Finder', screenshot: true })
  await hands('see', { label: 'Look at Notes', app: 'Notes' })
  const m = app.ops.length
  const two = await settle(hands('drag', { label: 'Drag', from: { element: app.elementIds()[0] }, to: { point: [100, 50] } }))
  check('drag across two apps: refused, nothing acted', !two.ok && /A drag stays inside one app: it starts in Notes but ends in Finder/.test(two.e.message) && opsSince(m).join() === 'resolve,resolve', two.e?.message || opsSince(m).join())
}

{
  // One step at a time.
  const n = app.ops.length
  await Promise.all([hands('see', { label: 'A', app: 'Finder' }), hands('see', { label: 'B', app: 'Notes' })])
  const seq = opsSince(n).filter(op => op === 'resolve' || op === 'see').join(',')
  check('two calls run one after the other, not interleaved', seq === 'resolve,see,resolve,see', seq)
}

{
  // Open an app from the Dock.
  fs.writeFileSync(config.appsFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(config.appsFile, 'utf8')), 'Google Chrome': true }))
  const n = app.ops.length
  const r = await settle(hands('open', { label: 'Open Chrome', app: 'Google Chrome' }))
  check('open app: resolve the Dock item, then click it', r.ok && JSON.stringify(app.ops.slice(n, n + 2).map(o => [o.op, Object.keys(o.args)[0]])) === '[["resolve","dock"],["click","point"]]' && /Frontmost: Google Chrome/.test(r.v.text), r.v?.text || r.e?.message)
}

{
  // Bad args fail with a readable error before anything reaches the app.
  const n = app.ops.length
  const bad = [
    ['click', {}, /click needs an element id or a point/],
    ['click', { element: 'e1', button: 'middle' }, /click button must be "left" or "right"/],
    ['scroll', { direction: 'sideways' }, /scroll needs a direction/],
    ['scroll', { direction: 'down', pages: 0 }, /scroll pages must be a number above 0 and at most 10/],
    ['scroll', { direction: 'down', pages: 11 }, /scroll pages must be/],
    ['scroll', { direction: 'down', pages: '2' }, /scroll pages must be/],
    ['see', { screenshot: 'yes' }, /screenshot must be true or false/],
    ['click', { element: 'e1', screenshot: 1 }, /screenshot must be true or false/],
    ['type', {}, /type needs text/],
    ['key', {}, /key needs a combo/],
    ['open', {}, /open needs an app, a url or a path/],
    ['drag', {}, /drag needs from and to, each \{ element \} or \{ point \}/],
    ['drag', { from: { element: 'e1' } }, /drag needs from and to/],
    ['drag', { from: 'e1', to: { point: [1, 2] } }, /drag needs from and to/],
    ['drag', { from: { element: 'e1' }, to: {} }, /drag needs from and to/],
  ]
  const wrong = []
  for (const [tool, args, msg] of bad) {
    const r = await settle(hands(tool, { label: 'x', ...args }))
    if (r.ok || !msg.test(r.e.message)) wrong.push(`${tool}: ${r.ok ? 'ok' : r.e.message}`)
  }
  check('bad args: a readable error per tool, and nothing sent to the app', wrong.length === 0 && app.ops.length === n, wrong.join('; ') || opsSince(n).join(','))
}

{
  // Scroll: at an element, at a point, or in the app of the last step.
  await hands('see', { label: 'Look', app: 'Finder', screenshot: true })
  const scrolled = async args => {
    const n = app.ops.length
    const r = await settle(hands('scroll', { label: 'Scroll', ...args }))
    return { r, resolve: app.ops.slice(n).find(o => o.op === 'resolve')?.args, scroll: app.ops.slice(n).find(o => o.op === 'scroll')?.args }
  }
  const el = await scrolled({ element: app.elementIds()[0], direction: 'down' })
  check('scroll at an element: at its point, 1 page by default, where it is now', el.r.ok && el.resolve?.element === app.elementIds()[0] && el.scroll?.pages === 1 && el.scroll.direction === 'down' && Array.isArray(el.scroll.point) && /Scrolled down 1 page \(504 px\) in Finder, now at 25%/.test(el.r.v.text), el.r.v?.text || el.r.e?.message)
  const pt = await scrolled({ point: [100, 50], direction: 'up', pages: 0.25 })
  check('scroll at a point of the screenshot, a fraction of a page', pt.r.ok && JSON.stringify(pt.resolve?.point) === '[100,50]' && pt.scroll?.pages === 0.25 && /Scrolled up 0.25 pages \(126 px\) in Finder, now at 19%/.test(pt.r.v.text), pt.r.v?.text || pt.r.e?.message)
  await scrolled({ direction: 'up', pages: 10 })
  const top = await scrolled({ direction: 'up' })
  check('scroll that cannot move: says so', top.r.ok && /Did not move: already at the top in Finder/.test(top.r.v.text), top.r.v?.text || top.r.e?.message)
  const cur = await scrolled({ direction: 'left' })
  check('scroll with no target: in the app of the last step; no scroll bar, just the pixels', cur.r.ok && cur.resolve?.app === 'Finder' && cur.scroll?.direction === 'left' && /^Scrolled left 1 page \(810 px\) in Finder\.\nApp: Finder/.test(cur.r.v.text), cur.r.v?.text || JSON.stringify(cur.resolve))
}

{
  // Open a url or a path: nothing to resolve; the system opens it in its app, which is not listed
  // (nor granted) by this step.
  fs.writeFileSync(config.appsFile, JSON.stringify({ Finder: true, Notes: true }))
  const n = app.ops.length
  const cards = states.length
  const u = await settle(hands('open', { label: 'Open the site', url: 'https://example.com' }))
  check('open url: no resolve, the system opens it', u.ok && app.ops[n]?.op === 'open' && app.ops[n].args.url === 'https://example.com' && u.v.text === 'Opened https://example.com in Google Chrome. Call see to list it.', u.v?.text || u.e?.message)
  check('open url: no list and no grant card for the app it opened in', !opsSince(n).includes('see') && !states.slice(cards).some(st => st.cards.length), opsSince(n).join(','))
  const m = app.ops.length
  const p = await settle(hands('open', { label: 'Open the folder', path: '/tmp' }))
  check('open path: the system opens it', p.ok && app.ops[m]?.op === 'open' && app.ops[m].args.path === '/tmp' && /Opened \/tmp in Finder/.test(p.v.text), p.v?.text || p.e?.message)
}

{
  // Stop while waiting, and while a grant card is up.
  const started = await request({ type: 'tell', text: 'type something', source: 'voice' })
  check('tell with no turn working starts one, acked "started"', acked(started, { ok: true, state: 'started' }) && !!(await until(() => last().turn?.phase === 'working')), JSON.stringify(started))
  app.setIdle(0)
  await until(() => last().attention.busy)
  const p = settle(hands('type', { label: 'Type', text: 'x' }))
  const q = settle(hands('see', { label: 'queued', app: 'Finder' }))
  await until(() => last().focus?.phase === 'waiting')
  const stopped = await request({ type: 'control', action: 'stop' })
  const [r, r2] = await Promise.all([p, q])
  check('stop: acked', acked(stopped, { ok: true }), JSON.stringify(stopped))
  check('stop: the waiting step fails with "Cancelled"', !r.ok && /Cancelled/.test(r.e.message), r.e?.message)
  check('stop: queued steps are dropped too', !r2.ok && /Cancelled/.test(r2.e.message))
  check('stop: executor interrupted and turn cancelled', calls.some(c => c.name === 'interrupt') && !!(await until(() => last().turn.phase === 'cancelled')))
  const idle = await request({ type: 'control', action: 'stop' })
  const odd = await request({ type: 'control', action: 'resume' })
  check('stop with nothing running, and an unknown action: acked as errors', acked(idle, { ok: false, error: 'nothing_running' }) && acked(odd, { ok: false, error: 'unknown_action' }), `${JSON.stringify(idle)} ${JSON.stringify(odd)}`)

  await request({ type: 'tell', text: 'look at notes', source: 'voice' })

  app.setIdle(10)
  fs.writeFileSync(config.appsFile, JSON.stringify({ Finder: true }))
  const g = settle(hands('see', { label: 'Look at Notes', app: 'Notes' }))
  await until(() => last().cards.some(c => c.source === 'core'))
  await request({ type: 'control', action: 'stop' })
  const b = await g
  check('stop: a pending grant card is withdrawn', !b.ok && /Cancelled/.test(b.e.message) && !!(await until(() => !last().cards.some(c => c.source === 'core'))), b.e?.message)
  check('stop: a cancelled grant is not saved', !('Notes' in JSON.parse(fs.readFileSync(config.appsFile, 'utf8'))))
}

// ---------------------------------------------------------------- pause, resume

let app2
{
  check('on connect the app is told whether the core is paused', JSON.stringify(app.notices[0]) === '{"type":"paused","paused":false}', JSON.stringify(app.notices[0]))

  // Pause while a step waits for the front and another is queued: the turn stops as with "stop".
  app.setIdle(0)
  await until(() => last().attention.busy)
  await request({ type: 'tell', text: 'write the summary', source: 'voice' })
  await until(() => last().turn?.phase === 'working' && last().turn.sent === 'write the summary')
  const count = name => calls.filter(c => c.name === name).length
  const cancels = count('interrupt')
  const p = settle(hands('type', { label: 'Type', text: 'x' }))
  const q = settle(hands('see', { label: 'queued', app: 'Finder' }))
  await until(() => last().focus?.phase === 'waiting')
  const paused = await request({ type: 'control', action: 'pause' })
  const [r, r2] = await Promise.all([p, q])
  check('pause: acked', acked(paused, { ok: true }), JSON.stringify(paused))
  check('pause: the waiting step fails and the queued one is dropped', !r.ok && /Cancelled/.test(r.e.message) && !r2.ok && /Cancelled/.test(r2.e.message), r.e?.message)
  check('pause: the executor is interrupted and the turn cancelled', count('interrupt') === cancels + 1 && !!(await until(() => last().turn.phase === 'cancelled')))
  check('pause: paused is in the snapshot', !!(await until(() => last().paused === true)))
  check('pause: the app is told', !!(await until(() => JSON.stringify(app.notices.at(-1)) === '{"type":"paused","paused":true}')))

  // While paused: no hands, no new work.
  app.setIdle(10)
  const n = app.ops.length
  const h = await settle(hands('see', { label: 'Look', app: 'Finder' }))
  check('paused: the hands refuse a step without touching the app', !h.ok && /paused/.test(h.e.message) && app.ops.length === n, h.e?.message)
  const t = await post('/api/tell', JSON.stringify({ text: 'open notes' }))
  check('paused: a tell is refused, saying how to resume', t.status === 409 && /Resume from the menu bar/.test((await t.json()).error), `status ${t.status}`)
  const told = await request({ type: 'tell', text: 'open notes', source: 'typed' })
  check('paused: an overlay tell is acked with the same error', told?.ok === false && /Resume from the menu bar/.test(told.error), JSON.stringify(told))

  // An app that connects while paused learns it at once.
  app.close()
  app2 = startFakeApp({ port: PORT, idle: 10 })
  await app2.ready
  check('an app connecting while paused is told so', !!(await until(() => JSON.stringify(app2.notices[0]) === '{"type":"paused","paused":true}')), JSON.stringify(app2.notices[0]))

  // Resume from the app (the menu bar or ⌃⌥P): voice and hands come back; the stopped turn stays stopped.
  const prompts = count('prompt')
  app2.send({ type: 'resume' })
  check('resume: paused clears and the app is told', !!(await until(() => last().paused === false)) && !!(await until(() => JSON.stringify(app2.notices.at(-1)) === '{"type":"paused","paused":false}')))
  await sleep(50)
  check('resume: the turn pause stopped is not started again', count('prompt') === prompts && last().turn.phase === 'cancelled', `${count('prompt') - prompts} prompts; turn ${last().turn.phase}`)

  // Pause with no turn working, then resume: nothing is cancelled or told.
  const before = calls.length
  await request({ type: 'control', action: 'pause' })
  await until(() => last().paused === true)
  const twice = await request({ type: 'control', action: 'pause' }) // already paused: nothing changes
  check('pause while paused: acked, nothing changes', acked(twice, { ok: true }), JSON.stringify(twice))
  app2.send({ type: 'resume' })
  await until(() => last().paused === false)
  await sleep(50)
  check('pause and resume with no turn working: nothing is cancelled or told', calls.length === before, calls.slice(before).map(c => c.name).join(','))

  // The talk mode: the app's menu sets it for this run; a mode the core does not know is ignored.
  check('on connect the app is told the talk mode, key by default', JSON.stringify(app2.notices[1]) === '{"type":"talk","mode":"key"}', JSON.stringify(app2.notices[1]))
  app2.send({ type: 'talk', mode: 'always' })
  check('talk: the snapshot carries it and the app is told', !!(await until(() => last().talk === 'always')) && !!(await until(() => JSON.stringify(app2.notices.at(-1)) === '{"type":"talk","mode":"always"}')))
  app2.send({ type: 'talk', mode: 'loud' })
  await sleep(50)
  check('talk: an unknown mode is ignored', last().talk === 'always' && !app2.notices.some(n => n.mode === 'loud'))
  app2.send({ type: 'talk', mode: 'key' })
  await until(() => last().talk === 'key')
}

// Voice grant: without a voice, a clear error with its HTTP status and no network call.
{
  const off = await settle(createVoiceHost({ ...config, voice: { ...config.voice, off: 'voice is off (LOOKMA_VOICE=off)' } }, { log: quiet }).grant())
  check('voice grant: no voice is a 503 with the reason', off.e?.status === 503 && off.e.message === 'voice is off (LOOKMA_VOICE=off)', off.e?.message)
}

// Minting one calls the voice provider's account (OpenAI's), so only with LOOKMA_LIVE_TESTS=1. Never printed.
if (process.env.LOOKMA_LIVE_TESTS === '1') {
  const r = await post('/api/voice/grant', '{}')
  const body = await r.json()
  const exists = f => fs.existsSync(path.join(config.root, 'prompts', f))
  if (exists('butler.md') && exists('butler-tools.json')) {
    check('voice grant minted', r.status === 200 && body.provider === config.voice.provider.name && typeof body.credential === 'string' && body.credential.length > 10 && !!body.startBy, `status ${r.status} ${body.error || ''}`)
  } else {
    check('voice grant fails clearly while prompts are missing', r.status >= 400 && /prompts\/butler/.test(body.error || ''), `status ${r.status}: ${body.error}`)
  }
}

// ---------------------------------------------------------------- quit

{
  app2.send({ type: 'quit' })
  await until(() => quitDone)
  const listening = await fetch(`http://127.0.0.1:${PORT}/api/state`).then(() => true, () => false)
  check('quit from the app: the core runs its shutdown', quitDone)
  check('quit: the app is told to quit and the executor closes', app2.notices.at(-1)?.type === 'quit' && calls.at(-1)?.name === 'close', `${JSON.stringify(app2.notices.at(-1))} ${calls.at(-1)?.name}`)
  check('quit: the server stops listening', !listening)
}

// ---------------------------------------------------------------- done

overlay.close()
bridge.close()
app2.close()
fs.rmSync(DATA, { recursive: true, force: true })
console.log(failures ? `${failures} FAILED` : 'all passed')
process.exit(failures ? 1 : 0)
