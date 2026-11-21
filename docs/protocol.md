# Protocol (v1)

How the pieces talk. The core holds one model: the turn, the focus (the current hands step) and the user's attention, and every step is visible by default. All user-facing text in the product is English. Anything spoken or narrated follows the language the user speaks.

## Processes

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/architecture-dark.svg">
  <img src="images/architecture.svg" width="100%" alt="You talk to the overlay in Lookma.app, which streams your microphone to OpenAI Realtime while it listens. The overlay and the app connect to the core on 127.0.0.1, which prompts Claude Code and runs each hands step through the app.">
</picture>

Three WebSockets meet at the core: the overlay page on `/ws/overlay`, the app on `/ws/app`, and the executor adapter's own connection on `/ws/executor` (the agent's tools bridge).

- **core** (`core/`) is the only place that decides anything. It serves the overlay page at `/`, WebSockets at `/ws/overlay`, `/ws/app` and `/ws/executor`, and HTTP at `/hook`, `/api/state`, `/api/tell` and `/api/voice/grant`. Beside the overlay it serves the selected voice provider's page half, `/voices/<name>/page.js` (and `/voices/<name>/page/*`), and nothing else of that folder.
- **app** (`app/`) is launched with `open` so macOS permissions belong to it. It connects back to the core, provides primitives, and the menu bar item (pause, resume, type, quit), and makes no decisions.
- **overlay** (`overlay/`) is a page loaded by the app's full-screen, click-through WKWebView. It renders core state and runs the realtime voice session. It also opens in a normal browser for development.
- **executor adapter** (`executors/<name>/`) wraps one agent behind the contract below. v1 ships `claude` and `codex`.

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
- `cards` are pending approvals, oldest first. `source: 'core'` means the core asks for itself, e.g. the first time the hands touch an app. `turnId` is the turn that was working when the card was raised (null outside a turn, e.g. a startup card); stopping that turn removes its cards.
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

