#if os(iOS)
import UserNotifications
import MurageShellCore

/// Spec §3.5 "Lock-screen actions". Every action asks for the passcode or
/// Face ID first (.authenticationRequired). A risky or unrated approval
/// (APPROVAL_OPEN, Plan 3a R2) offers Deny and Open only.
enum PushCategories {
    static func install(actions: Bool = PushFeatures.lockScreenActions) {
        UNUserNotificationCenter.current().setNotificationCategories(registered(actions: actions))
    }

    static func registered(actions: Bool = PushFeatures.lockScreenActions) -> Set<UNNotificationCategory> {
        let approve = UNNotificationAction(identifier: "APPROVE", title: "Approve", options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: "DENY", title: "Deny", options: [.authenticationRequired, .destructive])
        let open = UNNotificationAction(identifier: "OPEN", title: "Open", options: [.authenticationRequired, .foreground])
        let call = (PushContract.iosActions["CALL"] ?? []).map { action in
            var options: UNNotificationActionOptions = [.authenticationRequired]
            if action.options.contains("foreground") { options.insert(.foreground) }
            return UNNotificationAction(identifier: action.id,
                title: CallPushStrings.text(action.id == "ANSWER" ? "push_call_answer" : "push_call_not_now"), options: options)
        }
        return [
            category("APPROVAL", actions: actions ? [approve, deny, open] : [open]),
            category("APPROVAL_OPEN", actions: actions ? [deny, open] : [open]),
            category("QUESTION", actions: [open]),
            category("DONE", actions: []),
            category(PushCategory.deviceJob.iosCategory, actions: []),
            category("CALL", actions: call),
            category("CALL_NOTE", actions: [open]),
        ]
    }
    private static func category(_ id: String, actions: [UNNotificationAction]) -> UNNotificationCategory {
        UNNotificationCategory(identifier: id, actions: actions, intentIdentifiers: [], options: [])
    }
}
#endif
