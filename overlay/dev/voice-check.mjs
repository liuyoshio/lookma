#!/usr/bin/env node
// Headless check of the voice client (overlay/voice.js and overlay/voice/) without a microphone
// or an OpenAI key. WebRTC is replaced in the page by a fake peer connection and data channel:
// the test plays the Realtime server's events in (its VAD turns, the replies the page asked for,
// their audio) and reads what the overlay sends back. getUserMedia takes 100 ms, as a real one
// might. Chrome runs muted. Checks:
//   - the butler's session (core/voice-key.mjs): semantic VAD with medium eagerness that never
//     replies by itself; for a room far-field noise reduction and no barge-in, for a headset
//     near-field and barge-in; the max output tokens, the transcription language only when set,
//     no transcription prompt, the control and pass tools, and the per-reply parameters the key
//     carries (RESPONSES)
//   - at startup one session is connected with the microphone attached; the page never commits
//     or clears the input buffer (the server's VAD does); the talk and wake APIs are gone; the
//     capsule stays hidden while idle
//   - every committed turn gets a reply at once, with tools allowed, transcript or not; its
//     caption shows when the reply's first item that is not a pass arrives. A pass, or a reply
//     with nothing in it, deletes the turn and the call: no caption, no further reply
//   - a say comes from the mock core's outbox and is announced speak-only (tool_choice none) on
//     the warm session when nobody is talking, a user turn first; once its audio stopped the
//     core gets its receipt (delivered spoken)
//   - a card is announced the same way, as data that says what approving does, with no
//     per-response instruction override; its hint reads Say “yes, I approve”
//   - consent from VAD turn records: "Approve?" (arriving after the call) and a lone "Approve."
//     are refused; "Yes, I approve." said over the butler voicing the phrase is refused (its echo
//     would sound the same), said over the butler asking "Approve?" it approves; less than a
//     second after a new card was rendered it is refused, and after that it approves, as a request
//     with an id whose ack is the tool's output. Every refusal gives the butler the same generic
//     error, never the user's words or the cause, and every result is then said
//   - do sends {type:'tell', id, source:'voice'} and its output is the core's ack; a reply that
//     spoke gets no second one, a silent one a speak-only reply; status answers from the snapshot
//   - a transcript alone sends nothing to the core, card or not: "Stop." and "Pause." act only
//     through the butler's control call, once, and its output is the ack; paused closes the
//     session and stops the microphone; resume reopens both, and the new session is told what
//     was said earlier
//   - a dropped session reconnects in the background, with the same microphone, and an
//     announcement in flight at the drop is told and asked for again on the new session
//   - talking over an announcement: told again after a declined interrupter, settled as cut
//     after an addressed one
//   - a receipt lost with the core link is sent again from the reconnect's snapshot
//   - voice off (the core has no voice): no session and no microphone, and what is owed is
//     settled as shown; a ?voice=0 page: no session, no microphone and no receipts
//
//   node overlay/dev/voice-check.mjs [--port 8795] [--cdp 8796]

import { sleep, arg, check, waitFor, startMock, startChrome, finish } from './harness.mjs'
import { butlerSession, RESPONSES } from '../../core/voice-key.mjs'
import { ROOT } from '../../core/config.mjs'