- **Warm session.** One Realtime WebRTC session, its audio transceiver `sendrecv` with the microphone track. macOS shows its mic indicator. The voice speaks on the same session, and it keeps the conversation across turns.
- **Turns** come from the server: `turn_detection` is `semantic_vad` with `eagerness: 'medium'` and `create_response: false`. The audio setup (`LOOKMA_AUDIO`) sets the rest: `room` (the default) has `interrupt_response: false` and `far_field` noise reduction, so speech over the voice does not cut it off; `headset` has `interrupt_response: true` and `near_field`, so it does (barge-in).
- **The floor** (`overlay/voice/floor.js`) decides who speaks: one reply at a time, and only once the user's turn is committed. What the voice owes is user turns (a reply) and outbox entries (an announcement). Every committed turn gets a `response.create` at once; the voice itself decides whether it was meant for it, and a reply that is a `pass` call, or has nothing in it, deletes that turn from the conversation. A turn is shown as heard when the reply's first output that is not a `pass` arrives.
- **Replies.** `response.create` carries the grant's `session.responses[kind]` and never instructions: a reply to new turns (`turn`) may call tools; every other reply (`speak`: an announcement, or a tool result to say) is speak-only (`tool_choice: 'none'`). A tool result the user has not heard (an error, `status`, or any result after a reply that said nothing) gets a speak-only reply.
- **Announcements.** What the outbox owes is announced once nobody has talked for 0.7 s, after any user turn, all of it in one reply, in outbox order, as user items marked as updates. When its audio has played, the entries get `spoken`. Talked over by a user who then gets an answer (the reply to their turn is not a `pass`), they get `cut`. A reply that fails (cancelled by noise, rejected, cut off by a dropped session, or with no news for 30 s) is tried again; a reply the user's voice cancelled counts as failed only once the reply to their turn turns out not to be an answer, so a request spoken in pieces is never lost. After two failures an entry gets `shown`, and a request the voice never acted on shows "say that again". A receipt is sent again while a snapshot still shows the entry owed, so one lost with the core link heals itself.
- **Turn records.** Each turn is recorded when its speech starts: its item id, `startedAt` (when the event arrived) and `overButler` (whether the voice's audio was playing then). Its transcript is matched by item id when it arrives.
- **Health.** The session reconnects in the background when it closes or fails, with backoff. While idle (nothing heard, said or owed for 10 s), it is renewed after the grant's `renewAfter` (before the Realtime session limit), with its grant minted ahead.
- **Context.** Every new session is first given the outbox entries that already have a receipt (the last 5 minutes, and the card on screen), as user items marked "from earlier" and with no `response.create`. So "yes, I approve" still answers a card announced on the old session, also after a page reload.
- **Paused:** no session at all, and no microphone; what is owed stays in the outbox and is announced after resume. **Voice off** (`LOOKMA_VOICE=off`, no OpenAI key): no session, captions only, and everything owed gets `shown`. A page opened with `?voice=0` is a spectator: no session, captions only, and no receipts, so it never settles what the app's voice still owes.

**Voice approval** (`overlay/consent.js`): a spoken answer (approve or decline) counts only when all of these hold:
- it was spoken at least 1 s after the card rendered (the turn's `startedAt`);
- it cannot be the assistant's own voice: said over the voice (`overButler`), it counts unless the voice itself was saying an approval phrase;
- its own transcript, matched by the turn's item id and awaited up to 3 s, is explicit: "yes, I approve", "approved, do it", or a clear "no", "don't". A lone "approve" or "go ahead" is not enough, and any hesitation fails. "Cancel" is a stop, never a decline.
- the core accepts it: the butler's `answer` sends an `answer` request, and the card shows Approved (or Declined) only after the ack says `ok`.

Otherwise the voice asks again. The card's hint reads: Say “yes, I approve”. Clicking Approve always works.

## Overlay → core

Requests carry an `id` (`r1`, `r2`, … per page) and get exactly one `ack`, to the requester only. The core alone decides whether a request applies; the page never does.

| Request | Ack |
|---|---|
| `{ type: 'tell', id, text, source: 'voice' \| 'typed' }`: a new instruction; the core prompts, or steers if a turn is running | `{ ok: true, state: 'started' \| 'added' }`, or `{ ok: false, error }` (empty text, paused, the executor not running) |
| `{ type: 'answer', id, cardId, allow, via: 'voice' \| 'click' }` | `{ ok: true }`, or `{ ok: false, error: 'gone' }` |
| `{ type: 'control', id, action: 'stop' \| 'go_ahead' \| 'pause' }` | `{ ok: true }`, or `{ ok: false, error: 'nothing_running' \| 'not_waiting' \| 'unknown_action' }` |

- `stop` stops the working turn (the executor's `cancel`, the waiting hands step fails, queued steps drop) and removes that turn's cards. `go_ahead` lets a step waiting with `focus.phase: 'waiting'` act now. `pause` is idempotent (see Pause and quit).
- The page's `request` resolves `{ ok: false, error: 'not connected' }` when the socket is closed or closes before the ack, and `{ ok: false, error: 'no answer' }` after 3 s. It never resends.

Without an ack:

```js
{ type: 'delivered', ids, how: 'spoken' | 'cut' | 'shown' }   // receipts for outbox entries; idempotent, seen in the next snapshot
{ type: 'log', text }                                // a line for the core's log (the voice's decisions)
```

Spoken "stop", "go ahead" and "pause" are the voice's: it calls its `control` tool. Every tool that reaches the core (`do` sends `tell`, `answer`, `control`) gets the ack as its output, verbatim, so the voice says what really happened. A typed line of just "stop", "go ahead" or "pause" is sent as that `control` request whatever the state (`commandFor` in `overlay/consent.js`); a failed typed request shows its error on screen.

`POST /api/voice/grant` → `{ provider, credential?, startBy?, renewAfter, label, session? }`, one grant per voice session, minted by the selected provider's `mint.mjs` through the voice host (`core/voice/host.mjs`). `provider` names the page half the session imports (`/voices/<provider>/page.js`); `credential` is what it connects with, never the real key, which stays in the core; `startBy` (epoch ms) is the last moment a connection may start with it; `renewAfter` (ms) is when the session is swapped at the next idle moment; `label` is for the log; `session` is the provider's own data. A 503 means no voice, for good (`LOOKMA_VOICE=off`, or a required setting such as `OPENAI_API_KEY` unset). Any other error (a 502 when the provider's service refused) means try again later.

For `openai`, `credential` is an ephemeral OpenAI Realtime key, with the session config (the voice's instructions from `prompts/butler.md`, its tools `do`, `status`, `answer`, `control` and `pass` from `prompts/butler-tools.json`, transcription (with `language` from `LOOKMA_VOICE_LANGUAGE` when set, and no prompt), server turn detection as above, `max_output_tokens` from `LOOKMA_OPENAI_MAX_TOKENS` (default 200), and voice) baked in by the core; `startBy` is the key's expiry, `renewAfter` 50 minutes, and `session.responses` the parameters of each kind of reply (`voices/openai/mint.mjs`), so the page never builds one.

**Voice provider contract** (provisional until a second provider exists). A provider is `voices/<name>/`: `manifest.mjs` (as an executor's, below), `mint.mjs` in the core and `page.js` in the overlay; `overlay/voice/contract.js` has the exact shapes.

```js
// voices/<name>/mint.mjs
export async function mint({ options, instructions, tools, audio, language, log }) → { credential?, startBy?, renewAfter, label, session? }
// voices/<name>/page.js, a browser module
export function connect(grant, { signal, openMic, onEvent, onClose, log }) → Promise<{ send(effect) }>
```

- `tools` are `prompts/butler-tools.json`, `[{ name, description, parameters }]`; `audio` is `room` or `headset`; `language` is `LOOKMA_VOICE_LANGUAGE` or `''`. A `mint` that throws is the 502.
- `connect` resolves once the connection is live and rejects in words. `signal` aborts when the session ends it, live or not: release everything. `openMic()` is the session's microphone, kept across reconnects. `onClose(why)`: the connection ended by itself.
- The provider owns turn detection and emits the voice events: `turn.started`, `turn.stopped`, `turn.committed { id }` (one id per user turn; `started` as soon as the user is audibly speaking), `turn.transcript { id, text | null }` (once per committed turn), `response.started { response }` (once per reply it began for a `create`, before its other events), `response.item { response, kind }` (as soon as the reply's first output is known), `butler.said { response, text, final }`, `response.done { response, status, items }` (`completed`, `cancelled`, `failed` or `incomplete`; items through `item()`, which makes a `pass` call an item of kind `pass`), `audio.started`, `audio.stopped`, `audio.cleared { response }` (the truth about playback at the speaker), and `error { eventId, message }`.
- It carries out the four effects and nothing else: `create { kind: 'turn' | 'speak', eventId }` starts one reply now (a `speak` reply only speaks; the service never replies by itself), `tell { texts }` adds texts the butler was told, with no reply, `drop { items }` voids items (a pending call among them is resolved silently), and `output { results: [{ callId, output }] }` gives call results, with no reply.

**Overlay ↔ app (local, not the core).** The page posts `{ hitRects: [rect…], typing, voice, listening, speaking }` to `window.webkit.messageHandlers.lookma` whenever one of them changes:

- `hitRects`: the app makes the window accept mouse events only while the pointer is inside one of those rects (the card), and click-through everywhere else.
- `typing`: the app gives the window the keyboard only while the typed input is open, and hands it back when the page closes it.
- `voice`: voice works (voice on, not paused, the session not failing).
- `listening`: the user is speaking (the server heard speech start, and not yet stop). The app shows it in the menu bar.
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

- **Pause** (`control` `pause` from the overlay, or `pause` from the app). If a turn is working, the core stops it exactly as `stop` does (the executor's `cancel`, the waiting hands step fails, queued steps drop, its cards go). Then `paused` becomes true. While paused:
  - the overlay closes the voice session entirely (WebRTC closed, mic track stopped), so nothing is heard, sent or billed, and the voice stops talking; what is owed stays in the outbox;
  - the capsule shows "Paused" and how to resume: the menu bar or ⌃⌥P;
  - marks clear, and the hands refuse every step;
  - `tell` is refused with the same hint (its ack's `error`; `POST /api/tell` answers 409).
- **Resume** (`resume` from the app). `paused` becomes false. The overlay reconnects the warm voice session, with the microphone. Nothing else starts: a turn the pause stopped stays stopped until the user asks again.
- **Quit** (`quit` from the app). The core runs its usual shutdown, the same as Ctrl-C: `{ type: 'quit' }` to the app, the executor's `stop`, the server closes and the process exits, so the `lookma` command ends. If the core is not reachable, or does not answer within 5 s, the app quits by itself.

The app's menu bar item, the seal, shows the state the core and the page last sent: its ring filled while the user speaks, a pause sign while paused, and dimmed while not connected. Its menu has Pause or Resume (⌃⌥P), Type a Request…, and Quit.

- ⌃⌥P is a Carbon hot key, which needs no extra permission; when another app holds it, the app logs that and the menu still works.

Core → app requests, and the app's replies:

```js
{ type: 'req', id, op, args }  →  { type: 'res', id, ok: true, result } | { type: 'res', id, ok: false, error }
```

| op | args | result |
|---|---|---|
| `see` | `{ app? }` (default: frontmost) | `{ image (png base64), shot: { w, h, rect }, app, window: { title, rect }, elements: [{ id, role, text, rect }] }` |
| `resolve` | `{ element } \| { point:[x,y] } \| { dock: appName } \| { app }` | `{ app, rect, point, frontmost, pressable }` |
| `front` | `{ app }` | `{}` (best effort: the ops that post input check the front themselves) |
| `press` | `{ element }` | AX press: `{}` |
| `click` | `{ point }` (screen points) | `{}` |
| `type` | `{ text }` | `{}` |
| `key` | `{ combo }` e.g. `"cmd+t"` | `{}` |
| `scroll` | `{ point, direction, amount }` | `{}` |
| `open` | `{ url } \| { path }` | `{ app }` |

Element ids come from the last `see` and stay valid until the next one. A stale id is an error: "call see again".

## The hands pipeline (core, one function, one step at a time)

The executor's GUI tools are `see`, `click`, `type`, `key`, `scroll` and `open`. Each takes a `label`, a short description of the step in the user's language. Every call runs the same steps:

1. **Resolve** the target to `{ app, rect, point }`: an element, a screenshot point, a Dock item (`open` an app = press its Dock icon), or the app itself (`see`, `type`, `key`).
2. **Grant.** If the hands have never touched this app, raise a `core` card ("Allow controlling Maps?") and wait. A no ends the step with an error the executor can read. Answers persist in `~/.lookma/apps.json`.
3. **Attention.** Visible by default: if the user is not busy (idle ≥ 3 s), bring the target forward. If they are busy:
   - steps that can act in the background (AX `press`, `see`) proceed with `background: true` and an edge hint;
   - steps that need the front (`type`, `key`, a coordinate `click`, `scroll`, opening an app) wait with `focus.phase = 'waiting'` until the user is idle ≥ 3 s or says go ahead (`control` `go_ahead`).
4. **Mark.** Set `focus` (label, rect, point). Wait about 350 ms so the ring and ghost cursor arrive before anything happens.
5. **Act** through the app, then set `focus.phase` to `done` or `failed`.
6. **Return** to the executor:
   - `see` → the image plus the element list as text;
   - every other tool → one line saying what happened and what is frontmost now.

## Executor contract

```js
// executors/<name>/index.mjs
export function create(ctx)  // ctx: { emit(event), hands(tool, args) → Promise<result>, config, options, log }
  → { start({ dirs }) → Promise<{ name }>,
      prompt(text, { steer }), cancel(), answer(cardId, allow), stop(),
      connect?(ws), hook?(body) }
```

- `prompt` gets `steer: true` when a turn is already running: the text is a correction to it.
- `connect` gets each socket accepted on `/ws/executor`, and `hook` each body POSTed to `/hook`. An adapter that needs neither leaves them out; the core then closes `/ws/executor` sockets (code 4004).
- `executors/<name>/manifest.mjs` (a voice has one too, in `voices/<name>/`) exports `default { title, settings, checks? }`, read and validated only by `core/plugins.mjs`. A setting is `{ default, help, env?, secret?, required? }`: its type is the type of `default` (string, boolean written `1` or `0`, number), its name is `LOOKMA_<NAME>_<KEY>` unless `env` names a well-known variable (`OPENAI_API_KEY`), an empty value is unset, and `secret` is never printed. The adapter gets the checked values as `ctx.options`. `checks` is a list of functions `options => finding`, run by `lookma doctor` and before `lookma start`. A manifest may import only Node's own modules and the helpers `ok`, `warn`, `fail`, `sh` and `atLeast` from `core/doctor.mjs`, so it works before `npm install`.

The adapter emits:

```js
{ type: 'status', status: 'starting' | 'ready' | 'down', detail }
{ type: 'turnStart' }  { type: 'turnEnd', ok }
{ type: 'step', title }                          // non-GUI step of the main turn
{ type: 'say', speech, display, kind }
{ type: 'task', id, title, status: 'running' | 'done' | 'failed', action, result: { speech, display } }
{ type: 'approval', id, title, detail }          // one per dialog; the adapter merges its own routes
{ type: 'approvalGone', id }                      // answered elsewhere or closed
```

GUI steps are not in the contract. They arrive as hands tool calls, which the adapter forwards to `ctx.hands`.

**The tools bridge.** Both adapters give their agent `say` and the hands through `core/executor/bridge.mjs`, a stdio MCP server that the agent spawns with `LOOKMA_CORE_URL` set. It exposes the tools as `core/tools.mjs` defines them and connects to `/ws/executor`, the adapter's `connect`, where `core/executor/tool-link.mjs` serves them:

- bridge → core: `{ type: 'say', speech, display, kind }` and `{ type: 'hands', id, tool, args }`;
- core → bridge: `{ type: 'res', id, ok, result | error }`, the hands call's result (`{ text, image? }`) or its error.

The bridge returns `see`'s screenshot as an MCP image, and an error as a tool error the agent reads.

### Claude Code adapter (`executors/claude/`)

- **Run.** Interactive `claude` runs in a tmux session (`lookma`; `tmux attach -t lookma` to watch). Its working dir is a generated session dir holding `.mcp.json`, `settings.json` and the executor prompt (`executor.md`, copied from `prompts/executor.md`).
  - Flags: `--model`, `--permission-mode`, `--settings`, `--append-system-prompt-file`, `--dangerously-load-development-channels server:lookma`, then `LOOKMA_CLAUDE_FLAGS` (the user's folders are in the settings, see Folders below).
  - No `--chrome`. The settings deny built-in computer use (`mcp__computer-use`).
- **Channel.** `channel.mjs` is the tools bridge as a Claude Code development channel. On top of the bridge:
  - it declares `claude/channel` and `claude/channel/permission`, and marks the tools `anthropic/alwaysLoad`;
  - core → channel: `{ type: 'prompt', text }` and `{ type: 'permissionAnswer', request_id, behavior }`;
  - channel → core: `{ type: 'permission', request_id, tool_name, description, input_preview }`.
- **Commands.** `prompt` goes as a channel message, with or without `steer`: Claude Code takes a message that arrives during a turn into that turn. `cancel` is tmux `send-keys Escape`.
- **Hooks.** Claude Code's http hooks POST to `/hook`; the core passes each body to the adapter's `hook`, which turns it into `step`, `task`, `turnStart` and `turnEnd`.
- **Approvals.** There are two routes, and the adapter emits one `approval` per dialog:
  - **Relay:** the permission request arrives through the channel.
  - **Terminal:** while the session lives, the adapter polls `tmux capture-pane` every second. A generic parser (question plus numbered options) finds terminal-only dialogs, e.g. the startup development-channel warning or a path outside the workdir.
  - **Which dialogs become cards:** only permission and trust questions (a question with Yes…/No… options, or a known startup warning). Settings pickers such as /model never do.
  - **Identity:** a dialog's signature is its folded question plus its numbered options. A card closes when the pane shows no dialog or a different signature.
  - **Answering:** `answer(id, true)` uses the relay if the dialog came from it. Otherwise it picks "Yes", or else the first option starting with "Yes", or else the first option, always skipping anything containing allow, always, all future, don't ask again, accept edits or auto mode. `answer(id, false)` picks a "No…" option, or Escape.
  - **Keys:** arrows only, never digits. Enter is pressed only when a re-parse shows the cursor on the target and the same signature.
- **Folders.** The user's folders go into the session's `permissions.additionalDirectories`, not `--add-dir`, so starting asks no per-folder trust question.

### Codex adapter (`executors/codex/`)

- **Run.** `codex app-server` runs as a child process, speaking newline-delimited JSON-RPC on stdio (`rpc.mjs`), with `--strict-config`, the login kept in a file (`cli_auth_credentials_store="file"`), and the features `apps`, `plugins`, `computer_use`, `browser_use`, `multi_agent`, `memories` and `image_generation` turned off. Lookma's own OpenAI key is not passed on. It is checked against Codex 0.163.0; app-server is experimental.
- **Isolation.** `CODEX_HOME` is `<data>/sessions/codex/home`, which holds only a link to the user's `auth.json`: the login is shared, while the user's own config, MCP servers and plugins stay out. The thread's working dir is the empty `<data>/sessions/codex/work`, so no `AGENTS.md` is read.
- **Handshake.** `initialize` (with `experimentalApi`, and the streaming deltas and usage notifications opted out), `initialized`, then one `thread/start` for the whole run:
  - `cwd`: the work dir; `model`: `LOOKMA_CODEX_MODEL` or Codex's default; `ephemeral: true`;
  - `approvalPolicy: 'on-request'`, `sandbox: 'workspace-write'`, `config.sandbox_workspace_write: { writable_roots: <the user's dirs>, network_access: false }`;
  - `developerInstructions`: `prompts/executor.md`, after Codex's own base prompt;
  - `config.mcp_servers.lookma`: `mcp.mjs` (the tools bridge) with `LOOKMA_CORE_URL`, `default_tools_approval_mode: 'approve'` and `tool_timeout_sec: 600`, since a hands call may wait on the user's card.
- **Ready** once the thread has started and the bridge has connected; prompts told before that are queued. `mcpServer/startupStatus/updated` with `failed` for `lookma`, or app-server exiting, is `down`.
- **Turns.** The adapter runs prompts and cancels one after another, and picks steer or start from its own record of the running Codex turn:
  - `prompt` → `turn/start { threadId, input: [{ type: 'text', text, text_elements: [] }] }`, or `turn/steer { threadId, input, expectedTurnId }` while a turn runs; a refused steer (the turn has just ended) becomes a `turn/start`;
  - `cancel` → `turn/interrupt { threadId, turnId }`. The core has already ended its turn, so the interrupted turn's `turn/completed` gives no `turnEnd`, and the next prompt waits for it (at most 5 s);
  - `turn/started` → `turnStart`, `turn/completed` → `turnEnd` with `ok` when its status is `completed`; a failed `turn/start`, or app-server exiting mid-turn, is `turnEnd` with `ok: false`;
  - `item/started` → `step`: a command (as Codex reads it, e.g. "Read notes.txt", else the command line), a file change, a web search. The hands, reasoning and messages give none; the model's text replies are only logged.
- **Approvals.** One card per request, id `codex-<request id>`:

  | Request | Card | Approve | Decline |
  |---|---|---|---|
  | `item/commandExecution/requestApproval` | "Run this command?" (or network access, or input to a running command), with the command and Codex's reason | `{ decision: 'accept' }` | `{ decision: 'decline' }` |
  | `item/fileChange/requestApproval` | "Change these files?", with the paths of its file change | `{ decision: 'accept' }` | `{ decision: 'decline' }` |

  Never `acceptForSession`: Approve is this once. If a request does not offer `accept`, Approve answers `decline`. A card closes on `serverRequest/resolved`, at the end of its turn, or when app-server exits. Without a card: `item/permissions/requestApproval` gets no extra permissions, `mcpServer/elicitation/request` is declined and `currentTime/read` is answered. Any other request gets the JSON-RPC error `-32601`, so no request can block a turn.
- **Not used.** `hook`, `task` (Codex's subagents are off) and a startup card.
