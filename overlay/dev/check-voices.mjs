#!/usr/bin/env node
// Headless check of the voice client (overlay/voice.js and overlay/voice/) with every installed
// voice provider in turn, each against its own fake service (voices/<name>/dev/fake.mjs), without
// a microphone or a network. The page gets its grant from a fake POST /api/voice/grant and
// imports the provider's real page.js; the fake stands in for the service behind it. The test
// plays voice events in (turns, the replies the page asked for, their audio), as the service
// would send them, and reads the effects the page sends back. getUserMedia takes 100 ms, as a
// real one might. Chrome runs muted. Checks:
//   - at startup one session is connected, hearing nothing until the turn source's listen puts
//     the microphone on it; the page sends no service message but the reply effects (turn
//     detection is the provider's); the talk and wake APIs are gone; the capsule stays hidden
//     while idle
//   - every committed turn gets a reply at once, with tools allowed, transcript or not; its
//     caption shows when the reply's first item that is not a pass arrives. A pass, or a reply
//     with nothing in it, drops the turn and the call: no caption, no further reply
//   - a say comes from the mock core's outbox and is announced speak-only on the warm session
//     when nobody is talking, a user turn first; once its audio stopped the core gets its
//     receipt (delivered spoken)
//   - a card is announced the same way, as data that says what approving does, with nothing
//     added to the reply's parameters; its hint reads Say “yes, I approve”
//   - consent from turn records: "Approve?" (arriving after the call) and a lone "Approve."
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
//   - a dropped session reconnects in the background; the microphone is closed while no session
//     is live and a new one is put on the new session; an announcement in flight at the drop is
//     told and asked for again on the new session
//   - talking over an announcement: told again after a declined interrupter, settled as cut
//     after an addressed one
//   - a receipt lost with the core link is sent again from the reconnect's snapshot
//   - a microphone that cannot open: the session stays up with nothing on it, and the capsule
//     says Lookma has no microphone access
//   - voice off (the core has no voice): no session and no microphone, and what is owed is
//     settled as shown; a ?voice=0 page: no session, no microphone and no receipts
// The provider's own checks (what it asks its service for) are its dev/check.mjs.
//
//   node overlay/dev/check-voices.mjs [--port 8795] [--cdp 8796]

import { sleep, arg, check, waitFor, startMock, startChrome, finish } from './harness.mjs'
import { list } from '../../core/plugins.mjs'

const PORT = Number(arg('--port', 8795)), CDP = Number(arg('--cdp', 8796))
const mock = startMock({ port: PORT })
const page = await startChrome({ port: CDP })
for (const name of list('voices')) await scenario(name, await import(`../../voices/${name}/dev/fake.mjs`))
await page.close()
finish()

