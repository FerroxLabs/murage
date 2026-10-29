import Foundation

/// No cookies, URL cache, credential fallback or redirects for native bearers.
public final class ShareTargetsHTTP: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.urlCache = nil
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 5; config.timeoutIntervalForResource = 5
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()
    public func fetch(_ origin: WorkspaceOrigin, token: String) async throws -> ShareTargetsClient.Response {
        guard PhoneAskContract.tokenValid(token), let url = origin.url(path: "/api/phones/self/targets") else { throw ShareInputError.invalid }
        var request = URLRequest(url: url, timeoutInterval: 5)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        return try await send(request)
    }
    /// Shared foreground transport for targets and the single App Intent POST.
    public func send(_ request: URLRequest) async throws -> ShareTargetsClient.Response {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.url == request.url else { throw ShareInputError.invalid }
        return .init(status: http.statusCode, data: data)
    }
    public func close() { session.invalidateAndCancel() }
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

#if os(iOS)
public enum ShareContainer {
    public static let group = "group.com.murage.mobile"
    public static var root: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) }
}

/// N12 takes over this identifier on app relaunch. It owns outcomes and retries.
@MainActor public final class ShareUploadSession {
    public static let identifier = "com.murage.mobile.share.ext"
    public init() {}
    public func enqueue(_ prepared: ShareBodyFile.Prepared, origin: WorkspaceOrigin, token: String) throws {
        guard let root = ShareContainer.root, !SharePendingRemovals(root: root).contains(origin) else { throw ShareInputError.invalid }
        guard try PhoneAskTokenStore().readForAsk(origin: origin) == token,
              !SharePendingRemovals(root: root).contains(origin),
              PhoneAskContract.tokenValid(token), let url = origin.url(path: "/api/phones/self/share") else { throw ShareInputError.invalid }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue(try ShareMultipartWriter.contentType(boundary: prepared.boundary), forHTTPHeaderField: "Content-Type")
        try ShareBackgroundSessions.shared.enqueueExtension(request: request, body: prepared.body, shareId: prepared.state.shareId)
    }
}
#endif
