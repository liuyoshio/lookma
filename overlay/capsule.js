// The turn capsule at the bottom centre, and the yellow background-task pills above it.
// Three rows: what the user said, the exact text sent to the executor, and one status
// line. It grows and shrinks to fit (like the Dynamic Island) and collapses to the
// voice glyph when nothing is going on.

import { $, txt, cls, replay } from './dom.js'

const LINGER = 5000      // keep a finished turn or a caption up this long
const TURN_WINDOW = 20000 // a user line said this long before a turn started belongs to it
const TASK_LINGER = 10000

const cap = $('cap'), capIn = $('capIn'), vg = $('vg')
const rPrev = cap.querySelector('.r-prev'), rUser = cap.querySelector('.r-user')
const rSent = cap.querySelector('.r-sent'), rStatus = cap.querySelector('.r-status')
const tasksEl = $('tasks')

export function capsuleModel(ui, now, wake) {
  const { state, voice, user } = ui
  // A notice (a typed request that did not go through, one the voice lost, or no microphone) shows on the said line, when it is the newer.
  const said = ui.notice && ui.notice.at > (ui.said?.at || 0) ? ui.notice : ui.said
  // Paused: one calm line and how to resume. Not by voice: the mic is off.
  if (state.paused && ui.link !== 'closed') {
    return { voice: 'paused', prev: '', user: 'Paused', ph: false, sent: '', tag: '', fix: false, min: false, hidden: true,
      status: { kind: 'paused', ic: '', text: 'The mic is off. Resume from the menu bar or with ⌃⌥P.' } }
  }
  const turn = state.turn
  const working = turn?.phase === 'working'
  const ended = turn && !working ? turn.endedAt : 0
  const movedOn = !!(turn && !working && user && user.at > ended)
  const lastWord = Math.max(ended, said?.at || 0)
  const turnLive = !!turn && !movedOn && (working || now - lastWord < LINGER)
  if (turn && !working && turnLive) wake(lastWord + LINGER)

  const userLive = !!user && (turnLive ? user.at >= turn.startedAt - TURN_WINDOW : now - user.at < LINGER)
  if (user && !turnLive && userLive) wake(user.at + LINGER)
  const saidLive = !!said && (turnLive ? said.at >= turn.startedAt : now - said.at < LINGER)
  if (said && !turnLive && saidLive) wake(said.at + LINGER)

  const m = { voice, prev: '', user: '', ph: false, sent: '', tag: '', fix: false, status: null }
  if (ui.hearing) { m.user = 'Listening…'; m.ph = true } // the user is talking
  else if (userLive) { m.user = `“${user.text}”`; m.prev = user.prev }

  if (turnLive && turn.sent) {
    m.sent = turn.sent
    m.fix = !!ui.sentFirst[turn.id] && ui.sentFirst[turn.id] !== turn.sent
    m.tag = m.fix ? 'Corrected' : 'Doing'
  }
  m.status = statusLine(ui, said, turnLive, saidLive)
  m.min = !m.user && !m.sent && !m.status && !['listening', 'speaking', 'thinking'].includes(voice)
  return m
}

// The user sees one assistant, so no executor name appears here.
function statusLine(ui, said, turnLive, saidLive) {
  const { state, link } = ui
  const turn = state.turn, focus = state.focus
  if (!turnLive) {
    if (link === 'closed') return { kind: 'think', ic: 'dim', text: 'Not connected to the core' }
    const ex = state.executor
    if (ex.status === 'starting') return { kind: 'think', ic: 'dim', text: 'Starting…' }
    if (ex.status === 'down') return { kind: 'fail', ic: 'fail', text: `Not running${ex.detail ? ` · ${ex.detail}` : ''}` }
    if (saidLive) return { kind: 'said', ic: 'said', text: said.display }
    return null
  }
  const focusHere = focus && focus.at > turn.startedAt
  if (turn.phase === 'working') {
    if (state.cards.length) return { kind: 'await', ic: 'wait', text: 'Waiting for your approval' }
    if (focusHere && focus.phase === 'waiting') return { kind: 'await', ic: 'wait', text: 'Waiting for you to pause', meta: focus.app || '' }
    if (saidLive && said.at > ui.statusAt) return { kind: 'said', ic: 'said', text: said.display }
    if (turn.status) return { kind: 'step', ic: 'spin', text: turn.status, meta: focusHere && focus.app ? focus.app : '' }
    return { kind: 'think', ic: 'dim', text: 'Thinking…' }
  }
  const ic = { done: 'done', failed: 'fail', cancelled: 'no' }[turn.phase]
  const word = { done: 'Done', failed: 'Failed', cancelled: 'Stopped' }[turn.phase]
  const secs = `${Math.max(1, Math.round((turn.endedAt - turn.startedAt) / 1000))} s`
  const text = turn.phase === 'cancelled' ? word : saidLive ? said.display : (turn.status || word)
  return { kind: 'done', ic, text, meta: secs }
}

