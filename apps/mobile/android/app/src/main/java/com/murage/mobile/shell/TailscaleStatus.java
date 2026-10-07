package com.murage.mobile.shell;

import java.util.List;
import org.json.JSONObject;

/**
 * What the launcher's state() says about Tailscale; null is unknown, and the
 * launcher then keeps its general wording. Twin of TailscaleStatus.swift.
 */
public final class TailscaleStatus {
    public final Boolean installed;
    public final Boolean connected;

    public TailscaleStatus(Boolean installed, Boolean connected) {
        this.installed = installed;
        this.connected = connected;
    }

    /**
     * {@code packageVisible}: com.tailscale.ipn is installed (the manifest's
     * queries entry makes it visible). {@code addresses}: every address on an
     * interface that is up, or null when they could not be read.
     */
    public static TailscaleStatus android(boolean packageVisible, List<byte[]> addresses) {
        Boolean connected = null;
        if (addresses != null) {
            connected = false;
            for (byte[] raw : addresses) {
                if (TailscaleAddress.isTailnet(raw)) connected = true;
            }
        }
        return new TailscaleStatus(packageVisible || Boolean.TRUE.equals(connected), connected);
    }

    public JSONObject wire() {
        JSONObject wire = new JSONObject();
        Json.put(wire, "installed", installed == null ? JSONObject.NULL : installed);
        Json.put(wire, "connected", connected == null ? JSONObject.NULL : connected);
        return wire;
    }
}
