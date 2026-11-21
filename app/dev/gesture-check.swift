// app/Sources/Gesture.swift on its own: synthetic hands in, mouse states out, and the output
// loop's pointer (its easing, and giving way to anyone else who moves the pointer) against a
// simulated real one. The hands are MediaPipe's 21 points, generated here from the ring finger's
// base, a palm length and a pose, at 30 frames a second; a dropout is a frame with no hand, as the
// page reports one. No camera, no recordings and no input posted.
//
//   npm run test:gesture
import CoreGraphics
import Foundation

enum Shape {
    case open, relaxed, fist
    case index(Double)  // thumb on the index tip at this gap, in palm lengths; the others extended
    case middle(Double) // the same on the middle finger
    /// Index and middle both curled toward the thumb, which sits at `share` of the way from the
    /// index tip to the middle tip: both gaps closed, the nearer one tighter.
    case both(share: Double)
}

/// A hand in the mirrored frame, upright, whose ring finger base is at (fx, fy) as fractions of the
/// frame, with a palm `palm` frame heights long, in a frame of the given aspect.
func hand(_ fx: Double, _ fy: Double, _ pose: Shape, palm p: Double = 0.13, aspect: Double = 16.0 / 9) -> Hand {
    let ax = fx * aspect, ay = fy
    let d = 0.25 * p // knuckle spacing
    // Joint offsets from the base, in palm lengths: straightness 1, 0.76 (relaxed) and 0.09.
    let extended = [(0.0, -0.45), (0.0, -0.72), (0.0, -0.92)]
    let relaxed = [(0.0, -0.4), (-0.15, -0.55), (-0.3, -0.5)] // curled toward the thumb
    let folded = [(0.0, -0.3), (0.0, -0.1), (0.0, -0.05)]
    let shapes: [[(Double, Double)]] // index, middle, ring, little
    switch pose {
    case .open, .index, .middle: shapes = [extended, extended, extended, extended]
    case .relaxed: shapes = [relaxed, relaxed, relaxed, relaxed]
    case .fist: shapes = [folded, folded, folded, folded]
    case .both: shapes = [relaxed, relaxed, extended, extended]
    }
    var shaped = shapes
    if case .index = pose { shaped[0] = relaxed }
    if case .middle = pose { shaped[1] = relaxed }
    let bases = [-2.0, -1.0, 0.0, 1.0].map { CGPoint(x: ax + $0 * d, y: ay) }
    let fingers = zip(bases, shaped).map { base, shape in [base] + shape.map { CGPoint(x: base.x + $0.0 * p, y: base.y + $0.1 * p) } }
    let wrist = CGPoint(x: bases[1].x, y: ay + p) // a palm of exactly p
    let thumbTip: CGPoint
    switch pose {
    case .open, .relaxed: thumbTip = CGPoint(x: bases[0].x - 0.6 * p, y: ay - 0.1 * p)
    case .fist: thumbTip = CGPoint(x: bases[0].x + 0.05 * p, y: ay - 0.05 * p) // across the folded index
    case .index(let g): thumbTip = CGPoint(x: fingers[0][3].x, y: fingers[0][3].y + g * p)
    case .middle(let g): thumbTip = CGPoint(x: fingers[1][3].x, y: fingers[1][3].y + g * p)
    case .both(let s):
        let i = fingers[0][3], m = fingers[1][3]
        thumbTip = CGPoint(x: i.x + s * (m.x - i.x), y: i.y + 0.05 * p)
    }
    let thumb = (1...3).map { k in
        CGPoint(x: wrist.x + (thumbTip.x - wrist.x) * Double(k) / 4, y: wrist.y + (thumbTip.y - wrist.y) * Double(k) / 4)
    }
    return Hand(points: [wrist] + thumb + [thumbTip] + fingers.flatMap { $0 })
}

/// An engine fed at 30 fps, recording every state it returns.
struct Rig {
    var engine = GestureEngine()
    var t = 0.0
    var aspect = 16.0 / 9
    var states: [MouseState] = []
    var last: MouseState { states.last! }

