import Foundation

/// Presentation-only bridge boundary. No state or credentials can cross it.
public enum PhoneForBotsEntry {
    public static func open(args: [String: Any], paired: Bool, present: () -> Void) throws {
        guard args.isEmpty else { throw ChannelError.badArgs }
        if paired { present() }
    }
}
