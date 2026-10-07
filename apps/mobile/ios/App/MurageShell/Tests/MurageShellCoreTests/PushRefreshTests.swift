import XCTest
@testable import MurageShellCore

@MainActor final class PushRefreshTests: XCTestCase {
    private var clock = Date(timeIntervalSince1970: 1_000_000)
    private var store = MemoryRefreshStore()
    private var runs = 0
    private var results: [PushRefreshResult] = []

    private func make() -> PushRefresher {
        PushRefresher(store: store, now: { [unowned self] in clock }, run: { [unowned self] in
            runs += 1
            return results.isEmpty ? .refreshed : results.removeFirst()
        })
    }

    func testFiresOnForegroundWhenMoreThan24HoursHavePassed() async {
        store.record = PushRefreshRecord(lastSuccess: clock.timeIntervalSince1970 - 25 * 3600, failures: 0, retryAt: 0)
        await make().foreground()
        XCTAssertEqual(runs, 1)
        XCTAssertEqual(store.record.lastSuccess, clock.timeIntervalSince1970)
    }

    func testFiresOnTheFirstForegroundWithNoRecord() async {
        await make().foreground()
        XCTAssertEqual(runs, 1)
    }

    func testDoesNotFireWithin24Hours() async {
        store.record = PushRefreshRecord(lastSuccess: clock.timeIntervalSince1970 - 23 * 3600, failures: 0, retryAt: 0)
        let r = make()
        await r.foreground()
        await r.foreground()
        XCTAssertEqual(runs, 0)
    }

    func testAFailureBacksOffAndNeverLoops() async {
        results = [.failed, .failed, .refreshed]
        let r = make()
        await r.foreground()
        XCTAssertEqual(runs, 1)
        XCTAssertEqual(store.record.failures, 1)
        XCTAssertEqual(store.record.lastSuccess, 0)
        await r.foreground()                      // same instant: backed off
        XCTAssertEqual(runs, 1)
        clock.addTimeInterval(14 * 60)
        await r.foreground()
        XCTAssertEqual(runs, 1)
        clock.addTimeInterval(2 * 60)             // past the first 15 minute wait
        await r.foreground()
        XCTAssertEqual(runs, 2)
        XCTAssertEqual(store.record.failures, 2)
        clock.addTimeInterval(20 * 60)            // the second wait is 30 minutes
        await r.foreground()
        XCTAssertEqual(runs, 2)
        clock.addTimeInterval(11 * 60)
        await r.foreground()
        XCTAssertEqual(runs, 3)
        XCTAssertEqual(store.record.failures, 0)
    }

    func testTheBackoffIsCapped() {
        XCTAssertEqual(PushRefreshRecord.backoff(failures: 1), 15 * 60)
        XCTAssertEqual(PushRefreshRecord.backoff(failures: 2), 30 * 60)
        XCTAssertEqual(PushRefreshRecord.backoff(failures: 50), 6 * 3600)
    }

    func testSkippedIsNotStampedSoNothingIsClaimed() async {
        results = [.skipped]
        await make().foreground()
        XCTAssertEqual(store.record, PushRefreshRecord())
    }

    func testOverlappingForegroundsShareOneRun() async {
        let r = make()
        async let a: Void = r.foreground()
        async let b: Void = r.foreground()
        _ = await (a, b)
        XCTAssertEqual(runs, 1)
    }
}
