// app/Sources/Gesture.swift's engine on its own: synthetic hands in, gesture events out. The
// hands are generated here from a hand point, a palm scale and a pose, at 30 frames a second;
// a dropout is a frame with no hand, as Vision reports one. No camera and no recordings.
//
//   npm run test:gesture
import CoreGraphics
import Foundation

enum Pose { case open, pinch(Double), fist, loose, edgeOn, folded(Int) }

/// A hand whose hand point (the index and middle knuckles' midpoint) is (x, y) and whose palm
/// scale is s, upright, in the given pose.
func hand(_ x: Double, _ y: Double, _ pose: Pose, s: Double = 0.12) -> Hand {
    // Knuckle spacing: index to little is s; edge-on squeezes the knuckles together.
    var edgeOn = false
    if case .edgeOn = pose { edgeOn = true }
    let d = s / 3 * (edgeOn ? 0.3 : 1)
    let mcps = [-0.5, 0.5, 1.5, 2.5].map { CGPoint(x: x + $0 * d, y: y) }
    func finger(_ m: CGPoint, _ kind: String) -> Finger {
        let o: [(Double, Double)] = switch kind {
        case "extended": [(0, -0.4), (0, -0.65), (0, -0.85)]  // straightness 1
        case "loose": [(0, -0.35), (0.15, -0.45), (0.25, -0.35)] // 0.64
        default: [(0, -0.3), (0, -0.1), (0, -0.05)]             // folded, 0.09
        }
        let p = o.map { CGPoint(x: m.x + $0.0 * s, y: m.y + $0.1 * s) }
        return Finger(mcp: m, pip: p[0], dip: p[1], tip: p[2])
    }
    let kinds: [String]
    switch pose {
    case .open, .edgeOn: kinds = ["extended", "extended", "extended", "extended"]
    case .pinch, .loose: kinds = ["loose", "loose", "loose", "loose"]
    case .fist: kinds = ["folded", "folded", "folded", "folded"]
    case .folded(let k): kinds = (0..<4).map { $0 < 4 - k ? "extended" : "folded" } // little first
    }
    let fingers = zip(mcps, kinds).map { finger($0, $1) }
    let indexTip = fingers[0].tip
    let thumb: CGPoint
    switch pose {
    case .pinch(let g): thumb = CGPoint(x: indexTip.x - g * s, y: indexTip.y)
    case .fist: thumb = CGPoint(x: indexTip.x + 0.1 * s, y: indexTip.y)
    case .edgeOn: thumb = CGPoint(x: indexTip.x, y: indexTip.y + 0.4 * s) // in front of the index
    case .open, .loose, .folded: thumb = CGPoint(x: mcps[0].x - 0.6 * s, y: y - 0.2 * s)
    }
    return Hand(wrist: CGPoint(x: mcps[1].x, y: y + 1.1 * s), thumbTip: thumb, fingers: fingers)
}

/// An engine fed at 30 fps, recording what it emits.
struct Rig {
    var engine = GestureEngine()
    var t = 0.0
    var events: [(t: Double, e: GestureEvent)] = []
    var dot: HandDot? = nil

    mutating func frame(_ hands: [Hand]) {
        let out = engine.feed(HandFrame(t: t, hands: hands))
        events += out.events.map { (t, $0) }
        dot = out.dot
        t += 1.0 / 30
    }
    /// n frames, each made from its index.
    mutating func frames(_ n: Int, _ make: (Int) -> [Hand]) { for i in 0..<n { frame(make(i)) } }
    /// n frames of the same hands.
    mutating func hold(_ n: Int, _ hands: [Hand]) { frames(n) { _ in hands } }
    /// n frames with no hand.
    mutating func gap(_ n: Int) { hold(n, []) }
    /// One hand moving in a straight line over n frames (excluding the start, including the end).
    mutating func move(_ from: (Double, Double), _ to: (Double, Double), _ n: Int, _ pose: Pose, s: Double = 0.12) {
        frames(n) { i in
            let f = Double(i + 1) / Double(n)
            return [hand(from.0 + (to.0 - from.0) * f, from.1 + (to.1 - from.1) * f, pose, s: s)]
        }
    }
    /// Opens the hand in view, then pinches: the engine arms.
    mutating func pinchAt(_ x: Double, _ y: Double) {
        hold(3, [hand(x, y, .loose)])
        hold(3, [hand(x, y, .pinch(0.1))])
    }

