package com.murage.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import com.murage.mobile.shell.PairingLink;
import java.util.UUID;

/**
 * Spec §3.3 "Device records": Keystore contents are wiped on uninstall, so
 * the install id lives in the one preferences file Auto Backup restores
 * (res/xml/backup_rules.xml; cloud backup only, never device transfer).
 * Without a backup a reinstall is a new install. The id is not a secret; it
 * only lets a re-pair replace this install's record.
 */
final class InstallId {
    private static final String KEY = "installId";

    private InstallId() {}

    /** The id, or null when a stored value is present but invalid (then pairing sends none). */
    static String get(Context context) {
        return from(context.getSharedPreferences("murage_install", Context.MODE_PRIVATE));
    }

    static synchronized String from(SharedPreferences prefs) {
        String stored = prefs.getString(KEY, null);
        if (stored != null) {
            if (PairingLink.validInstallId(stored)) return stored;
            // Never overwritten: a new id would orphan this install's record on the computer.
            ShellLog.i("install id unreadable length=" + stored.length());
            return null;
        }
        String fresh = PairingLink.newInstallId("and", UUID.randomUUID());
        if (!prefs.edit().putString(KEY, fresh).commit()) ShellLog.i("install id save failed");
        return fresh;
    }
}
