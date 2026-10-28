package com.murage.mobile.shell;

import static org.junit.Assert.*;
import java.util.*;
import org.junit.Test;
import com.murage.mobile.shell.AssistantSettings.Destination;

public class AssistantSettingsTest {
    @Test public void everyDestinationHasAnAssistantRoleOrSettingsPackage() {
        for (Destination destination : Destination.values()) {
            if (destination == Destination.ROLE) continue;
            assertEquals("com.android.settings", destination.packageName);
            assertNotNull(destination.action);
        }
        assertEquals("android.settings.MANAGE_DEFAULT_APPS_SETTINGS", Destination.DEFAULT_APPS.action);
        assertEquals("android.settings.SETTINGS", Destination.SETTINGS.action);
    }

    @Test public void availableRoleIsRequestedOnlyOnApi29AndAbove() {
        for (int sdk : new int[]{27, 28, 29, 33, 35}) for (boolean available : new boolean[]{false, true}) {
            List<Destination> opened = new ArrayList<>();
            AssistantSettings.open(sdk, available, destination -> { opened.add(destination); return true; });
            assertEquals(Collections.singletonList(sdk >= 29 && available ? Destination.ROLE : Destination.DEFAULT_APPS), opened);
        }
    }

    @Test public void missingRoleOrDefaultAppsActivityFallsBackToPlainSettingsOnce() {
        for (boolean available : new boolean[]{false, true}) for (boolean fallbackExists : new boolean[]{false, true}) {
            List<Destination> opened = new ArrayList<>();
            AssistantSettings.open(29, available, destination -> {
                opened.add(destination); return destination == Destination.SETTINGS && fallbackExists;
            });
            assertEquals(Arrays.asList(available ? Destination.ROLE : Destination.DEFAULT_APPS, Destination.SETTINGS), opened);
        }
    }
}
