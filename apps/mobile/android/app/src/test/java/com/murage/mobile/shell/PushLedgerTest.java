package com.murage.mobile.shell;

import static org.junit.Assert.assertEquals;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class PushLedgerTest {
    private static void run(String name, JSONArray steps) throws Exception {
        PushLedger ledger = new PushLedger();
        for (int i = 0; i < steps.length(); i++) {
            JSONObject s = steps.getJSONObject(i);
            String binding = s.optString("bindingId");
            Object expected = s.isNull("expect") ? null : s.opt("expect");
            switch (s.getString("op")) {
                case "bind": ledger.bind(binding, s.getString("origin")); break;
                case "origin": assertEquals(name, expected, ledger.origin(binding)); break;
                case "binding": assertEquals(name, expected, ledger.binding(s.getString("origin"))); break;
                case "bindingIds": {
                    List<String> want = new ArrayList<>();
                    JSONArray e = s.getJSONArray("expect");
                    for (int k = 0; k < e.length(); k++) want.add(e.getString(k));
                    assertEquals(name, want, ledger.bindingIds());
                    break;
                }
                case "accept":
                    assertEquals(name, expected, ledger.accept(binding, s.getString("collapseKey"), s.getInt("revision"), s.getInt("workspaceBadge")).wire);
                    assertEquals(name, s.getInt("total"), ledger.total());
                    break;
                case "acceptMany":
                    for (int k = 0; k < s.getInt("count"); k++) ledger.accept(binding, s.getString("prefix") + k, s.getInt("revision"), s.getInt("workspaceBadge"));
                    break;
                case "setBadge": ledger.setBadge(binding, s.getInt("count")); assertEquals(name, s.getInt("total"), ledger.total()); break;
                case "unbindOrigin": assertEquals(name, expected, ledger.unbindOrigin(s.getString("origin"))); assertEquals(name, s.getInt("total"), ledger.total()); break;
                case "reconcile": {
                    List<PushLedger.Pending> pending = new ArrayList<>();
                    JSONArray p = s.getJSONArray("pending");
                    for (int k = 0; k < p.length(); k++) pending.add(new PushLedger.Pending(p.getJSONObject(k).getString("collapseKey"), p.getJSONObject(k).getInt("revision")));
                    List<String> shown = new ArrayList<>();
                    JSONArray sh = s.getJSONArray("shown");
                    for (int k = 0; k < sh.length(); k++) shown.add(sh.getString(k));
                    List<String> want = new ArrayList<>();
                    JSONArray e = s.getJSONArray("expect");
                    for (int k = 0; k < e.length(); k++) want.add(e.getString(k));
                    assertEquals(name, want, ledger.reconcile(binding, s.getInt("badge"), pending, shown));
                    assertEquals(name, s.getInt("total"), ledger.total());
                    break;
                }
                case "roundTrip": ledger = PushLedger.decode(ledger.encode()); break;
                default: throw new AssertionError("unknown op");
            }
        }
    }

    @Test public void everyFixtureCase() throws Exception {
        JSONObject fixture = new JSONObject(Fixtures.read("push-ledger.json"));
        JSONArray cases = fixture.getJSONArray("cases");
        for (int i = 0; i < cases.length(); i++) run(cases.getJSONObject(i).getString("name"), cases.getJSONObject(i).getJSONArray("steps"));
    }

    @Test public void decodeIsForgiving() throws Exception {
        JSONArray cases = new JSONObject(Fixtures.read("push-ledger.json")).getJSONArray("decode");
        for (int i = 0; i < cases.length(); i++) assertEquals(cases.getJSONObject(i).getInt("total"), PushLedger.decode(cases.getJSONObject(i).getString("input")).total());
    }
}
