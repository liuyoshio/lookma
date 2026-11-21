// Claude Code http hooks → contract events: turnStart, turnEnd, step and task.
import path from 'node:path'
import { clip } from '../../core/util.mjs'

const base = p => (p ? path.basename(String(p)) : '')
const OURS = /^mcp__lookma__/ // say and the hands are visible already

// One readable line: what this tool call is doing.
export function describe(h) {
  const i = h.tool_input || {}
  if (i.label) return clip(i.label)
  switch (h.tool_name) {
    case 'Bash': return clip(i.description || i.command)
    case 'Read': return `Read ${base(i.file_path)}`
    case 'Write': return `Write ${base(i.file_path)}`
    case 'Edit': case 'MultiEdit': return `Edit ${base(i.file_path)}`
    case 'NotebookEdit': return `Edit ${base(i.notebook_path)}`
    case 'Grep': case 'Glob': return `Search for ${clip(i.pattern, 40)}`
    case 'WebSearch': return `Search the web for ${clip(i.query, 40)}`
    case 'WebFetch':
      try {
        return `Read ${new URL(i.url).host}`
      } catch {
        return 'Read a web page'
      }
    case 'Agent': case 'Task': return `Start: ${clip(i.description, 50)}`
  }
  const m = String(h.tool_name).match(/^mcp__(.+?)__(.+)$/)
  return m ? `${m[1]} · ${m[2].replace(/_/g, ' ')}` : String(h.tool_name)
}

// A subagent's report ends with
//   SAY: one sentence to speak, in the user's language
//   SHOW: one line to display
// Anything else is used as is, shortened.
export function splitReport(text) {
  const speech = text.match(/^\s*SAY:\s*(.+)$/im)?.[1]?.trim()
  const display = text.match(/^\s*SHOW:\s*(.+)$/im)?.[1]?.trim()
  const rest = text.replace(/^\s*(SAY|SHOW):.*$/gim, '')
  return { speech: speech || clip(rest, 120), display: display || speech || clip(rest, 200) }
}

export function createHookHandler({ emit, approvals }) {
  const tasks = new Set() // running subagent ids
  const titles = [] // descriptions of Agent calls, waiting for their SubagentStart
  const handbacks = new Map() // agent id -> SubagentHandback message

  return function hook(h) {
    const id = h.agent_id
    switch (h.hook_event_name) {
      case 'UserPromptSubmit':
        if (!id) emit({ type: 'turnStart' })
        break
      case 'Stop':
      case 'StopFailure':
        if (!id) emit({ type: 'turnEnd', ok: h.hook_event_name === 'Stop' })
        break
      case 'PreToolUse':
        if (id) {
          if (h.tool_name === 'SubagentHandback') handbacks.set(id, h.tool_input?.message || '')
          else if (tasks.has(id)) emit({ type: 'task', id, status: 'running', action: describe(h) })
        } else if (!OURS.test(h.tool_name)) {
          if (h.tool_name === 'Agent' || h.tool_name === 'Task') titles.push(clip(h.tool_input?.description, 40))
          emit({ type: 'step', title: describe(h) })
        }
        break
      case 'PostToolUse':
      case 'PostToolUseFailure':
        approvals.toolDone(h.tool_name)
        break
      case 'SubagentStart':
        // Internal agents (prompt suggestions and the like) come with an empty agent_type.
        if (!h.agent_type) break
        tasks.add(id)
        emit({ type: 'task', id, title: titles.shift() || h.agent_type, status: 'running' })
        break
      case 'SubagentStop':
        if (!tasks.has(id)) break
        tasks.delete(id)
        emit({ type: 'task', id, status: 'done', result: splitReport(handbacks.get(id) || h.last_assistant_message || '') })
        handbacks.delete(id)
        break
    }
  }
}
