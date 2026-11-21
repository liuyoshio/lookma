// The gesture engine: hand frames in, gesture events out. A hand is a second input device with a
// clutch. A pinch made in view is holding the Mac (its first motion picks scroll or the app
// switcher, a second hand pinching first picks zoom); an open upright palm is addressing Lookma
// (held still it is the talk key, pushed toward the camera it is stop). Any other hand does
// nothing, which is the defence against false triggers.
//
// Pure, like TalkKey: no AppKit, no camera and no clock of its own (time comes in the frame), so
// app/dev/gesture-check.swift drives it with synthetic hands. HandCamera makes the frames and
// validates them once; GestureOutput turns the events into input. Every gesture constant is in
// GestureEngine.Tuning; positions and distances are in frame heights.
//
// Credits (ideas and numbers, code written here): the finger-straightness test and its 0.82 /
// 0.55 bounds are Precog's (lulu38m/precog-macos, MIT); a fling as displacement within a time
// window is Gstrl's (tomyang-tz/Gstrl, MIT); hand identity by nearest hand and starting pinch
// thresholds follow Glide (euphoriawolf/glide, MIT); the One Euro filter is from the paper.
import CoreGraphics
import Foundation

// MARK: - Hand frames (HandCamera's output, validated there)

/// A finger's joints. Points are in the mirrored camera image: x to the user's right, y down,
/// both in frame heights (x runs 0...aspect), so distances match in both axes at any resolution.
struct Finger { let mcp, pip, dip, tip: CGPoint }
struct Hand {
    let wrist: CGPoint, thumbTip: CGPoint
    let fingers: [Finger] // index, middle, ring, little, always four
}
/// 0, 1 or 2 hands, in no particular order (identity is kept here, not by Vision's chirality).
struct HandFrame { let t: Double; let hands: [Hand] }

// MARK: - Gesture events

enum GestureEvent: Equatable {
    case scroll(dy: Double) // hand travel since the last seen frame, frame heights, + is down
    case switchBegin        // the app switcher opens (the output holds Command)
    case switchStep(Int)    // +1 next app, -1 previous
    case switchEnd          // the switcher commits (the output lets Command go)
    case zoom(Int)          // +1 in, -1 out
    case talk(TalkEdge)     // .down, .up, .cancel: the same edges as fn
    case stop
}
/// Where the hand is, for the overlay's dot: frame heights, as Hand.
struct HandDot: Equatable { let x, y: Double; let pinched: Bool }
struct GestureOutputs { let events: [GestureEvent]; let dot: HandDot? }

// MARK: - The engine

struct GestureEngine {
    /// Starting values, from the projects credited above where they have prior art; tuned on a real
    /// camera.
    enum Tuning {
        static let nearField = 0.05          // palm scale below which a hand is ignored (bystanders)
        static let pinchClose = 0.20         // gap, in palm scales, that closes a pinch
        static let pinchRelease = 0.32       // gap that opens it (and makes a hand ready)
        static let debounce = 2              // consecutive seen frames to confirm or release
        static let grace = 0.25              // seconds a track survives without a hand
        static let matchRadius = 0.25        // nearest-hand radius for identity
        static let deadzone = 0.025          // vertical travel that locks scroll
        static let restRadius = 0.02         // the hand rests while this near the anchor
        static let flingTravel = 0.07        // sideways travel that is a fling...
        static let flingWindow = 0.15        // ...within this many seconds of rest
        static let flingRatio = 2.0          // ...and at least this much more sideways than vertical
        static let detent = 0.10             // further sideways travel per switch step
        static let zoomStep = 0.18           // log span change per zoom step
        static let zoomInterval = 0.2        // seconds between zoom steps, at least
        static let talkDwell = 0.5           // seconds a palm must be still to press the talk key
        static let stillSpeed = 0.3          // frame heights per second that count as still
        static let stillScale = 0.10         // palm scale change that breaks stillness
        static let talkOn = 0.5              // the palm presses the key above this height...
        static let talkOff = 0.6             // ...and lets it go below this one
        static let talkFolded = 3            // folded fingers that let the key go
        static let openGap = 0.5             // an open palm's thumb is at least this far out
        static let upright = 0.8             // middle fingertip above the wrist, in palm scales
        static let pushGrowth = 1.30         // palm scale growth that is a push...
        static let pushWindow = 0.30         // ...within this many seconds...
        static let pushTravel = 0.15         // ...while the hand moves less than this
        static let extended = 0.82           // straightness above which a finger is extended
        static let folded = 0.55             // straightness below which it is folded
        static let filterMinCutoff = 1.4     // One Euro, AirWave's published values
        static let filterBeta = 5.5
        static let filterDCutoff = 2.4
    }

