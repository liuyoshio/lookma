// The outbox: what the work wants the user told, kept in the core so it outlives a pause, a voice
// failure and a page reload. Each entry is owed an announcement until it gets exactly one receipt
// (spoken, cut or shown); what has none is still owed. Lives in store.data.outbox, oldest first.
// Knows nothing of turns, cards or the executor: the core decides what to post and drop, and
// which entries are held (kept, receipt or not, until it drops them).

export const KEEP_MS = 5 * 60000 // delivered entries stay this long: the context a new voice session is seeded with
export const MAX = 50
export const RECEIPTS = ['spoken', 'cut', 'shown']

/**
 * @param {object} o
 * @param {{ data: { outbox: object[] }, update(fn): void }} o.store
 * @param {(prefix: string) => string} o.nextId
 * @param {() => number} [o.now]
 */
export function createOutbox({ store, nextId, now = Date.now }) {
  // Delivered entries older than KEEP_MS go, then the oldest beyond MAX; held ones stay.
  function trim(s) {
    const t = now()
    const kept = s.outbox.filter(e => e.held || !e.delivered || t - e.at < KEEP_MS)
    let over = kept.length - MAX
    s.outbox = kept.filter(e => e.held || over-- <= 0) // the first `over` not held, the oldest, go
  }

  return {
    /**
     * kind: 'info' | 'question' | 'confirm' | 'report' | 'card'. display defaults to speech.
     * held: kept until dropped, past KEEP_MS and MAX.
     */
    post({ kind, speech, display, turnId = null, held = false, ...about }) {
      const entry = { id: nextId('m'), kind, speech, display: display || speech, ...about, turnId, held, at: now(), delivered: null }
      store.update(s => {
        s.outbox.push(entry)
        trim(s)
      })
      return entry
    },

    /** The first receipt wins; ids no longer in the outbox are ignored. */
    deliver(ids, how) {
      store.update(s => {
        for (const e of s.outbox) if (!e.delivered && ids.includes(e.id)) e.delivered = how
        trim(s)
      })
    },

    /** Trims now, so what is left is the last KEEP_MS: before a new voice session is seeded from it. */
    prune() {
      store.update(trim)
    },

    drop(match) {
      store.update(s => (s.outbox = s.outbox.filter(e => !match(e))))
    },
  }
}
