package com.murage.mobile.shell;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

/** The shared fixtures in apps/mobile/contract (P4). Gradle runs unit tests from android/app. */
final class Fixtures {
    private Fixtures() {}

    static String read(String name) throws Exception {
        return new String(Files.readAllBytes(Paths.get("../../contract", name)), StandardCharsets.UTF_8);
    }
}
