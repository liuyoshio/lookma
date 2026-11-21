// The talk key: fn, alone. A primitive like the hands: it reports the key's edges (down, up,
// cancel) to the overlay page, which knows the rest. No clocks here, so a tap and a hold are the
// same to the app; the page's turn source (overlay/voice/source.js) tells them apart and decides
// what the microphone does.
//
// Two parts. TalkKey is a pure machine fed one keyboard event at a time
// (app/dev/talkkey-check.swift runs it). TalkKeyWatcher feeds it from NSEvent's global and local
// monitors, which observe and cannot consume, so fn keeps working as a modifier: fn+arrow,
// fn+delete and the Globe shortcuts are cancelled here and long over before the page would act.
// Global key monitors need Accessibility, which the app already holds.
//
// One limit: while macOS Secure Input is on (a password field has focus, or Terminal's Secure
// Keyboard Entry) no key events reach any app. A press that starts there does nothing; a release
// lost there is what the page's maximum hold is for.
import AppKit

/// What the page is told (window.lookma.key): the key's edges, and toggle, the menu's Start/End Conversation.
enum TalkEdge: String { case down, up, cancel, toggle }

/// One keyboard event, as the machine needs it.
struct KeyEvent {
    enum Kind { case flagsChanged, keyDown }
    let kind: Kind
    let keyCode: UInt16
    let flags: NSEvent.ModifierFlags
    /// Posted by this process (the hands typing while the user holds fn): never the user's key.
    let own: Bool
}

extension KeyEvent {
    init(_ e: NSEvent) {
        kind = e.type == .keyDown ? .keyDown : .flagsChanged
        keyCode = e.keyCode
        flags = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
        own = e.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) == Int64(getpid())
    }
}

/// fn down alone is `.down`; its release is `.up`; any other key or modifier while it is down is
/// `.cancel` (it was part of a shortcut), and nothing more until fn is up again. A press always
/// starts clean: a release lost to Secure Input leaves no phase behind.
struct TalkKey {
    /// fn's key code (the Globe key on Apple keyboards). The fn flag alone is not fn: arrows and
    /// F-keys carry it too. The single place to change should a keyboard report the Globe key as 179.
    static let fnKeyCode: UInt16 = 63
    static let otherModifiers: NSEvent.ModifierFlags = [.shift, .control, .option, .command]

    enum Phase { case idle, down, spent }
    private(set) var phase = Phase.idle

    mutating func feed(_ e: KeyEvent) -> TalkEdge? {
        if e.own { return nil }
        let fn = e.kind == .flagsChanged && e.keyCode == Self.fnKeyCode
        let fnDown = fn && e.flags.contains(.function)
        if fnDown { phase = .idle } // fn can only go down from up: whatever came before, its release was lost
        switch phase {
        case .idle:
            guard fnDown else { return nil }
            if !e.flags.isDisjoint(with: Self.otherModifiers) { // fn joined a held modifier: a shortcut
                phase = .spent
                return nil
            }
            phase = .down
            return .down
        case .down:
            if fn { // went up
                phase = .idle
                return .up
            }
            // A key already held when fn went down needs no scan: its key repeat lands here well
            // inside the page's arm time.
            phase = .spent
            return .cancel
        case .spent:
            if fn { phase = .idle } // went up
            return nil
        }
    }
}

/// Feeds TalkKey from every key event the app can observe, in other apps and in its own panel.
final class TalkKeyWatcher {
    private var machine = TalkKey()
    private let onEdge: (TalkEdge) -> Void

    init(onEdge: @escaping (TalkEdge) -> Void) {
        self.onEdge = onEdge
        let mask: NSEvent.EventTypeMask = [.flagsChanged, .keyDown]
        _ = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] in self?.see($0) }
        _ = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] in
            self?.see($0)
            return $0
        }
    }

    private func see(_ event: NSEvent) {
        if let edge = machine.feed(KeyEvent(event)) { onEdge(edge) }
    }
}
