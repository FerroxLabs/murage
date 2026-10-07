package com.murage.mobile;

import com.murage.mobile.shell.PushContract;
import com.murage.mobile.shell.PushOutcome;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;

/**
 * The 5 s detail fetch (Global Constraints), apart from the service so JVM
 * tests can drive it. ANY failure (Tailscale off, a fast failure before the
 * first unlock, a timeout, a non-200, a bad body) leaves the generic text.
 */
final class PushDetailFetch {
    static final long DEADLINE_MS = 5000;
    /** PushContract's REF pattern, checked again where the URL is built (defence in depth). */
    private static final Pattern REF = Pattern.compile("^[a-f0-9]{64}$");
    private PushDetailFetch() {}

    /** The door's detail route: GET /api/mobile/push/<eventRef> with the detail bearer (companion/src/push-door.ts). */
    static Callable<PushHttp.Answer> door(String origin, String eventRef, String detailToken) {
        return door(origin, eventRef, detailToken, PushHttp::call, (int) DEADLINE_MS);
    }

    /** The same request through any caller: the action receiver's second try (A5) uses it too. */
    static Callable<PushHttp.Answer> door(String origin, String eventRef, String detailToken, PushHttp.Caller http, int timeoutMs) {
        if (eventRef == null || !REF.matcher(eventRef).matches()) {
            ShellLog.i("push detail refused bad-ref");
            return () -> null; // no request; fetch shows the generic text
        }
        return () -> http.call("GET", origin + "/api/mobile/push/" + eventRef, detailToken, null, timeoutMs);
    }

    static PushOutcome.Detail fetch(ExecutorService pool, Callable<PushHttp.Answer> call, long deadlineMs, PushContract.Category category) {
        Future<PushHttp.Answer> answer = null;
        try {
            answer = pool.submit(call);
            PushHttp.Answer a = answer.get(deadlineMs, TimeUnit.MILLISECONDS);
            return a == null ? generic(category) : PushOutcome.detail(a.status, a.body, category);
        } catch (TimeoutException late) {
            ShellLog.i("push detail timeout ms=" + deadlineMs);
        } catch (InterruptedException stopped) {
            Thread.currentThread().interrupt();
        } catch (Exception failed) {
            ShellLog.i("push detail failed error=" + failed.getClass().getSimpleName());
        }
        if (answer != null) answer.cancel(true);
        return generic(category);
    }

    static PushOutcome.Detail generic(PushContract.Category category) {
        return PushOutcome.detail(null, null, category);
    }
}
