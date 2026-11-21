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
// Then commandFor, for typed input: a whole line of just "stop", "go ahead" or "pause" is that
// control action, whatever the state (the core decides whether it applies); "cancel" is a stop,
// never a decline.
//
//   node overlay/dev/consent-check.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { judgeAnswer, isExplicitApproval, isExplicitDecline, commandFor } from '../consent.js'

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/voice-consent')
const MUST_NOT = new Set(['deny', 'hold', 'echo', 'early', 'ambiguous'])


const COMMANDS = [
  ['Pause.', 'pause'], ['Pause listening.', 'pause'], ['Pause, please.', 'pause'], ['OK, pause please', 'pause'],
  ['Stop.', 'stop'], ['Go ahead.', 'go_ahead'], ['Pause the video.', null],
]
const wrongCommands = COMMANDS.filter(([text, want]) => commandFor(text) !== want)
  .map(([text, want]) => `"${text}": ${commandFor(text)}, want ${want}`)
if (isExplicitDecline('cancel')) wrongCommands.push('"cancel" is a decline, want a stop only')
console.log(`${wrongCommands.length ? 'FAIL' : 'PASS'} commands: ${COMMANDS.length} lines, "cancel" no decline${wrongCommands.map(w => `\n  ${w}`).join('')}`)

if (!fs.existsSync(DIR)) {
  console.log(`SKIP ${DIR} not found`)
  process.exit(wrongCommands.length ? 1 : 0)
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
process.exit(falseApprovals.length || wrongCommands.length ? 1 : 0)
