// The hand mouse's output: makes the Mac's real mouse match the gesture engine's MouseState
// (Gesture.swift). It is the only place gesture input is posted.
//
// A loop at GestureTuning.loopRate on its own serial queue eases the pointer toward the hand's
// target, `ease` of the remaining distance per tick (handTrack's, small-cactus/handTrack, MIT), so
// the pointer glides at the display's pace between 30 fps camera frames; a target nearer than the
// dead zone does not move it, so a still hand is a still pointer. Its own queue, so main's AX calls
// and menu tracking cannot freeze the pointer; a fixed rate, not the display link, so the easing
// feels the same on any display. The pointer gives way to anyone else (HandPointer, Gesture.swift):
// a trackpad or physical mouse move, or the agent's click, while the hand is still leaves the
// pointer where they put it until the hand moves past the dead zone or parks, and then starts from
// there. The loop runs while the hand has a target or scroll is owed and stops itself otherwise.
//
// The button goes down and up at once, at the eased pointer, when the state's button changes, with
// macOS's multi-click count; while it is held, moves are drags. Scroll owed (display heights to
// points) drains with the same easing as pixel scroll events at the pointer; positive scrolls
// toward the top, so the content follows the hand. The button is let go on every exit path: a
// parked or lost hand is `button: false` in the state, and every stop of the frames reaches
// release() through HandCamera's onStop.
//
// Events come from a private event source (Gstrl's lesson, tomyang-tz/Gstrl, MIT) and are
// deliberately not marked as the hands' own (Input.swift's posting {}): the hand mouse is the
// user's input, so userIdle() counts it and the agent waits for the front while the user moves it.
// The log says when the hand goes live or parks, never where it is.
import AppKit

final class GestureOutput {
    private typealias T = GestureTuning
    private let queue = DispatchQueue(label: "dev.lookma.pointer", qos: .userInteractive)
    private let source = CGEventSource(stateID: .privateState)

    // Everything below is the loop queue's.
    private var timer: DispatchSourceTimer?
    private var pointer = HandPointer()
    private var diagonal = 0.0       // the main display's, in points
    private var lastTick = 0.0
    private var button = false       // the left button as last posted
    private var clicks = 0           // the multi-click count of the current press
    private var lastDown = (t: -Double.infinity, at: CGPoint.zero)
    private var owed = 0.0           // scroll points not posted yet
    private var carry = 0.0          // the posted scroll's sub-point remainder
    private var live = false         // for the log

    /// The engine's latest state. Call on main; returns at once (hops to the loop's queue).
    func apply(_ state: MouseState) {
        // Read on each frame, so a resolution change is picked up.
        let display = CGDisplayBounds(CGMainDisplayID())
        let interval = NSEvent.doubleClickInterval
        queue.async { [self] in
            if (state.at != nil) != live {
                live.toggle()
                log(live ? "hand mouse: live" : "hand mouse: parked")
            }
            diagonal = hypot(display.width, display.height)
            // The last pixel row and column, not one past them, which is the next display's.
            pointer.aim(state.at.map { CGPoint(x: display.minX + $0.x * (display.width - 1), y: display.minY + $0.y * (display.height - 1)) },
                        diagonal: diagonal)
            if state.button != button { press(state.button, interval: interval) }
            owed += state.scroll * display.height
            if timer == nil && (pointer.target != nil || owed != 0) { start() }
        }
    }

    /// Button up if held, owed scroll dropped, loop stopped. Call on main; returns when done. The
    /// loop's queue never waits on main, so this cannot deadlock. Idempotent.
    func release() {
        queue.sync {
            if button { press(false, interval: 0) }
            pointer.aim(nil, diagonal: diagonal)
            owed = 0
            carry = 0
            stop()
            if live {
                live = false
                log("hand mouse: parked")
            }
        }
    }

    private func start() {
        lastTick = ProcessInfo.processInfo.systemUptime
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1 / T.loopRate, repeating: 1 / T.loopRate, leeway: .milliseconds(1))
        t.setEventHandler { [unowned self] in self.tick() }
        t.resume()
        timer = t
    }

    private func stop() {
        timer?.cancel()
        timer = nil
        pointer.stop()
    }

    private func tick() {
        let now = ProcessInfo.processInfo.systemUptime
        let dt = now - lastTick
        lastTick = now
        if pointer.step(real: realPointer(), dt: dt, diagonal: diagonal) != nil { post(button ? .leftMouseDragged : .mouseMoved) }
        if owed != 0 { scroll(easeShare(dt)) }
        if pointer.target == nil && owed == 0 { stop() }
    }

    private func realPointer() -> CGPoint { CGEvent(source: nil)!.location }

    private func press(_ down: Bool, interval: Double) {
        pointer.sync(real: realPointer())
        let at = pointer.at
        if down {
            let now = ProcessInfo.processInfo.systemUptime
            let again = now - lastDown.t <= interval && hypot(at.x - lastDown.at.x, at.y - lastDown.at.y) <= T.clickRadius
            clicks = again ? clicks + 1 : 1
            lastDown = (now, at)
        }
        button = down
        post(down ? .leftMouseDown : .leftMouseUp)
    }

    private func post(_ type: CGEventType) {
        let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: pointer.at, mouseButton: .left)!
        // The press's click count rides on its down, its drags and its up, as a real mouse's does.
        if type != .mouseMoved { e.setIntegerValueField(.mouseEventClickState, value: Int64(clicks)) }
        e.post(tap: .cghidEventTap)
    }

    /// Posts share k of the owed scroll, in whole points; under a point left owed goes at once, so
    /// the loop drains and stops.
    private func scroll(_ k: Double) {
        let step = abs(owed) * (1 - k) < 1 ? owed : owed * k
        owed -= step
        let px = step + carry
        let whole = px.rounded(.towardZero)
        carry = px - whole
        guard whole != 0 else { return }
        let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: Int32(whole), wheel2: 0, wheel3: 0)!
        e.location = pointer.at
        e.post(tap: .cghidEventTap)
    }
}
