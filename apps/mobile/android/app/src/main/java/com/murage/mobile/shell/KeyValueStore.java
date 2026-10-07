package com.murage.mobile.shell;

/** SharedPreferences in the app (P18); memory in tests. A null value removes the key. */
public interface KeyValueStore {
    String get(String key);
    void put(String key, String value);
}
