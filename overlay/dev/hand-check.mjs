#!/usr/bin/env node
// The hand gestures' page side in Node, with fakes for the browser: the camera's lifecycle
// (overlay/hand/camera.js) against a fake getUserMedia, video and worker; pack() (the bridge's
// hand); and the assets the page loads: the model is the pinned one, and the installed
// @mediapipe/tasks-vision is exactly 0.10.35 with no Google endpoint in what the page loads (the
// 1.x line adds a usage-metrics logger, so a silent upgrade must fail here). No camera, no network.
// overlay/dev/check-hands.mjs runs the real tracker in headless Chrome.
//
//   node overlay/dev/hand-check.mjs

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCamera } from '../hand/camera.js'
import { pack } from '../hand/pack.js'
import { TASKS_VISION } from '../../core/server.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let failed = 0
function check(ok, what, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${ok || detail === undefined ? '' : `\n  ${JSON.stringify(detail)}`}`)
  if (!ok) failed++
}
const settle = () => new Promise(r => setTimeout(r, 0))

// ------------------------------------------------------------ the camera's lifecycle

class FakeTrack extends EventTarget {
  readyState = 'live'
  stop() { this.readyState = 'ended' }
}

/** A camera with fakes all round. getUserMedia resolves only when the test says (grant()). */
function rig() {
  const r = { states: [], frames: [], pending: [], streams: [], workers: 0, logs: [] }
  globalThis.createImageBitmap = async () => ({ width: 1280, height: 720 })
  r.video = { srcObject: null, requestVideoFrameCallback(cb) { this.next = cb } }
  r.worker = Object.assign(new EventTarget(), { sent: [], terminated: 0, postMessage(msg) { this.sent.push(msg) }, terminate() { this.terminated++ } })
  r.camera = createCamera({
    getUserMedia: () => new Promise((resolve, reject) => r.pending.push({ resolve, reject })),
    video: r.video,
    startWorker: () => { r.workers++; return r.worker },
    onFrame: f => r.frames.push(f),
    onState: s => r.states.push(s),
    log: msg => r.logs.push(msg),
  })
  /** Resolve the oldest pending getUserMedia with a new one-track stream. */
  r.grant = async () => {
    const track = new FakeTrack()
    r.streams.push(track)
    r.pending.shift().resolve({ getTracks: () => [track] })
    await settle()
    return track
  }
  /** One camera frame through the pump, and the worker's answer to it. */
  r.frame = async (now, hand = null) => {
    r.video.next?.(now)
    await settle()
    const msg = r.worker.sent.at(-1)
    if (!msg || msg.answered) return
    msg.answered = true
    r.worker.dispatchEvent(Object.assign(new Event('message'), { data: { gen: msg.gen, t: msg.now / 1000, aspect: 16 / 9, hand, ms: 15 } }))
  }
  return r
}

{
  const r = rig()
  r.camera(true)
  r.camera(false)
  const track = await r.grant()
  check(track.readyState === 'ended' && r.video.srcObject === null, 'off while getUserMedia is pending: the stream is stopped the moment it resolves')
  await r.frame(100)
  check(r.frames.length === 0 && r.worker.sent.length === 0 && r.states.join() === '', 'off while pending: no frame pumped, and nothing reported (it never went on)', r.states)
}

{
  const r = rig()
  r.camera(true)
  const a = await r.grant()
  check(r.video.srcObject !== null && r.states.join() === '', 'on: the stream plays in the video; not "on" before a frame came back')
  await r.frame(100)
  await r.frame(133)
  check(r.frames.length === 2 && r.frames[1].t === 0.133 && r.states.join() === 'on', 'on: each processed frame goes out, and the page reports on once frames flow', r.states)
  r.video.next(166) // a frame comes while the tracker is busy with the previous one
  r.video.next(200)
  await settle()
  check(r.worker.sent.length === 3, 'one frame in flight: frames that come while the tracker is busy are skipped', r.worker.sent.length)
  r.camera(false)
  r.worker.dispatchEvent(Object.assign(new Event('message'), { data: { gen: r.worker.sent[2].gen, t: 0.166, aspect: 16 / 9, hand: null, ms: 15 } }))
  check(a.readyState === 'ended' && r.video.srcObject === null && r.states.join() === 'on,off' && r.frames.length === 2,
    'off: every track stopped, reported off, and the frame in flight across the stop is dropped', { states: r.states, frames: r.frames.length })
  r.camera(true)
  const b = await r.grant()
  await r.frame(300)
  check(b.readyState === 'live' && r.frames.length === 3 && r.states.join() === 'on,off,on' && r.workers === 1, 'on again: a new stream, frames again, the same worker')
  r.camera(true)
  check(r.pending.length === 0, 'on while on: nothing new')
}

{
  const r = rig()
  r.camera(true)
  const track = await r.grant()
  await r.frame(100)
  track.dispatchEvent(new Event('ended')) // unplugged, or access revoked
  check(r.states.join() === 'on,failed' && r.video.srcObject === null && r.logs.some(l => l.startsWith('camera failed')), 'a track that ends by itself: reported failed, and logged', r.states)
  r.camera(true)
  await r.grant()
  await r.frame(200)
  check(r.states.join() === 'on,failed,on', 'after a failure, on starts afresh', r.states)
}

{
  const r = rig()
  r.camera(true)
  r.pending.shift().reject(new Error('Permission denied'))
  await settle()
  check(r.states.join() === 'failed' && r.logs.at(-1) === 'camera failed: Permission denied', 'getUserMedia refused: reported failed, with the reason in the log', r.logs)
}

{
  const r = rig()
  r.camera(true)
  await r.grant()
  r.video.next(100)
  await settle()
  r.worker.dispatchEvent(Object.assign(new Event('message'), { data: { gen: r.worker.sent[0].gen, error: 'model did not load' } }))
  check(r.states.join() === 'failed' && r.streams[0].readyState === 'ended', 'the tracker fails: the camera stops and the page reports failed', r.states)
}

{
  const r = rig()
  r.camera(true)
  await r.grant()
  globalThis.createImageBitmap = async () => { throw new Error('the frame is not ready') }
  await r.frame(100)
  check(r.states.join() === 'failed' && r.logs.at(-1) === 'camera failed: the frame is not ready' && r.streams[0].readyState === 'ended',
    'a frame that cannot be copied: the camera stops, reported failed and logged', { states: r.states, logs: r.logs })
  globalThis.createImageBitmap = async () => ({ width: 1280, height: 720 })
  r.camera(true)
  await r.grant()
  await r.frame(200)
  check(r.states.join() === 'failed,on' && r.frames.length === 1, '...and on again pumps frames (nothing left busy)', r.states)
}

{
  const r = rig()
  r.camera(true)
  await r.grant()
  let copied
  globalThis.createImageBitmap = () => new Promise(resolve => { copied = resolve })
  r.video.next(100)
  await settle()
  r.worker.dispatchEvent(Object.assign(new Event('error'), { message: 'abort' })) // uncaught in the worker
  const bitmap = { closed: false, close() { this.closed = true } }
  copied(bitmap)
  await settle()
  check(r.states.join() === 'failed' && r.worker.terminated === 1 && r.worker.sent.length === 0 && bitmap.closed,
    'the worker errors: it is stopped, and a frame copied meanwhile is dropped', { states: r.states, terminated: r.worker.terminated })
  globalThis.createImageBitmap = async () => ({ width: 1280, height: 720 })
  r.camera(true)
  check(r.workers === 2, '...and on again starts a new worker', r.workers)
}

// ------------------------------------------------------------ pack

{
  const landmarks = Array.from({ length: 21 }, (_, i) => ({ x: i / 40, y: 0.5 + i / 100, z: -0.1 }))
  const p = pack(landmarks)
  check(p.length === 42 && p.every(Number.isFinite), 'pack: 42 finite numbers')
  check(p[0] === 1 && p[1] === 0.5 && Math.abs(p[26] - (1 - 13 / 40)) < 1e-12 && p[27] === 0.63, 'pack: x mirrored (1 - x), y as it is, in landmark order', p.slice(0, 4))
  check(pack(undefined) === null, 'pack: no hand is null')
}

// ------------------------------------------------------------ assets

{
  const model = fs.readFileSync(path.join(ROOT, 'overlay/hand/hand_landmarker.task'))
  check(crypto.createHash('sha256').update(model).digest('hex') === 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1',
    'the model is the pinned hand_landmarker.task (float16, version 1)')
  const pkg = JSON.parse(fs.readFileSync(path.join(TASKS_VISION, 'package.json'), 'utf8'))
  const ours = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  check(pkg.version === '0.10.35' && ours.dependencies['@mediapipe/tasks-vision'] === '0.10.35', 'tasks-vision is exactly 0.10.35, pinned without a range', pkg.version)
  // The bundle names protobuf types as type.googleapis.com/...; those are names, not addresses.
  const endpoint = /https?:\/\/[^\s"'`]*googleapis\.com|odml\.pa\./
  const loaded = ['vision_bundle.mjs', 'wasm/vision_wasm_module_internal.js']
  const calling = loaded.filter(f => endpoint.test(fs.readFileSync(path.join(TASKS_VISION, f), 'utf8')))
  check(calling.length === 0, 'the bundle and wasm loader the page loads name no Google endpoint (no usage metrics)', calling)
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall hand checks passed')
process.exit(failed ? 1 : 0)
