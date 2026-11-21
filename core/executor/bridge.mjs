// A stdio MCP server that gives an agent `say` and the hands tools, as a thin pipe to the core.
// The agent spawns it (Claude Code from the session's .mcp.json, Codex from its thread config) with
// LOOKMA_CORE_URL set, and it dials that socket, the adapter's `connect` (see tool-link.mjs):
//   bridge → core: { type: 'say', speech, display, kind }, { type: 'hands', id, tool, args }
//   core → bridge: { type: 'res', id, ok, result | error }
// Any other message from the core goes to onCore, for what one agent needs on top. Never write to
// stdout: it is the MCP transport.
import fs from 'node:fs'
import WebSocket from 'ws'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { SAY, HANDS } from '../tools.mjs'

const HANDS_NAMES = new Set(HANDS.map(t => t.name))

// tools: SAY and HANDS as tools.mjs defines them, maybe with fields of the agent's own.
// setup(bridge) runs before the transport connects, to add handlers; onCore(msg, bridge) gets the
// core's other messages. bridge is { mcp, send }.
export async function serve({ tools = [SAY, ...HANDS], capabilities = {}, instructions, setup, onCore } = {}) {
  const coreUrl = process.env.LOOKMA_CORE_URL
  if (!coreUrl) {
    process.stderr.write('lookma tools: LOOKMA_CORE_URL is not set. Lookma starts this server itself; run lookma instead.\n')
    process.exit(1)
  }
  const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

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

  async function fromCore(raw) {
    const msg = JSON.parse(raw)
    if (msg.type !== 'res') return onCore?.(msg, bridge)
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error))
  }

  function connect() {
    const sock = new WebSocket(coreUrl)
    sock.on('open', () => (ws = sock))
    sock.on('message', raw => fromCore(raw).catch(err => process.stderr.write(`lookma tools: ${err.message}\n`)))
    sock.on('error', () => {}) // 'close' follows
    sock.on('close', () => {
      if (ws === sock) ws = null
      for (const p of pending.values()) p.reject(new Error('Lost the connection to Lookma.'))
      pending.clear()
      setTimeout(connect, 1000)
    })
  }

  // ---------------------------------------------------------------- MCP

  const mcp = new Server({ name: 'lookma', version }, { capabilities: { ...capabilities, tools: {} }, instructions })
  const bridge = { mcp, send }

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

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

  setup?.(bridge)
  mcp.oninitialized = connect
  mcp.onclose = () => process.exit(0)
  process.stdin.on('end', () => process.exit(0))
  await mcp.connect(new StdioServerTransport())
}
