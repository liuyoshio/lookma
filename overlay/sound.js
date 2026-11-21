// The overlay's sound, synthesized with WebAudio so it ships no audio assets:
//   chime()       a soft two-note chime for a new approval card. It tells someone who is not
//                 looking at the screen (on a walk, across the room) that something is waiting.
//   tone(which)   'open' or 'close': one short, quiet note when the microphone opens for the user
//                 (rising) or closes again (falling), so a press of the talk key is heard to land.

let ctx = null

function out(gain) {
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  const g = ctx.createGain()
  g.gain.value = gain
  g.connect(ctx.destination)
  return g
}

export function chime() {
  try {
    const o = out(0.16)
    const t0 = ctx.currentTime + 0.02
    note(659.25, t0, 0.5, o)        // E5
    note(987.77, t0 + 0.13, 0.7, o) // B5
  } catch {
    // No audio device: the card is still on screen.
  }
}

const TONES = { open: [587.33, 880], close: [880, 587.33] } // D5 and A5: up to open, down to close

export function tone(which) {
  try {
    const o = out(0.07)
    const t0 = ctx.currentTime + 0.01
    const [from, to] = TONES[which]
    note(from, t0, 0.09, o)
    note(to, t0 + 0.06, 0.16, o)
  } catch {
    // No audio device: the capsule's glyph still shows it.
  }
}

function note(freq, at, len, o) {
  const osc = ctx.createOscillator()
  const env = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  env.gain.setValueAtTime(0, at)
  env.gain.linearRampToValueAtTime(1, at + 0.012)
  env.gain.exponentialRampToValueAtTime(0.001, at + len)
  osc.connect(env).connect(o)
  osc.start(at)
  osc.stop(at + len + 0.05)
}
