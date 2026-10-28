package com.murage.mobile;

import android.content.Intent;
import android.os.Bundle;
import android.view.*;
import android.widget.*;
import androidx.appcompat.app.AppCompatActivity;
import com.murage.mobile.shell.*;
import java.util.UUID;
import org.json.JSONObject;

/** Exported native share target. Only an explicit Open button launches the app. */
public final class ShareActivity extends AppCompatActivity {
    private PhoneShareServices services;
    private ShareContent content;
    private SharePicker picker;
    private SharePicker.Selection selection;
    private TextView status;
    private Button send;
    private EditText note;
    private boolean copying, sending, finishAfterCopy;
    private String shareId;
    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        services = PhoneShareServices.get(this);
        services.foreground();
        getWindow().setGravity(Gravity.BOTTOM);
        getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        LinearLayout rows = new LinearLayout(this); rows.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (20 * getResources().getDisplayMetrics().density); rows.setPadding(pad, pad, pad, pad);
        rows.setBackgroundColor(getColor(R.color.murage_canvas));
        ScrollView scroll = new ScrollView(this); scroll.addView(rows); setContentView(scroll);
        SharePicker.label(rows, getString(R.string.share_title)).setTextSize(22);
        status = SharePicker.label(rows, "");
        try { content = new ShareContent(this, getIntent()); }
        catch (Exception invalid) { status.setText(getString(invalid instanceof ShareBody.InputError ? resource(((ShareBody.InputError) invalid).key) : R.string.share_type)); return; }
        TextView preview = SharePicker.label(rows, content.preview); preview.setMaxLines(3);
        if (!content.streams.isEmpty()) {
            // Decode a bounded first-image preview off the UI thread. The URI is never a file path.
            ImageView image = new ImageView(this); image.setAdjustViewBounds(true); image.setMaxHeight(pad * 10); rows.addView(image);
            services.io.execute(() -> {
                try {
                    String mime = getContentResolver().getType(content.streams.get(0));
                    if (!ShareBody.accepts(mime)) throw new ShareBody.InputError("share_type");
                    if (mime.startsWith("image/")) {
                        android.graphics.Bitmap bitmap = android.graphics.ImageDecoder.decodeBitmap(
                            android.graphics.ImageDecoder.createSource(getContentResolver(), content.streams.get(0)),
                            (decoder, info, source) -> {
                                double scale = Math.min(1, 512.0 / Math.max(info.getSize().getWidth(), info.getSize().getHeight()));
                                decoder.setTargetSize(Math.max(1, (int) (info.getSize().getWidth() * scale)), Math.max(1, (int) (info.getSize().getHeight() * scale)));
                            });
                        runOnUiThread(() -> { if (!isDestroyed()) image.setImageBitmap(bitmap); else bitmap.recycle(); });
                    } else if (content.preview == null) {
                        try (android.database.Cursor cursor = getContentResolver().query(content.streams.get(0),
                            new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                            if (cursor != null && cursor.moveToFirst()) {
                                String name = ShareBody.name(cursor.getString(0), 1);
                                runOnUiThread(() -> { if (!isDestroyed()) preview.setText(name); });
                            }
                        }
                    }
                } catch (Exception ignored) { }
            });
        }
        note = new EditText(this); note.setHint(R.string.share_note); note.setMinLines(1); note.setMaxLines(5);
        note.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        note.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(2000)});
        send = new Button(this); send.setText(R.string.share_send); send.setEnabled(false);
        picker = new SharePicker(this, services, null, selected -> { selection = selected; send.setEnabled(selected != null && !sending); });
        rows.addView(picker); rows.addView(note); rows.addView(send);
        send.setOnClickListener(v -> send());
        Button outbox = new Button(this); outbox.setText(R.string.share_outbox_waiting);
        outbox.setOnClickListener(v -> startActivity(new Intent(this, ShareOutboxActivity.class))); rows.addView(outbox);
        if (saved != null && saved.getString("shareId") != null) {
            shareId = saved.getString("shareId"); sending = true; send.setEnabled(false); picker.setEnabled(false);
            status.setText(R.string.share_outbox_waiting); services.foreground();
        }
    }
    private void send() {
        SharePicker.Selection target = selection;
        if (sending || target == null) return;
        if (!services.targets.allows(target.origin, target.bot, target.thread, System.currentTimeMillis())) { picker.reload(); return; }
        String message = note.getText().toString(); shareId = UUID.randomUUID().toString(); String id = shareId;
        long generation = services.generation(target.origin);
        sending = true; copying = true; send.setEnabled(false); picker.setEnabled(false); note.setEnabled(false); status.setText(R.string.share_sending);
        services.io.execute(() -> {
            try {
                ShareBody.prepare(services.root, target.origin, id, target.bot, target.thread, message, content.text, content.url,
                    content.attachments(getContentResolver()), System.currentTimeMillis(),
                    () -> generation == services.generation(target.origin)
                        && services.targets.allows(target.origin, target.bot, target.thread, System.currentTimeMillis()));
                runOnUiThread(() -> { copying = false; if (finishAfterCopy) finish(); });
                services.remember(target.origin, target.bot, target.thread);
                services.send(id, target.origin);
                JSONObject row = services.outbox.state(id);
                boolean hasBody = services.outbox.body(id).isFile();
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    boolean sent = "sent".equals(row.optString("state"));
                    status.setText(sent ? getString(R.string.share_sent, target.name) : "queued".equals(row.optString("state"))
                        ? getString(R.string.share_offline) : getString(resource(ShareOutbox.messageKey(row, hasBody))));
                    if (sent) status.postDelayed(this::finish, 800);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    copying = false;
                    if (isDestroyed()) return;
                    status.setText(resource(error instanceof ShareBody.InputError ? ((ShareBody.InputError) error).key : "share_outbox_failed"));
                    if (finishAfterCopy) finish();
                });
            }
        });
    }
    @Override public void finish() {
        if (copying) { finishAfterCopy = true; return; } // Granted content must be private before returning to the sender.
        super.finish();
    }
    @Override protected void onSaveInstanceState(Bundle state) {
        if (shareId != null) state.putString("shareId", shareId);
        super.onSaveInstanceState(state);
    }
    @Override protected void onDestroy() { if (picker != null) picker.close(); super.onDestroy(); }
    static int resource(String key) {
        switch (key) {
            case "share_ten": return R.string.share_ten;
            case "share_photo_large": return R.string.share_photo_large;
            case "share_file_large": return R.string.share_file_large;
            case "share_type": return R.string.share_type;
            case "share_again": return R.string.share_again;
            case "share_update": return R.string.share_update;
            case "share_outbox_waiting": return R.string.share_outbox_waiting;
            case "share_outbox_sent": return R.string.share_outbox_sent;
            case "share_outbox_target": return R.string.share_outbox_target;
            default: return R.string.share_outbox_failed;
        }
    }
}
