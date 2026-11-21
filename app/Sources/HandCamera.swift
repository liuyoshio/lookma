// The camera for hand gestures: a capture session on the camera the user prefers in macOS, and
// Apple's Vision hand pose on every frame, whose joints leave here as HandFrames (Gesture.swift).
// It knows no gesture: each frame goes to onFrame, on the capture queue. It is the only file that
// runs the camera or Vision, and the one place that asks macOS for camera access.
//
// The boundary: Vision's joints are checked once, here. A hand whose measuring joints (the wrist,
// the four knuckles, the thumb tip and the index finger) are below the confidence floor is
// dropped for that frame, and the engine's grace covers the flicker. The other joints pass as
// Vision estimates them: in a side-on pinch the ring and little fingers are routinely hidden, and
// "every joint or nothing" would drop the main gesture. Points become the mirrored image in frame
// heights. Vision's left/right is not passed on (unreliable); the engine keeps hand identity. No
// frame is stored, logged or sent: only joints leave the callback.
//
// Threading: the capture queue owns everything a frame touches (Vision, `live`, and whatever
// onFrame and onStop touch), so there are no locks. The session queue runs startRunning(), which
// blocks. stop() is the only teardown: the session stops (macOS's green light goes out), then
// onStop runs on the capture queue, which drops every frame from then on, so a straggler cannot
// start anything after it. Everything else here runs on main.
import AVFoundation
import Vision

/// What the camera is doing, for the menu.
enum CameraState { case off, running, denied, unavailable }

