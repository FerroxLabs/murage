import XCTest
@testable import MurageShellCore

/// contract/relay-requests.json: the phone's side of relay.ts's routes.
final class RelayRequestTests: XCTestCase {
    private let secret = "murage_ds_" + String(repeating: "S", count: 43)
    private let binding = "5b0c6f0e-1d2a-4c3b-8a9d-0e1f2a3b4c5d"

    func testEveryBuilderMatchesTheFixture() throws {
        let built: [String: RelayRequest] = [
            "challenge": .challenge(),
            "registerDevice": .registerDevice(environment: "development", pushToken: "ab12", challenge: "c", keyId: "k", attestationObject: "o"),
            "updateToken": .updateToken(secret: secret, pushToken: "ab12"),
            "createBinding": .createBinding(secret: secret),
            "deleteBinding": .deleteBinding(binding, secret: secret),
            "approvalStatement": .approvalStatement(environment: "development", challenge: "c", installId: "i", approvalKey: "k", keyId: "k", attestationObject: "o"),
        ]
        let cases = try Fixtures.json("relay-requests.json") as? [[String: Any]] ?? []
        XCTAssertEqual(cases.count, built.count)
        for c in cases {
            let name = c["name"] as? String ?? ""
            let r = try XCTUnwrap(built[name], name)
            XCTAssertEqual(r.method, c["method"] as? String, name)
            XCTAssertEqual(r.path.replacingOccurrences(of: binding, with: ":id"), c["path"] as? String, name)
            XCTAssertEqual(r.bearer != nil, c["auth"] as? String == "device", name)
            XCTAssertEqual(r.body.map { $0.keys.sorted() }, c["body"] as? [String], name)
            XCTAssertEqual(r.ok, c["ok"] as? Int, name)
        }
    }

    func testRegistrationCarriesTheAppAttestObject() {
        let r = RelayRequest.registerDevice(environment: "development", pushToken: "ab12", challenge: "c", keyId: "k", attestationObject: "o")
        XCTAssertEqual(r.body?["platform"] as? String, "ios")
        XCTAssertEqual(r.body?["environment"] as? String, "development")
        XCTAssertEqual(r.body?["attestation"] as? [String: String], ["kind": "app-attest", "keyId": "k", "attestationObject": "o"])
    }

    func testTheURLRequestHasTheBearerTheBodyAndAFifteenSecondCap() throws {
        let u = RelayRequest.updateToken(secret: secret, pushToken: "ab12").urlRequest(origin: URL(string: "https://relay.example")!)
        XCTAssertEqual(u.url?.absoluteString, "https://relay.example/v1/devices/self/token")
        XCTAssertEqual(u.httpMethod, "PUT")
        XCTAssertEqual(u.value(forHTTPHeaderField: "Authorization"), "Bearer \(secret)")
        XCTAssertEqual(u.timeoutInterval, 15)
        let body = try JSONSerialization.jsonObject(with: XCTUnwrap(u.httpBody)) as? [String: String]
        XCTAssertEqual(body, ["pushToken": "ab12"])
        XCTAssertNil(RelayRequest.createBinding(secret: secret).urlRequest(origin: URL(string: "https://relay.example")!).httpBody)
    }

    func testTokenUpdateOutcomes() {
        XCTAssertEqual(TokenUpdateOutcome.from(status: 200), .store)
        XCTAssertEqual(TokenUpdateOutcome.from(status: 401), .drop)
        XCTAssertEqual(TokenUpdateOutcome.from(status: 409), .drop)
        for status: Int? in [nil, 302, 429, 500] { XCTAssertEqual(TokenUpdateOutcome.from(status: status), .retry) }
    }
}

@MainActor final class PushEnrolmentTests: XCTestCase {
    private let a = "https://mac.tailnet123.ts.net"
    private let b = "https://old.tailnet123.ts.net"
    private let old1 = "5b0c6f0e-1d2a-4c3b-8a9d-0e1f2a3b4c5d"
    private let old2 = "6c1d7a1f-2e3b-4d4c-9b0e-1f2a3b4c5d6e"
    private let s1 = "murage_ds_" + String(repeating: "1", count: 43)
    private let s2 = "murage_ds_" + String(repeating: "2", count: 43)

