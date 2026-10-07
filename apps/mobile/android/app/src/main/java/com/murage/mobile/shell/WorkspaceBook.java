package com.murage.mobile.shell;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The saved computers, kept encrypted with a Keystore key (P18). Twin of
 * WorkspaceBook.swift. Each entry is a bare origin, a display name and a time:
 * never a credential or cookie, and decoding drops any other field.
 */
public final class WorkspaceBook {
    public static final int LIMIT = 20;
    static final int MAX_NAME = 200;

    /** Immutable: an update replaces the entry, so a caller's copy never changes under it. */
    public static final class Entry {
        public final String origin;
        public final String name;
        public final long lastConnected;

        Entry(String origin, String name, long lastConnected) {
            this.origin = origin;
            this.name = name;
            this.lastConnected = lastConnected;
        }
    }

    private final List<Entry> workspaces = new ArrayList<>();
    private String active;

    /** Forgiving: anything unreadable is dropped, never an exception. */
    public static WorkspaceBook decode(byte[] data) {
        WorkspaceBook book = new WorkspaceBook();
        JSONObject json = data == null ? null : Json.object(new String(data, StandardCharsets.UTF_8));
        if (json == null) return book;
        JSONArray list = json.optJSONArray("workspaces");
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject item = list.optJSONObject(i);
            Object raw = item == null ? null : item.opt("origin");
            WorkspaceOrigin origin = raw instanceof String ? WorkspaceOrigin.parse((String) raw) : null;
            if (origin == null || book.entry(origin) != null) continue;
            Object name = item.opt("name");
            String clean = name instanceof String ? cleanName((String) name) : null;
            book.workspaces.add(new Entry(origin.serialized(), clean != null ? clean : defaultName(origin), time(item.opt("lastConnected"))));
        }
        // A file that somehow holds more than the limit keeps the newest; a tie drops the one listed first.
        while (book.workspaces.size() > LIMIT) book.workspaces.remove(book.oldest(null));
        // Like Swift: "active" must be exactly a saved origin.
        Object active = json.opt("active");
        if (active instanceof String && book.index((String) active) >= 0) book.active = (String) active;
        return book;
    }

    public byte[] encode() {
        JSONArray list = new JSONArray();
        for (Entry entry : workspaces) {
            JSONObject item = new JSONObject();
            Json.put(item, "origin", entry.origin);
            Json.put(item, "name", entry.name);
            Json.put(item, "lastConnected", entry.lastConnected);
            list.put(item);
        }
        JSONObject json = new JSONObject();
        Json.put(json, "workspaces", list);
        if (active != null) Json.put(json, "active", active);
        return json.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** Newest first; a copy. */
    public List<Entry> sorted() {
        List<Entry> copy = new ArrayList<>(workspaces);
        Collections.sort(copy, (a, b) -> Long.compare(b.lastConnected, a.lastConnected));
        return copy;
    }

    public Entry entry(WorkspaceOrigin origin) {
        if (origin == null) return null;
        int index = index(origin.serialized());
        return index < 0 ? null : workspaces.get(index);
    }

    public String active() {
        return active;
    }

    public void signedIn(WorkspaceOrigin origin, String name, long millis) {
        String key = origin.serialized();
        String clean = cleanName(name);
        int index = index(key);
        if (index >= 0) {
            Entry existing = workspaces.get(index);
            workspaces.set(index, new Entry(key, clean != null ? clean : existing.name, millis));
        } else {
            workspaces.add(new Entry(key, clean != null ? clean : defaultName(origin), millis));
            // Never the one just signed in to, even when its clock is behind every other.
            if (workspaces.size() > LIMIT) workspaces.remove(oldest(key));
        }
        active = key;
    }

    /** "Last connected" shows minutes, so a touch within one of the saved time changes nothing. */
    public static final long TOUCH_INTERVAL_MS = 60_000;

    /**
     * The computer was in use at {@code millis} (a later load, going to the
     * background): its time only. Never adds one (a removed computer stays
     * removed), never changes the active one, so never evicts. False when
     * nothing changed (not saved, or within TOUCH_INTERVAL_MS): no save
     * needed. Twin of Swift's touched.
     */
    public boolean touched(WorkspaceOrigin origin, long millis) {
        int index = index(origin.serialized());
        if (index < 0) return false;
        Entry existing = workspaces.get(index);
        long since = millis - existing.lastConnected;
        if (since >= 0 && since < TOUCH_INTERVAL_MS) return false;
        workspaces.set(index, new Entry(existing.origin, existing.name, millis));
        return true;
    }

    public void remove(WorkspaceOrigin origin) {
        int index = index(origin.serialized());
        if (index >= 0) workspaces.remove(index);
        if (origin.serialized().equals(active)) active = null;
    }

    /** The MagicDNS machine name: {@code example-mac} from {@code example-mac.tail….ts.net}. */
    public static String defaultName(WorkspaceOrigin origin) {
        int dot = origin.host.indexOf('.');
        return dot > 0 ? origin.host.substring(0, dot) : origin.host;
    }

    /**
     * A computer's name as shown: null when empty, else its first 200 code
     * points, so a cut never leaves half a surrogate pair. Swift counts
     * Unicode scalars (code points) too, so the two cut at the same place.
     */
    static String cleanName(String name) {
        if (name == null || name.isEmpty()) return null;
        if (name.codePointCount(0, name.length()) <= MAX_NAME) return name;
        return name.substring(0, name.offsetByCodePoints(0, MAX_NAME));
    }

    private int index(String origin) {
        for (int i = 0; i < workspaces.size(); i++) {
            if (workspaces.get(i).origin.equals(origin)) return i;
        }
        return -1;
    }

    /** The first-listed entry with the smallest time, other than {@code keep}. */
    private Entry oldest(String keep) {
        Entry oldest = null;
        for (Entry entry : workspaces) {
            if (entry.origin.equals(keep)) continue;
            if (oldest == null || entry.lastConnected < oldest.lastConnected) oldest = entry;
        }
        return oldest;
    }

    /** An Integer or Long only: optLong would also read "1e3" or 1.5, and the two org.json copies coerce differently. */
    private static long time(Object value) {
        return value instanceof Integer || value instanceof Long ? ((Number) value).longValue() : 0;
    }
}
