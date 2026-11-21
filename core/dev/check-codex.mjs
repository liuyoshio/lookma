#!/usr/bin/env node
// Checks the Codex adapter. Offline (npm test): the real adapter against a stand-in for app-server,
// with no process and no model, for the parts that are easy to get wrong: prompts queue until the
// thread and the tools are ready, steer or start, a cancel followed at once by a new prompt, one
// turnEnd per turn, approvals and their answers, and step titles.
//   node core/dev/check-codex.mjs               offline
//   node core/dev/check-codex.mjs --handshake   the real codex binary (port 8793, a scratch data
//                                               dir): the adapter starts app-server and its thread,
//                                               the tools connect, then it stops. No turn is
//                                               started, so no model is called.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { ROOT } from '../config.mjs'
import { load } from '../plugins.mjs'
import { create } from '../../executors/codex/index.mjs'
import { stepTitle } from '../../executors/codex/events.mjs'

const PORT = 8793
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lookma-check-codex-'))
const config = { root: ROOT, dataDir: DATA, port: PORT }
const { options } = await load('executors', 'codex', process.env)

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tick = () => sleep(5)
async function until(pred, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const v = pred()
    if (v) return v
  }
  return null
}

// ---------------------------------------------------------------- the stand-in

// Plays app-server for the adapter: records what it sends, answers each request from `replies`
// (a throw is a JSON-RPC error), and sends notifications and requests of its own.
function fakeServer() {
  const sent = [] // { method, params }: the adapter's requests and notifications
  const answered = [] // { id, result } or { id, error }: the adapter's replies to our requests
  let turns = 0
  const replies = {
    initialize: () => ({}),
    'thread/start': () => ({ thread: { id: 'T' }, model: 'test-model' }),
    'turn/start': () => ({ turn: { id: `turn${++turns}` } }),
    'turn/steer': p => ({ turnId: p.expectedTurnId }),
    'turn/interrupt': () => ({}),
  }
  let h = null
  return {
    sent,
    answered,
    replies,
    open(handlers) {
      h = handlers
      return {
        request: async (method, params) => (sent.push({ method, params }), replies[method](params)),
        notify: (method, params) => sent.push({ method, params }),
        respond: (id, result) => answered.push({ id, result }),
        fail: (id, error) => answered.push({ id, error }),
        close: async () => h.onExit(0),
      }
    },
    notify: (method, params) => h.onNotification({ method, params }),
    request: (id, method, params) => h.onRequest({ id, method, params }),
    exit: code => h.onExit(code),
    all: method => sent.filter(m => m.method === method),
  }
}

function fakeSocket() {
  const ws = new EventEmitter()
  ws.readyState = 1
  ws.sent = []
  ws.send = s => ws.sent.push(JSON.parse(s))
  ws.close = () => ((ws.readyState = 3), ws.emit('close'))
  return ws
}

// The adapter, started against the stand-in; ready() also connects the tools bridge.
async function harness() {
  const server = fakeServer()
  const events = []
  const ctx = { emit: e => events.push(e), hands: async tool => ({ text: `${tool} done` }), config, options, log: () => {} }
  const ex = create(ctx, { openServer: handlers => server.open(handlers) })
  await ex.start({ dirs: ['/Users/someone/Projects'] })
  await tick()
  const of = type => events.filter(e => e.type === type)
  return { server, ex, events, of, status: () => of('status').at(-1)?.status }
}
async function ready() {
  const h = await harness()
  h.ws = fakeSocket()
  h.ex.connect(h.ws)
  await tick()
  return h
}
const started = (h, id) => h.server.notify('turn/started', { threadId: 'T', turn: { id } })
const completed = (h, id, status = 'completed') => h.server.notify('turn/completed', { threadId: 'T', turn: { id, status, error: status === 'failed' ? { message: 'boom' } : null } })
const texts = (h, method) => h.server.all(method).map(m => m.params.input[0].text)

