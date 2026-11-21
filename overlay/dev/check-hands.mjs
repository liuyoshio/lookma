#!/usr/bin/env node
// Headless check of the hand gestures' page side for real: the overlay page (with ?hands=1, so the
// debug view draws too) against the mock core, in headless Chrome with its fake camera (a test
// pattern, no hand in it), and window.webkit stubbed as the app. Checks:
//   - camera(true) starts the stream, the module worker loads tasks-vision, its wasm and the model
//     from the local server only, and frames { t, aspect, hand: null } arrive at the camera's rate
//     with t increasing; the page tells the app its camera is on
//   - camera(false) ends every track, the page says off, and no frame follows
//   - nothing goes to another host: every request of the page and its workers (watched over CDP)
//     is to the local server
// This proves the serving and the module worker in Chromium, not in WebKit: the app's WKWebView is
// the maintainer's probe.
//
//   node overlay/dev/check-hands.mjs [--port 8799] [--cdp 8800]

import { sleep, arg, check, startMock, startChrome, finish, problems } from './harness.mjs'

const PORT = Number(arg('--port', 8799)), CDP = Number(arg('--cdp', 8800))

const mock = startMock({ port: PORT })
const page = await startChrome({ port: CDP, args: ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream'] })

// Every request the page and its workers make. A worker is held at its start until its requests
// are watched too.
const requests = []
page.on(m => {
  if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url)
  if (m.method === 'Target.attachedToTarget') {
    const s = m.params.sessionId
    page.cdp('Network.enable', {}, s).then(() => page.cdp('Runtime.runIfWaitingForDebugger', {}, s))
  }
})
await page.cdp('Network.enable')
await page.cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })

await page.beforeLoad(`{
  window.__hands = []
  window.__posts = []
  window.__streams = []
  window.webkit = { messageHandlers: { // the app
    lookma: { postMessage: m => window.__posts.push(m) },
    hand: { postMessage: m => window.__hands.push(m) },
  } }
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async c => { const s = await gum(c); if (c.video) window.__streams.push(s); return s }
}`)
await page.goto(`${mock.base}?voice=0&hands=1`)
await sleep(1000)
const hands = () => page.evaluate('window.__hands.length')
const posted = key => page.evaluate(`window.__posts.at(-1)?.${key}`)

check((await posted('camera')) === 'off', 'at load: the page tells the app its camera is off')
await page.evaluate('window.lookma.camera(true)')
let n = 0
for (let i = 0; i < 600 && !(n = await hands()); i++) await sleep(100) // the first frame waits for the tracker to load
check(n > 0, 'camera(true): the stream starts, the worker loads the tracker, and frames arrive')
const t0 = Date.now(), n0 = await hands()
await sleep(3000)
const frames = await page.evaluate('window.__hands')
const rate = (frames.length - n0) / ((Date.now() - t0) / 1000)
console.log(`  ${rate.toFixed(1)} frames a second, ${await page.evaluate(`document.querySelector('canvas') ? 'view drawn' : 'no view'`)}`)
check(rate >= 10, `frames arrive at about the camera's rate (${rate.toFixed(1)} a second)`)
check(frames.every((f, i) => Object.keys(f).join() === 't,aspect,hand' && f.hand === null && Math.abs(f.aspect - 16 / 9) < 0.01 && (i === 0 || f.t > frames[i - 1].t)),
  `each frame is { t, aspect, hand: null } (no hand in the test pattern), 16:9, with t increasing ${JSON.stringify(frames[0])}`)
check((await posted('camera')) === 'on', 'the page tells the app its camera is on')

await page.evaluate('window.lookma.camera(false)')
await sleep(500)
const after = await hands()
await sleep(1000)
const tracks = await page.evaluate('window.__streams.flatMap(s => s.getTracks()).map(t => t.readyState)')
check(tracks.length > 0 && tracks.every(s => s === 'ended') && (await page.evaluate(`document.getElementById('camera').srcObject === null`)),
  `camera(false): every track ended and the video let go ${JSON.stringify(tracks)}`)
check((await hands()) === after && (await posted('camera')) === 'off', 'camera(false): no frame follows, and the page says off')

const elsewhere = requests.filter(u => !u.startsWith(mock.base))
check(requests.some(u => u.endsWith('/hand/hand_landmarker.task')) && requests.some(u => u.endsWith('.wasm')) && elsewhere.length === 0,
  `the worker loaded tasks-vision, its wasm and the model from the local server, and nothing went anywhere else ${JSON.stringify(elsewhere)}`)
await page.close()
// MediaPipe's wasm writes its own log lines to the console (its INFO lines as errors). A real
// failure reaches the page as the worker's { error } and fails the checks above.
for (let i = problems.length - 1; i >= 0; i--) if (/^log \w+: .* http:\S+\/vendor\/tasks-vision\/wasm\/\S+$/s.test(problems[i])) problems.splice(i, 1)
finish()
