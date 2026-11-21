// The overlay: a transparent full-screen panel on the main display, above everything, on every
// Space, hosting the overlay page. Click-through except while the pointer is inside one of the
// rects the page posts (the card). Screen recordings show it (sharingType .readOnly); see() leaves
// it out by capturing only the target app. The page owns the voice session and the microphone: it
// is told the talk key's edges (key()) and posts back whether its voice is on, whether the
// microphone is open and whether a hands-free conversation is. With hand gestures on it also draws
// the user's hand as a dot (hand()), and a palm pushed at the camera stops through it (stop()).
import AppKit
import WebKit

/// What the overlay page last said about its voice.
struct PageVoice: Equatable {
    /// Voice works: on, not paused, the session not failing.
    var on = false
    /// The microphone is open for the user: fn held, a conversation open, or always listening.
    var mic = false
    /// A hands-free conversation is open.
    var conversation = false
}

final class OverlayPanel: NSPanel {
    var allowsKey = false // only while the typed input is open
    override var canBecomeKey: Bool { allowsKey }
    override var canBecomeMain: Bool { false }
}

/// Takes the first click even though the panel is never key, so the card's buttons work at once.
final class OverlayWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// The rects the page posts (the card, the typed input, "Go ahead"), in screen points.
private let hitLock = NSLock()
private var hitRects: [CGRect] = []

/// Whether the overlay takes clicks at this point. Everywhere else it is click-through.
func overlayCovers(_ p: CGPoint) -> Bool { hitLock.withLock { hitRects.contains { $0.contains(p) } } }

final class Overlay: NSObject, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private let url: URL
    private var panel: OverlayPanel!
    private var web: OverlayWebView!
    private var typing = false
    private var voice = PageVoice()
    var onVoice: (PageVoice) -> Void = { _ in }

    init(url: URL) {
        self.url = url
        super.init()
        let frame = NSScreen.screens[0].frame
        panel = OverlayPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        panel.sharingType = .readOnly

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "lookma")
        config.mediaTypesRequiringUserActionForPlayback = []
        web = OverlayWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.uiDelegate = self
        web.navigationDelegate = self
        panel.contentView = web
        panel.orderFrontRegardless()
        load()

        // The pointer decides whether the panel takes mouse events: inside a hit rect, yes.
        Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.trackPointer() }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, let screen = NSScreen.screens.first else { return }
            self.panel.setFrame(screen.frame, display: true)
        }
    }

    private func load() { web.load(URLRequest(url: url)) }

    private func trackPointer() {
        let m = NSEvent.mouseLocation // global, bottom-left origin
        let p = CGPoint(x: m.x, y: NSScreen.screens[0].frame.height - m.y)
        let inside = overlayCovers(p)
        if panel.ignoresMouseEvents == inside { panel.ignoresMouseEvents = !inside }
    }

    /// Show or hide the page's typed input ("Type a Request…" in the menu bar; SIGUSR1 toggles).
    func setTyping(_ on: Bool) {
        keyboard(on)
        web.evaluateJavaScript("window.lookma?.toggleTyping(\(on))") { _, err in
            if let err { log("toggleTyping failed: \(err.localizedDescription)") }
        }
    }

    func toggleTyping() { setTyping(!typing) }

    /// The talk key's edge, or the menu's Start/End Conversation (toggle). Always sent: the page
    /// ignores it while no voice session is live.
    func key(_ edge: TalkEdge) {
        web.evaluateJavaScript("window.lookma?.key('\(edge.rawValue)')") { _, err in
            if let err { log("key \(edge.rawValue) failed: \(err.localizedDescription)") }
        }
    }

    /// A palm pushed at the camera: the page cuts the voice and asks the core to stop the work.
    func stop() {
        web.evaluateJavaScript("window.lookma?.stop()") { _, err in
            if let err { log("stop failed: \(err.localizedDescription)") }
        }
    }

    /// Your hand's dot, as fractions of the overlay from its top left, lit while pinched; nil hides
    /// it. Every camera frame while a hand is in view (GestureOutput).
    func hand(_ dot: (x: Double, y: Double, pinched: Bool)?) {
        let size = panel.frame.size
        let arg = dot.map { "{x:\(Int(($0.x * size.width).rounded())),y:\(Int(($0.y * size.height).rounded())),pinched:\($0.pinched)}" } ?? "null"
        web.evaluateJavaScript("window.lookma?.hand(\(arg))") { _, err in
            if let err { log("hand failed: \(err.localizedDescription)") }
        }
    }

    private func setVoice(_ next: PageVoice) {
        guard next != voice else { return }
        voice = next
        onVoice(next)
    }

    /// The panel takes the keyboard only while the typed input shows, then hands it back.
    private func keyboard(_ on: Bool) {
        typing = on
        panel.allowsKey = on
        if on { panel.makeKeyAndOrderFront(nil) }
        else if panel.isKeyWindow { // hand the keyboard back to the app in front
            panel.orderOut(nil)
            panel.orderFrontRegardless()
        }
    }

    // MARK: - page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        // The page also closes the input itself (Escape): then the keyboard goes back.
        if let t = body["typing"] as? Bool, t != typing { keyboard(t) }
        setVoice(PageVoice(on: body["voice"] as? Bool == true, mic: body["mic"] as? Bool == true, conversation: body["conversation"] as? Bool == true))
        guard let rects = body["hitRects"] as? [[String: Any]] else { return }
        let next: [CGRect] = rects.compactMap { r in
            guard let x = r["x"] as? NSNumber, let y = r["y"] as? NSNumber, let w = r["w"] as? NSNumber, let h = r["h"] as? NSNumber else { return nil }
            return CGRect(x: x.doubleValue, y: y.doubleValue, width: w.doubleValue, height: h.doubleValue)
        }
        hitLock.withLock { hitRects = next }
        trackPointer()
    }

    // The page's microphone (the realtime voice). macOS still asks the user once, for the app.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        log("overlay page loaded: \(webView.url?.absoluteString ?? "")")
    }

    // The core may not be up yet, or may restart: keep trying.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.load() }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log("overlay page crashed; reloading")
        setVoice(PageVoice()) // its voice session went with it
        load()
    }
}
