// Focus marks: where the agent's hands are. A coral ring around the target, a label
// hanging off it, and a ghost cursor that glides to the point and presses. A drag
// (`focus.to`) also gets a dimmer ring on its drop end and a dashed line to it before
// the press; then the ghost holds, glides there with the real pointer, and the ring
// follows. All of it comes from `focus` and is placed once per step (no per-frame
// tracking). When the user is busy, the marks stand down and a yellow tab at the
// screen edge says where the agent is working, or that it is waiting for the front.

import { $, css, cls, txt, replay, clamp, rectOf, pointOf, onScreen, overlaps } from './dom.js'

const STALE = 10000 // a finished step older than this no longer marks anything
const GRACE = 1600  // marks stay this long after the turn ends
const GLIDE = 340   // ghost flight; fits inside the core's ~350 ms pause before acting
// A drag as the app's mouseDrag (Input.swift) posts it: the move to the start and the hold
// (60 + 300 ms), then the glide to the drop end (20 events 25 ms apart).
const DRAG_HOLD = 360
const DRAG_MS = 500
const SPRING = 'cubic-bezier(.32,.72,0,1)'

const ring = $('ring'), drop = $('drop'), path = $('path'), flabel = $('flabel'), ghost = $('ghost'), ripple = $('ripple'), edge = $('edge'), stack = $('stack')
const flTx = flabel.querySelector('.tx')
const edgeTx = edge.querySelector('.tx')

const g = { ringOn: false, labelOn: false, ringStep: null, turnId: null, pos: null, flewStep: null, pressedStep: null, flight: null, actStep: null, actAt: 0, droppedStep: null }
const scale = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--s')) || 1

export function renderMarks(ui, now, wake) {
  const { turn, focus: f, executor } = ui.state
  const ended = turn && turn.phase !== 'working' ? (turn.endedAt || now) : 0
  const turnLive = !!turn && !ui.state.paused && (!ended || now - ended < GRACE) // paused: clear at once
  if (turnLive && ended) wake(ended + GRACE)

  const inTurn = turnLive && !!f && f.at > turn.startedAt
  const busyPhase = inTurn && ['moving', 'acting', 'waiting'].includes(f.phase)
  const fresh = inTurn && (busyPhase || now - f.at < STALE)
  if (fresh && !busyPhase) wake(f.at + STALE)
  const aside = fresh && (!!f.background || f.phase === 'waiting')

  // A drag's drop end. Once the ghost starts gliding there, the ring follows it.
  const to = fresh && f.to ? { r: rectOf(f.to.rect), p: pointOf(f.to.point) } : null
  if (to && f.phase === 'acting' && g.actStep !== f.id) { g.actStep = f.id; g.actAt = now }
  const gliding = !!to && f.phase === 'acting' && now - g.actAt >= DRAG_HOLD
  if (to && f.phase === 'acting' && !gliding) wake(g.actAt + DRAG_HOLD)
  const dropped = gliding || (!!to && f.phase === 'done')
  const r = !fresh ? null : dropped ? to.r : rectOf(f.rect)

  // ring + label
  const showRing = !!r && !aside && onScreen(r)
  if (showRing) {
    if (!g.ringOn) ring.classList.add('snap') // appear in place, don't glide from a stale target
    const box = frame(ring, r)
    if (!g.ringOn) { void ring.offsetWidth; ring.classList.remove('snap') }
    if (g.ringStep !== f.id) { g.ringStep = f.id; replay(ring, 'breathe') } // 2 s, then still

    txt(flTx, f.label || '')
    const pos = placeLabel(box, flabel.offsetWidth, flabel.offsetHeight)
    if (!g.labelOn) flabel.style.transition = 'none'
    css(flabel, 'transform', `translate(${pos.x}px,${pos.y}px)`)
    if (!g.labelOn) { void flabel.offsetWidth; flabel.style.transition = '' }
  }
  g.ringOn = g.labelOn = showRing
  cls(ring, 'on', showRing)
  cls(flabel, 'on', showRing)

  // a drag's drop ring and the line to it: both ends are marked before the button goes down
  const p = fresh && !aside ? pointOf(f.point) : null
  const showDrop = showRing && !!to?.r && !dropped && ['moving', 'acting'].includes(f.phase) && onScreen(to.r)
  if (showDrop) frame(drop, to.r)
  cls(drop, 'on', showDrop)
  const showPath = showDrop && !!p && !!to.p
  if (showPath) {
    const dx = to.p.x - p.x, dy = to.p.y - p.y
    css(path, 'width', `${Math.hypot(dx, dy)}px`)
    css(path, 'transform', `translate(${p.x}px,${p.y}px) rotate(${Math.atan2(dy, dx)}rad)`)
  }
  cls(path, 'on', showPath)

  // ghost cursor: rests where it last pressed until the turn ends
  if (turn?.id !== g.turnId) { g.turnId = turn?.id; g.pos = null }
  if (p && g.flewStep !== f.id) {
    g.flewStep = f.id
    fly(g.pos || capsuleTop(), p)
    g.pos = p
  }
  if (p && g.pressedStep !== f.id && (f.phase === 'acting' || f.phase === 'done')) {
    g.pressedStep = f.id
    const end = to?.p
    if (end) g.pos = end
    const go = () => (end ? drag(p, end) : press(p))
    g.flight ? g.flight.finished.then(go, go) : go()
  }
  if (p && to?.p && f.phase === 'done' && g.droppedStep !== f.id) {
    g.droppedStep = f.id
    pulse(to.p)
  }
  cls(ghost, 'on', turnLive && !!g.pos && !aside)

  // edge hint
  const showEdge = aside
  if (showEdge) {
    const cx = r ? r.x + r.w / 2 : innerWidth, cy = r ? r.y + r.h / 2 : innerHeight / 2
    const waiting = f.phase === 'waiting'
    cls(edge, 'left', cx < innerWidth / 2)
    cls(edge, 'waiting', waiting)
    const app = f.app || 'an app'
    txt(edgeTx, `${waiting ? `Waiting to use ${app}` : `In ${app}`}${f.label ? ` · ${f.label}` : ''}`)
    css(edge, 'top', `${clamp(cy - edge.offsetHeight / 2, 40, innerHeight - 280)}px`)
  }
  cls(edge, 'on', showEdge)
}

