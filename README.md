<p align="center">
  <img src="brand/seal.svg" width="148" alt="Hands, the Lookma seal, balancing a coral ring on its nose">
</p>

<h1 align="center">Lookma</h1>

<p align="center">
  <b>Look ma, no hands. 🦭</b><br>
  The AI agent that actually uses your Mac, right where you can watch.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-FF805C"></a>
  <img alt="macOS 15 or later" src="https://img.shields.io/badge/macOS-15%2B-555">
  <img alt="Node.js 20 or later" src="https://img.shields.io/badge/node-20%2B-555">
  <img alt="Works with Claude Code or Codex" src="https://img.shields.io/badge/works%20with-Claude%20Code%20%7C%20Codex-555">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/bike-dark.svg">
    <img src="brand/bike.svg" width="100%" alt="A person on a stationary bike says 'Hey Lookma, visualize this data for me', and Lookma builds a chart on the living-room TV while they keep pedaling.">
  </picture>
  <br><sub>Tap fn once, then talk to it from across the room.</sub>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/demo-dark.svg">
    <img src="brand/demo.svg" width="100%" alt="Animated demo: a spoken request appears as a caption, a coral ring and a ghost cursor move across two apps on a Mac desktop, an approval card pops up and is approved by voice, and the task finishes.">
  </picture>
</p>

Most AI agents work where you can't see them: in the background, in a cloud browser, in a virtual machine. Lookma works on your screen.

Lookma is a free, open-source app for your Mac. Hold fn and say what you want, in any language, and watch an AI do it in your real apps, on your own screen. It listens only while you ask it to, shows every step, and waits for your yes. The work is done by the coding agent you already have: Claude Code or Codex.


<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#using-it">Using it</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#privacy-and-costs">Privacy</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#limitations">Limitations</a> ·
  <a href="#swap-the-agent-swap-the-voice">Plug-ins</a>
</p>

## Why Lookma

<table>
<tr>
<td width="33%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/feature-see-dark.svg">
  <img src="brand/feature-see.svg" width="100%" alt="A coral ring and a ghost cursor land on a button a moment before it is clicked, with a caption naming the step.">
</picture>

**You see every step.**
Your real apps, on your screen. A coral ring and a ghost cursor land on each target a beat before it acts.
</td>
<td width="33%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/feature-say-dark.svg">
  <img src="brand/feature-say.svg" width="100%" alt="An approval card on screen, and a speech bubble saying yes, I approve.">
</picture>

**You say yes out loud.**
Anything that needs your OK pops up a card. Hold fn and say “yes, I approve”. A lone “ok” never counts.
</td>
<td width="33%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/feature-aside-dark.svg">
  <img src="brand/feature-aside.svg" width="100%" alt="A person typing in one window while the ring waits politely in another.">
</picture>

**It steps aside.**
While you type, it never grabs your window. It waits until you pause, or say “go ahead”.
</td>
</tr>
</table>

## What you see

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/overlay-anatomy-dark.svg">
  <img src="docs/images/overlay-anatomy.svg" width="100%" alt="The overlay, annotated: a coral ring and a ghost cursor on a search field with a step label under it, an approval card, the capsule with your words, what it is doing and its status, the menu bar icon, and the yellow tab that appears while you type.">
</picture>

## Quick start

