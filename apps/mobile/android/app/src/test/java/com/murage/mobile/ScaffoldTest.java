package com.murage.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class ScaffoldTest {
    @Test
    public void buildsTheMurageApp() {
        assertEquals("com.murage.mobile", BuildConfig.APPLICATION_ID);
        assertEquals("1.0.9", BuildConfig.VERSION_NAME);
        assertEquals(10009, BuildConfig.VERSION_CODE);
    }
}