    /// One activity at a time; the first motion of a pinch locks its mode.
    enum Phase: Equatable {
        case idle
        /// Pinched, not moved yet: anchored at `at`, last at rest there at `rest` (-inf: the hand
        /// was moving when anchored).
        case armed(track: Int, anchor: CGPoint, at: Double, rest: Double)
        case scroll(track: Int, y: Double)
        /// Steps count from `detent` once the flick has settled; until then it follows the hand.
        case switching(track: Int, detent: Double, settled: Bool)
        case zoom(Int, Int, ref: Double, last: Double)
        case talk(track: Int)
        case spent // a session ended or a stop fired: nothing starts until hands open or leave
    }

    private(set) var phase = Phase.idle
    private var tracks: [Track] = [] // at most two, oldest first
    private var nextID = 0

    mutating func feed(_ frame: HandFrame) -> GestureOutputs {
        let t = frame.t
        tracks.removeAll { t - $0.lastSeen > Tuning.grace }
        for i in tracks.indices { tracks[i].seenNow = false }
        let confirmed = match(frame.hands.map(Shape.init).filter { $0.scale >= Tuning.nearField }, at: t)
        var events: [GestureEvent] = []
        advance(t, confirmed: confirmed, &events)
        // A palm's dwell counts only while idle, and its push only while idle or talking, so a pose
        // held during a pinch session does not fire the moment the session ends.
        switch phase {
        case .idle: break
        case .talk: for i in tracks.indices { tracks[i].still = nil }
        default: for i in tracks.indices { tracks[i].still = nil; tracks[i].palm = [] }
        }
        return GestureOutputs(events: events, dot: dot())
    }

    /// Ends whatever is under way with its closing events and forgets every hand. HandCamera.stop()
    /// is the only caller, so a held Command is always let go.
    mutating func reset() -> [GestureEvent] {
        let closing: [GestureEvent]
        switch phase {
        case .switching: closing = [.switchEnd]
        case .talk: closing = [.talk(.up)]
        default: closing = []
        }
        self = GestureEngine()
        return closing
    }

    /// Gives each hand to the nearest track within the radius (around its predicted point while
    /// pinched: a fast fling is when Vision drops frames), else to a free track. Returns the
    /// tracks that confirmed a pinch in this frame.
    private mutating func match(_ shapes: [Shape], at t: Double) -> [Track] {
        var pairs: [(d: Double, h: Int, k: Int)] = []
        for (h, s) in shapes.enumerated() {
            for (k, tr) in tracks.enumerated() {
                let d = distance(s.point, tr.expected(at: t))
                if d <= Tuning.matchRadius { pairs.append((d, h, k)) }
            }
        }
        var handOf: [Int: Int] = [:] // track index -> hand index
        var taken = Set<Int>()
        for p in pairs.sorted(by: { $0.d < $1.d }) where handOf[p.k] == nil && !taken.contains(p.h) {
            handOf[p.k] = p.h
            taken.insert(p.h)
        }
        var confirmed: [Track] = []
        for (k, h) in handOf.sorted(by: { $0.key < $1.key }) {
            if tracks[k].see(shapes[h], at: t) { confirmed.append(tracks[k]) }
        }
        // New hands left to right, so which one is first does not depend on Vision's order.
        let fresh = shapes.indices.filter { !taken.contains($0) }.sorted { shapes[$0].point.x < shapes[$1].point.x }
        for h in fresh where tracks.count < 2 {
            tracks.append(Track(id: nextID, shapes[h], at: t))
            nextID += 1
        }
        return confirmed
    }

    private func track(_ id: Int) -> Track? { tracks.first { $0.id == id } }

