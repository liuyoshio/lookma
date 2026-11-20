#!/usr/bin/env node
// Headless check of the voice client (overlay/voice.js) without a microphone or an OpenAI
// key. WebRTC is replaced in the page by a fake peer connection and data channel: the test
// plays the Realtime server's events in, its VAD turns included (speech_started,
// speech_stopped, committed, then the transcript), and reads what the overlay sends back.
// getUserMedia takes 100 ms, as a real one might. Chrome runs muted. Checks:
//   - the butler's session (core/voice-key.mjs): semantic VAD with low eagerness that never
//     replies by itself and lets the user talk over the butler, far-field noise reduction, the
//     max output tokens, the transcription language only when set, and no transcription prompt
//   - at startup one session is connected with the microphone attached; the page never commits
//     or clears the input buffer (the server's VAD does); the talk and wake APIs are gone; the
//     capsule stays hidden while idle
//   - a VAD turn shows "Listening…" while the user talks, and gets a reply once its transcript is
//     in: "Abre Mapas" and "Open Maps" do; "", "Um." and "Tja" get none and are deleted from the
//     conversation; a turn whose transcript is not in by 2.5 s is replied to anyway
//   - a say is spoken on the warm session, and waits while the user talks
//   - a card is announced as a plain user message that says what approving does, with no
//     per-response instruction override; its hint reads Say “yes, I approve”
//   - consent from VAD turn records: "Approve?" (arriving after the call) and a lone "Approve."
//     are refused; "Yes, I approve." said over the butler voicing the phrase is refused (its echo
//     would sound the same), said over the butler asking "Approve?" it approves; less than a
//     second after a new card was rendered it is refused, and after that it approves. Every
//     refusal gives the butler the same generic error, never the user's words or the cause
//   - tell sends {type:'tell', source:'voice'}; status answers from the snapshot
//   - "Stop." while working sends {type:'cancel'} at once, with no reply
//   - "Pause." sends {type:'pause'}, not while a card is up; paused closes the session and stops
//     the microphone; resume reopens both, and the new session is told what was said earlier
//   - a dropped session reconnects in the background, with the same microphone
//   - voice off (the core has no voice, or ?voice=0): no session and no microphone
//
//   node overlay/dev/voice-check.mjs [--port 8795] [--cdp 8796]

import { sleep, arg, check, waitFor, startMock, startChrome, finish } from './harness.mjs'
import { butlerSession } from '../../core/voice-key.mjs'
import { ROOT } from '../../core/config.mjs'

// 0. The session the core mints (no OpenAI call: only the config it would send).
{
  const voice = { model: 'gpt-realtime', voice: 'marin', transcribe: 'gpt-4o-transcribe', language: '', noise: 'far_field', maxTokens: 200 }
  const s = butlerSession({ root: ROOT, voice })
  const td = s.audio.input.turn_detection
  check(td?.type === 'semantic_vad' && td.eagerness === 'low' && td.create_response === false && td.interrupt_response === true,
    `session: semantic VAD, eagerness low, no reply by itself, barge-in ${JSON.stringify(td)}`)
  check(s.audio.input.noise_reduction?.type === 'far_field' && s.max_output_tokens === 200, 'session: far_field noise reduction, max output tokens 200')
  check(JSON.stringify(s.audio.input.transcription) === '{"model":"gpt-4o-transcribe"}', `session: no language unless set, no transcription prompt ${JSON.stringify(s.audio.input.transcription)}`)
  const zh = butlerSession({ root: ROOT, voice: { ...voice, language: 'zh', noise: 'near_field', maxTokens: 150 } })
  check(JSON.stringify(zh.audio.input.transcription) === '{"model":"gpt-4o-transcribe","language":"zh"}' && zh.audio.input.noise_reduction.type === 'near_field' && zh.max_output_tokens === 150,
    `session: LOOKMA_VOICE_LANGUAGE=zh goes to the transcription, noise and max tokens configurable ${JSON.stringify(zh.audio.input.transcription)}`)
}

