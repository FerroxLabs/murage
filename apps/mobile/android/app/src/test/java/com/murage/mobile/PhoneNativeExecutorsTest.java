package com.murage.mobile;

import static org.junit.Assert.*;
import android.content.Intent;
import android.provider.AlarmClock;
import com.murage.mobile.shell.PhoneJobsContract;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.function.Consumer;
import org.json.*;
import org.junit.Test;

public final class PhoneNativeExecutorsTest {
    static final class Memory implements PhoneOperationLedger.Storage {
        byte[] bytes; boolean fail; Runnable beforeWrite = () -> {};
        public byte[] read() throws Exception { if (fail) throw new Exception(); return bytes; }
        public void write(byte[] data) throws Exception { beforeWrite.run(); if (fail) throw new Exception(); bytes = data.clone(); }
    }
    static final class CalendarFake implements PhoneCalendarExecutor.Access {
        String access = "full"; int writes; boolean notes, revoke; List<JSONObject> rows = new ArrayList<>();
        public String access() { return access; }
        public List<JSONObject> events(long start, long end, boolean notes) { this.notes = notes; if (revoke) access = null; return rows; }
        public String add(PhoneJobsContract.CalendarAddArgs a, PhoneJobRunner.Cancellation cancellation) { writes++; return "event-1"; }
        public String change(PhoneJobsContract.CalendarChangeArgs a, PhoneJobRunner.Cancellation cancellation) { writes++; return a.id; }
    }
    static final class ContactsFake implements PhoneContactsExecutor.Access {
        boolean granted = true, revoke; List<JSONObject> rows = new ArrayList<>();
        public boolean granted() { return granted; }
        public List<JSONObject> search(String query, int limit) { if (revoke) granted = false; return rows; }
        public JSONObject get(String id) { for (JSONObject row : rows) if (id.equals(row.optString("id"))) return row; return null; }
    }
    static final class LocationFake implements PhoneLocationExecutor.Access {
        boolean granted = true, precise = true, requestedPrecise, revoke, hold; Consumer<PhoneLocationExecutor.Fix> pending;
        public void cancel() { Consumer<PhoneLocationExecutor.Fix> callback = pending; pending = null; if (callback != null) callback.accept(null); }
        public boolean granted() { return granted; }
        public boolean precise() { return precise; }
        public void current(boolean precise, Consumer<PhoneLocationExecutor.Fix> done) {
            requestedPrecise = precise; if (revoke) granted = false;
            if (hold) { pending = done; return; }
            done.accept(new PhoneLocationExecutor.Fix(37.77491, -122.41942, 12.5, 1790000000000L));
        }
    }
    static final class IntentsFake implements PhoneSystemIntents {
        boolean supported = true, revoked; List<Request> opened = new ArrayList<>();
        Runnable onResolve = () -> {};
        public boolean resolves(String action, String scheme) { onResolve.run(); return supported; }
        public void open(Request request) throws Exception { if (revoked) throw new SecurityException(); opened.add(request); }
    }
    static final class Rig {
        final Memory memory = new Memory(); final CalendarFake calendar = new CalendarFake(); final ContactsFake contacts = new ContactsFake();
        final LocationFake location = new LocationFake(); final IntentsFake intents = new IntentsFake(); long now = 1790000000000L;
        final PhoneOperationLedger ledger = new PhoneOperationLedger(memory, () -> now);
        final NativePhoneJobExecutors registry;
        Rig() {
            Map<String, PhoneExecutorSupport.Module> modules = new HashMap<>();
            modules.put("calendar", new PhoneCalendarExecutor(calendar, ledger)); modules.put("reminders", new PhoneRemindersExecutor());
            modules.put("contacts", new PhoneContactsExecutor(contacts)); modules.put("location", new PhoneLocationExecutor(location));
            modules.put("alarms", new PhoneAlarmsExecutor(intents, ledger)); modules.put("messages", new PhoneMessagesExecutor(intents)); modules.put("calls", new PhoneCallsExecutor(intents));
            registry = new NativePhoneJobExecutors(modules);
        }
        PhoneJobRunner.Execution run(String action, JSONObject args) { return run(action, args, UUID.randomUUID().toString(), false); }
        PhoneJobRunner.Execution run(String action, JSONObject args, String id, boolean precise) {
            PhoneJobsContract.Args decoded = PhoneJobsContract.Args.parse(action, args); assertNotNull(action, decoded);
            PhoneJobRunner.Execution[] answer = new PhoneJobRunner.Execution[1];
            registry.run(id, action.substring(0, action.indexOf('.')), action, decoded, precise, new PhoneJobRunner.Cancellation(), result -> { assertNull(answer[0]); answer[0] = result; });
            assertNotNull(answer[0]); return answer[0];
        }
    }
    static JSONObject fixture() throws Exception {
        Path path = Paths.get("").toAbsolutePath();
        while (path != null) {
            Path file = path.resolve("contract/phone-jobs.json");
            if (Files.exists(file)) return new JSONObject(new String(Files.readAllBytes(file), StandardCharsets.UTF_8)).getJSONObject("actions");
            path = path.getParent();
        }
        throw new AssertionError("phone-jobs fixture missing");
    }
    static JSONObject output(PhoneJobRunner.Execution execution, String action) {
        assertNull(action + ": " + execution.code, execution.code); assertNotNull(execution.result);
        JSONObject value = execution.result.encode(); assertNotNull(value);
        assertNotNull(PhoneJobsContract.Result.parse(action, value)); assertTrue(PhoneJobsContract.withinResultBound(value)); return value;
    }
    static JSONObject event() { return PhoneJobRunner.json("id", "event-1", "title", "Meeting", "start", "2026-10-27T09:00:00Z", "end", "2026-10-27T10:00:00Z", "allDay", false, "calendar", "Work", "notes", "Only when asked", "private", true); }
    static JSONObject contact() { return PhoneJobRunner.json("id", "c-1", "name", "Sam", "phones", new JSONArray().put(PhoneJobRunner.json("number", "+15555550100", "private", true)), "emails", new JSONArray().put(PhoneJobRunner.json("address", "sam@example.test", "private", true)), "birthday", "private"); }
    static JSONObject first(JSONObject fixtures, String action) throws Exception { return fixtures.getJSONObject(action).getJSONArray("validArgs").getJSONObject(0); }
    static String repeat(String text, int count) { StringBuilder out = new StringBuilder(); for (int i = 0; i < count; i++) out.append(text); return out.toString(); }

