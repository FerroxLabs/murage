package com.murage.mobile.shell;

import static org.junit.Assert.*;

import java.net.InetAddress;
import java.util.Arrays;
import java.util.Collections;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * contract/tailscale-address.json, whose oracle is isTailnetAddress in
 * src/lib/native-contract.test.ts. The glue hands the core
 * InetAddress.getAddress(); every fixture address is a literal, so
 * getByName parses it without a lookup.
 */
public class TailscaleAddressTest {
    @Test public void sharedAddressCases() throws Exception {
        JSONArray cases = new JSONArray(Fixtures.read("tailscale-address.json"));
        assertTrue(cases.length() > 30);
        for (int i = 0; i < cases.length(); i++) {
            JSONObject entry = cases.getJSONObject(i);
            String text = entry.getString("address");
            byte[] raw = InetAddress.getByName(text).getAddress();
            assertEquals(text, entry.getBoolean("tailnet"), TailscaleAddress.isTailnet(raw));
        }
    }

    /** Java already hands a mapped address over as 4 bytes; the 16-byte form reads the same, as Swift's does. */
    @Test public void ipv4MappedReadsTheEmbeddedAddress() {
        byte ff = (byte) 0xff;
        assertTrue(TailscaleAddress.isTailnet(new byte[] {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ff, ff, 100, 64, 0, 1}));
        assertFalse(TailscaleAddress.isTailnet(new byte[] {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ff, ff, 100, (byte) 128, 0, 0}));
        assertFalse(TailscaleAddress.isTailnet(new byte[] {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 64, 0, 1})); // IPv4-compatible is not mapped
    }

    @Test public void onlyFourOrSixteenBytesAreAddresses() {
        assertFalse(TailscaleAddress.isTailnet(null));
        assertFalse(TailscaleAddress.isTailnet(new byte[0]));
        assertFalse(TailscaleAddress.isTailnet(new byte[] {100, 64, 0}));
        assertFalse(TailscaleAddress.isTailnet(new byte[] {100, 64, 0, 1, 0}));
        assertFalse(TailscaleAddress.isTailnet(new byte[] {(byte) 0xfd, 0x7a, 0x11, 0x5c, (byte) 0xa1, (byte) 0xe0}));
    }

    private static final byte[] ON = {100, 101, 102, 103};
    private static final byte[] WIFI = {(byte) 192, (byte) 168, 1, 20};

    @Test public void androidKnowsWhetherItIsInstalled() {
        TailscaleStatus on = TailscaleStatus.android(true, Arrays.asList(WIFI, ON));
        assertEquals(Boolean.TRUE, on.installed);
        assertEquals(Boolean.TRUE, on.connected);
        TailscaleStatus off = TailscaleStatus.android(true, Collections.singletonList(WIFI));
        assertEquals(Boolean.TRUE, off.installed);
        assertEquals(Boolean.FALSE, off.connected);
        TailscaleStatus missing = TailscaleStatus.android(false, Collections.<byte[]>emptyList());
        assertEquals(Boolean.FALSE, missing.installed);
        assertEquals(Boolean.FALSE, missing.connected);
        // The interfaces could not be read: unknown, never "off".
        TailscaleStatus unread = TailscaleStatus.android(true, null);
        assertEquals(Boolean.TRUE, unread.installed);
        assertNull(unread.connected);
        // A tailnet address with the package hidden: it is there all the same.
        assertEquals(Boolean.TRUE, TailscaleStatus.android(false, Collections.singletonList(ON)).installed);
    }

    @Test public void wireShapeUsesNullForUnknown() throws Exception {
        JSONObject wire = new TailscaleStatus(null, false).wire();
        assertSame(JSONObject.NULL, wire.get("installed"));
        assertEquals(false, wire.get("connected"));
        assertEquals(2, wire.length());
    }
}
