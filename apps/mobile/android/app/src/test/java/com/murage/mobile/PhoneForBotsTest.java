package com.murage.mobile;

import static org.junit.Assert.*;
import com.murage.mobile.shell.ChannelException;
import com.murage.mobile.shell.ChannelGate;
import com.murage.mobile.shell.PhoneForBotsEntry;
import com.murage.mobile.shell.PhoneJobsContract;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class PhoneForBotsTest {
    private static final class Store implements PhoneForBotsModel.Store {
        final Map<String, String> entries = new HashMap<>();
        @Override public PhoneForBotsModel.Consent read(WorkspaceOrigin workspace) throws Exception {
            String data = entries.get(workspace.serialized());
            return data == null ? new PhoneForBotsModel.Consent() : PhoneConsentStore.decode(data);
        }
        @Override public void write(WorkspaceOrigin workspace, PhoneForBotsModel.Consent c) throws Exception {
            entries.put(workspace.serialized(), PhoneConsentStore.encode(c));
        }
    }
    private static final class Result implements PhoneForBotsModel.Done {
        int calls;
        Exception error;
        @Override public void finish(Exception error) { calls++; this.error = error; }
        void ok() { assertEquals(1, calls); assertNull(error); }
    }
    private static final class Rig {
        final WorkspaceOrigin origin = WorkspaceOrigin.parse("https://phone.example.test");
        final Store store = new Store();
        final Map<String, Object> allowed = new HashMap<>();
        final List<String> requests = new ArrayList<>(), events = new ArrayList<>();
        final List<JSONObject> bodies = new ArrayList<>();
        String token;
        int prompts, sheets;
        boolean unavailable, failHTTP;
        Executor registrationExecutor = Runnable::run;
        JSONObject metadata;
        final PhoneForBotsModel model;
        Rig() throws Exception {
            metadata = new JSONObject().put("name", "Phone").put("platform", "android").put("osVersion", "16")
                .put("appVersion", "1.0.9").put("timeZone", "UTC");
            model = new PhoneForBotsModel(origin, store, new PhoneForBotsModel.Tokens() {
                @Override public String read() { return token; }
                @Override public void remove() { events.add("remove"); token = null; }
            }, done -> { prompts++; token = "murage_pj_" + repeat('a', 43); done.finish(null); },
            done -> done.finish(unavailable ? new Exception() : null), new PhoneForBotsModel.Permissions() {
                @Override public Object value(String row) { return allowed.get(row); }
                @Override public void request(String row, Runnable done) { requests.add(row); done.run(); }
            }, () -> new JSONObject(metadata.toString()), (method, bearer, body, done) -> registrationExecutor.execute(() -> {
                assertTrue(PhoneJobsContract.tokenValid(bearer)); events.add(method);
                if (body != null) bodies.add(body);
                done.finish(failHTTP ? new Exception() : null);
            }));
        }
        void enable(boolean allow) { Result r = new Result(); model.setMaster(true, answer -> { sheets++; answer.accept(allow); }, r); r.ok(); }
        void row(String row, boolean on) { Result r = new Result(); model.setRow(row, on, r); r.ok(); }
        void refresh() { Result r = new Result(); model.refresh(r); r.ok(); }
        JSONObject caps() throws Exception { return model.registration().getJSONObject("capabilities"); }
    }
    private static String repeat(char c, int count) { char[] chars = new char[count]; Arrays.fill(chars, c); return new String(chars); }
    private static JSONObject fixtures() throws Exception {
        return new JSONObject(new String(Files.readAllBytes(Paths.get("../../contract/phone-jobs.json")), StandardCharsets.UTF_8));
    }

    @Test public void firstRunNotNowAndFirstAllow() throws Exception {
        Rig r = new Rig(); r.refresh();
        assertFalse(r.model.state().enabled); assertTrue(r.model.state().rows.isEmpty());
        assertTrue(r.requests.isEmpty()); assertTrue(r.events.isEmpty());
        r.enable(false); assertFalse(r.model.state().enabled); assertNull(r.token); assertEquals(0, r.prompts);
        r.enable(true); assertTrue(r.model.state().enabled); assertTrue(r.model.state().sharing);
        assertTrue(r.model.state().providers.isEmpty()); assertEquals(0, r.caps().length());
        r.refresh(); r.enable(true); assertEquals(1, r.prompts); assertEquals(2, r.sheets);
    }

    @Test public void everyRowRequiresConsentAndPermissionAndOffDoesNotPrompt() throws Exception {
        Rig r = new Rig(); r.enable(true);
        for (String row : PhoneForBotsModel.ROWS) {
            Object value = "calendar".equals(row) || "contacts".equals(row) ? "full" : "location".equals(row) ? "precise" : true;
            r.allowed.put(row, value); assertFalse(r.caps().has(row));
            r.allowed.remove(row); r.row(row, true);
            assertEquals(row, r.requests.get(r.requests.size() - 1)); assertFalse(r.caps().has(row));
            r.allowed.put(row, value); r.refresh();
            if (!"precise".equals(row)) assertTrue(r.caps().has(row));
            int prompts = r.requests.size(); r.row(row, false);
            assertFalse(r.caps().has(row)); assertEquals(prompts, r.requests.size());
        }
        assertEquals(PhoneForBotsModel.ROWS.length, r.requests.size());
        PhoneForBotsModel.Consent c = r.model.state(); c.rows.add("reminders"); r.store.write(r.origin, c);
        r.allowed.put("reminders", true); assertFalse(r.caps().has("reminders"));
    }

    @Test public void preciseIsSeparateAndPermissionLossNarrowsRegistration() throws Exception {
        Rig r = new Rig(); r.enable(true); r.allowed.put("location", "precise"); r.allowed.put("precise", true);
        r.row("location", true); assertEquals("approximate", r.caps().getString("location"));
        r.row("precise", true); assertEquals("precise", r.caps().getString("location"));
        r.allowed.put("location", "approximate"); r.allowed.remove("precise"); r.refresh();
        assertEquals("approximate", r.caps().getString("location"));
        r.allowed.remove("location"); r.refresh(); assertFalse(r.caps().has("location"));
    }

    @Test public void providerConsentIsPerWorkspaceAndReReadAtCommit() throws Exception {
        Rig r = new Rig(); r.enable(true); r.row("contacts", true);
        assertTrue(r.store.needsProviderSheet(r.origin, "first"));
        assertFalse(r.store.readForCommit(r.origin, "first", "contacts"));
        // Not now makes no write; the same provider still requires the sheet.
        assertTrue(r.store.needsProviderSheet(r.origin, "first"));
        r.store.recordProviderConsent(r.origin, "first");
        assertFalse(r.store.needsProviderSheet(r.origin, "first"));
        assertTrue(r.store.needsProviderSheet(r.origin, "second"));
        assertTrue(r.store.needsProviderSheet(WorkspaceOrigin.parse("https://other.example.test"), "first"));
        assertTrue(r.store.readForCommit(r.origin, "first", "contacts"));
        PhoneForBotsModel.Consent c = r.model.state(); c.sharing = false; r.store.write(r.origin, c);
        assertFalse(r.store.readForCommit(r.origin, "first", "contacts"));
        r.allowed.put("contacts", "full"); assertEquals(0, r.caps().length());
    }

    @Test public void offRemovesLocallyBeforeDeleteEvenWhenDeleteFails() throws Exception {
        Rig r = new Rig(); r.enable(true); r.events.clear(); r.failHTTP = true;
        Result off = new Result(); r.model.setMaster(false, answer -> fail(), off);
        assertEquals(1, off.calls); assertNotNull(off.error); assertFalse(r.model.state().enabled); assertNull(r.token);
        assertEquals(Arrays.asList("remove", "DELETE"), r.events);
        r.failHTTP = false; r.refresh();
        assertEquals(Arrays.asList("remove", "DELETE"), r.events);
        r.enable(true); assertEquals(1, r.sheets); assertEquals(2, r.prompts);
        r.events.clear(); Result success = new Result(); r.model.setMaster(false, answer -> fail(), success); success.ok();
        assertEquals(Arrays.asList("remove", "DELETE"), r.events); assertNull(r.token);
    }

    @Test public void offRemovesTokenWhenShutdownDropsQueuedDelete() throws Exception {
        Rig r = new Rig(); r.enable(true); r.events.clear();
        ExecutorService io = Executors.newSingleThreadExecutor();
        CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
        try {
            io.execute(() -> {
                started.countDown();
                try { release.await(); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            });
            assertTrue(started.await(1, TimeUnit.SECONDS));
            r.registrationExecutor = io;
            Result off = new Result(); r.model.setMaster(false, answer -> fail(), off);
            assertFalse(r.model.state().enabled); assertNull(r.token);
            assertEquals(1, io.shutdownNow().size()); // DELETE never runs or calls back.
            assertEquals(Arrays.asList("remove"), r.events); assertEquals(0, off.calls);
        } finally {
            release.countDown(); io.shutdownNow();
        }
    }

    @Test public void offRemovesTokenWhenExecutorAlreadyStopped() throws Exception {
        Rig r = new Rig(); r.enable(true); r.events.clear();
        ExecutorService io = Executors.newSingleThreadExecutor(); io.shutdownNow();
        r.registrationExecutor = io;
        Result off = new Result(); r.model.setMaster(false, answer -> fail(), off);
        assertFalse(r.model.state().enabled); assertNull(r.token);
        assertEquals(1, off.calls); assertNotNull(off.error);
        assertEquals(Arrays.asList("remove"), r.events);
    }

    @Test public void unavailableNeverDisclosesMintsOrRegisters() throws Exception {
        Rig r = new Rig(); r.unavailable = true;
        Result result = new Result(); r.model.setMaster(true, answer -> fail(), result);
        assertEquals(1, result.calls); assertNotNull(result.error); assertEquals(0, r.prompts);
        assertTrue(r.events.isEmpty()); assertFalse(r.model.state().enabled);
    }

    @Test public void registrationMatchesFixturesAndRejectsInvalidVectors() throws Exception {
        JSONObject f = fixtures().getJSONObject("registration");
        JSONArray valid = new JSONArray().put(f.getJSONObject("valid"));
        JSONArray also = f.getJSONArray("alsoValid");
        for (int i = 0; i < also.length(); i++) valid.put(also.getJSONObject(i));
        for (int i = 0; i < valid.length(); i++) {
            JSONObject body = valid.getJSONObject(i);
            assertTrue(PhoneJobsContract.registrationValid(body));
            Rig r = new Rig(); r.metadata = new JSONObject(body.toString());
            r.metadata.put("platform", "android");
            PhoneForBotsModel.Consent c = new PhoneForBotsModel.Consent(); c.enabled = true; c.sharing = true;
            JSONObject caps = new JSONObject(body.getJSONObject("capabilities").toString()); caps.remove("reminders");
            for (Iterator<String> keys = caps.keys(); keys.hasNext();) { String row = keys.next(); c.rows.add(row); r.allowed.put(row, caps.get(row)); }
            if ("precise".equals(caps.optString("location"))) c.rows.add("precise");
            r.store.write(r.origin, c);
            JSONObject generated = r.model.registration();
            assertTrue(PhoneJobsContract.registrationValid(generated));
            assertEquals(caps.length(), generated.getJSONObject("capabilities").length());
            for (Iterator<String> keys = caps.keys(); keys.hasNext();) { String row = keys.next(); assertEquals(caps.get(row), generated.getJSONObject("capabilities").get(row)); }
            assertFalse(generated.getJSONObject("capabilities").has("reminders"));
            for (String field : Arrays.asList("name", "osVersion", "appVersion", "timeZone", "protocol")) assertEquals(body.get(field), generated.get(field));
        }
        JSONArray invalid = f.getJSONArray("invalid");
        for (int i = 0; i < invalid.length(); i++) assertFalse(PhoneJobsContract.registrationValid(invalid.getJSONObject(i).get("body")));
    }

    @Test public void consentUsesOwnSecureEntryAndSurvivesRecreation() throws Exception {
        new LogCapture();
        FakePrefs prefs = new FakePrefs();
        KeyGenerator generator = KeyGenerator.getInstance("AES"); generator.init(256); SecretKey secret = generator.generateKey();
        SecureStore.Keys keys = new SecureStore.Keys() {
            @Override public SecretKey existing() { return secret; }
            @Override public SecretKey create() { return secret; }
        };
        PhoneJobsTokenStore.Stores stores = name -> new SecureStore(prefs, keys, name);
        PhoneConsentStore store = new PhoneConsentStore(stores);
        WorkspaceOrigin origin = WorkspaceOrigin.parse("https://phone.example.test"), other = WorkspaceOrigin.parse("https://other.example.test");
        assertFalse(store.read(origin).enabled);
        PhoneForBotsModel.Consent c = new PhoneForBotsModel.Consent(); c.enabled = true; c.sharing = true; c.rows.add("contacts");
        store.write(origin, c); store.recordProviderConsent(origin, "service");
        assertTrue(new PhoneConsentStore(stores).readForCommit(origin, "service", "contacts"));
        assertFalse(store.read(other).enabled);
        assertNotEquals(PhoneJobsTokenStore.key(origin), PhoneConsentStore.key(origin));
        assertFalse(prefs.getString(PhoneConsentStore.key(origin), "").contains("contacts"));
    }

    @Test public void bridgeTakesNoArgumentsReturnsVoidAndOnlyPresents() throws Exception {
        int[] presented = {0};
        PhoneForBotsEntry.open(new JSONObject(), true, () -> presented[0]++);
        PhoneForBotsEntry.open(new JSONObject(), false, () -> fail());
        assertEquals(1, presented[0]);
        assertEquals(Void.TYPE, PhoneForBotsEntry.class.getMethod("open", JSONObject.class, boolean.class, Runnable.class).getReturnType());
        try { PhoneForBotsEntry.open(new JSONObject().put("provider", "injected"), true, () -> fail()); fail(); }
        catch (ChannelException expected) { assertEquals("bad_args", expected.code); }
        try { ChannelGate.parse("{\"id\":1,\"method\":\"openPhoneForBots\",\"args\":{\"token\":\"injected\"}}"); fail(); }
        catch (ChannelException expected) { assertEquals("bad_args", expected.code); }
        String source = new String(Files.readAllBytes(Paths.get("src/main/java/com/murage/mobile/WorkspaceActivity.java")), StandardCharsets.UTF_8);
        int start = source.indexOf("case \"openPhoneForBots\":");
        assertTrue(start >= 0);
        String dispatch = source.substring(start, source.indexOf("case \"hello\":", start));
        assertTrue(dispatch.contains("reply.ok(null)")); assertTrue(dispatch.contains("runOnUiThread"));
        for (String forbidden : Arrays.asList("PhoneJobsSigner", "PhoneJobsTokenStore", "PhoneConsentStore", "readForRunner", "recordProviderConsent", "signPhoneJobs", "request.args.get")) assertFalse(forbidden, dispatch.contains(forbidden));
    }
}
