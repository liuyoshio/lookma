// What the Claude Code adapter needs (core/plugins.mjs reads this): its settings, and the check
// lookma doctor and the start's preflight run: Claude Code on PATH, recent enough for the Agent SDK,
// logged in, and with which login, since that decides who pays: a Claude plan's usage limits, or
// an API account. Node built-ins, the doctor's helpers and session.mjs only, so it runs before npm
// install.
import { ok, warn, fail, sh, atLeast } from '../../core/doctor.mjs'
import { sessionEnv } from './session.mjs'

// The Claude Code the Agent SDK in package.json was built against: the MCP servers the SDK sends
// at initialize need at least this one.
const NEEDS = { claude: '2.1.330' }

// `claude auth status --json`, or null when it does not answer in JSON.
function authStatus() {
  try {
    return JSON.parse(sh('claude', ['auth', 'status', '--json'], { env: sessionEnv(process.env) }).out)
  } catch {
    return null
  }
}

function checkClaude() {
  const v = sh('claude', ['--version'])
  if (!v.ok) return fail('Claude Code (claude) is not on PATH', 'npm install -g @anthropic-ai/claude-code')
  const version = v.out.match(/\d+\.\d+\.\d+/)?.[0] || v.out
  if (!atLeast(version, NEEDS.claude)) return fail(`Claude Code ${version}: Lookma needs ${NEEDS.claude} or later`, 'claude update')
  // Reads the stored login, in the environment the session gets; makes no model call.
  const auth = authStatus()
  if (!auth) return warn(`Claude Code ${version}; could not check the login`, 'Run claude once and log in if it asks.')
  if (!auth.loggedIn) return fail(`Claude Code ${version} is not logged in`, 'claude auth login')
  if (auth.authMethod === 'claude.ai') return ok(`Claude Code ${version}, logged in with your Claude plan (${auth.subscriptionType}): Lookma's work counts against its usage limits`)
  const via = auth.apiProvider && auth.apiProvider !== 'firstParty' ? ` through ${auth.apiProvider}` : ''
  return ok(`Claude Code ${version}, logged in with ${auth.authMethod}${via}: Lookma's work is billed to that account`)
}

export default {
  title: 'Claude Code',
  settings: {
    model: { default: 'sonnet', help: 'the Claude Code model, e.g. opus' },
    effort: { default: '', help: "Claude Code's reasoning effort: low, medium, high, xhigh or max; empty, the model's default" },
    permissionMode: { default: 'auto', help: "Claude Code's permission mode; default gives more cards" },
    flags: { default: '', help: 'extra flags for claude, separated by spaces' },
  },
  checks: [checkClaude],
}
