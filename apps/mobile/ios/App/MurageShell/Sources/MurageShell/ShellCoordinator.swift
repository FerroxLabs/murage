#if os(iOS)
import AVFoundation
import MurageShellCore
import UIKit
import WebKit

public struct ClosedWorkspace: Sendable {
    public let origin: String
    public let reason: CloseReason
}

/// `unreadable` (P14 carry): the Keychain could not be read, so there is no
/// saved list to show or to add to, or no install id to pair with. The
/// launcher shows "unlock / try again" for it, never an empty list.
/// `busy`: another open is still in flight (a double tap); this one does nothing.
public enum OpenFailure: String, Error {
    case unreachable, insecure, accessoff, hosterror, unreadable, busy
    case badOrigin = "bad_origin"
    case badCredential = "bad_credential"
    case noLauncher = "no_launcher"
}

public enum ScanFailure: String, Error {
    case cancelled
    case cameraDenied = "camera_denied"
    case unavailable
}

/// Owns the one workspace screen at a time, the saved computers and the
/// hand-off between the launcher page and native (spec §3.1, §3.2).
@MainActor
public final class ShellCoordinator {
    public static let shared = ShellCoordinator()
    public static let switchShortcut = "com.murage.mobile.switch"

    public weak var launcher: UIViewController?
    public var launcherRequested = false
    /// Set by the plugin. Without a listener, a close waits for `snapshot()`.
    public var onClosed: ((ClosedWorkspace) -> Void)?

    private var pendingClose: ClosedWorkspace?
    private var current: WorkspaceViewController?
    private var autoOpened = false
    private var names: [WorkspaceOrigin: String] = [:]
    private let books = WorkspaceBookStore()
    private let routes = RouteMemory(store: UserDefaultsStore())
    /// A notification tap that arrived before the launcher could present
    /// (a cold start): launchIfNeeded opens this computer instead of the last one.
    private var notificationOrigin: WorkspaceOrigin?
    /// B6: a different computer's notification held because the current
    /// workspace has a call open, delivered by `deliverPendingCrossComputerOpen()`.
    private var pendingCrossComputerOpen: (origin: WorkspaceOrigin, threadId: String?, messageId: String?, heldAt: Date)?
    private var pendingNotice: String?
    /// Set by the plugin. Without a listener, a notice waits for `takePendingNotice()`.
    public var onNotice: ((String) -> Void)?
    /// Kept once read; a failed read is tried again next time (never cached as nil).
    private var installIdValue: String?
    private var debugProbe = false
    /// One open at a time: the probe is awaited, and a second tap must not present twice.
    private var opening = false

    private init() {}

    private func currentInstallId() -> String? {
        if installIdValue == nil { installIdValue = InstallIdentity.value() }
        return installIdValue
    }

    // MARK: opening

    /// Cold start: straight into the last computer, once (Decision 4, surprise 2).
    /// An unreadable list opens nothing; the launcher's state() then asks to unlock.
    public func launchIfNeeded() {
        defer { autoOpened = true }
        #if DEBUG
        if !autoOpened, let launcher, presentDebugScreen(on: launcher) { return }
        #endif
        guard let book = books.load() else { return }
        PushServices.shared.sweep(knownOrigins: Set(book.workspaces.map(\.origin)))
        let tapped = notificationOrigin.flatMap { book.entry(for: $0) != nil ? $0 : nil }
        notificationOrigin = nil
        let target = tapped ?? LaunchPolicy.autoOpen(book: book, alreadyAutoOpened: autoOpened,
                                                     launcherRequested: launcherRequested, closePending: pendingClose != nil)
        if let target { present(origin: target, credential: nil, verdict: nil, installId: nil) }
    }

