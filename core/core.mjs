// The core: one place that decides. Holds turn, focus, attention, cards, tasks, the outbox and
// paused; runs the hands pipeline; answers the overlay's requests (tell, answer, control: stop,
// go ahead, pause) with one ack each, takes its receipts for the outbox, and the app's pause,
// resume and quit; talks to one executor through its adapter, and grants the overlay its voice
// sessions through the voice host (voice/host.mjs). Transport is server.mjs's: it hands each
// socket to an entry point.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLog, logUnknown, cancelled } from './util.mjs'
import { createStore } from './state.mjs'
import { createAppLink } from './app-link.mjs'
import { createGrants } from './grants.mjs'
import { createHands } from './hands.mjs'
import { createOutbox, RECEIPTS } from './outbox.mjs'
import { createVoiceHost } from './voice/host.mjs'

const MAX_TASKS = 8
// The user counts as busy until this long after their last input; steps that need the front wait.
const IDLE_S = 3

// onQuit: the app asked to quit; the CLI runs its graceful shutdown.
export async function createCore(config, { log = createLog(), createExecutor, onQuit = () => {} } = {}) {
  const store = createStore()
  let n = 0
  const nextId = prefix => `${prefix}${++n}`
  const outbox = createOutbox({ store, nextId })
  const voice = createVoiceHost(config, { log })

  // A line for the user, spoken and shown as a caption: an outbox entry. display defaults to
  // speech, kind to info. Said during a turn, it is that turn's (turnId) and counts in turn.said.
  function say({ speech = '', display, kind }) {
    const turn = working() ? store.data.turn : null
    const entry = outbox.post({ kind: kind || 'info', speech, display, turnId: turn?.id ?? null })
    if (turn) store.update(s => (s.turn.said += 1))
    return entry
  }

  // ---------------------------------------------------------------- cards

  const waiters = new Map() // core card id -> answer(allow)

  // Every change of cards goes through here, so the announcements follow: the head card (the one
  // on screen) has an outbox entry, and an entry goes when its card goes, and only then (held: a
  // new voice session is told of the card for as long as it is up). A card is announced only
  // while it is the one on screen.
  function changeCards(fn) {
    store.update(s => (s.cards = fn(s.cards)))
    const { cards } = store.data
    outbox.drop(e => e.cardId && !cards.some(c => c.id === e.cardId))
    const head = cards[0]
    if (head && !store.data.outbox.some(e => e.cardId === head.id)) {
      outbox.post({ kind: 'card', cardId: head.id, turnId: head.turnId, held: true, speech: [head.title, head.detail].filter(Boolean).join('\n') })
    }
  }

  function removeCard(id) {
    changeCards(cards => cards.filter(c => c.id !== id))
  }

  // A card raised during a turn belongs to it (turnId) and goes when that turn is stopped.
  function addCard(card) {
    changeCards(cards => [...cards, { ...card, turnId: working() ? store.data.turn.id : null, createdAt: Date.now() }])
    log('card', { id: card.id, source: card.source, title: card.title })
  }

  // A card the core raises for itself; resolves with the answer.
  function ask({ title, detail }, signal) {
    return new Promise((resolve, reject) => {
      const id = nextId('card')
      const onAbort = () => {
        waiters.delete(id)
        removeCard(id)
        reject(cancelled())
      }
      waiters.set(id, allow => {
        signal.removeEventListener('abort', onAbort)
        resolve(allow)
      })
      signal.addEventListener('abort', onAbort, { once: true })
      addCard({ id, title, detail, source: 'core' })
    })
  }

  // ---------------------------------------------------------------- app, hands

  const app = createAppLink({
    log,
    onChange: () => store.update(s => (s.app = app.info ? { version: app.info.version, permissions: app.info.permissions } : null)),
    onAttention(idle) {
      const next = idle == null || Number.isNaN(idle) ? { busy: false, idle: null } : { busy: idle < IDLE_S, idle: Math.floor(idle) }
      const cur = store.data.attention
      if (cur.busy !== next.busy || cur.idle !== next.idle) store.update(s => (s.attention = next))
    },
    // The menu bar and the hotkey.
    onCommand(type) {
      if (type === 'pause') pause()
      else if (type === 'resume') resume()
      else if (type === 'quit') {
        log('quit, asked by the app')
        onQuit()
      }
    },
  })
  const hands = createHands({ store, app, grants: createGrants(config.appsFile), ask, log })

  // ---------------------------------------------------------------- turn

  const working = () => store.data.turn?.phase === 'working'

  function newTurn(sent) {
    store.update(s => (s.turn = { id: nextId('turn'), sent, status: '', phase: 'working', said: 0, startedAt: Date.now(), endedAt: null }))
  }

  // A turn that ends always leaves something to tell: when the work said nothing, the core says
  // it ended. The count is on the turn, not read back from the outbox, which prunes what was
  // delivered. A stopped turn's untold lines and its cards are moot; cards from outside a turn
  // (startup) stay.
  function endTurn(phase) {
    const turn = store.data.turn
    if (turn?.phase !== 'working') return
    if (phase !== 'cancelled' && !turn.said) say({ speech: phase === 'done' ? 'Done.' : 'That did not work.' })
    store.update(s => {
      s.turn.phase = phase
      s.turn.endedAt = Date.now()
    })
    if (phase === 'cancelled') {
      outbox.drop(e => e.turnId === turn.id && !e.delivered)
      changeCards(cards => cards.filter(c => c.turnId !== turn.id))
    }
  }

  // A finished task's result is a report in the outbox.
  function upsertTask(e) {
    let task
    store.update(s => {
      task = s.tasks.find(x => x.id === e.id)
      if (!task) {
        task = { id: e.id, title: '', status: 'running', action: '', startedAt: Date.now(), endedAt: null }
        s.tasks.push(task)
      }
      for (const k of ['title', 'status', 'action']) if (e[k]) task[k] = e[k]
      if (task.status !== 'running' && !task.endedAt) task.endedAt = Date.now()
      while (s.tasks.length > MAX_TASKS) {
        const i = s.tasks.findIndex(x => x.status !== 'running')
        s.tasks.splice(i < 0 ? 0 : i, 1)
      }
    })
    if (e.status !== 'running' && e.result?.speech) {
      const { speech, display } = e.result
      const entry = outbox.post({ kind: 'report', taskId: e.id, title: task.title, speech, display })
      log('report', e.id, entry.display)
    }
  }

  // ---------------------------------------------------------------- executor
  //
  // The contract (docs/protocol.md): executors/<name>/index.mjs exports
  //   create({ emit, hands(tool, args), config, options, log }), options being its own settings
  //     → { start({ dirs }) → Promise<{ name }>, prompt(text, { steer }), cancel(), answer(id, allow),
  //         stop(), connect?(ws), hook?(body) }
  // connect gets the sockets on /ws/executor, hook the bodies POSTed to /hook; an adapter that
  // needs neither leaves them out. The adapter emits the events handled here.

  const unknownEvent = logUnknown(log, 'executor')

  function onExecutorEvent(e) {
    switch (e.type) {
      case 'status':
        store.update(s => (s.executor = { name: s.executor.name, status: e.status, detail: e.detail || '' }))
        log('executor', e.status, e.detail || '')
        break
      case 'turnStart':
        if (!working()) newTurn('')
        break
      case 'turnEnd':
        endTurn(e.ok === false ? 'failed' : 'done')
        break
      case 'step':
        store.update(s => {
          if (s.turn?.phase === 'working') s.turn.status = e.title
        })
        break
      case 'say': {
        const said = say(e)
        log('say', said.kind, said.display)
        break
      }
      case 'task':
        upsertTask(e)
        break
      case 'approval':
        addCard({ id: e.id, title: e.title, detail: e.detail || '', source: 'executor' })
        break
      case 'approvalGone':
        if (store.data.cards.some(c => c.id === e.id)) {
          removeCard(e.id)
          log('card gone', e.id)
        }
        break
      default:
        unknownEvent(e.type)
    }
  }

  const { name, dir, options } = config.executor
  const factory = createExecutor || (await import(pathToFileURL(path.join(dir, 'index.mjs')).href)).create
  const executor = factory({ emit: onExecutorEvent, hands: hands.run, config, options, log: createLog(name) })
  store.update(s => (s.executor = { name, status: 'starting', detail: '' }))

  // ---------------------------------------------------------------- routing

  function tell(text, source = 'typed') {
    text = String(text ?? '').trim()
    if (!text) throw new Error('empty text')
    if (store.data.paused) throw new Error('Paused. Resume from the menu bar or with ⌃⌥P first.')
    if (store.data.executor.status === 'down') throw new Error('The executor is not running.')
    log('tell', source, text)
    const steer = working()
    if (steer) store.update(s => (s.turn.sent = text))
    else newTurn(text)
    executor.prompt(text, { steer })
    return store.data.turn
  }

  function answer(cardId, allow, via) {
    const card = store.data.cards.find(c => c.id === cardId)
    if (!card) return false
    log('answer', { cardId, allow: !!allow, via })
    removeCard(cardId)
    if (card.source === 'core') {
      waiters.get(cardId)(!!allow)
      waiters.delete(cardId)
    } else {
      executor.answer(cardId, !!allow)
    }
    return true
  }

  // "Stop": false when no turn is working.
  function stop() {
    if (!working()) return false
    log('stop')
    hands.abort()
    executor.cancel()
    endTurn('cancelled')
    return true
  }

  // ---------------------------------------------------------------- pause

  // Paused: the overlay closes the voice session and the hands refuse every step, until resume.
  // Pausing stops a working turn like "stop". Resuming only turns the voice and the hands back on:
  // the stopped work stays stopped until the user asks again.
  function setPaused(paused) {
    store.update(s => (s.paused = paused))
    app.send({ type: 'paused', paused })
  }

  function pause() {
    if (store.data.paused) return
    log('pause')
    stop()
    setPaused(true)
  }

  function resume() {
    if (!store.data.paused) return
    log('resume')
    setPaused(false)
  }

  // ---------------------------------------------------------------- overlay

  const unknownOverlay = logUnknown(log, 'overlay')
  const ok = (extra = {}) => ({ ok: true, ...extra })
  const fail = error => ({ ok: false, error })

  // Each request's handler returns its ack; a throw (a refused tell) is the error ack.
  const REQUESTS = {
    tell: m => {
      const steer = working()
      tell(m.text, m.source)
      return ok({ state: steer ? 'added' : 'started' })
    },
    answer: m => (answer(m.cardId, m.allow, m.via) ? ok() : fail('gone')),
    control: m => (Object.hasOwn(CONTROLS, m.action) ? CONTROLS[m.action]() : fail('unknown_action')),
  }
  const CONTROLS = {
    stop: () => (stop() ? ok() : fail('nothing_running')),
    go_ahead: () => (hands.goAhead() ? ok() : fail('not_waiting')),
    pause: () => (pause(), ok()),
  }

  // Messages without an ack. A malformed one throws: connectOverlay logs it.
  const NOTES = {
    // A receipt for outbox entries; idempotent, it shows in the next snapshot.
    delivered: m => {
      if (!Array.isArray(m.ids) || !RECEIPTS.includes(m.how)) throw new Error(`delivered needs ids and one of ${RECEIPTS}`)
      outbox.deliver(m.ids, m.how)
    },
    log: m => log('overlay', String(m.text || '').slice(0, 500)), // the voice's decisions, in this terminal
  }

  // reply: to the requester only.
  function onOverlayMessage(msg, reply) {
    if (Object.hasOwn(REQUESTS, msg.type)) {
      let ack
      try {
        ack = REQUESTS[msg.type](msg)
      } catch (err) {
        ack = fail(err.message)
      }
      return reply({ type: 'ack', id: msg.id, ...ack })
    }
    if (Object.hasOwn(NOTES, msg.type)) return NOTES[msg.type](msg)
    unknownOverlay(msg.type)
  }

  // ---------------------------------------------------------------- API

  return {
    store,
    tell,
    // Every voice session starts with a grant: trimming here keeps its seed to the last KEEP_MS.
    voiceGrant: () => (outbox.prune(), voice.grant()),

    // The three sockets, each handed over by the server once accepted.
    connectOverlay(ws) {
      store.addClient(ws)
      const reply = body => ws.send(JSON.stringify(body))
      ws.on('message', raw => {
        try {
          onOverlayMessage(JSON.parse(raw), reply)
        } catch (err) {
          log('bad overlay message', err.message)
        }
      })
    },
    connectApp(ws) {
      app.attach(ws)
      app.send({ type: 'paused', paused: store.data.paused })
    },
    connectExecutor(ws) {
      if (executor.connect) executor.connect(ws)
      else ws.close(4004, 'this executor takes no connection')
    },
    hook: body => executor.hook?.(body),

    startExecutor: dirs => executor.start({ dirs }),
    async stop() {
      app.quit()
      await executor.stop()
    },
  }
}
