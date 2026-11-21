// see: the elements a person could act on or read in the app's window, with ids and states, and a
// screenshot only when the call asks for one. Only elements inside the visible window and inside
// their scroll area are listed. An open menu (context, pop-up or menu bar) is listed first, and the
// visible area grows to take it in. The result says why the list stopped early (`cut`) and how many
// actionable elements have no label, so the agent can tell when the list is not enough. Text is one
// line, cut longer for what is there to be read (text, headings, text areas) than for labels.
// A menu item's submenu is listed only when it is open, as a menu of its own: a closed one can still
// report frames, and its items would look clickable.
// An id names the same element for as long as it is listed: each see keeps the id of every element
// it finds again (the same AX element), gives a new one to the rest, and drops what it did not find,
// so an id of an element that is gone is caught as stale. The core lists after every action, and an
// agent may send two calls from one list. The latest list's elements, and the last screenshot
// taken, stay here for the ops that act on them (resolve, press). Each see logs a `see parts` line
// with where its time went (docs/protocol.md).
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

/// The last screenshot: maps a point in its pixels back to screen points, as long as the window it
/// was taken of still has the frame it had then.
struct Shot {
    let w: Int, h: Int
    let rect: CGRect
    let pid: pid_t
    let app: String
    let window: AXUIElement
    let frame: CGRect
}

// What the latest see found, and the id counter. Owned by the op queue (Link.serve), which runs one
// op at a time, so they need no lock; never touch them from the main thread.
private var elements: [String: Element] = [:]
private(set) var lastShot: Shot? = nil
private var nextId = 0

private func newId() -> String {
    nextId += 1
    return "e\(nextId)"
}

func element(_ raw: Any?) throws -> Element {
    var id = (raw as? String) ?? (raw as? NSNumber)?.stringValue ?? ""
    if !id.hasPrefix("e") { id = "e" + id }
    guard let e = elements[id] else { throw HandsError("Unknown or stale element \(id); call see again.") }
    return e
}

private let actionRoles: Set<String> = ["AXButton", "AXLink", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
                                        "AXPopUpButton", "AXMenuButton", "AXComboBox", "AXMenuItem", "AXSlider",
                                        "AXDisclosureTriangle", "AXTab", "AXRow", "AXIncrementor", "AXSegment"]
// Listed when they have text. An image with a label says what an icon means; one without is what
// the screenshot is for.
private let textRoles: Set<String> = ["AXStaticText", "AXHeading", "AXImage"]
private let walkAttrs = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXPlaceholderValue",
                         "AXPosition", "AXSize", "AXChildren", "AXEnabled", "AXSelected", "AXFocused"] as CFArray
private let maxElements = 300, maxVisit = 6000, maxDepth = 60, walkBudget = 1.1
// How much of an element's text is listed: enough of a paragraph to read it without a screenshot,
// and a short line for everything else.
private let readRoles: Set<String> = ["AXStaticText", "AXHeading", "AXTextArea"]
private let readLength = 400, labelLength = 120

private struct Found { let ax: AXUIElement; let axRole: String; let role: String; let text: String; let states: [String]; let rect: CGRect }

private struct Walk {
    var visited = 0
    var deadline: Double
    var out: [Found] = []
    var unlabeled = 0 // listed actionable elements with no text
    var listed: [CFHashCode: [AXUIElement]] = [:] // so an element reached twice (an open menu) is listed once
    var cut: String? = nil // the limit that stopped the walk: "elements", "visits" or "time"

    /// True once a limit is reached; the first one reached is kept in `cut`. "elements" is set where
    /// an element would be listed past the limit, so a list that is exactly full is not called cut.
    mutating func full() -> Bool {
        if cut == nil { cut = visited > maxVisit ? "visits" : now() > deadline ? "time" : nil }
        return cut != nil
    }
}

private func attrs(_ e: AXUIElement) -> [Any?]? {
    var arr: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(e, walkAttrs, AXCopyMultipleAttributeOptions(rawValue: 0), &arr) == .success,
          let ns = arr as NSArray? else { return nil }
    return (0..<ns.count).map { axUnwrap(ns[$0] as AnyObject) }
}

// `clip` is the visible part: the window, narrowed by every scroll area on the way down.
// `inside` is the label of the nearest actionable ancestor, so its own text is not listed twice.
// `inItem` is set under a menu item, whose AXMenu child is its submenu.
private func walk(_ e: AXUIElement, depth: Int, clip: CGRect, inside: String?, inItem: Bool = false, _ w: inout Walk) {
    if w.full() { return }
    w.visited += 1
    guard let v = attrs(e) else { return }
    let role = v[0] as? String ?? ""
    if inItem && role == "AXMenu" { return } // open submenus come from openMenus
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
        let limit = readRoles.contains(role) ? readLength : labelLength
        var parts: [String] = []
        func add(_ s: String?) { if let s = clean(s, limit), !parts.contains(s) { parts.append(s) } }
        add(v[2] as? String)
        add(v[3] as? String)
        if let s = v[4] as? String { add(s) } else if let n = v[4] as? NSNumber, isAction { add(n.stringValue) }
        if let p = clean(v[5] as? String) { parts.append("placeholder: \(p)") }
        let text = clean(parts.joined(separator: " | "), limit) ?? ""
        let redundant = isText && (text.isEmpty || (inside?.contains(text) ?? false))
        if !redundant && !(isScroll && text.isEmpty && role != "AXWebArea") && !w.listed[CFHash(e), default: []].contains(where: { CFEqual($0, e) }) {
            if w.out.count == maxElements {
                w.cut = "elements"
                return
            }
            w.listed[CFHash(e), default: []].append(e)
            let r = subrole == "AXSearchField" ? "searchfield" : String(role.dropFirst(2)).lowercased()
            // Only what is set: most elements have no AXSelected, and text has no AXEnabled.
            var states: [String] = []
            if v[9] as? Bool == false { states.append("disabled") }
            if v[10] as? Bool == true { states.append("selected") }
            if v[11] as? Bool == true { states.append("focused") }
            w.out.append(Found(ax: e, axRole: role, role: r, text: text, states: states, rect: f.intersection(clip)))
            if isAction && text.isEmpty { w.unlabeled += 1 }
        }
        if isAction { inside2 = text }
    }
    guard depth < maxDepth, let kids = v[8] as? [AXUIElement] else { return }
    for k in kids { walk(k, depth: depth + 1, clip: clip2, inside: inside2, inItem: role == "AXMenuItem", &w) }
}

