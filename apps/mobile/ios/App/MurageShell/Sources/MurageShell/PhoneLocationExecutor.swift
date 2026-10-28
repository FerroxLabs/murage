import Foundation
import MurageShellCore

struct PhoneLocationFix { let lat: Double, lon: Double, accuracy: Double; let at: Date }
@MainActor protocol PhoneLocationAccess {
    var granted: Bool { get }
    var precise: Bool { get }
    func current(precise: Bool) async throws -> PhoneLocationFix
    func cancel()
}
extension PhoneLocationAccess { func cancel() {} }
@MainActor final class PhoneLocationExecutor: PhoneCapabilityExecutor {
    let os: PhoneLocationAccess
    func cancel() { os.cancel() }
    init(os: PhoneLocationAccess) { self.os = os }
    func execute(operationId: String, args: PhoneJobsContract.Args, preciseConsent: Bool, cancellation: PhoneJobCancellation) async throws -> [String: Any] {
        try cancellation.check()
        guard case .locationGet(let a) = args else { throw PhoneExecutorFailure.unsupported }
        guard os.granted else { throw PhoneExecutorFailure.denied }
        let precise = a.precision == "precise" && preciseConsent && os.precise
        let fix = try await os.current(precise: precise)
        guard os.granted, fix.lat.isFinite, fix.lon.isFinite, fix.accuracy.isFinite, abs(fix.lat) <= 90, abs(fix.lon) <= 180, fix.accuracy >= 0 else { throw PhoneExecutorFailure.denied }
        let full = precise && os.precise
        return ["lat": full ? fix.lat : (fix.lat * 1000).rounded() / 1000,
                "lon": full ? fix.lon : (fix.lon * 1000).rounded() / 1000,
                "accuracyMeters": full ? fix.accuracy : max(100, fix.accuracy),
                "precision": full ? "precise" : "approximate", "at": PhoneFields.time(fix.at)]
    }
}
#if os(iOS)
import CoreLocation
// Core Location delivers delegate callbacks on the run loop where the manager
// was created (the main actor here); preserve synchronous callback handling.
@MainActor final class CoreLocationAccess: NSObject, PhoneLocationAccess, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var answer: CheckedContinuation<PhoneLocationFix, Error>?
    private var deadline: Task<Void, Never>?
    override init() { super.init(); manager.delegate = self }
    var granted: Bool { manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways }
    var precise: Bool { manager.accuracyAuthorization == .fullAccuracy }
    func current(precise: Bool) async throws -> PhoneLocationFix {
        guard granted, answer == nil else { throw PhoneExecutorFailure.denied }
        manager.desiredAccuracy = precise ? kCLLocationAccuracyBest : kCLLocationAccuracyHundredMeters
        return try await withCheckedThrowingContinuation { continuation in
            answer = continuation
            deadline = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
                self?.finish(.failure(PhoneExecutorFailure.denied))
            }
            manager.requestLocation()
        }
    }
    func cancel() { finish(.failure(PhoneExecutorFailure.denied)) }
    private func finish(_ result: Result<PhoneLocationFix, Error>) {
        let pending = answer; answer = nil; deadline?.cancel(); deadline = nil; manager.stopUpdatingLocation()
        pending?.resume(with: result)
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard granted, let location = locations.last, location.horizontalAccuracy >= 0 else { finish(.failure(PhoneExecutorFailure.denied)); return }
        finish(.success(.init(lat: location.coordinate.latitude, lon: location.coordinate.longitude, accuracy: location.horizontalAccuracy, at: location.timestamp)))
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { finish(.failure(PhoneExecutorFailure.denied)) }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { if !granted { finish(.failure(PhoneExecutorFailure.denied)) } }
}
#endif
