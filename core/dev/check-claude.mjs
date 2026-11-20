#!/usr/bin/env node
// Checks the Claude adapter's pure parts against the real captures in core/dev/fixtures/claude-captures:
// the dialog parser, dialog identity (signature), choosing with arrows on a fake pane that replays
// a capture, what allow and deny pick, which dialogs become cards; then one approval per dialog
// across the relay and terminal routes, the tmux pane size (a real tmux session "itest-…"), and
// hooks → events.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT } from '../config.mjs'
import { parse, signature, asksPermission, choose, escape } from '../executors/claude/dialog.mjs'
import { createApprovals, allowOption, denyOption } from '../executors/claude/approvals.mjs'
import { createTmux } from '../executors/claude/tmux.mjs'
import { createHookHandler, splitReport } from '../executors/claude/hooks.mjs'

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------- approvals harness

const dialog = (q, ...opts) => ({ question: q, options: opts.map((text, i) => ({ n: i + 1, text })), selected: 1 })
function harness({ choose: pick, escape: esc } = {}) {
  const events = []
  const acts = []
  const logs = []
  const a = createApprovals({
    emit: e => events.push(e),
    relayAnswer: (id, behavior) => acts.push(['relay', id, behavior]),
    choose: pick || (async (sig, n) => acts.push(['choose', n])),
    escape: esc || (async () => acts.push(['escape'])),
    log: (...m) => logs.push(m.join(' ')),
  })
  return { a, events, acts, logs, approvals: () => events.filter(e => e.type === 'approval'), gone: () => events.filter(e => e.type === 'approvalGone') }
}

// ---------------------------------------------------------------- real captures

