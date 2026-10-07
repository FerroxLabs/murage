package com.murage.mobile;

import android.content.SharedPreferences;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/** An in-memory SharedPreferences whose commit() can be made to fail. */
final class FakePrefs implements SharedPreferences {
    final Map<String, Object> values = new HashMap<>();
    boolean commitSucceeds = true;
    /** When set, a commit that writes a key starting with this text fails. */
    String failWritesTo = null;

    @Override public Map<String, ?> getAll() { return new HashMap<>(values); }
    @Override public String getString(String key, String fallback) { return values.containsKey(key) ? (String) values.get(key) : fallback; }
    @SuppressWarnings("unchecked")
    @Override public Set<String> getStringSet(String key, Set<String> fallback) { return values.containsKey(key) ? (Set<String>) values.get(key) : fallback; }
    @Override public int getInt(String key, int fallback) { return values.containsKey(key) ? (Integer) values.get(key) : fallback; }
    @Override public long getLong(String key, long fallback) { return values.containsKey(key) ? (Long) values.get(key) : fallback; }
    @Override public float getFloat(String key, float fallback) { return values.containsKey(key) ? (Float) values.get(key) : fallback; }
    @Override public boolean getBoolean(String key, boolean fallback) { return values.containsKey(key) ? (Boolean) values.get(key) : fallback; }
    @Override public boolean contains(String key) { return values.containsKey(key); }
    @Override public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) {}
    @Override public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) {}

    @Override public Editor edit() {
        Map<String, Object> pending = new HashMap<>();
        Set<String> removed = new java.util.HashSet<>();
        return new Editor() {
            @Override public Editor putString(String key, String value) { pending.put(key, value); return this; }
            @Override public Editor putStringSet(String key, Set<String> value) { pending.put(key, value); return this; }
            @Override public Editor putInt(String key, int value) { pending.put(key, value); return this; }
            @Override public Editor putLong(String key, long value) { pending.put(key, value); return this; }
            @Override public Editor putFloat(String key, float value) { pending.put(key, value); return this; }
            @Override public Editor putBoolean(String key, boolean value) { pending.put(key, value); return this; }
            @Override public Editor remove(String key) { removed.add(key); return this; }
            @Override public Editor clear() { removed.addAll(values.keySet()); return this; }
            @Override public boolean commit() {
                if (!commitSucceeds) return false;
                if (failWritesTo != null) for (String key : pending.keySet()) if (key.startsWith(failWritesTo)) return false;
                for (String key : removed) values.remove(key);
                values.putAll(pending);
                return true;
            }
            @Override public void apply() { commit(); }
        };
    }
}
