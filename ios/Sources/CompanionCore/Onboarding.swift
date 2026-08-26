/// A small, platform-neutral decision seam for the companion's first-run flow.
///
/// Keeping this outside SwiftUI makes the important transitions explicit and
/// testable: skipping setup must not look like a pairing, a pending deep link
/// must still open pairing, and a revoked credential must never fall through
/// to an ordinary empty state.
public enum CompanionPairingState: Equatable, Sendable {
    case unpaired
    case paired
    case revoked
}

public enum CompanionOnboardingRoute: Equatable, Sendable {
    case welcome
    case pairing
    case unpairedHome
    case notificationPrompt
    case chats
    case revoked
}

public struct CompanionOnboardingContext: Equatable, Sendable {
    public var pairingState: CompanionPairingState
    public var hasSeenWelcome: Bool
    public var pairingRequested: Bool
    public var hasPendingPairingInvite: Bool
    /// True only while the current UI flow is completing a new pairing.
    /// Existing paired users must not see first-pair education on upgrade.
    public var notificationOnboardingRequested: Bool
    public var hasSeenNotificationPrompt: Bool
    public var notificationPermissionIsUndetermined: Bool

    public init(
        pairingState: CompanionPairingState,
        hasSeenWelcome: Bool,
        pairingRequested: Bool = false,
        hasPendingPairingInvite: Bool = false,
        notificationOnboardingRequested: Bool = false,
        hasSeenNotificationPrompt: Bool = false,
        notificationPermissionIsUndetermined: Bool = true
    ) {
        self.pairingState = pairingState
        self.hasSeenWelcome = hasSeenWelcome
        self.pairingRequested = pairingRequested
        self.hasPendingPairingInvite = hasPendingPairingInvite
        self.notificationOnboardingRequested = notificationOnboardingRequested
        self.hasSeenNotificationPrompt = hasSeenNotificationPrompt
        self.notificationPermissionIsUndetermined = notificationPermissionIsUndetermined
    }
}

public enum CompanionOnboardingRouter {
    public static func route(for context: CompanionOnboardingContext) -> CompanionOnboardingRoute {
        switch context.pairingState {
        case .revoked:
            return .revoked
        case .paired:
            if context.notificationOnboardingRequested,
               !context.hasSeenNotificationPrompt,
               context.notificationPermissionIsUndetermined {
                return .notificationPrompt
            }
            return .chats
        case .unpaired:
            if context.pairingRequested || context.hasPendingPairingInvite {
                return .pairing
            }
            return context.hasSeenWelcome ? .unpairedHome : .welcome
        }
    }
}
