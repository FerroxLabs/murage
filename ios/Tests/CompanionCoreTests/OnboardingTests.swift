import XCTest
@testable import CompanionCore

final class OnboardingTests: XCTestCase {
    func testFirstLaunchShowsWelcome() {
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .unpaired,
                hasSeenWelcome: false
            )),
            .welcome
        )
    }

    func testSkipShowsUsefulUnpairedHome() {
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .unpaired,
                hasSeenWelcome: true
            )),
            .unpairedHome
        )
    }

    func testResumeAndPendingInviteBothOpenPairing() {
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .unpaired,
                hasSeenWelcome: true,
                pairingRequested: true
            )),
            .pairing
        )
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .unpaired,
                hasSeenWelcome: false,
                hasPendingPairingInvite: true
            )),
            .pairing
        )
    }

    func testPairedUserSeesNotificationExplanationOnceThenChats() {
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .paired,
                hasSeenWelcome: true
            )),
            .notificationPrompt
        )
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .paired,
                hasSeenWelcome: true,
                hasSeenNotificationPrompt: true
            )),
            .chats
        )
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .paired,
                hasSeenWelcome: true,
                notificationPermissionIsUndetermined: false
            )),
            .chats
        )
    }

    func testRevokedPairingAlwaysShowsRecovery() {
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .revoked,
                hasSeenWelcome: false,
                pairingRequested: true,
                hasPendingPairingInvite: true
            )),
            .revoked
        )
    }
}
