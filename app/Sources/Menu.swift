// The user's controls outside the overlay: a menu bar item and the global hotkey ⌃⌥P that toggles
// pause. They only ask: the core decides whether it is paused and how the user talks (`talk`), and
// the overlay page owns the voice session and says whether its voice is on, whether the
// microphone is open and whether a hands-free conversation is. The icon and the menu show what
// they last said.
//
//   Hold fn to Talk  ·  Tap to Stay Open      a hint, in key mode
//   Start Conversation                        End Conversation while one is open; key mode only
//   Listen: With the fn Key / Listen: Always  the talk mode, for this run (LOOKMA_TALK is the setting)
//   Pause or Resume (⌃⌥P), Type a Request…, Quit
//
// The icon is Hands the seal (brand/menubar*.png, copied to app/Resources): a ball above it while
// the microphone is open, the plain seal and its ring otherwise (the tooltip says whether the key
// opens it or the voice is off), a pause sign when paused, dimmed while the core is not connected.
// Template images, so macOS tints them for light and dark menu bars.
import AppKit
import Carbon.HIToolbox

/// How the user talks, as the core says (`talk`): the microphone opens while fn is held, or always.
enum TalkMode: String { case key, always }

final class StatusMenu: NSObject {
    var onToggle: () -> Void = {}
    var onTalk: (TalkMode) -> Void = { _ in }
    var onConversation: () -> Void = {}
    var onType: () -> Void = {}
    var onQuit: () -> Void = {}

    /// What the core last said; nil while it is not connected.
    var paused: Bool? = nil { didSet { refresh() } }
    /// The talk mode the core last said; nil until it has.
    var talk: TalkMode? = nil { didSet { refresh() } }
    var voice = PageVoice() { didSet { refresh() } }

    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let seal = template("menubar")
    private lazy var sealWithBall = holdingBall(seal)
    private let sealPaused = template("menubar-paused")
    private let hint = NSMenuItem(title: "Hold fn to Talk  ·  Tap to Stay Open", action: nil, keyEquivalent: "")
    private let conversation = NSMenuItem(title: "Start Conversation", action: #selector(conversationChosen), keyEquivalent: "")
    private let keySeparator = NSMenuItem.separator()
    private let listenKey = NSMenuItem(title: "Listen: With the fn Key", action: #selector(talkChosen), keyEquivalent: "")
    private let listenAlways = NSMenuItem(title: "Listen: Always", action: #selector(talkChosen), keyEquivalent: "")
    private let toggle = NSMenuItem(title: "Pause", action: #selector(toggleChosen), keyEquivalent: "")
    private let typeItem = NSMenuItem(title: "Type a Request…", action: #selector(typeChosen), keyEquivalent: "")

    override init() {
        super.init()
        let menu = NSMenu()
        menu.autoenablesItems = false
        let quit = NSMenuItem(title: "Quit", action: #selector(quitChosen), keyEquivalent: "")
        listenKey.representedObject = TalkMode.key
        listenAlways.representedObject = TalkMode.always
        hint.isEnabled = false
        for i in [hint, conversation, keySeparator, listenKey, listenAlways, toggle, typeItem, .separator(), quit] {
            i.target = self
            menu.addItem(i)
        }
        item.menu = menu
        refresh()
    }

    private func refresh() {
        let connected = paused != nil
        let (image, state) =
            !connected ? (seal, "not connected") :
            paused! ? (sealPaused, "paused") :
            !voice.on ? (seal, "voice off") :
            voice.mic ? (sealWithBall, "listening") :
            talk == .key ? (seal, "ready, hold fn") : (seal, "connecting")
        item.button?.image = image
        item.button?.setAccessibilityLabel("Lookma, \(state)")
        item.button?.appearsDisabled = !connected
        item.button?.toolTip = "Lookma: \(state)"

        // The key's lines only where a tap means something: in always, it only cuts the voice.
        for i in [hint, conversation, keySeparator] { i.isHidden = talk != .key }
        conversation.title = voice.conversation ? "End Conversation" : "Start Conversation"
        conversation.isEnabled = paused == false && voice.on
        for i in [listenKey, listenAlways] {
            i.state = talk == (i.representedObject as? TalkMode) ? .on : .off
            i.isEnabled = connected
        }
        // ⌃⌥P is a global Carbon hot key, not a key equivalent, so it is drawn as part of the title.
        toggle.attributedTitle = shortcutTitle(paused == true ? "Resume" : "Pause", "⌃⌥P")
        toggle.isEnabled = connected
        typeItem.isEnabled = paused == false
    }

    @objc private func toggleChosen() { onToggle() }
    @objc private func talkChosen(_ sender: NSMenuItem) { onTalk(sender.representedObject as! TalkMode) }
    @objc private func conversationChosen() { onConversation() }
    @objc private func typeChosen() { onType() }
    @objc private func quitChosen() { onQuit() }
}

/// A menu bar template from app/Resources; NSImage picks up the @2x file itself.
private func template(_ name: String) -> NSImage {
    let image = NSImage(named: name) ?? NSImage()
    image.isTemplate = true
    return image
}

/// The seal holding a ball instead of a hoop: its ring filled in. Drawn once per scale, since the
/// 1x file is hand-pixeled and its ring sits a little left of the 2x one (brand/src/brandgen.py).
private func holdingBall(_ seal: NSImage) -> NSImage {
    let image = NSImage(size: seal.size)
    // The ring's bounds in points (from the bottom left, as AppKit draws): MENUBAR_1X for 1x,
    // menubar.svg for 2x.
    for (scale, ring) in [(1, NSRect(x: 8, y: 12, width: 6, height: 6)), (2, NSRect(x: 8.7, y: 11.7, width: 6, height: 6))] {
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(seal.size.width) * scale, pixelsHigh: Int(seal.size.height) * scale,
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
        rep.size = seal.size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        seal.draw(in: NSRect(origin: .zero, size: seal.size)) // picks the file of this scale
        NSColor.black.setFill()
        NSBezierPath(ovalIn: ring).fill()
        NSGraphicsContext.restoreGraphicsState()
        image.addRepresentation(rep)
    }
    image.isTemplate = true
    return image
}

/// A menu title with its shortcut right-aligned at one tab stop. No colors, so AppKit still dims it
/// while disabled and inverts it while highlighted.
private func shortcutTitle(_ title: String, _ keys: String) -> NSAttributedString {
    let style = NSMutableParagraphStyle()
    style.tabStops = [NSTextTab(textAlignment: .right, location: 170)]
    return NSAttributedString(string: "\(title)\t\(keys)", attributes: [.font: NSFont.menuFont(ofSize: 0), .paragraphStyle: style])
}

// MARK: - pause hotkey

private var onHotkey: () -> Void = {}

/// ⌃⌥P in any app. A Carbon hot key needs no Accessibility or Input Monitoring permission.
/// When it cannot be had (another process holds it), this logs it and the menu bar still works.
func registerPauseHotkey(_ action: @escaping () -> Void) {
    onHotkey = action
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let handler = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
        onHotkey()
        return noErr
    }, 1, &spec, nil, nil)
    var ref: EventHotKeyRef?
    let id = EventHotKeyID(signature: 0x4C4B_4D41, id: 1) // 'LKMA'
    let status = RegisterEventHotKey(UInt32(kVK_ANSI_P), UInt32(controlKey | optionKey), id, GetApplicationEventTarget(),
                                     OptionBits(kEventHotKeyExclusive), &ref)
    if handler != noErr || status != noErr { log("hotkey ⌃⌥P unavailable (\(handler), \(status)); pause from the menu bar") }
}
