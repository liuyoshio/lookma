// The hands pipeline. Every GUI tool call from the executor runs the same steps, one call at a time:
//   resolve → grant → attention → mark (~350 ms) → act → return
// See docs/protocol.md, "The hands pipeline". What differs per tool is in the table below; step()
// runs it and knows no tool by name.
import { cancelled, clip, sleep } from './util.mjs'
import { waitUntil } from './state.mjs'

const MARK_MS = 350

const has = v => v !== undefined && v !== null && v !== ''

function need(cond, msg) {
  if (!cond) throw new Error(msg)
}

// The result of an action: one line saying what was done, and which app is in front after it,
// since an action can change that.
const line = done => async (a, r, res, frontmost) => ({ text: `${done(a, r, res)} Frontmost: ${await frontmost()}.` })

// The result of see: the screenshot, and its elements as lines the agent can pick ids from.
function seen(res) {
  const win = res.window?.title ? ` — window "${clip(res.window.title, 80)}"` : ''
  const lines = [
    `App: ${res.app}${win}.`,
    `Screenshot: ${res.shot?.w}x${res.shot?.h} px. A point you click is in these pixels.`,
    'Elements (ids are valid until the next see):',
    ...(res.elements || []).map(e => `${e.id} ${e.role}${e.text ? ` "${clip(e.text, 80)}"` : ''}`),
  ]
  return { text: lines.join('\n'), image: res.image }
}

// The result of a scroll. `position` (0 to 1 along the axis) and `moved` are null when the area has
// no scroll bar to read; "did not move" is what tells the agent to stop scrolling that way.
const EDGE = { up: 'top', down: 'bottom', left: 'left edge', right: 'right edge' }
function scrolled(a, r, res) {
  const pages = a.pages ?? 1
  const how = `${a.direction} ${pages} page${pages === 1 ? '' : 's'} (${res.pixels} px) in ${r.app}`
  if (res.position === null) return `Scrolled ${how}.`
  const pct = Math.round(res.position * 100)
  if (res.moved) return `Scrolled ${how}, now at ${pct}%.`
  const end = a.direction === 'down' || a.direction === 'right' ? pct === 100 : pct === 0
  return end ? `Did not move: already at the ${EDGE[a.direction]} in ${r.app}.` : `Did not move: scrolled ${how}, still at ${pct}%.`
}

// Per tool:
//   target(args, current)  checks the args and says what to resolve (null: nothing to resolve).
//                          `current` is the app of the last step; type, key and scroll go there.
//   front(args, r)         whether acting needs the front, so it waits while the user is busy
//   raise                  false when acting brings the app forward itself (default true)
//   act(args, r)           the app op and its args
//   result(args, r, res, frontmost)  what the executor gets back
// A tool whose args decide which of two specs runs (open) is a function from the args to the spec.
const TOOLS = {
  see: {
    target: a => ({ app: a.app || null }),
    front: () => false,
    act: (a, r) => ['see', { app: r.app }],
    result: (a, r, res) => seen(res),
  },
  click: {
    target: a => {
      need(has(a.element) || Array.isArray(a.point), 'click needs an element id or a point.')
      return has(a.element) ? { element: a.element } : { point: a.point }
    },
    front: (a, r) => !(has(a.element) && r.pressable),
    act: (a, r) => (has(a.element) && r.pressable ? ['press', { element: a.element }] : ['click', { point: r.point }]),
    result: line((a, r) => `Clicked ${has(a.element) ? a.element : `at ${a.point.join(',')}`} in ${r.app}.`),
  },
  type: {
    target: (a, current) => {
      need(typeof a.text === 'string', 'type needs text.')
      return { app: current }
    },
    front: () => true,
    act: a => ['type', { text: a.text }],
    result: line((a, r) => `Typed ${a.text.length} characters in ${r.app}.`),
  },
  key: {
    target: (a, current) => {
      need(has(a.combo), 'key needs a combo, e.g. "cmd+t".')
      return { app: current }
    },
    front: () => true,
    act: a => ['key', { combo: a.combo }],
    result: line((a, r) => `Pressed ${a.combo} in ${r.app}.`),
  },
  scroll: {
    target: (a, current) => {
      need(['up', 'down', 'left', 'right'].includes(a.direction), 'scroll needs a direction: up, down, left or right.')
      need(a.pages === undefined || (typeof a.pages === 'number' && a.pages > 0 && a.pages <= 10), 'scroll pages must be a number above 0 and at most 10, e.g. 1 or 0.25.')
      if (has(a.element)) return { element: a.element }
      if (Array.isArray(a.point)) return { point: a.point }
      return { app: current }
    },
    front: () => true,
    act: (a, r) => ['scroll', { point: r.point, direction: a.direction, pages: a.pages ?? 1 }],
    result: line(scrolled),
  },
  open: a => {
    need(has(a.app) || has(a.url) || has(a.path), 'open needs an app, a url or a path.')
    return has(a.app) ? OPEN_APP : OPEN_ITEM
  },
}