    mutating func frame(_ h: Hand?) {
        states.append(engine.feed(HandFrame(t: t, aspect: aspect, hand: h)))
        t += 1.0 / 30
    }
    /// n frames of the same hand, or of no hand.
    mutating func hold(_ n: Int, _ h: Hand?) { for _ in 0..<n { frame(h) } }
    /// The ring finger's base moving in a straight line over n frames (excluding the start).
    mutating func move(_ from: (Double, Double), _ to: (Double, Double), _ n: Int, _ pose: Shape) {
        for i in 1...n {
            let f = Double(i) / Double(n)
            frame(hand(from.0 + (to.0 - from.0) * f, from.1 + (to.1 - from.1) * f, pose, aspect: aspect))
        }
    }
    /// An open hand held long enough to go live.
    mutating func open(_ x: Double = 0.5, _ y: Double = 0.5) { hold(3, hand(x, y, .open, aspect: aspect)) }

    func since(_ mark: Int) -> ArraySlice<MouseState> { states[mark...] }
    func scrolled(since mark: Int) -> Double { since(mark).reduce(0) { $0 + $1.scroll } }
}

/// HandPointer at 120 Hz on a 2560 x 1440 display (dead zone 8.8 points) against a simulated real
/// pointer, which shows each posted move `lag` ticks after the tick that posted it.
struct Desk {
    static let diagonal = hypot(2560.0, 1440.0)
    var p = HandPointer()
    var real: CGPoint
    var lag = 0
    var posted: [(tick: Int, at: CGPoint)] = []
    var n = 0
    var moves: [CGPoint] = []

    init(real: CGPoint) { self.real = real }
    mutating func aim(_ x: Double, _ y: Double) { p.aim(CGPoint(x: x, y: y), diagonal: Desk.diagonal) }
    mutating func run(_ ticks: Int) {
        for _ in 0..<ticks {
            while let first = posted.first, first.tick + lag < n {
                real = first.at
                posted.removeFirst()
            }
            if let next = p.step(real: real, dt: 1.0 / 120, diagonal: Desk.diagonal) {
                posted.append((n, next))
                moves.append(next)
            }
            n += 1
        }
    }
    /// Someone else (a trackpad, the agent's click) puts the pointer at (x, y).
    mutating func elsewhere(_ x: Double, _ y: Double) {
        real = CGPoint(x: x, y: y)
        posted = []
    }
}

@main
struct GestureCheck {
    static var failed = 0

    static func check(_ ok: Bool, _ what: String) {
        print("\(ok ? "PASS" : "FAIL") \(what)")
        if !ok { failed += 1 }
    }

    static func near(_ a: CGPoint?, _ x: Double, _ y: Double) -> Bool {
        guard let a else { return false }
        return abs(a.x - x) < 1e-9 && abs(a.y - y) < 1e-9
    }

    static func main() {
        gate()
        mapping()
        button()
        scroll()
        inertia()
        easing()
        pointer()
        print(failed > 0 ? "\n\(failed) FAILED" : "\nall gesture checks passed")
        exit(failed > 0 ? 1 : 0)
    }

    static func gate() {
        var r = Rig()
        r.open()
        check(r.states[0] == .parked && r.states[1] == .parked && r.last.at != nil,
              "gate: an open hand goes live on its third frame, not before")

        r = Rig()
        r.hold(30, hand(0.5, 0.5, .relaxed))
        check(r.since(0).allSatisfy { $0 == .parked }, "gate: a relaxed hand never goes live")
        r.hold(30, hand(0.5, 0.5, .fist))
        check(r.since(0).allSatisfy { $0 == .parked }, "gate: nor does a fist")

        r = Rig()
        r.hold(2, hand(0.5, 0.5, .open))
        r.frame(nil)
        r.hold(2, hand(0.5, 0.5, .open))
        check(r.last == .parked, "gate: the open frames must be consecutive")

        r = Rig()
        r.open()
        r.hold(20, hand(0.5, 0.5, .relaxed))
        check(r.last.at != nil, "gate: a live hand that relaxes stays live")
        r.frame(hand(0.5, 0.5, .fist))
        check(r.last.at != nil, "gate: one fist frame does not park")
        r.frame(hand(0.5, 0.5, .fist))
        check(r.last == .parked, "gate: the second fist frame parks")
        r.hold(2, hand(0.5, 0.5, .open))
        check(r.last == .parked, "gate: after a park the hand must open flat for three frames again")
        r.frame(hand(0.5, 0.5, .open))
        check(r.last.at != nil, "gate: ...and then it is live")

        r = Rig()
        r.open()
        r.frame(nil)
        check(r.last.at == r.states[2].at, "gate: one missing frame holds the pointer")
        r.frame(nil)
        check(r.last == .parked, "gate: two missing frames park")

        r = Rig()
        r.hold(10, hand(0.5, 0.5, .open, palm: 0.05))
        check(r.since(0).allSatisfy { $0 == .parked }, "gate: a palm under minPalm is no hand (someone behind you)")
        r = Rig()
        r.open()
        r.hold(2, hand(0.5, 0.5, .open, palm: 0.05))
        check(r.last == .parked, "gate: a live hand that shrinks under minPalm parks like a lost one")
    }

