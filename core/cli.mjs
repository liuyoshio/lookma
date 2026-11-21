// The lookma command: start, doctor, config, --help, --version. bin/lookma only finds Node and runs this.
// Its static imports use only Node's own modules, so everything but start works before
// `npm install`.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT, loadConfig, parseArgs } from './config.mjs'
import { createLog, usage } from './util.mjs'
import { isStale, build } from './app-build.mjs'
import { doctor, preflight } from './doctor.mjs'
import { describe } from './plugins.mjs'

const log = createLog()

// The core's settings a new user needs, then those of the selected plug-ins from their manifests.
// The full list is the README's Configuration table.
const HELP = `lookma: talk to your Mac. Watch it work.

Usage:
  lookma [options] [dir ...]         Start. The agent may work in each dir you pass.
  lookma start [options] [dir ...]   The same.
  lookma doctor [options] [--fix]    Check what Lookma needs, with a fix for each problem.
                                     --fix opens System Settings at the first missing permission.
  lookma config [options]            Print the settings in effect, and where each came from.
  lookma --version                   Print the version.
  lookma --help                      Print this help.

Options (each overrides the environment and .env):
  --agent <name>       the agent: claude (Claude Code, the default) or codex (Codex CLI)
  --voice <name>       the voice: openai (the default) or off (type instead, nothing goes to OpenAI)
  --audio <setup>      room (speakers, the default) or headset
  --set NAME=value     any setting below, e.g. --set LOOKMA_CLAUDE_MODEL=opus

While it runs, watch the agent: Claude Code in its terminal (tmux attach -t lookma),
Codex in the log of the terminal that started Lookma.
Just talk. While Lookma runs and is not paused, it listens: the microphone streams
to the voice, and macOS shows its microphone indicator. To approve a card, say
"yes, I approve". Pause or resume it with ⌃⌥P, its menu bar icon, or by saying
"pause". Quit from the menu bar icon, or with Ctrl-C in the terminal that started it.

Settings, from the environment or ${path.join(ROOT, '.env')}:
  LOOKMA_EXECUTOR        the agent: claude (Claude Code, the default) or codex (Codex CLI)
  LOOKMA_VOICE           the voice: openai (OpenAI Realtime, the default) or off
  LOOKMA_AUDIO           room (speakers, the default) or headset (talking over the voice stops it)
  LOOKMA_VOICE_LANGUAGE  the language you speak, e.g. en or zh; unset, it is detected
`

// The settings of the selected executor and voice, each with its help and default.
function pluginHelp(config) {
  const sections = [[config.executor, 'LOOKMA_EXECUTOR'], [config.voice.provider, 'LOOKMA_VOICE']]
    .filter(([plugin]) => plugin)
    .map(([plugin, select]) => ({ head: `${plugin.title} (${select}=${plugin.name}):`, rows: describe(plugin) }))
  const width = Math.max(...sections.flatMap(s => s.rows.map(r => r.name.length)))
  const line = r => `  ${r.name.padEnd(width)}  ${r.help}${r.default ? ` (default ${r.default})` : ''}`
  const text = sections.map(s => ['', s.head, ...s.rows.map(line)].join('\n')).join('\n')
  return `${text}\n\nAll of them: the Configuration table in ${path.join(ROOT, 'README.md')}\n`
}

async function printHelp() {
  process.stdout.write(HELP + pluginHelp(await loadConfig()))
}

// The three switches, and every other setting that is set, with where it came from. Secrets are masked.
function settings(config) {
  const from = name => config.sources[name] || 'default'
  const rows = [
    ['agent', config.executor.name, from('LOOKMA_EXECUTOR')],
    ['voice', config.voice.provider?.name ?? 'off', from('LOOKMA_VOICE')],
    ['audio', config.voice.audio, from('LOOKMA_AUDIO')],
  ]
  const shown = ['LOOKMA_EXECUTOR', 'LOOKMA_VOICE', 'LOOKMA_AUDIO']
  for (const name of Object.keys(config.sources).filter(n => !shown.includes(n)).sort()) {
    rows.push([name, config.declared.get(name)?.secret ? '(set)' : process.env[name], from(name)])
  }
  return rows
}

async function printConfig(args) {
  const { settings: flags, rest } = parseArgs(args)
  if (rest.length) throw usage(`config takes options only, not ${rest[0]}`)
  const rows = settings(await loadConfig(flags))
  const width = Math.max(...rows.map(r => r[0].length))
  for (const [name, value, from] of rows) console.log(`${name.padEnd(width)}  ${value}  (${from})`)
}

// `open` makes macOS attribute the permissions to the app, not to this terminal.
function launchApp(config) {
  log('launching', path.basename(config.app))
  const env = [`LOOKMA_PORT=${config.port}`]
  if (!config.voice.provider) env.push(`LOOKMA_OVERLAY_URL=http://127.0.0.1:${config.port}/?voice=0`)
  spawn('open', [...env.flatMap(e => ['--env', e]), '-a', config.app], { stdio: 'ignore', detached: true }).unref()
}

async function start(args) {
  const { settings: flags, rest } = parseArgs(args)
  const dirs = rest.map(d => path.resolve(d))
  for (const d of dirs) if (!fs.statSync(d, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`not a directory: ${d}`)
  const config = await loadConfig(flags)
  log('settings', settings(config).slice(0, 3).map(([name, value, from]) => `${name} ${value} (${from})`).join(', '))

  // Without the app (LOOKMA_NO_APP=1) its build is yours too, which also keeps a dev core from
  // replacing the bundle another Lookma is running.
  const building = config.launchApp && isStale(config)
  preflight(config, { build: building })
  if (building) build(config)
  // Only now: the core needs the npm packages the preflight checked for.
  const { createCore } = await import('./core.mjs')
  const { startServer } = await import('./server.mjs')

  // Ctrl-C, SIGTERM or Quit in the app's menu bar: the app quits, the executor stops, we exit.
  let stopping = false
  async function shutdown(why) {
    if (stopping) return
    stopping = true
    log('stopping', why)
    await core.stop().catch(err => log('stop failed', err.message))
    server.close()
    process.exit(0)
  }

  const core = await createCore(config, { log, onQuit: () => shutdown('quit from the app') })
  const server = await startServer({ config, core, log })
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  // Not awaited: the overlay shows the executor starting, prompts told meanwhile wait in the host,
  // and a card raised during the start has an overlay to appear in. A start that fails leaves the
  // executor down, with the reason in the overlay and this log.
  core.startExecutor(dirs)
  if (config.launchApp) launchApp(config)
  else log('LOOKMA_NO_APP=1: not launching the app')
}

async function runDoctor(args) {
  const { settings: flags, rest } = parseArgs(args, ['--fix'])
  const extra = rest.find(a => a !== '--fix')
  if (extra) throw usage(`doctor takes options only, not ${extra}`)
  process.exitCode = await doctor(await loadConfig(flags), { fix: rest.includes('--fix') })
}

const COMMANDS = {
  start,
  doctor: runDoctor,
  config: printConfig,
  '--help': printHelp,
  '-h': printHelp,
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