const dir = path.join(ROOT, 'core', 'dev', 'fixtures', 'claude-captures')
if (fs.existsSync(dir)) {
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8')
  const files = fs.readdirSync(dir).sort()
  const dialogs = files.filter(f => !f.startsWith('nondialog-'))

  // parser
  {
    const bad = files.filter(f => (f.startsWith('nondialog-') ? parse(read(f)) !== null : parse(read(f)) === null))
    check(`parser on ${files.length} real captures (dialogs found, non-dialogs ignored)`, bad.length === 0, bad.join(', '))
    const warn = parse(read('c-dev-channel-warning.txt'))
    check('dev-channel warning: question and options', /development channels/.test(warn.question) && warn.options[0].text === 'I am using this for local development' && warn.options[1].text === 'Exit')
    check('2.1.329: the "❯" + NBSP prompt is an input frame, not a dialog', parse(read('nondialog-after-ls-2.1.329.txt')) === null && parse(read('a-bash-ls-tmp-2.1.329.txt'))?.options.length === 4)
  }

  // A pane that shows a capture and moves its cursor `lag` ms after an arrow key, like Claude Code.
  // Enter and Escape close the dialog. It records every key and what the screen showed at Enter.
  function fakePane(file, { lag = 40 } = {}) {
    let lines, rows, at, c
    let closed = false
    const load = f => {
      lines = read(f).split('\n')
      rows = []
      if (!parse(read(f))) return
      const cur = lines.findLastIndex(l => /^\s*❯\s/.test(l))
      c = lines[cur].indexOf('❯')
      let top = cur
      while (top > 0 && !/^\s*[─━]{8,}/.test(lines[top - 1])) top--
      for (let i = top; i < lines.length; i++) if (lines[i].slice(0, c + 2).replace('❯', ' ').trim() === '' && /\S/.test(lines[i][c + 2] || ' ')) rows.push(i)
      at = rows.indexOf(cur)
    }
    load(file)
    const due = []
    const p = {
      sent: [],
      enterShowed: undefined, // the option the screen showed under the cursor when Enter was sent
      frozen: false, // arrows do nothing
      set(f) { load(f); closed = false },
      screen() {
        for (const e of due.splice(0).sort((x, y) => x.t - y.t)) if (e.t <= Date.now()) e.fn(); else due.push(e)
        if (closed) return read('nondialog-after-ls.txt')
        return lines.map((l, i) => (rows.includes(i) ? l.slice(0, c) + (rows[at] === i ? '❯' : ' ') + l.slice(c + 1) : l)).join('\n')
      },
      capture: async () => p.screen(),
      async keys(...ks) {
        for (const k of ks) {
          p.sent.push(k)
          if (k === 'Enter') {
            const d = parse(p.screen())
            p.enterShowed = d && d.options.find(o => o.n === d.selected)
          }
          if (k === 'Up' || k === 'Down') {
            if (!p.frozen) due.push({ t: Date.now() + lag, fn: () => { at = Math.max(0, Math.min(rows.length - 1, at + (k === 'Down' ? 1 : -1))) } })
          } else if (k === 'Enter' || k === 'Escape') due.push({ t: Date.now() + lag, fn: () => { closed = true } })
        }
        p.onKeys?.(ks)
      },
    }
    return p
  }
  const sigOf = file => signature(parse(read(file)))
  const refused = async fn => { try { await fn(); return null } catch (err) { return err.message } }

  // identity
  {
    check('signature: the same dialog read twice is equal (closed-B-1, closed-D-1)', sigOf('closed-B-1.txt') === sigOf('closed-D-1.txt'))
    check('signature: whitespace is folded, a 70-column re-wrap is the same dialog', sigOf('a-bash-ls-tmp-70cols.txt') === sigOf('closed-A-1.txt') && parse(read('a-bash-ls-tmp-70cols.txt')).question !== parse(read('closed-A-1.txt')).question)
    check('signature: the "N of M" counter is kept ("1 of 2" ≠ "2 of 2")', sigOf('closed-B-2.txt') !== sigOf('closed-B-3.txt') && /1 of 2/.test(sigOf('closed-B-2.txt')))
    const p = fakePane('a-bash-ls-tmp.txt', { lag: 0 })
    await p.keys('Down', 'Down')
    const moved = parse(p.screen())
    check('signature: moving the cursor keeps it', moved.selected === 3 && signature(moved) === sigOf('a-bash-ls-tmp.txt'))

    const h = harness()
    const b2 = parse(read('closed-B-2.txt'))
    const b3 = parse(read('closed-B-3.txt'))
    h.a.screen(b2)
    h.a.screen(b2)
    h.a.screen(b3)
    check('card closes on a poll with a different signature (next queued request)', h.gone().length === 1 && h.gone()[0].id === h.approvals()[0].id)
    h.a.screen(b3)
    check('the next queued request gets its own card', h.approvals().length === 2 && /2 of 2/.test(h.approvals()[1].title))
    h.a.screen(null)
    check('card closes on a poll with no dialog', h.gone().length === 2)
  }

  // choosing
  {
    let p = fakePane('a-bash-ls-tmp.txt')
    await choose(p, sigOf('a-bash-ls-tmp.txt'), 4)
    check('choose: arrows by delta, then Enter (1 → 4: Down ×3)', p.sent.join(',') === 'Down,Down,Down,Enter', p.sent.join(','))
    check('choose: Enter only once the screen shows the cursor on the target', p.enterShowed?.n === 4 && p.enterShowed?.text === 'No')

    p = fakePane('c0-new-mcp-server.txt')
    await choose(p, sigOf('c0-new-mcp-server.txt'), 1)
    check('choose: up from a cursor that starts on the last option (3 → 1: Up ×2)', p.sent.join(',') === 'Up,Up,Enter' && p.enterShowed?.text === 'Use this MCP server', p.sent.join(','))

    p = fakePane('closed-B-3.txt')
    let err = await refused(() => choose(p, sigOf('closed-B-2.txt'), 1))
    check('choose: a different dialog on screen is refused, no key sent', !!err && p.sent.length === 0, err)

    p = fakePane('closed-B-2.txt')
    p.onKeys = () => p.set('closed-B-3.txt') // the next queued request replaces it as the cursor moves
    err = await refused(() => choose(p, sigOf('closed-B-2.txt'), 4))
    check('choose: the dialog changing while the cursor moves is refused, no Enter', !!err && !p.sent.includes('Enter'), `${err}; ${p.sent.join(',')}`)

    p = fakePane('nondialog-idle.txt')
    err = await refused(() => choose(p, sigOf('a-bash-ls-tmp.txt'), 1))
    const errEsc = await refused(() => escape(p, sigOf('a-bash-ls-tmp.txt')))
    check('choose / escape: no dialog on screen, no key sent', !!err && !!errEsc && p.sent.length === 0)

    p = fakePane('a-bash-ls-tmp.txt')
    await escape(p, sigOf('a-bash-ls-tmp.txt'))
    check('escape: Escape on the dialog of the card', p.sent.join(',') === 'Escape')
  }

  // what allow and deny pick, end to end: capture → card → answer → keys on the fake pane
  async function answerOn(file, allow) {
    const p = fakePane(file)
    const h = harness({ choose: (sig, n) => choose(p, sig, n), escape: sig => escape(p, sig) })
    const d = parse(read(file))
    h.a.screen(d)
    h.a.screen(d)
    await h.a.answer(h.approvals()[0]?.id, allow)
    return { keys: p.sent.join(','), picked: p.enterShowed?.text, logs: h.logs }
  }
  {
    const want = [
      ['a-bash-ls-tmp.txt', true, 'Enter', 'Yes'],
      ['a-bash-ls-tmp-2.1.329.txt', true, 'Enter', 'Yes'],
      ['b-read-outside.txt', true, 'Enter', 'Yes'],
      ['e-write-file.txt', true, 'Enter', 'Yes'],
      ['c-dev-channel-warning.txt', true, 'Enter', 'I am using this for local development'],
      ['c0-new-mcp-server.txt', true, 'Up,Up,Enter', 'Use this MCP server'],
      ['a-bash-ls-tmp.txt', false, 'Down,Down,Down,Enter', 'No'],
      ['b-read-outside.txt', false, 'Down,Down,Enter', 'No'],
      ['e-write-file.txt', false, 'Down,Down,Enter', 'No'],
      ['c-dev-channel-warning.txt', false, 'Escape', undefined],
      ['c0-new-mcp-server.txt', false, 'Escape', undefined],
    ]
    for (const [file, allow, keys, picked] of want) {
      const r = await answerOn(file, allow)
      check(`${allow ? 'allow' : 'deny'} on ${file}: ${picked ? `"${picked}"` : 'Escape'}`, r.keys === keys && r.picked === picked, `${r.keys} → ${r.picked} ${r.logs.join('; ')}`)
    }
    const broader = /allow|auto mode|all future|don't ask again|accept edits|always/i
    const permission = dialogs.filter(f => asksPermission(parse(read(f))))
    const bad = permission.filter(f => broader.test(allowOption(parse(read(f)).options)?.text ?? 'none'))
    check(`allow never picks a broader option (${permission.length} permission captures)`, bad.length === 0, bad.join(', '))
    const opts = (...t) => t.map((text, i) => ({ n: i + 1, text }))
    check('allow: folder trust picks "Yes, I trust this folder"', allowOption(opts('No, exit', 'Yes, I trust this folder'))?.n === 2)
    check('allow: exactly "Yes" wins over an earlier "Yes, …"', allowOption(opts('Yes, and manually approve edits', 'Yes', 'No'))?.n === 2)
    check('allow: skips broader options even when first', allowOption(opts("Yes, and don't ask again for ls", 'Yes, just this time', 'No'))?.n === 2)
    check('allow: nothing when every option is broader', allowOption(opts('Yes, always allow', 'Use this and all future MCP servers')) === null)
    check('deny: the option starting with "No", else Escape (null)', denyOption(opts('Yes', 'No, and tell Claude what to do differently'))?.n === 2 && denyOption(opts('I am using this for local development', 'Exit')) === null)

    const p = fakePane('a-bash-ls-tmp.txt')
    p.frozen = true // the cursor never gets there
    const h = harness({ choose: (sig, n) => choose(p, sig, n), escape: sig => escape(p, sig) })
    const d = parse(read('a-bash-ls-tmp.txt'))
    h.a.screen(d)
    h.a.screen(d)
    await h.a.answer(h.approvals()[0].id, false)
    h.a.screen(d)
    check('a refused answer re-issues the card for the dialog still on screen', h.approvals().length === 2 && !p.sent.includes('Enter') && /did not reach/.test(h.logs.join()), h.logs.join('; '))
  }

  // settings dialogs never become cards
  {
    const pickers = dialogs.filter(f => /^d-/.test(f))
    const permission = dialogs.filter(f => !/^d-/.test(f))
    const asked = pickers.filter(f => asksPermission(parse(read(f))))
    const missed = permission.filter(f => !asksPermission(parse(read(f))))
    check(`settings menus and questions are not permission dialogs (${pickers.length}: /model, AskUserQuestion)`, asked.length === 0, asked.join(', '))
    check(`permission, trust and startup dialogs are (${permission.length})`, missed.length === 0, missed.join(', '))
    const h = harness()
    for (const f of ['d-model-picker.txt', 'd-model-picker-fullscreen.txt']) for (let i = 0; i < 3; i++) h.a.screen(parse(read(f)))
    check('the /model picker on screen for several polls gives no card', h.approvals().length === 0)
  }
} else {
  console.log('SKIP real captures (core/dev/fixtures/claude-captures not found)')
}

