package com.murage.mobile;

import java.util.concurrent.Executor;

/**
 * At most one pass running and one more waiting (A5 review Minor 5): a request
 * while a pass runs asks for one more after it, however many arrive, so a burst of
 * resumes costs two passes, not one per resume. The later pass reads fresh state.
 */
final class Coalesce {
    private final Executor executor;
    private final Runnable pass;
    private boolean running, again;

    Coalesce(Executor executor, Runnable pass) { this.executor = executor; this.pass = pass; }

    void request() {
        synchronized (this) {
            if (running) { again = true; return; }
            running = true;
        }
        try {
            executor.execute(this::drain);
        } catch (RuntimeException rejected) {
            synchronized (this) { running = false; again = false; }
            throw rejected;
        }
    }

    private void drain() {
        boolean more = true;
        try {
            while (more) {
                pass.run();
                synchronized (this) {
                    more = again;
                    again = false;
                    if (!more) running = false;
                }
            }
        } finally {
            // A pass that threw: the next request starts afresh rather than finding it stuck.
            if (more) synchronized (this) { running = false; again = false; }
        }
    }
}