    /// The launcher's open: probe first, then show the workspace (spec §3.1 table).
    public func open(originString: String, credential: String?) async -> Result<ProbeVerdict, OpenFailure> {
        guard !opening else { return .failure(.busy) }
        opening = true
        defer { opening = false }
        // The launcher trims its input too (P22); a pasted newline is not a different origin.
        guard let origin = WorkspaceOrigin(string: WorkspaceOrigin.trimInput(originString)) else { return .failure(.badOrigin) }
        if let credential, !PairingLink.validCredential(credential) { return .failure(.badCredential) }
        // Pairing adds the computer to the list, which must be readable to be written.
        if credential != nil {
            guard books.load() != nil else { return .failure(.unreadable) }
        }
        let verdict = await ProbeClient.probe(origin, userAgent: ShellEnvironment.userAgentToken)
        switch verdict.kind {
        case .unreachable: return .failure(.unreachable)
        case .insecure: return .failure(.insecure)
        case .accessoff: return .failure(.accessoff)
        case .hosterror: return .failure(.hosterror)
        case .full, .basic: break
        }
        guard verdict.hostCapabilityOk else { return .success(verdict) }
        // Recorded only once the desktop passes the gate, as on Android.
        if let name = verdict.name { names[origin] = name }
        // A full door records this phone by its install id: never pair it without one.
        var installId: String?
        if credential != nil, verdict.isFull {
            guard let id = currentInstallId() else { return .failure(.unreadable) }
            installId = id
        }
        // SEC-006: the approval key is made and kept now, and the relay's statement for it is
        // fetched once (one attempt, 10 s cap). A key never goes without its statement; with
        // none, the phone pairs without a key and the owner is told to pair again for approvals.
        var approvalKey: String?
        var approvalStatement: String?
        if credential != nil {
            if verdict.isFull, verdict.approvalProofOk == true, let installId {
                // A failed enrol (no passcode, no Secure Enclave) must not leave an older key behind.
                approvalKey = ApprovalKeys.enrol(origin: origin)
                if approvalKey == nil { ApprovalKeys.remove(origin: origin) }
            } else {
                ApprovalKeys.remove(origin: origin)
            }
            if let approvalKey, let installId {
                approvalStatement = await ApprovalAttestation.statement(transport: RelayClient(), attester: AppAttester(), environment: RelayConfig.attestEnvironment,
                                                                        installId: installId, approvalKey: approvalKey)
                #if DEBUG
                ShellLog.event(approvalStatement == nil ? "approval statement: no" : "approval statement: yes")
                #endif
            }
        }
        if let failure = present(origin: origin, credential: credential, verdict: verdict, installId: installId, approvalKey: approvalKey, approvalStatement: approvalStatement) { return .failure(failure) }
        return .success(verdict)
    }

    /// nil once the workspace is on its way on screen.
    @discardableResult
    private func present(origin: WorkspaceOrigin, credential: String?, verdict: ProbeVerdict?, installId: String?, approvalKey: String? = nil, approvalStatement: String? = nil) -> OpenFailure? {
        guard let launcher else { return .noLauncher }
        let path: String
        if let credential {
            // The credential was checked in open(); only the install id can fail here.
            // The key and its statement were made in open(); ApprovalAttestation.enterPath sends the key only with its statement.
            guard let enter = ApprovalAttestation.enterPath(credential: credential, installId: verdict?.isFull == true ? installId : nil,
                                                           approvalKey: approvalKey, approvalStatement: approvalStatement) else { return .unreadable }
            path = enter
        } else {
            path = routes.startPath(for: origin)
        }
        let workspace = WorkspaceViewController(origin: origin, startPath: path, verdict: verdict, routes: routes, debugProbe: debugProbe)
        workspace.onClose = { [weak self, weak workspace] reason in
            guard let self, let workspace else { return }
            self.closed(workspace, reason: reason)
        }
        workspace.onSignedIn = { [weak self] in self?.signedIn(origin) }
        workspace.onInUse = { [weak self] in self?.inUse(origin) }
        workspace.onName = { [weak self] name in self?.names[origin] = name }
        workspace.onCallEnded = { [weak self] in self?.deliverPendingCrossComputerOpen() }
        workspace.push = PushServices.shared
        // An older workspace still on screen closes properly (its saves are
        // cancelled) without telling the launcher, then is dismissed below.
        if let old = current { old.onClose = nil; old.closeFromShell(.launcher) }
        current = workspace
        launcherRequested = false
        let show = { launcher.present(workspace, animated: false) }
        // Whatever covers the launcher (the scanner, which then answers
        // `cancelled`, or an older workspace) goes first.
        if let presented = launcher.presentedViewController {
            presented.dismiss(animated: false, completion: show)
        } else {
            show()
        }
        return nil
    }