const PORT = Number(arg('--port', 8795)), CDP = Number(arg('--cdp', 8796))
const mock = startMock({ port: PORT })
const page = await startChrome({ port: CDP })
// Hold the core at the very start, with nothing to say, before the page connects.
await sleep(400)
await mock.restart({ from: 'idle', hold: true })
await mock.until('idle')

await page.beforeLoad(`
  window.__dc = { sent: [], ch: null, pcs: [], closed: 0, mics: [], gums: 0, keys: 0 }
  window.__posts = []
  window.webkit = { messageHandlers: { lookma: { postMessage: m => window.__posts.push(m) } } } // the app
  const keyOff = location.search.includes('fakeKeyOff=1') // a core with no voice
  const realFetch = window.fetch.bind(window)
  window.fetch = (url, opts) => {
    const u = String(url)
    if (u.endsWith('/api/voice-key')) {
      window.__dc.keys++
      const body = keyOff ? { error: 'voice is off (LOOKMA_NO_VOICE=1)' } : { value: 'fake', model: 'fake-realtime', expiresAt: Math.floor(Date.now() / 1000) + 600 }
      return Promise.resolve(new Response(JSON.stringify(body), { status: keyOff ? 503 : 200, headers: { 'Content-Type': 'application/json' } }))
    }
    if (u.startsWith('https://api.openai.com/')) return Promise.resolve(new Response('v=0', { status: 201 }))
    return realFetch(url, opts)
  }
  navigator.mediaDevices.getUserMedia = async () => {
    window.__dc.gums++
    await new Promise(r => setTimeout(r, 100)) // a real microphone takes a moment to start
    const stream = new AudioContext().createMediaStreamDestination().stream
    window.__dc.mics.push(stream)
    return stream
  }
  window.__mics = () => window.__dc.mics.map(m => ({ id: m.getAudioTracks()[0].id, state: m.getAudioTracks()[0].readyState }))
  window.RTCPeerConnection = class {
    constructor() {
      this.connectionState = 'new'
      this.i = window.__dc.pcs.length
      this.rec = { tracks: [], transceivers: 0, offers: 0, closed: false }
      window.__dc.pcs.push(this.rec)
    }
    addTrack(track) { this.rec.tracks.push(track.id) }
    addTransceiver() { this.rec.transceivers++; return { sender: { replaceTrack: async () => {} } } }
    createDataChannel() {
      const i = this.i, rec = this.rec
      const ch = {
        readyState: 'connecting',
        close() {},
        send(d) { window.__dc.sent.push({ ...JSON.parse(d), _pc: i }) },
      }
      window.__dc.ch = this.ch = ch
      setTimeout(() => { if (!rec.closed) { ch.readyState = 'open'; ch.onopen && ch.onopen() } }, 50)
      return ch
    }
    async createOffer() { this.rec.offers++; return { type: 'offer', sdp: 'v=0' } }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() { this.rec.closed = true; window.__dc.closed++; if (this.ch) this.ch.readyState = 'closed' }
  }
  window.__emit = (...events) => { for (const e of events) window.__dc.ch.onmessage({ data: JSON.stringify(e) }) }
  window.__drop = () => { const ch = window.__dc.ch; ch.readyState = 'closed'; ch.onclose && ch.onclose() } // the server went away
`)

