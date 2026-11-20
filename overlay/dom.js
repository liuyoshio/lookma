// Small DOM helpers shared by the overlay modules. Writes are skipped when nothing
// changed, so re-rendering a whole snapshot costs almost nothing.

export const $ = id => document.getElementById(id)
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

export function txt(el, s) { if (el.textContent !== s) el.textContent = s }
export function cls(el, c, on) { on = !!on; if (el.classList.contains(c) !== on) el.classList.toggle(c, on) }
export function css(el, k, v) { const c = el._s || (el._s = {}); if (c[k] !== v) { c[k] = v; el.style[k] = v } }
export function replay(el, c) { el.classList.remove(c); void el.offsetWidth; el.classList.add(c) }

/** Rects are screen points on the main display, the same as CSS pixels here: { x, y, w, h }. */
export function rectOf(r) {
  if (!r) return null
  const [x, y, w, h] = Array.isArray(r) ? r : [r.x, r.y, r.w ?? r.width, r.h ?? r.height]
  return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0 ? { x, y, w, h } : null
}

/** Points are [x, y] (as in the hands' `click { point }`). */
export function pointOf(p) {
  if (!p) return null
  const [x, y] = Array.isArray(p) ? p : [p.x, p.y]
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

export const onScreen = r => r.x < innerWidth && r.y < innerHeight && r.x + r.w > 0 && r.y + r.h > 0
export const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
