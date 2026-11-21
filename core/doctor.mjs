// lookma doctor [--fix]: checks what Lookma needs and prints a fix for each problem. It changes
// nothing; --fix only opens the System Settings pane of the first fix made there: a missing
// permission, or what the fn (🌐) key also does. The same checks are `lookma start`'s preflight,
// so a missing piece gets the same words from both. A plug-in adds its own in its manifest.mjs,
// with the helpers exported here; the doctor also lists the installed plug-ins with the settings
// in effect, and names any LOOKMA_* variable nobody reads.
// Permissions belong to the app, which is launched with `open` (macOS ties them to its signature),
// so they are read from the app itself: from the running core, which holds the app's hello, or
// else from a separate instance started with LOOKMA_CHECK=<file>, which writes them and exits.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from './config.mjs'
import { isStale } from './app-build.mjs'
import { list, describe } from './plugins.mjs'

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
// Node's minimum is the one in package.json's engines.
const NEEDS = { macos: '15', node: PKG.engines.node.replace(/^>=/, '') }
const BUILD_SH = path.join(ROOT, 'app', 'build.sh')
const PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_'
// level: how much a missing grant matters with these settings. The camera is only for hand
// gestures, which are off by default.
const PERMISSIONS = [
  { key: 'accessibility', name: 'Accessibility', pane: 'Accessibility', use: 'to read, click and type in other apps', level: () => 'fail' },
  { key: 'screen', name: 'Screen Recording', pane: 'ScreenCapture', use: 'to see the screen', level: () => 'fail' },
  { key: 'microphone', name: 'Microphone', pane: 'Microphone', use: 'for voice; macOS asks the first time you talk', level: () => 'warn' },
  { key: 'camera', name: 'Camera', pane: 'Camera', use: 'for hand gestures; macOS asks when you turn them on', level: config => (config.gestures ? 'warn' : 'note') },
]

// A check returns a finding, or a list of them: { level, text, fix: [lines] }. One whose fix is
// made in System Settings also carries `settings: { where, url }`, the pane --fix opens.
const finding = level => (text, fix = []) => ({ level, text, fix: [fix].flat() })
export const ok = finding('ok')
export const warn = finding('warn')
export const fail = finding('fail')
const note = finding('note')

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000, ...opts })
  return { ok: !r.error && r.status === 0, out: `${r.stdout || ''}`.trim(), err: `${r.stderr || ''}`.trim() }
}

export function atLeast(version, min) {
  const a = version.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]
  return true
}

// ---------------------------------------------------------------- what Lookma needs

function checkMacos() {
  const mac = sh('sw_vers', ['-productVersion']).out
  if (atLeast(mac, NEEDS.macos)) return ok(`macOS ${mac}`)
  return fail(`macOS ${mac}: Lookma needs macOS ${NEEDS.macos} or later`, 'Update in System Settings → General → Software Update.')
}

function checkNode() {
  const node = process.versions.node
  if (atLeast(node, NEEDS.node)) return ok(`Node ${node}`)
  return fail(`Node ${node}: Lookma needs Node ${NEEDS.node} or later`, 'brew install node')
}

function checkPackages() {
  const missing = Object.keys(PKG.dependencies).filter(d => !fs.existsSync(path.join(ROOT, 'node_modules', d)))
  if (!missing.length) return ok('npm packages installed')
  return fail('npm packages are not installed', `cd ${ROOT} && npm install`)
}

function checkSwiftc() {
  // Ask xcode-select first: running the swiftc shim without the tools pops up an installer.
  const dev = sh('xcode-select', ['-p'])
  const swiftc = dev.ok && ['usr/bin/swiftc', 'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc'].map(f => path.join(dev.out, f)).find(f => fs.existsSync(f))
  if (!swiftc) return fail('Xcode Command Line Tools are not installed (lookma builds the app with swiftc)', 'xcode-select --install')
  const swift = sh(swiftc, ['--version'])
  const version = `${swift.out}\n${swift.err}`.match(/Swift version (\S+)/)?.[1]
  if (swift.ok && version) return ok(`swiftc ${version}`)
  return fail('swiftc does not run', (swift.err || swift.out).split('\n')[0] || 'xcode-select --install')
}

// A plug-in's own checks, from its manifest, with its options.
const pluginChecks = plugin => plugin.checks.map(check => () => check(plugin.options))

// To run Lookma, and to build its app. A voice's checks are the doctor's only: without a voice
// Lookma still runs.
const toRun = config => [checkMacos, checkNode, checkPackages, ...pluginChecks(config.executor)]
const TO_BUILD = [checkSwiftc]

