import Foundation
import XCTest
@testable import MurageShell

final class PhoneToolsLocalizationTests: XCTestCase {
    // The design says 13 but supplies no list. These are the eight distinct
    // languages in src/locales/index.ts (pt is an alias of pt-BR).
    private let locales = ["en", "de", "es", "fr", "hi", "ja", "pt-BR", "zh"]
    private var app: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("App")
    }

    private func strings(_ url: URL) throws -> [String: String] {
        try XCTUnwrap(PropertyListSerialization.propertyList(
            from: Data(contentsOf: url), format: nil) as? [String: String])
    }

    private func placeholders(_ value: String) throws -> [String] {
        let expression = try NSRegularExpression(pattern: #"%(?:[1-9][0-9]*\$)?[@a-zA-Z]|%%"#)
        let text = value as NSString
        return expression.matches(in: value, range: NSRange(location: 0, length: text.length))
            .map { text.substring(with: $0.range) }.sorted()
    }

    private func bundledStrings(_ locale: String) throws -> [String: String] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "Localizable", withExtension: "strings",
                                                 subdirectory: nil, localization: locale))
        // A bundle lookup may silently fall back to English. Require the real catalog.
        XCTAssertEqual(url.deletingLastPathComponent().lastPathComponent.lowercased(),
                       locale.lowercased() + ".lproj")
        return try strings(url)
    }

    func testEveryPhoneKeyAndPlaceholderIsPresentInEveryBundledLocale() throws {
        XCTAssertEqual(Set(Bundle.module.localizations.filter { $0 != "Base" }.map { $0.lowercased() }),
                       Set(locales.map { $0.lowercased() }))
        let english = try bundledStrings("en").filter { $0.key.hasPrefix("phone_") }
        XCTAssertGreaterThanOrEqual(english.count, 44)
        for locale in locales {
            let translated = try bundledStrings(locale).filter { $0.key.hasPrefix("phone_") }
            XCTAssertEqual(Set(translated.keys), Set(english.keys), locale)
            for (key, value) in english {
                let actual = try XCTUnwrap(translated[key], "\(locale): \(key)")
                XCTAssertFalse(actual.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, key)
                XCTAssertEqual(try placeholders(actual), try placeholders(value), "\(locale): \(key)")
                XCTAssertFalse(actual.contains("\u{2014}"), "\(locale): \(key)")
            }
            let used = try XCTUnwrap(translated["phone_job_used"])
            let rendered = String(format: used, "BOT_MARKER", "CAPABILITY_MARKER")
            XCTAssertTrue(rendered.contains("BOT_MARKER"), locale)
            XCTAssertTrue(rendered.contains("CAPABILITY_MARKER"), locale)
        }
    }

    func testEveryUsagePurposeIsLocalizedAndEnglishMatchesTheAppPlist() throws {
        let english = try strings(app.appendingPathComponent("en.lproj/InfoPlist.strings"))
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(
            from: Data(contentsOf: app.appendingPathComponent("Info.plist")), format: nil) as? [String: Any])
        XCTAssertEqual(english.count, 7)
        for (key, value) in english {
            let original = key == "PhonePreciseLocation"
                ? (plist["NSLocationTemporaryUsageDescriptionDictionary"] as? [String: String])?[key]
                : plist[key] as? String
            XCTAssertEqual(original, value, key)
        }
        for locale in locales {
            let translated = try strings(app.appendingPathComponent("\(locale).lproj/InfoPlist.strings"))
            XCTAssertEqual(Set(translated.keys), Set(english.keys), locale)
            for (key, value) in english {
                let actual = try XCTUnwrap(translated[key], "\(locale): \(key)")
                XCTAssertFalse(actual.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, key)
                XCTAssertEqual(try placeholders(actual), try placeholders(value), "\(locale): \(key)")
                XCTAssertFalse(actual.contains("\u{2014}"), "\(locale): \(key)")
            }
        }
    }

    func testPhoneDataIsLinkedForFunctionalityWithoutTracking() throws {
        let manifest = try XCTUnwrap(PropertyListSerialization.propertyList(
            from: Data(contentsOf: app.appendingPathComponent("PrivacyInfo.xcprivacy")), format: nil) as? [String: Any])
        XCTAssertEqual(manifest["NSPrivacyTracking"] as? Bool, false)
        let entries = try XCTUnwrap(manifest["NSPrivacyCollectedDataTypes"] as? [[String: Any]])
        // Calendar and Reminders belong to Other User Content in the privacy taxonomy.
        for category in ["OtherUserContent", "Contacts", "CoarseLocation", "PreciseLocation"] {
            let matches = entries.filter { $0["NSPrivacyCollectedDataType"] as? String == "NSPrivacyCollectedDataType" + category }
            XCTAssertEqual(matches.count, 1, category)
            let entry = try XCTUnwrap(matches.first)
            XCTAssertEqual(entry["NSPrivacyCollectedDataTypeLinked"] as? Bool, true)
            XCTAssertEqual(entry["NSPrivacyCollectedDataTypeTracking"] as? Bool, false)
            XCTAssertEqual(entry["NSPrivacyCollectedDataTypePurposes"] as? [String],
                           ["NSPrivacyCollectedDataTypePurposeAppFunctionality"])
        }
    }
}
