package com.murage.mobile;

import android.content.*;
import android.view.View;
import android.widget.*;
import androidx.appcompat.app.AppCompatActivity;
import com.murage.mobile.shell.*;
import java.util.*;
import java.util.function.Consumer;

/** Native picker shared by the sheet and an explicit outbox redirect. */
final class SharePicker extends LinearLayout {
    static final class Selection {
        final WorkspaceOrigin origin; final String bot, thread, name;
        Selection(WorkspaceOrigin origin, String bot, String thread, String name) {
            this.origin = origin; this.bot = bot; this.thread = thread; this.name = name;
        }
    }
    private final AppCompatActivity activity;
    private final PhoneShareServices services;
    private final Consumer<Selection> changed;
    private final WorkspaceOrigin fixedOrigin;
    private final Set<String> opened = new HashSet<>(), removed = new HashSet<>();
    private WorkspaceOrigin origin;
    private int generation;
    private boolean closed, enabled = true;
    private final Consumer<WorkspaceOrigin> removal;
    private LinearLayout targetRows;
    SharePicker(AppCompatActivity activity, PhoneShareServices services, WorkspaceOrigin fixedOrigin, Consumer<Selection> changed) {
        super(activity); this.activity = activity; this.services = services; this.fixedOrigin = fixedOrigin; this.changed = changed;
        setOrientation(VERTICAL);
        removal = origin -> activity.runOnUiThread(() -> { if (!closed) { removed.add(origin.serialized()); reload(); } });
        services.removalListeners.add(removal);
        reload();
    }
    void close() { closed = true; generation++; services.removalListeners.remove(removal); }
    void reload() {
        if (closed) return;
        generation++; changed.accept(null); removeAllViews();
        List<WorkspaceBook.Entry> computers = new ArrayList<>();
        for (WorkspaceBook.Entry entry : services.computers()) if (!removed.contains(entry.origin)
            && (fixedOrigin == null || fixedOrigin.serialized().equals(entry.origin))) computers.add(entry);
        if (computers.isEmpty()) { setup(this, R.string.share_setup); return; }
        SharedPreferences prefs = activity.getSharedPreferences("phone_share_choices", Context.MODE_PRIVATE);
        WorkspaceBook book = services.book();
        String last = origin == null ? prefs.getString("origin", book == null ? null : book.active()) : origin.serialized();
        int selected = 0;
        for (int i = 0; i < computers.size(); i++) if (computers.get(i).origin.equals(last)) selected = i;
        if (computers.size() > 1) {
            label(this, activity.getString(R.string.share_from)); Spinner from = new Spinner(activity);
            List<String> names = new ArrayList<>(); for (WorkspaceBook.Entry e : computers) names.add(e.name);
            from.setAdapter(adapter(names)); from.setSelection(selected); addView(from);
            from.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
                public void onNothingSelected(AdapterView<?> parent) { }
                public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                    WorkspaceOrigin next = WorkspaceOrigin.parse(computers.get(position).origin);
                    if (!next.equals(origin)) select(next);
                }
            });
        }
        targetRows = new LinearLayout(activity); targetRows.setOrientation(VERTICAL); addView(targetRows);
        select(WorkspaceOrigin.parse(computers.get(selected).origin));
        setEnabled(enabled);
    }
    private ArrayAdapter<String> adapter(List<String> values) {
        ArrayAdapter<String> adapter = new ArrayAdapter<>(activity, android.R.layout.simple_spinner_item, values);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item); return adapter;
    }
    private void select(WorkspaceOrigin next) {
        origin = next; int request = ++generation; changed.accept(null);
        apply(services.targets.initial(next, System.currentTimeMillis()));
        services.io.execute(() -> {
            ShareTargets.Result result = services.targets.open(next, System.currentTimeMillis(), opened);
            activity.runOnUiThread(() -> { if (!closed && request == generation) apply(result); });
        });
    }
    private void apply(ShareTargets.Result result) {
        changed.accept(null); targetRows.removeAllViews();
        if (removed.contains(origin.serialized()) || services.access.current(origin) == null) { setup(targetRows, R.string.share_setup); return; }
        if (result.state == ShareTargets.State.LOADING) { targetRows.addView(new ProgressBar(activity)); return; }
        if (result.state != ShareTargets.State.READY) { setup(targetRows, result.state == ShareTargets.State.UPDATE ? R.string.share_update : R.string.share_setup); return; }
        label(targetRows, activity.getString(R.string.share_to));
        List<String> labels = new ArrayList<>(); List<Selection> options = new ArrayList<>();
        for (PhoneAskContract.TargetBot bot : result.targets.bots) {
            labels.add(activity.getString(R.string.share_new, bot.name)); options.add(new Selection(origin, bot.id, "new", bot.name));
        }
        for (PhoneAskContract.RecentTarget recent : result.targets.recent) {
            if (!ShareTargets.contains(result.targets, recent.botId, recent.threadId)) continue;
            String name = recent.botId;
            for (PhoneAskContract.TargetBot bot : result.targets.bots) if (bot.id.equals(recent.botId)) name = bot.name;
            labels.add(activity.getString(R.string.share_recent) + ": " + recent.title);
            options.add(new Selection(origin, recent.botId, recent.threadId, name));
        }
        SharedPreferences prefs = activity.getSharedPreferences("phone_share_choices", Context.MODE_PRIVATE);
        String workspace = ShareFiles.workspace(origin), bot = prefs.getString(workspace + ".bot", null), thread = prefs.getString(workspace + ".thread", null);
        int selected = 0;
        for (int i = 0; i < options.size(); i++) if (options.get(i).bot.equals(bot) && options.get(i).thread.equals(thread)) selected = i;
        Spinner to = new Spinner(activity); to.setAdapter(adapter(labels)); to.setSelection(selected); targetRows.addView(to);
        changed.accept(options.get(selected));
        to.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            public void onNothingSelected(AdapterView<?> parent) { changed.accept(null); }
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) { changed.accept(options.get(position)); }
        });
        setEnabled(enabled);
    }
    private void setup(LinearLayout rows, int message) {
        label(rows, activity.getString(message)); Button open = new Button(activity); open.setText(R.string.share_open);
        open.setOnClickListener(v -> { activity.startActivity(new Intent(activity, MainActivity.class)); activity.finish(); }); rows.addView(open);
    }
    static TextView label(LinearLayout parent, String text) {
        TextView label = new TextView(parent.getContext()); label.setText(text); parent.addView(label); return label;
    }
    @Override public void setEnabled(boolean value) { enabled = value; super.setEnabled(value); enableChildren(this, value); }
    private static void enableChildren(android.view.ViewGroup group, boolean enabled) {
        for (int i = 0; i < group.getChildCount(); i++) {
            View child = group.getChildAt(i); child.setEnabled(enabled);
            if (child instanceof android.view.ViewGroup) enableChildren((android.view.ViewGroup) child, enabled);
        }
    }
}
