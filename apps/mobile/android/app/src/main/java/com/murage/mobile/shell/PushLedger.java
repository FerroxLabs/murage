package com.murage.mobile.shell;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Twin of PushLedger.swift; oracle apps/mobile/src/push-ledger.ts. */
public final class PushLedger {
    public static final int SEEN_LIMIT = 500;
    public enum Accept { SHOW("show"), STALE("stale"), UNKNOWN("unknown"); public final String wire; Accept(String w) { wire = w; } }
    public static final class Pending { public final String collapseKey; public final int revision; public Pending(String k, int r) { collapseKey = k; revision = r; } }
    private static final class Entry { final String origin; int badge; Entry(String o, int b) { origin = o; badge = b; } }

    private final Map<String, Entry> bindings = new LinkedHashMap<>();
    private final Deque<Object[]> seen = new ArrayDeque<>();

    public void bind(String bindingId, String origin) {
        // LinkedHashMap.put on an existing key updates the value in place, without moving
        // it, and on a new key appends: that alone gives the contract's insertion order
        // (the TS oracle's Map has the same behaviour). Do not also remove(bindingId)
        // unconditionally first, or every rebind would move the id to the end.
        bindings.values().removeIf(e -> e.origin.equals(origin));
        bindings.put(bindingId, new Entry(origin, 0));
    }
    public String unbindOrigin(String origin) {
        for (Iterator<Map.Entry<String, Entry>> it = bindings.entrySet().iterator(); it.hasNext();) {
            Map.Entry<String, Entry> e = it.next();
            if (e.getValue().origin.equals(origin)) { it.remove(); return e.getKey(); }
        }
        return null;
    }
    public String origin(String bindingId) { Entry e = bindings.get(bindingId); return e == null ? null : e.origin; }
    public List<String> bindingIds() { return new ArrayList<>(bindings.keySet()); }
    public String binding(String origin) {
        for (Map.Entry<String, Entry> e : bindings.entrySet()) if (e.getValue().origin.equals(origin)) return e.getKey();
        return null;
    }
    public int total() { int sum = 0; for (Entry e : bindings.values()) sum += e.badge; return sum; }

    private Object[] find(String key) { for (Object[] s : seen) if (s[0].equals(key)) return s; return null; }
    private void remember(String key, int revision) {
        Object[] at = find(key);
        if (at != null) seen.remove(at);
        seen.addLast(new Object[] {key, revision});
        while (seen.size() > SEEN_LIMIT) seen.removeFirst();
    }

    public Accept accept(String bindingId, String collapseKey, int revision, int workspaceBadge) {
        Entry e = bindings.get(bindingId);
        if (e == null) return Accept.UNKNOWN;
        Object[] at = find(collapseKey);
        if (at != null && (int) at[1] >= revision) return Accept.STALE;
        remember(collapseKey, revision);
        e.badge = Math.max(0, workspaceBadge);
        return Accept.SHOW;
    }
    public void setBadge(String bindingId, int count) { Entry e = bindings.get(bindingId); if (e != null) e.badge = Math.max(0, count); }

    public List<String> reconcile(String bindingId, int badge, List<Pending> pending, List<String> shown) {
        setBadge(bindingId, badge);
        Set<String> live = new HashSet<>();
        for (Pending p : pending) {
            live.add(p.collapseKey);
            Object[] at = find(p.collapseKey);
            if (at == null || (int) at[1] < p.revision) remember(p.collapseKey, p.revision);
        }
        List<String> out = new ArrayList<>();
        for (String key : shown) if (!live.contains(key)) out.add(key);
        Collections.sort(out);
        return out;
    }

    /** `bindings` is an ordered array of `[bindingId, origin, badge]` triples, not a JSON
     *  object keyed by bindingId: neither org.json copy (Json.java) guarantees an object's
     *  key order survives a round trip, and `bindingIds` order (the contract, defined by
     *  the TS oracle) must. */
    public String encode() {
        JSONArray b = new JSONArray();
        for (Map.Entry<String, Entry> e : bindings.entrySet()) {
            JSONArray triple = new JSONArray();
            triple.put(e.getKey());
            triple.put(e.getValue().origin);
            triple.put(e.getValue().badge);
            b.put(triple);
        }
        JSONArray s = new JSONArray();
        for (Object[] pair : seen) s.put(new JSONArray().put(pair[0]).put(pair[1]));
        JSONObject out = new JSONObject();
        Json.put(out, "bindings", b);
        Json.put(out, "seen", s);
        return out.toString();
    }
    public static PushLedger decode(String text) {
        PushLedger ledger = new PushLedger();
        JSONObject o = Json.object(text);
        if (o == null) return ledger;
        JSONArray b = o.optJSONArray("bindings");
        for (int i = 0; b != null && i < b.length(); i++) {
            JSONArray triple = b.optJSONArray(i);
            if (triple == null || triple.length() != 3) continue;
            Object id = triple.opt(0);
            Object origin = triple.opt(1);
            if (!(id instanceof String) || !(origin instanceof String) || !((String) origin).startsWith("https://")) continue;
            Integer badge = ChannelArgs.integer(triple.opt(2));
            ledger.bindings.put((String) id, new Entry((String) origin, badge == null ? 0 : badge));
        }
        JSONArray s = o.optJSONArray("seen");
        for (int i = 0; s != null && i < s.length(); i++) {
            JSONArray pair = s.optJSONArray(i);
            Object key = pair == null ? null : pair.opt(0);
            Integer revision = pair == null ? null : ChannelArgs.integer(pair.opt(1));
            if (key instanceof String && revision != null) ledger.seen.addLast(new Object[] {key, revision});
        }
        while (ledger.seen.size() > SEEN_LIMIT) ledger.seen.removeFirst();
        return ledger;
    }
}