    private func signedIn(_ origin: WorkspaceOrigin) {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if !books.update({ $0.signedIn(origin, name: names[origin], at: now) }) {
            ShellLog.event("book not updated after sign-in")
        }
    }

    /// "Last connected" moves on while the computer is in use, not only when
    /// it loads. The same read-then-write as every change: nothing is saved
    /// when the list cannot be read, and a computer not on it is not added.
    private func inUse(_ origin: WorkspaceOrigin) {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if !books.updateIfChanged({ $0.touched(origin, at: now) }) {
            ShellLog.event("book not updated after use")
        }
    }

    // MARK: closing

    private func closed(_ workspace: WorkspaceViewController, reason: CloseReason) {
        guard current === workspace else { return }
        current = nil
        let origin = workspace.origin
        ShellLog.closed(reason)
        if reason == .signOut { forget(origin) }
        if reason == .signOut || reason == .signedOut { ApprovalKeys.remove(origin: origin) }
        if reason == .launcher { launcherRequested = true }
        // B6: a deliberate trip back to the launcher drops a held open (the
        // person chose where to go); any other close delivers it, but only once
        // the old workspace is fully dismissed, so present() never races it.
        if reason == .launcher { pendingCrossComputerOpen = nil }
        workspace.dismiss(animated: false) { [weak self] in
            self?.deliver(ClosedWorkspace(origin: origin.serialized, reason: reason))
            self?.deliverPendingCrossComputerOpen()
        }
    }

    private func deliver(_ closed: ClosedWorkspace) {
        if let onClosed { onClosed(closed) } else { pendingClose = closed }
    }

    /// Signing out, or removing the computer: off the list, its routes gone,
    /// and its session gone from the workspace's own data store. The session
    /// is cleared even when the list cannot be read. Returns false if the
    /// list could not be updated.
    @discardableResult
    private func forget(_ origin: WorkspaceOrigin) -> Bool {
        ApprovalKeys.remove(origin: origin)
        let removed = books.update { $0.remove(origin) }
        if !removed { ShellLog.event("book not updated after forget") }
        routes.forget(origin)
        PushServices.shared.forget(origin)
        clearSession(origin)
        return removed
    }

    /// R4: the cookies for this host and the HTTP cache, in the workspace's
    /// own store (P15), where the session lives. Capacitor's store is never
    /// touched. Cookies carry no port, so a second computer on the same host
    /// (another port) loses its cookies too. The cache is cleared whole: its
    /// records are per site, not per origin, and losing it costs only a reload.
    private func clearSession(_ origin: WorkspaceOrigin) {
        let store = WKWebsiteDataStore(forIdentifier: WorkspaceDataStore.identifier)
        let cookies = store.httpCookieStore
        let host = Self.bareHost(origin.host)
        cookies.getAllCookies { all in
            // The door's session cookie has no Domain attribute and one name on every port, so by host removes nothing truly separate.
            let mine = all.filter { Self.bareHost($0.domain) == host }
            for cookie in mine { cookies.delete(cookie) }
            ShellLog.value("session cookies cleared", mine.count)
        }
        let cache: Set<String> = [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache, WKWebsiteDataTypeFetchCache]
        store.removeData(ofTypes: cache, modifiedSince: .distantPast) {
            ShellLog.event("workspace cache cleared")
        }
    }

    /// Lower case, without a cookie domain's leading dot or a trailing dot.
    nonisolated private static func bareHost(_ raw: String) -> String {
        var host = raw.lowercased()
        if host.hasPrefix(".") { host.removeFirst() }
        if host.hasSuffix(".") { host.removeLast() }
        return host
    }

    // MARK: launcher requests

