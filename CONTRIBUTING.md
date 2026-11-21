# Contributing to Lookma

Thanks for helping. Lookma is small on purpose: a Node core that decides everything, a Swift app that only provides primitives, and a web overlay that draws what the core says. Small, focused changes are the easiest to review and land.

## Set up from source

You need macOS 15+, the Xcode Command Line Tools (`xcode-select --install`), Node.js 20+ and Claude Code, as listed in the [README](README.md#requirements). Google Chrome is needed only for the overlay's browser checks, and an OpenAI key only for voice.

```sh
git clone https://github.com/liuyoshio/lookma
cd lookma
npm ci
app/build.sh            # builds app/build/Lookma.app with swiftc
npm run check && npm test
```

## Run it in development

A normal `lookma` may already be running on port 8790, so give your copy its own port and data folder:

```sh
# terminal 1: the core, without launching the app
LOOKMA_PORT=8793 LOOKMA_DATA=/tmp/lookma-dev LOOKMA_NO_APP=1 LOOKMA_VOICE=off \
node core/cli.mjs start ~/Projects

# terminal 2: the app, straight from your shell
LOOKMA_PORT=8793 app/build/Lookma.app/Contents/MacOS/Lookma
```

- **`LOOKMA_NO_APP=1`** keeps the core from launching the app with `open`. Run the binary yourself instead: it then uses your terminal's Accessibility, Screen Recording and Microphone grants, which survive rebuilds.
- **`LOOKMA_VOICE=off`** is text only: no voice session and no microphone, so nothing goes to OpenAI. With voice on, Lookma listens whenever it runs and is not paused; pause it with ⌃⌥P while you work on it. Type with **Type a Request…** in the menu bar, or post to the core:
  `curl -X POST -H 'Content-Type: application/json' -d '{"text":"open notes"}' http://127.0.0.1:8793/api/tell`
- **Swift changed?** Run `app/build.sh` again. `LOOKMA_SIGN_IDENTITY=-` forces ad hoc signing.
- **Watch the agent** in the core's log: its steps, cards and messages, and for Claude Code the login it uses. A core started from inside another agent's session can inherit that session's API settings; if the login is not yours, start it with a plain environment (`env -i HOME="$HOME" USER="$USER" PATH="$PATH" ...`; Claude Code needs `USER` to find its login in the keychain).
- **The overlay is a plain page.** Open `http://127.0.0.1:8793/` in a browser to see it against your core, or run `node overlay/dev/mock-core.mjs` and open `http://127.0.0.1:8797/?backdrop=1` to replay a scripted scenario on a fake desktop, no core needed.
- **No real screen:** `npm run fake-app -- --port 8793` stands in for the app.

Every variable is in the README's [Configuration](README.md#configuration) table. Ports the dev tools use:

| Port | Used by |
|---|---|
| 8790 | the core (default `LOOKMA_PORT`) |
| 8791 | `npm run test:e2e` |
| 8792 | `core/dev/check-pipeline.mjs`, part of `npm test` |
| 8793 | `executors/codex/dev/check.mjs --handshake` |
| 8794 | `core/dev/check-executors.mjs`, part of `npm test` |
| 8795, 8796 | `overlay/dev/check-voices.mjs` (mock core, Chrome DevTools) |
| 8797, 8798 | `overlay/dev/mock-core.mjs` and `shoot.mjs` (mock core, Chrome DevTools) |

## Test

| Command | Checks | Needs |
|---|---|---|
| `npm run check` | `node --check` on every script | Node |
| `npm test` | the plug-in manifests and settings, the hands pipeline against a fake app and a stub executor, every executor against its fake agent (`executors/<name>/dev/fake-agent.mjs`), each plug-in's own `dev/check.mjs`, voice consent on recorded runs, which turns get a reply, when the microphone is open | No network, no models, no Chrome |
| `node overlay/dev/check-voices.mjs` | the voice client with each voice provider, against its fake service (`voices/<name>/dev/fake.mjs`) | Google Chrome in `/Applications` (runs headless) |
| `node overlay/dev/shoot.mjs` | the overlay through the whole scenario, with screenshots in `overlay/dev/shots/` | Google Chrome in `/Applications` (runs headless) |
| `npm run test:e2e` | a real Claude Code session with the fake app: it gets ready, says hello, and leaves nothing running | A logged-in Claude Code; one short Sonnet turn on your Claude plan |

Run `npm run check && npm test` before every pull request, the two Chrome checks when you touch `overlay/`, and the e2e when you touch `executors/claude/`. CI runs `check`, `test` and the app build on macOS. `LOOKMA_LIVE_TESTS=1 npm test` also mints a voice grant (an OpenAI key) on your OpenAI account; it never runs in CI.

## Code conventions

Match the code around you. In short:

- **ESM, no build step.** The core is `.mjs` on Node built-ins (`node:` imports). The overlay is plain `.js` modules the browser loads as they are. No TypeScript, no bundler.
- **Few dependencies.** Four at runtime (`@modelcontextprotocol/sdk`, `ws`, `zod`, and `@anthropic-ai/claude-agent-sdk`, which only the Claude adapter imports: it is the documented way to interrupt a headless Claude Code. Its bundled `claude` binaries are optional packages, which the repo's `.npmrc` leaves out: Lookma runs the user's own), none for development. A new one needs a reason in the PR.
- **Small modules, one job each**, each opening with a comment that says what it is and how it fits.
- **Comments explain why**, not what the next line does.
- **No dead code:** no commented-out blocks, unused exports, or options for cases that do not exist yet.
- **Style:** two spaces, single quotes and no semicolons in JS; four spaces in Swift. [.editorconfig](.editorconfig) has the rest.
- **Decisions live in the core.** The app provides primitives, the overlay draws state; neither decides anything.
- **Tests are plain scripts** that print `PASS` / `FAIL` lines and exit non-zero on a failure. Add checks to the closest existing script.
- **User-facing text is English.** Anything spoken follows the user's language.

## The protocol and the plug-in contracts

[docs/protocol.md](docs/protocol.md) is the contract between the core, the app, the overlay and the two plug-ins: the WebSockets, the hands pipeline, the [executor contract](docs/protocol.md#executor-contract) and the [voice provider contract](docs/protocol.md#voice-provider-contract). If you change how the pieces talk, update it in the same pull request. [docs/how-it-works.md](docs/how-it-works.md) explains the design behind it.

## Add an agent or a voice

Each is one folder, and the core never names it. The guides walk through every step:

- **An agent:** [docs/writing-an-executor.md](docs/writing-an-executor.md). `executors/<name>/` with a `manifest.mjs`, an `index.mjs` on the executor contract, and a `dev/fake-agent.mjs` that `core/dev/check-executors.mjs` runs the conformance scenarios against. Try it with `--agent <name> --voice off`.
- **A voice:** [docs/writing-a-voice.md](docs/writing-a-voice.md) (provisional until a second voice exists). `voices/<name>/` with a `manifest.mjs`, a `mint.mjs` for the core, a `page.js` for the overlay, and a `dev/fake.mjs` that `overlay/dev/check-voices.mjs` runs the voice against.

Either way: settings are named for you (`LOOKMA_<NAME>_<KEY>`) and listed by `lookma --help` and `lookma doctor`; put them in the README's Configuration table, and give your plug-in a section in docs/protocol.md like the existing ones.

## Commits and pull requests

- **One change per pull request.** Say what it does and why, and link the issue.
- **Commit subjects** are short and imperative ("Show a stopped task as stopped"). Use the body for the why when it is not obvious.
- **Keep the docs true.** A new variable goes into the README's Configuration table; a core one also into `lookma --help` (`core/cli.mjs`) if a new user needs it, while a plug-in's comes from its manifest; a protocol change into docs/protocol.md.
- **Overlay changes** come with a screenshot from `overlay/dev/shots/`.
- **Never commit** `.env`, `app/build/` or `overlay/dev/shots/` (they are in `.gitignore`).

## Privacy rules for fixtures

Fixtures are recordings of real sessions, such as the voice runs in `overlay/dev/fixtures/voice-consent/`. Before you add one:

- **Replace personal paths.** Your home folder becomes `/Users/myname`.
- **No personal data:** no real names, emails, messages, contacts, file names, URLs, tokens or keys. Use made-up English content, like `overlay/dev/scenario.mjs`.
- **No screenshots of your real screen.** The dev harness draws a fake desktop for that.
- **Check before you commit:** `grep -rnF "$HOME" overlay/dev/fixtures` must print nothing, and neither must a grep for your name.

## Security

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md), not in a public issue.
