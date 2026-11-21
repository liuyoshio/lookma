// The ?hands=1 debug view (main.js loads it only with that flag): the hand the page sends the app,
// drawn on a canvas over the whole overlay that takes no clicks. The 21 landmarks and their bones
// are mapped onto the display through the engine's reach (the central 70% of the frame spans the
// display, GestureTuning.reach in app/Sources/Gesture.swift), so the ring finger's base, drawn as
// a ring, sits on the point the pointer eases to. An inset shows the whole frame with the 70% box,
// and the tracker's milliseconds per frame and frames per second. It shows nothing of the engine's
// state: the pointer and the app's behaviour show that. Fed by main.js's `lookma:hand` events.

const REACH = 0.70 // GestureTuning.reach
const EDGE = (1 - REACH) / 2
const ANCHOR = 13 // ringMCP
// MediaPipe's hand connections.
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]]
const INSET = 240 // the inset's width, CSS pixels

const canvas = document.createElement('canvas')
canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:10'
document.body.append(canvas)
const g = canvas.getContext('2d')
const acc = getComputedStyle(document.documentElement).getPropertyValue('--acc').trim()
const times = [] // the last second's frames, for frames per second

const clamp01 = v => Math.min(1, Math.max(0, v))

function draw({ aspect, hand, ms }) {
  const now = performance.now()
  times.push(now)
  while (times[0] < now - 1000) times.shift()

  const dpr = devicePixelRatio, w = innerWidth, h = innerHeight
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr
    canvas.height = h * dpr
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)

  // The inset: the whole frame, the 70% box, the hand as the camera sees it (mirrored).
  const iw = INSET, ih = INSET / aspect, ix = 16, iy = h - ih - 16
  g.fillStyle = 'rgba(20, 20, 24, .72)'
  g.fillRect(ix, iy, iw, ih)
  g.strokeStyle = 'rgba(255, 255, 255, .5)'
  g.lineWidth = 1
  g.strokeRect(ix + EDGE * iw, iy + EDGE * ih, REACH * iw, REACH * ih)
  g.fillStyle = 'rgba(255, 255, 255, .9)'
  g.font = '12px ui-monospace, Menlo, monospace'
  g.fillText(`${ms.toFixed(1)} ms/frame, ${times.length} fps`, ix + 8, iy + 18)
  if (!hand) return
  skeleton(i => [ix + hand[2 * i] * iw, iy + hand[2 * i + 1] * ih], 1.5, 2)

  // On the display, through the reach. The anchor is clamped as the engine clamps it.
  skeleton(i => [(hand[2 * i] - EDGE) / REACH * w, (hand[2 * i + 1] - EDGE) / REACH * h], 3, 4)
  g.strokeStyle = `rgb(${acc})`
  g.lineWidth = 2.5
  g.beginPath()
  g.arc(clamp01((hand[2 * ANCHOR] - EDGE) / REACH) * w, clamp01((hand[2 * ANCHOR + 1] - EDGE) / REACH) * h, 14, 0, 2 * Math.PI)
  g.stroke()
}

function skeleton(at, line, dot) {
  g.strokeStyle = `rgb(${acc} / .7)`
  g.fillStyle = `rgb(${acc})`
  g.lineWidth = line
  g.beginPath()
  for (const [a, b] of BONES) {
    g.moveTo(...at(a))
    g.lineTo(...at(b))
  }
  g.stroke()
  for (let i = 0; i < 21; i++) {
    g.beginPath()
    g.arc(...at(i), dot, 0, 2 * Math.PI)
    g.fill()
  }
}

addEventListener('lookma:hand', e => draw(e.detail))
