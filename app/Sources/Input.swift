// Synthetic input (CGEvent clicks, drags, keys, text, scrolling) and the user's idle time. Our own
// events count as input to macOS too, so we note when we post and leave those out of idle.
import CoreGraphics
import Foundation

private let src = CGEventSource(stateID: .hidSystemState)
private let anyInput = CGEventType(rawValue: ~0)!
private let lock = NSLock()
private var ownStart = 0.0, ownEnd = 0.0 // our latest burst of events; ownEnd < ownStart while posting
private var userLast = now() - CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput)

private func posting(_ body: () throws -> Void) rethrows {
    lock.withLock { ownStart = now() }
    defer { lock.withLock { ownEnd = now() } }
    try body()
}

/// Seconds since the user's last key or mouse event, not counting the events we posted.
func userIdle() -> Double {
    let t = now()
    let last = t - CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput)
    return lock.withLock {
        let ours = last >= ownStart - 0.05 && (ownEnd < ownStart || last <= ownEnd + 0.3)
        if !ours { userLast = max(userLast, last) }
        return max(0, t - userLast)
    }
}

private func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }

func mouseClick(_ p: CGPoint, button: CGMouseButton) {
    let types: [CGEventType] = button == .right ? [.rightMouseDown, .rightMouseUp] : [.leftMouseDown, .leftMouseUp]
    posting {
        post(CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
        usleep(60_000) // the overlay re-checks the pointer at 30 Hz and turns click-through back on
        for type in types {
            let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: button)
            e?.setIntegerValueField(.mouseEventClickState, value: 1)
            post(e)
            usleep(40_000)
        }
    }
}

// A drag, timed as a hand would do it. Each value is matched by DRAG_HOLD, DRAG_MS and DRAG_DWELL in
// overlay/marks.js, so the ghost cursor moves with the real pointer.
// The hold before moving: apps start a drag session only after the button has been down a while,
// and a text view waits longer before it treats a press on selected text as a drag rather than a
// new selection. The text-view delay is not verified; the TextEdit check sets the final value.
private let dragHoldUs: useconds_t = 300_000
// The move: 20 dragged events 25 ms apart (500 ms), then a dwell over the drop target, which many
// targets need before they highlight and accept the drop.
private let dragSamples = 20
private let dragStepUs: useconds_t = 25_000
private let dragDwellUs: useconds_t = 200_000

/// `n` points from a to b (apart) on a straight line, eased in and out, the last one at b. The first
/// is 5 points off a, past the few points apps wait for before a press becomes a drag, or b when that
/// is closer.
func dragPath(from a: CGPoint, to b: CGPoint, samples n: Int) -> [CGPoint] {
    let dx = b.x - a.x, dy = b.y - a.y, d = hypot(dx, dy), lead = min(5, d)
    let first = CGPoint(x: a.x + dx / d * lead, y: a.y + dy / d * lead)
    let ease = { (u: CGFloat) in u < 0.5 ? 4 * u * u * u : 1 - pow(-2 * u + 2, 3) / 2 }
    return [first] + (1..<n).map { i in
        let u = ease(CGFloat(i) / CGFloat(n - 1))
        return CGPoint(x: first.x + (b.x - first.x) * u, y: first.y + (b.y - first.y) * u)
    }
}

/// A left button event as hardware sends it: down and up carry click count 1 (some text and table
/// views ignore a press without it), and a dragged event carries how far it moved (a canvas may
/// pan by that delta rather than by the position).
private func leftEvent(_ type: CGEventType, at p: CGPoint, from prev: CGPoint? = nil) -> CGEvent? {
    let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)
    if let prev {
        e?.setIntegerValueField(.mouseEventDeltaX, value: Int64((p.x - prev.x).rounded()))
        e?.setIntegerValueField(.mouseEventDeltaY, value: Int64((p.y - prev.y).rounded()))
    } else {
        e?.setIntegerValueField(.mouseEventClickState, value: 1)
    }
    return e
}

/// Presses the left button at `from`, holds, moves to `to` and lets go there. The button is let go
/// on every path out once it is down, so a drag never leaves it held.
func mouseDrag(from: CGPoint, to: CGPoint) {
    posting {
        post(CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: .left))
        usleep(60_000) // the overlay re-checks the pointer at 30 Hz and turns click-through back on
        post(leftEvent(.leftMouseDown, at: from))
        var at = from
        defer { post(leftEvent(.leftMouseUp, at: at)) }
        usleep(dragHoldUs)
        for p in dragPath(from: from, to: to, samples: dragSamples) {
            post(leftEvent(.leftMouseDragged, at: p, from: at))
            at = p
            usleep(dragStepUs)
        }
        usleep(dragDwellUs)
    }
}

/// Scrolls by pixels, positive dy toward the top and positive dx toward the left, in events of at
/// most 100 px, 8 ms apart: some apps drop or clamp one large delta.
func scrollWheel(at p: CGPoint, dx: Int, dy: Int) {
    let n = max(1, (max(abs(dx), abs(dy)) + 99) / 100)
    posting {
        post(CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
        usleep(50_000)
        var sent = (x: 0, y: 0)
        for i in 1...n {
            let next = (x: dx * i / n, y: dy * i / n)
            post(CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2,
                         wheel1: Int32(next.y - sent.y), wheel2: Int32(next.x - sent.x), wheel3: 0))
            sent = next
            if i < n { usleep(8_000) }
        }
    }
}

private let keyCodes: [String: CGKeyCode] = [
    "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09,
    "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14,
    "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18, "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E,
    "o": 0x1F, "u": 0x20, "[": 0x21, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29,
    "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, "`": 0x32,
    "return": 0x24, "enter": 0x24, "tab": 0x30, "space": 0x31, "delete": 0x33, "backspace": 0x33, "escape": 0x35, "esc": 0x35,
    "forwarddelete": 0x75, "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
    "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64, "f9": 0x65,
    "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
]

private func parseCombo(_ combo: String) throws -> (CGKeyCode, CGEventFlags) {
    var flags: CGEventFlags = []
    var code: CGKeyCode? = nil
    for part in combo.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
        switch part {
        case "cmd", "command", "⌘": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "opt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default:
            guard let c = keyCodes[part] else { throw HandsError("Unknown key \"\(part)\" in \(combo).") }
            code = c
        }
    }
    guard let code else { throw HandsError("No key in \(combo).") }
    return (code, flags)
}

private func keyStroke(_ code: CGKeyCode, _ flags: CGEventFlags) {
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
        e?.flags = flags
        post(e)
        usleep(15_000)
    }
}

func pressKey(_ combo: String) throws {
    let (code, flags) = try parseCombo(combo)
    posting { keyStroke(code, flags) }
}

/// Types text as Unicode key events; "\n" presses Return.
func typeText(_ text: String) {
    posting {
        for (i, line) in text.components(separatedBy: "\n").enumerated() {
            if i > 0 { keyStroke(0x24, []) }
            for ch in line {
                var u = Array(String(ch).utf16)
                for down in [true, false] {
                    let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
                    e?.flags = []
                    e?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
                    post(e)
                }
                usleep(8_000)
            }
        }
    }
}
