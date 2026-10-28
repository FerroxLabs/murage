package com.murage.mobile;

import com.murage.mobile.shell.PhoneJobsContract;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.util.*;
import java.util.concurrent.Executor;
import java.util.function.Consumer;
import org.json.JSONObject;

/** One process-wide actor. All state changes and HTTP completions use serial. */
final class PhoneJobRunner {
    interface Cards {
        default void show(WorkspaceOrigin w, PhoneJobsContract.Offer offer, PhoneJobsContract.Args args, Consumer<Boolean> answer, Runnable failed) { show(w, offer, answer); }
        default void showProvider(WorkspaceOrigin w, PhoneJobsContract.NamedParty provider, String name, Consumer<Boolean> answer, Runnable failed) { showProvider(w, provider, name, answer); }
        default boolean canPresent(WorkspaceOrigin workspace) { return true; }
        void show(WorkspaceOrigin workspace, PhoneJobsContract.Offer offer, Consumer<Boolean> answer);
        void showProvider(WorkspaceOrigin workspace, PhoneJobsContract.NamedParty provider, String workspaceName, Consumer<Boolean> answer);
        void used(WorkspaceOrigin workspace, PhoneJobsContract.Offer offer, Runnable closed);
        void alreadyHandled(WorkspaceOrigin workspace, String operationId, Runnable closed);
        void dismiss(WorkspaceOrigin workspace, String operationId); // null means the whole workspace
    }
    interface Executors {
        default void cancel() {}
        default void run(WorkspaceOrigin workspace, String operationId, String capability, String action, PhoneJobsContract.Args args, boolean preciseConsent, Cancellation cancellation, Consumer<Execution> completion) {
            run(operationId, capability, action, args, preciseConsent, cancellation, completion);
        }
        void run(String operationId, String capability, String action, PhoneJobsContract.Args args, boolean preciseConsent, Cancellation cancellation, Consumer<Execution> completion);
    }
    static final class Cancellation {
        private boolean cancelled, writing;
        synchronized void cancel() { if (!writing) cancelled = true; }
        synchronized boolean isCancelled() { return cancelled; }
        synchronized void beginWrite() throws PhoneExecutorSupport.Failure { check(); writing = true; }
        void check() throws PhoneExecutorSupport.Failure { PhoneExecutorSupport.require(!isCancelled()); }
    }
    static final class Execution {
        final PhoneJobsContract.Result result; final String code;
        Execution(PhoneJobsContract.Result result, String code) { this.result = result; this.code = code; }
        static Execution error(String code) { return new Execution(null, code); }
    }
    interface Environment {
        String token(WorkspaceOrigin workspace);
        boolean enabled(WorkspaceOrigin workspace);
        boolean needsProvider(WorkspaceOrigin workspace, String provider);
        boolean recordProvider(WorkspaceOrigin workspace, String provider);
        boolean consent(WorkspaceOrigin workspace, PhoneJobsContract.Offer offer);
        boolean permission(PhoneJobsContract.Offer offer);
        default boolean preciseConsent(WorkspaceOrigin workspace) { return false; }
        void turnOff(WorkspaceOrigin workspace);
    }
    interface Cancel { void cancel(); }
    interface Clock {
        long now();
        Cancel after(long milliseconds, Runnable task);
    }
    interface HTTP {
        Cancel send(WorkspaceOrigin workspace, String token, String method, String suffix, JSONObject body,
                    int timeoutMillis, Consumer<Response> completion);
    }
    static final class Response {
        final int status; final Object body;
        Response(int status, Object body) { this.status = status; this.body = body; }
    }
    private static final class Job {
        final WorkspaceOrigin workspace; final PhoneJobsContract.Offer offer; final PhoneJobsContract.Args args;
        final String token; final long generation;
        boolean answering, revoked, posted, executing, closing, providerPending;
        final Cancellation cancellation = new Cancellation();
        String lease; JSONObject retainedResult;
        Job(WorkspaceOrigin w, PhoneJobsContract.Offer o, String t, long g) {
            workspace = w; offer = o; args = o.decodedArgs(); token = t; generation = g;
        }
    }
    private static final class Poll { Cancel request, delay; }
    private final Executor serial;
    private final Environment env;
    private final Cards cards;
    private final Executors executors;
    private final HTTP http;
    private final Clock clock;
    private final Set<WorkspaceOrigin> workspaces = new HashSet<>(), blocked = new HashSet<>();
    private final Map<WorkspaceOrigin, String> blockedTokens = new HashMap<>();
    private final Map<WorkspaceOrigin, Poll> polls = new HashMap<>();
    private final LinkedHashMap<WorkspaceOrigin, PhoneJobsContract.Offer> waiting = new LinkedHashMap<>();
    private boolean foreground, resolvingPush, pushResolved;
    private long generation;
    private volatile Job current; // Only cancellation crosses threads; other job state stays on serial.
    private WorkspaceOrigin pushWorkspace;
    private String pushRef;

