package com.murage.mobile.shell;

/** What registerPush does for the workspace on screen (Decision 1). Twin of PushEnrolPlan.swift; oracle apps/mobile/src/push-enrol-plan.ts. */
public final class PushEnrolPlan {
    private PushEnrolPlan() {}
    public static String decide(String permission, String binding, boolean hasDetail, boolean fresh) {
        if (!"granted".equals(permission)) return "denied";
        if (binding != null && hasDetail && !fresh) return "reuse";
        return binding != null ? "replace" : "create";
    }
}
