import Foundation
import MurageShellCore

/// Capture the bearer before clearing local state. Remote removal is best effort.
@MainActor final class PhoneJobsCleanup {
    let token: (WorkspaceOrigin) throws -> String?
    let removeToken: (WorkspaceOrigin) throws -> Void
    let removeConsent: (WorkspaceOrigin) throws -> Void
    let clearLedger: (WorkspaceOrigin) throws -> Void
    let unregister: (URLRequest) -> Void
    init(token: @escaping (WorkspaceOrigin) throws -> String?, removeToken: @escaping (WorkspaceOrigin) throws -> Void,
         removeConsent: @escaping (WorkspaceOrigin) throws -> Void, clearLedger: @escaping (WorkspaceOrigin) throws -> Void,
         unregister: @escaping (URLRequest) -> Void) {
        self.token = token; self.removeToken = removeToken; self.removeConsent = removeConsent
        self.clearLedger = clearLedger; self.unregister = unregister
    }
    @discardableResult func forget(_ workspace: WorkspaceOrigin) -> Bool {
        let bearer = try? token(workspace)
        var cleared = true
        do { try removeToken(workspace) } catch { cleared = false }
        do { try removeConsent(workspace) } catch { cleared = false }
        do { try clearLedger(workspace) } catch { cleared = false }
        if let bearer, let url = URL(string: workspace.serialized + "/api/phones/self") {
            var request = URLRequest(url: url, timeoutInterval: 3); request.httpMethod = "DELETE"
            request.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization")
            unregister(request)
        }
        return cleared
    }
    func firstInstall(defaults: UserDefaults, origins: () throws -> [WorkspaceOrigin]) {
        let marker = "phoneJobs.install.v1"
        guard !defaults.bool(forKey: marker), let workspaces = try? origins() else { return }
        var cleared = true
        for workspace in workspaces { if !forget(workspace) { cleared = false } }
        if cleared { defaults.set(true, forKey: marker) }
    }
}
