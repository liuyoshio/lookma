// What the user's words are allowed to do. Pure functions, no DOM, so they can be
// tested in Node against recorded transcripts (overlay/dev/consent-check.mjs).
//
// Approvals, from the voice-consent experiments (data in overlay/dev/fixtures/voice-consent). The spoken protocol is
// "yes, I approve", in English. A voiced approval (allow=true) is sent only when
// all of these hold:
//   1. the butler model called answer(allow=true); it heard the audio itself;
//   2. the user turn that led to the call started at least MIN_CARD_MS after the card
//      was rendered: nobody approves a card they have not seen, and a "go ahead" meant
//      for something else when the card popped up does not count;
//   3. it cannot be the butler's own voice: an answer said over the butler (barge-in)
//      counts, because users answer as soon as they see the card, unless what the
//      butler was saying itself contains an approval phrase ("say yes, I approve"):
//      then its voice leaking into the mic would sound like the user approving. The
//      butler is told to ask with just "Approve?", so this rarely bites;
//   4. that turn's own transcript is an explicit approval (isExplicitApproval):
//      a. only words from the lists below: anything unknown, in any language, fails
//         closed ("wait", "don't", "not yet", "approve?", a garbled transcript);
//      b. no question mark;
//      c. an approval word that is not alone: with a yes-word ("yes, I approve",
//         "OK, do it"), with a second approval phrase ("approved, do it"),
//         or in the first person ("I approve"). A lone "approve" or "go ahead"
//         is also how people ask back, and when the voice barely rises neither
//         the model nor the transcriber hears the question.
// The model (audio) and the transcriber (text) are two independent ears; both must hear
// an explicit approval.
//
// Declines get the same checks 2-4, with an explicit "no" instead (isExplicitDecline):
// a wrong "no" is not free either. It refuses a step the user wanted, and the agent's work
// goes on without it or stops short (an echo of the voice's own "Sure.", heard over its
// question, has declined a card live). Anything unclear asks again.

export const MIN_CARD_MS = 1000
export const TRANSCRIPT_WAIT_MS = 3000

