// App entry, and the one place that decides when the event stream lives.
//
// A phone is not a desktop: the stream is torn down the moment the app
// leaves the screen's short background grace period, because iOS is going to
// suspend it anyway and doing it deliberately means the cursor is written
// down at a known point. Coming back asks the harness what was missed rather
// than asking for everything.
import SwiftUI
import CompanionCore
import UserNotifications

@main
struct CompanionApp: App {
    @StateObject private var session = Session()
    @Environment(\.scenePhase) private var scenePhase
    @State private var liveActivities = LiveActivityCoordinator()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .onAppear {
                    session.connect()
                    liveActivities.attach(to: session)
                }
                .onOpenURL { session.receivePairingURL($0) }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        session.connect()
                        Task { await session.refreshNotificationAuthorization() }
                    case .background: session.linger()
                    case .inactive: break
                    @unknown default: break
                    }
                }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var session: Session
    @AppStorage("companion.onboarding.welcomeSeen") private var hasSeenWelcome = false
    @AppStorage("companion.onboarding.notificationsSeen") private var hasSeenNotificationPrompt = false
    @AppStorage(CompanionOnboardingPreferences.pendingNotificationOnboardingKey)
    private var notificationOnboardingPending = false
    @State private var pairingRequested = false

    var body: some View {
        Group {
            switch route {
            case .welcome:
                CompanionWelcomeView(
                    onConnect: startPairing,
                    onSkip: {
                        hasSeenWelcome = true
                        pairingRequested = false
                    }
                )
            case .pairing:
                PairingView {
                    hasSeenWelcome = true
                    pairingRequested = false
                }
                .onAppear {
                    hasSeenWelcome = true
                    pairingRequested = true
                }
            case .unpairedHome:
                UnpairedHomeView(onConnect: startPairing)
            case .notificationPrompt:
                NotificationOnboardingView {
                    hasSeenNotificationPrompt = true
                    notificationOnboardingPending = false
                    pairingRequested = false
                }
                .onAppear { hasSeenWelcome = true }
            case .chats:
                ChatListView()
                    .onAppear {
                        hasSeenWelcome = true
                        // This is either an existing pairing or a new pairing
                        // which needed no notification education. Do not let
                        // a later voluntary unpair reopen Pairing by itself.
                        pairingRequested = false
                        reconcileNotificationOnboarding()
                    }
            case .revoked:
                UnpairedView {
                    session.signOut()
                    startPairing()
                }
            }
        }
        .onChange(of: session.pairingInvite) { _, invite in
            guard invite != nil else { return }
            hasSeenWelcome = true
            pairingRequested = true
        }
        .onAppear { reconcileNotificationOnboarding() }
        .onChange(of: session.notificationAuthorizationResolved) { _, _ in
            reconcileNotificationOnboarding()
        }
        .onChange(of: session.notificationAuthorization) { _, _ in
            reconcileNotificationOnboarding()
        }
        .onChange(of: notificationOnboardingPending) { _, isPending in
            if isPending { reconcileNotificationOnboarding() }
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { session.actionError != nil },
                set: { if !$0 { session.actionError = nil } }
            ),
            presenting: session.actionError
        ) { _ in
            Button("OK", role: .cancel) { session.actionError = nil }
        } message: { message in
            Text(message)
        }
    }

    private var route: CompanionOnboardingRoute {
        let pairingState: CompanionPairingState
        if session.status == .unauthorized {
            pairingState = .revoked
        } else if session.connection != nil {
            pairingState = .paired
        } else {
            pairingState = .unpaired
        }
        return CompanionOnboardingRouter.route(for: .init(
            pairingState: pairingState,
            hasSeenWelcome: hasSeenWelcome,
            pairingRequested: pairingRequested,
            hasPendingPairingInvite: session.pairingInvite != nil,
            notificationOnboardingPending: notificationOnboardingPending,
            hasSeenNotificationPrompt: hasSeenNotificationPrompt,
            notificationAuthorization: notificationAuthorizationState
        ))
    }

    private var notificationAuthorizationState: CompanionNotificationAuthorizationState {
        #if DEBUG
        // Store-preview runs are deterministic screenshot fixtures, not a
        // first pairing, and must keep landing on the requested chat surface.
        if ProcessInfo.processInfo.arguments.contains("-store-preview") { return .determined }
        #endif
        guard session.notificationAuthorizationResolved else { return .unresolved }
        return session.notificationAuthorization == .notDetermined ? .notDetermined : .determined
    }

    private func reconcileNotificationOnboarding() {
        notificationOnboardingPending = CompanionNotificationOnboardingPolicy.shouldKeepPending(
            isPending: notificationOnboardingPending,
            hasCompletedStep: hasSeenNotificationPrompt,
            authorization: notificationAuthorizationState
        )
    }

    private func startPairing() {
        hasSeenWelcome = true
        pairingRequested = true
    }
}

/// The token stopped working. Almost always because someone revoked this
/// phone on the computer — which is exactly what that button is for, so the
/// honest thing is to say so and offer to pair again.
struct UnpairedView: View {
    let onPairAgain: () -> Void

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("This phone was unpaired", systemImage: "lock.slash")
            } description: {
                Text("The connection was removed on your computer. Pair again to keep using your chats here.")
            } actions: {
                Button("Pair again", action: onPairAgain)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
            }
        }
    }
}
