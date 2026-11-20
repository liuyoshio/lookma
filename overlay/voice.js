// The realtime voice client: the "butler". The overlay talks to OpenAI Realtime over
// WebRTC with a short-lived key from the core (POST /api/voice-key), which already
// carries the butler's instructions, tools and turn detection (core/voice-key.mjs). To the
// user the butler is the one doing the work; its tools are framed that way:
//   do     - start what the user asked for (the core hands it to the executor)
//   status - read progress from the latest snapshot
//   answer - answer the card on screen (the oldest), checked here by judgeAnswer() first
//
// Always listening, full duplex, on one warm session:
//   - While voice is on and not paused, one session is connected with the microphone attached
//     (macOS shows its mic indicator). The server's VAD finds each turn; the user just talks,
//     and talking over the butler stops it (the server interrupts the response).
//   - The server does not answer by itself. A turn gets a reply (response.create) only when its
//     transcript is worth answering (worthAnswering in consent.js): silence, hesitation and noise
//     fragments are dropped from the conversation. A transcript not in by TURN_WAIT_MS is
//     answered anyway. "stop", "go ahead" and "pause" act at once (commandFor) and need no reply.
//   - The session reconnects when it closes or fails, and is renewed while idle before the
//     Realtime session limit, with its key minted ahead. The microphone stays open across both.
//   - Paused: no session and no microphone. Voice off (?voice=0, or the core has no voice): no
//     session and no microphone, captions only.
//
// Messages from the executor (say), finished background tasks (report) and cards as they
// are rendered are queued and spoken on the warm session when nobody is talking. They go in
// as marked data (plain user messages); the session instructions (prompts/butler.md) say what
// to do with them, and are never overridden per response, so the approval policy always
// applies. A session that replaces a lost one is first told the pending cards and what was
// said lately (CONTEXT_MS), as items with no response.
//
// The approval check (judgeAnswer) gets the user turn behind each answer() call, from the VAD:
// when its speech started (speech_started's arrival), whether the butler's audio was playing
// then and what that response said, and its own transcript, matched by item id.

import { judgeAnswer, commandFor, worthAnswering, TRANSCRIPT_WAIT_MS, TURN_WAIT_MS } from './consent.js'

const REALTIME_URL = 'https://api.openai.com/v1/realtime/calls'
const MIC = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
const QUIET_MS = 700           // the butler speaks up after this long with nobody talking
const CONNECT_MS = 15000       // a session not up after this long is given up and tried again
const RENEW_MS = 50 * 60000    // a new session, while idle, before the Realtime limit of 60 min
const RENEW_IDLE_MS = 10000    // idle: nothing said or heard for this long
const KEY_AHEAD_MS = 60000     // the renewal's key is minted this long before it
const KEY_MARGIN_MS = 15000    // a key minted ahead is used only with this long left
const RETRY_MS = [1000, 2000, 5000, 15000, 30000, 60000] // reconnecting, after each failure in a row
const STABLE_MS = 60000        // a session that lasted this long resets the backoff
const CONTEXT_MS = 5 * 60000   // a new session is told what was said in this window
const URGENT = new Set(['card', 'question', 'confirm'])

/**
 * @param {object} o
 * @param {boolean} o.enabled                false: captions only (?voice=0)
 * @param {() => object} o.getState          latest core snapshot
 * @param {(msg: object) => boolean} o.send  overlay -> core
 * @param {(id: string) => number} o.cardShownAt  when the overlay rendered the card (Infinity: not yet)
 * @param {(id: string, allow: boolean, via: string) => void} o.answerCard
 * @param {(v: { glyph: string, hearing: boolean, available: boolean }) => void} o.onVoice
 *        glyph: off | listening | thinking | speaking; hearing: the user is talking now;
 *        available: voice is on, not paused, and not failing
 * @param {(text: string) => void} o.onUser    a user turn worth answering, as heard
 * @param {(heard: object) => void} o.onHeard  an utterance that did not count as an answer
 * @param {(msg: string) => void} o.log
 */
