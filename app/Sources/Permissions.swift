// The macOS permissions the app depends on: Accessibility for the hands, Screen Recording for see,
// the microphone for the voice (the overlay's web view), and the camera for hand gestures
// (HandCamera.swift, which is also the one place that asks for it).
import ApplicationServices
import AVFoundation
import CoreGraphics

/// What macOS grants this app now, for the hello and for check mode (main.swift). Asks for nothing.
func permissions() -> [String: Bool] {
    [
        "accessibility": AXIsProcessTrusted(),
        "screen": CGPreflightScreenCaptureAccess(),
        "microphone": AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
        "camera": AVCaptureDevice.authorizationStatus(for: .video) == .authorized,
    ]
}
