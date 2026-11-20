# Security

Lookma drives your real Mac with your permissions, so security reports matter a lot to us.

## Reporting a vulnerability

Please report it privately: on GitHub, open this repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue or pull request for it.

Include what you found, how to reproduce it, and your Lookma (`lookma --version`) and macOS versions. We will reply as soon as we can, keep you posted on the fix, and credit you unless you would rather not be named.

In scope: anything that lets a web page, another app or another user reach the core, approve a card without you, act in an app you did not allow, or send data anywhere other than described below. Text on screen misleading the model is a known limitation (see the README's Privacy and costs section), but a way around the consent check or the app grants is in scope.

## The design, in brief

- The core listens on 127.0.0.1 only, accepts JSON bodies only, and refuses WebSocket connections from web pages.
- No accounts, servers or telemetry: local state stays in `~/.lookma/`, and voice goes to OpenAI, with your key, while Lookma runs and is not paused (the microphone is on then, and macOS shows its indicator).
- Every on-screen step goes through one pipeline in the core: each app is allowed once by you, every step is shown before it happens, and approvals come to you as cards.
