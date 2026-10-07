package com.murage.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.murage.mobile.shell.PairingLink;
import org.junit.Before;
import org.junit.Test;

public class InstallIdTest {
    private FakePrefs prefs;
    private LogCapture log;

    @Before public void setUp() {
        prefs = new FakePrefs();
        log = new LogCapture();
    }

    @Test public void mintsOnceAndKeepsIt() {
        String first = InstallId.from(prefs);
        assertTrue(PairingLink.validInstallId(first));
        assertTrue(first.startsWith("and-"));
        assertEquals(first, InstallId.from(prefs));
        assertEquals(first, prefs.values.get("installId"));
    }

    @Test public void neverOverwritesAPresentButInvalidValue() {
        prefs.values.put("installId", "short");
        assertNull(InstallId.from(prefs));
        assertEquals("short", prefs.values.get("installId"));
        assertTrue(log.all().contains("install id unreadable"));
        assertTrue(!log.all().contains("short"));
    }

    @Test public void logsAFailedSaveButStillAnswers() {
        prefs.commitSucceeds = false;
        String id = InstallId.from(prefs);
        assertTrue(PairingLink.validInstallId(id));
        assertTrue(log.all().contains("install id save failed"));
    }
}
