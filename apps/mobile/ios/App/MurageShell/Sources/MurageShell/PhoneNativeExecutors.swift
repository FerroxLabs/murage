import Foundation
import MurageShellCore

enum PhoneExecutorFailure: Error {
    case denied, unsupported, invalidResult
    var code: String {
        switch self { case .denied: return "denied"; case .unsupported: return "unsupported"; case .invalidResult: return "invalid_result" }
    }
}
enum PhoneFields {
    static func text(_ value: Any?, _ max: Int) -> String {
        let value = value as? String ?? ""
        var result = "", count = 0
        for scalar in value.unicodeScalars {
            let width = scalar.value > 0xffff ? 2 : 1
            if count + width > max { break }
            result.unicodeScalars.append(scalar); count += width
        }
        return result
    }
    static func pick(_ row: [String: Any], strings: [String: Int], other: [String] = []) -> [String: Any] {
        var result: [String: Any] = [:]
        for (key, max) in strings where row[key] != nil { result[key] = text(row[key], max) }
        for key in other { result[key] = row[key] }
        return result
    }
    static func date(_ text: String) throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        guard let date = formatter.date(from: text) else { throw PhoneExecutorFailure.denied }
        return date
    }
    static func time(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
    static func result(_ action: String, _ json: [String: Any]) -> PhoneJobExecution {
        guard JSONSerialization.isValidJSONObject(json), let bytes = try? JSONSerialization.data(withJSONObject: json) else { return .error(code: "invalid_result") }
        guard bytes.count <= PhoneJobsContract.resultMaxBytes else { return .error(code: "too_large") }
        guard let result = PhoneJobsContract.Result.parse(action: action, json), result.encode() != nil else { return .error(code: "invalid_result") }
        return .result(result)
    }
}
@MainActor protocol PhoneCapabilityExecutor {
    func cancel()
    func execute(operationId: String, args: PhoneJobsContract.Args, preciseConsent: Bool, cancellation: PhoneJobCancellation) async throws -> [String: Any]
}

extension PhoneCapabilityExecutor { func cancel() {} }

/// Runner-only dispatch. Framework adapters never receive a lease, token or workspace.
@MainActor final class NativePhoneJobExecutors: PhoneJobExecutorRegistry {
    private let modules: [String: PhoneCapabilityExecutor]
    private let foreground: () -> Bool
    func cancel() async { for module in modules.values { module.cancel() } }
    init(modules: [String: PhoneCapabilityExecutor], foreground: @escaping () -> Bool = { true }) { self.modules = modules; self.foreground = foreground }
    func run(operationId: String, capability: String, action: String, args: PhoneJobsContract.Args, preciseConsent: Bool, cancellation: PhoneJobCancellation) async -> PhoneJobExecution {
        guard foreground(), !cancellation.isCancelled else { return .error(code: "denied") }
        guard action.hasPrefix(capability + "."), let module = modules[capability] else { return .error(code: "unsupported") }
        do { return PhoneFields.result(action, try await module.execute(operationId: operationId, args: args, preciseConsent: preciseConsent, cancellation: cancellation)) }
        catch let error as PhoneExecutorFailure { return .error(code: error.code) }
        catch { return .error(code: "denied") }
    }
}
