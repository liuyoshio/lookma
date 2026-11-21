// Claude Code's permission requests (the SDK's canUseTool) → cards through ctx.ask. Approve allows
// this one call, never a rule for later (Claude Code's suggestions are not passed back). Decline, or
// a card withdrawn (a stop, a restart), denies it, and Claude goes on without it. A request Claude
// Code cancels itself (its interrupt) aborts the signal, which withdraws the card.
import { clip } from '../../core/util.mjs'
import { describe } from './hooks.mjs'

const file = (title, key) => i => [title, i[key]]
const CARDS = {
  Bash: i => ['Run this command?', i.command],
  Write: file('Write this file?', 'file_path'),
  Edit: file('Change this file?', 'file_path'),
  MultiEdit: file('Change this file?', 'file_path'),
  NotebookEdit: file('Change this notebook?', 'notebook_path'),
  Read: file('Read this file?', 'file_path'),
  WebFetch: i => ['Open this web page?', i.url],
  WebSearch: i => ['Search the web?', i.query],
}

/** The card of a request: what the tool would do, and why Claude Code asks (blockedPath, decisionReason). */
export function card(tool, input, { blockedPath, decisionReason }) {
  const [title, what] = CARDS[tool]?.(input) ?? ['Allow this step?', describe(tool, input)]
  return { title, detail: [what, blockedPath !== what && blockedPath, decisionReason].filter(Boolean).join('\n') }
}

/** The SDK's canUseTool: a card, awaited as long as the user takes. */
export function createCanUseTool({ ask, log }) {
  return async (tool, input, { signal, blockedPath, decisionReason }) => {
    const c = card(tool, input, { blockedPath, decisionReason })
    log('card', c.title, clip(c.detail, 120))
    const allow = await ask(c, signal)
    log('answer', allow === null ? 'withdrawn' : allow ? 'allow' : 'deny')
    if (allow) return { behavior: 'allow', updatedInput: input }
    return { behavior: 'deny', message: allow === false ? 'The user declined this step.' : 'The user stopped this step.' }
  }
}
