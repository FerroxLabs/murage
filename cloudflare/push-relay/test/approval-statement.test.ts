import { describe, expect, it, vi } from "vitest";
import vector from "./fixtures/approval-statement-vector.json";
import { APPROVAL_STATEMENT_TTL_MS, approvalBindingNonce, loadStatementKey, signStatement } from "../src/approval-statement";
import { createPlayIntegrityVerifier } from "../src/attestation";
import { LIMITS } from "../src/limits";
import type { AttestInput } from "../src/attestation";
import { relayUnderTest } from "./relay-harness";

const testKey = () => loadStatementKey(JSON.stringify({ kid: vector.testKid, pkcs8: Buffer.from(vector.testPkcs8, "base64url").toString("base64") }));
const decode = (statement: string) => {
  const [payload, sig] = statement.split(".");
  return { lines: Buffer.from(payload, "base64url").toString("utf8").split("\n"), payload: Buffer.from(payload, "base64url"), sig: Buffer.from(sig, "base64url") };
};
async function setup(verdict: { ok: boolean } = { ok: true }, key: "test" | "none" = "test") {
  const seen: AttestInput[] = [];
  const statementKey = key === "test" ? testKey : async () => null;
  const t = relayUnderTest({ verifier: { verify: async () => ({ ok: false }) }, approvalVerifier: { verify: async (i) => { seen.push(i); return verdict.ok ? { ok: true } : { ok: false }; } }, statementKey, now: () => vector.issuedAt });
  const challenge = async () => ((await (await t.call("POST", "/v1/challenges")).json()) as { challenge: string }).challenge;
  const ask = async (over: Record<string, unknown> = {}) => t.call("POST", "/v1/approval-keys", {
    platform: "ios", environment: "production", challenge: await challenge(), installId: vector.installId, approvalKey: vector.approvalKey,
    attestation: { kind: "app-attest", keyId: "k", attestationObject: "o" }, ...over,
  });
  return { t, seen, ask, challenge };
}

describe("the approval-key binding", () => {
  it("matches the golden vector", async () => {
    expect(await approvalBindingNonce(vector.challenge, vector.installId, vector.keyHash)).toBe(vector.bindingNonce);
  });
});

