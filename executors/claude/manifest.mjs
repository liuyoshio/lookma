// What the Claude Code adapter needs (core/plugins.mjs reads this): its settings, and the checks
// lookma doctor and the start's preflight run: tmux, and Claude Code logged in. Node built-ins and
// the doctor's helpers only, so it runs before npm install.
import { ok, warn, fail, sh, atLeast } from '../../core/doctor.mjs'

const NEEDS = { claude: '2.1.312' }

function checkTmux() {
  const tmux = sh('tmux', ['-V'])
  return tmux.ok ? ok(tmux.out) : fail('tmux is not installed (Claude Code runs in it)', 'brew install tmux')
}

function checkClaude() {
  const v = sh('claude', ['--version'])
  if (!v.ok) return fail('Claude Code (claude) is not on PATH', 'npm install -g @anthropic-ai/claude-code')
  const version = v.out.match(/\d+\.\d+\.\d+/)?.[0] || v.out
  if (!atLeast(version, NEEDS.claude)) return fail(`Claude Code ${version}: Lookma needs ${NEEDS.claude} or later`, 'claude update')
  // Reads the stored login; makes no model call.
  let auth = null
  try {
    auth = JSON.parse(sh('claude', ['auth', 'status', '--json']).out)
  } catch {}
  if (auth?.loggedIn) return ok(`Claude Code ${version}, logged in${auth.authMethod ? ` (${auth.authMethod})` : ''}`)
  if (auth) return fail(`Claude Code ${version} is not logged in`, 'claude auth login')
  return warn(`Claude Code ${version}; could not check the login`, 'Run claude once and log in if it asks.')
}

export default {
  title: 'Claude Code',
  settings: {
    model: { default: 'sonnet', help: 'the Claude Code model (--model), e.g. opus' },
    permissionMode: { default: 'auto', help: "Claude Code's permission mode; default gives more cards" },
    flags: { default: '', help: 'extra flags for claude, separated by spaces' },
    // Its old name, for as long as the adapter runs Claude Code in tmux.
    session: { default: 'lookma', env: 'LOOKMA_EXEC_SESSION', help: 'the tmux session that runs Claude Code; watch it with tmux attach -t <name>' },
  },
  checks: [checkTmux, checkClaude],
}
