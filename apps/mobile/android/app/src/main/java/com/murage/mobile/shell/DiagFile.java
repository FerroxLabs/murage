package com.murage.mobile.shell;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Twin of DiagFile.swift: the device's record of the page's [call-diag] and
 * [call-trace] console lines (channel method diagLine). One `ISO8601 <line>`
 * per call, appended to one file that rotates at maxBytes, keeping one old
 * file (`<name>.1`). Callers serialise on one thread.
 */
public final class DiagFile {
    public static final int MAX_BYTES = 2 * 1024 * 1024;
    public static final String FILE_NAME = "murage-call-diag.log";

    public final File file;
    private final long maxBytes;

    public DiagFile(File file, long maxBytes) {
        this.file = file;
        this.maxBytes = maxBytes;
    }

    public File old() {
        return new File(file.getPath() + ".1");
    }

    public static String stamp(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(millis));
    }

    public boolean append(String line, long nowMillis) {
        byte[] data = (stamp(nowMillis) + " " + line + "\n").getBytes(StandardCharsets.UTF_8);
        long size = file.length();
        if (size > 0 && size + data.length > maxBytes) {
            old().delete();
            file.renameTo(old());
        }
        try (FileOutputStream out = new FileOutputStream(file, true)) {
            out.write(data);
            return true;
        } catch (IOException failed) {
            return false;
        }
    }
}