    @Test public void forbiddenDialCharactersDeclineWithoutOpening() {
        for (String character : new String[]{":", "/", "?", "&", "%", ";", ",", "@", "a", "\n", "\t", "\u202e", "\u00a0", "١"}) {
            Rig r = new Rig();
            r.intents.onResolve = () -> fail("Invalid number reached the dialer");
            assertEquals("denied", r.run("calls.dial", PhoneJobRunner.json("number", "+123" + character + "4")).code);
            assertTrue(r.intents.opened.isEmpty());
        }
    }
    @Test public void cancelledDialJobNeverOpensIncludingCancellationDuringResolution() {
        for (boolean cancelDuringResolution : new boolean[]{false, true}) {
            Rig r = new Rig(); PhoneJobRunner.Cancellation signal = new PhoneJobRunner.Cancellation();
            if (cancelDuringResolution) r.intents.onResolve = signal::cancel;
            else signal.cancel();
            PhoneJobRunner.Execution[] result = new PhoneJobRunner.Execution[1];
            r.registry.run(UUID.randomUUID().toString(), "calls", "calls.dial", new PhoneJobsContract.CallsDialArgs("+123"), false, signal, value -> result[0] = value);
            assertNotNull(result[0]); assertEquals("denied", result[0].code);
            assertTrue(r.intents.opened.isEmpty());
        }
    }
    @Test public void allowedDialPunctuationIsPassedToSystemUnchanged() {
        Rig r = new Rig(); String number = "+1 (555) 010-20.30";
        output(r.run("calls.dial", PhoneJobRunner.json("number", number)), "calls.dial");
        assertEquals(1, r.intents.opened.size());
        assertEquals(Intent.ACTION_DIAL, r.intents.opened.get(0).action);
        assertEquals("tel", r.intents.opened.get(0).scheme);
        assertEquals(number, r.intents.opened.get(0).recipient);
    }

