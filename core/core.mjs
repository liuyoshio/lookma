// The core: one place that decides. Holds turn, focus, attention, cards, tasks and paused; runs the
// hands pipeline; routes tell, answer, cancel, go ahead, pause, resume and quit; talks to one
// executor through its adapter. Transport is server.mjs's: it hands each socket to an entry point.
import { createLog, logUnknown, cancelled } from './util.mjs'
import { createStore } from './state.mjs'
import { createAppLink } from './app-link.mjs'
import { createGrants } from './grants.mjs'
import { createHands } from './hands.mjs'
import { mintVoiceKey } from './voice-key.mjs'

const MAX_TASKS = 8
// The user counts as busy until this long after their last input; steps that need the front wait.
const IDLE_S = 3

// onQuit: the app asked to quit; the CLI runs its graceful shutdown.
export async function createCore(config, { log = createLog(), createExecutor, onQuit = () => {} } = {}) {
  const store = createStore()
  let n = 0
  const nextId = prefix => `${prefix}${++n}`

  // A line for the user, spoken and shown as a caption. display defaults to speech, kind to info.
  function say({ speech = '', display, kind }) {
    const event = { type: 'say', id: nextId('say'), speech, display: display || speech, kind: kind || 'info' }
    store.send(event)
    return event
  }

  // ---------------------------------------------------------------- cards

  const waiters = new Map() // core card id -> answer(allow)

  function removeCard(id) {
    store.update(s => (s.cards = s.cards.filter(c => c.id !== id)))
  }

  function addCard(card) {
    store.update(s => s.cards.push({ detail: '', ...card, createdAt: Date.now() }))
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
        signal?.removeEventListener('abort', onAbort)
        resolve(allow)
      })
      signal?.addEventListener('abort', onAbort, { once: true })
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
    store.update(s => (s.turn = { id: nextId('turn'), sent, status: '', phase: 'working', startedAt: Date.now(), endedAt: null }))
  }

  function endTurn(phase) {
    store.update(s => {
      if (s.turn?.phase !== 'working') return
      s.turn.phase = phase
      s.turn.endedAt = Date.now()
    })
  }

  function upsertTask(e) {
    store.update(s => {
      let t = s.tasks.find(x => x.id === e.id)
      if (!t) {
        t = { id: e.id, title: '', status: 'running', action: '', startedAt: Date.now(), endedAt: null }
        s.tasks.push(t)
      }
      for (const k of ['title', 'status', 'action']) if (e[k]) t[k] = e[k]
      if (t.status !== 'running' && !t.endedAt) t.endedAt = Date.now()
      while (s.tasks.length > MAX_TASKS) {
        const i = s.tasks.findIndex(x => x.status !== 'running')
        s.tasks.splice(i < 0 ? 0 : i, 1)
      }
    })
    if (e.status && e.status !== 'running' && e.result?.speech) {
      const { speech, display } = e.result
      store.send({ type: 'report', id: nextId('report'), taskId: e.id, speech, display: display || speech })
      log('report', e.id, display || speech)
    }
  }

  // ---------------------------------------------------------------- executor
  //
  // The contract (docs/protocol.md): core/executors/<name>/index.mjs exports
  //   create({ emit, hands(tool, args), config, log })
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

  const factory = createExecutor || (await import(`./executors/${config.executor}/index.mjs`)).create
  const executor = factory({ emit: onExecutorEvent, hands: hands.run, config, log: createLog(config.executor) })
  store.update(s => (s.executor = { name: config.executor, status: 'starting', detail: '' }))

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
      waiters.get(cardId)?.(!!allow)
      waiters.delete(cardId)
    } else {
      executor.answer(cardId, !!allow)
    }
    return true
  }

  function cancel() {
    log('cancel')
    hands.abort()
    executor.cancel()
    endTurn('cancelled')
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
    if (working()) cancel()
    setPaused(true)
  }

  function resume() {
    if (!store.data.paused) return
    log('resume')
    setPaused(false)
  }

  // ---------------------------------------------------------------- overlay

  const unknownOverlay = logUnknown(log, 'overlay')

  function onOverlayMessage(msg) {
    switch (msg.type) {
      case 'tell':
        try {
          tell(msg.text, msg.source || 'typed')
        } catch (err) {
          say({ speech: err.message }) // why the tell did not go through
        }
        break
      case 'answer':
        answer(msg.cardId, msg.allow, msg.via)
        break
      case 'cancel':
        cancel()
        break
      case 'goAhead':
        hands.goAhead()
        break
      case 'pause':
        pause()
        break
      case 'resume':
        resume()
        break
      case 'log': // the overlay's own log line (voice decisions), shown in this terminal
        log('overlay', String(msg.text || '').slice(0, 500))
        break
      default:
        unknownOverlay(msg.type)
    }
  }

  // ---------------------------------------------------------------- API

  return {
    store,
    tell,
    voiceKey: () => mintVoiceKey(config),

    // The three sockets, each handed over by the server once accepted.
    connectOverlay(ws) {
      store.addClient(ws)
      ws.on('message', raw => {
        try {
          onOverlayMessage(JSON.parse(raw))
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
