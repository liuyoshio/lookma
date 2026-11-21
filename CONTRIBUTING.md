# Contributing to Lookma

Thanks for helping. Lookma is small on purpose: a Node core that decides everything, a Swift app that only provides primitives, and a web overlay that draws what the core says. Small, focused changes are the easiest to review and land.

## Set up from source

You need macOS 15+, the Xcode Command Line Tools (`xcode-select --install`), Node.js 20+, tmux and Claude Code, as listed in the [README](README.md#requirements). Google Chrome is needed only for the overlay's browser checks, and an OpenAI key only for voice.

```sh
git clone https://github.com/liuyoshio/lookma
cd lookma
npm ci
app/build.sh            # builds app/build/Lookma.app with swiftc
npm run check && npm test
```

## Run it in development

A normal `lookma` may already be running on port 8790 with tmux session `lookma`, so give your copy its own port, session and data folder:

```sh
# terminal 1: the core, without launching the app
LOOKMA_PORT=8793 LOOKMA_EXEC_SESSION=lookma-dev LOOKMA_DATA=/tmp/lookma-dev \
LOOKMA_NO_APP=1 LOOKMA_VOICE=off node core/cli.mjs start ~/Projects

# terminal 2: the app, straight from your shell
LOOKMA_PORT=8793 app/build/Lookma.app/Contents/MacOS/Lookma
```

- **`LOOKMA_NO_APP=1`** keeps the core from launching the app with `open`. Run the binary yourself instead: it then uses your terminal's Accessibility, Screen Recording and Microphone grants, which survive rebuilds.
- **`LOOKMA_VOICE=off`** is text only: no voice session and no microphone, so nothing goes to OpenAI. With voice on, Lookma listens whenever it runs and is not paused; pause it with ⌃⌥P while you work on it. Type with **Type a Request…** in the menu bar, or post to the core:
  `curl -X POST -H 'Content-Type: application/json' -d '{"text":"open notes"}' http://127.0.0.1:8793/api/tell`
- **Swift changed?** Run `app/build.sh` again. `LOOKMA_SIGN_IDENTITY=-` forces ad hoc signing.
- **Watch Claude Code** with `tmux attach -t lookma-dev`.
- **The overlay is a plain page.** Open `http://127.0.0.1:8793/` in a browser to see it against your core, or run `node overlay/dev/mock-core.mjs` and open `http://127.0.0.1:8797/?backdrop=1` to replay a scripted scenario on a fake desktop, no core needed.
- **No real screen:** `npm run fake-app -- --port 8793` stands in for the app.

Every variable is in the README's [Configuration](README.md#configuration) table. Ports the dev tools use:

| Port | Used by |
|---|---|
| 8790 | the core (default `LOOKMA_PORT`) |
| 8791 | `npm run test:e2e` (tmux session `lookma-test`) |
| 8792 | `core/dev/check-pipeline.mjs`, part of `npm test` |
| 8795, 8796 | `overlay/dev/check-voices.mjs` (mock core, Chrome DevTools) |
| 8797, 8798 | `overlay/dev/mock-core.mjs` and `shoot.mjs` (mock core, Chrome DevTools) |

## Test

| Command | Checks | Needs |
|---|---|---|
| `npm run check` | `node --check` on every script | Node |
| `npm test` | the plug-in manifests and settings, the hands pipeline against a fake app and a stub executor, the Claude adapter on recorded terminal screens, the session each voice provider asks for, voice consent on recorded runs, which turns get a reply | No network, no models, no Chrome. tmux is optional: one check is skipped without it |
| `node overlay/dev/check-voices.mjs` | the voice client with each voice provider, against its fake service (`voices/<name>/dev/fake.mjs`) | Google Chrome in `/Applications` (runs headless) |
| `node overlay/dev/shoot.mjs` | the overlay through the whole scenario, with screenshots in `overlay/dev/shots/` | Google Chrome in `/Applications` (runs headless) |
| `npm run test:e2e` | a real Claude Code session with the fake app | tmux and a logged-in Claude Code; uses your Claude plan |

Run `npm run check && npm test` before every pull request, the two Chrome checks when you touch `overlay/`, and the e2e when you touch `executors/claude/`. CI runs `check`, `test` and the app build on macOS. `LOOKMA_LIVE_TESTS=1 npm test` also mints a voice grant (an OpenAI key) on your OpenAI account; it never runs in CI.

## Code conventions

Match the code around you. In short:

- **ESM, no build step.** The core is `.mjs` on Node built-ins (`node:` imports). The overlay is plain `.js` modules the browser loads as they are. No TypeScript, no bundler.
- **Few dependencies.** Three at runtime (`@modelcontextprotocol/sdk`, `ws`, `zod`), none for development. A new one needs a reason in the PR.
- **Small modules, one job each**, each opening with a comment that says what it is and how it fits.
- **Comments explain why**, not what the next line does.
- **No dead code:** no commented-out blocks, unused exports, or options for cases that do not exist yet.
- **Style:** two spaces, single quotes and no semicolons in JS; four spaces in Swift. [.editorconfig](.editorconfig) has the rest.
- **Decisions live in the core.** The app provides primitives, the overlay draws state; neither decides anything.
- **Tests are plain scripts** that print `PASS` / `FAIL` lines and exit non-zero on a failure. Add checks to the closest existing script.
- **User-facing text is English.** Anything spoken follows the user's language.

## The protocol and the executor contract

[docs/protocol.md](docs/protocol.md) is the contract between the core, the app, the overlay and the executor: the WebSockets, the hands pipeline and the [executor contract](docs/protocol.md#executor-contract). If you change how the pieces talk, update it in the same pull request. [docs/how-it-works.md](docs/how-it-works.md) explains the design behind it.

## Add an executor adapter

1. Create `executors/<name>/manifest.mjs`: a title, your settings and your checks, as `executors/codex/manifest.mjs` has them. A setting's name is derived (`LOOKMA_<NAME>_<KEY>`), and `lookma --help` and `lookma doctor` list it; the loader, `core/plugins.mjs`, validates the manifest and the values.
2. Create `executors/<name>/index.mjs` exporting `create(ctx)`, where `ctx` is `{ emit, hands, config, options, log }` and `options` are your settings, typed and checked. Return `{ start({ dirs }), prompt(text, { steer }), cancel(), answer(cardId, allow), stop() }`. `start` resolves to `{ name }`; `steer` is true when a turn is already running. Add `connect(ws)` if your agent connects back on `/ws/executor`, and `hook(body)` if it POSTs to `/hook`.
3. Emit the contract's events: `status`, `turnStart` / `turnEnd`, `step`, `say`, `task`, and one `approval` per question for the user, with `approvalGone` once it is answered elsewhere or closed.
4. Give the agent `say` and the six hands tools (`see`, `click`, `type`, `key`, `scroll`, `open`), as `core/tools.mjs` defines them, and forward each hands call to `ctx.hands(tool, args)`. Never touch the screen any other way: the pipeline is what makes every step visible and granted.
5. Run it with `LOOKMA_EXECUTOR=<name>` or `--agent <name>`.

The stub executor at the top of `core/dev/check-pipeline.mjs` is the smallest working adapter. Test your adapter's pure parts against recorded fixtures, as `core/dev/check-claude.mjs` does, and give it a section in docs/protocol.md like the Claude Code one.

## Commits and pull requests

- **One change per pull request.** Say what it does and why, and link the issue.
- **Commit subjects** are short and imperative ("Parse the trust dialog of 2.1.329"). Use the body for the why when it is not obvious.
- **Keep the docs true.** A new variable goes into the README's Configuration table; a core one also into `lookma --help` (`core/cli.mjs`) if a new user needs it, while a plug-in's comes from its manifest; a protocol change into docs/protocol.md.
- **Overlay changes** come with a screenshot from `overlay/dev/shots/`.
- **Never commit** `.env`, `app/build/` or `overlay/dev/shots/` (they are in `.gitignore`).

## Privacy rules for fixtures

Fixtures are recordings of real sessions: terminal screens in `core/dev/fixtures/claude-captures/` and voice runs in `overlay/dev/fixtures/voice-consent/`. Before you add one:

- **Replace personal paths.** Your home folder becomes `/Users/myname`, as in the existing captures.
- **No personal data:** no real names, emails, messages, contacts, file names, URLs, tokens or keys. Use made-up English content, like `overlay/dev/scenario.mjs`.
- **No screenshots of your real screen.** The dev harness draws a fake desktop for that.
- **Check before you commit:** `grep -rnF "$HOME" core/dev/fixtures overlay/dev/fixtures` must print nothing, and neither must a grep for your name.

## Security

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md), not in a public issue.
