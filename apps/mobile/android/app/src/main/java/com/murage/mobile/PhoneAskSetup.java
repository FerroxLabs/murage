package com.murage.mobile;

import android.app.KeyguardManager;
import android.app.StatusBarManager;
import android.app.role.RoleManager;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import com.murage.mobile.shell.WorkspaceOrigin;
import com.murage.mobile.shell.ShareFiles;
import com.murage.mobile.shell.ShareTargets;
import com.murage.mobile.shell.WorkspaceBook;
import com.murage.mobile.shell.PhoneAskContract;
import com.murage.mobile.shell.AssistantSettings;
import com.murage.mobile.shell.OpenHash;
import java.util.ArrayList;
import java.util.List;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Only the foreground workspace offers setup. No bridge or intent can mint. */
final class PhoneAskSetup {
    private final AppCompatActivity activity;
    private final WorkspaceOrigin origin;
    private final SharedPreferences choices;
    private final PhoneAskSigner.EnrolledKey key;
    private final PhoneAskSigner signer;
    private final PhoneJobsMintClient mint;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private AlertDialog dialog;
    private boolean working, closed;

    PhoneAskSetup(AppCompatActivity activity, WorkspaceOrigin origin) {
        this.activity = activity; this.origin = origin;
        choices = activity.getSharedPreferences("phone_ask_setup", Context.MODE_PRIVATE);
        key = new PhoneAskSigner.EnrolledKey(activity);
        signer = new PhoneAskSigner(key);
        mint = new PhoneJobsMintClient(signer, new PhoneAskTokenStore(activity), new PhoneJobsMintHTTP(Shell.USER_AGENT_TOKEN),
            io, activity::runOnUiThread, System::currentTimeMillis);
    }

    private String pairing() { String id = signer.keyId(origin); return id == null ? "no-key" : id; }

    void foreground() {
        retryRemovals(activity);
        if (removals(activity).contains(origin)) return;
        KeyguardManager gate = activity.getSystemService(KeyguardManager.class);
        if (closed || working || dialog != null || activity.isFinishing() || activity.isDestroyed()
            || gate == null || gate.isDeviceLocked() || !activity.hasWindowFocus()
            || pairing().equals(choices.getString(origin.serialized(), null))) return;
        show(null);
    }

