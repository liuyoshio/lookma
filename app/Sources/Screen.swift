// The screen: the main display, whether an app's window is really on it, and screenshots that
// show only the target app (so our own overlay never appears in what the executor sees).
import AppKit
import ImageIO
import ScreenCaptureKit

/// The main display in global screen points, top-left origin. The overlay covers exactly this.
func mainBounds() -> CGRect { CGDisplayBounds(CGMainDisplayID()) }

/// A normal window of the app that is on screen now, on the main display.
func onScreenWindow(_ pid: pid_t) -> CGRect? {
    guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    let main = mainBounds()
    for w in info where (w[kCGWindowOwnerPID as String] as? pid_t) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
        if ((w[kCGWindowAlpha as String] as? Double) ?? 1) <= 0 { continue }
        guard let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) else { continue }
        if r.width > 40 && r.height > 40 && r.intersects(main) { return r }
    }
    return nil
}

/// Frontmost, with a window really on screen. After a Space switch (about 1 s) the app is
/// frontmost well before its window shows.
func ready(_ pid: pid_t) -> Bool { frontPid() == pid && onScreenWindow(pid) != nil }

/// A screenshot, the screen rect it shows, and the seconds spent finding the app's window in the
/// shareable content (`share`) and taking the picture (`grab`), for see's log line.
struct Capture {
    let image: CGImage
    let rect: CGRect
    let share: Double
    let grab: Double
}

/// A screenshot of `rect` (screen points) with only the app's own windows in it: its menus and
/// popups are in; our overlay and anything covering the app are out. The long edge is at most
/// `maxEdge` pixels and never more than one pixel per point. Waits up to about a second for the
/// app's window to show up in the shareable content.
func capture(_ rect: CGRect, pid: pid_t, maxEdge: CGFloat = 1280) async throws -> Capture {
    let start = now()
    var content: SCShareableContent? = nil
    let end = start + 1.0
    repeat {
        let c = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        if c.windows.contains(where: { $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.isOnScreen }) {
            content = c
            break
        }
        try await Task.sleep(nanoseconds: 150_000_000)
    } while now() < end
    guard let content, let app = content.applications.first(where: { $0.processID == pid }) else {
        throw HandsError("The app's window is not on screen (another Space, minimized or hidden).")
    }
    guard let d = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else { throw HandsError("No main display.") }
    let r = rect.intersection(d.frame).integral
    guard r.width >= 1, r.height >= 1 else { throw HandsError("The window is not on the main display.") }
    let scale = min(1, maxEdge / max(r.width, r.height))
    let cfg = SCStreamConfiguration()
    cfg.sourceRect = r.offsetBy(dx: -d.frame.minX, dy: -d.frame.minY)
    cfg.width = max(1, Int((r.width * scale).rounded()))
    cfg.height = max(1, Int((r.height * scale).rounded()))
    cfg.showsCursor = false
    let filter = SCContentFilter(display: d, including: [app], exceptingWindows: [])
    let found = now()
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    return Capture(image: image, rect: r, share: found - start, grab: now() - found)
}

/// PNG without an alpha channel: about a quarter smaller, and the model has no use for alpha.
func png(_ img: CGImage) -> Data {
    let out = NSMutableData()
    guard let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
          let dest = CGImageDestinationCreateWithData(out, "public.png" as CFString, 1, nil) else { return Data() }
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: img.width, height: img.height))
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
    guard let flat = ctx.makeImage() else { return Data() }
    CGImageDestinationAddImage(dest, flat, nil)
    CGImageDestinationFinalize(dest)
    return out as Data
}
