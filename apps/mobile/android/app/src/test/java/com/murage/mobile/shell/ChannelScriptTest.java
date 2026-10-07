package com.murage.mobile.shell;

import static org.junit.Assert.*;

import org.junit.Test;

public class ChannelScriptTest {
    @Test
    public void injectsTheSavedOriginAsAJavaScriptString() {
        String script = ChannelScript.android("https://mac.tailnet123.ts.net:8444");
        assertTrue(script.contains("location.origin !== \"https:"));
        assertTrue(script.contains("mac.tailnet123.ts.net:8444\""));
        assertFalse(script.contains("__ORIGIN__"));
        assertTrue(script.contains("window !== window.top"));
        assertNotEquals("murageNative", ChannelScript.PORT);
    }

    /** M6: the origin check runs inside the event script; values fill their slots once, never as slots. */
    @Test
    public void eventScriptChecksTheOriginInsideAndFillsEachSlotOnce() throws Exception {
        org.json.JSONObject detail = new org.json.JSONObject().put("threadId", "__NAME__ __ORIGIN__");
        String script = ChannelScript.emit("notificationOpened", detail, "https://mac.tailnet123.ts.net:8444");
        assertTrue(script.startsWith("(function(){if(location.origin!==\"https:"));
        assertTrue(script.contains("mac.tailnet123.ts.net:8444\")return false;"));
        assertTrue(script.contains("f(\"notificationOpened\",{\"threadId\":\"__NAME__ __ORIGIN__\"})===true"));
        assertTrue(ChannelScript.emit("pause", null, "https://mac.tailnet123.ts.net").contains("f(\"pause\",null)===true"));
    }
}
