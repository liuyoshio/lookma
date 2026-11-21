// Plug-ins: the folders of executors/ and voices/ at the repo root. Each says what it needs in its
// manifest.mjs, and this module is the only code that reads one. It is the boundary where a
// manifest and the settings it declares are validated: after load(), a plug-in's options are a
// plain, checked object.
//
//   export default {
//     title: 'Codex',                        the name people read in doctor and help
//     settings: { model: { default: '', help: 'the model' }, ... },
//     checks: [options => finding],          optional; run by lookma doctor (core/doctor.mjs)
//   }
//
// A setting is { default, help, env?, secret?, required? }. Its type is the type of its default:
// a string, a boolean (written 1 or 0) or a number. Its name is derived, LOOKMA_<PLUGIN>_<KEY>
// (codex + model is LOOKMA_CODEX_MODEL, claude + permissionMode LOOKMA_CLAUDE_PERMISSION_MODE),
// so a plug-in cannot break the naming rule; `env` names a well-known variable instead
// (OPENAI_API_KEY). An empty value counts as unset. `secret` is never printed. `required` (a
// string setting with an empty default) is reported in `missing` while unset: the caller decides
// what that means. Plug-in names are unique across both kinds. Node built-ins only, like the
// manifests: lookma doctor reads them before npm install.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { usage } from './util.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KINDS = ['executors', 'voices']
const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const KEY = /^[a-z][a-zA-Z0-9]*$/
const FIELDS = { manifest: ['title', 'settings', 'checks'], setting: ['default', 'help', 'env', 'secret', 'required'] }

/** The names of the installed plug-ins of a kind ('executors' or 'voices'), sorted. */
export function list(kind) {
  const dir = path.join(ROOT, kind)
  return fs.readdirSync(dir).filter(name => fs.existsSync(path.join(dir, name, 'manifest.mjs'))).sort()
}

/** The environment name of a setting: LOOKMA_<PLUGIN>_<KEY>. */
export function settingName(plugin, key) {
  const snake = s => s.replace(/-/g, '_').replace(/[A-Z]/g, c => `_${c}`).toUpperCase()
  return `LOOKMA_${snake(plugin)}_${snake(key)}`
}

/**
 * Every installed plug-in, read and checked: [{ kind, name, dir, title, settings, checks }], where
 * settings is a list of { key, name, ...the declaration }. Throws in words on a malformed manifest
 * or a name used twice.
 */
export async function manifests() {
  const all = []
  for (const kind of KINDS) for (const name of list(kind)) all.push(await read(kind, name))
  const names = all.map(p => p.name)
  const twice = names.find((name, i) => names.indexOf(name) !== i)
  if (twice) throw new Error(`two plug-ins are named ${twice}: names are unique across ${KINDS.join(' and ')}`)
  return all
}

/**
 * One plug-in with its settings read from env: its manifest as manifests() gives it, plus
 * `options` (by key, typed) and `missing` (the names of required settings that are unset).
 * The name must be one of list(kind). Throws a usage error for a value of the wrong type.
 */
export async function load(kind, name, env) {
  const plugin = await read(kind, name)
  const options = Object.fromEntries(plugin.settings.map(s => [s.key, parse(s, env[s.name])]))
  const missing = plugin.settings.filter(s => s.required && !options[s.key]).map(s => s.name)
  return { ...plugin, options, missing }
}

/** A loaded plug-in's settings in effect, for doctor and help: [{ name, value, default, help }], secrets masked. */
export function describe(plugin) {
  const show = v => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
  return plugin.settings.map(s => {
    const value = plugin.options[s.key]
    return { name: s.name, value: s.secret ? (value ? '(set)' : '') : show(value), default: s.secret ? '' : show(s.default), help: s.help }
  })
}

async function read(kind, name) {
  const dir = path.join(ROOT, kind, name)
  const { default: manifest } = await import(pathToFileURL(path.join(dir, 'manifest.mjs')).href)
  return { kind, name, dir, ...validate(kind, name, manifest) }
}

/** A manifest checked, as { title, settings, checks }; throws in words naming the file. */
export function validate(kind, name, m) {
  const bad = what => {
    throw new Error(`${kind}/${name}/manifest.mjs: ${what}`)
  }
  if (!NAME.test(name)) bad('the folder name must be lowercase letters and digits, with single hyphens')
  if (!m || typeof m !== 'object') bad('must export default { title, settings, checks }')
  for (const field of Object.keys(m)) if (!FIELDS.manifest.includes(field)) bad(`unknown field ${field}`)
  if (typeof m.title !== 'string' || !m.title) bad('title must be a non-empty string')
  const checks = m.checks ?? []
  if (!Array.isArray(checks) || !checks.every(c => typeof c === 'function')) bad('checks must be a list of functions')
  const settings = Object.entries(m.settings ?? {}).map(([key, s]) => {
    const fail = what => bad(`setting ${key}: ${what}`)
    if (!KEY.test(key)) fail('the key must be camelCase letters and digits')
    for (const field of Object.keys(s)) if (!FIELDS.setting.includes(field)) fail(`unknown field ${field}`)
    if (!['string', 'boolean', 'number'].includes(typeof s.default)) fail('default must be a string, a boolean or a number')
    if (typeof s.help !== 'string' || !s.help) fail('help must be a non-empty string')
    if (s.env !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(s.env)) fail('env must be an environment variable name')
    if (s.required && s.default !== '') fail('a required setting is a string with an empty default')
    return { key, name: s.env ?? settingName(name, key), ...s }
  })
  return { title: m.title, settings, checks }
}

function parse(setting, raw) {
  if (raw === undefined || raw === '') return setting.default
  if (typeof setting.default === 'string') return raw
  if (typeof setting.default === 'boolean') {
    if (raw === '1' || raw === '0') return raw === '1'
    throw usage(`${setting.name}=${raw}: use 1 or 0`)
  }
  const n = Number(raw)
  if (Number.isFinite(n)) return n
  throw usage(`${setting.name}=${raw}: use a number`)
}