function ghostAt(p) {
  const tip = 2 * scale() // the arrow's tip in its 20 x 28 box
  return `translate(${p.x - tip}px,${p.y - tip}px)`
}

// One gently curved flight per step, sampled into keyframes and run by the compositor.
function fly(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y
  const c = { x: (a.x + b.x) / 2 - dy * 0.16, y: (a.y + b.y) / 2 + dx * 0.16 }
  const ease = u => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2)
  const frames = []
  for (let i = 0; i <= 12; i++) {
    const u = ease(i / 12), v = 1 - u
    frames.push({ transform: ghostAt({ x: v * v * a.x + 2 * v * u * c.x + u * u * b.x, y: v * v * a.y + 2 * v * u * c.y + u * u * b.y }) })
  }
  ghost.style.transform = ghostAt(b)
  g.flight = ghost.animate(frames, { duration: GLIDE })
  g.flight.finished.then(() => { g.flight = null }, () => {})
}

function press(p) {
  const at = ghostAt(p)
  ghost.animate([{ transform: at }, { transform: `${at} scale(.84)` }, { transform: at }], { duration: 240, easing: 'ease-out' })
  pulse(p)
}

function pulse(p) {
  const R = ripple.offsetWidth / 2
  const t = `translate(${p.x - R}px,${p.y - R}px)`
  ripple.animate([{ opacity: 0.9, transform: `${t} scale(.25)` }, { opacity: 0, transform: `${t} scale(1.35)` }], { duration: 600, easing: SPRING })
}

// Press at a, hold while the app does, glide to b with the real pointer (the same ease as
// dragPath in Input.swift), and let go there. The ripple waits for the step to be done.
function drag(a, b) {
  const from = ghostAt(a), to = ghostAt(b), total = DRAG_HOLD + DRAG_MS + 120
  ghost.style.transform = to
  g.flight = ghost.animate([
    { transform: from, offset: 0 },
    { transform: `${from} scale(.84)`, offset: 120 / total },
    { transform: `${from} scale(.84)`, offset: DRAG_HOLD / total, easing: 'cubic-bezier(.65,0,.35,1)' },
    { transform: `${to} scale(.84)`, offset: (DRAG_HOLD + DRAG_MS) / total },
    { transform: to, offset: 1 },
  ], { duration: total })
  g.flight.finished.then(() => { g.flight = null }, () => {})
}

/** Puts a ring-like element around r, padded, and returns its box. */
function frame(el, r) {
  const pad = 4 * scale()
  const box = { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad }
  css(el, 'transform', `translate(${box.x}px,${box.y}px)`)
  css(el, 'width', `${box.w}px`)
  css(el, 'height', `${box.h}px`)
  css(el, 'borderRadius', `${Math.min(12, Math.min(r.w, r.h) / 2) + pad}px`)
  return box
}

function capsuleTop() {
  const b = $('cap').getBoundingClientRect()
  return { x: b.left + b.width / 2, y: b.top }
}

/** The area the bottom stack occupies; labels stay clear of it. */
function stackRect() {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const el of stack.children) {
    if (el.hidden) continue
    const b = el.getBoundingClientRect()
    if (!b.width || !b.height) continue
    x1 = Math.min(x1, b.left); y1 = Math.min(y1, b.top); x2 = Math.max(x2, b.right); y2 = Math.max(y2, b.bottom)
  }
  return x1 === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

// Narrow targets: centred above. Wide ones: above the trailing end, so the label never
// hides the start of what it points at. Then below, right, left, and finally inside.
function placeLabel(r, lw, lh) {
  const gap = 9 * scale(), avoid = stackRect(), W = innerWidth, H = innerHeight
  const ax = r.w < lw * 1.2 ? r.x + r.w / 2 - lw / 2 : r.w > lw * 2.2 ? r.x + r.w - lw : r.x
  const cands = [
    { x: ax, y: r.y - gap - lh },
    { x: ax, y: r.y + r.h + gap },
    { x: r.x + r.w + gap, y: r.y + r.h / 2 - lh / 2 },
    { x: r.x - gap - lw, y: r.y + r.h / 2 - lh / 2 },
    { x: r.x + 12, y: r.y + 12 },
  ]
  for (const c of cands) {
    const box = { x: c.x, y: c.y, w: lw, h: lh }
    if (c.x >= 8 && c.y >= 30 && c.x + lw <= W - 8 && c.y + lh <= H - 8 && !overlaps(box, avoid)) return c
  }
  const c = cands[cands.length - 1]
  return { x: clamp(c.x, 8, W - lw - 8), y: clamp(c.y, 30, H - lh - 8) }
}
