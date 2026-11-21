// Codex thread items → steps (core/executor/steps.mjs): one per item that does something, null
// for the rest (reasoning, messages, plans) and for Lookma's own tools, which show themselves. Pure.
import { title } from '../../core/executor/steps.mjs'

// Codex runs each command through the login shell: "/bin/zsh -lc 'ls -la'" reads as "ls -la".
export function unwrap(command) {
  return command.match(/^\S*\b(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/)?.[2] ?? command
}

const EDITS = { add: 'write', delete: 'delete' } // a change kind's step; any other is an edit

// server: the name of Lookma's own MCP server.
export function stepTitle(item, server) {
  switch (item.type) {
    case 'commandExecution': {
      const a = item.commandActions[0] // Codex's reading of the command, when it has one
      if (a?.type === 'read') return title('read', a.name)
      if (a?.type === 'listFiles') return title('list', a.path)
      if (a?.type === 'search') return title('search', a.query)
      return title('run', unwrap(item.command))
    }
    case 'fileChange':
      return title(EDITS[item.changes[0]?.kind.type] || 'edit', item.changes.map(c => c.path))
    case 'webSearch':
      if (item.action?.type === 'openPage' && item.action.url) return title('read', item.action.url)
      return title('web', item.query)
    case 'mcpToolCall':
      return item.server === server ? null : title('tool', `${item.server} · ${item.tool}`)
  }
  return null
}
