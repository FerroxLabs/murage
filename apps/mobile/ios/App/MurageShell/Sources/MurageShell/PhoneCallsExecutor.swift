import Foundation
import MurageShellCore
@MainActor protocol PhoneDialer {
    var available: Bool { get }
    func open(number: String, cancellation: PhoneJobCancellation) async throws
}
@MainActor final class PhoneCallsExecutor: PhoneCapabilityExecutor {
    let os: PhoneDialer
    init(os: PhoneDialer) { self.os = os }
    func execute(operationId: String, args: PhoneJobsContract.Args, preciseConsent: Bool, cancellation: PhoneJobCancellation) async throws -> [String: Any] {
        try cancellation.check()
        guard case .callsDial(let a) = args else { throw PhoneExecutorFailure.unsupported }
        try PhoneDialNumber.check(a.number)
        guard os.available else { throw PhoneExecutorFailure.unsupported }
        try cancellation.check()
        try await os.open(number: a.number, cancellation: cancellation)
        return ["outcome": "dialer_opened"]
    }
}
enum PhoneDialNumber {
    static func check(_ number: String) throws {
        guard PhoneJobsContract.isDialNumber(number) else {
            throw PhoneExecutorFailure.denied
        }
    }
}

@MainActor protocol URLOpener {
    var foreground: Bool { get }
    func canOpenURL(_ url: URL) -> Bool
    func open(_ url: URL, cancellation: PhoneJobCancellation) async throws -> Bool
}

@MainActor final class SystemPhoneDialer: PhoneDialer {
    private let opener: URLOpener
    init(opener: URLOpener) { self.opener = opener }
    var available: Bool { opener.canOpenURL(URL(string: "tel:123")!) }
    func open(number: String, cancellation: PhoneJobCancellation) async throws {
        try cancellation.check()
        try PhoneDialNumber.check(number)
        guard opener.foreground,
              let encoded = number.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "0123456789+-().")),
              let url = URL(string: "tel:" + encoded) else { throw PhoneExecutorFailure.denied }
        try cancellation.check()
        let opened = try await opener.open(url, cancellation: cancellation)
        guard opened else { throw PhoneExecutorFailure.unsupported }
    }
}

#if os(iOS)
import UIKit
extension SystemPhoneDialer {
    convenience init() { self.init(opener: ApplicationURLOpener()) }
}
@MainActor private final class ApplicationURLOpener: URLOpener {
    var foreground: Bool { UIApplication.shared.applicationState != .background }
    func canOpenURL(_ url: URL) -> Bool { UIApplication.shared.canOpenURL(url) }
    func open(_ url: URL, cancellation: PhoneJobCancellation) async throws -> Bool {
        guard foreground else { throw PhoneExecutorFailure.denied }
        try cancellation.beginWrite()
        return await UIApplication.shared.open(url, options: [:])
    }
}
#endif