describe("POST /v1/approval-keys", () => {
  it("verifies the attestation over the binding nonce, not the bare challenge", async () => {
    const { seen, t } = await setup();
    const challenge = ((await (await t.call("POST", "/v1/challenges")).json()) as { challenge: string }).challenge;
    const res = await t.call("POST", "/v1/approval-keys", { platform: "ios", environment: "production", challenge, installId: vector.installId, approvalKey: vector.approvalKey, attestation: { kind: "app-attest", keyId: "k", attestationObject: "o" } });
    expect(res.status).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0].challenge).toBe(await approvalBindingNonce(challenge, vector.installId, vector.keyHash));
    expect(seen[0].challenge).not.toBe(challenge);
  });

  it("returns a statement the pinned public key verifies, naming install, key hash and a ten-minute expiry", async () => {
    const { ask } = await setup();
    const body = (await (await ask()).json()) as { statement: string; expiresAt: number };
    const { lines, payload, sig } = decode(body.statement);
    expect(lines).toEqual(["murage-approval-attestation/1", vector.testKid, "ios", "production", vector.installId, vector.keyHash, String(vector.issuedAt), String(vector.issuedAt + APPROVAL_STATEMENT_TTL_MS)]);
    expect(body.expiresAt).toBe(vector.issuedAt + 600_000);
    const pub = await crypto.subtle.importKey("raw", Buffer.from(vector.testPublicKey, "base64url"), { name: "Ed25519" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "Ed25519" }, pub, sig, payload)).toBe(true);
  });

  it("signs exactly the golden statement for the golden inputs (Ed25519 is deterministic)", async () => {
    const key = await testKey();
    expect(key).not.toBeNull();
    expect(await signStatement(key!, { platform: "ios", environment: "production", installId: vector.installId, keyHash: vector.keyHash, issuedAt: vector.issuedAt })).toBe(vector.statement);
  });

  it("refuses a failed attestation and spends the challenge anyway", async () => {
    const { ask, t } = await setup({ ok: false });
    const challenge = ((await (await t.call("POST", "/v1/challenges")).json()) as { challenge: string }).challenge;
    expect((await ask({ challenge })).status).toBe(403);
    const again = await t.call("POST", "/v1/devices", { platform: "ios", environment: "production", pushToken: "a".repeat(64), challenge, attestation: { kind: "app-attest", keyId: "k", attestationObject: "o" } });
    expect(await again.json()).toEqual({ error: "challenge_unavailable" });
  });

  it("uses only the approval verifier: the registration verifier's yes does not count", async () => {
    const t = relayUnderTest({ verifier: { verify: async () => ({ ok: true }) }, approvalVerifier: { verify: async () => ({ ok: false }) }, statementKey: testKey, now: () => vector.issuedAt });
    const challenge = ((await (await t.call("POST", "/v1/challenges")).json()) as { challenge: string }).challenge;
    const res = await t.call("POST", "/v1/approval-keys", { platform: "ios", environment: "production", challenge, installId: vector.installId, approvalKey: vector.approvalKey, attestation: { kind: "app-attest", keyId: "k", attestationObject: "o" } });
    expect(res.status).toBe(403);
  });

  it("uses only the approval verifier: its yes counts even when the registration verifier says no", async () => {
    const { ask } = await setup();
    expect((await ask()).status).toBe(201);
  });

  it("says statement_unavailable when no approval verifier is configured, even with a registration verifier", async () => {
    const t = relayUnderTest({ verifier: { verify: async () => ({ ok: true }) }, statementKey: testKey, now: () => vector.issuedAt });
    const challenge = ((await (await t.call("POST", "/v1/challenges")).json()) as { challenge: string }).challenge;
    const res = await t.call("POST", "/v1/approval-keys", { platform: "ios", environment: "production", challenge, installId: vector.installId, approvalKey: vector.approvalKey, attestation: { kind: "app-attest", keyId: "k", attestationObject: "o" } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "statement_unavailable" });
  });

  it("refuses an unknown or reused challenge before verifying", async () => {
    const { ask, seen } = await setup();
    expect((await ask({ challenge: "z".repeat(43) })).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("refuses a key that is not an uncompressed P-256 point on the curve, and a bad install id", async () => {
    const { ask, seen } = await setup();
    const offCurve = Buffer.from(vector.approvalKey, "base64url"); offCurve[64] ^= 1;
    for (const over of [{ approvalKey: "A".repeat(87) }, { approvalKey: offCurve.toString("base64url") }, { approvalKey: vector.approvalKey + "=" }, { installId: "short" }, { installId: "has space in it 0123" }, { extra: 1 }]) {
      expect((await ask(over)).status).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it("answers 400 to a POST with no body, in the usual error shape", async () => {
    const { t } = await setup();
    const res = await t.call("POST", "/v1/approval-keys");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("says statement_unavailable, and spends no challenge, when no signing key is configured", async () => {
    const { ask, seen } = await setup({ ok: true }, "none");
    const res = await ask();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "statement_unavailable" });
    expect(seen).toHaveLength(0);
  });

  it("writes nothing to D1 but the challenge it spends and its rate counters", async () => {
    const { ask, t } = await setup();
    expect((await ask()).status).toBe(201);
    const tables = (await t.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all<{ name: string }>()).results.map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["relay_devices", "relay_bindings", "relay_challenges", "relay_counters"]));
    for (const name of tables.filter((n) => n !== "relay_challenges" && n !== "relay_counters")) {
      expect(await t.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).first(), name).toEqual({ n: 0 });
    }
    expect(await t.db.prepare("SELECT COUNT(*) AS n FROM relay_challenges").first()).toEqual({ n: 0 });
  });

  it("is limited per IP", async () => {
    const { ask } = await setup();
    for (let i = 0; i < LIMITS.approvalStatementsPerIpHour; i++) expect((await ask({ installId: `install-${String(i).padStart(16, "0")}` })).status).toBe(201);
    expect((await ask({ installId: "install-ffffffffffffffff" })).status).toBe(429);
  });

  it("is limited per install", async () => {
    const { ask } = await setup();
    for (let i = 0; i < LIMITS.approvalStatementsPerInstallHour; i++) expect((await ask()).status).toBe(201);
    expect((await ask()).status).toBe(429);
    expect((await ask({ installId: "install-another-0123456" })).status).toBe(201);
  });
});

describe("Android approval attestation", () => {
  const NOW = 1_790_000_000_000;
  const RELEASE = "release-digest", TESTER = "tester-digest";
  async function serviceAccount() {
    const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey) as ArrayBuffer).toString("base64");
    return { client_email: "relay@murage-test.iam.gserviceaccount.com", project_id: "murage-test", private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----` };
  }
  const NONCE = "n".repeat(43);
  const verdict = (app: Record<string, unknown>) => ({ tokenPayloadExternal: {
    requestDetails: { requestPackageName: "com.murage.mobile", nonce: NONCE, timestampMillis: String(NOW - 1000) },
    appIntegrity: { packageName: "com.murage.mobile", ...app },
    deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
  } });
  const verifierFor = async (decoded: unknown, approval: { releaseCertDigests: string[]; testerCertDigests: string[] } = { releaseCertDigests: [RELEASE], testerCertDigests: [TESTER] }) => {
    const fetch = vi.fn(async (url: string) => url.startsWith("https://oauth2.googleapis.com/")
      ? new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600, token_type: "Bearer" })) : new Response(JSON.stringify(decoded)));
    return createPlayIntegrityVerifier({ packageName: "com.murage.mobile", serviceAccount: await serviceAccount(), debugCertDigests: ["debug-digest"], approval, fetch: fetch as unknown as typeof globalThis.fetch, now: () => NOW });
  };
  const input = (environment: "development" | "production" = "production"): AttestInput => ({ platform: "android", environment, challenge: NONCE, attestation: { kind: "play-integrity", token: "t" } });

  it("accepts PLAY_RECOGNIZED with the release certificate", async () => {
    const v = await verifierFor(verdict({ appRecognitionVerdict: "PLAY_RECOGNIZED", certificateSha256Digest: [RELEASE] }));
    expect((await v.verify(input())).ok).toBe(true);
  });
  it("accepts a certificate on the tester list, recognized or not", async () => {
    for (const recognition of ["UNRECOGNIZED_VERSION", "PLAY_RECOGNIZED"]) {
      const v = await verifierFor(verdict({ appRecognitionVerdict: recognition, certificateSha256Digest: [TESTER] }));
      expect((await v.verify(input())).ok, recognition).toBe(true);
    }
  });
  it("refuses a repackaged app: an unrecognized version, or a recognized one with a foreign certificate", async () => {
    for (const app of [
      { appRecognitionVerdict: "UNRECOGNIZED_VERSION", certificateSha256Digest: ["someone-else"] },
      { appRecognitionVerdict: "UNRECOGNIZED_VERSION", certificateSha256Digest: [RELEASE] },
      { appRecognitionVerdict: "PLAY_RECOGNIZED", certificateSha256Digest: ["someone-else"] },
      { appRecognitionVerdict: "PLAY_RECOGNIZED", certificateSha256Digest: [] },
      { appRecognitionVerdict: "PLAY_RECOGNIZED" },
      { appRecognitionVerdict: "UNRECOGNIZED_VERSION", certificateSha256Digest: ["debug-digest"] },
    ]) {
      const v = await verifierFor(verdict(app));
      expect((await v.verify(input("development"))).ok, JSON.stringify(app)).toBe(false);
    }
  });
  it("refuses a tester certificate without device integrity, with another nonce, or with a stale token", async () => {
    const tester = { appRecognitionVerdict: "UNRECOGNIZED_VERSION", certificateSha256Digest: [TESTER] };
    const base = verdict(tester).tokenPayloadExternal;
    for (const bad of [
      { tokenPayloadExternal: { ...base, deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"] } } },
      { tokenPayloadExternal: { ...base, requestDetails: { ...base.requestDetails, nonce: "x".repeat(43) } } },
      { tokenPayloadExternal: { ...base, requestDetails: { ...base.requestDetails, timestampMillis: String(NOW - 11 * 60_000) } } },
    ]) expect((await (await verifierFor(bad)).verify(input())).ok).toBe(false);
  });
  it("refuses everything when no release certificate is configured, except the tester list", async () => {
    const v = await verifierFor(verdict({ appRecognitionVerdict: "PLAY_RECOGNIZED", certificateSha256Digest: [RELEASE] }), { releaseCertDigests: [], testerCertDigests: [] });
    expect((await v.verify(input())).ok).toBe(false);
  });
  it("refuses another package even with a listed certificate", async () => {
    const v = await verifierFor(verdict({ appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: "com.evil.app", certificateSha256Digest: [RELEASE] }));
    expect((await v.verify(input())).ok).toBe(false);
  });
});
