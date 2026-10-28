package com.murage.mobile.shell;

import static org.junit.Assert.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.*;
import org.junit.*;
import org.junit.rules.TemporaryFolder;

public class ShareFlowTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private static final WorkspaceOrigin ORIGIN = WorkspaceOrigin.parse("https://desk.example.test");
    private static final WorkspaceOrigin OTHER = WorkspaceOrigin.parse("https://other.example.test");
    private static final String ID = "share_0001_abcdefgh";
    private static JSONObject fixture() throws Exception { return new JSONObject(Fixtures.read("phone-ask.json")); }
    private static String targetsAnswer() throws Exception { return fixture().getJSONObject("targets").getJSONObject("answer").toString(); }
    private static String token(int index) throws Exception { return fixture().getJSONObject("token").getJSONArray("valid").getString(index); }
    private static final class FakeCall implements ShareOutbox.Call {
        ShareTargets.Response response = new ShareTargets.Response(502, null);
        boolean cancelled; int executions;
        Runnable during = () -> {};
        public ShareTargets.Response execute() throws Exception { if (cancelled) throw new IOException("cancelled"); executions++; during.run(); return response; }
        public void cancel() { cancelled = true; }
    }
    private final class Rig implements ShareAccess {
        final File root;
        final Map<WorkspaceOrigin, String> tokens = new HashMap<>();
        final Set<WorkspaceOrigin> pending = new HashSet<>();
        final List<WorkspaceOrigin> shortcutRemovals = new ArrayList<>();
        final List<String> authorizations = new ArrayList<>();
        final List<FakeCall> calls = new ArrayList<>();
        final ShareTargets targets;
        ShareTargets.Fetch fetch;
        ShareOutbox outbox;
        long now = 1_800_000_000_000L;
        boolean cleanupFails;
        int gets, revocations;
        FakeCall next = new FakeCall();
        Rig() throws Exception {
            root = temporary.newFolder(); tokens.put(ORIGIN, ShareFlowTest.token(0)); tokens.put(OTHER, ShareFlowTest.token(0));
            fetch = (origin, bearer) -> new ShareTargets.Response(200, targetsAnswer());
            targets = new ShareTargets(root, this, (origin, bearer) -> { gets++; return fetch.get(origin, bearer); });
            restart();
        }
        void restart() {
            outbox = new ShareOutbox(root, this, (origin, bearer, body, boundary) -> {
                assertTrue(body.isFile()); assertEquals(ShareBody.boundary(body.getParentFile().getName()), boundary);
                authorizations.add(bearer); FakeCall call = next; calls.add(call); next = new FakeCall(); return call;
            }, targets, () -> now);
        }
        public boolean pending(WorkspaceOrigin origin) { return pending.contains(origin); }
        public String token(WorkspaceOrigin origin) { return tokens.get(origin); }
        public void removeShortcuts(WorkspaceOrigin origin) { shortcutRemovals.add(origin); }
        public boolean forget(WorkspaceOrigin origin, String code) {
            synchronized (ShareFiles.LOCK) {
                pending.add(origin); tokens.remove(origin); if (code.equals("revoked")) revocations++;
                try { targets.remove(origin); outbox.markRemoved(origin, code); }
                catch (IOException e) { throw new AssertionError(e); }
                if (cleanupFails) return false;
                pending.remove(origin); return true;
            }
        }
        JSONObject prepare(String id, WorkspaceOrigin origin) throws Exception {
            return ShareBody.prepare(root, origin, id, "bot-lena", "new", null, "hello", null, Collections.emptyList(), now, () -> current(origin) != null);
        }
        void cache() { assertEquals(ShareTargets.State.READY, targets.refresh(ORIGIN, now).state); }
    }

    @Test public void corruptFailureJournalRepairsAndRetainsStateFilesAcrossForeground() throws Exception {
        for (String corrupt : Arrays.asList("{", "[null]", "[1]")) {
            Rig r = new Rig(); r.prepare(ID, ORIGIN); r.prepare("other_0001_abcdefgh", ORIGIN);
            r.outbox.completed(ID, ORIGIN, 415, "{\"error\":\"refused\",\"code\":\"unsupported_type\"}");
            File journal = new File(r.root, "outbox/failed.json");
            ShareFiles.atomic(journal, corrupt.getBytes(StandardCharsets.UTF_8));
            assertEquals("unsupported_type", r.outbox.state(ID).getString("code"));
            assertEquals(0, new JSONArray(ShareFiles.read(journal, 65536)).length());
            assertEquals(2, r.outbox.entries().size());
            r.outbox.foreground(workspace -> ORIGIN);
            assertEquals(1, r.calls.size());
            assertEquals("unsupported_type", r.outbox.state(ID).getString("code"));
            assertFalse(r.outbox.body(ID).exists());
        }
    }

    @Test public void separateOutboxOwnersSerializeFailureUpdatesAndResendDrops() throws Exception {
        Rig r = new Rig();
        ShareOutbox sheet = new ShareOutbox(r.root, r, (origin, token, body, boundary) -> {
            fail("This test does not send"); return null;
        }, r.targets, () -> r.now);
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < 20; i++) { String id = "journal_share_0000_" + i; ids.add(id); r.prepare(id, ORIGIN); }
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            List<Future<?>> writes = new ArrayList<>();
            for (int i = 0; i < ids.size(); i++) {
                final String id = ids.get(i); final ShareOutbox writer = i % 2 == 0 ? r.outbox : sheet;
                writes.add(workers.submit(() -> { writer.completed(id, ORIGIN, 409, "{\"error\":\"refused\",\"code\":\"conflict\"}"); return null; }));
            }
            for (Future<?> write : writes) write.get(5, TimeUnit.SECONDS);
            File journal = new File(r.root, "outbox/failed.json");
            assertEquals(ids.size(), new JSONArray(ShareFiles.read(journal, 65536)).length());
            List<Future<?>> changes = new ArrayList<>();
            for (int i = 0; i < ids.size(); i += 2) {
                final String id = ids.get(i), fresh = "journal_new_00000_" + i;
                r.prepare(fresh, ORIGIN);
                changes.add(workers.submit(() -> { r.outbox.resend(id, ORIGIN, "bot-lena", "new"); return null; }));
                changes.add(workers.submit(() -> { sheet.completed(fresh, ORIGIN, 415, "{\"error\":\"refused\",\"code\":\"unsupported_type\"}"); return null; }));
            }
            for (Future<?> change : changes) change.get(5, TimeUnit.SECONDS);
            JSONArray lines = new JSONArray(ShareFiles.read(journal, 65536));
            Set<String> actual = new HashSet<>();
            for (int i = 0; i < lines.length(); i++) actual.add(lines.getJSONObject(i).getString("shareId"));
            assertEquals(20, actual.size());
            for (int i = 0; i < ids.size(); i++) assertEquals(i % 2 != 0, actual.contains(ids.get(i)));
            for (int i = 0; i < ids.size(); i += 2) assertTrue(actual.contains("journal_new_00000_" + i));
        } finally { workers.shutdownNow(); }
    }

    @Test public void missingBodiesHaveTerminalCopyAndNeverRetryInstructions() throws Exception {
        for (String code : Arrays.asList("too_large", "unsupported_type", "invalid", "expired", "removed", "conflict", "unknown")) {
            JSONObject row = new JSONObject().put("state", "failed").put("code", code);
            assertEquals("share_outbox_couldnt_send", ShareOutbox.messageKey(row, false));
            assertEquals("share_outbox_failed", ShareOutbox.messageKey(row, true));
        }
        JSONObject row = new JSONObject().put("state", "needsTarget");
        assertEquals("share_outbox_couldnt_send", ShareOutbox.messageKey(row, false));
        assertEquals("share_outbox_target", ShareOutbox.messageKey(row, true));
        row.put("state", "failed").put("code", "revoked");
        assertEquals("share_again", ShareOutbox.messageKey(row, false));
        row.put("code", "update");
        assertEquals("share_update", ShareOutbox.messageKey(row, false));
        row.put("state", "sent");
        assertEquals("share_outbox_sent", ShareOutbox.messageKey(row, false));
    }

    @Test public void actualBodyFileEqualsFixtureAndEveryCopyIsPrivateBeforePublication() throws Exception {
        Rig r = new Rig(); JSONObject share = fixture().getJSONObject("share"), mp = share.getJSONObject("multipart");
        PhoneAskContract.ShareManifest m = PhoneAskContract.ShareManifest.parse(share.getJSONObject("manifest").getJSONObject("valid"));
        List<ShareBody.Attachment> inputs = new ArrayList<>(); int[] copied = {0};
        for (PhoneAskContract.ShareItem item : m.items) {
            byte[] bytes = mp.getJSONArray("items").getJSONObject(item.n - 1).getString("text").getBytes(StandardCharsets.UTF_8);
            inputs.add(new ShareBody.Attachment(item.name, item.mime, file -> {
                assertEquals(Integer.toString(item.n), file.getName());
                assertFalse(new File(file.getParentFile(), "state.json").exists());
                ShareBody.stream(new ByteArrayInputStream(bytes), file, item.bytes, "share_file_large"); copied[0]++;
            }));
        }
        JSONObject state = ShareBody.prepare(r.root, ORIGIN, m.shareId, m.botId, m.threadId, m.note, m.text, m.url, inputs, r.now, () -> {
            assertEquals(m.items.size(), copied[0]); return true;
        });
        assertEquals("queued", state.getString("state")); assertEquals(ShareFiles.workspace(ORIGIN), state.getString("workspace"));
        String expected = mp.getString("body").replace(mp.getString("boundary"), ShareBody.boundary(m.shareId));
        assertArrayEquals(expected.getBytes(StandardCharsets.UTF_8), Files.readAllBytes(r.outbox.body(m.shareId).toPath()));
        File literal = new File(temporary.newFolder(), "body");
        ShareBody.write(m, mp.getString("boundary"), literal, item -> new FileInputStream(new File(ShareFiles.folder(r.root, m.shareId), Integer.toString(item.n))));
        assertArrayEquals(mp.getString("body").getBytes(StandardCharsets.UTF_8), Files.readAllBytes(literal.toPath()));
    }

    @Test public void everyFixtureOutcomeChangesStateAndPayloadExactly() throws Exception {
        JSONObject answers = fixture().getJSONObject("share").getJSONObject("answers");
        for (String group : Arrays.asList("ok", "errors")) {
            JSONArray rows = answers.getJSONArray(group);
            for (int i = 0; i < rows.length(); i++) {
                Rig r = new Rig(); r.prepare(ID, ORIGIN); r.cache();
                JSONObject answer = rows.getJSONObject(i); int status = answer.getInt("status");
                String response = answer.has("body") ? answer.getJSONObject("body").toString() : null;
                r.next.response = new ShareTargets.Response(status, response); r.outbox.send(ID, ORIGIN);
                JSONObject row = r.outbox.state(ID);
                String code = answer.has("body") ? answer.getJSONObject("body").optString("code") : "update";
                String expected = status == 200 ? "sent" : code.equals("target_gone") ? "needsTarget" : "failed";
                assertEquals(code, expected, row.getString("state"));
                boolean keep = Arrays.asList("conflict", "target_gone", "update").contains(code);
                assertEquals(code, keep, r.outbox.body(ID).exists());
                assertEquals(1, r.calls.size());
                if (status == 401 || status == 403) {
                    assertNull(r.current(ORIGIN)); assertFalse(r.targets.file(ORIGIN).exists()); assertEquals("revoked", row.getString("code"));
                }
                if (code.equals("target_gone")) assertEquals("refresh after target_gone", 2, r.gets);
                if (status != 200) assertTrue(new File(r.root, "outbox/failed.json").isFile());
            }
        }
    }

    @Test public void unknownMalformedNetworkAndServerAnswersKeepBody() throws Exception {
        for (int status : new int[]{0, 200, 302, 408, 409, 413, 415, 422, 429, 500, 502, 503}) {
            Rig r = new Rig(); r.prepare(ID, ORIGIN); r.next.response = new ShareTargets.Response(status, "{}");
            r.outbox.send(ID, ORIGIN);
            assertEquals("queued", r.outbox.state(ID).getString("state")); assertTrue(r.outbox.body(ID).exists());
            assertEquals(r.now + 60_000, r.outbox.state(ID).getLong("nextAttemptAt"));
        }
    }

    @Test public void retriesUseCurrentTokenAndBackoffThenEachForegroundAndSurviveRelaunch() throws Exception {
        Rig r = new Rig(); r.prepare(ID, ORIGIN);
        for (long delay : ShareOutbox.BACKOFF) {
            int sent = r.authorizations.size(); r.outbox.foreground(workspace -> ORIGIN);
            assertEquals(sent + 1, r.authorizations.size());
            assertEquals(r.now + delay, r.outbox.state(ID).getLong("nextAttemptAt"));
            r.outbox.foreground(workspace -> ORIGIN); assertEquals(sent + 1, r.authorizations.size());
            r.now += delay; r.tokens.put(ORIGIN, "murage_pa_" + String.join("", Collections.nCopies(43, "Z")));
            r.restart(); // Process died: no live task survives, body and share id do.
        }
        r.outbox.foreground(workspace -> ORIGIN);
        assertFalse(r.outbox.state(ID).has("nextAttemptAt"));
        assertEquals(r.tokens.get(ORIGIN), r.authorizations.get(r.authorizations.size() - 1));
        int count = r.authorizations.size(); r.tokens.remove(ORIGIN);
        r.outbox.foreground(workspace -> ORIGIN); assertEquals(count, r.authorizations.size());
        r.tokens.put(ORIGIN, token(0)); r.outbox.foreground(workspace -> ORIGIN); assertEquals(count + 1, r.authorizations.size());
    }

    @Test public void pendingForgetHidesTargetsSkipsRetriesCancelsAndDeletesOnlyThatOrigin() throws Exception {
        Rig r = new Rig(); r.cache(); r.prepare(ID, ORIGIN); r.prepare("other_0001_abcdefgh", OTHER);
        r.cleanupFails = true;
        FakeCall live = r.next;
        live.during = () -> {
            assertFalse(r.forget(ORIGIN, "removed")); assertTrue(r.pending(ORIGIN));
            assertTrue(live.cancelled); assertEquals(ShareTargets.State.SETUP, r.targets.initial(ORIGIN, r.now).state);
            assertFalse(r.targets.allows(ORIGIN, "bot-lena", "new", r.now));
        };
        r.outbox.send(ID, ORIGIN);
        assertEquals("removed", r.outbox.state(ID).getString("code")); assertFalse(r.outbox.body(ID).exists());
        assertTrue(r.outbox.body("other_0001_abcdefgh").exists()); assertNotNull(r.current(OTHER));
        int sent = r.calls.size(); r.outbox.foreground(workspace -> ORIGIN); assertEquals(sent, r.calls.size());
        r.cleanupFails = false; assertTrue(r.forget(ORIGIN, "removed")); assertFalse(r.pending(ORIGIN));
    }

    @Test public void everyShareAndAskAuthenticationFailureIncludingCodelessRevokesOrigin() throws Exception {
        for (String kind : Arrays.asList("share", "ask")) for (int status : new int[]{401, 403}) for (String body : Arrays.asList(null, "{}", "{\"code\":\"revoked\"}")) {
            Rig r = new Rig(); r.cache(); r.prepare(ID, ORIGIN); r.prepare("second_0001_abcdefgh", ORIGIN);
            if (kind.equals("share")) r.outbox.completed(ID, ORIGIN, status, body);
            else assertTrue(r.revoked(ORIGIN, status)); // The shared ask/share response gate ignores the body.
            assertNull(r.current(ORIGIN)); assertFalse(r.targets.file(ORIGIN).exists());
            for (JSONObject row : r.outbox.entries()) {
                assertEquals("revoked", row.getString("code")); assertEquals("failed", row.getString("state"));
                assertFalse(r.outbox.body(row.getString("shareId")).exists());
            }
            r.outbox.foreground(workspace -> ORIGIN); assertTrue(r.authorizations.isEmpty());
        }
        Rig r = new Rig(); r.cache(); r.prepare(ID, ORIGIN);
        r.outbox.completed(ID, ORIGIN, 200, fixture().getJSONObject("share").getJSONObject("answers").getJSONArray("ok").getJSONObject(0).getJSONObject("body").toString());
        r.outbox.completed(ID, ORIGIN, 403, null); assertNull(r.current(ORIGIN));
        r.tokens.put(ORIGIN, token(0)); r.outbox.completed("missing_0001_abcdef", ORIGIN, 401, null); assertNull(r.current(ORIGIN));
    }

    @Test public void noSecondSendForLiveTaskAndLateCancelledCompletionCannotRestoreRow() throws Exception {
        Rig r = new Rig(); r.prepare(ID, ORIGIN); FakeCall live = r.next;
        live.during = () -> {
            try { r.outbox.foreground(workspace -> ORIGIN); } catch (IOException e) { throw new AssertionError(e); }
            assertEquals(1, r.calls.size()); r.forget(ORIGIN, "removed");
        };
        live.response = new ShareTargets.Response(200, fixture().getJSONObject("share").getJSONObject("answers").getJSONArray("ok").getJSONObject(0).getJSONObject("body").toString());
        r.outbox.send(ID, ORIGIN); assertEquals("removed", r.outbox.state(ID).getString("code")); assertFalse(r.outbox.body(ID).exists());
    }

    @Test public void cacheVersionInvalidJsonThirtyDaysAndFiveMinuteRules() throws Exception {
        Rig r = new Rig(); assertEquals(ShareTargets.State.LOADING, r.targets.initial(ORIGIN, r.now).state);
        Set<String> opened = new HashSet<>(); r.targets.open(ORIGIN, r.now, opened); assertEquals(1, r.gets);
        r.now += ShareTargets.FRESH; assertFalse(r.targets.needsRefresh(ORIGIN, r.now));
        r.now++; r.targets.open(ORIGIN, r.now, opened); assertEquals(1, r.gets);
        r.targets.open(ORIGIN, r.now, new HashSet<>()); assertEquals(2, r.gets);
        for (String invalid : Arrays.asList("{", "{}", new JSONObject(ShareFiles.read(r.targets.file(ORIGIN), 65536)).put("v", 2).toString())) {
            ShareFiles.atomic(r.targets.file(ORIGIN), invalid.getBytes(StandardCharsets.UTF_8)); assertNull(r.targets.read(ORIGIN, r.now));
        }
        r.cache(); r.now += 31L * ShareOutbox.DAY; assertNull(r.targets.read(ORIGIN, r.now));
        r.fetch = (origin, bearer) -> new ShareTargets.Response(502, null);
        int before = r.gets; r.targets.foreground(ORIGIN, r.now); r.targets.foreground(ORIGIN, r.now + 1); assertEquals(before + 1, r.gets);
        assertEquals(ShareTargets.State.SETUP, r.targets.open(ORIGIN, r.now, new HashSet<>()).state);
        assertTrue(r.outbox.entries().isEmpty());
        r.fetch = (origin, bearer) -> new ShareTargets.Response(200, "{\"workspace\":\"Home\",\"bots\":[],\"recent\":[]}");
        assertEquals(ShareTargets.State.SETUP, r.targets.refresh(ORIGIN, r.now).state);
        assertTrue(r.outbox.entries().isEmpty());
    }

    @Test public void refreshCannotRewriteCacheAfterForgetRotationOrPendingRemoval() throws Exception {
        for (String change : Arrays.asList("forget", "rotate", "pending")) {
            Rig r = new Rig(); r.cache();
            r.fetch = (origin, bearer) -> {
                if (change.equals("forget")) r.forget(origin, "removed");
                else if (change.equals("pending")) { r.pending.add(origin); r.targets.remove(origin); }
                else { r.tokens.put(origin, "murage_pa_" + String.join("", Collections.nCopies(43, "X"))); r.targets.remove(origin); }
                return new ShareTargets.Response(200, targetsAnswer());
            };
            assertEquals(change, ShareTargets.State.SETUP, r.targets.refresh(ORIGIN, r.now + ShareTargets.FRESH + 1).state);
            assertFalse(r.targets.file(ORIGIN).exists());
        }
        for (int status : new int[]{401, 403}) {
            Rig r = new Rig(); r.cache(); r.fetch = (origin, bearer) -> new ShareTargets.Response(status, null);
            assertEquals(ShareTargets.State.SETUP, r.targets.refresh(ORIGIN, r.now).state);
            assertNull(r.current(ORIGIN)); assertFalse(r.targets.file(ORIGIN).exists());
        }
    }

    @Test public void revokedRefreshDisablesShortcutsEvenWhenCleanupCannotFinish() throws Exception {
        for (int status : new int[]{401, 403}) for (boolean cleanupFails : new boolean[]{false, true}) {
            Rig r = new Rig(); r.cache(); r.cleanupFails = cleanupFails;
            r.fetch = (origin, bearer) -> new ShareTargets.Response(status, null);
            assertEquals(ShareTargets.State.SETUP, r.targets.refresh(ORIGIN, r.now).state);
            assertEquals(Collections.singletonList(ORIGIN), r.shortcutRemovals);
            assertNull(r.current(ORIGIN)); assertNotNull(r.current(OTHER));
        }
    }

    @Test public void revokedShareAndAskCompletionsAlsoDisableShortcuts() throws Exception {
        for (int status : new int[]{401, 403}) {
            Rig r = new Rig();
            r.outbox.completed(ID, ORIGIN, status, null);
            assertEquals(Collections.singletonList(ORIGIN), r.shortcutRemovals);
            assertNull(r.current(ORIGIN)); assertNotNull(r.current(OTHER));
        }
    }

    @Test public void shortcutPublicationSharesTheCacheRemovalBarrier() throws Exception {
        for (String change : Arrays.asList("none", "forget", "pending", "revoked")) {
            Rig r = new Rig(); AtomicInteger publications = new AtomicInteger();
            ShareTargets publishing = new ShareTargets(r.root, r, (origin, bearer) -> {
                if (change.equals("forget")) r.forget(origin, "removed");
                if (change.equals("pending")) r.pending.add(origin);
                return new ShareTargets.Response(change.equals("revoked") ? 403 : 200, targetsAnswer());
            }, origin -> {
                assertTrue(Thread.holdsLock(ShareFiles.LOCK));
                assertFalse(r.pending(origin)); assertNotNull(r.current(origin));
                assertNotNull(ShareTargets.readCached(r.root, origin, r.now));
                publications.incrementAndGet();
            });
            publishing.refresh(ORIGIN, r.now);
            assertEquals(change, change.equals("none") ? 1 : 0, publications.get());
        }
    }

    @Test public void simultaneousAppAndSheetWritesLeaveWholeSnapshots() throws Exception {
        Rig r = new Rig(); r.cache(); AtomicInteger sequence = new AtomicInteger();
        CountDownLatch fetching = new CountDownLatch(2), release = new CountDownLatch(1);
        r.fetch = (origin, bearer) -> {
            fetching.countDown(); assertTrue(release.await(5, TimeUnit.SECONDS));
            JSONObject answer = new JSONObject(targetsAnswer()).put("workspace", "writer-" + sequence.incrementAndGet());
            return new ShareTargets.Response(200, answer.toString());
        };
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<?> app = workers.submit(() -> r.targets.refresh(ORIGIN, r.now + 1));
            Future<?> sheet = workers.submit(() -> r.targets.refresh(ORIGIN, r.now + 2));
            assertTrue(fetching.await(5, TimeUnit.SECONDS));
            assertEquals("Home", r.targets.read(ORIGIN, r.now).workspace); release.countDown();
            for (int i = 0; i < 100; i++) assertNotNull(new JSONObject(ShareFiles.read(r.targets.file(ORIGIN), 65536)).optJSONObject("targets"));
            app.get(5, TimeUnit.SECONDS); sheet.get(5, TimeUnit.SECONDS);
            assertTrue(r.targets.read(ORIGIN, r.now + 2).workspace.startsWith("writer-"));
        } finally { release.countDown(); workers.shutdownNow(); }
    }

    @Test public void recentsMatchBotAndThreadPair() throws Exception {
        JSONObject answer = new JSONObject(targetsAnswer());
        String thread = "a2a4d6f8-1c3e-4057-9a8b-7d6e5f4c3b2a";
        answer.put("recent", new JSONArray().put(new JSONObject().put("botId", "bot-lena").put("threadId", thread).put("title", "Chat").put("at", 1)));
        PhoneAskContract.TargetsAnswer targets = PhoneAskContract.TargetsAnswer.parse(answer);
        assertTrue(ShareTargets.contains(targets, "bot-lena", thread)); assertFalse(ShareTargets.contains(targets, "bot-max", thread));
        answer.getJSONArray("recent").put(new JSONObject().put("botId", "bot-max").put("threadId", thread).put("title", "Other chat").put("at", 2));
        assertTrue(ShareTargets.contains(PhoneAskContract.TargetsAnswer.parse(answer), "bot-max", thread));
    }

    @Test public void typeNarrowingElevenItemsWhitespaceNamesAndImageCeiling() throws Exception {
        JSONObject types = new JSONObject(Fixtures.read("share-types.json"));
        JSONArray offered = types.getJSONArray("androidFilter");
        for (int i = 0; i < offered.length(); i++) assertTrue(ShareBody.accepts(offered.getString(i)));
        assertTrue(ShareBody.accepts("image/heic")); assertTrue(ShareBody.accepts("image/heif"));
        for (String mime : Arrays.asList("image/*", "image/svg+xml", "image/tiff", "video/mp4", "audio/mpeg", "application/zip", "text/html", null)) assertFalse(ShareBody.accepts(mime));
        Rig r = new Rig();
        try {
            ShareBody.prepare(r.root, ORIGIN, ID, "bot-lena", "new", null, "text", null,
                Collections.nCopies(11, new ShareBody.Attachment("a", "text/plain", file -> fail("11 items must not open providers"))), r.now, () -> true);
            fail("11 items");
        } catch (ShareBody.InputError e) { assertEquals("share_ten", e.key); }
        assertFalse(ShareFiles.folder(r.root, ID).exists());
        for (String note : Arrays.asList("", " \t\n", "\u2003\u00a0")) {
            String id = UUID.randomUUID().toString();
            ShareBody.prepare(r.root, ORIGIN, id, "bot-lena", "new", note, "text", null, Collections.emptyList(), r.now, () -> true);
            assertFalse(ShareFiles.read(r.outbox.body(id), 65536).contains("\"note\""));
        }
        assertFalse(ShareBody.name("../../display\\name\r\n.txt", 1).contains("/"));
        assertFalse(ShareBody.name("../../display\\name\r\n.txt", 1).contains("\\"));
        for (String id : Arrays.asList("../escape", "a", String.join("", Collections.nCopies(81, "a")), "aaaaaaaaaaaaaaaa/")) {
            try { ShareFiles.folder(r.root, id); fail(id); } catch (IOException expected) { }
        }
        assertArrayEquals(new int[]{4096, 1365}, ShareBody.imageSize(12000, 4000));
        assertTrue(12000 / ShareBody.imageSample(12000, 4000) <= 4096);
        assertEquals(types.getJSONObject("heicToJpeg").getInt("maxEdge"), ShareBody.IMAGE_EDGE);
        assertEquals(types.getJSONObject("heicToJpeg").getDouble("quality"), ShareBody.JPEG_QUALITY / 100.0, 0);
    }

    @Test public void forgetDuringCopyNeverPublishesAndDisplayNameNeverBecomesAPath() throws Exception {
        Rig r = new Rig();
        ShareBody.Attachment item = new ShareBody.Attachment("../../escape.txt", "text/plain", destination -> {
            assertEquals("1", destination.getName());
            ShareBody.stream(new ByteArrayInputStream(new byte[]{1}), destination, 1, "share_type");
            r.forget(ORIGIN, "removed");
        });
        try {
            ShareBody.prepare(r.root, ORIGIN, ID, "bot-lena", "new", null, null, null, Arrays.asList(item), r.now, () -> r.current(ORIGIN) != null);
            fail("forgotten while copying");
        } catch (IOException expected) { }
        assertFalse(ShareFiles.folder(r.root, ID).exists()); assertTrue(r.outbox.entries().isEmpty());
    }

    @Test public void sevenDayExpiryDeletesBodiesAndFailuresLastSevenMoreDaysSentLastsOneDay() throws Exception {
        for (String outcome : Arrays.asList("queued", "conflict", "target_gone", "update")) {
            Rig r = new Rig(); r.prepare(ID, ORIGIN);
            if (!outcome.equals("queued")) r.outbox.completed(ID, ORIGIN, outcome.equals("update") ? 404 : 409,
                new JSONObject().put("error", "refused").put("code", outcome).toString());
            r.now += ShareOutbox.WEEK; r.outbox.sweep(); assertFalse(r.outbox.body(ID).exists());
            if (outcome.equals("queued")) {
                assertEquals("expired", r.outbox.state(ID).getString("code"));
                r.now += ShareOutbox.WEEK; r.outbox.sweep(); assertTrue(r.outbox.entries().isEmpty());
            }
        }
        Rig r = new Rig(); r.prepare(ID, ORIGIN);
        r.outbox.completed(ID, ORIGIN, 200, fixture().getJSONObject("share").getJSONObject("answers").getJSONArray("ok").getJSONObject(0).getJSONObject("body").toString());
        assertFalse(r.outbox.body(ID).exists()); r.now += ShareOutbox.DAY; r.outbox.sweep(); assertTrue(r.outbox.entries().isEmpty());
    }

    @Test public void explicitRetryAndRedirectGetNewIdManifestAndBody() throws Exception {
        for (String code : Arrays.asList("conflict", "target_gone")) {
            Rig r = new Rig(); r.prepare(ID, ORIGIN); r.cache();
            r.outbox.completed(ID, ORIGIN, 409, new JSONObject().put("error", "refused").put("code", code).toString());
            if (code.equals("target_gone")) r.cache();
            else r.targets.remove(ORIGIN); // Like N12, retry of an existing target needs no cache fetch.
            JSONObject next = r.outbox.resend(ID, ORIGIN, "bot-max", "new");
            String id = next.getString("shareId"); assertNotEquals(ID, id); assertEquals("queued", next.getString("state"));
            String body = ShareFiles.read(r.outbox.body(id), 65536);
            assertTrue(body.contains(id)); assertFalse(body.contains(ID)); assertTrue(body.contains("bot-max"));
            assertFalse(ShareFiles.folder(r.root, ID).exists());
        }
    }

    @Test public void failureJournalWinsAfterCrashBeforeStateWrite() throws Exception {
        Rig r = new Rig(); JSONObject queued = r.prepare(ID, ORIGIN);
        JSONObject removed = new JSONObject(queued.toString()).put("state", "failed").put("code", "removed").put("updatedAt", r.now);
        ShareFiles.json(new File(r.root, "outbox/failed.json"), new JSONArray().put(removed));
        r.restart(); r.outbox.foreground(workspace -> ORIGIN);
        assertEquals("removed", r.outbox.state(ID).getString("code")); assertFalse(r.outbox.body(ID).exists()); assertTrue(r.calls.isEmpty());
    }

    @Test public void perItemAndTotalLimitsRefuseBeforePublishingState() throws Exception {
        for (String mime : Arrays.asList("image/jpeg", "application/pdf")) {
            Rig r = new Rig(); long cap = mime.startsWith("image/") ? PhoneAskContract.ShareLimits.IMAGE_MAX_BYTES : PhoneAskContract.ShareLimits.FILE_MAX_BYTES;
            ShareBody.Attachment item = new ShareBody.Attachment("item", mime, destination -> {
                try (RandomAccessFile file = new RandomAccessFile(destination, "rw")) { file.setLength(cap + 1); }
            });
            try {
                ShareBody.prepare(r.root, ORIGIN, ID, "bot-lena", "new", null, null, null, Arrays.asList(item), r.now, () -> true);
                fail("per-item cap");
            } catch (ShareBody.InputError e) { assertEquals(mime.startsWith("image/") ? "share_photo_large" : "share_file_large", e.key); }
            assertFalse(ShareFiles.folder(r.root, ID).exists());
        }
        Rig r = new Rig(); ShareBody.Attachment file = new ShareBody.Attachment("item", "application/pdf", destination -> {
            try (RandomAccessFile output = new RandomAccessFile(destination, "rw")) { output.setLength(PhoneAskContract.ShareLimits.FILE_MAX_BYTES); }
        });
        try {
            ShareBody.prepare(r.root, ORIGIN, ID, "bot-lena", "new", null, null, null, Arrays.asList(file, file, file), r.now, () -> true);
            fail("total cap");
        } catch (ShareBody.InputError e) { assertEquals("share_file_large", e.key); }
        assertTrue(r.outbox.entries().isEmpty());
    }

    @Test public void missingBodyAlsoExpiresAndUnknownTokenIsNeverUsed() throws Exception {
        Rig r = new Rig(); r.prepare(ID, ORIGIN); r.tokens.put(ORIGIN, "not-an-ask-token");
        r.outbox.send(ID, ORIGIN); assertTrue(r.calls.isEmpty());
        Files.delete(r.outbox.body(ID).toPath()); r.now += ShareOutbox.WEEK;
        r.outbox.sweep(); assertEquals("expired", r.outbox.state(ID).getString("code"));
    }

    @Test public void textSubjectAndLinkFieldsPreserveSharedTextWithoutInventingAUrl() {
        ShareBody.TextInput link = new ShareBody.TextInput(" https://example.test/page ", "Page title");
        assertEquals("https://example.test/page", link.url); assertNull(link.text); assertEquals("Page title", link.preview);
        ShareBody.TextInput text = new ShareBody.TextInput("Read https://example.test/page", "Title");
        assertNull(text.url); assertEquals("Read https://example.test/page", text.text);
        assertEquals("Subject only", new ShareBody.TextInput(null, "Subject only").text);
        assertNull(new ShareBody.TextInput(" \n\t", null).text);
    }

    @Test public void lockedTokenReadLeavesRelaunchedRowQueuedWithoutASend() throws Exception {
        Rig r = new Rig(); r.prepare(ID, ORIGIN);
        ShareAccess locked = new ShareAccess() {
            public boolean pending(WorkspaceOrigin origin) { return false; }
            public String token(WorkspaceOrigin origin) { throw new IllegalStateException("locked"); }
            public boolean forget(WorkspaceOrigin origin, String code) { return true; }
        };
        ShareOutbox relaunched = new ShareOutbox(r.root, locked, (origin, token, body, boundary) -> {
            fail("locked phone must not enqueue"); return null;
        }, r.targets, () -> r.now);
        relaunched.foreground(workspace -> ORIGIN);
        assertEquals("queued", relaunched.state(ID).getString("state")); assertTrue(relaunched.body(ID).isFile());
    }
}
