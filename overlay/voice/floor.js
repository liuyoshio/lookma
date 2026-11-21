// The floor: who speaks, and what the voice still owes the user. A pure reducer over voice
// events; it imports nothing and knows no Realtime event names, tool names, wording or consent.
//
// The voice owes two kinds of things: a user turn (owed a reply) and an outbox entry (owed an
// announcement). The floor holds at most one reply at a time (the slot) and is the only one that
// asks for a reply (the create effect). The rules:
//   R1  an obligation is settled only when the user heard a true result: a reply covering it
//       spoke, its audio finished, and no tool result is still unsaid
//   R2  a reply starts only while live, with the slot free and the user not speaking (from the
//       start of a turn until it is committed, at most SLOT_MS after its sound stopped); an
//       announcement also waits for QUIET_MS of quiet. Turns first, then the outbox
//   R3  a reply covers everything of its kind that is owed
//   R4  only a reply to turns not yet acted on may use tools (kind 'turn'); every other reply is
//       speak-only. A turn reply that completes with no speech and no real call declines: its
//       newest turn was not meant for the butler and leaves the conversation
//   R5  what the user's voice cut is judged by the next reply. Addressed (a turn reply whose
//       first output is not a pass): entries get a 'cut' receipt, turns stop being owed. Cut
//       too: all of it passes on to the reply after. Any other end: one failure (R6)
//   R6  a failed reply counts against all it covered (a cut only once R5 judged it); after
//       MAX_FAILURES the obligation is settled on screen ('shown', or a "say that again" line).
//       Every slot has a deadline
//   R8  every entry gets exactly one receipt; a receipt is re-sent while a snapshot still shows
//       the entry pending, so a lost one heals itself
//
// step(state, event) never mutates its input. Events carry `at`; wakeAt(state) says when the
// reducer next needs a tick, so time is just another event.

export const QUIET_MS = 700     // an announcement waits this long after the last sound
export const MAX_FAILURES = 2   // failed replies before an obligation is settled on screen
export const IDLE_MS = 10000    // quiet this long, with nothing owed: the session may be renewed
export const SLOT_MS = 30000    // a reply phase, or a stopped turn's commit, this long overdue: a server event was lost

const NONE = { turns: [], entries: [] }

export function initial() {
  return {
    voice: 'down',      // 'down' | 'live' | 'off' (off: for good, the core has no voice)
    hearing: null,      // the turn the user is speaking, until it is committed: { id, until }, or null.
                        // until: SLOT_MS after its sound stopped, should the commit never come
    quietAt: 0,         // when sound last stopped (user or butler) or the slot was last freed
    seq: 0,             // response.create event ids: lookma_<seq>
    slot: null,         // the one reply (start() below), or null
    turns: [],          // owed user turns, oldest first: { id, failures, acted, shown }
    outbox: [],         // the core's entries as of the last snapshot
    settled: {},        // entry id -> how: receipts sent, until the core's snapshot agrees
    failures: {},       // entry id -> failed announcements
    interrupted: NONE,  // what the user's voice cut, not yet charged: judged by the next reply (R5)
  }
}

// Derived, never stored. owed: entries still owed an announcement; recent: those that had one
// (the context a new session is told).
const owed = s => s.outbox.filter(e => !e.delivered && !(e.id in s.settled))
const recent = s => s.outbox.filter(e => e.delivered || e.id in s.settled)
const isOwed = (s, id) => owed(s).some(e => e.id === id)
const slotTurns = s => s.turns.filter(t => s.slot.turns.includes(t.id))

export function step(state, ev) {
  const s = structuredClone(state)
  const fx = []
  apply(s, ev, fx)
  retire(s, fx)
  schedule(s, ev.at, fx)
  return { state: s, effects: fx }
}

export function view(s) {
  const glyph = s.hearing ? 'listening' : s.voice !== 'live' ? 'off' : s.slot?.audio ? 'speaking' : s.slot ? 'thinking' : 'off'
  return { glyph, hearing: !!s.hearing }
}

/** Nothing said, heard or owed for IDLE_MS: the session may be swapped now. */
export function isIdle(s, at) {
  return s.voice === 'live' && !s.slot && !s.hearing && !s.turns.length && !owed(s).length && at - s.quietAt >= IDLE_MS
}

/** When the reducer next needs a tick: a deadline (the slot's, the hearing's), or the end of the quiet an announcement waits for. */
export function wakeAt(s) {
  const times = [s.slot?.until, s.hearing?.until]
  if (s.voice === 'live' && !s.slot && !s.hearing && owed(s).length) times.push(s.quietAt + QUIET_MS)
  const due = times.filter(t => t != null)
  return due.length ? Math.min(...due) : null
}

// ------------------------------------------------------------ apply