const emit = (...events) => page.evaluate(`window.__emit(...${JSON.stringify(events)})`)
const dc = expr => page.evaluate(`window.__dc.${expr}`)
const dcSent = () => dc('sent')
const pcs = () => dc('pcs')
const mics = () => page.evaluate('window.__mics()')
const lastPc = async () => (await pcs()).at(-1)
const posted = key => page.evaluate(`window.__posts.at(-1)?.${key}`)
const capUser = () => page.evaluate(`document.querySelector('#cap .r-user').textContent`)
const capHidden = () => page.evaluate(`document.getElementById('cap').classList.contains('min')`)
const glyphNow = () => page.evaluate(`document.getElementById('vg').className`)
async function glyph(want) { // rendering is coalesced to the next frame
  for (let i = 0; i < 20; i++) { const g = await glyphNow(); if (g === want) return g; await sleep(50) }
  return glyphNow()
}
async function until(pred, ms = 3000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(30)) if (await pred()) return true
  return false
}
const logged = (text, since = 0) => page.logs.slice(since).some(l => l.includes(text))
const text = e => e?.item?.content?.[0]?.text || ''
const userItems = list => list.filter(e => e.type === 'conversation.item.create' && e.item?.role === 'user')
const typesSince = async from => (await dcSent()).slice(from).map(e => e.type)
async function sentSince(from, pred, ms = 3000) {
  for (let t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) {
    const hit = (await dcSent()).slice(from).find(pred)
    if (hit) return hit
  }
  return null
}
const isCreate = e => e.type === 'response.create'
const toCore = type => mock.fromOverlay.filter(m => m.type === type)
const hint = () => page.evaluate(`document.querySelector('#card .k-hint').textContent`)
// A refusal since `since` (taken with mark() before the case): nothing reached the core,
// the butler got the generic error (not the heard words), and the page logged the cause.
const mark = () => ({ logs: page.logs.length, answers: toCore('answer').length })
function refused(since, out, why, heard) {
  return toCore('answer').length === since.answers && /^Nothing was approved\./.test(out?.error || '') && !(heard && out.error.includes(heard)) &&
    logged(`approval refused (${why})`, since.logs)
}
let n = 0
const call = (name, args) => {
  const id = `r${++n}`, callId = `c${n}`
  return { id, callId, events: [
    { type: 'response.created', response: { id } },
    { type: 'response.done', response: { id, status: 'completed', output: [{ type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) }] } },
  ] }
}
const quietResponse = () => { const id = `r${++n}`; return [{ type: 'response.created', response: { id } }, { type: 'response.done', response: { id, status: 'completed', output: [] } }] }
// The butler starts saying `words`; returns the events that end it (played out, or cut off by the user).
async function butlerSays(words) {
  const id = `r${++n}`
  await emit({ type: 'response.created', response: { id } }, { type: 'response.output_audio_transcript.delta', response_id: id, delta: words },
    { type: 'output_audio_buffer.started', response_id: id })
  return {
    done: [{ type: 'output_audio_buffer.stopped', response_id: id }, { type: 'response.done', response: { id, status: 'completed', output: [] } }],
    cut: [{ type: 'output_audio_buffer.cleared', response_id: id }, { type: 'response.done', response: { id, status: 'cancelled', output: [] } }],
  }
}
async function outputOf(callId) {
  for (let i = 0; i < 80; i++) {
    const item = (await dcSent()).find(e => e.type === 'conversation.item.create' && e.item?.call_id === callId)
    if (item) return JSON.parse(item.item.output)
    await sleep(100)
  }
  return null
}
const transcript = (item, words) => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript: words })

// One VAD turn as the server reports it: speech starts, stops, the buffer is committed as an
// item, then its transcript (none: words == null). `cut`: the butler's response it interrupts.
let items = 0
async function vadTurn(words, { talkMs = 300, cut = null } = {}) {
  const item = `in${++items}`
  await emit({ type: 'input_audio_buffer.speech_started', item_id: item, audio_start_ms: 0 })
  if (cut) await emit(...cut) // interrupt_response: the server stops the butler
  await sleep(talkMs)
  await emit({ type: 'input_audio_buffer.speech_stopped', item_id: item }, { type: 'input_audio_buffer.committed', item_id: item })
  if (words != null) { await sleep(150); await transcript(item, words) }
  return item
}
/** A turn that answers the card: the reply is asked for, and the butler calls answer(allow). */
async function answerTurn(words, opts) {
  const from = (await dcSent()).length
  await vadTurn(words, opts)
  await sentSince(from, isCreate)
  const c = call('answer', { allow: true })
  await emit(...c.events)
  return outputOf(c.callId)
}

