# How Lookma works

Lookma keeps one small model of what is going on:

- **the turn**: one request from you and everything it leads to;
- **the focus**: the target the agent is acting on right now, an app plus a rect and a point;
- **your attention**: whether you are using the keyboard or mouse.

Every step is visible by default. The overlay draws only what follows from those three.

This page explains the design. The exact messages are in [protocol.md](protocol.md), the contract between the pieces.

## The pieces

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/architecture-dark.svg">
  <img src="images/architecture.svg" width="100%" alt="You talk to the overlay in Lookma.app, which streams your microphone to OpenAI Realtime while it listens. The overlay passes your words to the core on 127.0.0.1. The core prompts Claude Code, the swappable executor, which calls back with hands steps. The core runs each step through the app's hands in your real apps.">
</picture>

| Piece | Where | What it does |
|---|---|---|
| Core | `core/` | A resident Node process on 127.0.0.1:8790. The only piece that decides anything: it holds the turn, focus, attention and approval cards, runs the hands pipeline and grants the voice its sessions. |
| App | `app/` | `Lookma.app`, a small Swift menu bar app with no Dock icon. It provides primitives and decides nothing: Accessibility (AX) reads and presses, screenshots, keyboard and mouse input, seconds since your last input, and the overlay window. macOS permissions belong to it, so the core launches it with `open`. |
| Overlay | `overlay/` | A web page in the app's full-screen, transparent, click-through window. It draws the capsule, marks and cards, and runs the voice. The window takes clicks only on the card, the Go ahead button and the text box. |
| Executor adapter | `executors/<name>/` | Wraps one agent behind the executor contract: `claude`, Claude Code run headless through the Claude Agent SDK, or `codex`, Codex CLI through its app-server. Its `manifest.mjs` declares its settings and checks. |
| Voice provider | `voices/<name>/` | The voice service, today `openai` (OpenAI Realtime). Its `manifest.mjs` declares its settings, `mint.mjs` runs in the core and mints a short-lived grant for each session, and `page.js` runs in the overlay and connects to the service. The rest of the voice (`overlay/voice/`) is the same for every provider. |
| Prompts | `prompts/` | `butler.md` and `butler-tools.json` for the voice, `executor.md` for the agent. |
| Launcher | `bin/lookma`, `core/cli.mjs` | `bin/lookma` only finds Node and runs `core/cli.mjs`, which checks dependencies, builds the app when its sources changed (`core/app-build.mjs`), and starts the core. `lookma doctor` checks dependencies and permissions. |

## Two plug-ins

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/plug-ins-dark.svg">
  <img src="images/plug-ins.svg" width="100%" alt="Lookma in the middle, the same whatever is plugged in: the overlay, whose floor decides who speaks, and the core, which hosts the plug-ins. On the left, the voice plug-in in voices/<name>/, chosen with LOOKMA_VOICE: page.js in the overlay connects to the voice service, emits voice events and carries out the floor's four effects, and mint.mjs in the core mints a short-lived grant. On the right, the agent plug-in in executors/<name>/, chosen with LOOKMA_EXECUTOR: index.mjs drives the agent with start, prompt, interrupt and close, and reports turnStart, turnEnd, step, task and down. The agent calls say and the hands through the tools bridge, which the core runs.">
</picture>

Both ends of Lookma can be swapped: the agent that does the work and the voice you talk to. Each is one folder with a `manifest.mjs` that says what it needs, behind a small contract, and a host in the core is the only code that loads it. Nothing else knows which one is plugged in.

- **The agent** (`executors/<name>/`, `LOOKMA_EXECUTOR`) is a driver for one agent session. Prompts and an interrupt go down; the agent's activity comes up as five events. The agent gets `say` and the hands from Lookma's tools bridge, so every step on screen still goes through the core. The executor host owns readiness, the order of prompts, the stop gate and one restart, the same for every agent.
- **The voice** (`voices/<name>/`, `LOOKMA_VOICE`) is one voice service in the floor's own terms. Its `page.js` in the overlay turns what the service sends into voice events and carries out four effects; its `mint.mjs` in the core mints a short-lived grant per session, so your API key stays in the core. The floor decides who speaks, and the session keeps the connection healthy, the same for every voice.

What a plug-in cannot do is never declared. An agent without background work simply never reports a task; a voice service that cannot, say, delete a conversation item does the nearest safe thing, and rules the floor already has absorb the difference.

