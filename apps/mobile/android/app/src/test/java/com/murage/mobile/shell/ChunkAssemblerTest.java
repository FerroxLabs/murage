package com.murage.mobile.shell;

import static org.junit.Assert.*;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Before;
import org.junit.Test;
import org.json.JSONArray;
import org.json.JSONObject;

public class ChunkAssemblerTest {
    static final class MemorySink implements ChunkAssembler.Sink {
        final Map<File, ByteArrayOutputStream> files = new HashMap<>();
        final List<File> discarded = new ArrayList<>();
        boolean failWrites;

        @Override public File create(String id, String filename) {
            File file = new File("/memory/" + id + "/" + filename);
            files.put(file, new ByteArrayOutputStream());
            return file;
        }

        @Override public void append(byte[] data, File file) throws IOException {
            if (failWrites) throw new IOException("disk full");
            files.get(file).write(data);
        }

        @Override public void discard(File file) {
            discarded.add(file);
            files.remove(file);
        }
    }

    private MemorySink sink;
    private long clock;
    private ChunkAssembler assembler;

    @Before public void setUp() {
        sink = new MemorySink();
        clock = 1_000_000;
        assembler = new ChunkAssembler(sink, () -> clock);
    }

    private static String b64(String text) {
        return Base64.getEncoder().encodeToString(text.getBytes(StandardCharsets.UTF_8));
    }

    private void expect(String code, ThrowingRunnable body) {
        try {
            body.run();
            fail("expected " + code);
        } catch (ChannelException refused) {
            assertEquals(code, refused.code);
        }
    }

    interface ThrowingRunnable { void run() throws ChannelException; }

    @Test public void assemblesChunksInOrder() throws Exception {
        assembler.begin("a", "n.txt", "text/plain", 10);
        assembler.chunk("a", 0, b64("hello"));
        assembler.chunk("a", 1, b64("world"));
        ChunkAssembler.Assembled file = assembler.end("a");
        assertEquals("helloworld", sink.files.get(file.file).toString("UTF-8"));
        assertEquals(10, file.size);
        assertEquals(0, assembler.openCount());
    }

    @Test public void refusesOutOfOrderOversizedAndInvalidChunks() throws Exception {
        assembler.begin("a", "n.txt", "text/plain", 3);
        expect("bad_args", () -> assembler.chunk("a", 1, b64("hi")));
        expect("too_large", () -> assembler.chunk("a", 0, b64("hello")));
        expect("bad_args", () -> assembler.chunk("a", 0, "not base64!"));
    }

    @Test public void refusesAChunkOverOneMebibyte() throws Exception {
        assembler.begin("a", "n.bin", "application/octet-stream", SaveRequest.MAX_BYTES);
        String big = Base64.getEncoder().encodeToString(new byte[SaveRequest.CHUNK_BYTES + 1]);
        expect("too_large", () -> assembler.chunk("a", 0, big));
        expect("too_large", () -> assembler.begin("b", "n.bin", "x", SaveRequest.MAX_BYTES + 1));
    }

    @Test public void endBeforeEveryByteArrivedIsRefusedAndAbortDiscards() throws Exception {
        assembler.begin("a", "n.txt", "text/plain", 10);
        assembler.chunk("a", 0, b64("hello"));
        expect("bad_args", () -> assembler.end("a"));
        assembler.abort("a");
        assembler.abort("a");
        assertEquals(1, sink.discarded.size());
        assertEquals(0, assembler.openCount());
    }

    @Test public void atMostTwoAtOnceAndIdleOnesExpire() throws Exception {
        assembler.begin("a", "a.txt", "text/plain", 1);
        assembler.begin("b", "b.txt", "text/plain", 1);
        expect("busy", () -> assembler.begin("c", "c.txt", "text/plain", 1));
        clock += ChunkAssembler.IDLE_LIMIT_MS + 1;
        assembler.begin("c", "c.txt", "text/plain", 1);
        assertEquals(2, sink.discarded.size());
        assertEquals(1, assembler.openCount());
    }

    @Test public void writeFailuresDuplicatesAndUnknownTransfers() throws Exception {
        assembler.begin("a", "a.txt", "text/plain", 5);
        expect("bad_args", () -> assembler.begin("a", "a.txt", "text/plain", 5));
        expect("bad_args", () -> assembler.chunk("zz", 0, b64("x")));
        expect("bad_args", () -> assembler.end("zz"));
        sink.failWrites = true;
        expect("write_failed", () -> assembler.chunk("a", 0, b64("hello")));
    }

