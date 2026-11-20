// The macOS permissions the app depends on: Accessibility for the hands, Screen Recording for see,
// and the microphone for the voice (the overlay's web view).
import ApplicationServices
import AVFoundation
import CoreGraphics

/// What macOS grants this app now, for the hello and for check mode (main.swift). Asks for nothing.
func permissions() -> [String: Bool] {
    [
        "accessibility": AXIsProcessTrusted(),
        "screen": CGPreflightScreenCaptureAccess(),
        "microphone": AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
    ]
}