    /// Everything emitted since `mark`, scrolls left out, as short names.
    func names(since mark: Int = 0) -> String {
        events[mark...].compactMap { e -> String? in
            switch e.e {
            case .scroll: return nil
            case .switchBegin: return "begin"
            case .switchStep(let n): return "step\(n > 0 ? "+" : "")\(n)"
            case .switchEnd: return "end"
            case .zoom(let n): return "zoom\(n > 0 ? "+" : "")\(n)"
            case .talk(let edge): return edge.rawValue
            case .stop: return "stop"
            }
        }.joined(separator: " ")
    }
    func scrolled(since mark: Int = 0) -> Double {
        events[mark...].reduce(0) { if case .scroll(let dy) = $1.e { return $0 + dy } else { return $0 } }
    }
    func scrolls(since mark: Int = 0) -> Int {
        events[mark...].filter { if case .scroll = $0.e { return true } else { return false } }.count
    }
}

@main
struct GestureCheck {
    static var failed = 0

    static func check(_ ok: Bool, _ what: String) {
        print("\(ok ? "PASS" : "FAIL") \(what)")
        if !ok { failed += 1 }
    }

    static func main() {
        pinch()
        dropout()
        scroll()
        switching()
        zoom()
        identity()
        talk()
        stop()
        print(failed > 0 ? "\n\(failed) FAILED" : "\nall gesture checks passed")
        exit(failed > 0 ? 1 : 0)
    }

    static func pinch() {
        var r = Rig()
        r.pinchAt(0.5, 0.5)
        r.frames(20) { i in [hand(0.5, 0.5, .pinch(i % 2 == 0 ? 0.22 : 0.30))] }
        check(r.dot?.pinched == true, "pinch: a gap wobbling between close and release stays pinched")
        r.hold(3, [hand(0.5, 0.5, .loose)])
        check(r.dot?.pinched == false && r.engine.phase == .idle, "pinch: opening releases it")
        r.frames(20) { i in [hand(0.5, 0.5, .pinch(i % 2 == 0 ? 0.22 : 0.30))] }
        check(r.dot?.pinched == false, "pinch: the same wobble from open does not pinch")

        r = Rig()
        r.hold(3, [hand(0.5, 0.5, .loose)])
        r.hold(1, [hand(0.5, 0.5, .pinch(0.1))])
        r.hold(3, [hand(0.5, 0.5, .loose)])
        check(r.dot?.pinched == false && r.engine.phase == .idle, "pinch: a one-frame dip does not pinch")

        r = Rig()
        r.hold(3, [hand(0.5, 0.5, .loose)])
        r.hold(10, [hand(0.5, 0.5, .fist)])
        check(r.dot?.pinched == false && r.engine.phase == .idle, "pinch: a fist is not a pinch")

        r = Rig()
        r.hold(10, [hand(0.5, 0.5, .pinch(0.1))])
        r.move((0.5, 0.5), (0.5, 0.7), 20, .pinch(0.1))
        check(r.dot?.pinched == false && r.events.isEmpty, "pinch: a hand that enters pinched does nothing")
        r.hold(3, [hand(0.5, 0.7, .loose)])
        r.hold(3, [hand(0.5, 0.7, .pinch(0.1))])
        check(r.dot?.pinched == true, "pinch: ...until it has opened once in view")

        r = Rig()
        r.hold(3, [hand(0.5, 0.5, .loose, s: 0.04)])
        r.hold(3, [hand(0.5, 0.5, .pinch(0.1), s: 0.04)])
        r.move((0.5, 0.5), (0.5, 0.8), 20, .pinch(0.1), s: 0.04)
        check(r.dot == nil && r.events.isEmpty, "pinch: a hand below the near-field gate is ignored")
    }

    static func dropout() {
        var r = Rig()
        r.pinchAt(0.5, 0.3)
        r.move((0.5, 0.3), (0.5, 0.4), 10, .pinch(0.1))
        r.gap(5)
        let mark = r.events.count
        r.move((0.5, 0.43), (0.5, 0.5), 10, .pinch(0.1))
        check(r.scrolls(since: mark) > 0, "dropout: 5 missing frames inside a scroll keep it")
        r.gap(10)
        let after = r.events.count
        r.move((0.5, 0.5), (0.5, 0.7), 20, .pinch(0.1))
        check(r.scrolls(since: after) == 0 && r.dot?.pinched == false, "dropout: 10 missing frames end it")
    }

