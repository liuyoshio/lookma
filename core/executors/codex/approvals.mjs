// Codex's requests to Lookma (server → client JSON-RPC requests) → approval cards, or a direct reply.
// Every request gets an answer, since an unanswered one blocks its turn:
//   a command or a file change      → a card; Approve is "accept" (this once), Decline is "decline"
//                                     (refused, and Codex goes on, as Claude's "No" does)
//   extra permissions, MCP questions → refused without a card; the current time → told
//   anything else                    → a JSON-RPC error
// A card closes when Codex resolves its request (serverRequest/resolved), when its turn ends, or
// when Codex exits.
import { clip } from '../../util.mjs'
import { unwrap } from './events.mjs'

const NOT_SUPPORTED = { code: -32601, message: 'Not supported by Lookma.' }

function commandCard(p) {
  const title = p.networkApprovalContext ? `Allow network access to ${p.networkApprovalContext.host}?`
    : p.kind === 'writeStdin' ? 'Send input to the running command?'
    : 'Run this command?'
  return { title, detail: [p.command && unwrap(p.command), p.reason].filter(Boolean).join('\n') }
}

export function createApprovals({ emit, respond, fail, log }) {
  const open = new Map() // card id -> { rpcId, turnId, decisions }
  const changes = new Map() // fileChange item id -> { turnId, paths }, for its card's detail
  const refused = new Set() // request methods refused, logged once each

  const CARDS = {
    'item/commandExecution/requestApproval': commandCard,
    // The paths are in the fileChange item that started just before.
    'item/fileChange/requestApproval': p => ({ title: 'Change these files?', detail: [...(changes.get(p.itemId)?.paths ?? []), p.reason].filter(Boolean).join('\n') }),
  }
  const DIRECT = {
    'item/permissions/requestApproval': () => ({ permissions: {}, scope: 'turn' }), // grants nothing
    'mcpServer/elicitation/request': () => ({ action: 'decline', content: null, _meta: null }),
    'currentTime/read': () => ({ currentTimeAt: Math.floor(Date.now() / 1000) }),
  }

  function drop(id) {
    open.delete(id)
    emit({ type: 'approvalGone', id })
  }

  function request({ id, method, params }) {
    if (CARDS[method]) {
      const cardId = `codex-${id}`
      const card = CARDS[method](params)
      open.set(cardId, { rpcId: id, turnId: params.turnId, decisions: params.availableDecisions })
      log('approval', cardId, card.title, clip(card.detail, 120))
      emit({ type: 'approval', id: cardId, ...card })
    } else if (DIRECT[method]) {
      if (method !== 'currentTime/read') log('declined', method, clip(params.message ?? params.reason, 120))
      respond(id, DIRECT[method](params))
    } else {
      if (!refused.has(method)) log('refused', method, '(not supported)')
      refused.add(method)
      fail(id, NOT_SUPPORTED)
    }
  }

  function answer(cardId, allow) {
    const a = open.get(cardId)
    open.delete(cardId)
    // Approve is "accept", this once. Without it on offer, nothing broader is ever chosen: decline.
    // Codex takes "decline" even when it lists only "cancel" (which would end the whole turn).
    const decision = allow && (!a.decisions || a.decisions.includes('accept')) ? 'accept' : 'decline'
    log('answer', cardId, decision)
    respond(a.rpcId, { decision })
  }

  // A file change item started: remember its paths for the approval request that may follow.
  function fileChange(item, turnId) {
    changes.set(item.id, { turnId, paths: item.changes.map(c => c.path) })
  }

  function resolved(rpcId) {
    for (const [id, a] of open) if (a.rpcId === rpcId) drop(id)
  }

  function closeTurn(turnId) {
    for (const [id, a] of open) if (a.turnId === turnId) drop(id)
    for (const [id, c] of changes) if (c.turnId === turnId) changes.delete(id)
  }

  function clear() {
    for (const id of open.keys()) drop(id)
    changes.clear()
  }

  return { request, answer, fileChange, resolved, closeTurn, clear }
}
