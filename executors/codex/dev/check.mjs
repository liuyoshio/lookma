#!/usr/bin/env node
// Checks what is Codex's own in the adapter (the contract itself is core/dev/check-executors.mjs's,
// against dev/fake-agent.mjs). Offline (npm test): the thread Lookma asks for, the cards Codex's
// requests become and the answers they give, and the step titles of Codex's items.
//   node executors/codex/dev/check.mjs               offline
//   node executors/codex/dev/check.mjs --handshake   the real codex binary behind the real host
//                                                    (port 8793, a scratch data dir): the session
//                                                    starts, its tools connect, then it closes.
//                                                    No turn is started, so no model is called.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from '../../../core/config.mjs'
import { load } from '../../../core/plugins.mjs'
import { cancelled } from '../../../core/util.mjs'
import { threadParams } from '../session.mjs'
import { createApprovals } from '../approvals.mjs'
import { stepTitle } from '../events.mjs'

const PORT = 8793
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lookma-check-codex-'))

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

async function offline() {
  // ---------------------------------------------------------------- the thread
  {
    const tools = { server: 'lookma', mcp: () => ({ command: '/bin/node', args: ['bridge.mjs'], env: { LOOKMA_CORE_URL: 'ws://x' } }) }
    const p = threadParams({ options: { model: '', fast: true }, dirs: ['/Users/someone/Projects'], work: '/w', instructions: 'Be brief.', tools })
    check('thread: the user dirs are the writable roots, no network, cards on request', JSON.stringify(p.config.sandbox_workspace_write) === '{"writable_roots":["/Users/someone/Projects"],"network_access":false}' && p.approvalPolicy === 'on-request' && p.sandbox === 'workspace-write')
    check("thread: the work dir, the host's instructions, Codex's default model, the Fast tier", p.cwd === '/w' && p.developerInstructions === 'Be brief.' && p.model === null && p.serviceTier === 'priority' && p.ephemeral === true)
    const bridge = p.config.mcp_servers.lookma
    check("thread: the host's tools bridge, never asking, waiting for cards", bridge?.command === '/bin/node' && bridge.env.LOOKMA_CORE_URL === 'ws://x' && bridge.default_tools_approval_mode === 'approve' && bridge.tool_timeout_sec === 600, JSON.stringify(bridge))
  }

  // ---------------------------------------------------------------- requests and cards
  {
    const cards = [] // { card, answer, withdrawn }
    const answered = [] // { id, result } or { id, error }
    const ask = (card, signal) => new Promise((resolve, reject) => {
      const c = { card, answer: resolve, withdrawn: false }
      cards.push(c)
      signal.addEventListener('abort', () => ((c.withdrawn = true), reject(cancelled())), { once: true })
    }).catch(() => null) // as the host does: a withdrawn card is null
    const a = createApprovals({ ask, respond: (id, result) => answered.push({ id, result }), fail: (id, error) => answered.push({ id, error }), log: () => {} })
    const reply = id => JSON.stringify(answered.find(r => r.id === id))
    const cmd = (id, extra = {}) => a.request({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'T', turnId: 'turn1', itemId: `c${id}`, kind: 'command', command: "/bin/zsh -lc 'touch ~/Desktop/a.txt'", reason: 'Write outside the workspace', ...extra } })

    cmd(7, { availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] })
    check('command request → card', cards[0]?.card.title === 'Run this command?' && cards[0].card.detail === 'touch ~/Desktop/a.txt\nWrite outside the workspace', JSON.stringify(cards[0]?.card))
    cards[0].answer(true)
    await tick()
    check('Approve → accept, this once', reply(7) === '{"id":7,"result":{"decision":"accept"}}', reply(7))

    a.fileChange({ id: 'f1', changes: [{ path: '/Users/someone/Desktop/a.txt', kind: { type: 'add' }, diff: '' }] }, 'turn1')
    a.request({ id: 8, method: 'item/fileChange/requestApproval', params: { threadId: 'T', turnId: 'turn1', itemId: 'f1', reason: null } })
    check('file change request → card with its paths', cards[1]?.card.title === 'Change these files?' && cards[1].card.detail === '/Users/someone/Desktop/a.txt', JSON.stringify(cards[1]?.card))
    cards[1].answer(false)
    await tick()
    check('Decline → decline', reply(8) === '{"id":8,"result":{"decision":"decline"}}', reply(8))

    cmd(9, { availableDecisions: ['decline', 'cancel'] })
    cards[2].answer(true)
    await tick()
    check('Approve when accept is not offered → decline', reply(9) === '{"id":9,"result":{"decision":"decline"}}', reply(9))

    const permissions = { network: { enabled: true }, fileSystem: { write: ['/Users/someone/Desktop'] } }
    a.request({ id: 10, method: 'item/permissions/requestApproval', params: { threadId: 'T', turnId: 'turn1', itemId: 'p1', cwd: '/w', permissions, reason: 'Save the export', startedAtMs: 0 } })
    check('more permissions → a card saying which', cards[3]?.card.title === 'Allow more access?' && cards[3].card.detail === 'Network access\nWrite /Users/someone/Desktop\nSave the export', JSON.stringify(cards[3]?.card))
    cards[3].answer(true)
    await tick()
    check('Approve → those permissions, for this turn', reply(10) === JSON.stringify({ id: 10, result: { permissions, scope: 'turn' } }), reply(10))
    a.request({ id: 11, method: 'item/permissions/requestApproval', params: { threadId: 'T', turnId: 'turn1', itemId: 'p2', cwd: '/w', permissions, reason: null, startedAtMs: 0 } })
    cards[4].answer(null) // the host withdrew it: a stop
    await tick()
    check('a card the host withdrew → nothing granted', reply(11) === '{"id":11,"result":{"permissions":{},"scope":"turn"}}', reply(11))

    cmd(12, { networkApprovalContext: { host: 'example.com', protocol: 'https' } })
    check('network request → its own title', cards[5]?.card.title === 'Allow network access to example.com?')
    a.resolved(12)
    await tick()
    check('Codex resolves the request itself → the card is withdrawn, no answer sent', cards[5].withdrawn && !reply(12))
    cmd(13)
    a.closeTurn('turn1')
    await tick()
    check('the end of its turn withdraws a card', cards[6]?.withdrawn && !reply(13))

    a.request({ id: 14, method: 'mcpServer/elicitation/request', params: { threadId: 'T', turnId: 'turn1', serverName: 'x', mode: 'form', message: 'Allow?', requestedSchema: {}, _meta: null } })
    a.request({ id: 15, method: 'item/tool/requestUserInput', params: { threadId: 'T', turnId: 'turn1', questions: [] } })
    a.request({ id: 16, method: 'currentTime/read', params: { threadId: 'T' } })
    check('MCP question → declined, no card', reply(14) === '{"id":14,"result":{"action":"decline","content":null,"_meta":null}}' && cards.length === 7)
    check('any other request → JSON-RPC error', JSON.parse(reply(15)).error?.code === -32601)
    check('currentTime/read → whole seconds', Number.isInteger(JSON.parse(reply(16)).result.currentTimeAt))
    check('never acceptForSession', !answered.some(r => JSON.stringify(r).includes('ForSession')))
  }

  // ---------------------------------------------------------------- steps
  const titles = [
    [{ type: 'commandExecution', command: "/bin/zsh -lc 'git status'", commandActions: [{ type: 'unknown', command: 'git status' }] }, 'git status'],
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
    [{ type: 'mcpToolCall', server: 'lookma', tool: 'see' }, null],
    [{ type: 'reasoning', summary: [], content: [] }, null],
    [{ type: 'agentMessage', text: 'Done.' }, null],
  ]
  const wrong = titles.filter(([it, want]) => stepTitle(it, 'lookma') !== want).map(([it]) => `${it.type}: ${stepTitle(it, 'lookma')}`)
  check(`step titles for ${titles.length} items; Lookma's own tools and the rest give none`, wrong.length === 0, wrong.join('; '))
}