    private var relay: FakeRelay!
    private var attester: FakeAttester!
    private var secrets: EnrolSecrets!
    private var ledger: EnrolLedger!
    private var platform: FakePlatform!
    private var forgotten: [String] = []
    private var plans: [PushEnrolment.Decision] = []
    private var enrolment: PushEnrolment!

    override func setUp() async throws {
        relay = FakeRelay(); attester = FakeAttester(); secrets = EnrolSecrets(); ledger = EnrolLedger(); platform = FakePlatform()
        forgotten = []
        enrolment = PushEnrolment(transport: relay, attester: attester, secrets: secrets, ledger: ledger, platform: platform,
                                  environment: "development", forget: { [unowned self] origin in
            self.forgotten.append(origin)
            _ = PushBindings(ledger: self.ledger, secrets: self.secrets).forget(origin: origin)
        })
        plans = []
        enrolment.onDecision = { [unowned self] in self.plans.append($0) }
    }

    /// Two workspaces enrolled under the install whose secret is s1.
    private func enrolledTwice() {
        _ = ledger.update { $0.bind(old1, origin: a); $0.bind(old2, origin: b) }
        for id in [old1, old2] {
            _ = secrets.write("murage_pd_x", secret: .detail, account: id)
            _ = secrets.write("murage_pr_x", secret: .respond, account: id)
        }
        _ = secrets.write(s1, secret: .deviceSecret, account: "install")
        _ = secrets.write("aa11", secret: .deviceSecret, account: "apnsToken")
    }

    func testAnEnrolledWorkspaceReusesItsBinding() async {
        enrolledTwice()
        let got1 = await enrolment.register(origin: a, fresh: false)
        XCTAssertEqual(got1, .enrolled(bindingId: old1))
        XCTAssertTrue(relay.sent.isEmpty)
    }

    func testCreateAttestsOnceBindsAndRecordsTheOrigin() async {
        relay.answers = [(201, ["challenge": "c1"]), (201, ["deviceSecret": s1]), (201, ["bindingId": "N1", "grant": "G1"])]
        let got2 = await enrolment.register(origin: a, fresh: false)
        XCTAssertEqual(got2, .granted(bindingId: "N1", grant: "G1"))
        XCTAssertEqual(relay.routes, ["POST /v1/challenges", "POST /v1/devices", "POST /v1/bindings"])
        XCTAssertEqual(attester.challenges, ["c1"])
        XCTAssertEqual(ledger.ledger.binding(origin: a), "N1")
        XCTAssertEqual(secrets.read(secret: .deviceSecret, account: "install"), s1)
        XCTAssertEqual(secrets.read(secret: .deviceSecret, account: "apnsToken"), "aa11")
    }

    func testUnsupportedTouchesNothing() async {
        attester.isSupported = false
        _ = ledger.update { $0.bind(old1, origin: a) } // bound, no detail: plans replace
        let before = secrets.items
        let got3 = await enrolment.register(origin: a, fresh: true)
        XCTAssertEqual(got3, .unsupported)
        XCTAssertTrue(relay.sent.isEmpty)
        XCTAssertTrue(forgotten.isEmpty)
        XCTAssertEqual(secrets.items, before)
        XCTAssertEqual(ledger.writes, 1)
        XCTAssertEqual(platform.tokenAsks, 0)
    }

    func testDeniedAsksNothingOfTheRelay() async {
        platform.permission = "denied"
        let got4 = await enrolment.register(origin: a, fresh: false)
        XCTAssertEqual(got4, .denied)
        XCTAssertTrue(relay.sent.isEmpty)
    }

    func testA401OnBindingDropsTheInstallAndRetriesExactlyOnce() async {
        _ = secrets.write(s1, secret: .deviceSecret, account: "install")
        relay.answers = [(401, nil), (201, ["challenge": "c2"]), (201, ["deviceSecret": s2]), (201, ["bindingId": "N1", "grant": "G1"])]
        let got5 = await enrolment.register(origin: a, fresh: false)
        XCTAssertEqual(got5, .granted(bindingId: "N1", grant: "G1"))
        XCTAssertEqual(relay.routes, ["POST /v1/bindings", "POST /v1/challenges", "POST /v1/devices", "POST /v1/bindings"])
        XCTAssertEqual(relay.sent.last?.bearer, s2)
        XCTAssertEqual(secrets.read(secret: .deviceSecret, account: "install"), s2)
    }

