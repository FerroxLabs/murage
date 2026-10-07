#if os(iOS)
import Foundation
import MurageShellCore

/// Spec §3.1 "Reachability probe": `GET /healthz` with native HTTP, before
/// the launcher opens a computer (and alongside a cold start, Decision 4).
enum ProbeClient {
    /// `{"ok":true,"mobile":1,"name":…}` is tiny. A longer body is not a
    /// Murage door, so it is read no further and counts as basic.
    static let bodyLimit = 4096

    /// The probe answers for the saved origin only: a 3xx is not followed
    /// (it reaches classify as a status, so basic), whoever it points at.
    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    private static let noRedirects = NoRedirects()

    /// No cookies and no cache: the probe proves reachability and the door's
    /// version, nothing about the session.
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 10
        config.waitsForConnectivity = false
        return URLSession(configuration: config, delegate: noRedirects, delegateQueue: nil)
    }()

    static func probe(_ origin: WorkspaceOrigin, userAgent: String) async -> ProbeVerdict {
        guard let url = origin.url(path: "/healthz") else { return .unreachable }
        var request = URLRequest(url: url)
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let started = Date()
        do {
            let (bytes, response) = try await session.bytes(for: request, delegate: noRedirects)
            defer { bytes.task.cancel() }
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            // Only a 200 can be full; any other status is classified on its own.
            let body = status == 200 ? try await capped(bytes, declared: response.expectedContentLength) : nil
            let verdict = ProbeVerdict.classify(status: status, body: body, errorDomain: nil, errorCode: nil)
            ShellLog.probe(host: origin.host, status: status, bytes: body?.count, mode: verdict.mode, ms: ms(since: started))
            return verdict
        } catch {
            let failure = error as NSError
            let verdict = ProbeVerdict.classify(status: nil, body: nil, errorDomain: failure.domain, errorCode: failure.code)
            ShellLog.probeFailed(host: origin.host, domain: failure.domain, code: failure.code, mode: verdict.mode, ms: ms(since: started))
            return verdict
        }
    }

    /// The body, or nil once it passes the limit (declared or read).
    private static func capped(_ bytes: URLSession.AsyncBytes, declared: Int64) async throws -> Data? {
        if declared > Int64(bodyLimit) { return nil }
        var body = Data()
        for try await byte in bytes {
            guard body.count < bodyLimit else { return nil }
            body.append(byte)
        }
        return body
    }
}
#endif
