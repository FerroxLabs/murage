#if os(iOS)
import Foundation
import MurageShellCore

/// The relay's phone routes (Plan 3a R3, cloudflare/push-relay/src/relay.ts).
/// The relay never sees content.
enum RelayConfig {
    /// Decision 4, with the Plan 3a correction: the relay lives on its
    /// workers.dev address until murage.ai moves accounts.
    static var origin: URL {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if let at = args.firstIndex(of: "-murageRelay"), at + 1 < args.count, let url = URL(string: args[at + 1]), url.scheme == "https" { return url }
        #endif
        return URL(string: "https://murage-push-relay.sean-874.workers.dev")!
    }
    /// Decision 5, corrected by B12: the APNs environment is the one in the
    /// entitlement the app was signed with (embedded provisioning profile), not
    /// the build configuration; Debug/Release only decides it when the build
    /// carries no profile (App Store, simulator).
    static var environment: String {
        #if DEBUG
        let compiled = "development"
        #else
        let compiled = "production"
        #endif
        let profile = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision").flatMap { try? Data(contentsOf: $0) }
        return PushEnvironment.resolve(provisioning: profile, compiledDefault: compiled)
    }
    /// The environment App Attest runs in (the entitlement's build setting), for the approval statement.
    static var attestEnvironment: String {
        AppAttestEnvironment.resolve(plistValue: Bundle.main.object(forInfoDictionaryKey: "AppAttestEnvironment"), fallback: environment)
    }
}

/// Sends RelayRequests. Its own ephemeral session: no cookies, no cache, a
/// 15 s cap on the whole call, and no redirects, so the device secret, the
/// push token and the attestation never go anywhere but the relay (a 3xx
/// comes back as the answer, which is never a request's `ok`).
final class RelayClient: RelayTransport {
    let origin = RelayConfig.origin
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 15
        config.httpShouldSetCookies = false
        config.urlCache = nil
        return URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }()

    /// Nothing is logged but the status. The body is capped as every push
    /// call's is (PushExtension.send; final review M6).
    func send(_ request: RelayRequest) async -> (status: Int?, body: [String: Any]?) {
        let (status, body) = await PushExtension.send(request.urlRequest(origin: origin), session: session)
        guard let status else {
            ShellLog.event("relay unreachable")
            return (nil, nil)
        }
        ShellLog.event("relay answered", status: status)
        return (status, body as? [String: Any])
    }

    private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }
}
#endif
