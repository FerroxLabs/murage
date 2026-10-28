import Foundation
import MurageShellCore

@MainActor protocol PhoneContactsAccess {
    var access: String? { get }
    // The store returns only OS-granted contacts, including under limited authorization.
    func search(query: String, limit: Int) throws -> [[String: Any]]
    func get(id: String) throws -> [String: Any]?
}
@MainActor final class PhoneContactsExecutor: PhoneCapabilityExecutor {
    let os: PhoneContactsAccess
    init(os: PhoneContactsAccess) { self.os = os }
    static func trim(_ row: [String: Any]) -> [String: Any] {
        var result = PhoneFields.pick(row, strings: ["id": 256, "name": 200])
        for (key, value, max) in [("phones", "number", 40), ("emails", "address", 254)] {
            let rows = row[key] as? [[String: Any]] ?? []
            result[key] = rows.filter { !PhoneFields.text($0[value], max).isEmpty }.prefix(10).map {
                PhoneFields.pick($0, strings: ["label": 50, value: max])
            }
        }
        return result
    }
    func execute(operationId: String, args: PhoneJobsContract.Args, preciseConsent: Bool, cancellation: PhoneJobCancellation) async throws -> [String: Any] {
        try cancellation.check()
        guard let access = os.access else { throw PhoneExecutorFailure.denied }
        let result: [String: Any]
        switch args {
        case .contactsSearch(let a):
            result = ["contacts": try os.search(query: a.query, limit: a.limit ?? 25).prefix(a.limit ?? 25).map(Self.trim), "limited": access == "limited"]
        case .contactsGet(let a):
            result = ["contact": try os.get(id: a.id).map(Self.trim) as Any? ?? NSNull(), "limited": access == "limited"]
        default: throw PhoneExecutorFailure.unsupported
        }
        // Discard a read if its authorization changed while the OS supplied it.
        guard os.access == access else { throw PhoneExecutorFailure.denied }
        return result
    }
}
#if os(iOS)
import Contacts
@MainActor final class ContactsStoreAccess: PhoneContactsAccess {
    private let store = CNContactStore()
    var access: String? {
        let state = CNContactStore.authorizationStatus(for: .contacts)
        if state == .authorized { return "full" }
        if #available(iOS 18, *), state == .limited { return "limited" }
        return nil
    }
    private var keys: [CNKeyDescriptor] { [CNContactIdentifierKey as CNKeyDescriptor, CNContactFormatter.descriptorForRequiredKeys(for: .fullName), CNContactPhoneNumbersKey as CNKeyDescriptor, CNContactEmailAddressesKey as CNKeyDescriptor] }
    private func row(_ c: CNContact) -> [String: Any] {
        ["id": c.identifier, "name": CNContactFormatter.string(from: c, style: .fullName) ?? "",
         "phones": c.phoneNumbers.map { v -> [String: Any] in
             var r: [String: Any] = ["number": v.value.stringValue]
             if let label = v.label { r["label"] = CNLabeledValue<NSString>.localizedString(forLabel: label) }; return r
         }, "emails": c.emailAddresses.map { v -> [String: Any] in
             var r: [String: Any] = ["address": v.value as String]
             if let label = v.label { r["label"] = CNLabeledValue<NSString>.localizedString(forLabel: label) }; return r
         }]
    }
    func search(query: String, limit: Int) throws -> [[String: Any]] {
        guard access != nil else { throw PhoneExecutorFailure.denied }
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.predicate = CNContact.predicateForContacts(matchingName: query); request.sortOrder = .userDefault
        var rows: [[String: Any]] = []
        try store.enumerateContacts(with: request) { contact, stop in
            rows.append(self.row(contact)); if rows.count >= limit { stop.pointee = true }
        }
        return rows
    }
    func get(id: String) throws -> [String: Any]? {
        guard access != nil else { throw PhoneExecutorFailure.denied }
        // A predicate over the authorized store cannot retrieve an ungranted identifier.
        return try store.unifiedContacts(matching: CNContact.predicateForContacts(withIdentifiers: [id]), keysToFetch: keys).first.map(row)
    }
}
#endif
