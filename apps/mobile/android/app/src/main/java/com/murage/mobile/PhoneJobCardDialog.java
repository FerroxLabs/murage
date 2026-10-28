package com.murage.mobile;

import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.appcompat.app.AlertDialog;

/** Owned by WorkspaceActivity; plain native widgets never pass through a WebView. */
final class PhoneJobCardDialog {
    private final WorkspaceActivity activity;
    private final AlertDialog dialog;
    private final LinearLayout content;
    private PhoneJobCardModel model;

    PhoneJobCardDialog(WorkspaceActivity activity, PhoneJobCardModel model) {
        this.activity = activity; this.model = model;
        content = new LinearLayout(activity); content.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(24 * activity.getResources().getDisplayMetrics().density);
        content.setPadding(padding, padding, padding, padding);
        ScrollView scroll = new ScrollView(activity); scroll.addView(content);
        dialog = new AlertDialog.Builder(activity).setView(scroll).setCancelable(false).create();
        render();
    }
    void show() { dialog.show(); }
    void dismiss() { model.dismiss(); dialog.dismiss(); }
    void replace(PhoneJobCardModel next) { model.dismiss(); model = next; render(); }
    private void render() {
        content.removeAllViews();
        PhoneJobCardModel displayed = model;
        switch (model.state()) {
            case OFFER: case WAITING:
                label(model.bot, 22);
                label(activity.getString(capability(model.capability, false)), 18);
                if (model.workspace != null) label(model.workspace, 14);
                label(model.say, 16);
                for (String destination : model.destinations) label(destination, 16);
                for (PhoneJobCardModel.Detail detail : model.details) {
                    String value = detail.localized ? detailString("phone_detail_" + detail.value.substring(1)) : detail.value;
                    label(detailString(detail.key) + ": " + value, 16);
                }
                Button allow = button(R.string.phone_allow, v -> choose(displayed, true));
                Button notNow = button(R.string.phone_not_now, v -> choose(displayed, false));
                allow.setEnabled(model.state() == PhoneJobCardModel.State.OFFER);
                notNow.setEnabled(model.state() == PhoneJobCardModel.State.OFFER);
                break;
            case USED:
                label(activity.getString(R.string.phone_job_used, model.bot,
                    activity.getString(capability(model.capability, true))), 14);
                if (model.workspace != null) label(model.workspace, 14);
                button(R.string.phone_done, v -> displayed.close());
                break;
            case HANDLED:
                label(activity.getString(R.string.phone_job_handled), 18);
                button(R.string.phone_done, v -> displayed.close());
                break;
            case DISMISSED: break;
        }
    }
    private String detailString(String key) {
        return activity.getString(activity.getResources().getIdentifier(key, "string", activity.getPackageName()));
    }
    private void choose(PhoneJobCardModel displayed, boolean allow) {
        if (model != displayed) return;
        model.choose(allow); render();
    }
    private void label(String text, float size) {
        TextView label = new TextView(activity);
        label.setText(text); // String only: no Html, links, or styled spans.
        label.setTextSize(size);
        label.setPadding(0, 0, 0, Math.round(12 * activity.getResources().getDisplayMetrics().density));
        content.addView(label);
    }
    private Button button(int text, View.OnClickListener action) {
        Button button = new Button(activity);
        button.setText(text); button.setOnClickListener(action); content.addView(button);
        return button;
    }
    private static int capability(String value, boolean used) {
        switch (value) {
            case "calendar": return used ? R.string.phone_job_used_calendar : R.string.phone_calendar;
            case "reminders": return used ? R.string.phone_job_used_reminders : R.string.phone_job_reminders;
            case "contacts": return used ? R.string.phone_job_used_contacts : R.string.phone_contacts;
            case "location": return used ? R.string.phone_job_used_location : R.string.phone_location;
            case "alarms": return used ? R.string.phone_job_used_alarms : R.string.phone_alarms;
            case "messages": return used ? R.string.phone_job_used_messages : R.string.phone_messages;
            case "calls": return used ? R.string.phone_job_used_calls : R.string.phone_calls;
            default: throw new IllegalArgumentException("Unknown phone capability");
        }
    }
}