    static func scroll() {
        var r = Rig()
        r.pinchAt(0.5, 0.5)
        r.move((0.5, 0.5), (0.5, 0.7), 40, .pinch(0.1))
        r.hold(30, [hand(0.5, 0.7, .pinch(0.1))])
        let sum = r.scrolled()
        check(sum > 0.165 && sum < 0.18 && r.names().isEmpty, "scroll: dy sums to the travel after the deadzone (\(String(format: "%.4f", sum)))")
        var mark = r.events.count
        r.move((0.5, 0.7), (0.7, 0.7), 20, .pinch(0.1))
        check(abs(r.scrolled(since: mark)) < 1e-4, "scroll: the axis is locked, sideways wobble scrolls nothing")
        r.hold(15, [hand(0.7, 0.7, .pinch(0.1))])
        mark = r.events.count
        r.hold(3, [hand(0.7, 0.7, .loose)])
        check(abs(r.scrolled(since: mark)) < 1e-4 && r.names(since: mark).isEmpty && r.engine.phase == .idle,
              "scroll: opening the pinch at a still hand ends it without a jerk or an event")
        r = Rig()
        r.pinchAt(0.5, 0.5)
        r.move((0.5, 0.5), (0.5, 0.3), 30, .pinch(0.1))
        check(r.scrolled() < -0.15, "scroll: up is negative")
    }

    static func switching() {
        var r = Rig()
        r.pinchAt(0.5, 0.5)
        r.move((0.5, 0.5), (0.8, 0.5), 60, .pinch(0.1))
        check(r.events.isEmpty, "switch: a slow sideways drag does nothing")
        r.hold(3, [hand(0.8, 0.5, .pinch(0.1))])
        r.move((0.8, 0.5), (0.68, 0.5), 4, .pinch(0.1))
        check(r.names() == "begin step-1", "switch: ...and a fling can start where it stopped")

        func fling(_ dir: Double = 1) -> Rig {
            var r = Rig()
            r.pinchAt(0.5, 0.5)
            r.move((0.5, 0.5), (0.5 + 0.12 * dir, 0.5), 4, .pinch(0.1))
            r.hold(5, [hand(0.5 + 0.12 * dir, 0.5, .pinch(0.1))])
            return r
        }
        r = fling()
        check(r.names() == "begin step+1", "switch: a fling right opens the switcher on the next app")
        r.hold(3, [hand(0.62, 0.5, .loose)])
        check(r.names() == "begin step+1 end" && r.engine.phase == .idle, "switch: opening the pinch commits")
        r = fling(-1)
        check(r.names() == "begin step-1", "switch: a fling left steps back")

        r = Rig()
        r.pinchAt(0.5, 0.5)
        r.frames(6) { i in [1, 2, 3].contains(i) ? [] : [hand(0.5 + 0.03 * Double(i + 1), 0.5, .pinch(0.1))] }
        check(r.names() == "begin step+1", "switch: a fling with 3 missing frames in the middle still switches")

        r = fling()
        r.move((0.62, 0.5), (0.82, 0.5), 30, .pinch(0.1))
        r.hold(10, [hand(0.82, 0.5, .pinch(0.1))])
        check(r.names() == "begin step+1 step+1 step+1", "switch: further travel adds a step per detent")
        r.move((0.82, 0.5), (0.64, 0.5), 30, .pinch(0.1))
        r.hold(10, [hand(0.64, 0.5, .pinch(0.1))])
        check(r.names() == "begin step+1 step+1 step+1 step-1", "switch: travelling back steps back")

        r = Rig()
        r.pinchAt(0.3, 0.5)
        r.frames(17) { i in (8..<14).contains(i) ? [] : [hand(0.34 + 0.04 * Double(i), 0.5, .pinch(0.1))] }
        check(r.names().hasPrefix("begin step+1 step+1") && !r.names().contains("end"),
              "switch: a fast slide across a dropout keeps the same hand")

        r = fling()
        r.gap(12)
        r.hold(5, [hand(0.62, 0.5, .loose)])
        check(r.names() == "begin step+1 end", "switch: a lost hand ends it once")
        r = fling()
        let closing = r.engine.reset()
        r.hold(5, [hand(0.62, 0.5, .loose)])
        check(closing == [.switchEnd] && r.names() == "begin step+1", "switch: reset() ends it once")
    }