// ---------------------------------------------------------------- approvals

{
  const h = harness()
  const d = dialog('Read file\nDo you want to proceed?', 'Yes', 'Yes, allow reading from x during this session', 'No')
  h.a.screen(null)
  h.a.screen(d)
  check('terminal: a dialog seen once is not yet an approval', h.approvals().length === 0)
  h.a.screen(d)
  h.a.screen(d)
  h.a.screen(d)
  check('terminal: a dialog on screen for several polls gives one approval, without its options', h.approvals().length === 1 && h.approvals()[0].title === 'Read file' && !('options' in h.approvals()[0]))
  h.a.screen(null)
  check('terminal: the dialog closing sends approvalGone', h.gone().length === 1 && h.gone()[0].id === h.approvals()[0].id)
}

{
  const h = harness()
  const d = dialog('Bash command\nls /tmp\nDo you want to proceed?', 'Yes', 'Yes, and always allow', 'No')
  h.a.relay({ request_id: 'r1', tool_name: 'Bash', description: 'List /tmp', input_preview: 'ls /tmp' })
  h.a.screen(d)
  h.a.screen(d)
  h.a.screen(d)
  check('relay then terminal: one approval for the dialog', h.approvals().length === 1 && h.approvals()[0].title === 'Allow Bash?')
  h.a.answer(h.approvals()[0].id, true)
  check('relay: allow goes through the relay', JSON.stringify(h.acts) === '[["relay","r1","allow"]]')
  h.a.screen(d)
  h.a.screen(d)
  h.a.screen(null)
  check('relay: no second approval while the answered dialog is still drawn', h.approvals().length === 1 && h.gone().length === 0)
}

