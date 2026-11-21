// The voice's Realtime session: the connection to OpenAI and nothing said on it. One session at
// a time over WebRTC, with a short-lived key from the core (POST /api/voice-key) that already
// carries the butler's instructions, tools and turn detection, and the per-reply parameters
// (responses) the voice asks for replies with (core/voice-key.mjs).
//   - run(true): one session, with the microphone attached (macOS shows its mic indicator). A
//     session that closes or fails by itself is reconnected with backoff; the microphone stays
//     open across reconnects and renewals.
//   - Renewed while idle (isIdle) before the Realtime limit of 60 minutes, its key minted ahead.
//   - run(false), paused: no session and no microphone. Off for good (?voice=0, or the core has
//     no voice): neither, ever.
// One stale-session guard: guard() returns live(), true while the session current at the call
// is still the session. connect() takes it once and checks it after every await and in every
// callback; the caller uses the same guard for anything it started on a session.

const REALTIME_URL = 'https://api.openai.com/v1/realtime/calls'
const MIC = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
const CONNECT_MS = 15000       // a session not up this long after the microphone opened is given up and tried again
const RENEW_MS = 50 * 60000    // a new session, while idle, before the Realtime limit of 60 min
const RENEW_IDLE_MS = 10000    // once renewal is due, how often to look for an idle moment
const KEY_AHEAD_MS = 60000     // the renewal's key is minted this long before it
const KEY_MARGIN_MS = 15000    // a key minted ahead is used only with this long left
const RETRY_MS = [1000, 2000, 5000, 15000, 30000, 60000] // reconnecting, after each failure in a row
const STABLE_MS = 60000        // a session that lasted this long resets the backoff

/**
 * @param {object} o
 * @param {boolean} o.enabled                    false: off for good (?voice=0)
 * @param {(event: object) => void} o.onEvent    each Realtime server event of the live session
 * @param {(status: string, how: { lost: boolean }) => void} o.onChange
 *        every status change; lost: a live session ended by itself (not pause, renewal or off)
 * @param {() => boolean} o.isIdle               nothing going on: the session may be swapped now
 * @param {(msg: string) => void} o.log
 */
export function createSession({ enabled, onEvent, onChange, isIdle, log }) {
  let s = null           // the session: { pc, dc, audio, ready, openedAt, timer, responses }
  let mic = null         // the microphone (a promise of its stream), open while wanted
  let off = !enabled     // for good: ?voice=0, or the core has no voice (LOOKMA_NO_VOICE, no key)
  let wanted = false     // until the core's first snapshot says otherwise
  let failing = false    // the last connect failed; another is coming
  let fails = 0, retryTimer = 0
  let nextKey = null     // a key minted ahead of a renewal (a promise)
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
      nextKey = null
      if (s) log('voice: paused; session closed, microphone off')
      close()
      closeMic()
    }
    changed()
  }

  /** One client event on the live data channel. */
  function send(event) {
    if (s?.dc?.readyState !== 'open') return false
    s.dc.send(JSON.stringify(event))
    return true
  }

  async function connect(why = '') {
    if (s || off || !wanted) return
    clearTimeout(retryTimer)
    const me = s = { pc: null, dc: null, audio: null, ready: false, openedAt: 0, timer: 0, responses: null }
    const live = guard()
    try {
      const key = await takeKey() // first: a core with no voice must not open the microphone
      if (!live()) return
      me.responses = key.responses
      const asked = openMic()
      const stream = await asked
      if (!live()) return
      // Counted from here, not while the microphone permission dialog waits for the user.
      me.timer = setTimeout(() => lost('not up in time'), CONNECT_MS)
      const pc = me.pc = new RTCPeerConnection()
      me.audio = new Audio()
      me.audio.autoplay = true
      pc.ontrack = e => { me.audio.srcObject = e.streams[0] }
      pc.onconnectionstatechange = () => { if (live() && ['failed', 'closed'].includes(pc.connectionState)) lost(`connection ${pc.connectionState}`) }
      const track = stream.getAudioTracks()[0]
      track.onended = () => { // unplugged: open another
        if (mic === asked) mic = null
        if (live()) lost('the microphone stopped')
      }
      pc.addTrack(track, stream)
      const dc = me.dc = pc.createDataChannel('oai-events')
      dc.onopen = () => {
        if (!live()) return
        clearTimeout(me.timer)
        me.ready = true
        me.openedAt = Date.now()
        failing = false
        me.timer = setTimeout(mintAhead, RENEW_MS - KEY_AHEAD_MS)
        log(`voice: connected, listening (${key.model}${why ? `, ${why}` : ''})`)
        changed()
      }
      dc.onclose = () => { if (live()) lost('channel closed') }
      dc.onmessage = e => { if (live()) onEvent(JSON.parse(e.data)) }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const sdp = await fetch(REALTIME_URL, {
        method: 'POST', body: offer.sdp,
        headers: { Authorization: `Bearer ${key.value}`, 'Content-Type': 'application/sdp' },
      })
      if (!sdp.ok) throw new Error(`realtime: HTTP ${sdp.status}`)
      const answer = await sdp.text()
      if (!live()) return
      await pc.setRemoteDescription({ type: 'answer', sdp: answer })
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

  // Renewal, on the live session's one timer: the next key ahead of time, then the swap at the
  // first idle moment.
  function mintAhead() {
    nextKey = mintKey()
    nextKey.catch(() => {})
    s.timer = setTimeout(renew, KEY_AHEAD_MS)
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

  /** No session: the connection, its timer and the butler's voice. The microphone is kept for the next one. */
  function close() {
    const me = s
    s = null // first: closing the connection must not read as losing it
    if (!me) return
    clearTimeout(me.timer)
    me.pc?.close()
    if (me.audio) me.audio.srcObject = null
  }

  /** The open microphone, or a new one. One at a time, even while it is still being asked for. */
  function openMic() {
    if (!mic) {
      if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error('this page has no microphone access'))
      const asked = mic = navigator.mediaDevices.getUserMedia(MIC)
      asked.catch(() => { if (mic === asked) mic = null })
    }
    return mic
  }

  function closeMic() {
    mic?.then(stream => stream.getTracks().forEach(t => t.stop()), () => {}) // also one still being asked for, once it opens
    mic = null
  }

  async function mintKey() {
    const res = await fetch('/api/voice-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const key = await res.json().catch(() => ({}))
    // 503: this core has no voice (LOOKMA_NO_VOICE=1, or no OpenAI key). Asking again will not help.
    if (res.status === 503) throw Object.assign(new Error(key.error || 'the core has no voice'), { voiceOff: true })
    if (!res.ok || !key.value || !key.responses) throw new Error(key.error || `voice key: HTTP ${res.status}`)
    return key
  }

  async function takeKey() {
    const ahead = await nextKey?.catch(() => null)
    nextKey = null
    if (ahead && ahead.expiresAt * 1000 > Date.now() + KEY_MARGIN_MS) return ahead
    return mintKey()
  }

  return {
    run,
    send,
    guard,
    get status() { return status },
    /** The live session's per-reply parameters, by reply kind: { turn, speak }. */
    get responses() { return s?.responses },
  }
}