    static func zoom() {
        func two(_ span: Double, _ pa: Pose, _ pb: Pose, y: Double = 0.5) -> [Hand] {
            [hand(0.7 - span / 2, y, pa), hand(0.7 + span / 2, y, pb)]
        }
        func armed() -> Rig {
            var r = Rig()
            r.hold(3, two(0.3, .loose, .loose))
            r.hold(3, two(0.3, .pinch(0.1), .loose))
            r.hold(3, two(0.3, .pinch(0.1), .pinch(0.1)))
            return r
        }
        var r = armed()
        r.frames(30) { i in two(0.3 + 0.15 * Double(i + 1) / 30, .pinch(0.1), .pinch(0.1)) }
        r.hold(10, two(0.45, .pinch(0.1), .pinch(0.1)))
        check(r.names() == "zoom+1 zoom+1", "zoom: spreading to 1.5x zooms in twice")

        r = armed()
        r.frames(15) { i in two(0.3 * exp(0.22 * Double(i + 1) / 15), .pinch(0.1), .pinch(0.1)) }
        r.frames(30) { i in two(0.3 * exp(0.22 + (i % 2 == 0 ? 0.1 : -0.1)), .pinch(0.1), .pinch(0.1)) }
        check(r.names() == "zoom+1", "zoom: jitter after a step does not flap")

        r = armed()
        r.frames(9) { i in two(0.3 + 0.6 * Double(i + 1) / 9, .pinch(0.1), .pinch(0.1)) }
        r.hold(30, two(0.9, .pinch(0.1), .pinch(0.1)))
        let times = r.events.map(\.t)
        check(zip(times, times.dropFirst()).allSatisfy { $1 - $0 >= 0.2 - 1e-9 } && times.count >= 2,
              "zoom: a fast spread is held to one step per 0.2 s (\(times.count) steps)")

        r = armed()
        r.hold(3, two(0.3, .pinch(0.1), .loose))
        let mark = r.events.count
        r.frames(20) { i in [hand(0.55, 0.5 + 0.01 * Double(i + 1), .pinch(0.1)), hand(0.85, 0.5, .loose)] }
        check(r.events.count == mark && r.engine.phase == .spent, "zoom: after one hand lets go, the other does not scroll")
        r.hold(3, [hand(0.55, 0.7, .loose), hand(0.85, 0.5, .loose)])
        check(r.engine.phase == .idle, "zoom: ...until it has opened")

        r = Rig()
        r.hold(3, two(0.3, .loose, .loose))
        r.hold(3, two(0.3, .pinch(0.1), .loose))
        r.frames(10) { i in [hand(0.55, 0.5 + 0.01 * Double(i + 1), .pinch(0.1)), hand(0.85, 0.5, .loose)] }
        r.hold(3, [hand(0.55, 0.6, .pinch(0.1)), hand(0.85, 0.5, .pinch(0.1))])
        r.frames(20) { i in [hand(0.55, 0.6, .pinch(0.1)), hand(0.85 + 0.01 * Double(i + 1), 0.5, .pinch(0.1))] }
        check(r.names().isEmpty, "zoom: a second pinch during a scroll does not zoom")
        r.hold(3, [hand(0.55, 0.6, .loose), hand(1.05, 0.5, .pinch(0.1))])
        let after = r.events.count
        r.frames(20) { i in [hand(0.55, 0.6, .loose), hand(1.05, 0.5 + 0.01 * Double(i + 1), .pinch(0.1))] }
        check(r.events.count == after && r.engine.phase == .spent, "zoom: ...and starts nothing when the scroll ends")
    }

    static func identity() {
        func run(swap: Bool) -> [GestureEvent] {
            var r = Rig()
            r.frames(40) { i in
                let pose: Pose = i < 3 ? .loose : .pinch(0.1)
                let y = i < 10 ? 0.4 : 0.4 + 0.008 * Double(i - 9)
                let hands = [hand(0.4, y, pose), hand(0.8, 0.5, .loose)]
                return swap && i % 2 == 1 ? hands.reversed() : hands
            }
            return r.events.map(\.e)
        }
        let plain = run(swap: false), swapped = run(swap: true)
        check(!plain.isEmpty && plain == swapped, "identity: the two hands swapping order changes nothing")
    }

