// The Codex session: its folder, the app-server command line, and what Lookma asks of app-server.
// The folder is <dataDir>/sessions/codex/, set up again on every start:
//   home/  CODEX_HOME. Lookma puts only a link to the user's auth.json in it, so the login is
//          shared while the user's own config.toml, MCP servers and plugins stay out.
//   work/  the thread's working dir. Empty, so no AGENTS.md is read; scratch files land here.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', '..', 'package.json'), 'utf8'))

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

export function writeSession(config, opts) {
  const dir = path.join(config.dataDir, 'sessions', 'codex')
  const home = path.join(dir, 'home')
  const work = path.join(dir, 'work')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(work, { recursive: true })
  const link = path.join(home, 'auth.json')
  fs.rmSync(link, { force: true })
  fs.symlinkSync(path.join(opts.codexHome, 'auth.json'), link)
  return { dir, home, work }
}

// `codex app-server` speaks JSON-RPC on stdio. --strict-config turns a mistyped setting into an
// error instead of ignoring it. The file credential store makes Codex keep the login in the linked
// auth.json, never in the keychain.
export function appServer(home) {
  const env = { ...process.env, CODEX_HOME: home }
  delete env.OPENAI_API_KEY // the voice's key, which .env holds, stays with Lookma: Codex uses the ChatGPT login
  return {
    command: 'codex',
    args: ['app-server', '--strict-config', '-c', 'cli_auth_credentials_store="file"', ...DISABLED.flatMap(f => ['--disable', f])],
    env,
  }
}

export function initializeParams() {
  return {
    clientInfo: { name: 'lookma', title: null, version },
    capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: QUIET },
  }
}

// One thread for the whole run, so a follow-up ("now close it") has the context.
export function threadParams({ config, opts, dirs, work, instructions }) {
  return {
    cwd: work,
    model: opts.model,
    serviceTier: opts.fast ? 'priority' : null, // 'priority' is the tier Codex calls Fast
    approvalPolicy: 'on-request', // a step that needs more than the sandbox asks first, as a card
    sandbox: 'workspace-write',
    developerInstructions: instructions, // after Codex's own base prompt, which teaches its shell and patch tools
    ephemeral: true, // nothing is kept in Codex's session history
    config: {
      mcp_servers: {
        lookma: {
          command: process.execPath,
          args: [path.join(HERE, 'mcp.mjs')],
          env: { LOOKMA_CORE_URL: `ws://127.0.0.1:${config.port}/ws/executor` },
          default_tools_approval_mode: 'approve', // say and the hands never ask: the core's own cards are the gate
          tool_timeout_sec: 600, // a hands step may wait for the user's answer to a card
        },
      },
      // Commands may write in work/, the user's folders and tmp, and read anywhere; no network.
      sandbox_workspace_write: { writable_roots: dirs, network_access: false },
    },
  }
}
