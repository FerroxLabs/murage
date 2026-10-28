package com.murage.mobile;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import com.murage.mobile.shell.*;

/** Opens an empty web composer. Incoming content is never read or forwarded. */
public final class AssistActivity extends Activity {
    static final String EXTRA_BOT = AssistRoute.EXTRA_BOT;
    static final String EXTRA_WORKSPACE = AssistRoute.EXTRA_WORKSPACE;
    static Intent shortcutIntent(Context context) {
        return new Intent(Intent.ACTION_ASSIST).setComponent(new ComponentName(context, AssistRoute.SHORTCUT));
    }
    private KeyguardManager keyguard;
    private boolean completed;

    @Override protected void onCreate(Bundle state) {
        keyguard = getSystemService(KeyguardManager.class);
        boolean locked = keyguard != null && keyguard.isKeyguardLocked();
        // NoDisplay must finish before onResume. Dismissal is asynchronous, so
        // the locked path needs a window behind the keyguard, never above it.
        if (locked) setTheme(R.style.AppTheme_AssistUnlock);
        super.onCreate(state);
        if (state != null || keyguard == null) { finish(); return; }
        if (!locked) { openComposer(); return; }
        try {
            keyguard.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override public void onDismissSucceeded() { openComposer(); }
                @Override public void onDismissCancelled() { completed = true; finish(); }
                @Override public void onDismissError() { completed = true; finish(); }
            });
        } catch (RuntimeException unavailable) { completed = true; finish(); }
    }

    private void openComposer() {
        if (completed || isFinishing() || isDestroyed()) return;
        completed = true;
        try {
            if (keyguard.isKeyguardLocked() || keyguard.isDeviceLocked()) return;
            synchronized (ShareFiles.LOCK) {
                SecureStore.Read saved = new SecureStore(this).read();
                WorkspaceBook book = saved.state == SecureStore.Read.State.UNREADABLE ? null : WorkspaceBook.decode(saved.bytes);
                SharedPreferences choices = getSharedPreferences("phone_share_choices", MODE_PRIVATE);
                // The exported assist entry never reads extras, including malformed bundles.
                Intent incoming = getIntent();
                ComponentName component = incoming.getComponent();
                AssistRoute route = new AssistRoute(component == null ? null : component.getClassName(), incoming::getStringExtra);
                String requested = route.workspace;
                WorkspaceOrigin origin = WorkspaceOrigin.parse(requested == null
                    ? choices.getString("origin", book == null ? null : book.active()) : requested);
                if (requested == null && book != null && book.entry(origin) == null && !book.sorted().isEmpty())
                    origin = WorkspaceOrigin.parse(book.sorted().get(0).origin);
                if (book == null || book.entry(origin) == null || PhoneAskSetup.removalPending(this, origin)) {
                    startActivity(new Intent(this, MainActivity.class).setAction("com.murage.mobile.SWITCH")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
                    return;
                }
                PhoneAskContract.TargetsAnswer targets = ShareTargets.readCached(getFilesDir(), origin, System.currentTimeMillis());
                String bot = ShareTargets.resolveBot(targets, route.bot,
                    choices.getString(ShareFiles.workspace(origin) + ".bot", null));
                startActivity(new Intent(this, WorkspaceActivity.class)
                    .putExtra(WorkspaceActivity.EXTRA_ORIGIN, origin.serialized())
                    .putExtra(WorkspaceActivity.EXTRA_MODE, "unknown")
                    .putExtra(WorkspaceActivity.EXTRA_ASK_HASH, OpenHash.compose(bot))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
            }
        } catch (RuntimeException invalidLaunch) {
            // Malformed extras or unavailable local storage never launch a partial route.
        } finally { finish(); }
    }
}
