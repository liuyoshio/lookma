# Protocol (v1)

How the pieces talk. The core holds one model: the turn, the focus (the current hands step) and the user's attention, and every step is visible by default. All user-facing text in the product is English. Anything spoken or narrated follows the language the user speaks.

## Processes

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/architecture-dark.svg">
  <img src="images/architecture.svg" width="100%" alt="You talk to the overlay in Lookma.app, which streams your microphone to OpenAI Realtime while it listens. The overlay and the app connect to the core on 127.0.0.1, which prompts Claude Code and runs each hands step through the app.">
</picture>

Three WebSockets meet at the core: the overlay page on `/ws/overlay`, the app on `/ws/app`, and the executor adapter's own connection on `/ws/executor` (for Claude Code, its MCP proxy).

- **core** (`core/`) is the only place that decides anything. It serves the overlay page at `/`, WebSockets at `/ws/overlay`, `/ws/app` and `/ws/executor`, and HTTP at `/hook`, `/api/state`, `/api/tell` and `/api/voice-key`.
- **app** (`app/`) is launched with `open` so macOS permissions belong to it. It connects back to the core, provides primitives, and the menu bar item (pause, resume, type, quit), and makes no decisions.
- **overlay** (`overlay/`) is a page loaded by the app's full-screen, click-through WKWebView. It renders core state and runs the realtime voice session. It also opens in a normal browser for development.
- **executor adapter** (`core/executors/<name>/`) wraps one agent behind the contract below. v1 ships `claude`.

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
  turn: null | { id, sent, status, phase: 'working' | 'done' | 'failed' | 'cancelled', startedAt, endedAt },
  focus: null | { id, label, action, app, rect, point, phase: 'moving' | 'waiting' | 'acting' | 'done' | 'failed', background, at },
  attention: { busy, idle },
  app: null | { version, permissions },          // the app's hello; null while it is not connected
  cards: [ { id, title, detail, source: 'executor' | 'core', createdAt } ],
  tasks: [ { id, title, status: 'running' | 'done' | 'failed', action, startedAt, endedAt } ],
  paused: false | true }
