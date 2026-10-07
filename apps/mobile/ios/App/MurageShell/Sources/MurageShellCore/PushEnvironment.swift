import Foundation

/// B12 (Fable M3): the APNs environment a phone registers under.
///
/// The relay picks the APNs host (sandbox or production) from this value, so it
/// must match the token's real environment, which is the `aps-environment`
/// entitlement the app was signed with. The build configuration is a separate
/// setting: a Release build signed with a development profile holds a sandbox
/// token and would register as production, and every push would then answer
/// BadDeviceToken. So the entitlement is read from the embedded provisioning
/// profile; only a build without one (the App Store, the simulator) falls back
/// to the compiled default, which is right for those.
public enum PushEnvironment {
    /// `provisioning` is the bytes of `embedded.mobileprovision`: a signed CMS
    /// blob that carries the profile's XML plist in the clear.
    public static func resolve(provisioning: Data?, compiledDefault: String) -> String {
        guard let provisioning, let environment = apsEnvironment(in: provisioning) else { return compiledDefault }
        return environment
    }

    static func apsEnvironment(in blob: Data) -> String? {
        let open = Data("<?xml".utf8), close = Data("</plist>".utf8)
        guard let start = blob.range(of: open), let end = blob.range(of: close, in: start.lowerBound..<blob.endIndex) else { return nil }
        let xml = blob.subdata(in: start.lowerBound..<end.upperBound)
        guard let plist = try? PropertyListSerialization.propertyList(from: xml, options: [], format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              let value = entitlements["aps-environment"] as? String,
              value == "development" || value == "production" else { return nil }
        return value
    }
}

/// The App Attest environment the relay uses to pick the AAGUID. iOS offers no
/// public call to read the app's own entitlement, so the build puts the same
/// build setting that fills the entitlement (APP_ATTEST_ENVIRONMENT) into
/// Info.plist as `AppAttestEnvironment`. That is what App Attest itself
/// follows, unlike the APNs profile, which can differ in a Release build
/// signed with a development profile. A missing or odd value falls back to
/// the APNs-derived one.
public enum AppAttestEnvironment {
    public static func resolve(plistValue: Any?, fallback: String) -> String {
        guard let value = plistValue as? String, value == "development" || value == "production" else { return fallback }
        return value
    }
}