[Writing an executor](writing-an-executor.md) and [Writing a voice](writing-a-voice.md) walk through adding one; [protocol.md](protocol.md#plug-ins) has the exact contracts.

## A turn, end to end

Say “find three ramen places near the ferry and put them in a new note”:

1. **You talk.** You just say it. The overlay streams your microphone to the voice (OpenAI Realtime today), which hears when you stop. The voice starts the work with its `do` tool, keeping your names, numbers and dates; to you it is one assistant doing the work. The capsule shows what it heard and the exact text sent, so a mishearing shows at once.
2. **The core starts a turn** and hands the text to the executor. If a turn is already running, the text goes in as a correction instead: the agent takes it into the work it is doing.
3. **The agent works.** Anything on screen goes through the seven hands tools. Anything else (files, shell commands, web searches) uses the agent's own tools; the adapter reports each step, which shows up as the capsule's status line.
4. **Every hands call runs the pipeline** below, one call at a time.
5. **The agent talks back** with `say`: one short sentence in your language. You hear one assistant: the voice speaks it as soon as nobody is talking, on the same session. Questions, confirmations and approval cards go to the front of the queue. Without voice, these are captions only.
6. **The turn ends** when the agent stops. The capsule shows the result and how long it took, then shrinks away.

## The hands pipeline

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/hands-pipeline-dark.svg">
  <img src="images/hands-pipeline.svg" width="100%" alt="Every hands call (see, click, drag, type, key, scroll, open) runs six steps: resolve, grant, attention, mark, act and observe. If you are idle, the target comes to the front. If you are busy, nothing takes the front: safe steps run in the background and the rest wait for go ahead. Every step returns the app's elements; a screenshot only when asked.">
</picture>

The agent's GUI tools are `see`, `click`, `drag`, `type`, `key`, `scroll` and `open`. Each call carries a `label`, a few words in your language (“Search for ramen”), which the overlay shows at the target. Every call goes through the same steps, in `core/hands.mjs`:

1. **Resolve** the target to an app, a rect and a point:
   - an element id from the latest list. An id stays valid while its element is listed, so two calls sent from one list both work; an id of an element that is gone is an error.
   - a point in the last screenshot's pixels. The app maps it back to screen points, and refuses it once that window has moved.
   - a Dock icon: opening an app means pressing its Dock icon, as a person would.
   - the app itself, for `see`, `type`, `key`, and `scroll` with no element or point.

   A `drag` has two targets, where it starts and where it drops, and both must be in the same app.
2. **Grant.** The first time the hands touch an app, the core raises its own card (“Allow controlling Maps?”). The answer is kept in `~/.lookma/apps.json`. A no ends the step with an error that the agent reads.
3. **Attention.** The app reports the seconds since your last key or mouse event every half second. You count as busy when you used either in the last 3 s.
   - **Not busy:** the target comes to the front.
   - **Busy:** nothing takes the front, the marks step aside, and a yellow tab at the screen edge says where it is working. What happens depends on the step:

   | Step | While you are busy |
   |---|---|
   | `see`, and `click` on an element that supports an AX press | Runs in the background. |
   | `type`, `key`, `scroll`, `open`, `drag`, a right `click`, and `click` at a point or on an element without an AX press | Waits until you pause for 3 s, or until you say “go ahead”. The tab says it is waiting. |

4. **Mark.** The core sets the focus. The overlay moves the coral ring to the target, hangs the label off it and flies the ghost cursor to the point. A drag also gets a dimmer ring on where it drops and a dashed line to it, so you see both ends before the button goes down. Before an action, the core waits about 350 ms so the marks arrive before anything happens. `see` only looks, so it does not wait.
5. **Act** through the app. Input that needs the front is posted only when it will land in the target: the point must be on the target's window, and the target must have keyboard focus. Otherwise the step fails with a reason. The app returns once the effect has had time to show (200 ms after the last event for a click, a drag, a key or text; for a right click, once its menu is up). A drag holds the button about 300 ms before it moves, as apps want, and the ghost cursor holds and glides with it.
6. **Observe.** The core lists the app the step resolved and granted. So the agent does not need a `see` after every action: act, read the list, act again. If listing fails after an action, the action is still reported as done. `open` with a URL or a file lists nothing, since the app it opened in has not been granted yet; the agent's next `see` asks.
7. **Return** to the agent: a line saying what was done, then a text list of elements (id, role, text, and states such as selected or disabled; an open menu's items first), headed by the facts that tell the agent whether the list is enough: whether it was cut short, how many elements have no label, and whether the last screenshot is older than this list. A screenshot comes only when the call asks for one (`screenshot: true`, on any tool): for a canvas, a map or unlabeled icons.

Screenshots contain only the target app's windows, its menus and popups included. The overlay and anything covering the app are left out. The long edge is at most 1280 px.

Saying “stop” aborts the step in flight and everything queued, and interrupts the agent: the Agent SDK's `interrupt()` for Claude Code, `turn/interrupt` for Codex.

## Approvals

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/approvals-dark.svg">
  <img src="images/approvals.svg" width="100%" alt="Three sources raise the same approval card: the Lookma core the first time it touches an app, a Claude Code tool permission, and a Codex request to go beyond its sandbox. You answer by voice, through a consent gate, or by clicking. The answer goes back the way the question came.">
</picture>

Everything that needs your OK is the same thing: one card, answered by voice or by click. Cards come from the core and from the agent:

| Source | Example | How the answer gets back |
|---|---|---|
| Core | “Allow controlling Maps?” | The waiting pipeline step continues, or fails. |
| Claude Code | A tool call its permission mode does not allow by itself, e.g. a command or a path outside the working folders | The answer to the Agent SDK's `canUseTool`. |
| app-server (Codex) | A command or file change that needs more than the sandbox allows | The reply to Codex's request. |

Each agent asks one request at a time, in a structured form, so a card maps to exactly one question and nothing is read off a screen. Approve always means “yes, this once”: Claude Code gets allow for that call, without the rule it suggests for later, and Codex gets `accept`, never `acceptForSession`. Decline answers deny or `decline`, and the agent goes on without that step. A card withdrawn by a stop answers the same as a decline. The card shows what the step would do (the command, the file, the page), never the agent's own options, so it cannot suggest that Approve might mean “always”.

## When it listens

While Lookma runs, voice is on and it is not paused, it listens. You just talk, from the desk or from across the room. With a headset you can talk over the voice to interrupt it. macOS shows its microphone indicator the whole time. Pause from the menu bar, with ⌃⌥P or by saying “pause”, and the microphone is off until you resume.

**One warm session.** The overlay (`overlay/voice.js`) keeps one session of the voice connected, with the microphone attached: with OpenAI Realtime, one WebRTC call. The voice speaks on the same session, so it can tell you something at any time, and it remembers the conversation from one turn to the next. Pausing closes the session; resuming opens a fresh one. With voice off (`LOOKMA_VOICE=off` or no OpenAI key) there is no session and no microphone.

**Turns.** The voice service finds them. OpenAI's uses semantic voice activity detection, at medium eagerness, so a short pause to think does not cut you off. `LOOKMA_AUDIO` says how you hear the voice. In a `room` (the default) noise reduction is `far_field` and the voice finishes its sentence when you talk over it, since what it hears then may be its own echo. With a `headset` it is `near_field` and your speech stops the voice at once. Either way a turn does not answer itself: the service never replies on its own, and the overlay's floor asks for every reply.

**No replies to silence or noise.** A microphone that is always on hears the whole room. So the page asks for a reply only when the turn's transcript means something:

| The transcript | What happens |
|---|---|
| Empty, a filler (“um”, “hmm”) or a short noise fragment (“Tja”) | Dropped. Nothing is said. |
| A real short command: “stop”, “pause”, “no”, “yes, I approve” | Kept, however short. |
| Anything longer | Kept: the voice answers, or calls `do`. |
| Does not arrive within about 2.5 s | The voice answers anyway. |

The decision is one small pure function, with its own tests. Speech that gets through but is not meant for Lookma, such as people talking to each other or a TV, is the voice's call: its instructions (`prompts/butler.md`) tell it to stay silent.

**A terse butler.** The voice answers in one short sentence, in your language and in the first person. It never restates what you asked, adds no filler or acknowledgements, and calls its tools silently, since the screen already shows the work. A reply is capped at `LOOKMA_OPENAI_MAX_TOKENS` (about 200).

**Language.** Set `LOOKMA_VOICE_LANGUAGE` (an ISO code such as `en` or `zh`) and the transcriber is told the language you speak. There is no transcription prompt: it makes the transcriber drop question marks, and the approval check relies on them.

**Health.** If the session closes or fails, the overlay reconnects in the background. Before the service's session time limit, it opens a fresh one while nothing is going on, never in the middle of a turn, with its grant (a short-lived key) minted ahead of time. A session that replaces an old one starts knowing what you were just told: the pending cards and the updates and reports of the last 5 minutes, marked as from earlier, with no reply. So “yes, I approve” still answers a card announced on the old session.

## Voice consent

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/consent-chart-dark.svg">
  <img src="images/consent-chart.svg" width="100%" alt="Bar chart. The voice model alone approved a lone approve-question 15 of 15 times, a go-ahead said 0.3 seconds after the card 11 of 16 times, and its own leaked voice 4 of 12 times. With Lookma's consent gate, 0 of 169 must-not cases were approved.">
</picture>

The voice model hears your audio, and a separate transcriber writes it down. On its own the model approves far too easily (above). A voiced approval needs the model, the transcript and timing to agree (`overlay/consent.js`):

1. **The voice calls `answer(allow=true)`.** Its instructions allow that only after an explicit yes. When it asks, it ends with “Approve?” and never says the approval phrase itself: the card shows the phrase.
2. **You saw the card.** Your answer started (the server heard your speech start) at least 1 s after the card appeared. A “go ahead” meant for something else as the card popped up does not count.
3. **It is not its own echo.** An answer started while the voice was playing counts, because people answer as soon as they see the card. It is refused only when what the voice was saying itself contained an approval phrase.
4. **The transcript is an explicit approval.** The transcript of that same turn, matched by the item id the server gave it, must:
   - use only words from a short list. Any other word, in any language, fails closed: “wait”, “not yet”, “hold on”, a garbled transcript.
   - contain no question mark.
   - pair an approval word with a yes (“yes, I approve”, “OK, do it”), use two approval phrases (“approved, do it”), or be in the first person (“I approve”).

   A lone “approve” or “go ahead” is also how people ask back, so it never counts. Neither does a lone “ok” or “sure”. If the transcript does not arrive within 3 s, nothing is approved.

Declines go through the same checks, with an explicit no instead (“no”, “cancel”, “don’t”). A wrong no is not free either: the agent loses a step you wanted.

When a voiced answer is refused, nothing is sent. The card shows “Not a clear yes” with what was heard, and the voice asks again. The approval words are English, whatever language you speak to it in; you can always click instead. Clicking Approve or Decline always works.

**Commands.** An utterance that is only “stop” (or “cancel”) cancels a running turn at once, without waiting for the voice model. “Go ahead” (or “continue”) resumes a step that is waiting for you. “Pause” pauses: the running turn stops as with “stop”, the voice session closes and the microphone is off until you resume from the menu bar or with ⌃⌥P. Resuming only turns listening back on; the stopped turn stays stopped. This works typed or spoken. While a card is up, your words answer the card instead.

## Background work

Long work with nothing to show on screen goes to Claude Code's background subagents, such as research or a big batch of file edits. They are told not to use `say` or the hands, and they cannot start subagents of their own. Each one ends its final message with a `SAY:` line to speak and a `SHOW:` line to display. The overlay shows running tasks as yellow pills, and the voice reads the report when one finishes. The main session does all screen work itself, because there is one screen and one pair of hands. Codex has no background tasks yet: its subagents are turned off, and everything runs in the turn.

## The executor contract

The core talks to the agent only through an adapter in `executors/<name>/index.mjs`, which the executor host (`core/executor/host.mjs`) loads and runs:

```js
export function create(ctx)  // ctx: { emit, tools: { server, mcp(extras) }, ask, options, instructions, sessionDir, env, log }
  → { start({ dirs }), prompt(text), interrupt(), close() }   // each returns a promise
```

The adapter only translates. Prompts and an interrupt go down; up come `turnStart`, `turnEnd` (with the failure's reason), `step` (a non-GUI step), `task` (background work) and `down`. The agent gets `say` and the hands from the tools bridge, which it spawns from `ctx.tools.mcp()`; the host serves those calls, so the adapter never touches the screen or the outbox. A question for you is `await ctx.ask(card)`. The host owns the rest once, for every agent: the status, the order of prompts, the stop gate (from "stop" until the agent confirms, nothing of the stopped work reaches you or the screen) and one restart when the agent dies or does not stop. Field-level details are in [protocol.md](protocol.md#executor-contract).

How the Claude Code adapter fills it in, through the Claude Agent SDK, which runs your installed `claude`:

| Contract | Claude Code |
|---|---|
| `start` | Starts one `query()` in streaming-input mode, with an empty `work/` in `~/.lookma/sessions/claude/` as its working folder, Claude Code's own system prompt plus `executor.md`, and the tools bridge as its one MCP server. Resolves once that server is connected. |
| `prompt` | One user message into the open input stream. A correction is sent the same way: Claude Code takes a message that arrives during a turn into that turn. |
| `interrupt` | The SDK's `interrupt()`, resolving on the stopped turn's result. |
| `ask` | The SDK's `canUseTool` callback, which waits for the card. |
| `step`, `task` | Claude Code's hooks, as SDK callbacks: `PreToolUse` for the steps, `SubagentStart` and `SubagentStop` for background tasks. |
| `turnEnd`, `turnStart` | The stream's `result` message; a main-agent message while idle, when a finished background task wakes it. |
| `down` | Claude Code exiting by itself. A restart resumes the same conversation by its session id. |

The session is isolated from your own Claude Code: none of your settings, CLAUDE.md, hooks, plugins or MCP servers, only Lookma's settings and tools. Those settings allow `say` and the hands, and deny Claude Code's built-in computer use (the hands are ours) and `AskUserQuestion` (you could not answer it from a card; Claude asks with `say` instead). It uses your own login: on a Claude plan, its work counts against the plan's usage limits, and `lookma doctor` says which login it is.

How the Codex adapter fills it in:

| Contract | Codex |
|---|---|
| `start` | Writes a session folder (`~/.lookma/sessions/codex/`: `home/`, holding only a link to your `auth.json`, and an empty `work/`), starts `codex app-server` with that home, and starts one thread for the session, with `executor.md` as its developer instructions and the tools bridge as its one MCP server. Resolves once that server is up. |
| `prompt` | `turn/start`, or `turn/steer` while a Codex turn runs, so a correction lands in that turn. |
| `interrupt` | `turn/interrupt`, resolving when Codex reports the turn ended. |
| `ask` | Codex's approval requests (a command, a file change, more permissions); the answer goes back as `accept` or `decline`. |
| `step`, `turnStart`, `turnEnd` | `item/started`, `turn/started` and `turn/completed` notifications. |
| `down` | app-server exiting by itself. |

Besides its own shell, file edits and web search, Codex gets only Lookma's tools: its own home keeps your Codex MCP servers, plugins and settings out, and Lookma turns off its connectors, plugins, computer and browser use, subagents, memories and image generation. Its commands run in the workspace-write sandbox, which may write only in the folders you pass to `lookma` (plus its `work/` folder and tmp), with no network; anything beyond that is a card.

**Adding an executor** takes one folder: a manifest, the adapter and a fake agent for the conformance check. [Writing an executor](writing-an-executor.md) walks through it, with a complete minimal adapter.

## Local only

- The core listens on 127.0.0.1 only.
- POST bodies must be `application/json`, so another web page cannot send commands with a plain form.
- WebSocket upgrades are accepted only without an `Origin` header (native clients) or from the core's own origin. Without this check, any web page you visit could drive your computer.
- The voice's API key stays in the core. The overlay gets a short-lived grant: with OpenAI, a key with the voice's instructions and tools baked in.

There are no tokens or accounts beyond that.

## Where things live

| Path | What |
|---|---|
| `~/.lookma/apps.json` | Per-app grants, e.g. `{ "Maps": true, "Notes": false }`. Read on every step, so a hand edit takes effect at once. |
| `~/.lookma/sessions/claude/` | The Claude Code session's working folder, `work/`, empty unless the agent writes there. |
| `~/.lookma/sessions/codex/` | The Codex session folder: `home/` (Codex's home, with a link to your login) and `work/` (its working folder). |
| `app/build/Lookma.app` | The app, built from `app/Sources/` by `app/build.sh`. |
| `.env` | Your settings and `OPENAI_API_KEY`. Real environment variables win. |
