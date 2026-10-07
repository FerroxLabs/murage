#if os(iOS)
import MurageCallAudioCore
import MurageShellCore
import UIKit
import WebKit

/// The workspace's own persistent website data store (iOS 17). Capacitor's
/// CAPBridgeViewController observes `WKWebsiteDataStore.default()` and mirrors
/// every cookie into `HTTPCookieStorage.shared`, and its CapacitorCookies
/// plugin clears that store; the workspace session lives where neither
/// reaches. Signing out (P17) clears this store, never the default one.
enum WorkspaceDataStore {
    static let identifier = UUID(uuidString: "412B02B8-D3C1-45C8-AE37-7E75AED4D285")!
}

/// WKUserContentController retains its handlers; this breaks the cycle and
/// still answers if the screen is gone, so no promise in the page hangs.
private final class WeakChannelHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: WKScriptMessageHandlerWithReply?

    init(_ target: WKScriptMessageHandlerWithReply) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let target else { replyHandler(nil, ChannelError.unavailable.rawValue); return }
        target.userContentController(controller, didReceive: message, replyHandler: replyHandler)
    }
}

/// WebKit's reply handler, carried to the main actor after the call-audio
/// queue answers. It is only ever called there.
private struct ChannelReply: @unchecked Sendable {
    let send: (Any?, String?) -> Void
    init(_ send: @escaping (Any?, String?) -> Void) { self.send = send }
}