    func testASecond401AnswersUnavailable() async {
        _ = secrets.write(s1, secret: .deviceSecret, account: "install")
        relay.answers = [(401, nil), (201, ["challenge": "c2"]), (201, ["deviceSecret": s2]), (401, nil)]
        let got6 = await enrolment.register(origin: a, fresh: false)
        XCTAssertEqual(got6, .failed)
        XCTAssertEqual(relay.routes.filter { $0 == "POST /v1/bindings" }.count, 2)
        XCTAssertNil(ledger.ledger.binding(origin: a))
    }

    func testALedgerThatCannotSaveGivesTheBindingBack() async {
        _ = secrets.write(s1, secret: .deviceSecret, account: "install")
        ledger.saveFails = true
        relay.answers = [(201, ["bindingId": "N1", "grant": "G1"]), (200, ["removed": true])]
        let got7 = await enrolment.register(origin: a, fresh: false)
        XCTAssertEqual(got7, .failed)
        XCTAssertEqual(relay.routes, ["POST /v1/bindings", "DELETE /v1/bindings/N1"])
        XCTAssertEqual(relay.sent.last?.bearer, s1)
    }

    func testAfterADropEveryOtherWorkspaceReplacesItsBinding() async {
        enrolledTwice()
        relay.answers = [(409, ["error": "token_in_use"])]
        await enrolment.tokenChanged("bb22")
        XCTAssertNil(secrets.read(secret: .deviceSecret, account: "install"))

        relay.answers = [(201, ["challenge": "c2"]), (201, ["deviceSecret": s2]), (201, ["bindingId": "N1", "grant": "G1"])]
        let got8 = await enrolment.register(origin: a, fresh: false)
        XCTAssertEqual(got8, .granted(bindingId: "N1", grant: "G1"))
        // The secret exists again, but b's binding was made under the dropped install.
        relay.answers = [(201, ["bindingId": "N2", "grant": "G2"])]
        let got9 = await enrolment.register(origin: b, fresh: false)
        XCTAssertEqual(got9, .granted(bindingId: "N2", grant: "G2"))
        // Each old binding stays until the host takes its new one.
        XCTAssertEqual(forgotten, [])
        XCTAssertEqual(ledger.ledger.bindingIds.sorted(), [old1, old2].sorted())
        XCTAssertTrue(enrolment.adopt(origin: a, bindingId: "N1"))
        XCTAssertTrue(enrolment.adopt(origin: b, bindingId: "N2"))
        XCTAssertEqual(forgotten, [a, b])
        XCTAssertEqual(ledger.ledger.bindingIds.sorted(), ["N1", "N2"])
    }

    /// The device incident of 2026-09-27: a replace deleted the working
    /// binding at the relay before the host had the new one.
    func testReplaceKeepsTheOldBindingUntilTheHostConfirms() async {
        _ = ledger.update { $0.bind(old1, origin: a) } // bound, no detail: plans replace
        _ = secrets.write(s1, secret: .deviceSecret, account: "install")
        relay.answers = [(201, ["bindingId": "N1", "grant": "G1"])]
        let got = await enrolment.register(origin: a, fresh: false)
        XCTAssertEqual(got, .granted(bindingId: "N1", grant: "G1"))
        XCTAssertEqual(relay.routes, ["POST /v1/bindings"]) // no DELETE of old1
        XCTAssertEqual(forgotten, [])
        XCTAssertEqual(ledger.ledger.binding(origin: a), old1)
        XCTAssertEqual(enrolment.pendingBindingIds, ["N1"]) // reconcile keeps its notifications

        XCTAssertTrue(enrolment.adopt(origin: a, bindingId: "N1"))
        XCTAssertEqual(enrolment.pendingBindingIds, [])
        XCTAssertEqual(forgotten, [a])
        XCTAssertEqual(ledger.ledger.binding(origin: a), "N1")
        XCTAssertFalse(enrolment.adopt(origin: a, bindingId: "N1")) // once
    }

