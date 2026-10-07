import XCTest
@testable import MurageShellCore

/// B12 (Fable M3): the APNs environment the phone registers under comes from
/// the entitlement it was signed with, not from the build configuration.
final class PushEnvironmentTests: XCTestCase {
    /// What an embedded.mobileprovision looks like: a signed CMS blob with the
    /// profile's XML plist in the middle of binary bytes.
    private func profile(apsEnvironment: String?) -> Data {
        let entitlements = apsEnvironment.map { "<key>Entitlements</key><dict><key>aps-environment</key><string>\($0)</string></dict>" }
            ?? "<key>Entitlements</key><dict></dict>"
        let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Name</key><string>x</string>\(entitlements)</dict></plist>"
        return Data([0x30, 0x82, 0x01, 0xff, 0x06, 0x09]) + Data(xml.utf8) + Data([0x00, 0x9a, 0x13])
    }

    func testTheEntitlementWinsOverTheBuildConfiguration() {
        // A Release build (compiled default production) signed with a development profile.
        XCTAssertEqual(PushEnvironment.resolve(provisioning: profile(apsEnvironment: "development"), compiledDefault: "production"), "development")
        XCTAssertEqual(PushEnvironment.resolve(provisioning: profile(apsEnvironment: "production"), compiledDefault: "development"), "production")
    }

    func testNoProfileFallsBackToTheCompiledDefault() {
        XCTAssertEqual(PushEnvironment.resolve(provisioning: nil, compiledDefault: "production"), "production")
        XCTAssertEqual(PushEnvironment.resolve(provisioning: nil, compiledDefault: "development"), "development")
    }

    func testAnUnreadableOrUnknownProfileFallsBackToo() {
        XCTAssertEqual(PushEnvironment.resolve(provisioning: Data([1, 2, 3]), compiledDefault: "production"), "production")
        XCTAssertEqual(PushEnvironment.resolve(provisioning: profile(apsEnvironment: nil), compiledDefault: "development"), "development")
        XCTAssertEqual(PushEnvironment.resolve(provisioning: profile(apsEnvironment: "staging"), compiledDefault: "production"), "production")
    }
}

final class AppAttestEnvironmentTests: XCTestCase {
    func testTheBuildSettingWinsOverTheFallback() {
        XCTAssertEqual(AppAttestEnvironment.resolve(plistValue: "production", fallback: "development"), "production")
        XCTAssertEqual(AppAttestEnvironment.resolve(plistValue: "development", fallback: "production"), "development")
    }

    func testAMissingOrOddValueFallsBack() {
        for bad: Any? in [nil, "", "$(APP_ATTEST_ENVIRONMENT)", "Production", 1] {
            XCTAssertEqual(AppAttestEnvironment.resolve(plistValue: bad, fallback: "production"), "production")
        }
    }
}
