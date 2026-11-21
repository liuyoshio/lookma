// The hands: the ops of docs/protocol.md ("App ⇄ core"). The core resolves a target before every
// step; that target is the only app the step may touch. Input that needs the front (click, drag,
// type, key, scroll) is posted only when it will land in the target. Ops run one at a time.
// An act op returns once its effect has had time to show, since the core lists the app right after.
import AppKit
import ApplicationServices

private struct Target {
    var pid: pid_t?
    var name: String
    var dockTitle: String? = nil // set when the target is a Dock icon
}

// The app the current step may touch, set by whichever op picks one. Owned by the op queue
// (Link.serve), which runs one op at a time, so it needs no lock; never touch it from the main thread.
private var target: Target? = nil

private func num(_ v: Any?) -> CGFloat? { (v as? NSNumber).map { CGFloat($0.doubleValue) } }

private func point(_ v: Any?) throws -> CGPoint {
    guard let a = v as? [Any], a.count == 2, let x = num(a[0]), let y = num(a[1]) else { throw HandsError("Expected a point [x, y].") }
    return CGPoint(x: x, y: y)
}

/// Left unless the core asks for right.
private func button(_ v: Any?) throws -> CGMouseButton {
    switch v as? String {
    case nil, "left": return .left
    case "right": return .right
    default: throw HandsError("click button must be \"left\" or \"right\".")
    }
}

private func text(_ args: [String: Any], _ key: String) -> String? {
    guard let s = args[key] as? String, !s.isEmpty else { return nil }
    return s
}

// AXPress reports success but does nothing on SwiftUI menu buttons, popup buttons and menu
// items, and it does not focus text fields. Those get a real click instead.
private let clickOnly: Set<String> = ["AXMenuButton", "AXPopUpButton", "AXMenuItem", "AXMenuBarItem",
                                      "AXTextField", "AXTextArea", "AXComboBox"]

private func pressable(_ e: Element) -> Bool { !clickOnly.contains(e.axRole) && axActions(e.ax).contains("AXPress") }

private func isFront(_ pid: pid_t?) -> Bool { pid != nil && frontPid() == pid }

func runOp(_ op: String, _ args: [String: Any]) async throws -> [String: Any] {
    switch op {
    case "see":
        guard let shot = args["screenshot"] as? Bool else { throw HandsError("see needs screenshot: true or false.") }
        return try await see(text(args, "app"), screenshot: shot)
    case "resolve": return try resolve(args)
    case "front": return try await front(text(args, "app"))
    case "press": return try await press(args)
    case "click": return try await click(point(args["point"]), button: button(args["button"]))
    case "drag": return try await drag(from: point(args["from"]), to: point(args["to"]))
    case "type": return try await typeInTarget(args)
    case "key": return try await keyInTarget(args)
    case "scroll": return try await scroll(args)
    case "open": return try await open(args)
    default: throw HandsError("Unknown op \(op).")
    }
}

// MARK: - resolve, front

