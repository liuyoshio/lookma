// HTTP and WebSocket server on 127.0.0.1. Local-only rules (docs/protocol.md): listen on loopback,
// POST bodies must be JSON, WebSocket upgrades only without an Origin or from our own origin.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { WebSocketServer } from 'ws'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function serveStatic(res, dir, pathname) {
  const file = path.join(dir, path.normalize(pathname === '/' ? '/index.html' : pathname))
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return json(res, 404, { error: fs.existsSync(dir) ? 'not found' : `${path.basename(dir)}/ is missing` })
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
  fs.createReadStream(file).pipe(res)
}

export function startServer({ config, core, log }) {
  const origins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`])
  const overlayDir = path.join(config.root, 'overlay')
  // A voice provider's page half, beside the overlay: /voices/<name>/page.js and /voices/<name>/page/*.
  // Nothing else of its folder is served.
  const voicePage = /^\/voices\/([a-z0-9-]+)\/page(\.js|\/.+)$/
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })
  // The three sockets (docs/protocol.md), each with the core's entry point for it.
  const sockets = { '/ws/overlay': core.connectOverlay, '/ws/app': core.connectApp, '/ws/executor': core.connectExecutor }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    try {
      let body = null
      if (req.method === 'POST') {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
          return json(res, 415, { error: 'POST bodies must be application/json' })
        }
        const text = await readBody(req)
        try {
          body = text ? JSON.parse(text) : {}
        } catch {
          return json(res, 400, { error: 'invalid JSON' })
        }
      }
      const route = `${req.method} ${url.pathname}`

      if (route === 'GET /api/state') return json(res, 200, core.store.snapshot())
      if (route === 'POST /api/tell') {
        try {
          const turn = core.tell(body.text, body.source || 'typed')
          return json(res, 200, { ok: true, turn })
        } catch (err) {
          return json(res, 409, { error: err.message })
        }
      }
      if (route === 'POST /api/voice/grant') {
        try {
          return json(res, 200, await core.voiceGrant())
        } catch (err) {
          return json(res, err.status || 500, { error: err.message })
        }
      }
      const pathname = decodeURIComponent(url.pathname)
      const page = req.method === 'GET' && pathname.match(voicePage)
      if (page) {
        const dir = path.join(config.root, 'voices', page[1])
        return page[2] === '.js' ? serveStatic(res, dir, '/page.js') : serveStatic(res, path.join(dir, 'page'), page[2])
      }
      if (req.method === 'GET') return serveStatic(res, overlayDir, pathname)
      json(res, 404, { error: 'not found' })
    } catch (err) {
      log('http error', String(err?.stack || err))
      if (!res.headersSent) json(res, 500, { error: String(err?.message || err) })
    }
  })

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1')
    const origin = req.headers.origin
    if (!Object.hasOwn(sockets, pathname) || (origin && !origins.has(origin))) {
      log('refused websocket', pathname, origin || '')
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, sockets[pathname])
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, '127.0.0.1', () => {
      log(`listening on http://127.0.0.1:${config.port}/`)
      resolve(server)
    })
  })
}
