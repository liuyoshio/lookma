// The approval card: the oldest pending card from the core, with Approve / Decline.
// It slides up above the capsule and is the only part of the overlay that takes clicks.
// Only the question and its detail are shown, never the agent's own options: Approve is
// always "yes, once", and listing "Yes, and don't ask again" would suggest it might pick that.
// onShow(card) fires when a card is actually rendered: that moment is when the user can see it.

import { $, txt, cls } from './dom.js'

const SPRING = 'cubic-bezier(.32,.72,0,1)'
const SHOW_ANSWER = 900 // an answered card stays this long, showing the choice
const MIC = '<svg viewBox="0 0 16 16"><rect x="5.5" y="1.8" width="5" height="8" rx="2.5"/><path d="M3.2 8a4.8 4.8 0 0 0 9.6 0M8 12.8v1.8"/></svg>'

const card = $('card')
const kQ = card.querySelector('.k-q'), kD = card.querySelector('.k-d')
const kHint = card.querySelector('.k-hint'), kMore = card.querySelector('.k-more')
const buttons = [...card.querySelectorAll('.k-btn')]

let shown = null // the card on screen
let hiding = null
let onAnswer = () => {}
let onShow = () => {}
let afterMove = () => {}

export function initCard(handlers) {
  ({ onAnswer, onShow, afterMove } = handlers)
  for (const b of buttons) b.addEventListener('click', () => {
    if (shown && !card.classList.contains('answered')) onAnswer(shown.id, b.dataset.allow === 'true')
  })
}

export function renderCard(ui, now, wake) {
  const cards = ui.state.cards || []
  let c = cards[0]
  if (!c && shown && ui.answered[shown.id] && now - ui.answered[shown.id].at < SHOW_ANSWER) {
    c = shown // gone from the core, but let the user see their answer land
    wake(ui.answered[shown.id].at + SHOW_ANSWER)
  }
  if (!c) { hide(); return }

  if (c.id !== shown?.id) {
    shown = c
    kQ.textContent = c.title || 'Approve this step?'
    kD.textContent = c.detail || ''
    show()
    onShow(c)
  }
  txt(kMore, cards.length > 1 ? `+${cards.length - 1} more` : '')

  const answered = ui.answered[c.id]
  cls(card, 'answered', !!answered)
  for (const b of buttons) {
    const mine = !!answered && String(answered.allow) === b.dataset.allow
    cls(b, 'chosen', mine)
    cls(b, 'faded', !!answered && !mine)
  }

  const heard = ui.heard?.cardId === c.id ? ui.heard : null
  let key, html
  if (answered) {
    key = `a${answered.allow}${answered.via}`
    html = `<span>${answered.allow ? 'Approved' : 'Declined'}${answered.via === 'voice' ? ' by voice' : ''}</span>`
  } else if (heard) {
    key = `h${heard.text}`
    html = `${MIC}<span>Not a clear yes: <span class="q"></span></span>`
  } else if (ui.voiceAvailable && ui.mic) { // listening now: just say it
    key = 'v'
    html = `${MIC}<span>Say “yes, I approve”</span>` // the buttons beside it say the rest
  } else if (ui.voiceAvailable) { // the microphone is closed until the key is held
    key = 'k'
    html = `${MIC}<span>Hold fn and say “yes, I approve”</span>`
  } else {
    key = 'c'
    html = '<span>Click to answer</span>'
  }
  if (kHint._k !== key) {
    kHint._k = key
    kHint.innerHTML = html
    const q = kHint.querySelector('.q') // the heard words go in as text, never as markup
    if (q) q.textContent = `“${heard.text}”`
  }
  cls(kHint, 'heard', !!heard && !answered)
}

function show() {
  hiding?.cancel()
  hiding = null
  card.hidden = false
  afterMove()
  card.animate(
    [{ opacity: 0, transform: 'translateY(1em) scale(.97)' }, { opacity: 1, transform: 'none' }],
    { duration: 550, easing: SPRING },
  ).finished.then(afterMove, () => {})
}

function hide() {
  if (card.hidden || hiding) return
  shown = null
  hiding = card.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(.7em) scale(.985)' }],
    { duration: 350, easing: SPRING, fill: 'forwards' },
  )
  hiding.finished.then(() => {
    card.hidden = true
    hiding.cancel()
    hiding = null
    afterMove()
  }, () => {})
}
