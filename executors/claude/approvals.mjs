// One approval per dialog. Claude Code dialogs reach the adapter by two routes:
//   relay    — permission requests the channel forwards; answered through the channel.
//   terminal — dialogs the 1 s capture-pane poll parses that ask for permission or trust
//              (dialog.mjs asksPermission; never settings menus); answered with keys.
// A dialog is known by its signature. A relayed request is also drawn in the terminal; while one is
// pending, the dialog on screen belongs to it. A dialog counts once it is on screen for two polls
// in a row, so a relay that lands just after the dialog is drawn still claims it. Its card closes
// on the first poll that shows no dialog or a different one.
import { signature, asksPermission } from './dialog.mjs'

// Options that grant more than this one request or change settings. Approve never picks them.
const BROADER = ['allow', 'and switch to auto mode', 'all future', "don't ask again", 'accept edits', 'always']
const once = options => options.filter(o => !BROADER.some(w => o.text.toLowerCase().replace(/’/g, "'").includes(w)))

// allow: "yes, once": the option that is exactly "Yes", else the first starting with "Yes", else
// the first option ("I am using this for local development", "Use this MCP server").
export function allowOption(options) {
  const ok = once(options)
  return ok.find(o => o.text === 'Yes') || ok.find(o => /^yes\b/i.test(o.text)) || ok[0] || null
}

// deny: the first option starting with "No"; null means Escape.
export const denyOption = options => options.find(o => /^no\b/i.test(o.text)) || null

export function createApprovals({ emit, relayAnswer, choose, escape, log }) {
  const open = new Map() // id -> { id, requestId?, tool?, key, dialog }
  let n = 0
  let lastKey = null // the dialog seen on the previous poll
  let answeredKey = null // a dialog we answered; ignored until it leaves the screen

  function add(a, card) {
    open.set(a.id, a)
    emit({ type: 'approval', id: a.id, ...card })
  }

  function drop(a) {
    open.delete(a.id)
    emit({ type: 'approvalGone', id: a.id })
  }

  function relay(p) {
    const detail = [p.description, p.input_preview].filter(Boolean).join('\n')
    add({ id: `ap${++n}`, requestId: p.request_id, tool: p.tool_name, key: null }, { title: `Allow ${p.tool_name}?`, detail })
  }

  // Called on every poll with the parsed dialog, or null.
  function screen(d) {
    const key = d && asksPermission(d) ? signature(d) : null
    if (key !== lastKey) {
      for (const a of [...open.values()]) if (a.key && a.key === lastKey) drop(a) // its dialog closed
      if (answeredKey !== key) answeredKey = null
      lastKey = key
      return
    }
    if (!key || key === answeredKey) return
    const all = [...open.values()]
    if (all.some(a => a.key === key)) return
    const relayed = all.find(a => a.requestId && !a.key)
    if (relayed) {
      relayed.key = key
      relayed.dialog = d
      return
    }
    const [title, ...rest] = d.question.split('\n')
    add({ id: `ap${++n}`, key, dialog: d }, { title: title || 'Claude Code is asking', detail: rest.join('\n') })
  }

  // The relay if the request came through it, else keys for allowOption / denyOption (Escape when
  // there is no "No"). If the keys are refused (the dialog changed, the cursor did not get there),
  // nothing was answered and the dialog still on screen gets a new card.
  async function answer(id, allow) {
    const a = open.get(id)
    if (!a) return
    open.delete(id)
    if (a.key) answeredKey = a.key
    if (a.requestId) return relayAnswer(a.requestId, allow ? 'allow' : 'deny')
    try {
      const pick = allow ? allowOption(a.dialog.options) : denyOption(a.dialog.options)
      if (pick) await choose(a.key, pick.n)
      else if (allow) throw new Error('no option allows just this once')
      else await escape(a.key)
    } catch (err) {
      if (answeredKey === a.key) answeredKey = null
      log('answer refused', err.message)
    }
  }

  // A tool call finished, so a relayed request for it was answered (maybe in the terminal).
  function toolDone(tool) {
    for (const a of [...open.values()]) if (a.requestId && a.tool === tool) drop(a)
  }

  function clear() {
    for (const a of [...open.values()]) drop(a)
    lastKey = answeredKey = null
  }

  return { relay, screen, answer, toolDone, clear }
}
