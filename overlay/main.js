// The overlay page: renders the core's snapshots (docs/protocol.md, "Core -> overlay")
// and runs the voice butler, which it hands every snapshot (voice.update), and, with hand
// gestures on, the camera and its hand tracker (hand/), whose hands go to the app. Full-screen and
// transparent in the app's WKWebView; also opens in a normal browser for development.
//   ?scale=1.75     one size factor for TV distance
//   ?voice=0        captions only, no realtime voice
//   ?backdrop=1     draw a neutral fake desktop underneath (development screenshots)
//   ?hands=1        draw the hand tracker's view: landmarks, the 70% box, ms per frame (hand/view.js)

import { $ } from './dom.js'
import { connect } from './link.js'
import { createVoice } from './voice.js'
import { renderCapsule } from './capsule.js'
import { renderMarks } from './marks.js'
import { createCamera } from './hand/camera.js'
import { initCard, renderCard } from './card.js'
import { commandFor } from './consent.js'
import { chime } from './sound.js'

const params = new URLSearchParams(location.search)
const scale = Number(params.get('scale'))
if (scale > 0) document.documentElement.style.setProperty('--s', String(scale))
if (params.get('backdrop') === '1') import('./dev/backdrop.js')
if (params.get('hands') === '1') import('./hand/view.js')
const voiceOn = params.get('voice') !== '0'

// Everything the page shows is a function of this: the core's last snapshot plus
// what only the page knows (the voice session, what the user said, local answers).
const ui = {
  state: { executor: { name: '', status: 'starting' }, turn: null, focus: null, attention: { busy: false, idle: 0 }, cards: [], tasks: [], outbox: [] },
  link: 'connecting',
  voice: 'off',     // the glyph: off | open | listening | thinking | speaking
  hearing: false,  // the user is talking now (the voice's VAD heard speech start)
  voiceAvailable: voiceOn,
  mic: false,      // the microphone is open for the user: held, in a conversation, or always listening
  conversation: false, // a hands-free conversation is open (a tap, or Start Conversation in the menu)
  camera: 'off',   // the hand gestures' camera: off | on | failed (hand/camera.js)
  user: null,      // { text, at, prev }   the user's last line (voice transcript or typed)
  said: null,      // { display, kind, at } the work's last line (the newest outbox entry that is not a card or report)
  notice: null,    // { display, at }       a request that did not go through, one the voice lost, or no microphone (shown like a said line)
  reports: {},     // taskId -> { display, at }, from the outbox's report entries
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
// overlay is click-through. It gives the window the keyboard only while `typing`; its menu bar
// icon shows `voice` (on, not paused, not failing) and `mic` (the microphone open), and its menu
// offers End Conversation while `conversation`. `camera` is what the camera it asked for is doing.
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
    mic: ui.mic,
    conversation: ui.conversation,
    camera: ui.camera,
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
    // Captions come from the outbox, whatever the voice does with it.
    const said = next.outbox.findLast(e => e.kind !== 'card' && e.kind !== 'report')
    ui.said = said ? { display: said.display, kind: said.kind, at: said.at } : null
    ui.reports = Object.fromEntries(next.outbox.filter(e => e.kind === 'report').map(e => [e.taskId, { display: e.display, at: e.at }]))
    voice.update(next)
    schedule()
    window.dispatchEvent(new CustomEvent('lookma:state', { detail: next })) // for the dev backdrop
  },
  // Development only: the mock core stands in for the voice session's transcripts.
  'mock:heard'(msg) { heardUser(msg.text) },
}

/** A whole line from the user. Said while a turn is running (and not in answer to a
 *  card), it is a correction: the previous line stays above it as one grey line. */
function heardUser(text) {
  const correcting = ui.state.turn?.phase === 'working' && !ui.state.cards.length
  ui.user = { text, at: Date.now(), prev: correcting && ui.user ? ui.user.text : '' }
  schedule()
}

/** Click or voice. Shown as answered only once the core agreed; resolves with its ack. */
async function answerCard(cardId, allow, via) {
  const ack = await link.request({ type: 'answer', cardId, allow, via })
  if (ack.ok) {
    ui.answered[cardId] = { allow, via, at: Date.now() }
    schedule()
  }
  return ack
}

// To the console and the core's log.
const log = msg => { console.info(`[lookma] ${msg}`); link.send({ type: 'log', text: msg }) }

// ------------------------------------------------------------ voice

