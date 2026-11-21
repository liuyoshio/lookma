// see: a screenshot of the app's window plus the elements a person could act on or read, with
// ids. Only elements inside the visible window and inside their scroll area are listed.
// Element ids count up across sees, so an id from an older see is caught as stale. The last see's
// elements and screenshot stay here for the ops that act on them (resolve, press).
import AppKit
import ApplicationServices

struct Element {
    let id: String
    let ax: AXUIElement
    let axRole: String
    let role: String
    let text: String
    let rect: CGRect
    let pid: pid_t
    let app: String
}

/// The last screenshot: maps a point in its pixels back to screen points.
struct Shot {
    let w: Int, h: Int
    let rect: CGRect
    let pid: pid_t
    let app: String
}

// What the last see found, and the id counter. Owned by the op queue (Link.serve), which runs one
// op at a time, so they need no lock; never touch them from the main thread.
private var elements: [String: Element] = [:]
private(set) var lastShot: Shot? = nil
private var nextId = 0

func element(_ raw: Any?) throws -> Element {
    var id = (raw as? String) ?? (raw as? NSNumber)?.stringValue ?? ""
    if !id.hasPrefix("e") { id = "e" + id }
    guard let e = elements[id] else { throw HandsError("Unknown or stale element \(id); call see again.") }
    return e
}

private let actionRoles: Set<String> = ["AXButton", "AXLink", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
                                        "AXPopUpButton", "AXMenuButton", "AXComboBox", "AXMenuItem", "AXSlider",
                                        "AXDisclosureTriangle", "AXTab", "AXRow", "AXIncrementor", "AXSegment"]
private let textRoles: Set<String> = ["AXStaticText", "AXHeading"]
private let walkAttrs = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXPlaceholderValue",
                         "AXPosition", "AXSize", "AXChildren"] as CFArray
private let maxElements = 300, maxVisit = 6000, maxDepth = 60, walkBudget = 1.1

private struct Found { let ax: AXUIElement; let axRole: String; let role: String; let text: String; let rect: CGRect }

private struct Walk {
    var visited = 0
    var deadline: Double
    var out: [Found] = []
    var full: Bool { visited > maxVisit || out.count >= maxElements || now() > deadline }
}

private func attrs(_ e: AXUIElement) -> [Any?]? {
    var arr: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(e, walkAttrs, AXCopyMultipleAttributeOptions(rawValue: 0), &arr) == .success,
          let ns = arr as NSArray? else { return nil }
    return (0..<ns.count).map { axUnwrap(ns[$0] as AnyObject) }
}

// `clip` is the visible part: the window, narrowed by every scroll area on the way down.
// `inside` is the label of the nearest actionable ancestor, so its own text is not listed twice.
private func walk(_ e: AXUIElement, depth: Int, clip: CGRect, inside: String?, _ w: inout Walk) {
    if w.full { return }
    w.visited += 1
    guard let v = attrs(e) else { return }
    let role = v[0] as? String ?? ""
    let subrole = v[1] as? String ?? ""
    var frame: CGRect? = nil
    if let p = v[6] as? CGPoint, let s = v[7] as? CGSize { frame = CGRect(origin: p, size: s) }
    var clip2 = clip
    if let f = frame, f.width > 0, f.height > 0 {
        if !f.intersects(clip) { return } // scrolled out or off the window: skip the whole subtree
        if scrollRoles.contains(role) { clip2 = clip.intersection(f) }
    }
    var inside2 = inside
    let isAction = actionRoles.contains(role) || subrole == "AXSearchField"
    let isText = textRoles.contains(role)
    let isScroll = scrollRoles.contains(role)
    if isAction || isText || isScroll, let f = frame, f.width > 1, f.height > 1, f.intersects(clip) {
        var parts: [String] = []
        func add(_ s: String?) { if let s = clean(s), !parts.contains(s) { parts.append(s) } }
        add(v[2] as? String)
        add(v[3] as? String)
        if let s = v[4] as? String { add(s) } else if let n = v[4] as? NSNumber, isAction { add(n.stringValue) }
        if let p = clean(v[5] as? String) { parts.append("placeholder: \(p)") }
        let text = clean(parts.joined(separator: " | "), 120) ?? ""
        let redundant = isText && (text.isEmpty || (inside?.contains(text) ?? false))
        if !redundant && !(isScroll && text.isEmpty && role != "AXWebArea") {
            let r = subrole == "AXSearchField" ? "searchfield" : String(role.dropFirst(2)).lowercased()
            w.out.append(Found(ax: e, axRole: role, role: r, text: text, rect: f.intersection(clip)))
        }
        if isAction { inside2 = text }
    }
    guard depth < maxDepth, let kids = v[8] as? [AXUIElement] else { return }
    for k in kids { walk(k, depth: depth + 1, clip: clip2, inside: inside2, &w) }
}

func see(_ name: String?) async throws -> [String: Any] {
    guard let app = findApp(name) else { throw notRunning(name) }
    let pid = app.processIdentifier
    let appName = app.localizedName ?? "app"
    let appEl = AXUIElementCreateApplication(pid)
    if enableAX(app) { try await Task.sleep(nanoseconds: 600_000_000) }
    guard let win = frontWindow(appEl), let focused = axFrame(win) else { throw HandsError("\(appName) has no open window.") }

    // Some apps split one visual window into several (Chrome in full screen puts its toolbar in
    // its own window). Take every window of the app that touches the focused one.
    var wins: [(AXUIElement, CGRect)] = [(win, focused)]
    var others: [(AXUIElement, CGRect)] = ((axGet(appEl, "AXWindows") as? [AXUIElement]) ?? []).compactMap { w in
        guard !CFEqual(w, win), let f = axFrame(w), f.width > 1, f.height > 1, !f.contains(focused) else { return nil }
        return (w, f)
    }
    var area = focused
    while let i = others.firstIndex(where: { $0.1.intersects(area.insetBy(dx: -2, dy: -2)) }) {
        wins.append(others[i])
        area = area.union(others[i].1)
        others.remove(at: i)
    }
    let visible = area.intersection(mainBounds())
    guard !visible.isNull, visible.width >= 1, visible.height >= 1 else { throw HandsError("\(appName)'s window is not on the main display.") }

    async let shot = capture(visible, pid: pid)
    var w = Walk(deadline: now() + walkBudget)
    for (el, f) in wins.sorted(by: { $0.1.minY < $1.1.minY }) { walk(el, depth: 0, clip: f.intersection(visible), inside: nil, &w) }
    let (img, rect) = try await shot

    elements = [:]
    var list: [[String: Any]] = []
    for f in w.out {
        nextId += 1
        let e = Element(id: "e\(nextId)", ax: f.ax, axRole: f.axRole, role: f.role, text: f.text, rect: f.rect, pid: pid, app: appName)
        elements[e.id] = e
        list.append(["id": e.id, "role": e.role, "text": e.text, "rect": rectJSON(e.rect)])
    }
    lastShot = Shot(w: img.width, h: img.height, rect: rect, pid: pid, app: appName)
    return [
        "image": png(img).base64EncodedString(),
        "shot": ["w": img.width, "h": img.height, "rect": rectJSON(rect)],
        "app": appName,
        "window": ["title": axString(win, "AXTitle") ?? "", "rect": rectJSON(visible)],
        "elements": list,
    ]
}
