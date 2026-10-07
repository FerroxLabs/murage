import CryptoKit
import XCTest
@testable import MurageShellCore

final class ApprovalProofTests: XCTestCase {
    private func contract() throws -> [String: Any] { try XCTUnwrap(Fixtures.json("approval-proof.json") as? [String: Any]) }

    func testAcceptedArgsBuildTheExactMessage() throws {
        let accepted = try XCTUnwrap(contract()["accepted"] as? [[String: Any]])
        XCTAssertEqual(accepted.count, 3)
        let names = accepted.compactMap { $0["name"] as? String }
        XCTAssertTrue(names[0].contains("low-S"), names[0])
        XCTAssertTrue(names[1].contains("random nonce"), names[1])
        XCTAssertTrue(names[2].contains("high-S"), names[2])
        for entry in accepted {
            let request = try XCTUnwrap(ApprovalRequest.parse(try XCTUnwrap(entry["args"] as? [String: Any])), "\(entry)")
            XCTAssertEqual(String(data: request.message, encoding: .utf8), entry["message"] as? String)
        }
    }

    func testRefusedArgs() throws {
        for entry in try XCTUnwrap(contract()["refused"] as? [[String: Any]]) {
            XCTAssertNil(ApprovalRequest.parse(try XCTUnwrap(entry["args"] as? [String: Any])), "\(entry["why"] ?? "")")
        }
    }

    func testReasonRefusesFormatCharacters() throws {
        var hidden = ["\u{202A}", "\u{202B}", "\u{202C}", "\u{202D}", "\u{202E}", "\u{2066}", "\u{2067}", "\u{2068}", "\u{2069}", "\u{200B}", "\u{200C}", "\u{200D}", "\u{200E}", "\u{200F}", "\u{FEFF}", "\u{061C}", "\u{E0001}"]
        hidden.append("\u{AD}")
        var base = try XCTUnwrap(try XCTUnwrap(contract()["accepted"] as? [[String: Any]])[0]["args"] as? [String: Any])
        for scalar in hidden {
            base["reason"] = "Allow \(scalar)Lena"
            XCTAssertNil(ApprovalRequest.parse(base), "\(scalar.unicodeScalars.map { $0.value })")
        }
        base["reason"] = "Allow Lena \u{E9} \u{1F600}"
        XCTAssertNotNil(ApprovalRequest.parse(base))
    }

