// Lookma app: the overlay window (its page owns the voice session), the hands and attention, the
// talk key (fn, whose edges go to the page), and the menu bar item with the ⌃⌥P pause hotkey,
// connected to the core over /ws/app. It provides primitives and makes no decisions
// (docs/protocol.md).
//   LOOKMA_PORT          the core's port (default 8790)
//   LOOKMA_OVERLAY_URL   the page to load (default http://127.0.0.1:$LOOKMA_PORT/)
//   LOOKMA_CHECK=<file>  check mode for `lookma doctor` (below)
//   kill -USR1 <pid>     show or hide the typed input (debug path; the menu bar has "Type a Request…")
import AppKit
import ApplicationServices

setvbuf(stdout, nil, _IOLBF, 0)
let env = ProcessInfo.processInfo.environment

// Check mode: write the permissions macOS grants this app to the file as JSON
// ({ accessibility, screen, microphone }) and exit at once: no window, no prompt, no connection.
if let file = env["LOOKMA_CHECK"] {
    let data = try? JSONSerialization.data(withJSONObject: permissions())
    exit(FileManager.default.createFile(atPath: file, contents: data) ? 0 : 1)
}

let port = Int(env["LOOKMA_PORT"] ?? "") ?? 8790

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
AXUIElementSetMessagingTimeout(systemWide, 1.0)
// The overlay, the attention beat and the socket must keep full speed in the background.
let activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "Lookma overlay and hands")

// macOS lists the app under Accessibility and Screen Recording once it asks; the user flips the switch.
if !AXIsProcessTrusted() {
    AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
}
if !CGPreflightScreenCaptureAccess() { CGRequestScreenCaptureAccess() }

let overlay = Overlay(url: URL(string: env["LOOKMA_OVERLAY_URL"] ?? "http://127.0.0.1:\(port)/")!)
let link = Link(url: URL(string: "ws://127.0.0.1:\(port)/ws/app")!)

// The menu bar item and ⌃⌥P only ask the core; it says back whether it is paused and how the user
// talks. The page says whether its voice is on, the microphone open and a conversation open.
let menu = StatusMenu()
link.onPaused = { menu.paused = $0 }
link.onTalk = { menu.talk = $0 }
overlay.onVoice = { menu.voice = $0 }
func togglePause() {
    guard let paused = menu.paused else { return }
    link.send(["type": paused ? "resume" : "pause"])
}
menu.onToggle = togglePause
menu.onTalk = { link.send(["type": "talk", "mode": $0.rawValue]) }
menu.onConversation = { overlay.key(.toggle) }
menu.onType = { overlay.setTyping(true) }
menu.onQuit = {
    // The core shuts down, Claude Code included, and tells the app to quit. Without a core, or
    // without an answer, the app quits by itself.
    guard link.connected else { return app.terminate(nil) }
    log("asking the core to quit")
    link.send(["type": "quit"])
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { app.terminate(nil) }
}
registerPauseHotkey(togglePause)
let talkKey = TalkKeyWatcher { overlay.key($0) }
link.start()

// Every exit path turns off the AX attributes we set on other apps.
final class Delegate: NSObject, NSApplicationDelegate {
    func applicationWillTerminate(_ note: Notification) { restoreAX() }
}
let delegate = Delegate()
app.delegate = delegate

var signalSources: [DispatchSourceSignal] = []
func onSignal(_ sig: Int32, _ handler: @escaping () -> Void) {
    signal(sig, SIG_IGN)
    let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    s.setEventHandler(handler: handler)
    s.resume()
    signalSources.append(s)
}
for sig in [SIGTERM, SIGINT, SIGHUP] {
    onSignal(sig) {
        log("exiting on signal \(sig)")
        restoreAX()
        exit(0)
    }
}
onSignal(SIGUSR1) { overlay.toggleTyping() }

log("started (pid \(getpid()), port \(port))")
app.run()
