package com.murage.mobile;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * One run per key at a time (PushRegistrar's registerPush): a call for a key
 * already running waits for that run's answer. The entry is cleared in a
 * finally, so even an Error in the work answers every waiter (with null) and
 * the next call starts a new run (A4 review, Minor 5).
 */
final class SingleFlight<V> {
    private final Map<String, List<Consumer<V>>> inFlight = new HashMap<>();
    private final Executor work, answers;

    SingleFlight(Executor work, Executor answers) { this.work = work; this.answers = answers; }

    void run(String key, Consumer<V> done, Supplier<V> task) {
        synchronized (inFlight) {
            List<Consumer<V>> waiting = inFlight.get(key);
            if (waiting != null) { waiting.add(done); return; }
            inFlight.put(key, new ArrayList<>(Collections.singletonList(done)));
        }
        work.execute(() -> {
            Object[] answer = {null};
            try {
                answer[0] = task.get();
            } finally {
                List<Consumer<V>> waiting;
                synchronized (inFlight) { waiting = inFlight.remove(key); }
                @SuppressWarnings("unchecked") V result = (V) answer[0];
                answers.execute(() -> { for (Consumer<V> each : waiting) each.accept(result); });
            }
        });
    }
}
