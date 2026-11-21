// app/Sources/TalkKey.swift's machine on its own: keyboard events in, the edges the page is told
// out. The watcher (NSEvent monitors) is not run; it only hands each event over.
//
//   npm run test:key
import AppKit

@main
struct TalkKeyCheck {
    static var failed = 0

    static func check(_ ok: Bool, _ what: String) {
        print("\(ok ? "PASS" : "FAIL") \(what)")
        if !ok { failed += 1 }
    }

    static func fn(_ down: Bool, _ others: NSEvent.ModifierFlags = [], own: Bool = false) -> KeyEvent {
        KeyEvent(kind: .flagsChanged, keyCode: TalkKey.fnKeyCode, flags: down ? others.union(.function) : others, own: own)
    }
    static let shiftDown = KeyEvent(kind: .flagsChanged, keyCode: 56, flags: .shift, own: false)
    static let shiftUp = KeyEvent(kind: .flagsChanged, keyCode: 56, flags: [], own: false)
    static let arrow = KeyEvent(kind: .keyDown, keyCode: 123, flags: [.function, .numericPad], own: false) // left arrow, as fn+arrow sends it

    /// Feeds the events to one machine and lists what it emitted, "-" for nothing.
    static func run(_ k: inout TalkKey, _ events: [KeyEvent]) -> String {
        events.map { k.feed($0)?.rawValue ?? "-" }.joined(separator: " ")
    }

    static func main() {
        var k = TalkKey()
        check(run(&k, [fn(true), fn(false)]) == "down up", "fn alone: down, then up")
        check(run(&k, [fn(true), arrow, fn(false)]) == "down cancel -", "fn then an arrow: cancelled, and its release says nothing")
        check(run(&k, [fn(true), shiftDown, shiftUp, fn(false)]) == "down cancel - -", "fn then shift: cancelled")
        check(run(&k, [shiftDown, fn(true, .shift), fn(false, .shift), shiftUp]) == "- - - -", "shift held first: fn never fires")
        check(run(&k, [fn(true), arrow, arrow, fn(false), fn(true), fn(false)]) == "down cancel - - down up", "re-armed only once fn is up")
        check(run(&k, [fn(true, own: true), fn(false, own: true)]) == "- -" && k.phase == .idle, "fn posted by this process is ignored")
        let ownKey = KeyEvent(kind: .keyDown, keyCode: 0, flags: [], own: true)
        check(run(&k, [fn(true), ownKey, fn(false)]) == "down - up", "the hands typing while fn is held do not cancel it")
        check(run(&k, [arrow, fn(false)]) == "- -" && k.phase == .idle, "keys and a stray fn release while idle do nothing")
        check(run(&k, [fn(true), fn(true), fn(false)]) == "down down up", "a release lost (Secure Input): the next press starts clean")
        check(run(&k, [fn(true), arrow, fn(true), fn(false)]) == "down cancel down up", "a release lost after a shortcut: the next press starts clean")
        print(failed > 0 ? "\n\(failed) FAILED" : "\nall talk key checks passed")
        exit(failed > 0 ? 1 : 0)
    }
}
