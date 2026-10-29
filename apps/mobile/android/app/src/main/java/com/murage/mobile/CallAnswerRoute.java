package com.murage.mobile;

import android.content.Intent;
import com.murage.mobile.shell.OpenHash;

/** P3's call-answer entry point. Phase 1 opens the existing thread route;
 * session admission belongs to the unlocked app. */
final class CallAnswerRoute {
    private CallAnswerRoute() {}
    static boolean isNotNow(String action) { return "NOT_NOW".equals(action); }
    static Intent intent(Intent tap) { return new Intent(tap).putExtra("murage.callAnswer", true); }
    static String thread(String threadId) { return OpenHash.valid(threadId) ? threadId : null; }
}
