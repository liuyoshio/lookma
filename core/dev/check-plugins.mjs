#!/usr/bin/env node
// Checks the plug-in loader (core/plugins.mjs) and the settings it feeds core/config.mjs: every
// installed manifest is valid, the derived names are the documented ones, values are typed and
// checked at the boundary, malformed manifests and bad selections fail in words.
//   node core/dev/check-plugins.mjs
import { manifests, load, describe, validate, settingName } from '../plugins.mjs'
import { loadConfig, parseArgs } from '../config.mjs'

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const settle = p => p.then(v => ({ v }), e => ({ e }))
const thrown = fn => {
  try {
    fn()
  } catch (err) {
    return err.message
  }
  return ''
}

// ---------------------------------------------------------------- the installed plug-ins and their names

{
  const all = await manifests()
  const names = Object.fromEntries(all.map(p => [`${p.kind}/${p.name}`, p.settings.map(s => s.name).join(' ')]))
  const want = {
    'executors/claude': 'LOOKMA_CLAUDE_MODEL LOOKMA_CLAUDE_PERMISSION_MODE LOOKMA_CLAUDE_FLAGS',
    'executors/codex': 'LOOKMA_CODEX_MODEL LOOKMA_CODEX_FAST CODEX_HOME',
    'voices/openai': 'OPENAI_API_KEY LOOKMA_OPENAI_MODEL LOOKMA_OPENAI_VOICE LOOKMA_OPENAI_TRANSCRIBE_MODEL LOOKMA_OPENAI_MAX_TOKENS',
  }
  check('installed plug-ins and their setting names', JSON.stringify(names) === JSON.stringify(want), JSON.stringify(names))
  check('derived names: hyphens and camelCase become underscores', settingName('gemini-live', 'turnModel') === 'LOOKMA_GEMINI_LIVE_TURN_MODEL')
}

// ---------------------------------------------------------------- values

{
  const openai = await load('voices', 'openai', {})
  const o = openai.options
  check('defaults, and an unset required setting is missing', o.model === 'gpt-realtime-2.1' && o.voice === 'marin' && o.transcribeModel === 'gpt-realtime-whisper' && o.maxTokens === 1000 && openai.missing.join() === 'OPENAI_API_KEY', JSON.stringify({ o, missing: openai.missing }))
  const set = await load('voices', 'openai', { OPENAI_API_KEY: 'sk-test', LOOKMA_OPENAI_MAX_TOKENS: '150', LOOKMA_OPENAI_VOICE: '' })
  check('values are typed, an empty one is unset', set.options.maxTokens === 150 && set.options.voice === 'marin' && set.missing.length === 0)
  const shown = describe(set)
  check('describe masks a secret, also as a default', shown[0].value === '(set)' && shown[0].default === '' && !JSON.stringify(shown).includes('sk-test'), JSON.stringify(shown[0]))
  const codex = await load('executors', 'codex', { LOOKMA_CODEX_FAST: '1' })
  check('a boolean is written 1 or 0', codex.options.fast === true && describe(codex)[1].value === '1' && describe(codex)[1].default === '0')
  const bool = await settle(load('executors', 'codex', { LOOKMA_CODEX_FAST: 'yes' }))
  const num = await settle(load('voices', 'openai', { LOOKMA_OPENAI_MAX_TOKENS: 'lots' }))
  check('a value of the wrong type is a usage error', bool.e?.exitCode === 2 && /^LOOKMA_CODEX_FAST=yes: use 1 or 0/.test(bool.e.message) && num.e?.exitCode === 2 && /^LOOKMA_OPENAI_MAX_TOKENS=lots: use a number/.test(num.e.message), `${bool.e?.message} | ${num.e?.message}`)
}

// ---------------------------------------------------------------- malformed manifests

{
  const setting = { default: '', help: 'h' }
  const cases = [
    [{ title: 'X', settings: { model: setting }, extra: 1 }, 'unknown field extra'],
    [{ settings: {} }, 'title must be a non-empty string'],
    [{ title: 'X', settings: { model_name: setting } }, 'setting model_name: the key must be camelCase'],
    [{ title: 'X', settings: { model: { default: null, help: 'h' } } }, 'setting model: default must be'],
    [{ title: 'X', settings: { key: { default: 'k', help: 'h', required: true } } }, 'setting key: a required setting is a string with an empty default'],
    [{ title: 'X', checks: ['claude'] }, 'checks must be a list of functions'],
  ]
  const wrong = cases.map(([m, want]) => [want, thrown(() => validate('executors', 'x', m))]).filter(([want, got]) => !got.startsWith(`executors/x/manifest.mjs: ${want}`))
  check(`malformed manifests fail in words (${cases.length} cases)`, !wrong.length, JSON.stringify(wrong))
  check('a folder name with capitals fails', thrown(() => validate('voices', 'Gemini', { title: 'G' })).includes('the folder name'))
}

// ---------------------------------------------------------------- selection (core/config.mjs)

// Each case starts from the same environment: loadConfig writes flags and .env into it.
const before = { ...process.env }
async function config(env, args = []) {
  for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name]
  Object.assign(process.env, before, { LOOKMA_EXECUTOR: '', LOOKMA_VOICE: '' }, env)
  return settle(loadConfig(parseArgs(args).settings))
}

{
  const { v } = await config({})
  check('defaults: claude, openai', v.executor.name === 'claude' && v.voice.provider.name === 'openai')
  const flags = await config({}, ['--agent', 'codex', '--voice', 'off'])
  check('--agent and --voice select, as flags', flags.v.executor.name === 'codex' && flags.v.voice.provider === null && flags.v.voice.off === 'voice is off (LOOKMA_VOICE=off)' && flags.v.sources.LOOKMA_VOICE === 'flag')
  const noKey = await config({ OPENAI_API_KEY: '' })
  check('no API key: the voice is off, and why', noKey.v.voice.provider.name === 'openai' && noKey.v.voice.off === 'OPENAI_API_KEY is not set (see .env.example)')
  const agent = await config({ LOOKMA_EXECUTOR: 'foo' })
  const voice = await config({}, ['--voice', 'marin'])
  check('an unknown executor or voice is a usage error', agent.e?.exitCode === 2 && /^LOOKMA_EXECUTOR=foo: use claude or codex/.test(agent.e.message) && voice.e?.exitCode === 2 && /^LOOKMA_VOICE=marin: use openai or off/.test(voice.e.message), `${agent.e?.message} | ${voice.e?.message}`)
  check('declared: the core, every plug-in, secrets marked', v.declared.get('LOOKMA_VOICE_LANGUAGE')?.owner === 'core' && v.declared.get('LOOKMA_CODEX_FAST')?.owner === 'executors/codex' && v.declared.get('OPENAI_API_KEY')?.secret === true)
}

console.log(failures ? `${failures} FAILED` : 'all passed')
process.exit(failures ? 1 : 0)
