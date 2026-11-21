#!/usr/bin/env node
// overlay/voice/floor.js on its own, in Node: sequences of voice events in, effects out, on a fake
// clock. The state handed to step is deep-frozen, so a reducer that mutates its input throws.
// The cases follow the design's sequences: a normal task, silent and failing tool calls,
// declines, room and headset interruptions, a dropped session, tools in flight, a rejected create,
// quiet, receipts, the view, budgets, stacked declines, the token limit, barge-in twice, and
// deadlines.
//
//   node overlay/dev/floor-check.mjs

import { initial, step, view, isIdle, wakeAt, QUIET_MS, MAX_FAILURES, IDLE_MS, SLOT_MS } from '../voice/floor.js'

let failed = 0
function check(ok, what, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${ok || detail === undefined ? '' : `\n  ${JSON.stringify(detail)}`}`)
  if (!ok) failed++
}

function freeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) freeze(v)
  }
  return o
}

/** A floor on a fake clock: f(type, props) feeds one event and returns its effects. */
function floor() {
  let state = initial()
  let at = 1000
  const f = (type, props = {}) => {
    const r = step(freeze(state), { type, at, ...props })
    state = r.state
    return r.effects
  }
  f.wait = ms => { at += ms }
  f.state = () => state
  f.at = () => at
  return f
}

// Effects
const types = fx => fx.map(e => e.type)
const only = (fx, type) => fx.filter(e => e.type === type)
const creates = fx => only(fx, 'create')
const lines = fx => only(fx, 'line')
const receipts = fx => only(fx, 'delivered').map(e => `${e.how}:${e.ids.join(',')}`)
const drops = fx => only(fx, 'drop').flatMap(e => e.items)
const owedTurns = f => f.state().turns.map(t => t.id)

// Response items, as a provider's page.js gives them (voice/contract.js item())
const MSG = { kind: 'message' }
const PASS = id => ({ kind: 'pass', id })
const CALL = (id, name = 'do', complete = true) => ({ kind: 'call', id, callId: `c_${id}`, name, args: {}, complete })
const entry = (id, extra = {}) => ({ id, kind: 'info', speech: id, display: id, turnId: null, at: 0, delivered: null, ...extra })
const result = (id, output) => ({ callId: `c_${id}`, output, news: output.ok !== true })

/** A user turn: speech starts, stops, the buffer is committed. Returns the commit's effects. */
function turn(f, id) {
  f('turn.started', { id })
  f('turn.stopped', { id })
  return f('turn.committed', { id })
}

/** A reply to the slot's create, as response events: started, its items, done. audio: started before done. */
function reply(f, response, items, { status = 'completed', audio = items.some(i => i.kind === 'message') } = {}) {
  const fx = [...f('response.started', { response })]
  for (const i of items) fx.push(...f('response.item', { response, kind: i.kind }))
  if (audio) fx.push(...f('audio.started', { response }))
  fx.push(...f('response.done', { response, status, items }))
  return fx
}

/** Announces whatever is owed after the quiet; returns the tick's effects. */
function announce(f) {
  f.wait(QUIET_MS)
  return f('tick')
}

// 1. Normal task
{
  const f = floor()
  f('session.up')
  let fx = turn(f, 'T1')
  check(creates(fx).length === 1 && creates(fx)[0].kind === 'turn', '1. commit -> create(turn)', fx)
  const { eventId } = creates(fx)[0]
  f('response.started', { response: 'R1' })
  fx = f('response.item', { response: 'R1', kind: 'message' })
  check(JSON.stringify(lines(fx)) === '[{"type":"line","kind":"user","turn":"T1"}]', '1. first message item -> line user', fx)
  f('audio.started', { response: 'R1' })
  fx = f('response.done', { response: 'R1', status: 'completed', items: [MSG, CALL('i1')] })
  const run = only(fx, 'run')[0]
  check(run?.eventId === eventId && run.turn === 'T1' && run.calls.length === 1 && run.calls[0].name === 'do', '1. done {message, do} -> run for T1', fx)
  fx = f('tools.done', { eventId, results: [result('i1', { ok: true, state: 'started' })] })
  check(types(fx).join() === 'output' && owedTurns(f).join() === 'T1', '1. ok result -> output, no second create, still owed while audio plays', fx)
  fx = f('audio.stopped', { response: 'R1' })
  check(!creates(fx).length && owedTurns(f).length === 0 && !f.state().slot, '1. audio.stopped -> T1 settled', f.state())
  f('outbox', { entries: [entry('m7')] })
  fx = announce(f)
  check(types(fx).join() === 'tell,create' && fx[0].entries[0].id === 'm7' && !fx[0].earlier && fx[1].kind === 'speak', '1. later m7 -> after quiet: tell + create(speak)', fx)
  fx = [...reply(f, 'R2', [MSG]), ...f('audio.stopped', { response: 'R2' })]
  check(receipts(fx).join() === 'spoken:m7', '1. announcement heard -> delivered m7 spoken', fx)
}

// 2. Silent tool call
{
  const f = floor()
  f('session.up')
  const { eventId } = creates(turn(f, 'T1'))[0]
  let fx = reply(f, 'R1', [CALL('i1')])
  check(only(fx, 'run').length === 1, '2. done {do} without speech -> run', fx)
  fx = f('tools.done', { eventId, results: [result('i1', { ok: true, state: 'started' })] })
  check(creates(fx).length === 1 && creates(fx)[0].kind === 'speak' && f.state().slot.turns.join() === 'T1', '2. after tools.done -> create(speak) for the same turn', fx)
  fx = reply(f, 'R2', [MSG])
  check(owedTurns(f).join() === 'T1' && !lines(fx).length, '2. still owed while the result plays', f.state())
  f('audio.stopped', { response: 'R2' })
  check(owedTurns(f).length === 0, '2. settled once heard', f.state())
}

// 3. Tool error after speech
{
  const f = floor()
  f('session.up')
  const { eventId } = creates(turn(f, 'T1'))[0]
  reply(f, 'R1', [MSG, CALL('i1')])
  let fx = f('tools.done', { eventId, results: [result('i1', { ok: false, error: 'The executor is not running.' })] })
  check(!creates(fx).length && f.state().slot?.phase === 'draining', '3. error result while the first audio plays -> no create yet', fx)
  fx = f('audio.stopped', { response: 'R1' })
  check(creates(fx).length === 1 && creates(fx)[0].kind === 'speak', '3. first audio stopped -> create(speak)', fx)
}

// 4. Decline
{
  const f = floor()
  f('session.up')
  turn(f, 'T1')
  let fx = reply(f, 'R1', [PASS('p1')])
  check(drops(fx).join() === 'T1,p1' && !lines(fx).length && !creates(fx).length && owedTurns(f).length === 0, '4. completed {pass} -> drop [turn, call], no line, no create', fx)
  turn(f, 'T2')
  fx = reply(f, 'R2', [])
  check(drops(fx).join() === 'T2' && !lines(fx).length && !creates(fx).length, '4. an empty completed turn reply does the same', fx)
}

// 5. Room: a turn commits during an announcement
{
  const f = floor()
  f('session.up')
  f('outbox', { entries: [entry('m7')] })
  announce(f)
  reply(f, 'R1', [MSG])
  const during = turn(f, 'T2')
  const fx = f('audio.stopped', { response: 'R1' })
  check(!creates(during).length && types(fx).join() === 'delivered,create' && receipts(fx).join() === 'spoken:m7' && creates(fx)[0].kind === 'turn',
    '5. room: delivered spoken first, then create(turn)', { during, fx })
}

// 6. Headset noise
{
  const f = floor()
  f('session.up')
  f('outbox', { entries: [entry('m7')] })
  announce(f)
  f('response.started', { response: 'R1' })
  f('audio.started', { response: 'R1' })
  f('turn.started', { id: 'T2' })
  f('audio.cleared', { response: 'R1' })
  f('response.done', { response: 'R1', status: 'cancelled', items: [] })
  f('turn.stopped', { id: 'T2' })
  let fx = f('turn.committed', { id: 'T2' })
  check(creates(fx)[0]?.kind === 'turn' && f.state().slot.cut.entries.join() === 'm7', '6. the cut announcement goes to the interrupter as cut', f.state().slot)
  fx = reply(f, 'R2', [PASS('p2')])
  check(drops(fx).join() === 'T2,p2' && !receipts(fx).length, '6. interrupter declined -> m7 still owed', fx)
  fx = announce(f)
  check(types(fx).join() === 'tell,create' && fx[0].entries[0].id === 'm7', '6. -> tell + create(speak) again', fx)
  f('response.started', { response: 'R3' })
  f('audio.started', { response: 'R3' })
  f('turn.started', { id: 'T3' })
  fx = f('response.done', { response: 'R3', status: 'cancelled', items: [] })
  check(!receipts(fx).length && f.state().failures.m7 === 1, '6. cut again -> not charged yet, the interrupter judges it', fx)
  f('turn.stopped', { id: 'T3' })
  f('turn.committed', { id: 'T3' })
  fx = [...reply(f, 'R4', [PASS('p3')]), ...announce(f), ...announce(f)]
  check(receipts(fx).join() === 'shown:m7' && !creates(fx).length && !only(fx, 'tell').length,
    `6. declined again -> delivered shown after ${MAX_FAILURES} failures, no third announcement`, fx)
}

// 7. Headset barge-in on an announcement
{
  const f = floor()
  f('session.up')
  f('outbox', { entries: [entry('m7')] })
  announce(f)
  f('response.started', { response: 'R1' })
  f('audio.started', { response: 'R1' })
  f('turn.started', { id: 'T3' })
  f('response.done', { response: 'R1', status: 'cancelled', items: [] })
  f('turn.stopped', { id: 'T3' })
  const { eventId } = creates(f('turn.committed', { id: 'T3' }))[0]
  f('response.started', { response: 'R2' })
  let fx = f('response.item', { response: 'R2', kind: 'message' })
  check(receipts(fx).join() === 'cut:m7' && lines(fx)[0]?.turn === 'T3', '7. interrupter addressed -> line user and delivered cut', fx)
  f('audio.started', { response: 'R2' })
  f('response.done', { response: 'R2', status: 'completed', items: [MSG, CALL('i1')] })
  f('tools.done', { eventId, results: [result('i1', { ok: true, state: 'added' })] })
  f('audio.stopped', { response: 'R2' })
  f.wait(IDLE_MS)
  fx = f('tick')
  check(owedTurns(f).length === 0 && !only(fx, 'tell').length && !creates(fx).length, '7. never re-announced', { fx, state: f.state() })
}

// 8. Cancelled tool call
{
  const f = floor()
  f('session.up')
  turn(f, 'T1')
  f('turn.started', { id: 'T2' }) // headset: the user's voice cancels the reply
  let fx = reply(f, 'R1', [CALL('i1', 'do', false)], { status: 'cancelled' })
  check(!only(fx, 'run').length && !creates(fx).length, '8. done cancelled with an incomplete call -> no run', fx)
  f('turn.stopped', { id: 'T2' })
  fx = f('turn.committed', { id: 'T2' })
  check(creates(fx).length === 1 && creates(fx)[0].kind === 'turn' && f.state().slot.turns.join() === 'T1,T2', '8. next commit -> one create(turn) for both', fx)
  fx = reply(f, 'R2', [PASS('p2')])
  check(drops(fx).join() === 'T2,p2' && creates(fx).length === 1 && f.state().slot.turns.join() === 'T1', '8. a pass drops only the newest, and a new create(turn) follows', fx)
}

// 9. Session dies mid-announcement
{
  const f = floor()
  f('outbox', { entries: [entry('m8', { delivered: 'spoken' }), entry('m9')] })
  f('session.up')
  announce(f)
  f('response.started', { response: 'R1' })
  f('audio.started', { response: 'R1' })
  let fx = f('session.down', { lost: true })
  check(!receipts(fx).length && !creates(fx).length && f.state().failures.m9 === 1, '9. lost mid-announcement -> no receipt, one failure', fx)
  fx = f('session.up')
  check(types(fx).join() === 'tell' && fx[0].earlier && fx[0].entries.map(e => e.id).join() === 'm8', '9. session.up -> seed tell (earlier) without create', fx)
  fx = announce(f)
  check(types(fx).join() === 'tell,create' && !fx[0].earlier && fx[0].entries[0].id === 'm9', '9. after quiet -> tell + create', fx)
  reply(f, 'R2', [MSG])
  f('audio.stopped', { response: 'R2' })
  turn(f, 'T1')
  fx = f('session.down', { lost: true })
  check(lines(fx).map(l => l.kind).join() === 'missed', '9. a lost un-acted turn -> line missed', fx)
  f('session.up')
  turn(f, 'T2')
  fx = f('session.down', { lost: false })
  check(!lines(fx).length && owedTurns(f).length === 0, '9. a pause -> no line missed', fx)
}

// 10. Tools in flight while a new turn commits
{
  const f = floor()
  f('session.up')
  const { eventId } = creates(turn(f, 'T1'))[0]
  reply(f, 'R1', [CALL('i1')])
  let fx = turn(f, 'T2')
  check(!creates(fx).length, '10. no create before tools.done', fx)
  fx = f('tools.done', { eventId, results: [result('i1', { ok: true, state: 'started' })] })
  check(creates(fx).length === 1 && creates(fx)[0].kind === 'turn' && f.state().slot.turns.join() === 'T1,T2', '10. then one create(turn) covering both', fx)
}

// 11. Rejected create
{
  const f = floor()
  f('session.up')
  const first = creates(turn(f, 'T1'))[0]
  let fx = f('error', { eventId: 'something_else' })
  check(fx.length === 0 && f.state().slot?.eventId === first.eventId, '11. an unrelated error changes nothing', fx)
  fx = f('error', { eventId: first.eventId })
  const retry = creates(fx)[0]
  check(retry?.kind === 'turn' && retry.eventId !== first.eventId, '11. matching error -> retried', fx)
  fx = f('error', { eventId: retry.eventId })
  check(lines(fx).map(l => l.kind).join() === 'missed' && !creates(fx).length && owedTurns(f).length === 0, '11. rejected again -> line missed', fx)
}

// 12. Quiet
{
  const f = floor()
  f('session.up')
  f('turn.started', { id: 'T1' })
  let fx = f('outbox', { entries: [entry('m1'), entry('m2')] })
  check(fx.length === 0 && wakeAt(f.state()) === null, '12. owed entries while hearing -> nothing', fx)
  f.wait(100)
  fx = f('turn.stopped', { id: 'T1' })
  check(fx.length === 0 && wakeAt(f.state()) === f.at() + SLOT_MS, '12. turn.stopped -> still the user\'s until committed (wake only at its bound)', fx)
  f('turn.committed', { id: 'T1' })
  reply(f, 'R1', [PASS('p1')])
  check(wakeAt(f.state()) === f.at() + QUIET_MS, '12. the turn declined -> wakeAt = +700', wakeAt(f.state()) - f.at())
  f.wait(QUIET_MS - 1)
  fx = f('tick')
  check(fx.length === 0, '12. early tick -> nothing', fx)
  f.wait(1)
  fx = f('tick')
  check(types(fx).join() === 'tell,create' && fx[0].entries.map(e => e.id).join() === 'm1,m2' && fx[1].kind === 'speak', '12. later tick -> one tell with all owed entries in order + create(speak)', fx)
}

// 13. Receipts
{
  const f = floor()
  const m1 = entry('m1'), m2 = entry('m2')
  f('outbox', { entries: [m1] })
  f('session.up')
  announce(f)
  reply(f, 'R1', [MSG])
  f('audio.stopped', { response: 'R1' })
  let fx = f('outbox', { entries: [m1, m2] })
  check(receipts(fx).join() === 'spoken:m1' && !creates(fx).length && !only(fx, 'tell').length, '13. a snapshot still showing a settled entry -> delivered re-sent, no re-announce', fx)
  fx = f('outbox', { entries: [m1, m2] })
  check(types(fx).join() === 'delivered' && receipts(fx).join() === 'spoken:m1', '13. the same snapshot again -> re-sent again, nothing else', fx)
  f('session.down', { lost: false })
  fx = f('session.up')
  check(only(fx, 'tell')[0]?.entries.map(e => e.id).join() === 'm1', '13. a settled, unacknowledged entry is in the seed', fx)
  f('outbox', { entries: [{ ...m1, delivered: 'spoken' }, m2] })
  check(!('m1' in f.state().settled), '13. the core agreeing ends the re-sending', f.state().settled)
  fx = f('voice.off')
  check(receipts(fx).join() === 'shown:m2' && f.state().voice === 'off', '13. voice.off -> everything owed shown', fx)
}

// 14. view, isIdle, wakeAt across case 1
{
  const f = floor()
  const v = () => `${view(f.state()).glyph}${view(f.state()).hearing ? '+hearing' : ''}`
  check(v() === 'off' && !isIdle(f.state(), f.at()) && wakeAt(f.state()) === null, '14. down: off, not idle, no wake')
  f('session.up')
  check(!isIdle(f.state(), f.at()) && (f.wait(IDLE_MS), isIdle(f.state(), f.at())), '14. live: idle only after 10 s of quiet')
  f('turn.started', { id: 'T1' })
  check(v() === 'listening+hearing' && !isIdle(f.state(), f.at() + IDLE_MS), '14. the user talking: listening, not idle', v())
  f('turn.stopped', { id: 'T1' })
  const { eventId } = creates(f('turn.committed', { id: 'T1' }))[0]
  check(v() === 'thinking' && wakeAt(f.state()) === f.at() + SLOT_MS, '14. a reply asked for: thinking, wake at its deadline', v())
  f('response.started', { response: 'R1' })
  f('audio.started', { response: 'R1' })
  check(v() === 'speaking', '14. its audio: speaking', v())
  f('response.done', { response: 'R1', status: 'completed', items: [MSG, CALL('i1')] })
  f('tools.done', { eventId, results: [result('i1', { ok: true, state: 'started' })] })
  f.wait(500)
  f('audio.stopped', { response: 'R1' })
  check(v() === 'off' && !isIdle(f.state(), f.at()) && isIdle(f.state(), f.at() + IDLE_MS) && wakeAt(f.state()) === null, '14. settled: off, idle 10 s later, no wake', v())
  f('outbox', { entries: [entry('m7')] })
  check(!isIdle(f.state(), f.at() + IDLE_MS) && wakeAt(f.state()) === f.at() + QUIET_MS, '14. something owed: not idle, wake after the quiet')
}

// 15. Tool-result speech has its own budget
for (const [name, output] of [['status', { work: 'ready' }], ['answer', { error: 'Nothing was approved.' }]]) {
  const f = floor()
  f('session.up')
  const { eventId } = creates(turn(f, 'T1'))[0]
  reply(f, 'R1', [CALL('i1', name)])
  let fx = f('tools.done', { eventId, results: [result('i1', output)] })
  check(creates(fx)[0]?.kind === 'speak', `15. ${name}: its result -> create(speak)`, fx)
  f('response.started', { response: 'R2' })
  f('audio.started', { response: 'R2' })
  fx = f('response.done', { response: 'R2', status: 'cancelled', items: [] })
  check(creates(fx)[0]?.kind === 'speak' && !lines(fx).length, `15. ${name}: cut once -> create(speak) again`, fx)
  reply(f, 'R3', [MSG])
  fx = f('audio.stopped', { response: 'R3' })
  check(owedTurns(f).length === 0 && !lines(fx).length, `15. ${name}: then heard and settled`, f.state())
}

// 16. Stacked declines
{
  const f = floor()
  f('session.up')
  f('outbox', { entries: [entry('m1')] })
  announce(f)
  reply(f, 'R1', [MSG])
  for (const id of ['T1', 'T2', 'T3']) turn(f, id) // room: the announcement plays on
  let fx = f('audio.stopped', { response: 'R1' })
  check(f.state().slot?.turns.join() === 'T1,T2,T3', '16. three owed turns, one reply', f.state().slot)
  fx = [...reply(f, 'R2', [PASS('p2')]), ...reply(f, 'R3', [PASS('p3')])]
  const t1 = f.state().turns[0]
  check(drops(fx).join() === 'T3,p2,T2,p3' && f.state().slot?.turns.join() === 'T1' && t1.failures === 0 && !lines(fx).length,
    '16. two passes -> the oldest is replied to, with zero failures, no line missed', { fx, turns: f.state().turns })
}

// 17. Token limit
{
  const f = floor()
  f('session.up')
  turn(f, 'T1')
  let fx = reply(f, 'R1', [], { status: 'incomplete' })
  check(!drops(fx).length && creates(fx)[0]?.kind === 'turn' && owedTurns(f).join() === 'T1', '17. incomplete with nothing -> no drop, replied to again', fx)
  fx = reply(f, 'R2', [MSG], { status: 'incomplete', audio: false })
  check(owedTurns(f).length === 0 && !f.state().slot, '17. incomplete with a message -> settled', f.state())
}

// 18. Barge-in on a spoken turn reply, twice in a row
{
  const f = floor()
  f('session.up')
  const all = []
  const cutBy = (response, next) => {
    f('turn.started', { id: next })
    all.push(...f('audio.cleared', { response }), ...f('response.done', { response, status: 'cancelled', items: [] }))
    f('turn.stopped', { id: next })
    all.push(...f('turn.committed', { id: next }))
  }
  all.push(...turn(f, 'T1'))
  f('response.started', { response: 'R1' })
  all.push(...f('response.item', { response: 'R1', kind: 'message' }))
  f('audio.started', { response: 'R1' })
  cutBy('R1', 'T2')
  f('response.started', { response: 'R2' })
  all.push(...f('response.item', { response: 'R2', kind: 'message' }))
  check(owedTurns(f).join() === 'T2', '18. T2 addressed -> T1 leaves turns', f.state().turns)
  f('audio.started', { response: 'R2' })
  cutBy('R2', 'T3')
  all.push(...reply(f, 'R3', [MSG]))
  check(owedTurns(f).join() === 'T3', '18. T3 addressed -> T2 leaves turns', f.state().turns)
  all.push(...f('audio.stopped', { response: 'R3' }))
  check(owedTurns(f).length === 0 && !lines(all).some(l => l.kind === 'missed') && lines(all).map(l => l.turn).join() === 'T1,T2,T3',
    '18. no turn lost, no line missed', lines(all))

  const g = floor()
  g('session.up')
  turn(g, 'T1')
  g('response.started', { response: 'R1' })
  g('response.item', { response: 'R1', kind: 'message' })
  g('audio.started', { response: 'R1' })
  g('turn.started', { id: 'T2' })
  g('response.done', { response: 'R1', status: 'cancelled', items: [] })
  g('turn.stopped', { id: 'T2' })
  g('turn.committed', { id: 'T2' })
  const fx = reply(g, 'R2', [PASS('p2')])
  check(drops(fx).join() === 'T2,p2' && owedTurns(g).join() === 'T1' && g.state().slot?.turns.join() === 'T1', '18. the interrupter declined -> the cut turn stays owed', g.state())

  // Cut before addressed, twice (a request spoken in three pieces): nothing is charged until a reply is addressed.
  const h = floor()
  h('session.up')
  const hx = [...turn(h, 'T1')]
  h('turn.started', { id: 'T2' })
  hx.push(...reply(h, 'R1', [], { status: 'cancelled' }), ...h('turn.stopped', { id: 'T2' }), ...h('turn.committed', { id: 'T2' }))
  h('turn.started', { id: 'T3' })
  hx.push(...reply(h, 'R2', [], { status: 'cancelled' }), ...h('turn.stopped', { id: 'T3' }), ...h('turn.committed', { id: 'T3' }))
  check(h.state().slot?.turns.join() === 'T1,T2,T3' && h.state().turns.every(t => t.failures === 0) && !lines(hx).length,
    '18. cut before addressed, twice -> one reply for all three, no failures, no line missed', { hx, turns: h.state().turns })
  hx.push(...reply(h, 'R3', [MSG]), ...h('audio.stopped', { response: 'R3' }))
  check(owedTurns(h).length === 0 && lines(hx).map(l => l.kind).join() === 'user,user,user', '18. then addressed -> all three settled', lines(hx))
}

// 19. Deadline
{
  const f = floor()
  f('session.up')
  turn(f, 'T1')
  reply(f, 'R1', [MSG])
  check(f.state().slot.phase === 'draining' && wakeAt(f.state()) === f.at() + SLOT_MS, '19. draining: wake at its deadline')
  f.wait(SLOT_MS)
  let fx = f('tick')
  check(creates(fx)[0]?.kind === 'turn' && f.state().turns[0].failures === 1, '19. draining, no audio.stopped -> failed once, replied again', fx)
  const slot = f.state().slot
  fx = [...f('audio.stopped', { response: 'R1' }), ...f('response.done', { response: 'R1', status: 'completed', items: [MSG] })]
  check(fx.length === 0 && JSON.stringify(f.state().slot) === JSON.stringify(slot), '19. late events of the abandoned reply change nothing', fx)

  const g = floor()
  g('session.up')
  const first = creates(turn(g, 'T1'))[0]
  g.wait(SLOT_MS)
  fx = g('tick')
  check(creates(fx)[0]?.eventId !== first.eventId && creates(fx).length === 1, '19. replying, no response at all -> failed once, replied again', fx)

  const h = floor()
  h('session.up')
  const { eventId } = creates(turn(h, 'T1'))[0]
  reply(h, 'R1', [CALL('i1')])
  h.wait(SLOT_MS)
  fx = h('tick')
  check(creates(fx).length === 1 && h.state().turns[0].failures === 1, '19. tools, no tools.done -> failed once, replied again', fx)
  const after = h.state().slot
  fx = h('tools.done', { eventId, results: [result('i1', { ok: true, state: 'started' })] })
  check(fx.length === 0 && JSON.stringify(h.state().slot) === JSON.stringify(after), '19. the abandoned tools.done changes nothing', fx)

  const k = floor()
  k('session.up')
  k('outbox', { entries: [entry('m1')] })
  k('turn.started', { id: 'T1' })
  k('turn.stopped', { id: 'T1' }) // and its commit never comes
  k.wait(SLOT_MS)
  fx = k('tick')
  check(!k.state().hearing && types(fx).join() === 'log,tell,create', '19. a stopped turn never committed -> the floor is free again at its bound', fx)
}

console.log(failed ? `\n${failed} FAILED` : '\nall floor checks passed')
process.exit(failed ? 1 : 0)