// 0. The session the core mints (no OpenAI call: only the config it would send).
{
  const options = { model: 'gpt-realtime', voice: 'marin', transcribeModel: 'gpt-4o-transcribe', maxTokens: 200 }
  const voice = { language: '', audio: 'room', provider: { options } }
  const s = butlerSession({ root: ROOT, voice })
  const td = s.audio.input.turn_detection
  check(td?.type === 'semantic_vad' && td.eagerness === 'medium' && td.create_response === false && td.interrupt_response === false && s.audio.input.noise_reduction?.type === 'far_field',
    `session, room: semantic VAD, eagerness medium, no reply by itself, no barge-in, far_field ${JSON.stringify(s.audio.input)}`)
  check(s.max_output_tokens === 200, 'session: max output tokens 200')
  check(JSON.stringify(s.audio.input.transcription) === '{"model":"gpt-4o-transcribe"}', `session: no language unless set, no transcription prompt ${JSON.stringify(s.audio.input.transcription)}`)
  const headset = butlerSession({ root: ROOT, voice: { ...voice, audio: 'headset' } }).audio.input
  check(headset.turn_detection.interrupt_response === true && headset.noise_reduction.type === 'near_field' && headset.turn_detection.eagerness === 'medium',
    `session, headset: barge-in, near_field ${JSON.stringify(headset)}`)
  const zh = butlerSession({ root: ROOT, voice: { ...voice, language: 'zh', provider: { options: { ...options, maxTokens: 150 } } } })
  check(JSON.stringify(zh.audio.input.transcription) === '{"model":"gpt-4o-transcribe","language":"zh"}' && zh.max_output_tokens === 150,
    `session: LOOKMA_VOICE_LANGUAGE=zh goes to the transcription, max tokens configurable ${JSON.stringify(zh.audio.input.transcription)}`)
  const control = s.tools.find(t => t.name === 'control')
  check(JSON.stringify(control?.parameters.properties.action.enum) === '["stop","go_ahead","pause"]', `session: the control tool, with stop, go_ahead and pause ${JSON.stringify(control?.parameters)}`)
  const pass = s.tools.find(t => t.name === 'pass')
  check(!!pass && JSON.stringify(pass.parameters.properties) === '{}', `session: the pass tool, with no arguments ${JSON.stringify(pass?.parameters)}`)
  check(JSON.stringify(RESPONSES) === '{"turn":{},"speak":{"tool_choice":"none"}}', `key: a turn reply may call tools, every other reply is speak-only ${JSON.stringify(RESPONSES)}`)
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
      const body = keyOff ? { error: 'voice is off (LOOKMA_VOICE=off)' } : { value: 'fake', model: 'fake-realtime', expiresAt: Math.floor(Date.now() / 1000) + 600, responses: ${JSON.stringify(RESPONSES)} }
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
const isCreate = e => e.type === 'response.create'
const toCore = type => mock.fromOverlay.filter(m => m.type === type)
const requestsSince = from => mock.fromOverlay.slice(from).filter(m => ['tell', 'answer', 'control'].includes(m.type))
const hint = () => page.evaluate(`document.querySelector('#card .k-hint').textContent`)
const post = path => fetch(`${mock.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
const entryId = async speech => (await (await fetch(`${mock.base}api/state`)).json()).outbox.find(e => e.speech === speech)?.id
const receipted = (id, how) => toCore('delivered').some(m => m.how === how && m.ids.includes(id))

// The page's response.creates, taken in order: every one the page sends gets its reply here.
let consumed = 0
async function nextCreate(ms = 3000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(30)) {
    const all = (await dcSent()).filter(isCreate)
    if (all.length > consumed) return all[consumed++]
  }
  return null
}
const noCreate = async ms => { await sleep(ms); return (await dcSent()).filter(isCreate).length === consumed }
/** The item told just before a create: what an announcement says. */
async function toldBefore(create) {
  const sent = await dcSent()
  return text(sent[sent.findIndex(e => e.event_id === create?.event_id) - 1])
}

// A refusal since `since` (taken with mark() before the case): nothing reached the core,
// the butler got the generic error (not the heard words), and the page logged the cause.
const mark = () => ({ logs: page.logs.length, answers: toCore('answer').length })
function refused(since, out, why, heard) {
  return toCore('answer').length === since.answers && /^Nothing was approved\./.test(out?.error || '') && !(heard && out.error.includes(heard)) &&
    logged(`approval refused (${why})`, since.logs)
}

let n = 0
/**
 * Starts the reply to the page's latest response.create: response.created, then each output
 * item as it is added, and a spoken one starts its audio. out, in order: { say: words },
 * { call: name, args }, { pass: true }. Returns its call ids and the events that end it:
 * done (generated, then its audio played out) or cut (the user talked over it).
 */
async function start(out = []) {
  const id = `r${++n}`
  const items = out.map((o, i) => o.say != null
    ? { type: 'message', id: `${id}_m${i}`, role: 'assistant', status: 'completed', content: [] }
    : { type: 'function_call', id: `${id}_f${i}`, name: o.pass ? 'pass' : o.call, call_id: `${id}_c${i}`, arguments: JSON.stringify(o.args || {}), status: 'completed' })
  const words = out.filter(o => o.say != null).map(o => o.say).join(' ')
  await emit({ type: 'response.created', response: { id } }, ...items.map(item => ({ type: 'response.output_item.added', response_id: id, item })),
    ...(words ? [{ type: 'response.output_audio_transcript.delta', response_id: id, delta: words }, { type: 'output_audio_buffer.started', response_id: id }] : []))
  return {
    items,
    callIds: items.filter(i => i.type === 'function_call').map(i => i.call_id),
    done: [
      ...(words ? [{ type: 'response.output_audio_transcript.done', response_id: id, transcript: words }] : []),
      { type: 'response.done', response: { id, status: 'completed', output: items } },
      ...(words ? [{ type: 'output_audio_buffer.stopped', response_id: id }] : []),
    ],
    cut: [
      ...(words ? [{ type: 'output_audio_buffer.cleared', response_id: id }] : []),
      { type: 'response.done', response: { id, status: 'cancelled', output: [] } },
    ],
  }
}
/** A whole reply, played out. */
async function reply(out) {
  const r = await start(out)
  await emit(...r.done)
  return r
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
// item, then its transcript (none: words == null). `cut`: the butler's reply it interrupts.
let items = 0
async function vadTurn(words, { talkMs = 300, cut = null } = {}) {
  const item = `in${++items}`
  await emit({ type: 'input_audio_buffer.speech_started', item_id: item, audio_start_ms: 0 })
  if (cut) await emit(...cut) // a headset's interrupt_response: the server stops the butler
  await sleep(talkMs)
  await emit({ type: 'input_audio_buffer.speech_stopped', item_id: item }, { type: 'input_audio_buffer.committed', item_id: item })
  if (words != null) { await sleep(150); await transcript(item, words) }
  return item
}
/** The butler, replying to a user question, starts saying `words`. */
async function butlerSays(words) {
  await vadTurn('What is that?')
  await nextCreate()
  return start([{ say: words }])
}
/** A turn that answers the card: the butler calls answer(allow), and then says its result. */
async function answerTurn(words, opts) {
  await vadTurn(words, opts)
  await nextCreate()
  const { callIds } = await reply([{ call: 'answer', args: { allow: true } }])
  const out = await outputOf(callIds[0])
  const said = await nextCreate()
  await reply([{ say: out?.ok ? 'OK, going ahead.' : 'Nothing was approved. Approve?' }])
  return { ...out, saidAfter: said?.response?.tool_choice === 'none' }
}

// 1. Startup: one session, connected with the microphone attached.
await page.goto(`${mock.base}?backdrop=1`)
await until(() => logged('voice: connected, listening'))
await sleep(300)
let p = await lastPc()
let m = await mics()
check((await pcs()).length === 1 && p.tracks.length === 1 && p.transceivers === 0 && (await dc('gums')) === 1 && m[0]?.id === p.tracks[0] && m[0]?.state === 'live',
  `startup: one session, connected with the microphone attached ${JSON.stringify(p)}`)
check((await dcSent()).length === 0, 'startup: nothing sent (nothing owed, nothing to tell a first session)')
check((await glyph('vg off')) === 'vg off' && (await capHidden()), 'startup: the glyph still and the capsule hidden while idle')
check((await posted('voice')) === true && (await posted('listening')) === undefined, 'startup: the app is told voice is on (its menu bar icon)')
check((await page.evaluate('Object.keys(window.lookma).join()')) === 'toggleTyping', 'the talk and wake APIs are gone (talkDown, talkUp, talkCancel, wakeTalk, wakeEnd)')

// 2. A VAD turn: "Listening…" while the user talks; a reply asked for at once on commit; the
// caption once the reply takes the turn.
let from = (await dcSent()).length
let item = `in${++items}`
await emit({ type: 'input_audio_buffer.speech_started', item_id: item, audio_start_ms: 0 })
check((await glyph('vg listening')) === 'vg listening' && (await capUser()) === 'Listening…' && !(await capHidden()), 'a turn: "Listening…" and the glyph while the user talks')
await page.shot('voice-listening')
await sleep(300)
await emit({ type: 'input_audio_buffer.speech_stopped', item_id: item }, { type: 'input_audio_buffer.committed', item_id: item })
let create = await nextCreate(500)
check(!!create && JSON.stringify(create.response) === '{}' && (await glyph('vg thinking')) === 'vg thinking', `a turn: a reply is asked for on commit, before any transcript, tools allowed ${JSON.stringify(create)}`)
check(!(await typesSince(from)).some(t => t.startsWith('input_audio_buffer.')), 'the page never commits or clears the input buffer: the server VAD does')
await transcript(item, 'Abre Mapas')
await sleep(300)
check((await capUser()) !== '“Abre Mapas”', 'a turn: no caption before the reply takes it')
let said = await start([{ say: 'Abriendo Mapas.' }])
check(await until(async () => (await capUser()) === '“Abre Mapas”', 1000), 'a turn: the caption once the reply\'s first item arrives')
check((await glyph('vg speaking')) === 'vg speaking', 'glyph: speaking while the butler talks')
await emit(...said.done)
check((await glyph('vg off')) === 'vg off', 'glyph: still again once it is done')

// 3. The butler decides what was meant for it: a pass, or a reply with nothing in it, deletes the
// turn (and the pass call) from the conversation, with no caption and no further reply.
for (const [words, out] of [['', []], ['Um.', [{ pass: true }]], ['Tja', [{ pass: true }]]]) {
  from = (await dcSent()).length
  const it = await vadTurn(words)
  create = await nextCreate(1000)
  const r = await reply(out)
  await sleep(300)
  const deleted = (await dcSent()).slice(from).filter(e => e.type === 'conversation.item.delete').map(e => e.item_id)
  check(!!create && JSON.stringify(deleted) === JSON.stringify([it, ...r.items.map(i => i.id)]) && (await noCreate(300)) && (await capUser()) !== `“${words}”`,
    `${JSON.stringify(words)}: ${out.length ? 'a pass' : 'an empty reply'} deletes ${JSON.stringify(deleted)}, no caption, no further reply`)
}
from = (await dcSent()).length
await vadTurn('Open Maps')
check(!!(await nextCreate(1000)), '"Open Maps" gets a reply')
await reply([{ say: 'Opening Maps.' }])
check(!(await typesSince(from)).includes('conversation.item.delete') && (await until(async () => (await capUser()) === '“Open Maps”', 1000)), '"Open Maps": taken, shown, not deleted')

// 4. A say from the outbox is announced speak-only when nobody talks; its receipt follows its audio.
from = (await dcSent()).length
await mock.say({ speech: 'Your report is saved in Documents.', display: 'Saved report.pdf to ~/Documents' })
create = await nextCreate()
let told = await toldBefore(create)
check(/^\[Update from your work; the user did not say this\] Your report is saved in Documents\.$/.test(told), `a say is announced: ${JSON.stringify(told)}`)
check(create?.response?.tool_choice === 'none' && !create.response.instructions && create._pc === 0 && (await pcs()).length === 1, `a say is announced speak-only on the warm session ${JSON.stringify(create)}`)
let id = await entryId('Your report is saved in Documents.')
said = await start([{ say: 'Your report is saved.' }])
await emit(...said.done.slice(0, -1))
await sleep(300)
check(!toCore('delivered').some(r => r.ids.includes(id)), 'no receipt while its audio still plays')
await emit(said.done.at(-1))
check(await until(() => receipted(id, 'spoken')), `once its audio stopped: delivered ${id} spoken`)
await sleep(800)
item = `in${++items}`
await emit({ type: 'input_audio_buffer.speech_started', item_id: item, audio_start_ms: 0 })
from = (await dcSent()).length
await mock.say({ speech: 'The download finished.', display: 'Download finished' })
check((await noCreate(1500)) && userItems((await dcSent()).slice(from)).length === 0, 'nothing is announced while the user talks')
await emit({ type: 'input_audio_buffer.speech_stopped', item_id: item }, { type: 'input_audio_buffer.committed', item_id: item })
await transcript(item, 'Open my calendar')
create = await nextCreate()
check(JSON.stringify(create?.response) === '{}', 'the user\'s turn is replied to first')
await reply([{ say: 'Opening your calendar.' }])
create = await nextCreate()
told = await toldBefore(create)
check(/^\[Update from your work; the user did not say this\] The download finished\.$/.test(told) && create?.response?.tool_choice === 'none', `the say is announced after: ${JSON.stringify(told)}`)
await reply([{ say: 'The download finished.' }])

// 5. A card is announced on the warm session, as data that says what approving does.
await mock.restart({ from: 'card', hold: true })
await mock.until('card')
create = await nextCreate()
told = await toldBefore(create)
check(/^\[Approval needed for your own next step; the user did not say this\. Approving lets you go ahead with this:\] Run a command/.test(told), `card announced: ${JSON.stringify(told)}`)
check(create?.response?.tool_choice === 'none' && !create.response.instructions, 'the announcement is speak-only and uses the session prompt (no instruction override)')
check((await hint()) === 'Say “yes, I approve”', `card hint: ${JSON.stringify(await hint())}`)
said = await start([{ say: "I'd like to run a command. Approve?" }])
await page.shot('voice-speaking')
await emit(...said.done)
await sleep(800) // the card has been up for over a second

// 5a. "Approve?", its transcript arriving after the call (the reply went out without it): refused.
let since = mark()
item = await vadTurn(null)
await nextCreate()
let c = await reply([{ call: 'answer', args: { allow: true } }])
await sleep(300)
await transcript(item, 'Approve?')
let out = await outputOf(c.callIds[0])
check(refused(since, out, 'not explicit') /* the generic reason itself ends in "Approve?" */, `"Approve?" is not approved: ${out?.error}`)
create = await nextCreate()
check(create?.response?.tool_choice === 'none', 'the refusal is said in a speak-only reply')
await reply([{ say: 'Nothing was approved. Approve?' }])
await sleep(300)
check(/Not a clear yes/.test(await hint()), 'card shows what was heard and that it did not count')
await page.shot('voice-not-counted')

// 5b. A lone "Approve." is how people ask back: refused.
since = mark()
out = await answerTurn('Approve.')
check(refused(since, out, 'not explicit', 'Approve.') && out.saidAfter, `a lone "Approve." is not approved, and that is said: ${out?.error}`)

// 5c. A transcript alone sends nothing to the core, card or not: only the butler's tools do.
let toCoreFrom = mock.fromOverlay.length
await vadTurn('Pause.')
await nextCreate()
await reply([])
await sleep(300)
check(requestsSince(toCoreFrom).length === 0, '"Pause." alone, with a card up, sends nothing to the core')

// 5d. The echo rule: said over the butler voicing the approval phrase, refused.
said = await butlerSays('Say "yes, I approve" to allow it.')
since = mark()
out = await answerTurn('Yes, I approve.', { cut: said.cut })
check(refused(since, out, 'said over the butler voicing an approval', 'Yes, I approve.'), `over the butler saying the phrase is not approved: ${out?.error}`)

// 5e. Said over the butler asking "Approve?" (barge-in, the usual way): approved.
said = await butlerSays("I'd like to run a command. Approve?")
since = mark()
out = await answerTurn('Yes, I approve.', { cut: said.cut })
let a = toCore('answer').at(-1)
check(out?.ok === true && out.answered === 'approved' && out.saidAfter && toCore('answer').length === since.answers + 1 && a?.via === 'voice' && a?.allow === true && !!a?.id,
  `"Yes, I approve." over the butler asking: sends ${JSON.stringify(a)}; output ${JSON.stringify(out)}`)
await sleep(150)
await page.shot('voice-approved')

// 6. do and status, while the scenario's turn is still working (it holds after the card): the
// tell steers it, and the ack says so. A do the butler said nothing about gets a speak-only
// reply for its result; one it spoke about does not.
await vadTurn('Also open my calendar')
await nextCreate()
c = await reply([{ call: 'do', args: { task: 'Also open my calendar' } }])
out = await outputOf(c.callIds[0])
const tell = toCore('tell')[0]
check(tell?.source === 'voice' && tell?.text === 'Also open my calendar' && !!tell?.id, `do sends ${JSON.stringify(tell)}`)
check(JSON.stringify(out) === '{"ok":true,"state":"added"}', `do: its output is the core's ack ${JSON.stringify(out)}`)
create = await nextCreate()
check(create?.response?.tool_choice === 'none', 'a silent do: its result gets a speak-only reply')
await reply([{ say: "I'll open your calendar too." }])
await vadTurn('And open Notes')
await nextCreate()
c = await reply([{ say: 'Opening Notes too.' }, { call: 'do', args: { task: 'And open Notes' } }])
out = await outputOf(c.callIds[0])
check(out?.ok === true && (await noCreate(800)), `a do the butler spoke about: no second reply ${JSON.stringify(out)}`)
await vadTurn('How is it going?')
await nextCreate()
c = await reply([{ call: 'status' }])
out = await outputOf(c.callIds[0])
check(out?.turn?.phase === 'working' && typeof out?.turn?.request === 'string' && Array.isArray(out?.unsaid), `status reads the snapshot: ${JSON.stringify(out?.turn)}`)
create = await nextCreate()
check(create?.response?.tool_choice === 'none', 'status: its result gets a speak-only reply')
await reply([{ say: 'Still on it.' }])

// 7. "Stop." is the butler's: the transcript sends nothing, its control(stop) call sends one
// control request, and the output is the ack, said in a speak-only reply.
toCoreFrom = mock.fromOverlay.length
await vadTurn('Stop.')
await nextCreate()
const heardOnly = requestsSince(toCoreFrom).length === 0
c = await reply([{ call: 'control', args: { action: 'stop' } }])
out = await outputOf(c.callIds[0])
const stops = toCore('control').filter(m => m.action === 'stop')
check(heardOnly && stops.length === 1 && !!stops[0].id && JSON.stringify(out) === '{"ok":true}', `"Stop.": only the control(stop) call reaches the core, once; output ${JSON.stringify(out)}`)
create = await nextCreate()
check(create?.response?.tool_choice === 'none', '"Stop.": the result is said in a speak-only reply')
await reply([{ say: 'Stopped.' }])

// 8. "Pause." with no card up, through control(pause): the core pauses, the page closes the
// session and stops the microphone.
await sleep(800)
await vadTurn('Pause.')
await nextCreate()
await reply([{ call: 'control', args: { action: 'pause' } }])
await waitFor(() => toCore('control').some(m => m.action === 'pause')).catch(() => {})
check(toCore('control').filter(m => m.action === 'pause').length === 1 && toCore('pause').length === 0, '"Pause." with no card up: its control(pause) call sends control pause')
await nextCreate(1000) // the ack comes before the paused snapshot: the reply asked for to say it dies with the session
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

// 9. A dropped session reconnects in the background, with the same microphone; an announcement
// in flight at the drop is told and asked for again on the new session.
await sleep(800)
await mock.say({ speech: 'The upload finished.', display: 'Upload finished' })
await nextCreate()
await start([{ say: 'The upload finished.' }])
from = (await dcSent()).length
since = page.logs.length
const before = (await pcs()).length, gumsBefore = await dc('gums'), micBefore = (await mics()).at(-1).id
await page.evaluate('window.__drop()')
let t0 = Date.now()
await until(async () => (await pcs()).length === before + 1 && userItems((await dcSent()).slice(from)).length > 0, 5000)
p = await lastPc()
seeded = (await dcSent()).slice(from)
check(logged('session closed (channel closed); reconnecting', since) && !p.closed && p.tracks[0] === micBefore && (await dc('gums')) === gumsBefore,
  `after a drop: reconnected in the background in ${Date.now() - t0} ms, with the same microphone`)
check(userItems(seeded).some(e => /from earlier/.test(text(e))) && !seeded.some(isCreate), 'after a drop: the new session is told what was said earlier')
create = await nextCreate()
told = await toldBefore(create)
check(create?._pc === before && /^\[Update from your work; the user did not say this\] The upload finished\.$/.test(told), `after a drop: the announcement cut by it is told and asked for again ${JSON.stringify(told)}`)
await reply([{ say: 'The upload finished.' }])
await sleep(300)
await vadTurn('Open Maps')
check((await nextCreate())?._pc === before, 'a turn after the drop is replied to on the new session')
await reply([{ say: 'Opening Maps.' }])

// 10. A new card: "Yes, I approve." starting less than a second after it was rendered is refused;
// a second later, it approves.
await sleep(800) // quiet for a while, so the card is announced as soon as it shows
await mock.restart({ from: 'card', hold: true })
await mock.until('card')
const shown = await page.evaluate(`new Promise(r => { const t0 = Date.now(); const tick = () => { const k = document.getElementById('card'); !k.hidden && !k.classList.contains('answered') ? r(Date.now() - t0) : setTimeout(tick, 10) }; tick() })`)
create = await nextCreate()
check(/^\[Approval needed/.test(await toldBefore(create)), 'the new card is announced')
await reply([{ say: 'Approve?' }])
since = mark()
out = await answerTurn('Yes, I approve.')
check(refused(since, out, 'card too new', 'Yes, I approve.'), `an approval started within a second of the card being rendered is refused (rendered after ${shown} ms): ${out?.error}`)
await sleep(1000)
since = mark()
out = await answerTurn('Yes, I approve.')
a = toCore('answer').at(-1)
check(out?.ok === true && out.answered === 'approved' && toCore('answer').length === since.answers + 1 && a?.via === 'voice' && a?.allow === true && !!a?.id,
  `a VAD turn "Yes, I approve.": approved, sends ${JSON.stringify(a)}`)

// 11. Talking over an announcement (the server cancels it): after a declined interrupter it is
// told again; after an addressed one it is settled as cut, and not told again.
await sleep(800)
await mock.say({ speech: 'The backup finished.', display: 'Backup finished' })
await nextCreate()
said = await start([{ say: 'The backup finished.' }])
await vadTurn('', { cut: said.cut })
await nextCreate()
await reply([{ pass: true }])
create = await nextCreate()
check(/\] The backup finished\.$/.test(await toldBefore(create)) && create?.response?.tool_choice === 'none', 'cut by noise the butler passed on: told again')
await reply([{ say: 'The backup finished.' }])
id = await entryId('The backup finished.')
check(await until(() => receipted(id, 'spoken')), `then heard: delivered ${id} spoken`)
await sleep(800)
await mock.say({ speech: 'Your build failed.', display: 'Build failed' })
await nextCreate()
said = await start([{ say: 'Your build failed.' }])
await vadTurn('Open the log', { cut: said.cut })
await nextCreate()
await reply([{ say: 'Opening the log.' }])
id = await entryId('Your build failed.')
check((await until(() => receipted(id, 'cut'))) && (await noCreate(1500)), `cut by the user taking the floor: delivered ${id} cut, not told again`)

// 12. A receipt lost with the core link: the reconnect's snapshot still shows the entry owed,
// and the page sends the receipt again.
await mock.say({ speech: 'The export finished.', display: 'Export finished' })
await nextCreate()
said = await start([{ say: 'The export finished.' }])
await emit(...said.done.slice(0, -1))
id = await entryId('The export finished.')
await post('dev/drop')
await sleep(150)
await emit(said.done.at(-1)) // heard, while the link to the core is down
await sleep(100)
const lostThen = !receipted(id, 'spoken')
check(lostThen && (await until(() => receipted(id, 'spoken'))) && (await noCreate(300)), `a receipt lost with the link is sent again after the reconnect (${id}), with no new announcement`)

// 13. Voice off: no session and no microphone, and what is owed is settled as shown.
await mock.restart({ from: 'idle', hold: true })
await mock.until('idle')
since = page.logs.length
await page.goto(`${mock.base}?backdrop=1&fakeKeyOff=1`)
await until(() => logged('voice off, captions only', since))
await sleep(400)
check((await pcs()).length === 0 && (await dc('gums')) === 0 && (await dc('keys')) === 1 && (await posted('voice')) === false,
  'a core with no voice: no session, no microphone, the key not asked for again, the app told voice is off')
await mock.say({ speech: 'Left on screen.' })
id = await entryId('Left on screen.')
check(await until(() => receipted(id, 'shown')), `a core with no voice: what is owed is delivered ${id} shown`)
await page.goto(`${mock.base}?backdrop=1&voice=0`)
await sleep(800)
check((await pcs()).length === 0 && (await dc('gums')) === 0 && (await dc('keys')) === 0 && (await posted('voice')) === false,
  '?voice=0: no session, no key, no microphone, the app told voice is off')
await mock.say({ speech: 'Not for a spectator.' })
id = await entryId('Not for a spectator.')
await sleep(800)
check(!!id && !toCore('delivered').some(m => m.ids.includes(id)), `?voice=0: a spectator sends no receipts (${id} still owed)`)

await page.close()
finish()
