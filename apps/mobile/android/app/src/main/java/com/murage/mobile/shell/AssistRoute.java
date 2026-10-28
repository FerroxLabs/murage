package com.murage.mobile.shell;

import java.util.function.Function;

/** Only the private shortcut component may supply routing extras. */
public final class AssistRoute {
    public static final String SHORTCUT = "com.murage.mobile.AssistShortcut";
    public static final String EXTRA_WORKSPACE = "murage.askWorkspace";
    public static final String EXTRA_BOT = "murage.askBot";
    public final String workspace, bot;

    public AssistRoute(String component, Function<String, String> extras) {
        boolean shortcut = SHORTCUT.equals(component);
        workspace = shortcut ? extras.apply(EXTRA_WORKSPACE) : null;
        bot = shortcut ? extras.apply(EXTRA_BOT) : null;
    }
}
