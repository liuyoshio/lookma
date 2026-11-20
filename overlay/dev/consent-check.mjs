#!/usr/bin/env node
// overlay/consent.js against every recorded voice-consent run in
// overlay/dev/fixtures/voice-consent/*.jsonl. Each record is one card and the user turns after
// it, on the clock the spike measured: cardAt, and per turn the arrival of speech_started
// (with overButler, when it was recorded) and its transcript, matched by item_id (in
// order for the first run, which recorded no ids).
//
// Worst case: every turn is judged as if the butler had called answer(allow=true) on it,
// whatever the model actually did. A turn of a record that must not be approved
// (deny, hold, echo, early, and the lone ok/yeah/sure the spike called ambiguous)
// that judgeAnswer lets through is a false approval. There must be none.
//
// First, worthAnswering: always listening, a turn gets a reply only when its transcript could
// be said to the butler (no silence, hesitation or noise fragment), or when it has none in time.
// Then commandFor: a whole utterance of just "stop", "go ahead" or "pause" acts at once,
// and never while a card is up (then words answer the card).
//
//   node overlay/dev/consent-check.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { judgeAnswer, isExplicitApproval, commandFor, worthAnswering } from '../consent.js'

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/voice-consent')
const MUST_NOT = new Set(['deny', 'hold', 'echo', 'early', 'ambiguous'])

const REPLY = ['Abre Mapas', 'Open Maps', 'stop', 'Stop.', 'pause', 'no', 'No.', 'yes', 'Yes, I approve.', 'OK.', 'wait', 'help', 'Approve?',
  'Hmm, open Safari', '3', null]
const SILENT = ['', '  ', '.', 'Um.', 'Uh, um.', 'Hmm...', 'Tja', 'Tja.', 'you', 'Ja', 'Bye']
const wrongReplies = [...REPLY.filter(t => !worthAnswering(t)).map(t => `${JSON.stringify(t)}: no reply, want one`),
  ...SILENT.filter(t => worthAnswering(t)).map(t => `${JSON.stringify(t)}: a reply, want none`)]
console.log(`${wrongReplies.length ? 'FAIL' : 'PASS'} replies: ${REPLY.length} turns answered, ${SILENT.length} not${wrongReplies.map(w => `\n  ${w}`).join('')}`)

const working = { cards: [], turn: { phase: 'working' }, focus: { phase: 'waiting' }, paused: false }
const withCard = { ...working, cards: [{ id: 'card1' }] }
const COMMANDS = [
  ['Pause.', working, 'pause'], ['Pause listening.', working, 'pause'], ['Pause, please.', working, 'pause'],
  ['OK, pause please', { cards: [], turn: null }, 'pause'],
  ['Pause.', withCard, null], ['Pause.', { ...working, paused: true }, null], ['Pause the video.', working, null],
  ['Stop.', working, 'cancel'], ['Stop.', withCard, null], ['Go ahead.', working, 'goAhead'], ['Go ahead.', withCard, null],
]
const wrongCommands = COMMANDS.filter(([text, state, want]) => commandFor(text, state) !== want)
  .map(([text, state, want]) => `"${text}"${state.cards.length ? ' with a card up' : ''}${state.paused ? ' while paused' : ''}: ${commandFor(text, state)}, want ${want}`)
console.log(`${wrongCommands.length ? 'FAIL' : 'PASS'} commands: ${COMMANDS.length} utterances${wrongCommands.map(w => `\n  ${w}`).join('')}`)

if (!fs.existsSync(DIR)) {
  console.log(`SKIP ${DIR} not found`)
  process.exit(wrongCommands.length || wrongReplies.length ? 1 : 0)
}

function turnsOf(rec) {
  const turns = []
  for (const e of rec.events || []) {
    if (e.type === 'speech_started') turns.push({ item: e.item, startedAt: e.t, overButler: e.overButler === true, transcript: null })
    if (e.type !== 'transcript') continue
    let t = e.item ? turns.find(x => x.item === e.item) : turns.find(x => x.transcript == null)
    if (!t) turns.push((t = { item: e.item, startedAt: e.t, overButler: false })) // no speech_started seen: as late as possible
    t.transcript = e.text ?? ''
  }
  return turns
}

const falseApprovals = []
const textOnly = [] // must-not transcripts that read as approvals; timing or echo must stop them
let records = 0, turnsJudged = 0, transcripts = 0
const approve = { records: 0, approved: 0 }
for (const file of fs.readdirSync(DIR).filter(f => f.endsWith('.jsonl')).sort()) {
  const rows = fs.readFileSync(path.join(DIR, file), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  let fa = 0
  for (const rec of rows) {
    records++
    const turns = turnsOf(rec)
    let approved = false
    for (const turn of turns) {
      turnsJudged++
      if (turn.transcript != null) transcripts++
      const v = judgeAnswer({ allow: true, shownAt: rec.cardAt, turn })
      approved ||= v.ok
      if (MUST_NOT.has(rec.expect)) {
        if (v.ok) { fa++; falseApprovals.push(`${file} ${rec.id}: "${turn.transcript}" (${turn.startedAt - rec.cardAt} ms after the card)`) }
        if (isExplicitApproval(turn.transcript)) textOnly.push(`${file} ${rec.id}: "${turn.transcript}" refused: ${v.why}`)
      }
    }
    if (rec.expect === 'approve') { approve.records++; if (approved) approve.approved++ }
  }
  console.log(`${fa ? 'FAIL' : 'PASS'} ${file}: ${rows.length} records, ${fa} false approvals`)
}

console.log(`\n${records} records, ${turnsJudged} user turns, ${transcripts} transcripts, each judged as allow=true`)
if (textOnly.length) console.log(`must-not transcripts that read as approvals, stopped by timing or echo:\n  ${textOnly.join('\n  ')}`)
console.log(`approve records approved: ${approve.approved} of ${approve.records} (lone "approve" / "go ahead" and garbled transcripts are asked again by design)`)
if (falseApprovals.length) console.log(`\n${falseApprovals.length} FALSE APPROVALS:\n  ${falseApprovals.join('\n  ')}`)
else console.log('\nzero false approvals')
process.exit(falseApprovals.length || wrongCommands.length || wrongReplies.length ? 1 : 0)
