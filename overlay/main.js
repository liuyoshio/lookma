// The overlay page: renders the core's snapshots (docs/protocol.md, "Core -> overlay")
// and runs the voice butler. Full-screen and transparent in the app's WKWebView;
// also opens in a normal browser for development.
//   ?scale=1.75     one size factor for TV distance
//   ?voice=0        captions only, no realtime voice
//   ?backdrop=1     draw a neutral fake desktop underneath (development screenshots)

import { $ } from './dom.js'
import { connect } from './link.js'
import { createVoice } from './voice.js'
import { renderCapsule } from './capsule.js'
import { renderMarks } from './marks.js'
import { initCard, renderCard } from './card.js'
import { commandFor } from './consent.js'
import { chime } from './sound.js'

const params = new URLSearchParams(location.search)
const scale = Number(params.get('scale'))
if (scale > 0) document.documentElement.style.setProperty('--s', String(scale))
if (params.get('backdrop') === '1') import('./dev/backdrop.js')
const voiceOn = params.get('voice') !== '0'

// Everything the page shows is a function of this: the core's last snapshot plus
// what only the page knows (the voice session, what the user said, local answers).
const ui = {
  state: { executor: { name: 'claude', status: 'starting' }, turn: null, focus: null, attention: { busy: false, idle: 0 }, cards: [], tasks: [] },
  link: 'connecting',
  voice: 'off',     // the glyph: off | listening | thinking | speaking
  hearing: false,  // the user is talking now (the voice's VAD heard speech start)
  voiceAvailable: voiceOn,
  user: null,      // { text, at, prev }   the user's last line (voice transcript or typed)
  said: null,      // { display, kind, at } the executor's last `say`
  reports: {},     // taskId -> { display, at }
  heard: null,     // { cardId, text }      an utterance that did not count as an answer
  answered: {},    // cardId -> { allow, via, at }
  cardShown: {},   // cardId -> when the card was rendered (the user could first see it)
  sentFirst: {},   // turnId -> the first text sent in that turn (a later one is a correction)
  statusAt: 0,     // when the turn's status line last changed
}

// ------------------------------------------------------------ rendering, coalesced to one per frame

let frame = 0
let wakeAt = Infinity, wakeTimer = 0
const schedule = () => { frame ||= requestAnimationFrame(render) }

/** Ask for a re-render at time t (a caption expiring, a mark going stale). */
function wake(t) {
  if (t >= wakeAt || t <= Date.now()) return
  wakeAt = t
  clearTimeout(wakeTimer)
  wakeTimer = setTimeout(() => { wakeAt = Infinity; schedule() }, t - Date.now() + 20)
}

function render() {
  frame = 0
  const now = Date.now()
  renderCapsule(ui, now, wake)
  renderCard(ui, now, wake)
  renderMarks(ui, now, wake)
  postToApp()
}

// The app makes the window clickable only inside these rects; everywhere else the
// overlay is click-through. It gives the window the keyboard only while `typing`, and its menu
// bar icon shows listening while `voice` (on, not paused: the microphone is open).
let lastPost = ''
function postToApp() {
  const edge = $('edge')
  const els = [$('card'), $('typed')].filter(el => !el.hidden)
  if (edge.classList.contains('on') && edge.classList.contains('waiting')) els.push($('goAhead'))
  const hitRects = els.map(el => {
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }
  })
  const msg = {
    hitRects,
    typing: !$('typed').hidden,
    voice: ui.voiceAvailable,
  }
  const key = JSON.stringify(msg)
  if (key === lastPost) return
  lastPost = key
  window.webkit?.messageHandlers?.lookma?.postMessage(msg)
}
for (const id of ['cap', 'edge']) $(id).addEventListener('transitionend', postToApp)

// ------------------------------------------------------------ core link

const link = connect({
  onLink(state) { ui.link = state; schedule() },
  onMessage(msg) { HANDLERS[msg.type]?.(msg) },
})