// open is one tool for the agent and two here, told apart by its args.
const OPEN_APP = {
  target: a => ({ dock: a.app }),
  front: () => true,
  raise: false, // pressing the Dock icon brings the app forward
  act: (a, r) => ['click', { point: r.point }],
  result: line(a => `Opened ${a.app}.`),
}
const OPEN_ITEM = {
  target: () => null, // a url or a path: the system opens it in the app it picks
  front: () => true,
  act: a => ['open', has(a.url) ? { url: a.url } : { path: a.path }],
  result: line((a, r, res) => `Opened ${a.url || a.path} in ${res.app || 'its app'}.`),
}

// The tools this pipeline runs; core/tools.mjs describes them to the agent.
export const TOOL_NAMES = Object.keys(TOOLS)

// ask(card, signal) → Promise<boolean>: raise a core card and wait for the answer.
export function createHands({ store, app, grants, ask, log }) {
  let chain = Promise.resolve()
  let ctl = new AbortController()
  let resumed = false
  let seq = 0

  const busy = () => store.data.attention.busy
  const setFocus = fields => store.update(s => (s.focus = { ...s.focus, ...fields }))

  async function grant(name, signal) {
    const g = grants.get(name)
    if (g === true) return
    need(g !== false, `The user has not allowed controlling ${name}.`)
    const allow = await ask({ title: `Allow controlling ${name}?`, detail: 'Lookma will look at and operate this app.' }, signal)
    grants.set(name, allow)
    log('grant', name, allow)
    need(allow, `The user did not allow controlling ${name}.`)
  }

  async function frontmost() {
    try {
      return (await app.request('resolve', { app: null })).app
    } catch {
      return 'unknown'
    }
  }

  async function step(tool, args, signal) {
    const spec = typeof TOOLS[tool] === 'function' ? TOOLS[tool](args) : TOOLS[tool]
    const target = spec.target(args, store.data.focus?.app ?? null)

    // 1. Resolve.
    const r = target ? await app.request('resolve', target) : null
    // 2. Grant.
    if (r?.app) await grant(r.app, signal)

    const id = ++seq
    const label = clip(args.label || tool)
    store.update(s => {
      s.focus = { id, label, action: tool, app: r?.app ?? null, rect: r?.rect ?? null, point: r?.point ?? null, phase: 'moving', background: false, at: Date.now() }
      if (s.turn?.phase === 'working') s.turn.status = label
    })

    try {
      // 3. Attention.
      let background = false
      if (busy()) {
        if (spec.front(args, r)) {
          setFocus({ phase: 'waiting' })
          resumed = false
          await waitUntil(store, () => !busy() || resumed, signal)
          resumed = false
          setFocus({ phase: 'moving' })
        } else {
          background = true
          setFocus({ background: true })
        }
      }
      if (!background && r && !r.frontmost && spec.raise !== false) await app.request('front', { app: r.app })

      // 4. Mark.
      await sleep(MARK_MS, signal)

      // 5. Act.
      setFocus({ phase: 'acting' })
      const [op, opArgs] = spec.act(args, r)
      const res = await app.request(op, opArgs)
      setFocus({ phase: 'done' })

      // 6. Return.
      return await spec.result(args, r, res, frontmost)
    } catch (err) {
      setFocus({ phase: 'failed' })
      throw err
    }
  }

  // Queue a call; steps run strictly one after another.
  function run(tool, args = {}) {
    if (!TOOLS[tool]) return Promise.reject(new Error(`Unknown hands tool: ${tool}`))
    const signal = ctl.signal
    const p = chain.then(() => {
      if (signal.aborted) throw cancelled()
      if (store.data.paused) throw new Error('The user paused Lookma. Nothing can be done on screen until they resume.')
      return step(tool, args, signal)
    })
    chain = p.catch(() => {})
    return p
  }

  return {
    run,
    // Cancel the step in flight and everything queued.
    abort() {
      ctl.abort()
      ctl = new AbortController()
    },
    // "Go ahead" while a step waits for the user to stop.
    goAhead() {
      if (store.data.focus?.phase !== 'waiting') return false
      resumed = true
      store.update(() => {})
      return true
    },
  }
}
