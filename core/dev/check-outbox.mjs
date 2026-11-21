#!/usr/bin/env node
// Checks the outbox (core/outbox.mjs) on its own with an injected clock, then the core's use of
// it with a stub executor and a fake overlay socket (no ports, no app): receipts, pruning by age
// and cap (a held entry stays), a stopped turn's entries and cards, the line a turn ends with,
// card announcements, and the control acks.
//   node core/dev/check-outbox.mjs      (a scratch data dir is used)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../config.mjs'
import { createCore } from '../core.mjs'
import { createOutbox, KEEP_MS, MAX } from '../outbox.mjs'

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lookma-outbox-'))
process.env.LOOKMA_DATA = DATA

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const show = v => JSON.stringify(v)

// ---------------------------------------------------------------- the outbox alone

{
  let clock = 1000
  const store = { data: { outbox: [] }, update: fn => fn(store.data) }
  let n = 0
  const outbox = createOutbox({ store, nextId: p => `${p}${++n}`, now: () => clock })
  const list = () => store.data.outbox

  const a = outbox.post({ kind: 'info', speech: 'Opening Maps.' })
  const b = outbox.post({ kind: 'report', speech: 'Twelve thousand yen.', display: '12,000 yen', taskId: 't1', title: 'Sum receipts', turnId: 'turn1' })
  check('post: an entry with display from speech, no receipt, turnId null by default', show(a) === show({ id: 'm1', kind: 'info', speech: 'Opening Maps.', display: 'Opening Maps.', turnId: null, held: false, at: 1000, delivered: null }), show(a))
  check('post: optional fields are kept', b.taskId === 't1' && b.title === 'Sum receipts' && b.turnId === 'turn1' && b.display === '12,000 yen', show(b))

  outbox.deliver([a.id], 'spoken')
  outbox.deliver([a.id], 'cut')
  outbox.deliver(['m99'], 'shown')
  check('deliver: the first receipt wins, unknown ids are ignored', a.delivered === 'spoken' && b.delivered === null && list().length === 2, show(list()))

  const held = outbox.post({ kind: 'card', speech: 'Allow Bash?', held: true })
  outbox.deliver([held.id], 'spoken')
  clock += KEEP_MS
  outbox.prune()
  check('prune by age: a delivered entry older than KEEP_MS goes, an undelivered or held one stays', show(list().map(e => e.id)) === '["m2","m3"]', show(list().map(e => e.id)))

  for (let i = 0; i < MAX; i++) outbox.post({ kind: 'info', speech: `line ${i}` })
  check('prune by cap: beyond MAX the oldest go, a held one stays', list().length === MAX && list()[0] === held && list()[1].speech === 'line 1' && list().at(-1).speech === `line ${MAX - 1}`, `${list().length} entries, then ${list()[1].speech}`)

  outbox.drop(e => e === held)
  check('drop removes what matches, held or not', list().length === MAX - 1 && !list().includes(held))
}

// ---------------------------------------------------------------- the core

// The core's clock, moved forward by `skew` to cross KEEP_MS without waiting.
let skew = 0
const realNow = Date.now
Date.now = () => realNow() + skew

let emit
function stubExecutor(ctx) {
  emit = ctx.emit
  return {
    start: async () => (ctx.emit({ type: 'status', status: 'ready' }), { name: 'stub' }),
    prompt() {},
    cancel() {},
    answer() {},
    stop: async () => {},
  }
}

const logs = []
const core = await createCore(await loadConfig(), { log: (...a) => logs.push(a.join(' ')), createExecutor: stubExecutor })
await core.startExecutor([])

// A fake overlay socket: requests are handled at once, so each ack is there when send returns.
const received = []
let onMessage
core.connectOverlay({ readyState: 1, send: t => received.push(JSON.parse(t)), on: (ev, fn) => ev === 'message' && (onMessage = fn) })
const overlay = msg => onMessage(JSON.stringify(msg))
let requests = 0
function request(msg) {
  const id = `t${++requests}`
  overlay({ ...msg, id })
  const { type, id: _, ...ack } = received.findLast(m => m.type === 'ack' && m.id === id)
  return ack
}

const data = core.store.data
const entriesOf = turnId => data.outbox.filter(e => e.turnId === turnId)
const startTurn = text => (request({ type: 'tell', text, source: 'typed' }), data.turn)

{
  const turn = startTurn('open maps')
  emit({ type: 'turnEnd', ok: true })
  const done = entriesOf(turn.id)
  check('a turn that ends with no say gets exactly one entry: "Done."', done.length === 1 && done[0].speech === 'Done.' && done[0].kind === 'info' && turn.said === 1, show(done))

  const failed = startTurn('open notes')
  emit({ type: 'turnEnd', ok: false })
  check('a failed turn with no say gets "That did not work."', show(entriesOf(failed.id).map(e => e.speech)) === '["That did not work."]', show(entriesOf(failed.id)))

  const long = startTurn('sort the photos')
  skew += KEEP_MS + 1000
  emit({ type: 'turnEnd', ok: true })
  check('also when the turn ran longer than KEEP_MS', show(entriesOf(long.id).map(e => e.speech)) === '["Done."]', show(entriesOf(long.id)))
}

