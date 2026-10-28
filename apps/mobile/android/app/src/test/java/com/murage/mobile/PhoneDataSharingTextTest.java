package com.murage.mobile;

import static org.junit.Assert.*;
import org.junit.Test;

public class PhoneDataSharingTextTest {
    @Test public void newlinesAndControlsCannotExtendTheProviderLine() {
        String name = " \u00a0Acme\nAI\r\t\u0000\u0085\u2028\u2029 \u00a0";
        assertEquals("AcmeAI", PhoneDataSharingText.providerLine(name));
        assertEquals("Fixed warning.\n\nAcmeAI", PhoneDataSharingText.message("Fixed warning.", name));
    }

    @Test public void bidiOverridesAndOtherFormatCharactersAreRemoved() {
        String name = "\u200e\u200f\u202a\u202b\u202c\u202d\u202eAcme\u2066\u2067\u2068\u2069"
            + "\u00ad\u200b\u200d\ufeff\udb40\udc01";
        assertEquals("Acme", PhoneDataSharingText.providerLine(name));
        assertEquals("Fixed warning.\n\nAcme", PhoneDataSharingText.message("Fixed warning.", name));
    }

    @Test public void emptyNamesFallBackAndOrdinaryNamesStayPlain() {
        assertEquals("another AI service", PhoneDataSharingText.providerLine(" \n\u202e\u2069\u200b "));
        assertEquals("Fixed warning.\n\nanother AI service", PhoneDataSharingText.message("Fixed warning.", ""));
        assertEquals("Fixed warning.", PhoneDataSharingText.message("Fixed warning.", null));
        assertEquals("<b>Acme & AI</b>", PhoneDataSharingText.providerLine(" <b>Acme & AI</b> "));
    }
}