    func testAReplaceTheHostNeverTookLeavesTheOldBindingInPlace() async {
        enrolledTwice()
        relay.answers = [(201, ["bindingId": "N1", "grant": "G1"])]
        let got = await enrolment.register(origin: a, fresh: true) // the host said not_enrolled
        XCTAssertEqual(got, .granted(bindingId: "N1", grant: "G1"))
        // The page never posts the grant: no adopt.
        XCTAssertEqual(relay.routes, ["POST /v1/bindings"])
        XCTAssertEqual(forgotten, [])
        XCTAssertEqual(ledger.ledger.binding(origin: a), old1)
        XCTAssertEqual(secrets.read(secret: .detail, account: old1), "murage_pd_x")
        XCTAssertEqual(secrets.read(secret: .respond, account: old1), "murage_pr_x")
        let again = await enrolment.register(origin: a, fresh: false)
        XCTAssertEqual(again, .enrolled(bindingId: old1))
    }

    /// Review Important 1: N1 was made under the install the relay then
    /// dropped (409). Committing it would leave a binding no re-attest repairs.
    func testADropDuringAPendingReplaceIsNeverAdopted() async {
        enrolledTwice()
        relay.answers = [(201, ["bindingId": "N1", "grant": "G1"])]
        let got = await enrolment.register(origin: a, fresh: true)
        XCTAssertEqual(got, .granted(bindingId: "N1", grant: "G1"))
        relay.answers = [(409, ["error": "token_in_use"])]
        await enrolment.tokenChanged("bb22")
        XCTAssertNil(secrets.read(secret: .deviceSecret, account: "install"))
        XCTAssertFalse(enrolment.adopt(origin: a, bindingId: "N1"))
        XCTAssertEqual(forgotten, [])
        XCTAssertEqual(ledger.ledger.binding(origin: a), old1)
        XCTAssertNil(secrets.read(secret: .detail, account: "N1"))
    }

    func testForgettingAWorkspaceDropsItsPendingReplace() async {
        enrolledTwice()
        relay.answers = [(201, ["bindingId": "N1", "grant": "G1"])]
        _ = await enrolment.register(origin: a, fresh: true)
        XCTAssertEqual(enrolment.pendingBindingIds, ["N1"])
        enrolment.cancelPending(origin: a)
        XCTAssertEqual(enrolment.pendingBindingIds, [])
        XCTAssertFalse(enrolment.adopt(origin: a, bindingId: "N1"))
        XCTAssertEqual(ledger.ledger.binding(origin: a), old1)
    }

    func testAdoptRefusesAnotherBindingAndAnAlreadyMovedLedger() async {
        XCTAssertFalse(enrolment.adopt(origin: a, bindingId: "N1")) // nothing pending
        enrolledTwice()
        relay.answers = [(201, ["bindingId": "N1", "grant": "G1"])]
        _ = await enrolment.register(origin: a, fresh: true)
        XCTAssertFalse(enrolment.adopt(origin: a, bindingId: "N9"))
        XCTAssertFalse(enrolment.adopt(origin: b, bindingId: "N1"))
        XCTAssertEqual(forgotten, [])
        XCTAssertEqual(ledger.ledger.binding(origin: a), old1)
        // The ledger moved meanwhile (signed out and in again): the pending
        // replace no longer retires what the ledger holds, so it binds nothing.
        _ = ledger.update { l in _ = l.unbindOrigin(a); l.bind("X1", origin: a) }
        XCTAssertFalse(enrolment.adopt(origin: a, bindingId: "N1"))
        XCTAssertEqual(forgotten, [])
        XCTAssertEqual(ledger.ledger.binding(origin: a), "X1")
    }

    func testAdoptNeverResurrectsASignedOutWorkspace() async {
        enrolledTwice()
        relay.answers = [(201, ["bindingId": "N1", "grant": "G1"])]
        _ = await enrolment.register(origin: a, fresh: true)
        _ = ledger.update { l in _ = l.unbindOrigin(a) } // signed out, not paired again
        XCTAssertFalse(enrolment.adopt(origin: a, bindingId: "N1"))
        XCTAssertEqual(forgotten, [])
        XCTAssertNil(ledger.ledger.binding(origin: a))
    }

    func testTokenUpdateStoresTheTokenTheRelayTook() async {
        enrolledTwice()
        relay.answers = [(200, ["ok": true])]
        await enrolment.tokenChanged("bb22")
        XCTAssertEqual(relay.routes, ["PUT /v1/devices/self/token"])
        XCTAssertEqual(secrets.read(secret: .deviceSecret, account: "apnsToken"), "bb22")
        await enrolment.tokenChanged("bb22")
        XCTAssertEqual(relay.sent.count, 1) // unchanged: nothing sent
    }

