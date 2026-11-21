# AGENTS.md

How to work on Lookma, for AI coding agents (Claude Code, Codex and others) and for people. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup, dev ports, test commands and code style. This file has the principles and working rules behind them. Read both before changing code.

## What Lookma is

A visible, voice-driven computer operator for macOS. You hold fn and talk (or tap fn for a hands-free conversation), and a coding agent operates your real apps on your own screen while you watch. It is a real daily tool, not a demo: optimize for everyday use with real apps and low friction, never for a staged recording.

- **Three parts.** The Node core decides everything. The Swift app only provides primitives (hands, attention, the overlay window). The overlay draws what the core says and runs the voice client. [docs/how-it-works.md](docs/how-it-works.md) explains the design, [docs/protocol.md](docs/protocol.md) is the contract between the parts.
- **Two plug-in ends.** Modularity is a headline feature. The agent that does the work is an executor in `executors/<name>/` (Claude Code, Codex). The voice you talk to is a provider in `voices/<name>/` (OpenAI Realtime today; other providers are planned), selected the same way (`LOOKMA_EXECUTOR`, `LOOKMA_VOICE`). Each plug-in declares its settings and checks in a `manifest.mjs`, which `core/plugins.mjs` alone loads and validates; a setting's name is derived, `LOOKMA_<PLUGIN>_<KEY>`. Adding an agent or a voice should take one folder plus a section in the docs ([writing an executor](docs/writing-an-executor.md), [writing a voice](docs/writing-a-voice.md)), and the core should never know a provider's specifics.
- **English first.** Every UI text, prompt and doc is in English. At runtime, spoken replies follow whatever language the user speaks.

## Design principles

- **First principles, one model.** Before building, name the few core concepts and route every case through one model and one pipeline. Do not grow the design by accretion: no per-app hacks, no special cases bolted on. When feedback arrives, revisit the model before adding a feature.
- **No symptom filters.** A heuristic that filters a component's output (for example, dropping transcripts that "look like noise") is a hack. Fix the component that makes the decision instead.
- **Low coupling, high cohesion.** Each module owns one concern completely, and each concern has exactly one owner. Modules meet only through small, explicit contracts: the executor contract, the hands tools bridge, request/ack messages.
- **Depth over breadth.** Make the agreed scope deeper (concrete mechanisms, numbers, failure modes) instead of adding subsystems. Before adding a component, check whether an existing one, or a feature of the agent itself, already covers it.
- **Validate at boundaries, trust inside.** Check input once where it enters: user input, files and environment variables, network and IPC messages (WebSocket, JSON-RPC, MCP, HTTP), and other processes' output. Inside, assume the data is correct. Do not add repeated null or type checks, optional chaining on values that must exist, try/catch that swallows errors, or "just in case" fallbacks. If an internal assumption breaks, let it throw; catch only where there is a real recovery, such as a reconnect. Defensive code hides bugs and makes the code harder to read. Delete it when you touch a file.
- **Voice should feel human.** Natural turn-taking, short acknowledgements ("OK, opening Maps"), progress that matches what is really happening, no robotic silence and no rambling. Headphones are a first-class setup next to the room microphone, with one model for both, not two pipelines.
- **The microphone opens when the user asks.** The default is the fn key: hold to talk, tap for a hands-free conversation. Always listening (`LOOKMA_TALK=always`) is the option. Both are one turn source (`overlay/voice/source.js`) resting in a different place, never two code paths. Lookma never writes the user's 🌐 setting and never swallows fn; it says what to change.

## Code

Follow the conventions in [CONTRIBUTING.md](CONTRIBUTING.md#code-conventions). In addition:

- No dead code, leftover experiments or options for cases that do not exist yet.
- Comments say why. Keep each file's header comment true when you change the file.
- Keep the docs true in the same change: a wire change goes into docs/protocol.md, a new variable into the README's Configuration table and, for a core setting, `lookma --help` (a plug-in's settings come from its manifest).
- Write code you would be glad to see reviewed in public. The repository is long-lived open source.

