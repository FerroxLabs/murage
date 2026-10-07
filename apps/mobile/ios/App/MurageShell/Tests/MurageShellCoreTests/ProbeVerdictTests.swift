import XCTest
@testable import MurageShellCore

final class ProbeVerdictTests: XCTestCase {
    func testGatewayErrorsAreNotNetworkFailures() {
        // A 401 on /healthz is an older desktop door (companion/src/browser.ts), so it asks for an update.
        XCTAssertEqual(ProbeVerdict.classify(status: 401, body: nil, errorDomain: nil, errorCode: nil).mode, "basic")
        for status in [502, 503, 504] {
            XCTAssertEqual(ProbeVerdict.classify(status: status, body: nil, errorDomain: nil, errorCode: nil).mode, "hosterror")
        }
    }

    private func body(_ text: String) -> Data { Data(text.utf8) }

    private func probe(_ text: String) -> ProbeVerdict {
        ProbeVerdict.classify(status: 200, body: body(text), errorDomain: nil, errorCode: nil)
    }

    func testThisDoorIsFullMode() {
        XCTAssertEqual(ProbeVerdict.classify(status: 200, body: body(#"{"ok":true,"name":"Sean's Mac","mobile":1}"#), errorDomain: nil, errorCode: nil), .full(name: "Sean's Mac"))
        XCTAssertEqual(ProbeVerdict.classify(status: 200, body: body(#"{"ok":true,"mobile":1}"#), errorDomain: nil, errorCode: nil), .full(name: nil))
        let long = String(repeating: "n", count: 300)
        XCTAssertEqual(ProbeVerdict.classify(status: 200, body: body("{\"mobile\":1,\"name\":\"\(long)\"}"), errorDomain: nil, errorCode: nil), .full(name: String(repeating: "n", count: 200)))
    }

    /// A 401 is an older door that does not know /healthz; so is any other non-capability response.
    func testAnyOtherAnswerIsBasicMode() {
        XCTAssertEqual(ProbeVerdict.classify(status: 401, body: body(#"{"error":"sign in"}"#), errorDomain: nil, errorCode: nil), .basic)
        XCTAssertEqual(ProbeVerdict.classify(status: 404, body: nil, errorDomain: nil, errorCode: nil), .basic)
        XCTAssertEqual(ProbeVerdict.classify(status: 200, body: body(#"{"ok":true}"#), errorDomain: nil, errorCode: nil), .basic)
        XCTAssertEqual(ProbeVerdict.classify(status: 200, body: body(#"{"mobile":"1"}"#), errorDomain: nil, errorCode: nil), .basic)
        XCTAssertEqual(ProbeVerdict.classify(status: 200, body: body("<html>"), errorDomain: nil, errorCode: nil), .basic)
    }

    /// Decision 13: Tailscale Serve answers 502 when Murage is not running.
    func testGatewayErrorsMeanMurageIsNotAnswering() {
        for status in [502, 503, 504] {
            XCTAssertEqual(ProbeVerdict.classify(status: status, body: nil, errorDomain: nil, errorCode: nil), .hosterror)
        }
    }

    func testNoAnswerIsUnreachableOrInsecure() {
        XCTAssertEqual(ProbeVerdict.classify(status: nil, body: nil, errorDomain: NSURLErrorDomain, errorCode: NSURLErrorTimedOut), .unreachable)
        XCTAssertEqual(ProbeVerdict.classify(status: nil, body: nil, errorDomain: NSURLErrorDomain, errorCode: NSURLErrorServerCertificateUntrusted), .insecure)
        XCTAssertEqual(ProbeVerdict.classify(status: nil, body: nil, errorDomain: nil, errorCode: nil), .unreachable)
    }

    /// Like the Java twin: only a certificate or handshake failure is
    /// insecure. Any other failure, even one Navigation would ignore, is a
    /// can't-reach for the probe.
    func testOnlyCertificateFailuresAreInsecure() {
        for code in [NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateHasUnknownRoot,
                     NSURLErrorServerCertificateNotYetValid, NSURLErrorClientCertificateRejected, NSURLErrorClientCertificateRequired] {
            XCTAssertEqual(ProbeVerdict.classify(status: nil, body: nil, errorDomain: NSURLErrorDomain, errorCode: code), .insecure, "\(code)")
        }
        for code in [NSURLErrorNetworkConnectionLost, NSURLErrorCancelled, NSURLErrorUnknown, NSURLErrorCannotConnectToHost] {
            XCTAssertEqual(ProbeVerdict.classify(status: nil, body: nil, errorDomain: NSURLErrorDomain, errorCode: code), .unreachable, "\(code)")
        }
        XCTAssertEqual(ProbeVerdict.classify(status: nil, body: nil, errorDomain: "WebKitErrorDomain", errorCode: 102), .unreachable)
        XCTAssertEqual(ProbeVerdict.classify(status: nil, body: nil, errorDomain: NSURLErrorDomain, errorCode: nil), .unreachable)
    }

    /// mobile is a door identity: full mode only when it is exactly the integer 1.
    func testMobileMustBeAnInteger() {
        XCTAssertEqual(probe(#"{"mobile":1.0}"#), .basic)
        XCTAssertEqual(probe(#"{"mobile":1e0}"#), .basic)
        XCTAssertEqual(probe(#"{"mobile":2}"#), .basic)
        XCTAssertEqual(probe(#"{"mobile":1.5}"#), .basic)
        XCTAssertEqual(probe(#"{"mobile":0}"#), .basic)
        XCTAssertEqual(probe(#"{}"#), .basic)
        XCTAssertEqual(probe(#"{"mobile":true}"#), .basic)
        XCTAssertEqual(probe(#"{"mobile":18446744073709551617}"#), .basic)
        XCTAssertEqual(probe(#"{"mobile":1}"#), .full(name: nil))
    }

    func testOnlyAUsefulNameIsKept() {
        XCTAssertEqual(probe(#"{"mobile":1,"name":""}"#), .full(name: nil))
        XCTAssertEqual(probe(#"{"mobile":1,"name":7}"#), .full(name: nil))
        XCTAssertEqual(probe(#"{"mobile":1,"name":null}"#), .full(name: nil))
        XCTAssertEqual(probe("[1]"), .basic)
        XCTAssertEqual(ProbeVerdict.classify(status: 200, body: nil, errorDomain: nil, errorCode: nil), .basic)
    }

    /// 200 code points like Java: never half an emoji, and a combining mark
    /// past the cut is dropped the same way on both twins.
    func testTheNameCutCountsCodePoints() {
        let face = "😀"
        let edge = String(repeating: "n", count: 199) + face
        XCTAssertEqual(probe("{\"mobile\":1,\"name\":\"\(edge)x\"}"), .full(name: edge))
        XCTAssertEqual(probe("{\"mobile\":1,\"name\":\"\(String(repeating: face, count: 300))\"}"), .full(name: String(repeating: face, count: 200)))
        let accent = String(repeating: "n", count: 199) + "e"
        XCTAssertEqual(probe("{\"mobile\":1,\"name\":\"\(accent)\u{301}\"}"), .full(name: accent))
    }

    func testHostCapabilityComesFromMobileFeatures() {
        let ok = probe(#"{"ok":true,"name":"Sean's Mac","mobile":1,"mobileFeatures":1,"approvalProof":1}"#)
        XCTAssertTrue(ok.isFull)
        XCTAssertTrue(ok.hostCapabilityOk)
        XCTAssertEqual(ok.hostCapability, 1)
        XCTAssertTrue(probe(#"{"mobile":1,"mobileFeatures":2}"#).hostCapabilityOk)
        let bare = probe(#"{"mobile":1}"#)
        XCTAssertTrue(bare.isFull)
        XCTAssertFalse(bare.hostCapabilityOk)
        XCTAssertFalse(probe(#"{"mobile":1,"mobileFeatures":0}"#).hostCapabilityOk)
        for text in [#"{"mobile":1,"mobileFeatures":"1"}"#, #"{"mobile":1,"mobileFeatures":1.5}"#, #"{"mobile":1,"mobileFeatures":true}"#, #"{"mobile":1,"mobileFeatures":null}"#] {
            XCTAssertTrue(probe(text).isFull, text)
            XCTAssertNil(probe(text).hostCapability, text)
            XCTAssertFalse(probe(text).hostCapabilityOk, text)
        }
        XCTAssertEqual(probe(#"{"mobile":2,"mobileFeatures":1}"#), .basic)
        XCTAssertFalse(probe(#"{"mobile":2,"mobileFeatures":1}"#).hostCapabilityOk)
        let oldDoor = ProbeVerdict.classify(status: 401, body: body(#"{"mobile":1,"mobileFeatures":1}"#), errorDomain: nil, errorCode: nil)
        XCTAssertEqual(oldDoor, .basic)
        XCTAssertNil(oldDoor.hostCapability)
    }

    func testModes() {
        XCTAssertEqual(ProbeVerdict.full(name: nil).mode, "full")
        XCTAssertEqual(ProbeVerdict.basic.mode, "basic")
        XCTAssertEqual(ProbeVerdict.unreachable.mode, "unreachable")
        XCTAssertEqual(ProbeVerdict.insecure.mode, "insecure")
        XCTAssertTrue(ProbeVerdict.full(name: "x").isFull)
        XCTAssertFalse(ProbeVerdict.basic.isFull)
    }

    func testApprovalProofIsReadOnlyAsAnInteger() {
        let ok = ProbeVerdict.classify(status: 200, body: Data(#"{"ok":true,"mobile":1,"approvalProof":1}"#.utf8), errorDomain: nil, errorCode: nil)
        XCTAssertTrue(ok.approvalProofOk)
        XCTAssertEqual(ok.approvalProof, 1)
        for body in [#"{"mobile":1}"#, #"{"mobile":1,"approvalProof":true}"#, #"{"mobile":1,"approvalProof":1.0}"#, #"{"mobile":1,"approvalProof":"1"}"#, #"{"mobile":1,"approvalProof":0}"#] {
            XCTAssertFalse(ProbeVerdict.classify(status: 200, body: Data(body.utf8), errorDomain: nil, errorCode: nil).approvalProofOk, body)
        }
        XCTAssertFalse(ProbeVerdict.full(name: "x").approvalProofOk)
    }
}