    func testRefreshSendsTheStoredTokenEvenWhenUnchanged() async {
        enrolledTwice()
        relay.answers = [(200, ["ok": true])]
        let out = await enrolment.refresh()
        XCTAssertEqual(out, .refreshed)
        XCTAssertEqual(relay.routes, ["PUT /v1/devices/self/token"])
        XCTAssertEqual(relay.sent.first?.body?["pushToken"] as? String, "aa11")
        XCTAssertEqual(secrets.read(secret: .deviceSecret, account: "apnsToken"), "aa11")
    }

    func testRefreshWithoutAnInstallSendsNothing() async {
        let out = await enrolment.refresh()
        XCTAssertEqual(out, .skipped)
        XCTAssertTrue(relay.sent.isEmpty)
    }

    func testRefreshFailsOnAnUnreachableRelayAndKeepsTheInstall() async {
        enrolledTwice()
        relay.answers = [(nil, nil)]
        let out = await enrolment.refresh()
        XCTAssertEqual(out, .failed)
        XCTAssertEqual(secrets.read(secret: .deviceSecret, account: "install"), s1)
    }

    func testRefreshAfterTheRelayForgotTheInstallDropsItAndSkips() async {
        enrolledTwice()
        relay.answers = [(401, nil)]
        let out = await enrolment.refresh()
        XCTAssertEqual(out, .skipped)
        XCTAssertNil(secrets.read(secret: .deviceSecret, account: "install"))
    }

    func testTokenUpdateRetriesLaterOnAnyOtherAnswer() async {
        enrolledTwice()
        relay.answers = [(nil, nil)]
        await enrolment.tokenChanged("bb22")
        XCTAssertEqual(secrets.read(secret: .deviceSecret, account: "install"), s1)
        XCTAssertEqual(secrets.read(secret: .deviceSecret, account: "apnsToken"), "aa11")
        let got10 = await enrolment.register(origin: a, fresh: false)
        XCTAssertEqual(got10, .enrolled(bindingId: old1))
    }

    func testADropSparesASecretStoredWhileTheUpdateWasOut() async {
        enrolledTwice()
        relay.answers = [(401, nil)]
        relay.beforeAnswer = { [unowned self] in _ = self.secrets.write(self.s2, secret: .deviceSecret, account: "install") }
        await enrolment.tokenChanged("bb22")
        XCTAssertEqual(secrets.read(secret: .deviceSecret, account: "install"), s2)
    }

    func testOverlappingRegistrationsShareOneRun() async {
        platform.suspend = true
        relay.answers = [(201, ["challenge": "c1"]), (201, ["deviceSecret": s1]), (201, ["bindingId": "N1", "grant": "G1"])]
        async let first = enrolment.register(origin: a, fresh: false)
        async let second = enrolment.register(origin: a, fresh: false)
        let (one, two) = await (first, second)
        XCTAssertEqual(one, .granted(bindingId: "N1", grant: "G1"))
        XCTAssertEqual(two, one)
        XCTAssertEqual(attester.challenges.count, 1)
        XCTAssertEqual(relay.routes.count, 3)
    }

    // MARK: the iPhone churn of 2026-09-28

    private let made1 = "7d2e8b2a-3f4c-4e5d-8a6b-2c3d4e5f6a7b"

    /// issuePushTokens' args as WKScriptMessage hands them over: WebKit turns
    /// every JavaScript number into a double NSNumber, 1790000000000 included.
    private func webKitArgs(_ id: String) -> [String: Any] {
        ["bindingId": id, "detail": "murage_pd_" + String(repeating: "D", count: 43),
         "respond": "murage_pr_" + String(repeating: "R", count: 43), "expiresAt": NSNumber(value: 1_790_000_000_000.0)]
    }

    /// What the issuePushTokens handler does (WorkspaceViewController, then
    /// PushServices): parse the args, adopt a pending replace, store the pair.
    private func issuePushTokens(_ args: Any, origin: String) -> Bool {
        guard let tokens = IssuedTokens.parse(args) else { return false }
        enrolment.adopt(origin: origin, bindingId: tokens.bindingId)
        return PushBindings(ledger: ledger, secrets: secrets).issue(origin: origin, tokens: tokens)
    }

