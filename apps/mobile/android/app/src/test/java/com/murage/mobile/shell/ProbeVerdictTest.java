package com.murage.mobile.shell;

import static org.junit.Assert.*;

import java.net.SocketTimeoutException;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLProtocolException;
import org.junit.Test;

public class ProbeVerdictTest {
    @Test public void gatewayErrorsAreNotNetworkFailures() {
        // A 401 on /healthz is an older desktop door, so it asks for an update.
        assertEquals("basic", ProbeVerdict.classify(401, null, null).mode());
        for (int status : new int[] {502, 503, 504}) assertEquals("hosterror", ProbeVerdict.classify(status, null, null).mode());
        assertEquals("unreachable", ProbeVerdict.classify(null, null, new SSLProtocolException("bad record")).mode());
    }

    @Test public void hostCapabilityComesFromMobileFeatures() {
        ProbeVerdict ok = ProbeVerdict.classify(200, "{\"ok\":true,\"name\":\"Sean's Mac\",\"mobile\":1,\"mobileFeatures\":1,\"approvalProof\":1}", null);
        assertTrue(ok.isFull());
        assertTrue(ok.hostCapabilityOk());
        assertEquals(Long.valueOf(1), ok.hostCapability);
        assertTrue(ProbeVerdict.classify(200, "{\"mobile\":1,\"mobileFeatures\":2}", null).hostCapabilityOk());
        ProbeVerdict bare = ProbeVerdict.classify(200, "{\"mobile\":1}", null);
        assertTrue(bare.isFull());
        assertFalse(bare.hostCapabilityOk());
        assertFalse(ProbeVerdict.classify(200, "{\"mobile\":1,\"mobileFeatures\":0}", null).hostCapabilityOk());
        for (String value : new String[] {"null", "\"1\"", "1.5", "true", "[]", "{}"}) {
            ProbeVerdict verdict = ProbeVerdict.classify(200, "{\"mobile\":1,\"mobileFeatures\":" + value + "}", null);
            assertTrue(value, verdict.isFull());
            assertNull(value, verdict.hostCapability);
            assertFalse(value, verdict.hostCapabilityOk());
        }
        ProbeVerdict newer = ProbeVerdict.classify(200, "{\"mobile\":2,\"mobileFeatures\":1}", null);
        assertEquals(ProbeVerdict.Kind.BASIC, newer.kind);
        assertFalse(newer.hostCapabilityOk());
        assertNull(ProbeVerdict.classify(401, "{\"mobile\":1,\"mobileFeatures\":1}", null).hostCapability);
    }

    @Test public void thisDoorIsFullMode() {
        ProbeVerdict verdict = ProbeVerdict.classify(200, "{\"ok\":true,\"name\":\"Sean's Mac\",\"mobile\":1}", null);
        assertEquals(ProbeVerdict.Kind.FULL, verdict.kind);
        assertEquals("Sean's Mac", verdict.name);
        assertEquals("full", verdict.mode());
        assertTrue(verdict.isFull());
        assertNull(ProbeVerdict.classify(200, "{\"mobile\":1}", null).name);
        assertEquals(200, ProbeVerdict.classify(200, "{\"mobile\":1,\"name\":\"" + "n".repeat(300) + "\"}", null).name.length());
    }

    @Test public void anyOtherAnswerIsBasicMode() {
        assertEquals(ProbeVerdict.Kind.BASIC, ProbeVerdict.classify(401, null, null).kind);
        assertEquals(ProbeVerdict.Kind.BASIC, ProbeVerdict.classify(404, null, null).kind);
        assertEquals(ProbeVerdict.Kind.BASIC, ProbeVerdict.classify(200, "{\"ok\":true}", null).kind);
        assertEquals(ProbeVerdict.Kind.BASIC, ProbeVerdict.classify(200, "{\"mobile\":\"1\"}", null).kind);
        assertEquals(ProbeVerdict.Kind.BASIC, ProbeVerdict.classify(200, "<html>", null).kind);
    }

    @Test public void gatewayErrorsMeanMurageIsNotAnswering() {
        for (int status : new int[] {502, 503, 504}) assertEquals(ProbeVerdict.Kind.HOSTERROR, ProbeVerdict.classify(status, null, null).kind);
    }