final class HandCamera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    /// A frame's hands, and the frame's width over its height (a Hand's x runs 0...aspect). On the
    /// capture queue.
    var onFrame: (HandFrame, Double) -> Void = { _, _ in }
    /// The camera stopped. On the capture queue; no frame follows until it runs again.
    var onStop: () -> Void = {}
    /// What the camera is doing changed.
    var onState: (CameraState) -> Void = { _ in }
    /// macOS has an answer to the camera prompt (the hello's permissions are stale).
    var onAccess: () -> Void = {}

    /// Joints that carry the engine's measurements must be at least this confident (Apple's
    /// sample, Glide).
    private static let confidenceFloor: Float = 0.3
    private typealias Joint = VNHumanHandPoseObservation.JointName
    private static let measuring: [Joint] = [.wrist, .thumbTip, .indexMCP, .middleMCP, .ringMCP, .littleMCP, .indexPIP, .indexDIP, .indexTip]
    private static let fingers: [[Joint]] = [
        [.indexMCP, .indexPIP, .indexDIP, .indexTip],
        [.middleMCP, .middlePIP, .middleDIP, .middleTip],
        [.ringMCP, .ringPIP, .ringDIP, .ringTip],
        [.littleMCP, .littlePIP, .littleDIP, .littleTip],
    ]

    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let sessionQueue = DispatchQueue(label: "dev.lookma.camera.session")
    private let captureQueue = DispatchQueue(label: "dev.lookma.camera.capture", qos: .userInteractive)

    // The capture queue's.
    private var live = false
    private var failing = false // Vision failed on the last frame
    private let request: VNDetectHumanHandPoseRequest = {
        let r = VNDetectHumanHandPoseRequest()
        r.maximumHandCount = 2
        return r
    }()

    // Main's.
    private var wanted = false
    private var asking = false
    private var device: AVCaptureDevice? // the camera in the session
    private(set) var state = CameraState.off { didSet { if state != oldValue { onState(state) } } }

    override init() {
        super.init()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.alwaysDiscardsLateVideoFrames = true // frames never queue behind Vision
        output.setSampleBufferDelegate(self, queue: captureQueue)
        let center = NotificationCenter.default
        // A camera unplugged mid-run: start again on the one macOS prefers now, if any. One plugged
        // in while there was none: start on it.
        center.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, state == .running, (note.object as? AVCaptureDevice) == device else { return }
            log("camera disconnected")
            stop()
            device = nil // never reused, even if macOS still names it for a moment
            run(wanted)
        }
        center.addObserver(forName: AVCaptureDevice.wasConnectedNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, wanted, state == .unavailable else { return }
            run(true)
        }
        // The session died and sends no more frames. The engine's only clock is the frame, so it
        // must be torn down now, or a held Command or talk key would stay down.
        center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: .main) { [weak self] note in
            log("camera error: \((note.userInfo?[AVCaptureSessionErrorKey] as? Error)?.localizedDescription ?? "unknown")")
            guard let self else { return }
            stop()
            state = .unavailable
        }
    }

    /// Run the camera or not (main.swift: gestures on and Lookma not paused). Asks for access the
    /// first time it should run.
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

    /// The one teardown, for every way the camera stops.
    func stop() {
        guard state == .running else { return }
        sessionQueue.sync { session.stopRunning() }
        captureQueue.sync {
            live = false
            onStop()
        }
        state = .off
    }

    private func start() {
        guard state != .running else { return }
        guard let camera = AVCaptureDevice.systemPreferredCamera else {
            state = .unavailable
            return
        }
        if camera != device {
            do {
                try sessionQueue.sync { try use(camera) }
            } catch {
                log("camera unavailable: \(error.localizedDescription)")
                state = .unavailable
                return
            }
            device = camera
        }
        captureQueue.sync { live = true }
        sessionQueue.async { [session] in session.startRunning() }
        log("camera on: \(camera.localizedName)")
        state = .running
    }

    /// Puts this camera in the session: 1280x720 where it has it, else 640x480, and at most 30
    /// frames a second. The higher resolution is for range: at 640x480 a palm at arm's length is
    /// about 30 pixels, and the pinch thresholds come down to the joints' own noise.
    private func use(_ camera: AVCaptureDevice) throws {
        let input = try AVCaptureDeviceInput(device: camera)
        session.beginConfiguration()
        for old in session.inputs { session.removeInput(old) }
        session.addInput(input)
        if session.outputs.isEmpty { session.addOutput(output) }
        session.sessionPreset = session.canSetSessionPreset(.hd1280x720) ? .hd1280x720 : .vga640x480
        session.commitConfiguration()
        try camera.lockForConfiguration()
        if camera.activeFormat.videoSupportedFrameRateRanges.contains(where: { $0.minFrameRate <= 30 && 30 <= $0.maxFrameRate }) {
            camera.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 30)
        }
        camera.unlockForConfiguration()
    }

    // MARK: - frames, on the capture queue

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard live, let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
        let aspect = Double(CVPixelBufferGetWidth(pixels)) / Double(CVPixelBufferGetHeight(pixels))
        // A frame Vision fails on still goes on, with no hand: the engine's only clock is the frame,
        // so a held hand is let go after the grace. Logged when it starts failing, not every frame.
        let hands: [Hand]
        do {
            try VNImageRequestHandler(cvPixelBuffer: pixels).perform([request])
            hands = try (request.results ?? []).compactMap { try hand($0, aspect) }
            failing = false
        } catch {
            if !failing { log("hand pose failed: \(error.localizedDescription)") }
            failing = true
            hands = []
        }
        onFrame(HandFrame(t: CMSampleBufferGetPresentationTimeStamp(sample).seconds, hands: hands), aspect)
    }

    /// Vision's hand as a Hand, or nil when a measuring joint is below the floor or a joint is
    /// missing. Vision's points are 0...1 from the lower left, unmirrored.
    private func hand(_ o: VNHumanHandPoseObservation, _ aspect: Double) throws -> Hand? {
        let joints = try o.recognizedPoints(.all)
        guard Self.measuring.allSatisfy({ (joints[$0]?.confidence ?? 0) >= Self.confidenceFloor }) else { return nil }
        let point = { (j: Joint) in joints[j].map { CGPoint(x: (1 - $0.location.x) * aspect, y: 1 - $0.location.y) } }
        var fingers: [Finger] = []
        for f in Self.fingers {
            guard let mcp = point(f[0]), let pip = point(f[1]), let dip = point(f[2]), let tip = point(f[3]) else { return nil }
            fingers.append(Finger(mcp: mcp, pip: pip, dip: dip, tip: tip))
        }
        return Hand(wrist: point(.wrist)!, thumbTip: point(.thumbTip)!, fingers: fingers)
    }
}