// ---------------------------------------------------------------- the real binary, no turn

async function handshake() {
  const { WebSocketServer } = await import('ws')
  const { createExecutorHost } = await import('../../../core/executor/host.mjs')
  const plugin = await load('executors', 'codex', process.env)
  const auth = path.join(plugin.options.home, 'auth.json')
  const authBefore = fs.statSync(auth).mtimeMs
  const statuses = []
  const logs = []
  const config = { root: ROOT, dataDir: DATA, port: PORT, executor: { ...plugin, env: process.env } }
  const host = await createExecutorHost(config, {
    onEvent: () => {},
    onStatus: (status, detail) => statuses.push({ status, detail }),
    say: () => {},
    hands: { run: async () => ({ text: 'no hands in this check' }), abort: () => {} },
    ask: () => Promise.resolve(false),
    log: (...a) => logs.push(a.join(' ')),
  })
  const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT })
  wss.on('connection', ws => host.connect(ws))

  await host.start([fs.realpathSync(DATA)])
  check('the session gets ready: thread started, the tools connected', statuses.at(-1)?.status === 'ready', JSON.stringify(statuses.at(-1)))
  const servers = logs.map(l => l.match(/^codex mcp server (\S+) ready/)?.[1]).filter(Boolean)
  check("only Lookma's own MCP server starts", servers.join() === 'lookma', servers.join())
  check('the bridge dialled the host', !!(await until(() => wss.clients.size === 1, 5000)))
  await host.close()
  check('close: status down, the bridge gone', statuses.at(-1)?.status === 'down' && !!(await until(() => wss.clients.size === 0, 5000)))
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