// `lookma start` checks what it needs, building or not, and throws the first failure as the doctor
// words it. Warnings do not stop it: it returns their texts, for the log. A setting nobody reads
// is one of them, so a misspelt or renamed setting does not go unnoticed, and so is a talk key
// that does something else too.
export function preflight(config, { build }) {
  const warnings = []
  for (const check of [...toRun(config), ...(build ? TO_BUILD : []), () => checkUndeclared(config), () => checkTalkKey(config)]) {
    for (const f of [check()].flat()) {
      if (f.level === 'fail') throw new Error([f.text, ...f.fix.map(l => `  ${l}`), 'Run lookma doctor for a full check.'].join('\n'))
      if (f.level === 'warn') warnings.push(f.fix.length ? `${f.text}. ${f.fix.join(' ')}` : f.text)
    }
  }
  return warnings
}

// ---------------------------------------------------------------- plug-ins and settings

// The installed plug-ins of a kind, the selected one marked, with its settings in effect.
function listPlugins(config, kind, selected) {
  const names = list(kind).map(name => (name === selected?.name ? `${name} (selected)` : name))
  if (!selected) return note(`${kind}: ${names.join(', ')}; none selected`)
  const rows = describe(selected).map(s => [s.name, s.value || '(empty)', config.sources[s.name] || 'default'])
  const width = Math.max(...rows.map(r => r[0].length))
  return note(`${kind}: ${names.join(', ')}`, rows.map(([name, value, from]) => `${name.padEnd(width)}  ${value}  (${from})`))
}

function checkVoice(config) {
  const { provider } = config.voice
  if (!provider) return warn('voice is off (LOOKMA_VOICE=off): you can still type')
  const [missing] = provider.missing
  if (!missing) return ok(`voice: ${provider.title}`)
  return warn(`${missing} is not set: voice is off, you can still type`, `Put ${missing}=… in ${path.join(ROOT, '.env')} (see .env.example).`)
}

// The talk key is fn, which macOS also calls the 🌐 key: System Settings → Keyboard → "Press 🌐
// key to" gives it a job of its own, stored as AppleFnUsageType in com.apple.HIToolbox
// (community-documented, not Apple's). Lookma never writes that setting, nor swallows the key: it
// says what else fn does. In key mode, where fn is how you talk, that is a warning; in always mode
// fn only gives you the floor, so it is a note.
const GLOBE = { 1: 'changes the input source', 2: 'shows Emoji & Symbols', 3: 'starts Dictation when tapped twice' }
const KEYBOARD = { where: 'Keyboard', url: 'x-apple.systempreferences:com.apple.Keyboard-Settings.extension' }

function checkTalkKey(config) {
  if (!config.voice.provider) return []
  const key = config.voice.talk === 'key'
  const read = sh('defaults', ['read', 'com.apple.HIToolbox', 'AppleFnUsageType'])
  const findings = []
  if (read.ok && read.out === '0') findings.push(ok('the fn (🌐) key does nothing else (Press 🌐 key to → Do Nothing)'))
  else {
    const also = !read.ok ? 'may also show Emoji & Symbols or change the input source: "Press 🌐 key to" was never set, so macOS picks'
      : GLOBE[read.out] ? `also ${GLOBE[read.out]}` : `may also do something else (AppleFnUsageType is ${read.out})`
    const found = (key ? warn : note)(`the fn (🌐) key ${also}`, [
      'Set System Settings → Keyboard → Press 🌐 key to → Do Nothing.',
      'If you switch input sources with 🌐, ⌃Space does the same.',
    ])
    findings.push(key ? { ...found, settings: KEYBOARD } : found)
  }
  // Where macOS keeps Dictation's own shortcut is not established, so it is named, not read. Once
  // it is, this reads it and warns like the setting above.
  if (key) findings.push(note('if Dictation\'s shortcut is Press 🌐 Twice, two quick taps of fn also start Dictation', 'Pick another in System Settings → Keyboard → Dictation → Shortcut.'))
  return findings
}

// One warning for every LOOKMA_* variable that is set and that nothing reads: a typo, or a
// setting that was renamed.
function checkUndeclared(config) {
  const unread = Object.keys(config.sources).filter(name => !config.declared.has(name)).sort()
  if (!unread.length) return []
  const one = unread.length === 1
  const names = unread.map(name => `${name} (${config.sources[name]})`).join(', ')
  return warn(`${names} ${one ? 'is' : 'are'} set, but Lookma does not read ${one ? 'it' : 'them'}`, 'Check the names in lookma --help, or remove them.')
}

// ---------------------------------------------------------------- the running core, the app

// The running core's state, null when nothing listens, 'other' when something else answers.
async function readCore(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2000) })
    const state = await res.json()
    return state?.type === 'state' ? state : 'other'
  } catch (err) {
    return err?.cause?.code === 'ECONNREFUSED' ? null : 'other'
  }
}

function checkCore(state, port) {
  if (state === 'other') return fail(`port ${port} is in use by another program`, 'Quit it, or set LOOKMA_PORT to a free port in .env.')
  if (!state) return note('Lookma is not running')
  const connected = !!state.app
  return (connected ? ok : warn)(`Lookma is running on port ${port}: executor ${state.executor.status}, app ${connected ? 'connected' : 'not connected'}`)
}