    /// Every registerPush made a new relay binding: issuePushTokens refused
    /// WebKit's double `expiresAt` (bad_args), so no detail token was ever
    /// stored and the next run planned replace. Now the second run reuses.
    func testACreatedBindingIsReusedOnTheNextRegistration() async {
        relay.answers = [(201, ["challenge": "c1"]), (201, ["deviceSecret": s1]), (201, ["bindingId": made1, "grant": "G1"])]
        let first = await enrolment.register(origin: a, fresh: false)
        XCTAssertEqual(first, .granted(bindingId: made1, grant: "G1"))
        XCTAssertTrue(issuePushTokens(webKitArgs(made1), origin: a))
        let calls = relay.sent.count
        let again = await enrolment.register(origin: a, fresh: false)
        XCTAssertEqual(again, .enrolled(bindingId: made1))
        XCTAssertEqual(relay.sent.count, calls) // no relay call: reuse
        XCTAssertEqual(plans.map(\.plan), [.create, .reuse])
    }

    func testAnAdoptedReplaceIsReusedOnTheNextRegistration() async {
        _ = ledger.update { $0.bind(old1, origin: a) } // bound, no detail: plans replace
        _ = secrets.write(s1, secret: .deviceSecret, account: "install")
        relay.answers = [(201, ["bindingId": made1, "grant": "G1"])]
        let first = await enrolment.register(origin: a, fresh: false)
        XCTAssertEqual(first, .granted(bindingId: made1, grant: "G1"))
        XCTAssertTrue(issuePushTokens(webKitArgs(made1), origin: a))
        XCTAssertEqual(forgotten, [a])
        XCTAssertEqual(ledger.ledger.binding(origin: a), made1)
        let again = await enrolment.register(origin: a, fresh: false)
        XCTAssertEqual(again, .enrolled(bindingId: made1))
        XCTAssertEqual(relay.routes, ["POST /v1/bindings"])
        XCTAssertEqual(plans.map(\.plan), [.replace, .reuse])
    }

    /// The debug log line: the plan and the booleans behind it, never an id.
    func testEveryRunReportsItsPlanAndWhy() async {
        enrolledTwice()
        _ = await enrolment.register(origin: a, fresh: false)
        platform.permission = "denied"
        _ = await enrolment.register(origin: b, fresh: true)
        XCTAssertEqual(plans, [
            PushEnrolment.Decision(plan: .reuse, permission: "granted", bound: true, hasDetail: true, fresh: false),
            PushEnrolment.Decision(plan: .denied, permission: "denied", bound: true, hasDetail: true, fresh: true),
        ])
    }

    func testReplyShapes() {
        XCTAssertEqual(try PushEnrolment.Outcome.granted(bindingId: "N1", grant: "G1").reply.get() as? [String: String],
                       ["status": "granted", "bindingId": "N1", "grant": "G1"])
        XCTAssertEqual(try PushEnrolment.Outcome.unsupported.reply.get() as? [String: String], ["status": "unsupported"])
        XCTAssertThrowsError(try PushEnrolment.Outcome.failed.reply.get())
    }
}

@MainActor private final class FakePlatform: PushPlatform {
    var permission = "granted"
    var suspend = false
    var tokenAsks = 0
    func notificationPermission() async -> String {
        if suspend { await Task.yield() }
        return permission
    }
    func pushToken() async -> String? { tokenAsks += 1; return "aa11" }
}

private final class EnrolSecrets: PushSecrets {
    var items: [String: String] = [:]
    private func key(_ s: PushSecret, _ a: String) -> String { "\(s)/\(a)" }
    func write(_ value: String, secret: PushSecret, account: String) -> Bool { items[key(secret, account)] = value; return true }
    func read(secret: PushSecret, account: String) -> String? { items[key(secret, account)] }
    func delete(secret: PushSecret, account: String) { items[key(secret, account)] = nil }
    func accounts(secret: PushSecret) -> [String]? {
        items.keys.compactMap { $0.hasPrefix("\(secret)/") ? String($0.dropFirst("\(secret)/".count)) : nil }
    }
}

private final class EnrolLedger: LedgerAccess {
    var ledger = PushLedger()
    var saveFails = false
    var writes = 0
    func read() -> PushLedger? { ledger }
    func update<T>(_ change: (inout PushLedger) -> T) -> T? {
        var l = ledger
        let out = change(&l)
        if saveFails { return nil }
        ledger = l
        writes += 1
        return out
    }
}