private func resolve(_ args: [String: Any]) throws -> [String: Any] {
    if args["element"] != nil && !(args["element"] is NSNull) {
        let e = try element(args["element"])
        target = Target(pid: e.pid, name: e.app)
        let r = axFrame(e.ax).flatMap { $0.width > 0 && $0.height > 0 ? $0 : nil } ?? e.rect // it may have moved since see
        return ["app": e.app, "rect": rectJSON(r), "point": center(r), "frontmost": isFront(e.pid), "pressable": pressable(e)]
    }
    if args["point"] != nil && !(args["point"] is NSNull) {
        let p = try point(args["point"])
        guard let s = lastShot else { throw HandsError("No screenshot yet; call see with screenshot: true.") }
        // A point is in the picture's pixels: once the window moves, it names another place.
        guard axFrame(s.window) == s.frame else {
            throw HandsError("The window moved or closed since the screenshot; call see with screenshot: true for a new one.")
        }
        let q = CGPoint(x: s.rect.minX + p.x * s.rect.width / CGFloat(s.w), y: s.rect.minY + p.y * s.rect.height / CGFloat(s.h))
        guard s.rect.insetBy(dx: -1, dy: -1).contains(q) else { throw HandsError("That point is outside the last screenshot (\(s.w)x\(s.h)).") }
        target = Target(pid: s.pid, name: s.app)
        return ["app": s.app, "rect": rectJSON(CGRect(x: q.x - 12, y: q.y - 12, width: 24, height: 24)),
                "point": [Int(q.x.rounded()), Int(q.y.rounded())], "frontmost": isFront(s.pid), "pressable": false]
    }
    if let name = text(args, "dock") {
        guard let item = dockItem(named: name), let r = axFrame(item) else {
            // Not in the Dock: an installed app is launched from its path instead (the core acts
            // with open), named as it runs, like a Dock item below.
            guard let url = appURL(name) else { throw HandsError("\(name) is not in the Dock, and no app by that name is installed.") }
            let running = NSWorkspace.shared.runningApplications.first { $0.bundleURL == url }
            target = Target(pid: running?.processIdentifier, name: running?.localizedName ?? bundleAppName(url) ?? name)
            return ["app": target!.name, "rect": NSNull(), "point": NSNull(), "frontmost": isFront(running?.processIdentifier),
                    "pressable": false, "path": url.path]
        }
        let title = axString(item, "AXTitle") ?? name
        let running = dockItemApp(item)
        // An app that is not running yet is named as it will be once it runs (its Dock title can
        // differ: "Visual Studio Code" runs as "Code"), so the grant, the list after the press and
        // the next steps all name the same app.
        let appName = running?.localizedName ?? dockItemURL(item).flatMap(bundleAppName) ?? title
        target = Target(pid: running?.processIdentifier, name: appName, dockTitle: title)
        return ["app": target!.name, "rect": rectJSON(r), "point": center(r), "frontmost": isFront(running?.processIdentifier), "pressable": true]
    }
    let name = text(args, "app")
    guard let app = findApp(name) else { throw notRunning(name) }
    let pid = app.processIdentifier
    target = Target(pid: pid, name: app.localizedName ?? name ?? "app")
    let win = frontWindow(AXUIElementCreateApplication(pid)).flatMap(axFrame)
    return ["app": target!.name, "rect": win.map(rectJSON) ?? NSNull(), "point": win.map(center) ?? NSNull(),
            "frontmost": isFront(pid), "pressable": false]
}

/// Bring an app and its front window forward from the background, and wait up to 2 s for the
/// window to be really on screen. Best effort, so it reports nothing: the ops that post input
/// check the front again themselves.
private func front(_ name: String?) async throws -> [String: Any] {
    guard let app = findApp(name) else { throw notRunning(name) }
    let pid = app.processIdentifier
    let appEl = AXUIElementCreateApplication(pid)
    target = Target(pid: pid, name: app.localizedName ?? name ?? "app")
    let win = frontWindow(appEl)

    if !isFront(pid) {
        _ = await MainActor.run { app.activate(options: []) }
        if !(await until(0.6, { isFront(pid) })) {
            axSet(appEl, "AXFrontmost", kCFBooleanTrue)
            _ = await until(0.6, { isFront(pid) })
        }
    }
    if let w = win {
        axSet(w, "AXMain", kCFBooleanTrue)
        AXUIElementPerformAction(w, "AXRaise" as CFString)
        axSet(w, "AXFocused", kCFBooleanTrue)
        _ = await until(2.0, { ready(pid) })
    }
    return [:]
}

// MARK: - acting

// How long an op waits after its last event before its effect is read (by the core's list, or by
// scroll's own position read). The same for every op, so no wait stacks on another.
private let settleNs: UInt64 = 200_000_000

private func settled() async throws -> [String: Any] {
    try await Task.sleep(nanoseconds: settleNs)
    return [:]
}

private func press(_ args: [String: Any]) async throws -> [String: Any] {
    let e = try element(args["element"])
    let err = AXUIElementPerformAction(e.ax, "AXPress" as CFString)
    guard err == .success else { throw HandsError("Pressing \(e.id) failed (AX error \(err.rawValue)); call see again.") }
    return try await settled()
}