function apply(s, ev, fx) {
  const { at } = ev
  const sl = s.slot
  // One stale-reply guard: events of a reply the floor gave up on are never taken for the next one's.
  const mine = !!sl?.response && ev.response === sl.response
  switch (ev.type) {
    case 'session.up': {
      s.voice = 'live'
      s.quietAt = at
      const seed = recent(s)
      if (seed.length) fx.push({ type: 'tell', entries: seed, earlier: true })
      break
    }
    case 'session.down':
      down(s, ev.lost, at, fx)
      break
    case 'voice.off':
      down(s, true, at, fx)
      s.voice = 'off' // retire settles everything owed as shown
      break
    case 'outbox': {
      s.outbox = ev.entries
      const pending = new Set(s.outbox.filter(e => !e.delivered).map(e => e.id))
      for (const how of new Set(Object.values(s.settled))) {
        const ids = Object.keys(s.settled).filter(id => s.settled[id] === how && pending.has(id))
        if (ids.length) fx.push({ type: 'delivered', ids, how }) // the core has not seen it yet: again
      }
      s.settled = keep(s.settled, pending)
      s.failures = keep(s.failures, pending)
      break
    }
    case 'turn.started':
      s.hearing = { id: ev.id, until: null }
      break
    case 'turn.stopped':
      // Sound stopped, but the user holds the floor until the turn is an item (committed comes
      // right after): a reply started in between would miss it. Bounded, like a slot.
      if (s.hearing) s.hearing.until = at + SLOT_MS
      s.quietAt = at
      break
    case 'turn.committed':
      if (s.hearing?.id === ev.id) s.hearing = null
      s.turns.push({ id: ev.id, failures: 0, acted: false, shown: false })
      s.quietAt = at
      break
    case 'response.started':
      if (sl?.phase === 'replying' && !sl.response) sl.response = ev.response
      break
    case 'response.item':
      if (mine && ev.kind !== 'pass') address(s, fx)
      break
    case 'response.done':
      if (mine && sl.phase === 'replying') done(s, ev, at, fx)
      break
    case 'tools.done':
      if (sl?.phase !== 'tools' || ev.eventId !== sl.eventId) break
      fx.push({ type: 'output', results: ev.results })
      for (const t of slotTurns(s)) t.acted = true
      finish(s, sl.spoke && !ev.results.some(r => r.news), at, fx)
      break
    case 'audio.started':
      if (mine) sl.audio = true
      break
    case 'audio.stopped':
    case 'audio.cleared':
      if (!mine) break
      sl.audio = false
      s.quietAt = at
      if (sl.phase !== 'draining') break
      if (ev.type === 'audio.cleared') fail(s, true, 'cut while playing', at, fx)
      else if (sl.heard) settle(s, at, fx)
      else free(s, at) // released: a tool result is still unsaid, and the next reply says it
      break
    case 'error':
      if (sl && ev.eventId === sl.eventId) fail(s, false, 'create rejected', at, fx)
      break
    case 'tick':
      if (s.hearing?.until != null && at >= s.hearing.until) {
        s.hearing = null
        fx.push({ type: 'log', text: 'voice: a turn was never committed' })
      }
      if (sl && at >= sl.until) fail(s, false, `no news in ${sl.phase}`, at, fx)
      break
  }
}

/** The session ended: its reply failed, and its turns die with it (a loss shows a notice; a pause does not). */
function down(s, lost, at, fx) {
  if (s.slot) fail(s, false, 'session ended', at, fx)
  if (lost) lose(s, s.turns, fx)
  s.voice = 'down'
  s.hearing = null
  s.turns = []
  s.interrupted = NONE
}

/** response.done for the slot: settled, ran tools, declined or failed. */
function done(s, ev, at, fx) {
  const sl = s.slot
  if (ev.status === 'cancelled') return fail(s, true, 'cancelled', at, fx)
  if (ev.status === 'failed') return fail(s, false, `failed${ev.reason ? `: ${ev.reason}` : ''}`, at, fx)
  // completed, or incomplete (the token limit)
  const spoke = ev.items.some(i => i.kind === 'message')
  const calls = sl.kind === 'turn' ? ev.items.filter(i => i.kind === 'call' && i.complete) : [] // R4 as structure
  const drop = ev.items.filter(i => i.kind === 'pass' || (i.kind === 'call' && !calls.includes(i))).map(i => i.id)
  if (ev.items.some(i => i.kind !== 'pass')) address(s, fx) // its first item, if that event never came
  const newest = slotTurns(s).at(-1)?.id ?? null
  if (calls.length) {
    sl.phase = 'tools'
    sl.spoke = spoke
    sl.until = at + SLOT_MS
    fx.push({ type: 'run', eventId: sl.eventId, calls, turn: newest })
  } else if (spoke) {
    finish(s, true, at, fx)
  } else if (sl.kind === 'turn' && ev.status === 'completed') {
    // Declined (R4): only the newest turn was not meant for the butler; the others stay owed.
    drop.unshift(newest)
    s.turns = s.turns.filter(t => t.id !== newest)
    fx.push({ type: 'log', text: `voice: not for me, ${newest} dropped` })
    free(s, at)
  } else {
    fail(s, false, 'nothing said', at, fx) // never a decline: a request must not be deleted
  }
  if (drop.length) fx.push({ type: 'drop', items: drop })
}

