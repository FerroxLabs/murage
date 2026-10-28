#if canImport(UserNotifications)
import Foundation
import UserNotifications

/// The NSE's presentation adapter, also exercised by the simulator suite.
public enum PushNotificationContent {
    public static func apply(_ rewrite: PushRewrite, payload: PushPayload?, to content: UNMutableNotificationContent,
                             shown: [String] = [],
                             now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) {
        content.title = rewrite.title
        content.body = rewrite.body
        // Even a malformed call payload must not pass through a relay preview.
        let rawCategory = (content.userInfo["murage"] as? [String: Any])?["category"] as? String
        let category = payload?.category ?? rawCategory.flatMap(PushCategory.init(rawValue:))
        let action = payload.map { PushContract.callDisplayAction($0, now: now, shown: shown) }
        let quiet = rewrite.silent || category == .resolved || (category?.isExpiring == true && payload == nil) ||
            action == .silent || action == .replace
        content.userInfo["murageSilent"] = quiet
        content.userInfo["murageTarget"] = nil
        if let category {
            content.categoryIdentifier = category.iosCategory
            if category.isExpiring {
                let closed = CallPushStrings.closed(category)
                content.title = closed.title
                content.body = closed.body
                content.subtitle = ""
                content.attachments = []
                content.summaryArgument = ""
                if !quiet && category.isTimeSensitive {
                    content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: PushContract.CallSound.ios))
                    content.interruptionLevel = .timeSensitive
                } else if !quiet && category == .callNote {
                    content.sound = .default
                    content.interruptionLevel = .active
                }
            }
        }
        if quiet {
            content.categoryIdentifier = ""
            content.sound = nil
            content.interruptionLevel = .passive
        }
        if let badge = rewrite.badge { content.badge = NSNumber(value: badge) }
        if !quiet, let target = rewrite.target { content.userInfo["murageTarget"] = PushExtension.targetInfo(target) }
    }
}
#endif
