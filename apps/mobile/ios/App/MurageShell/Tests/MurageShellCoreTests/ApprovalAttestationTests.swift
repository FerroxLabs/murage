import CryptoKit
import XCTest
@testable import MurageShellCore

@MainActor final class ApprovalAttestationTests: XCTestCase {
    let challenge = String(repeating: "c", count: 43)
    let install = "install-0123456789abcdef"
    let key = "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU"
    let statement = String(repeating: "p", count: 300) + "." + String(repeating: "s", count: 86)

    func testBindingNonceMatchesTheRelayVector() {
        XCTAssertEqual(ApprovalAttestation.keyHash(approvalKey: key), "698bea63dc44a344663ff1429aea10842df27b6b991ef25866b2c6c02cdcc5be")
        let nonce = ApprovalAttestation.bindingNonce(challenge: challenge, installId: install, approvalKey: key)
        XCTAssertEqual(nonce, "UN2c6c0F-1AOnOUvSdQGdncHDywJnuy_rPVYm56KLhI")
        // What AppAttester feeds attestKey: SHA256(utf8(nonce)).
        XCTAssertEqual(SHA256.hash(data: Data(nonce!.utf8)).map { String(format: "%02x", $0) }.joined(), "df45c0e3ac68cc431601f75595398501891217baef7ef14adbc4ec2414c7c2ae")
    }

    func testAKeyThatIsNotAPointHasNoHash() {
        XCTAssertNil(ApprovalAttestation.keyHash(approvalKey: "AAAA"))
        XCTAssertNil(ApprovalAttestation.bindingNonce(challenge: challenge, installId: install, approvalKey: "AAAA"))
    }

    func testAsksForAChallengeAttestsTheBindingNonceAndReturnsTheStatement() async {
        let relay = FakeRelay(); relay.answers = [(201, ["challenge": challenge]), (201, ["statement": statement, "expiresAt": 1])]
        let attester = FakeAttester()
        let got = await ApprovalAttestation.statement(transport: relay, attester: attester, environment: "production", installId: install, approvalKey: key)
        XCTAssertEqual(got, statement)
        XCTAssertEqual(attester.challenges, ["UN2c6c0F-1AOnOUvSdQGdncHDywJnuy_rPVYm56KLhI"]) // never the bare challenge
        XCTAssertEqual(relay.routes, ["POST /v1/challenges", "POST /v1/approval-keys"])
        let body = relay.sent[1].body ?? [:]
        XCTAssertEqual(body["challenge"] as? String, challenge)
        XCTAssertEqual(body["installId"] as? String, install)
        XCTAssertEqual(body["approvalKey"] as? String, key)
        XCTAssertEqual(body["platform"] as? String, "ios")
        XCTAssertEqual(body["environment"] as? String, "production")
        XCTAssertEqual(body["attestation"] as? [String: String], ["kind": "app-attest", "keyId": "key", "attestationObject": "object"])
    }

    func testAnyFailureMeansNoStatementAndNoSecondAttempt() async {
        for answers in [[(Int?.none, [String: Any]?.none)], [(201, ["challenge": challenge]), (403, ["error": "attestation_failed"])], [(201, ["challenge": "short"])],
                        [(201, ["challenge": challenge]), (201, ["statement": "not a statement"])]] as [[(Int?, [String: Any]?)]] {
            let relay = FakeRelay(); relay.answers = answers
            let got = await ApprovalAttestation.statement(transport: relay, attester: FakeAttester(), environment: "production", installId: install, approvalKey: key)
            XCTAssertNil(got)
            XCTAssertLessThanOrEqual(relay.sent.count, 2)
        }
        let unsupported = FakeAttester(); unsupported.isSupported = false
        let relay = FakeRelay()
        let none = await ApprovalAttestation.statement(transport: relay, attester: unsupported, environment: "production", installId: install, approvalKey: key)
        XCTAssertNil(none)
        XCTAssertTrue(relay.sent.isEmpty) // the simulator touches nothing
    }

    func testASlowRelayCannotHoldPairingPastTheBudget() async {
        let relay = FakeRelay(); relay.answers = [(201, ["challenge": challenge]), (201, ["statement": statement])]
        relay.beforeAnswer = nil
        relay.delayNanos = 5_000_000_000
        let started = Date()
        let got = await ApprovalAttestation.statement(transport: relay, attester: FakeAttester(), environment: "production", installId: install, approvalKey: key, budget: .milliseconds(200))
        XCTAssertNil(got)
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
    }

    /// F1: the cap is hard. App Attest that never returns still lets pairing go on at the deadline.
    func testAnAttesterThatNeverReturnsStillEndsAtTheBudget() async {
        let relay = FakeRelay(); relay.answers = [(201, ["challenge": challenge]), (201, ["statement": statement])]
        let hung = HungAttester()
        let started = Date()
        let got = await ApprovalAttestation.statement(transport: relay, attester: hung, environment: "production", installId: install, approvalKey: key, budget: .milliseconds(200))
        XCTAssertNil(got)
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
        XCTAssertEqual(relay.routes, ["POST /v1/challenges"]) // never reached the second call
        hung.release()
    }

    /// From the P4 review: a key never goes without its statement.
    func testNoStatementPairsWithoutAKeyAtAll() {
        let link = ApprovalAttestation.enterPath(credential: "murage_pair_abc", installId: install, approvalKey: key, approvalStatement: nil)
        XCTAssertEqual(link, "/enter#murage_pair_abc&installId=\(install)")
        XCTAssertFalse(link?.contains("approvalKey") ?? true)
        let full = ApprovalAttestation.enterPath(credential: "murage_pair_abc", installId: install, approvalKey: key, approvalStatement: statement)
        XCTAssertEqual(full, "/enter#murage_pair_abc&installId=\(install)&approvalKey=\(key)&approvalStatement=\(statement)")
        // A statement that fails the shape check also falls back to no key.
        XCTAssertEqual(ApprovalAttestation.enterPath(credential: "murage_pair_abc", installId: install, approvalKey: key, approvalStatement: "a&b"),
                       "/enter#murage_pair_abc&installId=\(install)")
        // No key, no statement, no install id: the old door's plain form.
        XCTAssertEqual(ApprovalAttestation.enterPath(credential: "murage_pair_abc", installId: nil, approvalKey: nil, approvalStatement: nil), "/enter#murage_pair_abc")
    }
}

/// An attester that ignores cancellation and never answers until released.
@MainActor final class HungAttester: PushAttester {
    var isSupported = true
    private var waiting: [CheckedContinuation<Void, Never>] = []
    func attest(challenge: String) async -> (keyId: String, attestationObject: String)? {
        await withCheckedContinuation { waiting.append($0) }
        return nil
    }
    func release() { waiting.forEach { $0.resume() }; waiting = [] }
}
