#!/usr/bin/env node
// overlay/voice/source.js on its own, in Node: key, session and quiet events in, effects out, on a
// fake clock. The state handed to step is frozen, so a reducer that mutates its input throws.
// Every case also checks that a listen is emitted exactly when `how` changes.
//
//   node overlay/dev/source-check.mjs

import { initial, step, how, wakeAt, ARM_MS, TAP_MS, MAX_HOLD_MS, TALK_QUIET_MS } from '../voice/source.js'

let failed = 0
function check(ok, what, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${ok || detail === undefined ? '' : `\n  ${JSON.stringify(detail)}`}`)
  if (!ok) failed++
}

/** A source on a fake clock: f(type, props) feeds one event and returns its effects as strings. */
function source(mode, { live = true } = {}) {
  let state = initial(mode)
  let at = 1000
  let levels = 0 // listens that did not match a change of how
  const f = (type, props = {}) => {
    const before = how(state)
    const r = step(Object.freeze(state), { type, at, ...props })
    state = r.state
    const listens = r.effects.filter(e => e.type === 'listen')
    if (listens.length !== (how(state) !== before ? 1 : 0) || listens.some(e => e.how !== how(state))) levels++
    return r.effects.map(e => e.type === 'listen' ? `listen ${e.how}${e.drop ? ' drop' : ''}` : e.type).join(', ')
  }
  f.wait = ms => { at += ms }
  /** Waits until the reducer's next wake, if it is due within ms, and ticks; else just waits. */
  f.until = ms => {
    const t = wakeAt(state)
    if (t != null && t <= at + ms) { at = t; return f('tick') }
    at += ms
    return ''
  }
  f.state = () => state
  f.at = () => at
  f.levels = () => levels
  if (live) f('session.up')
  return f
}

/** A press of ms, ticked as the page's wake timer would. Returns the effects of every step. */
function press(f, ms) {
  const fx = [f('key.down')]
  if (ms >= ARM_MS) fx.push(f.until(ARM_MS))
  f.wait(ms - (ms >= ARM_MS ? ARM_MS : 0))
  fx.push(f('key.up'))
  return fx.filter(Boolean).join(' | ')
}

// Key mode
{
  const f = source('key', { live: false })
  check(f('session.up') === '' && how(f.state()) === 'off', 'key: a new session rests off and needs no listen')
  check(press(f, 100) === 'cut, listen auto' && f.state().open, 'key: a tap from closed cuts and opens a conversation')
  check(press(f, 100) === 'cut, listen off' && !f.state().open, 'key: a tap from open cuts and closes it')

  f('key.down')
  f.wait(100)
  check(f('key.cancel') === '' && f.until(1000) === '' && f.state().key === 'up', 'key: a press of 100 ms then cancelled (a shortcut) emits nothing')

  check(f('key.down') === '' && f.until(ARM_MS) === 'cut, listen hold', 'key: a hold arms at ARM_MS with cut, then listen hold')
  f.wait(200 - ARM_MS)
  check(f('key.up') === 'listen auto drop' && f.state().open, 'key: released at 200 ms, a tap: the hold\'s turn dropped, the conversation open')
  press(f, 100) // close it

  check(press(f, 1000) === 'cut, listen hold | listen off', 'key: released at 1 s, the turn is committed (no drop) and the microphone closes')

  f('key.down')
  f.until(ARM_MS)
  f.wait(500)
  check(f('key.cancel') === 'listen off drop', 'key: cancelled while held, the turn is dropped')

  f('key.down')
  f.until(ARM_MS)
  check(f.until(MAX_HOLD_MS) === 'listen off' && f.state().key === 'up', 'key: a hold ends by itself at MAX_HOLD_MS, committed')
  check(f('key.up') === '', 'key: the late key.up of that hold is ignored')

  press(f, 100) // open
  check(press(f, 1000) === 'cut, listen hold | listen auto' && f.state().open, 'key: a hold inside a conversation returns to auto, the conversation still open')

  check(f('key.toggle') === 'cut, listen off' && f('key.toggle') === 'cut, listen auto', 'key: toggle (the menu) closes and opens, cutting each time')

  check(f.levels() === 0, 'key: exactly one listen per change of how, and none otherwise')
}

// Quiet closes a conversation
{
  const f = source('key')
  press(f, 100)
  check(f.until(TALK_QUIET_MS * 2) === '' && f.state().open, 'quiet: never closes while quietSince is null (something going on)')
  f('quiet', { since: f.at() })
  f.wait(TALK_QUIET_MS - 1)
  check(f('tick') === '' && f.state().open, 'quiet: still open just before TALK_QUIET_MS')
  check(f.until(10) === 'listen off' && !f.state().open, 'quiet: closed after TALK_QUIET_MS of quiet')

  const g = source('key')
  g('quiet', { since: g.at() })
  g.wait(TALK_QUIET_MS * 2)
  press(g, 100)
  check(g.until(TALK_QUIET_MS - 1) === '' && g.state().open && g.until(1) === 'listen off', 'quiet: counted from the opening when the quiet began earlier')
}

// Always mode
{
  const f = source('always', { live: false })
  check(f('session.up') === 'listen auto', 'always: a new session listens auto')
  check(press(f, 100) === 'cut' && !f.state().open, 'always: a tap only cuts')
  check(press(f, 1000) === 'cut, listen hold | listen auto', 'always: a hold returns to auto')
  f('key.down')
  f.until(ARM_MS)
  f.wait(TAP_MS - ARM_MS - 1)
  check(f('key.up') === 'listen auto drop', 'always: a short hold is a tap: its turn dropped, back to auto')
  check(f('key.toggle') === 'cut' && !f.state().open, 'always: toggle only cuts')
  check(f.levels() === 0, 'always: exactly one listen per change of how')
}

// Session, mode and microphone
{
  const f = source('key')
  press(f, 100)
  f('key.down')
  check(f('mic.failed') === 'listen off' && f.state().key === 'up' && !f.state().open, 'mic.failed: the gesture did nothing, back to rest')

  press(f, 100)
  f('key.down')
  f.until(ARM_MS)
  check(f('session.down') === 'listen off' && f.state().key === 'up' && !f.state().open, 'session.down: the hold and the conversation end')
  check(f('key.down') === '' && f('key.toggle') === '' && f.state().key === 'up', 'keys are ignored while no session is live')
  check(f('session.up') === '' && how(f.state()) === 'off', 'session.up in key mode: back to rest, off')

  const g = source('always')
  g('session.down')
  check(g('session.up') === 'listen auto', 'session.up in always: the rest listen is emitted again')

  press(f, 100)
  check(f('mode', { mode: 'always' }) === '' && !f.state().open && how(f.state()) === 'auto', 'mode always while a conversation is open: the conversation ends, still auto')
  check(f('mode', { mode: 'key' }) === 'listen off', 'mode key: rests off')
  check(f.levels() === 0 && g.levels() === 0, 'session and mode: exactly one listen per change of how')
}

console.log(failed ? `\n${failed} FAILED` : '\nall source checks passed')
process.exit(failed ? 1 : 0)
