// swift-tools-version:6.0
// Sotto native app (docs/NATIVE.md §5). No third-party dependencies.
import PackageDescription

let package = Package(
    name: "Sotto",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Sotto", targets: ["SottoApp"]),
    ],
    targets: [
        // C11 atomics for the real-time rings (Synchronization.Atomic needs macOS 15).
        .target(name: "CSottoAtomics"),
        // Audio engine: capture, playout, jitter buffer, fake audio. Depends only on CSottoAtomics.
        .target(name: "SottoAudio", dependencies: ["CSottoAtomics"]),
        // Daemon link: bootstrap, WebSocket client, protocol types, frame codec.
        .target(name: "SottoClient"),
        // SwiftUI views + StateModel. Knows the protocol types, not the audio engine.
        .target(name: "SottoUI", dependencies: ["SottoClient"]),
        // App: menu bar, floating panel, hotkeys, URL scheme, wiring (Controller).
        .executableTarget(name: "SottoApp", dependencies: ["SottoAudio", "SottoClient", "SottoUI"]),
        .testTarget(name: "SottoAudioTests", dependencies: ["SottoAudio"]),
        .testTarget(name: "SottoClientTests", dependencies: ["SottoClient"]),
        .testTarget(name: "SottoUITests", dependencies: ["SottoUI", "SottoClient"]),
    ],
    swiftLanguageModes: [.v5]
)
