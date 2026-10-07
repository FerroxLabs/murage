package com.murage.mobile.shell;

/**
 * Tailscale's addresses (spec §3.1 can't-reach): IPv4 100.64.0.0/10 and IPv6
 * fd7a:115c:a1e0::/48. Twin of TailscaleAddress in TailscaleStatus.swift; the
 * shared cases are contract/tailscale-address.json. Raw network-order bytes,
 * 4 or 16, exactly InetAddress.getAddress(); anything else is not an address.
 */
public final class TailscaleAddress {
    private static final byte[] V6_PREFIX = {(byte) 0xfd, 0x7a, 0x11, 0x5c, (byte) 0xa1, (byte) 0xe0};

    private TailscaleAddress() {}

    public static boolean isTailnet(byte[] raw) {
        if (raw == null) return false;
        if (raw.length == 4) return raw[0] == 100 && (raw[1] & 0xC0) == 64;
        if (raw.length != 16) return false;
        // IPv4-mapped (::ffff:0:0/96) is its embedded IPv4. InetAddress already
        // hands those over as 4 bytes; this keeps the 16-byte form equal to Swift's.
        if (mapped(raw)) return isTailnet(new byte[] {raw[12], raw[13], raw[14], raw[15]});
        for (int i = 0; i < V6_PREFIX.length; i++) {
            if (raw[i] != V6_PREFIX[i]) return false;
        }
        return true;
    }

    private static boolean mapped(byte[] raw) {
        for (int i = 0; i < 10; i++) {
            if (raw[i] != 0) return false;
        }
        return raw[10] == (byte) 0xff && raw[11] == (byte) 0xff;
    }
}
