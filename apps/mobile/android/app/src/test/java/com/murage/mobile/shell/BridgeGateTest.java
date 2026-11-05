package com.murage.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/** A closing workspace's page reaches nothing native, whatever it asks. */
public class BridgeGateTest {
    /** What the channel handler does with a request, in the order it does it. */
    private static String handle(BridgeGate gate, String method, List<String> ran) {
        if (!gate.admitsRequest()) return "unavailable";
        ran.add(method);
        return null;
    }

    @Test public void everyMethodIsAdmittedWhileOpen() {
        BridgeGate gate = new BridgeGate();
        List<String> ran = new ArrayList<>();
        for (String method : ChannelGate.ADVERTISED) assertNull(method, handle(gate, method, ran));
        assertEquals(ChannelGate.ADVERTISED, ran);
        assertTrue(gate.admitsEvent());
    }

    @Test public void onceClosingEveryMethodIsRejectedAndNeverRuns() {
        BridgeGate gate = new BridgeGate();
        gate.close();
        List<String> ran = new ArrayList<>();
        for (String method : ChannelGate.ADVERTISED) assertEquals(method, "unavailable", handle(gate, method, ran));
        assertTrue("no method body ran", ran.isEmpty());
    }

    @Test public void onceClosingNoEventIsSentAndClosingIsIrreversible() {
        BridgeGate gate = new BridgeGate();
        gate.close();
        assertFalse(gate.admitsEvent());
        gate.close();
        assertTrue(gate.isClosed());
        assertFalse(gate.admitsEvent());
    }
}