// 1. Startup: one session, connected with the microphone attached.
await page.goto(`${mock.base}?backdrop=1`)
await until(() => logged('voice: connected, listening'))
await sleep(300)
let p = await lastPc()
let m = await mics()
check((await pcs()).length === 1 && p.tracks.length === 1 && p.transceivers === 0 && (await dc('gums')) === 1 && m[0]?.id === p.tracks[0] && m[0]?.state === 'live',
  `startup: one session, connected with the microphone attached ${JSON.stringify(p)}`)
check((await dcSent()).length === 0, 'startup: nothing sent (nothing to say, nothing to tell a first session)')
check((await glyph('vg off')) === 'vg off' && (await capHidden()), 'startup: the glyph still and the capsule hidden while idle')
check((await posted('voice')) === true && (await posted('listening')) === undefined, 'startup: the app is told voice is on (its menu bar icon)')
check((await page.evaluate('Object.keys(window.lookma).join()')) === 'toggleTyping', 'the talk and wake APIs are gone (talkDown, talkUp, talkCancel, wakeTalk, wakeEnd)')

// 2. A VAD turn: "Listening…" while the user talks, and a reply once its transcript is in.
let from = (await dcSent()).length
let item = `in${++items}`
await emit({ type: 'input_audio_buffer.speech_started', item_id: item, audio_start_ms: 0 })
check((await glyph('vg listening')) === 'vg listening' && (await capUser()) === 'Listening…' && !(await capHidden()), 'a turn: "Listening…" and the glyph while the user talks')
await page.shot('voice-listening')
await sleep(300)
await emit({ type: 'input_audio_buffer.speech_stopped', item_id: item }, { type: 'input_audio_buffer.committed', item_id: item })
await sleep(400)
check(!(await typesSince(from)).includes('response.create'), 'a turn: no reply before its transcript')
await transcript(item, 'Abre Mapas')
check(!!(await sentSince(from, isCreate, 1000)), 'a turn: "Abre Mapas" gets a reply (response.create)')
check(!(await typesSince(from)).some(t => t.startsWith('input_audio_buffer.')), 'the page never commits or clears the input buffer: the server VAD does')
check((await until(async () => (await capUser()) === '“Abre Mapas”', 1000)) && (await glyph('vg thinking')) === 'vg thinking', 'a turn: the capsule shows what was heard, the glyph thinking')
let said = await butlerSays('Maps is open.')
check((await glyph('vg speaking')) === 'vg speaking', 'glyph: speaking while the butler talks')
await emit(...said.done)
check((await glyph('vg off')) === 'vg off', 'glyph: still again once it is done')

// 3. No reply to silence, hesitation or noise; a real request gets one.
for (const words of ['', 'Um.', 'Tja']) {
  from = (await dcSent()).length
  const it = await vadTurn(words)
  const deleted = await sentSince(from, e => e.type === 'conversation.item.delete', 1000)
  await sleep(300)
  check(!(await typesSince(from)).includes('response.create') && deleted?.item_id === it, `${JSON.stringify(words)} gets no reply, and is deleted from the conversation`)
}
from = (await dcSent()).length
await vadTurn('Open Maps')
check(!!(await sentSince(from, isCreate, 1000)) && !(await typesSince(from)).includes('conversation.item.delete'), '"Open Maps" gets a reply')
await emit(...quietResponse())

