// The turn source: is the microphone open, and who ends the turn? A pure reducer, the same shape
// as the floor (voice/floor.js); it imports nothing and knows no provider, key code or wording.
//
// It has exactly three answers, `how`, derived from the state and never stored:
//   off   the microphone is closed: nothing captured, nothing sent, no turns
//   hold  the microphone is open and the key holds the turn: it begins when the hold arms and
//         ends at release
//   auto  the microphone is open and the provider's detector finds the turns
// The talk mode only chooses the rest state: `key` rests `off` (a tap opens a hands-free
// conversation, `auto`, that closes after TALK_QUIET_MS of quiet or another tap); `always` rests
// `auto`. Holding the key gives a `hold` turn in both, and every confirmed gesture (a hold that
// armed, a tap) cuts the butler.
//
// Effects:
//   listen { how, drop? }  the microphone's level, emitted exactly when `how` changes and never
//                          otherwise. drop: the turn the hold began is discarded, not committed
//   cut                    the user stopped the butler by hand
//   sound { which }        open or close: a soft tone when `how` leaves or returns to `off`
//                          while a session stays live, so a connection coming or going (a
//                          reconnect, a renewal, a pause) and a gesture that did nothing (the
//                          microphone failed) make no sound
//
// step(state, event) never mutates its input. Events carry `at`; wakeAt(state) says when the
// reducer next needs a tick. Key events are ignored while no session is live.

export const ARM_MS = 150          // a press is nothing until it has lasted this long alone: fn shortcuts are over or cancelled by then
export const TAP_MS = 300          // released sooner than this after the press: a tap
export const MAX_HOLD_MS = 60000   // a hold ends by itself: a lost key-up must not leave the microphone open
export const TALK_QUIET_MS = 20000 // a hands-free conversation closes after this much quiet

/** @param {'key' | 'always'} mode */
export function initial(mode) {
  return {
    mode,
    live: false,        // a voice session is up
    key: 'up',          // 'up' | 'pressed' (not yet armed) | 'held' (armed: a hold)
    downAt: 0,
    open: false,        // a hands-free conversation (key mode only)
    openedAt: 0,
    quietSince: null,   // when everything last went quiet; null while anything is going on
  }
}

export function how(s) {
  if (!s.live) return 'off'
  if (s.key === 'held') return 'hold'
  return s.mode === 'always' || s.open ? 'auto' : 'off'
}

export function step(state, ev) {
  const s = { ...state }
  const fx = []
  const drop = apply(s, ev, fx)
  const before = how(state), next = how(s)
  if (next === before) return { state: s, effects: fx }
  fx.push({ type: 'listen', how: next, ...(drop && { drop: true }) })
  if (state.live && s.live && ev.type !== 'mic.failed' && (before === 'off' || next === 'off')) {
    fx.push({ type: 'sound', which: next === 'off' ? 'close' : 'open' })
  }
  return { state: s, effects: fx }
}

export function view(s) {
  return { how: how(s), open: s.open }
}

/** When the reducer next needs a tick: the arm, the end of a hold, or the end of a conversation's quiet. */
export function wakeAt(s) {
  const times = []
  if (s.key === 'pressed') times.push(s.downAt + ARM_MS)
  if (s.key === 'held') times.push(s.downAt + MAX_HOLD_MS)
  if (s.open && s.quietSince != null) times.push(Math.max(s.quietSince, s.openedAt) + TALK_QUIET_MS)
  return times.length ? Math.min(...times) : null
}

/** One event. Returns true when the turn a hold began is dropped rather than committed. */
function apply(s, ev, fx) {
  const { at } = ev
  if (ev.type.startsWith('key.') && !s.live) return false
  switch (ev.type) {
    case 'session.up':
      s.live = true
      return false
    case 'session.down':
      Object.assign(s, { live: false, key: 'up', open: false })
      return false
    case 'mode':
      s.mode = ev.mode
      if (s.mode === 'always') s.open = false
      return false
    case 'key.down':
      if (s.key === 'up') Object.assign(s, { key: 'pressed', downAt: at })
      return false
    case 'key.up': {
      if (s.key === 'up') return false // a hold that already ended (MAX_HOLD_MS)
      const armed = s.key === 'held'
      s.key = 'up'
      if (armed && at - s.downAt >= TAP_MS) return false // a hold: committed
      if (!armed) fx.push({ type: 'cut' }) // a tap that never armed has not cut yet
      toggle(s, at)
      return armed
    }
    case 'key.cancel': {
      const armed = s.key === 'held'
      s.key = 'up'
      return armed
    }
    case 'key.toggle': // the menu's Start/End Conversation
      fx.push({ type: 'cut' })
      toggle(s, at)
      return false
    case 'mic.failed': // the gesture did nothing
      Object.assign(s, { key: 'up', open: false })
      return false
    case 'quiet':
      s.quietSince = ev.since
      return false
    case 'tick':
      if (s.key === 'pressed' && at >= s.downAt + ARM_MS) {
        s.key = 'held'
        fx.push({ type: 'cut' })
      } else if (s.key === 'held' && at >= s.downAt + MAX_HOLD_MS) {
        s.key = 'up' // committed; the late key.up finds 'up'
      }
      if (s.open && s.quietSince != null && at >= Math.max(s.quietSince, s.openedAt) + TALK_QUIET_MS) s.open = false
      return false
    default:
      return false
  }
}

/** A tap opens or closes the conversation in key mode; in always there is nothing to toggle. */
function toggle(s, at) {
  if (s.mode !== 'key') return
  s.open = !s.open
  s.openedAt = at
}
