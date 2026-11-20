// lookma doctor [--fix]: checks what Lookma needs and prints a fix for each problem. It changes
// nothing; --fix only opens the System Settings pane of the first missing permission. The same
// checks are `lookma start`'s preflight, so a missing piece gets the same words from both.
// Permissions belong to the app, which is launched with `open` (macOS ties them to its signature),
// so they are read from the app itself: from the running core, which holds the app's hello, or
// else from a separate instance started with LOOKMA_CHECK=<file>, which writes them and exits.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT } from './config.mjs'
import { isStale } from './app-build.mjs'

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
// Node's minimum is the one in package.json's engines.
const NEEDS = { macos: '15', node: PKG.engines.node.replace(/^>=/, ''), claude: '2.1.312' }
const BUILD_SH = path.join(ROOT, 'app', 'build.sh')
const PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_'
const PERMISSIONS = [
  { key: 'accessibility', name: 'Accessibility', pane: 'Accessibility', use: 'to read, click and type in other apps', required: true },
  { key: 'screen', name: 'Screen Recording', pane: 'ScreenCapture', use: 'to see the screen', required: true },
  { key: 'microphone', name: 'Microphone', pane: 'Microphone', use: 'for voice; macOS asks the first time you talk', required: false },
]

// A check returns a finding, or a list of them: { level, text, fix: [lines] }. A missing
// permission also carries `settings`, the pane --fix opens.
const finding = level => (text, fix = []) => ({ level, text, fix: [fix].flat() })
const ok = finding('ok')
const warn = finding('warn')
const fail = finding('fail')
const note = finding('note')

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000, ...opts })
  return { ok: !r.error && r.status === 0, out: `${r.stdout || ''}`.trim(), err: `${r.stderr || ''}`.trim() }
}

function atLeast(version, min) {
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

// To run Lookma, and to build its app.
const TO_RUN = [checkMacos, checkNode, checkPackages, checkTmux, checkClaude]
const TO_BUILD = [checkSwiftc]

// `lookma start` checks what it needs, building or not, and throws the first failure as the doctor
// words it. Warnings do not stop it.
export function preflight({ build }) {
  for (const check of [...TO_RUN, ...(build ? TO_BUILD : [])]) {
    const f = check()
    if (f.level === 'fail') throw new Error([f.text, ...f.fix.map(l => `  ${l}`), 'Run lookma doctor for a full check.'].join('\n'))
  }
}

// ---------------------------------------------------------------- voice, the running core, the app

function checkVoice(config) {
  if (!config.voice.enabled) return warn('voice is off (LOOKMA_NO_VOICE=1): you can still type')
  if (config.voice.apiKey) return ok('OPENAI_API_KEY is set (voice)')
  return warn('OPENAI_API_KEY is not set: voice is off, you can still type', `Put OPENAI_API_KEY=… in ${path.join(ROOT, '.env')} (see .env.example).`)
}

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

function checkPermissions(perms, appName) {
  return PERMISSIONS.map(p => {
    if (perms[p.key]) return ok(p.name)
    const url = PANE + p.pane
    const missing = (p.required ? fail : warn)(`${p.name} is not granted to ${appName} (${p.use})`, [
      `Turn on ${appName} in System Settings → Privacy & Security → ${p.name}:`,
      `open "${url}"`,
      ...(p.required ? ['If it already looks on, remove it with −, then start lookma: macOS adds it back and you turn it on.'] : []),
    ])
    return { ...missing, settings: { name: p.name, url } }
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

  for (const check of [...TO_RUN, ...TO_BUILD]) report(check())
  report(checkVoice(config))
  const state = await readCore(config.port)
  report(checkCore(state, config.port))
  const app = findApp(config)
  report(checkApp(app))
  if (state?.app) report(checkPermissions(state.app.permissions, app?.name || 'the app'))
  else if (app && !app.stale) {
    const perms = checkInstance(app.path)
    report(perms ? checkPermissions(perms, app.name) : fail('the app did not answer the permission check', `Rebuild it with ${BUILD_SH} and run lookma doctor again.`))
  } else report(note(`permissions: checked once the app is ${app ? 'rebuilt' : 'built'} (start lookma once)`))

  const panes = findings.filter(f => f.settings)
  const first = panes.find(f => f.level === 'fail') || panes[0]
  if (first && fix) {
    sh('open', [first.settings.url])
    console.log(`\nOpened System Settings → Privacy & Security → ${first.settings.name}.`)
  } else if (first) console.log('\nRun lookma doctor --fix to open the first of these in System Settings.')
  const failures = findings.filter(f => f.level === 'fail').length
  console.log(failures ? `\n${failures} problem${failures > 1 ? 's' : ''} to fix.` : '\nReady.')
  return failures ? 1 : 0
}