// One warm voice session while voice is on and not paused, listening as the talk mode says (voice.js).
const voice = createVoice({
  enabled: voiceOn,
  getState: () => ui.state,
  request: link.request,
  send: link.send,
  cardShownAt: id => ui.cardShown[id] ?? Infinity,
  answerCard,
  onVoice(s) {
    // The floor's glyph; when it is still, solid bars while the microphone is open for the user.
    const next = { voice: s.glyph === 'off' && s.how !== 'off' ? 'open' : s.glyph, hearing: s.hearing, voiceAvailable: s.available, mic: s.how !== 'off', conversation: s.open }
    if (Object.keys(next).every(k => next[k] === ui[k])) return
    Object.assign(ui, next)
    schedule()
  },
  onLine(line) {
    if (line.kind === 'user') return heardUser(line.text)
    if (line.kind === 'unheard') ui.heard = { cardId: line.cardId, text: line.text }
    else ui.notice = { display: NOTICES[line.kind], at: Date.now() }
    schedule()
  },
  log,
})

// ------------------------------------------------------------ card, go ahead, typed input

initCard({
  onAnswer: (id, allow) => answerCard(id, allow, 'click'),
  // On screen now: a voiced answer counts from here. (The butler asks about it from the outbox.)
  onShow(c) {
    ui.cardShown[c.id] = Date.now()
    chime()
  },
  afterMove: postToApp,
})
$('goAhead').addEventListener('click', () => link.request({ type: 'control', action: 'go_ahead' }))

const typed = $('typed'), typedInput = $('typedInput')
function toggleTyping(show = typed.hidden) {
  typed.hidden = !show
  if (show) typedInput.focus()
  postToApp()
}
// The on-screen wording of a failed request's error code (other errors are already sentences),
// of a request the voice lost, and of a microphone that would not open.
const NOTICES = {
  missed: 'Sorry, I lost that. Please say it again.',
  nomic: 'Lookma has no microphone access',
  nothing_running: 'Nothing is running.',
  not_waiting: 'Nothing is waiting for you.',
  'not connected': 'Not connected to the core.',
  'no answer': 'The core did not answer.',
}
typed.addEventListener('submit', async e => {
  e.preventDefault()
  const text = typedInput.value.trim()
  if (!text) return
  typedInput.value = ''
  heardUser(text)
  const action = commandFor(text) // a bare "stop", "go ahead" or "pause"; the core decides if it applies
  const ack = await link.request(action ? { type: 'control', action } : { type: 'tell', text, source: 'typed' })
  if (ack.ok) return
  ui.notice = { display: NOTICES[ack.error] || ack.error, at: Date.now() }
  schedule()
})
addEventListener('keydown', e => {
  if (e.key === '`' && document.activeElement !== typedInput) { e.preventDefault(); toggleTyping() }
  else if (e.key === 'Escape' && !typed.hidden) toggleTyping(false)
})

// ------------------------------------------------------------ hand gestures' camera

// Runs while the app says (window.lookma.camera). Each processed frame's hand goes to the app on
// its own handler, `hand` (not page state: no dedupe, one message per frame), and to the ?hands=1
// view. Frames themselves never leave the page.
const camera = createCamera({
  getUserMedia: c => navigator.mediaDevices.getUserMedia(c),
  video: $('camera'),
  startWorker: () => new Worker(new URL('./hand/worker.js', import.meta.url), { type: 'module' }),
  onFrame({ t, aspect, hand, ms }) {
    window.webkit?.messageHandlers?.hand?.postMessage({ t, aspect, hand })
    window.dispatchEvent(new CustomEvent('lookma:hand', { detail: { aspect, hand, ms } }))
  },
  onState(s) {
    ui.camera = s
    postToApp()
  },
  log,
})

// ------------------------------------------------------------ for the app

// Called with evaluateJavaScript: "Type a Request…" in its menu bar item, the talk key's edges
// (and the menu's Start/End Conversation, 'toggle'), and the camera on or off, checked here where
// they enter. Each returns nothing, so evaluateJavaScript has no result to convert.
const KEY_EDGES = ['down', 'up', 'cancel', 'toggle']
function key(edge) {
  if (!KEY_EDGES.includes(edge)) throw new Error(`lookma.key: unknown edge ${JSON.stringify(edge)}`)
  voice.key(edge)
}
function setCamera(on) {
  if (typeof on !== 'boolean') throw new Error(`lookma.camera: not a boolean: ${JSON.stringify(on)}`)
  camera(on)
}
window.lookma = { toggleTyping, key, camera: setCamera }

render()
