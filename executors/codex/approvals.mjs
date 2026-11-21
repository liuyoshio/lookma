// Codex's requests to Lookma (server → client JSON-RPC requests) → cards through ctx.ask, or a
// direct reply. Every request gets an answer, since an unanswered one blocks its turn:
//   a command, a file change, more permissions → a card; Approve grants it this once, Decline
//                                     (or a card withdrawn) refuses it and Codex goes on
//   MCP questions → declined without a card; the current time → told
//   anything else → a JSON-RPC error
// A card is withdrawn, with no answer sent, when Codex resolves its request itself
// (serverRequest/resolved), when its turn ends, or when Codex exits.
import { clip } from '../../core/util.mjs'
import { unwrap } from './events.mjs'

const NOT_SUPPORTED = { code: -32601, message: 'Not supported by Lookma.' }

function commandCard(p) {
  const title = p.networkApprovalContext ? `Allow network access to ${p.networkApprovalContext.host}?`
    : p.kind === 'writeStdin' ? 'Send input to the running command?'
    : 'Run this command?'
  return { title, detail: [p.command && unwrap(p.command), p.reason].filter(Boolean).join('\n') }
}

// A sandbox path as Codex gives it: a path, a glob, or a special place ("root", "project_roots").
const where = p => (p.type === 'path' ? p.path : p.type === 'glob_pattern' ? p.pattern : [p.value.kind, p.value.subpath].filter(Boolean).join(' '))

function permissionsCard({ permissions: { network, fileSystem }, reason }) {
  const lines = [
    network?.enabled && 'Network access',
    ...(fileSystem?.write ?? []).map(p => `Write ${p}`),
    ...(fileSystem?.read ?? []).map(p => `Read ${p}`),
    ...(fileSystem?.entries ?? []).map(e => `${e.access}: ${where(e.path)}`),
    reason,
  ]
  return { title: 'Allow more access?', detail: lines.filter(Boolean).join('\n') }
}

// Approve is "accept", this once. Without it on offer, nothing broader is ever chosen: decline.
// Codex takes "decline" even when it lists only "cancel" (which would end the whole turn).
const decision = (allow, p) => ({ decision: allow && (!p.availableDecisions || p.availableDecisions.includes('accept')) ? 'accept' : 'decline' })

export function createApprovals({ ask, respond, fail, log }) {
  const open = new Map() // request id -> { turnId, ctl }, while its card is up
  const changes = new Map() // fileChange item id -> { turnId, paths }, for its card's detail
  const refused = new Set() // request methods refused, logged once each

  const CARDS = {
    'item/commandExecution/requestApproval': { card: commandCard, answer: decision },
    // The paths are in the fileChange item that started just before.
    'item/fileChange/requestApproval': {
      card: p => ({ title: 'Change these files?', detail: [...(changes.get(p.itemId)?.paths ?? []), p.reason].filter(Boolean).join('\n') }),
      answer: decision,
    },
    // Granted for this turn only, the narrower of Codex's two scopes.
    'item/permissions/requestApproval': {
      card: permissionsCard,
      answer: (allow, p) => ({ permissions: allow ? p.permissions : {}, scope: 'turn' }),
    },
  }
  const DIRECT = {
    'mcpServer/elicitation/request': () => ({ action: 'decline', content: null, _meta: null }),
    'currentTime/read': () => ({ currentTimeAt: Math.floor(Date.now() / 1000) }),
  }

  async function onCard(id, method, params) {
    const card = CARDS[method].card(params)
    const ctl = new AbortController()
    open.set(id, { turnId: params.turnId, ctl })
    log('card', id, card.title, clip(card.detail, 120))
    const allow = await ask(card, ctl.signal)
    if (ctl.signal.aborted) return // Codex closed the request itself
    open.delete(id)
    const result = CARDS[method].answer(allow === true, params)
    log('answer', id, JSON.stringify(result))
    respond(id, result)
  }

  function request({ id, method, params }) {
    if (CARDS[method]) return onCard(id, method, params)
    if (DIRECT[method]) {
      if (method !== 'currentTime/read') log('declined', method, clip(params.message, 120))
      return respond(id, DIRECT[method](params))
    }
    if (!refused.has(method)) log('refused', method, '(not supported)')
    refused.add(method)
    fail(id, NOT_SUPPORTED)
  }

  function withdraw(id) {
    open.get(id).ctl.abort()
    open.delete(id)
  }

  // A file change item started: remember its paths for the approval request that may follow.
  function fileChange(item, turnId) {
    changes.set(item.id, { turnId, paths: item.changes.map(c => c.path) })
  }

  function resolved(id) {
    if (open.has(id)) withdraw(id)
  }

  function closeTurn(turnId) {
    for (const [id, a] of open) if (a.turnId === turnId) withdraw(id)
    for (const [id, c] of changes) if (c.turnId === turnId) changes.delete(id)
  }

  function clear() {
    for (const id of [...open.keys()]) withdraw(id)
    changes.clear()
  }

  return { request, fileChange, resolved, closeTurn, clear }
}
