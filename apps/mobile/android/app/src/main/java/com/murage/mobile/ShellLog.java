package com.murage.mobile;

import android.util.Log;

/**
 * Content-free logging (Global Constraints): methods, status codes, hosts,
 * byte counts and timings. Never a cookie, a credential, the /enter
 * fragment, message text or a thread id. E2E reads these lines (P26).
 */
final class ShellLog {
    static final String TAG = "MurageShell";

    interface Sink {
        void line(String message);
    }

    /** JVM tests swap this: android.util.Log is only a stub there. */
    static Sink sink = message -> Log.i(TAG, message);

    private ShellLog() {}

    static void i(String message) {
        sink.line(message);
    }
}