    /// The launcher's state, or nil when the saved list cannot be read (the
    /// plugin rejects with `unreadable`; a pending close waits for a read that works).
    public func snapshot() -> [String: Any]? {
        guard let book = books.load() else { return nil }
        var state: [String: Any] = [
            "workspaces": book.sorted.map { ["origin": $0.origin, "name": $0.name, "lastConnected": $0.lastConnected] as [String: Any] },
            "active": NSNull(),
            "closed": NSNull(),
            "platform": "ios",
            "tailscale": tailscaleStatus().wire,
        ]
        if let active = book.active { state["active"] = active }
        if let closed = pendingClose {
            state["closed"] = ["origin": closed.origin, "reason": closed.reason.rawValue]
            pendingClose = nil
        }
        return state
    }

    /// nil when done (an origin that does not parse was never saved);
    /// `unreadable` when the list could not be updated.
    public func remove(originString: String) -> OpenFailure? {
        guard let origin = WorkspaceOrigin(string: WorkspaceOrigin.trimInput(originString)) else { return nil }
        return forget(origin) ? nil : .unreadable
    }

    public func showLauncher() {
        launcherRequested = true
        current?.closeFromShell(.launcher)
    }

    private static let tailscaleApp = URL(string: "tailscale://")!
    private static let tailscaleStore = URL(string: "https://apps.apple.com/app/tailscale/id1470499037")!

    /// Tailscale itself when iOS says it can open `tailscale://` (listed in
    /// LSApplicationQueriesSchemes), else its App Store page, which shows
    /// Open when it is installed. An open that fails falls back to the page too.
    public func openTailscale() {
        guard UIApplication.shared.canOpenURL(Self.tailscaleApp) else {
            UIApplication.shared.open(Self.tailscaleStore)
            return
        }
        UIApplication.shared.open(Self.tailscaleApp) { opened in
            if !opened { UIApplication.shared.open(Self.tailscaleStore) }
        }
    }

    /// Installed: canOpenURL, which only says yes if Tailscale registers the
    /// scheme (undocumented), so a no is unknown. Connected: a Tailscale
    /// address on an interface that is up (TailscaleStatus.ios).
    private func tailscaleStatus() -> TailscaleStatus {
        TailscaleStatus.ios(opensScheme: UIApplication.shared.canOpenURL(Self.tailscaleApp), addresses: Self.interfaceAddresses())
    }

