package com.murage.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** pushStatus's permission (A4 review Minor 1): below API 33 there is no prompt, so off is denied. */
public class PushServicesTest {
    @Test public void permissionReadsTheSameAsRegisterPush() {
        assertEquals("granted", PushServices.permission(true, false, 29));
        assertEquals("granted", PushServices.permission(true, false, 34));
        assertEquals("denied", PushServices.permission(false, false, 29));
        assertEquals("denied", PushServices.permission(false, false, 32));
        assertEquals("undetermined", PushServices.permission(false, false, 33));
        assertEquals("denied", PushServices.permission(false, true, 33));
    }
}
