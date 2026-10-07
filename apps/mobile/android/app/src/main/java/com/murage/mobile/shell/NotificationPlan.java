package com.murage.mobile.shell;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Spec §3.5 "Lock-screen actions" on Android: setAuthenticationRequired needs API 31, so below it Open only. */
public final class NotificationPlan {
    private NotificationPlan() {}

    public static final class Plan {
        public final String channel;
        public final List<String> actions;
        public final boolean authRequired, silent;
        Plan(String channel, List<String> actions, boolean silent) {
            this.channel = channel; this.actions = actions; this.silent = silent;
            // Only Approve and Deny answer anything; Open just opens the app, which has its own lock.
            this.authRequired = actions.contains("APPROVE") || actions.contains("DENY");
        }
    }

    public static Plan of(PushContract.Category category, int sdk, boolean lockScreenActions) {
        boolean actions = lockScreenActions && sdk >= 31;
        switch (category) {
            case APPROVAL: return new Plan(category.channel(), actions ? Arrays.asList("APPROVE", "DENY", "OPEN") : Collections.singletonList("OPEN"), false);
            case APPROVAL_OPEN: return new Plan(category.channel(), actions ? Arrays.asList("DENY", "OPEN") : Collections.singletonList("OPEN"), false);
            case QUESTION: return new Plan(category.channel(), Collections.singletonList("OPEN"), false);
            case RESOLVED: return new Plan(category.channel(), Collections.emptyList(), true);
            default: return new Plan(category.channel(), Collections.emptyList(), false);
        }
    }
}
