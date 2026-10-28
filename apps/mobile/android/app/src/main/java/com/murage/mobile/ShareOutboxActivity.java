package com.murage.mobile;

import android.os.Bundle;
import android.widget.*;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import com.murage.mobile.shell.*;
import java.util.List;
import org.json.JSONObject;

/** Native outbox. Explicit retry/redirect builds a new manifest and share id. */
public final class ShareOutboxActivity extends AppCompatActivity {
    private PhoneShareServices services;
    private LinearLayout rows;
    private final Runnable changed = () -> runOnUiThread(() -> { if (!isDestroyed() && !isFinishing()) refresh(); });
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state); services = PhoneShareServices.get(this);
        rows = new LinearLayout(this); rows.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (20 * getResources().getDisplayMetrics().density); rows.setPadding(pad, pad, pad, pad);
        ScrollView scroll = new ScrollView(this); scroll.addView(rows); setContentView(scroll);
        setTitle(R.string.share_outbox_waiting);
        services.changeListeners.add(changed);
    }
    @Override protected void onResume() { super.onResume(); services.foreground(); refresh(); }
    @Override protected void onDestroy() { services.changeListeners.remove(changed); super.onDestroy(); }
    private void refresh() {
        services.io.execute(() -> {
            try {
                services.outbox.sweep(); List<JSONObject> entries = services.outbox.entries();
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    rows.removeAllViews();
                    SharePicker.label(rows, getString(R.string.share_outbox_waiting)).setTextSize(22);
                    for (JSONObject row : entries) {
                        WorkspaceOrigin origin = services.origin(row.optString("workspace"));
                        if (origin != null) {
                            WorkspaceBook book = services.book(); WorkspaceBook.Entry computer = book == null ? null : book.entry(origin);
                            if (computer != null) SharePicker.label(rows, computer.name);
                        }
                        boolean hasBody = false;
                        try { hasBody = services.outbox.body(row.optString("shareId")).isFile(); } catch (Exception ignored) { }
                        Button line = new Button(this); line.setText(ShareActivity.resource(ShareOutbox.messageKey(row, hasBody))); rows.addView(line);
                        boolean retry = false;
                        try { retry = origin != null && services.access.current(origin) != null && services.outbox.body(row.optString("shareId")).isFile()
                            && ("failed".equals(row.optString("state")) || "needsTarget".equals(row.optString("state"))); } catch (Exception ignored) { }
                        line.setEnabled(retry);
                        line.setOnClickListener(v -> {
                            if ("needsTarget".equals(row.optString("state"))) pick(row, origin);
                            else {
                                JSONObject target = row.optJSONObject("target");
                                if (target != null) retry(row, origin, target.optString("botId"), target.optString("threadId"));
                            }
                        });
                        if (origin != null && "sent".equals(row.optString("state")) && !row.optString("threadId").isEmpty()) {
                            Button open = new Button(this); open.setText(R.string.share_open_chat);
                            open.setOnClickListener(v -> Shell.get(this).openFromNotification(this, origin, row.optString("threadId"), null)); rows.addView(open);
                        }
                    }
                });
            } catch (Exception ignored) { runOnUiThread(() -> { if (!isDestroyed()) SharePicker.label(rows, getString(R.string.share_outbox_failed)); }); }
        });
    }
    private void pick(JSONObject row, WorkspaceOrigin origin) {
        SharePicker.Selection[] selected = {null}; AlertDialog[] shown = {null};
        SharePicker picker = new SharePicker(this, services, origin, value -> {
            selected[0] = value;
            if (shown[0] != null) shown[0].getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(value != null);
        });
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle(R.string.share_outbox_target).setView(picker)
            .setPositiveButton(R.string.share_send, (d, w) -> { if (selected[0] != null) retry(row, origin, selected[0].bot, selected[0].thread); }).create();
        dialog.setOnDismissListener(d -> picker.close()); dialog.show(); shown[0] = dialog;
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(selected[0] != null);
    }
    private void retry(JSONObject row, WorkspaceOrigin origin, String bot, String thread) {
        services.io.execute(() -> {
            try {
                JSONObject next = services.outbox.resend(row.optString("shareId"), origin, bot, thread);
                services.remember(origin, bot, thread); services.send(next.optString("shareId"), origin);
                refresh();
            } catch (Exception failed) { runOnUiThread(() -> { if (!isDestroyed()) SharePicker.label(rows, getString(R.string.share_outbox_failed)); }); }
        });
    }
}
