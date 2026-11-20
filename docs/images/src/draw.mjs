#!/usr/bin/env node
// Draws the diagrams in docs/images/, each as <name>.svg (light) and <name>-dark.svg.
// One template per diagram, two palettes. The brand art is read from brand/.
//   node docs/images/src/draw.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BRAND = path.resolve(OUT, '../../brand')

const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif"
const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"

// Coral marks the agent's hands and Lookma's own parts; yellow is "you are busy"; nothing else is loud.
const THEMES = {
  light: {
    panel: '#F7F2EC', surface: '#FFFFFF', sunk: '#FBF8F4', line: '#E3D9CF', ink: '#1B1B1F', ink2: '#4F4A46',
    muted: '#857D77', coral: '#FF805C', coralText: '#C94A24', wash: '#FDE9E0', arrow: '#9A918A',
    track: '#EAE2D9', bar: '#E9603A', good: '#1E7F38', goodFill: '#34C759',
    wall: ['#DCE3EC', '#B9C4D2', '#EBDAD2'], menu: 'rgba(255,255,255,.55)', menuInk: '#1B1B1F',
  },
  dark: {
    panel: '#18181C', surface: '#232328', sunk: '#1E1E23', line: '#36363E', ink: '#F2EEEA', ink2: '#C9C3BD',
    muted: '#8F8A93', coral: '#FF805C', coralText: '#FF8F6E', wash: '#3A2620', arrow: '#77727C',
    track: '#2C2C33', bar: '#E9603A', good: '#4CD964', goodFill: '#34C759',
    wall: ['#4A5568', '#272C37', '#6B5D6C'], menu: 'rgba(16,18,24,.55)', menuInk: '#FFFFFF',
  },
}

// ------------------------------------------------------------------ primitives

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const attrs = o => Object.entries(o).filter(([, v]) => v != null && v !== false)
  .map(([k, v]) => ` ${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}="${v}"`).join('')

/** text(x, y, 'plain' | [['run', {fontWeight: 700}], ...], {size, weight, fill, anchor, ...}) */
function text(x, y, s, o = {}) {
  const { size = 13, weight, fill, anchor, family, ls, opacity } = o
  const body = Array.isArray(s)
    ? s.map(([t, a = {}]) => `<tspan${attrs(a)}>${esc(t)}</tspan>`).join('')
    : esc(s)
  return `<text${attrs({ x, y, fontSize: size, fontWeight: weight, fill, textAnchor: anchor, fontFamily: family, letterSpacing: ls, fillOpacity: opacity })}>${body}</text>`
}
const rect = (x, y, w, h, o = {}) => `<rect${attrs({ x, y, width: w, height: h, ...o })}/>`
const line = (x1, y1, x2, y2, o = {}) => `<line${attrs({ x1, y1, x2, y2, ...o })}/>`
const circle = (cx, cy, r, o = {}) => `<circle${attrs({ cx, cy, r, ...o })}/>`
const pathEl = (d, o = {}) => `<path${attrs({ d, ...o })}/>`

