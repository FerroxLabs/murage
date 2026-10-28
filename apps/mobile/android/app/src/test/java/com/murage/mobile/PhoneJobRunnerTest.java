package com.murage.mobile;

import com.murage.mobile.shell.PhoneJobsContract;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.Executor;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class PhoneJobRunnerTest {
    static final class Serial implements Executor {
        final ArrayDeque<Runnable> tasks = new ArrayDeque<>();
        @Override public void execute(Runnable task) { tasks.add(task); }
        void drain() { int n = 0; while (!tasks.isEmpty()) { assertTrue("actor spins", n++ < 1000); tasks.remove().run(); } }
    }
    static final class Clock implements PhoneJobRunner.Clock {
        long time = 1700000000000L;
        final List<Runnable> timers = new ArrayList<>();
        @Override public long now() { return time; }
        @Override public PhoneJobRunner.Cancel after(long ms, Runnable task) { timers.add(task); return () -> timers.remove(task); }
        void advance(long ms) { time += ms; List<Runnable> ready = new ArrayList<>(timers); timers.clear(); for (Runnable r : ready) r.run(); }
    }
    static final class Request {
        WorkspaceOrigin workspace; String token, method, suffix; JSONObject body; int timeout;
        Consumer<PhoneJobRunner.Response> done; boolean cancelled, taken;
        void reply(Object body, int status) { done.accept(new PhoneJobRunner.Response(status, body)); }
        void reply(Object body) { reply(body, 200); }
        void fail() { reply(null, 0); }
    }
    static final class HTTP implements PhoneJobRunner.HTTP {
        final List<Request> requests = new ArrayList<>();
        @Override public PhoneJobRunner.Cancel send(WorkspaceOrigin w, String token, String method, String suffix,
                                                    JSONObject body, int timeout, Consumer<PhoneJobRunner.Response> done) {
            Request r = new Request(); r.workspace = w; r.token = token; r.method = method; r.suffix = suffix;
            r.body = body; r.timeout = timeout; r.done = done; requests.add(r); return () -> r.cancelled = true;
        }
        Request take(String suffix) {
            for (Request r : requests) if (!r.taken && r.suffix.endsWith(suffix)) { r.taken = true; return r; }
            throw new AssertionError("Missing request: " + suffix);
        }
        long count(String suffix) { return requests.stream().filter(r -> r.suffix.endsWith(suffix)).count(); }
    }
    static final class Cards implements PhoneJobRunner.Cards {
        final List<PhoneJobsContract.Offer> offers = new ArrayList<>();
        final List<String> providers = new ArrayList<>();
        WorkspaceOrigin onScreen;
        final List<WorkspaceOrigin> providerWorkspaces = new ArrayList<>(), offerWorkspaces = new ArrayList<>();
        final List<String> workspaceNames = new ArrayList<>();
        @Override public boolean canPresent(WorkspaceOrigin w) { return onScreen == null || PhoneJobCardModel.matches(w, onScreen); }
        Consumer<Boolean> answer, providerAnswer; Runnable close;
        boolean failPresentation;
        PhoneJobsContract.Args presentedArgs;
        @Override public void show(WorkspaceOrigin w, PhoneJobsContract.Offer offer, PhoneJobsContract.Args args, Consumer<Boolean> answer, Runnable failed) {
            presentedArgs = args;
            if (failPresentation) failed.run(); else show(w, offer, answer);
        }
        @Override public void showProvider(WorkspaceOrigin w, PhoneJobsContract.NamedParty provider, String name, Consumer<Boolean> answer, Runnable failed) {
            if (failPresentation) failed.run(); else showProvider(w, provider, name, answer);
        }
        int handled, dismissals, used; boolean displayed, holdUsed;
        @Override public void show(WorkspaceOrigin w, PhoneJobsContract.Offer o, Consumer<Boolean> answer) { offerWorkspaces.add(w); offers.add(o); this.answer = answer; displayed = true; }
        @Override public void showProvider(WorkspaceOrigin w, PhoneJobsContract.NamedParty p, String workspaceName, Consumer<Boolean> answer) { providerWorkspaces.add(w); workspaceNames.add(workspaceName); providers.add(p.name); providerAnswer = answer; displayed = true; }
        @Override public void used(WorkspaceOrigin w, PhoneJobsContract.Offer o, Runnable closed) {
            used++; close = closed; displayed = true; if (!holdUsed) closed.run();
        }
        @Override public void alreadyHandled(WorkspaceOrigin w, String operation, Runnable close) { handled++; this.close = close; displayed = true; }
        @Override public void dismiss(WorkspaceOrigin w, String operation) { dismissals++; displayed = false; }
    }
    static final class Env implements PhoneJobRunner.Environment {
        final Map<WorkspaceOrigin, PhoneForBotsModel.Consent> values = new HashMap<>();
        final Map<WorkspaceOrigin, String> tokens = new HashMap<>();
        boolean permission = true; int off;
        void enable(WorkspaceOrigin w, char token) {
            PhoneForBotsModel.Consent c = new PhoneForBotsModel.Consent(); c.enabled = true; c.sharing = true;
            c.providers.add("anthropic"); c.rows.add("calendar"); values.put(w, c);
            char[] chars = new char[43]; Arrays.fill(chars, token); tokens.put(w, "murage_pj_" + new String(chars));
        }
        @Override public String token(WorkspaceOrigin w) { return tokens.get(w); }
        @Override public boolean enabled(WorkspaceOrigin w) { return values.containsKey(w) && values.get(w).enabled; }
        @Override public boolean needsProvider(WorkspaceOrigin w, String p) { return !values.get(w).sharing || !values.get(w).providers.contains(p); }
        @Override public boolean recordProvider(WorkspaceOrigin w, String p) { values.get(w).providers.add(p); return true; }
        @Override public boolean consent(WorkspaceOrigin w, PhoneJobsContract.Offer o) {
            PhoneForBotsModel.Consent c = values.get(w); return c.enabled && c.sharing && c.rows.contains(o.capability) && c.providers.contains(o.provider.id);
        }
        @Override public boolean preciseConsent(WorkspaceOrigin w) { return values.get(w).rows.contains("precise"); }
        @Override public boolean permission(PhoneJobsContract.Offer o) { return permission; }
        @Override public void turnOff(WorkspaceOrigin w) { tokens.remove(w); values.get(w).enabled = false; off++; }
    }
    static final class Executors implements PhoneJobRunner.Executors {
        PhoneJobsContract.Args receivedArgs;
        String operationId; boolean preciseConsent; Runnable beforeComplete = () -> {};
        int runs, writes; PhoneJobRunner.Cancellation cancellation; boolean hold; Consumer<PhoneJobRunner.Execution> completion;
        PhoneJobRunner.Execution output = new PhoneJobRunner.Execution(new PhoneJobsContract.CalendarReadResult(Collections.emptyList(), false), null);
        @Override public void run(String operationId, String capability, String action, PhoneJobsContract.Args args, boolean preciseConsent, PhoneJobRunner.Cancellation cancellation, Consumer<PhoneJobRunner.Execution> done) {
            this.cancellation = cancellation; this.receivedArgs = args;
            runs++; this.operationId = operationId; this.preciseConsent = preciseConsent; completion = done; if (!hold) { beforeComplete.run(); done.accept(cancellation.isCancelled() ? PhoneJobRunner.Execution.error("denied") : output); }
        }
        void completeAfterWriteCheck() {
            if (!cancellation.isCancelled()) writes++;
            completion.accept(cancellation.isCancelled() ? PhoneJobRunner.Execution.error("denied") : output);
        }
    }
    static final class Rig {
        final WorkspaceOrigin w = WorkspaceOrigin.parse("https://one.example.ts.net");
        final Serial serial = new Serial(); final Clock clock = new Clock(); final HTTP http = new HTTP();
        final Cards cards = new Cards(); final Env env = new Env(); final Executors executors = new Executors();
        final PhoneJobRunner runner = new PhoneJobRunner(serial, env, cards, executors, http, clock);
        Rig() { env.enable(w, 'a'); }
        void start() { runner.start(Collections.singleton(w), true); serial.drain(); }
        void stop() { runner.stop(); serial.drain(); }
        void tick() { clock.advance(1000); serial.drain(); }
        void show() throws Exception { start(); http.take("/jobs").reply(jobs(offer())); serial.drain(); }
        Request lease() { cards.answer.accept(true); serial.drain(); return http.take("/lease"); }
        Request active(Request lease) throws Exception {
            lease.reply(PhoneJobRunner.json("active", true, "leaseToken", leaseToken())); serial.drain();
            Request target = http.take("/jobs/" + offer().getString("operationId")); assertEquals(3000, target.timeout); return target;
        }
        void commit(Request target) { target.reply(PhoneJobRunner.json("leased", true, "expiresAt", clock.time + 45000)); serial.drain(); }
        Request result(String code) {
            Request r = http.take("/result"); assertEquals(code == null, r.body.optBoolean("ok"));
            assertEquals(code, r.body.opt("code")); assertNotNull(PhoneJobsContract.ResultBody.parse(r.body)); return r;
        }
    }
    static String leaseToken() { return "YdPFFal_9PPr92JtGN-Z3IDRKNcoHkdE2ak2RwbSrsc"; }
    static JSONObject offer() throws Exception {
        Path path = Paths.get("..").toAbsolutePath();
        while (path != null && !Files.exists(path.resolve("contract/phone-jobs.json"))) path = path.getParent();
        if (path == null) throw new AssertionError("phone-jobs fixture missing");
        return new JSONObject(new String(Files.readAllBytes(path.resolve("contract/phone-jobs.json")), StandardCharsets.UTF_8))
            .getJSONObject("job").getJSONArray("offers").getJSONObject(0);
    }
    static JSONObject jobs(JSONObject offer) { return PhoneJobRunner.json("jobs", new JSONArray().put(offer)); }

    @Test public void unsafeDestinationsDeclineBeforeAnyCardOrExecution() throws Exception {
        for (String action : Arrays.asList("messages.compose", "calls.dial")) {
            for (String bad : Arrays.asList("+15551212\n900", "+1555\u202e1212", "+1\u200d23", "+1\t23", "+1\u000023", "Sam", "sam@example.test", "*123", "123#", String.join("", Collections.nCopies(41, "1")))) {
                Rig r = new Rig(); r.env.values.get(r.w).providers.clear();
                JSONObject args = action.equals("calls.dial") ? PhoneJobRunner.json("number", bad)
                    : PhoneJobRunner.json("to", new JSONArray().put("+123").put(bad), "body", "Hi");
                r.start(); r.http.take("/jobs").reply(jobs(offer().put("action", action)
                    .put("capability", action.split("\\.")[0]).put("args", args))); r.serial.drain();
                assertEquals(1, r.http.count("/decline"));
                assertTrue(r.cards.offers.isEmpty()); assertTrue(r.cards.providers.isEmpty());
                assertEquals(0, r.http.count("/lease")); assertEquals(0, r.executors.runs);
                r.http.take("/decline").reply(new JSONObject()); r.serial.drain(); r.stop();
            }
        }
    }

    @Test public void messageBodyControlsDeclineWithoutSilentRemoval() throws Exception {
        for (String body : Arrays.asList("Hi\u202ethere", "Hi\u200dthere", "Hi\tthere", "Hi\rthere", "Hi\u0000there")) {
            Rig r = new Rig(); r.start();
            r.http.take("/jobs").reply(jobs(offer().put("action", "messages.compose").put("capability", "messages")
                .put("args", PhoneJobRunner.json("to", new JSONArray().put("+123"), "body", body)))); r.serial.drain();
            assertEquals(1, r.http.count("/decline"));
            assertTrue(r.cards.offers.isEmpty()); assertTrue(r.cards.providers.isEmpty()); assertEquals(0, r.executors.runs);
            r.http.take("/decline").reply(new JSONObject()); r.serial.drain(); r.stop();
        }
    }

    @Test public void executorReceivesExactlyTheDisplayedDestinations() throws Exception {
        for (String action : Arrays.asList("messages.compose", "calls.dial")) {
            Rig r = new Rig(); String number = " +1 (555) 010-20.30 ", body = "Hi\nthere 👋";
            String capability = action.split("\\.")[0]; r.env.values.get(r.w).rows.add(capability);
            JSONObject args = action.equals("calls.dial") ? PhoneJobRunner.json("number", number)
                : PhoneJobRunner.json("to", new JSONArray().put(number).put("+44 (20) 1234"), "body", body);
            r.executors.output = new PhoneJobRunner.Execution(action.equals("calls.dial")
                ? new PhoneJobsContract.CallsDialResult("dialer_opened") : new PhoneJobsContract.MessagesComposeResult("opened_for_you_to_send"), null);
            r.start(); r.http.take("/jobs").reply(jobs(offer().put("action", action).put("capability", capability).put("args", args))); r.serial.drain();
            PhoneJobsContract.Offer shown = r.cards.offers.get(0);
            PhoneJobCardModel card = new PhoneJobCardModel(shown, 1, r.cards.answer);
            assertEquals(number, card.destinations.get(0)); card.choose(true); r.serial.drain();
            r.commit(r.active(r.http.take("/lease")));
            assertEquals(1, r.executors.runs); assertSame(shown.decodedArgs(), r.executors.receivedArgs);
            assertSame(r.cards.presentedArgs, r.executors.receivedArgs);
            if (r.executors.receivedArgs instanceof PhoneJobsContract.CallsDialArgs) {
                assertEquals(card.destinations.get(0), ((PhoneJobsContract.CallsDialArgs) r.executors.receivedArgs).number);
            } else {
                PhoneJobsContract.MessagesComposeArgs received = (PhoneJobsContract.MessagesComposeArgs) r.executors.receivedArgs;
                assertEquals(card.destinations, received.to); assertEquals(body, received.body);
            }
            r.result(null).reply(new JSONObject()); r.serial.drain(); r.stop();
        }
    }

    @Test public void offscreenOfferCannotBlockProviderAndCardForTheVisibleComputer() throws Exception {
        Rig r = new Rig(); WorkspaceOrigin other = WorkspaceOrigin.parse("https://two.example.ts.net");
        r.env.enable(other, 'b'); r.env.values.get(other).providers.clear(); r.env.values.get(r.w).providers.clear(); r.cards.onScreen = r.w;
        r.runner.start(new HashSet<>(Arrays.asList(r.w, other)), true); r.serial.drain();
        Request own = r.http.requests.stream().filter(x -> x.workspace.equals(r.w)).findFirst().get();
        Request away = r.http.requests.stream().filter(x -> x.workspace.equals(other)).findFirst().get();
        away.reply(jobs(offer().put("workspace", "Other"))); r.serial.drain();
        assertTrue(r.cards.offers.isEmpty()); assertTrue(r.cards.providers.isEmpty());
        own.reply(jobs(offer().put("workspace", "Studio"))); r.serial.drain();
        assertEquals(Collections.singletonList(r.w), r.cards.providerWorkspaces);
        assertEquals(Collections.singletonList("Studio"), r.cards.workspaceNames);
        r.cards.providerAnswer.accept(true); r.serial.drain();
        assertEquals(Collections.singletonList(r.w), r.cards.offerWorkspaces);
        assertTrue(r.env.values.get(other).providers.isEmpty());
        assertEquals(0, r.http.count("/lease"));
    }

    @Test public void overlappingAuthFailuresCannotRestoreTheSameBearer() throws Exception {
        for (int status : new int[]{401, 403}) {
            Rig r = new Rig(); r.start(); Request poll = r.http.take("/jobs");
            String old = r.env.token(r.w);
            r.runner.registration(r.w, "PUT", old, new JSONObject(), ignored -> {}); r.serial.drain();
            Request put = r.http.take("");
            // Queue both responses before allowing the serial runner to consume either one.
            poll.reply(null, status); put.reply(null, status); r.serial.drain();
            assertEquals(2, r.env.off); assertNull(r.env.token(r.w));
            long before = r.http.requests.size();
            r.env.values.get(r.w).enabled = true;
            r.runner.refresh(r.w); r.serial.drain(); // A missing token cannot unblock.
            r.env.enable(r.w, 'a'); r.runner.refresh(r.w); r.serial.drain();
            r.runner.registration(r.w, "PUT", old, new JSONObject(), code -> assertEquals(Integer.valueOf(403), code));
            r.serial.drain(); assertEquals(before, r.http.requests.size());
            r.env.enable(r.w, 'b'); r.runner.refresh(r.w); r.serial.drain();
            Request fresh = r.http.take("/jobs"); assertEquals(r.env.token(r.w), fresh.token);
        }
    }
    @Test public void stopAndRevokeCancelBeforeWriteAndAwaitExecutorResult() throws Exception {
        for (boolean revoke : new boolean[]{false, true}) {
            Rig r = new Rig(); r.executors.hold = true; r.show(); r.commit(r.active(r.lease()));
            assertEquals(1, r.executors.runs); assertFalse(r.executors.cancellation.isCancelled());
            if (revoke) { r.runner.notice(r.w, 401, r.env.token(r.w), () -> {}); r.serial.drain(); }
            else {
                r.runner.stop();
                assertTrue(r.executors.cancellation.isCancelled()); // Before serial processes stop.
                r.serial.drain();
            }
            assertTrue(r.executors.cancellation.isCancelled());
            assertEquals(0, r.http.count("/result"));
            r.executors.completeAfterWriteCheck(); r.serial.drain();
            r.result("denied").reply(new JSONObject()); r.serial.drain();
            assertEquals(0, r.executors.writes); assertEquals(1, r.http.count("/result")); assertEquals(0, r.cards.used);
        }
    }

    @Test public void runnerPassesOperationIdAndSeparatePreciseConsent() throws Exception {
        Rig r = new Rig(); r.env.values.get(r.w).rows.add("precise"); r.show(); r.commit(r.active(r.lease())); r.result(null);
        assertEquals(offer().getString("operationId"), r.executors.operationId); assertTrue(r.executors.preciseConsent);
    }

    @Test public void stopBeforeSynchronousWritePostsExecutorDenial() throws Exception {
        Rig r = new Rig(); r.show(); r.executors.beforeComplete = r.runner::stop;
        r.commit(r.active(r.lease())); r.result("denied");
        assertEquals(1, r.http.count("/result"));
    }

    @Test public void foregroundOnlyStopNotPauseAndCancelledPollCannotShow() throws Exception {
        Rig r = new Rig(); r.runner.start(Collections.singleton(r.w), false); r.serial.drain(); assertEquals(0, r.http.requests.size());
        r.start(); Request poll = r.http.take("/jobs"); assertEquals(25000, poll.timeout);
        r.runner.start(Collections.singleton(r.w), true); r.serial.drain(); assertEquals(1, r.http.count("/jobs"));
        r.stop(); assertTrue(poll.cancelled); assertFalse(r.cards.displayed);
        Request off = r.http.take("/foreground"); assertEquals(false, off.body.getBoolean("active"));
        poll.reply(jobs(offer())); r.serial.drain(); assertTrue(r.cards.offers.isEmpty()); assertEquals(0, r.executors.runs);
    }
    @Test public void fourCommitChecksDenyAndDuplicateAllowCannotLeaseAgain() throws Exception {
        for (int check = 0; check < 4; check++) {
            Rig r = new Rig(); r.show(); Request lease = r.lease(); r.cards.answer.accept(true); r.serial.drain();
            assertEquals(1, r.http.count("/lease")); Request target = r.active(lease);
            switch (check) {
                case 0: r.env.values.get(r.w).rows.clear(); break;
                case 1: r.env.values.get(r.w).providers.clear(); break;
                case 2: r.env.permission = false; break;
                default: r.runner.notice(r.w, 403, r.env.token(r.w), () -> {}); r.serial.drain();
            }
            r.commit(target); Request result = r.result("denied"); result.reply(new JSONObject()); r.serial.drain();
            assertEquals(0, r.executors.runs); assertEquals(1, r.http.count("/result")); assertFalse(r.cards.displayed);
        }
    }
    @Test public void masterSharingExpiryAndNotNowNeverExecute() throws Exception {
        for (boolean master : new boolean[]{false, true}) {
            Rig r = new Rig(); r.show(); Request target = r.active(r.lease());
            if (master) r.env.values.get(r.w).enabled = false; else r.env.values.get(r.w).sharing = false;
            r.commit(target); r.result("denied"); assertEquals(0, r.executors.runs);
        }
        Rig expired = new Rig(); expired.start(); expired.http.take("/jobs").reply(jobs(offer().put("expiresAt", expired.clock.time - 180_001)));
        expired.serial.drain(); assertTrue(expired.cards.offers.isEmpty());
        Rig declined = new Rig(); declined.show(); declined.cards.answer.accept(false); declined.serial.drain();
        assertEquals(1, declined.http.count("/decline")); assertEquals(0, declined.http.count("/lease")); assertEquals(0, declined.executors.runs);
    }
    @Test public void leaseInactiveDismissesWithoutPostingResult() throws Exception {
        Rig r = new Rig(); r.show(); r.lease().reply(PhoneJobRunner.json("active", false)); r.serial.drain();
        assertFalse(r.cards.displayed); assertEquals(0, r.executors.runs); assertEquals(0, r.http.count("/result"));
    }
    @Test public void allTargetedReasonsTimeoutAndNetworkErrorDenyOnce() throws Exception {
        for (String reason : Arrays.asList("done", "revoked", "ended", "unknown", "timeout", "network")) {
            Rig r = new Rig(); r.show(); Request target = r.active(r.lease());
            if (reason.equals("timeout")) { r.clock.time += 3001; target.fail(); }
            else if (reason.equals("network")) target.fail();
            else target.reply(PhoneJobRunner.json("handled", true, "reason", reason));
            r.serial.drain(); assertFalse(r.cards.displayed); Request result = r.result("denied");
            result.reply(new JSONObject()); r.serial.drain(); assertEquals(0, r.executors.runs); assertEquals(1, r.http.count("/result"));
        }
    }
    @Test public void authNoticesDeleteTokenTurnOffCancelPollAndDenyHeldLease() throws Exception {
        for (int status : new int[]{401, 403}) {
            Rig r = new Rig(); r.show(); Request target = r.active(r.lease());
            target.reply(null, status); r.serial.drain();
            assertNull(r.env.token(r.w)); assertFalse(r.env.enabled(r.w)); assertFalse(r.cards.displayed);
            Request result = r.result("denied"); result.reply(null, status); r.serial.drain();
            assertEquals(1, r.http.count("/result")); assertEquals(0, r.executors.runs);
            long polls = r.http.count("/jobs"); r.tick(); assertEquals(polls, r.http.count("/jobs"));
        }
    }
    @Test public void providersKnownAllowNotNowAndInvalidArgsBeforeAnyCard() throws Exception {
        Rig known = new Rig(); known.show(); assertTrue(known.cards.providers.isEmpty());
        for (boolean allow : new boolean[]{false, true}) {
            Rig r = new Rig(); r.env.values.get(r.w).providers.clear(); r.show();
            assertEquals(Collections.singletonList("Anthropic"), r.cards.providers); assertTrue(r.cards.offers.isEmpty());
            r.cards.providerAnswer.accept(allow); r.serial.drain();
            if (allow) { assertEquals(1, r.cards.offers.size()); assertTrue(r.env.values.get(r.w).providers.contains("anthropic")); }
            else { assertEquals(1, r.http.count("/decline")); assertTrue(r.cards.offers.isEmpty()); }
            assertEquals(0, r.executors.runs);
        }
        Rig r = new Rig(); r.start(); r.http.take("/jobs").reply(jobs(offer().put("args", PhoneJobRunner.json("extra", true)))); r.serial.drain();
        assertEquals(1, r.http.count("/decline")); assertTrue(r.cards.offers.isEmpty()); assertTrue(r.cards.providers.isEmpty());
    }
    @Test public void pushOnlyItsOperationAllHandledReasonsAndLeased() throws Exception {
        for (String reason : Arrays.asList("offer", "leased", "done", "revoked", "ended", "unknown")) {
            Rig r = new Rig(); String ref = String.join("", Collections.nCopies(64, "f"));
            r.runner.open(r.w, ref); r.serial.drain(); assertTrue(r.http.requests.isEmpty()); r.start();
            Request read = r.http.take("/jobs?eventRef=" + ref);
            if (reason.equals("offer")) read.reply(jobs(offer()));
            else if (reason.equals("leased")) read.reply(PhoneJobRunner.json("leased", true, "expiresAt", r.clock.time + 45000));
            else read.reply(PhoneJobRunner.json("handled", true, "reason", reason));
            r.serial.drain(); assertEquals(reason.equals("leased") ? 1 : 0, r.http.count("/jobs")); assertEquals(0, r.executors.runs);
            if (reason.equals("offer")) assertEquals(offer().getString("operationId"), r.cards.offers.get(0).operationId);
            else { assertTrue(r.cards.offers.isEmpty()); assertEquals(reason.equals("leased") ? 0 : 1, r.cards.handled); }
        }
    }
    @Test public void as8LateLeaseAfterStopDeniesExactlyOnce() throws Exception {
        Rig r = new Rig(); r.show(); Request lease = r.lease(); r.stop(); assertFalse(r.cards.displayed);
        lease.reply(PhoneJobRunner.json("active", true, "leaseToken", leaseToken())); r.serial.drain();
        Request result = r.result("denied"); result.reply(new JSONObject()); r.serial.drain();
        assertEquals(0, r.executors.runs); assertEquals(1, r.http.count("/result")); assertFalse(r.cards.displayed);
    }
    @Test public void as8LostForegroundOffReoffersNewRevisionAndRejectsOldCallback() throws Exception {
        Rig r = new Rig(); r.show(); Consumer<Boolean> old = r.cards.answer;
        r.stop(); r.http.take("/foreground").fail(); r.serial.drain(); r.start();
        String newID = "a1b2c3d4-0000-4000-8000-000000000002";
        r.http.take("/jobs").reply(jobs(offer().put("offerId", newID))); r.serial.drain();
        old.accept(true); r.serial.drain(); assertEquals(0, r.http.count("/lease"));
        Request lease = r.lease(); assertEquals(newID, lease.body.getString("offerId")); assertEquals(2, r.cards.offers.size());
    }
    @Test public void as8ServerRestart409ShowsHandledNoRetryUntilCardCloses() throws Exception {
        Rig r = new Rig(); r.show(); r.commit(r.active(r.lease()));
        assertEquals(1, r.executors.runs); Request result = r.result(null); result.reply(null, 409); r.serial.drain();
        assertEquals(1, r.cards.handled); assertTrue(r.cards.displayed); r.tick(); assertEquals(1, r.http.count("/result"));
        assertEquals(0, r.cards.used);
        r.cards.close.run(); r.serial.drain(); assertFalse(r.cards.displayed);
    }
    @Test public void successfulRunShowsUsedLineUntilCloseWithoutPostingAgain() throws Exception {
        Rig r = new Rig(); r.cards.holdUsed = true;
        r.show(); r.commit(r.active(r.lease())); r.result(null).reply(null); r.serial.drain();
        assertEquals(1, r.cards.used); assertEquals(0, r.cards.handled); assertTrue(r.cards.displayed);
        r.tick(); assertEquals(1, r.http.count("/result"));
        r.cards.close.run(); r.serial.drain(); assertFalse(r.cards.displayed);
    }
    @Test public void backgroundWhilePostingCannotShowUsedLine() throws Exception {
        Rig r = new Rig(); r.show(); r.commit(r.active(r.lease())); Request result = r.result(null);
        r.stop(); result.reply(null); r.serial.drain();
        assertEquals(0, r.cards.used); assertFalse(r.cards.displayed);
    }
    @Test public void as8RegistrationRevocationSurvivesReconnectUntilFreshMint() throws Exception {
        Rig r = new Rig(); r.start();
        r.runner.registration(r.w, "PUT", r.env.token(r.w), new JSONObject(), status -> assertEquals(Integer.valueOf(403), status));
        r.serial.drain(); Request put = r.http.requests.get(r.http.requests.size() - 1);
        assertEquals("PUT", put.method); assertEquals("", put.suffix);
        String oldToken = put.token; put.reply(PhoneJobRunner.json("error", "revoked"), 403); r.serial.drain();
        assertNull(r.env.token(r.w)); assertFalse(r.env.enabled(r.w));
        r.stop(); long calls = r.http.requests.size(); r.start(); r.tick();
        r.runner.registration(r.w, "PUT", oldToken, new JSONObject(), status -> assertEquals(Integer.valueOf(403), status));
        r.serial.drain(); assertEquals(calls, r.http.requests.size());
        r.env.enable(r.w, 'b'); r.runner.refresh(r.w); r.serial.drain();
        Request fresh = r.http.requests.get(r.http.requests.size() - 1); assertEquals(r.env.token(r.w), fresh.token); assertEquals("/jobs", fresh.suffix);
    }

    @Test public void invalidResultAndExecutorErrorUseContractCodes() throws Exception {
        for (PhoneJobRunner.Execution output : Arrays.asList(
            new PhoneJobRunner.Execution(new PhoneJobsContract.CalendarReadResult(null, false), null),
            new PhoneJobRunner.Execution(new PhoneJobsContract.CalendarAddResult("event", false), null),
            PhoneJobRunner.Execution.error("unsupported"), PhoneJobRunner.Execution.error("arbitrary"))) {
            Rig r = new Rig(); r.executors.output = output; r.show(); r.commit(r.active(r.lease()));
            Request result = r.result("unsupported".equals(output.code) ? "unsupported" : "invalid_result");
            result.reply(new JSONObject()); r.serial.drain(); assertEquals(1, r.http.count("/result"));
        }
    }
    @Test public void oneExecutorAcrossWorkspacesAndReopenAndCorrectBearer() throws Exception {
        Rig r = new Rig(); WorkspaceOrigin other = WorkspaceOrigin.parse("https://two.example.ts.net"); r.env.enable(other, 'b');
        r.runner.start(new HashSet<>(Arrays.asList(r.w, other)), true); r.serial.drain();
        Request one = r.http.requests.stream().filter(x -> x.workspace.equals(r.w)).findFirst().get();
        Request two = r.http.requests.stream().filter(x -> x.workspace.equals(other)).findFirst().get();
        one.reply(jobs(offer())); r.serial.drain(); r.executors.hold = true; r.commit(r.active(r.lease()));
        two.reply(jobs(offer().put("operationId", "a1b2c3d4-0000-4000-8000-000000000001"))); r.serial.drain();
        assertEquals(1, r.cards.offers.size()); assertEquals(1, r.executors.runs);
        r.stop(); assertEquals(0, r.http.count("/result")); r.start();
        assertEquals(1, r.executors.runs); r.executors.completeAfterWriteCheck(); r.serial.drain();
        r.result("denied").reply(new JSONObject()); r.serial.drain();
        assertEquals(1, r.http.count("/result"));
        for (Request req : r.http.requests) assertEquals(r.env.token(req.workspace), req.token);
    }
    @Test public void stopAndBothAuthStatusesAfterWriteStartPostRealOutcome() throws Exception {
        for (int status : new int[]{0, 401, 403}) {
            Rig r = new Rig(); r.executors.hold = true; r.env.values.get(r.w).rows.add("alarms");
            r.executors.output = new PhoneJobRunner.Execution(new PhoneJobsContract.AlarmsSetResult("set"), null);
            r.start(); r.http.take("/jobs").reply(jobs(offer().put("action", "alarms.set").put("capability", "alarms")
                .put("args", PhoneJobRunner.json("hour", 7, "minute", 5, "label", "Wake")))); r.serial.drain();
            r.commit(r.active(r.lease())); r.executors.cancellation.beginWrite();
            if (status == 0) r.stop(); else { r.runner.notice(r.w, status, r.env.token(r.w), () -> {}); r.serial.drain(); }
            assertFalse(r.executors.cancellation.isCancelled()); assertEquals(0, r.http.count("/result"));
            r.executors.completeAfterWriteCheck(); r.serial.drain(); r.result(null).reply(new JSONObject()); r.serial.drain();
            assertEquals(1, r.http.count("/result")); assertEquals(0, r.cards.used);
        }
    }
    @Test public void pushTerminalOutcomesAndFailedCardsResumePolling() throws Exception {
        for (String outcome : Arrays.asList("leased", "network", "http", "malformed", "expired", "decode", "offscreen", "card", "provider")) {
            Rig r = new Rig(); String ref = String.join("", Collections.nCopies(64, "f"));
            r.runner.open(r.w, ref); r.serial.drain(); r.start();
            Request target = r.http.take("/jobs?eventRef=" + ref);
            if (outcome.equals("card") || outcome.equals("provider")) r.cards.failPresentation = true;
            if (outcome.equals("provider")) r.env.values.get(r.w).providers.clear();
            if (outcome.equals("offscreen")) r.cards.onScreen = WorkspaceOrigin.parse("https://other.example.ts.net");
            switch (outcome) {
                case "network": target.fail(); break;
                case "http": target.reply(null, 500); break;
                case "malformed": target.reply(PhoneJobRunner.json("unexpected", true)); break;
                case "leased": target.reply(PhoneJobRunner.json("leased", true, "expiresAt", r.clock.time + 45000)); break;
                case "expired": target.reply(jobs(offer().put("expiresAt", r.clock.time - 180_001))); break;
                case "decode": target.reply(jobs(offer().put("args", PhoneJobRunner.json("extra", true)))); break;
                default: target.reply(jobs(offer()));
            }
            r.serial.drain();
            if (outcome.equals("decode")) { r.http.take("/decline").reply(new JSONObject()); r.serial.drain(); }
            Request poll = r.http.take("/jobs"); assertEquals("/jobs", poll.suffix);
            r.cards.failPresentation = false; r.cards.onScreen = null; r.env.values.get(r.w).providers.add("anthropic");
            poll.reply(jobs(offer())); r.serial.drain(); assertEquals(1, r.cards.offers.size());
            assertEquals(0, r.http.count("/lease")); r.stop();
        }
    }
    @Test public void twoMinuteClockSkewStillExecutesAfterLeaseCheck() throws Exception {
        Rig r = new Rig(); long serverNow = r.clock.time; r.clock.time += 120000;
        r.start(); r.http.take("/jobs").reply(jobs(offer().put("expiresAt", serverNow + 30000))); r.serial.drain();
        Request target = r.active(r.lease()); target.reply(PhoneJobRunner.json("leased", true, "expiresAt", serverNow + 45000));
        r.serial.drain(); r.result(null); assertEquals(1, r.executors.runs);
    }

}