// 4. A turn whose transcript is not in by 2.5 s is replied to anyway.
from = (await dcSent()).length
let t0 = Date.now()
item = await vadTurn(null)
const late = await sentSince(from, isCreate, 4000)
const waited = Date.now() - t0 - 300
check(!!late && waited >= 2300 && waited < 3500, `no transcript in time: replied to anyway after ${waited} ms`)
await emit(...quietResponse())
await transcript(item, 'Open Safari')

// 5. A say is spoken on the warm session; it waits while the user talks.
from = (await dcSent()).length
await mock.say({ speech: 'Your report is saved in Documents.', display: 'Saved report.pdf to ~/Documents' })
const say = await sentSince(from, e => e.item?.role === 'user')
let sentNow = await dcSent()
check(/^\[Update from your work; the user did not say this\] Your report is saved in Documents\.$/.test(text(say)) && sentNow[sentNow.indexOf(sentNow.find(e => text(e) === text(say))) + 1]?.type === 'response.create',
  `a say is spoken: ${JSON.stringify(text(say))}`)
check(say?._pc === 0 && (await pcs()).length === 1, 'a say is spoken on the warm session')
said = await butlerSays('Your report is saved.')
await emit(...said.done)
await sleep(800)
item = `in${++items}`
await emit({ type: 'input_audio_buffer.speech_started', item_id: item, audio_start_ms: 0 })
from = (await dcSent()).length
await mock.say({ speech: 'The download finished.', display: 'Download finished' })
await sleep(1500)
check(userItems((await dcSent()).slice(from)).length === 0, 'nothing is spoken while the user talks')
await emit({ type: 'input_audio_buffer.speech_stopped', item_id: item }, { type: 'input_audio_buffer.committed', item_id: item })
await transcript(item, 'Open my calendar')
await sentSince(from, isCreate)
await emit(...quietResponse()) // the reply to that turn
const spokenAfter = await sentSince(from, e => e.item?.role === 'user', 2000)
check(/^\[Update from your work; the user did not say this\] The download finished\.$/.test(text(spokenAfter)), `the say is spoken after: ${JSON.stringify(text(spokenAfter))}`)
await emit(...quietResponse())

// 6. A card is announced on the warm session, as data that says what approving does.
from = (await dcSent()).length
await mock.restart({ from: 'card', hold: true })
await mock.until('card')
const ask = await sentSince(from, e => e.item?.role === 'user')
sentNow = await dcSent()
const askIdx = sentNow.indexOf(sentNow.find(e => text(e) === text(ask)))
check(/^\[Approval needed for your own next step; the user did not say this\. Approving lets you go ahead with this:\] Run a command/.test(text(ask)), `card announced: ${JSON.stringify(text(ask))}`)
check(sentNow[askIdx + 1]?.type === 'response.create' && !sentNow[askIdx + 1]?.response?.instructions, 'announcement uses the session prompt (no instruction override)')
check((await hint()) === 'Say “yes, I approve”', `card hint: ${JSON.stringify(await hint())}`)
said = await butlerSays("I'd like to run a command. Approve?")
await page.shot('voice-speaking')
await emit(...said.done)
await sleep(800) // the card has been up for over a second

// 6a. "Approve?", its transcript arriving after the call (the reply went out without it): refused.
let since = mark()
from = (await dcSent()).length
item = await vadTurn(null)
await sentSince(from, isCreate, 4000)
let c = call('answer', { allow: true })
await emit(...c.events)
await sleep(300)
await transcript(item, 'Approve?')
let out = await outputOf(c.callId)
check(refused(since, out, 'not explicit') /* the generic reason itself ends in "Approve?" */, `"Approve?" is not approved: ${out?.error}`)
await emit(...quietResponse())
await sleep(300)
check(/Not a clear yes/.test(await hint()), 'card shows what was heard and that it did not count')
await page.shot('voice-not-counted')

// 6b. A lone "Approve." is how people ask back: refused.
since = mark()
out = await answerTurn('Approve.')
check(refused(since, out, 'not explicit', 'Approve.'), `a lone "Approve." is not approved: ${out?.error}`)
await emit(...quietResponse())

