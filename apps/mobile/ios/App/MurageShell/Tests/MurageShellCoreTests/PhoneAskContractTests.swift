import CryptoKit
import Foundation
import XCTest
@testable import MurageShellCore

final class PhoneAskContractTests: XCTestCase {
    private typealias C = PhoneAskContract
    private func object(_ value: Any?) throws -> [String: Any] { try XCTUnwrap(value as? [String: Any]) }
    private func objects(_ value: Any?) throws -> [[String: Any]] { try XCTUnwrap(value as? [[String: Any]]) }
    private func fixture() throws -> [String: Any] { try object(Fixtures.json("phone-ask.json")) }
    private func data(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) }
    private func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T { try JSONDecoder().decode(type, from: data(value)) }
    private func roundTrip<T: Codable>(_ type: T.Type, _ value: Any) throws {
        let model = try decode(type, value)
        let encoded = try JSONEncoder().encode(model)
        let restored = try JSONSerialization.jsonObject(with: encoded)
        XCTAssertEqual(try object(restored) as NSDictionary, try object(value) as NSDictionary)
    }
    private func expanded(_ vector: [String: Any]) throws -> [String: Any] {
        let body = try object(vector["body"])
        guard let spec = vector["repeat"] as? [String: Any] else { return body }
        let path = try XCTUnwrap(spec["path"] as? String).split(separator: ".").map(String.init)
        let count = try XCTUnwrap(spec["count"] as? Int)
        func replace(_ source: [String: Any], _ path: ArraySlice<String>) throws -> [String: Any] {
            var copy = source
            let key = try XCTUnwrap(path.first)
            if path.count == 1 {
                let values = try XCTUnwrap(copy[key] as? [Any])
                XCTAssertEqual(values.count, 1)
                copy[key] = Array(repeating: try XCTUnwrap(values.first), count: count)
            } else { copy[key] = try replace(object(copy[key]), path.dropFirst()) }
            return copy
        }
        return try replace(body, path[...])
    }
    private func refused<T: Decodable>(_ type: T.Type, _ vectors: Any?) throws {
        for vector in try objects(vectors) {
            XCTAssertThrowsError(try decode(type, expanded(vector)), vector["why"] as? String ?? "invalid vector")
        }
    }
    private func message(_ v: [String: Any]) throws -> String {
        C.phoneAskMessage(origin: try XCTUnwrap(v["origin"] as? String), keyId: try XCTUnwrap(v["keyId"] as? String),
                          nonce: try XCTUnwrap(v["nonce"] as? String), expiresAt: try XCTUnwrap(v["expiresAt"] as? NSNumber).int64Value)
    }
    private func base64url(_ value: Any?) throws -> Data {
        let text = try XCTUnwrap(value as? String).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return try XCTUnwrap(Data(base64Encoded: text + String(repeating: "=", count: (4 - text.count % 4) % 4)))
    }
    private func verifies(_ vector: [String: Any], _ message: String) throws -> Bool {
        let key = try P256.Signing.PublicKey(x963Representation: base64url(vector["point"]))
        let signature = try P256.Signing.ECDSASignature(derRepresentation: base64url(vector["signature"]))
        return key.isValidSignature(signature, for: Data(message.utf8))
    }

    func testMintBytesAndBothCrossPurposeSignatures() throws {
        let mint = try object(fixture()["mint"]), v = try object(mint["vector"])
        let cross = try object(mint["crossPurpose"]), jobs = try object(cross["jobsVector"])
        let bytes = try message(v)
        XCTAssertEqual(Data(bytes.utf8), Data(try XCTUnwrap(v["message"] as? String).utf8))
        XCTAssertEqual(C.tag, mint["tag"] as? String)
        XCTAssertEqual(C.ttlMs, mint["ttlMs"] as? Int)
        XCTAssertFalse(bytes.hasSuffix("\n"))
        XCTAssertEqual(PhoneJobsContract.approvalKeyId(point: try XCTUnwrap(v["point"] as? String)), v["keyId"] as? String)
        XCTAssertTrue(try verifies(v, bytes))
        XCTAssertFalse(try verifies(v, bytes + "0"))
        let asJobs = try XCTUnwrap(object(cross["askVectorAsJobs"])["message"] as? String)
        XCTAssertEqual(asJobs, PhoneJobsContract.phoneJobsMessage(origin: try XCTUnwrap(v["origin"] as? String), keyId: try XCTUnwrap(v["keyId"] as? String), nonce: try XCTUnwrap(v["nonce"] as? String), expiresAt: try XCTUnwrap(v["expiresAt"] as? NSNumber).int64Value))
        XCTAssertFalse(try verifies(v, asJobs))
        XCTAssertTrue(try verifies(jobs, XCTUnwrap(jobs["message"] as? String)))
        XCTAssertFalse(try verifies(jobs, message(jobs)))
        XCTAssertEqual(jobs as NSDictionary, try object(object(Fixtures.json("phone-jobs.json"))["mint"])["vector"] as? NSDictionary)
    }

    func testEveryRequestAndTargetVector() throws {
        let f = try fixture(), share = try object(f["share"]), manifest = try object(share["manifest"])
        try roundTrip(C.ShareManifest.self, XCTUnwrap(manifest["valid"]))
        for body in try objects(manifest["alsoValid"]) { try roundTrip(C.ShareManifest.self, body) }
        try refused(C.ShareManifest.self, share["invalid"])
        let ask = try object(f["ask"])
        try roundTrip(C.AskRequest.self, XCTUnwrap(ask["request"]))
        try refused(C.AskRequest.self, ask["invalid"])
        let token = try object(f["tokenRequest"])
        try roundTrip(C.TokenRequest.self, XCTUnwrap(token["valid"]))
        for body in try objects(token["alsoValid"]) { try roundTrip(C.TokenRequest.self, body) }
        try refused(C.TokenRequest.self, token["invalid"])
        let targets = try object(f["targets"])
        try roundTrip(C.TargetsAnswer.self, XCTUnwrap(targets["answer"]))
        try refused(C.TargetsAnswer.self, targets["invalid"])
        XCTAssertEqual(C.targetsRecentMax, targets["recentMax"] as? Int)
        let shape = try object(f["token"])
        for value in try XCTUnwrap(shape["valid"] as? [String]) { XCTAssertTrue(C.tokenValid(value)) }
        for value in try XCTUnwrap(shape["invalid"] as? [String]) { XCTAssertFalse(C.tokenValid(value)) }
    }

    func testEveryAnswerAndStrictUnionKeys() throws {
        let f = try fixture(), answers = try object(object(f["share"])["answers"]), ask = try object(f["ask"])
        for row in try objects(answers["ok"]) + objects(answers["errors"]) {
            if let body = row["body"] { try roundTrip(C.ShareAnswer.self, body) }
        }
        try roundTrip(C.AskAnswer.self, XCTUnwrap(ask["answer"]))
        for row in try objects(ask["errors"]) { if let body = row["body"] { try roundTrip(C.AskAnswer.self, body) } }
        let shareOK = try object(objects(answers["ok"])[0]["body"])
        for key in ["via", "origin", "answer", "text", "ownerActs"] {
            var shareBody = shareOK, askBody = try object(ask["answer"])
            shareBody[key] = "x"; askBody[key] = "x"
            XCTAssertThrowsError(try decode(C.ShareAnswer.self, shareBody))
            XCTAssertThrowsError(try decode(C.AskAnswer.self, askBody))
        }
        var mixed = shareOK; mixed["error"] = "x"; mixed["code"] = "invalid"
        XCTAssertThrowsError(try decode(C.ShareAnswer.self, mixed))
        XCTAssertThrowsError(try decode(C.AskAnswer.self, ["error": "x", "code": "too_large"]))
        var body = try object(ask["answer"]); body["notify"] = 1
        XCTAssertThrowsError(try decode(C.AskAnswer.self, body))
        body["notify"] = false; try roundTrip(C.AskAnswer.self, body)
    }

    func testLimitsTypesAndUTF16Validation() throws {
        let f = try fixture(), limits = try object(f["limits"]), types = try object(Fixtures.json("share-types.json"))
        let native = ["maxItems": C.ShareLimits.maxItems, "maxShareBytes": C.ShareLimits.maxShareBytes,
                      "doorMaxBytes": C.ShareLimits.doorMaxBytes, "imageMaxBytes": C.ShareLimits.imageMaxBytes,
                      "fileMaxBytes": C.ShareLimits.fileMaxBytes, "noteMaxChars": C.ShareLimits.noteMaxChars]
        XCTAssertEqual(native as NSDictionary, limits as NSDictionary)
        XCTAssertEqual(C.imageMimes, types["images"] as? [String])
        XCTAssertEqual(C.fileMimes, try objects(types["files"]).map { try XCTUnwrap($0["mime"] as? String) })
        XCTAssertEqual(C.imageMimes + C.fileMimes, types["androidFilter"] as? [String])
        var body = try object(object(object(f["share"])["manifest"])["valid"])
        for key in ["note", "text", "url"] {
            var invalid = body; invalid[key] = NSNull()
            XCTAssertThrowsError(try decode(C.ShareManifest.self, invalid))
        }
        body["note"] = String(repeating: "😀", count: 1000)
        _ = try decode(C.ShareManifest.self, body)
        body["note"] = String(repeating: "😀", count: 1001)
        XCTAssertThrowsError(try decode(C.ShareManifest.self, body))
        body.removeValue(forKey: "note")
        var item = try objects(body["items"])[0]
        for mime in C.imageMimes + C.fileMimes {
            item["mime"] = mime; body["items"] = [item]; _ = try decode(C.ShareManifest.self, body)
        }
        let invalidBytes: [Any] = [-1, 1.5, true, "6", 9_007_199_254_740_992 as Int64, NSNull()]
        for bytes in invalidBytes {
            item["bytes"] = bytes; body["items"] = [item]
            XCTAssertThrowsError(try decode(C.ShareManifest.self, body))
        }
        var request = try object(object(f["ask"])["request"])
        request["text"] = String(repeating: "a", count: 1_048_577)
        XCTAssertThrowsError(try decode(C.AskRequest.self, request))
        request["text"] = 123
        XCTAssertThrowsError(try decode(C.AskRequest.self, request))
    }

    func testMultipartWriterMatchesFixtureBytesAndRejectsChangedInputs() throws {
        let share = try object(fixture()["share"]), mp = try object(share["multipart"])
        let manifest = try decode(C.ShareManifest.self, XCTUnwrap(object(share["manifest"])["valid"]))
        let boundary = try XCTUnwrap(mp["boundary"] as? String), items = try objects(mp["items"])
        XCTAssertEqual(try ShareMultipartWriter.contentType(boundary: boundary), mp["contentType"] as? String)
        let output = OutputStream.toMemory(); output.open(); defer { output.close() }
        try ShareMultipartWriter.write(manifest: manifest, boundary: boundary, to: output) { item in
            InputStream(data: Data(try XCTUnwrap(items[item.n - 1]["text"] as? String).utf8))
        }
        XCTAssertEqual(output.property(forKey: .dataWrittenToMemoryStreamKey) as? Data, Data(try XCTUnwrap(mp["body"] as? String).utf8))
        for altered in ["", "HELLO\n", "hello\nextra"] {
            let partial = OutputStream.toMemory(); partial.open(); defer { partial.close() }
            XCTAssertThrowsError(try ShareMultipartWriter.write(manifest: manifest, boundary: boundary, to: partial) { _ in InputStream(data: Data(altered.utf8)) })
        }
        XCTAssertThrowsError(try ShareMultipartWriter.contentType(boundary: "x\r\ny"))
        var raw = try object(object(share["manifest"])["valid"])
        let first = try objects(raw["items"])[0]
        var second = first; second["n"] = 2
        for index in 0...1 {
            for filename in ["a\r\nb", "a\"b", "../a", "a\\b", ".", "..", "a\u{0}b", "a\u{1f}b", "a\u{7f}b", "a\u{9f}b"] {
                var rawItems = [first, second]
                rawItems[index]["name"] = filename; raw["items"] = rawItems
                let bad = try decode(C.ShareManifest.self, raw)
                let untouched = OutputStream.toMemory(); untouched.open(); defer { untouched.close() }
                var opened = 0
                XCTAssertThrowsError(try ShareMultipartWriter.write(manifest: bad, boundary: boundary, to: untouched) { _ in
                    opened += 1
                    return InputStream(data: Data(try XCTUnwrap(items[0]["text"] as? String).utf8))
                })
                XCTAssertEqual(opened, 0, "header must be refused before opening any input")
                XCTAssertEqual(untouched.property(forKey: .dataWrittenToMemoryStreamKey) as? Data, Data(),
                               "header must be refused before writing any byte")
            }
        }
    }
}
