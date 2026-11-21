// The core's state and its overlay clients. Every change schedules one full snapshot per frame.
import { cancelled } from './util.mjs'

const FRAME_MS = 16

// talk: the talk mode the core starts with (config.voice.talk); gestures: whether hand gestures
// are on (config.gestures).
export function createStore({ talk, gestures }) {
  const data = {
    executor: { name: '', status: 'starting', detail: '' },
    app: null, // the app's hello: version and permissions (null while not connected)
    turn: null,
    focus: null,
    attention: { busy: false, idle: null },
    cards: [],
    tasks: [],
    outbox: [], // what the work wants the user told (core/outbox.mjs)
    paused: false, // the user paused: no voice and no hands until they resume
    talk, // 'key' | 'always': how the user talks to the voice (LOOKMA_TALK, or the app's menu for this run)
    gestures, // hand gestures on (LOOKMA_GESTURES, or the app's menu for this run); only the app needs it, so not in the snapshot
  }
  const clients = new Set()
  const watchers = new Set()
  let timer = null

  function snapshot() {
    const ex = data.executor
    const status = ex.status === 'ready' && data.turn?.phase === 'working' ? 'busy' : ex.status
    return {
      type: 'state',
      executor: { ...ex, status },
      turn: data.turn,
      focus: data.focus,
      attention: data.attention,
      app: data.app,
      cards: data.cards,
      tasks: data.tasks,
      outbox: data.outbox,
      paused: data.paused,
      talk: data.talk,
    }
  }

  function broadcast(text) {
    for (const ws of clients) if (ws.readyState === 1) ws.send(text)
  }

  function flush() {
    timer = null
    broadcast(JSON.stringify(snapshot()))
  }

  // Mutate through fn; watchers run at once, overlays get a snapshot on the next frame.
  function update(fn) {
    fn(data)
    for (const w of [...watchers]) w()
    if (!timer) timer = setTimeout(flush, FRAME_MS)
  }

  return {
    data,
    snapshot,
    update,
    watch(fn) {
      watchers.add(fn)
      return () => watchers.delete(fn)
    },
    addClient(ws) {
      clients.add(ws)
      ws.send(JSON.stringify(snapshot()))
      ws.on('close', () => clients.delete(ws))
    },
  }
}

// Resolves once pred() holds, re-checked on every state change; rejects when signal aborts.
export function waitUntil(store, pred, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled())
    if (pred()) return resolve()
    const onAbort = () => {
      stop()
      reject(cancelled())
    }
    const unwatch = store.watch(() => {
      if (!pred()) return
      stop()
      resolve()
    })
    const stop = () => {
      unwatch()
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
