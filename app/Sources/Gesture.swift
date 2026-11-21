// The gesture engine: the hand is a mouse with a clutch. An open hand is the hand on the mouse,
// and the pointer follows the base of its ring finger; a fist, or the hand leaving the view, lifts
// it off the desk (parked: the pointer stays where it is, the button is up). While the hand is on
// the mouse, a thumb-index pinch is the left button held (click, double-click and drag come from
// that), and a thumb-middle pinch moved up or down is the scroll wheel. That is the whole
// vocabulary.
//
// Pure: no AppKit, no camera and no clock of its own (time comes in the frame), so
// app/dev/gesture-check.swift drives it with synthetic hands. The overlay page's MediaPipe hand
// landmarker makes the frames and HandCamera validates them once (HandFrame.swift). Level, not
// edges: each frame's MouseState is the whole state of the mouse, and GestureOutput makes the real
// one match it, so every way out is simply "parked, button up". The output loop's pointer
// (HandPointer: the easing, and giving way to anyone else who moves the pointer) is here too, pure
// for the same reason. Every constant of the engine and of the output's loop is in GestureTuning;
// the engine's positions and distances are in frame heights.
//
// Credits (ideas and numbers, code written here): the interaction model is handTrack's
// (small-cactus/handTrack, MIT): the ring finger's base as the pointer, the central 70% of the
// frame as the screen, the eased pointer and its dead zone, the thumb-index pinch as the held
// button and its threshold, the thumb-middle pinch as the scroll wheel with inertia. The open-hand
// gate is Pawvis's (alexandriax/pawvis, MIT). The finger-straightness test and its 0.82 / 0.55
// bounds are Precog's (lulu38m/precog-macos, MIT).
import CoreGraphics
import Foundation

/// Starting values, tuned on a real camera; the sources are in the header.
enum GestureTuning {
    // The engine, per camera frame.
    static let reach = 0.70          // the central share of the frame, in each axis, that spans the display
    static let minPalm = 0.06        // palm length (frame heights) below which a hand is someone else's
    static let pinchClose = 0.34     // thumb-to-fingertip gap, in palm lengths, that closes a pinch...
    static let pinchOpen = 0.45      // ...and the one that opens it, so a held button does not chatter
    static let extended = 0.82       // straightness at or above which a finger is extended...
    static let folded = 0.55         // ...and below which it is folded
    static let liveFrames = 3        // frames with three fingers extended that put the hand on the mouse
    static let parkFrames = 2        // frames with three fingers folded (a fist) that lift it off
    static let lostFrames = 2        // frames with no hand that lift it off
    static let scrollGain = 1.0      // content travel per hand travel, both mapped to the display
    static let velocityAlpha = 0.5   // weight of the newest frame in the scroll velocity
    static let flick = 0.3           // display heights per second at release that coast on
    static let coastTau = 0.25       // seconds: the coast's decay time constant
    static let coastStop = 0.05      // display heights per second below which the coast ends
    // The output's loop.
    static let loopRate = 120.0      // ticks per second
    static let ease = 1.0 / 12       // share of the remaining distance the pointer moves per tick
    static let deadZone = 0.003      // share of the display diagonal: a nearer target leaves the pointer still
    static let slack = 1.0           // points the real pointer may stray from where the loop put it (rounding)
    static let clickRadius = 4.0     // points within which a quick second press continues a multi-click
}

/// What the hand asks of the mouse after a frame. Level, not edges: GestureOutput makes the real
/// mouse match it.
struct MouseState: Equatable {
    /// Where the pointer should be, as fractions of the main display from its top left; nil: parked.
    var at: CGPoint?
    /// The left button is held. Never true while parked.
    var button: Bool
    /// Scroll to add for this frame, in main display heights; + moves the content down.
    var scroll: Double
    static let parked = MouseState(at: nil, button: false, scroll: 0)
}

struct GestureEngine {
    private typealias T = GestureTuning

    private enum Pinch: Equatable {
        case none
        case button
        /// Scrolling: the pointer frozen at `at` (the window under it keeps the scroll), the anchor
        /// last seen at height `y` at time `t`, the scroll velocity `v` in display heights per second.
        case scroll(at: CGPoint, y: Double, t: Double, v: Double)
    }

