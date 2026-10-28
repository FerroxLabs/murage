import Foundation
import MurageShellCore

@MainActor protocol PhoneAlarmsAccess {
    var supported: Bool { get }
    var granted: Bool { get }
    func set(operationId: String, hour: Int, minute: Int, label: String?, cancellation: PhoneJobCancellation) async throws -> String
    func timer(operationId: String, seconds: Int, label: String?, cancellation: PhoneJobCancellation) async throws -> String
}
@MainActor final class PhoneAlarmsExecutor: PhoneCapabilityExecutor {
    let os: PhoneAlarmsAccess, ledger: PhoneOperationLedger
    init(os: PhoneAlarmsAccess, ledger: PhoneOperationLedger) { self.os = os; self.ledger = ledger }
    func execute(operationId: String, args: PhoneJobsContract.Args, preciseConsent: Bool, cancellation: PhoneJobCancellation) async throws -> [String: Any] {
        try cancellation.check()
        guard os.supported else { throw PhoneExecutorFailure.unsupported }
        guard os.granted else { throw PhoneExecutorFailure.denied }
        switch args {
        case .alarmsSet(let a):
            _ = try await ledger.perform(operationId) { try cancellation.check(); return try await os.set(operationId: operationId, hour: a.hour, minute: a.minute, label: a.label, cancellation: cancellation) }
        case .alarmsTimer(let a):
            _ = try await ledger.perform(operationId) { try cancellation.check(); return try await os.timer(operationId: operationId, seconds: a.seconds, label: a.label, cancellation: cancellation) }
        default: throw PhoneExecutorFailure.unsupported
        }
        return ["outcome": "set"]
    }
}
#if os(iOS)
#if canImport(AlarmKit)
import AlarmKit
import SwiftUI
@available(iOS 26.0, *)
private struct PhoneAlarmMetadata: AlarmMetadata {}
#endif
@MainActor final class AlarmKitAccess: PhoneAlarmsAccess {
    var supported: Bool {
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) { return true }
        #endif
        return false
    }
    var granted: Bool {
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) { return AlarmManager.shared.authorizationState == .authorized }
        #endif
        return false
    }
    #if canImport(AlarmKit)
    @available(iOS 26.0, *)
    private func attributes(_ label: String?) -> AlarmAttributes<PhoneAlarmMetadata> {
        let title = LocalizedStringResource(stringLiteral: label ?? "Murage")
        let alert = AlarmPresentation.Alert(title: title, stopButton: AlarmButton(text: "Stop", textColor: .white, systemImageName: "stop.fill"))
        return AlarmAttributes(presentation: AlarmPresentation(alert: alert, countdown: .init(title: title)), metadata: PhoneAlarmMetadata(), tintColor: .blue)
    }
    #endif
    func set(operationId: String, hour: Int, minute: Int, label: String?, cancellation: PhoneJobCancellation) async throws -> String {
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            guard granted, let id = UUID(uuidString: operationId) else { throw PhoneExecutorFailure.denied }
            let schedule = Alarm.Schedule.relative(.init(time: .init(hour: hour, minute: minute), repeats: .never))
            try cancellation.beginWrite()
            _ = try await AlarmManager.shared.schedule(id: id, configuration: .alarm(schedule: schedule, attributes: attributes(label)))
            return id.uuidString.lowercased()
        }
        #endif
        throw PhoneExecutorFailure.unsupported
    }
    func timer(operationId: String, seconds: Int, label: String?, cancellation: PhoneJobCancellation) async throws -> String {
        #if canImport(AlarmKit)
        if #available(iOS 26.0, *) {
            guard granted, let id = UUID(uuidString: operationId) else { throw PhoneExecutorFailure.denied }
            try cancellation.beginWrite()
            _ = try await AlarmManager.shared.schedule(id: id, configuration: .timer(duration: TimeInterval(seconds), attributes: attributes(label)))
            return id.uuidString.lowercased()
        }
        #endif
        throw PhoneExecutorFailure.unsupported
    }
}
#endif