    /// Every IPv4 and IPv6 address on an interface that is up and running, as raw bytes;
    /// nil when getifaddrs fails. Addresses only, never logged.
    nonisolated private static func interfaceAddresses() -> [[UInt8]]? {
        var first: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&first) == 0 else { return nil }
        defer { freeifaddrs(first) }
        var addresses: [[UInt8]] = []
        var next = first
        while let entry = next {
            next = entry.pointee.ifa_next
            // Up and running, as Android's NetworkInterface.isUp() means it.
            let live = UInt32(IFF_UP | IFF_RUNNING)
            guard entry.pointee.ifa_flags & live == live, let address = entry.pointee.ifa_addr else { continue }
            switch Int32(address.pointee.sa_family) {
            case AF_INET:
                address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { v4 in
                    var raw = v4.pointee.sin_addr
                    addresses.append(withUnsafeBytes(of: &raw) { Array($0) })
                }
            case AF_INET6:
                address.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { v6 in
                    var raw = v6.pointee.sin6_addr
                    addresses.append(withUnsafeBytes(of: &raw) { Array($0) })
                }
            default: break
            }
        }
        return addresses
    }

    /// Answers exactly once, whatever happens.
    public func scan(completion: @escaping (Result<String, ScanFailure>) -> Void) {
        let start: @MainActor (Bool) -> Void = { [weak self] granted in
            guard granted else { completion(.failure(.cameraDenied)); return }
            guard let launcher = self?.launcher, launcher.presentedViewController == nil,
                  AVCaptureDevice.default(for: .video) != nil else { completion(.failure(.unavailable)); return }
            let scanner = QRScannerViewController(result: completion)
            scanner.modalPresentationStyle = .fullScreen
            launcher.present(scanner, animated: true)
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: start(true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                Task { @MainActor in start(granted) }
            }
        default: start(false)
        }
    }

    /// A conversation to open: Plan 3's notification tap, or the debug launch argument.
    public func queueOpen(threadId: String, messageId: String?) {
        guard let active = books.load()?.active.flatMap(WorkspaceOrigin.init(string:)) else { return }
        let open = PendingOpen(origin: active, threadId: threadId, messageId: messageId)
        guard routes.setPending(open) else { return }
        if let current {
            if current.origin == active { current.deliver(open) }
        } else if autoOpened {
            present(origin: active, credential: nil, verdict: nil, installId: nil)
        }
    }

    /// Spec §3.5 "Tapping a notification": the binding chose `origin`. A
    /// computer no longer on the list gets the launcher's notice instead. A
    /// different workspace on screen is closed first by present(), so its
    /// late results cannot land in this one; the pending open is keyed by
    /// origin, so only this computer's page takes it, and it survives a
    /// re-pair (a sign-in lands on "/", then the next load opens it).
    public func openFromNotification(origin: WorkspaceOrigin, threadId: String?, messageId: String?) {
        if let book = books.load(), book.entry(for: origin) == nil {
            showNotice(code: "removedWorkspace")
            return
        }
        if let threadId {
            let open = PendingOpen(origin: origin, threadId: threadId, messageId: messageId)
            _ = routes.setPending(open)
            if let current, current.origin == origin { ShellLog.event("open deliver current"); current.deliver(open); return }
        } else if let current, current.origin == origin {
            return
        }
        // B6 (Astra B6): a different computer's notification must not end a
        // call in progress on screen. Hold it at this boundary and deliver
        // it once the call really ends (onCallEnded) or the workspace
        // closes for any other reason.
        if CrossComputerNotification.mustHold(current: current?.origin, hasOpenCall: current?.hasOpenCall ?? false, requested: origin) {
            ShellLog.event("open held: call in progress on another computer", persist: true)
            pendingCrossComputerOpen = (origin, threadId, messageId, Date())
            return
        }
        // Before the launch-time open has run, the launcher may be registered
        // but not yet on screen, and a present from there shows nothing: hand
        // the computer to launchIfNeeded instead (as queueOpen waits for it).
        guard autoOpened else { notificationOrigin = origin; return }
        ShellLog.event("open presents workspace")
        if present(origin: origin, credential: nil, verdict: nil, installId: nil) != nil {
            notificationOrigin = origin
        }
    }

    /// B6: the call that made `openFromNotification` hold a different
    /// computer's notification has ended, or the workspace holding it is
    /// gone for some other reason. Re-run the same open now that nothing
    /// blocks it; a no-op if nothing was held.
    private func deliverPendingCrossComputerOpen() {
        guard let pending = pendingCrossComputerOpen else { return }
        pendingCrossComputerOpen = nil
        // held for long enough that the person has moved on: drop it (review M2)
        guard Date().timeIntervalSince(pending.heldAt) <= 600 else { return }
        openFromNotification(origin: pending.origin, threadId: pending.threadId, messageId: pending.messageId)
    }

    /// A launcher notice by code (L1 holds the words); held until a launcher listens.
    public func showNotice(code: String) {
        if let onNotice { onNotice(code) } else { pendingNotice = code }
    }

    public func takePendingNotice() -> String? {
        defer { pendingNotice = nil }
        return pendingNotice
    }

    #if DEBUG
    /// Debug builds only (P25/P26): `-murageE2EProbe`, `-murageOpenThread <id>`.
    public func applyDebugArguments(_ arguments: [String]) {
        debugProbe = arguments.contains("-murageE2EProbe")
        Self.parseDebugLaunch(arguments)
        if let at = arguments.firstIndex(of: "-murageOpenThread"), at + 1 < arguments.count {
            queueOpen(threadId: arguments[at + 1], messageId: nil)
        }
    }
    #endif
}
#endif