export function createVoice(o) {
  let s = null           // the warm session: { pc, dc, audio, ready, openedAt }
  let mic = null         // the microphone (a promise of its stream), open while voice is on and not paused
  let off = !o.enabled   // for good: ?voice=0, or the core has no voice (LOOKMA_NO_VOICE, no key)
  let paused = true      // until the core's first snapshot says otherwise
  let failing = false    // the last connect failed; another is coming
  let fails = 0, retryTimer = 0
  let nextKey = null     // a key minted ahead of a renewal (a promise)
  let connects = 0
  let hearing = null     // the user is talking: the item id from speech_started, until speech_stopped
  let speaking = false   // the butler's audio is playing (output_audio_buffer.started .. stopped)
  let responding = false // a response is in progress (response.create .. response.done)
  let lastQuiet = 0
  let want = null        // a response to create once none is in progress: { turn }
  let creating = null    // the response.create on its way: { eventId, turn }
  let tools = 0          // tool calls being handled
  let eventSeq = 0
  let saying = null      // what the latest response said: { text }
  const queue = []
  const recent = []      // { at, item }: every say and report, the context of a new session
  // A user turn is an input audio item, keyed by its item_id; the turn behind a response is the
  // one that asked for it.
  const turns = new Map()   // item_id -> { startedAt, overButler, butler, text, done, settled, committed, timedOut, decided, timer }
  const spoken = new Map()  // response id -> { text }: what the butler said in it
  const turnOf = new Map()  // response id -> the input item that led to it

  /** Sends one client event on the warm session; returns its event_id, or null. */
  const send = event => {
    if (s?.dc?.readyState !== 'open') return null
    const event_id = `lookma_${++eventSeq}`
    s.dc.send(JSON.stringify({ event_id, ...event }))
    return event_id
  }
  const glyph = () => hearing ? 'listening' : !s?.ready ? 'off' : speaking ? 'speaking' : responding ? 'thinking' : 'off'
  const changed = () => o.onVoice({ glyph: glyph(), hearing: !!hearing, available: !off && !paused && !failing })
  const cardOf = id => (o.getState().cards || []).find(c => c.id === id)
  const cardText = c => [c.title, c.detail].filter(Boolean).join('\n')
  const stop = stream => stream?.getTracks().forEach(t => t.stop())
  const capped = (map, max = 30) => { if (map.size > max) map.delete(map.keys().next().value) }

  // ------------------------------------------------------------ the warm session

  /** The core's paused flag. Paused closes everything: no session, no microphone, nothing queued. */
  function setPaused(next) {
    if (next === paused) return
    paused = next
    if (paused) {
      queue.length = 0
      clearTimeout(retryTimer)
      nextKey = null
      if (s) o.log('voice: paused; session closed, microphone off')
      close()
      closeMic()
    } else {
      fails = 0
      connect()
    }
    changed()
  }

  async function connect(why = '') {
    if (s || off || paused) return
    clearTimeout(retryTimer)
    const me = s = { pc: null, dc: null, audio: null, ready: false, openedAt: 0 }
    setTimeout(() => { if (me === s && !me.ready) lost(me, 'not up in time') }, CONNECT_MS)
    try {
      const key = await takeKey() // first: a core with no voice must not open the microphone
      if (me !== s) return
      const asked = openMic()
      const stream = await asked
      if (me !== s) return
      const pc = me.pc = new RTCPeerConnection()
      me.audio = new Audio()
      me.audio.autoplay = true
      pc.ontrack = e => { if (me.audio) me.audio.srcObject = e.streams[0] }
      pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) lost(me, `connection ${pc.connectionState}`) }
      const track = stream.getAudioTracks()[0]
      track.onended = () => { if (mic === asked) mic = null; lost(me, 'the microphone stopped') } // unplugged: open another
      pc.addTrack(track, stream)
      const dc = me.dc = pc.createDataChannel('oai-events')
      dc.onopen = () => {
        if (me !== s) return
        me.ready = true
        me.openedAt = lastQuiet = Date.now()
        failing = false
        o.log(`voice: connected, listening (${key.model}${why ? `, ${why}` : ''})`)
        if (connects++) seed() // it replaces a lost one: what that one knew
        changed()
        pump()
      }
      dc.onclose = () => lost(me, 'channel closed')
      dc.onmessage = e => { if (me === s) try { onEvent(JSON.parse(e.data)) } catch (err) { o.log(`voice: ${err.message}`) } }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const sdp = await fetch(REALTIME_URL, {
        method: 'POST', body: offer.sdp,
        headers: { Authorization: `Bearer ${key.value}`, 'Content-Type': 'application/sdp' },
      })
      if (!sdp.ok) throw new Error(`realtime: HTTP ${sdp.status}`)
      const answer = await sdp.text()
      if (me !== s) return
      await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    } catch (err) {
      if (me !== s) return
      close()
      queue.length = 0 // captions only, for what was waiting
      if (err.voiceOff) {
        off = true
        closeMic()
        o.log(`voice off, captions only: ${err.message}`)
      } else {
        failing = true
        o.log(`voice unavailable, captions only for now: ${err.message}`)
        retryLater()
      }
      changed()
    }
  }

  /** The session closed or failed by itself: reconnect in the background. */
  function lost(me, why) {
    if (me !== s) return
    if (me.ready && Date.now() - me.openedAt >= STABLE_MS) fails = 0
    o.log(`voice: the session closed (${why}); reconnecting`)
    close()
    retryLater()
  }

  function retryLater() {
    clearTimeout(retryTimer)
    if (off || paused) return
    retryTimer = setTimeout(() => connect('reconnected'), RETRY_MS[Math.min(fails++, RETRY_MS.length - 1)])
  }

  /** No session: the connection and the butler's voice. The microphone is kept for the next one. */
  function close() {
    const me = s
    s = null
    if (me) {
      me.pc?.close()
      if (me.audio) me.audio.srcObject = null
    }
    for (const t of turns.values()) { clearTimeout(t.timer); t.decided = true } // that session's turns
    want = creating = hearing = null
    speaking = responding = false
    changed()
  }

  /** The open microphone, or a new one. One at a time, even while it is still being asked for. */
  function openMic() {
    if (!mic) {
      if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error('this page has no microphone access'))
      const asked = mic = navigator.mediaDevices.getUserMedia(MIC)
      asked.catch(() => { if (mic === asked) mic = null })
    }
    return mic
  }

  function closeMic() {
    mic?.then(stop, () => {}) // also one still being asked for, once it opens
    mic = null
  }

  async function mintKey() {
    const res = await fetch('/api/voice-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const key = await res.json().catch(() => ({}))
    // 503: this core has no voice (LOOKMA_NO_VOICE=1, or no OpenAI key). Asking again will not help.
    if (res.status === 503) throw Object.assign(new Error(key.error || 'the core has no voice'), { voiceOff: true })
    if (!res.ok || !key.value) throw new Error(key.error || `voice key: HTTP ${res.status}`)
    return key
  }

  async function takeKey() {
    const ahead = await nextKey?.catch(() => null)
    nextKey = null
    if (ahead && ahead.expiresAt * 1000 > Date.now() + KEY_MARGIN_MS) return ahead
    return mintKey()
  }

  const undecided = () => [...turns.values()].some(t => t.committed && !t.decided)

  // Every 250 ms, and whenever something changes: speak what is queued when nobody is talking;
  // while idle, renew the session before it reaches the Realtime time limit.
  function tick() {
    if (!s?.ready || hearing || undecided() || want || responding || speaking || tools) return
    const now = Date.now()
    if (queue.length) {
      if (now - lastQuiet >= QUIET_MS) speak(queue.shift())
      return
    }
    const age = now - s.openedAt
    if (age >= RENEW_MS - KEY_AHEAD_MS && !nextKey) {
      nextKey = mintKey()
      nextKey.catch(() => {})
    }
    if (age >= RENEW_MS && now - lastQuiet >= RENEW_IDLE_MS) {
      o.log(`voice: renewing the session after ${Math.round(age / 60000)} min`)
      close()
      connect('renewed')
    }
  }
  setInterval(tick, 250)

  // A session that replaces a lost one starts knowing what the user was shown lately and the
  // pending cards, as items with no response: the butler answers only when the user talks.
  // What is still queued is left out; it will be spoken.
  function seed() {
    const now = Date.now()
    const queued = new Set(queue)
    const queuedCards = new Set(queue.filter(i => i.kind === 'card').map(i => i.cardId))
    const items = [
      ...recent.filter(r => now - r.at < CONTEXT_MS && !queued.has(r.item)).map(r => r.item),
      ...(o.getState().cards || []).filter(c => !queuedCards.has(c.id)).map(c => ({ kind: 'card', cardId: c.id, display: cardText(c) })),
    ]
    for (const item of items) send(userItem(marked(item, true)))
    if (items.length) o.log(`voice: the new session is told ${items.length} earlier item(s)`)
  }

  // ------------------------------------------------------------ user turns, from the server's VAD

  function turn(id) {
    let t = turns.get(id)
    if (!t) {
      t = { startedAt: 0, overButler: false, butler: null, text: null, done: false, committed: false, timedOut: false, decided: false, timer: 0 }
      t.settled = new Promise(r => { t.settle = r })
      turns.set(id, t)
      capped(turns)
    }
    return t
  }

  /** A committed turn with its transcript, or none in time: reply, act, or drop it. */
  function decide(id) {
    const t = turns.get(id)
    if (!t || t.decided || !t.committed || !(t.done || t.timedOut)) return
    t.decided = true
    clearTimeout(t.timer)
    lastQuiet = Date.now()
    const text = t.done ? t.text : null // null: not transcribed (in time)
    if (!worthAnswering(text)) {
      o.log(`voice: no reply to ${JSON.stringify(text)}`)
      send({ type: 'conversation.item.delete', item_id: id }) // noise is not conversation
    } else if (text == null) {
      o.log('voice: no transcript; replying anyway')
      respond(id)
    } else if (!act(text)) respond(id)
    tick()
  }

  /** Words worth answering, heard: shown, and "stop", "go ahead" or "pause" act at once. */
  function act(text) {
    o.onUser(text)
    const cmd = commandFor(text, o.getState())
    if (cmd) o.send({ type: cmd })
    return !!cmd
  }

  // ------------------------------------------------------------ responses

  /** Ask for a response once none is in progress and nobody is talking. */
  function respond(turnItem) {
    want = { turn: turnItem }
    pump()
  }

  function pump() {
    if (!want || !s?.ready || responding || hearing) return
    const { turn } = want
    want = null
    const eventId = send({ type: 'response.create' })
    if (!eventId) return
    creating = { eventId, turn }
    responding = true
    changed()
  }

  // ------------------------------------------------------------ realtime events

  function said(responseId) {
    let r = spoken.get(responseId)
    if (!r) { spoken.set(responseId, (r = { text: '' })); capped(spoken) }
    return r
  }

  function onEvent(e) {
    switch (e.type) {
      case 'input_audio_buffer.speech_started': { // a turn starts: the record judgeAnswer reads
        const t = turn(e.item_id)
        t.startedAt = Date.now()
        t.overButler = speaking
        t.butler = speaking ? saying : null // what the butler was voicing, as it completes
        hearing = e.item_id
        changed()
        break
      }
      case 'input_audio_buffer.speech_stopped':
        if (hearing === e.item_id) hearing = null
        lastQuiet = Date.now()
        changed()
        pump()
        break
      case 'input_audio_buffer.committed': { // the turn is an item of the conversation
        const t = turn(e.item_id)
        if (hearing === e.item_id) { hearing = null; changed() }
        t.startedAt ||= Date.now() // no speech_started seen: as late as possible
        t.committed = true
        t.timer = setTimeout(() => { t.timedOut = true; decide(e.item_id) }, TURN_WAIT_MS)
        decide(e.item_id)
        break
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const t = turn(e.item_id)
        t.text = (e.transcript || '').trim()
        t.done = true
        t.settle()
        o.log(`heard ${JSON.stringify(t.text)}${t.overButler ? ' (started while the butler was talking)' : ''}`)
        if (!t.decided) decide(e.item_id)
        else if (t.timedOut && worthAnswering(t.text)) act(t.text) // already replied to, without it
        break
      }
      case 'conversation.item.input_audio_transcription.failed': { // replied to with no transcript
        const t = turn(e.item_id)
        t.done = true
        t.settle()
        decide(e.item_id)
        break
      }
      case 'response.created':
        responding = true
        if (e.response?.id) {
          turnOf.set(e.response.id, creating?.turn ?? null)
          capped(turnOf)
          saying = said(e.response.id)
        }
        creating = null
        changed()
        break
      case 'response.output_audio_transcript.delta':
        if (e.response_id) said(e.response_id).text += e.delta || ''
        break
      case 'response.output_audio_transcript.done':
        o.log(`butler said ${JSON.stringify(e.transcript || '')}`)
        if (e.response_id) said(e.response_id).text = e.transcript || ''
        break
      case 'output_audio_buffer.started':
        speaking = true
        changed()
        break
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        speaking = false
        lastQuiet = Date.now()
        changed()
        break
      case 'response.done':
        responding = false
        lastQuiet = Date.now()
        changed()
        for (const item of e.response?.output || []) {
          if (item.type === 'function_call' && item.status !== 'incomplete') handleToolCall(item, turnOf.get(e.response.id))
        }
        if (e.response?.status === 'failed') o.log(`voice: ${JSON.stringify(e.response.status_details)}`)
        pump()
        break
      case 'error': {
        o.log(`voice: ${e.error?.message || JSON.stringify(e)}`)
        if (e.error?.event_id && creating?.eventId === e.error.event_id) { // that response was never created
          creating = null
          responding = false
          changed()
        }
        break
      }
    }
  }

  // ------------------------------------------------------------ butler tools

  async function handleToolCall({ call_id, name, arguments: raw }, turnItem) {
    const me = s
    tools++
    let args = {}
    try { args = JSON.parse(raw || '{}') } catch {}
    let output
    let speakAgain = true
    try {
      if (name === 'do') {
        const text = String(args.task || '').trim()
        if (!text) output = { error: 'No task given.' }
        else if (!o.send({ type: 'tell', text, source: 'voice' })) output = { error: 'Could not start: Lookma is not connected. Tell the user, in a few words, that it did not start.' }
        else { output = { ok: true, note: 'Started. Your progress and results come back as updates from your work.' }; speakAgain = false } // nothing to say yet
      } else if (name === 'status') {
        output = statusSummary()
      } else if (name === 'answer') {
        output = await answer(args.allow === true, turnItem)
      } else {
        output = { error: `Unknown tool ${name}.` }
      }
    } catch (err) {
      output = { error: String(err.message || err) }
    } finally {
      tools--
    }
    if (me !== s) return // that session is gone
    send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id, output: JSON.stringify(output) } })
    if (speakAgain) respond(turnItem)
  }

  // The model decided the user approved or declined; check that against what was
  // actually said in the turn that led to the call, and when, before anything reaches
  // the executor. That turn's transcript can arrive after the call: wait for it, and a
  // transcript that never comes means not approved.
  async function answer(allow, turnItem) {
    const card = o.getState().cards?.[0] // the one on screen: oldest first, the order they are asked in
    if (!card) return { error: 'No approval is pending.' }
    const t = turnItem ? turns.get(turnItem) : null
    if (t && !t.done) await Promise.race([t.settled, new Promise(r => setTimeout(r, TRANSCRIPT_WAIT_MS))])
    const turn = t && { startedAt: t.startedAt, overButler: t.overButler, transcript: t.done ? t.text : null, butlerSaid: t.butler?.text || '' }
    const verdict = judgeAnswer({ allow, shownAt: o.cardShownAt(card.id), turn })
    o.log(`answer(allow=${allow}) on ${JSON.stringify(turn?.transcript ?? null)}: ${verdict.ok ? 'accepted' : 'refused'}`)
    if (!verdict.ok) {
      o.log(`voice: ${allow ? 'approval' : 'decline'} refused (${verdict.why})`)
      if (t?.text) o.onHeard({ cardId: card.id, text: t.text })
      return { error: verdict.reason } // generic: the butler reads it aloud
    }
    if (o.getState().cards?.[0]?.id !== card.id) return { error: 'That approval was already answered.' }
    o.answerCard(card.id, allow, 'voice')
    return { ok: true, answered: allow ? 'approved' : 'declined', what: card.title }
  }

  function statusSummary() {
    const st = o.getState()
    const secs = (a, b) => (a ? Math.round(((b || Date.now()) - a) / 1000) : undefined)
    return {
      work: st.executor?.status || 'unknown',
      turn: st.turn ? { request: st.turn.sent, doing: st.turn.status, phase: st.turn.phase, seconds: secs(st.turn.startedAt, st.turn.endedAt) } : null,
      screen: st.focus ? {
        step: st.focus.label, app: st.focus.app, phase: st.focus.phase,
        note: st.focus.phase === 'waiting' ? 'waiting until the user stops using the computer, or says go ahead' : undefined,
      } : null,
      approvals_pending: (st.cards || []).map(c => c.title),
      background: (st.tasks || []).map(t => ({ title: t.title, status: t.status, doing: t.status === 'running' ? t.action : undefined, seconds: secs(t.startedAt, t.endedAt) })),
      not_yet_spoken: queue.map(i => i.display),
    }
  }

  // ------------------------------------------------------------ speaking queue

  /** item: { kind: 'info'|'question'|'confirm'|'report', speech, display, title? } or { kind: 'card', cardId } */
  function enqueue(item) {
    if (item.kind === 'card') {
      const c = cardOf(item.cardId)
      if (!c) return
      item = { ...item, display: cardText(c) }
    } else {
      recent.push({ at: Date.now(), item })
      if (recent.length > 30) recent.shift()
    }
    if (off || paused || failing) return // captions only
    if (URGENT.has(item.kind)) queue.unshift(item)
    else queue.push(item)
    tick()
  }

  function speak(item) {
    if (item.kind === 'card' && !cardOf(item.cardId)) return tick() // answered meanwhile
    send(userItem(marked(item)))
    respond(null) // no user turn behind it
  }

  return { setPaused, enqueue }
}

// What the butler is given to say, as data with a marker it knows (prompts/butler.md).
// `earlier`: context for a session that replaces a lost one, already shown or said before it.
function marked(item, earlier = false) {
  const was = earlier ? ', from earlier' : ''
  // A card says what approving does: the butler asks for exactly that.
  if (item.kind === 'card') return `[Approval needed for your own next step${was}; the user did not say this. Approving lets you go ahead with this:] ${item.display}`
  // Only what to say: the screen already shows the display text.
  if (item.kind === 'report') return `[Your background task "${item.title || 'task'}" finished${was}; the user did not say this] ${item.speech}`
  const asks = item.kind === 'question' || item.kind === 'confirm'
  return `[Update from your work${asks ? ', a question for the user' : ''}${was}; the user did not say this] ${item.speech}`
}

const userItem = text => ({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
