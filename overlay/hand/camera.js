// The camera for hand gestures, in the overlay page. The app says when it runs
// (window.lookma.camera, checked in main.js); this owns the getUserMedia stream's life and pumps
// its frames to the hand tracker (worker.js), one in flight: a frame that comes while the tracker
// is busy is skipped, never queued, so the hand is always the newest one. Every processed frame,
// hand or none, goes to onFrame; frames stay in the page (the main thread hands each to its own
// worker), and only the packed hand leaves it.
//
// What it reports (onState): 'on' once frames flow, 'off' when told off, 'failed' when the camera,
// a frame's copy or the tracker fails, or the track ends by itself (unplugged, access revoked). A failure turns the
// camera off here; the app decides whether to try again.
//
// The race: a camera(false) can arrive while getUserMedia is still pending. A generation counter
// makes it win: the stream is stopped the moment it resolves, and a frame in flight across a stop
// is dropped, so nothing reaches the app after it said off.

const CONSTRAINTS = { audio: false, video: { width: 1280, height: 720, frameRate: { ideal: 30, max: 30 } } }

/**
 * @param {object} o
 * @param {(c: MediaStreamConstraints) => Promise<MediaStream>} o.getUserMedia
 * @param {HTMLVideoElement} o.video  muted, autoplay and in the DOM (WebKit may not run
 *   requestVideoFrameCallback for a detached video)
 * @param {() => Worker} o.startWorker  worker.js, started on the first camera(true)
 * @param {(f: { t: number, aspect: number, hand: number[] | null, ms: number }) => void} o.onFrame
 * @param {(s: 'off' | 'on' | 'failed') => void} o.onState
 * @param {(msg: string) => void} o.log
 * @returns {(on: boolean) => void} camera
 */
export function createCamera({ getUserMedia, video, startWorker, onFrame, onState, log }) {
  let want = false
  let gen = 0 // bumped by every on, off and failure; a stream or frame of an older one is stale
  let stream = null
  let worker = null
  let busy = false // a frame is with the tracker
  let state = 'off'

  const setState = s => {
    if (s === state) return
    state = s
    onState(s)
  }

  function release() {
    for (const track of stream?.getTracks() ?? []) track.stop()
    stream = null
    video.srcObject = null
  }

  function fail(why) {
    log(`camera failed: ${why}`)
    want = false
    gen++
    release()
    setState('failed')
  }

  function reply({ data }) {
    busy = false
    if (data.gen !== gen) return
    if (data.error) return fail(data.error)
    onFrame(data)
    setState('on')
  }

  async function start(g) {
    if (!worker) {
      worker = startWorker()
      worker.addEventListener('message', reply)
      // A worker that did not load, or an error worker.js did not catch (it reports the ones it
      // does): stop it, tracker and all, and start afresh next time.
      worker.addEventListener('error', e => {
        worker.terminate()
        worker = null
        busy = false
        fail(e.message || 'the hand tracker did not load')
      })
    }
    let s
    try {
      s = await getUserMedia(CONSTRAINTS)
    } catch (err) {
      if (g === gen) fail(err.message)
      return
    }
    if (g !== gen) {
      for (const track of s.getTracks()) track.stop()
      return
    }
    stream = s
    for (const track of s.getTracks()) track.addEventListener('ended', () => { if (stream === s) fail('the camera stopped') })
    video.srcObject = s
    pump(g)
  }

  // requestVideoFrameCallback: once per new camera frame, with `now` (ms, increasing), which is
  // also the tracker's timestamp.
  function pump(g) {
    video.requestVideoFrameCallback(now => {
      if (g !== gen) return
      if (!busy) {
        busy = true
        createImageBitmap(video).then(
          bitmap => {
            // Stopped or failed while the frame was copied: the worker may be gone, so drop it here.
            if (g !== gen) {
              bitmap.close()
              busy = false
              return
            }
            worker.postMessage({ gen: g, bitmap, now }, [bitmap])
          },
          err => {
            busy = false
            if (g === gen) fail(err.message)
          },
        )
      }
      pump(g)
    })
  }

  return function camera(on) {
    if (on === want) return
    want = on
    gen++
    if (on) start(gen)
    else {
      release()
      setState('off')
    }
  }
}
