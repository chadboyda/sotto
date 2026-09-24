// Default system implementations the app can wire into SettingsHooks.
// Nothing here runs by itself: tests never call these (no TCC prompt, no login item).
import AppKit
import AVFoundation
import ServiceManagement

public enum MicAccess {
    /// Reads the privacy state. Never prompts.
    public static func current() -> MicPermission {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .granted
        case .notDetermined: return .notDetermined
        case .denied: return .denied
        case .restricted: return .restricted
        @unknown default: return .unknown
        }
    }

    /// Shows the macOS question once (no-op after the user answered). Do not call under `--test`.
    public static func request() async -> MicPermission {
        if current() != .notDetermined { return current() }
        _ = await AVCaptureDevice.requestAccess(for: .audio)
        return current()
    }

    public static let privacyURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!

    public static func openPrivacySettings() { NSWorkspace.shared.open(privacyURL) }
}

public enum LoginItem {
    public static func current() -> LoginItemState {
        guard Bundle.main.bundleURL.pathExtension == "app" else { return .unavailable }
        switch SMAppService.mainApp.status {
        case .enabled: return .on
        case .requiresApproval: return .requiresApproval
        case .notRegistered: return .off
        case .notFound: return .unavailable
        @unknown default: return .unavailable
        }
    }

    /// Register or unregister the main app as a login item. Do not call under `--test`.
    public static func set(_ on: Bool) throws -> LoginItemState {
        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        return current()
    }

    public static func openSettings() { SMAppService.openSystemSettingsLoginItems() }
}
