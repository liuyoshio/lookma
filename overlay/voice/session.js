// The voice session: the connection to the voice service and nothing said on it. The service is
// the provider the core names in its grant (POST /api/voice/grant); this module imports that
// provider's page half, /voices/<provider>/page.js, and knows nothing else about it
// (voice/contract.js is the contract). What is the same for every provider is here:
//   - run(true): one connection at a time, with the microphone the provider asks for (macOS shows
//     its mic indicator). A connection that closes or fails by itself is reconnected with
//     backoff; the microphone stays open across reconnects and renewals.
//   - Renewed while idle (isIdle) once the grant's renewAfter has passed, the next grant minted
//     ahead and used only while it may still start a connection (startBy).
//   - run(false), paused: no connection and no microphone. Off for good (?voice=0, or the core has
//     no voice): neither, ever.
// One stale-session guard: guard() returns live(), true while the session current at the call
// is still the session. connect() takes it once and checks it after every await and in every
// callback the provider makes; the caller uses the same guard for anything it started on a session.

const MIC = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
const CONNECT_MS = 15000       // a connection not up this long is given up and tried again (not counting the microphone permission dialog)
const RENEW_IDLE_MS = 10000    // once renewal is due, how often to look for an idle moment
const GRANT_AHEAD_MS = 60000   // the renewal's grant is minted this long before it
const GRANT_MARGIN_MS = 15000  // a grant minted ahead is used only if it may start a connection this long from now
const RETRY_MS = [1000, 2000, 5000, 15000, 30000, 60000] // reconnecting, after each failure in a row
const STABLE_MS = 60000        // a session that lasted this long resets the backoff

/**
 * @param {object} o
 * @param {boolean} o.enabled                    false: off for good (?voice=0)
 * @param {(event: object) => void} o.onEvent    each voice event of the live session (voice/contract.js)
 * @param {(status: string, how: { lost: boolean }) => void} o.onChange
 *        every status change; lost: a live session ended by itself (not pause, renewal or off)
 * @param {() => boolean} o.isIdle               nothing going on: the session may be swapped now
 * @param {(msg: string) => void} o.log
 */
