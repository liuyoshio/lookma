// Helpers the whole app shares: the log line, the clock and polling, the error an op reports,
// UI text cleanup, and rects and points in the shape docs/protocol.md sends them.
import CoreGraphics
import Foundation

// The core's line format (local HH:MM:SS.mmm, then who is speaking), so the two logs read as one.
private let logTime: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "HH:mm:ss.SSS"
    return f
}()

func log(_ s: String) { print("\(logTime.string(from: Date())) app \(s)") }

func now() -> Double { CFAbsoluteTimeGetCurrent() }

/// Polls `cond` every 50 ms for up to `timeout` seconds. True as soon as it holds.
func until(_ timeout: Double, _ cond: () -> Bool) async -> Bool {
    let end = now() + timeout
    while now() < end {
        if cond() { return true }
        try? await Task.sleep(nanoseconds: 50_000_000)
    }
    return cond()
}

/// An op's failure. The message goes to the executor as the tool's error, so it says what to do next.
struct HandsError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// UI text as one short line: newlines and runs of spaces collapsed, object placeholders (U+FFFC)
/// dropped, cut at `max` characters. nil when nothing is left.
func clean(_ s: String?, _ max: Int = 100) -> String? {
    guard let s else { return nil }
    var t = s.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\u{FFFC}", with: "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    while t.contains("  ") { t = t.replacingOccurrences(of: "  ", with: " ") }
    if t.isEmpty { return nil }
    if t.count > max { t = String(t.prefix(max)) + "…" }
    return t
}

func rectJSON(_ r: CGRect) -> [String: Int] {
    ["x": Int(r.minX.rounded()), "y": Int(r.minY.rounded()), "w": Int(r.width.rounded()), "h": Int(r.height.rounded())]
}

func center(_ r: CGRect) -> [Int] { [Int(r.midX.rounded()), Int(r.midY.rounded())] }