```

- `turn.sent` is the exact text handed to the executor (the capsule's second row).
- `turn.status` is the latest one-line step description (the third row). Steps that have no screen target, such as reading a file or running a command, only update this line.
- `focus` is the current or last hands step:
  - `rect` is the target's frame and `point` is where the ghost cursor goes;
  - `background: true` means it is acting without bringing the target forward, because the user is busy;
  - `phase: 'waiting'` means it needs the front and is waiting for the user to stop. The overlay shows the edge hint.
- `cards` are pending approvals, oldest first. `source: 'core'` means the core asks for itself, e.g. the first time the hands touch an app.
- `tasks` are background work with no screen presence. It is shown yellow.
- `paused` is true while the user has paused. See Pause and quit below.

Transient events:

```js
{ type: 'say', id, speech, display, kind: 'info' | 'question' | 'confirm' }  // executor wants this said
{ type: 'report', id, taskId, speech, display }                           // a background task finished
```

The overlay speaks these through the voice session when it is quiet; with no voice, it uses on-screen captions. It plays a soft chime when a new card appears.

**Voice session** (`overlay/voice.js`). Always listening, full duplex: while voice is on and not paused, one warm session is connected with the microphone attached.

- **Warm session.** One Realtime WebRTC session, its audio transceiver `sendrecv` with the microphone track. macOS shows its mic indicator. The voice speaks on the same session, and it keeps the conversation across turns.
- **Turns** come from the server: `turn_detection` is `semantic_vad` with `eagerness: 'low'`, `create_response: false` and `interrupt_response: true`. Input `noise_reduction` is `far_field` (`LOOKMA_VOICE_NOISE`). Speech over the voice cuts it off (barge-in).
- **Replies.** The page sends `response.create` only when the turn's transcript is meaningful, one pure tested function: empty transcripts, fillers ("um", "hmm") and short noise fragments ("Tja") are dropped; real short commands ("stop", "pause", "no", "yes, I approve") are kept. If the transcript has not arrived about 2.5 s after the turn, the page responds anyway.
- **Turn records.** Each turn is recorded at `input_audio_buffer.speech_started`: its item id, `startedAt` (when the event arrived) and `overButler` (whether the voice's audio was playing then). Its transcript is matched by item id when it arrives.
- **Health.** The session reconnects in the background when it closes or fails, with backoff. While idle (never mid-turn), it is renewed before the Realtime session limit, with its key minted ahead.
- **Context.** A session that replaces a lost one is first given the pending cards and the `say` and `report` items of the last 5 minutes, as user items marked "from earlier" and with no `response.create`. So "yes, I approve" still answers a card announced on the old session.
- **Queue.** A `say`, a `report` or a new card is spoken when nobody is talking: not while the user speaks, nor while the voice answers. Questions, confirmations and cards go first.
- **Paused:** no session at all, and no microphone. **Voice off** (`LOOKMA_NO_VOICE=1`, no OpenAI key, or `?voice=0`): no session, captions only.

**Voice approval** (`overlay/consent.js`): a spoken answer (approve or decline) counts only when all of these hold:
- it was spoken at least 1 s after the card rendered (the turn's `startedAt`);
- it cannot be the assistant's own voice: said over the voice (`overButler`), it counts unless the voice itself was saying an approval phrase;
- its own transcript, matched by the turn's item id and awaited up to 3 s, is explicit: "yes, I approve", "approved, do it", or a clear "no", "cancel", "don't". A lone "approve" or "go ahead" is not enough, and any hesitation fails.

Otherwise the voice asks again. The card's hint reads: Say “yes, I approve”. Clicking Approve always works.

## Overlay → core

```js
{ type: 'tell', text, source: 'voice' | 'typed' }  // new instruction; the core prompts, or steers if a turn is running
{ type: 'answer', cardId, allow, via: 'voice' | 'click' }
{ type: 'cancel' }                                   // "stop"
{ type: 'goAhead' }                                  // "go ahead" while focus.phase is 'waiting'
{ type: 'pause' }                                    // "pause"
{ type: 'resume' }                                   // end the pause (the page itself never sends it: paused, the mic is off)
{ type: 'log', text }                                // a line for the core's log (the voice's decisions)
```

A whole utterance of just "stop", "go ahead" or "pause", spoken or typed, is sent as the command at once (`commandFor` in `overlay/consent.js`). While a card is up, words answer the card instead.

`POST /api/voice-key` → `{ value, model, expiresAt }`. This is an ephemeral OpenAI Realtime key, with the session config (the voice's instructions from `prompts/butler.md`, its tools from `prompts/butler-tools.json`, transcription (with `language` from `LOOKMA_VOICE_LANGUAGE` when set, and no prompt), server turn detection as above, `max_output_tokens` from `LOOKMA_VOICE_MAX_TOKENS` (default 200), and voice) baked in by the core. The real key never leaves the core.

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

- **Pause** (`pause` from the overlay or the app). If a turn is working, the core cancels it exactly as `cancel` does (the executor's `cancel`, the waiting hands step fails, queued steps drop) and remembers that the pause interrupted it. Then `paused` becomes true. While paused:
  - the overlay closes the voice session entirely (WebRTC closed, mic track stopped) and drops what it had queued to say, so nothing is heard, sent or billed, and the voice stops talking;
  - the capsule shows "Paused" and how to resume: the menu bar or ⌃⌥P;
  - marks clear, and the hands refuse every step;
  - `tell` is refused with the same hint (`POST /api/tell` answers 409).
- **Resume** (`resume` from the app). `paused` becomes false. The overlay reconnects the warm voice session, with the microphone. If the pause interrupted a turn, the core tells the executor "Continue where you left off." as a normal tell (source `resume`).
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
   - steps that need the front (`type`, `key`, a coordinate `click`, `scroll`, opening an app) wait with `focus.phase = 'waiting'` until the user is idle ≥ 3 s or says go ahead (`goAhead`).
4. **Mark.** Set `focus` (label, rect, point). Wait about 350 ms so the ring and ghost cursor arrive before anything happens.
5. **Act** through the app, then set `focus.phase` to `done` or `failed`.
6. **Return** to the executor:
   - `see` → the image plus the element list as text;
   - every other tool → one line saying what happened and what is frontmost now.

## Executor contract

```js
// core/executors/<name>/index.mjs
export function create(ctx)  // ctx: { emit(event), hands(tool, args) → Promise<result>, config, log }
  → { start({ dirs }) → Promise<{ name }>,
      prompt(text, { steer }), cancel(), answer(cardId, allow), stop(),
      connect?(ws), hook?(body) }
```

- `prompt` gets `steer: true` when a turn is already running: the text is a correction to it.
- `connect` gets each socket accepted on `/ws/executor`, and `hook` each body POSTed to `/hook`. An adapter that needs neither leaves them out; the core then closes `/ws/executor` sockets (code 4004).

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

### Claude Code adapter (`core/executors/claude/`)

- **Run.** Interactive `claude` runs in a tmux session (`lookma`; `tmux attach -t lookma` to watch). Its working dir is a generated session dir holding `.mcp.json`, `settings.json` and the executor prompt (`executor.md`, copied from `prompts/executor.md`).
  - Flags: `--model`, `--permission-mode`, `--settings`, `--append-system-prompt-file`, `--dangerously-load-development-channels server:lookma`, then `LOOKMA_CLAUDE_FLAGS` (the user's folders are in the settings, see Folders below).
  - No `--chrome`. The settings deny built-in computer use (`mcp__computer-use`).
- **Proxy.** `channel.mjs` is a stdio MCP server that Claude Code spawns. It connects to `/ws/executor` (the adapter's `connect`) and is a thin pipe:
  - it declares `claude/channel` and `claude/channel/permission`;
  - it exposes the `say` tool and the six hands tools, as `core/tools.mjs` defines them;
  - core → proxy: `{ type: 'prompt', text }` and `{ type: 'permissionAnswer', request_id, behavior }`;
  - proxy → core: `{ type: 'say', … }`, `{ type: 'hands', id, tool, args }` (reply `{ type: 'res', id, ok, result | error }`) and `{ type: 'permission', request_id, tool_name, description, input_preview }`.
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
