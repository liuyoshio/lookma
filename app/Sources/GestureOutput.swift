// What a hand gesture does: the one table from the gesture engine's events (Gesture.swift) to the
// Mac or to Lookma, and the only place a key code, a scroll gain or a page call for gestures
// appears. It runs on the camera's capture queue (HandCamera.swift), which owns it.
//
//   scroll      pixel scroll events to the window under the real pointer, following the hand
//   switch      Command held from begin to end and Tab (Shift-Tab back) for each step: the system
//               app switcher, driven as a hand on the keyboard drives it
//   zoom        one Command-= or Command-- stroke, to the focused app
//   talk, stop  to the overlay page: the talk key's edges (window.lookma.key, the same turn source
//               as fn) and window.lookma.stop (the voice cut, the work stopped)
//   the dot     the engine's hand point, carried from the camera frame to the main display, where
//               the overlay draws it (Overlay.hand). The central part of the frame stretches to the
//               whole screen in each axis, so the dot reaches the edges while the hand stays in view.
//
// Input is posted at once from this queue: no main hop, no sleep, no pointer move. It comes from a
// private event source, and the Command key-up carries no flags (Gstrl's lessons,
// tomyang-tz/Gstrl, MIT). It is deliberately not marked as the hands' own (Input.swift's
// posting {}): a gesture is the user's input, so userIdle() counts it and the agent waits for the
// front while the user scrolls by hand. TalkKey ignores events this process posts, so the held
// Command neither fires nor cancels fn. The engine ends every switch with switchEnd, and
// HandCamera.stop() hands the engine's reset() here on every exit path, so Command is always let
// go. Page calls go to main asynchronously, never synchronously: HandCamera.stop() waits on the
// capture queue from main. The log says which gesture fired (not each scroll frame), never where.
import CoreGraphics
import Foundation

final class GestureOutput {
    /// The share of the camera frame, in each axis, that spans the screen.
    private static let reach = 0.7
    /// Scroll pixels per frame height of hand travel: a comfortable 20 cm pull is about one screen.
    /// Positive pixels scroll toward the top, so the content follows the hand.
    private static let scrollGain = 2200.0
    private static let command: CGKeyCode = 0x37, tab: CGKeyCode = 0x30, equal: CGKeyCode = 0x18, minus: CGKeyCode = 0x1B

    private let overlay: Overlay
    private let source = CGEventSource(stateID: .privateState)
    private var shown = false
    private var carry = 0.0 // the scroll's sub-pixel remainder, for the next event

    init(overlay: Overlay) { self.overlay = overlay }

    func handle(_ events: [GestureEvent]) {
        for e in events {
            switch e {
            case .scroll(let dy):
                scroll(dy)
            case .switchBegin:
                key(Self.command, down: true, .maskCommand)
                log("gesture: switch")
            case .switchStep(let n):
                stroke(Self.tab, n > 0 ? .maskCommand : [.maskCommand, .maskShift])
                log("gesture: switch \(n > 0 ? "next" : "previous")")
            case .switchEnd:
                key(Self.command, down: false, [])
                log("gesture: switch done")
            case .zoom(let n):
                stroke(n > 0 ? Self.equal : Self.minus, .maskCommand)
                log("gesture: zoom \(n > 0 ? "in" : "out")")
            case .talk(let edge):
                DispatchQueue.main.async { [overlay] in overlay.key(edge) }
                log("gesture: talk \(edge.rawValue)")
            case .stop:
                DispatchQueue.main.async { [overlay] in overlay.stop() }
                log("gesture: stop")
            }
        }
    }

    /// This frame's dot, or nil with no hand; aspect is the frame's width over its height.
    func dot(_ d: HandDot?, aspect: Double) {
        guard let d else { return hide() }
        let margin = (1 - Self.reach) / 2
        let fit = { (v: Double) in min(max((v - margin) / Self.reach, 0), 1) }
        let at = (x: fit(d.x / aspect), y: fit(d.y), pinched: d.pinched)
        shown = true
        DispatchQueue.main.async { [overlay] in overlay.hand(at) }
    }

    /// No dot, as when the camera stops.
    func hide() {
        guard shown else { return }
        shown = false
        DispatchQueue.main.async { [overlay] in overlay.hand(nil) }
    }

    /// One frame's hand travel (frame heights, + down) as one pixel scroll event.
    private func scroll(_ dy: Double) {
        let px = dy * Self.scrollGain + carry
        let whole = px.rounded(.towardZero)
        carry = px - whole
        guard whole != 0 else { return }
        CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: Int32(whole), wheel2: 0, wheel3: 0)?
            .post(tap: .cghidEventTap)
    }

    private func stroke(_ code: CGKeyCode, _ flags: CGEventFlags) {
        key(code, down: true, flags)
        key(code, down: false, flags)
    }

    private func key(_ code: CGKeyCode, down: Bool, _ flags: CGEventFlags) {
        let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
        e?.flags = flags
        e?.post(tap: .cghidEventTap)
    }
}