{
  const h = harness()
  const d = dialog('Bash command\nDo you want to proceed?', 'Yes', 'No')
  h.a.screen(d) // drawn just before the relay arrives
  h.a.relay({ request_id: 'r2', tool_name: 'Bash', description: '', input_preview: 'rm x' })
  h.a.screen(d)
  h.a.screen(d)
  check('terminal first, relay right after: still one approval', h.approvals().length === 1)
  h.a.screen(null)
  check('the relayed dialog answered in the terminal: approvalGone', h.gone().length === 1)
}

{
  const h = harness()
  const d = dialog('Do you want to create note.txt?', 'Yes', 'Yes, and switch to accept edits', 'No')
  h.a.screen(d)
  h.a.screen(d)
  await h.a.answer(h.approvals()[0].id, true)
  check('terminal: allow picks "Yes" ("yes, once")', JSON.stringify(h.acts) === '[["choose",1]]')
  h.a.screen(d)
  check('terminal: no new approval for a dialog we answered', h.approvals().length === 1)

  const w = dialog('WARNING: Loading development channels', 'I am using this for local development', 'Exit')
  h.a.screen(w)
  h.a.screen(w)
  await h.a.answer(h.approvals()[1].id, false)
  check('terminal: deny without a "No" option sends Escape', JSON.stringify(h.acts.at(-1)) === '["escape"]')

  const x = dialog('Read file\nDo you want to proceed?', 'Yes', 'No')
  h.a.screen(x)
  h.a.screen(x)
  await h.a.answer(h.approvals()[2].id, false)
  check('terminal: deny picks the "No" option', JSON.stringify(h.acts.at(-1)) === '["choose",2]')

  const t = dialog('Accessing workspace:\n/Users/me/project\nQuick safety check: Is this a project you created or one you trust?', 'No, exit', 'Yes, I trust this folder')
  h.a.screen(t)
  h.a.screen(t)
  await h.a.answer(h.approvals()[3].id, true)
  check('terminal: allow picks the "Yes" option even when it is not first', JSON.stringify(h.acts.at(-1)) === '["choose",2]')

  const w2 = dialog('WARNING: Loading development channels (again)', 'I am using this for local development', 'Exit')
  h.a.screen(w2)
  h.a.screen(w2)
  await h.a.answer(h.approvals()[4].id, true)
  check('terminal: allow with no "Yes" option picks the first', JSON.stringify(h.acts.at(-1)) === '["choose",1]')
}

