// The realtime voice client: the "butler". This file only assembles it:
//   voice/session.js  - the session: grant, microphone, the provider's connection, reconnects, renewal, pause
//   voice/contract.js - what a voice provider (voices/<name>/page.js) emits and is sent: voice events, effects
//   voice/floor.js    - who speaks and what is still owed (a pure reducer; its rules are there)
//   voice/turns.js    - what is known about each user turn, for approvals and captions
//   voice/butler.js   - the butler's tools (do, status, answer, control) and the wording of what it is told
//
// Always listening, full duplex, on one warm session. The provider finds each turn and never
// replies by itself; every committed turn goes to the floor, which asks for a reply at once, and
// the butler decides whether it was meant for it (its pass tool, or saying nothing). What the
// work wants said is the core's outbox: every snapshot hands it to the floor, which announces
// what is owed when nobody is talking and sends a receipt (delivered) for each entry. Replies
// use the session's own instructions, never an override, so the approval policy always applies.
//
// Here: dispatch(event) runs the floor's step, executes its effects through one table, keeps
// the one wake timer and pushes the view to the page.

import { createSession } from './voice/session.js'
import { createTurns } from './voice/turns.js'
import { createButler, marked } from './voice/butler.js'
import { initial, step, view, isIdle, wakeAt } from './voice/floor.js'

/**
 * @param {object} o
 * @param {boolean} o.enabled                false (?voice=0): a spectator with captions only. No session and
 *        no receipts: the floor stays down, so this page never settles what the app's voice owes
 * @param {() => object} o.getState          latest core snapshot
 * @param {(msg: object) => Promise<object>} o.request  a request to the core (link.request); resolves with its ack
 * @param {(msg: object) => boolean} o.send  a message to the core with no ack (link.send): receipts
 * @param {(id: string, allow: boolean, via: string) => Promise<object>} o.answerCard  resolves with the ack
 * @param {(id: string) => number} o.cardShownAt  when the overlay rendered the card (Infinity: not yet)
 * @param {(v: { glyph: string, hearing: boolean, available: boolean }) => void} o.onVoice
 *        glyph: off | listening | thinking | speaking; hearing: the user is talking now;
 *        available: voice is on, not paused, and not failing
 * @param {(line: object) => void} o.onLine  a line for the capsule or a card:
 *        { kind: 'user', text }            a user turn the butler took, as heard
 *        { kind: 'unheard', text, cardId } an utterance that did not count as an answer
 *        { kind: 'missed' }                a request the voice gave up on ("say that again")
 * @param {(msg: string) => void} o.log
 * @returns {{ update(snapshot: object): void }}
 */
export function createVoice(o) {
  let state = initial()
  let timer = 0

  const turns = createTurns({ log: o.log })
  const session = createSession({ enabled: o.enabled, onEvent, onChange, isIdle: () => isIdle(state, Date.now()), log: o.log })
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
    const r = step(state, { ...event, at: Date.now() })
    state = r.state
    for (const e of r.effects) EFFECTS[e.type](e)
    clearTimeout(timer)
    const t = wakeAt(state)
    if (t != null) timer = setTimeout(() => dispatch({ type: 'tick' }), Math.max(0, t - Date.now()))
    o.onVoice({ ...view(state), available: available() })
  }

  // The turn gate: the single decision point for which committed turns reach the floor. Every
  // one does: the butler judges. Should it prove unable to tell noise from requests, the fallback
  // is here: wait for the transcript and admit only what worthAnswering (consent.js) keeps.
  const admit = ev => dispatch(ev)

  function onEvent(ev) {
    turns.note(ev, Date.now(), !!state.slot?.audio)
    if (ev.type === 'error') o.log(`voice: ${ev.message}`)
    if (ev.type === 'turn.committed') admit(ev)
    else dispatch(ev)
  }

  // off: the core has no voice, for good; what is owed is then settled as shown.
  function onChange(status, { lost }) {
    if (status === 'live') return dispatch({ type: 'session.up' })
    turns.reset() // that session's turns are gone with it
    dispatch(status === 'off' ? { type: 'voice.off' } : { type: 'session.down', lost })
  }

  return {
    /** Every core snapshot: paused closes the session and the microphone; the outbox is what is owed. */
    update(snapshot) {
      session.run(!snapshot.paused)
      dispatch({ type: 'outbox', entries: snapshot.outbox })
    },
  }
}