    static func talk() {
        var r = Rig()
        r.hold(9, [hand(0.5, 0.3, .open)])
        check(r.events.isEmpty, "talk: 0.3 s of a raised palm does nothing")
        r.hold(9, [hand(0.5, 0.3, .open)])
        check(r.names() == "down", "talk: 0.5 s still presses the key")
        r.hold(15, [hand(0.5, 0.3, .folded(1))])
        r.hold(15, [hand(0.5, 0.3, .folded(2))])
        check(r.names() == "down", "talk: one or two fingers relaxing keep it down")
        r.hold(2, [hand(0.5, 0.3, .folded(3))])
        check(r.names() == "down up", "talk: three folded let it go")

        r = Rig()
        r.hold(20, [hand(0.5, 0.3, .open)])
        r.move((0.5, 0.3), (0.5, 0.55), 8, .open)
        check(r.names() == "down", "talk: lowering a little keeps it down")
        r.move((0.5, 0.55), (0.5, 0.75), 8, .open)
        check(r.names() == "down up", "talk: lowering past the line lets it go")

        r = Rig()
        r.hold(20, [hand(0.5, 0.3, .open)])
        r.gap(10)
        check(r.names() == "down up", "talk: a hand leaving the frame lets it go")

        r = Rig()
        r.hold(3, [hand(0.4, 0.5, .loose), hand(0.8, 0.3, .open)])
        r.hold(3, [hand(0.4, 0.5, .pinch(0.1)), hand(0.8, 0.3, .open)])
        r.frames(30) { i in [hand(0.4, 0.5 + 0.2 * Double(i + 1) / 30, .pinch(0.1)), hand(0.8, 0.3, .open)] }
        r.frames(12) { i in [hand(0.4, 0.7, i < 10 ? .pinch(0.1) : .loose), hand(0.8, 0.3, .open)] }
        check(r.scrolls() > 0 && r.names().isEmpty, "talk: a raised palm beside a scrolling hand does nothing")
        let mark = r.events.count
        r.hold(9, [hand(0.4, 0.7, .loose), hand(0.8, 0.3, .open)])
        check(r.names(since: mark).isEmpty, "talk: a palm held during a pinch session waits its own dwell after it")

        r = Rig()
        r.move((0.5, 0.95), (0.5, 0.05), 27, .open)
        r.gap(10)
        check(r.events.isEmpty, "talk: a palm passing through the upper half does nothing")
    }

    static func stop() {
        func push(_ r: inout Rig, at y: Double, from s: Double = 0.12) {
            r.frames(6) { i in [hand(0.5, y, .open, s: s * (1 + 0.4 * Double(i + 1) / 6))] }
        }
        var r = Rig()
        r.hold(4, [hand(0.5, 0.4, .open)])
        push(&r, at: 0.4)
        r.hold(30, [hand(0.5, 0.4, .open, s: 0.168)])
        check(r.names() == "stop", "stop: a push stops once, and the palm does not then talk")
        r.hold(3, [hand(0.5, 0.4, .fist)])
        r.hold(20, [hand(0.5, 0.4, .open)])
        check(r.names() == "stop down", "stop: ...until it has closed")

        r = Rig()
        r.hold(20, [hand(0.5, 0.4, .open)])
        push(&r, at: 0.4)
        check(r.names() == "down cancel stop", "stop: a push while talking cancels, then stops")

        r = Rig()
        r.move((0.5, 0.95), (0.5, 0.35), 9, .open)
        r.hold(8, [hand(0.5, 0.35, .open)])
        check(r.events.isEmpty, "stop: a raise does not stop")

        r = Rig()
        r.frames(45) { i in [hand(0.5, 0.7, .open, s: 0.12 * (1 + 0.4 * Double(i + 1) / 45))] }
        check(r.events.isEmpty, "stop: a slow approach does not stop")

        r = Rig()
        r.frames(8) { i in [hand(0.5, 0.7, .edgeOn, s: 0.07 + 0.05 * Double(i + 1) / 8)] }
        r.hold(10, [hand(0.5, 0.7, .open)])
        check(r.events.isEmpty, "stop: a hand turning from edge-on to face the camera does not stop")
    }
}
