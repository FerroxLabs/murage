package com.murage.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class ScaffoldTest {
    @Test
    public void buildsTheMurageApp() {
        assertEquals("com.murage.mobile", BuildConfig.APPLICATION_ID);
        assertEquals("1.0.0", BuildConfig.VERSION_NAME);
    }
}
