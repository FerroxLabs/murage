import Foundation

/// Why the workspace screen closed, as the launcher receives it (P22 `CloseReason`).
public enum CloseReason: String, CaseIterable, Sendable {
    case unreachable, insecure, signedOut, signOut, launcher, updateRequired, accessoff, hosterror
}

/// What a main-document HTTP status means (spec §3.2, §7): 401 is the door
/// saying "not signed in"; 502-504 is Tailscale Serve with no Murage behind it.
public enum MainDocument {
    public static func closeReason(status: Int) -> CloseReason? {
        switch status {
        case 401: return .signedOut
        case 502, 503, 504: return .hosterror
        default: return nil
        }
    }

    /// What a main document that loaded says about the computer. `.signedIn`
    /// at "/" (where pairing lands): WorkspaceBook.signedIn, which may add
    /// the computer and make it active. `.inUse` on any other page but the
    /// door's pairing page /enter (the one 200 without a session): only
    /// "Last connected" moves on (WorkspaceBook.touched), since a relaunch
    /// opens the last conversation and a door without ready() has nothing
    /// else to go by. Never adds, activates or evicts.
    public static func arrival(status: Int, path: String) -> MainDocumentArrival {
        guard status == 200, path != "/enter" else { return .nothing }
        return path == "/" || path.isEmpty ? .signedIn : .inUse
    }
}

public enum MainDocumentArrival: Equatable, Sendable {
    case signedIn, inUse, nothing
}

public enum LaunchPolicy {
    /// The computer to open by itself at launch, or nil to show the launcher.
    /// Once per process: a person who came back to the launcher (a can't-reach
    /// screen, "Switch computer") stays there (Phase 0 surprise 2).
    public static func autoOpen(book: WorkspaceBook, alreadyAutoOpened: Bool, launcherRequested: Bool, closePending: Bool) -> WorkspaceOrigin? {
        guard !alreadyAutoOpened, !launcherRequested, !closePending,
              let active = book.active, let origin = WorkspaceOrigin(string: active), book.entry(for: origin) != nil else { return nil }
        return origin
    }
}

/// B6 (Astra B6): a notification tap for a different computer must not
/// silently end a call in progress on the one already on screen — that
/// would replace the workspace, and `present()` closes the old one, which
/// tears down its call audio. Same-origin notifications are never held
/// here; `WorkspaceViewController`'s own `reloadOrKeepPending()` already
/// guards a same-origin reload mid-call.
public enum CrossComputerNotification {
    /// Whether `origin`'s notification must be held at the coordinator
    /// boundary until the current workspace's call ends (or the workspace
    /// closes for any other reason). `current` is nil when no workspace is
    /// on screen, in which case there is nothing to protect.
    public static func mustHold(current: WorkspaceOrigin?, hasOpenCall: Bool, requested: WorkspaceOrigin) -> Bool {
        guard let current, current != requested else { return false }
        return hasOpenCall
    }
}
