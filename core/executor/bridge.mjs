#!/usr/bin/env node
// The tools bridge: a stdio MCP server that gives an agent `say` and the hands, as a thin pipe to
// the executor host (host.mjs). The agent spawns it from the spec the host's tools.mcp() returns,
// whose environment carries everything it needs:
//   LOOKMA_CORE_URL  the host's socket, /ws/executor
//   LOOKMA_TOOLS     { name, tools, instructions? }: the MCP server's name, its tool list and the
//                    instructions the agent's MCP client wants, all decided by the host
// It dials the socket first and only then answers MCP, so a tool listed is a tool that can be
// called. Every call goes the same way:
//   bridge → host: { type: 'call', id, tool, args }
//   host → bridge: { type: 'res', id, ok, result: { text, image? } | error }
// It knows no tool by name. Never write to stdout: it is the MCP transport.
import fs from 'node:fs'
import WebSocket from 'ws'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const RECONNECT_MS = 1000

const { LOOKMA_CORE_URL: coreUrl, LOOKMA_TOOLS: spec } = process.env
if (!coreUrl || !spec) {
  process.stderr.write('lookma tools: LOOKMA_CORE_URL or LOOKMA_TOOLS is not set. Lookma starts this server itself; run lookma instead.\n')
  process.exit(1)
}
const { name, tools, instructions } = JSON.parse(spec)
const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

// ---------------------------------------------------------------- the host's socket

let ws = null
let seq = 0
const pending = new Map() // id -> { resolve, reject }

function onMessage(raw) {
  const msg = JSON.parse(raw)
  const p = pending.get(msg.id)
  pending.delete(msg.id)
  if (msg.ok) p.resolve(msg.result)
  else p.reject(new Error(msg.error))
}

// Resolves once the socket is open. After a loss it dials again; calls meanwhile fail.
function connect() {
  return new Promise(resolve => {
    const sock = new WebSocket(coreUrl)
    sock.on('open', () => {
      ws = sock
      resolve()
    })
    sock.on('message', onMessage)
    sock.on('error', () => {}) // 'close' follows
    sock.on('close', () => {
      if (ws === sock) ws = null
      for (const p of pending.values()) p.reject(new Error('Lost the connection to Lookma.'))
      pending.clear()
      setTimeout(() => connect().then(resolve), RECONNECT_MS)
    })
  })
}

function call(tool, args) {
  return new Promise((resolve, reject) => {
    if (ws?.readyState !== WebSocket.OPEN) return reject(new Error('Lookma is not connected.'))
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ type: 'call', id, tool, args }))
  })
}

// ---------------------------------------------------------------- MCP

const mcp = new Server({ name, version }, { capabilities: { tools: {} }, instructions })

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  try {
    const r = await call(req.params.name, req.params.arguments ?? {})
    const content = r.image ? [{ type: 'image', data: r.image, mimeType: 'image/png' }] : []
    content.push({ type: 'text', text: r.text })
    return { content }
  } catch (err) {
    return { content: [{ type: 'text', text: err.message }], isError: true }
  }
})

await connect()
mcp.onclose = () => process.exit(0)
process.stdin.on('end', () => process.exit(0))
await mcp.connect(new StdioServerTransport())
