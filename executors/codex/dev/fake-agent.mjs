#!/usr/bin/env node
// A stand-in for `codex app-server`, for core/dev/check-executors.mjs: it speaks app-server's
// JSON-RPC on stdio, spawns the tools bridge from the thread config as Codex does and calls its
// tools over MCP, and plays each prompt as one of the conformance commands listed in
// check-executors.mjs. No model, no network.
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// The command the adapter spawns, which the check puts first on its PATH.
export const bin = 'codex'

if (process.argv[1] === fileURLToPath(import.meta.url)) play()

function play() {
  const send = msg => process.stdout.write(JSON.stringify(msg) + '\n')
  const notify = (method, params) => send({ method, params })
  const waiting = new Map() // our request id -> resolve
  let seq = 0
  let tools = null // the MCP client of the tools bridge
  let turn = null // { id, cmd } of the turn running
  let turns = 0

  function request(method, params) {
    const id = ++seq
    send({ id, method, params })
    return new Promise(resolve => waiting.set(id, resolve))
  }

  async function call(name, args) {
    const r = await tools.callTool({ name, arguments: args })
    return r.content.find(c => c.type === 'text').text
  }

  const step = (t, command) => notify('item/started', { threadId: 'T', turnId: t.id, item: { type: 'commandExecution', id: `c${++seq}`, command, commandActions: [] } })

  function complete(t, status, summary, error) {
    if (turn !== t) return // ended already: interrupted, or steered
    turn = null
    if (summary) notify('item/completed', { threadId: 'T', turnId: t.id, item: { type: 'agentMessage', id: `m${++seq}`, text: summary } })
    notify('turn/completed', { threadId: 'T', turn: { id: t.id, status, error: error ? { message: error } : null } })
  }

  // The stopped work's stragglers, which the host must hold back, then the end.
  async function straggle(t) {
    await call('say', { speech: 'late' })
    step(t, 'late step')
    complete(t, 'interrupted')
  }

  const PLAY = {
    say: async (t, words) => {
      await call('say', { speech: words })
      complete(t, 'completed', words)
    },
    see: async t => complete(t, 'completed', await call('see', { label: 'Look' })),
    ask: async t => {
      const r = await request('item/commandExecution/requestApproval', { threadId: 'T', turnId: t.id, itemId: `c${++seq}`, command: 'touch notes.txt', reason: 'Write a file', availableDecisions: ['accept', 'decline'] })
      complete(t, 'completed', r.decision === 'accept' ? 'yes' : 'no')
    },
    fail: t => complete(t, 'failed', '', 'boom'),
    work: t => step(t, 'sleep 60'),
    stuck: t => step(t, 'sleep 60'),
    die: () => process.exit(3),
  }

  const METHODS = {
    initialize: () => ({}),
    // Answers, then starts the tools and says so, as Codex does.
    'thread/start'(p) {
      const [name, spec] = Object.entries(p.config.mcp_servers)[0]
      setImmediate(async () => {
        tools = new Client({ name: 'fake-codex', version: '0' })
        await tools.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...process.env, ...spec.env } }))
        notify('mcpServer/startupStatus/updated', { name, status: 'ready', error: null })
      })
      return { thread: { id: 'T', ephemeral: true }, model: 'fake', serviceTier: null }
    },
    'turn/start'(p) {
      const [cmd, ...words] = p.input[0].text.split(' ')
      if (cmd === 'refuse') throw new Error('usage limit reached')
      const t = (turn = { id: `turn${++turns}`, cmd })
      setImmediate(() => {
        notify('turn/started', { threadId: 'T', turn: { id: t.id, status: 'inProgress' } })
        PLAY[cmd](t, words.join(' '))
      })
      return { turn: { id: t.id } }
    },
    'turn/steer'(p) {
      if (turn?.id !== p.expectedTurnId) throw new Error('no active turn to steer')
      const t = turn
      setImmediate(() => complete(t, 'completed', `steered: ${p.input[0].text}`))
      return { turnId: t.id }
    },
    'turn/interrupt'() {
      const t = turn
      if (t && t.cmd !== 'stuck') setImmediate(() => straggle(t))
      return {}
    },
  }

  readline.createInterface({ input: process.stdin })
    .on('line', async line => {
      const msg = JSON.parse(line)
      if (!msg.method) {
        waiting.get(msg.id)(msg.result)
        return waiting.delete(msg.id)
      }
      if (msg.id === undefined) return // a notification: initialized
      try {
        send({ id: msg.id, result: await METHODS[msg.method](msg.params) })
      } catch (err) {
        send({ id: msg.id, error: { code: -32600, message: err.message } })
      }
    })
    .on('close', () => process.exit(0)) // app-server exits when its input ends
}
