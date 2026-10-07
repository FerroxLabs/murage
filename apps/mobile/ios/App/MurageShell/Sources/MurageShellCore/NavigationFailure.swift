import Foundation

public enum LoadFailure: Equatable, Sendable {
    case ignore, unreachable, insecure
}

/// What a failed main-document load means for the person (spec §3.2, §7).
/// Only WebKit's own policy errors and a cancelled load are ignored; a
/// certificate failure is insecure; every other failure is a can't-reach.
/// An ignored failure would leave the splash up for good, since nothing
/// restarts the readiness deadline after a failed load (P15).
///
/// NavigationFailure.java follows the same rule (P19): it ignores only a URL
/// the WebView will not show, and any other code is a can't-reach.
public enum NavigationFailure {
    /// A certificate the phone refuses or a failed TLS handshake. The probe
    /// treats only these as insecure, like Java's SSLHandshakeException and
    /// SSLPeerUnverifiedException.
    static let certificateCodes: Set<Int> = [
        NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateUntrusted,
        NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid,
        NSURLErrorClientCertificateRejected, NSURLErrorClientCertificateRequired,
        NSURLErrorAppTransportSecurityRequiresSecureConnection,
    ]

    static func isCertificate(domain: String, code: Int) -> Bool {
        isURLDomain(domain) && certificateCodes.contains(code)
    }

    public static func classify(domain: String, code: Int) -> LoadFailure {
        // WebKit's own domain is policy, not the network: 102 is a navigation
        // that became a download (Phase 0 surprise 3), 101 a URL it will not show.
        if domain == "WebKitErrorDomain" { return .ignore }
        // A superseded load: the next navigation reports for itself.
        if isURLDomain(domain), code == NSURLErrorCancelled { return .ignore }
        if isCertificate(domain: domain, code: code) { return .insecure }
        return .unreachable
    }

    /// CFNetwork reports the NSURLError codes under its own domain too.
    private static func isURLDomain(_ domain: String) -> Bool {
        domain == NSURLErrorDomain || domain == "kCFErrorDomainCFNetwork"
    }
}
