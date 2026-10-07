package com.murage.mobile;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;
import com.murage.mobile.shell.WorkspaceOrigin;

/**
 * Spec §3.5 "Tapping a notification", A5 review Minors 2, 3 and 7. Every tap lands
 * here, never on the exported launcher: this activity is not exported and shows
 * nothing (Theme.NoDisplay), so it finishes in onCreate.
 *
 * <ul>
 *   <li>A live workspace: the tap opens its chat from here, as before (startWorkspace
 *       closes the other computer first). No Capacitor bridge is built (P26 F2, I2).</li>
 *   <li>No live workspace (the process died, or none is open): the tap goes to the
 *       launcher at the root with CLEAR_TOP, so a dead workspace's record under it is
 *       cleared and Back from the new computer reaches the launcher, not the old one.</li>
 *   <li>A computer no longer on this phone: a toast over a live workspace, or the
 *       launcher's notice when it will be on screen. Nothing is left to surface late.</li>
 * </ul>
 */
public class PushOpenActivity extends Activity {
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        try {
            if (state == null) route(getIntent());
        } catch (RuntimeException unexpected) {
            ShellLog.i("notification open failed error=" + unexpected.getClass().getSimpleName());
        }
        finish();
    }

    private void route(Intent intent) {
        if (intent == null || !PushIntents.OPEN.equals(intent.getAction())) return;
        Shell shell = Shell.get(this);
        WorkspaceOrigin origin = PushServices.get(this).store.canonicalOrigin(intent.getStringExtra("murage.bindingId"));
        String threadId = intent.getStringExtra("murage.threadId"), messageId = intent.getStringExtra("murage.messageId");
        boolean live = shell.live() != null;
        if (origin == null) ShellLog.i("notification for a removed computer");
        if (live) {
            if (origin == null) Toast.makeText(getApplicationContext(), R.string.removed_workspace, Toast.LENGTH_LONG).show();
            else shell.openFromNotification(this, origin, threadId, messageId);
            return;
        }
        shell.handPushTap(new Shell.PushTap(origin, threadId, messageId));
        startActivity(launcher(this));
        overridePendingTransition(0, 0);
    }

    /** The launcher at the task's root, everything above it cleared; onNewIntent if it is there. */
    static Intent launcher(Activity from) {
        return new Intent(from, MainActivity.class).setAction(PushIntents.OPEN)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }
}
