// The Claude Code session: what Lookma asks of the Agent SDK's query(), and the environment Claude
// Code runs in. The SDK starts the user's own installed `claude`, so the session uses that login and
// its billing (lookma doctor says which). It is isolated from the user's own Claude Code:
//   settings   none of the user's, project or local settings (no CLAUDE.md, hooks or plugins);
//              only Lookma's, passed as flag settings
//   MCP        only the host's tools bridge (strict MCP config), its spec sent over stdin
//   folders    the session folder's work/ (<dataDir>/sessions/claude/work, empty) is the working
//              dir; the user's folders are added to it
// Node built-ins only: the manifest's login check uses sessionEnv too.
import fs from 'node:fs'
import path from 'node:path'

// A parent Claude Code's own session markers (CLAUDECODE, CLAUDE_CODE_*, CLAUDE_AGENT_SDK_*), set
// when Lookma is started from inside one. Inherited, they would make this session a child of that
// one: bare mode, for one, never reads the login. The user's own auth choices (ANTHROPIC_*,
// CLAUDE_CONFIG_DIR) are kept.
const PARENT = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/

/** The environment Claude Code runs in: env without a parent Claude Code's session markers. */
export function sessionEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !PARENT.test(name)))
}

// The background-task convention: hooks.mjs (splitReport) parses a subagent's report, so the
// adapter that parses it teaches it, after the instructions every agent gets.
const BACKGROUND = `
- If you can start background subagents, use them only for long work with nothing on screen. Tell each one: do not call \`say\` or the hands tools, and end the final message with two lines:
  - \`SAY: <one sentence to speak, in the user's language>\`
  - \`SHOW: <one short line to display>\`
`

// The tools' MCP server, as Claude Code lists it to the model. alwaysLoad: the tools are listed
// from the start instead of behind Claude Code's tool search, so say and the hands are never a
// lookup away.
const TOOLS = {
  toolMeta: { 'anthropic/alwaysLoad': true },
  instructions:
    'The user talks to you by voice through Lookma and watches the screen; they never see your text replies. ' +
    'Speak to them only with the say tool. Work on screen only with the see, click, type, key, scroll and open tools.',
}

/** The `claude` on env's PATH, as an absolute path: the SDK starts that one, never its own. */
export function findClaude(env) {
  for (const dir of env.PATH.split(':')) {
    const file = path.join(dir, 'claude')
    if (dir && fs.existsSync(file)) return file
  }
  throw new Error('claude is not on PATH')
}

/** LOOKMA_CLAUDE_FLAGS, "--name value --switch", as the SDK's extraArgs { name: value, switch: null }. */
export function extraArgs(flags) {
  const args = {}
  const words = flags.split(/\s+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    const [name, inline] = words[i].replace(/^--?/, '').split(/=(.*)/s)
    const next = words[i + 1]
    args[name] = inline ?? (next && !next.startsWith('-') ? words[++i] : null)
  }
  return args
}

/**
 * The options of query(). options: the adapter's settings; tools, instructions, env: the host's
 * ctx; work: the working dir; dirs: the user's folders; resume: the session id to go on with, or
 * null; canUseTool and hooks: the adapter's.
 */
export function queryOptions({ options, tools, instructions, env, work, dirs, resume, canUseTool, hooks }) {
  return {
    pathToClaudeCodeExecutable: findClaude(env),
    env: sessionEnv(env),
    cwd: work,
    additionalDirectories: dirs,
    settingSources: [],
    // Lookma's own settings. Allowed: say and the hands never ask, since the core's own cards gate
    // the hands (a settings rule, not allowedTools, which the SDK warns would shadow canUseTool).
    // Denied: Claude Code's own computer use (the hands are Lookma's), AskUserQuestion (a card
    // cannot answer it), and a subagent forked from the whole conversation (one starts fresh with
    // its brief, BACKGROUND). At most one level of subagents: a subagent cannot start its own.
    settings: {
      permissions: { allow: [`mcp__${tools.server}`], deny: ['mcp__computer-use', 'AskUserQuestion', 'Agent(fork)'] },
      env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1' },
    },
    strictMcpConfig: true,
    mcpServers: { [tools.server]: { type: 'stdio', ...tools.mcp(TOOLS) } },
    mcpServersDelivery: 'initialize', // over stdin: on the command line, the bridge's env would be visible to other users
    // Claude Code's own system prompt, which teaches its tools, then Lookma's.
    systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions + BACKGROUND },
    model: options.model,
    permissionMode: options.permissionMode,
    canUseTool,
    hooks,
    ...(resume && { resume }),
    extraArgs: extraArgs(options.flags),
  }
}
