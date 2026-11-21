#!/usr/bin/env node
// A fake app for tests: connects to /ws/app, reports attention and answers the ops of
// docs/protocol.md with plausible rects and a placeholder PNG. Nothing on the real screen moves.
//   node core/dev/fake-app.mjs [--port 8791] [--idle 10] [--front Finder]
// As a module: startFakeApp({ port, idle, front }) → { ops, notices, setIdle, send, front, elementIds, failSee, ready, close }
//   notices: what the core sent besides requests ({ type: 'paused' }, { type: 'quit' })
//   send(msg): what the menu bar and hotkey send ({ type: 'pause' | 'resume' | 'quit' })
//   failSee(error): see throws that error from now on; null makes it work again
import zlib from 'node:zlib'
import WebSocket from 'ws'

const SCREEN = { w: 1440, h: 900, scale: 2 }
const APPS = {
  Finder: {
    window: { title: 'Downloads', rect: { x: 200, y: 120, w: 900, h: 560 } },
    controls: [['button', 'Back'], ['textfield', 'Search'], ['row', 'report.pdf', ['selected']], ['row', 'notes.txt'], ['button', '']],
    menu: [['menuitem', 'Open'], ['menuitem', 'Get Info'], ['menuitem', 'Move to Trash', ['disabled']]], // what a right click opens
  },
  Slack: { window: { title: 'general', rect: { x: 80, y: 60, w: 1200, h: 800 } }, controls: [['row', '#general'], ['row', '#random'], ['textarea', 'Message #general'], ['button', 'Send']] },
  'Google Chrome': { window: { title: 'New Tab', rect: { x: 0, y: 38, w: 1440, h: 820 } }, controls: [['textfield', 'Address and search bar'], ['button', 'New Tab'], ['link', 'Gmail']] },
  Notes: { window: { title: 'Notes', rect: { x: 300, y: 150, w: 800, h: 600 } }, controls: [['button', 'New Note'], ['textarea', 'Note body']] },
}
const DOCK_Y = SCREEN.h - 40
const dockRect = name => ({ x: 400 + 60 * Object.keys(APPS).indexOf(name), y: DOCK_Y - 24, w: 48, h: 48 })
const center = r => [Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2)]
const inside = (p, r) => p[0] >= r.x && p[0] < r.x + r.w && p[1] >= r.y && p[1] < r.y + r.h

