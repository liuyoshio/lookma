// Your hand's dot (Hand Gestures): where the camera sees your hand, drawn where the app says
// (window.lookma.hand, checked in main.js). It is not core state, so it skips the snapshot render
// and moves on each call, every camera frame. A bare dot, faint while the hand is open, solid and
// glowing while it pinches; it targets nothing (a scroll goes to the window under the pointer).

import { $, cls, css } from './dom.js'

const el = $('hand')

/** p: { x, y, pinched } in overlay points, or null to hide the dot. */
export function showHand(p) {
  cls(el, 'on', p)
  cls(el, 'pinched', p?.pinched)
  if (p) css(el, 'transform', `translate(${p.x}px,${p.y}px)`)
}