const HANDLERS = {
  state(next) {
    const now = Date.now()
    const prev = ui.state
    const t = next.turn
    if (t?.sent && !ui.sentFirst[t.id]) ui.sentFirst[t.id] = t.sent
    if (t && (t.id !== prev.turn?.id || t.status !== prev.turn?.status || t.phase !== prev.turn?.phase)) ui.statusAt = now
    ui.state = next
    followPause(!!next.paused)
    schedule()
    window.dispatchEvent(new CustomEvent('lookma:state', { detail: next })) // for the dev backdrop
  },
  say(msg) {
    ui.said = { display: msg.display || msg.speech, kind: msg.kind, at: Date.now() }
    schedule()
    voice.enqueue({ kind: msg.kind || 'info', speech: msg.speech || msg.display, display: msg.display || msg.speech })
  },
  report(msg) {
    ui.reports[msg.taskId] = { display: msg.display || msg.speech, at: Date.now() }
    schedule()
    const task = (ui.state.tasks || []).find(x => x.id === msg.taskId)
    voice.enqueue({ kind: 'report', title: task?.title, speech: msg.speech || msg.display, display: msg.display || msg.speech })
  },
  // Development only: the mock core stands in for the voice session's transcripts.
  'mock:heard'(msg) { heardUser(msg.text) },
}

/** A whole line from the user. Said while a turn is running (and not in answer to a
 *  card), it is a correction: the previous line stays above it as one grey line. */
function heardUser(text) {
  const correcting = ui.state.turn?.phase === 'working' && !ui.state.cards?.length
  ui.user = { text, at: Date.now(), prev: correcting && ui.user ? ui.user.text : '' }
  schedule()
}

function answerCard(cardId, allow, via) {
  if (ui.answered[cardId]) return
  if (!link.send({ type: 'answer', cardId, allow, via })) return
  ui.answered[cardId] = { allow, via, at: Date.now() }
  schedule()
}

// ------------------------------------------------------------ voice

// One warm voice session, always listening while voice is on and not paused (voice.js).
const voice = createVoice({
  enabled: voiceOn,
  getState: () => ui.state,
  send: msg => link.send(msg),
  cardShownAt: id => ui.cardShown[id] ?? Infinity,
  answerCard,
  onVoice(s) {
    if (s.glyph === ui.voice && s.hearing === ui.hearing && s.available === ui.voiceAvailable) return
    Object.assign(ui, { voice: s.glyph, hearing: s.hearing, voiceAvailable: s.available })
    schedule()
  },
  onUser: heardUser,
  onHeard(heard) { ui.heard = heard; schedule() },
  log: msg => { console.info(`[lookma] ${msg}`); link.send({ type: 'log', text: String(msg) }) },
})

// The core's paused flag, from the first snapshot on. Paused closes the voice entirely (mic off,
// the butler silent, nothing sent or billed) until the core resumes.
let paused = null
function followPause(next) {
  if (next === paused) return
  paused = next
  voice.setPaused(next)
}

// ------------------------------------------------------------ card, go ahead, typed input

initCard({
  onAnswer: (id, allow) => answerCard(id, allow, 'click'),
  // On screen now: a voiced answer counts from here, and the butler asks about this card.
  onShow(c) {
    ui.cardShown[c.id] = Date.now()
    chime()
    voice.enqueue({ kind: 'card', cardId: c.id })
  },
  afterMove: postToApp,
})
$('goAhead').addEventListener('click', () => link.send({ type: 'goAhead' }))

const typed = $('typed'), typedInput = $('typedInput')
function toggleTyping(show = typed.hidden) {
  typed.hidden = !show
  if (show) typedInput.focus()
  postToApp()
}
typed.addEventListener('submit', e => {
  e.preventDefault()
  const text = typedInput.value.trim()
  if (!text) return
  typedInput.value = ''
  const cmd = commandFor(text, ui.state) // "stop", "go ahead" and "pause" act at once, typed or spoken
  link.send(cmd ? { type: cmd } : { type: 'tell', text, source: 'typed' })
  heardUser(text)
})
addEventListener('keydown', e => {
  if (e.key === '`' && document.activeElement !== typedInput) { e.preventDefault(); toggleTyping() }
  else if (e.key === 'Escape' && !typed.hidden) toggleTyping(false)
})

// For the app (evaluateJavaScript): "Type a Request…" in its menu bar item. It returns nothing,
// so evaluateJavaScript has no result to convert.
window.lookma = { toggleTyping }

render()
