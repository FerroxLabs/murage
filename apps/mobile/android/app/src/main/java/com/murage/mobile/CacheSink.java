package com.murage.mobile;

import android.content.Context;
import com.murage.mobile.shell.ChunkAssembler;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/**
 * The temp directory for generated saves, {@code cache/murage-saves}, and the
 * ChunkAssembler sink: one fresh directory per transfer, so a page-chosen
 * name reaches nothing else and the page's id never becomes a path.
 * SaveController deletes a transfer's directory once MediaStore has the file;
 * anything a crash leaves is swept at startup and pruned by age.
 */
final class CacheSink implements ChunkAssembler.Sink {
    static final String DIRECTORY = "murage-saves";
    /** A leftover older than this, and not in use by this process, is pruned. */
    static final long MAX_AGE_MS = 600_000;
    /** This process's transfer directories that are still in use. */
    private static final Set<File> LIVE = new HashSet<>();

    private final File base;

    CacheSink(Context context) {
        this(new File(context.getCacheDir(), DIRECTORY));
    }

    CacheSink(File base) {
        this.base = base;
    }

    @Override public File create(String id, String filename) throws IOException {
        prune(base);
        File directory = new File(base, UUID.randomUUID().toString());
        if (!directory.mkdirs()) throw new IOException("no directory");
        synchronized (LIVE) {
            LIVE.add(directory);
        }
        File file = new File(directory, filename);
        try {
            // FileNames.safe already allows one plain component; the sink holds to it anyway.
            if (!directory.getCanonicalFile().equals(file.getCanonicalFile().getParentFile())) throw new IOException("not a plain name");
            if (!file.createNewFile()) throw new IOException("exists");
        } catch (IOException | RuntimeException failed) {
            delete(directory);
            throw failed instanceof IOException ? (IOException) failed : new IOException(failed);
        }
        return file;
    }

    @Override public void append(byte[] data, File file) throws IOException {
        try (FileOutputStream out = new FileOutputStream(file, true)) {
            out.write(data);
        }
    }

    @Override public void discard(File file) {
        delete(file.getParentFile());
    }

    /**
     * Deletes whatever an earlier process left behind (killed mid-transfer).
     * Shell calls it once per process, before any save can exist, so a live
     * transfer is never swept (P18 ruling).
     */
    static void sweep(Context context) {
        File base = new File(context.getCacheDir(), DIRECTORY);
        if (!base.exists()) return;
        int removed = deleteTree(base);
        ShellLog.i("saves swept files=" + removed);
    }

    /** A transfer's own directory and its file; it is no longer in use. */
    static void delete(File directory) {
        if (directory == null) return;
        deleteTree(directory);
        synchronized (LIVE) {
            LIVE.remove(directory);
        }
    }

    static boolean inUse(File directory) {
        synchronized (LIVE) {
            return LIVE.contains(directory);
        }
    }

    /** Leftovers this process does not own whose newest entry is older than MAX_AGE_MS. */
    static void prune(File base) {
        File[] directories = base.listFiles();
        if (directories == null) return;
        long cutoff = System.currentTimeMillis() - MAX_AGE_MS;
        int removed = 0;
        for (File directory : directories) {
            if (inUse(directory) || newest(directory) >= cutoff) continue;
            removed += deleteTree(directory);
        }
        if (removed > 0) ShellLog.i("saves pruned files=" + removed);
    }

    private static long newest(File directory) {
        long newest = directory.lastModified();
        File[] children = directory.listFiles();
        if (children != null) {
            for (File child : children) newest = Math.max(newest, child.lastModified());
        }
        return newest;
    }

    private static int deleteTree(File file) {
        int count = 0;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) count += deleteTree(child);
        }
        boolean isFile = file.isFile();
        if (file.delete() && isFile) count++;
        return count;
    }
}
