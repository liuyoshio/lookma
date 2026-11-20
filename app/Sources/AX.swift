// Accessibility helpers: attributes, apps by name (running, installed or in the Dock) and their
// windows, the app with keyboard focus, and the extra attributes web-based apps need before they
// expose their tree (set only on apps the hands target).
import AppKit
import ApplicationServices

func axGet(_ e: AXUIElement, _ a: String) -> AnyObject? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success, let v else { return nil }
    return v as AnyObject
}

@discardableResult
func axSet(_ e: AXUIElement, _ a: String, _ v: CFTypeRef) -> AXError {
    AXUIElementSetAttributeValue(e, a as CFString, v)
}

func axString(_ e: AXUIElement, _ a: String) -> String? { axGet(e, a) as? String }

func axElement(_ v: AnyObject?) -> AXUIElement? {
    guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

func axUnwrap(_ v: AnyObject?) -> Any? {
    guard let v else { return nil }
    guard CFGetTypeID(v) == AXValueGetTypeID() else { return v }
    let ax = v as! AXValue
    switch AXValueGetType(ax) {
    case .cgPoint: var p = CGPoint.zero; AXValueGetValue(ax, .cgPoint, &p); return p
    case .cgSize: var s = CGSize.zero; AXValueGetValue(ax, .cgSize, &s); return s
    default: return nil // includes the error value of a missing attribute
    }
}

func axFrame(_ e: AXUIElement) -> CGRect? {
    guard let p = axUnwrap(axGet(e, "AXPosition")) as? CGPoint,
          let s = axUnwrap(axGet(e, "AXSize")) as? CGSize else { return nil }
    return CGRect(origin: p, size: s)
}

func axActions(_ e: AXUIElement) -> [String] {
    var names: CFArray?
    AXUIElementCopyActionNames(e, &names)
    return (names as? [String]) ?? []
}

func axPid(_ e: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    return AXUIElementGetPid(e, &pid) == .success ? pid : nil
}

// MARK: - apps

let systemWide = AXUIElementCreateSystemWide()

/// The app with keyboard focus. Asked of the accessibility server, because NSWorkspace's cached
/// value was measured lagging a Dock click by seconds.
func frontPid() -> pid_t? {
    if let a = axElement(axGet(systemWide, "AXFocusedApplication")), let pid = axPid(a) { return pid }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

func appName(_ pid: pid_t?) -> String {
    guard let pid else { return "no app" }
    return NSRunningApplication(processIdentifier: pid)?.localizedName ?? "pid \(pid)"
}

/// A running app by bundle id or name (exact first, then contains). nil or "" means frontmost.
func findApp(_ name: String?) -> NSRunningApplication? {
    guard let name, !name.isEmpty else { return frontPid().flatMap { NSRunningApplication(processIdentifier: $0) } }
    let n = name.lowercased().replacingOccurrences(of: ".app", with: "")
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    return apps.first { $0.bundleIdentifier?.lowercased() == n }
        ?? apps.first { $0.localizedName?.lowercased() == n }
        ?? apps.first { $0.localizedName?.lowercased().contains(n) ?? false }
}

func notRunning(_ name: String?) -> HandsError {
    HandsError(name.map { "\($0) is not running. Open it first." } ?? "No app has keyboard focus.")
}

func frontWindow(_ appEl: AXUIElement) -> AXUIElement? {
    axElement(axGet(appEl, "AXFocusedWindow")) ?? axElement(axGet(appEl, "AXMainWindow"))
        ?? (axGet(appEl, "AXWindows") as? [AXUIElement])?.first
}

/// An installed app's bundle, for apps that have no Dock icon.
func appURL(_ name: String) -> URL? {
    if let u = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) { return u }
    let file = name.hasSuffix(".app") ? name : name + ".app"
    for dir in ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities",
                NSHomeDirectory() + "/Applications"] {
        let p = dir + "/" + file
        if FileManager.default.fileExists(atPath: p) { return URL(fileURLWithPath: p) }
    }
    return nil
}

// MARK: - the Dock

func dockApp() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first
}

/// The Dock's application icons (kept and running apps alike).
func dockItems() -> [AXUIElement] {
    guard let dock = dockApp(), let kids = axGet(AXUIElementCreateApplication(dock.processIdentifier), "AXChildren") as? [AXUIElement] else { return [] }
    var items: [AXUIElement] = []
    for list in kids where axString(list, "AXRole") == "AXList" {
        items += ((axGet(list, "AXChildren") as? [AXUIElement]) ?? []).filter { axString($0, "AXSubrole") == "AXApplicationDockItem" }
    }
    return items
}

func dockItem(named name: String) -> AXUIElement? {
    let n = name.lowercased().replacingOccurrences(of: ".app", with: "")
    let items = dockItems().map { ($0, (axString($0, "AXTitle") ?? "").lowercased()) }
    return (items.first { $0.1 == n } ?? items.first { !$0.1.isEmpty && $0.1.contains(n) })?.0
}

/// The running app a Dock icon stands for, if it is running.
func dockItemApp(_ item: AXUIElement) -> NSRunningApplication? {
    guard let v = axGet(item, "AXURL") else { return nil }
    guard let url = (v as? URL) ?? URL(string: "\(v)"), let id = Bundle(url: url)?.bundleIdentifier else { return nil }
    return NSRunningApplication.runningApplications(withBundleIdentifier: id).first
}

// MARK: - attributes for web-based apps

// Electron builds its web AX tree only when AXManualAccessibility is set; Chromium browsers also
// want AXEnhancedUserInterface (what VoiceOver sets). We set them on target apps only, remember
// what we turned on ourselves, and turn it off again on every exit path (restoreAX).
private var turnedOn: [pid_t: [String]] = [:]
private let axLock = NSLock()

private func frameworks(_ app: NSRunningApplication) -> [String] {
    guard let url = app.bundleURL else { return [] }
    return (try? FileManager.default.contentsOfDirectory(atPath: url.appendingPathComponent("Contents/Frameworks").path)) ?? []
}

/// Sets the attributes on first contact. Returns true when the app builds its tree lazily and was
/// just switched on, so the caller should give it a moment (measured: 0.6 to 2.6 s).
func enableAX(_ app: NSRunningApplication) -> Bool {
    let pid = app.processIdentifier
    axLock.lock()
    defer { axLock.unlock() }
    if turnedOn[pid] != nil { return false }
    let fw = frameworks(app)
    let electron = fw.contains("Electron Framework.framework")
    let chromium = fw.contains { name in
        name.hasSuffix("Framework.framework") && ["Chrome", "Chromium", "Edge", "Brave"].contains { name.contains($0) }
    }
    let el = AXUIElementCreateApplication(pid)
    var set: [String] = []
    for a in ["AXManualAccessibility"] + (chromium ? ["AXEnhancedUserInterface"] : []) {
        if (axGet(el, a) as? Bool) == true { continue } // someone else turned it on; leave it to them
        let e = axSet(el, a, kCFBooleanTrue)
        // Electron answers "unsupported" even when the set worked, so keep it either way.
        if e == .success || e == .attributeUnsupported { set.append(a) }
    }
    turnedOn[pid] = set
    return electron || chromium
}

func restoreAX() {
    axLock.lock()
    defer { axLock.unlock() }
    for (pid, attrs) in turnedOn {
        let el = AXUIElementCreateApplication(pid)
        for a in attrs { axSet(el, a, kCFBooleanFalse) }
    }
    turnedOn = [:]
}