    PhoneJobRunner(Executor serial, Environment env, Cards cards, Executors executors, HTTP http, Clock clock) {
        this.serial = serial; this.env = env; this.cards = cards; this.executors = executors; this.http = http; this.clock = clock;
    }
    void start(Set<WorkspaceOrigin> origins, boolean visible) {
        Set<WorkspaceOrigin> copy = new HashSet<>(origins);
        serial.execute(() -> {
            if (!visible) return;
            if (!foreground) { foreground = true; generation++; }
            Set<WorkspaceOrigin> removed = new HashSet<>(workspaces); removed.removeAll(copy);
            workspaces.clear(); workspaces.addAll(copy);
            for (WorkspaceOrigin w : removed) suspendWorkspace(w);
            if (pushRef != null) resolvePush(); else startPolls();
        });
    }
    void refresh(WorkspaceOrigin workspace) {
        serial.execute(() -> {
            String token = env.token(workspace);
            if (!env.enabled(workspace) || token == null) { suspendWorkspace(workspace); return; }
            workspaces.add(workspace);
            if (!token.equals(blockedTokens.get(workspace))) { blocked.remove(workspace); blockedTokens.remove(workspace); }
            startPolls();
        });
    }
    private void suspendWorkspace(WorkspaceOrigin workspace) {
        cancel(polls.remove(workspace)); waiting.remove(workspace);
        Job held = current != null && current.workspace.equals(workspace) ? current : null;
        if (held != null) {
            held.revoked = true; held.cancellation.cancel();
            if (held.executing) held.closing = true;
            else if (held.lease != null) post(held, null, "denied");
            else if (!held.answering) finish(held);
        }
        cards.dismiss(workspace, null);
    }
    void forget(WorkspaceOrigin workspace) {
        cancelCurrent(workspace);
        serial.execute(() -> {
            workspaces.remove(workspace); suspendWorkspace(workspace);
            if (workspace.equals(pushWorkspace) && pushRef != null) closePush(pushRef);
        });
    }
    void stop() {
        cancelCurrent(null);
        serial.execute(() -> {
        if (!foreground) return;
        foreground = false; generation++; pushRef = null; pushResolved = false; waiting.clear(); cancelPolls();
        Job held = current;
        if (held != null) held.cancellation.cancel();
        if (held == null || !held.executing) executors.cancel();
        if (held != null) { held.revoked = true; if (!held.answering || (held.posted && !held.executing)) { held.retainedResult = null; current = null; } }
        for (WorkspaceOrigin w : workspaces) {
            cards.dismiss(w, null);
            String token = env.token(w);
            if (token != null) call(w, token, "POST", "/foreground", json("active", false), 25000, r -> {});
        }
        if (held != null) {
            if (held.executing) held.closing = true;
            else if (held.lease != null) post(held, null, "denied");
        }
    }); }
    void open(WorkspaceOrigin workspace, String eventRef) {
        if (eventRef == null || !eventRef.matches("[a-f0-9]{64}")) return;
        serial.execute(() -> {
            pushWorkspace = workspace; pushRef = eventRef; pushResolved = false; cancelPolls(); waiting.clear();
            if (current != null && !current.answering) finish(current);
            if (foreground) resolvePush();
        });
    }
    private void resolvePush() {
        if (!foreground || resolvingPush || pushResolved || pushRef == null || current != null) return;
        if (blocked.contains(pushWorkspace) || !cards.canPresent(pushWorkspace) || !env.enabled(pushWorkspace)) { closePush(pushRef); return; }
        String token = env.token(pushWorkspace);
        if (token == null) { closePush(pushRef); return; }
        WorkspaceOrigin w = pushWorkspace; String ref = pushRef; long epoch = generation;
        resolvingPush = true;
        call(w, token, "GET", "/jobs?eventRef=" + ref, null, 25000, r -> {
            resolvingPush = false;
            if (!foreground || generation != epoch || !ref.equals(pushRef)) { if (foreground && pushRef != null) resolvePush(); return; }
            if (blocked.contains(w) || r.status != 200) { closePush(ref); return; }
            PhoneJobsContract.TargetedAnswer answer = PhoneJobsContract.TargetedAnswer.parse(r.body);
            if (answer == null) { closePush(ref); return; }
            pushResolved = true;
            if (answer.kind == PhoneJobsContract.TargetedAnswer.Kind.JOBS) { receive(w, answer.job); if (current == null) closePush(ref); }
            else if (answer.kind == PhoneJobsContract.TargetedAnswer.Kind.HANDLED) cards.alreadyHandled(w, null, () -> serial.execute(() -> closePush(ref)));
            else closePush(ref);
        });
    }
    private void closePush(String ref) {
        if (!ref.equals(pushRef)) return;
        pushRef = null; pushResolved = false; startPolls();
    }
    private void startPolls() {
        if (!foreground || pushRef != null) return;
        for (WorkspaceOrigin w : workspaces) {
            if (polls.containsKey(w) || blocked.contains(w) || !env.enabled(w)) continue;
            String token = env.token(w);
            if (token == null) continue;
            Poll poll = new Poll(); polls.put(w, poll); poll(w, token, generation, poll);
        }
    }
    private void poll(WorkspaceOrigin w, String token, long epoch, Poll poll) {
        if (!foreground || epoch != generation || polls.get(w) != poll || blocked.contains(w)) return;
        poll.request = call(w, token, "GET", "/jobs", null, 25000, r -> {
            if (!foreground || epoch != generation || polls.get(w) != poll || blocked.contains(w) || pushRef != null) return;
            if (r.status == 200) {
                PhoneJobsContract.PollAnswer answer = PhoneJobsContract.PollAnswer.parse(r.body);
                if (answer != null) for (PhoneJobsContract.Offer offer : answer.jobs) receive(w, offer);
            }
            poll.delay = clock.after(1000, () -> serial.execute(() -> poll(w, token, epoch, poll)));
        });
    }
    private void cancelPolls() {
        for (Poll p : polls.values()) cancel(p);
        polls.clear();
    }
    private void cancel(Poll p) {
        if (p == null) return;
        if (p.request != null) p.request.cancel();
        if (p.delay != null) p.delay.cancel();
    }
    private void receive(WorkspaceOrigin w, PhoneJobsContract.Offer offer) {
        String token = env.token(w);
        if (!foreground || blocked.contains(w) || !env.enabled(w) || token == null || offer.expiresAt <= clock.now() - 180_000) return;
        if (offer.decodedArgs() == null) {
            call(w, token, "POST", "/jobs/" + offer.operationId + "/decline", json("offerId", offer.offerId), 25000, r -> {}); return;
        }
        if (!cards.canPresent(w)) return; // Leave offscreen offers unleased for their own computer.
        if (current != null) {
            if (!current.workspace.equals(w) || !current.offer.operationId.equals(offer.operationId)) waiting.put(w, offer);
            return;
        }
        Job job = new Job(w, offer, token, generation); current = job;
        if (env.needsProvider(w, offer.provider.id)) { job.providerPending = true; cards.showProvider(w, offer.provider, offer.workspace, allow -> serial.execute(() -> {
            if (!valid(job) || job.answering || !job.providerPending) return;
            job.providerPending = false; job.answering = true;
            if (!allow || !env.recordProvider(w, offer.provider.id)) decline(job);
            else { job.answering = false; show(job); }
        }), () -> serial.execute(() -> finish(job))); }
        else show(job);
    }
    private void show(Job job) { cards.show(job.workspace, job.offer, job.args, allow -> serial.execute(() -> answer(job, allow)), () -> serial.execute(() -> finish(job))); }
    private boolean valid(Job job) {
        return foreground && current == job && generation == job.generation && !job.revoked && !job.cancellation.isCancelled() && !blocked.contains(job.workspace);
    }
    private void decline(Job job) {
        call(job.workspace, job.token, "POST", path(job, "/decline"), json("offerId", job.offer.offerId), 25000, r -> finish(job));
    }
    private void answer(Job job, boolean allow) {
        if (!valid(job) || job.answering) return;
        job.answering = true;
        if (!allow) { decline(job); return; }
        call(job.workspace, job.token, "POST", path(job, "/lease"), json("offerId", job.offer.offerId), 25000, r -> {
            PhoneJobsContract.LeaseAnswer lease = PhoneJobsContract.LeaseAnswer.parse(r.body);
            if (r.status != 200 || lease == null || !lease.active) { finish(job); return; }
            job.lease = lease.leaseToken;
            if (!valid(job)) { post(job, null, "denied"); return; }
            call(job.workspace, job.token, "GET", path(job, ""), null, 3000, notice -> {
                PhoneJobsContract.TargetedAnswer targeted = PhoneJobsContract.TargetedAnswer.parse(notice.body);
                if (notice.status != 200 || targeted == null || targeted.kind != PhoneJobsContract.TargetedAnswer.Kind.LEASED
                    || targeted.expiresAt <= clock.now() - 180_000) {
                    job.revoked = true; cards.dismiss(job.workspace, job.offer.operationId); post(job, null, "denied"); return;
                }
                if (!valid(job) || job.posted || !env.consent(job.workspace, job.offer) || !env.permission(job.offer)) {
                    post(job, null, "denied"); return;
                }
                job.executing = true;
                Thread invokingThread = Thread.currentThread();
                java.util.concurrent.atomic.AtomicBoolean invoking = new java.util.concurrent.atomic.AtomicBoolean(true);
                executors.run(job.workspace, job.offer.operationId, job.offer.capability, job.offer.action, job.args, env.preciseConsent(job.workspace), job.cancellation, output -> {
                    Runnable consume = () -> {
                    job.executing = false;
                    if (job.posted) { if (job.closing) finish(job); return; }
                    // Execution owns the real outcome after stop or revoke.
                    if (output == null) { post(job, null, "invalid_result"); return; }
                    if (output.code != null) {
                        post(job, null, PhoneJobsContract.RESULT_CODES.contains(output.code) ? output.code : "invalid_result"); return;
                    }
                    JSONObject encoded = output.result == null ? null : output.result.encode();
                    if (encoded == null || PhoneJobsContract.Result.parse(job.offer.action, encoded) == null
                        || !PhoneJobsContract.withinResultBound(encoded)) post(job, null, "invalid_result");
                    else post(job, encoded, null);
                    };
                    // Synchronous completions already run on serial. The cancellation signal
                    // also fences a stop received before its queued actor turn.
                    if (invoking.get() && Thread.currentThread() == invokingThread) consume.run();
                    else serial.execute(consume);
                });
                invoking.set(false);
            });
        });
    }
    private static String path(Job job, String suffix) { return "/jobs/" + job.offer.operationId + suffix; }
    private void post(Job job, JSONObject result, String code) {
        if (job.lease == null || job.posted) return;
        job.posted = true;
        JSONObject body = json("leaseToken", job.lease, "ok", code == null);
        try { if (code == null) body.put("result", result); else body.put("code", code); }
        catch (org.json.JSONException impossible) { throw new IllegalStateException(impossible); }
        job.retainedResult = body;
        call(job.workspace, job.token, "POST", path(job, "/result"), body, 25000, r -> {
            if (r.status == 409 && valid(job)) cards.alreadyHandled(job.workspace, job.offer.operationId, () -> serial.execute(() -> finish(job)));
            else if (code == null && valid(job)) {
                job.retainedResult = null;
                cards.used(job.workspace, job.offer, () -> serial.execute(() -> finish(job)));
            } else finish(job);
        });
    }
    private void finish(Job job) {
        if (job.executing) { job.closing = true; return; } // Never overlap executors across a background/reopen.
        job.retainedResult = null;
        if (current != job) return;
        current = null; cards.dismiss(job.workspace, job.offer.operationId);
        if (foreground && pushRef != null) {
            if (pushResolved) closePush(pushRef); else resolvePush();
        }
        if (foreground && pushRef == null && !waiting.isEmpty()) {
            Map.Entry<WorkspaceOrigin, PhoneJobsContract.Offer> next = waiting.entrySet().iterator().next();
            WorkspaceOrigin w = next.getKey(); PhoneJobsContract.Offer offer = next.getValue(); waiting.remove(w); receive(w, offer);
        }
    }
    void registration(WorkspaceOrigin workspace, String method, String token, JSONObject body, Consumer<Integer> done) {
        serial.execute(() -> {
            if (blocked.contains(workspace) && (!env.enabled(workspace) || token == null || !token.equals(env.token(workspace)) || token.equals(blockedTokens.get(workspace)))) { done.accept(403); return; }
            call(workspace, token, method, "", body, 25000, response -> {
                if (response.status == 200) refresh(workspace);
                done.accept(response.status);
            });
        });
    }
    // Signal immediately, even while serial is busy preparing an OS write.
    private void cancelCurrent(WorkspaceOrigin workspace) {
        Job held = current;
        if (held != null && (workspace == null || held.workspace.equals(workspace))) held.cancellation.cancel();
    }
    /** Every bearer route, including registration, feeds this notice before completing. */
    void notice(WorkspaceOrigin workspace, int status, String token, Runnable done) {
        if (status == 401 || status == 403) cancelCurrent(workspace);
        serial.execute(() -> { noticeOnActor(workspace, status, token); done.run(); });
    }
    private void noticeOnActor(WorkspaceOrigin workspace, int status, String token) {
        if (status != 401 && status != 403) return;
        if (!blocked.contains(workspace)) blockedTokens.put(workspace, token);
        blocked.add(workspace); cancel(polls.remove(workspace)); waiting.remove(workspace);
        Job held = current != null && current.workspace.equals(workspace) ? current : null;
        if (held != null) { held.revoked = true; held.cancellation.cancel(); if (!held.executing) executors.cancel(); }
        cards.dismiss(workspace, null); env.turnOff(workspace);
        if (held != null) {
            if (held.executing) held.closing = true;
            else if (held.lease != null) post(held, null, "denied");
            else if (!held.answering) finish(held);
        }
    }
    private Cancel call(WorkspaceOrigin w, String token, String method, String suffix, JSONObject body, int timeout, Consumer<Response> done) {
        return http.send(w, token, method, suffix, body, timeout, response -> {
            Response r = response == null ? new Response(0, null) : response;
            if (r.status == 401 || r.status == 403) cancelCurrent(w);
            serial.execute(() -> { noticeOnActor(w, r.status, token); done.accept(r); });
        });
    }
    static JSONObject json(Object... pairs) {
        JSONObject value = new JSONObject();
        try { for (int i = 0; i < pairs.length; i += 2) value.put((String) pairs[i], pairs[i + 1]); }
        catch (org.json.JSONException impossible) { throw new IllegalArgumentException(impossible); }
        return value;
    }
}
