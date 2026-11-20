#!/usr/bin/env node
// Headless check of the overlay against the mock core. Runs the whole scenario once in
// headless Chrome and:
//   - saves a screenshot at every scenario mark to overlay/dev/shots/
//   - clicks Approve on the card and expects {type:'answer', via:'click', allow:true}
//   - clicks Go ahead while the hands wait and expects {type:'goAhead'}
//   - checks the card's rect was posted as a hitRect
//   - types into the hidden input and expects {type:'tell', source:'typed'}; the app is told
//     when the input opens and closes, so it gives the keyboard back
//   - pauses (as the app's menu bar would): a calm capsule that says how to resume
//   - checks nothing animates while nothing is happening
//   - takes one more shot at ?scale=1.75 (TV distance)
//   - fails on any console error, warning or uncaught exception
//
//   node overlay/dev/shoot.mjs [--port 8797] [--cdp 8798] [--speed 1]

import fs from 'node:fs'
import path from 'node:path'
import { SHOTS, sleep, arg, check, waitFor, startMock, startChrome, finish } from './harness.mjs'

const PORT = Number(arg('--port', 8797)), CDP = Number(arg('--cdp', 8798))
fs.mkdirSync(SHOTS, { recursive: true })
for (const f of fs.readdirSync(SHOTS)) if (f.endsWith('.png')) fs.unlinkSync(path.join(SHOTS, f))

const mock = startMock({ port: PORT, args: ['--speed', arg('--speed', '1')] })
const page = await startChrome({ port: CDP })
// Stand in for the app's message handler, so the posted hitRects can be checked.
await page.beforeLoad('window.__posts = []; window.webkit = { messageHandlers: { lookma: { postMessage: m => window.__posts.push(m) } } }')
const sent = type => mock.fromOverlay.filter(m => m.type === type)
const running = () => page.evaluate(`document.getAnimations().filter(a => a.playState === 'running').map(a => a.animationName || a.constructor.name)`)

await page.goto(`${mock.base}?backdrop=1&voice=0`)
for (;;) {
  const mark = await mock.nextMark()
  await sleep(mark === 'idle' ? 300 : 700) // let the spring transitions land
  await page.shot(mark)
  if (mark === 'idle') { const r = await running(); check(r.length === 0, `no animations while idle (${r.join(', ') || 'none'})`) }
  if (mark === 'card') {
    const hits = await page.evaluate(`(() => { const b = document.getElementById('card').getBoundingClientRect(); const p = window.__posts.at(-1); return { card: [b.left, b.top, b.width, b.height].map(Math.round), posted: p && p.hitRects } })()`)
    const [x, y, w, h] = hits.card
    check(!!hits.posted?.some(r => r.x === x && r.y === y && r.w === w && r.h === h), `card rect posted as a hitRect (${JSON.stringify(hits.card)})`)
    await page.click('#card .k-btn.primary')
    await waitFor(() => sent('answer').length).catch(() => {})
    const a = sent('answer')[0]
    check(a?.via === 'click' && a?.allow === true && /^card-/.test(a?.cardId), `clicking Approve sends answer ${JSON.stringify(a)}`)
    await sleep(250)
    await page.shot('card-approved')
  }
  if (mark === 'waiting') {
    await page.click('#goAhead')
    await waitFor(() => sent('goAhead').length).catch(() => {})
    check(sent('goAhead').length === 1, 'clicking Go ahead sends goAhead')
  }
  if (mark === 'end') break
}

// Once the last turn has lingered and the task pill is gone, everything is still.
await sleep(9000)
await page.shot('rest')
{ const r = await running(); check(r.length === 0, `no animations at rest (${r.join(', ') || 'none'})`) }

// typed input: hidden by default, toggled with the ` key, sends tell with source typed
check(await page.evaluate(`document.getElementById('typed').hidden`), 'typed input is hidden by default')
await page.key('`', 'Backquote', { text: '`' })
const typingPosted = () => page.evaluate('window.__posts.at(-1)?.typing')
check((await typingPosted()) === true, 'the app is told the typed input is open')
await page.cdp('Input.insertText', { text: 'Open Notes and start a new note' })
await page.shot('typed')
await page.key('Enter', 'Enter', { windowsVirtualKeyCode: 13, text: '\r' })
await waitFor(() => sent('tell').length).catch(() => {})
const tell = sent('tell')[0]
check(tell?.source === 'typed' && tell?.text === 'Open Notes and start a new note', `typed input sends tell ${JSON.stringify(tell)}`)
await sleep(900)
await page.shot('typed-sent')

// paused, as the app's menu bar or ⌃⌥P would ask: one calm line and how to resume, nothing moving
await page.key('Escape', 'Escape')
await sleep(100)
check((await typingPosted()) === false, 'Escape closes the typed input, and the app is told')
await sleep(1100) // the mock's typed turn ends
await mock.setPaused(true)
await sleep(900)
await page.shot('paused')
const capsule = () => page.evaluate(`[document.querySelector('#cap .r-user').textContent, document.querySelector('#cap .r-status').textContent, document.getElementById('vg').className]`)
const [pUser, pHint, pGlyph] = await capsule()
check(pUser === 'Paused' && /menu bar/.test(pHint) && pHint.includes('⌃⌥P') && pGlyph === 'vg paused', `paused capsule: ${JSON.stringify([pUser, pHint, pGlyph])}`)
{ const r = await running(); check(r.length === 0, `no animations while paused (${r.join(', ') || 'none'})`) }
await mock.setPaused(false)
await sleep(600)
check((await capsule())[0] !== 'Paused', 'resumed: the capsule leaves the paused state')

// TV distance: the card again at ?scale=1.75
await page.goto(`${mock.base}?backdrop=1&voice=0&scale=1.75`)
await sleep(800)
await mock.restart({ from: 'card', hold: true })
await mock.until('card')
await sleep(900)
await page.shot('tv-card')

console.log(`\nmarks: ${mock.marks.join(' ')}`)
await page.close()
finish()