/// B4 (Astra B4): a relay DELETE that cannot be made now is owed, not lost.
@MainActor final class PushDeletionQueueTests: XCTestCase {
    private let s1 = "murage_ds_" + String(repeating: "1", count: 43)
    private func make(_ queue: PushDeletionQueue, secret: String? = nil) -> (PushEnrolment, FakeRelay, EnrolSecrets) {
        let relay = FakeRelay(), secrets = EnrolSecrets()
        if let secret { _ = secrets.write(secret, secret: .deviceSecret, account: "install") }
        let e = PushEnrolment(transport: relay, attester: FakeAttester(), secrets: secrets, ledger: EnrolLedger(), platform: FakePlatform(),
                              environment: "development", forget: { _ in }, deletions: queue)
        return (e, relay, secrets)
    }

    func testAnOfflineRemovalIsKeptAndRetriedUntilTheRelayAnswers() async {
        let queue = MemoryDeletionQueue()
        let (e, relay, _) = make(queue, secret: s1)
        relay.answers = [(nil, nil)]                       // offline
        await e.deleteAtRelay("B1")
        XCTAssertEqual(e.owedDeletions, ["B1"])            // not lost
        relay.answers = [(503, nil)]                       // relay having a bad moment
        await e.drainDeletions()
        XCTAssertEqual(e.owedDeletions, ["B1"])
        relay.answers = [(200, nil)]                       // back
        await e.drainDeletions()
        XCTAssertEqual(e.owedDeletions, [])
        XCTAssertEqual(relay.routes, ["DELETE /v1/bindings/B1", "DELETE /v1/bindings/B1", "DELETE /v1/bindings/B1"])
    }

    func testAFinalAnswerClearsIt() async {
        for status in [200, 401, 403, 404] {
            let queue = MemoryDeletionQueue()
            let (e, relay, _) = make(queue, secret: s1)
            relay.answers = [(status, nil)]
            await e.deleteAtRelay("B1")
            XCTAssertEqual(e.owedDeletions, [], "status \(status)")
        }
        for status in [408, 429, 500, 502] {
            let queue = MemoryDeletionQueue()
            let (e, relay, _) = make(queue, secret: s1)
            relay.answers = [(status, nil)]
            await e.deleteAtRelay("B1")
            XCTAssertEqual(e.owedDeletions, ["B1"], "status \(status)")
        }
    }

    func testTheQueueSurvivesARestart() async {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("del-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let (first, relay, _) = make(FileDeletionQueue(url: url), secret: s1)
        relay.answers = [(nil, nil)]
        await first.deleteAtRelay("B1")
        // a new process: new queue object on the same file
        let (second, relay2, _) = make(FileDeletionQueue(url: url), secret: s1)
        XCTAssertEqual(second.owedDeletions, ["B1"])
        relay2.answers = [(200, nil)]
        await second.drainDeletions()
        XCTAssertEqual(FileDeletionQueue(url: url).ids(), [])
    }

    func testNoInstallSecretKeepsTheQueue() async {
        let queue = MemoryDeletionQueue()
        let (e, relay, _) = make(queue)
        queue.add("B1")
        await e.drainDeletions()
        XCTAssertEqual(queue.ids(), ["B1"]) // a failed Keychain read must not wipe what is owed
        XCTAssertTrue(relay.sent.isEmpty)
    }

    func testForgetAndSweepWriteTheObligationBeforeTheLocalDiscard() {
        let queue = MemoryDeletionQueue()
        let ledger = EnrolLedger(), secrets = EnrolSecrets()
        _ = ledger.update { $0.bind("B1", origin: "https://a.tailnet123.ts.net"); $0.bind("B2", origin: "https://b.tailnet123.ts.net") }
        let bindings = PushBindings(ledger: ledger, secrets: secrets, owed: queue)
        XCTAssertEqual(bindings.forget(origin: "https://a.tailnet123.ts.net").bindingId, "B1")
        XCTAssertEqual(queue.ids(), ["B1"])
        _ = secrets.write("x", secret: .detail, account: "ORPHAN")
        let swept = bindings.sweep(knownOrigins: [])
        XCTAssertEqual(swept.dropped, ["B2"])
        XCTAssertEqual(Set(queue.ids()), ["B1", "B2", "ORPHAN"])
    }
}