    /** The shared begin/chunk/end/abort rows in contract/channel.json, through the parser and the assembler. */
    @Test public void sharedTransferRows() throws Exception {
        JSONObject channel = new JSONObject(Fixtures.read("channel.json"));
        WorkspaceOrigin origin = WorkspaceOrigin.parse(channel.getString("origin"));
        JSONArray saves = channel.getJSONArray("saves");
        ChunkAssembler.Assembled done = null;
        int fed = 0;
        for (int i = 0; i < saves.length(); i++) {
            JSONObject entry = saves.getJSONObject(i);
            if (entry.has("error")) continue;
            SaveRequest request = SaveRequest.parse(entry.getJSONObject("request"), origin);
            switch (request.kind) {
                case "begin": assembler.begin(request.id, request.filename, request.mime, request.size); break;
                case "chunk": assembler.chunk(request.id, request.index, request.base64); break;
                case "end": done = assembler.end(request.id); break;
                case "abort": assembler.abort(request.id); break;
                default: continue;
            }
            fed++;
        }
        assertEquals(4, fed);
        assertNotNull(done);
        assertEquals("notes.txt", done.filename);
        assertEquals("text/plain", done.mime);
        assertEquals("hello", sink.files.get(done.file).toString("UTF-8"));
        // After end the file is the caller's: a late abort must not delete it.
        assertTrue(sink.discarded.isEmpty());
        assertEquals(0, assembler.openCount());
    }

    @Test public void aRepeatedChunkIsRefusedAndNotWrittenTwice() throws Exception {
        assembler.begin("a", "n.txt", "text/plain", 10);
        assembler.chunk("a", 0, b64("hello"));
        expect("bad_args", () -> assembler.chunk("a", 0, b64("hello")));
        expect("bad_args", () -> assembler.chunk("a", 2, b64("world")));
        assembler.chunk("a", 1, b64("world"));
        expect("too_large", () -> assembler.chunk("a", 2, b64("!")));
        assertEquals("helloworld", sink.files.get(assembler.end("a").file).toString("UTF-8"));
    }

    /** The length is checked before anything is decoded, so no over-long string is ever expanded. */
    @Test public void anOverlongBase64StringIsRefusedBeforeDecoding() throws Exception {
        assembler.begin("a", "n.bin", "application/octet-stream", SaveRequest.MAX_BYTES);
        // Not even base64: only the length check can answer too_large (a decode would say bad_args).
        String huge = "!".repeat(SaveRequest.MAX_BASE64 + 4);
        expect("too_large", () -> assembler.chunk("a", 0, huge));
        assertEquals(0, sink.files.values().iterator().next().size());
    }

    /** What the page sends is always padded (save-file.ts), and Swift's Data(base64Encoded:) requires it. */
    @Test public void unpaddedOrSpacedBase64IsRefused() throws Exception {
        assembler.begin("a", "n.txt", "text/plain", 2);
        expect("bad_args", () -> assembler.chunk("a", 0, "aGk"));
        expect("bad_args", () -> assembler.chunk("a", 0, "aG k"));
        expect("bad_args", () -> assembler.chunk("a", 0, null));
        assembler.chunk("a", 0, "aGk=");
    }

    /** P9 ruling, on both twins: an empty chunk is bad_args unless the declared size is 0. */
    @Test public void anEmptyChunkIsRefusedUnlessTheSizeIsZero() throws Exception {
        assembler.begin("a", "n.txt", "text/plain", 5);
        expect("bad_args", () -> assembler.chunk("a", 0, ""));
        assembler.chunk("a", 0, b64("hello"));
        expect("bad_args", () -> assembler.chunk("a", 1, ""));
        assertEquals("hello", sink.files.get(assembler.end("a").file).toString("UTF-8"));
        assembler.begin("z", "z.txt", "text/plain", 0);
        assembler.chunk("z", 0, "");
        assertEquals(0, sink.files.get(assembler.end("z").file).size());
    }

    /** A failed write discards the transfer, so a retry can never append after partial bytes. */
    @Test public void aFailedWriteDiscardsTheTransfer() throws Exception {
        assembler.begin("a", "a.txt", "text/plain", 10);
        assembler.chunk("a", 0, b64("hello"));
        sink.failWrites = true;
        expect("write_failed", () -> assembler.chunk("a", 1, b64("world")));
        assertEquals(1, sink.discarded.size());
        assertEquals(0, assembler.openCount());
        sink.failWrites = false;
        expect("bad_args", () -> assembler.chunk("a", 1, b64("world")));
        expect("bad_args", () -> assembler.end("a"));
    }

    @Test public void idleTransfersAreDiscardedAndAbortAfterAFailedWriteCleansUp() throws Exception {
        assembler.begin("a", "a.txt", "text/plain", 5);
        sink.failWrites = true;
        expect("write_failed", () -> assembler.chunk("a", 0, b64("hello")));
        assembler.abort("a");
        assertEquals(1, sink.discarded.size());
        assertTrue(sink.files.isEmpty());
        sink.failWrites = false;
        assembler.begin("b", "b.txt", "text/plain", 5);
        clock += ChunkAssembler.IDLE_LIMIT_MS + 1;
        expect("bad_args", () -> assembler.begin(null, "c.txt", "text/plain", 1));
        assertEquals(2, sink.discarded.size());
        assertEquals(0, assembler.openCount());
    }
}
