// swift-tools-version: 5.9
import PackageDescription

// The iOS shell's native code. MurageShellCore is Foundation-only, so its
// tests run on the Mac with `swift test`; MurageShell holds the UIKit/WebKit
// half, every file wrapped in `#if os(iOS)` so the macOS test build skips it.
// MurageCallAudioCore is the testable half of native call audio (spec §4.2):
// argument limits, sniffing, the mic framer and resampler, the streamed
// decoder and the clip bookkeeping. It uses AVFAudio and AudioToolbox but no
// AVAudioSession or AVAudioEngine, so it also runs on the Mac. Only
// MurageShell depends on it; the notification extension never links it.
let package = Package(
    name: "MurageShell",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "MurageShell", targets: ["MurageShell", "MurageShellCore"]),
        // The extension links only this: Foundation, no UIKit or WebKit.
        .library(name: "MurageShellCore", targets: ["MurageShellCore"]),
    ],
    targets: [
        .target(name: "MurageShellCore"),
        .target(
            name: "MurageCallAudioCore",
            linkerSettings: [.linkedFramework("AVFAudio"), .linkedFramework("AudioToolbox")]
        ),
        .target(name: "MurageShell", dependencies: ["MurageShellCore", "MurageCallAudioCore"]),
        .testTarget(name: "MurageShellCoreTests", dependencies: ["MurageShellCore"]),
        // iOS simulator only (`xcodebuild test` on this package): drives
        // CallAudioEngine with posted notifications. Empty on the Mac.
        .testTarget(name: "MurageShellTests", dependencies: ["MurageShell", "MurageCallAudioCore"]),
        .testTarget(
            name: "MurageCallAudioCoreTests",
            dependencies: ["MurageCallAudioCore"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
