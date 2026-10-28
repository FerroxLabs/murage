package com.murage.mobile.shell;

import static org.junit.Assert.*;
import java.net.URI;
import java.util.*;
import org.junit.Test;

public class ShareContentPolicyTest {
    @Test public void ownProviderIsRefusedByResolvedPackageIncludingAlternateAuthorities() throws Exception {
        for (String authority : Arrays.asList("com.murage.mobile.fileprovider", "another.authority", "0@another.authority")) {
            URI uri = new URI("content://" + authority + "/private-file");
            List<String> resolved = new ArrayList<>();
            try {
                ShareBody.externalStream(uri.getScheme(), uri.getAuthority(), "com.murage.mobile", value -> {
                    resolved.add(value); return "com.murage.mobile";
                });
                fail("own provider accepted");
            } catch (ShareBody.InputError refused) { assertEquals("share_type", refused.key); }
            assertEquals(Collections.singletonList(authority.replace("0@", "")), resolved);
        }
    }

    @Test public void externalProviderIsAcceptedRegardlessOfAuthoritySpelling() throws Exception {
        ShareBody.externalStream("content", "com.murage.mobile.lookalike", "com.murage.mobile", authority -> "other.app");
        ShareBody.externalStream("content", "missing.provider", "com.murage.mobile", authority -> null);
    }

    @Test public void nonContentAndMissingAuthoritiesAreRejectedBeforeResolution() throws Exception {
        for (String[] input : new String[][]{{"file", "/private-file"}, {null, null}, {"content", ""}, {"content", null}}) {
            try {
                ShareBody.externalStream(input[0], input[1], "com.murage.mobile", authority -> { throw new AssertionError("resolved invalid URI"); });
                fail("invalid stream accepted");
            } catch (ShareBody.InputError refused) { assertEquals("share_type", refused.key); }
        }
    }
}
