// Claude Code adapter (executor contract v2, docs/protocol.md), on the Claude Agent SDK: the SDK
// runs the user's installed `claude` headless, isolated (session.mjs), with one open stream of
// prompts per session.
//   start      query(); resolves once Claude Code is initialised and the tools' MCP server is connected
//   prompt     one user message into the stream; during a turn, Claude Code takes it into that turn
//   interrupt  Query.interrupt(); resolves on the interrupted turn's result
//   result → turnEnd     a main-agent message while idle → turnStart (a background task woke it)
//   canUseTool → cards (approvals.mjs)     hooks → steps and tasks (hooks.mjs)
// After close, start goes on with the same conversation, by its session id.
import fs from 'node:fs'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { clip, sleep } from '../../core/util.mjs'
import { queryOptions } from './session.mjs'
import { EVENTS, createHookHandler } from './hooks.mjs'
import { createCanUseTool } from './approvals.mjs'

// The prompt stream query() reads: open until end(), so the session lives between turns.
function createInbox() {
  const waiting = []
  let wake = null
  let ended = false
  return {
    push(text) {
      waiting.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
      wake?.()
    },
    end() {
      ended = true
      wake?.()
    },
    async *stream() {
      for (;;) {
        if (waiting.length) yield waiting.shift()
        else if (ended) return
        else await new Promise(resolve => (wake = resolve))
      }
    },
  }
}

// Resolves once Claude Code has connected the tools' MCP server; rejects in words if it failed.
async function toolsUp(session, name) {
  for (;;) {
    const s = (await session.mcpServerStatus()).find(s => s.name === name)
    if (s.status === 'connected') return
    if (s.status !== 'pending') throw new Error(`the tools did not start (${s.status}${s.error ? `: ${s.error}` : ''})`)
    await sleep(100)
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
  let ending = [] // interrupts waiting for the turn's result

  function settle() {
    for (const resolve of ending) resolve()
    ending = []
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
      return settle()
    }
    if (!busy && main && (m.type === 'assistant' || (m.type === 'system' && m.subtype === 'init'))) {
      busy = true
      emit({ type: 'turnStart' })
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
    settle()
    if (!closing) emit({ type: 'down', detail: reason })
  }

  return {
    // `lookma start` has checked the claude binary and the login already (manifest.mjs).
    async start({ dirs }) {
      closing = false
      busy = false
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
      inbox.push(text)
    },

    async interrupt() {
      if (!busy) return
      const end = new Promise(resolve => ending.push(resolve))
      await q.interrupt()
      await end
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
