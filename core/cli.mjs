// The lookma command: start, doctor, --help, --version. bin/lookma only finds Node and runs this.
// Its static imports use only Node's own modules, so everything but start works before
// `npm install`.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT, loadConfig } from './config.mjs'
import { createLog } from './util.mjs'
import { isStale, build } from './app-build.mjs'
import { doctor, preflight } from './doctor.mjs'

const log = createLog()

// The full list of settings is the README's Configuration table; this names the ones a new user needs.
const HELP = `lookma: talk to your Mac. Watch it work.

Usage:
  lookma [dir ...]         Start. The agent may work in each dir you pass.
  lookma start [dir ...]   The same.
  lookma doctor [--fix]    Check what Lookma needs, with a fix for each problem.
                           --fix opens System Settings at the first missing permission.
  lookma --version         Print the version.
  lookma --help            Print this help.

While it runs, watch the agent: Claude Code in its terminal (tmux attach -t lookma),
Codex in the log of the terminal that started Lookma.
Just talk. While Lookma runs and is not paused, it listens: the microphone streams
to the voice, and macOS shows its microphone indicator. To approve a card, say
"yes, I approve". Pause or resume it with ⌃⌥P, its menu bar icon, or by saying
"pause". Quit from the menu bar icon, or with Ctrl-C in the terminal that started it.

Settings, from the environment or ${path.join(ROOT, '.env')}:
  OPENAI_API_KEY           turns on voice; without it you type instead
  LOOKMA_VOICE_LANGUAGE    the language you speak, e.g. en or zh; unset, it is detected
  LOOKMA_AUDIO             room (speakers, the default) or headset (talking over the voice stops it)
  LOOKMA_VOICE_MAX_TOKENS  the longest a spoken reply can be, in tokens (default 200)
  LOOKMA_EXECUTOR          the agent: claude (Claude Code, the default) or codex (Codex CLI)
  LOOKMA_MODEL             the Claude Code model, e.g. opus
  LOOKMA_PERMISSION_MODE   Claude Code's permission mode; default gives more cards
  LOOKMA_CODEX_MODEL       the Codex model; unset, Codex's default
  LOOKMA_CODEX_FAST        1: Codex's Fast speed tier (uses more of your plan)
All of them: the Configuration table in ${path.join(ROOT, 'README.md')}
`

const usage = message => Object.assign(new Error(`${message} (see lookma --help)`), { exitCode: 2 })

// `open` makes macOS attribute the permissions to the app, not to this terminal.
function launchApp(config) {
  log('launching', path.basename(config.app))
  const env = [`LOOKMA_PORT=${config.port}`]
  if (!config.voice.enabled) env.push(`LOOKMA_OVERLAY_URL=http://127.0.0.1:${config.port}/?voice=0`)
  spawn('open', [...env.flatMap(e => ['--env', e]), '-a', config.app], { stdio: 'ignore', detached: true }).unref()
}

async function start(args) {
  const option = args.find(a => a.startsWith('-'))
  if (option) throw usage(`unknown option ${option}`)
  const dirs = args.map(d => path.resolve(d))
  for (const d of dirs) if (!fs.statSync(d, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`not a directory: ${d}`)
  const config = loadConfig()

  // Without the app (LOOKMA_NO_APP=1) its build is yours too, which also keeps a dev core from
  // replacing the bundle another Lookma is running.
  const building = config.launchApp && isStale(config)
  await preflight(config, { build: building })
  if (building) build(config)
  // Only now: the core needs the npm packages the preflight checked for.
  const { createCore } = await import('./core.mjs')
  const { startServer } = await import('./server.mjs')

  // Ctrl-C, SIGTERM, Quit in the app's menu bar, or an executor that does not start: the app
  // quits, the executor stops, we exit.
  let stopping = false
  async function shutdown(why, code = 0) {
    if (stopping) return
    stopping = true
    log('stopping', why)
    await core.stop().catch(err => log('stop failed', err.message))
    server.close()
    process.exit(code)
  }

  const core = await createCore(config, { log, onQuit: () => shutdown('quit from the app') })
  const server = await startServer({ config, core, log })
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  try {
    log('executor started', await core.startExecutor(dirs))
  } catch (err) {
    console.error(`lookma: the executor did not start: ${err.message}`)
    return shutdown('the executor did not start', 1)
  }
  // Last, so that a start that fails leaves no app behind: one not yet connected cannot be told to quit.
  if (config.launchApp) launchApp(config)
  else log('LOOKMA_NO_APP=1: not launching the app')
}

async function runDoctor(args) {
  const option = args.find(a => a !== '--fix')
  if (option) throw usage(`unknown doctor option ${option}`)
  process.exitCode = await doctor(loadConfig(), { fix: args.includes('--fix') })
}

const COMMANDS = {
  start,
  doctor: runDoctor,
  '--help': () => process.stdout.write(HELP),
  '-h': () => process.stdout.write(HELP),
  '--version': () => console.log(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version),
}

// `lookma [dir ...]` is `lookma start [dir ...]`.
const argv = process.argv.slice(2)
const [name, ...args] = Object.hasOwn(COMMANDS, argv[0] ?? '') ? argv : ['start', ...argv]
try {
  await COMMANDS[name](args)
} catch (err) {
  console.error(`lookma: ${err.message}`)
  process.exit(err.exitCode ?? 1)
}