export function renderCapsule(ui, now, wake) {
  const m = capsuleModel(ui, now, wake)
  const vgc = `vg ${m.voice}`
  if (vg.className !== vgc) vg.className = vgc
  cls(cap, 'min', m.min)
  cls(cap, 'hidden', m.hidden)

  txt(rPrev, m.prev)
  const uk = m.user + m.ph
  if (rUser._k !== uk) {
    rUser._k = uk
    rUser.textContent = m.user
    cls(rUser, 'ph', m.ph)
    if (m.user) replay(rUser, 'enter') // the whole sentence at once
  }

  const sk = m.tag + '\n' + m.sent
  if (rSent._k !== sk) {
    rSent._k = sk
    rSent.replaceChildren()
    if (m.sent) {
      const k = document.createElement('span')
      k.className = m.fix ? 'k fix' : 'k'
      k.textContent = m.tag
      const t = document.createElement('span')
      t.className = 'tx'
      t.textContent = m.sent
      rSent.append(k, t)
      replay(rSent, 'snapin') // the relayed text shows at once, so a mishearing is obvious
    }
  }

  const st = m.status
  const stk = st ? `${st.kind}\n${st.ic}\n${st.text}\n${st.meta || ''}` : ''
  if (rStatus._k !== stk) {
    const kindChanged = !st || rStatus._kind !== st.kind || st.kind === 'step'
    rStatus._k = stk
    rStatus._kind = st?.kind
    rStatus.className = 'r-status' + (st ? ` ${st.kind}` : '')
    rStatus.replaceChildren()
    if (st) {
      if (st.ic) { const ic = document.createElement('span'); ic.className = `ic ${st.ic}`; rStatus.append(ic) }
      const tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = st.text
      rStatus.append(tx)
      if (st.meta) { const me = document.createElement('span'); me.className = 'meta'; me.textContent = st.meta; rStatus.append(me) }
      if (kindChanged) replay(rStatus, 'enter')
    }
  }

  // Size the glass to the content; the transition does the rest.
  const w = capIn.offsetWidth, h = capIn.offsetHeight
  if (cap._w !== w || cap._h !== h) {
    cap._w = w; cap._h = h
    const em = parseFloat(getComputedStyle(cap).fontSize)
    cap.style.width = `${w}px`
    cap.style.height = `${h}px`
    cap.style.borderRadius = `${h < 4.3 * em ? h / 2 : 1.55 * em}px`
  }

  renderTasks(ui, now, wake)
}

function renderTasks(ui, now, wake) {
  const shown = ui.state.tasks.filter(t => {
    if (t.status === 'running') return true
    const end = Math.max(t.endedAt, ui.reports[t.id]?.at || 0)
    if (now - end < TASK_LINGER) { wake(end + TASK_LINGER); return true }
    return false
  })
  const key = JSON.stringify(shown.map(t => [t.id, t.status, t.title, t.action, ui.reports[t.id]?.display]))
  if (tasksEl._k === key) return
  tasksEl._k = key
  tasksEl.replaceChildren(...shown.map(t => {
    const row = document.createElement('div')
    row.className = `task ${t.status}`
    const dot = document.createElement('i'); dot.className = 'dot'
    const ti = document.createElement('span'); ti.className = 'ti'; ti.textContent = t.title || 'Background task'
    const tx = document.createElement('span'); tx.className = 'tx'
    tx.textContent = t.status === 'running' ? (t.action || 'In the background') : (ui.reports[t.id]?.display || (t.status === 'failed' ? 'Failed' : 'Done'))
    row.append(dot, ti, tx)
    return row
  }))
}
