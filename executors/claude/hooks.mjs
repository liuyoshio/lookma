// Claude Code's hook events (the SDK's hook callbacks) → contract events: a step for each tool call
// of the main agent, and a task for each subagent, with its progress and its report. Turns come
// from the stream instead (index.mjs). Pure.
import { clip } from '../../core/util.mjs'
import { title } from '../../core/executor/steps.mjs'

/** The hook events this handler reads, for the SDK's hooks option. */
export const EVENTS = ['PreToolUse', 'SubagentStart', 'SubagentStop']

/** One readable line for a tool call: its step title (core/executor/steps.mjs). */
export function describe(tool, i) {
  switch (tool) {
    case 'Bash': return title('run', i.description || i.command)
    case 'Read': return title('read', i.file_path)
    case 'Write': return title('write', i.file_path)
    case 'Edit': case 'MultiEdit': return title('edit', i.file_path)
    case 'NotebookEdit': return title('edit', i.notebook_path)
    case 'Grep': case 'Glob': return title('search', i.pattern)
    case 'WebSearch': return title('web', i.query)
    case 'WebFetch': return title('read', i.url)
    case 'Agent': case 'Task': return title('task', i.description)
  }
  const m = tool.match(/^mcp__(.+?)__(.+)$/)
  return title('tool', m ? `${m[1]} · ${m[2].replace(/_/g, ' ')}` : tool)
}

// A subagent's report ends with
//   SAY: one sentence to speak, in the user's language
//   SHOW: one line to display
// as session.mjs teaches. Anything else is used as is, shortened.
export function splitReport(text) {
  const speech = text.match(/^\s*SAY:\s*(.+)$/im)?.[1]?.trim()
  const display = text.match(/^\s*SHOW:\s*(.+)$/im)?.[1]?.trim()
  const rest = text.replace(/^\s*(SAY|SHOW):.*$/gim, '')
  return { speech: speech || clip(rest, 120), display: display || speech || clip(rest, 200) }
}

// server: the name of Lookma's own MCP server, whose tools show themselves and are never steps.
export function createHookHandler({ emit, server }) {
  const ours = `mcp__${server}__`
  const tasks = new Set() // running subagent ids
  const titles = [] // descriptions of Agent calls, waiting for their SubagentStart
  const handbacks = new Map() // agent id -> its SubagentHandback message

  return function hook(h) {
    const id = h.agent_id
    switch (h.hook_event_name) {
      case 'PreToolUse':
        if (id) {
          if (h.tool_name === 'SubagentHandback') handbacks.set(id, h.tool_input.message)
          else if (tasks.has(id)) emit({ type: 'task', id, status: 'running', action: describe(h.tool_name, h.tool_input) })
        } else if (!h.tool_name.startsWith(ours)) {
          if (h.tool_name === 'Agent' || h.tool_name === 'Task') titles.push(clip(h.tool_input.description, 40))
          emit({ type: 'step', title: describe(h.tool_name, h.tool_input) })
        }
        break
      case 'SubagentStart':
        // Claude Code's internal agents (prompt suggestions and the like) come with an empty type.
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
