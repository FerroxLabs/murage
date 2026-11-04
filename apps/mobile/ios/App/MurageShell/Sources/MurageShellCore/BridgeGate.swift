import Foundation

/// The one place a closing workspace stops being reachable. Once `close()` is
/// called, every page request is turned away whatever its method, and no event
/// is sent to the page, so a page that outlives its screen (a retained
/// controller, a request already in flight) holds no native authority: no
/// microphone, no Ask, no phone job, nothing. The controller asks it first in
/// its message handler and at the top of `emit`, never per method.
public final class BridgeGate {
    public private(set) var isClosed = false

    public init() {}

    /// The workspace has started to close. Irreversible.
    public func close() { isClosed = true }

    /// May a page request (any method) reach native code?
    public func admitsRequest() -> Bool { !isClosed }

    /// May native code still send an event to the page?
    public func admitsEvent() -> Bool { !isClosed }
}
