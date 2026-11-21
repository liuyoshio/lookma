// The lookma command: start, doctor, config, --help, --version. bin/lookma only finds Node and runs this.
// Its static imports use only Node's own modules, so everything but start works before
// `npm install`.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT, DEFAULTS, loadConfig, parseArgs } from './config.mjs'
import { createLog, usage } from './util.mjs'
import { isStale, build } from './app-build.mjs'
import { doctor, preflight } from './doctor.mjs'
import { describe, manifests } from './plugins.mjs'

const log = createLog()

// "a, b or c"
const anyOf = words => (words.length > 1 ? `${words.slice(0, -1).join(', ')} or ${words.at(-1)}` : words[0])

// The installed plug-ins of a kind, by name and title, the default marked.
function choices(all, kind) {
  return all.filter(p => p.kind === kind).map(p => `${p.name} (${p.title}${p.name === DEFAULTS[kind] ? ', the default' : ''})`)
}

// The core's settings a new user needs, the plug-ins named from their manifests. The settings of
// the selected plug-ins follow (pluginHelp); the full list is the README's Configuration table.
const help = all => `lookma: talk to your Mac. Watch it work.

Usage:
  lookma [options] [dir ...]         Start. The agent may work in each dir you pass.
  lookma start [options] [dir ...]   The same.
  lookma doctor [options] [--fix]    Check what Lookma needs, with a fix for each problem.
                                     --fix opens System Settings where the first fix is made.
  lookma config [options]            Print the settings in effect, and where each came from.
  lookma --version                   Print the version.
  lookma --help                      Print this help.

Options (each overrides the environment and .env):
  --agent <name>       the agent: ${anyOf(choices(all, 'executors'))}
  --voice <name>       the voice: ${anyOf([...choices(all, 'voices'), 'off (type instead)'])}
  --audio <setup>      room (speakers, the default) or headset
  --talk <mode>        key (hold fn to talk, the default) or always (always listening)
  --gestures <off|on>  hand gestures from the camera: off (the default) or on
  --set NAME=value     any setting below, e.g. --set LOOKMA_CLAUDE_MODEL=opus

While it runs, the agent's steps, cards and messages are in the log of the terminal
that started Lookma.
Hold fn and talk; let go and it answers. Tap fn for a hands-free conversation: it
listens until 20 s of quiet or another tap. Only then is the microphone open, and
macOS shows its indicator. With --talk always it listens whenever it is not paused.
A hold or a tap also stops the voice mid-sentence. For fn to do nothing else, set
System Settings → Keyboard → Press 🌐 key to → Do Nothing (lookma doctor checks).
To approve a card, hold fn and say "yes, I approve". Pause or resume it with ⌃⌥P,
its menu bar icon, or by saying "pause". Quit from the menu bar icon, or with
Ctrl-C in the terminal that started it.

Settings, from the environment or ${path.join(ROOT, '.env')}:
  LOOKMA_EXECUTOR        the agent, as --agent
  LOOKMA_VOICE           the voice, as --voice
  LOOKMA_AUDIO           room (speakers, the default) or headset (talking over the voice stops it)
  LOOKMA_TALK            key (the default) or always, as --talk
  LOOKMA_GESTURES        off (the default) or on, as --gestures
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

// With a setting that is wrong, the help still prints, then the error instead of the plug-ins'
// settings (they depend on the selection).
async function printHelp() {
  const text = help(await manifests())
  let config
  try {
    config = await loadConfig()
  } catch (err) {
    if (!err.exitCode) throw err
    process.stdout.write(text)
    console.error(`\nlookma: ${err.message}`)
    process.exitCode = err.exitCode
    return
  }
  process.stdout.write(text + pluginHelp(config))
}

// The main switches, and every other setting that is set, with where it came from. Secrets are masked.
function settings(config) {
  const from = name => config.sources[name] || 'default'
  const rows = [
    ['agent', config.executor.name, from('LOOKMA_EXECUTOR')],
    ['voice', config.voice.provider?.name ?? 'off', from('LOOKMA_VOICE')],
    ['audio', config.voice.audio, from('LOOKMA_AUDIO')],
    ['talk', config.voice.talk, from('LOOKMA_TALK')],
    ['gestures', config.gestures ? 'on' : 'off', from('LOOKMA_GESTURES')],
  ]
  const shown = ['LOOKMA_EXECUTOR', 'LOOKMA_VOICE', 'LOOKMA_AUDIO', 'LOOKMA_TALK', 'LOOKMA_GESTURES']
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

// `open` makes macOS attribute the permissions to the app, not to this terminal. It also cuts the
// app off from this terminal, so the app writes its log to app.log in the data folder and a tail
// copies each line here: the two logs read as one, and the file keeps the app's side of this run.
function launchApp(config) {
  log('launching', path.basename(config.app))
  const appLog = path.join(config.dataDir, 'app.log')
  fs.mkdirSync(config.dataDir, { recursive: true })
  fs.writeFileSync(appLog, '')
  const tail = spawn('tail', ['-f', appLog], { stdio: ['ignore', 'inherit', 'inherit'] })
  process.on('exit', () => tail.kill())
  const env = [`LOOKMA_PORT=${config.port}`]
  if (!config.voice.provider) env.push(`LOOKMA_OVERLAY_URL=http://127.0.0.1:${config.port}/?voice=0`)
  const args = [...env.flatMap(e => ['--env', e]), '--stdout', appLog, '--stderr', appLog, '-a', config.app]
  spawn('open', args, { stdio: 'ignore', detached: true }).unref()
}

async function start(args) {
  const { settings: flags, rest } = parseArgs(args)
  const dirs = rest.map(d => path.resolve(d))
  for (const d of dirs) if (!fs.statSync(d, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`not a directory: ${d}`)
  const config = await loadConfig(flags)
  log('settings', settings(config).slice(0, 5).map(([name, value, from]) => `${name} ${value} (${from})`).join(', '))

  // Without the app (LOOKMA_NO_APP=1) its build is yours too, which also keeps a dev core from
  // replacing the bundle another Lookma is running.
  const building = config.launchApp && isStale(config)
  for (const warning of preflight(config, { build: building })) log('warning', warning)
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
