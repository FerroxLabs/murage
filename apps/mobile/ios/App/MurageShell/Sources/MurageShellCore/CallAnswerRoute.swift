import Foundation

/// P3's entry point for answering a bot call. Phase 1 currently uses the
/// existing thread route; session admission belongs to the unlocked app.
public enum CallAnswerRoute {
    public static func target(payload: PushPayload, origin: WorkspaceOrigin, userInfo: [AnyHashable: Any],
                              detailToken: () -> String?, send: PushResponse.Send) async -> PushTarget? {
        guard payload.category == .call else { return nil }
        guard let target = await PushResponse.open(payload: payload, origin: origin, userInfo: userInfo,
                                                  detailToken: detailToken, send: send) else { return nil }
        return PushTarget(threadId: target.threadId, messageId: nil, requestId: target.requestId)
    }
}
