#!/usr/bin/env node
// Checks what is Claude Code's own in the adapter (the contract itself is
// core/dev/check-executors.mjs's, against dev/fake-agent.mjs). Offline (npm test): Claude Code's
// hook events as steps and tasks, and LOOKMA_CLAUDE_FLAGS as the SDK's extra args.
//   node executors/claude/dev/check.mjs
import { createHookHandler, splitReport } from '../hooks.mjs'
import { extraArgs } from '../session.mjs'

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---------------------------------------------------------------- hooks
{
  const events = []
  const hook = createHookHandler({ emit: e => events.push(e), server: 'lookma' })
  const tool = (tool_name, tool_input, agent_id) => hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, agent_id })
  tool('Read', { file_path: '/a/b/notes.txt' })
  tool('mcp__lookma__click', { label: 'Open #general' })
  tool('Agent', { description: 'Sum receipts', prompt: '...' })
  hook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose' })
  hook({ hook_event_name: 'SubagentStart', agent_id: 'x', agent_type: '' })
  tool('Bash', { command: 'awk ...', description: 'Add up totals' }, 'a1')
  tool('Bash', { command: 'ls' }, 'x')
  hook({ hook_event_name: 'SubagentStop', agent_id: 'x', agent_type: '', last_assistant_message: 'internal' })
  hook({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'general-purpose', last_assistant_message: 'Done.\nSAY: Twelve thousand yen.\nSHOW: 12,000 yen, 3 receipts' })
  const types = events.map(e => e.type).join()
  check('hooks: steps of the main agent, then the task, its action and its report', types === 'step,step,task,task,task', types)
  check('hooks: a step is its title; our own tools are not steps', events[0].title === 'Read notes.txt' && events[1].title === 'Start: Sum receipts', JSON.stringify(events.slice(0, 2)))
  check('hooks: the task is titled by its Agent call; Claude Code\'s internal agents are not tasks', events[2].title === 'Sum receipts' && events[2].id === 'a1' && events[3].action === 'Add up totals', JSON.stringify(events.slice(2, 4)))
  check('hooks: the report is split into SAY and SHOW', events[4].status === 'done' && events[4].result.speech === 'Twelve thousand yen.' && events[4].result.display === '12,000 yen, 3 receipts', JSON.stringify(events[4]))

  events.length = 0
  tool('Agent', { description: 'Check mail' })
  hook({ hook_event_name: 'SubagentStart', agent_id: 'a2', agent_type: 'general-purpose' })
  tool('SubagentHandback', { message: 'SAY: Nothing new.' }, 'a2')
  hook({ hook_event_name: 'SubagentStop', agent_id: 'a2', agent_type: 'general-purpose', last_assistant_message: 'handed back' })
  check('hooks: a handback is the report, and is not an action', events.length === 3 && events[2].result.speech === 'Nothing new.', JSON.stringify(events))
  check('splitReport without SAY or SHOW falls back to the text', splitReport('It is 3 pm.').speech === 'It is 3 pm.')
}

// ---------------------------------------------------------------- LOOKMA_CLAUDE_FLAGS
{
  const args = extraArgs('--effort high --verbose --max-turns=3 -d')
  const want = { effort: 'high', verbose: null, 'max-turns': '3', d: null }
  check('flags: values, switches, name=value', JSON.stringify(args) === JSON.stringify(want), JSON.stringify(args))
  check('flags: none', JSON.stringify(extraArgs('')) === '{}')
}

console.log(failures ? `${failures} FAILED` : 'all passed')
process.exit(failures ? 1 : 0)
