// What the gesture engine's outputs do, on the camera's capture queue (HandCamera.swift). The
// dot: the engine's hand point, carried from the camera frame to the main display, where the
// overlay draws it (Overlay.hand). The central part of the frame stretches to the whole screen in
// each axis, so the dot reaches the edges while the hand stays in view. Page calls go to main
// asynchronously, never synchronously: HandCamera.stop() waits on the capture queue from main.
import CoreGraphics
import Foundation

final class GestureOutput {
    /// The share of the camera frame, in each axis, that spans the screen.
    private static let reach = 0.7

    private let overlay: Overlay
    private var shown = false

    init(overlay: Overlay) { self.overlay = overlay }

    /// This frame's dot, or nil with no hand; aspect is the frame's width over its height.
    func dot(_ d: HandDot?, aspect: Double) {
        guard let d else { return hide() }
        let margin = (1 - Self.reach) / 2
        let fit = { (v: Double) in min(max((v - margin) / Self.reach, 0), 1) }
        let at = (x: fit(d.x / aspect), y: fit(d.y), pinched: d.pinched)
        shown = true
        DispatchQueue.main.async { [overlay] in overlay.hand(at) }
    }

    /// No dot, as when the camera stops.
    func hide() {
        guard shown else { return }
        shown = false
        DispatchQueue.main.async { [overlay] in overlay.hand(nil) }
    }
}
