// The tools every executor gives its agent, as JSON Schema in the { name, description, inputSchema }
// shape that MCP and tool-use APIs take: say, the agent's only way to speak to the user, and the six
// hands tools that core/hands.mjs runs. An adapter hands them to its agent as they are and adds
// only what its agent needs on top.

const tool = (name, description, properties, required) => ({ name, description, inputSchema: { type: 'object', properties, required } })

const label = { type: 'string', description: 'What this step does, in a few words in the language of the user\'s latest message, e.g. "Open #general". Shown on screen at the target.' }
const element = { type: 'string', description: 'An element id from the last see.' }
const point = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[x, y] in the pixels of the last screenshot (see with screenshot: true).' }

export const SAY = tool('say', 'Say one short sentence to the user, spoken and shown as a caption. The only way the user hears you.', {
  speech: { type: 'string', description: 'The sentence to speak, in the language of the user\'s latest message, with numbers written as spoken.' },
  display: { type: 'string', description: 'The on-screen version; may use digits and symbols. Defaults to speech.' },
  kind: { type: 'string', enum: ['info', 'question', 'confirm'], description: '"question" when you need an answer; "confirm" before send, submit, pay or delete.' },
}, ['speech'])

export const HANDS = [
  tool('see', 'List an app\'s elements with ids, and states such as (selected) or (disabled). Defaults to the frontmost app. Call it before acting and again after the screen changes.', {
    label,
    app: { type: 'string', description: 'App name, e.g. "Slack". Omit for the frontmost app.' },
    screenshot: { type: 'boolean', description: 'Also return a screenshot of the app. Ask only when the element list is not enough: a canvas, a map, unlabeled icons, or a list that says it was cut. Default false.' },
  }, ['label']),
  tool('click', 'Click an element by id (preferred), or a point in the last screenshot.', { label, element, point }, ['label']),
  tool('type', 'Type text into the focused field of the app you are working in.', {
    label,
    text: { type: 'string' },
  }, ['label', 'text']),
  tool('key', 'Press a key or a combination in the app you are working in, e.g. "return", "escape", "cmd+t".', {
    label,
    combo: { type: 'string' },
  }, ['label', 'combo']),
  tool('scroll', 'Scroll at an element, a point, or the app you are working in. `pages` is how far, in pages of the visible area: default 1, 0.25 for a small move. The result says where it is now, or that it did not move.', {
    label,
    element,
    point,
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    pages: { type: 'number', description: 'How far, in pages of the visible area: above 0, at most 10. Default 1.' },
  }, ['label', 'direction']),
  tool('open', 'Open an app (by pressing its Dock icon), a URL (in the default browser) or a file or folder. Give exactly one of app, url or path.', {
    label,
    app: { type: 'string' },
    url: { type: 'string' },
    path: { type: 'string' },
  }, ['label']),
]
