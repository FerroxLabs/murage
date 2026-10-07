package com.murage.mobile;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import com.murage.mobile.shell.ApprovalProof;
import com.murage.mobile.shell.WorkspaceOrigin;
import java.security.GeneralSecurityException;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;

/**
 * SEC-006: the per-computer approval key and the prompt that unlocks it. The key
 * is an EC P-256 pair in AndroidKeyStore (StrongBox when the phone has it, else
 * the TEE): the private half never leaves the hardware, is not backed up, and
 * signs only after the person authenticates with a strong biometric or the
 * device credential. Nothing here logs keys, signatures or nonces. The Keystore
 * and BiometricPrompt calls are thin wrappers over platform services and are not
 * unit-tested; the message bytes and key encoding live in ApprovalProof, which is.
 */
final class ApprovalKeys {
    interface Callback {
        void ok(String signature);

        void error(String code);
    }

    private static final String PROVIDER = "AndroidKeyStore";

    private ApprovalKeys() {}

    /**
     * Makes a fresh key for this computer, replacing any older one, and returns
     * its public point (base64url, uncompressed), or null when the phone has no
     * screen lock or the key cannot be made. The key is not invalidated when
     * fingerprints change: the lock screen remains the gate.
     */
    static String enrol(Context context, WorkspaceOrigin origin) {
        // Never keep a key from an earlier pairing: it goes first, whatever follows.
        remove(origin);
        String alias = ApprovalProof.alias(origin.serialized());
        try {
            KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
            if (keyguard == null || !keyguard.isDeviceSecure()) return null;
            java.security.KeyPair pair;
            if (context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)) {
                try {
                    pair = generate(alias, true);
                } catch (GeneralSecurityException | RuntimeException e) {
                    // Some OEM StrongBox parts fail with a plain ProviderException, not
                    // StrongBoxUnavailableException: drop any half-made entry, retry in the TEE.
                    remove(origin);
                    pair = generate(alias, false);
                }
            } else {
                pair = generate(alias, false);
            }
            return ApprovalProof.rawPointFromSpki(pair.getPublic().getEncoded());
        } catch (GeneralSecurityException | RuntimeException e) {
            // ProviderException and friends come from OEM keystores: pairing must not crash.
            return null;
        }
    }

    private static java.security.KeyPair generate(String alias, boolean strongBox) throws GeneralSecurityException {
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(false);
        if (Build.VERSION.SDK_INT >= 30) {
            spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
        } else {
            spec.setUserAuthenticationValidityDurationSeconds(5);
        }
        if (strongBox) spec.setIsStrongBoxBacked(true);
        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER);
        generator.initialize(spec.build());
        return generator.generateKeyPair();
    }

    private static void deleteEntry(String alias) throws GeneralSecurityException, java.io.IOException {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(alias)) store.deleteEntry(alias);
    }

    /** Forgets this computer's key (sign-out, re-pair). Best effort. */
    static void remove(WorkspaceOrigin origin) {
        try {
            deleteEntry(ApprovalProof.alias(origin.serialized()));
        } catch (GeneralSecurityException | java.io.IOException | RuntimeException e) {
            // Nothing to do: an orphaned key only signs behind the same prompt.
        }
    }

    /**
     * Asks the person to authenticate, then signs request.message() with the
     * computer's key. Calls back on the main thread, exactly once. The returned
     * signal cancels the prompt (null when no prompt was started).
     */
    static CancellationSignal sign(Activity activity, WorkspaceOrigin origin, ApprovalProof.Request request, Callback target) {
        java.util.concurrent.atomic.AtomicBoolean answered = new java.util.concurrent.atomic.AtomicBoolean();
        Callback callback = new Callback() {
            @Override public void ok(String signature) { if (answered.compareAndSet(false, true)) target.ok(signature); }

            @Override public void error(String code) { if (answered.compareAndSet(false, true)) target.error(code); }
        };
        try {
            return signOnce(activity, origin, request, callback);
        } catch (RuntimeException e) {
            callback.error("unavailable");
            return null;
        }
    }

    private static CancellationSignal signOnce(Activity activity, WorkspaceOrigin origin, ApprovalProof.Request request, Callback callback) {
        String alias = ApprovalProof.alias(origin.serialized());
        PrivateKey key;
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            key = (PrivateKey) store.getKey(alias, null);
        } catch (GeneralSecurityException | java.io.IOException e) {
            callback.error("unavailable");
            return null;
        }
        if (key == null) {
            callback.error("no_key");
            return null;
        }
        Signature signature = null;
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                signature = Signature.getInstance("SHA256withECDSA");
                signature.initSign(key);
            } catch (KeyPermanentlyInvalidatedException e) {
                callback.error("no_key");
                return null;
            } catch (GeneralSecurityException e) {
                callback.error("unavailable");
                return null;
            }
        }
        BiometricPrompt.Builder builder = new BiometricPrompt.Builder(activity)
            .setTitle("Confirm it's you")
            .setDescription(request.reason);
        if (Build.VERSION.SDK_INT >= 30) {
            builder.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
        } else {
            builder.setDeviceCredentialAllowed(true);
        }
        CancellationSignal cancel = new CancellationSignal();
        BiometricPrompt.AuthenticationCallback result = new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationError(int code, CharSequence message) {
                if (code == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED || code == BiometricPrompt.BIOMETRIC_ERROR_CANCELED) callback.error("cancelled");
                else if (code == BiometricPrompt.BIOMETRIC_ERROR_NO_DEVICE_CREDENTIAL) callback.error("no_lock");
                else callback.error("unavailable");
            }

            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult authenticated) {
                try {
                    Signature signer = authenticated.getCryptoObject() != null ? authenticated.getCryptoObject().getSignature() : null;
                    if (signer == null) {
                        signer = Signature.getInstance("SHA256withECDSA");
                        signer.initSign(key);
                    }
                    signer.update(request.message());
                    callback.ok(ApprovalProof.base64url(signer.sign()));
                } catch (KeyPermanentlyInvalidatedException e) {
                    callback.error("no_key");
                } catch (GeneralSecurityException | RuntimeException e) {
                    callback.error("unavailable");
                }
            }
        };
        BiometricPrompt prompt = builder.build();
        if (signature != null) prompt.authenticate(new BiometricPrompt.CryptoObject(signature), cancel, activity.getMainExecutor(), result);
        else prompt.authenticate(cancel, activity.getMainExecutor(), result);
        return cancel;
    }
}
