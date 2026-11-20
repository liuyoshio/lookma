// Claude Code terminal dialogs, read from `tmux capture-pane -p`. Checked against the
// real captures in core/dev/fixtures/claude-captures ( Claude Code 2.1.314 and 2.1.329,
// fullscreen and default TUI).
//
//   parse(paneText) -> null | { question, options: [{ n, text }], selected }
//
// One structural rule, no per-dialog branches:
//   1. Claude Code shows either its input frame (a solid rule, a line starting with "❯", a solid
//      rule) or a dialog that replaces it. If the input frame is on screen there is no dialog.
//   2. The dialog's cursor is the last line with "❯" in its gutter. Its options are the lines
//      aligned at the same column (all numbered "N." or all unnumbered). Deeper-indented lines are
//      continuations. A numbered list may cross a blank line or a rule if the numbering continues.
//   3. The question is everything between the solid rule above the options and the options.
// Runs of 3+ spaces (column padding) become two spaces. ANSI escapes are stripped first.
//
// A dialog's identity is its signature (question and options, whitespace folded). The keys sent to
// a dialog are arrows and Enter (never digits: they are text in "Type something" rows and only
// reach 1-9), and none is sent unless parse() shows the dialog the card was made for.
import { sleep } from '../../util.mjs'

const RULE = /^\s*[─━═▔]{8,}/ // solid rule; the dashed ╌ lines inside dialogs are not boundaries
const DASHED = /^\s*[╌┄┈]{8,}\s*$/
const CURSOR = '❯'

export function stripAnsi(s) {
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
}

const tidy = s => s.trim().replace(/ {3,}/g, '  ')

function info(raw) {
  const m = raw.match(/^(\s*)(?:([❯↑↓])(?:\s+|$))?(.*)$/) // 2.1.329 draws the prompt as "❯" + NBSP
  const col = raw.length - m[3].length
  const num = m[3].match(/^(\d+)\.\s+/)
  return {
    blank: raw.trim() === '',
    rule: RULE.test(raw),
    glyph: m[2] || null,
    col,
    n: num ? Number(num[1]) : null,
    textCol: num ? col + num[0].length : col,
    text: num ? m[3].slice(num[0].length) : m[3],
  }
}

function hasInputFrame(L) {
  for (let i = 0; i + 1 < L.length; i++) {
    if (!RULE.test(L[i]) || !L[i + 1].startsWith(CURSOR)) continue
    for (let j = i + 2; j < L.length; j++) {
      if (RULE.test(L[j])) return true
      if (L[j] === '' || /^\s{2}/.test(L[j])) continue // wrapped or multi-line input
      break
    }
  }
  return false
}

export function parse(paneText) {
  const L = stripAnsi(paneText).split('\n').map(s => s.replace(/\s+$/, ''))
  if (hasInputFrame(L)) return null

  let s = -1
  for (let i = L.length - 1; i >= 0; i--) {
    if (info(L[i]).glyph === CURSOR) {
      s = i
      break
    }
  }
  if (s < 0) return null
  const sel = info(L[s])
  const numbered = sel.n !== null
  const isStart = x => !x.blank && !x.rule && x.col === sel.col && (x.n !== null) === numbered

  // The block's extent around the cursor line.
  const extend = (from, step) => {
    let edge = from
    let lastN = sel.n
    for (let i = from + step; i >= 0 && i < L.length; i += step) {
      const x = info(L[i])
      if (isStart(x)) {
        edge = i
        lastN = x.n
        continue
      }
      if (!x.blank && !x.rule && x.col > sel.col) {
        edge = i
        continue
      }
      if (numbered && (x.blank || x.rule)) {
        let k = i
        while (k >= 0 && k < L.length && (info(L[k]).blank || info(L[k]).rule) && Math.abs(k - i) < 3) k += step
        const y = k >= 0 && k < L.length ? info(L[k]) : null
        if (y && isStart(y) && y.n === lastN + step) {
          i = k - step
          continue
        }
      }
      break
    }
    return edge
  }
  const top = extend(s, -1)
  const bottom = extend(s, +1)

  // Options top-down; leading non-option lines and broken structure are dropped.
  let options = []
  let cur = null
  let selected = null
  for (let i = top; i <= bottom; i++) {
    const x = info(L[i])
    if (x.blank || x.rule) continue
    if (isStart(x)) {
      cur = { n: numbered ? x.n : options.length + 1, text: tidy(x.text), _textCol: x.textCol }
      options.push(cur)
      if (i === s) selected = cur.n
    } else if (cur && x.col >= cur._textCol) {
      cur.text += ' ' + tidy(L[i])
    } else if (i < s) {
      options = []
      cur = null
    } else break
  }
  if (selected === null || options.length < 2) return null
  if (numbered && options.some((o, k) => k > 0 && o.n !== options[k - 1].n + 1)) return null

  // Question: lines between the solid rule above the block and the block.
  let firstOpt = s
  for (let i = top; i <= s; i++) {
    if (isStart(info(L[i]))) {
      firstOpt = i
      break
    }
  }
  const q = []
  for (let i = firstOpt - 1; i >= 0 && !RULE.test(L[i]); i--) {
    if (L[i].trim() && !DASHED.test(L[i])) q.unshift(tidy(L[i]))
  }
  return { question: q.join('\n'), options: options.map(({ n, text }) => ({ n, text })), selected }
}

// The dialog's identity: two reads with the same signature are the same dialog, wherever its
// cursor is. Whitespace is folded so a re-wrapped question is not a new dialog; the "1 of 2" queue
// counter stays in, so the next queued request with the same text is.
const fold = t => t.replace(/\s+/g, ' ').trim()
export const signature = d => (d ? JSON.stringify([fold(d.question), d.options.map(o => [o.n, fold(o.text)])]) : null)

// Only dialogs that ask for permission or trust become cards, never settings menus such as the
// /model picker: a question with Yes/No options (tool permissions, folder trust), or one of the
// startup questions that have neither.
const STARTUP = ['WARNING: Loading development channels', 'New MCP server found']
export function asksPermission(d) {
  const yesNo = d.options.some(o => /^yes\b/i.test(o.text)) && d.options.some(o => /^no\b/i.test(o.text))
  return (yesNo && d.question.includes('?')) || STARTUP.some(t => d.question.startsWith(t))
}

const onScreen = async (tmux, sig) => {
  const d = parse(await tmux.capture())
  if (signature(d) !== sig) throw new Error('the dialog on screen is not the one on the card')
  return d
}

// Move the cursor of dialog `sig` to option n with arrows; Enter once the screen shows the cursor
// on n and the dialog is still `sig`.
export async function choose(tmux, sig, n) {
  const d = await onScreen(tmux, sig)
  const to = d.options.findIndex(o => o.n === n)
  if (to < 0) throw new Error(`the dialog has no option ${n}`)
  const delta = to - d.options.findIndex(o => o.n === d.selected)
  if (delta) await tmux.keys(...Array(Math.abs(delta)).fill(delta > 0 ? 'Down' : 'Up'))
  for (let i = 0; i < 40; i++) {
    if ((await onScreen(tmux, sig)).selected === n) return tmux.keys('Enter')
    await sleep(25)
  }
  throw new Error(`the dialog cursor did not reach option ${n}`)
}

// Escape on dialog `sig`. On a permission dialog this also interrupts Claude's turn.
export async function escape(tmux, sig) {
  await onScreen(tmux, sig)
  return tmux.keys('Escape')
}