    @Test public void cancellationDuringLedgerSavePreventsEveryOSWrite() throws Exception {
        JSONObject actions = fixture();
        for (String action : Arrays.asList("calendar.add", "calendar.change", "alarms.set", "alarms.timer")) {
            Rig r = new Rig(); PhoneJobRunner.Cancellation signal = new PhoneJobRunner.Cancellation();
            r.memory.beforeWrite = signal::cancel;
            PhoneJobsContract.Args args = PhoneJobsContract.Args.parse(action, first(actions, action));
            assertNotNull(args);
            PhoneJobRunner.Execution[] result = new PhoneJobRunner.Execution[1];
            r.registry.run(UUID.randomUUID().toString(), action.substring(0, action.indexOf('.')), action, args, false, signal, value -> result[0] = value);
            assertNotNull(result[0]); assertEquals("denied", result[0].code);
            assertEquals(0, r.calendar.writes); assertTrue(r.intents.opened.isEmpty());
        }
    }

    @Test public void everyValidActionVectorPassesN1OrAndroidRemindersUnsupported() throws Exception {
        JSONObject fixtures = fixture(); int count = 0;
        for (Iterator<String> keys = fixtures.keys(); keys.hasNext();) {
            String action = keys.next(); if ("note".equals(action)) continue; count++;
            JSONArray args = fixtures.getJSONObject(action).getJSONArray("validArgs");
            for (int i = 0; i < args.length(); i++) {
                Rig r = new Rig(); r.calendar.rows.add(event()); r.contacts.rows.add(contact());
                PhoneJobRunner.Execution result = r.run(action, args.getJSONObject(i), UUID.randomUUID().toString(), true);
                if (action.startsWith("reminders.")) assertEquals("unsupported", result.code); else output(result, action);
            }
        }
        assertEquals(14, count);
    }
    @Test public void trimmingLimitsAndNotesOnlyWhenAsked() throws Exception {
        Rig r = new Rig(); r.calendar.rows.add(event()); r.calendar.rows.add(event());
        JSONObject args = first(fixture(), "calendar.read"); args.put("limit", 1);
        JSONObject result = output(r.run("calendar.read", args), "calendar.read");
        assertTrue(result.getBoolean("truncated")); JSONObject row = result.getJSONArray("events").getJSONObject(0);
        assertFalse(row.has("private")); assertFalse(row.has("notes")); assertFalse(r.calendar.notes);
        args.put("includeNotes", true);
        assertEquals("Only when asked", output(r.run("calendar.read", args), "calendar.read").getJSONArray("events").getJSONObject(0).getString("notes"));
        JSONObject person = contact(); person.put("name", repeat("😀", 150));
        JSONArray phones = new JSONArray(); for (int i = 0; i < 15; i++) phones.put(PhoneJobRunner.json("number", "+15555550100", "label", repeat("x", 70), "private", true)); person.put("phones", phones);
        r.contacts.rows.add(person);
        JSONObject found = output(r.run("contacts.search", PhoneJobRunner.json("query", "Sam")), "contacts.search");
        JSONObject c = found.getJSONArray("contacts").getJSONObject(0);
        assertFalse(c.has("birthday")); assertEquals(200, c.getString("name").length()); assertEquals(10, c.getJSONArray("phones").length());
        assertFalse(c.getJSONArray("phones").getJSONObject(0).has("private")); assertEquals(50, c.getJSONArray("phones").getJSONObject(0).getString("label").length());
        assertTrue(output(r.run("contacts.get", PhoneJobRunner.json("id", "hidden")), "contacts.get").isNull("contact"));
    }
    @Test public void separatePreciseConsentAndOsPermissionRequired() throws Exception {
        for (boolean consent : new boolean[]{false, true}) for (boolean osPrecise : new boolean[]{false, true}) {
            Rig r = new Rig(); r.location.precise = osPrecise; boolean full = consent && osPrecise;
            JSONObject value = output(r.run("location.get", PhoneJobRunner.json("precision", "precise"), UUID.randomUUID().toString(), consent), "location.get");
            assertEquals(full, r.location.requestedPrecise); assertEquals(full ? "precise" : "approximate", value.getString("precision"));
            assertEquals(full ? 37.77491 : 37.775, value.getDouble("lat"), 0.00000001);
            assertEquals(full ? 12.5 : 100, value.getDouble("accuracyMeters"), 0);
        }
    }
    @Test public void composeDialAndClockRequestsNeverSendOrCall() throws Exception {
        Rig r = new Rig();
        output(r.run("messages.compose", PhoneJobRunner.json("to", new JSONArray().put("+15555550100").put("+15555550101"), "body", "Hi & hello")), "messages.compose");
        PhoneSystemIntents.Request text = r.intents.opened.get(0);
        assertEquals(Intent.ACTION_SENDTO, text.action); assertEquals("smsto", text.scheme); assertEquals("+15555550100;+15555550101", text.recipient); assertEquals("Hi & hello", text.extras.get("sms_body"));
        output(r.run("calls.dial", PhoneJobRunner.json("number", "+15555550100")), "calls.dial");
        PhoneSystemIntents.Request dial = r.intents.opened.get(1);
        assertEquals(Intent.ACTION_DIAL, dial.action); assertEquals("tel", dial.scheme); assertEquals("+15555550100", dial.recipient);
        output(r.run("alarms.set", PhoneJobRunner.json("hour", 8, "minute", 30, "label", "Wake up")), "alarms.set");
        PhoneSystemIntents.Request alarm = r.intents.opened.get(2);
        assertEquals(AlarmClock.ACTION_SET_ALARM, alarm.action); assertEquals(8, alarm.extras.get(AlarmClock.EXTRA_HOUR)); assertEquals(30, alarm.extras.get(AlarmClock.EXTRA_MINUTES)); assertEquals(false, alarm.extras.get(AlarmClock.EXTRA_SKIP_UI));
        output(r.run("alarms.timer", PhoneJobRunner.json("seconds", 90, "label", "Tea")), "alarms.timer");
        PhoneSystemIntents.Request timer = r.intents.opened.get(3);
        assertEquals(AlarmClock.ACTION_SET_TIMER, timer.action); assertEquals(90, timer.extras.get(AlarmClock.EXTRA_LENGTH)); assertEquals(false, timer.extras.get(AlarmClock.EXTRA_SKIP_UI));
        for (PhoneSystemIntents.Request request : r.intents.opened) { assertNotEquals(Intent.ACTION_CALL, request.action); assertNotEquals(Intent.ACTION_SEND, request.action); }
    }
    @Test public void allWritesDoneReplayPendingNoResaveExpiryAndNoPayloadStorage() throws Exception {
        JSONObject fixtures = fixture();
        for (String action : new String[]{"calendar.add", "calendar.change", "alarms.set", "alarms.timer"}) {
            Rig r = new Rig(); String id = UUID.randomUUID().toString(); JSONObject args = first(fixtures, action);
            JSONObject one = output(r.run(action, args, id, false), action), two = output(r.run(action, args, id, false), action);
            assertEquals(one.toString(), two.toString()); assertEquals(1, r.calendar.writes + r.intents.opened.size());
            JSONObject rows = new JSONObject(new String(r.memory.bytes, StandardCharsets.UTF_8));
            assertEquals(1, rows.length()); assertTrue(rows.has(PhoneOperationLedger.key(id)));
            JSONObject entry = rows.getJSONObject(PhoneOperationLedger.key(id)); assertEquals(3, entry.length());
            assertEquals("done", entry.getString("state")); assertTrue(entry.has("identifier")); assertTrue(entry.has("timestamp"));
            assertFalse(new String(r.memory.bytes, StandardCharsets.UTF_8).contains(id));
            for (String key : new String[]{"args", "result", "title", "body", "label", "notes"}) assertFalse(entry.has(key));
            r.now += PhoneOperationLedger.LIFETIME;
            output(r.run(action, args, id, false), action); assertEquals(2, r.calendar.writes + r.intents.opened.size());
            Rig pending = new Rig(); pending.memory.bytes = PhoneJobRunner.json(PhoneOperationLedger.key(id), PhoneJobRunner.json("state", "pending", "timestamp", pending.now)).toString().getBytes(StandardCharsets.UTF_8);
            assertEquals("denied", pending.run(action, args, id, false).code); assertEquals(0, pending.calendar.writes + pending.intents.opened.size());
        }
    }
    @Test public void deniedRevokedAndUnsupportedNeverReachOsWrites() throws Exception {
        JSONObject fixtures = fixture();
        for (Iterator<String> keys = fixtures.keys(); keys.hasNext();) {
            String action = keys.next(); if ("note".equals(action)) continue;
            Rig r = new Rig(); r.calendar.access = null; r.contacts.granted = false; r.location.granted = false; r.intents.supported = false;
            String code = action.startsWith("calendar.") || action.startsWith("contacts.") || action.startsWith("location.") ? "denied" : "unsupported";
            assertEquals(action, code, r.run(action, first(fixtures, action)).code); assertEquals(0, r.calendar.writes + r.intents.opened.size());
        }
        for (String action : new String[]{"calendar.read", "calendar.free_time", "contacts.search", "location.get"}) {
            Rig r = new Rig(); r.calendar.revoke = true; r.contacts.revoke = true; r.location.revoke = true;
            assertEquals("denied", r.run(action, first(fixtures, action)).code);
        }
        for (String action : new String[]{"alarms.set", "alarms.timer", "messages.compose", "calls.dial"}) {
            Rig r = new Rig(); r.intents.revoked = true; assertEquals("denied", r.run(action, first(fixtures, action)).code); assertTrue(r.intents.opened.isEmpty());
        }
    }
    @Test public void encodedByteCapIsTooLargeAndLedgerFailurePreventsSave() throws Exception {
        Rig r = new Rig(); JSONObject large = event(); large.put("notes", repeat("漢", 4000));
        for (int i = 0; i < 200; i++) r.calendar.rows.add(large);
        JSONObject args = first(fixture(), "calendar.read"); args.put("includeNotes", true);
        assertEquals("too_large", r.run("calendar.read", args).code);
        JSONObject fixtures = fixture();
        for (Iterator<String> keys = fixtures.keys(); keys.hasNext();) {
            String action = keys.next(); if ("note".equals(action)) continue;
            assertEquals("too_large", PhoneExecutorSupport.result(action, PhoneJobRunner.json("payload", repeat("漢", 100000))).code);
        }
        r.memory.fail = true; assertEquals("denied", r.run("calendar.add", first(fixtures, "calendar.add")).code); assertEquals(0, r.calendar.writes);
    }
    @Test public void interruptedSaveLeavesOnlyPendingAndExpiresAcrossInstances() throws Exception {
        Memory memory = new Memory(); String id = UUID.randomUUID().toString(); long[] now = {1790000000000L}; int[] saves = {0};
        PhoneOperationLedger ledger = new PhoneOperationLedger(memory, () -> now[0]);
        try {
            ledger.perform(id, () -> {
                saves[0]++;
                JSONObject rows = new JSONObject(new String(memory.bytes, StandardCharsets.UTF_8));
                JSONObject entry = rows.getJSONObject(PhoneOperationLedger.key(id));
                assertEquals("pending", entry.getString("state")); assertEquals(2, entry.length());
                throw new Exception("interrupted");
            }); fail("Expected interruption");
        } catch (Exception expected) {}
        PhoneOperationLedger reopened = new PhoneOperationLedger(memory, () -> now[0]);
        try { reopened.perform(id, () -> { saves[0]++; return "event-1"; }); fail("Pending must refuse"); }
        catch (PhoneExecutorSupport.Failure expected) { assertEquals("denied", expected.code); }
        assertEquals(1, saves[0]); now[0] += PhoneOperationLedger.LIFETIME;
        assertEquals("event-1", reopened.perform(id, () -> { saves[0]++; return "event-1"; })); assertEquals(2, saves[0]);
    }
    @Test public void backgroundCancellationEndsOneShot() {
        Rig r = new Rig(); r.location.hold = true; PhoneJobRunner.Execution[] answer = new PhoneJobRunner.Execution[1];
        r.registry.run(UUID.randomUUID().toString(), "location", "location.get", new PhoneJobsContract.LocationGetArgs("approximate"), false, new PhoneJobRunner.Cancellation(), result -> answer[0] = result);
        assertNull(answer[0]); assertNotNull(r.location.pending); r.registry.cancel();
        assertEquals("denied", answer[0].code); assertNull(r.location.pending);
    }
    @Test public void contactsByteCapAndDroppingUnknownDataBeforeEncoding() throws Exception {
        Rig r = new Rig(); JSONObject person = contact(); person.put("name", repeat("漢", 200));
        JSONArray phones = new JSONArray(), emails = new JSONArray();
        for (int i = 0; i < 10; i++) {
            phones.put(PhoneJobRunner.json("number", repeat("漢", 40), "label", repeat("漢", 50)));
            emails.put(PhoneJobRunner.json("address", repeat("漢", 254), "label", repeat("漢", 50)));
        }
        person.put("phones", phones); person.put("emails", emails);
        for (int i = 0; i < 25; i++) r.contacts.rows.add(person);
        assertEquals("too_large", r.run("contacts.search", PhoneJobRunner.json("query", "Sam")).code);
        JSONObject small = contact(); small.put("undocumented", repeat("漢", 100000)); r.contacts.rows.clear(); r.contacts.rows.add(small);
        output(r.run("contacts.search", PhoneJobRunner.json("query", "Sam")), "contacts.search");
    }

    @Test public void freeTimeMergesOverlapsAndClipsWindow() throws Exception {
        Rig r = new Rig();
        for (String[] times : new String[][]{{"08:00", "09:30"}, {"09:00", "10:00"}, {"10:30", "11:00"}})
            r.calendar.rows.add(PhoneJobRunner.json("start", "2026-10-27T" + times[0] + ":00Z", "end", "2026-10-27T" + times[1] + ":00Z"));
        JSONObject result = output(r.run("calendar.free_time", PhoneJobRunner.json("start", "2026-10-27T09:00:00Z", "end", "2026-10-27T12:00:00Z", "durationMinutes", 30)), "calendar.free_time");
        JSONArray slots = result.getJSONArray("slots"); assertEquals(2, slots.length());
        assertEquals("2026-10-27T10:00:00Z", slots.getJSONObject(0).getString("start")); assertEquals("2026-10-27T10:30:00Z", slots.getJSONObject(0).getString("end"));
        assertEquals("2026-10-27T11:00:00Z", slots.getJSONObject(1).getString("start")); assertEquals("2026-10-27T12:00:00Z", slots.getJSONObject(1).getString("end"));
    }
}