## Tests

- **Offline by default.** `npm test` and the dev checks use fakes and recordings and never touch the network. Never call a paid API (the OpenAI Realtime voice, or any OpenAI endpoint billed to the maintainer's key) in a test without asking first and saying roughly how many calls it takes. Live checks sit behind `LOOKMA_LIVE_TESTS=1`.
- **Test by text.** To try a change end to end, start Lookma with `LOOKMA_VOICE=off` (or `--voice off`) and send requests with `POST /api/tell`. Nothing then reaches OpenAI. Agent sessions (Claude Code, Codex) run on the maintainer's subscription: fine, but keep them modest. With voice off fn does nothing, so try the talk key through `overlay/dev/check-voices.mjs`, which drives `window.lookma.key` against the fake voice service.
- **Read the code first; tests are not the proof.** Simple, clear logic should be judged correct by reading it, not by running a hundred tests. A green suite can hide bugs: it only covers the cases someone thought of, and piling on tests is often a sign the logic itself is not clear. If the code needs many tests to be trusted, make it simpler first.
- **Test what is tricky, only.** Timing, races, parsers and state machines (such as the voice floor) get tests. Clear-cut edits (text, prompts, renames, docs) get none, and do not run the whole suite to prove them. Do not add cases just to document behaviour.
- **Harmless apps only.** GUI tests use Maps, Calculator, TextEdit (a new, unsaved document), Finder (read-only) and a browser for searching. Never Mail, Messages, Slack, WeChat, Discord or any other app that can send something on the user's behalf.
- **Leave the running copy alone.** A Lookma may be running on port 8790. Use the dev ports in CONTRIBUTING.md and never stop the user's instance or touch `~/.lookma`. Every running app hears fn, so a dev app runs with voice off.

## Language and privacy in tracked files

- **No CJK in the repository.** No Chinese, Japanese or Korean characters and no full-width punctuation in any tracked file: code, prompts, tests, fixtures, docs, diagrams. macOS `grep` has no `-P`, so scan with Python before every push:

  ```sh
  git ls-files -z | xargs -0 python3 -c 'import re,sys
  bad=re.compile("[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]")
  for f in sys.argv[1:]:
    b=open(f,"rb").read()
    if b"\0" not in b and bad.search(b.decode("utf-8","ignore")): print(f)'
  ```

- **Nothing personal.** No real names (other than the copyright line), emails, home paths, machine names, locations, account names, messages or files in code, fixtures, commits, screenshots or demos. Fixtures follow [CONTRIBUTING.md](CONTRIBUTING.md#privacy-rules-for-fixtures).
- **Commit identity.** Commits use a GitHub noreply address. A global git identity may carry a private email, so set a repo-local one.
- **Screen recordings.** Before recording a demo, clear Maps' Recents and hide the current location, desktop widgets and unrelated windows, and cut anything after the demo ends. Watch the result once before publishing.
- Private notes and plans live outside this repository.

## Public writing

- Lead with visuals. Draw architecture and flows as SVG images with light and dark variants, never ASCII boxes. Keep the text tight.
- Never claim Lookma is the "first" or "only" anything. The positioning is the contrast: most AI agents work where you cannot see them; Lookma works on your screen. Lookma is not a "local agent": the models run in the cloud.

## Working style for agents

- **Do not commit, push or publish unless asked.** Ask before anything outward-facing: posting, sending, opening issues or pull requests elsewhere.
- **One pragmatic review, at most.** No voting panels, refute-by-default reviewers or speculative security layers. The essential security is local-only networking plus explicit user consent for actions. Verify by running the thing, not by debate.
- **Use the strongest model for judgment.** When you split work across sub-agents, put design, critique and final decisions on the most capable model, and mechanical work on cheaper ones.
- **Visual work goes to the maintainer.** Make sure it renders, then hand over the file or preview. No rounds of screenshot self-review.
- **Short copy, written directly.** A post, blurb or message is drafted in one go and iterated on feedback, not run through a multi-draft process.