    func testCommittedSignatureVerifiesWithCryptoKit() throws {
        let signature = try XCTUnwrap(contract()["signature"] as? [String: String])
        let point = try XCTUnwrap(ApprovalProof.data(base64url: try XCTUnwrap(signature["publicKey"])))
        XCTAssertTrue(ApprovalProof.validPoint(point))
        let key = try P256.Signing.PublicKey(x963Representation: point)
        let der = try XCTUnwrap(ApprovalProof.data(base64url: try XCTUnwrap(signature["signatureDer"])))
        XCTAssertTrue(key.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: der), for: Data(try XCTUnwrap(signature["message"]).utf8)))
    }

    func testBase64urlRoundTripHasNoPadding() {
        let data = Data((0..<65).map { UInt8($0) })
        let text = ApprovalProof.base64url(data)
        XCTAssertEqual(text.count, 87)
        XCTAssertFalse(text.contains("="))
        XCTAssertEqual(ApprovalProof.data(base64url: text), data)
    }

    func testEveryAcceptedSignatureVerifiesIncludingHighS() throws {
        for entry in try XCTUnwrap(contract()["accepted"] as? [[String: Any]]) {
            let point = try XCTUnwrap(ApprovalProof.data(base64url: try XCTUnwrap(entry["publicKey"] as? String)))
            let key = try P256.Signing.PublicKey(x963Representation: point)
            let der = try XCTUnwrap(ApprovalProof.data(base64url: try XCTUnwrap(entry["signatureDer"] as? String)))
            let signature = try P256.Signing.ECDSASignature(derRepresentation: der)
            XCTAssertTrue(key.isValidSignature(signature, for: Data(try XCTUnwrap(entry["message"] as? String).utf8)), "\(entry["name"] ?? "")")
        }
    }

    func testSignatureCases() throws {
        for entry in try XCTUnwrap(contract()["signatureCases"] as? [[String: Any]]) {
            let name = try XCTUnwrap(entry["name"] as? String)
            let expected = try XCTUnwrap((entry["expect"] as? [String: Any])?["verify"] as? Bool)
            let point = try XCTUnwrap(ApprovalProof.data(base64url: try XCTUnwrap(entry["publicKey"] as? String)))
            let key = try P256.Signing.PublicKey(x963Representation: point)
            let der = try XCTUnwrap(ApprovalProof.data(base64url: try XCTUnwrap(entry["signatureDer"] as? String)))
            var verified = false
            if let signature = try? P256.Signing.ECDSASignature(derRepresentation: der) {
                verified = key.isValidSignature(signature, for: Data(try XCTUnwrap(entry["message"] as? String).utf8))
            }
            XCTAssertEqual(verified, expected, name)
            if name == "malformed DER" || name.hasPrefix("raw r||s") {
                XCTAssertNil(try? P256.Signing.ECDSASignature(derRepresentation: der), name)
            }
        }
    }

    private func args(requestId: String) throws -> [String: Any] {
        var args = try XCTUnwrap(try XCTUnwrap(contract()["accepted"] as? [[String: Any]])[0]["args"] as? [String: Any])
        args["requestId"] = requestId
        return args
    }

    func testRequestIdFollowsTheContract() throws {
        for id in ["req.1:x", String(repeating: "a", count: 256), "id with spaces \u{e9}"] {
            XCTAssertNotNil(ApprovalRequest.parse(try args(requestId: id)), id)
        }
        for id in ["", String(repeating: "a", count: 257), "a\u{0}b", "a\nb", "a\u{7f}b", "a\u{85}b", "a\u{9f}b", "a\u{2028}b", "a\u{2029}b"] {
            XCTAssertNil(ApprovalRequest.parse(try args(requestId: id)), "\(id.unicodeScalars.map { $0.value })")
        }
    }

    func testRequestIdLengthCountsUTF16Units() throws {
        let astral = String(repeating: "\u{1F600}", count: 128) // 128 characters, 256 UTF-16 units
        XCTAssertEqual(astral.utf16.count, 256)
        XCTAssertNotNil(ApprovalRequest.parse(try args(requestId: astral)))
        XCTAssertNil(ApprovalRequest.parse(try args(requestId: astral + "a")))
        XCTAssertNil(ApprovalRequest.parse(try args(requestId: String(repeating: "\u{1F600}", count: 129))))
    }

    /// The real path: args serialized to JSON text and parsed back, as the bridge hands them over.
    private func viaJSON(_ args: [String: Any]) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: args)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testTrailingLineTerminatorsAreRefusedOnTheJSONPath() throws {
        let terminators = ["\n", "\r", "\r\n", "\u{0B}", "\u{0C}", "\u{85}", "\u{2028}", "\u{2029}"]
        let base = try args(requestId: "req-1")
        XCTAssertNotNil(ApprovalRequest.parse(try viaJSON(base)))
        for field in ["threadId", "digest", "nonce"] {
            for terminator in terminators {
                var mutated = base
                mutated[field] = (base[field] as! String) + terminator
                XCTAssertNil(ApprovalRequest.parse(try viaJSON(mutated)), "\(field) + \(terminator.unicodeScalars.map { $0.value })")
                var leading = base
                leading[field] = terminator + (base[field] as! String)
                XCTAssertNil(ApprovalRequest.parse(try viaJSON(leading)), "\(terminator.unicodeScalars.map { $0.value }) + \(field)")
            }
        }
    }

    /// WKScriptMessage turns every JavaScript number into a double NSNumber. The
    /// first review found every real approval refused as bad_args.
    private func wkStyle(_ args: [String: Any]) -> [String: Any] {
        var out = args
        for key in ["v", "expiresAt"] {
            if let n = args[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() { out[key] = NSNumber(value: n.doubleValue) }
        }
        return out
    }

    func testWebKitDoubleNumbersAreAccepted() throws {
        for entry in try XCTUnwrap(contract()["accepted"] as? [[String: Any]]) {
            let raw = try XCTUnwrap(entry["args"] as? [String: Any])
            let wk = wkStyle(raw)
            XCTAssertTrue(CFNumberIsFloatType(try XCTUnwrap(wk["v"] as? NSNumber)))
            XCTAssertTrue(CFNumberIsFloatType(try XCTUnwrap(wk["expiresAt"] as? NSNumber)))
            let request = try XCTUnwrap(ApprovalRequest.parse(wk), "\(entry["name"] ?? "")")
            XCTAssertEqual(String(data: request.message, encoding: .utf8), entry["message"] as? String)
            // The real path: JSON text through JSONSerialization, as the channel decodes it.
            let data = try JSONSerialization.data(withJSONObject: raw)
            let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let again = try XCTUnwrap(ApprovalRequest.parse(decoded), "\(entry["name"] ?? "")")
            XCTAssertEqual(String(data: again.message, encoding: .utf8), entry["message"] as? String)
        }
        var direct = try args(requestId: "req-1")
        direct["v"] = NSNumber(value: 1.0)
        direct["expiresAt"] = NSNumber(value: 1760000000000.0)
        XCTAssertEqual(ApprovalRequest.parse(direct)?.expiresAt, 1_760_000_000_000)
    }

    func testWebKitRefusalsHold() throws {
        let base = try args(requestId: "req-1")
        let bad: [Any] = [NSNumber(value: 1.5), NSNumber(value: 1760000000000.5), kCFBooleanTrue as Any, kCFBooleanFalse as Any, NSNumber(value: Double.nan), NSNumber(value: Double.infinity), NSNumber(value: 9_007_199_254_740_992.0), NSNumber(value: 0.0), NSNumber(value: -5.0), "1760000000000", NSNull()]
        for value in bad {
            var mutated = base
            mutated["expiresAt"] = value
            XCTAssertNil(ApprovalRequest.parse(mutated), "expiresAt \(value)")
        }
        for value in [NSNumber(value: 1.5), NSNumber(value: 2.0), NSNumber(value: 0.0), kCFBooleanTrue as Any, "1"] as [Any] {
            var mutated = base
            mutated["v"] = value
            XCTAssertNil(ApprovalRequest.parse(mutated), "v \(value)")
        }
    }

    func testExpiresAtMustBeAnInteger() throws {
        let base = try args(requestId: "req-1")
        for bad: Any in [1700000060000.5, 1.5, true, false, "1700000060000", 0, -1, NSNull()] {
            var mutated = base
            mutated["expiresAt"] = bad
            XCTAssertNil(ApprovalRequest.parse(try viaJSON(mutated)), "\(bad)")
        }
        var big = base
        big["expiresAt"] = Int64.max
        XCTAssertNotNil(ApprovalRequest.parse(try viaJSON(big)))
    }

    func testSignatureCasesCount() throws {
        let cases = try XCTUnwrap(contract()["signatureCases"] as? [[String: Any]])
        XCTAssertEqual(cases.count, 6)
        let names = cases.compactMap { $0["name"] as? String }
        XCTAssertTrue(names.contains("malformed DER"))
        XCTAssertTrue(names.contains { $0.hasPrefix("raw r||s") })
    }

    func testBase64urlIsStrict() {
        XCTAssertNil(ApprovalProof.data(base64url: "AQI="))
        XCTAssertNil(ApprovalProof.data(base64url: "+/+/"))
        XCTAssertNil(ApprovalProof.data(base64url: "AQ"+"\n"))
        XCTAssertNil(ApprovalProof.data(base64url: "A"))
        XCTAssertNil(ApprovalProof.data(base64url: "AR")) // non-canonical trailing bits
        XCTAssertEqual(ApprovalProof.data(base64url: "AQI"), Data([1, 2]))
        XCTAssertEqual(ApprovalProof.data(base64url: "-_8"), Data([0xfb, 0xff]))
        XCTAssertEqual(ApprovalProof.data(base64url: ""), Data())
    }
}
