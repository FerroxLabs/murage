#if os(iOS)
import UIKit
import EventKit
import Contacts
import CoreLocation
import MessageUI
#if canImport(AlarmKit)
import AlarmKit
#endif

// This manager is created on the main actor, so Core Location delivers its
// delegate callbacks on the main run loop.
@MainActor final class PhonePermissions: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let events = EKEventStore()
    private let contacts = CNContactStore()
    private let location = CLLocationManager()
    private var locationAnswer: CheckedContinuation<Void, Never>?
    override init() { super.init(); location.delegate = self }

    func value(_ row: String) -> Any? {
        switch row {
        case "calendar":
            switch EKEventStore.authorizationStatus(for: .event) {
            case .fullAccess: return "full"
            case .writeOnly: return "write-only"
            default: return nil
            }
        case "reminders": return EKEventStore.authorizationStatus(for: .reminder) == .fullAccess ? true : nil
        case "contacts":
            let status = CNContactStore.authorizationStatus(for: .contacts)
            if status == .authorized { return "full" }
            if #available(iOS 18, *), status == .limited { return "limited" }
            return nil
        case "location", "precise":
            guard location.authorizationStatus == .authorizedWhenInUse || location.authorizationStatus == .authorizedAlways else { return nil }
            let full = location.accuracyAuthorization == .fullAccuracy
            return row == "precise" ? (full ? true : nil) : (full ? "precise" : "approximate")
        case "alarms":
            #if canImport(AlarmKit)
            if #available(iOS 26.0, *) { return AlarmManager.shared.authorizationState == .authorized ? true : nil }
            #endif
            return nil
        case "messages": return MFMessageComposeViewController.canSendText() ? true : nil
        case "calls": return UIApplication.shared.canOpenURL(URL(string: "tel:123")!) ? true : nil
        default: return nil
        }
    }

    func request(_ row: String) async {
        switch row {
        case "calendar": _ = try? await events.requestFullAccessToEvents()
        case "reminders": _ = try? await events.requestFullAccessToReminders()
        case "contacts": _ = try? await contacts.requestAccess(for: .contacts)
        case "location", "precise":
            guard CLLocationManager.locationServicesEnabled() else { return }
            if location.authorizationStatus == .notDetermined {
                await withCheckedContinuation { continuation in
                    locationAnswer = continuation
                    location.requestWhenInUseAuthorization()
                }
            }
            if row == "precise", value("location") != nil, location.accuracyAuthorization == .reducedAccuracy {
                try? await location.requestTemporaryFullAccuracyAuthorization(withPurposeKey: "PhonePreciseLocation")
            }
        case "alarms":
            #if canImport(AlarmKit)
            if #available(iOS 26.0, *) { _ = try? await AlarmManager.shared.requestAuthorization() }
            #endif
        default: break // OS composers have no runtime permission.
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard !CLLocationManager.locationServicesEnabled() || manager.authorizationStatus != .notDetermined else { return }
        let answer = locationAnswer
        locationAnswer = nil
        answer?.resume()
    }
}
#endif
