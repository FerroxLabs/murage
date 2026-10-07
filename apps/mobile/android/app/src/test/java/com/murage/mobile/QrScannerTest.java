package com.murage.mobile;

import static org.junit.Assert.*;

import com.google.mlkit.common.MlKitException;
import org.junit.Test;

/** P21: the scanner hands the launcher only what PairingLink.parse accepts, trimmed like open(). */
public class QrScannerTest {
    private static final String LINK = "https://mac.tailnet123.ts.net:8444/enter#murage_pair_abc";

    @Test
    public void acceptsThePairingLink() {
        assertEquals(LINK, QrScanner.accept(LINK));
    }

    @Test
    public void trimsTheWayOpenTrims() {
        assertEquals(LINK, QrScanner.accept("\n\t " + LINK + "\r\n"));
        assertEquals(LINK, QrScanner.accept(" " + LINK + " "));
    }

    /**
     * P23 fix round 2: once the module is confirmed available, every
     * startScan failure means the person left the scanner's screen -- not
     * only CODE_SCANNER_CANCELLED. Seen on a Galaxy S25 (Android 16): Back
     * arrives as MlKitException code 13 (INTERNAL), never that code and
     * never onCanceled.
     */
    @Test
    public void treatsEveryFailureAsCancelledOnceTheModuleIsAvailable() {
        assertEquals("cancelled", QrScanner.failureCode(new MlKitException("cancelled", MlKitException.CODE_SCANNER_CANCELLED)));
        assertEquals("cancelled", QrScanner.failureCode(new MlKitException("back on a Galaxy S25", 13)));
        assertEquals("cancelled", QrScanner.failureCode(new MlKitException("unavailable", MlKitException.UNAVAILABLE)));
        assertEquals("cancelled", QrScanner.failureCode(new MlKitException("in progress", MlKitException.CODE_SCANNER_TASK_IN_PROGRESS)));
        assertEquals("cancelled", QrScanner.failureCode(new RuntimeException("anything else")));
    }

    /**
     * The one exception: Android has no camera_denied code in the shared
     * contract (apps/mobile/src/shell-types.ts SHELL_ERRORS), so a denied
     * camera permission maps to unavailable instead.
     */
    @Test
    public void mapsTheDeniedCameraPermissionToUnavailable() {
        assertEquals(
            "unavailable",
            QrScanner.failureCode(new MlKitException("camera", MlKitException.CODE_SCANNER_CAMERA_PERMISSION_NOT_GRANTED)));
    }

    @Test
    public void refusesAnyOtherCode() {
        assertNull(QrScanner.accept(null));
        assertNull(QrScanner.accept(""));
        assertNull(QrScanner.accept("WIFI:S:home;T:WPA;P:secret;;"));
        assertNull(QrScanner.accept("https://mac.tailnet123.ts.net/"));
        assertNull(QrScanner.accept("http://mac.tailnet123.ts.net/enter#murage_pair_abc"));
        assertNull(QrScanner.accept("https://mac.tailnet123.ts.net/enter?x=1#murage_pair_abc"));
        assertNull(QrScanner.accept(LINK + "&installId=ios-0123456789abcdef"));
        assertNull(QrScanner.accept(LINK + "a".repeat(4096)));
    }
}