export function createSession({ enabled, onEvent, onChange, isIdle, log }) {
  let s = null           // the session: { abort, conn, ready, openedAt, timer, mic }
  let mic = null         // the microphone (a promise of its stream), open while wanted
  let off = !enabled     // for good: ?voice=0, or the core has no voice (LOOKMA_VOICE=off, no key)
  let wanted = false     // until the core's first snapshot says otherwise
  let failing = false    // the last connect failed; another is coming
  let fails = 0, retryTimer = 0
  let nextGrant = null   // a grant minted ahead of a renewal (a promise)
  const current = () => off ? 'off' : !wanted ? 'paused' : failing ? 'failing' : s?.ready ? 'live' : 'connecting'
  let status = current()

  function changed(lost = false) {
    const next = current()
    if (next === status) return
    status = next
    onChange(status, { lost })
  }

  function guard() {
    const me = s
    return () => me !== null && me === s
  }

  /** Paused (false) closes everything: no session, no microphone. */
  function run(next) {
    if (next === wanted) return
    wanted = next
    if (wanted) {
      fails = 0
      connect()
    } else {
      clearTimeout(retryTimer)
      nextGrant = null
      if (s) log('voice: paused; session closed, microphone off')
      close()
      closeMic()
    }
    changed()
  }

  /** One effect (voice/contract.js) on the live connection; dropped while there is none. */
  function send(effect) {
    if (s?.ready) s.conn.send(effect)
  }

  async function connect(why = '') {
    if (s || off || !wanted) return
    clearTimeout(retryTimer)
    const me = s = { abort: new AbortController(), conn: null, ready: false, openedAt: 0, timer: 0, mic: null }
    const live = guard()
    const deadline = () => {
      clearTimeout(me.timer)
      me.timer = setTimeout(() => lost('not up in time'), CONNECT_MS)
    }
    try {
      const grant = await takeGrant() // first: a core with no voice must not open the microphone
      if (!live()) return
      const provider = await import(`/voices/${grant.provider}/page.js`)
      if (!live()) return
      deadline()
      const io = {
        signal: me.abort.signal,
        // The deadline waits while the microphone permission dialog does.
        async openMic() {
          clearTimeout(me.timer)
          const stream = await (me.mic = openMic())
          if (!live()) throw new Error('the session ended')
          deadline()
          return stream
        },
        onEvent: ev => { if (live()) onEvent(ev) },
        onClose: why => { if (live()) lost(why) },
        log,
      }
      const conn = await provider.connect(grant, io)
      if (!live()) return
      clearTimeout(me.timer)
      me.conn = conn
      me.ready = true
      me.openedAt = Date.now()
      failing = false
      me.timer = setTimeout(mintAhead, grant.renewAfter - GRANT_AHEAD_MS)
      log(`voice: connected, listening (${grant.label}${why ? `, ${why}` : ''})`)
      changed()
    } catch (err) {
      if (!live()) return
      close()
      if (err.voiceOff) {
        off = true
        closeMic()
        log(`voice off, captions only: ${err.message}`)
      } else {
        failing = true
        log(`voice unavailable, captions only for now: ${err.message}`)
        retryLater()
      }
      changed()
    }
  }

  /** The session closed or failed by itself: reconnect in the background. */
  function lost(why) {
    const wasLive = s.ready
    if (wasLive && Date.now() - s.openedAt >= STABLE_MS) fails = 0
    log(`voice: the session closed (${why}); reconnecting`)
    close()
    retryLater()
    changed(wasLive)
  }

  function retryLater() {
    clearTimeout(retryTimer)
    if (off || !wanted) return
    retryTimer = setTimeout(() => connect('reconnected'), RETRY_MS[Math.min(fails++, RETRY_MS.length - 1)])
  }

  // Renewal, on the live session's one timer: the next grant ahead of time, then the swap at the
  // first idle moment.
  function mintAhead() {
    nextGrant = mintGrant()
    nextGrant.catch(() => {})
    s.timer = setTimeout(renew, GRANT_AHEAD_MS)
  }

  function renew() {
    if (!isIdle()) {
      s.timer = setTimeout(renew, RENEW_IDLE_MS)
      return
    }
    log(`voice: renewing the session after ${Math.round((Date.now() - s.openedAt) / 60000)} min`)
    close()
    connect('renewed')
    changed()
  }

  /** No session: its timer, and the connection, live or still coming up. The microphone is kept for the next one. */
  function close() {
    const me = s
    s = null // first: ending the connection must not read as losing it
    if (!me) return
    clearTimeout(me.timer)
    me.abort.abort()
  }

  /** The open microphone, or a new one. One at a time, even while it is still being asked for. */
  function openMic() {
    if (!mic) {
      if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error('this page has no microphone access'))
      const asked = mic = navigator.mediaDevices.getUserMedia(MIC)
      asked.then(stream => {
        stream.getAudioTracks()[0].onended = () => { // unplugged: the next connection opens another
          if (mic === asked) mic = null
          if (s?.mic === asked) lost('the microphone stopped')
        }
      }, () => { if (mic === asked) mic = null })
    }
    return mic
  }

  function closeMic() {
    mic?.then(stream => stream.getTracks().forEach(t => t.stop()), () => {}) // also one still being asked for, once it opens
    mic = null
  }

  async function mintGrant() {
    const res = await fetch('/api/voice/grant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const grant = await res.json().catch(() => ({}))
    // 503: this core has no voice (LOOKMA_VOICE=off, or no API key). Asking again will not help.
    if (res.status === 503) throw Object.assign(new Error(grant.error || 'the core has no voice'), { voiceOff: true })
    if (!res.ok || !grant.provider || !grant.renewAfter) throw new Error(grant.error || `voice grant: HTTP ${res.status}`)
    return grant
  }

  async function takeGrant() {
    const ahead = await nextGrant?.catch(() => null)
    nextGrant = null
    if (ahead && (ahead.startBy ?? Infinity) > Date.now() + GRANT_MARGIN_MS) return ahead
    return mintGrant()
  }

  return {
    run,
    send,
    guard,
    get status() { return status },
  }
}
