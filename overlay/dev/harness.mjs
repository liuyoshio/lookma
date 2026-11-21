// Shared plumbing for the headless overlay checks (shoot.mjs, check-voices.mjs): the
// mock core as a child process, and headless Chrome driven over CDP with its own
// profile in overlay/dev/.chrome/<cdp port>, so checks can run side by side. Headless only;
// no window ever opens.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

export const DEV = path.dirname(fileURLToPath(import.meta.url))
export const SHOTS = path.join(DEV, 'shots')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export const sleep = ms => new Promise(r => setTimeout(r, ms))
export const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }

export const problems = []
const children = []
function cleanup() { for (const c of children) try { c.kill() } catch {} }
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(130))
setTimeout(() => { console.log('FAIL timed out'); process.exit(2) }, 240000).unref()

export function check(ok, what) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`)
  if (!ok) problems.push(`check failed: ${what}`)
}

export function waitFor(pred, ms = 3000) {
  return new Promise((res, rej) => {
    const t0 = Date.now()
    const tick = () => (pred() ? res() : Date.now() - t0 > ms ? rej(new Error('timed out')) : setTimeout(tick, 50))
    tick()
  })
}

/** The mock core, its overlay -> core messages and its scenario marks. */
export function startMock({ port, args = [] }) {
  const proc = spawn(process.execPath, [path.join(DEV, 'mock-core.mjs'), '--port', String(port), ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(proc)
  const m = { fromOverlay: [], marks: [], queue: [], waiter: null, base: `http://127.0.0.1:${port}/` }
  readline.createInterface({ input: proc.stdout }).on('line', line => {
    let e
    try { e = JSON.parse(line) } catch { return }
    if (e.from === 'overlay') { m.fromOverlay.push(e.msg); console.log('  overlay ->', JSON.stringify(e.msg)) }
    if (e.error) problems.push(`mock core: ${e.error}`)
    if (e.mark) {
      m.marks.push(e.mark)
      if (m.waiter) { const w = m.waiter; m.waiter = null; w(e.mark) } else m.queue.push(e.mark)
    }
  })
  m.nextMark = () => (m.queue.length ? Promise.resolve(m.queue.shift()) : new Promise(res => { m.waiter = res }))
  m.until = async name => { for (let x; (x = await m.nextMark()) !== name;); }
  m.restart = async body => {
    m.queue.length = 0
    await fetch(`${m.base}dev/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  }
  // What the app's menu bar and ⌃⌥P do: ask the core to pause or resume.
  m.setPaused = paused => fetch(`${m.base}dev/paused`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused }) })
  // One executor `say`, now: { speech, display?, kind? }.
  m.say = body => fetch(`${m.base}dev/say`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return m
}

/** Headless Chrome at 1440 x 900, with console errors, warnings and exceptions collected into
 *  `problems`, and every console line in `logs`. */
export async function startChrome({ port }) {
  const proc = spawn(CHROME, [
    // --mute-audio: tests must never chime through the speakers.
    '--headless=new', '--mute-audio', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(DEV, '.chrome', String(port))}`,
    '--window-size=1440,900', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
  ], { stdio: 'ignore' })
  children.push(proc)

  let target
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(150)
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page') } catch {}
  }
  if (!target) throw new Error('headless Chrome did not start')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  let seq = 0
  const calls = new Map()
  const logs = []
  ws.on('message', data => {
    const m = JSON.parse(data)
    if (m.id) { const c = calls.get(m.id); calls.delete(m.id); m.error ? c.reject(new Error(m.error.message)) : c.resolve(m.result); return }
    if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`)
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value ?? a.description).join(' '))
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(m.params.type)) {
      problems.push(`console.${m.params.type}: ${m.params.args.map(a => a.value ?? a.description).join(' ')}`)
    }
    if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) problems.push(`log ${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url || ''}`)
  })
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    calls.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Log.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

  const c = {
    cdp,
    logs,
    async evaluate(expr) {
      const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
      return r.result.value
    },
    beforeLoad: source => cdp('Page.addScriptToEvaluateOnNewDocument', { source }),
    goto: url => cdp('Page.navigate', { url }),
    async shot(name) {
      fs.mkdirSync(SHOTS, { recursive: true })
      const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
      const n = fs.readdirSync(SHOTS).filter(f => f.endsWith('.png')).length + 1
      const file = path.join(SHOTS, `${String(n).padStart(2, '0')}-${name}.png`)
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
      console.log(`shot ${path.relative(process.cwd(), file)}`)
    },
    async click(selector) {
      const r = await c.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 })
      }
    },
    async key(key, code, extra = {}) {
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, ...extra })
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code })
    },
    async close() { try { await cdp('Browser.close') } catch {} },
  }
  return c
}

export function finish() {
  console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nno console errors, all checks passed')
  cleanup()
  process.exit(problems.length ? 1 : 0)
}
