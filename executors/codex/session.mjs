// The Codex session: its folder, the app-server command line, and what Lookma asks of app-server.
// The folder is the host's session folder (<dataDir>/sessions/codex/), set up again on every start:
//   home/  CODEX_HOME. Lookma puts only a link to the user's auth.json in it, so the login is
//          shared while the user's own config.toml, MCP servers and plugins stay out.
//   work/  the thread's working dir. Empty, so no AGENTS.md is read; scratch files land here.
import fs from 'node:fs'
import path from 'node:path'

const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

// Codex features Lookma turns off: ChatGPT connectors and plugins, Codex's own screen and browser
// control (the hands are Lookma's), subagents (no background tasks yet), memories across runs and
// image generation.
const DISABLED = ['apps', 'plugins', 'computer_use', 'browser_use', 'multi_agent', 'memories', 'image_generation']

// Streaming deltas and usage counters: the adapter reads whole items only.
const QUIET = [
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'command/exec/outputDelta',
  'process/outputDelta',
  'turn/diff/updated',
  'thread/tokenUsage/updated',
  'account/rateLimits/updated',
]

// codexHome: the user's Codex folder, whose auth.json is linked.
export function writeSession(dir, codexHome) {
  const home = path.join(dir, 'home')
  const work = path.join(dir, 'work')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(work, { recursive: true })
  const link = path.join(home, 'auth.json')
  fs.rmSync(link, { force: true })
  fs.symlinkSync(path.join(codexHome, 'auth.json'), link)
  return { home, work }
}

// `codex app-server` speaks JSON-RPC on stdio. --strict-config turns a mistyped setting into an
// error instead of ignoring it. The file credential store makes Codex keep the login in the linked
// auth.json, never in the keychain. env is the host's, without the other plug-ins' secrets (the
// voice's OpenAI key): Codex uses the ChatGPT login.
export function appServer(home, env) {
  return {
    command: 'codex',
    args: ['app-server', '--strict-config', '-c', 'cli_auth_credentials_store="file"', ...DISABLED.flatMap(f => ['--disable', f])],
    env: { ...env, CODEX_HOME: home },
  }
}

export function initializeParams() {
  return {
    clientInfo: { name: 'lookma', title: null, version },
    capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: QUIET },
  }
}

// One thread for the whole session, so a follow-up ("now close it") has the context. tools: the
// host's ctx.tools, whose bridge Codex spawns as an MCP server.
export function threadParams({ options, dirs, work, instructions, tools }) {
  return {
    cwd: work,
    model: options.model || null, // null: Codex's default model
    serviceTier: options.fast ? 'priority' : null, // 'priority' is the tier Codex calls Fast
    approvalPolicy: 'on-request', // a step that needs more than the sandbox asks first, as a card
    sandbox: 'workspace-write',
    developerInstructions: instructions, // after Codex's own base prompt, which teaches its shell and patch tools
    ephemeral: true, // nothing is kept in Codex's session history
    config: {
      mcp_servers: {
        [tools.server]: {
          ...tools.mcp(),
          default_tools_approval_mode: 'approve', // say and the hands never ask: the core's own cards are the gate
          tool_timeout_sec: 600, // a hands step may wait for the user's answer to a card
        },
      },
      // Commands may write in work/, the user's folders and tmp, and read anywhere; no network.
      sandbox_workspace_write: { writable_roots: dirs, network_access: false },
    },
  }
}