async function scenario(name, fake) {
  console.log(`\nvoice provider ${name}`)
  const base = { overlay: mock.fromOverlay.length, logs: page.logs.length }
  // Hold the core at the very start, with nothing to say, before the page connects.
  await sleep(400)
  await mock.restart({ from: 'idle', hold: true })
  await mock.until('idle')

  // The core's grant and the microphone, for every provider; then the provider's fake service.
  const scripts = [await page.beforeLoad(`{
    window.__voice = { mics: [], gums: 0, grants: 0 }
    window.__posts = []
    window.webkit = { messageHandlers: { lookma: { postMessage: m => window.__posts.push(m) } } } // the app
    const grantOff = location.search.includes('fakeGrantOff=1') // a core with no voice
    const noMic = location.search.includes('fakeNoMic=1') // microphone permission refused
    const fetchBefore = window.fetch.bind(window)
    window.fetch = (url, opts) => {
      if (!String(url).endsWith('/api/voice/grant')) return fetchBefore(url, opts)
      window.__voice.grants++
      const body = grantOff ? { error: 'voice is off (LOOKMA_VOICE=off)' } : { provider: ${JSON.stringify(name)}, startBy: Date.now() + 600000, ...${JSON.stringify(fake.grant)} }
      return Promise.resolve(new Response(JSON.stringify(body), { status: grantOff ? 503 : 200, headers: { 'Content-Type': 'application/json' } }))
    }
    navigator.mediaDevices.getUserMedia = async () => {
      window.__voice.gums++
      await new Promise(r => setTimeout(r, 100)) // a real microphone takes a moment to start
      if (noMic) throw new DOMException('Permission denied', 'NotAllowedError')
      const stream = new AudioContext().createMediaStreamDestination().stream
      window.__voice.mics.push(stream)
      return stream
    }
    window.__mics = () => window.__voice.mics.map(m => ({ id: m.getAudioTracks()[0].id, state: m.getAudioTracks()[0].readyState }))
  }`), await page.beforeLoad(fake.page)]

  const emit = (...events) => page.evaluate(`window.__fake.emit(${JSON.stringify(events.flatMap(fake.toService))})`)
  const voice = key => page.evaluate(`window.__voice.${key}`)
  const sent = async () => (await page.evaluate('window.__fake.sent')).map(fake.fromService)
  const connections = () => page.evaluate('window.__fake.connections')
  const lastConnection = async () => (await connections()).at(-1)
  const closed = async () => (await connections()).filter(c => c.closed).length
  const mics = () => page.evaluate('window.__mics()')
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
  const logged = (text, since = base.logs) => page.logs.slice(since).some(l => l.includes(text))
  const told = e => (e?.type === 'tell' ? e.texts[0] : '')
  const tells = effects => effects.filter(e => e.type === 'tell')
  const isCreate = e => e.type === 'create'
  const toCore = type => mock.fromOverlay.slice(base.overlay).filter(m => m.type === type)
  const requestsSince = from => mock.fromOverlay.slice(from).filter(m => ['tell', 'answer', 'control'].includes(m.type))
  const hint = () => page.evaluate(`document.querySelector('#card .k-hint').textContent`)
  const post = path => fetch(`${mock.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  const entryId = async speech => (await (await fetch(`${mock.base}api/state`)).json()).outbox.find(e => e.speech === speech)?.id
  const receipted = (id, how) => toCore('delivered').some(m => m.how === how && m.ids.includes(id))

  // The page's creates, taken in order: every one the page sends gets its reply here.
  let consumed = 0
  async function nextCreate(ms = 3000) {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(30)) {
      const all = (await sent()).filter(isCreate)
      if (all.length > consumed) return all[consumed++]
    }
    return null
  }
  const noCreate = async ms => { await sleep(ms); return (await sent()).filter(isCreate).length === consumed }
  /** The text told just before a create: what an announcement says. */
  async function toldBefore(create) {
    const effects = await sent()
    return told(effects[effects.findIndex(e => isCreate(e) && e.eventId === create?.eventId) - 1])
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
   * Starts the reply to the page's latest create: response.started, then each output item as it
   * is added, and a spoken one starts its audio. out, in order: { say: words },
   * { call: name, args }, { pass: true }. Returns its items, its call ids and the events that end
   * it: done (generated, then its audio played out) or cut (the user talked over it).
   */
  async function start(out = []) {
    const id = `r${++n}`
    const items = out.map((o, i) => o.say != null ? { kind: 'message', id: `${id}_m${i}` }
      : o.pass ? { kind: 'pass', id: `${id}_f${i}` }
      : { kind: 'call', id: `${id}_f${i}`, callId: `${id}_c${i}`, name: o.call, args: o.args || {}, complete: true })
    const words = out.filter(o => o.say != null).map(o => o.say).join(' ')
    await emit({ type: 'response.started', response: id }, ...items.map(item => ({ type: 'response.item', response: id, item })),
      ...(words ? [{ type: 'butler.said', response: id, text: words, final: false }, { type: 'audio.started', response: id }] : []))
    return {
      items,
      callIds: items.filter(i => i.kind === 'call').map(i => i.callId),
      done: [
        ...(words ? [{ type: 'butler.said', response: id, text: words, final: true }] : []),
        { type: 'response.done', response: id, status: 'completed', items },
        ...(words ? [{ type: 'audio.stopped', response: id }] : []),
      ],
      cut: [
        ...(words ? [{ type: 'audio.cleared', response: id }] : []),
        { type: 'response.done', response: id, status: 'cancelled', items: [] },
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
      const out = (await sent()).find(e => e.type === 'output' && e.results[0].callId === callId)
      if (out) return out.results[0].output
      await sleep(100)
    }
    return null
  }
  const transcript = (turn, words) => emit({ type: 'turn.transcript', id: turn, text: words })

  // One user turn as the provider reports it: speech starts, stops, the turn is committed, then
  // its transcript (none: words == null). `cut`: the butler's reply it interrupts.
  let turns = 0
  async function vadTurn(words, { talkMs = 300, cut = null } = {}) {
    const turn = `in${++turns}`
    await emit({ type: 'turn.started', id: turn })
    if (cut) await emit(...cut) // a headset's barge-in: the service stops the butler
    await sleep(talkMs)
    await emit({ type: 'turn.stopped', id: turn }, { type: 'turn.committed', id: turn })
    if (words != null) { await sleep(150); await transcript(turn, words) }
    return turn
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
    return { ...out, saidAfter: said?.kind === 'speak' }
  }

  // 1. Startup: one session, connected, then the microphone put on it.
  await page.goto(`${mock.base}?backdrop=1`)
  await until(() => logged('voice: connected ('))
  await sleep(300)
  let c0 = await lastConnection()
  let m = await mics()
  check((await connections()).length === 1 && c0.tracks.length === 1 && (await voice('gums')) === 1 && m[0]?.id === c0.tracks[0] && m[0]?.state === 'live',
    `startup: one session, connected, the microphone then put on its sender ${JSON.stringify(c0)}`)
  check((await sent()).length === 0, 'startup: nothing sent (nothing owed, nothing to tell a first session)')
  check((await glyph('vg off')) === 'vg off' && (await capHidden()), 'startup: the glyph still and the capsule hidden while idle')
  check((await posted('voice')) === true && (await posted('listening')) === undefined, 'startup: the app is told voice is on (its menu bar icon)')
  check((await page.evaluate('Object.keys(window.lookma).join()')) === 'toggleTyping', 'the talk and wake APIs are gone (talkDown, talkUp, talkCancel, wakeTalk, wakeEnd)')

  // 2. A turn: "Listening…" while the user talks; a reply asked for at once on commit; the
  // caption once the reply takes the turn.
  let from = (await sent()).length
  let turn = `in${++turns}`
  await emit({ type: 'turn.started', id: turn })
  check((await glyph('vg listening')) === 'vg listening' && (await capUser()) === 'Listening…' && !(await capHidden()), 'a turn: "Listening…" and the glyph while the user talks')
  await page.shot('voice-listening')
  await sleep(300)
  await emit({ type: 'turn.stopped', id: turn }, { type: 'turn.committed', id: turn })
  let create = await nextCreate(500)
  check(create?.kind === 'turn' && (await glyph('vg thinking')) === 'vg thinking', `a turn: a reply is asked for on commit, before any transcript, tools allowed ${JSON.stringify(create)}`)
  check(!(await sent()).slice(from).some(e => e.type === 'other'), 'the page sends no service message but the reply effects: turn detection is the provider\'s')
  await transcript(turn, 'Abre Mapas')
  await sleep(300)
  check((await capUser()) !== '“Abre Mapas”', 'a turn: no caption before the reply takes it')
  let said = await start([{ say: 'Abriendo Mapas.' }])
  check(await until(async () => (await capUser()) === '“Abre Mapas”', 1000), 'a turn: the caption once the reply\'s first item arrives')
  check((await glyph('vg speaking')) === 'vg speaking', 'glyph: speaking while the butler talks')
  await emit(...said.done)
  check((await glyph('vg off')) === 'vg off', 'glyph: still again once it is done')

  // 3. The butler decides what was meant for it: a pass, or a reply with nothing in it, drops the
  // turn (and the pass call) from the conversation, with no caption and no further reply.
  for (const [words, out] of [['', []], ['Um.', [{ pass: true }]], ['Tja', [{ pass: true }]]]) {
    from = (await sent()).length
    const it = await vadTurn(words)
    create = await nextCreate(1000)
    const r = await reply(out)
    await sleep(300)
    const dropped = (await sent()).slice(from).filter(e => e.type === 'drop').flatMap(e => e.items)
    check(!!create && JSON.stringify(dropped) === JSON.stringify([it, ...r.items.map(i => i.id)]) && (await noCreate(300)) && (await capUser()) !== `“${words}”`,
      `${JSON.stringify(words)}: ${out.length ? 'a pass' : 'an empty reply'} drops ${JSON.stringify(dropped)}, no caption, no further reply`)
  }
  from = (await sent()).length
  await vadTurn('Open Maps')
  check(!!(await nextCreate(1000)), '"Open Maps" gets a reply')
  await reply([{ say: 'Opening Maps.' }])
  check(!(await sent()).slice(from).some(e => e.type === 'drop') && (await until(async () => (await capUser()) === '“Open Maps”', 1000)), '"Open Maps": taken, shown, not dropped')

  // 4. A say from the outbox is announced speak-only when nobody talks; its receipt follows its audio.
  from = (await sent()).length
  await mock.say({ speech: 'Your report is saved in Documents.', display: 'Saved report.pdf to ~/Documents' })
  create = await nextCreate()
  let text = await toldBefore(create)
  check(/^\[Update from your work; the user did not say this\] Your report is saved in Documents\.$/.test(text), `a say is announced: ${JSON.stringify(text)}`)
  check(create?.kind === 'speak' && create.connection === 0 && (await connections()).length === 1, `a say is announced speak-only on the warm session ${JSON.stringify(create)}`)
  let id = await entryId('Your report is saved in Documents.')
  said = await start([{ say: 'Your report is saved.' }])
  await emit(...said.done.slice(0, -1))
  await sleep(300)
  check(!toCore('delivered').some(r => r.ids.includes(id)), 'no receipt while its audio still plays')
  await emit(said.done.at(-1))
  check(await until(() => receipted(id, 'spoken')), `once its audio stopped: delivered ${id} spoken`)
  await sleep(800)
  turn = `in${++turns}`
  await emit({ type: 'turn.started', id: turn })
  from = (await sent()).length
  await mock.say({ speech: 'The download finished.', display: 'Download finished' })
  check((await noCreate(1500)) && tells((await sent()).slice(from)).length === 0, 'nothing is announced while the user talks')
  await emit({ type: 'turn.stopped', id: turn }, { type: 'turn.committed', id: turn })
  await transcript(turn, 'Open my calendar')
  create = await nextCreate()
  check(create?.kind === 'turn', 'the user\'s turn is replied to first')
  await reply([{ say: 'Opening your calendar.' }])
  create = await nextCreate()
  text = await toldBefore(create)
  check(/^\[Update from your work; the user did not say this\] The download finished\.$/.test(text) && create?.kind === 'speak', `the say is announced after: ${JSON.stringify(text)}`)
  await reply([{ say: 'The download finished.' }])

  // 5. A card is announced on the warm session, as data that says what approving does.
  await mock.restart({ from: 'card', hold: true })
  await mock.until('card')
  create = await nextCreate()
  text = await toldBefore(create)
  check(/^\[Approval needed for your own next step; the user did not say this\. Approving lets you go ahead with this:\] Run a command/.test(text), `card announced: ${JSON.stringify(text)}`)
  check(create?.kind === 'speak', 'the announcement is speak-only, with nothing added to the reply (no instruction override)')
  check((await hint()) === 'Say “yes, I approve”', `card hint: ${JSON.stringify(await hint())}`)
  said = await start([{ say: "I'd like to run a command. Approve?" }])
  await page.shot('voice-speaking')
  await emit(...said.done)
  await sleep(800) // the card has been up for over a second

  // 5a. "Approve?", its transcript arriving after the call (the reply went out without it): refused.
  let since = mark()
  turn = await vadTurn(null)
  await nextCreate()
  let c = await reply([{ call: 'answer', args: { allow: true } }])
  await sleep(300)
  await transcript(turn, 'Approve?')
  let out = await outputOf(c.callIds[0])
  check(refused(since, out, 'not explicit') /* the generic reason itself ends in "Approve?" */, `"Approve?" is not approved: ${out?.error}`)
  create = await nextCreate()
  check(create?.kind === 'speak', 'the refusal is said in a speak-only reply')
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
  check(create?.kind === 'speak', 'a silent do: its result gets a speak-only reply')
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
  check(create?.kind === 'speak', 'status: its result gets a speak-only reply')
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
  check(create?.kind === 'speak', '"Stop.": the result is said in a speak-only reply')
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
  check((await lastConnection()).closed && (await closed()) === 1 && m.every(x => x.state === 'ended') && (await posted('voice')) === false,
    'paused: the session is closed, the microphone stopped, the app told voice is off')
  await page.shot('voice-paused')
  const gumsAtPause = await voice('gums'), connectionsAtPause = (await connections()).length
  from = (await sent()).length
  await mock.setPaused(false) // the app's menu bar or ⌃⌥P
  await until(async () => (await connections()).length === connectionsAtPause + 1 && tells((await sent()).slice(from)).length > 0)
  await sleep(300)
  c0 = await lastConnection()
  m = await mics()
  let seeded = (await sent()).slice(from)
  check((await voice('gums')) === gumsAtPause + 1 && c0.tracks[0] === m.at(-1).id && m.at(-1).state === 'live' && (await posted('voice')) === true,
    'resumed: a new session with a new microphone attached')
  check(tells(seeded).some(e => /^\[Update from your work, from earlier; the user did not say this\] Your report is saved/.test(told(e))) && !seeded.some(isCreate),
    `resumed: the new session is told what was said earlier, with no reply: ${JSON.stringify(seeded.map(told))}`)

  // 9. A dropped session reconnects in the background, with a new microphone (none is open while
  // no session is live); an announcement in flight at the drop is told and asked for again on
  // the new session.
  await sleep(800)
  await mock.say({ speech: 'The upload finished.', display: 'Upload finished' })
  await nextCreate()
  await start([{ say: 'The upload finished.' }])
  from = (await sent()).length
  since = page.logs.length
  const before = (await connections()).length, gumsBefore = await voice('gums'), micBefore = (await mics()).at(-1).id
  await page.evaluate('window.__fake.drop()')
  const t0 = Date.now()
  await until(async () => (await connections()).length === before + 1 && tells((await sent()).slice(from)).length > 0, 5000)
  c0 = await lastConnection()
  seeded = (await sent()).slice(from)
  await until(async () => (await voice('gums')) === gumsBefore + 1 && (await lastConnection()).tracks.length === 1)
  c0 = await lastConnection()
  m = await mics()
  check(logged('; reconnecting', since) && !c0.closed && c0.tracks[0] === m.at(-1).id && m.at(-1).id !== micBefore && m.every((x, i) => x.state === (i === m.length - 1 ? 'live' : 'ended')),
    `after a drop: reconnected in the background in ${Date.now() - t0} ms; the old microphone stopped, a new one on the new session`)
  check(tells(seeded).some(e => /from earlier/.test(told(e))) && !seeded.some(isCreate), 'after a drop: the new session is told what was said earlier')
  create = await nextCreate()
  text = await toldBefore(create)
  check(create?.connection === before && /^\[Update from your work; the user did not say this\] The upload finished\.$/.test(text), `after a drop: the announcement cut by it is told and asked for again ${JSON.stringify(text)}`)
  await reply([{ say: 'The upload finished.' }])
  await sleep(300)
  await vadTurn('Open Maps')
  check((await nextCreate())?.connection === before, 'a turn after the drop is replied to on the new session')
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
    `a turn "Yes, I approve.": approved, sends ${JSON.stringify(a)}`)

  // 11. Talking over an announcement (the service cancels it): after a declined interrupter it is
  // told again; after an addressed one it is settled as cut, and not told again.
  await sleep(800)
  await mock.say({ speech: 'The backup finished.', display: 'Backup finished' })
  await nextCreate()
  said = await start([{ say: 'The backup finished.' }])
  await vadTurn('', { cut: said.cut })
  await nextCreate()
  await reply([{ pass: true }])
  create = await nextCreate()
  check(/\] The backup finished\.$/.test(await toldBefore(create)) && create?.kind === 'speak', 'cut by noise the butler passed on: told again')
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

  // 13. A microphone that cannot open: the session stays up, nothing on its sender, and a notice.
  since = page.logs.length
  await page.goto(`${mock.base}?backdrop=1&fakeNoMic=1`)
  await until(() => logged('voice: the microphone did not open', since))
  await sleep(200)
  c0 = await lastConnection()
  const saidLine = await page.evaluate(`document.getElementById('cap').textContent`)
  check(!c0.closed && c0.tracks.length === 0 && (await voice('gums')) === 1 && saidLine.includes('Lookma has no microphone access'),
    `no microphone: the session stays up with no track, and the capsule says so ${JSON.stringify(c0)}`)

  // 14. Voice off: no session and no microphone, and what is owed is settled as shown.
  await mock.restart({ from: 'idle', hold: true })
  await mock.until('idle')
  since = page.logs.length
  await page.goto(`${mock.base}?backdrop=1&fakeGrantOff=1`)
  await until(() => logged('voice off, captions only', since))
  await sleep(400)
  check((await connections()).length === 0 && (await voice('gums')) === 0 && (await voice('grants')) === 1 && (await posted('voice')) === false,
    'a core with no voice: no session, no microphone, the grant not asked for again, the app told voice is off')
  await mock.say({ speech: 'Left on screen.' })
  id = await entryId('Left on screen.')
  check(await until(() => receipted(id, 'shown')), `a core with no voice: what is owed is delivered ${id} shown`)
  await page.goto(`${mock.base}?backdrop=1&voice=0`)
  await sleep(800)
  check((await connections()).length === 0 && (await voice('gums')) === 0 && (await voice('grants')) === 0 && (await posted('voice')) === false,
    '?voice=0: no session, no grant, no microphone, the app told voice is off')
  await mock.say({ speech: 'Not for a spectator.' })
  id = await entryId('Not for a spectator.')
  await sleep(800)
  check(!!id && !toCore('delivered').some(m => m.ids.includes(id)), `?voice=0: a spectator sends no receipts (${id} still owed)`)

  for (const { identifier } of scripts) await page.cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier })
}