func see(_ name: String?, screenshot: Bool) async throws -> [String: Any] {
    guard let app = findApp(name) else { throw notRunning(name) }
    let pid = app.processIdentifier
    let appTitle = app.localizedName ?? "app"
    let appEl = AXUIElementCreateApplication(pid)
    let ms = { (t: Double) in Int((t * 1000).rounded()) }
    // With no screenshot to fall back on, the first list of a web-based app must not be the empty
    // tree it has before it builds one. Once per app per run; 3000 in the log means it gave up.
    var axWait = 0.0
    if enableAX(app) {
        let start = now()
        _ = await until(3.0, { frontWindow(appEl).map(webTreeBuilt) ?? false })
        axWait = now() - start
    }
    guard let win = frontWindow(appEl), let focused = axFrame(win) else { throw HandsError("\(appTitle) has no open window.") }

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
    // Open menus are windows of their own, often outside the app's window.
    let menus: [(AXUIElement, CGRect)] = openMenus(pid).compactMap { m in axFrame(m).map { (m, $0) } }
    for (_, f) in menus { area = area.union(f) }
    let visible = area.intersection(mainBounds())
    guard !visible.isNull, visible.width >= 1, visible.height >= 1 else { throw HandsError("\(appTitle)'s window is not on the main display.") }

    // The menus first, so their items lead the list; `inMenu` counts them.
    func walkAll() -> (Walk, Int) {
        var w = Walk(deadline: now() + walkBudget)
        for (el, f) in menus { walk(el, depth: 0, clip: f.intersection(visible), inside: nil, &w) }
        let inMenu = w.out.count
        for (el, f) in wins.sorted(by: { $0.1.minY < $1.1.minY }) { walk(el, depth: 0, clip: f.intersection(visible), inside: nil, &w) }
        return (w, inMenu)
    }
    let (w, inMenu): (Walk, Int)
    var picture: Capture? = nil
    let walkStart = now()
    if screenshot {
        async let shot = capture(visible, pid: pid) // runs while the walk does
        (w, inMenu) = walkAll()
        picture = try await shot
    } else {
        (w, inMenu) = walkAll()
    }
    let walkTime = now() - walkStart // with a screenshot, the walk runs alongside the capture

    // The previous list by CFHash, so each element found again is matched with CFEqual cheaply.
    var before: [CFHashCode: [Element]] = [:]
    for e in elements.values { before[CFHash(e.ax), default: []].append(e) }
    var table: [String: Element] = [:]
    var list: [[String: Any]] = []
    for f in w.out {
        let id = before[CFHash(f.ax)]?.first(where: { table[$0.id] == nil && CFEqual($0.ax, f.ax) })?.id ?? newId()
        let e = Element(id: id, ax: f.ax, axRole: f.axRole, role: f.role, text: f.text, rect: f.rect, pid: pid, app: appTitle)
        table[id] = e
        list.append(["id": id, "role": e.role, "text": e.text, "states": f.states, "rect": rectJSON(e.rect)])
    }
    elements = table
    var result: [String: Any] = [
        "app": appTitle,
        "frontmost": appName(frontPid()),
        "window": ["title": axString(win, "AXTitle") ?? "", "rect": rectJSON(visible)],
        "elements": list,
        "menu": inMenu,
        "cut": w.cut ?? NSNull(),
        "unlabeled": w.unlabeled,
    ]
    var encode = 0.0, bytes = 0
    if let c = picture {
        lastShot = Shot(w: c.image.width, h: c.image.height, rect: c.rect, pid: pid, app: appTitle, window: win, frame: focused)
        let start = now()
        let data = png(c.image)
        encode = now() - start
        bytes = data.count
        result["image"] = data.base64EncodedString()
    }
    log("see parts ax-wait=\(ms(axWait)) walk=\(ms(walkTime)) visited=\(w.visited) elements=\(list.count) cut=\(w.cut ?? "-") "
        + "share=\(ms(picture?.share ?? 0)) capture=\(ms(picture?.grab ?? 0)) png=\(ms(encode)) bytes=\(bytes)")
    // The screenshot a point refers to, also when this see did not replace it: then it is older.
    if let s = lastShot, s.pid == pid { result["shot"] = ["w": s.w, "h": s.h, "rect": rectJSON(s.rect)] }
    return result
}