{
  const h = harness()
  h.a.relay({ request_id: 'r3', tool_name: 'WebFetch', description: '', input_preview: '' })
  h.a.toolDone('WebFetch')
  check('relay: the tool finishing withdraws its approval', h.gone().length === 1)
}

check('signature ignores the cursor', signature({ ...dialog('q', 'a', 'b'), selected: 1 }) === signature({ ...dialog('q', 'a', 'b'), selected: 2 }))

// ---------------------------------------------------------------- tmux pane size

{
  let hasTmux = true
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }) } catch { hasTmux = false }
  if (hasTmux) {
    const t = createTmux(`itest-claude-${process.pid}`)
    try {
      await t.start({ cwd: os.tmpdir(), argv: ['/bin/sleep', '30'] })
      const size = execFileSync('tmux', ['display-message', '-p', '-t', `=${t.name}:`, '#{pane_width}x#{pane_height}'], { encoding: 'utf8' }).trim()
      check('tmux: the session starts with a fixed 120x40 pane', size === '120x40', size)
    } finally {
      await t.kill()
    }
  } else {
    console.log('SKIP tmux pane size (tmux not found)')
  }
}

// ---------------------------------------------------------------- hooks

{
  const events = []
  const dropped = []
  const hook = createHookHandler({ emit: e => events.push(e), approvals: { toolDone: t => dropped.push(t) } })
  hook({ hook_event_name: 'UserPromptSubmit' })
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/a/b/notes.txt' } })
  hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__lookma__click', tool_input: { label: 'Open #general' } })
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'Sum receipts' } })
  hook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose' })
  hook({ hook_event_name: 'SubagentStart', agent_id: 'x', agent_type: '' })
  hook({ hook_event_name: 'PreToolUse', agent_id: 'a1', tool_name: 'Bash', tool_input: { description: 'Add up totals' } })
  hook({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'general-purpose', last_assistant_message: 'Done.\nSAY: Twelve thousand yen.\nSHOW: ¥12,000 · 3 receipts' })
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })
  hook({ hook_event_name: 'Stop' })
  const types = events.map(e => e.type).join(',')
  check('hooks → turnStart, step, task…, turnEnd', types === 'turnStart,step,step,task,task,task,turnEnd', types)
  check('hooks: our own tools are not steps', !events.some(e => e.type === 'step' && /general/.test(e.title)))
  check('hooks: a step is its title', JSON.stringify(events[1]) === '{"type":"step","title":"Read notes.txt"}', JSON.stringify(events[1]))
  check('hooks: task title from the Agent call, report from SAY/SHOW', events[3].title === 'Sum receipts' && events[5].result.speech === 'Twelve thousand yen.' && events[5].result.display === '¥12,000 · 3 receipts')
  check('hooks: PostToolUse tells approvals the tool finished', dropped[0] === 'Bash')
  check('splitReport without SAY/SHOW falls back to the text', splitReport('It is 3 pm.').speech === 'It is 3 pm.')
}

console.log(failures ? `${failures} FAILED` : 'all passed')
process.exit(failures ? 1 : 0)