// 6c. "Pause." while a card is up answers the card (here: not at all), it does not pause.
from = (await dcSent()).length
await vadTurn('Pause.')
await sentSince(from, isCreate)
await emit(...quietResponse())
await sleep(300)
check(toCore('pause').length === 0, '"Pause." while a card is up does not pause')

// 6d. The echo rule: said over the butler voicing the approval phrase, refused.
said = await butlerSays('Say "yes, I approve" to allow it.')
since = mark()
out = await answerTurn('Yes, I approve.', { cut: said.cut })
check(refused(since, out, 'said over the butler voicing an approval', 'Yes, I approve.'), `over the butler saying the phrase is not approved: ${out?.error}`)
await emit(...quietResponse())

// 6e. Said over the butler asking "Approve?" (barge-in, the usual way): approved.
said = await butlerSays("I'd like to run a command. Approve?")
since = mark()
out = await answerTurn('Yes, I approve.', { cut: said.cut })
await waitFor(() => toCore('answer').length > since.answers).catch(() => {})
let a = toCore('answer').at(-1)
check(out?.ok === true && a?.via === 'voice' && a?.allow === true, `"Yes, I approve." over the butler asking: sends ${JSON.stringify(a)}`)
await sleep(150)
await page.shot('voice-approved')
await emit(...quietResponse())

// 7. do and status, on a new turn.
await until(async () => (await (await fetch(`${mock.base}api/state`)).json()).turn?.phase !== 'working', 5000)
c = call('do', { task: 'Also open my calendar' })
await emit(...c.events)
out = await outputOf(c.callId)
await waitFor(() => toCore('tell').length).catch(() => {})
check(out?.ok && toCore('tell')[0]?.source === 'voice' && toCore('tell')[0]?.text === 'Also open my calendar', `do sends ${JSON.stringify(toCore('tell')[0])}`)
c = call('status', {})
await emit(...c.events)
out = await outputOf(c.callId)
check(out?.turn?.phase === 'working' && typeof out?.turn?.request === 'string', `status reads the snapshot: ${JSON.stringify(out?.turn)}`)
await emit(...quietResponse())

// 8. "Stop." acts at once, with no reply.
from = (await dcSent()).length
await vadTurn('Stop.')
await waitFor(() => toCore('cancel').length).catch(() => {})
await sleep(300)
let after = (await dcSent()).slice(from)
const firstCreate = after.findIndex(isCreate), firstSay = after.findIndex(e => e.item?.role === 'user') // a say may follow
check(toCore('cancel').length === 1 && (firstCreate < 0 || (firstSay >= 0 && firstSay < firstCreate)), '"Stop." while working sends cancel, with no reply')
await sentSince(from, isCreate, 3000) // the mock still says "Got it" for that do call; let it be spoken
await emit(...quietResponse())

// 9. "Pause." with no card up: the core pauses, the page closes the session and stops the microphone.
await sleep(800)
await vadTurn('Pause.')
await waitFor(() => toCore('pause').length).catch(() => {})
check(toCore('pause').length === 1, '"Pause." with no card up sends pause')
check((await glyph('vg paused')) === 'vg paused', 'glyph: paused')
await sleep(200)
m = await mics()
check((await lastPc()).closed && (await dc('closed')) === 1 && m.every(x => x.state === 'ended') && (await posted('voice')) === false,
  'paused: the session is closed, the microphone stopped, the app told voice is off')
await page.shot('voice-paused')
const gumsAtPause = await dc('gums'), pcsAtPause = (await pcs()).length
from = (await dcSent()).length
await mock.setPaused(false) // the app's menu bar or ⌃⌥P
await until(async () => (await pcs()).length === pcsAtPause + 1 && userItems((await dcSent()).slice(from)).length > 0)
await sleep(300)
p = await lastPc()
m = await mics()
let seeded = (await dcSent()).slice(from)
check((await dc('gums')) === gumsAtPause + 1 && p.tracks[0] === m.at(-1).id && m.at(-1).state === 'live' && (await posted('voice')) === true,
  'resumed: a new session with a new microphone attached')
