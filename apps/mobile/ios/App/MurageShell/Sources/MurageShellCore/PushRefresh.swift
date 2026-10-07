import Foundation

/// The relay deletes a device row and its bindings after 30 idle days, and only
/// a registration refresh, a delivery or a host publish counts. Opening the app
/// does not, so a quiet pairing would be swept. When the app comes to the front
/// it refreshes its registration, at most once every 24 hours.
public enum PushRefreshResult: Equatable, Sendable {
    case refreshed
    /// Nothing to refresh (no install, no stored token): not counted either way.
    case skipped
    case failed
}

public struct PushRefreshRecord: Equatable, Sendable {
    public var lastSuccess: TimeInterval
    public var failures: Int
    public var retryAt: TimeInterval
    public init(lastSuccess: TimeInterval = 0, failures: Int = 0, retryAt: TimeInterval = 0) {
        self.lastSuccess = lastSuccess
        self.failures = failures
        self.retryAt = retryAt
    }

    /// 15 minutes after the first failure, doubling, never more than 6 hours.
    public static func backoff(failures: Int) -> TimeInterval {
        min(6 * 3600, 15 * 60 * pow(2, Double(max(0, min(failures, 10) - 1))))
    }
}

public protocol PushRefreshStore: AnyObject {
    var record: PushRefreshRecord { get set }
}

public final class MemoryRefreshStore: PushRefreshStore {
    public var record = PushRefreshRecord()
    public init() {}
}

/// Decides when a foreground refreshes, and keeps the last-success stamp and
/// the failure backoff. It runs once per foreground event: a failure waits for
/// a later foreground after the backoff, never a retry loop.
@MainActor public final class PushRefresher {
    public static let interval: TimeInterval = 24 * 3600
    private let store: PushRefreshStore
    private let now: () -> Date
    private let run: () async -> PushRefreshResult
    private var running = false

    public init(store: PushRefreshStore, now: @escaping () -> Date = Date.init, run: @escaping () async -> PushRefreshResult) {
        self.store = store
        self.now = now
        self.run = run
    }

    public func foreground() async {
        let t = now().timeIntervalSince1970
        let r = store.record
        guard !running, t - r.lastSuccess >= Self.interval, t >= r.retryAt else { return }
        running = true
        defer { running = false }
        switch await run() {
        case .refreshed: store.record = PushRefreshRecord(lastSuccess: t, failures: 0, retryAt: 0)
        case .skipped: break
        case .failed:
            let failures = r.failures + 1
            store.record = PushRefreshRecord(lastSuccess: r.lastSuccess, failures: failures, retryAt: t + PushRefreshRecord.backoff(failures: failures))
        }
    }
}