// Approval phrases. FIRST_PERSON ones are complete on their own.
const APPROVAL = ['approve', 'approved', 'go ahead', 'do it']
const FIRST_PERSON = ['i approve']
// Yes-words make a lone approval phrase an answer. They never approve on their own.
const YES = ['yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'alright', 'all right']
// Allowed around the others; they count for nothing.
const FILLER = ['please', 'it', 'that', 'this', 'now', 'then', 'just', 'so', 'and', 'right']

// Decline phrases: the whole utterance must be made of these and fillers.
// "cancel" is not one: it is a stop (STOP below), which stops the work and takes its cards along.
const DECLINE = ['no', 'nope', 'decline', 'declined', 'deny', "don't", 'do not', 'reject', 'not now',
  'no thanks', 'no thank you']

const sortLongestFirst = list => list.sort((a, b) => b[0].length - a[0].length) // "approved" before "approve"
const APPROVE_TABLE = sortLongestFirst([
  ...APPROVAL.map(p => [p, 'approval']),
  ...FIRST_PERSON.map(p => [p, 'first']),
  ...YES.map(p => [p, 'yes']),
  ...FILLER.map(p => [p, 'filler']),
])
const DECLINE_TABLE = sortLongestFirst([...DECLINE.map(p => [p, 'decline']), ...FILLER.map(p => [p, 'filler'])])
const LATIN = /[a-z0-9']/

// Counts per kind when every word of the utterance is in the table; null when any word is
// not (unknown words, in any language, fail closed) or when it is a question.
function classify(text, table) {
  if (typeof text !== 'string' || /\?/.test(text)) return null
  const s = text.toLowerCase().replace(/[’`]/g, "'").replace(/[^\p{L}\p{N}'\s]/gu, ' ').replace(/\s+/g, ' ').trim()
  const n = {}
  let i = 0
  while (i < s.length) {
    if (s[i] === ' ') { i++; continue }
    const hit = table.find(([p]) => s.startsWith(p, i) && !(LATIN.test(p.at(-1)) && LATIN.test(s[i + p.length] ?? '')))
    if (!hit) return null
    n[hit[1]] = (n[hit[1]] || 0) + 1
    i += hit[0].length
  }
  return n
}

// Words of an utterance, lowercased; CJK text becomes single characters.
export const words = text => text.toLowerCase().replace(/[’`]/g, "'")
  .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, ' $& ')
  .split(/[^\p{L}\p{N}']+/u).filter(Boolean)

/** Rule 3: true when the butler's words contain an approval phrase its echo could pass for. */
export function voicesApproval(butlerSaid) {
  const t = (butlerSaid || '').toLowerCase()
  const w = new Set(words(t))
  const approval = w.has('approve') || w.has('approved') || /\bgo ahead\b|\bdo it\b/.test(t)
  return approval && ['yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'alright', 'i'].some(y => w.has(y))
}

/** True when the whole utterance is an explicit approval (rule 4). */
export function isExplicitApproval(text) {
  const n = classify(text, APPROVE_TABLE)
  return !!n && (n.first > 0 || (n.approval > 0 && (n.yes > 0 || n.approval > 1)))
}

/** True when the whole utterance is an explicit no ("no", "don't"). */
export function isExplicitDecline(text) {
  const n = classify(text, DECLINE_TABLE)
  return !!n && n.decline > 0
}

// What the butler is told on a refusal. Generic on purpose: it reads its tool results
// aloud, so the cause (and the user's words) stay in `why`, for logs only.
const NOT_YET = 'Nothing was sent: the user has not answered this request yet. Ask them, then wait for the answer.'
const ASK_AGAIN = 'Nothing was approved. If the user asked something, answer it. Then ask again in a few words ending with "Approve?". Do not say the approval phrase yourself: it is on the card.'

/**
 * Decide whether a voiced answer to a card may be sent.
 * @param {object}  a
 * @param {boolean} a.allow      what the butler wants to answer
 * @param {number}  a.shownAt    when the overlay rendered the card (ms)
 * @param {object}  [a.turn]     the user turn that led to the call:
 *                               { startedAt: ms (speech_started arrival), overButler: boolean, transcript: string|null }
 * @returns {{ ok: true } | { ok: false, why: string, reason: string }}
 *          `why` is for logs; `reason` goes back to the butler as the tool's error.
 */
export function judgeAnswer({ allow, shownAt, turn }) {
  if (!turn || !(turn.startedAt > shownAt)) return { ok: false, why: 'no answer yet', reason: NOT_YET }
  const why =
    turn.startedAt - shownAt < MIN_CARD_MS ? 'card too new' :
    turn.overButler && voicesApproval(turn.butlerSaid) ? 'said over the butler voicing an approval' :
    turn.transcript == null ? 'no transcript' :
    !(allow ? isExplicitApproval : isExplicitDecline)(turn.transcript) ? 'not explicit' : ''
  return why ? { ok: false, why, reason: ASK_AGAIN } : { ok: true }
}

// Typed control words. Spoken ones are the butler's (its control tool); typed input has no
// butler, so this is a second reader of intent, for text only. The core decides whether the
// command applies, so nothing here looks at state.
const norm = s => s.toLowerCase().replace(/[.,!\s]+/g, ' ').trim()
const LEAD = String.raw`(?:(?:ok(?:ay)?|yes|yeah|please|now|alright) )*`
const STOP = new RegExp(String.raw`^${LEAD}(stop|stop it|stop that|cancel|cancel that|cancel it|abort)(?: please)?$`)
const GO = new RegExp(String.raw`^${LEAD}(go ahead|continue|go on|carry on|keep going)(?: please)?$`)
const PAUSE = new RegExp(String.raw`^${LEAD}(pause|pause listening)(?: please)?$`)

/**
 * A whole typed line that is just "stop", "go ahead" or "pause" becomes that control action.
 * @returns {'stop' | 'go_ahead' | 'pause' | null}
 */
export function commandFor(text) {
  const t = norm(text)
  return STOP.test(t) ? 'stop' : GO.test(t) ? 'go_ahead' : PAUSE.test(t) ? 'pause' : null
}