/// The workspace screen (spec §2, §3.2): our own WKWebView on the user's own
/// Murage origin, never Capacitor's, with the natively checked channel.
public final class WorkspaceViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    public let origin: WorkspaceOrigin
    var onClose: ((CloseReason) -> Void)?
    var onSignedIn: (() -> Void)?
    /// Still in use after signing in (going to the background, "Switch
    /// computer"): the "Last connected" time moves on, and nothing is added.
    var onInUse: (() -> Void)?
    var onName: ((String) -> Void)?
    /// B6: fires on the page's own `callSessionClose`, so the coordinator can
    /// deliver a held cross-computer notification the moment the call
    /// genuinely ends, the same signal `deliverKeptRoute()` uses for a
    /// same-origin held route.
    var onCallEnded: (() -> Void)?
    /// Push state for the four push methods (I2); nil answers `unavailable`.
    public weak var push: PushChannel?

    private let startPath: String
    private var verdict: ProbeVerdict?
    private let routes: RouteMemory
    private let debugProbe: Bool
    private var webView: WKWebView!
    private let overlay = LoadingOverlay()
    private var readyTimer: Timer?
    private var isReady = false
    /// A page on the origin loaded or called ready(): this computer was reached.
    private var signedInSeen = false
    /// The splash is covering the page and waiting for ready() (or a reveal).
    private var splashUp = false
    private var closing = false
    private var loadStarted = Date()
    /// Answers to load()'s same-document reload: the first for the newest load wins.
    private var inPlace = InPlaceReload()
    private var observers: [NSObjectProtocol] = []
    /// WebKit raises if a panel's completion handler is dropped unanswered,
    /// which dismissing the screen under an open alert would do.
    private var openPanels: [UUID: () -> Void] = [:]
    /// Web-content crashes in the last minute: a second one stops the reloads.
    private var crashes: [Date] = []
    /// A notification that arrived while the splash was up, opened on ready().
    private var queuedOpen: PendingOpen?
    /// True while the page says a call is open (callSessionOpen/Close,
    /// callbar-rereview2.md G3): the one signal that only ever follows
    /// startCall/endCall, never a retry, Resume or `lost` — unlike the
    /// native call-audio engine's own teardown, which fires on all of
    /// those too and so cannot drive this guard. Guards the same reload
    /// `deliver()` would otherwise commit over a live call, and gates
    /// when a held route is actually delivered. Reset on every main-frame
    /// navigation commit and on a content-process crash (callbar-rereview2.md
    /// G4's iOS counterpart), so a page that died mid-call never leaves
    /// this stuck true.
    private var callSessionOpen = false
    private var approving = false
    /// B6: lets the coordinator hold a different computer's notification at
    /// its boundary, the same question `reloadOrKeepPending()` already asks
    /// for a same-origin reload.
    var hasOpenCall: Bool { callSessionOpen }
    private lazy var saves = SaveController(origin: origin, host: self, isClosing: { [weak self] in self?.closing ?? true })
    /// Native call audio (spec §4.2); it observes the app and audio session
    /// notifications itself. Every close path below closes it (§4.2.7).
    private let callAudio = CallAudioEngine()

    init(origin: WorkspaceOrigin, startPath: String, verdict: ProbeVerdict?, routes: RouteMemory, debugProbe: Bool) {
        self.origin = origin
        self.startPath = startPath
        self.verdict = verdict
        self.routes = routes
        self.debugProbe = debugProbe
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    required init?(coder: NSCoder) { nil }

    deinit {
        callAudio.close(.controllerClosed)
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        SaveController.sweepLeftovers() // once per process, before any save exists
        view.backgroundColor = ShellColors.canvas
        webView = makeWebView()
        view.addSubview(webView)
        overlay.frame = view.bounds
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        overlay.onRetry = { [weak self] in self?.reloadRoute() }
        overlay.onChoose = { [weak self] in self?.close(.launcher) }
        view.addSubview(overlay)
        callAudio.sink = { [weak self] event, done in
            guard let self else { done(false); return }
            self.emit("callAudio", detail: event.detail, done: done)
        }
        observeLifecycle()
        beginProgress()
        if verdict == nil { probeBeforeLoading(path: startPath) }
        else { load(path: startPath) }
    }

    public override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isBeingDismissed || isMovingFromParent else { return }
        callAudio.close(.controllerClosed)
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        readyTimer?.invalidate()
        let unanswered = openPanels.values
        openPanels.removeAll()
        unanswered.forEach { $0() }
    }

    private func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore(forIdentifier: WorkspaceDataStore.identifier) // persistent (Phase 0 Q2)
        config.applicationNameForUserAgent = ShellEnvironment.userAgentToken
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: ChannelScript.ios(origin: origin), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.addScriptMessageHandler(WeakChannelHandler(self), contentWorld: .page, name: ChannelScript.iosHandlerName)
        config.userContentController = controller

        let webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.isOpaque = false
        webView.backgroundColor = ShellColors.canvas
        webView.scrollView.backgroundColor = ShellColors.canvas
        // Decision 1: the web UI owns the safe area (index.html viewport-fit=cover,
        // env(safe-area-inset-*)); WebKit reports the insets only with this.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        #if DEBUG
        webView.isInspectable = true
        #endif
        return webView
    }

    // MARK: loading and readiness

    private func load(path: String) {
        guard !closing, verdict?.hostCapabilityOk == true else { return }
        // A start path without a leading "/" would be nil; the root still loads
        // and still arms the deadline.
        let url = origin.url(path: path) ?? origin.url
        let ticket = inPlace.begin()
        isReady = false
        loadStarted = Date()
        if !splashUp { beginProgress() }
        armDeadline()
        // A target that differs only by the fragment is a same-document
        // navigation, not a load: the page would never call ready() again.
        // Reload it at the target instead; if the page can't, load as before.
        guard SameDocument.of(current: webView.url, target: url) else {
            webView.load(URLRequest(url: url))
            return
        }
        // A hung page may never answer: the timeout loads, and whichever
        // comes second, or belongs to an older load(), does nothing.
        DispatchQueue.main.asyncAfter(deadline: .now() + InPlaceReload.timeout) { [weak self] in
            self?.fallBack(ticket: ticket, url: url, reloaded: false)
        }
        webView.evaluateJavaScript(SameDocument.reloadScript(target: url)) { [weak self] value, _ in
            self?.fallBack(ticket: ticket, url: url, reloaded: value as? Bool == true)
        }
    }

    private func fallBack(ticket: Int, url: URL, reloaded: Bool) {
        guard inPlace.fallBack(ticket: ticket, reloaded: reloaded), !closing else { return }
        webView.load(URLRequest(url: url))
    }

    private var progressStarted = Date()
    private var slowShown = false
    private var probeAttempt = 0

    private func beginProgress() {
        progressStarted = Date()
        slowShown = false
        splashUp = true
        overlay.showSplash()
        armDeadline()
    }

    private func reloadRoute() {
        beginProgress()
        if verdict == nil { probeBeforeLoading(path: routes.startPath(for: origin)) }
        else { load(path: routes.startPath(for: origin)) }
    }

    /// One progress deadline from the start of this attempt, including its probe.
    /// Finishes and ignored failures keep the remaining time; slow copy is announced once.
    private func armDeadline() {
        readyTimer?.invalidate()
        guard splashUp, !isReady, !closing, !slowShown else { return }
        readyTimer = Timer.scheduledTimer(withTimeInterval: max(0.01, 8 - Date().timeIntervalSince(progressStarted)), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.splashUp, !self.isReady, !self.closing else { return }
                ShellLog.event("ready deadline passed")
                self.slowShown = true
                self.overlay.showSlow()
            }
        }
    }

    /// Takes the splash down without ready(): the door's
    /// /enter page, basic mode.
    private func reveal() {
        splashUp = false
        readyTimer?.invalidate()
        overlay.hide()
    }

    private func markReady() {
        // A late ready() after sign-out must not put the computer back on the list.
        guard !isReady, !closing else { return }
        isReady = true
        reveal()
        if let open = queuedOpen {
            queuedOpen = nil
            deliver(open) // clears the pending open once the page handles it
        } else {
            routes.clearPending(for: origin)
        }
        signedIn()
        ShellLog.timing("ready", ms: ms(since: loadStarted))
        #if DEBUG
        ShellLog.value("webcontent pid", E2EProbe.webContentPID(webView))
        if debugProbe { E2EProbe.run(in: webView) }
        #endif
    }

    private func signedIn() {
        signedInSeen = true
        onSignedIn?()
    }

    /// Only after this workspace reached its computer, and never once closing
    /// (a sign-out must not leave a fresh time behind).
    private func stillInUse() {
        guard signedInSeen, !closing else { return }
        onInUse?()
    }

    /// A page other than "/" loaded: reached, so "Last connected" moves on; touch only, never an add.
    private func loadedInUse() {
        signedInSeen = true
        stillInUse()
    }

    /// Kept for a lowered gate: with mobileFeatures >= 1 required, only a lowered gate reaches basic here.
    private func revealBasic() {
        guard splashUp else { return }
        reveal()
        Toast.show("Update Murage on your computer to get notifications on this phone.", in: view)
    }

    private func probeBeforeLoading(path: String) {
        probeAttempt += 1
        let attempt = probeAttempt
        let origin = origin
        Task { @MainActor [weak self] in
            let verdict = await ProbeClient.probe(origin, userAgent: ShellEnvironment.userAgentToken)
            guard let self, !self.closing, self.probeAttempt == attempt else { return }
            self.verdict = verdict
            if verdict.kind == .unreachable { self.close(.unreachable); return }
            if verdict.kind == .insecure { self.close(.insecure); return }
            if verdict.kind == .accessoff { self.close(.accessoff); return }
            if verdict.kind == .hosterror { self.close(.hosterror); return }
            guard verdict.hostCapabilityOk else { self.close(.updateRequired); return }
            if let name = verdict.name { self.onName?(name) }
            self.load(path: path)
        }
    }

    // MARK: closing, events, deep links

    private func close(_ reason: CloseReason) {
        guard !closing else { return }
        if reason == .launcher { stillInUse() }
        closing = true
        readyTimer?.invalidate()
        saves.cancelAll()
        callAudio.close(.controllerClosed)
        DispatchQueue.main.async { self.onClose?(reason) }
    }

    func closeFromShell(_ reason: CloseReason) {
        close(reason)
    }

    /// Calls `window.__murageNativeEmit(name, detail)` in the main frame, only
    /// while the page is on the saved origin: checked here and again inside
    /// the script (M6). `done(true)` if a listener handled it.
    func emit(_ name: String, detail: [String: Any]? = nil, done: ((Bool) -> Void)? = nil) {
        guard isViewLoaded, let url = webView?.url, origin.contains(url) else { done?(false); return }
        webView.callAsyncJavaScript(
            ChannelScript.iosEmit,
            arguments: ["name": name, "detail": detail ?? NSNull(), "origin": origin.serialized], in: nil, in: .page
        ) { result in
            done?((try? result.get()) as? Bool ?? false)
        }
    }

    /// A conversation to open now (P17 `queueOpen`, Plan 3's notification
    /// tap). The caller has saved it as the pending open first. While the
    /// splash is up it waits for ready() (the newest one wins), so a burst of
    /// taps never reloads the page over and over; a revealed page that never
    /// called ready(), or one that does not handle the event, reloads once
    /// onto the pending route.
    func deliver(_ open: PendingOpen) {
        guard isViewLoaded else { ShellLog.event("deliver view not loaded"); return } // viewDidLoad loads the caller's start path
        guard isReady else {
            ShellLog.event(splashUp ? "deliver queued behind splash" : "deliver reloads unready page")
            if splashUp { queuedOpen = open } else { reloadOrKeepPending() }
            return
        }
        var detail: [String: Any] = ["threadId": open.threadId]
        if let message = open.messageId { detail["messageId"] = message }
        emit("notificationOpened", detail: detail) { [weak self] handled in
            guard let self else { return }
            ShellLog.event(handled ? "deliver handled by page" : "deliver unhandled, reloading")
            if handled { self.routes.clearPending(for: self.origin) } else { self.reloadOrKeepPending() }
        }
    }

    /// A reload here commits a navigation, which ends any call in progress
    /// (`close(.navigationCommitted)`) — the same silent hang-up the JS
    /// path already answering `true` exists to prevent. Reached only when
    /// the page is unready or failed to answer, so the guard is the same
    /// question either way: is a call open right now. If so, skip the
    /// reload and leave `routes`' pending flag for this origin exactly as
    /// it was — `open` itself is not requeued here, since the route book
    /// already tracks it and `callSessionClose` (the channel case below)
    /// delivers it the moment the call really ends, without waiting for
    /// some other trigger (callbar-review.md M4; callbar-rereview.md N5).
    /// Guards on the page's own `callSessionOpen`, not the native
    /// call-audio engine's own session: that one closes and reopens on
    /// every `lost`, Resume and a retry's stale close, none of which are
    /// a real hang-up — delivering then would re-emit the route mid-call
    /// and, if unhandled, reload over it (callbar-rereview2.md G3).
    /// Persisted: this is exactly the skip a report made without the
    /// phone in hand needs to explain a notification that appeared to do
    /// nothing.
    private func reloadOrKeepPending() {
        guard !callSessionOpen else {
            ShellLog.event("deliver unhandled during call", persist: true)
            return
        }
        reloadRoute()
    }

    /// The call that made `reloadOrKeepPending` hold a route has really
    /// ended (the page's own `callSessionClose`, not any native session
    /// teardown — callbar-rereview2.md G3). Re-runs `deliver` for whatever
    /// is still pending on this origin — a no-op if nothing was held, or
    /// if it was already cleared (the page handled it on some other path
    /// in the meantime).
    private func deliverKeptRoute() {
        guard let open = routes.pending, open.origin == origin.serialized else { return }
        deliver(open)
    }

    private func observeLifecycle() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.stillInUse()
                self?.emit("pause")
            }
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.emit("resume") }
        })
    }

    // MARK: the channel

    public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        let security = message.frameInfo.securityOrigin
        let frameOrigin = WorkspaceOrigin(scheme: security.protocol, host: security.host, port: security.port)
        guard ChannelGate.admit(isMainFrame: message.frameInfo.isMainFrame, frameOrigin: frameOrigin, saved: origin) else {
            ShellLog.channelDropped(mainFrame: message.frameInfo.isMainFrame, host: frameOrigin?.host)
            replyHandler(nil, ChannelError.unavailable.rawValue)
            return
        }
        switch ChannelGate.parse(message.body) {
        case .failure(let error):
            ShellLog.channelRefused(error)
            replyHandler(nil, error.rawValue)
        case .success(let request):
            ShellLog.channelAccepted(request.method)
            dispatch(request, reply: replyHandler)
        }
    }

    /// Every branch replies exactly once (P11 review), including saveFile,
    /// whose controller owns the reply.
    private func dispatch(_ request: ChannelRequest, reply: @escaping (Any?, String?) -> Void) {
        switch request.method {
        case .hello:
            reply(ChannelGate.hello(), nil)
        case .ready:
            markReady()
            reply(true, nil)
        case .saveFile:
            saves.handle(request.args, in: webView, reply: reply)
        case .openExternal:
            guard let target = ChannelArgs.externalURL(request.args) else { reply(nil, ChannelError.badArgs.rawValue); return }
            launch(target)
            reply(true, nil)
        case .haptic:
            guard let kind = (request.args["kind"] as? String).flatMap(HapticKind.init(rawValue:)) else {
                reply(nil, ChannelError.badArgs.rawValue)
                return
            }
            Haptics.play(kind)
            reply(true, nil)
        case .signOut:
            reply(true, nil)
            close(.signOut)
        case .rePair:
            reply(true, nil)
            close(.signedOut)
        case .setRoute:
            switch ChannelArgs.route(request.args) {
            case .thread(let thread): routes.remember(threadId: thread, for: origin); reply(true, nil)
            case .keep: reply(true, nil)
            case .invalid: reply(nil, ChannelError.badArgs.rawValue)
            }
        case .showLauncher:
            reply(true, nil)
            close(.launcher)
        case .registerPush:
            guard let push else { reply(nil, ChannelError.unavailable.rawValue); return }
            guard pushWhilePresent("push register deferred") else { reply(nil, ChannelError.unavailable.rawValue); return }
            let fresh = request.args["fresh"] as? Bool ?? false
            Task { @MainActor in
                switch await push.registerPush(origin: origin, fresh: fresh) {
                case .success(let result): reply(result, nil)
                case .failure(let error): reply(nil, error.rawValue)
                }
            }
        case .pushStatus:
            guard let push else { reply(nil, ChannelError.unavailable.rawValue); return }
            Task { @MainActor in reply(await push.pushStatus(origin: origin), nil) }
        case .issuePushTokens:
            guard let tokens = IssuedTokens.parse(request.args) else { ShellLog.channelRefused(.badArgs); reply(nil, ChannelError.badArgs.rawValue); return }
            guard pushWhilePresent("push issue deferred") else { reply(nil, ChannelError.unavailable.rawValue); return }
            guard let push, push.issuePushTokens(origin: origin, tokens: tokens) else { reply(nil, ChannelError.unavailable.rawValue); return }
            reply(true, nil)
        case .setBadgeCount:
            guard let count = ChannelArgs.int(request.args["count"]) else { reply(nil, ChannelError.badArgs.rawValue); return }
            push?.setBadgeCount(origin: origin, count: count)
            reply(true, nil)
        case .callSessionOpen:
            if !callSessionOpen {
                Toast.show("Keep Murage open during your call. On iPhone, the call pauses when you leave the app or lock your phone.", in: view)
            }
            callSessionOpen = true
            ShellLog.event("call session open")
            reply(true, nil)
        case .callSessionClose:
            callSessionOpen = false
            ShellLog.event("call session closed")
            reply(true, nil)
            deliverKeptRoute()
            onCallEnded?()
        case .diagLine:
            guard let line = ChannelArgs.diagLine(request.args) else { ShellLog.channelRefused(.badArgs); reply(nil, ChannelError.badArgs.rawValue); return }
            ShellLog.callDiag(line)
            reply(true, nil)
        case .approveWithDevice:
            // SEC-006: allow decisions only. Deny never comes here (no native prompt).
            guard let approval = ApprovalRequest.parse(request.args) else { ShellLog.channelRefused(.badArgs); reply(nil, ChannelError.badArgs.rawValue); return }
            guard UIApplication.shared.applicationState == .active else { reply(nil, ChannelError.unavailable.rawValue); return }
            guard !approving else { reply(nil, ChannelError.busy.rawValue); return }
            approving = true
            Task { @MainActor in
                let result = await ApprovalKeys.sign(origin: origin, request: approval)
                approving = false
                switch result {
                case .success(let signature): reply(["signature": signature], nil)
                case .failure(let failure): reply(nil, failure.rawValue)
                }
            }
        case .callAudioOpen:
            // §4.2.10: the app state, read here on the main actor. An open
            // while inactive waits for didBecomeActive (2 s at most).
            callAudio.open(app: CallAudioAppState(UIApplication.shared.applicationState), reply: Self.answer(reply))
        case .callAudioClose:
            callAudio.close(args: request.args, reply: Self.answer(reply))
        case .callAudioPlay:
            callAudio.play(args: request.args, reply: Self.answer(reply))
        case .callAudioControl:
            callAudio.control(args: request.args, reply: Self.answer(reply))
        }
    }

    /// The call-audio engine answers on the main actor; this turns its reply
    /// into the channel's.
    nonisolated private static func answer(_ reply: @escaping (Any?, String?) -> Void) -> CallAudioEngine.ReplyHandler {
        let reply = ChannelReply(reply)
        return { answer in
            switch answer {
            case .ok: reply.send(true, nil)
            case let .opened(session): reply.send(["session": session, "sampleRate": 16000, "frame": 1024], nil)
            case let .error(code): reply.send(nil, code)
            }
        }
    }

    /// Push enrolment runs only while the person is here. On a locked or
    /// leaving phone (a resume glance, a WebContent reload in the background
    /// grace period) the Keychain cannot keep the respond token (WhenUnlocked),
    /// and the page is suspended before it can hand a new grant to the host.
    /// The refusal is `unavailable`, which the page reads as "failed": it
    /// posts nothing and replaces nothing, and the next resume runs it again.
    /// `!= .background`, not `== .active`: `resume` is emitted on
    /// willEnterForeground, while the app is still `.inactive`.
    private func pushWhilePresent(_ deferred: StaticString) -> Bool {
        let app = UIApplication.shared
        guard app.applicationState != .background, app.isProtectedDataAvailable else {
            ShellLog.event(deferred)
            return false
        }
        return true
    }

    // MARK: leaving the app

    /// A URL the page or a navigation wants opened outside: only what the
    /// openExternal rule admits (http, https, tel, mailto without attach).
    private func openOutside(_ url: URL) {
        guard let target = ChannelArgs.externalURL(["url": url.absoluteString]) else {
            ShellLog.event("navigation external refused")
            return
        }
        ShellLog.host("navigation external", host: target.host ?? target.scheme ?? "")
        launch(target)
    }

    /// The only way out to the system browser, mail or phone.
    private func launch(_ target: URL) {
        ShellLog.host("open external", host: target.host ?? target.scheme ?? "")
        UIApplication.shared.open(target)
    }

    // MARK: navigation

    public func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        // A download (a[download]) only from the workspace page itself: a foreign
        // frame's blob: or data: file never reaches the share sheet (M2).
        if action.shouldPerformDownload { decisionHandler(fromPage(action.sourceFrame) ? .download : .cancel); return }
        // No target frame is a new window, which is decided as the main frame
        // first; createWebViewWith then keeps it here or sends it out.
        let target: NavigationTarget = action.targetFrame?.isMainFrame ?? true ? .mainFrame : .subframe
        switch NavigationPolicy.decide(url.absoluteString, target: target, saved: origin) {
        case .allow: decisionHandler(.allow)
        case .sendOut:
            openOutside(url) // another origin, mailto:, tel:
            decisionHandler(.cancel)
        case .cancel, .openHere: decisionHandler(.cancel)
        }
    }

    public func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let http = response.response as? HTTPURLResponse {
            if response.isForMainFrame, let url = http.url, origin.contains(url) {
                let path = url.path
                ShellLog.mainDocument(status: http.statusCode, enter: path == "/enter")
                if let reason = MainDocument.closeReason(status: http.statusCode) { decisionHandler(.cancel); close(reason); return }
                // Closing (signed out): a late load never signs back in.
                // "/" signs in; any other page only moves "Last connected" on.
                if !closing {
                    switch MainDocument.arrival(status: http.statusCode, path: path) {
                    case .signedIn: signedIn()
                    case .inUse: loadedInUse()
                    case .nothing: break
                    }
                }
            }
            let disposition = http.value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
            if disposition.hasPrefix("attachment") { decisionHandler(.download); return }
        }
        if response.canShowMIMEType { decisionHandler(.allow); return }
        // A frame's blob: or data: response never becomes a download (M2); an
        // HTTP one still meets SaveController's origin check.
        if !response.isForMainFrame && !(response.response is HTTPURLResponse) { decisionHandler(.cancel); return }
        decisionHandler(.download)
    }

    public func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        saves.adopt(download)
    }

    public func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        saves.adopt(download)
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let url = webView.url, origin.contains(url) else { return }
        if url.path == "/enter" { reveal(); return } // the door's pairing page never calls ready()
        if verdict?.kind == .basic { revealBasic(); return }
        armDeadline() // keep the original progress deadline
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let failure = error as NSError
        ShellLog.navigationFailed("main-document late error", domain: failure.domain, code: failure.code, outcome: nil)
        armDeadline()
    }

    private func failed(_ error: Error) {
        let failure = error as NSError
        let outcome = NavigationFailure.classify(domain: failure.domain, code: failure.code)
        ShellLog.navigationFailed("main-document error", domain: failure.domain, code: failure.code, outcome: outcome)
        switch outcome {
        case .ignore: armDeadline()
        case .unreachable: close(.unreachable)
        case .insecure: close(.insecure)
        }
    }

    /// Any main-frame commit, a reload included, ends a native call: the
    /// microphone never outlives the page that opened it (spec §4.2.7).
    /// The new page has no call either way, so `callSessionOpen` is reset
    /// here too — otherwise a page-initiated reload mid-call (or any
    /// other commit) would leave the flag stuck true forever, since the
    /// dead page can never call `callSessionClose` (callbar-rereview2.md
    /// G4's iOS counterpart).
    public func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        callAudio.close(.navigationCommitted)
        endCallSession()
    }

    /// The page's call is over by any route that cannot say so itself (B6):
    /// a held cross-computer notification is delivered now, not left stuck.
    private func endCallSession() {
        let wasOpen = callSessionOpen
        callSessionOpen = false
        if wasOpen { onCallEnded?() }
    }

    /// Reloads the route behind the splash, which re-arms the deadline.
    /// `callSessionOpen` is reset for the same reason as `didCommit`
    /// above: the crashed page cannot tell native its call ended
    /// (callbar-rereview2.md G4).
    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        callAudio.close(.webContentTerminated)
        endCallSession()
        guard mayReloadAfterCrash() else { return }
        ShellLog.event("webcontent terminated; reloading route")
        reloadRoute()
    }

    /// A second crash within a minute stops the reloads: the slow panel's Try
    /// again is the person's call, so a page that kills its process cannot loop.
    private func mayReloadAfterCrash() -> Bool {
        let now = Date()
        crashes = crashes.filter { now.timeIntervalSince($0) < 60 } + [now]
        guard crashes.count < 2 else {
            ShellLog.event("webcontent terminated again; waiting for the person")
            isReady = false
            readyTimer?.invalidate()
            splashUp = true
            overlay.showSlow()
            return false
        }
        return true
    }

    // MARK: UI delegate

    public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        switch NavigationPolicy.decide(url.absoluteString, target: .newWindow, saved: origin) {
        case .openHere: webView.load(action.request) // the system browser has no session (Plan 1 note 9)
        case .sendOut: openOutside(url)
        case .allow, .cancel: break
        }
        return nil
    }

    public func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let requester = WorkspaceOrigin(scheme: origin.protocol, host: origin.host, port: origin.port)
        decisionHandler(NavigationPolicy.mayCapture(requester: requester, isMainFrame: frame.isMainFrame, saved: self.origin) ? .grant : .deny)
    }

    /// Native panels only for the workspace page itself; any other frame
    /// gets the dismissive answer without a word.
    private func fromPage(_ frame: WKFrameInfo) -> Bool {
        let security = frame.securityOrigin
        return ChannelGate.admit(isMainFrame: frame.isMainFrame,
                                 frameOrigin: WorkspaceOrigin(scheme: security.protocol, host: security.host, port: security.port),
                                 saved: origin)
    }

    public func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard fromPage(frame) else { completionHandler(); return }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        let answer = panel(dismissed: completionHandler)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in answer(completionHandler) })
        presentAlert(alert, answer: answer, otherwise: completionHandler)
    }

    public func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard fromPage(frame) else { completionHandler(false); return }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        let answer = panel { completionHandler(false) }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in answer { completionHandler(false) } })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in answer { completionHandler(true) } })
        presentAlert(alert, answer: answer) { completionHandler(false) }
    }

    public func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard fromPage(frame) else { completionHandler(nil); return }
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        let answer = panel { completionHandler(nil) }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in answer { completionHandler(nil) } })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
            let text = alert?.textFields?.first?.text
            answer { completionHandler(text) }
        })
        presentAlert(alert, answer: answer) { completionHandler(nil) }
    }

    /// Registers a panel's fallback answer (used if the screen goes away) and
    /// returns a one-shot `answer` that runs the given reply instead.
    private func panel(dismissed fallback: @escaping () -> Void) -> (@escaping () -> Void) -> Void {
        let id = UUID()
        openPanels[id] = fallback
        return { [weak self] reply in
            guard let self, self.openPanels.removeValue(forKey: id) != nil else { return }
            reply()
        }
    }

    /// Only one panel at a time and none while closing: otherwise the page
    /// gets the dismissive answer straight away.
    private func presentAlert(_ alert: UIAlertController, answer: (@escaping () -> Void) -> Void, otherwise: @escaping () -> Void) {
        guard presentedViewController == nil, !closing else { answer(otherwise); return }
        present(alert, animated: true)
    }
}
#endif
