/// Twin of PushEnrolPlan.java; oracle apps/mobile/src/push-enrol-plan.ts.
public enum PushEnrolPlan: String, Sendable {
    case denied, reuse, replace, create

    public static func decide(permission: String, binding: String?, hasDetail: Bool, fresh: Bool) -> PushEnrolPlan {
        guard permission == "granted" else { return .denied }
        if binding != nil, hasDetail, !fresh { return .reuse }
        return binding != nil ? .replace : .create
    }
}