async function offline() {
  // ---------------------------------------------------------------- start and readiness
  {
    const h = await harness()
    const order = h.server.sent.map(m => m.method).join(',')
    check('start: initialize, initialized, thread/start', order === 'initialize,initialized,thread/start', order)
    const p = h.server.all('thread/start')[0].params
    check('thread: the user dirs are the writable roots, no network, cards on request', JSON.stringify(p.config.sandbox_workspace_write) === '{"writable_roots":["/Users/someone/Projects"],"network_access":false}' && p.approvalPolicy === 'on-request' && p.sandbox === 'workspace-write')
    check('thread: works in the session folder, with prompts/executor.md as its instructions', p.cwd === path.join(DATA, 'sessions', 'codex', 'work') && p.developerInstructions === fs.readFileSync(path.join(ROOT, 'prompts', 'executor.md'), 'utf8'))
    h.ex.prompt('open Maps')
    await tick()
    check('a prompt before the tools connect waits, status starting', h.server.all('turn/start').length === 0 && h.status() === 'starting')
    h.ex.connect(fakeSocket())
    await tick()
    check('thread and tools ready: status ready, the waiting prompt starts a turn', h.status() === 'ready' && texts(h, 'turn/start').join() === 'open Maps')
  }

  // ---------------------------------------------------------------- the tools bridge
  {
    const h = await ready()
    h.ws.emit('message', JSON.stringify({ type: 'say', speech: 'Opening Maps.' }))
    h.ws.emit('message', JSON.stringify({ type: 'hands', id: 3, tool: 'see', args: { label: 'Look' } }))
    await tick()
    check('bridge: say → say event, hands → ctx.hands → res', h.of('say')[0]?.speech === 'Opening Maps.' && JSON.stringify(h.ws.sent[0]) === '{"type":"res","id":3,"ok":true,"result":{"text":"see done"}}', JSON.stringify(h.ws.sent))
  }

  // ---------------------------------------------------------------- steer or start
  {
    const h = await ready()
    h.ex.prompt('open TextEdit')
    await tick()
    started(h, 'turn1')
    h.ex.prompt('make it red', { steer: true })
    await tick()
    const steer = h.server.all('turn/steer')[0]
    check('a prompt during a turn steers it, expecting that turn', steer?.params.expectedTurnId === 'turn1' && steer.params.input[0].text === 'make it red' && h.server.all('turn/start').length === 1)
    h.server.replies['turn/steer'] = () => {
      throw new Error('no active turn to steer')
    }
    h.ex.prompt('and bigger', { steer: true })
    await tick()
    check('a refused steer starts a new turn', texts(h, 'turn/start').join('|') === 'open TextEdit|and bigger')
  }

  // ---------------------------------------------------------------- cancel, then a new prompt at once
  {
    const h = await ready()
    h.ex.cancel()
    await tick()
    check('cancel with no turn running sends nothing', h.server.all('turn/interrupt').length === 0)
    h.ex.prompt('find coffee near me')
    await tick()
    started(h, 'turn1')
    h.ex.cancel()
    h.ex.prompt('what is 2 plus 2')
    await tick()
    check('cancel interrupts the running turn', h.server.all('turn/interrupt')[0]?.params.turnId === 'turn1')
    check('the next prompt waits for the interrupted turn to end', h.server.all('turn/start').length === 1 && h.server.all('turn/steer').length === 0)
    h.server.notify('item/started', { threadId: 'T', turnId: 'turn1', item: { type: 'commandExecution', id: 'c1', command: 'ls', commandActions: [] } })
    completed(h, 'turn1', 'interrupted')
    await tick()
    check('the interrupted turn ends with no turnEnd and no late step', h.of('turnEnd').length === 0 && h.of('step').length === 0)
    check('then the new prompt starts its own turn', texts(h, 'turn/start').join('|') === 'find coffee near me|what is 2 plus 2' && h.server.all('turn/steer').length === 0)
  }
  {
    const h = await ready()
    h.ex.prompt('open Maps')
    await tick()
    h.ex.cancel() // before Codex reported the turn started
    await tick()
    started(h, 'turn1')
    check('a cancelled turn that starts late raises no turnStart', h.of('turnStart').length === 0 && h.server.all('turn/interrupt')[0]?.params.turnId === 'turn1')
  }

  // ---------------------------------------------------------------- one turnEnd per turn
  {
    const h = await ready()
    const startTurn = h.server.replies['turn/start']
    h.ex.prompt('a')
    await tick()
    started(h, 'turn1')
    completed(h, 'turn1')
    h.ex.prompt('b')
    await tick()
    started(h, 'turn2')
    completed(h, 'turn2', 'failed')
    const ends = () => JSON.stringify(h.of('turnEnd').map(e => e.ok))
    check('one turnEnd per turn, ok by its status', ends() === '[true,false]' && h.of('turnStart').length === 2, ends())
    h.server.replies['turn/start'] = () => {
      throw new Error('usage limit reached')
    }
    h.ex.prompt('c')
    await tick()
    check('turn/start refused → turnEnd ok:false', ends() === '[true,false,false]', ends())
    h.server.replies['turn/start'] = startTurn
    h.ex.prompt('d')
    await tick()
    started(h, 'turn4')
    h.server.exit(1)
    check('Codex exits mid-turn → turnEnd ok:false, status down', ends() === '[true,false,false,false]' && h.status() === 'down', `${ends()} ${h.status()}`)
  }

  // ---------------------------------------------------------------- approvals
  {
    const h = await ready()
    h.ex.prompt('write a file on my Desktop')
    await tick()
    started(h, 'turn1')
    const cmd = (id, extra = {}) => h.server.request(id, 'item/commandExecution/requestApproval', { threadId: 'T', turnId: 'turn1', itemId: `c${id}`, kind: 'command', command: "/bin/zsh -lc 'touch ~/Desktop/a.txt'", reason: 'Write outside the workspace', ...extra })
    const card = id => h.of('approval').find(e => e.id === `codex-${id}`)
    const reply = id => JSON.stringify(h.server.answered.find(a => a.id === id))
    const gone = id => h.of('approvalGone').some(e => e.id === `codex-${id}`)

    cmd(7, { availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] })
    check('command request → card', card(7)?.title === 'Run this command?' && card(7).detail === 'touch ~/Desktop/a.txt\nWrite outside the workspace', JSON.stringify(card(7)))
    h.ex.answer('codex-7', true)
    check('Approve → accept, this once', reply(7) === '{"id":7,"result":{"decision":"accept"}}', reply(7))

    h.server.notify('item/started', { threadId: 'T', turnId: 'turn1', item: { type: 'fileChange', id: 'f1', changes: [{ path: '/Users/someone/Desktop/a.txt', kind: { type: 'add' }, diff: '' }], status: 'inProgress' } })
    h.server.request(8, 'item/fileChange/requestApproval', { threadId: 'T', turnId: 'turn1', itemId: 'f1', reason: null })
    check('file change request → card with its paths', card(8)?.title === 'Change these files?' && card(8).detail === '/Users/someone/Desktop/a.txt', JSON.stringify(card(8)))
    h.ex.answer('codex-8', false)
    check('Decline → decline', reply(8) === '{"id":8,"result":{"decision":"decline"}}', reply(8))

    cmd(9, { availableDecisions: ['decline', 'cancel'] })
    h.ex.answer('codex-9', true)
    check('Approve when accept is not offered → decline', reply(9) === '{"id":9,"result":{"decision":"decline"}}', reply(9))

    cmd(10, { networkApprovalContext: { host: 'example.com', protocol: 'https' } })
    check('network request → its own title', card(10)?.title === 'Allow network access to example.com?')
    h.server.notify('serverRequest/resolved', { threadId: 'T', requestId: 10 })
    check('serverRequest/resolved → approvalGone', gone(10))
    cmd(11)
    completed(h, 'turn1')
    check('the end of its turn closes a card', gone(11))

    h.server.request(12, 'mcpServer/elicitation/request', { threadId: 'T', turnId: 'turn1', serverName: 'x', mode: 'form', message: 'Allow?', requestedSchema: {}, _meta: null })
    h.server.request(13, 'item/tool/requestUserInput', { threadId: 'T', turnId: 'turn1', questions: [] })
    h.server.request(14, 'currentTime/read', { threadId: 'T' })
    check('MCP question → declined, no card', reply(12) === '{"id":12,"result":{"action":"decline","content":null,"_meta":null}}' && !card(12))
    check('any other request → JSON-RPC error', JSON.parse(reply(13)).error?.code === -32601)
    check('currentTime/read → whole seconds', Number.isInteger(JSON.parse(reply(14)).result.currentTimeAt))
    check('never acceptForSession', !h.server.answered.some(a => JSON.stringify(a).includes('ForSession')))
  }

  // ---------------------------------------------------------------- steps
  {
    const h = await ready()
    h.ex.prompt('look around')
    await tick()
    started(h, 'turn1')
    const item = it => h.server.notify('item/started', { threadId: 'T', turnId: 'turn1', item: it })
    item({ type: 'commandExecution', id: 'c1', command: "/bin/zsh -lc 'git status'", commandActions: [{ type: 'unknown', command: 'git status' }] })
    item({ type: 'mcpToolCall', id: 'm1', server: 'lookma', tool: 'see' })
    item({ type: 'reasoning', id: 'r1', summary: [], content: [] })
    check('item/started → step; the hands and reasoning give none', JSON.stringify(h.of('step')) === '[{"type":"step","title":"git status"}]', JSON.stringify(h.of('step')))
  }
  const titles = [
    [{ type: 'commandExecution', command: 'cat notes.txt', commandActions: [{ type: 'read', command: 'cat notes.txt', name: 'notes.txt', path: '/x/notes.txt' }] }, 'Read notes.txt'],
    [{ type: 'commandExecution', command: 'ls src', commandActions: [{ type: 'listFiles', command: 'ls src', path: '/x/src' }] }, 'List src'],
    [{ type: 'commandExecution', command: 'ls', commandActions: [{ type: 'listFiles', command: 'ls', path: null }] }, 'List files'],
    [{ type: 'commandExecution', command: 'rg ramen', commandActions: [{ type: 'search', command: 'rg ramen', query: 'ramen', path: null }] }, 'Search for ramen'],
    [{ type: 'commandExecution', command: "/bin/bash -lc 'npm test'", commandActions: [] }, 'npm test'],
    [{ type: 'fileChange', changes: [{ path: '/x/a.md', kind: { type: 'add' } }] }, 'Write a.md'],
    [{ type: 'fileChange', changes: [{ path: '/x/a.md', kind: { type: 'update', move_path: null } }, { path: '/x/b.md', kind: { type: 'delete' } }] }, 'Edit a.md + 1 more'],
    [{ type: 'webSearch', query: 'ramen near the ferry', action: { type: 'search', query: 'ramen near the ferry', queries: null } }, 'Search the web for ramen near the ferry'],
    [{ type: 'webSearch', query: '', action: { type: 'openPage', url: 'https://example.com/menu' } }, 'Read example.com'],
    [{ type: 'mcpToolCall', server: 'docs', tool: 'search' }, 'docs · search'],
    [{ type: 'agentMessage', text: 'Done.' }, null],
  ]
  const wrong = titles.filter(([it, want]) => stepTitle(it) !== want).map(([it]) => `${it.type}: ${stepTitle(it)}`)
  check(`step titles for ${titles.length} items`, wrong.length === 0, wrong.join('; '))
}

