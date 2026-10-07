package com.murage.mobile.shell;

import static org.junit.Assert.*;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** contract/navigation.json, whose oracle is navigationDecision and mayCapture in src/lib/native-contract.test.ts (final review I3). */
public class NavigationPolicyTest {
    private static NavigationPolicy.Target target(String wire) {
        switch (wire) {
            case "main":
                return NavigationPolicy.Target.MAIN_FRAME;
            case "sub":
                return NavigationPolicy.Target.SUBFRAME;
            case "newWindow":
                return NavigationPolicy.Target.NEW_WINDOW;
            default:
                throw new AssertionError("unknown target " + wire);
        }
    }

    private static NavigationPolicy.Decision decision(String wire) {
        switch (wire) {
            case "allow":
                return NavigationPolicy.Decision.ALLOW;
            case "cancel":
                return NavigationPolicy.Decision.CANCEL;
            case "sendOut":
                return NavigationPolicy.Decision.SEND_OUT;
            case "openHere":
                return NavigationPolicy.Decision.OPEN_HERE;
            default:
                throw new AssertionError("unknown decision " + wire);
        }
    }

    @Test
    public void sharedNavigationCases() throws Exception {
        JSONObject contract = new JSONObject(Fixtures.read("navigation.json"));
        WorkspaceOrigin saved = WorkspaceOrigin.parse(contract.getString("origin"));
        JSONArray cases = contract.getJSONArray("navigations");
        assertTrue(cases.length() > 40);
        for (int i = 0; i < cases.length(); i++) {
            JSONObject entry = cases.getJSONObject(i);
            String url = entry.getString("url");
            String target = entry.getString("target");
            assertEquals(target + " " + url, decision(entry.getString("decision")), NavigationPolicy.decide(url, target(target), saved));
        }
    }

    @Test
    public void sharedCaptureCases() throws Exception {
        JSONObject contract = new JSONObject(Fixtures.read("navigation.json"));
        WorkspaceOrigin saved = WorkspaceOrigin.parse(contract.getString("origin"));
        JSONArray cases = contract.getJSONArray("captures");
        assertTrue(cases.length() > 5);
        for (int i = 0; i < cases.length(); i++) {
            JSONObject entry = cases.getJSONObject(i);
            String requester = entry.isNull("requester") ? null : entry.getString("requester");
            Boolean mainFrame = entry.isNull("mainFrame") ? null : entry.getBoolean("mainFrame");
            assertEquals(requester + " " + mainFrame, entry.getBoolean("granted"), NavigationPolicy.mayCapture(requester, mainFrame, saved));
        }
    }

    /** M3: only a failed load of the workspace's own main document closes it; a foreign form POST that fails is sent back. */
    @Test
    public void onlyTheOwnMainDocumentFailingClosesTheWorkspace() {
        WorkspaceOrigin saved = WorkspaceOrigin.parse("https://mac.tailnet123.ts.net:8444");
        assertTrue(NavigationPolicy.isOwnMainDocument("https://mac.tailnet123.ts.net:8444/", true, saved));
        assertTrue(NavigationPolicy.isOwnMainDocument("https://MAC.tailnet123.ts.net:8444/enter", true, saved));
        assertFalse(NavigationPolicy.isOwnMainDocument("https://mac.tailnet123.ts.net:8444/", false, saved));
        assertFalse(NavigationPolicy.isOwnMainDocument("https://no-such-host.invalid/form", true, saved));
        assertFalse(NavigationPolicy.isOwnMainDocument("https://mac.tailnet123.ts.net/", true, saved));
        assertFalse(NavigationPolicy.isOwnMainDocument("https://mac.tailnet123.ts.net:8444@evil.example/", true, saved));
        assertFalse(NavigationPolicy.isOwnMainDocument(null, true, saved));
    }
}
