#if DEBUG && os(iOS)
import UIKit

/// Debug builds only: launch arguments that show a debug screen instead of
/// a workspace. `-murageCallAudioSpike` shows the spec §6.0 call audio spike
/// (`-murageCallAudioSpikeAuto` runs its cases at once, and
/// `-murageCallAudioSelfTest` its channel self-test). Kept out of
/// ShellCoordinator, which only asks whether a debug screen was shown.
extension ShellCoordinator {
    private static var callAudioSpike = false
    private static var callAudioSpikeAuto = false

    static func parseDebugLaunch(_ arguments: [String]) {
        callAudioSpike = arguments.contains("-murageCallAudioSpike")
        callAudioSpikeAuto = arguments.contains("-murageCallAudioSpikeAuto")
    }

    /// Presents the screen the arguments asked for; false when there is none.
    func presentDebugScreen(on launcher: UIViewController) -> Bool {
        guard Self.callAudioSpike else { return false }
        launcher.present(CallAudioSpikeViewController(auto: Self.callAudioSpikeAuto), animated: false)
        return true
    }
}
#endif
