// What the voice knows about each user turn, by item id, for approvals (judgeAnswer in
// consent.js) and captions: when its speech started, whether the butler was audible then and
// what that reply was saying, and its transcript. Also what the butler said in each reply.
// Fed voice events (voice/contract.js); whether the butler is audible comes from the floor, its
// one owner. Records die with the session (reset), so they need no cap.

/** @param {{ log: (msg: string) => void }} o */
export function createTurns({ log }) {
  let turns = new Map()    // item id -> { startedAt, overButler, butler, text, done, settled, settle }
  let replies = new Map()  // response id -> { text }: what the butler said in it
  let saying = null        // the record of the reply the butler voiced last

  function turn(id) {
    let t = turns.get(id)
    if (!t) {
      t = { startedAt: 0, overButler: false, butler: null, text: null, done: false }
      t.settled = new Promise(r => { t.settle = r })
      turns.set(id, t)
    }
    return t
  }

  function reply(id) {
    let r = replies.get(id)
    if (!r) replies.set(id, (r = { text: '' }))
    return r
  }

  /** One voice event; butlerAudible: the butler's audio is playing as it arrives. */
  function note(ev, at, butlerAudible) {
    switch (ev.type) {
      case 'turn.started': {
        const t = turn(ev.id)
        t.startedAt = at
        t.overButler = butlerAudible
        t.butler = butlerAudible ? saying : null // what the butler was voicing, as it completes
        break
      }
      case 'turn.committed':
        turn(ev.id).startedAt ||= at // no turn.started seen: as late as possible
        break
      case 'turn.transcript': {
        const t = turn(ev.id)
        t.text = ev.text
        t.done = true
        t.settle(ev.text)
        if (ev.text != null) log(`heard ${JSON.stringify(ev.text)}${t.overButler ? ' (started while the butler was talking)' : ''}`)
        break
      }
      case 'butler.said': {
        const r = saying = reply(ev.response)
        if (!ev.final) r.text += ev.text
        else {
          r.text = ev.text
          log(`butler said ${JSON.stringify(ev.text)}`)
        }
        break
      }
    }
  }

  /** The turn's record for judgeAnswer, its transcript waited for up to waitMs; null: no such turn. */
  async function evidence(id, waitMs) {
    const t = turns.get(id)
    if (!t) return null
    if (!t.done) await Promise.race([t.settled, new Promise(r => setTimeout(r, waitMs))])
    return { startedAt: t.startedAt, overButler: t.overButler, transcript: t.text, butlerSaid: t.butler?.text || '' }
  }

  return {
    note,
    evidence,
    /** The transcript once it is in (null: it failed). */
    text: id => turn(id).settled,
    reset() {
      turns = new Map()
      replies = new Map()
      saying = null
    },
  }
}
