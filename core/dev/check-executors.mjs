#!/usr/bin/env node
// The executor conformance check: one list of scenarios, run over every executor that has a fake
// agent (executors/<name>/dev/fake-agent.mjs), each with the real executor host, the real adapter
// and the real tools bridge, and the fake in place of the agent. Offline: no model, no network.
// A fake speaks its agent's protocol, exports `bin` (the command the adapter spawns; the check
// puts a script by that name first on the adapter's PATH), and plays each prompt as a command:
//   say <words>   say <words> through the bridge, then end the turn ok with <words> as its summary
//   see           call see through the bridge; end ok with the result's text as its summary
//   ask           ask the user for an approval; end ok with the summary yes or no
//   fail          end the turn failed, with the error "boom"
//   refuse        refuse the prompt itself
//   work          take a step, then work until interrupted; a prompt meanwhile ends the turn ok
//                 with the summary "steered: <prompt>"
//   stuck         take a step, then ignore everything, interrupts included
//   die           exit at once
// Interrupted, the stopped work straggles: it says "late" and takes one more step before its
// turn ends, and the host's stop gate must hold both back.
//   node core/dev/check-executors.mjs      (port 8794, a scratch data dir)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'
import { ROOT } from '../config.mjs'
import { list, load } from '../plugins.mjs'
import { createExecutorHost } from '../executor/host.mjs'
import { cancelled } from '../util.mjs'

const PORT = 8794
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lookma-check-executors-'))
const RESTART = { interruptMs: 500, restartWindowMs: 60000 }

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(pred, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
    const v = pred()
    if (v) return v
  }
  return null
}
const alive = pid => {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

// The bridges dial this socket; it hands each to the host under test, as server.mjs does.
let current = null
const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT })
wss.on('connection', ws => current.connect(ws))