/** The turn reply's first real output: its turns are shown as taken, and what the user cut is settled (R5). */
function address(s, fx) {
  const sl = s.slot
  if (sl.kind !== 'turn' || sl.addressed) return
  sl.addressed = true
  for (const t of slotTurns(s).filter(t => !t.shown)) {
    t.shown = true
    fx.push({ type: 'line', kind: 'user', turn: t.id })
  }
  const cut = sl.cut.entries.filter(id => isOwed(s, id))
  for (const id of cut) s.settled[id] = 'cut'
  if (cut.length) fx.push({ type: 'delivered', ids: cut, how: 'cut' })
  s.turns = s.turns.filter(t => !sl.cut.turns.includes(t.id))
  sl.cut = NONE
}

/** The reply said what it had to (heard) or left a result unsaid; either way, once its audio is done. */
function finish(s, heard, at, fx) {
  const sl = s.slot
  sl.heard = heard
  if (sl.audio) {
    sl.phase = 'draining'
    sl.until = at + SLOT_MS
  } else if (heard) settle(s, at, fx)
  else free(s, at)
}

/** Heard (R1): its turns are answered, its entries spoken. */
function settle(s, at, fx) {
  const sl = s.slot
  s.turns = s.turns.filter(t => !sl.turns.includes(t.id))
  const ids = sl.entries.filter(id => isOwed(s, id))
  for (const id of ids) s.settled[id] = 'spoken'
  if (ids.length) fx.push({ type: 'delivered', ids, how: 'spoken' })
  free(s, at)
}

/**
 * Everything else (R6). All it covered, with what it was offered as cut, is judged once: by the
 * next reply if the user's voice did it (cut, R5), else as one failure now.
 */
function fail(s, cut, why, at, fx) {
  const sl = s.slot
  const covered = { turns: union(sl.turns, sl.cut.turns), entries: union(sl.entries, sl.cut.entries) }
  if (cut) s.interrupted = covered
  else charge(s, covered)
  sl.cut = NONE
  fx.push({ type: 'log', text: `voice: reply ${sl.eventId} failed (${why})` })
  free(s, at)
}

/** The slot ends. What the user cut and this reply neither addressed nor passed on was not taken: one failure (R5). */
function free(s, at) {
  charge(s, s.slot.cut)
  s.slot = null
  s.quietAt = at
}

/** One failure for each of these turns and entries that is still owed. */
function charge(s, { turns, entries }) {
  for (const t of s.turns) if (turns.includes(t.id)) t.failures += 1
  for (const id of entries) if (isOwed(s, id)) s.failures[id] = (s.failures[id] || 0) + 1
}

/** Turns that leave unanswered; a request never acted on shows "say that again" (the only place). */
function lose(s, turns, fx) {
  if (!turns.length) return
  const ids = turns.map(t => t.id)
  s.turns = s.turns.filter(t => !ids.includes(t.id))
  if (turns.some(t => !t.acted)) fx.push({ type: 'line', kind: 'missed' })
}

// ------------------------------------------------------------ retire, schedule

/** R6, R8: what voice gave up on is settled on screen. */
function retire(s, fx) {
  const shown = owed(s).filter(e => s.voice === 'off' || (s.failures[e.id] || 0) >= MAX_FAILURES).map(e => e.id)
  for (const id of shown) s.settled[id] = 'shown'
  if (shown.length) fx.push({ type: 'delivered', ids: shown, how: 'shown' })
  lose(s, s.turns.filter(t => t.failures >= MAX_FAILURES), fx)
}

/** R2, R3, R4: the only place a reply starts. */
function schedule(s, at, fx) {
  if (s.voice !== 'live' || s.slot || s.hearing) return
  if (s.turns.length) return start(s, s.turns.some(t => !t.acted) ? 'turn' : 'speak', s.turns.map(t => t.id), [], at, fx)
  const due = owed(s)
  if (!due.length || at - s.quietAt < QUIET_MS) return // wakeAt covers the wait
  fx.push({ type: 'tell', entries: due, earlier: false })
  start(s, 'speak', [], due.map(e => e.id), at, fx)
}

function start(s, kind, turns, entries, at, fx) {
  const eventId = `lookma_${++s.seq}`
  s.slot = {
    kind,               // 'turn': tools allowed | 'speak'
    phase: 'replying',  // 'replying' | 'tools' | 'draining'
    eventId,
    response: null,     // the response id, bound at response.started
    until: at + SLOT_MS,
    turns,              // item ids it covers
    entries,            // entry ids it covers
    cut: s.interrupted, // what the user's voice cut, judged by this reply (R5)
    addressed: false,
    spoke: false,
    heard: false,
    audio: false,       // its audio is playing: the butler is audible
  }
  s.interrupted = NONE
  fx.push({ type: 'create', kind, eventId })
}

const union = (a, b) => [...new Set([...a, ...b])]
const keep = (map, ids) => Object.fromEntries(Object.entries(map).filter(([id]) => ids.has(id)))