/// What is under a point, as the window server routes a click (click-through windows skipped).
private func owner(at p: CGPoint) -> pid_t? {
    var el: AXUIElement?
    guard AXUIElementCopyElementAtPosition(systemWide, Float(p.x), Float(p.y), &el) == .success, let el else { return nil }
    return axPid(el)
}

/// Input lands in the target only: the point must be on the target's window, and the target
/// must have keyboard focus. Our own panel is see-through except where the card is; an unknown
/// owner (no AX answer) is fine when the target is in front.
private func checkPointer(_ p: CGPoint, _ verb: String) throws {
    guard let t = target, let pid = t.pid else { throw HandsError("Did not \(verb): no target app; resolve one first.") }
    if overlayCovers(p) { throw HandsError("Did not \(verb): the Lookma card covers that point.") }
    if let o = owner(at: p), o != pid, o != getpid() { throw HandsError("Did not \(verb): the point is on \(appName(o)), not on \(t.name).") }
    guard isFront(pid) else { throw HandsError("Did not \(verb): \(appName(frontPid())) is in front, not \(t.name).") }
}

// How long a right click waits for its menu. Menus open within a frame or two; a click where the
// app has no context menu waits this long and reports none.
private let menuWait = 0.5

/// A left click returns when settled. A right click returns once its menu is up (`menu: true`), or
/// after `menuWait` with `menu: false`. Only a left click on a Dock icon opens that app.
private func click(_ p: CGPoint, button: CGMouseButton) async throws -> [String: Any] {
    if button == .left, let item = dockItems().first(where: { axFrame($0)?.contains(p) ?? false }) { return try await pressDockIcon(item) }
    try checkPointer(p, "click")
    mouseClick(p, button: button)
    guard button == .right else { return try await settled() }
    let pid = target!.pid!
    return ["menu": await until(menuWait, { !openMenus(pid).isEmpty })]
}

/// A left-button drag inside the target app: both ends must be on its window, as for a click, and
/// apart. Returns when settled after the drop.
private func drag(from: CGPoint, to: CGPoint) async throws -> [String: Any] {
    guard from != to else { throw HandsError("Did not drag: it starts and ends at the same point.") }
    try checkPointer(from, "drag")
    try checkPointer(to, "drag")
    mouseDrag(from: from, to: to)
    return try await settled()
}

/// Opening an app is pressing its Dock icon. Done when the app is in front with a window on screen.
private func pressDockIcon(_ item: AXUIElement) async throws -> [String: Any] {
    let title = axString(item, "AXTitle") ?? "?"
    guard let t = target, t.dockTitle == title else {
        throw HandsError("Did not click: the point is on \(title) in the Dock, not on \(target?.name ?? "the target").")
    }
    let err = AXUIElementPerformAction(item, "AXPress" as CFString)
    guard err == .success else { throw HandsError("Pressing \(title) in the Dock failed (AX error \(err.rawValue)).") }
    let ok = await until(12, { dockItemApp(item).map { ready($0.processIdentifier) } ?? false })
    if let app = dockItemApp(item) { target = Target(pid: app.processIdentifier, name: app.localizedName ?? title) }
    guard ok else { throw HandsError("Pressed \(title) in the Dock, but no window of it came to the front within 12 s.") }
    return [:]
}

private func checkKeyboard(_ verb: String) throws {
    guard let t = target, let pid = t.pid else { throw HandsError("Did not \(verb): no target app; resolve one first.") }
    let f = frontPid()
    guard f == pid else { throw HandsError("Did not \(verb): \(appName(f)) has keyboard focus, not \(t.name).") }
}

private func typeInTarget(_ args: [String: Any]) async throws -> [String: Any] {
    guard let s = args["text"] as? String else { throw HandsError("type needs text.") }
    try checkKeyboard("type")
    typeText(s)
    return try await settled()
}

private func keyInTarget(_ args: [String: Any]) async throws -> [String: Any] {
    guard let combo = text(args, "combo") else { throw HandsError("key needs a combo, e.g. \"cmd+t\".") }
    try checkKeyboard("press \(combo)")
    try pressKey(combo)
    return try await settled()
}

