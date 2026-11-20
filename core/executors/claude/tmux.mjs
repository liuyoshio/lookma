// The tmux session that runs interactive Claude Code. Targets use "=name" so "lookma" never
// matches "lookma-test" by prefix. The pane starts at 120x40, the size the dialog parser was
// checked at (see core/dev/fixtures/claude-captures).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`

export function createTmux(name) {
  const session = `=${name}`
  const pane = `=${name}:`
  const run = async (...args) => (await exec('tmux', args, { encoding: 'utf8' })).stdout
  return {
    name,
    alive: () => run('has-session', '-t', session).then(() => true, () => false),
    start: ({ cwd, argv, env = {} }) =>
      run('new-session', '-d', '-s', name, '-x', '120', '-y', '40', '-c', cwd,
        ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        argv.map(quote).join(' ')),
    capture: () => run('capture-pane', '-p', '-t', pane),
    keys: (...keys) => run('send-keys', '-t', pane, ...keys),
    kill: () => run('kill-session', '-t', session).then(() => true, () => false),
  }
}