    static func mapping() {
        var r = Rig()
        r.open(0.15, 0.15)
        check(near(r.last.at, 0, 0), "mapping: the frame's 0.15 corner is the display's top left")
        r.frame(hand(0.85, 0.85, .open))
        check(near(r.last.at, 1, 1), "mapping: its 0.85 corner is the bottom right")
        r.frame(hand(0.5, 0.5, .open))
        check(near(r.last.at, 0.5, 0.5), "mapping: the centre is the centre")
        r.frame(hand(0.32, 0.5, .open))
        check(near(r.last.at, (0.32 - 0.15) / 0.7, 0.5), "mapping: linear in between")
        r.frame(hand(0.05, 0.97, .open))
        check(near(r.last.at, 0, 1), "mapping: beyond the box it clamps to the edge")
        r.frame(hand(0.3, 0.5, .open))
        let left = r.last.at!.x
        r.frame(hand(0.7, 0.5, .open))
        check(left < r.last.at!.x, "mapping: the hand to the user's right is the pointer to the right (the page mirrors)")

        var square = Rig()
        square.aspect = 4.0 / 3
        square.open(0.32, 0.6)
        var wide = Rig()
        wide.open(0.32, 0.6)
        check(near(square.last.at, wide.last.at!.x, wide.last.at!.y), "mapping: the same place in a 4:3 frame maps the same")
    }

    static func button() {
        var r = Rig()
        r.open()
        r.frame(hand(0.5, 0.5, .index(0.35)))
        check(!r.last.button, "button: a gap of 0.35 palms does not close")
        r.frame(hand(0.5, 0.5, .index(0.33)))
        check(r.last.button, "button: a gap of 0.33 palms presses at once")
        r.frame(hand(0.5, 0.5, .index(0.44)))
        check(r.last.button, "button: it holds up to 0.45")
        r.frame(hand(0.5, 0.5, .index(0.46)))
        check(!r.last.button && r.last.at != nil, "button: above 0.45 it lets go, and the hand stays live")

        r = Rig()
        r.open()
        let mark = r.states.count
        r.frame(hand(0.5, 0.5, .index(0.1)))
        let pressedAt = r.last.at
        r.frame(hand(0.5, 0.5, .open))
        check(r.since(mark).map(\.button) == [true, false] && r.last.at == pressedAt,
              "button: a quick pinch is one press and release where the pointer is (a click)")

        r = Rig()
        r.open(0.4, 0.4)
        r.frame(hand(0.4, 0.4, .index(0.1)))
        let dragMark = r.states.count
        r.move((0.4, 0.4), (0.6, 0.5), 10, .index(0.1))
        let drag = r.since(dragMark)
        check(drag.allSatisfy(\.button) && near(r.last.at, (0.6 - 0.15) / 0.7, (0.5 - 0.15) / 0.7),
              "button: a pinched hand that moves holds the button while the pointer follows (a drag)")
        r.frame(nil)
        check(r.last.button, "button: one missing frame keeps the drag")
        r.frame(nil)
        check(r.last == .parked, "button: losing the hand lets go, with no click of its own")

        r = Rig()
        r.open()
        r.frame(hand(0.5, 0.5, .index(0.1)))
        r.frame(hand(0.5, 0.5, .fist))
        r.frame(hand(0.5, 0.5, .fist))
        check(r.last == .parked, "button: a fist while pressed parks and lets go")

        r = Rig()
        r.open()
        let fistMark = r.states.count
        r.hold(5, hand(0.5, 0.5, .fist))
        check(r.since(fistMark).allSatisfy { !$0.button }, "button: making a fist (thumb over the index) never presses")

        r = Rig()
        r.hold(10, hand(0.5, 0.5, .index(0.1)))
        check(r.last.at != nil && r.since(0).allSatisfy { !$0.button },
              "button: a hand that arrives pinched points but presses nothing")
        r.frame(hand(0.5, 0.5, .open))
        r.frame(hand(0.5, 0.5, .index(0.1)))
        check(r.last.button, "button: ...until it has opened in view")

        r = Rig()
        r.open()
        r.hold(2, nil)
        r.hold(5, hand(0.5, 0.5, .index(0.1)))
        check(r.last.at != nil && !r.last.button, "button: after a park the pinch must be made in view again")
    }

