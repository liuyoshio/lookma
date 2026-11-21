#!/usr/bin/env node
// A stand-in for `claude` as the Agent SDK runs it (stream-json on stdio, with the SDK's control
// requests), for core/dev/check-executors.mjs: it answers initialize, spawns the tools bridge from
// the MCP servers the SDK sends at initialize and calls its tools over MCP, asks for permission
// with can_use_tool, reports steps through the PreToolUse hook, and plays each prompt as one of
// the conformance commands listed in check-executors.mjs. A prompt during a turn waits in a queue
// until the turn's next tool boundary (here 50 ms on), as in Claude Code: an interrupt before then
// leaves it queued, names it in the receipt's still_queued, and it runs as the next turn. No
// model, no network.
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// The command the adapter spawns, which the check puts first on its PATH.
export const bin = 'claude'

if (process.argv[1] === fileURLToPath(import.meta.url)) play()

function play() {
  const send = msg => process.stdout.write(JSON.stringify(msg) + '\n')
  // --resume <id> or --resume=<id>: the conversation goes on under its id.
  const args = process.argv.slice(2).join(' ')
  const session = args.match(/--resume[= ](\S+)/)?.[1] ?? randomUUID()
  const waiting = new Map() // our control request id -> resolve
  let seq = 0
  let tools = null // the MCP client of the tools bridge
  let hooks = {} // hook event -> callback ids
  let turn = null // { cmd, asking, stopped } of the turn running
  const queued = [] // prompts told during a turn: { uuid, text }

  function request(req) {
    const id = `fake${++seq}`
    send({ type: 'control_request', request_id: id, request: req })
    return { id, answer: new Promise(resolve => waiting.set(id, resolve)) }
  }
  const respond = (id, response) => send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })

  async function call(name, args) {
    const r = await tools.callTool({ name, arguments: args })
    return r.content.find(c => c.type === 'text').text
  }

  // A tool call of the main agent, as Claude Code reports it to the SDK's PreToolUse hook.
  async function step(command) {
    for (const id of hooks.PreToolUse ?? []) {
      await request({ subtype: 'hook_callback', callback_id: id, input: { hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Bash', tool_input: { command }, tool_use_id: `t${++seq}` } }).answer
    }
  }

  function result(t, ok, text) {
    if (turn !== t) return // ended already: interrupted, or steered
    turn = null
    const base = { type: 'result', session_id: session, uuid: randomUUID(), duration_ms: 1, num_turns: 1 }
    send(ok ? { ...base, subtype: 'success', is_error: false, result: text } : { ...base, subtype: 'error_during_execution', is_error: true, errors: [text] })
    if (queued.length) begin(queued.shift().text)
  }

  // The stopped work's stragglers, which the host must hold back, then the end.
  // A turn that ended meanwhile has nothing left to straggle.
  async function straggle(t) {
    if (turn === t) await call('say', { speech: 'late' })
    if (turn === t) await step('late step')
    result(t, false, 'interrupted')
  }

  const PLAY = {
    say: async (t, words) => {
      await call('say', { speech: words })
      result(t, true, words)
    },
    see: async t => result(t, true, await call('see', { label: 'Look' })),
    ask: async t => {
      t.asking = request({ subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch notes.txt' }, tool_use_id: `t${++seq}` })
      const r = await t.asking.answer
      result(t, true, r.behavior === 'allow' ? 'yes' : 'no')
    },
    fail: t => result(t, false, 'boom'),
    // As Claude Code answers a prompt it cannot take: a failed turn, with the reason.
    refuse: t => result(t, false, 'Claude usage limit reached'),
    work: t => step('sleep 60'),
    stuck: t => step('sleep 60'),
    die: () => process.exit(3),
  }

  // A prompt during a turn is taken into it at its next tool boundary, unless the turn ended first.
  function prompt({ uuid, text }) {
    if (!turn) return begin(text)
    const t = turn
    const q = { uuid, text }
    queued.push(q)
    setTimeout(() => {
      if (turn !== t || !queued.includes(q)) return
      queued.splice(queued.indexOf(q), 1)
      result(t, true, `steered: ${text}`)
    }, 50)
  }

  function begin(text) {
    const [cmd, ...words] = text.split(' ')
    const t = (turn = { cmd })
    send({ type: 'system', subtype: 'init', session_id: session, uuid: randomUUID(), model: 'fake', mcp_servers: [{ name: 'lookma', status: 'connected' }] })
    setImmediate(() => PLAY[cmd](t, words.join(' ')))
  }

  const CONTROL = {
    // Answers once the tools bridge is connected, as Claude Code does.
    async initialize(r) {
      hooks = Object.fromEntries(Object.entries(r.hooks ?? {}).map(([event, matchers]) => [event, matchers.flatMap(m => m.hookCallbackIds)]))
      const [name, spec] = Object.entries(r.mcpServers)[0]
      tools = new Client({ name: 'fake-claude', version: '0' })
      await tools.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...process.env, ...spec.env } }))
      tools.server = name
      return { commands: [], agents: [], output_style: 'default', available_output_styles: [], models: [], account: {}, claude_code_version: 'fake', hooks_applied: true, mcp_servers_applied: true }
    },
    mcp_status: () => ({ mcpServers: [{ name: tools.server, status: 'connected' }] }),
    // A stuck turn never answers. Any other is stopped: its open request is cancelled, then it
    // straggles. The queued prompts survive, and the receipt names them.
    interrupt() {
      const t = turn
      if (t?.cmd === 'stuck') return new Promise(() => {})
      if (t && !t.stopped) {
        t.stopped = true // a second interrupt of a turn already stopping changes nothing
        if (t.asking) send({ type: 'control_cancel_request', request_id: t.asking.id })
        setImmediate(() => straggle(t))
      }
      return { still_queued: queued.map(q => q.uuid) }
    },
  }

  readline.createInterface({ input: process.stdin })
    .on('line', async line => {
      const msg = JSON.parse(line)
      if (msg.type === 'user') return prompt({ uuid: msg.uuid, text: msg.message.content })
      if (msg.type === 'control_response') {
        waiting.get(msg.response.request_id)?.(msg.response.response)
        return waiting.delete(msg.response.request_id)
      }
      if (msg.type === 'control_request') respond(msg.request_id, await CONTROL[msg.request.subtype](msg.request))
    })
    .on('close', () => process.exit(0)) // Claude Code exits when its input ends
}