/** An arrow from (x1,y1) to (x2,y2). `both` puts a head on each end. */
function arrow(c, x1, y1, x2, y2, { color = c.arrow, width = 1.6, both = false, dash } = {}) {
  const id = markerId(color)
  return `<path d="M${x1} ${y1}L${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linecap="round" marker-end="url(#${id})"${both ? ` marker-start="url(#${id})"` : ''}/>`
}
function curve(c, d, { color = c.arrow, width = 1.6, both = false } = {}) {
  const id = markerId(color)
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" marker-end="url(#${id})"${both ? ` marker-start="url(#${id})"` : ''}/>`
}
let markers = new Map()
const markerId = color => {
  if (!markers.has(color)) markers.set(color, `ah${markers.size}`)
  return markers.get(color)
}
const markerDefs = () => [...markers].map(([color, id]) =>
  `<marker id="${id}" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M1.2 1.2L8.8 5L1.2 8.8Z" fill="${color}"/></marker>`).join('')

function svg(c, w, h, title, desc, body, defs = '') {
  const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t d" font-family="${SANS}">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<defs>${markerDefs()}
<filter id="shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="6" stdDeviation="9" flood-color="#000" flood-opacity=".28"/></filter>
<filter id="soft" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity=".10"/></filter>
<filter id="glow" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="5"/></filter>
<filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="22"/></filter>
${defs}</defs>
${rect(0, 0, w, h, { rx: 18, fill: c.panel })}
${body}
</svg>
`
  markers = new Map()
  return out
}

// A node: rounded box with an optional coral accent.
const box = (c, x, y, w, h, o = {}) => rect(x, y, w, h, { rx: o.rx ?? 14, fill: o.fill ?? c.surface, stroke: o.stroke ?? c.line, strokeWidth: o.sw ?? 1.2, strokeDasharray: o.dash, filter: o.shadow ? 'url(#soft)' : null })
const caps = (c, x, y, s, o = {}) => text(x, y, s.toUpperCase(), { size: 11.5, weight: 700, ls: 1.4, fill: o.fill ?? c.muted, anchor: o.anchor })
const chip = (c, x, y, s, o = {}) => {
  const w = o.w ?? Math.round(s.length * 7.1 + 22)
  return rect(x, y, w, 24, { rx: 12, fill: o.fill ?? c.sunk, stroke: o.stroke ?? c.line, strokeWidth: 1 }) +
    text(x + w / 2, y + 16.5, s, { size: 12.5, anchor: 'middle', fill: o.ink ?? c.ink2, weight: o.weight })
}

// ------------------------------------------------------------------ brand art

const inner = file => fs.readFileSync(path.join(BRAND, file), 'utf8')
  .replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>.*?<\/title>/, '')
/** The app icon (the dark tile with the seal), at any size. */
const appIcon = (x, y, size) => `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 32 32">${inner('icon-small.svg').replace(/id="bg"/g, 'id="ai-bg"').replace(/url\(#bg\)/g, 'url(#ai-bg)').replace(/id="tile"/g, 'id="ai-tile"').replace(/url\(#tile\)/g, 'url(#ai-tile)')}</svg>`
/** The menu bar glyph, in one color. */
const menuGlyph = (x, y, size, color) => `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 18 18"><g fill="${color}">${inner('menubar.svg').replace(/id="eyes"/g, 'id="mb-eyes"').replace(/url\(#eyes\)/g, 'url(#mb-eyes)').replace(/stroke="#000"/g, `stroke="${color}"`)}</g></svg>`

// ------------------------------------------------------------------ overlay pieces (the real UI, same in both themes)

const GLASS = '#1C1C21'
const MIC = (x, y, s, color) => `<g transform="translate(${x} ${y}) scale(${s / 16})" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round"><rect x="5.5" y="1.8" width="5" height="8" rx="2.5"/><path d="M3.2 8a4.8 4.8 0 0 0 9.6 0M8 12.8v1.8"/></g>`
const ghostCursor = (x, y, s = 1) => `<g transform="translate(${x - 2 * s} ${y - 2 * s}) scale(${s})"><path d="M2 2v20.5l5.1-5 3.3 7.6 3.3-1.4-3.2-7.5h7z" fill="#FF805C" opacity=".55" filter="url(#glow)"/><path d="M2 2v20.5l5.1-5 3.3 7.6 3.3-1.4-3.2-7.5h7z" fill="#fff" stroke="#FF805C" stroke-width="1.6" stroke-linejoin="round"/></g>`

function ring(x, y, w, h, r) {
  return rect(x - 3, y - 3, w + 6, h + 6, { rx: r + 3, fill: 'none', stroke: '#FF805C', strokeWidth: 9, strokeOpacity: .45, filter: 'url(#glow)' }) +
    rect(x - 4.5, y - 4.5, w + 9, h + 9, { rx: r + 4.5, fill: 'none', stroke: '#FF805C', strokeOpacity: .18, strokeWidth: 4 }) +
    rect(x - 1.5, y - 1.5, w + 3, h + 3, { rx: r + 1.5, fill: 'none', stroke: '#FF805C', strokeWidth: 3 }) +
    rect(x, y, w, h, { rx: r, fill: 'none', stroke: '#fff', strokeOpacity: .8, strokeWidth: 1 })
}
function stepLabel(x, y, s, w) {
  return rect(x, y, w, 24, { rx: 12, fill: GLASS, fillOpacity: .96, stroke: '#fff', strokeOpacity: .17, strokeWidth: .6, filter: 'url(#shadow)' }) +
    circle(x + 13, y + 12, 6, { fill: '#FF805C', fillOpacity: .28 }) + circle(x + 13, y + 12, 3.6, { fill: '#FF805C' }) +
    text(x + 24, y + 16.2, s, { size: 11.5, fill: '#fff', opacity: .94 })
}
function card(x, y, w, question, { hint = 'Say “yes, I approve”' } = {}) {
  const h = 104
  return rect(x, y, w, h, { rx: 16, fill: GLASS, fillOpacity: .97, stroke: '#fff', strokeOpacity: .17, strokeWidth: .6, filter: 'url(#shadow)' }) +
    circle(x + 17, y + 20, 3, { fill: '#fff', fillOpacity: .85 }) +
    text(x + 26, y + 24, 'Needs your approval', { size: 11, fill: '#fff', opacity: .55 }) +
    text(x + 14, y + 49, question, { size: 15, weight: 600, fill: '#fff' }) +
    MIC(x + 13, y + 72, 13, 'rgba(255,255,255,.6)') +
    text(x + 30, y + 83, hint, { size: 11.5, fill: '#fff', opacity: .62 }) +
    rect(x + w - 156, y + 67, 66, 25, { rx: 7, fill: '#fff', fillOpacity: .13 }) +
    text(x + w - 123, y + 83.5, 'Decline', { size: 12, anchor: 'middle', fill: '#fff', opacity: .92 }) +
    rect(x + w - 84, y + 67, 70, 25, { rx: 7, fill: '#fff', fillOpacity: .94 }) +
    text(x + w - 49, y + 83.5, 'Approve', { size: 12, weight: 600, anchor: 'middle', fill: '#1D1D1F' })
}
function voiceBars(x, y, color = '#fff') {
  const hs = [5, 9, 12, 8, 4]
  return hs.map((h, i) => rect(x + i * 3.6, y - h / 2, 2, h, { rx: 1, fill: color, fillOpacity: .92 })).join('')
}
function capsule(x, y, w, { said, sent, status, meta, icon = 'wait' }) {
  const h = 86
  const ic = icon === 'wait'
    ? circle(x + 50, y + 69, 5, { fill: 'none', stroke: '#fff', strokeOpacity: .85, strokeWidth: 1.6 })
    : circle(x + 50, y + 69, 5, { fill: 'none', stroke: '#FF805C', strokeWidth: 1.6, strokeDasharray: '20 12' })
  return rect(x, y, w, h, { rx: 22, fill: GLASS, fillOpacity: .97, stroke: '#fff', strokeOpacity: .17, strokeWidth: .6, filter: 'url(#shadow)' }) +
    voiceBars(x + 17, y + 22) +
    text(x + 44, y + 27, `“${said}”`, { size: 13, weight: 500, fill: '#fff' }) +
    rect(x + 44, y + 35, 38, 16, { rx: 4, fill: 'none', stroke: '#fff', strokeOpacity: .25, strokeWidth: .7 }) +
    text(x + 63, y + 46.5, 'Doing', { size: 9.5, anchor: 'middle', fill: '#fff', opacity: .55 }) +
    text(x + 90, y + 47, sent, { size: 11.5, fill: '#fff', opacity: .72 }) +
    line(x + 44, y + 57.5, x + w - 18, y + 57.5, { stroke: '#fff', strokeOpacity: .13, strokeWidth: .7 }) +
    ic + text(x + 62, y + 73, status, { size: 12, fill: '#fff', opacity: .92 }) +
    (meta ? text(x + w - 18, y + 73, meta, { size: 10, anchor: 'end', fill: '#fff', opacity: .42 }) : '')
}
function edgeTab(xRight, y, s) {
  const w = 236
  const x = xRight - w
  return rect(x, y, w + 20, 34, { rx: 17, fill: GLASS, fillOpacity: .97, stroke: '#fff', strokeOpacity: .17, strokeWidth: .6, filter: 'url(#shadow)' }) +
    circle(x + 15, y + 17, 6, { fill: '#FFD60A', fillOpacity: .22 }) + circle(x + 15, y + 17, 3.6, { fill: '#FFD60A' }) +
    text(x + 26, y + 21.5, s, { size: 11.5, fill: '#fff', opacity: .92 }) +
    rect(x + 146, y + 5, 70, 24, { rx: 12, fill: '#fff', fillOpacity: .94 }) +
    text(x + 181, y + 21, 'Go ahead', { size: 11.5, weight: 600, anchor: 'middle', fill: '#1D1D1F' }) +
    pathEl(`M${x + 222} ${y + 13}l4 4-4 4`, { fill: 'none', stroke: '#fff', strokeOpacity: .6, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' })
}

/** A desktop: wallpaper and menu bar, clipped to the screen. */
function desktop(c, id, x, y, w, h, content, { app = 'Atlas', menus = ['File', 'Edit', 'View', 'Window'] } = {}) {
  const [a, b, glow] = c.wall
  const defs = `<linearGradient id="${id}-w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
<radialGradient id="${id}-g" cx="${x + w * .82}" cy="${y + h * .9}" r="${w * .45}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${glow}" stop-opacity=".75"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>
<clipPath id="${id}-c"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/></clipPath>`
  let mx = x + 14
  const menuText = [text(mx, y + 15.5, app, { size: 11, weight: 700, fill: c.menuInk })]
  mx += app.length * 7 + 16
  for (const m of menus) { menuText.push(text(mx, y + 15.5, m, { size: 11, fill: c.menuInk, opacity: .9 })); mx += m.length * 6.4 + 16 }
  const body = `<g clip-path="url(#${id}-c)">
${rect(x, y, w, h, { fill: `url(#${id}-w)` })}${rect(x, y, w, h, { fill: `url(#${id}-g)` })}
${rect(x, y, w, 22, { fill: c.menu })}${menuText.join('')}
${menuGlyph(x + w - 34, y + 3, 16, c.menuInk)}
${content}
</g>${rect(x + .5, y + .5, w - 1, h - 1, { rx: 12, fill: 'none', stroke: c.line, strokeWidth: 1 })}`
  return { defs, body }
}

/** A plain map window ("Atlas", a made-up app). */
function atlasWindow(x, y, w, h) {
  const top = y + 26
  const id = `atlas${x}`
  return `<g filter="url(#shadow)">${rect(x, y, w, h, { rx: 10, fill: '#EEE8DC' })}</g>
<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/></clipPath>
<g clip-path="url(#${id})">
${pathEl(`M${x + w * .6} ${y + h}L${x + w * .68} ${y + h * .74}Q${x + w * .8} ${y + h * .6} ${x + w} ${y + h * .64}L${x + w} ${y + h}Z`, { fill: '#AFCDEA' })}
<ellipse cx="${x + w * .22}" cy="${y + h * .78}" rx="${w * .16}" ry="${h * .12}" fill="#C6DFB5"/>
${[[0, .52, 1, .42], [.4, .12, .54, 1], [.06, 1, .8, .26]].map(([x1, y1, x2, y2]) =>
    line(x + w * x1, y + h * y1, x + w * x2, y + h * y2, { stroke: '#DCD2C1', strokeWidth: 9, strokeLinecap: 'round' }) +
    line(x + w * x1, y + h * y1, x + w * x2, y + h * y2, { stroke: '#fff', strokeWidth: 6, strokeLinecap: 'round' })).join('')}
${[[.6, .55], [.79, .5], [.5, .84]].map(([px, py]) => {
    const cx = x + w * px, cy = y + h * py
    return pathEl(`M${cx} ${cy}c-5.5-6.5-8-10-8-13.5a8 8 0 0 1 16 0c0 3.5-2.5 7-8 13.5z`, { fill: '#3E6FD8', stroke: '#fff', strokeWidth: 1.5 }) + circle(cx, cy - 13.5, 2.8, { fill: '#fff' })
  }).join('')}
${rect(x, y, w, 26, { fill: '#F3F2F1' })}${line(x, top, x + w, top, { stroke: '#000', strokeOpacity: .1 })}
${['#FF5F57', '#FEBC2E', '#28C840'].map((f, i) => circle(x + 14 + i * 16, y + 13, 5, { fill: f })).join('')}
${text(x + w / 2, y + 17.5, 'Atlas', { size: 11.5, weight: 600, anchor: 'middle', fill: '#3A3A3C' })}
</g>`
}

// ------------------------------------------------------------------ 1. overlay anatomy

function overlayAnatomy(c) {
  const X0 = 210, Y0 = 24, W = 580, H = 440
  const wx = X0 + 20, wy = Y0 + 38, ww = 300, wh = 222
  const fx = wx + 14, fy = wy + 38, fw = 206, fh = 26
  const lx = fx + 18, ly = fy + fh + 14
  const tip = [fx + fw - 34, fy + 15]
  const cw = 324, cx = X0 + (W - cw) / 2, cy = Y0 + 220
  const pw = 456, px = X0 + (W - pw) / 2, py = cy + 114

  const scene = atlasWindow(wx, wy, ww, wh) +
    // the search field the agent is about to use
    `<g filter="url(#soft)">${rect(fx, fy, fw, fh, { rx: 8, fill: '#fff' })}</g>` +
    circle(fx + 14, fy + 12, 4.2, { fill: 'none', stroke: '#8E8E93', strokeWidth: 1.5 }) + line(fx + 17, fy + 15, fx + 20, fy + 18, { stroke: '#8E8E93', strokeWidth: 1.5, strokeLinecap: 'round' }) +
    text(fx + 28, fy + 17.5, 'ramen near the ferry', { size: 11.5, fill: '#1D1D1F' }) +
    ring(fx, fy, fw, fh, 9) +
    stepLabel(lx, ly, 'Search for ramen', 128) +
    card(cx, cy, cw, 'Allow controlling Jot?') +
    capsule(px, py, pw, { said: 'Find three ramen places and put them in a new note', sent: 'Search Atlas for ramen, save three in a new Jot note', status: 'Waiting for your approval', meta: 'Jot' }) +
    ghostCursor(tip[0], tip[1], 1.05)

  const d = desktop(c, 'desk', X0, Y0, W, H, scene)

  // callouts: a title and one or two short lines, with a leader to the part
  const callout = (side, x, y, title, lines, to) => {
    const anchor = side === 'left' ? 'end' : 'start'
    const lx0 = side === 'left' ? x + 10 : x - 10
    return text(x, y, title, { size: 14.5, weight: 700, fill: c.ink, anchor }) +
      lines.map((l, i) => text(x, y + 18.5 + i * 17.5, l, { size: 13.5, fill: c.ink2, anchor })).join('') +
      pathEl(`M${lx0} ${y - 5}L${to[0]} ${to[1]}`, { fill: 'none', stroke: c.ink, strokeOpacity: .55, strokeWidth: 1.2 }) +
      circle(to[0], to[1], 3.6, { fill: c.ink, stroke: c.surface, strokeWidth: 1.8 })
  }
  const L = 194, R = 806
  const callouts =
    callout('left', L, 92, 'Coral ring', ['Lands on the target', 'a beat before it acts.'], [fx - 6, fy + 6]) +
    callout('left', L, 172, 'Step label', ['What this step does,', 'in your language.'], [lx - 1, ly + 12]) +
    callout('left', L, 292, 'Approval card', ['Comes with a chime.', 'Answer out loud or click.'], [cx - 1, cy + 40]) +
    callout('left', L, 392, 'Capsule', ['Grows while it works,', 'then shrinks away.'], [px - 1, py + 42]) +
    callout('right', R, 40, 'Menu bar', ['Talk, Pause (⌃⌥P),', 'Type a Request…, Quit.'], [X0 + W - 14, Y0 + 11]) +
    callout('right', R, 128, 'Ghost cursor', ['The agent’s hand.', 'Your cursor stays yours.'], [tip[0] + 19, tip[1] + 12]) +
    callout('right', R, 330, 'Your words', ['As it heard them, so a', 'mishearing shows at once.'], [px + pw - 22, py + 22]) +
    callout('right', R, 400, 'Doing', ['The exact request', 'handed to the agent.'], [px + pw - 26, py + 43]) +
    callout('right', R, 462, 'Status', ['The current step.'], [px + pw - 84, py + 69])

  // the edge tab replaces the marks while you are busy, so it gets its own strip
  const by = Y0 + H + 34
  const strip = `<clipPath id="strip-c"><rect x="${X0 + 250}" y="${by}" width="${W - 250}" height="54" rx="10"/></clipPath>
<g clip-path="url(#strip-c)">${rect(X0 + 250, by, W - 250, 54, { fill: `url(#desk-w)` })}${edgeTab(X0 + W, by + 10, 'Waiting to use Jot')}</g>` +
    rect(X0 + 250.5, by + .5, W - 251, 53, { rx: 10, fill: 'none', stroke: c.line })
  const busy = text(X0, by + 18, 'While you type', { size: 14.5, weight: 700, fill: c.ink }) +
    text(X0, by + 36.5, 'The marks step aside. A yellow tab says', { size: 13.5, fill: c.ink2 }) +
    text(X0, by + 54, 'where it works, or that it waits for you.', { size: 13.5, fill: c.ink2 })

  return svg(c, 1000, by + 74, 'What Lookma shows on screen',
    'A desktop with a map app. A coral ring and a ghost cursor sit on the search field, with a step label under it. An approval card asks "Allow controlling Jot?" above the capsule, which shows your words, what it is doing and its status. A strip below shows the yellow tab at the screen edge, "Waiting to use Jot", with a Go ahead button.',
    d.body + callouts + busy + strip, d.defs)
}

// ------------------------------------------------------------------ 2. architecture

function architecture(c) {
  const person = (cx, cy) => circle(cx, cy, 46, { fill: c.surface, stroke: c.line, strokeWidth: 1.2 }) +
    circle(cx, cy - 12, 12, { fill: c.ink2 }) + pathEl(`M${cx - 22} ${cy + 24}a22 20 0 0 1 44 0z`, { fill: c.ink2 })
  const cloudGlyph = (x, y, color) => pathEl(`M${x + 7} ${y + 18}h15a6 6 0 0 0 .5-12a8 8 0 0 0-15.4 1.8a5.2 5.2 0 0 0-.1 10.2z`, { fill: 'none', stroke: color, strokeWidth: 1.8, strokeLinejoin: 'round' })
  const tile = (x, y, fill, glyph) => rect(x, y, 40, 40, { rx: 10, fill }) + glyph
  const tiles = (x, y) =>
    tile(x, y, '#FFD66B', [12, 19, 26].map(ly => line(x + 10, y + ly, x + 30, y + ly, { stroke: '#8A6A12', strokeWidth: 2, strokeLinecap: 'round' })).join('')) +
    tile(x + 52, y, '#5FB878', pathEl(`M${x + 72} ${y + 31}c-6-7-8.5-10.5-8.5-14a8.5 8.5 0 0 1 17 0c0 3.5-2.5 7-8.5 14z`, { fill: '#fff' }) + circle(x + 72, y + 17, 3, { fill: '#5FB878' })) +
    tile(x + 104, y, '#4C8DF0', circle(x + 124, y + 20, 10, { fill: 'none', stroke: '#fff', strokeWidth: 1.8 }) + pathEl(`M${x + 114} ${y + 20}h20M${x + 124} ${y + 10}c-5 6-5 14 0 20c5-6 5-14 0-20`, { fill: 'none', stroke: '#fff', strokeWidth: 1.6 })) +
    tile(x + 156, y, '#8E8E96', circle(x + 176, y + 20, 6, { fill: 'none', stroke: '#fff', strokeWidth: 2 }) + circle(x + 176, y + 20, 11, { fill: 'none', stroke: '#fff', strokeWidth: 3, strokeDasharray: '3.4 2.4' }))

  const body = [
    // OpenAI Realtime, outside the Mac
    box(c, 320, 22, 200, 56, { rx: 28, fill: c.surface }),
    cloudGlyph(338, 37, c.muted),
    text(374, 46, 'OpenAI Realtime', { size: 16, weight: 700, fill: c.ink }),
    text(374, 64, 'the voice', { size: 13.5, fill: c.muted }),
    // your Mac
    rect(200, 120, 780, 440, { rx: 22, fill: 'none', stroke: c.muted, strokeOpacity: .7, strokeWidth: 1.3, strokeDasharray: '5 5' }),
    caps(c, 222, 146, 'Your Mac'),
    // you
    person(100, 262),
    text(100, 336, 'You', { size: 16, weight: 700, anchor: 'middle', fill: c.ink }),
    text(100, 355, 'talk, watch, approve', { size: 13.5, anchor: 'middle', fill: c.muted }),
    // Lookma.app
    box(c, 228, 160, 392, 190, { rx: 16, stroke: c.coral, sw: 2, shadow: true }),
    appIcon(244, 170, 26),
    text(278, 189, 'Lookma.app', { size: 16, weight: 700, fill: c.ink }),
    text(604, 189, 'menu bar app', { size: 13.5, anchor: 'end', fill: c.muted }),
    box(c, 244, 208, 176, 126, { rx: 12, fill: c.sunk }),
    text(260, 234, 'Overlay', { size: 16, weight: 700, fill: c.ink }),
    ...['voice · captions', 'ring · ghost cursor', 'approval cards'].map((s, i) => text(260, 258 + i * 21, s, { size: 14, fill: c.ink2 })),
    box(c, 432, 208, 172, 126, { rx: 12, fill: c.sunk }),
    text(448, 234, 'Hands', { size: 16, weight: 700, fill: c.ink }),
    ...['Accessibility', 'screenshots', 'mouse · keyboard'].map((s, i) => text(448, 258 + i * 21, s, { size: 14, fill: c.ink2 })),
    // core
    box(c, 228, 410, 392, 124, { rx: 16, stroke: c.coral, sw: 2, shadow: true }),
    text(248, 440, 'Core', { size: 16, weight: 700, fill: c.ink }),
    text(604, 440, 'Node · 127.0.0.1', { size: 12, anchor: 'end', fill: c.muted, family: MONO }),
    chip(c, 248, 455, 'turn', { w: 52 }), chip(c, 308, 455, 'focus', { w: 58 }), chip(c, 374, 455, 'attention', { w: 86 }), chip(c, 468, 455, 'cards', { w: 58 }),
    text(248, 513, 'It decides; the other parts only do.', { size: 14, fill: c.ink2 }),
    // your apps
    box(c, 704, 208, 240, 126, { rx: 14, shadow: true }),
    text(720, 234, 'Your apps', { size: 16, weight: 700, fill: c.ink }),
    tiles(720, 250),
    text(720, 318, 'real windows, on your screen', { size: 13.5, fill: c.muted }),
    // Claude Code
    box(c, 713, 419, 240, 124, { rx: 16, fill: 'none', stroke: c.muted, dash: '4 4' }),
    box(c, 704, 410, 240, 124, { rx: 16, shadow: true }),
    text(720, 440, 'Claude Code', { size: 16, weight: 700, fill: c.ink }),
    rect(856, 425, 78, 22, { rx: 11, fill: c.wash }),
    text(895, 440.5, 'swappable', { size: 11.5, weight: 700, anchor: 'middle', fill: c.coralText }),
    text(720, 466, 'the executor, in tmux', { size: 14, fill: c.ink2 }),
    text(720, 487, 'on your Claude plan', { size: 14, fill: c.ink2 }),
    text(720, 516, 'or any agent behind the adapter', { size: 12, fill: c.muted }),

    // flows
    arrow(c, 150, 262, 240, 262, { both: true }),
    text(186, 252, 'talk', { size: 13.5, anchor: 'middle', fill: c.muted }),
    text(186, 283, 'see, hear', { size: 13.5, anchor: 'middle', fill: c.muted }),
    arrow(c, 400, 82, 400, 204, { both: true, dash: '5 4' }),
    text(412, 104, 'audio, while it listens', { size: 13.5, fill: c.muted }),
    arrow(c, 312, 338, 312, 406),
    text(302, 368, 'your words,', { size: 13.5, anchor: 'end', fill: c.muted }),
    text(302, 384, 'answers', { size: 13.5, anchor: 'end', fill: c.muted }),
    arrow(c, 346, 406, 346, 338),
    text(356, 376, 'state', { size: 13.5, fill: c.muted }),
    arrow(c, 518, 338, 518, 406, { both: true, color: c.coral }),
    text(530, 368, 'one step', { size: 13.5, fill: c.muted }),
    text(530, 384, 'at a time', { size: 13.5, fill: c.muted }),
    arrow(c, 624, 262, 700, 262, { color: c.coral, width: 2 }),
    text(662, 252, 'see, click,', { size: 13.5, anchor: 'middle', fill: c.muted }),
    text(662, 283, 'type, scroll', { size: 13.5, anchor: 'middle', fill: c.muted }),
    arrow(c, 622, 455, 700, 455),
    text(661, 446, 'prompts', { size: 13.5, anchor: 'middle', fill: c.muted }),
    arrow(c, 700, 490, 622, 490),
    text(661, 510, 'hands, say', { size: 13.5, anchor: 'middle', fill: c.muted }),
  ].join('\n')
  return svg(c, 1000, 580, 'How Lookma fits together',
    'You talk to the overlay in Lookma.app, which streams your microphone to OpenAI Realtime while it listens. The overlay passes your words to the core on 127.0.0.1. The core prompts Claude Code, the swappable executor, which calls back with hands steps. The core runs each step through the app\'s hands, which see, click and type in your real apps.',
    body)
}

// ------------------------------------------------------------------ 3. approvals

function approvals(c) {
  const src = (x, tag, title, ask, back) =>
    box(c, x, 24, 300, 156, { shadow: true }) +
    caps(c, x + 18, 50, tag, { fill: c.coralText }) +
    text(x + 18, 77, title, { size: 16.5, weight: 700, fill: c.ink }) +
    text(x + 18, 100, ask, { size: 14, fill: c.ink2 }) +
    line(x + 18, 118, x + 282, 118, { stroke: c.line }) +
    text(x + 18, 140, 'The answer goes back', { size: 12.5, fill: c.muted }) +
    text(x + 18, 161, back, { size: 14, fill: c.ink2 })

  const ex = (x, y, s, ok) => {
    const w = Math.round(s.length * 7.6 + 42)
    return rect(x, y, w, 26, { rx: 13, fill: c.sunk, stroke: c.line }) +
      text(x + 12, y + 18, s, { size: 13.5, fill: c.ink }) +
      (ok
        ? circle(x + w - 15, y + 13, 7.5, { fill: c.goodFill }) + pathEl(`M${x + w - 18.5} ${y + 13}l2.4 2.4 4.4-4.6`, { fill: 'none', stroke: '#fff', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' })
        : circle(x + w - 15, y + 13, 7.5, { fill: c.muted, fillOpacity: .5 }) + pathEl(`M${x + w - 18} ${y + 10}l6 6m0-6l-6 6`, { stroke: '#fff', strokeWidth: 1.6, strokeLinecap: 'round' }))
  }
  const shield = (x, y) => pathEl(`M${x} ${y}l8 3v6c0 5-3.5 8-8 9.5c-4.5-1.5-8-4.5-8-9.5v-6z`, { fill: c.coral })

  const cx = 340, cy = 252, cw = 320
  const body = [
    src(20, 'Lookma core', 'First time in an app', '“Allow controlling Jot?”', 'The waiting step goes on, or fails.'),
    src(350, 'Claude Code · channel', 'A tool permission', '“Run a command: …”', 'Allow or deny, through the channel.'),
    src(680, 'Claude Code · terminal', 'A terminal-only dialog', 'The startup warning, folder access', 'Arrow keys and Enter, in tmux.'),
    curve(c, `M170 184C170 222 ${cx + 60} 214 ${cx + 70} ${cy - 6}`, { both: true }),
    arrow(c, 500, 184, 500, cy - 6, { both: true }),
    curve(c, `M830 184C830 222 ${cx + cw - 60} 214 ${cx + cw - 70} ${cy - 6}`, { both: true }),
    `<ellipse cx="500" cy="${cy + 52}" rx="200" ry="70" fill="${c.coral}" fill-opacity=".16" filter="url(#blur)"/>`,
    card(cx, cy, cw, 'Allow controlling Jot?'),
    text(20, 288, 'One card, whatever asked.', { size: 16.5, weight: 700, fill: c.ink }),
    text(20, 311, 'Approve always means “this once”,', { size: 14, fill: c.ink2 }),
    text(20, 330, 'never “always allow”.', { size: 14, fill: c.ink2 }),
    text(980, 288, 'It chimes, so you notice.', { size: 16.5, weight: 700, fill: c.ink, anchor: 'end' }),
    text(980, 311, 'Answering in the terminal', { size: 14, fill: c.ink2, anchor: 'end' }),
    text(980, 330, 'yourself closes it too.', { size: 14, fill: c.ink2, anchor: 'end' }),
    // the gate and the two ways to answer
    box(c, 120, 392, 390, 60, { rx: 14, fill: c.wash, stroke: c.coral, sw: 1.2 }),
    shield(148, 407),
    text(166, 418, 'Consent gate', { size: 15, weight: 700, fill: c.ink }),
    text(140, 440, 'explicit yes · 1 s after the card · not its own echo', { size: 13.5, fill: c.ink2 }),
    arrow(c, 315, 390, 430, cy + 108),
    box(c, 120, 486, 400, 106, { shadow: true }),
    MIC(140, 503, 18, c.ink),
    text(166, 518, 'Say it', { size: 16.5, weight: 700, fill: c.ink }),
    text(226, 518, 'English or Chinese', { size: 13.5, fill: c.muted }),
    ex(140, 540, '“yes, I approve”', true), ex(306, 540, '“ok”', false), ex(390, 540, '“approve?”', false),
    arrow(c, 315, 482, 315, 456),
    box(c, 560, 486, 320, 106, { shadow: true }),
    pathEl('M582 500v17.5l4.4-4.3 2.8 6.5 2.8-1.2-2.7-6.4h6z', { fill: c.surface, stroke: c.ink, strokeWidth: 1.4, strokeLinejoin: 'round' }),
    text(606, 518, 'Or click', { size: 16.5, weight: 700, fill: c.ink }),
    text(580, 547, 'Approve or Decline on the card.', { size: 14, fill: c.ink2 }),
    text(580, 568, 'Always works, in any language.', { size: 14, fill: c.ink2 }),
    arrow(c, 720, 482, 590, cy + 108),
  ].join('\n')
  return svg(c, 1000, 612, 'Where approval cards come from',
    'Three sources raise the same approval card: the Lookma core the first time it touches an app, a Claude Code tool permission relayed through the channel, and dialogs that only appear in Claude Code\'s terminal. You answer by voice, through a consent gate that needs an explicit yes, or by clicking. The answer goes back the way the question came.',
    body)
}

// ------------------------------------------------------------------ 4. consent chart

function consentChart(c) {
  const x0 = 450, span = 400, bh = 18
  const row = (y, title, sub, n, of) => {
    const w = Math.max(0, span * n / of)
    const pct = Math.round(100 * n / of)
    const end = x0 + w
    return text(32, y + 4, title, { size: 14.5, weight: 600, fill: c.ink }) +
      text(32, y + 23, sub, { size: 12.5, fill: c.muted }) +
      rect(x0, y - 7, span, bh, { rx: 4, fill: c.track }) +
      (w ? pathEl(`M${x0} ${y - 7}h${w - 4}a4 4 0 0 1 4 4v${bh - 8}a4 4 0 0 1-4 4h-${w - 4}z`, { fill: c.bar }) : '') +
      text(x0 + span + 14, y + 7, [[`${n} of ${of}`, { fontWeight: 700 }], [`  ${pct}%`, { fill: c.muted }]], { size: 13.5, fill: c.ink })
  }
  const body = [
    text(32, 48, 'A voice model alone says yes too easily', { size: 19, weight: 700, fill: c.ink }),
    text(32, 72, 'Times it approved a card although the person had not said yes. From the voice-approval experiment.', { size: 13, fill: c.ink2 }),
    caps(c, 32, 112, 'The voice model alone'),
    line(32, 122, 968, 122, { stroke: c.line }),
    row(152, 'A lone “approve?”, asked back', 'said as a question, rising tone', 15, 15),
    row(208, '“Go ahead”, 0.3 s after the card', 'meant for something else', 11, 16),
    row(264, 'Its own voice, leaking into the mic', 'the assistant hears itself', 4, 12),
    caps(c, 32, 324, 'With Lookma’s consent gate'),
    line(32, 334, 968, 334, { stroke: c.line }),
    text(32, 368, 'Every must-not case', { size: 14.5, weight: 600, fill: c.ink }),
    text(32, 387, '4 runs × 52: no, wait, echoes, too early', { size: 12.5, fill: c.muted }),
    rect(x0, 357, span, bh, { rx: 4, fill: c.track }),
    text(x0 + span + 14, 371, [['0 of 169', { fontWeight: 700 }], ['  0%', { fill: c.muted }]], { size: 13.5, fill: c.ink }),
    circle(x0 + 16, 366, 11, { fill: c.goodFill }),
    pathEl(`M${x0 + 10.5} 366l3.8 3.8 6.6-7`, { fill: 'none', stroke: '#fff', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    text(x0 + 36, 371, 'never approved', { size: 13.5, weight: 600, fill: c.good }),
  ].join('\n')
  return svg(c, 1000, 418, 'Voice approvals, with and without the gate',
    'Bar chart. The voice model alone approved a lone "approve?" asked back 15 of 15 times, a "go ahead" said 0.3 seconds after the card 11 of 16 times, and its own leaked voice 4 of 12 times. With Lookma\'s consent gate, 0 of 169 must-not cases were approved.',
    body)
}

// ------------------------------------------------------------------ 5. the hands pipeline

function handsPipeline(c) {
  const steps = [
    ['Resolve', ['element id, point,', 'Dock icon, or app']],
    ['Grant', ['first time in this', 'app? one card']],
    ['Attention', ['keys or mouse used', 'in the last 3 s?']],
    ['Mark', ['ring, label, ghost', 'cursor, ~350 ms early']],
    ['Act', ['AX press, or input', 'that lands on target']],
  ]
  const W = 172, G = 21, X = 20, Y = 92
  const st = steps.map(([title, lines], i) => {
    const x = X + i * (W + G)
    const hot = i === 3
    return box(c, x, Y, W, 112, { shadow: true, stroke: hot ? c.coral : c.line, sw: hot ? 2 : 1.2 }) +
      circle(x + 26, Y + 28, 12, { fill: hot ? c.coral : c.wash }) +
      text(x + 26, Y + 32.5, String(i + 1), { size: 12.5, weight: 700, anchor: 'middle', fill: hot ? '#fff' : c.coralText }) +
      text(x + 46, Y + 33.5, title, { size: 16.5, weight: 700, fill: c.ink }) +
      lines.map((l, j) => text(x + 16, Y + 66 + j * 21, l, { size: 14, fill: c.ink2 })).join('') +
      (i < steps.length - 1 ? arrow(c, x + W + 3, Y + 56, x + W + G - 3, Y + 56) : '')
  }).join('')
  const ax = X + 2 * (W + G), mid = ax + W / 2
  const tool = (x, s) => chip(c, x, 40, s, { w: Math.round(s.length * 7.4 + 22), ink: c.ink, fill: c.surface })
  const tools = ['see', 'click', 'type', 'key', 'scroll', 'open']
  let tx = 168
  const toolChips = tools.map(s => { const w = Math.round(s.length * 7.4 + 22); const out = tool(tx, s); tx += w + 8; return out }).join('')
  const body = [
    text(20, 57, 'Every hands call', { size: 15, weight: 700, fill: c.ink }),
    toolChips,
    text(tx + 6, 57, 'runs the same five steps, one at a time.', { size: 15, fill: c.ink2 }),
    st,
    // attention: the two outcomes
    curve(c, `M${mid - 30} ${Y + 116}C${mid - 30} 250 ${mid - 150} 236 ${mid - 150} 262`),
    curve(c, `M${mid + 30} ${Y + 116}C${mid + 30} 250 ${mid + 150} 236 ${mid + 150} 262`),
    box(c, mid - 330, 266, 300, 80, { fill: c.sunk }),
    text(mid - 314, 292, 'You’re idle', { size: 15.5, weight: 700, fill: c.ink }),
    text(mid - 314, 315, 'The target comes to the front,', { size: 14, fill: c.ink2 }),
    text(mid - 314, 333, 'and the step runs in plain sight.', { size: 14, fill: c.ink2 }),
    box(c, mid + 30, 266, 300, 80, { fill: c.sunk }),
    circle(mid + 52, 287, 5, { fill: '#FFD60A' }),
    text(mid + 64, 292, 'You’re busy', { size: 15.5, weight: 700, fill: c.ink }),
    text(mid + 46, 315, 'Nothing takes the front. Safe steps', { size: 14, fill: c.ink2 }),
    text(mid + 46, 333, 'run behind you; the rest wait.', { size: 14, fill: c.ink2 }),
    // what comes back
    text(980, 384, [['Back to the agent: ', { fill: c.muted }], ['see', { fontWeight: 700, fill: c.ink }], [' returns a screenshot and the elements; the rest, one line.', { fill: c.ink2 }]], { size: 14, anchor: 'end' }),
  ].join('\n')
  return svg(c, 1000, 410, 'The hands pipeline',
    'Every hands call (see, click, type, key, scroll, open) runs five steps: resolve the target, grant (a card the first time in an app), attention (did you use the keyboard or mouse in the last 3 seconds), mark (ring, label and ghost cursor, about 350 ms early), and act. If you are idle, the target comes to the front. If you are busy, nothing takes the front: safe steps run in the background and the rest wait for go ahead.',
    body)
}

// ------------------------------------------------------------------ write

const DIAGRAMS = { 'overlay-anatomy': overlayAnatomy, architecture, approvals, 'consent-chart': consentChart, 'hands-pipeline': handsPipeline }
for (const [name, draw] of Object.entries(DIAGRAMS)) {
  for (const [theme, c] of Object.entries(THEMES)) {
    const file = path.join(OUT, `${name}${theme === 'dark' ? '-dark' : ''}.svg`)
    fs.writeFileSync(file, draw(c))
  }
}
console.log(`drew ${Object.keys(DIAGRAMS).length * 2} files in ${path.relative(process.cwd(), OUT) || '.'}`)
