package com.murage.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/** Data minimisation: the last workspace going releases the FCM token and the Firebase installation, best effort. */
public class DeviceReleaseTest {
    private final LogCapture log = new LogCapture();

    @Test public void bothStepsRunInOrder() {
        List<String> ran = new ArrayList<>();
        DeviceRelease.run(() -> ran.add("token"), () -> ran.add("installation"));
        assertEquals(List.of("token", "installation"), ran);
        assertTrue(log.lines.isEmpty());
    }

    @Test public void aFailedTokenDeleteDoesNotStopTheInstallationDelete() {
        List<String> ran = new ArrayList<>();
        DeviceRelease.run(() -> { throw new java.io.IOException("secret-token-value"); }, () -> ran.add("installation"));
        assertEquals(List.of("installation"), ran);
        assertTrue(log.all().contains("IOException"));
        assertFalse(log.all().contains("secret-token-value"));
    }

    @Test public void aFailedInstallationDeleteIsLoggedWithoutItsMessage() {
        DeviceRelease.run(() -> { }, () -> { throw new IllegalStateException("secret-token-value"); });
        assertTrue(log.all().contains("IllegalStateException"));
        assertFalse(log.all().contains("secret-token-value"));
    }
}
