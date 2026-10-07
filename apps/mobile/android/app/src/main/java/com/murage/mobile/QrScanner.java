package com.murage.mobile;

import android.app.Activity;
import com.google.android.gms.common.moduleinstall.ModuleInstall;
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest;
import com.google.mlkit.common.MlKitException;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import com.murage.mobile.shell.PairingLink;
import com.murage.mobile.shell.WorkspaceOrigin;

/**
 * The pairing QR scanner (spec §3.1): Google's code scanner, no camera
 * permission needed. Twin of QRScannerViewController.swift: it answers
 * exactly once, with the first code that is a pairing link the core parses,
 * {@code cancelled} when the person leaves, {@code unavailable} when the
 * scanner cannot run. Any other code is ignored and scanning goes on (the
 * Google scanner closes after each code, so it is started again).
 *
 * <p>The scanner's UI is a Play services module. The manifest asks Play to
 * fetch it at install ({@code barcode_ui}); before startScan is ever called
 * its availability is checked with {@code ModuleInstall.areModulesAvailable}.
 * Not available (a sideloaded build, or the download has not happened yet):
 * the module is requested and this scan answers {@code unavailable} at once
 * rather than waiting on a download. The next tap can scan once it has
 * arrived. If the availability check itself fails, the scan is tried anyway.
 *
 * <p>Once the module is confirmed available, the scanner's own screen is
 * shown, so any startScan failure -- onCanceled, {@code
 * CODE_SCANNER_CANCELLED}, or anything else, including the {@code
 * MlKitException} code 13 (INTERNAL) that Back produces on a Galaxy S25,
 * Android 16, in place of a cancel -- means the person left it: that
 * answers {@code cancelled} and requests nothing, so the launcher leaves
 * the screen alone and the person can tap again. The one exception is a
 * denied camera permission ({@code CODE_SCANNER_CAMERA_PERMISSION_NOT_GRANTED}),
 * which answers {@code unavailable} (Android has no {@code camera_denied}
 * code in the shared contract).
 */
final class QrScanner {
    interface Done {
        void text(String value);

        void failed(String code);
    }

    private QrScanner() {}

    /**
     * The scanned text the launcher gets, or null when it is not a pairing
     * link: trimmed the way open() trims its input, then PairingLink.parse.
     */
    static String accept(String raw) {
        String trimmed = WorkspaceOrigin.trimInput(raw);
        return trimmed == null || PairingLink.parse(trimmed) == null ? null : trimmed;
    }

    /**
     * What a startScan failure answers once the module is confirmed
     * available: cancelled, unless the camera permission was denied, which
     * has no code of its own in the shared contract and maps to unavailable.
     */
    static String failureCode(Exception error) {
        if (error instanceof MlKitException
            && ((MlKitException) error).getErrorCode() == MlKitException.CODE_SCANNER_CAMERA_PERMISSION_NOT_GRANTED) {
            return "unavailable";
        }
        return "cancelled";
    }

    /** Main thread. */
    static void scan(Activity activity, Done done) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build();
        GmsBarcodeScanner scanner;
        try {
            scanner = GmsBarcodeScanning.getClient(activity, options);
        } catch (RuntimeException unavailable) {
            ShellLog.i("scan unavailable");
            done.failed("unavailable");
            return;
        }
        checkModule(activity, scanner, done);
    }

    /**
     * Confirms the module is available before the scanner's UI is ever
     * shown, so a scan that cannot run answers unavailable at once instead
     * of surfacing as a false cancel once startScan is tried.
     */
    private static void checkModule(Activity activity, GmsBarcodeScanner scanner, Done done) {
        if (activity.isFinishing() || activity.isDestroyed()) {
            done.failed("unavailable");
            return;
        }
        try {
            ModuleInstall.getClient(activity).areModulesAvailable(scanner)
                .addOnSuccessListener(response -> {
                    if (response.areModulesAvailable()) {
                        next(activity, scanner, done);
                        return;
                    }
                    ShellLog.i("scan module not available");
                    requestModule(activity, scanner);
                    done.failed("unavailable");
                })
                .addOnFailureListener(error -> {
                    ShellLog.i("scan module check failed, trying anyway");
                    next(activity, scanner, done);
                });
        } catch (RuntimeException unavailable) {
            ShellLog.i("scan module check failed, trying anyway");
            next(activity, scanner, done);
        }
    }

    private static void next(Activity activity, GmsBarcodeScanner scanner, Done done) {
        if (activity.isFinishing() || activity.isDestroyed()) {
            done.failed("unavailable");
            return;
        }
        // Not activity-scoped listeners: those are dropped when the scanner's own
        // screen stops this activity, and the launcher would never hear back.
        // Without an executor they run on the main thread.
        try {
            scanner.startScan()
                .addOnSuccessListener(code -> {
                    String value = accept(code.getRawValue());
                    if (value != null) {
                        done.text(value);
                        return;
                    }
                    ShellLog.i("scan ignored a code that is not a pairing link");
                    next(activity, scanner, done);
                })
                .addOnCanceledListener(() -> done.failed("cancelled"))
                .addOnFailureListener(error -> {
                    ShellLog.i("scan failed type=" + error.getClass().getSimpleName()
                        + (error instanceof MlKitException ? " code=" + ((MlKitException) error).getErrorCode() : ""));
                    done.failed(failureCode(error));
                });
        } catch (RuntimeException unavailable) {
            ShellLog.i("scan unavailable");
            done.failed("unavailable");
        }
    }

    /** Starts the module download; the result is only logged (content-free). */
    private static void requestModule(Activity activity, GmsBarcodeScanner scanner) {
        try {
            ModuleInstall.getClient(activity).installModules(ModuleInstallRequest.newBuilder().addApi(scanner).build())
                .addOnSuccessListener(response -> ShellLog.i("scan module requested installed=" + response.areModulesAlreadyInstalled()))
                .addOnFailureListener(error -> ShellLog.i("scan module request failed"));
        } catch (RuntimeException unavailable) {
            ShellLog.i("scan module request failed");
        }
    }
}
