package com.murage.mobile;

import com.murage.mobile.shell.PhoneJobsContract;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.Consumer;

/** Memory-only model. All production access is on the UI thread. */
final class PhoneJobCardModel {
    enum State { OFFER, WAITING, USED, HANDLED, DISMISSED }
    private State state = State.OFFER;
    final String bot, capability, say, workspace;
    final List<String> destinations;
    List<Detail> details = Collections.emptyList();
    static final class Detail {
        final String key, value;
        boolean localized;
        Detail(String key, String value) { this.key = "phone_detail_" + key; this.value = PhoneDataSharingText.plain(value, 4000, 8); }
    }
    private Consumer<Boolean> answer;
    private Runnable closed;

    PhoneJobCardModel(String bot, String capability, String say, String workspace,
                      int enabledWorkspaces, Consumer<Boolean> answer) {
        this(bot, capability, say, workspace, enabledWorkspaces, false, answer);
    }
    PhoneJobCardModel(String bot, String capability, String say, String workspace,
                      int enabledWorkspaces, boolean offscreen, Consumer<Boolean> answer) {
        this(bot, capability, say, workspace, enabledWorkspaces, offscreen, Collections.emptyList(), answer);
    }
    private PhoneJobCardModel(String bot, String capability, String say, String workspace,
                      int enabledWorkspaces, boolean offscreen, List<String> destinations, Consumer<Boolean> answer) {
        this.bot = PhoneDataSharingText.plain(bot, 120, 0);
        this.capability = capability;
        this.say = PhoneDataSharingText.plain(say, 240, 2);
        this.workspace = (enabledWorkspaces > 1 || offscreen) ? PhoneDataSharingText.plain(workspace, 120, 0) : null;
        this.answer = answer;
        // Already validated; approval must preserve every byte.
        this.destinations = Collections.unmodifiableList(new ArrayList<>(destinations));
    }
    PhoneJobCardModel(PhoneJobsContract.Offer offer, int enabledWorkspaces, Consumer<Boolean> answer) {
        this(offer, enabledWorkspaces, false, answer);
    }
    PhoneJobCardModel(PhoneJobsContract.Offer offer, int count, boolean offscreen, Consumer<Boolean> answer) {
        this(offer.bot.name, offer.capability, offer.say, offer.workspace, count, offscreen, destinations(offer), answer);
        details = details(offer.decodedArgs(), null);
    }
    private static List<String> destinations(PhoneJobsContract.Offer offer) {
        PhoneJobsContract.Args args = offer.decodedArgs();
        if (args instanceof PhoneJobsContract.CallsDialArgs)
            return Collections.singletonList(((PhoneJobsContract.CallsDialArgs) args).number);
        if (args instanceof PhoneJobsContract.MessagesComposeArgs)
            return ((PhoneJobsContract.MessagesComposeArgs) args).to;
        return Collections.emptyList();
    }
    PhoneJobCardModel(PhoneJobsContract.Offer offer, PhoneJobsContract.Args args, String currentTitle, int count, Consumer<Boolean> answer) {
        this(offer.bot.name, offer.capability, offer.say, offer.workspace, count, false, destinations(args), answer);
        details = details(args, currentTitle);
    }
    private static List<String> destinations(PhoneJobsContract.Args args) {
        if (args instanceof PhoneJobsContract.CallsDialArgs) return Collections.singletonList(((PhoneJobsContract.CallsDialArgs) args).number);
        if (args instanceof PhoneJobsContract.MessagesComposeArgs) return ((PhoneJobsContract.MessagesComposeArgs) args).to;
        return Collections.emptyList();
    }
    private static void add(List<Detail> rows, String key, String value) { if (value != null) rows.add(new Detail(key, value)); }
    static List<Detail> details(PhoneJobsContract.Args args, String currentTitle) {
        List<Detail> rows = new ArrayList<>();
        if (args instanceof PhoneJobsContract.CalendarAddArgs) {
            PhoneJobsContract.CalendarAddArgs a = (PhoneJobsContract.CalendarAddArgs) args;
            add(rows, "title", a.title); add(rows, "start", a.start); add(rows, "end", a.end);
            add(rows, "all_day", Boolean.TRUE.equals(a.allDay) ? "@yes" : "@no");
            add(rows, "location", a.location); add(rows, "notes", a.notes);
        } else if (args instanceof PhoneJobsContract.CalendarChangeArgs) {
            PhoneJobsContract.CalendarChangeArgs a = (PhoneJobsContract.CalendarChangeArgs) args;
            add(rows, "current_item", currentTitle); add(rows, "id", a.id); add(rows, "title", a.title);
            add(rows, "start", a.start); add(rows, "end", a.end); add(rows, "location", a.location); add(rows, "notes", a.notes);
        } else if (args instanceof PhoneJobsContract.RemindersAddArgs) {
            PhoneJobsContract.RemindersAddArgs a = (PhoneJobsContract.RemindersAddArgs) args;
            add(rows, "title", a.title); add(rows, "due", a.due == null ? "@none" : a.due); add(rows, "notes", a.notes);
        } else if (args instanceof PhoneJobsContract.RemindersCompleteArgs) {
            add(rows, "current_item", currentTitle); add(rows, "id", ((PhoneJobsContract.RemindersCompleteArgs) args).id); add(rows, "completed", "@yes");
        } else if (args instanceof PhoneJobsContract.AlarmsSetArgs) {
            PhoneJobsContract.AlarmsSetArgs a = (PhoneJobsContract.AlarmsSetArgs) args;
            add(rows, "time", String.format(java.util.Locale.ROOT, "%02d:%02d", a.hour, a.minute)); add(rows, "label", a.label);
        } else if (args instanceof PhoneJobsContract.AlarmsTimerArgs) {
            PhoneJobsContract.AlarmsTimerArgs a = (PhoneJobsContract.AlarmsTimerArgs) args;
            add(rows, "seconds", String.valueOf(a.seconds)); add(rows, "label", a.label);
        } else if (args instanceof PhoneJobsContract.MessagesComposeArgs) add(rows, "message", ((PhoneJobsContract.MessagesComposeArgs) args).body);
        for (Detail d : rows) d.localized = d.key.equals("phone_detail_all_day") || d.key.equals("phone_detail_completed")
            || (d.key.equals("phone_detail_due") && args instanceof PhoneJobsContract.RemindersAddArgs && ((PhoneJobsContract.RemindersAddArgs) args).due == null);
        return Collections.unmodifiableList(rows);
    }
    static boolean matches(WorkspaceOrigin job, WorkspaceOrigin onScreen) {
        return job != null && job.equals(onScreen);
    }
    State state() { return state; }
    void choose(boolean allow) {
        if (state != State.OFFER || answer == null) return;
        Consumer<Boolean> callback = answer;
        state = State.WAITING; answer = null;
        callback.accept(allow);
    }
    void complete(Runnable closed) {
        if (state == State.DISMISSED) return;
        state = State.USED; answer = null; this.closed = closed;
    }
    void alreadyHandled(Runnable closed) {
        if (state == State.DISMISSED) return;
        state = State.HANDLED; answer = null; this.closed = closed;
    }
    void close() {
        if (state != State.USED && state != State.HANDLED) return;
        Runnable callback = closed;
        dismiss(); if (callback != null) callback.run();
    }
    void dismiss() { state = State.DISMISSED; answer = null; closed = null; }
}
