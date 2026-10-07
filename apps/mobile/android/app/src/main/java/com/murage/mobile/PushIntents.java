package com.murage.mobile;

import android.content.Context;
import android.content.Intent;
import com.murage.mobile.shell.PushContract;
import com.murage.mobile.shell.PushOutcome;

/** The extras a notification carries into a tap or an action: ids only. */
final class PushIntents {
    static final String OPEN = "com.murage.mobile.PUSH_OPEN";
    private PushIntents() {}

    /**
     * Every notification tap (and the Open action) goes to PushOpenActivity, which is
     * not exported, by explicit component (A5 review Minor 2): no other app can start
     * it, so nothing outside a notification chooses a computer or a chat.
     */
    static Intent tap(Context context) {
        return new Intent(context, PushOpenActivity.class).setAction(OPEN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    static Intent fill(Intent i, PushContract.Payload p, PushOutcome.Target target) {
        i.putExtra("murage.bindingId", p.bindingId).putExtra("murage.eventRef", p.eventRef).putExtra("murage.category", p.category.wire)
            .putExtra("murage.revision", p.revision).putExtra("murage.collapseKey", p.collapseKey).putExtra("murage.threadGroup", p.threadGroup);
        if (target != null) {
            i.putExtra("murage.threadId", target.threadId);
            if (target.messageId != null) i.putExtra("murage.messageId", target.messageId);
            if (target.requestId != null) i.putExtra("murage.requestId", target.requestId);
        }
        return i;
    }
}
