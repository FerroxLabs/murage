package com.murage.mobile;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.junit.Before;
import org.junit.Test;

/** The sealed book with a JVM AES key standing in for AndroidKeyStore (review round 1). */
public class SecureStoreTest {
    private static final byte[] BOOK = "{\"workspaces\":[{\"origin\":\"https://studio.example.ts.net\"}]}".getBytes(StandardCharsets.UTF_8);

    /** A keystore with at most one key, which counts how often a key is minted. */
    private static final class FakeKeys implements SecureStore.Keys {
        SecretKey key;
        int created;

        @Override public SecretKey existing() {
            return key;
        }

        @Override public SecretKey create() throws Exception {
            KeyGenerator generator = KeyGenerator.getInstance("AES");
            generator.init(256);
            key = generator.generateKey();
            created++;
            return key;
        }
    }

    private FakePrefs prefs;
    private FakeKeys keys;
    private SecureStore store;
    private LogCapture log;

    @Before public void setUp() {
        prefs = new FakePrefs();
        keys = new FakeKeys();
        store = new SecureStore(prefs, keys);
        log = new LogCapture();
    }

    @Test public void emptyOnlyWhenNothingWasEverSaved() {
        SecureStore.Read read = store.read();
        assertEquals(SecureStore.Read.State.EMPTY, read.state);
        assertNull(read.bytes);
        assertEquals("reading never mints a key", 0, keys.created);
    }

    @Test public void readsBackWhatItSealed() {
        assertTrue(store.write(BOOK));
        SecureStore.Read read = store.read();
        assertEquals(SecureStore.Read.State.OK, read.state);
        assertArrayEquals(BOOK, read.bytes);
        String sealed = (String) prefs.values.get("book");
        assertFalse("never stored in the clear", new String(Base64.getDecoder().decode(sealed), StandardCharsets.ISO_8859_1).contains("studio"));
    }

    @Test public void twoWritesUseFreshIvsAndOneKey() {
        assertTrue(store.write(BOOK));
        String first = (String) prefs.values.get("book");
        assertTrue(store.write(BOOK));
        assertFalse(first.equals(prefs.values.get("book")));
        assertEquals(1, keys.created);
    }

    @Test public void aMissingKeyWithABlobIsUnreadableAndMintsNothing() {
        assertTrue(store.write(BOOK));
        keys.key = null; // the Keystore entry is gone, the ciphertext is not
        int before = keys.created;
        SecureStore.Read read = store.read();
        assertEquals(SecureStore.Read.State.UNREADABLE, read.state);
        assertNull(read.bytes);
        assertEquals(before, keys.created);
        assertTrue(prefs.values.containsKey("book"));
    }

    @Test public void aCorruptBlobIsUnreadable() {
        assertTrue(store.write(BOOK));
        byte[] all = Base64.getDecoder().decode((String) prefs.values.get("book"));
        all[all.length - 1] ^= 1; // the GCM tag no longer matches
        prefs.values.put("book", Base64.getEncoder().encodeToString(all));
        assertEquals(SecureStore.Read.State.UNREADABLE, store.read().state);
    }

    @Test public void shortOrNonBase64BlobsAreUnreadable() throws Exception {
        keys.create();
        for (String bad : new String[] {"", "AAAA", "not base64!"}) {
            prefs.values.put("book", bad);
            assertEquals(bad, SecureStore.Read.State.UNREADABLE, store.read().state);
        }
    }

    @Test public void aKeystoreErrorIsUnreadable() {
        prefs.values.put("book", "AAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        SecureStore broken = new SecureStore(prefs, new SecureStore.Keys() {
            @Override public SecretKey existing() throws Exception { throw new java.security.KeyStoreException("locked"); }
            @Override public SecretKey create() { throw new AssertionError("read minted a key"); }
        });
        assertEquals(SecureStore.Read.State.UNREADABLE, broken.read().state);
    }

    @Test public void aFailedCommitIsReportedAndLogsNoContent() {
        prefs.commitSucceeds = false;
        assertFalse(store.write(BOOK));
        prefs.values.put("book", "garbage");
        store.read();
        assertFalse(log.all().contains("studio"));
        assertFalse(log.all().contains("garbage"));
    }
}
