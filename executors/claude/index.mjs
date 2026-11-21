// Claude Code adapter (executor contract v2, docs/protocol.md), on the Claude Agent SDK: the SDK
// runs the user's installed `claude` headless, isolated (session.mjs), with one open stream of
// prompts per session.
//   start      query(); resolves once Claude Code is initialised and the tools' MCP server is connected
//   prompt     one user message into the stream; during a turn, Claude Code takes it into that turn
//   interrupt  Query.interrupt() until nothing of ours is left to run; resolves on the last result
//   result → turnEnd     a main-agent message while idle → turnStart (a background task woke it)
//   canUseTool → cards (approvals.mjs)     hooks → steps and tasks (hooks.mjs)
// After close, start goes on with the same conversation, by its session id.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { clip, sleep } from '../../core/util.mjs'
import { queryOptions } from './session.mjs'
import { EVENTS, createHookHandler } from './hooks.mjs'
import { createCanUseTool } from './approvals.mjs'

const TOOLS_MS = 30000 // how long Claude Code may take to connect the tools' MCP server

// The prompt stream query() reads: open until end(), so the session lives between turns. Each
// message carries a uuid, by which an interrupt's receipt names the ones that survive it.
function createInbox() {
  const waiting = []
  let wake = null
  let ended = false
  let drained = [] // written() calls waiting for the SDK to have written everything pushed
  return {
    /** Queues a prompt; returns its uuid. */
    push(text) {
      const uuid = randomUUID()
      waiting.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid })
      wake?.()
      return uuid
    },
    end() {
      ended = true
      wake?.()
    },
    // Resolves once the SDK has written every pushed message to Claude Code, so a control request
    // sent after it reaches Claude Code after them.
    written() {
      return waiting.length ? new Promise(resolve => drained.push(resolve)) : Promise.resolve()
    },
    async *stream() {
      for (;;) {
        if (waiting.length) {
          // The SDK asks for the next message only after writing this one.
          yield waiting[0]
          waiting.shift()
          if (!waiting.length) for (const resolve of drained.splice(0)) resolve()
        } else if (ended) return
        else await new Promise(resolve => (wake = resolve))
      }
    },
  }
}

// Resolves once Claude Code has connected the tools' MCP server; rejects in words if it failed,
// is not listed, or is still pending after TOOLS_MS.
async function toolsUp(session, name) {
  for (const end = Date.now() + TOOLS_MS; ; await sleep(100)) {
    const s = (await session.mcpServerStatus()).find(s => s.name === name)
    if (!s) throw new Error('the tools did not start')
    if (s.status === 'connected') return
    if (s.status !== 'pending') throw new Error(`the tools did not start (${s.status}${s.error ? `: ${s.error}` : ''})`)
    if (Date.now() > end) throw new Error(`the tools did not start within ${TOOLS_MS / 1000} s`)
  }
}

export function create(ctx) {
  const { emit, log } = ctx
  const hook = createHookHandler({ emit, server: ctx.tools.server })
  const hooks = Object.fromEntries(EVENTS.map(name => [name, [{ hooks: [async input => (hook(input), {})] }]]))
  const canUseTool = createCanUseTool({ ask: ctx.ask, log })
  let q = null // the session's Query
  let inbox = null
  let reading = null // settles when the session's stream ends
  let sessionId = null // the conversation, resumed by the next start
  let busy = false // a turn runs: from a prompt, or a main-agent message while idle, to its result
  let closing = false
  const sent = new Set() // the uuids of this session's prompts
  // The stop under way, or null: { resolve, reject, asked: interrupts not yet answered, left: the
  // last receipt names prompts of ours that will still run }. A plain interrupt stops the running
  // turn only; a prompt Claude Code has queued survives it and runs next (its receipt's
  // still_queued). So the stop interrupts every turn that starts while it lasts, asks again after
  // a turn ends while some were left, and is over when no turn runs, every interrupt is answered
  // and the last receipt names none of ours.
  let stop = null

  // One more interrupt for the stop under way.
  function halt() {
    stop.asked++
    answered(stop, q.interrupt())
  }

  function answered(s, receipt) {
    receipt.then(r => {
      s.asked--
      // An older Claude Code sends no receipt. The list may name messages that are not ours.
      s.left = !!r?.still_queued.some(id => sent.has(id))
      if (s === stop && !busy && !s.asked && !s.left) over()
    }, s.reject)
  }

  function over() {
    const s = stop
    stop = null
    s.resolve()
  }

  function onMessage(m) {
    if (m.session_id !== sessionId) log(`session ${m.session_id}`)
    sessionId = m.session_id
    const main = !m.parent_tool_use_id
    if (m.type === 'result') {
      busy = false
      // A success can still be an error (a usage limit, an API error), with the reason as its text.
      const ok = m.subtype === 'success' && !m.is_error
      const error = ok ? undefined : (m.subtype === 'success' ? m.result : m.errors.join('; ')) || m.subtype
      log(`turn ${ok ? 'done' : `${m.subtype}: ${error}`}`)
      emit({ type: 'turnEnd', ok, summary: m.result, error })
      if (stop && !stop.asked) stop.left ? halt() : over()
      return
    }
    if (!busy && main && (m.type === 'assistant' || (m.type === 'system' && m.subtype === 'init'))) {
      busy = true
      emit({ type: 'turnStart' })
      if (stop) halt()
    }
    // The model is told to speak only with say; its text replies are for this log.
    if (m.type === 'assistant' && main) for (const b of m.message.content) if (b.type === 'text') log('message', clip(b.text, 200))
  }

  async function read(session) {
    let reason = 'Claude Code ended the session'
    try {
      for await (const m of session) if (session === q) onMessage(m)
    } catch (err) {
      reason = err.message
    }
    if (session !== q) return
    busy = false
    if (stop) over()
    if (!closing) emit({ type: 'down', detail: reason })
  }

  return {
    // `lookma start` has checked the claude binary and the login already (manifest.mjs).
    async start({ dirs }) {
      closing = false
      busy = false
      sent.clear()
      const work = path.join(ctx.sessionDir, 'work')
      fs.mkdirSync(work, { recursive: true })
      inbox = createInbox()
      const options = queryOptions({ options: ctx.options, tools: ctx.tools, instructions: ctx.instructions, env: ctx.env, work, dirs, resume: sessionId, canUseTool, hooks })
      log(`Claude Code is starting (${options.pathToClaudeCodeExecutable}${sessionId ? `, resuming ${sessionId}` : ''})`)
      q = query({ prompt: inbox.stream(), options })
      reading = read(q)
      const init = await q.initializationResult()
      await toolsUp(q, ctx.tools.server)
      // Who pays, in the log too: a plan's usage limits, or an API account.
      const { subscriptionType, apiKeySource, apiProvider } = init.account
      log(`Claude Code ${init.claude_code_version} ready, ${subscriptionType ? `on the ${subscriptionType} plan` : `billed through ${apiKeySource || apiProvider || 'an unknown login'}`}`)
    },

    async prompt(text) {
      busy = true
      sent.add(inbox.push(text))
    },

    // Asked even while idle: a prompt queued behind the last result may be about to run.
    async interrupt() {
      const session = q
      const done = new Promise((resolve, reject) => (stop = { resolve, reject, asked: 1, left: false }))
      const s = stop
      await inbox.written()
      answered(s, session.interrupt())
      await done
    },

    async close() {
      closing = true
      if (!q) return
      inbox.end()
      q.close()
      await reading
      q = inbox = reading = null
    },
  }
}
