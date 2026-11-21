// Small helpers for the core and its adapters: the log line, cancellable waiting, one-line text,
// the error of a bad setting or option.

// A mistake in the user's settings or command line: lookma prints it and exits with status 2.
export function usage(message) {
  return Object.assign(new Error(`${message} (see lookma --help)`), { exitCode: 2 })
}

// log(...args): one line on stdout, "HH:MM:SS.mmm prefix text"; non-strings are written as JSON.
export function createLog(prefix = 'core') {
  return (...args) => {
    const d = new Date()
    const t = `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`
    const text = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    process.stdout.write(`${t} ${prefix} ${text}\n`)
  }
}

// unknown(type): logs a message type nobody handles, once per type. A peer that speaks a newer
// protocol, or a second adapter with a typo, is noticed without flooding the log.
export function logUnknown(log, from) {
  const seen = new Set()
  return type => {
    if (seen.has(type)) return
    seen.add(type)
    log(`unknown ${from} message type ${JSON.stringify(type)}, ignored`)
  }
}

// The error of every step the user cancelled; its message reaches the executor as is.
export function cancelled() {
  return new Error('Cancelled by the user.')
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled())
    const onAbort = () => {
      clearTimeout(t)
      reject(cancelled())
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Whitespace folded to single spaces, cut to n characters with an ellipsis.
export function clip(s, n = 60) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}
