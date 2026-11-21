// The page's hand tracker, in a module worker so its cost stays off the page's main thread:
// MediaPipe's HandLandmarker (Google's @mediapipe/tasks-vision, Apache-2.0, served by the core from
// node_modules at /vendor/tasks-vision/; the model is hand_landmarker.task beside this file, see
// NOTICE). camera.js transfers in one camera frame at a time, { gen, bitmap, now }, and gets back
// { gen, t, aspect, hand, ms } (hand packed by pack.js; ms is the detection's time, for the
// ?hands=1 view), or { gen, error } when the tracker cannot load or run. The tracker loads on the
// first frame and stays for the page's life, so a resume is instant and a page with gestures off
// never loads it. Each frame is closed here once read, never kept.
import { FilesetResolver, HandLandmarker } from '/vendor/tasks-vision/vision_bundle.mjs'
import { pack } from './pack.js'

// XNNPACK on wasm SIMD: the backend the 13.9 ms a frame was measured on, deterministic, and free of
// WebKit's GPU delegate trouble. If the ?hands=1 view shows over 25 ms a frame in the app's
// WKWebView, this one constant becomes 'GPU'.
const DELEGATE = 'CPU'

let landmarker = null

async function load() {
  // true: the ES module build of the wasm loader, the one a module worker can import.
  const fileset = await FilesetResolver.forVisionTasks(new URL('/vendor/tasks-vision/wasm', location.origin).href, true)
  // One hand, because the mouse is one hand; in VIDEO mode MediaPipe keeps tracking the hand it
  // has, so a second one coming into view does not take the pointer. Default confidences (0.5).
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '/hand/hand_landmarker.task', delegate: DELEGATE },
    runningMode: 'VIDEO',
    numHands: 1,
  })
}

self.onmessage = async ({ data: { gen, bitmap, now } }) => {
  // Caught to tell the page, which reports the camera failed: a rejection in a worker reaches no one.
  try {
    landmarker ??= await load()
    const start = performance.now()
    const { landmarks } = landmarker.detectForVideo(bitmap, now)
    const ms = performance.now() - start
    postMessage({ gen, t: now / 1000, aspect: bitmap.width / bitmap.height, hand: pack(landmarks[0]), ms })
  } catch (err) {
    postMessage({ gen, error: String(err?.message ?? err) })
  } finally {
    bitmap.close()
  }
}