    /// A session is over: nothing new starts while a hand is still pinched.
    private mutating func end() {
        phase = tracks.contains { $0.pinched } ? .spent : .idle
    }

    private mutating func advance(_ t: Double, confirmed: [Track], _ out: inout [GestureEvent]) {
        switch phase {
        case .idle:
            if let first = confirmed.first {
                phase = .armed(track: first.id, anchor: first.point, at: t, rest: first.slow ? t : -.infinity)
                if let second = confirmed.dropFirst().first { startZoom(first, second) }
            } else if tracks.contains(where: { $0.pushed }) {
                out.append(.stop)
                phase = .spent
            } else if let tr = tracks.first(where: { $0.dwelled }) {
                out.append(.talk(.down))
                phase = .talk(track: tr.id)
            }

        case .armed(let id, var anchor, var at, var rest):
            guard let tr = track(id), tr.pinched else { return end() }
            if let other = confirmed.first(where: { $0.id != id }) { return startZoom(tr, other) }
            guard tr.seenNow else { return }
            // A hand that was moving when it was anchored (fingers closing on a hand reaching for
            // the mouse or a cup) has not rested, so it cannot fling: it is anchored again where it
            // slows. Otherwise it rests while near the anchor.
            if rest == -.infinity && tr.slow { anchor = tr.point; at = t; rest = t }
            let dx = tr.point.x - anchor.x, dy = tr.point.y - anchor.y
            if hypot(dx, dy) <= Tuning.restRadius && rest > -.infinity { rest = t }
            if abs(dx) >= Tuning.flingTravel && abs(dx) >= Tuning.flingRatio * abs(dy) && t - rest <= Tuning.flingWindow {
                let step = dx > 0 ? 1 : -1
                out += [.switchBegin, .switchStep(step)]
                phase = .switching(track: id, detent: tr.point.x, settled: false)
            } else if abs(dy) >= Tuning.deadzone && abs(dy) > abs(dx) {
                phase = .scroll(track: id, y: tr.point.y) // the travel through the deadzone is not replayed
            } else {
                // Neither, for longer than a fling's window: a slow drag does nothing, and the next
                // fling may start from here once the hand rests.
                if t - max(at, rest) > Tuning.flingWindow {
                    anchor = tr.point
                    at = t
                    rest = tr.slow ? t : -.infinity
                }
                phase = .armed(track: id, anchor: anchor, at: at, rest: rest)
            }

        case .scroll(let id, let y):
            guard let tr = track(id), tr.pinched else { return end() }
            guard tr.seenNow else { return }
            if tr.point.y != y { out.append(.scroll(dy: tr.point.y - y)) }
            phase = .scroll(track: id, y: tr.point.y)

        case .switching(let id, var detent, var settled):
            guard let tr = track(id), tr.pinched else {
                out.append(.switchEnd)
                return end()
            }
            guard tr.seenNow else { return }
            if settled {
                while tr.point.x - detent >= Tuning.detent { out.append(.switchStep(1)); detent += Tuning.detent }
                while tr.point.x - detent <= -Tuning.detent { out.append(.switchStep(-1)); detent -= Tuning.detent }
            } else {
                // The flick that opened the switcher carries on past the crossing: the detents
                // count from where it slows, so one flick is one step.
                detent = tr.point.x
                settled = tr.slow
            }
            phase = .switching(track: id, detent: detent, settled: settled)

        case .zoom(let a, let b, let ref, let last):
            guard let ta = track(a), ta.pinched, let tb = track(b), tb.pinched else { return end() }
            let span = distance(ta.point, tb.point)
            let change = log(span / ref)
            // Re-anchoring on each step is the hysteresis: jitter at a threshold cannot flap.
            if abs(change) >= Tuning.zoomStep && t - last >= Tuning.zoomInterval {
                out.append(.zoom(change > 0 ? 1 : -1))
                phase = .zoom(a, b, ref: span, last: t)
            }

        case .talk(let id):
            guard let tr = track(id) else {
                out.append(.talk(.up))
                phase = .idle
                return
            }
            if tracks.contains(where: { $0.pushed }) {
                out += [.talk(.cancel), .stop]
                phase = .spent
            } else if tr.point.y > Tuning.talkOff || tr.shape.folded >= Tuning.talkFolded {
                out.append(.talk(.up))
                phase = .idle
            }

        case .spent:
            if !tracks.contains(where: { $0.pinched || $0.shape.openPalm }) { phase = .idle }
        }
    }