    private var live = false
    private var openRun = 0, foldRun = 0, lostRun = 0
    /// Seen live with both gaps open: a pinch must be made in view, not carried in (a hand that
    /// arrives pinched, holding a pen or resting on the chin, presses nothing).
    private var ready = false
    private var pinch = Pinch.none
    private var at = CGPoint.zero    // the pointer, while live
    private var coast: Double? = nil // a flick's velocity, display heights per second
    private var lastT = 0.0

    mutating func feed(_ frame: HandFrame) -> MouseState {
        let dt = frame.t - lastT
        lastT = frame.t
        guard let pose = frame.hand.map(Pose.init), pose.palm >= T.minPalm else {
            lostRun += 1
            openRun = 0
            foldRun = 0
            if live && lostRun >= T.lostFrames { park() }
            // A single missing frame holds the mouse as it was: a drag survives a dropout.
            return live ? MouseState(at: at, button: pinch == .button, scroll: coasting(dt)) : .parked
        }
        lostRun = 0
        openRun = pose.extended >= 3 ? openRun + 1 : 0
        foldRun = pose.fist ? foldRun + 1 : 0
        // Between the bounds (a relaxed hand) nothing changes: live stays live, parked stays parked.
        if live && foldRun >= T.parkFrames { park() }
        if !live && openRun >= T.liveFrames { live = true }
        guard live else { return .parked }

        let point = map(pose.anchor, aspect: frame.aspect)
        var scroll = coasting(dt)
        if !ready { ready = pose.indexGap > T.pinchOpen && pose.middleGap > T.pinchOpen }
        switch pinch {
        case .button where pose.indexGap > T.pinchOpen:
            pinch = .none
        case .scroll(_, _, _, let v) where pose.middleGap > T.pinchOpen:
            // A flick coasts on; a slow, careful scroll stops dead.
            if abs(v) >= T.flick { coast = v }
            pinch = .none
        case .scroll(let frozen, let y, let t, let v):
            // Vertical travel only, mapped like the pointer: the content follows the hand.
            scroll = (pose.anchor.y - y) / T.reach * T.scrollGain
            pinch = .scroll(at: frozen, y: pose.anchor.y, t: frame.t, v: v + T.velocityAlpha * (scroll / (frame.t - t) - v))
        case .none, .button:
            break
        }
        // One pinch at a time, the tighter one if both close at once. A fist also brings the thumb
        // to the fingers, so no pinch closes on a frame that counts toward a fist: making a fist
        // parks without clicking.
        if pinch == .none && ready && !pose.fist {
            let index = pose.indexGap < T.pinchClose, middle = pose.middleGap < T.pinchClose
            if index && (!middle || pose.indexGap <= pose.middleGap) {
                pinch = .button
            } else if middle {
                pinch = .scroll(at: point, y: pose.anchor.y, t: frame.t, v: 0)
            }
            if pinch != .none {
                coast = nil
                scroll = 0
            }
        }
        if case .scroll(let frozen, _, _, _) = pinch { at = frozen } else { at = point }
        return MouseState(at: at, button: pinch == .button, scroll: scroll)
    }

    /// Off the desk: the next live hand must open flat again, and open its pinch gaps again.
    private mutating func park() {
        live = false
        ready = false
        pinch = .none
        coast = nil
    }

    /// This frame's share of a coasting flick, which decays and then ends.
    private mutating func coasting(_ dt: Double) -> Double {
        guard let v = coast else { return 0 }
        let next = v * exp(-dt / T.coastTau)
        guard abs(next) >= T.coastStop else {
            coast = nil
            return 0
        }
        coast = next
        return next * dt
    }

    /// The central share of the frame, in each axis, onto the display (fractions from its top
    /// left), clamped so the pointer reaches the edges while the hand stays in view.
    private func map(_ p: CGPoint, aspect: Double) -> CGPoint {
        let margin = (1 - T.reach) / 2
        func fit(_ v: Double) -> Double { min(max((v - margin) / T.reach, 0), 1) }
        return CGPoint(x: fit(p.x / aspect), y: fit(p.y))
    }
}