// ---------------------------------------------------------------- the real binary, no turn

async function handshake() {
  const { WebSocketServer } = await import('ws')
  const { openServer } = await import('../../executors/codex/rpc.mjs')
  const auth = path.join(options.home, 'auth.json')
  const authBefore = fs.statSync(auth).mtimeMs
  const dir = path.join(fs.realpathSync(DATA), 'Projects') // a folder the user passes; Codex reports it resolved
  fs.mkdirSync(dir)

  // The real rpc.mjs, tapped for the thread/start reply and the MCP servers that start.
  let reply = null
  const servers = new Set()
  const tapped = handlers => {
    const rpc = openServer({
      ...handlers,
      onNotification(n) {
        if (n.method === 'mcpServer/startupStatus/updated') servers.add(n.params.name)
        handlers.onNotification(n)
      },
    })
    return { ...rpc, request: async (method, params) => (method === 'thread/start' ? (reply = await rpc.request(method, params)) : rpc.request(method, params)) }
  }
  const events = []
  const logs = []
  const ex = create({ emit: e => events.push(e), hands: async () => ({ text: 'no hands in this check' }), config, options, log: (...a) => logs.push(a.join(' ')) }, { openServer: tapped })
  const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT })
  wss.on('connection', ws => ex.connect(ws))

  await ex.start({ dirs: [dir] })
  const status = () => events.filter(e => e.type === 'status').at(-1)
  await until(() => ['ready', 'down'].includes(status()?.status), 30000)
  check('the adapter gets ready: thread started, the tools connected', status()?.status === 'ready', JSON.stringify(status()))
  check('thread: workspace-write, the user dir writable, no network', reply?.sandbox.type === 'workspaceWrite' && reply.sandbox.writableRoots.includes(dir) && reply.sandbox.networkAccess === false, JSON.stringify(reply?.sandbox))
  check('thread: approvals on request, ephemeral', reply?.approvalPolicy === 'on-request' && reply.thread.ephemeral === true)
  check("only Lookma's own MCP server starts", [...servers].join() === 'lookma', [...servers].join())
  await ex.stop()
  check('stop: app-server exits, status down', status()?.status === 'down' && status().detail === 'stopped', JSON.stringify(status()))
  const link = path.join(DATA, 'sessions', 'codex', 'home', 'auth.json')
  check("auth.json stays a link to the user's login, which is untouched", fs.lstatSync(link).isSymbolicLink() && fs.statSync(auth).mtimeMs === authBefore)
  wss.close()
  if (failures) console.log(logs.map(l => `  | ${l}`).join('\n'))
}

if (process.argv.includes('--handshake')) await handshake()
else await offline()
fs.rmSync(DATA, { recursive: true, force: true })
console.log(failures ? `${failures} FAILED` : 'all passed')
process.exit(failures ? 1 : 0)
