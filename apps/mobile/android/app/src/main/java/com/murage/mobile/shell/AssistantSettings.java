package com.murage.mobile.shell;

import java.util.function.Predicate;

/** Destinations for assistant setup, with a package-bound Settings fallback. */
public final class AssistantSettings {
    private AssistantSettings() {}
    public enum Destination {
        ROLE(null, null),
        DEFAULT_APPS("android.settings.MANAGE_DEFAULT_APPS_SETTINGS", "com.android.settings"),
        SETTINGS("android.settings.SETTINGS", "com.android.settings");

        public final String action, packageName;
        Destination(String action, String packageName) { this.action = action; this.packageName = packageName; }
    }

    public static void open(int sdk, boolean roleAvailable, Predicate<Destination> launch) {
        Destination target = sdk >= 29 && roleAvailable ? Destination.ROLE : Destination.DEFAULT_APPS;
        if (!launch.test(target)) launch.test(Destination.SETTINGS);
    }
}