    private void show(String problem) {
        if (closed || activity.isFinishing() || activity.isDestroyed()) return;
        dialog = new AlertDialog.Builder(activity)
            .setTitle(R.string.ask_setup_title)
            .setMessage(activity.getString(R.string.ask_setup_body) + (problem == null ? "" : "\n\n" + problem))
            .setNegativeButton(R.string.ask_not_now, (d, w) -> choices.edit().putString(origin.serialized(), pairing()).commit())
            .setPositiveButton(R.string.ask_turn_on, null)
            .setCancelable(false).create();
        dialog.setOnDismissListener(d -> dialog = null);
        dialog.show();
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            if (working || removals(activity).contains(origin)) return;
            working = true;
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(false);
            mint.mint(origin, new PhoneJobsMintClient.Completion() {
                @Override public void complete() {
                    working = false;
                    choices.edit().putString(origin.serialized(), pairing()).commit();
                    PhoneShareServices.get(activity).paired(origin);
                    if (dialog != null) dialog.dismiss();
                }
                @Override public void failed(PhoneJobsMintClient.Failure failure) {
                    working = false;
                    if (closed || dialog == null) return;
                    dialog.setMessage(activity.getString(R.string.ask_setup_body) + "\n\n" + activity.getString(errorResource(failure)));
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true);
                    dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(true);
                }
            });
        });
    }

    static int errorResource(PhoneJobsMintClient.Failure failure) {
        switch (failure) {
            case UPDATE_COMPUTER: return R.string.ask_update;
            case NO_APPROVAL_KEY: return R.string.ask_no_key;
            case REFUSED: return R.string.ask_computer_off;
            case NOT_OFFERED: return R.string.ask_cloud;
            default: return R.string.ask_setup_again;
        }
    }

    private void cancel() {
        mint.cancel(); key.cancel(); working = false;
        if (dialog != null) { dialog.dismiss(); dialog = null; }
    }

    void close() { closed = true; cancel(); io.shutdownNow(); }

    private static PendingRemovals pendingRemovals;

    private static PendingRemovals removals(Context context) {
        synchronized (ShareFiles.LOCK) {
            if (pendingRemovals == null) {
                Context app = context.getApplicationContext();
                PendingRemovals queue = new PendingRemovals(
                    app.getSharedPreferences("phone_ask_setup", Context.MODE_PRIVATE), new PhoneAskTokenStore(app),
                    (origin, code) -> PhoneShareServices.get(app).cleanup(origin, code));
                IntentFilter filter = new IntentFilter(Intent.ACTION_USER_PRESENT);
                filter.addAction(Intent.ACTION_USER_UNLOCKED);
                ContextCompat.registerReceiver(app, new BroadcastReceiver() {
                    @Override public void onReceive(Context context, Intent intent) {
                        String action = intent.getAction();
                        if (Intent.ACTION_USER_PRESENT.equals(action) || Intent.ACTION_USER_UNLOCKED.equals(action)) queue.retry();
                    }
                }, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
                pendingRemovals = queue;
            }
            return pendingRemovals;
        }
    }

    static void retryRemovals(Context context) { removals(context).retry(); }

    static boolean removalPending(Context context, WorkspaceOrigin origin) {
        // Composer entry points inspect only the barrier, never construct a token store.
        synchronized (ShareFiles.LOCK) {
            return pendingRemovals != null ? pendingRemovals.contains(origin)
                : context.getSharedPreferences("phone_ask_setup", Context.MODE_PRIVATE)
                    .getStringSet(PendingRemovals.QUEUE_KEY, java.util.Collections.emptySet()).contains(origin.serialized());
        }
    }

    static void addAssistantRows(AppCompatActivity activity, LinearLayout rows) {
        TextView title = new TextView(activity); title.setText(R.string.ask_assistant_title); rows.addView(title);
        TextView body = new TextView(activity); body.setText(R.string.ask_assistant_body); rows.addView(body);
        Button choose = new Button(activity); choose.setText(R.string.ask_assistant_settings);
        choose.setOnClickListener(v -> openAssistantSettings(activity)); rows.addView(choose);
        if (Build.VERSION.SDK_INT >= 33) {
            StatusBarManager status = activity.getSystemService(StatusBarManager.class);
            if (status == null) return;
            Button add = new Button(activity); add.setText(R.string.ask_add_tile);
            add.setOnClickListener(v -> status.requestAddTileService(new ComponentName(activity, AskTileService.class),
                activity.getString(R.string.tile_ask), Icon.createWithResource(activity, R.drawable.ic_tile_ask),
                activity.getMainExecutor(), result -> {}));
            rows.addView(add);
        }
    }

    static void openAssistantSettings(Context context) {
        RoleManager roles = Build.VERSION.SDK_INT >= 29 ? context.getSystemService(RoleManager.class) : null;
        boolean available = Build.VERSION.SDK_INT >= 29 && roles != null && roles.isRoleAvailable(RoleManager.ROLE_ASSISTANT);
        AssistantSettings.open(Build.VERSION.SDK_INT, available, destination -> {
            try {
                Intent intent = Build.VERSION.SDK_INT >= 29 && roles != null && destination == AssistantSettings.Destination.ROLE
                    ? roles.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT)
                    : new Intent(destination.action).setPackage(destination.packageName);
                context.startActivity(intent);
                return true;
            } catch (ActivityNotFoundException unavailable) { return false; }
        });
    }

    private static String shortcutPrefix(WorkspaceOrigin origin) { return "ask." + ShareFiles.workspace(origin) + "."; }

    /** Publication and removal use the same barrier as the target cache and outbox. */
    static void refreshShortcuts(Context context) {
        synchronized (ShareFiles.LOCK) {
            try {
                ShortcutManager manager = context.getSystemService(ShortcutManager.class);
                if (manager == null) return;
                SecureStore.Read saved = new SecureStore(context).read();
                if (saved.state == SecureStore.Read.State.UNREADABLE) return;
                WorkspaceBook book = WorkspaceBook.decode(saved.bytes);
                SharedPreferences choices = context.getSharedPreferences("phone_share_choices", Context.MODE_PRIVATE);
                List<WorkspaceBook.Entry> computers = book.sorted();
                String lastOrigin = choices.getString("origin", book.active());
                computers.sort((a, b) -> Boolean.compare(b.origin.equals(lastOrigin), a.origin.equals(lastOrigin)));
                // Static shortcuts count toward the launcher's per-activity limit too.
                int limit = Math.max(0, Math.min(4, manager.getMaxShortcutCountPerActivity() - manager.getManifestShortcuts().size()));
                List<ShortcutInfo> shortcuts = new ArrayList<>();
                List<ShortcutInfo> pinnedUpdates = new ArrayList<>();
                List<ShortcutInfo> pinned = manager.getPinnedShortcuts();
                for (WorkspaceBook.Entry entry : computers) {
                    WorkspaceOrigin origin = WorkspaceOrigin.parse(entry.origin);
                    if (removalPending(context, origin)) continue;
                    PhoneAskContract.TargetsAnswer targets = ShareTargets.readCached(context.getFilesDir(), origin, System.currentTimeMillis());
                    // Migrate all published bot intents, even outside the cache or dynamic limit.
                    // The activity still validates the bot against current cached targets.
                    String prefix = shortcutPrefix(origin);
                    for (ShortcutInfo shortcut : pinned) {
                        if (shortcut.isImmutable() || !shortcut.getId().startsWith(prefix)) continue;
                        String bot = shortcut.getId().substring(prefix.length());
                        if (!OpenHash.validBot(bot)) continue;
                        pinnedUpdates.add(new ShortcutInfo.Builder(context, shortcut.getId())
                            .setShortLabel(shortcut.getShortLabel())
                            .setIntent(AssistActivity.shortcutIntent(context)
                                .putExtra(AssistActivity.EXTRA_WORKSPACE, origin.serialized())
                                .putExtra(AssistActivity.EXTRA_BOT, bot)).build());
                    }
                    String last = choices.getString(ShareFiles.workspace(origin) + ".bot", null);
                    for (PhoneAskContract.TargetBot bot : ShareTargets.recentBots(targets, last)) {
                        if (shortcuts.size() >= limit) break;
                        shortcuts.add(botShortcut(context, origin, bot, shortcuts.size()));
                    }
                }
                if (!pinnedUpdates.isEmpty()) manager.updateShortcuts(pinnedUpdates);
                manager.setDynamicShortcuts(shortcuts);
            } catch (RuntimeException unavailable) { /* Launcher publication can retry on the next foreground. */ }
        }
    }

    private static ShortcutInfo botShortcut(Context context, WorkspaceOrigin origin, PhoneAskContract.TargetBot bot, int rank) {
        Intent intent = AssistActivity.shortcutIntent(context)
            .putExtra(AssistActivity.EXTRA_WORKSPACE, origin.serialized()).putExtra(AssistActivity.EXTRA_BOT, bot.id);
        return new ShortcutInfo.Builder(context, shortcutPrefix(origin) + bot.id)
            .setActivity(new ComponentName(context, MainActivity.class))
            .setShortLabel(context.getString(R.string.ask_shortcut_bot, bot.name))
            .setIcon(Icon.createWithResource(context, R.drawable.ic_tile_ask))
            .setRank(rank).setIntent(intent).build();
    }

    static boolean removeShortcuts(Context context, WorkspaceOrigin origin) {
        synchronized (ShareFiles.LOCK) {
            try {
                ShortcutManager manager = context.getSystemService(ShortcutManager.class);
                if (manager == null) return false;
                Set<String> ids = new HashSet<>();
                List<ShortcutInfo> shortcuts = new ArrayList<>(manager.getDynamicShortcuts());
                shortcuts.addAll(manager.getPinnedShortcuts());
                for (ShortcutInfo shortcut : shortcuts) if (shortcut.getId().startsWith(shortcutPrefix(origin))) ids.add(shortcut.getId());
                if (!ids.isEmpty()) {
                    List<String> removed = new ArrayList<>(ids);
                    manager.disableShortcuts(removed);
                    manager.removeDynamicShortcuts(removed);
                    if (Build.VERSION.SDK_INT >= 30) manager.removeLongLivedShortcuts(removed);
                }
                SharedPreferences choices = context.getSharedPreferences("phone_share_choices", Context.MODE_PRIVATE);
                SharedPreferences.Editor edit = choices.edit().remove(ShareFiles.workspace(origin) + ".bot")
                    .remove(ShareFiles.workspace(origin) + ".thread");
                if (origin.serialized().equals(choices.getString("origin", null))) edit.remove("origin");
                return edit.commit();
            } catch (RuntimeException unavailable) { return false; }
        }
    }

    static boolean forget(Context context, WorkspaceOrigin origin) {
        return forget(context, origin, "removed");
    }

    static boolean forget(Context context, WorkspaceOrigin origin, String code) {
        return removals(context).forget(origin, code);
    }

    static final class PendingRemovals {
        interface Cleanup { boolean remove(WorkspaceOrigin origin, String code); }
        private final Cleanup cleanup;
        private static final String QUEUE_KEY = "pendingRemovals.v1";
        private final SharedPreferences choices;
        private final PhoneAskTokenStore tokens;
        private final Set<String> pending;

        PendingRemovals(SharedPreferences choices, PhoneAskTokenStore tokens) {
            this(choices, tokens, (origin, code) -> true);
        }

        PendingRemovals(SharedPreferences choices, PhoneAskTokenStore tokens, Cleanup cleanup) {
            this.choices = choices; this.tokens = tokens; this.cleanup = cleanup;
            pending = new HashSet<>(choices.getStringSet(QUEUE_KEY, java.util.Collections.emptySet()));
        }

        boolean contains(WorkspaceOrigin origin) {
            synchronized (ShareFiles.LOCK) {
                return pending.contains(origin.serialized()) ||
                    choices.getStringSet(QUEUE_KEY, java.util.Collections.emptySet()).contains(origin.serialized());
            }
        }

        boolean forget(WorkspaceOrigin origin) { return forget(origin, "removed"); }
        boolean forget(WorkspaceOrigin origin, String code) {
            synchronized (ShareFiles.LOCK) {
                pending.add(origin.serialized());
                String reason = "revoked".equals(choices.getString("removalCode." + origin.serialized(), null)) ? "revoked" : code;
                boolean recorded = choices.edit().putStringSet(QUEUE_KEY, new HashSet<>(pending))
                    .putString("removalCode." + origin.serialized(), reason).commit();
                boolean removed = tokens.remove(origin);
                boolean cleaned;
                try { cleaned = cleanup.remove(origin, reason); }
                catch (RuntimeException failed) { cleaned = false; }
                if (!recorded || !removed || !cleaned) return false;
                Set<String> remaining = new HashSet<>(pending);
                remaining.remove(origin.serialized());
                if (!choices.edit().remove(origin.serialized()).remove("removalCode." + origin.serialized())
                    .putStringSet(QUEUE_KEY, remaining).commit()) return false;
                pending.remove(origin.serialized());
                return true;
            }
        }

        void retry() {
            synchronized (ShareFiles.LOCK) {
                for (String value : new HashSet<>(pending)) {
                    WorkspaceOrigin origin = WorkspaceOrigin.parse(value);
                    if (origin != null) forget(origin, choices.getString("removalCode." + value, "removed"));
                }
            }
        }
    }
}