function png(w, h, [r, g, b]) {
  const row = Buffer.alloc(1 + w * 3)
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])))
    return Buffer.concat([len, Buffer.from(type), data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const IMAGE = png(640, 400, [200, 205, 215]).toString('base64')

export function startFakeApp({ port = 8791, idle = 10, front = 'Finder', log = () => {} } = {}) {
  const ops = []
  const notices = []
  let ws = null
  let timer = null
  let closed = false
  let idleNow = idle
  let frontApp = front
  let nextId = 0
  let elements = new Map() // id -> { id, role, text, states, rect, app } from the latest see
  let shot = null // { w, h, rect, app } of the last screenshot
  let seeError = null
  let menuOpen = null // the app whose context menu is up
  const scrolledTo = {} // app -> vertical scroll position, 0 to 1

  function resolve(args) {
    if (args.element != null) {
      const e = elements.get(String(args.element))
      if (!e) throw new Error(`Unknown or stale element ${args.element}; call see again.`)
      return { app: e.app, rect: e.rect, point: center(e.rect), frontmost: e.app === frontApp, pressable: e.role === 'button' || e.role === 'row' || e.role === 'link' }
    }
    if (args.point) {
      if (!shot) throw new Error('No screenshot yet; call see with screenshot: true.')
      const p = [Math.round(shot.rect.x + (args.point[0] * shot.rect.w) / shot.w), Math.round(shot.rect.y + (args.point[1] * shot.rect.h) / shot.h)]
      return { app: frontApp, rect: { x: p[0] - 10, y: p[1] - 10, w: 20, h: 20 }, point: p, frontmost: true, pressable: false }
    }
    if (args.dock) {
      if (!APPS[args.dock]) throw new Error(`${args.dock} is not in the Dock.`)
      const rect = dockRect(args.dock)
      return { app: args.dock, rect, point: center(rect), frontmost: args.dock === frontApp, pressable: true }
    }
    const app = args.app || frontApp
    if (!APPS[app]) throw new Error(`${app} is not running.`)
    const rect = APPS[app].window.rect
    return { app, rect, point: center(rect), frontmost: app === frontApp, pressable: false }
  }

  // A screenshot only when asked for, and the last one of this app whenever there is one. An element
  // listed in the previous see (same app, role and text) keeps its id, as the app's AX match does.
  // Every control here is actionable, so one with no text counts as unlabeled. An open menu's items
  // come first.
  function see(args) {
    if (seeError) throw new Error(seeError)
    const app = args.app || frontApp
    const { window, controls } = APPS[app]
    const menu = menuOpen === app ? APPS[app].menu : []
    const r = window.rect
    const before = [...elements.values()]
    elements = new Map()
    ;[...menu, ...controls].forEach(([role, text, states = []], i) => {
      const id = before.find(e => e.app === app && e.role === role && e.text === text)?.id ?? `e${++nextId}`
      elements.set(id, { id, role, text, states, rect: { x: r.x + 20, y: r.y + 40 + i * 40, w: 200, h: 28 }, app })
    })
    const list = [...elements.values()].map(({ id, role, text, states, rect }) => ({ id, role, text, states, rect }))
    const res = { app, frontmost: frontApp, window, elements: list, menu: menu.length, cut: null, unlabeled: list.filter(e => !e.text).length }
    if (args.screenshot) shot = { w: 640, h: 400, rect: r, app }
    if (shot?.app !== app) return res
    const held = { ...res, shot: { w: shot.w, h: shot.h, rect: shot.rect } }
    return args.screenshot ? { ...held, image: IMAGE } : held
  }

  const handlers = {
    see,
    resolve,
    front: a => {
      frontApp = a.app
      return {}
    },
    // Any act but a right click closes an open menu. A right click opens one where the app has one.
    press: a => {
      resolve({ element: a.element })
      menuOpen = null
      return {}
    },
    click: a => {
      if (a.button === 'right') {
        menuOpen = APPS[frontApp].menu ? frontApp : null
        return { menu: !!menuOpen }
      }
      menuOpen = null
      const dock = Object.keys(APPS).find(name => inside(a.point, dockRect(name)))
      if (dock) frontApp = dock
      return {}
    },
    type: () => ({}),
    key: () => {
      menuOpen = null
      return {}
    },
    // Up and down read a scroll bar that moves a quarter per page; left and right have none.
    scroll: a => {
      const vertical = a.direction === 'up' || a.direction === 'down'
      const pixels = Math.round(APPS[frontApp].window.rect[vertical ? 'h' : 'w'] * 0.9 * a.pages)
      if (!vertical) return { pixels, position: null, moved: null }
      const was = scrolledTo[frontApp] ?? 0
      const now = Math.min(1, Math.max(0, was + (a.direction === 'down' ? 0.25 : -0.25) * a.pages))
      scrolledTo[frontApp] = now
      return { pixels, position: now, moved: now !== was }
    },
    open: a => {
      frontApp = a.url ? 'Google Chrome' : 'Finder'
      return { app: frontApp }
    },
  }

  let onReady
  const ready = new Promise(r => (onReady = r))

  function connect() {
    if (closed) return
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/app`)
    sock.on('open', () => {
      ws = sock
      sock.send(JSON.stringify({ type: 'hello', version: 'fake-1', permissions: { accessibility: true, screen: true, microphone: true }, screen: SCREEN }))
      const beat = () => sock.readyState === 1 && sock.send(JSON.stringify({ type: 'attention', idle: idleNow }))
      beat()
      timer = setInterval(beat, 500)
      onReady()
    })
    sock.on('message', raw => {
      const msg = JSON.parse(raw)
      if (msg.type !== 'req') {
        notices.push(msg)
        log(`notice ${raw}`)
        return
      }
      const entry = { op: msg.op, args: msg.args, at: Date.now() }
      ops.push(entry)
      log(`op ${msg.op} ${JSON.stringify(msg.args)}`)
      let reply
      try {
        reply = { type: 'res', id: msg.id, ok: true, result: handlers[msg.op](msg.args || {}) }
      } catch (err) {
        reply = { type: 'res', id: msg.id, ok: false, error: err.message }
        entry.error = err.message
      }
      sock.send(JSON.stringify(reply))
    })
    sock.on('error', () => {})
    sock.on('close', () => {
      clearInterval(timer)
      ws = null
      if (!closed) setTimeout(connect, 1000)
    })
  }
  connect()

  return {
    ops,
    notices,
    ready,
    setIdle(s) {
      idleNow = s
      ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'attention', idle: s }))
    },
    send: msg => ws?.readyState === 1 && ws.send(JSON.stringify(msg)),
    get front() {
      return frontApp
    },
    elementIds: () => [...elements.keys()],
    failSee(error) {
      seeError = error
    },
    close() {
      closed = true
      clearInterval(timer)
      ws?.close()
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : def
  }
  const app = startFakeApp({
    port: Number(arg('port', process.env.LOOKMA_PORT || 8791)),
    idle: Number(arg('idle', 10)),
    front: arg('front', 'Finder'),
    log: line => process.stdout.write(`${new Date().toISOString().slice(11, 23)} fake-app ${line}\n`),
  })
  app.ready.then(() => process.stdout.write('fake-app connected\n'))
  process.on('SIGTERM', () => (app.close(), process.exit(0)))
  process.on('SIGINT', () => (app.close(), process.exit(0)))
}