    @Test public void noAnswerIsUnreachableOrInsecure() {
        assertEquals(ProbeVerdict.Kind.UNREACHABLE, ProbeVerdict.classify(null, null, new SocketTimeoutException()).kind);
        assertEquals(ProbeVerdict.Kind.INSECURE, ProbeVerdict.classify(null, null, new SSLHandshakeException("untrusted")).kind);
        assertEquals("unreachable", ProbeVerdict.classify(null, null, null).mode());
        assertEquals(ProbeVerdict.Kind.INSECURE, ProbeVerdict.classify(null, null, new SSLPeerUnverifiedException("no peer")).kind);
        // Only a refused certificate or handshake is an HTTPS problem; a reset or bad record is a network failure and retries.
        assertEquals(ProbeVerdict.Kind.UNREACHABLE, ProbeVerdict.classify(null, null, new SSLException("connection reset")).kind);
        assertEquals(ProbeVerdict.Kind.UNREACHABLE, ProbeVerdict.classify(null, null, new SSLProtocolException("bad record")).kind);
        assertEquals(ProbeVerdict.Kind.UNREACHABLE, ProbeVerdict.classify(null, null, new SSLException("Connection reset", new java.net.SocketException("reset"))).kind);
    }

    /** mobile is a door identity: full mode only when it is exactly the integer 1. */
    @Test public void mobileMustBeAnInteger() {
        assertEquals(ProbeVerdict.Kind.BASIC, ProbeVerdict.classify(200, "{\"mobile\":1.0}", null).kind);
        assertEquals(ProbeVerdict.Kind.BASIC, ProbeVerdict.classify(200, "{\"mobile\":2}", null).kind);
        assertEquals(ProbeVerdict.Kind.BASIC, ProbeVerdict.classify(200, "{\"mobile\":1.5}", null).kind);
        assertEquals(ProbeVerdict.Kind.BASIC, ProbeVerdict.classify(200, "{\"mobile\":0}", null).kind);
        assertEquals(ProbeVerdict.Kind.BASIC, ProbeVerdict.classify(200, "{}", null).kind);
        assertEquals(ProbeVerdict.Kind.FULL, ProbeVerdict.classify(200, "{\"mobile\":1}", null).kind);
    }

    @Test public void onlyAUsefulNameIsKept() {
        assertNull(ProbeVerdict.classify(200, "{\"mobile\":1,\"name\":\"\"}", null).name);
        assertNull(ProbeVerdict.classify(200, "{\"mobile\":1,\"name\":7}", null).name);
        assertNull(ProbeVerdict.classify(200, "{\"mobile\":1,\"name\":null}", null).name);
        assertEquals(ProbeVerdict.Kind.BASIC, ProbeVerdict.classify(200, "{\"mobile\":true}", null).kind);
        assertEquals(ProbeVerdict.Kind.BASIC, ProbeVerdict.classify(200, "[1]", null).kind);
        assertEquals(ProbeVerdict.Kind.BASIC, ProbeVerdict.classify(200, null, null).kind);
    }

    /** 200 code points, never half an emoji (Swift counts Characters; the two agree on these). */
    @Test public void theNameCutNeverSplitsASurrogatePair() {
        String face = "😀";
        String edge = "n".repeat(199) + face;
        assertEquals(edge, ProbeVerdict.classify(200, "{\"mobile\":1,\"name\":\"" + edge + "x\"}", null).name);
        assertEquals(face.repeat(200), ProbeVerdict.classify(200, "{\"mobile\":1,\"name\":\"" + face.repeat(300) + "\"}", null).name);
    }

    @Test public void theFourModes() {
        assertEquals("full", ProbeVerdict.classify(200, "{\"mobile\":1}", null).mode());
        assertEquals("basic", ProbeVerdict.classify(401, null, null).mode());
        assertEquals("hosterror", ProbeVerdict.classify(503, null, null).mode());
        assertEquals("insecure", ProbeVerdict.classify(null, null, new SSLHandshakeException("x")).mode());
        assertFalse(ProbeVerdict.classify(401, null, null).isFull());
    }

    @Test public void approvalProofIsReadOnlyAsAnInteger() {
        ProbeVerdict ok = ProbeVerdict.classify(200, "{\"ok\":true,\"mobile\":1,\"approvalProof\":1}", null);
        assertTrue(ok.approvalProofOk());
        assertEquals(Long.valueOf(1), ok.approvalProof);
        String[] bodies = {"{\"mobile\":1}", "{\"mobile\":1,\"approvalProof\":true}", "{\"mobile\":1,\"approvalProof\":1.0}", "{\"mobile\":1,\"approvalProof\":\"1\"}", "{\"mobile\":1,\"approvalProof\":0}"};
        for (String body : bodies) assertFalse(body, ProbeVerdict.classify(200, body, null).approvalProofOk());
    }
}
