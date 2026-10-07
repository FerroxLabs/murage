import Capacitor
import MurageShell
import MurageShellCore

/// The launcher's one native door (P22 src/shell.ts types exactly this).
/// Capacitor's WebView loads only the bundled launcher, and the workspace is
/// our own WebView with no bridge; each call still checks it came from the
/// bundled page, and every path answers (resolve or reject with a code).
@objc(ShellPlugin)
public final class ShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShellPlugin"
    public let jsName = "MurageShell"
    public let pluginMethods: [CAPPluginMethod] = ["state", "scan", "open", "remove", "openTailscale"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    public override func load() {
        Task { @MainActor in
            ShellCoordinator.shared.onClosed = { [weak self] closed in
                // Retained until the launcher page has attached its listener.
                self?.notifyListeners("workspaceClosed", data: ["origin": closed.origin, "reason": closed.reason.rawValue], retainUntilConsumed: true)
            }
            // A launcher notice by code (L1 holds the words), e.g. a tap on a
            // notification from a computer that was removed. Retained, as above.
            ShellCoordinator.shared.onNotice = { [weak self] code in
                self?.notifyListeners("notice", data: ["code": code], retainUntilConsumed: true)
            }
            if let code = ShellCoordinator.shared.takePendingNotice() {
                self.notifyListeners("notice", data: ["code": code], retainUntilConsumed: true)
            }
        }
    }

    /// The page on the bridge is the app's own bundle (capacitor://localhost),
    /// else the call is refused with `unavailable`. On the main actor: the
    /// plugin queue must not read the WebView.
    @MainActor
    private func fromLauncher(_ call: CAPPluginCall) -> Bool {
        let local = bridge?.config.localURL
        let page = bridge?.webView?.url
        guard let local, let page, page.scheme == local.scheme, page.host == local.host, page.port == local.port else {
            call.reject("unavailable", "unavailable")
            return false
        }
        return true
    }

    @objc func state(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard fromLauncher(call) else { return }
            // Unreadable is not empty: the launcher asks to unlock and try again (P14).
            guard let state = ShellCoordinator.shared.snapshot() else { call.reject("unreadable", "unreadable"); return }
            call.resolve(state)
        }
    }

    @objc func scan(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard fromLauncher(call) else { return }
            ShellCoordinator.shared.scan { result in
                switch result {
                case .success(let text): call.resolve(["text": text])
                case .failure(let failure): call.reject(failure.rawValue, failure.rawValue)
                }
            }
        }
    }

    @objc func open(_ call: CAPPluginCall) {
        let origin = call.getString("origin")
        let credential = call.getString("credential")
        Task { @MainActor in
            guard fromLauncher(call) else { return }
            guard let origin else { call.reject("bad_origin", "bad_origin"); return }
            switch await ShellCoordinator.shared.open(originString: origin, credential: credential) {
            case .success(let verdict):
                var result: [String: Any] = ["mode": verdict.mode]
                if let hostCapability = verdict.hostCapability { result["hostCapability"] = hostCapability }
                call.resolve(result)
            case .failure(let failure): call.reject(failure.rawValue, failure.rawValue)
            }
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        let origin = call.getString("origin") ?? ""
        Task { @MainActor in
            guard fromLauncher(call) else { return }
            if let failure = ShellCoordinator.shared.remove(originString: origin) {
                call.reject(failure.rawValue, failure.rawValue)
            } else {
                call.resolve()
            }
        }
    }

    @objc func openTailscale(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard fromLauncher(call) else { return }
            ShellCoordinator.shared.openTailscale()
            call.resolve()
        }
    }
}