// The wheel's signs per direction: positive scrolls toward the top (dy) or the left (dx).
private let wheel: [String: (dx: Int, dy: Int)] = ["up": (0, 1), "down": (0, -1), "left": (1, 0), "right": (-1, 0)]

/// One scroll in pixels: `pages` of the visible length, less a tenth so the last line stays in view.
private func pagePixels(_ visible: CGFloat, _ pages: Double) -> Int { Int((visible * 0.9 * pages).rounded()) }

private func barValue(_ bar: AXUIElement) -> Double? { (axGet(bar, "AXValue") as? NSNumber)?.doubleValue }

/// Scrolls `pages` of what is visible at the point: the nearest scroll area or web area there, cut
/// to the window, else the window. Done when the scroll bar has been read again after settling.
/// The bar belongs to the nearest scroll area, which is the web area's parent in a WebKit view;
/// `position` and `moved` are null when there is none to read (typical for Chromium content).
private func scroll(_ args: [String: Any]) async throws -> [String: Any] {
    let p = try point(args["point"])
    guard let dir = args["direction"] as? String, let sign = wheel[dir] else { throw HandsError("scroll needs a direction: up, down, left or right.") }
    guard let pages = num(args["pages"]), pages > 0 else { throw HandsError("scroll needs pages above 0.") }
    try checkPointer(p, "scroll")
    let t = target!
    let appEl = AXUIElementCreateApplication(t.pid!)
    var hit: AXUIElement?
    let area = AXUIElementCopyElementAtPosition(appEl, Float(p.x), Float(p.y), &hit) == .success
        ? hit.flatMap { axAncestor($0, scrollRoles) } : nil
    let win = frontWindow(appEl).flatMap(axFrame)
    var visible = win
    if let f = area.flatMap(axFrame) { visible = win.map { f.intersection($0) } ?? f }
    guard let v = visible, !v.isEmpty else { throw HandsError("Did not scroll: found no visible area of \(t.name) at that point.") }

    let vertical = sign.dy != 0
    let px = pagePixels(vertical ? v.height : v.width, Double(pages))
    let bar = area.flatMap { axAncestor($0, ["AXScrollArea"]) }
        .flatMap { axElement(axGet($0, vertical ? "AXVerticalScrollBar" : "AXHorizontalScrollBar")) }
    let before = bar.flatMap(barValue)
    scrollWheel(at: p, dx: sign.dx * px, dy: sign.dy * px)
    try await Task.sleep(nanoseconds: settleNs)
    let after = bar.flatMap(barValue)
    guard let before, let after else { return ["pixels": px, "position": NSNull(), "moved": NSNull()] }
    return ["pixels": px, "position": after, "moved": abs(after - before) > 0.0005]
}

/// A URL in its app, or a file, folder or app by path. Done when that app is in front with a window.
private func open(_ args: [String: Any]) async throws -> [String: Any] {
    let url: URL
    if let s = text(args, "url") {
        guard let u = URL(string: s), u.scheme != nil else { throw HandsError("Not a URL: \(s)") }
        url = u
    } else if let s = text(args, "path") {
        let p = (s as NSString).expandingTildeInPath
        guard FileManager.default.fileExists(atPath: p) else { throw HandsError("No such file or folder: \(s)") }
        url = URL(fileURLWithPath: p)
    } else {
        throw HandsError("open needs a url or a path.")
    }
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = true
    let app: NSRunningApplication
    if url.isFileURL && url.pathExtension == "app" {
        app = try await NSWorkspace.shared.openApplication(at: url, configuration: cfg)
    } else {
        guard let handler = NSWorkspace.shared.urlForApplication(toOpen: url) else { throw HandsError("No app opens \(url.absoluteString).") }
        app = try await NSWorkspace.shared.open([url], withApplicationAt: handler, configuration: cfg)
    }
    let name = app.localizedName ?? url.lastPathComponent
    target = Target(pid: app.processIdentifier, name: name)
    guard await until(12, { ready(app.processIdentifier) }) else { throw HandsError("Opened it in \(name), but no window came to the front within 12 s.") }
    return ["app": name]
}
