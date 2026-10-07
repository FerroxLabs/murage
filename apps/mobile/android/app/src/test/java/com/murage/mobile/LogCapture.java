package com.murage.mobile;

import java.util.ArrayList;
import java.util.List;

/** Swaps ShellLog's sink for a list, since android.util.Log is a stub on the JVM. */
final class LogCapture {
    final List<String> lines = new ArrayList<>();

    LogCapture() {
        ShellLog.sink = lines::add;
    }

    String all() {
        return String.join("\n", lines);
    }
}
