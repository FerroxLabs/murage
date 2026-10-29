package com.murage.mobile;

import com.murage.mobile.shell.PhoneJobsContract;
import java.util.*;
import java.util.function.Consumer;
import org.json.*;

final class PhoneCalendarExecutor implements PhoneExecutorSupport.Module {
    interface Access {
        String access();
        List<JSONObject> events(long start, long end, boolean notes) throws Exception;
        String add(PhoneJobsContract.CalendarAddArgs args, PhoneJobRunner.Cancellation cancellation) throws Exception;
        String change(PhoneJobsContract.CalendarChangeArgs args, PhoneJobRunner.Cancellation cancellation) throws Exception;
    }
    private final Access os; private final PhoneOperationLedger ledger;
    PhoneCalendarExecutor(Access os, PhoneOperationLedger ledger) { this.os = os; this.ledger = ledger; }
    public void run(String operationId, String action, PhoneJobsContract.Args args, boolean precise, PhoneJobRunner.Cancellation cancellation, Consumer<PhoneJobRunner.Execution> done) throws Exception {
        cancellation.check();
        String access = os.access(); PhoneExecutorSupport.require(access != null);
        JSONObject result;
        if (args instanceof PhoneJobsContract.CalendarAddArgs) {
            String id = ledger.perform(operationId, () -> { cancellation.check(); return os.add((PhoneJobsContract.CalendarAddArgs) args, cancellation); });
            result = PhoneJobRunner.json("id", id, "writeOnly", "write-only".equals(access));
        } else {
            PhoneExecutorSupport.require("full".equals(access));
            if (args instanceof PhoneJobsContract.CalendarChangeArgs) {
                result = PhoneJobRunner.json("id", ledger.perform(operationId, () -> { cancellation.check(); return os.change((PhoneJobsContract.CalendarChangeArgs) args, cancellation); }));
            } else if (args instanceof PhoneJobsContract.CalendarReadArgs) {
                PhoneJobsContract.CalendarReadArgs a = (PhoneJobsContract.CalendarReadArgs) args;
                boolean notes = Boolean.TRUE.equals(a.includeNotes);
                List<JSONObject> rows = os.events(PhoneExecutorSupport.time(a.start), PhoneExecutorSupport.time(a.end), notes);
                PhoneExecutorSupport.require("full".equals(os.access()));
                int limit = a.limit == null ? 200 : a.limit; JSONArray events = new JSONArray();
                for (JSONObject row : rows.subList(0, Math.min(limit, rows.size()))) {
                    JSONObject event = PhoneExecutorSupport.trim(row, "id", 256, "title", 500, "start", -1, "end", -1, "allDay", -1, "calendar", 200, "location", 500);
                    if (notes && row.has("notes")) event.put("notes", PhoneExecutorSupport.text(row.opt("notes"), 4000));
                    events.put(event);
                }
                result = PhoneJobRunner.json("events", events, "truncated", rows.size() > limit);
            } else if (args instanceof PhoneJobsContract.CalendarFreeTimeArgs) {
                PhoneJobsContract.CalendarFreeTimeArgs a = (PhoneJobsContract.CalendarFreeTimeArgs) args;
                long start = PhoneExecutorSupport.time(a.start), end = PhoneExecutorSupport.time(a.end);
                List<long[]> busy = new ArrayList<>();
                for (JSONObject row : os.events(start, end, false)) busy.add(new long[]{PhoneExecutorSupport.time(row.getString("start")), PhoneExecutorSupport.time(row.getString("end"))});
                PhoneExecutorSupport.require("full".equals(os.access()));
                busy.sort(Comparator.comparingLong(r -> r[0])); busy.add(new long[]{end, end});
                long cursor = start; int limit = a.limit == null ? 20 : a.limit; JSONArray slots = new JSONArray();
                for (long[] range : busy) {
                    long stop = Math.min(range[0], end);
                    if (stop - cursor >= a.durationMinutes * 60000L && slots.length() < limit)
                        slots.put(PhoneJobRunner.json("start", PhoneExecutorSupport.time(cursor), "end", PhoneExecutorSupport.time(stop)));
                    cursor = Math.min(end, Math.max(cursor, range[1]));
                }
                result = PhoneJobRunner.json("slots", slots);
            } else throw new PhoneExecutorSupport.Failure("unsupported");
        }
        done.accept(PhoneExecutorSupport.result(action, result));
    }
}