/// What a hand is doing in one frame. Every gap is relative to the palm, so it holds at any distance.
private struct Pose {
    typealias T = GestureTuning
    /// Wrist to the middle finger's base: unlike wrist to fingertip, it does not shrink when the
    /// middle finger curls into the scroll pinch.
    let palm: Double
    /// The ring finger's base: it barely moves when the thumb meets the index or the middle finger,
    /// so a click lands where the pointer was aimed.
    let anchor: CGPoint
    let indexGap, middleGap: Double // thumb tip to the fingertip, in palm lengths
    let extended: Int               // of index, middle, ring and little
    let fist: Bool                  // three or more of them folded

    init(_ h: Hand) {
        palm = distance(h[.wrist], h[.middleMCP])
        anchor = h[.ringMCP]
        indexGap = distance(h[.thumbTip], h[.indexTip]) / palm
        middleGap = distance(h[.thumbTip], h[.middleTip]) / palm
        // Straightness: base to tip over the length along the finger's joints, 1 when straight.
        let straightness = [HandJoint.indexMCP, .middleMCP, .ringMCP, .littleMCP].map { mcp in
            let j = (0..<4).map { h.points[mcp.rawValue + $0] }
            return distance(j[0], j[3]) / (distance(j[0], j[1]) + distance(j[1], j[2]) + distance(j[2], j[3]))
        }
        extended = straightness.filter { $0 >= T.extended }.count
        fist = straightness.filter { $0 < T.folded }.count >= 3
    }
}

/// The output loop's pointer, pure so the check can drive it (GestureOutput reads the real pointer
/// and posts the moves). It eases toward the hand's target, and gives way to anyone else who moves
/// the pointer: found away from where the loop last knew it (a trackpad, a physical mouse, the
/// agent's click), it stays where they put it until the hand itself moves past the dead zone or
/// parks. So a hand held still in view never pulls the pointer back.
struct HandPointer {
    private typealias T = GestureTuning
    /// The eased pointer, in global display points.
    private(set) var at = CGPoint.zero
    /// Where the hand wants it; nil: parked, or given way.
    private(set) var target: CGPoint?
    /// The hand's target when it gave way.
    private var yieldedAt: CGPoint?
    /// Where the pointer was last known to be, put there by the loop or read; nil after a stop.
    private var known: CGPoint?
    /// The loop moved the pointer on its last step, so the real one may not have caught up yet.
    private var placed = false

    /// The hand's latest target in global display points; nil (parked) also ends a giving way.
    mutating func aim(_ hand: CGPoint?, diagonal: Double) {
        if let y = yieldedAt, let hand, distance(hand, y) < T.deadZone * diagonal { return }
        yieldedAt = nil
        target = hand
    }

    /// Takes the real pointer as `at`, unless the loop moved it on its last step. Found away from
    /// where it was last known, someone else moved it: the hand gives way.
    mutating func sync(real: CGPoint) {
        guard !placed else { return }
        if let known, distance(real, known) > T.slack, let target {
            yieldedAt = target
            self.target = nil
        }
        at = real
        known = real
    }

    /// One tick of dt seconds: where to move the pointer, or nil to leave it.
    mutating func step(real: CGPoint, dt: Double, diagonal: Double) -> CGPoint? {
        sync(real: real)
        placed = false
        guard let target, let next = easeCursor(from: at, to: target, dt: dt, diagonal: diagonal) else { return nil }
        at = next
        known = next
        placed = true
        return next
    }

    /// The loop stopped; it reads the pointer afresh when it starts again.
    mutating func stop() {
        known = nil
        placed = false
    }
}

/// One tick of the output's loop: the eased point, or nil to stay (within the dead zone). dt in
/// seconds, diagonal in the same units as the points.
func easeCursor(from: CGPoint, to: CGPoint, dt: Double, diagonal: Double) -> CGPoint? {
    let dx = to.x - from.x, dy = to.y - from.y
    guard hypot(dx, dy) >= GestureTuning.deadZone * diagonal else { return nil }
    let k = easeShare(dt)
    return CGPoint(x: from.x + k * dx, y: from.y + k * dy)
}

/// The share of the remaining distance to cover in dt: `ease` per tick, compounded, so a late tick
/// lands where the on-time ones would have.
func easeShare(_ dt: Double) -> Double {
    1 - pow(1 - GestureTuning.ease, dt * GestureTuning.loopRate)
}

private func distance(_ a: CGPoint, _ b: CGPoint) -> Double { hypot(a.x - b.x, a.y - b.y) }