// The built app and how it is signed, or null when it is not built.
function findApp(config) {
  if (!fs.existsSync(config.app)) return null
  const sig = sh('codesign', ['-dv', '--verbose=2', config.app])
  const text = `${sig.out}\n${sig.err}`
  const signing = !sig.ok ? null : /Signature=adhoc/.test(text) ? 'ad hoc' : text.match(/^Authority=(Developer ID|Apple Development)/m)?.[1] || 'other'
  return { path: config.app, name: path.basename(config.app, '.app'), stale: isStale(config), signing }
}

function checkApp(app) {
  if (!app) return [warn('the app is not built yet: lookma builds it on first start')]
  const signed = checkSigning(app.signing)
  if (!app.stale) return [signed]
  return [signed, note(`app sources changed since the build: lookma rebuilds it on next start${app.signing === 'ad hoc' ? ', then grant the permissions again' : ''}`)]
}

function checkSigning(signing) {
  if (!signing) return fail('the app is not signed', `Rebuild it: ${BUILD_SH}`)
  if (signing === 'ad hoc') {
    return warn('app built and signed ad hoc: macOS forgets Accessibility and Screen Recording after each rebuild or update', [
      'Grant them again after each rebuild. To keep them, create an Apple Development certificate',
      '(free Apple ID: Xcode → Settings → Accounts → Manage Certificates); the next build signs with it.',
    ])
  }
  return ok(`app built and signed with ${signing === 'other' ? 'your own' : `your ${signing}`} identity: permissions survive rebuilds`)
}

// A separate instance in check mode: writes its permissions to the file and exits at once.
function checkInstance(app) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookma-doctor-'))
  const file = path.join(dir, 'permissions.json')
  try {
    sh('open', ['-n', '-W', '--env', `LOOKMA_CHECK=${file}`, '-a', app], { timeout: 20000 })
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// A grant these settings do not need is a note, with no fix: macOS asks once it is needed.
function checkPermissions(perms, appName, config) {
  return PERMISSIONS.map(p => {
    if (perms[p.key]) return ok(p.name)
    const level = p.level(config)
    const text = `${p.name} is not granted to ${appName} (${p.use})`
    if (level === 'note') return note(text)
    const url = PANE + p.pane
    const missing = finding(level)(text, [
      `Turn on ${appName} in System Settings → Privacy & Security → ${p.name}:`,
      `open "${url}"`,
      ...(level === 'fail' ? ['If it already looks on, remove it with −, then start lookma: macOS adds it back and you turn it on.'] : []),
    ])
    return { ...missing, settings: { where: `Privacy & Security → ${p.name}`, url } }
  })
}

// ---------------------------------------------------------------- the report

const tty = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const MARK = { ok: paint(32, '✓'), warn: paint(33, '!'), fail: paint(31, '✗'), note: paint(2, '·') }

// Prints each finding as it comes (some checks take seconds) and returns the exit code.
export async function doctor(config, { fix = false } = {}) {
  const findings = []
  const report = found => {
    for (const f of [found].flat()) {
      findings.push(f)
      console.log(`  ${MARK[f.level]} ${f.text}`)
      for (const l of f.fix) console.log(paint(2, `      ${l}`))
    }
  }

  for (const check of [checkMacos, checkNode, checkPackages, ...TO_BUILD]) report(check())
  report(listPlugins(config, 'executors', config.executor))
  for (const check of pluginChecks(config.executor)) report(check())
  report(listPlugins(config, 'voices', config.voice.provider))
  report(checkVoice(config))
  if (config.voice.provider) for (const check of pluginChecks(config.voice.provider)) report(check())
  report(checkTalkKey(config))
  report(checkUndeclared(config))
  const state = await readCore(config.port)
  report(checkCore(state, config.port))
  const app = findApp(config)
  report(checkApp(app))
  if (state?.app) report(checkPermissions(state.app.permissions, app?.name || 'the app', config))
  else if (app && !app.stale) {
    const perms = checkInstance(app.path)
    report(perms ? checkPermissions(perms, app.name, config) : fail('the app did not answer the permission check', `Rebuild it with ${BUILD_SH} and run lookma doctor again.`))
  } else report(note(`permissions: checked once the app is ${app ? 'rebuilt' : 'built'} (start lookma once)`))

  const panes = findings.filter(f => f.settings)
  const first = panes.find(f => f.level === 'fail') || panes[0]
  if (first && fix) {
    sh('open', [first.settings.url])
    console.log(`\nOpened System Settings → ${first.settings.where}.`)
  } else if (first) console.log('\nRun lookma doctor --fix to open the first of these in System Settings.')
  const failures = findings.filter(f => f.level === 'fail').length
  console.log(failures ? `\n${failures} problem${failures > 1 ? 's' : ''} to fix.` : '\nReady.')
  return failures ? 1 : 0
}
