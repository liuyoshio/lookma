// Codex thread items → the step line the capsule shows: one readable line per item that does
// something, null for the rest (reasoning, messages, plans). Pure.
import path from 'node:path'
import { clip } from '../../util.mjs'

// Codex runs each command through the login shell: "/bin/zsh -lc 'ls -la'" reads as "ls -la".
export function unwrap(command) {
  return command.match(/^\S*\b(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/)?.[2] ?? command
}

export function stepTitle(item) {
  switch (item.type) {
    case 'commandExecution': {
      const a = item.commandActions[0] // Codex's reading of the command, when it has one
      if (a?.type === 'read') return `Read ${a.name}`
      if (a?.type === 'listFiles') return a.path && a.path !== '.' ? `List ${path.basename(a.path)}` : 'List files'
      if (a?.type === 'search') return a.query ? `Search for ${clip(a.query, 40)}` : 'Search files'
      return clip(unwrap(item.command))
    }
    case 'fileChange': {
      const [first, ...rest] = item.changes
      if (!first) return 'Edit files'
      const verb = { add: 'Write', delete: 'Delete' }[first.kind.type] || 'Edit'
      return `${verb} ${path.basename(first.path)}${rest.length ? ` + ${rest.length} more` : ''}`
    }
    case 'webSearch': {
      const url = item.action?.type === 'openPage' && item.action.url
      if (url) return `Read ${URL.canParse(url) ? new URL(url).host : clip(url, 40)}`
      return item.query ? `Search the web for ${clip(item.query, 40)}` : 'Search the web'
    }
    case 'mcpToolCall':
      return item.server === 'lookma' ? null : `${item.server} · ${item.tool}` // say and the hands show themselves
  }
  return null
}
