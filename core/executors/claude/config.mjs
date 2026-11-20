// The Claude adapter's settings, from the environment. The core's loadConfig() has merged .env into
// it before any adapter is created.
export function loadConfig(env = process.env) {
  return {
    session: env.LOOKMA_EXEC_SESSION || 'lookma', // the tmux session, and the name of its working dir
    model: env.LOOKMA_MODEL || 'sonnet',
    permissionMode: env.LOOKMA_PERMISSION_MODE || 'auto',
    flags: (env.LOOKMA_CLAUDE_FLAGS || '').split(/\s+/).filter(Boolean), // extra claude arguments
    path: env.PATH || '', // where claude is found; Claude Code runs with the same PATH
  }
}
