package com.murage.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.security.KeyStore;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The saved computers (spec §3.1: "stored in the Keystore"), sealed with an
 * AES-256-GCM key that never leaves AndroidKeyStore. Uninstalling wipes both
 * the key and the data (Decision 7), and murage_secure is not in the backup
 * rules, so a restore never brings back ciphertext without its key.
 *
 * <p>Contract for P19's Shell: {@link #read()} tells EMPTY (nothing was ever
 * saved) from UNREADABLE (a blob is there but the key is gone, the Keystore
 * failed or the blob is damaged). On UNREADABLE, {@code Shell.book()} returns
 * null, {@code signedIn} and {@code forget} refuse to save (a write would
 * mint a new key and overwrite the old book for good), and the launcher shows
 * "try again" with an explicit "start over", the only path that writes over
 * an unreadable book.
 */
final class SecureStore {
    /** Where the key lives. read() only ever calls existing(). */
    interface Keys {
        /** The key, or null when there is none. Throws when the Keystore itself fails. */
        SecretKey existing() throws Exception;

        SecretKey create() throws Exception;
    }

    static final class Read {
        enum State { EMPTY, OK, UNREADABLE }

        final State state;
        /** The plaintext book when OK, otherwise null. */
        final byte[] bytes;

        private Read(State state, byte[] bytes) {
            this.state = state;
            this.bytes = bytes;
        }

        static final Read EMPTY = new Read(State.EMPTY, null);
        static final Read UNREADABLE = new Read(State.UNREADABLE, null);
    }

    private static final String ALIAS = "murage.book.v1";
    private static final String KEY = "book";
    private static final int IV_BYTES = 12;
    private final SharedPreferences prefs;
    private final Keys keys;

    SecureStore(Context context) {
        this(context.getSharedPreferences("murage_secure", Context.MODE_PRIVATE), KEYSTORE);
    }

    SecureStore(SharedPreferences prefs, Keys keys) {
        this.prefs = prefs;
        this.keys = keys;
    }

    /** EMPTY only when the pref is absent. Never mints a key. */
    Read read() {
        String sealed = prefs.getString(KEY, null);
        if (sealed == null) return Read.EMPTY;
        try {
            SecretKey key = keys.existing();
            if (key == null) {
                ShellLog.i("book unreadable: no key");
                return Read.UNREADABLE;
            }
            byte[] all = Base64.getDecoder().decode(sealed);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, all, 0, IV_BYTES));
            return new Read(Read.State.OK, cipher.doFinal(all, IV_BYTES, all.length - IV_BYTES));
        } catch (Exception unreadable) {
            ShellLog.i("book unreadable error=" + unreadable.getClass().getSimpleName());
            return Read.UNREADABLE;
        }
    }

    /** Seals and commits. Mints the key when there is none, so callers must not write over an UNREADABLE book unasked. */
    boolean write(byte[] plain) {
        try {
            SecretKey key = keys.existing();
            if (key == null) key = keys.create();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key); // a fresh random IV every time
            byte[] iv = cipher.getIV();
            byte[] sealed = cipher.doFinal(plain);
            byte[] all = new byte[iv.length + sealed.length];
            System.arraycopy(iv, 0, all, 0, iv.length);
            System.arraycopy(sealed, 0, all, iv.length, sealed.length);
            if (prefs.edit().putString(KEY, Base64.getEncoder().encodeToString(all)).commit()) return true;
            ShellLog.i("book write failed: commit");
            return false;
        } catch (Exception failed) {
            ShellLog.i("book write failed error=" + failed.getClass().getSimpleName());
            return false;
        }
    }

    /** The AndroidKeyStore alias. Synchronized so two first writers cannot each mint a key. */
    static final Keys KEYSTORE = new Keys() {
        @Override public synchronized SecretKey existing() throws Exception {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (!store.containsAlias(ALIAS)) return null;
            return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
        }

        @Override public synchronized SecretKey create() throws Exception {
            SecretKey raced = existing();
            if (raced != null) return raced;
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
            return generator.generateKey();
        }
    };
}