// One host over one adapter, its agent replaced by the fake; the core's side is recorded.
async function harness(name, fakeFile, bin, timing) {
  const dir = fs.mkdtempSync(path.join(DATA, `${name}-`))
  fs.mkdirSync(path.join(dir, 'bin'))
  const pids = path.join(dir, 'pids')
  fs.writeFileSync(pids, '')
  fs.writeFileSync(path.join(dir, 'bin', bin), `#!/bin/sh\necho $$ >> '${pids}'\nexec '${process.execPath}' '${fakeFile}' "$@"\n`, { mode: 0o755 })
  const plugin = await load('executors', name, {})
  const config = { root: ROOT, dataDir: dir, port: PORT, executor: { ...plugin, env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}` } } }
  const h = { events: [], said: [], statuses: [], cards: [], aborts: 0, logs: [] }
  h.host = await createExecutorHost(config, {
    onEvent: e => h.events.push(e),
    onStatus: (status, detail) => h.statuses.push({ status, detail }),
    say: line => h.said.push(line.speech),
    hands: { run: async tool => ({ text: `${tool} done` }), abort: () => h.aborts++ },
    ask: (card, signal) => new Promise((resolve, reject) => {
      const c = { card, answer: resolve, withdrawn: false }
      h.cards.push(c)
      signal.addEventListener('abort', () => ((c.withdrawn = true), reject(cancelled())), { once: true })
    }),
    log: (...a) => h.logs.push(a.join(' ')),
    timing,
  })
  current = h.host
  h.status = () => h.statuses.at(-1)
  h.ends = () => h.events.filter(e => e.type === 'turnEnd')
  h.pids = () => fs.readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number)
  // Tell, and wait for the turn to end: its turnEnd, or null.
  h.turn = async (text, ms) => {
    const n = h.ends().length
    h.host.prompt(text)
    return until(() => h.ends()[n], ms)
  }
  return h
}

async function conformance(name, fakeFile, bin) {
  const it = what => `${name}: ${what}`

  // ---------------------------------------------------------------- start, prompts, tools, cards
  {
    const h = await harness(name, fakeFile, bin)
    const started = h.host.start([DATA])
    h.host.prompt('say early')
    check(it('starting until start() resolves; a prompt told meanwhile waits'), h.status()?.status === 'starting' && h.said.length === 0)
    await started
    check(it('ready once start() resolved'), h.status()?.status === 'ready', JSON.stringify(h.status()))
    const early = await until(() => h.ends()[0])
    check(it('the waiting prompt goes, its say comes through the bridge, the turn ends ok'), early?.ok === true && h.said.join() === 'early' && early.summary === 'early', JSON.stringify({ early, said: h.said }))

    const seen = await h.turn('see')
    check(it('a hands call goes through the bridge and its result comes back'), seen?.ok === true && seen.summary === 'see done', JSON.stringify(seen))
    const failed = await h.turn('fail')
    check(it('a failed turn ends not ok, with its error'), failed?.ok === false && failed.error === 'boom', JSON.stringify(failed))
    const refused = await h.turn('refuse')
    check(it('a refused prompt fails the turn with the reason'), refused?.ok === false && /usage limit/.test(refused.error), JSON.stringify(refused))

    for (const [allow, want] of [[true, 'yes'], [false, 'no']]) {
      const n = h.ends().length
      const k = h.cards.length
      h.host.prompt('ask')
      const card = await until(() => h.cards[k])
      card?.answer(allow)
      const end = await until(() => h.ends()[n])
      check(it(`a card answered ${allow ? 'yes' : 'no'} reaches the agent`), !!card?.card.title && end?.summary === want, JSON.stringify({ card: card?.card, end }))
    }

    const n = h.ends().length
    h.host.prompt('work')
    await until(() => h.events.filter(e => e.type === 'step').length)
    h.host.prompt('more')
    const steered = await until(() => h.ends()[n])
    await sleep(100)
    check(it('a prompt during work joins it: one turn, which takes it'), steered?.summary === 'steered: more' && h.ends().length === n + 1, JSON.stringify(h.ends().slice(n)))

    // A stop mid-work: the gate holds back the stragglers, then opens.
    const before = { events: h.events.length, said: h.said.length, aborts: h.aborts }
    h.host.prompt('work')
    await until(() => h.events.length > before.events && h.events.at(-1).type === 'step')
    const at = h.events.length
    const logs = h.logs.length
    await h.host.interrupt()
    await sleep(200)
    const held = h.logs.slice(logs).filter(l => /dropped (step|turnEnd)/.test(l)).length
    check(it('interrupt resolves, the hands are stopped, and nothing of the stopped work follows'), h.events.length === at && h.said.length === before.said && h.aborts > before.aborts, JSON.stringify(h.events.slice(at)) + JSON.stringify(h.said.slice(before.said)))
    check(it('the stragglers came and the gate held them (a late step and the end)'), held === 2, h.logs.slice(logs).join('; '))
    const after = await h.turn('say again')
    check(it('after the stop, the next prompt works'), after?.ok === true && h.said.at(-1) === 'again', JSON.stringify(after))

    // A stop while a card is up: the card is withdrawn.
    const m = h.ends().length
    const cards = h.cards.length
    h.host.prompt('ask')
    const open = await until(() => h.cards[cards])
    await h.host.interrupt()
    await sleep(200)
    check(it('a stop withdraws the open card, and the turn it belonged to says nothing'), open?.withdrawn === true && h.ends().length === m, JSON.stringify(h.ends().slice(m)))

    const pids = h.pids()
    await h.host.close()
    const gone = await until(() => pids.every(p => !alive(p)) && wss.clients.size === 0)
    check(it('close: status down, the agent and its tools bridge are gone'), !!gone && h.status()?.status === 'down', `pids ${pids.filter(alive)}, sockets ${wss.clients.size}`)
  }

  // ---------------------------------------------------------------- recovery
  {
    const h = await harness(name, fakeFile, bin, RESTART)
    await h.host.start([DATA])
    h.host.prompt('stuck')
    await until(() => h.events.some(e => e.type === 'step'))
    const first = h.pids()[0]
    await h.host.interrupt()
    const failed = h.ends().at(-1)
    check(it('an interrupt that never resolves fails the turn with the reason and restarts'), failed?.ok === false && /stopped responding/.test(failed.error) && h.statuses.some(s => s.status === 'starting' && /restarting/.test(s.detail)), JSON.stringify({ failed, statuses: h.statuses }))
    await until(() => h.status()?.status === 'ready')
    const again = await h.turn('say back')
    check(it('the new session works, and the old agent is gone'), again?.ok === true && h.said.at(-1) === 'back' && !alive(first), JSON.stringify(again))

    h.host.prompt('die')
    await until(() => h.status()?.status === 'down')
    check(it('a second failure within the window: down, with the reason'), h.status()?.status === 'down' && /exited/.test(h.status().detail) && h.ends().at(-1)?.ok === false, JSON.stringify(h.status()))
    await h.host.close()
  }
  {
    const h = await harness(name, fakeFile, bin, RESTART)
    await h.host.start([DATA])
    h.host.prompt('die')
    const died = await until(() => h.ends()[0])
    await until(() => h.status()?.status === 'ready' && h.statuses.length > 2)
    check(it('the agent dies: the turn fails with the reason, the host restarts it'), died?.ok === false && /exited/.test(died.error) && h.status()?.status === 'ready', JSON.stringify({ died, statuses: h.statuses }))
    const pids = h.pids()
    await h.host.close()
    check(it('close after a restart leaves no process'), !!(await until(() => pids.every(p => !alive(p)))), `alive ${pids.filter(alive)}`)
  }
}

for (const name of list('executors')) {
  const fakeFile = path.join(ROOT, 'executors', name, 'dev', 'fake-agent.mjs')
  if (!fs.existsSync(fakeFile)) {
    console.log(`SKIP ${name}: no dev/fake-agent.mjs`)
    continue
  }
  const { bin } = await import(pathToFileURL(fakeFile).href)
  await conformance(name, fakeFile, bin)
}

wss.close()
fs.rmSync(DATA, { recursive: true, force: true })
console.log(failures ? `${failures} FAILED` : 'all passed')
process.exit(failures ? 1 : 0)
