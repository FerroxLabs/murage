import Foundation

/// The shared fixtures in apps/mobile/contract (P4), which the web and Java
/// suites read too.
enum Fixtures {
    static let contract: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() } // …/apps/mobile
        return url.appendingPathComponent("contract")
    }()

    static func json(_ name: String) throws -> Any {
        let data = try Data(contentsOf: contract.appendingPathComponent(name))
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }
}
