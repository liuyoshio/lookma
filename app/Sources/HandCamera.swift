// The camera for hand gestures, as the app owns it. The camera itself runs in the overlay page,
// with MediaPipe's hand tracker (overlay/hand/); this file knows nothing about hands. It owns
// macOS's camera access (the one place that asks for it), the WebKit grant (Overlay.cameraAllowed),
// telling the page on and off, and the receiving side of the page's `hand` messages: each is
// checked once here and passed on as a HandFrame (HandFrame.swift) to onFrame.
//
// The boundary (docs/protocol.md, "hand"): the body is { t, aspect, hand }, t a finite number of
// seconds above the last accepted one, aspect finite in 0.25...4, hand null or exactly 42 finite
// numbers, x0, y0 ... x20, y20, as fractions of the frame, already mirrored. Points outside 0...1
// pass (a hand partly out of view). x is scaled by aspect into frame heights here, so the engine
// measures the same in both axes. A bad frame is dropped and logged once (a page bug); every frame
// is dropped while the camera is not wanted, so a straggler after a stop cannot press anything.
// Frames carry no image, and no position is logged: only that the camera went on, off or failed.
//
// Every way frames stop comes to onStop (main.swift: reset the engine, let the button go): stop(),
// the page's camera failing, the page going away, and a stall (no frame for 0.5 s while the page
// says its camera is on: the one way frames stop with no message). All of it runs on main.
import AVFoundation

/// What the camera is doing, for the menu.
enum CameraState { case off, running, denied, unavailable }

final class HandCamera {
    /// Each checked frame, while the camera runs.
    var onFrame: (HandFrame) -> Void = { _ in }
    /// Frames stopped or stalled: reset and let go. Frames that flow again are taken as usual.
    var onStop: () -> Void = {}
    /// What the camera is doing changed.
    var onState: (CameraState) -> Void = { _ in }
    /// macOS has an answer to the camera prompt (the hello's permissions are stale).
    var onAccess: () -> Void = {}

    /// No frame for this long while the page's camera is on: the page is stuck.
    private static let stall = 0.5

    private let overlay: Overlay
    private var wanted = false
    private var asking = false
    private var lastT = -Double.infinity // the last accepted frame's t, on this page
    private var badFrameLogged = false
    private var stallTimer: Timer?
    private(set) var state = CameraState.off { didSet { if state != oldValue { onState(state) } } }

    init(overlay: Overlay) {
        self.overlay = overlay
        overlay.onHand = { [unowned self] in take($0) }
        overlay.onPageCamera = { [unowned self] in pageCamera($0) }
        overlay.onPageGone = { [unowned self] in
            lastT = -.infinity // a new page's clock starts again
            guard state == .running else { return }
            stallTimer?.invalidate()
            onStop()
        }
        overlay.onPageReady = { [unowned self] in
            if state == .running { overlay.camera(true) }
        }
        // A camera plugged in after the page found none: try again.
        NotificationCenter.default.addObserver(forName: AVCaptureDevice.wasConnectedNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, wanted, state == .unavailable else { return }
            run(true)
        }
    }

    /// Run the camera or not (main.swift: gestures on, not paused, connected). Asks macOS for
    /// access the first time it should run.
    func run(_ on: Bool) {
        wanted = on
        guard on else { return stop() }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            start()
        case .notDetermined:
            guard !asking else { return }
            asking = true
            AVCaptureDevice.requestAccess(for: .video) { _ in
                DispatchQueue.main.async { [self] in
                    asking = false
                    onAccess()
                    run(wanted)
                }
            }
        default: // denied, or restricted by a profile
            stop()
            state = .denied
        }
    }

    /// The one teardown, for every way the camera is turned off.
    func stop() {
        guard state == .running else { return }
        end()
        state = .off
        log("camera off")
    }

    private func start() {
        guard state != .running else { return }
        overlay.cameraAllowed = true
        overlay.camera(true)
        state = .running
    }

    /// The camera off at both layers (the page, and WebKit's capture), and frames stopped.
    private func end() {
        overlay.cameraAllowed = false
        overlay.camera(false)
        stallTimer?.invalidate()
        onStop()
    }

    private func pageCamera(_ camera: PageCamera) {
        guard state == .running else { return }
        switch camera {
        case .on:
            log("camera on")
            armStall()
        case .failed: // the page logged why: no camera, unplugged, refused, or the tracker did not load
            log("camera failed")
            end()
            state = .unavailable
        case .off: // only ever after it was told off, which is handled there
            break
        }
    }

    private func armStall() {
        stallTimer?.invalidate()
        stallTimer = Timer.scheduledTimer(withTimeInterval: Self.stall, repeats: false) { [unowned self] _ in
            log("hand frames stalled")
            onStop()
        }
    }

    private func take(_ body: Any) {
        guard state == .running else { return }
        guard let frame = frame(body) else {
            if !badFrameLogged { log("dropped a malformed hand frame from the overlay page") }
            badFrameLogged = true
            return
        }
        lastT = frame.t
        armStall()
        onFrame(frame)
    }

    /// The page's message as a HandFrame, or nil if it breaks the protocol.
    private func frame(_ body: Any) -> HandFrame? {
        guard let body = body as? [String: Any],
              let t = number(body["t"]), t > lastT,
              let aspect = number(body["aspect"]), (0.25...4).contains(aspect) else { return nil }
        if body["hand"] is NSNull { return HandFrame(t: t, aspect: aspect, hand: nil) }
        guard let values = body["hand"] as? [Any], values.count == 2 * HandJoint.allCases.count else { return nil }
        let xy = values.compactMap(number)
        guard xy.count == values.count else { return nil }
        let points = stride(from: 0, to: xy.count, by: 2).map { CGPoint(x: xy[$0] * aspect, y: xy[$0 + 1]) }
        return HandFrame(t: t, aspect: aspect, hand: Hand(points: points))
    }
}

/// A finite JavaScript number, and not a boolean (which also arrives as an NSNumber).
private func number(_ value: Any?) -> Double? {
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
    return n.doubleValue
}
