package com.murage.mobile.shell;

/** Plan 1 note 5: a non-2xx download is a failed save, never a file. */
public final class DownloadGate {
    private DownloadGate() {}

    public static boolean accept(Integer status) {
        return status == null || (status >= 200 && status < 300);
    }
}
