package com.murage.mobile.shell;

import java.util.Locale;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLPeerUnverifiedException;
import org.json.JSONObject;

/** The launcher's GET /healthz (spec §3.1; Plan 1 B1). Twin of ProbeVerdict.swift. */
public final class ProbeVerdict {
    public enum Kind { FULL, BASIC, UNREACHABLE, INSECURE, ACCESSOFF, HOSTERROR }

    public final Kind kind;
    public final String name;
    public final Long hostCapability;
    public final Long approvalProof;

    private ProbeVerdict(Kind kind, String name) {
        this(kind, name, null);
    }

    private ProbeVerdict(Kind kind, String name, Long hostCapability) {
        this(kind, name, hostCapability, null);
    }

    private ProbeVerdict(Kind kind, String name, Long hostCapability, Long approvalProof) {
        this.hostCapability = hostCapability;
        this.approvalProof = approvalProof;
        this.kind = kind;
        this.name = name;
    }

    public static ProbeVerdict classify(Integer status, String body, Exception error) {
        if (status != null) {
            // A 401 on /healthz is an older desktop door that does not know the path
            // (companion/src/browser.ts), so it falls through to BASIC and the update screen.
            // ACCESSOFF stays defined for a future explicit access-off answer.
            // Decision 13: Tailscale Serve answering for a Murage that is not running.
            if (status == 502 || status == 503 || status == 504) return new ProbeVerdict(Kind.HOSTERROR, null);
            if (status != 200 || body == null) return new ProbeVerdict(Kind.BASIC, null);
            JSONObject json = Json.object(body);
            if (json == null) return new ProbeVerdict(Kind.BASIC, null);
            Object mobile = json.opt("mobile");
            // mobile is a door identity, exactly 1; the phone features come from mobileFeatures.
            if (!(mobile instanceof Integer || mobile instanceof Long) || ((Number) mobile).longValue() != 1) return new ProbeVerdict(Kind.BASIC, null);
            Object features = json.opt("mobileFeatures");
            Long hostCapability = features instanceof Integer || features instanceof Long ? ((Number) features).longValue() : null;
            Object raw = json.opt("name");
            Object proof = json.opt("approvalProof");
            Long approvalProof = proof instanceof Integer || proof instanceof Long ? ((Number) proof).longValue() : null;
            return new ProbeVerdict(Kind.FULL, raw instanceof String ? WorkspaceBook.cleanName((String) raw) : null, hostCapability, approvalProof);
        }
        // Only a refused handshake or certificate gets HTTPS guidance (twin of NavigationFailure.isCertificate);
        // a reset or bad record is a network failure, so the automatic retry still applies.
        if (error instanceof SSLHandshakeException || error instanceof SSLPeerUnverifiedException) return new ProbeVerdict(Kind.INSECURE, null);
        return new ProbeVerdict(Kind.UNREACHABLE, null);
    }

    public boolean hostCapabilityOk() {
        return hostCapability != null && hostCapability >= 1;
    }

    /** The computer's /healthz says it keeps a phone's approval key (SEC-006). */
    public boolean approvalProofOk() {
        return approvalProof != null && approvalProof >= 1;
    }

    public String mode() {
        return kind.name().toLowerCase(Locale.ROOT);
    }

    public boolean isFull() {
        return kind == Kind.FULL;
    }
}
