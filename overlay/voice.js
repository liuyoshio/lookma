// The realtime voice client: the "butler". This file only assembles it:
//   voice/session.js  - the session: grant, microphone, the provider's connection, reconnects, renewal, pause
//   voice/contract.js - what a voice provider (voices/<name>/page.js) emits and is sent: voice events, effects
//   voice/source.js   - the turn source: whether the microphone is open, and who ends the turn (a pure reducer)
//   voice/floor.js    - who speaks and what is still owed (a pure reducer; its rules are there)
//   voice/turns.js    - what is known about each user turn, for approvals and captions
//   voice/butler.js   - the butler's tools (do, status, answer, control) and the wording of what it is told
//
// Full duplex, on one warm session. The talk mode (the snapshot's `talk`) is the turn source's
// rest: key (the default), the microphone is closed until the key is held, or a tap opens a
// hands-free conversation; always, it is open whenever a session is live. The key comes from the app (key()). In
// auto the provider finds each turn, in hold the key bounds it, and the provider never replies by
// itself; every committed turn goes to the floor, which asks for a reply at once, and
// the butler decides whether it was meant for it (its pass tool, or saying nothing). What the
// work wants said is the core's outbox: every snapshot hands it to the floor, which announces
// what is owed when nobody is talking and sends a receipt (delivered) for each entry. Replies
// use the session's own instructions, never an override, so the approval policy always applies.
//
// Here: dispatch(event) runs the floor's step, executes its effects through one table, keeps
// the one wake timer and pushes the view to the page; talk(event) does the same for the turn
// source, whose quiet it computes from both: nobody speaking, nothing owed, no turn working and no
// card waiting (background tasks do not count: they can run for an hour). The source's tones play
// here: the open tone once the latest listen has the microphone live (a tap replaces its hold's
// listen before the device opens), the close tone at once, and only after an open tone.

import { createSession } from './voice/session.js'
import { createTurns } from './voice/turns.js'
import { createButler, marked } from './voice/butler.js'
import * as floor from './voice/floor.js'
import * as source from './voice/source.js'
import { tone } from './sound.js'

/**
 * @param {object} o
 * @param {boolean} o.enabled                false (?voice=0): a spectator with captions only. No session and
 *        no receipts: the floor stays down, so this page never settles what the app's voice owes
 * @param {() => object} o.getState          latest core snapshot
 * @param {(msg: object) => Promise<object>} o.request  a request to the core (link.request); resolves with its ack
 * @param {(msg: object) => boolean} o.send  a message to the core with no ack (link.send): receipts
 * @param {(id: string, allow: boolean, via: string) => Promise<object>} o.answerCard  resolves with the ack
 * @param {(id: string) => number} o.cardShownAt  when the overlay rendered the card (Infinity: not yet)
 * @param {(v: { glyph: string, hearing: boolean, available: boolean, how: string, open: boolean }) => void} o.onVoice
 *        glyph: off | listening | thinking | speaking; hearing: the user is talking now;
 *        available: voice is on, not paused, and not failing; how: the microphone, off | hold | auto
 *        (voice/source.js); open: a hands-free conversation is open
 * @param {(line: object) => void} o.onLine  a line for the capsule or a card:
 *        { kind: 'user', text }            a user turn the butler took, as heard
 *        { kind: 'unheard', text, cardId } an utterance that did not count as an answer
 *        { kind: 'missed' }                a request the voice gave up on ("say that again")
 *        { kind: 'nomic' }                 the microphone could not open
 * @param {(msg: string) => void} o.log
 * @returns {{ update(snapshot: object): void, key(edge: 'down' | 'up' | 'cancel' | 'toggle'): void }}
 */