    private mutating func startZoom(_ a: Track, _ b: Track) {
        phase = .zoom(a.id, b.id, ref: distance(a.point, b.point), last: -.infinity)
    }

    /// The active track's hand (the one in a session, else the first), as the overlay draws it.
    private func dot() -> HandDot? {
        let active: Int?
        switch phase {
        case .armed(let id, _, _, _), .scroll(let id, _), .switching(let id, _, _), .talk(let id), .zoom(let id, _, _, _): active = id
        case .idle, .spent: active = nil
        }
        guard let tr = active.flatMap({ track($0) }) ?? tracks.first else { return nil }
        return HandDot(x: tr.point.x, y: tr.point.y, pinched: tr.pinched)
    }
}

// MARK: - One hand in one frame

/// What a hand is doing, derived from its joints every frame. Every shape threshold is relative
/// to the palm scale, so it holds at any distance.
private struct Shape {
    /// Palm scale: the knuckle width, or the palm's length when the hand turns edge-on.
    let scale: Double
    /// The hand point: between the index and middle knuckles, so it stays put when the fingers
    /// close or open (the thumb-index midpoint jumps on every pinch and release).
    let point: CGPoint
    /// Thumb tip to index tip, in palm scales.
    let gap: Double
    /// At least two of middle, ring and little not folded: a fist also closes the gap.
    let othersLoose: Bool
    let folded: Int
    /// All four fingers extended, the thumb out, the fingers pointing up.
    let openPalm: Bool

    init(_ h: Hand) {
        let f = h.fingers
        scale = max(distance(f[0].mcp, f[3].mcp), 0.8 * distance(h.wrist, f[1].mcp))
        point = CGPoint(x: (f[0].mcp.x + f[1].mcp.x) / 2, y: (f[0].mcp.y + f[1].mcp.y) / 2)
        gap = distance(h.thumbTip, f[0].tip) / scale
        let straight = f.map { distance($0.mcp, $0.tip) / (distance($0.mcp, $0.pip) + distance($0.pip, $0.dip) + distance($0.dip, $0.tip)) }
        folded = straight.filter { $0 < GestureEngine.Tuning.folded }.count
        othersLoose = straight.dropFirst().filter { $0 >= GestureEngine.Tuning.folded }.count >= 2
        openPalm = straight.allSatisfy { $0 > GestureEngine.Tuning.extended }
            && gap > GestureEngine.Tuning.openGap
            && h.wrist.y - f[1].tip.y >= GestureEngine.Tuning.upright * scale
    }
}

// MARK: - A tracked hand

private struct Track {
    typealias T = GestureEngine.Tuning
    let id: Int
    private var filter = OneEuro(minCutoff: T.filterMinCutoff, beta: T.filterBeta, dCutoff: T.filterDCutoff)
    private(set) var point = CGPoint.zero // filtered hand point
    private(set) var lastSeen = 0.0
    var seenNow = false                   // seen in the current frame
    private(set) var shape: Shape         // as last seen
    /// Seen open once: a pinch must be made in view, not carried in (a pen, a cup, a chin rest).
    private(set) var ready = false
    private(set) var pinched = false
    private var closeRun = 0, openRun = 0
    /// The open upright palm's recent (t, scale, point), cleared whenever the pose breaks, so a
    /// hand turning to face the camera (any raise) does not count as growing.
    var palm: [(t: Double, s: Double, p: CGPoint)] = []
    /// Since when the palm has been still in the upper half, and its scale then.
    var still: (since: Double, scale: Double)? = nil

    /// A new hand. Its first frame confirms nothing: a pinch takes two.
    init(id: Int, _ s: Shape, at t: Double) {
        self.id = id
        shape = s
        _ = see(s, at: t)
    }

