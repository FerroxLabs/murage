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

    func testExistingPairedUserGoesStraightToChats() {
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .paired,
                hasSeenWelcome: true
            )),
            .chats
        )
    }

    func testJustPairedUserSeesNotificationExplanationOnceThenChats() {
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .paired,
                hasSeenWelcome: true,
                notificationOnboardingRequested: true
            )),
            .notificationPrompt
        )
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .paired,
                hasSeenWelcome: true,
                notificationOnboardingRequested: true,
                hasSeenNotificationPrompt: true
            )),
            .chats
        )
        XCTAssertEqual(
            CompanionOnboardingRouter.route(for: .init(
                pairingState: .paired,
                hasSeenWelcome: true,
                notificationOnboardingRequested: true,
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