check(userItems(seeded).some(e => /^\[Update from your work, from earlier; the user did not say this\] Your report is saved/.test(text(e))) && !seeded.some(isCreate),
  `resumed: the new session is told what was said earlier, with no response: ${JSON.stringify(seeded.map(text))}`)

// 10. A dropped session reconnects in the background, with the same microphone.
from = (await dcSent()).length
since = page.logs.length
const before = (await pcs()).length, gumsBefore = await dc('gums'), micBefore = (await mics()).at(-1).id
await page.evaluate('window.__drop()')
t0 = Date.now()
await until(async () => (await pcs()).length === before + 1 && userItems((await dcSent()).slice(from)).length > 0, 5000)
p = await lastPc()
seeded = (await dcSent()).slice(from)
check(logged('session closed (channel closed); reconnecting', since) && !p.closed && p.tracks[0] === micBefore && (await dc('gums')) === gumsBefore,
  `after a drop: reconnected in the background in ${Date.now() - t0} ms, with the same microphone`)
check(userItems(seeded).some(e => /from earlier/.test(text(e))) && !seeded.some(isCreate), 'after a drop: the new session is told what was said earlier')
await sleep(300)
from = (await dcSent()).length
await vadTurn('Open Maps')
check((await sentSince(from, isCreate))?._pc === before, 'a turn after the drop is replied to on the new session')
await emit(...quietResponse())

// 11. A new card: "Yes, I approve." starting less than a second after it was rendered is refused;
// a second later, it approves.
await sleep(800) // quiet for a while, so the card is announced as soon as it shows
from = (await dcSent()).length
await mock.restart({ from: 'card', hold: true })
await mock.until('card')
const shown = await page.evaluate(`new Promise(r => { const t0 = Date.now(); const tick = () => { const k = document.getElementById('card'); !k.hidden && !k.classList.contains('answered') ? r(Date.now() - t0) : setTimeout(tick, 10) }; tick() })`)
await sentSince(from, e => /^\[Approval needed/.test(text(e)))
await emit(...quietResponse()) // the announcement
since = mark()
out = await answerTurn('Yes, I approve.')
check(refused(since, out, 'card too new', 'Yes, I approve.'), `an approval started within a second of the card being rendered is refused (rendered after ${shown} ms): ${out?.error}`)
await emit(...quietResponse())
await sleep(1000)
since = mark()
out = await answerTurn('Yes, I approve.')
await waitFor(() => toCore('answer').length > since.answers).catch(() => {})
a = toCore('answer').at(-1)
check(out?.ok === true && toCore('answer').length === since.answers + 1 && a?.via === 'voice' && a?.allow === true, `a VAD turn "Yes, I approve.": approved, sends ${JSON.stringify(a)}`)
await emit(...quietResponse())

// 12. Voice off: no session and no microphone.
await mock.restart({ from: 'idle', hold: true })
await mock.until('idle')
since = page.logs.length
await page.goto(`${mock.base}?backdrop=1&fakeKeyOff=1`)
await until(() => logged('voice off, captions only', since))
await sleep(400)
check((await pcs()).length === 0 && (await dc('gums')) === 0 && (await dc('keys')) === 1 && (await posted('voice')) === false,
  'a core with no voice: no session, no microphone, the key not asked for again, the app told voice is off')
await page.goto(`${mock.base}?backdrop=1&voice=0`)
await sleep(800)
check((await pcs()).length === 0 && (await dc('gums')) === 0 && (await dc('keys')) === 0 && (await posted('voice')) === false,
  '?voice=0: no session, no key, no microphone, the app told voice is off')

await page.close()
finish()
