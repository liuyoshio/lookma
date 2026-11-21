// One frame's hand as the bridge to the app carries it (docs/protocol.md, "hand"). Its own module so
// the worker and the offline check (overlay/dev/hand-check.mjs) share it.

/** MediaPipe's 21 landmarks ({ x, y } as fractions of the frame, as the camera sees it), or
 *  undefined for no hand, as 42 numbers x0, y0 ... x20, y20, or null. x is mirrored (1 - x) so it
 *  runs to the user's right: the one place anything mirrors. z is not sent; nothing uses it. */
export const pack = landmarks => landmarks ? landmarks.flatMap(p => [1 - p.x, p.y]) : null
