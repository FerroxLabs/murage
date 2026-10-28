package com.murage.mobile.shell;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Call and approval actions require API 31 authentication and the feature switch. */
public final class NotificationPlan {
    private NotificationPlan() {}

    public static final class Plan {
        public final String channel;
        public final List<String> actions;
        public final boolean authRequired, silent;
        Plan(String channel, List<String> actions, boolean silent) {
            this.channel = channel; this.actions = actions; this.silent = silent;
            // Sensitive actions are offered only on API 31 and later.
            this.authRequired = actions.contains("APPROVE") || actions.contains("DENY") || actions.contains("ANSWER") || actions.contains("NOT_NOW");
        }
    }

    public static Plan of(PushContract.Category category, int sdk, boolean lockScreenActions) {
        return of(category, sdk, lockScreenActions, false);
    }

    public static Plan of(PushContract.Category category, int sdk, boolean lockScreenActions, boolean silent) {
        if (silent) return new Plan(category.channel(), Collections.emptyList(), true);
        boolean actions = lockScreenActions && sdk >= 31;
        switch (category) {
            case CALL: return new Plan(category.channel(), actions ? Arrays.asList("ANSWER", "NOT_NOW") : Collections.singletonList("OPEN"), false);
            case CALL_NOTE: return new Plan(category.channel(), Collections.singletonList("OPEN"), false);
            case APPROVAL: return new Plan(category.channel(), actions ? Arrays.asList("APPROVE", "DENY", "OPEN") : Collections.singletonList("OPEN"), false);
            case APPROVAL_OPEN: return new Plan(category.channel(), actions ? Arrays.asList("DENY", "OPEN") : Collections.singletonList("OPEN"), false);
            case QUESTION: return new Plan(category.channel(), Collections.singletonList("OPEN"), false);
            case RESOLVED: return new Plan(category.channel(), Collections.emptyList(), true);
            default: return new Plan(category.channel(), Collections.emptyList(), false);
        }
    }
}
