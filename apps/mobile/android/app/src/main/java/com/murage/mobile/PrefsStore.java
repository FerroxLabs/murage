package com.murage.mobile;

import android.content.SharedPreferences;
import com.murage.mobile.shell.KeyValueStore;

/** RouteMemory's store: the last conversation per computer and the pending intent. */
final class PrefsStore implements KeyValueStore {
    private final SharedPreferences prefs;

    PrefsStore(SharedPreferences prefs) {
        this.prefs = prefs;
    }

    @Override public String get(String key) {
        return prefs.getString(key, null);
    }

    /** commit, not apply: the process may be killed right after (spec §3.2 "Persisted state"). */
    @Override public void put(String key, String value) {
        if (value == null) prefs.edit().remove(key).commit();
        else prefs.edit().putString(key, value).commit();
    }
}