export function createVoice(o) {
  let state = floor.initial()
  let timer = 0
  let talking = source.initial('key') // the default, closed, until the core's first snapshot says otherwise
  let talkTimer = 0
  let busy = false, calmAt = 0 // the snapshot's work: running or waiting on a card; when it last stopped
  let quiet = null             // the quiet last given to the turn source
  let heard = Promise.resolve(true) // the last listen: true once sent (the microphone live), false if replaced or failed
  let toned = false                 // the open tone played and the microphone has not closed since

  const turns = createTurns({ log: o.log })
  const idle = () => floor.isIdle(state, Date.now()) && !source.view(talking).open
  const session = createSession({ enabled: o.enabled, onEvent, onChange, isIdle: idle, log: o.log })
  const butler = createButler({
    getState: o.getState, request: o.request, answerCard: o.answerCard, cardShownAt: o.cardShownAt,
    evidence: turns.evidence, onLine: o.onLine, log: o.log,
  })
  const available = () => session.status === 'connecting' || session.status === 'live'

  // The floor's effects, and all this file knows about them.
  const EFFECTS = {
    tell(e) {
      session.send({ type: 'tell', texts: e.entries.map(x => marked(x, e.earlier)) })
      if (e.earlier) o.log(`voice: the new session is told ${e.entries.length} earlier item(s)`)
    },
    create: session.send,
    drop: session.send,
    output: session.send,
    run(e) {
      const live = session.guard()
      butler.run(e.calls, e.turn).then(results => live() && dispatch({ type: 'tools.done', eventId: e.eventId, results }))
    },
    delivered: e => o.send({ type: 'delivered', ids: e.ids, how: e.how }),
    line(e) {
      if (e.kind === 'missed') return o.onLine({ kind: 'missed' })
      turns.text(e.turn).then(text => text && o.onLine({ kind: 'user', text }))
    },
    log: e => o.log(e.text),
  }

  function dispatch(event) {
    const r = floor.step(state, { ...event, at: Date.now() })
    state = r.state
    for (const e of r.effects) EFFECTS[e.type](e)
    clearTimeout(timer)
    const t = floor.wakeAt(state)
    if (t != null) timer = setTimeout(() => dispatch({ type: 'tick' }), Math.max(0, t - Date.now()))
    show()
    calm()
  }

  /** The view to the page: the floor's and the turn source's. */
  function show() {
    o.onVoice({ ...floor.view(state), available: available(), ...source.view(talking) })
  }

  // The turn source's effects. The floor hears of a cut and a hold before the provider acts.
  const TALK = {
    cut() {
      dispatch({ type: 'user.cut' })
      session.send({ type: 'cut' })
    },
    listen(e) {
      dispatch({ type: 'user.hold', on: e.how === 'hold' })
      heard = session.listen(e).catch(err => {
        o.log(`voice: the microphone did not open (${err.message})`)
        o.onLine({ kind: 'nomic' })
        talk({ type: 'mic.failed' })
        return false
      })
    },
    sound: e => e.which === 'open' ? opened(heard) : toned && tone('close'),
  }

  /** The open tone, once the latest listen is sent with the microphone open; one that replaced p is waited for instead. */
  function opened(p) {
    p.then(sent => {
      if (p !== heard) return opened(heard)
      if (!sent || toned || source.how(talking) === 'off') return
      toned = true
      tone('open')
    })
  }

  function talk(event) {
    const r = source.step(talking, { ...event, at: Date.now() })
    talking = r.state
    for (const e of r.effects) TALK[e.type](e)
    if (source.how(talking) === 'off') toned = false // closed, with its tone or silently (a reconnect, a failure)
    clearTimeout(talkTimer)
    const t = source.wakeAt(talking)
    if (t != null) talkTimer = setTimeout(() => talk({ type: 'tick' }), Math.max(0, t - Date.now()))
    show()
  }

  /** The quiet a hands-free conversation closes on, given to the turn source when it changes. */
  function calm() {
    const since = floor.quietSince(state)
    const next = busy || since == null ? null : Math.max(since, calmAt)
    if (next === quiet) return
    quiet = next
    talk({ type: 'quiet', since: next })
  }

  function onEvent(ev) {
    turns.note(ev, Date.now(), floor.audible(state))
    if (ev.type === 'error') o.log(`voice: ${ev.message}`)
    dispatch(ev) // every committed turn reaches the floor; the butler judges whether it was meant for it (pass)
  }

  // off: the core has no voice, for good; what is owed is then settled as shown.
  function onChange(status, { lost }) {
    if (status === 'live') {
      dispatch({ type: 'session.up' })
      return talk({ type: 'session.up' })
    }
    turns.reset() // that session's turns are gone with it
    dispatch(status === 'off' ? { type: 'voice.off' } : { type: 'session.down', lost })
    talk({ type: 'session.down' })
  }

  return {
    /** Every core snapshot: the talk mode; paused closes the session and the microphone; the outbox is what is owed. */
    update(snapshot) {
      if (snapshot.talk !== talking.mode) talk({ type: 'mode', mode: snapshot.talk })
      session.run(!snapshot.paused)
      const working = snapshot.turn?.phase === 'working' || snapshot.cards.length > 0
      if (busy && !working) calmAt = Date.now()
      busy = working
      dispatch({ type: 'outbox', entries: snapshot.outbox })
    },
    /** The talk key, from the app: down, up, cancel, or toggle (the menu's Start/End Conversation). */
    key: edge => talk({ type: `key.${edge}` }),
  }
}
