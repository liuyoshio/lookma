// The generated working dir of the Claude Code session: .mcp.json (the channel proxy),
// settings.json (http hooks to the core, our tools allowed, built-in computer use denied, the
// user's folders) and the executor prompt. Lives in <dataDir>/sessions/<tmux session name>.
// The user's folders go in permissions.additionalDirectories, not --add-dir: --add-dir asks a
// trust question for every folder on every start, settings do not.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOKS = ['UserPromptSubmit', 'Stop', 'StopFailure', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop']

const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')

export function writeSession(config, session, dirs = []) {
  const dir = path.join(config.dataDir, 'sessions', session)
  fs.mkdirSync(dir, { recursive: true })

  writeJson(path.join(dir, '.mcp.json'), {
    mcpServers: {
      lookma: {
        command: process.execPath,
        args: [path.join(HERE, 'channel.mjs')],
        env: { LOOKMA_CORE_URL: `ws://127.0.0.1:${config.port}/ws/executor` },
      },
    },
  })

  const hook = [{ hooks: [{ type: 'http', url: `http://127.0.0.1:${config.port}/hook`, timeout: 2 }] }]
  writeJson(path.join(dir, 'settings.json'), {
    enabledMcpjsonServers: ['lookma'],
    permissions: {
      additionalDirectories: dirs,
      allow: ['mcp__lookma'],
      // The hands are ours; the user cannot answer AskUserQuestion from a card.
      deny: ['mcp__computer-use', 'AskUserQuestion', 'Agent(fork)'],
    },
    env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1' },
    hooks: Object.fromEntries(HOOKS.map(name => [name, hook])),
  })

  fs.copyFileSync(path.join(config.root, 'prompts', 'executor.md'), path.join(dir, 'executor.md'))
  return dir
}