    /// Takes this frame's hand; returns true on the frame the pinch is confirmed.
    mutating func see(_ s: Shape, at t: Double) -> Bool {
        point = filter.feed(s.point, at: t)
        lastSeen = t
        seenNow = true
        shape = s
        if s.gap >= T.pinchRelease { ready = true }
        closeRun = s.gap <= T.pinchClose && s.othersLoose ? closeRun + 1 : 0
        openRun = s.gap >= T.pinchRelease ? openRun + 1 : 0
        var confirmed = false
        if !pinched && ready && closeRun >= T.debounce {
            pinched = true
            confirmed = true
        } else if pinched && openRun >= T.debounce {
            pinched = false
        }
        if s.openPalm {
            palm.append((t, s.scale, point))
            palm.removeAll { t - $0.t > T.pushWindow }
        } else {
            palm = []
        }
        if s.openPalm && point.y < T.talkOn && slow {
            if still == nil || abs(s.scale / still!.scale - 1) > T.stillScale { still = (t, s.scale) }
        } else {
            still = nil
        }
        return confirmed
    }

    /// Where the hand should be now: while pinched, the last point carried on at its velocity.
    func expected(at t: Double) -> CGPoint {
        guard pinched else { return point }
        return CGPoint(x: point.x + filter.velocity.dx * (t - lastSeen), y: point.y + filter.velocity.dy * (t - lastSeen))
    }

    /// Slower than still speed, by the filter's velocity.
    var slow: Bool { hypot(filter.velocity.dx, filter.velocity.dy) < T.stillSpeed }

    /// The palm grew by the push factor within the window while staying roughly in place, debounced
    /// like the pinch at both ends: each of the newest samples is that much bigger than each of
    /// some run of older ones, so one frame's joint glitch (a spike now, a dip before) is not a push.
    var pushed: Bool {
        let n = T.debounce
        guard palm.count >= 2 * n else { return false }
        let newest = palm.suffix(n), older = Array(palm.dropLast(n))
        return (0...older.count - n).contains { i in
            older[i..<i + n].allSatisfy { o in newest.allSatisfy { $0.s >= T.pushGrowth * o.s && distance($0.p, o.p) < T.pushTravel } }
        }
    }

    /// Still for the dwell, counted to the last frame the hand was seen: a palm that drops out of
    /// view does not finish its dwell inside the grace.
    var dwelled: Bool { still.map { lastSeen - $0.since >= T.talkDwell } ?? false }
}

// MARK: - One Euro filter

/// The One Euro filter (Casiez, Roussel and Vogel, CHI 2012), written from the paper, on a
/// point: a low-pass whose cutoff rises with speed, so a still hand is steady and a moving one
/// does not lag. One cutoff for both axes, from the speed, so a diagonal keeps its direction.
/// The filtered derivative is the hand's velocity, in frame heights per second.
private struct OneEuro {
    let minCutoff, beta, dCutoff: Double
    private var value: CGPoint? = nil
    private(set) var velocity = CGVector.zero
    private var lastT = 0.0

    init(minCutoff: Double, beta: Double, dCutoff: Double) {
        self.minCutoff = minCutoff
        self.beta = beta
        self.dCutoff = dCutoff
    }

    mutating func feed(_ x: CGPoint, at t: Double) -> CGPoint {
        guard let prev = value else {
            value = x
            lastT = t
            return x
        }
        let dt = t - lastT
        lastT = t
        let ad = Self.alpha(dCutoff, dt)
        velocity = CGVector(dx: velocity.dx + ad * ((x.x - prev.x) / dt - velocity.dx),
                            dy: velocity.dy + ad * ((x.y - prev.y) / dt - velocity.dy))
        let a = Self.alpha(minCutoff + beta * hypot(velocity.dx, velocity.dy), dt)
        let next = CGPoint(x: prev.x + a * (x.x - prev.x), y: prev.y + a * (x.y - prev.y))
        value = next
        return next
    }

    private static func alpha(_ cutoff: Double, _ dt: Double) -> Double { 1 / (1 + 1 / (2 * .pi * cutoff * dt)) }
}

private func distance(_ a: CGPoint, _ b: CGPoint) -> Double { hypot(a.x - b.x, a.y - b.y) }