{
  const turn = startTurn('find the receipts')
  emit({ type: 'say', speech: 'Looking in Downloads.' })
  const said = data.outbox.at(-1)
  check('say: an entry of the working turn, counted on it', said.speech === 'Looking in Downloads.' && said.turnId === turn.id && turn.said === 1, show(said))
  overlay({ type: 'delivered', ids: [said.id], how: 'spoken' })
  skew += KEEP_MS + 1000
  emit({ type: 'task', id: 'a1', title: 'Sum receipts', status: 'running' })
  emit({ type: 'task', id: 'a1', status: 'done', result: { speech: 'Twelve thousand yen.' } })
  const report = data.outbox.at(-1)
  check('a finished task posts a report with taskId and title, outside the turn', report.kind === 'report' && report.taskId === 'a1' && report.title === 'Sum receipts' && report.turnId === null, show(report))
  check('the delivered say was pruned after KEEP_MS', !data.outbox.some(e => e.id === said.id))
  emit({ type: 'turnEnd', ok: true })
  check('a turn that did say gets no entry at the end, even once its say is pruned', entriesOf(turn.id).length === 0, show(entriesOf(turn.id)))
}

{
  // Cards: only the head card is announced, and its entry goes with it.
  emit({ type: 'approval', id: 'c1', title: 'Allow Bash?', detail: 'ls' })
  emit({ type: 'approval', id: 'c2', title: 'Change these files?' })
  const cardEntries = () => data.outbox.filter(e => e.kind === 'card')
  check('a card entry exists only for the head card', show(cardEntries().map(e => [e.cardId, e.speech, e.turnId])) === '[["c1","Allow Bash?\\nls",null]]', show(cardEntries()))
  check('answering the head card: acked, its entry goes, the next card is announced', show(request({ type: 'answer', cardId: 'c1', allow: true, via: 'click' })) === '{"ok":true}' && show(cardEntries().map(e => e.cardId)) === '["c2"]', show(cardEntries()))
  overlay({ type: 'delivered', ids: [cardEntries()[0].id], how: 'spoken' })
  skew += KEEP_MS + 1000
  emit({ type: 'say', speech: 'Meanwhile.' }) // a post trims the outbox
  check('a delivered card entry stays past KEEP_MS while its card is up', show(cardEntries().map(e => e.cardId)) === '["c2"]', show(cardEntries()))
  emit({ type: 'approvalGone', id: 'c2' })
  check('a delivered card entry goes with its card too', cardEntries().length === 0, show(cardEntries()))
}

{
  // A stopped turn drops its untold entries and its cards; a card from outside a turn stays.
  emit({ type: 'approval', id: 'boot', title: 'Trust this folder?' })
  const turn = startTurn('clean the desktop')
  emit({ type: 'say', speech: 'Moving the screenshots.' })
  const told = data.outbox.at(-1)
  emit({ type: 'say', speech: 'Now the PDFs.' })
  overlay({ type: 'delivered', ids: [told.id], how: 'spoken' })
  emit({ type: 'approval', id: 'c3', title: 'Delete 4 files?' })
  check('a card raised in a turn is that turn\'s', data.cards.find(c => c.id === 'c3')?.turnId === turn.id)
  const stopped = request({ type: 'control', action: 'stop' })
  check('stop: acked', show(stopped) === '{"ok":true}', show(stopped))
  check('stop: the turn\'s undelivered entries go, the delivered one stays, and no "Done."', show(entriesOf(turn.id).map(e => e.speech)) === '["Moving the screenshots."]', show(entriesOf(turn.id)))
  check('stop: the turn\'s cards go, a card from outside the turn stays and is still announced', show(data.cards.map(c => c.id)) === '["boot"]' && show(data.outbox.filter(e => e.kind === 'card').map(e => e.cardId)) === '["boot"]', show(data.cards))
  request({ type: 'answer', cardId: 'boot', allow: true, via: 'click' })
}

{
  // Receipts from the overlay: idempotent, and a malformed one changes nothing.
  emit({ type: 'say', speech: 'Unrelated news.' })
  const e = data.outbox.at(-1)
  overlay({ type: 'delivered', ids: [e.id], how: 'louder' })
  check('a receipt with an unknown how is refused and logged', e.delivered === null && logs.some(l => /bad overlay message/.test(l)), logs.at(-1))
  overlay({ type: 'delivered', ids: [e.id], how: 'shown' })
  overlay({ type: 'delivered', ids: [e.id], how: 'spoken' })
  check('a receipt from the overlay: the first wins', e.delivered === 'shown')
  check('the snapshot carries the outbox and turn.said', show(core.store.snapshot().outbox) === show(data.outbox) && typeof core.store.snapshot().turn.said === 'number')
}

{
  const idle = request({ type: 'control', action: 'stop' })
  const notWaiting = request({ type: 'control', action: 'go_ahead' })
  const paused = request({ type: 'control', action: 'pause' })
  const again = request({ type: 'control', action: 'pause' })
  check('control acks: nothing_running, not_waiting', show(idle) === '{"ok":false,"error":"nothing_running"}' && show(notWaiting) === '{"ok":false,"error":"not_waiting"}', `${show(idle)} ${show(notWaiting)}`)
  check('control: pause is idempotent', show(paused) === '{"ok":true}' && show(again) === '{"ok":true}' && data.paused === true, `${show(paused)} ${show(again)}`)
}

Date.now = realNow
fs.rmSync(DATA, { recursive: true, force: true })
console.log(failures ? `${failures} FAILED` : 'all passed')
process.exit(failures ? 1 : 0)
