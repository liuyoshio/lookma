// The butler's tools and its wording. To the user the butler is the one doing the work; its
// tools are framed that way:
//   do      - start what the user asked for (the core hands it to the executor)
//   status  - read progress from the latest snapshot
//   answer  - answer the card on screen (the oldest), checked by judgeAnswer() first
//   control - stop, go ahead or pause
// Whatever reaches the core is a request, and the tool's output is the core's ack: the core
// decides whether it applies, never this page. A result is news (the floor has it said) when the
// user has not heard it yet: anything but ok true. marked() is how an outbox entry (an update, a
// report or a card) is put to the butler: as data with a marker its instructions know
// (prompts/butler.md). Nothing here knows the connection or when anything is said.

import { judgeAnswer, TRANSCRIPT_WAIT_MS } from '../consent.js'

export const MARKERS = { update: '[Update from your work', report: '[Your background task', card: '[Approval needed' }

/**
 * What the butler is given to say.
 * @param {{ kind: string, speech?: string, display?: string, title?: string }} entry
 * @param {boolean} earlier  context for a session that replaces a lost one, shown or said before it
 */
export function marked(entry, earlier = false) {
  const was = earlier ? ', from earlier' : ''
  // A card says what approving does: the butler asks for exactly that.
  if (entry.kind === 'card') return `${MARKERS.card} for your own next step${was}; the user did not say this. Approving lets you go ahead with this:] ${entry.display}`
  // Only what to say: the screen already shows the display text.
  if (entry.kind === 'report') return `${MARKERS.report} "${entry.title || 'task'}" finished${was}; the user did not say this] ${entry.speech}`
  const asks = entry.kind === 'question' || entry.kind === 'confirm'
  return `${MARKERS.update}${asks ? ', a question for the user' : ''}${was}; the user did not say this] ${entry.speech}`
}

/** The status tool's answer, from a snapshot. unsaid: what the outbox still owes the user. */
export function statusSummary(state, now) {
  const secs = (a, b) => Math.round(((b || now) - a) / 1000)
  return {
    work: state.executor.status,
    turn: state.turn ? { request: state.turn.sent, doing: state.turn.status, phase: state.turn.phase, seconds: secs(state.turn.startedAt, state.turn.endedAt) } : null,
    screen: state.focus ? {
      step: state.focus.label, app: state.focus.app, phase: state.focus.phase,
      note: state.focus.phase === 'waiting' ? 'waiting until the user stops using the computer, or says go ahead' : undefined,
    } : null,
    approvals_pending: state.cards.map(c => c.title),
    background: state.tasks.map(t => ({ title: t.title, status: t.status, doing: t.status === 'running' ? t.action : undefined, seconds: secs(t.startedAt, t.endedAt) })),
    unsaid: state.outbox.filter(e => !e.delivered).map(e => e.display),
  }
}

/**
 * @param {object} o
 * @param {() => object} o.getState                  latest core snapshot
 * @param {(msg: object) => Promise<object>} o.request  a request to the core; resolves with its ack
 * @param {(id: string, allow: boolean, via: string) => Promise<object>} o.answerCard  resolves with the ack
 * @param {(id: string) => number} o.cardShownAt     when the overlay rendered the card (Infinity: not yet)
 * @param {(id: string, waitMs: number) => Promise<object | null>} o.evidence  a user turn's record (turns.js)
 * @param {(line: object) => void} o.onLine          { kind: 'unheard', text, cardId }: an utterance that did not count as an answer
 * @param {(msg: string) => void} o.log
 */
export function createButler({ getState, request, answerCard, cardShownAt, evidence, onLine, log }) {
  /** Runs tool calls in order; turnId: the newest user turn of the reply (null: none). */
  async function run(calls, turnId) {
    const results = []
    for (const { callId, name, args } of calls) {
      const output = await tool(name, args, turnId)
      results.push({ callId, output, news: output.ok !== true })
    }
    return results
  }

  async function tool(name, args, turnId) {
    switch (name) {
      case 'do': return request({ type: 'tell', text: String(args.task ?? ''), source: 'voice' })
      case 'status': return statusSummary(getState(), Date.now())
      case 'answer': return answer(args.allow === true, turnId)
      case 'control': return request({ type: 'control', action: args.action })
      default: return { error: `Unknown tool ${name}.` }
    }
  }

  // The model decided the user approved or declined; check that against what was actually
  // said in the turn that led to the call, and when, before anything reaches the executor.
  // That turn's transcript can arrive after the call: wait for it, and a transcript that never
  // comes means not approved.
  async function answer(allow, turnId) {
    const card = getState().cards[0] // the one on screen: oldest first, the order they are asked in
    if (!card) return { error: 'No approval is pending.' }
    const turn = await evidence(turnId, TRANSCRIPT_WAIT_MS)
    const verdict = judgeAnswer({ allow, shownAt: cardShownAt(card.id), turn })
    log(`answer(allow=${allow}) on ${JSON.stringify(turn?.transcript ?? null)}: ${verdict.ok ? 'accepted' : 'refused'}`)
    if (!verdict.ok) {
      log(`voice: ${allow ? 'approval' : 'decline'} refused (${verdict.why})`)
      if (turn?.transcript) onLine({ kind: 'unheard', cardId: card.id, text: turn.transcript })
      return { error: verdict.reason } // generic: the butler reads it aloud
    }
    const ack = await answerCard(card.id, allow, 'voice') // the core decides whether it still applies
    return ack.ok ? { ...ack, answered: allow ? 'approved' : 'declined', what: card.title } : ack
  }

  return { run }
}
