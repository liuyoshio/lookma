# Protocol (v1)

How the pieces talk, and the two plug-in contracts. The core holds one model: the turn, the focus (the current hands step) and the user's attention, and every step is visible by default. All user-facing text in the product is English. Anything spoken or narrated follows the language the user speaks.

This page is normative. For a walkthrough of adding an agent or a voice, see [Writing an executor](writing-an-executor.md) and [Writing a voice](writing-a-voice.md).

## Processes

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/architecture-dark.svg">
  <img src="images/architecture.svg" width="100%" alt="You talk to the overlay in Lookma.app, which streams your microphone to OpenAI Realtime while it listens. The overlay and the app connect to the core on 127.0.0.1, which prompts Claude Code and runs each hands step through the app.">
</picture>

Three WebSockets meet at the core: the overlay page on `/ws/overlay`, the app on `/ws/app`, and the agent's tools bridge on `/ws/executor`.

- **core** (`core/`) is the only place that decides anything. It serves the overlay page at `/`, WebSockets at `/ws/overlay`, `/ws/app` and `/ws/executor`, and HTTP at `/api/state`, `/api/tell` and `/api/voice/grant`. Beside the overlay it serves the selected voice provider's page half, `/voices/<name>/page.js` (and `/voices/<name>/page/*`), and nothing else of that folder.
- **app** (`app/`) is launched with `open` so macOS permissions belong to it. It connects back to the core, provides primitives, and the menu bar item (pause, resume, type, quit), and makes no decisions.
- **overlay** (`overlay/`) is a page loaded by the app's full-screen, click-through WKWebView. It renders core state and runs the voice session. It also opens in a normal browser for development.
- **executor adapter** (`executors/<name>/`) wraps one agent behind the [executor contract](#executor-contract), and the core's executor host (`core/executor/host.mjs`) is the only code that runs it. `claude` and `codex` ship.
- **voice provider** (`voices/<name>/`) is one voice service behind the [voice provider contract](#voice-provider-contract): its `mint.mjs` runs in the core, under the voice host (`core/voice/host.mjs`), and its `page.js` in the overlay, under the voice session. `openai` ships.

Port: `LOOKMA_PORT`, default 8790. During development use another port (the dev scripts default to 8791), because your everyday Lookma may still hold 8790.

Local-only:
- listen on 127.0.0.1 only;
- POST bodies must be `application/json`;
- WebSocket upgrades are accepted only when `Origin` is absent (native clients) or is the core's own origin. Without this check, any web page could drive the computer.

Nothing else.

## Coordinates

Everything uses **screen points on the main display, origin at top-left**: AX frames, rects in state and the overlay's CSS pixels. The overlay covers the main display 1:1, so a rect from the core is a CSS rect.

Screenshots returned to the executor are downscaled. A point the executor gives in screenshot pixels is mapped back by the app using the `shot` it returned. The executor never sees screen points.

## Core → overlay

On connect, and on every change (coalesced to one per frame), the core sends a full snapshot:

```js
{ type: 'state',
  executor: { name: 'claude', status: 'starting' | 'ready' | 'busy' | 'down', detail },
  turn: null | { id, sent, status, phase: 'working' | 'done' | 'failed' | 'cancelled', said, startedAt, endedAt },
  focus: null | { id, label, action, app, rect, point, phase: 'moving' | 'waiting' | 'acting' | 'done' | 'failed', background, at },
  attention: { busy, idle },
  app: null | { version, permissions },          // the app's hello; null while it is not connected
  cards: [ { id, title, detail, source: 'executor' | 'core', turnId, createdAt } ],
  tasks: [ { id, title, status: 'running' | 'done' | 'failed', action, startedAt, endedAt } ],
  outbox: [ { id, kind: 'info' | 'question' | 'confirm' | 'report' | 'card', speech, display,
              title?, taskId?, cardId?, turnId, held, at, delivered: null | 'spoken' | 'cut' | 'shown' } ],
  paused: false | true }
```

- `turn.sent` is the exact text handed to the executor (the capsule's second row).
- `turn.status` is the latest one-line step description (the third row). Steps that have no screen target, such as reading a file or running a command, only update this line.
- `focus` is the current or last hands step:
  - `rect` is the target's frame and `point` is where the ghost cursor goes;
  - `background: true` means it is acting without bringing the target forward, because the user is busy;
  - `phase: 'waiting'` means it needs the front and is waiting for the user to stop. The overlay shows the edge hint.
- `cards` are pending approvals, oldest first. `source: 'core'` means the core asks for itself, e.g. the first time the hands touch an app. `turnId` is the turn that was working when the card was raised (null outside a turn). A stop withdraws every open card.
- `tasks` are background work with no screen presence. It is shown yellow.
- `turn.said` counts the lines the work said during the turn (see the outbox below).
- `outbox` is what the user is owed by voice, oldest first. See The outbox below.
- `paused` is true while the user has paused. See Pause and quit below.

**The outbox** (`core/outbox.mjs`). Everything the work wants the user told is an entry, kept in the core so it outlives a pause, a voice failure and a page reload:

- `info`, `question`, `confirm`: the executor's `say` (`kind` defaults to `info`, `display` to `speech`). Said while a turn is working, the entry carries that `turnId` and the turn's `said` goes up by one.
- `report`: a background task finished with a result (`taskId`, the task's `title`).
- `card`: the announcement of the card on screen, `cardId`, with the card's title and detail as its text. Only the head of `cards` has one; it is posted when that card becomes the head and removed when the card goes, delivered or not, and only then (`held: true`).
- A turn always ends with something to tell: one that ends `done` or `failed` with `said` 0 gets one entry from the core, "Done." or "That did not work." (the voice says it in the user's language). A stopped turn (`cancelled`) drops its undelivered entries, along with its cards.

Each entry gets exactly one receipt (`delivered`, first one wins): `spoken` (the user heard it), `cut` (the user talked over it), or `shown` (left on screen). An entry with no receipt is still owed. Delivered entries are kept for 5 minutes (the context a new voice session is given; the core trims the list whenever a voice grant is minted, so that holds however quiet it has been), and the list keeps at most the newest 50. A held entry (a card's) is kept, receipt or not, until its card goes.

The overlay reads the outbox from every snapshot. Its captions come from it (the newest entry that is not a card or report is the said line; report entries caption their task), and the voice announces what is owed when nobody is talking and sends the receipts. With no voice, everything owed gets `shown`. The overlay plays a soft chime when a new card appears.

The answer to an overlay request (see Overlay → core) goes to the requesting socket only:

```js
{ type: 'ack', id, ok: true, ... } | { type: 'ack', id, ok: false, error }
```

**Voice session** (`overlay/voice.js`, `overlay/voice/`). Always listening, full duplex: while voice is on and not paused, one warm session is connected with the microphone attached.

- **Warm session.** One connection of the selected voice provider (see Voice provider contract), with the microphone. macOS shows its mic indicator. The voice speaks on the same session, and it keeps the conversation across turns.
- **Turns** come from the provider, which owns turn detection; the service never replies by itself. The audio setup (`LOOKMA_AUDIO`) sets the rest: in a `room` (the default) speech over the voice does not cut it off; with a `headset` it does (barge-in).
- **The floor** (`overlay/voice/floor.js`) decides who speaks: one reply at a time, and only once the user's turn is committed. What the voice owes is user turns (a reply) and outbox entries (an announcement). Every committed turn gets a `create` at once; the voice itself decides whether it was meant for it, and a reply that is a `pass` call, or has nothing in it, drops that turn from the conversation. A turn is shown as heard when the reply's first output that is not a `pass` arrives.
- **Replies.** A reply to new turns (`create` of kind `turn`) may call tools; every other reply (`speak`: an announcement, or a tool result to say) only speaks. A tool result the user has not heard (an error, `status`, or any result after a reply that said nothing) gets a `speak` reply.
- **Announcements.** What the outbox owes is announced once nobody has talked for 0.7 s, after any user turn, all of it in one reply, in outbox order, as items marked as updates (`tell`). When its audio has played, the entries get `spoken`. Talked over by a user who then gets an answer (the reply to their turn is not a `pass`), they get `cut`. A reply that fails (cancelled by noise, rejected, cut off by a dropped session, or with no news for 30 s) is tried again; a reply the user's voice cancelled counts as failed only once the reply to their turn turns out not to be an answer, so a request spoken in pieces is never lost. After two failures an entry gets `shown`, and a request the voice never acted on shows "say that again". A receipt is sent again while a snapshot still shows the entry owed, so one lost with the core link heals itself.
- **Turn records.** Each turn is recorded when its speech starts: its id, `startedAt` (when the event arrived) and `overButler` (whether the voice's audio was playing then). Its transcript is matched by that id when it arrives.
- **Health.** The session reconnects in the background when it closes or fails, with backoff. While idle (nothing heard, said or owed for 10 s), it is renewed after the grant's `renewAfter`, with its grant minted ahead.
- **Context.** Every new session is first told the outbox entries that already have a receipt (the last 5 minutes, and the card on screen), marked "from earlier", with no reply. So "yes, I approve" still answers a card announced on the old session, also after a page reload.
- **Paused:** no session at all, and no microphone; what is owed stays in the outbox and is announced after resume. **Voice off** (`LOOKMA_VOICE=off`, or a required setting such as `OPENAI_API_KEY` unset): no session, captions only, and everything owed gets `shown`. A page opened with `?voice=0` is a spectator: no session, captions only, and no receipts, so it never settles what the app's voice still owes.

**Voice approval** (`overlay/consent.js`): a spoken answer (approve or decline) counts only when all of these hold:
- it was spoken at least 1 s after the card rendered (the turn's `startedAt`);
- it cannot be the assistant's own voice: said over the voice (`overButler`), it counts unless the voice itself was saying an approval phrase;
- its own transcript, matched by the turn's id and awaited up to 3 s, is explicit: "yes, I approve", "approved, do it", or a clear "no", "don't". A lone "approve" or "go ahead" is not enough, and any hesitation fails. "Cancel" is a stop, never a decline.
- the core accepts it: the butler's `answer` sends an `answer` request, and the card shows Approved (or Declined) only after the ack says `ok`.

Otherwise the voice asks again. The card's hint reads: Say “yes, I approve”. Clicking Approve always works.

## Overlay → core

Requests carry an `id` (`r1`, `r2`, … per page) and get exactly one `ack`, to the requester only. The core alone decides whether a request applies; the page never does.

| Request | Ack |
|---|---|
| `{ type: 'tell', id, text, source: 'voice' \| 'typed' }`: a new instruction; the core prompts, or steers if a turn is running | `{ ok: true, state: 'started' \| 'added' }`, or `{ ok: false, error }` (empty text, paused, the executor not running) |
| `{ type: 'answer', id, cardId, allow, via: 'voice' \| 'click' }` | `{ ok: true }`, or `{ ok: false, error: 'gone' }` |
| `{ type: 'control', id, action: 'stop' \| 'go_ahead' \| 'pause' }` | `{ ok: true }`, or `{ ok: false, error: 'nothing_running' \| 'not_waiting' \| 'unknown_action' }` |

- `stop` stops the working turn: the executor host interrupts the agent behind its stop gate (see Executor contract), the waiting hands step fails, queued steps drop and every open card is withdrawn. `go_ahead` lets a step waiting with `focus.phase: 'waiting'` act now. `pause` is idempotent (see Pause and quit).
- The page's `request` resolves `{ ok: false, error: 'not connected' }` when the socket is closed or closes before the ack, and `{ ok: false, error: 'no answer' }` after 3 s. It never resends.

Without an ack:

```js
{ type: 'delivered', ids, how: 'spoken' | 'cut' | 'shown' }   // receipts for outbox entries; idempotent, seen in the next snapshot
{ type: 'log', text }                                // a line for the core's log (the voice's decisions)
```

Spoken "stop", "go ahead" and "pause" are the voice's: it calls its `control` tool. Every tool that reaches the core (`do` sends `tell`, `answer`, `control`) gets the ack as its output, verbatim, so the voice says what really happened. A typed line of just "stop", "go ahead" or "pause" is sent as that `control` request whatever the state (`commandFor` in `overlay/consent.js`); a failed typed request shows its error on screen.

`POST /api/voice/grant` → `{ provider, credential?, startBy?, renewAfter, label, session? }`, one grant per voice session, minted by the selected provider (see Voice provider contract). A 503 means no voice, for good (`LOOKMA_VOICE=off`, or a required setting such as `OPENAI_API_KEY` unset): the page stops asking. Any other error (a 502 when the provider's service refused) means try again later.

**Overlay ↔ app (local, not the core).** The page posts `{ hitRects: [rect…], typing, voice, listening, speaking }` to `window.webkit.messageHandlers.lookma` whenever one of them changes:

- `hitRects`: the app makes the window accept mouse events only while the pointer is inside one of those rects (the card), and click-through everywhere else.
- `typing`: the app gives the window the keyboard only while the typed input is open, and hands it back when the page closes it.
- `voice`: voice works (voice on, not paused, the session not failing).
- `listening`: the user is speaking (the provider's `turn.started`, and not yet `turn.stopped`). The app shows it in the menu bar.
- `speaking`: the voice is answering (thinking or talking).

The app calls the page with `evaluateJavaScript`; it returns nothing:

```js
window.lookma.toggleTyping(true)                      // "Type a Request…"
```

## App ⇄ core (`/ws/app`)

App → core:

```js
{ type: 'hello', version, permissions: { accessibility, screen, microphone }, screen: { w, h, scale } }
{ type: 'attention', idle }                    // seconds since the last user key or mouse event; every 0.5 s
{ type: 'pause' } | { type: 'resume' }         // the menu bar item, or the hotkey ⌃⌥P
{ type: 'quit' }                               // Quit in the menu bar
```

Core → app, besides requests:

```js
{ type: 'paused', paused }                     // on connect, and on every change
{ type: 'quit' }                               // the core is stopping; the app quits with it
```

## Pause and quit

The core is the only place where `paused` changes; the overlay and the app only ask.

- **Pause** (`control` `pause` from the overlay, or `pause` from the app). If a turn is working, the core stops it exactly as `stop` does. Then `paused` becomes true. While paused:
  - the overlay closes the voice session entirely (the connection closed, the microphone stopped), so nothing is heard, sent or billed, and the voice stops talking; what is owed stays in the outbox;
  - the capsule shows "Paused" and how to resume: the menu bar or ⌃⌥P;
  - marks clear, and the hands refuse every step;
  - `tell` is refused with the same hint (its ack's `error`; `POST /api/tell` answers 409).
- **Resume** (`resume` from the app). `paused` becomes false. The overlay reconnects the warm voice session, with the microphone. Nothing else starts: a turn the pause stopped stays stopped until the user asks again.
- **Quit** (`quit` from the app). The core runs its usual shutdown, the same as Ctrl-C: `{ type: 'quit' }` to the app, the executor's `close`, the server closes and the process exits, so the `lookma` command ends. If the core is not reachable, or does not answer within 5 s, the app quits by itself.

The app's menu bar item, the seal, shows the state the core and the page last sent: its ring filled while the user speaks, a pause sign while paused, and dimmed while not connected. Its menu has Pause or Resume (⌃⌥P), Type a Request…, and Quit.

- ⌃⌥P is a Carbon hot key, which needs no extra permission; when another app holds it, the app logs that and the menu still works.

Core → app requests, and the app's replies:

```js
{ type: 'req', id, op, args }  →  { type: 'res', id, ok: true, result } | { type: 'res', id, ok: false, error }
```

| op | args | result |
|---|---|---|
| `see` | `{ app, screenshot }` (`app` null: frontmost) | `{ app, frontmost, window: { title, rect }, elements: [{ id, role, text, states, rect }], cut, unlabeled, shot?, image? }` |
| `resolve` | `{ element } \| { point:[x,y] } \| { dock: appName } \| { app }` | `{ app, rect, point, frontmost, pressable }` |
| `front` | `{ app }` | `{}` (best effort: the ops that post input check the front themselves) |
| `press` | `{ element }` | AX press: `{}` |
| `click` | `{ point }` (screen points) | `{}` |
| `type` | `{ text }` | `{}` |
| `key` | `{ combo }` e.g. `"cmd+t"` | `{}` |
| `scroll` | `{ point, direction, pages }` | `{ pixels, position, moved }` |
| `open` | `{ url } \| { path }` | `{ app }` |

An act op (`press`, `click`, `type`, `key`, `scroll`, `open`) returns once its effect has had time to show, because the core lists the app right after it: `press`, `click`, `type` and `key` 200 ms after their last event, `scroll` once it has read its scroll bar again, `open` and a Dock `click` once the app has a window in front. The core adds no wait of its own.

**An id names the same element for as long as that element is listed.** Each `see` keeps the id of every element it finds again (the same AX element, matched with `CFEqual`), gives the others new ids, and drops the ones it did not find. So two calls sent from one list both work, and an id of an element that is no longer listed is an error: "call see again".

`see` lists the elements a person could act on or read in the app's window: actionable roles, text, headings and images that have a label. `frontmost` names the app with keyboard focus. `states` holds only what is set, from `disabled`, `selected` and `focused`. `cut` says why the walk stopped early (`'elements'` at 300, `'visits'`, `'time'`) or is null; `unlabeled` counts the listed actionable elements with no text. `image` (PNG base64) comes only with `screenshot: true`. `shot: { w, h, rect }` describes the last screenshot of this app, whenever there is one: with no `image`, it is older than this list. The first `see` of a Chromium or Electron app waits, up to 3 s, until its web tree is built, so the first list is not the empty one it has before.

A `point` is in the pixels of the last screenshot taken, which a `see` without one does not replace. `resolve { point }` refuses it when there is none, or when the window it was taken of has moved or closed since.

`scroll` moves `pages` (above 0) of the visible area at the point: the nearest scroll area or web area there, cut to its window, or else the window. A page is 90% of that length, so the last line stays in view, sent as pixel wheel events of at most 100 px. The op returns once it has read the area's scroll bar on that axis again, 200 ms after the last event: `position` is where it is now, from 0 (top or left) to 1, and `moved` says whether it changed. Both are null when the area has no scroll bar to read (typical for Chromium content).

## The hands pipeline (core, one function, one step at a time)

The executor's GUI tools are `see`, `click`, `type`, `key`, `scroll` and `open`. Each takes a `label`, a short description of the step in the user's language, and `screenshot` (default false), which asks for a screenshot with the step's list. Every call runs the same steps:

1. **Resolve** the target to `{ app, rect, point }`: an element, a screenshot point, a Dock item (`open` an app = press its Dock icon), or the app itself (`see`, `type`, `key`).
2. **Grant.** If the hands have never touched this app, raise a `core` card ("Allow controlling Maps?") and wait. A no ends the step with an error the executor can read. Answers persist in `~/.lookma/apps.json`.
3. **Attention.** Visible by default: if the user is not busy (idle ≥ 3 s), bring the target forward. If they are busy:
   - steps that can act in the background (AX `press`, `see`) proceed with `background: true` and an edge hint;
   - steps that need the front (`type`, `key`, a coordinate `click`, `scroll`, opening an app) wait with `focus.phase = 'waiting'` until the user is idle ≥ 3 s or says go ahead (`control` `go_ahead`).
4. **Mark.** Set `focus` (label, rect, point). Before an act, wait about 350 ms so the ring and ghost cursor arrive before anything happens. `see` acts on nothing, so it does not wait.
5. **Act** through the app, then set `focus.phase` to `done` or `failed`. `see` has no act. The op returns once its effect shows (see the op table).
6. **Observe**: the `see` op of the app this step resolved and granted, with `screenshot` when the call asks for it. This is the only place the core asks for `see`. Two rules:
   - **An action that happened is never reported as failed.** If the list fails after the act, for any reason, the result is the action line followed by "Could not list <app>: <error>", and `focus.phase` stays `done`. A failed `see` step is a failed step.
   - **Only the resolved, granted app is listed.** `open` with a `url` or a `path` resolves nothing, so it lists nothing: its result names the app that opened it ("Call see to list it"), and the agent's `see` of that app takes the grant path.
7. **Return** to the executor, as text:
   - the action line, when the step acted: what happened. A scroll says how far it went and where it is now ("now at 40%"), or "Did not move" when the scroll bar stayed put;
   - the facts that say whether the list is enough: the app, its window and the frontmost app; a screenshot or "No screenshot"; "The last screenshot is from before this action" when there is an older one; a list cut short; how many elements have no label;
   - the elements, one per line: id, role, text and states.

   The image comes only when the call asked for it.

## Plug-ins

The agent and the voice are plug-ins: a folder in `executors/` or `voices/`, selected by `LOOKMA_EXECUTOR` (default `claude`) and `LOOKMA_VOICE` (default `openai`, or `off`). A plug-in's name is its folder's: lowercase letters and digits with single hyphens, unique across both kinds. Each has a `manifest.mjs`, read and validated only by `core/plugins.mjs`:

```js
export default {
  title,       // the name people read: 'Codex'
  settings,    // { key: { default, help, env?, secret?, required? } }
  checks,      // optional: [options => finding], run by lookma doctor (an executor's also before lookma start)
}
```

- A setting's type is the type of its `default`: a string, a number, or a boolean written `1` or `0`. An empty value is unset.
- Its name is derived, `LOOKMA_<NAME>_<KEY>` (`codex` + `model` is `LOOKMA_CODEX_MODEL`), unless `env` names a well-known variable (`OPENAI_API_KEY`, `CODEX_HOME`).
- `secret`: never printed, and kept out of every other plug-in's environment (an executor's `ctx.env`).
- `required`: a string with an empty default. An executor's stops `lookma start` while unset; a voice's leaves Lookma running without voice.
- The plug-in gets the checked values as `options`. Nothing else reads its settings.
- A finding is `ok(text)`, `warn(text, fix)` or `fail(text, fix)`. A manifest imports only Node's own modules and the helpers `ok`, `warn`, `fail`, `sh` and `atLeast` from `core/doctor.mjs`, so it works before `npm install`.
- `lookma --help` lists the selected plug-ins' settings, `lookma config` shows the ones in effect and where each came from, and `lookma doctor` warns once about any `LOOKMA_*` variable no one declares.

## Executor contract

An executor adapter is a driver for one agent session. The core owns the user's turn, the cards, the tools and the outbox; the executor host (`core/executor/host.mjs`) loads the adapter, and the adapter only translates: prompts and an interrupt go down, the agent's activity comes up.

```js
// executors/<name>/index.mjs
export function create(ctx) → {
  start({ dirs }) → Promise   // resolves when the agent can take a prompt and call its tools;
                              // rejects in words. Called again after close() (a restart).
  prompt(text) → Promise      // deliver one user message; resolves once the agent has taken it
                              // (not when the work is done), rejects if it could not
  interrupt() → Promise       // stop the current work; resolves when the agent is idle and nothing
                              // of the stopped work will be emitted or called any more
  close() → Promise           // end the session and every child process
}

ctx = {
  emit(event),
  tools: { server: 'lookma', mcp(extras?) → { command, args, env } },   // the tools bridge to spawn
  ask({ title, detail }, signal?) → Promise<true | false | null>,        // a card; null: withdrawn
  options,        // the adapter's settings, from its manifest, validated
  instructions,   // the text of prompts/executor.md
  sessionDir,     // <data>/sessions/<name>, created, the adapter's to fill
  env,            // the environment for child processes, without other plug-ins' secrets
  log,
}
```

Events:

```js
{ type: 'turnStart' }                       // the agent became busy without a prompt from the core
{ type: 'turnEnd', ok, summary?, error? }   // the agent became idle; error says why it failed
{ type: 'step', title }                     // a step of the main work that is not on screen
{ type: 'task', id, title, status: 'running' | 'done' | 'failed', action, result: { speech, display } }
{ type: 'down', detail }                    // the session died by itself
```

- **Events.** `turnEnd` once each time the agent goes idle, with `error` in words when it failed; a prompt that joined the running work gets none of its own. `turnStart` only for work the core did not start (a background task waking the agent), never for a prompt just delivered. `task` only for background work (`result` is the report the voice reads). `down` once, when the session died by itself: never after `close`, and during `start` the start rejects instead. An event an agent cannot produce is simply never emitted; nothing is declared.
- **Steering.** `prompt` while the agent works adds the text to the running work as soon as the agent can take it; it never restarts the conversation and is never lost. An agent that cannot take a message mid-turn is interrupted by its adapter, and the text sent as the next prompt in the same conversation, with no `turnEnd` for that inner interrupt.
- **Cards.** `await ctx.ask(card)` is `true` or `false`, the user's answer, or `null` when the card was withdrawn (a stop, a restart, close, or the adapter's own `signal`, for a request the agent closed itself); the adapter then answers its agent "deny". Approve means once: an adapter never maps a yes to an "always allow" option.
- **Steps.** `step.title` comes from `core/executor/steps.mjs`, `title(kind, detail)`; calls to `ctx.tools.server` are never steps (the hands show themselves).
- **The host** owns everything else, once:
  - **status** `starting` until `start()` resolves, then `ready`; `down` when a start fails, after `close`, or when recovery is used up;
  - **the prompt line**: prompts go to the adapter one at a time, in order, only while `ready` and not stopping; a rejected `prompt` fails the turn with its reason;
  - **the stop gate**: from the core's stop until `interrupt()` resolves, the adapter's events are dropped, tool calls are refused, open cards are withdrawn, the hands stop, and prompts told before the stop are discarded. A `task` event still passes while the session is `ready`: a background task is not the stopped work, and its `id` says which task it is;
  - **background tasks**: when the session ends (a restart, a failed start, `close`), every task still running gets `task { id, status: 'failed' }`;
  - **recovery**: a `down` event, or an `interrupt()` that has not resolved after 10 s, fails the running turn with the reason, closes the session and starts it again (status `starting`, "…; restarting"); a second failure within a minute leaves it `down`;
  - **the turn text**: a failed turn that said nothing tells "That did not work: <error>."; `summary` goes to the log only.
- `lookma start` launches the app without waiting for the executor: prompts told while it starts wait in the host.

GUI steps are not in the contract. They arrive as hands tool calls through the tools bridge.

**The tools bridge.** The agent gets `say` and the hands from `core/executor/bridge.mjs`, a stdio MCP server it spawns from `ctx.tools.mcp(extras)`. The spec's environment carries `LOOKMA_CORE_URL` and `LOOKMA_TOOLS` (the server's name, its tools as `core/tools.mjs` defines them, and the `extras`: `toolMeta`, merged into each tool's `_meta`, and the server's `instructions`). The bridge dials `/ws/executor` before it answers MCP, then pipes every call:

- bridge → host: `{ type: 'call', id, tool, args }`;
- host → bridge: `{ type: 'res', id, ok, result | error }`: `{ text, image? }` (a `say` is `{ text: 'said' }`), or the error the agent reads.

The bridge returns a step's screenshot, when it took one, as an MCP image, and an error as a tool error.

**Conformance.** `core/dev/check-executors.mjs` runs one list of scenarios over every executor with a `dev/fake-agent.mjs`, a script that speaks the agent's protocol in place of its binary: ready, prompts, tools through the bridge, cards allowed, declined and withdrawn, steering, a stop and its stragglers, a correction told just before a stop, a stop that never resolves, the agent dying, and `close`.

### Claude Code adapter (`executors/claude/`)

- **Run.** The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, imported by `index.mjs` only) runs the user's installed `claude` (the first on `ctx.env`'s `PATH`, `pathToClaudeCodeExecutable`), headless, as one `query()` per session in streaming-input mode: the prompt stream stays open between turns. It needs Claude Code 2.1.330 or later, the version the SDK was built against.
- **Isolation.**
  - `settingSources: []`: none of the user's, project or local settings, so no CLAUDE.md, hooks or plugins. Lookma's own settings go in as flag settings (`settings`): `permissions.allow` the `lookma` server (say and the hands never ask), `permissions.deny` `mcp__computer-use`, `AskUserQuestion` and `Agent(fork)`, and `env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`.
  - `strictMcpConfig: true`, `mcpServers: { lookma: ctx.tools.mcp({ toolMeta: { 'anthropic/alwaysLoad': true }, instructions }) }`, sent over stdin (`mcpServersDelivery: 'initialize'`) so the bridge's environment is not on the command line.
  - `cwd`: the empty `<data>/sessions/claude/work`; `additionalDirectories`: the user's folders.
  - The environment is `ctx.env` without a parent Claude Code's session markers (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_AGENT_SDK_*`), so a Lookma started from inside Claude Code still uses the user's own login. The user's own auth choices among them stay: `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_USE_*` (Bedrock, Vertex).
- **Options.** `model` (`LOOKMA_CLAUDE_MODEL`), `permissionMode` (`LOOKMA_CLAUDE_PERMISSION_MODE`), `systemPrompt`: Claude Code's own preset with `ctx.instructions` appended, plus the background-task convention below. `LOOKMA_CLAUDE_FLAGS` becomes `extraArgs`.
- **Start.** `query()`, then its `initializationResult()`, then `mcpServerStatus()` until `lookma` is `connected` (a failed or missing server, or one still pending after 30 s, rejects the start). The log names the login in use (`account.subscriptionType`, or the API key source). After `close`, `start` passes the last session id as `resume`, so a restart goes on with the same conversation.
- **Turns.**
  - `prompt` → one user message into the stream, with a `uuid`. During a turn, Claude Code queues it and takes it into that turn after the running tool calls.
  - `interrupt` → `Query.interrupt()`, once every prompt is written. A prompt still queued survives a plain interrupt and runs as the next turn; the interrupt's receipt names it (`still_queued`). So the stop interrupts every turn that starts while it lasts, asks again after a turn ends while the last receipt named prompts of ours, and resolves when no turn runs and the last receipt names none. Nothing runs and nothing is queued: it resolves on the receipt.
  - `result` → `turnEnd`: `ok` for a `success` that is not `is_error`; `error` from the result's text or its `errors`; `summary` is the result's text.
  - A main-agent `system/init` or `assistant` message while no turn runs → `turnStart` (a finished background task woke the agent).
  - The stream ending by itself (Claude Code exited) → `down`.
- **Hooks**, as SDK callbacks (`hooks.mjs`):
  - `PreToolUse` of the main agent → `step`, titled by `core/executor/steps.mjs`; the `lookma` server's tools are skipped. An `Agent` call is the step `Start: <description>`.
  - `SubagentStart` (with an `agent_type`; Claude Code's internal agents have none) → `task` running, titled by the `Agent` call's description; the subagent's own `PreToolUse` → `task` with an `action`.
  - `SubagentStop` → `task` done, with its report split into `SAY:` (speech) and `SHOW:` (display) lines. A subagent's `SubagentHandback` message is its report when there is one.
  - The convention is the adapter's: it appends its paragraph (start background subagents only for long work with nothing on screen; no `say` or hands; end with `SAY:` and `SHOW:`) to `ctx.instructions`.
- **Approvals.** `canUseTool` → `await ctx.ask(card, signal)` (`approvals.mjs`): the card is a question per tool (`Run this command?` with the command, `Write this file?`, `Open this web page?`, …, else `Allow this step?` with the step's title), plus Claude Code's `blockedPath` and `decisionReason`. `true` → `{ behavior: 'allow', updatedInput }` for this call only (the suggested rules are never passed back); `false` or `null` → `deny`. When Claude Code cancels the request itself (an interrupt), the SDK aborts `signal` and the card goes.

### Codex adapter (`executors/codex/`)

- **Run.** `codex app-server` runs as a child process, speaking newline-delimited JSON-RPC on stdio (`rpc.mjs`), with `--strict-config`, the login kept in a file (`cli_auth_credentials_store="file"`), and the features `apps`, `plugins`, `computer_use`, `browser_use`, `multi_agent`, `memories` and `image_generation` turned off. Its environment is `ctx.env`, so the voice's OpenAI key is not passed on. It is checked against Codex 0.163.0; app-server is experimental.
- **Isolation.** `CODEX_HOME` is `<data>/sessions/codex/home`, which holds only a link to the user's `auth.json`: the login is shared, while the user's own config, MCP servers and plugins stay out. The thread's working dir is the empty `<data>/sessions/codex/work`, so no `AGENTS.md` is read.
- **Start.** `initialize` (with `experimentalApi`, and the streaming deltas and usage notifications opted out), `initialized`, then one `thread/start` per session:
  - `cwd`: the work dir; `model`: `LOOKMA_CODEX_MODEL` or Codex's default; `ephemeral: true`;
  - `approvalPolicy: 'on-request'`, `sandbox: 'workspace-write'`, `config.sandbox_workspace_write: { writable_roots: <the user's dirs>, network_access: false }`;
  - `developerInstructions`: `ctx.instructions`, after Codex's own base prompt;
  - `config.mcp_servers.lookma`: `ctx.tools.mcp()`, with `default_tools_approval_mode: 'approve'` and `tool_timeout_sec: 600`, since a hands call may wait on the user's card.

  `start` resolves once `mcpServer/startupStatus/updated` says `lookma` is `ready` (and rejects if it failed). A restart begins a fresh thread.
- **Turns.**
  - `prompt` → `turn/start { threadId, input: [{ type: 'text', text, text_elements: [] }] }`, or `turn/steer { threadId, input, expectedTurnId }` while a Codex turn runs; a refused steer (the turn has just ended) becomes a `turn/start`;
  - `interrupt` → `turn/interrupt { threadId, turnId }`, resolving on that turn's `turn/completed`;
  - `turn/started` → `turnStart`; `turn/completed` → `turnEnd` with `ok` when its status is `completed`, `error` from the turn's error, and the last agent message as `summary`;
  - `item/started` → `step`: a command (as Codex reads it, e.g. "Read notes.txt", else the command line), a file change, a web search, another MCP server's tool. The hands, reasoning and messages give none;
  - app-server exiting by itself is `down`.
- **Cards.** One per request, through `ctx.ask`:

  | Request | Card | Approve | Decline or withdrawn |
  |---|---|---|---|
  | `item/commandExecution/requestApproval` | "Run this command?" (or network access, or input to a running command), with the command and Codex's reason | `{ decision: 'accept' }` | `{ decision: 'decline' }` |
  | `item/fileChange/requestApproval` | "Change these files?", with the paths of its file change | `{ decision: 'accept' }` | `{ decision: 'decline' }` |
  | `item/permissions/requestApproval` | "Allow more access?", with what is asked for and why | `{ permissions: <as asked>, scope: 'turn' }` | `{ permissions: {}, scope: 'turn' }` |

  Never `acceptForSession` or `scope: 'session'`: Approve is this once. If a request does not offer `accept`, Approve answers `decline`. A card is withdrawn, with no answer, on `serverRequest/resolved`, at the end of its turn, or when app-server exits. Without a card: `mcpServer/elicitation/request` is declined and `currentTime/read` is answered. Any other request gets the JSON-RPC error `-32601`, so no request can block a turn.
- **Not used.** `task` (Codex's subagents are off).

## Voice provider contract

**Provisional until a second provider exists.** A voice provider is one conversational voice service in the floor's own terms: it turns the microphone and the speaker into voice events and carries out the floor's four effects. The floor (`overlay/voice/floor.js`) decides who speaks; the provider decides nothing. The session's lifecycle (the grant, the microphone, the connect deadline, reconnecting, renewal, pause) is `overlay/voice/session.js`, the same for every provider. `overlay/voice/contract.js` has the exact shapes and is the only code a provider shares with the overlay. [Writing a voice](writing-a-voice.md) walks through it.

```js
// voices/<name>/mint.mjs, in the core, under the voice host (core/voice/host.mjs)
export async function mint({ options, instructions, tools, audio, language, log })
  → { credential?, startBy?, renewAfter, label, session? }

// voices/<name>/page.js, a browser module, served at /voices/<name>/page.js (and page/*)
export function connect(grant, { signal, openMic, onEvent, onClose, log }) → Promise<{ send(effect) }>
```

**The grant.** `POST /api/voice/grant` answers `{ provider, ...mint's result }`.

- In: `options`, the provider's checked settings; `instructions`, `prompts/butler.md`; `tools`, `prompts/butler-tools.json` as `[{ name, description, parameters }]`; `audio`, `room` or `headset` (`LOOKMA_AUDIO`); `language`, `LOOKMA_VOICE_LANGUAGE` or `''`. The host reads the prompts for every grant, so an edit applies to the next session.
- `credential` is what the page connects with, never the real key, which stays in the core. `startBy` (epoch ms) is the last moment a connection may start with the grant. `renewAfter` (ms) is when the session is swapped at the next idle moment. `label` is for the log. `session` is the provider's own data for its `page.js`, opaque to everyone else.
- A `mint` that throws is a 502 (try again later). No voice at all is a 503.

**The connection.** `connect` resolves once the connection is live and rejects in words.

- `signal` aborts when the session ends the connection, live or still coming up: release everything. From then on the session ignores it.
- `openMic()` resolves with the session's microphone, kept open across reconnects. A provider whose audio is captured elsewhere never calls it.
- `onClose(why)`: the connection ended by itself. The session reconnects with backoff.
- `send(effect)` is called only while the connection is live.

**Events** (provider → floor). The provider owns turn detection.

| Event | Obligation |
|---|---|
| `turn.started { id }`, `turn.stopped { id }`, `turn.committed { id }` | One id per user turn, the service's or minted. `started` as soon as the user is audibly speaking |
| `turn.transcript { id, text \| null }` | Once per committed turn; `null` when there is none |
| `response.started { response }` | Once per reply begun for a `create`, before its other events |
| `response.item { response, kind }` | As soon as the reply's first output is known to be a `message`, a `call` or a `pass` |
| `butler.said { response, text, final }` | What the butler is saying; whole with `final: true` |
| `response.done { response, status, items, reason? }` | `completed`, `cancelled` (cut by the user or the client), `failed` or `incomplete`; items through `item()`, which makes a `pass` call an item of kind `pass` |
| `audio.started`, `audio.stopped`, `audio.cleared { response }` | The truth about playback at the speaker: started, played to the end, cut off |
| `error { eventId, message }` | `eventId` of a rejected `create` when the service can tell, else `null` |

**Effects** (floor → provider), and nothing else:

| Effect | Meaning | When the service lacks it |
|---|---|---|
| `create { kind: 'turn', eventId }` | Start one reply now, covering the whole conversation, tools allowed. The service never replies by itself | Required: hold the service's own trigger until `create` |
| `create { kind: 'speak', eventId }` | Start one reply now that only speaks | An ordinary reply: the floor never runs a speak reply's calls |
| `tell { texts }` | Add texts the butler was told; no reply | Required |
| `drop { items }` | These items are void: remove them; a call among them still waiting for its result is resolved silently | Resolve the calls only |
| `output { results: [{ callId, output }] }` | The results of calls; no reply | Required |

A service that cannot report playback truthfully, or cannot hold its reply until `create`, cannot be a Lookma voice. Per-reply parameters are the provider's own: `mint` puts them in `grant.session`, and `page.js` reads them.

**`room` and `headset`.** In a `room`, the user's voice never cuts a reply and noise reduction is for a far microphone. With a `headset`, the user's voice cuts a reply at once (`audio.cleared`, then `response.done` `cancelled`) and noise reduction is for a near microphone.

**Conformance.** `overlay/dev/check-voices.mjs` runs the overlay's voice with every provider's real `page.js` in headless Chrome, against the provider's `dev/fake.mjs`, which stands in for the service: it exports `grant`, `page` (a script that replaces the transport with a fake service), `toService(event)` and `fromService(message)`.

### OpenAI Realtime provider (`voices/openai/`)

- **Settings.** `OPENAI_API_KEY` (secret, required), `LOOKMA_OPENAI_MODEL` (default `gpt-realtime-2.1`), `LOOKMA_OPENAI_VOICE` (`marin`), `LOOKMA_OPENAI_TRANSCRIBE_MODEL` (`gpt-4o-transcribe`), `LOOKMA_OPENAI_MAX_TOKENS` (200).
- **Mint.** `POST /v1/realtime/client_secrets` with the whole session: the butler's instructions and tools (`do`, `status`, `answer`, `control`, `pass`), `tool_choice: 'auto'`, `max_output_tokens`, transcription (with `language` when set, and no prompt: it makes the transcriber drop the question marks the approval check relies on), the voice, and turn detection: `semantic_vad` with `eagerness: 'medium'` and `create_response: false`. `room` sets `interrupt_response: false` and `far_field` noise reduction; `headset` `interrupt_response: true` and `near_field`. The grant: `credential` is the ephemeral key, `startBy` its expiry, `renewAfter` 50 minutes (the session limit is 60), `label` the model, and `session.responses` the parameters of each kind of reply: `turn` none, `speak` `tool_choice: 'none'`.
- **Connect.** One WebRTC call: the microphone track `sendrecv`, an SDP offer posted to `/v1/realtime/calls` with the key, the butler's voice on an `<audio>` element, and the events on the `oai-events` data channel. It resolves when the channel opens; `onClose` on the channel closing or the connection failing.
- **Events.** `input_audio_buffer.speech_started`, `speech_stopped`, `committed` → `turn.*` by `item_id`; `conversation.item.input_audio_transcription.completed` (or `.failed`, as `null`) → `turn.transcript`; `response.created` → `response.started`; `response.output_item.added` → `response.item`; `response.output_audio_transcript.delta` and `.done` → `butler.said`; `response.done` → `response.done`; `output_audio_buffer.started`, `stopped`, `cleared` → `audio.*`; `error` → `error`.
- **Effects.** `create` → `response.create` with `event_id` and that kind's parameters, never instructions; `tell` → a user message `conversation.item.create` per text; `drop` → `conversation.item.delete` per item; `output` → a `function_call_output` `conversation.item.create` per result.
- **Limits.** None.
