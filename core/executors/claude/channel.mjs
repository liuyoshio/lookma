#!/usr/bin/env node
// Stdio MCP server that Claude Code spawns (as a development channel). A thin pipe to the core:
//   core  → proxy: { type: 'prompt', text }, { type: 'permissionAnswer', request_id, behavior },
//                  { type: 'res', id, ok, result | error }
//   proxy → core:  { type: 'say', speech, display, kind }, { type: 'hands', id, tool, args },
//                  { type: 'permission', request_id, tool_name, description, input_preview }
// Runs in its own process, started from the .mcp.json that session.mjs writes, which also sets
// LOOKMA_CORE_URL. Never write to stdout: it is the MCP transport.
import fs from 'node:fs'
import WebSocket from 'ws'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { SAY, HANDS } from '../../tools.mjs'

const CORE_URL = process.env.LOOKMA_CORE_URL
if (!CORE_URL) {
  process.stderr.write('lookma channel: LOOKMA_CORE_URL is not set. Lookma starts this server itself; run lookma instead.\n')
  process.exit(1)
}
const { version } = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'))

// ---------------------------------------------------------------- tools

// alwaysLoad: Claude Code lists these tools to the model from the start instead of deferring them
// behind its tool search, so say and the hands are never a lookup away.
const TOOLS = [SAY, ...HANDS].map(t => ({ ...t, _meta: { 'anthropic/alwaysLoad': true } }))
const HANDS_NAMES = new Set(HANDS.map(t => t.name))

// ---------------------------------------------------------------- core link

let ws = null
let seq = 0
const pending = new Map() // id -> { resolve, reject }

function send(msg) {
  if (ws?.readyState !== WebSocket.OPEN) return false
  ws.send(JSON.stringify(msg))
  return true
}

function request(tool, args) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    if (!send({ type: 'hands', id, tool, args })) return reject(new Error('Lookma is not connected.'))
    pending.set(id, { resolve, reject })
  })
}

async function onCore(msg) {
  if (msg.type === 'prompt') {
    await mcp.notification({ method: 'notifications/claude/channel', params: { content: msg.text, meta: {} } })
  } else if (msg.type === 'permissionAnswer') {
    await mcp.notification({ method: 'notifications/claude/channel/permission', params: { request_id: msg.request_id, behavior: msg.behavior } })
  } else if (msg.type === 'res') {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.ok) p?.resolve(msg.result)
    else p?.reject(new Error(msg.error))
  }
}

function connect() {
  const sock = new WebSocket(CORE_URL)
  sock.on('open', () => (ws = sock))
  sock.on('message', raw => {
    try {
      onCore(JSON.parse(raw)).catch(err => process.stderr.write(`lookma channel: ${err.message}\n`))
    } catch {}
  })
  sock.on('error', () => {}) // 'close' follows
  sock.on('close', () => {
    if (ws === sock) ws = null
    for (const p of pending.values()) p.reject(new Error('Lost the connection to Lookma.'))
    pending.clear()
    setTimeout(connect, 1000)
  })
}

// ---------------------------------------------------------------- MCP

const mcp = new Server(
  { name: 'lookma', version },
  {
    capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} },
    instructions:
      'The user talks to you by voice through Lookma and watches the screen; they cannot see this terminal. ' +
      'Their words arrive as <channel source="lookma"> messages: that is the user speaking. ' +
      'Speak to them only with the say tool. Work on screen only with the see, click, type, key, scroll and open tools.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params
  const text = t => ({ content: [{ type: 'text', text: t }] })
  if (name === SAY.name) {
    const sent = send({ type: 'say', speech: args.speech, display: args.display, kind: args.kind }) // the core fills in defaults
    return text(sent ? 'said' : 'Lookma is not connected; the user did not hear this.')
  }
  if (!HANDS_NAMES.has(name)) throw new Error(`unknown tool: ${name}`)
  try {
    const r = await request(name, args)
    const content = r.image ? [{ type: 'image', data: r.image, mimeType: 'image/png' }] : []
    content.push({ type: 'text', text: r.text })
    return { content }
  } catch (err) {
    return { ...text(err.message), isError: true }
  }
})

// Claude Code sends this when a tool-approval dialog opens; the terminal dialog stays open too.
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
})
mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => send({ type: 'permission', ...params }))

mcp.oninitialized = connect
mcp.onclose = () => process.exit(0)
process.stdin.on('end', () => process.exit(0))
await mcp.connect(new StdioServerTransport())
