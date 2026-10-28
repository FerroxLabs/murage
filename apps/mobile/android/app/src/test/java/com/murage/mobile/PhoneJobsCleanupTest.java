package com.murage.mobile;

import com.murage.mobile.shell.WorkspaceOrigin;
import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class PhoneJobsCleanupTest {
    static final class State implements PhoneJobsCleanup.State {
        final Map<WorkspaceOrigin, String> tokens = new HashMap<>();
        final Set<WorkspaceOrigin> consent = new HashSet<>(), ledger = new HashSet<>();
        boolean failTokenRemoval;
        public String token(WorkspaceOrigin w) { return tokens.get(w); }
        public void removeToken(WorkspaceOrigin w) throws Exception { if (failTokenRemoval) throw new java.io.IOException(); tokens.remove(w); }
        public void removeConsent(WorkspaceOrigin w) { consent.remove(w); }
        public void clearLedger(WorkspaceOrigin w) { ledger.remove(w); }
    }
    @Test public void signOutAndRemoveComputerClearOnlyTheirWorkspaceEvenIfDeleteFails() {
        for (String reason : Arrays.asList("signOut", "removeComputer", "signedOut")) {
            State state = new State();
            WorkspaceOrigin one = WorkspaceOrigin.parse("https://one.example.ts.net"), two = WorkspaceOrigin.parse("https://two.example.ts.net");
            for (WorkspaceOrigin w : Arrays.asList(one, two)) { state.tokens.put(w, "bearer"); state.consent.add(w); state.ledger.add(w); }
            PhoneJobRunnerTest.HTTP http = new PhoneJobRunnerTest.HTTP();
            PhoneJobsCleanup cleanup = new PhoneJobsCleanup(state, http);
            assertTrue(cleanup.forget(one));
            assertNull(state.tokens.get(one)); assertFalse(state.consent.contains(one)); assertFalse(state.ledger.contains(one));
            assertEquals("bearer", state.tokens.get(two)); assertTrue(state.consent.contains(two)); assertTrue(state.ledger.contains(two));
            assertEquals(1, http.requests.size());
            PhoneJobRunnerTest.Request request = http.requests.get(0);
            assertEquals("DELETE", request.method); assertEquals("", request.suffix); assertEquals(one, request.workspace);
            assertEquals("bearer", request.token); assertNull(request.body); assertEquals(3000, request.timeout);
            request.fail();
            assertTrue(cleanup.forget(one)); assertEquals(1, http.requests.size());
        }
    }
    @Test public void failedTokenRemovalDoesNotSkipConsentLedgerOrDelete() {
        State state = new State(); WorkspaceOrigin w = WorkspaceOrigin.parse("https://one.example.ts.net");
        state.tokens.put(w, "bearer"); state.consent.add(w); state.ledger.add(w); state.failTokenRemoval = true;
        PhoneJobRunnerTest.HTTP http = new PhoneJobRunnerTest.HTTP();
        assertFalse(new PhoneJobsCleanup(state, http).forget(w));
        assertFalse(state.consent.contains(w)); assertFalse(state.ledger.contains(w)); assertEquals(1, http.requests.size());
    }
    @Test public void realStoresClearWorkspaceAndLateLedgerWriteCannotRecreateIt() throws Exception {
        FakePrefs prefs = new FakePrefs();
        SecureStore.Keys keys = new SecureStore.Keys() {
            javax.crypto.SecretKey key;
            public javax.crypto.SecretKey existing() { return key; }
            public javax.crypto.SecretKey create() throws Exception {
                javax.crypto.KeyGenerator generator = javax.crypto.KeyGenerator.getInstance("AES"); generator.init(256);
                key = generator.generateKey(); return key;
            }
        };
        PhoneJobsTokenStore.Stores stores = name -> new SecureStore(prefs, keys, name);
        WorkspaceOrigin one = WorkspaceOrigin.parse("https://one.example.ts.net"), two = WorkspaceOrigin.parse("https://two.example.ts.net");
        PhoneJobsTokenStore tokens = new PhoneJobsTokenStore(stores); PhoneConsentStore consent = new PhoneConsentStore(stores);
        String token = "murage_pj_" + String.join("", Collections.nCopies(43, "a"));
        for (WorkspaceOrigin w : Arrays.asList(one, two)) {
            assertTrue(tokens.save(token, w));
            PhoneForBotsModel.Consent c = new PhoneForBotsModel.Consent(); c.enabled = true; c.sharing = true; c.rows.add("calendar"); c.providers.add("provider");
            consent.write(w, c);
        }
        PhoneOperationLedger.PrivateStorage first = new PhoneOperationLedger.PrivateStorage(stores, one), second = new PhoneOperationLedger.PrivateStorage(stores, two);
        PhoneOperationLedger ledger = new PhoneOperationLedger(first, () -> 1000L), other = new PhoneOperationLedger(second, () -> 1000L);
        other.perform("other-operation", () -> "other-event");
        String id = ledger.perform("operation", () -> {
            assertTrue(tokens.remove(one)); assertTrue(consent.remove(one)); first.clear();
            return "saved-event";
        });
        assertEquals("saved-event", id); assertNull(tokens.readForRunner(one));
        PhoneForBotsModel.Consent cleared = consent.read(one);
        assertFalse(cleared.enabled); assertFalse(cleared.sharing); assertTrue(cleared.rows.isEmpty()); assertTrue(cleared.providers.isEmpty());
        assertNull(new PhoneOperationLedger.PrivateStorage(stores, one).read());
        assertEquals(token, tokens.readForRunner(two)); assertTrue(consent.read(two).enabled);
        assertEquals("other-event", other.perform("other-operation", () -> { fail("duplicate save"); return "duplicate"; }));
    }

}
