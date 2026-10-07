#if os(iOS)
import MurageShellCore
import UIKit

/// `haptic(kind)` (spec §3.2; approve, deny and send, §4).
@MainActor
enum Haptics {
    static func play(_ kind: HapticKind) {
        switch kind {
        case .tap: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .success: UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .warning: UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case .error: UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }
}
#endif