    static func scroll() {
        var r = Rig()
        r.open()
        r.frame(hand(0.5, 0.5, .middle(0.1)))
        let frozen = r.last.at
        let mark = r.states.count
        r.move((0.5, 0.5), (0.5, 0.57), 7, .middle(0.1))
        check(abs(r.scrolled(since: mark) - 0.1) < 1e-9, "scroll: 0.07 frames of travel down is 0.1 display heights, content down")
        check(r.since(mark - 1).allSatisfy { $0.at == frozen && !$0.button }, "scroll: the pointer stays where the pinch closed, and nothing clicks")
        let side = r.states.count
        r.move((0.5, 0.57), (0.7, 0.57), 10, .middle(0.1))
        check(r.scrolled(since: side) == 0 && r.last.at == frozen, "scroll: sideways travel scrolls nothing and moves nothing")
        let up = r.states.count
        r.move((0.7, 0.57), (0.7, 0.5), 7, .middle(0.1))
        check(abs(r.scrolled(since: up) + 0.1) < 1e-9, "scroll: up is negative")
        r.frame(nil)
        let back = r.states.count
        r.frame(hand(0.7, 0.53, .middle(0.1)))
        check(r.states[back - 1].scroll == 0 && abs(r.scrolled(since: back) - 0.03 / 0.7) < 1e-9,
              "scroll: a missing frame holds it, and the travel across it is not lost")

        r = Rig()
        r.open()
        r.frame(hand(0.5, 0.5, .both(share: 0.3)))
        check(r.last.button, "scroll: with both gaps closed the tighter one wins (index: the button)")
        r = Rig()
        r.open()
        r.frame(hand(0.5, 0.5, .both(share: 0.7)))
        check(!r.last.button && r.last.at != nil, "scroll: ...(middle: the scroll)")
        r.move((0.5, 0.5), (0.5, 0.6), 5, .both(share: 0.7))
        check(r.last.scroll > 0 && !r.last.button, "scroll: ...and it scrolls")

        r = Rig()
        r.open()
        r.frame(hand(0.5, 0.5, .index(0.1)))
        let held = r.states.count
        r.move((0.5, 0.5), (0.5, 0.6), 5, .both(share: 0.7))
        check(r.since(held).allSatisfy { $0.button && $0.scroll == 0 }, "scroll: cannot start while the button is held")
        r = Rig()
        r.open()
        r.frame(hand(0.5, 0.5, .middle(0.1)))
        let scrolling = r.states.count
        r.hold(5, hand(0.5, 0.5, .both(share: 0.3)))
        check(r.since(scrolling).allSatisfy { !$0.button }, "scroll: the button cannot press while scrolling")
    }

    static func inertia() {
        // 0.01 frame heights a frame is 0.43 display heights a second: a flick.
        var r = Rig()
        r.open()
        r.frame(hand(0.5, 0.4, .middle(0.1)))
        r.move((0.5, 0.4), (0.5, 0.5), 10, .middle(0.1))
        r.frame(hand(0.5, 0.5, .open))
        let mark = r.states.count
        r.hold(30, hand(0.5, 0.5, .open))
        let coast = r.since(mark).map(\.scroll)
        let moving = coast.prefix { $0 > 0 }
        check(moving.count >= 5 && zip(moving, moving.dropFirst()).allSatisfy { $0 > $1 },
              "inertia: a flick coasts on in the following frames, slowing (\(moving.count) frames)")
        check(moving.count < 30 && coast.dropFirst(moving.count).allSatisfy { $0 == 0 }, "inertia: ...and ends")
        let total = moving.reduce(0, +)
        check(total > 0.05 && total < 0.12, "inertia: gently (\(String(format: "%.3f", total)) display heights)")

        r = Rig()
        r.open()
        r.frame(hand(0.5, 0.4, .middle(0.1)))
        r.move((0.5, 0.4), (0.5, 0.41), 10, .middle(0.1))
        let slow = r.states.count
        r.hold(10, hand(0.5, 0.41, .open))
        check(r.scrolled(since: slow) == 0, "inertia: a slow, careful scroll stops dead")

        r = Rig()
        r.open()
        r.frame(hand(0.5, 0.4, .middle(0.1)))
        r.move((0.5, 0.4), (0.5, 0.5), 10, .middle(0.1))
        r.hold(2, hand(0.5, 0.5, .open))
        let pinch = r.states.count
        r.frame(hand(0.5, 0.5, .index(0.1)))
        r.hold(10, hand(0.5, 0.5, .open))
        check(r.states[pinch - 1].scroll > 0 && r.scrolled(since: pinch) == 0, "inertia: a new pinch stops the coast")

        r = Rig()
        r.open()
        r.frame(hand(0.5, 0.4, .middle(0.1)))
        r.move((0.5, 0.4), (0.5, 0.5), 10, .middle(0.1))
        r.frame(hand(0.5, 0.5, .open))
        r.hold(2, nil)
        let parked = r.states.count
        r.hold(10, hand(0.5, 0.5, .open))
        check(r.last.at != nil && r.scrolled(since: parked - 1) == 0, "inertia: a park stops the coast")
    }

