import Foundation

/// The launcher's `GET /healthz` (spec §3.1; Plan 1 B1). Twin of ProbeVerdict.java.
public struct ProbeVerdict: Equatable, Sendable {
    public enum Kind: String, Sendable { case full, basic, unreachable, insecure, accessoff, hosterror }
    public let kind: Kind
    public let name: String?
    public let hostCapability: Int64?
    public let approvalProof: Int64?

    public init(kind: Kind, name: String?, hostCapability: Int64?, approvalProof: Int64? = nil) {
        self.kind = kind
        self.name = name
        self.hostCapability = hostCapability
        self.approvalProof = approvalProof
    }

    public static func full(name: String?, hostCapability: Int64? = nil, approvalProof: Int64? = nil) -> ProbeVerdict {
        ProbeVerdict(kind: .full, name: name, hostCapability: hostCapability, approvalProof: approvalProof)
    }
    public static let basic = ProbeVerdict(kind: .basic, name: nil, hostCapability: nil)
    public static let unreachable = ProbeVerdict(kind: .unreachable, name: nil, hostCapability: nil)
    public static let insecure = ProbeVerdict(kind: .insecure, name: nil, hostCapability: nil)

    public static let accessoff = ProbeVerdict(kind: .accessoff, name: nil, hostCapability: nil)
    public static let hosterror = ProbeVerdict(kind: .hosterror, name: nil, hostCapability: nil)

    public var hostCapabilityOk: Bool { (hostCapability ?? 0) >= 1 }

    /// The computer's `/healthz` says it keeps a phone's approval key (SEC-006).
    public var approvalProofOk: Bool { (approvalProof ?? 0) >= 1 }

    public static func classify(status: Int?, body: Data?, errorDomain: String?, errorCode: Int?) -> ProbeVerdict {
        if let status {
            // A 401 on /healthz is an older desktop door that does not know the path
            // (companion/src/browser.ts), so it falls through to basic and the update screen.
            // .accessoff stays defined for a future explicit access-off answer.
            // Decision 13: Tailscale Serve answering for a Murage that is not running.
            if [502, 503, 504].contains(status) { return .hosterror }
            guard status == 200, let body,
                  let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return .basic }
            // `mobile` is a door identity, exactly 1; the phone features come from `mobileFeatures`.
            guard JSONInteger.value(json["mobile"]) == 1 else { return .basic }
            let hostCapability = JSONInteger.value(json["mobileFeatures"])
            return .full(name: (json["name"] as? String).flatMap(WorkspaceBook.cleanName), hostCapability: hostCapability, approvalProof: JSONInteger.value(json["approvalProof"]))
        }
        // A certificate the phone refuses. Any other failure, TLS or not, is a can't-reach.
        if let errorDomain, let errorCode, NavigationFailure.isCertificate(domain: errorDomain, code: errorCode) {
            return .insecure
        }
        return .unreachable
    }

    public var mode: String { kind.rawValue }

    public var isFull: Bool { kind == .full }
}

/// A JSON integer as JSONSerialization hands it over, read the way Java
/// reads an Integer or Long: a boolean, a fraction or exponent (even 1.0),
/// and anything past Int64 are not integers.
enum JSONInteger {
    static func value(_ raw: Any?) -> Int64? {
        guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              !CFNumberIsFloatType(number), String(cString: number.objCType) != "Q" else { return nil }
        return number.int64Value
    }
}
