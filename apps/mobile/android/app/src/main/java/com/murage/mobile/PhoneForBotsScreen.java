package com.murage.mobile;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.SwitchCompat;
import com.murage.mobile.shell.ProbeVerdict;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Native per-workspace screen and foreground registration owner. */
final class PhoneForBotsScreen {
    private final AppCompatActivity activity;
    private final WorkspaceOrigin workspace;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final PhoneJobsSigner.EnrolledKey key;
    private final PhoneJobsMintClient mint;
    private final PhonePermissions permissions;
    final PhoneForBotsModel model;
    private AlertDialog dialog;
    private LinearLayout rows;
    private TextView status;
    private boolean working, closed;
    private String problem;

    PhoneForBotsScreen(AppCompatActivity activity, WorkspaceOrigin workspace) {
        this.activity = activity; this.workspace = workspace;
        permissions = new PhonePermissions(activity);
        PhoneJobServices.get(activity).attach(activity, permissions);
        key = new PhoneJobsSigner.EnrolledKey(activity);
        PhoneJobsTokenStore tokens = new PhoneJobsTokenStore(activity);
        PhoneJobsSigner signer = new PhoneJobsSigner(key);
        mint = new PhoneJobsMintClient(signer, tokens, new PhoneJobsMintHTTP(Shell.USER_AGENT_TOKEN),
            io, activity::runOnUiThread, System::currentTimeMillis);
        model = new PhoneForBotsModel(workspace, new PhoneConsentStore(activity), new PhoneForBotsModel.Tokens() {
            @Override public String read() { return tokens.readForRunner(workspace); }
            @Override public void remove() { if (!tokens.remove(workspace)) throw new IllegalStateException(); }
        }, done -> mint.mint(workspace, new PhoneJobsMintClient.Completion() {
            @Override public void complete() { done.finish(null); }
            @Override public void failed(PhoneJobsMintClient.Failure failure) {
                done.finish(new Exception(activity.getString(failure.messageResource)));
            }
        }), this::available, permissions, () -> new JSONObject()
            .put("name", Build.MODEL.substring(0, Math.min(Build.MODEL.length(), 80))).put("platform", "android")
            .put("osVersion", Build.VERSION.RELEASE).put("appVersion", BuildConfig.VERSION_NAME)
            .put("timeZone", TimeZone.getDefault().getID()),
            (method, token, body, done) -> PhoneJobServices.get(activity).registration(workspace, method, token, body, done));
    }
    private void available(PhoneForBotsModel.Done done) {
        if (key.point(workspace) == null) { done.finish(new Exception(activity.getString(R.string.phone_no_key))); return; }
        io.execute(() -> {
            ProbeVerdict verdict = ProbeClient.probe(workspace, Shell.USER_AGENT_TOKEN);
            activity.runOnUiThread(() -> {
                if (closed) { done.finish(new IllegalStateException()); return; }
                done.finish(verdict.phoneJobsOk() ? null : new Exception(activity.getString(
                    verdict.phoneFlagsOk() ? R.string.phone_turned_off : R.string.phone_update)));
            });
        });
    }
    void present() {
        if (closed || dialog != null) return;
        rows = new LinearLayout(activity); rows.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (20 * activity.getResources().getDisplayMetrics().density);
        rows.setPadding(pad, pad, pad, pad);
        ScrollView scroll = new ScrollView(activity); scroll.addView(rows);
        dialog = new AlertDialog.Builder(activity).setTitle(R.string.phone_for_bots).setView(scroll)
            .setPositiveButton(R.string.phone_done, (d, which) -> {}).create();
        dialog.setOnDismissListener(d -> { dialog = null; rows = null; status = null; });
        dialog.show();
        render();
        available(error -> { problem = error == null ? null : error.getMessage(); render(); });
    }
    void refresh() {
        if (closed) return;
        model.refresh(error -> { if (error != null) problem = activity.getString(R.string.phone_failed); render(); });
    }
    void render() {
        if (rows == null) return;
        rows.removeAllViews();
        PhoneForBotsModel.Consent consent;
        try { consent = model.state(); } catch (Exception e) {
            consent = new PhoneForBotsModel.Consent(); problem = activity.getString(R.string.phone_failed);
        }
        addRow("master", R.string.phone_for_bots, consent.enabled, true);
        int[] labels = {R.string.phone_calendar, R.string.phone_contacts, R.string.phone_location,
            R.string.phone_precise, R.string.phone_alarms, R.string.phone_messages, R.string.phone_calls};
        for (int i = 0; i < PhoneForBotsModel.ROWS.length; i++) {
            String row = PhoneForBotsModel.ROWS[i];
            addRow(row, labels[i], consent.rows.contains(row), consent.enabled);
            if (consent.rows.contains(row) && permissions.value(row) == null) {
                Button settings = new Button(activity); settings.setText(R.string.phone_settings);
                settings.setOnClickListener(v -> activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + activity.getPackageName()))));
                rows.addView(settings);
            }
        }
        status = new TextView(activity); status.setText(problem); rows.addView(status);
        Button outbox = new Button(activity); outbox.setText(R.string.share_outbox_waiting);
        outbox.setOnClickListener(v -> activity.startActivity(new Intent(activity, ShareOutboxActivity.class))); rows.addView(outbox);
        PhoneAskSetup.addAssistantRows(activity, rows);
        if (dialog != null) { dialog.setCancelable(!working); dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(!working); }
    }
    private void addRow(String row, int label, boolean checked, boolean enabled) {
        SwitchCompat toggle = new SwitchCompat(activity); toggle.setText(label); toggle.setChecked(checked); toggle.setEnabled(enabled && !working);
        rows.addView(toggle, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        toggle.setOnCheckedChangeListener((button, on) -> {
            working = true; render();
            PhoneForBotsModel.Done done = error -> {
                working = false;
                problem = error == null ? null : error.getMessage() == null ? activity.getString(R.string.phone_failed) : error.getMessage();
                render();
            };
            if ("master".equals(row)) model.setMaster(on, answer -> PhoneDataSharingSheet.show(activity, null, answer), done);
            else model.setRow(row, on, done);
        });
    }
    void close() {
        closed = true; mint.cancel(); key.cancel();
        if (dialog != null) dialog.dismiss();
        io.shutdownNow();
    }
}