    static func easing() {
        let diagonal = hypot(2560.0, 1440.0) // dead zone 8.8 points
        let tick = 1.0 / 120
        check(abs(easeShare(tick) - 1.0 / 12) < 1e-12, "easing: one tick covers 1/12 of the way")
        check(easeCursor(from: .zero, to: CGPoint(x: 6, y: 6), dt: tick, diagonal: diagonal) == nil,
              "easing: a target inside the dead zone leaves the pointer still")
        let one = easeCursor(from: .zero, to: CGPoint(x: 600, y: -300), dt: tick, diagonal: diagonal)!
        let half = easeCursor(from: .zero, to: CGPoint(x: 600, y: -300), dt: tick / 2, diagonal: diagonal)!
        let two = easeCursor(from: half, to: CGPoint(x: 600, y: -300), dt: tick / 2, diagonal: diagonal)!
        check(abs(one.x - 50) < 1e-9 && abs(one.y + 25) < 1e-9 && abs(two.x - one.x) < 1e-9 && abs(two.y - one.y) < 1e-9,
              "easing: two ticks of 1/240 s land where one of 1/120 s does")
        var p = CGPoint.zero
        var ticks = 0
        let target = CGPoint(x: 1800, y: 900)
        while let next = easeCursor(from: p, to: target, dt: tick, diagonal: diagonal) {
            p = next
            ticks += 1
        }
        check(hypot(target.x - p.x, target.y - p.y) < 0.003 * diagonal && ticks < 120,
              "easing: it converges and then stays still (\(ticks) ticks, \(String(format: "%.2f", Double(ticks) / 120)) s)")
    }

    static func pointer() {
        var d = Desk(real: CGPoint(x: 100, y: 100))
        d.aim(1000, 600)
        d.run(240)
        check(!d.moves.isEmpty && d.p.target != nil && hypot(d.real.x - 1000, d.real.y - 600) < 9,
              "pointer: it eases to the hand, and its own moves are not someone else's")
        var late = Desk(real: CGPoint(x: 100, y: 100))
        late.lag = 1
        late.aim(1000, 600)
        late.run(240)
        check(late.p.target != nil && hypot(late.real.x - 1000, late.real.y - 600) < 9,
              "pointer: ...even when the real pointer catches up a tick late")

        d.elsewhere(300, 300)
        d.moves = []
        d.aim(1004, 603) // the still hand's jitter, inside the dead zone
        d.run(120)
        check(d.moves.isEmpty && d.real == CGPoint(x: 300, y: 300),
              "pointer: moved by someone else while the hand is still, it stays where they put it")
        d.aim(1020, 600)
        d.run(1)
        let k = easeShare(1.0 / 120)
        check(d.moves.count == 1 && abs(d.moves[0].x - (300 + k * 720)) < 1e-9 && abs(d.moves[0].y - (300 + k * 300)) < 1e-9,
              "pointer: the hand takes it back once it moves past the dead zone, from where the pointer is")

        d.run(240)
        d.elsewhere(300, 300)
        d.run(2)
        let gaveWay = d.p.target == nil
        d.p.aim(nil, diagonal: Desk.diagonal)
        d.aim(1020, 600)
        check(gaveWay && d.p.target != nil, "pointer: a park ends the giving way, so the hand that comes back has the pointer")

        var stopped = Desk(real: CGPoint(x: 100, y: 100))
        stopped.aim(1000, 600)
        stopped.run(240)
        stopped.p.stop()
        stopped.elsewhere(300, 300)
        stopped.moves = []
        stopped.aim(1000, 600)
        stopped.run(1)
        check(stopped.moves.count == 1 && abs(stopped.moves[0].x - (300 + k * 700)) < 1e-9 && stopped.p.target != nil,
              "pointer: after the loop stops, it starts from where the pointer is without giving way")
    }
}
