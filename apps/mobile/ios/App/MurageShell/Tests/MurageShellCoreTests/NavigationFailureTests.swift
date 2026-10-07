import XCTest
@testable import MurageShellCore

final class NavigationFailureTests: XCTestCase {
    /// Phase 0 surprise 3: a navigation that turns into a download fails
    /// with WebKitErrorDomain 102. It is not the network.
    func testFrameLoadInterruptedIsNotAFailure() {
        XCTAssertEqual(NavigationFailure.classify(domain: "WebKitErrorDomain", code: 102), .ignore)
        XCTAssertEqual(NavigationFailure.classify(domain: "WebKitErrorDomain", code: 101), .ignore)
    }

    func testCancelledIsNotAFailure() {
        XCTAssertEqual(NavigationFailure.classify(domain: NSURLErrorDomain, code: NSURLErrorCancelled), .ignore)
    }

    func testNetworkErrorsAreUnreachable() {
        for code in [NSURLErrorTimedOut, NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost,
                     NSURLErrorNetworkConnectionLost, NSURLErrorNotConnectedToInternet, NSURLErrorDNSLookupFailed] {
            XCTAssertEqual(NavigationFailure.classify(domain: NSURLErrorDomain, code: code), .unreachable, "\(code)")
            XCTAssertEqual(NavigationFailure.classify(domain: "kCFErrorDomainCFNetwork", code: code), .unreachable, "\(code)")
        }
        XCTAssertEqual(NavigationFailure.classify(domain: "kCFErrorDomainCFNetwork", code: 2), .unreachable)
        XCTAssertEqual(NavigationFailure.classify(domain: NSPOSIXErrorDomain, code: Int(ECONNREFUSED)), .unreachable)
    }

    func testCertificateErrorsAreInsecure() {
        for code in [NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasUnknownRoot,
                     NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateNotYetValid, NSURLErrorAppTransportSecurityRequiresSecureConnection] {
            XCTAssertEqual(NavigationFailure.classify(domain: NSURLErrorDomain, code: code), .insecure, "\(code)")
        }
    }

    /// P10 fix ruling: only WebKit policy errors and a cancelled load are
    /// ignored. Any other failure, however unusual, is a can't-reach, never a
    /// splash left up for good.
    func testEverythingElseIsUnreachable() {
        for code in [NSURLErrorBadServerResponse, NSURLErrorCannotParseResponse, NSURLErrorZeroByteResource,
                     NSURLErrorHTTPTooManyRedirects, NSURLErrorUnknown, NSURLErrorUnsupportedURL] {
            XCTAssertEqual(NavigationFailure.classify(domain: NSURLErrorDomain, code: code), .unreachable, "\(code)")
        }
        XCTAssertEqual([-1011, -1017, -1014, -1007, -1].map { NavigationFailure.classify(domain: NSURLErrorDomain, code: $0) },
                       Array(repeating: LoadFailure.unreachable, count: 5))
        XCTAssertEqual(NavigationFailure.classify(domain: "SomeOtherDomain", code: 7), .unreachable)
        XCTAssertEqual(NavigationFailure.classify(domain: NSPOSIXErrorDomain, code: Int(EPIPE)), .unreachable)
        XCTAssertEqual(NavigationFailure.classify(domain: "kCFErrorDomainCFNetwork", code: NSURLErrorCancelled), .ignore)
        XCTAssertEqual(NavigationFailure.classify(domain: "WebKitErrorDomain", code: NSURLErrorTimedOut), .ignore)
    }
}
