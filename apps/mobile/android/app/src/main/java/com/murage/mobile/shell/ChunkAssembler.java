package com.murage.mobile.shell;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.function.LongSupplier;

/**
 * The native half of save-file.ts saveBlobNatively: {@code begin}, chunks in
 * order from index 0, {@code end}; {@code abort} on any failure. Twin of
 * ChunkAssembler.swift. Each chunk is appended as it arrives, so at most one
 * 1 MiB piece (and its base64, capped before decoding) is held here, and at
 * most {@link #MAX_OPEN} transfers are open at once.
 */
public final class ChunkAssembler {
    public static final int MAX_OPEN = 2;
    public static final long IDLE_LIMIT_MS = 120_000;

    /**
     * Where the bytes go. {@code id} and {@code filename} come from the page:
     * {@code filename} has already been through {@link FileNames#safe}, and
     * {@code id} must never become a path component.
     */
    public interface Sink {
        File create(String id, String filename) throws IOException;
        void append(byte[] data, File file) throws IOException;
        void discard(File file);
    }

    public static final class Assembled {
        public final File file;
        public final String filename;
        public final String mime;
        public final int size;

        Assembled(File file, String filename, String mime, int size) {
            this.file = file;
            this.filename = filename;
            this.mime = mime;
            this.size = size;
        }
    }

    private static final class Transfer {
        final File file;
        final String filename;
        final String mime;
        final int size;
        int next;
        int received;
        long touched;

        Transfer(File file, String filename, String mime, int size, long touched) {
            this.file = file;
            this.filename = filename;
            this.mime = mime;
            this.size = size;
            this.touched = touched;
        }
    }

    private final Map<String, Transfer> open = new HashMap<>();
    private final Sink sink;
    private final LongSupplier now;

    public ChunkAssembler(Sink sink, LongSupplier now) {
        this.sink = sink;
        this.now = now;
    }

    public synchronized int openCount() {
        return open.size();
    }

    public synchronized void begin(String id, String filename, String mime, int size) throws ChannelException {
        expireIdle();
        if (id == null || open.containsKey(id) || size < 0) throw new ChannelException("bad_args");
        if (size > SaveRequest.MAX_BYTES) throw new ChannelException("too_large");
        if (open.size() >= MAX_OPEN) throw new ChannelException("busy");
        File file;
        try {
            file = sink.create(id, filename);
        } catch (IOException failed) {
            throw new ChannelException("write_failed");
        }
        open.put(id, new Transfer(file, filename, mime, size, now.getAsLong()));
    }

    public synchronized void chunk(String id, int index, String base64) throws ChannelException {
        Transfer transfer = id == null ? null : open.get(id);
        // A repeated, skipped or late index is refused: a chunk is never written twice.
        if (transfer == null || index != transfer.next || base64 == null) throw new ChannelException("bad_args");
        // Bounded before decoding, so no over-long string is ever expanded.
        if (base64.length() > SaveRequest.MAX_BASE64) throw new ChannelException("too_large");
        // Padded, like btoa() and Swift's Data(base64Encoded:); Java alone would take "aGk".
        if (base64.length() % 4 != 0) throw new ChannelException("bad_args");
        // An empty chunk makes no progress, so it only counts when the whole file is empty (P9 ruling, both twins).
        if (base64.isEmpty() && transfer.size != 0) throw new ChannelException("bad_args");
        byte[] data;
        try {
            data = Base64.getDecoder().decode(base64);
        } catch (IllegalArgumentException invalid) {
            throw new ChannelException("bad_args");
        }
        if (data.length > SaveRequest.CHUNK_BYTES || transfer.received + data.length > transfer.size) throw new ChannelException("too_large");
        try {
            sink.append(data, transfer.file);
        } catch (IOException failed) {
            // Part of the chunk may be on disk: discard the transfer so a retry can never append after it.
            abort(id);
            throw new ChannelException("write_failed");
        }
        transfer.next += 1;
        transfer.received += data.length;
        transfer.touched = now.getAsLong();
    }

    /** A short transfer stays open so the page's abort can discard it. After end the file is the caller's. */
    public synchronized Assembled end(String id) throws ChannelException {
        Transfer transfer = open.get(id);
        if (transfer == null || transfer.received != transfer.size) throw new ChannelException("bad_args");
        open.remove(id);
        return new Assembled(transfer.file, transfer.filename, transfer.mime, transfer.size);
    }

    /** Discards the temporary file. Unknown or finished ids are a no-op. */
    public synchronized void abort(String id) {
        Transfer transfer = id == null ? null : open.remove(id);
        if (transfer != null) sink.discard(transfer.file);
    }

    /** A page that reloaded mid-transfer never sends abort. */
    private void expireIdle() {
        long cutoff = now.getAsLong() - IDLE_LIMIT_MS;
        for (String id : new ArrayList<>(open.keySet())) {
            if (open.get(id).touched < cutoff) abort(id);
        }
    }
}
