package com.murage.mobile.shell;

import org.json.JSONObject;

/** Presentation-only bridge boundary, with no state or credential dependencies. */
public final class PhoneForBotsEntry {
    private PhoneForBotsEntry() {}
    public static void open(JSONObject args, boolean paired, Runnable present) throws ChannelException {
        if (args.length() != 0) throw new ChannelException("bad_args");
        if (paired) present.run();
    }
}