You need macOS 15+, Node.js 20+, and Claude Code or Codex CLI ([details](#requirements)).

**1. Install**

```sh
git clone https://github.com/liuyoshio/lookma
cd lookma
npm install
npm link
```

**2. Check** that everything is in place. Each problem comes with its fix.

```sh
lookma doctor
```

**3. Start**, with the folders it may work in.

```sh
lookma ~/Projects
```

Then hold <kbd>fn</kbd>, say “turn on dark mode” and let go. To work with Codex instead of Claude Code, start it with `lookma --agent codex ~/Projects`, or set `LOOKMA_EXECUTOR=codex` in `.env`.

> [!NOTE]
> Voice needs an OpenAI API key: `cp .env.example .env` and set `OPENAI_API_KEY`. Without one, Lookma still works by typing (menu bar → **Type a Request…**).

<details>
<summary><b>The first start</b>: the build, three permissions and a card per app</summary>

- **The build.** The first start compiles `Lookma.app` from source into `app/build/` with `swiftc`. It rebuilds whenever its sources change, for example after you pull.
- **Permissions.** macOS asks for three, and for the camera only if you turn on hand gestures. They belong to Lookma, not to your terminal. `lookma doctor` says what is missing, and `lookma doctor --fix` opens the right pane.

  | Permission | For | Asked |
  |---|---|---|
  | Accessibility | reading the UI, clicking, typing | on the first start |
  | Screen Recording | screenshots of the app it works in | on the first start |
  | Microphone | your voice | the first time you hold fn (with `--talk always`, on the first start) |
  | Camera | hand gestures, if you turn them on | the first time you turn them on |

  After you switch on Screen Recording, macOS may want the app reopened: press Ctrl-C and run `lookma` again.
- **One card per app.** The first time it touches an app you get “Allow controlling Notes?”. The answer is kept in `~/.lookma/apps.json`.
- **Signing.** The build signs with your Apple Development or Developer ID certificate if you have one (click **Always Allow** if macOS asks), and ad hoc otherwise. macOS ties the Accessibility and Screen Recording grants to that signature, so with ad hoc signing you grant them again after every rebuild. An old entry can look switched on and do nothing: remove it with the minus button, then start again.

</details>

### Requirements

Always:

| | |
|---|---|
| **macOS 15** or later | the main display |
| **Xcode Command Line Tools** | `xcode-select --install`, for `swiftc` (full Xcode is not needed) |
| **Node.js 20** or later | `brew install node` |
| **OpenAI API key** | optional, for voice |
| **An Apple keyboard** | for the talk key, fn (🌐). On most other keyboards fn never reaches macOS: use the menu bar or `--talk always` |

And one agent:

| Agent | What it needs |
|---|---|
| **[Claude Code](https://github.com/anthropics/claude-code)** (the default) | 2.1.330 or later on your `PATH`, logged in (`claude auth login`). Lookma runs it headless with your login: on a Claude plan, its work counts against the plan's usage limits. `lookma doctor` says which login it uses. |
| **[Codex CLI](https://github.com/openai/codex)** | 0.163.0 or later on your `PATH`, logged in with your ChatGPT account (`codex login`). Choose it with `LOOKMA_EXECUTOR=codex`. |

## Using it

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/talking-dark.svg">
  <img src="docs/images/talking.svg" width="100%" alt="Three timelines of the fn key and the microphone. Hold fn: the microphone opens about 150 ms after the press and closes when you let go, and your words go in. Tap fn: the microphone stays open for a hands-free conversation, until 20 seconds of quiet or another tap. Always listening, the option --talk always: the microphone is open until you pause, and a tap stops the voice mid-sentence.">
</picture>

| To | Do this |
|---|---|
| **Talk** | Hold <kbd>fn</kbd> while you talk, and let go: it answers. A soft tone says the microphone opened and closed. |
| **Talk hands-free** | Tap <kbd>fn</kbd>, or **Start Conversation** in the menu bar. It listens until 20 s of quiet or another tap, and stays open while the work you asked for runs. Any talk it hears restarts the 20 s, even talk it ignores. It answers only what is meant for it, not people talking to each other, the TV or noise. |
| **Ask** | Say it: “Find three ramen places near the ferry and put them in a new note.” |
| **Interrupt** | Hold or tap <kbd>fn</kbd>: the voice stops mid-sentence. |
| **Approve** | Hold <kbd>fn</kbd> and say “yes, I approve”, or click **Approve**. |
| **Decline** | “No” or “cancel”, or click **Decline**. |
| **Change your mind** | Just say so, even mid-task. |
| **Stop** | “Stop.” |
| **Let it carry on** | “Go ahead”, or click **Go ahead** on the yellow tab, or pause for 3 s. |
| **Check in** | “How’s it going?” |
| **Pause** | <kbd>⌃</kbd><kbd>⌥</kbd><kbd>P</kbd>, **Pause** in the menu bar, or say “pause”. The task stops, the voice disconnects and the microphone turns off until you resume. |
| **Resume** | <kbd>⌃</kbd><kbd>⌥</kbd><kbd>P</kbd> again, or **Resume**. The voice is back. The stopped task stays stopped; say “keep going” to carry on. |
| **Always listening** | Start with `--talk always`, or **Listen: Always** in the menu bar for this run. It listens whenever it is not paused, as if a conversation were always open; fn still interrupts. |
| **Use your hand as the mouse** | Turn on **Hand Gestures** in the menu bar: an open hand moves the pointer, a pinch clicks, drags or scrolls, and a fist lets go. See [Hand gestures](#hand-gestures). |
| **Type instead** | **Type a Request…** in the menu bar. Enter sends, Escape closes. |
| **Quit** | **Quit** in the menu bar, or Ctrl-C in the terminal that started it. |

**One voice.** You talk to one assistant, a terse one. It answers in your language, in a sentence, says when something is done, and asks when it needs you, even while the microphone is closed. With a headset you can also just talk over it to interrupt.

**The menu bar seal** fills its ring while the microphone is open, shows a pause sign while paused, and dims when the app has lost the core. Its menu also switches how you talk for this run (**Listen: With the fn Key** or **Always**), with the key starts or ends a hands-free conversation, and turns **Hand Gestures** on or off for this run. If Lookma may not use the camera, the item reads **Hand Gestures: Allow Camera…** and opens System Settings → Privacy & Security → Camera.

**The fn key is also 🌐.** Set System Settings → Keyboard → **Press 🌐 key to** → **Do Nothing**, or a tap of fn also switches the input source, opens Emoji & Symbols or starts Dictation. If you switch input sources with 🌐, <kbd>⌃</kbd><kbd>Space</kbd> does the same. If Dictation's shortcut (Keyboard → Dictation) is **Press 🌐 Twice**, pick another, or two quick taps start Dictation. `lookma doctor` and `lookma start` warn about the first (with `--talk always` it is only a note), and `lookma doctor --fix` opens the Keyboard pane. Lookma never changes either setting itself.

### Hand gestures

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/gestures-dark.svg">
  <img src="docs/images/gestures.svg" width="100%" alt="The camera runs in the overlay page, where MediaPipe's hand landmarker finds 21 points of your hand in each frame, on this Mac. Only those points go to the app: its gesture engine decides what the mouse should do, and a 120 Hz pointer loop moves the real mouse there. Four states: point with an open hand, and the pointer follows the base of your ring finger; pinch thumb and index to press the button, for a click, a double-click or a drag; pinch thumb and middle and move up or down to scroll the window under the pointer; make a fist or drop your hand to park, and the pointer stays and a held button lets go. A hand never opened flat in view moves nothing, and a pinch carried into view presses nothing.">
</picture>

Your hand is the mouse. Off by default: turn on **Hand Gestures** in the menu bar, or start with `--gestures on`. While they are on and Lookma is not paused, the camera runs (its green light is on), and your hand moves the real pointer, so what it is over is what you click and scroll.

| Gesture | Do this | What happens |
|---|---|---|
| **Point** | Open your hand, fingers straight | The pointer follows the base of your ring finger, smoothly. The middle 70% of the camera's view spans the screen. A still hand is a still pointer. |
| **Click and drag** | Pinch your thumb and index finger together | The mouse button is down while you pinch and up when you part them: a quick pinch is a click, two are a double-click, and moving while you pinch drags. |
| **Scroll** | Pinch your thumb and middle finger together, then move your hand up or down | The window under the pointer scrolls with your hand, and the pointer stays put. Let go mid-flick and it coasts a little. |
| **Park** | Make a fist, or drop your hand out of view | The pointer stays where it is and a held button lets go, like lifting a mouse off the desk. Open your hand to pick it up again. |

**Nothing by accident.** A hand moves the pointer only after it has been opened flat in view, so a hand resting, typing or holding a cup does nothing. A pinch counts only when you make it in view, so a hand that comes in holding a pen presses nothing until it opens. Gestures are made for desk distance, within about an arm's length of the camera; a hand farther away, like someone behind you, is ignored. One hand at a time: a second hand coming into view does not take the pointer. Your hand mouse is your input, so while you move it the agent waits for the front, as it does while you type.

**Watch the agent itself.** Both agents log their steps, cards and messages in the terminal that started Lookma.

**From a script**, post your request to the core's `/api/tell` ([protocol](docs/protocol.md#overlay--core)).

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/architecture-dark.svg">
  <img src="docs/images/architecture.svg" width="100%" alt="You talk to the overlay in Lookma.app, which streams your microphone to OpenAI Realtime while it listens. The overlay passes your words to the core on 127.0.0.1. The core prompts Claude Code, the swappable executor, which calls back with hands steps. The core runs each step through the app's hands in your real apps.">
</picture>

The voice does no work: it passes your exact words to the core, which hands them to the agent, Claude Code or Codex. The agent touches the screen only through seven *hands* tools, so every on-screen step goes through the core: **resolve → grant → attention → mark → act → observe**, and returns the app's elements to the agent. Files, shell commands and web searches use the agent's own tools and show up as status lines.

### A yes means yes

The voice model on its own approves far too easily. So a spoken yes counts only when it is explicit (“yes, I approve”, never a lone “ok” or “approve?”), said at least 1 s after the card appeared, not the assistant's own voice, and confirmed by a separate transcript.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/consent-chart-dark.svg">
  <img src="docs/images/consent-chart.svg" width="100%" alt="Bar chart. The voice model alone approved a lone approve-question 15 of 15 times, a go-ahead said 0.3 seconds after the card 11 of 16 times, and its own leaked voice 4 of 12 times. With Lookma's consent gate, 0 of 169 must-not cases were approved.">
</picture>

More: [how it works](docs/how-it-works.md), with the hands pipeline, approvals, voice consent and hand gestures drawn out, and [the protocol](docs/protocol.md) between the pieces.

## Privacy and costs

- **Local.** The core listens on 127.0.0.1 only and refuses connections from web pages. No accounts, no telemetry, no servers of ours.
- **The microphone is closed until you ask.** It opens while you hold fn or a conversation is open, and only then does audio go to OpenAI; macOS shows its microphone indicator for exactly that time. In between, the voice stays connected so it can speak to you, but hears nothing. With `--talk always` the microphone is open, and streams to OpenAI, whenever Lookma runs and is not paused, so it hears the room. Paused, the voice session is closed and nothing is sent.
- **The camera is off unless you turn on hand gestures.** Then it runs while Lookma is not paused, and macOS's green light shows it. Google's MediaPipe finds your hand in the overlay page, on this Mac, from files the core serves locally: frames stay in the page, and only the hand's 21 points per frame reach the app. No image, hand position or gesture is stored or sent, and neither the agent nor the voice sees them. The log says when the hand mouse goes live or parks, never where your hand was. MediaPipe is pinned to a version (0.10.35) without the usage metrics its 1.x line sends to Google.
- **Voice goes to OpenAI.** It also gets the text it reads to you: replies, reports and card text. Your API key stays in the core. It is billed to your key, per use. Without a key, or with `LOOKMA_VOICE=off`, nothing goes to OpenAI and the microphone stays closed.
- **Claude Code uses your Claude plan, Codex your ChatGPT plan**, as usual. The agent's model sees screenshots and UI text of the app it works in (only that app's windows, never the overlay), plus the files, commands and pages it uses.
- **Nothing else leaves your Mac.** Local state is in `~/.lookma/`.

**Safety.** It drives your real computer with your permissions. You allow each app once, and the agent's permission prompts come to you as cards. The agent is told to ask before anything irreversible or outward-facing (sending, posting, paying, deleting) that goes beyond what you said, but that is an instruction to the model, not an enforced gate. Text on screen can mislead the model, so watch it on anything that matters. Codex's commands run in its sandbox: they may write only in the folders you passed, with no network, and anything more asks you with a card. For more cards with Claude Code, set `LOOKMA_CLAUDE_PERMISSION_MODE=default`.

## Configuration

Set these in `.env` at the repo root, in your shell, or on the command line. A flag wins over the environment, which wins over `.env`. The main switches have their own flags, and `--set NAME=value` sets any other:

```sh
lookma --agent codex --audio headset ~/Projects
lookma --talk always ~/Projects  # always listening, no key
lookma --voice off --set LOOKMA_CLAUDE_MODEL=opus ~/Projects
lookma config --agent codex      # print the settings in effect, and where each came from
```

| Flag | Setting | Values |
|---|---|---|
| `--agent` | `LOOKMA_EXECUTOR` | `claude` (default) or `codex` |
| `--voice` | `LOOKMA_VOICE` | `openai` (default) or `off` |
| `--audio` | `LOOKMA_AUDIO` | `room` (default) or `headset` |
| `--talk` | `LOOKMA_TALK` | `key` (default) or `always` |
| `--gestures` | `LOOKMA_GESTURES` | `off` (default) or `on` |

The agent and the voice are plug-ins (folders in `executors/` and `voices/`), and each declares its own settings, named `LOOKMA_<PLUGIN>_<SETTING>`. `lookma --help` lists those of the agent and voice you selected, and `lookma doctor` shows the ones in effect and warns about any `LOOKMA_*` variable that Lookma does not read, such as a misspelled one.

| Variable | Default | What it does |
|---|---|---|
| `LOOKMA_EXECUTOR` | `claude` | The agent: `claude` (Claude Code) or `codex` (Codex CLI). |
| `LOOKMA_VOICE` | `openai` | The voice: `openai` (OpenAI Realtime) or `off`, text only: nothing is sent to OpenAI. |
| `LOOKMA_VOICE_LANGUAGE` | detected | The language you speak, as an ISO code (`en`, `zh`, `ja`), for a better transcript. |
| `LOOKMA_AUDIO` | `room` | How you hear the voice: `room` (speakers) or `headset`. With a headset, talking over the voice cuts it off; in a room it finishes its sentence. Sets the microphone's noise reduction to match. |
| `LOOKMA_TALK` | `key` | How you talk to the voice: `key` (it listens while you hold fn; a tap of fn keeps it listening, hands-free, until 20 s of quiet or another tap) or `always` (it listens whenever it is not paused). In both, holding fn gives you the floor and a tap stops the voice mid-sentence. The menu bar changes it for one run. |
| `LOOKMA_GESTURES` | `off` | Hand gestures from the camera: `on` runs the camera while Lookma is not paused, and your hand moves the pointer, clicks and scrolls. Frames stay in the overlay page on this Mac and are never stored or sent. The menu bar changes it for one run. |
| `LOOKMA_PORT` | `8790` | The core's port, on 127.0.0.1. |
| `LOOKMA_DATA` | `~/.lookma` | Per-app grants (`apps.json`) and the generated session folder. |
| `LOOKMA_SIGN_IDENTITY` | your first signing identity, else ad hoc | Code signing for the app build; `-` forces ad hoc. Environment only. |
| `LOOKMA_NO_APP` | | `1`: do not launch the app (for development). |

**Claude Code** (`LOOKMA_EXECUTOR=claude`)

| Variable | Default | What it does |
|---|---|---|
| `LOOKMA_CLAUDE_MODEL` | `sonnet` | The model (`--model`), e.g. `opus`, or `haiku` for faster everyday steps. |
| `LOOKMA_CLAUDE_EFFORT` | the model's default | Reasoning effort: `low`, `medium`, `high`, `xhigh` or `max`. Lower is faster. |
| `LOOKMA_CLAUDE_PERMISSION_MODE` | `auto` | The permission mode; `default` gives more cards. |
| `LOOKMA_CLAUDE_FLAGS` | | Extra flags for `claude`, separated by spaces. |

**Codex** (`LOOKMA_EXECUTOR=codex`)

| Variable | Default | What it does |
|---|---|---|
| `LOOKMA_CODEX_MODEL` | Codex's default | The model. |
| `LOOKMA_CODEX_FAST` | `0` | `1`: the Fast speed tier, quicker and uses more of your ChatGPT plan. |
| `CODEX_HOME` | `~/.codex` | Your Codex folder, whose login (`auth.json`) Lookma shares. |

**OpenAI Realtime** (`LOOKMA_VOICE=openai`)

| Variable | Default | What it does |
|---|---|---|
| `OPENAI_API_KEY` | | Turns on voice. Without it you type instead. |
| `LOOKMA_OPENAI_MODEL` | `gpt-realtime-2.1` | The voice model. |
| `LOOKMA_OPENAI_VOICE` | `marin` | The voice it speaks with. |
| `LOOKMA_OPENAI_TRANSCRIBE_MODEL` | `gpt-realtime-whisper` | Writes down what you say, for captions and the approval check. |
| `LOOKMA_OPENAI_MAX_TOKENS` | `1000` | A safety net on one reply, in tokens, its audio included. Replies are kept short by the voice's instructions. |

Per-app answers live in `~/.lookma/apps.json` (`{ "Maps": true, "Notes": false }`), read on every step. How the voice and the agent behave is plain text in `prompts/butler.md` (read for every new voice session) and `prompts/executor.md` (read on the next start).

## Limitations

- **macOS only, main display only.**
- **Drag works inside one app.** The hands see, click (right-click menus included), drag, type, press keys, scroll and open apps, URLs and files; a drag from one app to another is not supported.
- **Not fast.** A task of a few steps takes 10–20 s, mostly model thinking. Each action waits about 350 ms so you see the target first, and about 200 ms after for the app to settle; it then returns the app's elements, so the agent needs no extra look. The core's log has a `step` line per hands call that says where its time went.
- **Claude Code runs headless**, through the Claude Agent SDK (checked against 2.1.330). On a Claude plan this counts against the plan's usage limits, as Anthropic counts headless use today; that may change, and `lookma doctor` shows the login in use.
- **Voice approval understands English and Chinese**; in other languages, click.
- **Codex runs through its app-server**, which Codex marks experimental and changes between releases (checked against 0.163.0). With Codex there are no background tasks yet: all work happens in the turn.
- **One at a time:** one port, one agent session.
- **The talk key needs an Apple keyboard.** On most other keyboards fn never reaches macOS: use **Start Conversation** in the menu bar, or `LOOKMA_TALK=always`. While a password field has focus (macOS Secure Input), no app sees fn.
- **The hand mouse is a left button and a wheel.** No right-click, no zoom, and the pointer stays on the main display. It works at desk distance and needs some light on your hand. It uses the default camera, with no camera picker; if that camera goes away (unplugged), the menu reads **Hand Gestures: No Camera** until a camera is connected or you turn gestures off and on.
- **Hands-free, it hears the room.** In a conversation, or with `--talk always`, it stays quiet for speech that is not meant for it, but a TV or a conversation nearby can still start a turn now and then. Hold fn instead when that matters.

## Swap the agent, swap the voice

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/plug-ins-dark.svg">
  <img src="docs/images/plug-ins.svg" width="100%" alt="Lookma in the middle, the same whatever is plugged in. On the left, the voice plug-in in voices/<name>/, chosen with LOOKMA_VOICE: page.js in the overlay talks to the voice service and mint.mjs in the core mints a short-lived grant. On the right, the agent plug-in in executors/<name>/, chosen with LOOKMA_EXECUTOR: index.mjs drives the agent with start, prompt, interrupt and close. The agent calls say and the hands through the tools bridge, which the core runs.">
</picture>

Both ends are plug-ins: a folder each, picked with one setting or flag.

| | Agent | Voice |
|---|---|---|
| Pick it | `--agent codex` or `LOOKMA_EXECUTOR=codex` | `--voice off` or `LOOKMA_VOICE=off` |
| Ships with | `claude` (default), `codex` | `openai` (default), or `off` to type instead |
| Its folder | `executors/<name>/` | `voices/<name>/` |
| Its settings | `LOOKMA_CLAUDE_*`, `LOOKMA_CODEX_*` | `LOOKMA_OPENAI_*`, `OPENAI_API_KEY` |
| Write one | [Writing an executor](docs/writing-an-executor.md) | [Writing a voice](docs/writing-a-voice.md) (provisional) |

Whatever is plugged in, the agent touches the screen only through Lookma's hands, so every step stays visible, granted and stoppable, and the voice only talks: the floor in the overlay decides when. `lookma --help` lists the settings of the agent and voice you picked.

## Roadmap

Lookma is built to swap both ends: the agent that does the work, and the voice you talk to. Today it ships with two agents, Claude Code and Codex, and one voice, OpenAI Realtime (the voice contract is provisional until a second voice exists). Next, in order:

1. **Gemini Live** as a second voice.
2. **An offline voice**: on-device speech recognition and the system voice. Free, and nothing leaves your Mac.
3. **An on-device “Hey Lookma” wake word**, as an option next to the fn key.

Adapters for other agents (Gemini CLI, Aider, OpenCode, …) and other voices are very welcome. See [Swap the agent, swap the voice](#swap-the-agent-swap-the-voice) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Issues and pull requests are welcome. Keep changes small, and when you change how the pieces talk, update [docs/protocol.md](docs/protocol.md) in the same change.

```sh
npm run check      # syntax check
npm test           # pipeline vs a fake app, both agents vs stand-ins, voice consent, turn filtering; no models called
npm run test:e2e   # one short turn of a real Claude Code session on your plan (port 8791)
```

The diagrams are drawn by `node docs/images/src/draw.mjs`, in a light and a dark version each.

Hand gestures track your hand with Google's [MediaPipe](https://github.com/google-ai-edge/mediapipe) hand landmarker (`@mediapipe/tasks-vision` and its model, Apache-2.0; the model and its license are in `overlay/hand/`). The hand mouse learned from [handTrack](https://github.com/small-cactus/handTrack) (the interaction model and its numbers: the ring finger's base as the pointer, the eased pointer and its dead zone, the pinches), [Pawvis](https://github.com/alexandriax/pawvis) (the open-hand gate), [Precog](https://github.com/lulu38m/precog-macos) (the finger-straightness test) and [Gstrl](https://github.com/tomyang-tz/Gstrl) (the private event source), all MIT. Their ideas and numbers are adapted; no code is copied.

Built on [Claude Code](https://github.com/anthropics/claude-code), [Codex CLI](https://github.com/openai/codex), the [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime), the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript), [ws](https://github.com/websockets/ws) and [zod](https://zod.dev).

## License

MIT. See [LICENSE](LICENSE).

<p align="center">
  <img src="brand/seal.svg" width="56" alt=""><br>
  <sub>Hands has no hands. Its one rule: <b>no approval, no seal.</b></sub>
</p>
