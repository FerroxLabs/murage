import * as x509 from "@peculiar/x509";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { combineVerifiers, createAppAttestVerifier, createPlayIntegrityVerifier } from "../src/attestation";
import { APPLE_APP_ATTEST_ROOT_PEM } from "../src/apple-root";
import { encodeCbor } from "./cbor-encode";

x509.cryptoProvider.set(crypto);
const TEAM = "ABCDE12345";
const BUNDLE = "com.murage.mobile";
const CHALLENGE = "c".repeat(43);
const NOW = Date.parse("2026-09-27T12:00:00Z");
const DAY = 86_400_000;
const sha = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

// No verifier may log: tokens and attestation objects never reach a log line.
let logs: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => { logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m)); });
// A refusal may say which step failed, as a step name and Google's verdict
// enums only: never a token, an attestation object, a nonce or a digest.
const ALLOWED_LOG_KEYS = new Set(["integrity", "status", "app", "device", "environment", "debugCertMatch", "kind"]);
afterEach(() => {
  for (const spy of logs) {
    for (const call of spy.mock.calls) {
      expect(call[0]).toBe("push-relay");
      const line = JSON.parse(call[1] as string) as Record<string, unknown>;
      for (const key of Object.keys(line)) expect(ALLOWED_LOG_KEYS.has(key), key).toBe(true);
      expect(call[1] as string).not.toMatch(/[A-Za-z0-9_-]{24,}/);
    }
    spy.mockRestore();
  }
});

/** A chain shaped like Apple's: P-384 root and intermediate, P-256 leaf with
 *  the nonce extension 1.2.840.113635.100.8.2. */
async function appAttestFixture(o: { challenge?: string; teamId?: string; aaguid?: string; counter?: number; flags?: number; credentialId?: Uint8Array; coseKey?: boolean; nonceExt?: (good: Uint8Array) => Uint8Array } = {}) {
  const ec384 = { name: "ECDSA", namedCurve: "P-384", hash: "SHA-384" } as const;
  const rootKeys = await crypto.subtle.generateKey(ec384, true, ["sign", "verify"]) as CryptoKeyPair;
  const root = await x509.X509CertificateGenerator.createSelfSigned({ serialNumber: "01", name: "CN=Test App Attestation Root CA", notBefore: new Date(NOW - DAY), notAfter: new Date(NOW + DAY * 365), keys: rootKeys, signingAlgorithm: ec384, extensions: [new x509.BasicConstraintsExtension(true, 1, true)] });
  const intKeys = await crypto.subtle.generateKey(ec384, true, ["sign", "verify"]) as CryptoKeyPair;
  const intermediate = await x509.X509CertificateGenerator.create({ serialNumber: "02", subject: "CN=Test App Attestation CA 1", issuer: root.subject, notBefore: new Date(NOW - DAY), notAfter: new Date(NOW + DAY * 365), signingKey: rootKeys.privateKey, publicKey: intKeys.publicKey, signingAlgorithm: ec384, extensions: [new x509.BasicConstraintsExtension(true, 0, true)] });
  const leafKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const rawPoint = new Uint8Array((await crypto.subtle.exportKey("raw", leafKeys.publicKey)) as ArrayBuffer);
  const keyIdBytes = await sha(rawPoint);
  const rpIdHash = await sha(new TextEncoder().encode(`${o.teamId ?? TEAM}.${BUNDLE}`));
  const counter = new Uint8Array([0, 0, 0, o.counter ?? 0]);
  const aaguid = new TextEncoder().encode((o.aaguid ?? "appattest").padEnd(16, "\0"));
  const credentialId = o.credentialId ?? keyIdBytes;
  // Real App Attest authData ends with the credential's COSE EC2 public key
  // (kty 2, alg -7, crv 1, x, y) after the credentialId, as in WebAuthn.
  const cose = o.coseKey ? cat(new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), rawPoint.slice(1, 33), new Uint8Array([0x22, 0x58, 0x20]), rawPoint.slice(33)) : new Uint8Array();
  const authData = cat(rpIdHash, new Uint8Array([o.flags ?? 0x41]), counter, aaguid, new Uint8Array([0, credentialId.length]), credentialId, cose);
  const nonce = await sha(cat(authData, await sha(new TextEncoder().encode(o.challenge ?? CHALLENGE))));
  const goodExt = cat(new Uint8Array([0x30, 0x24, 0xa1, 0x22, 0x04, 0x20]), nonce);
  const nonceExt = o.nonceExt ? o.nonceExt(goodExt) : goodExt;
  const leaf = await x509.X509CertificateGenerator.create({ serialNumber: "03", subject: "CN=leaf", issuer: intermediate.subject, notBefore: new Date(NOW - DAY), notAfter: new Date(NOW + DAY), signingKey: intKeys.privateKey, publicKey: leafKeys.publicKey, signingAlgorithm: ec384, extensions: [new x509.Extension("1.2.840.113635.100.8.2", false, nonceExt)] });
  const parts = { x5c: [new Uint8Array(leaf.rawData), new Uint8Array(intermediate.rawData)], authData };
  const attestationObject = encodeCbor({ fmt: "apple-appattest", attStmt: { x5c: parts.x5c, receipt: new Uint8Array([1]) }, authData });
  return { rootPem: root.toString("pem"), keyId: b64(keyIdBytes), attestationObject: b64(attestationObject), rawObject: attestationObject, parts };
}

describe("App Attest", () => {
  const input = (f: { keyId: string; attestationObject: string }, environment: "development" | "production" = "production") =>
    ({ platform: "ios" as const, environment, challenge: CHALLENGE, attestation: { kind: "app-attest" as const, keyId: f.keyId, attestationObject: f.attestationObject } });
  const verifierFor = (rootPem: string, over: { bundleId?: string; now?: number } = {}) =>
    createAppAttestVerifier({ teamId: TEAM, bundleId: over.bundleId ?? BUNDLE, rootPem, now: () => over.now ?? NOW });

  it("accepts an attestation for this app, this challenge and this key", async () => {
    const f = await appAttestFixture();
    const result = await verifierFor(f.rootPem).verify(input(f));
    expect(result.ok).toBe(true);
    expect(result.ok && typeof result.attestKey).toBe("string");
  });
  it("accepts a development attestation only for a development registration", async () => {
    const f = await appAttestFixture({ aaguid: "appattestdevelop" });
    expect((await verifierFor(f.rootPem).verify(input(f, "development"))).ok).toBe(true);
    expect((await verifierFor(f.rootPem).verify(input(f, "production"))).ok).toBe(false);
    const prod = await appAttestFixture();
    expect((await verifierFor(prod.rootPem).verify(input(prod, "development"))).ok).toBe(false);
  });
  it("refuses another challenge, another app, the wrong environment and a used key", async () => {
    const cases = [
      await appAttestFixture({ challenge: "d".repeat(43) }),
      await appAttestFixture({ teamId: "ZZZZZ99999" }),
      await appAttestFixture({ aaguid: "appattestdevelop" }),
      await appAttestFixture({ counter: 1 }),
    ];
    for (const f of cases) expect((await verifierFor(f.rootPem).verify(input(f))).ok).toBe(false);
  });
  it("refuses another bundle id and another key id", async () => {
    const f = await appAttestFixture();
    expect((await verifierFor(f.rootPem, { bundleId: "com.murage.other" }).verify(input(f))).ok).toBe(false);
    const other = await appAttestFixture();
    expect((await verifierFor(f.rootPem).verify(input({ keyId: other.keyId, attestationObject: f.attestationObject }))).ok).toBe(false);
  });
  it("accepts authData that carries the COSE public key after the credentialId, as real devices send", async () => {
    const f = await appAttestFixture({ coseKey: true });
    expect(f.parts.authData.length).toBe(55 + 32 + 77);
    expect((await verifierFor(f.rootPem).verify(input(f))).ok).toBe(true);
  });
  it("refuses a credentialId that is not the key id", async () => {
    const wrong = new Uint8Array(32).fill(7);
    const f = await appAttestFixture({ credentialId: wrong });
    expect((await verifierFor(f.rootPem).verify(input(f))).ok).toBe(false);
    const short = await appAttestFixture({ credentialId: new Uint8Array(16) });
    expect((await verifierFor(short.rootPem).verify(input(short))).ok).toBe(false);
  });
  it("refuses authData without the attested credential data flag", async () => {
    const f = await appAttestFixture({ flags: 0x01 });
    expect((await verifierFor(f.rootPem).verify(input(f))).ok).toBe(false);
  });
  it("refuses a malformed nonce extension: another prefix, another length, a trailing byte", async () => {
    for (const nonceExt of [
      (good: Uint8Array) => cat(new Uint8Array([0x30, 0x24, 0xa2, 0x22, 0x04, 0x20]), good.slice(6)),
      (good: Uint8Array) => cat(new Uint8Array([0x30, 0x23, 0xa1, 0x21, 0x04, 0x1f]), good.slice(6, 37)),
      (good: Uint8Array) => cat(good, new Uint8Array([0x00])),
    ]) {
      const f = await appAttestFixture({ nonceExt });
      expect((await verifierFor(f.rootPem).verify(input(f))).ok).toBe(false);
    }
  });
  it("refuses a chain that does not end at the configured root", async () => {
    const f = await appAttestFixture();
    const other = await appAttestFixture();
    expect((await verifierFor(other.rootPem).verify(input(f))).ok).toBe(false);
    // A genuine intermediate beside a leaf it did not sign.
    const mixed = encodeCbor({ fmt: "apple-appattest", attStmt: { x5c: [f.parts.x5c[0], other.parts.x5c[1]], receipt: new Uint8Array([1]) }, authData: f.parts.authData });
    expect((await verifierFor(other.rootPem).verify(input({ keyId: f.keyId, attestationObject: b64(mixed) }))).ok).toBe(false);
    // The pinned root may not stand in the chain as the intermediate.
    const short = encodeCbor({ fmt: "apple-appattest", attStmt: { x5c: [f.parts.x5c[0]], receipt: new Uint8Array([1]) }, authData: f.parts.authData });
    expect((await verifierFor(f.rootPem).verify(input({ keyId: f.keyId, attestationObject: b64(short) }))).ok).toBe(false);
  });
  it("refuses an expired or not yet valid certificate, judged by the injected clock", async () => {
    const f = await appAttestFixture();
    expect((await verifierFor(f.rootPem, { now: NOW + 2 * DAY }).verify(input(f))).ok).toBe(false);
    expect((await verifierFor(f.rootPem, { now: NOW - 2 * DAY }).verify(input(f))).ok).toBe(false);
  });
  it("refuses trailing bytes after the attestation object, and another format", async () => {
    const f = await appAttestFixture();
    const trailing = b64(cat(f.rawObject, new Uint8Array([0x00])));
    expect((await verifierFor(f.rootPem).verify(input({ keyId: f.keyId, attestationObject: trailing }))).ok).toBe(false);
    const packed = encodeCbor({ fmt: "packed", attStmt: { x5c: f.parts.x5c, receipt: new Uint8Array([1]) }, authData: f.parts.authData });
    expect((await verifierFor(f.rootPem).verify(input({ keyId: f.keyId, attestationObject: b64(packed) }))).ok).toBe(false);
  });
  it("refuses garbage without throwing", async () => {
    const f = await appAttestFixture();
    const verifier = verifierFor(f.rootPem);
    expect((await verifier.verify(input({ keyId: "x", attestationObject: "not base64 cbor" }))).ok).toBe(false);
    expect((await verifier.verify(input({ keyId: f.keyId, attestationObject: b64(encodeCbor([1, 2])) }))).ok).toBe(false);
    expect((await verifier.verify(input({ keyId: f.keyId, attestationObject: b64(encodeCbor(null)) }))).ok).toBe(false);
  });
  it("ships Apple's real root, self-signed and pinned by fingerprint", async () => {
    const root = new x509.X509Certificate(APPLE_APP_ATTEST_ROOT_PEM);
    expect(root.subject).toContain("CN=Apple App Attestation Root CA");
    expect(root.issuer).toBe(root.subject);
    expect(await root.verify({ signatureOnly: true })).toBe(true);
    const fingerprint = [...new Uint8Array(await root.getThumbprint("SHA-256"))].map((b) => b.toString(16).padStart(2, "0")).join(":").toUpperCase();
    expect(fingerprint).toBe(APPLE_ROOT_SHA256);
  });
});

const APPLE_ROOT_SHA256 = "1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32";

describe("Play Integrity", () => {
  async function serviceAccount() {
    const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
    return { client_email: "relay@murage-test.iam.gserviceaccount.com", project_id: "murage-test", private_key: `-----BEGIN PRIVATE KEY-----\n${b64(pkcs8)}\n-----END PRIVATE KEY-----` };
  }
  const verdict = (over: Record<string, unknown> = {}) => ({
    tokenPayloadExternal: {
      requestDetails: { requestPackageName: "com.murage.mobile", nonce: CHALLENGE, timestampMillis: String(NOW - 1000) },
      appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: "com.murage.mobile", certificateSha256Digest: ["prod-digest"] },
      deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
      ...over,
    },
  });
  const fetchWith = (decoded: unknown) => vi.fn(async (url: string, _init?: RequestInit) =>
    url.startsWith("https://oauth2.googleapis.com/")
      ? new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600, token_type: "Bearer" }))
      : new Response(JSON.stringify(decoded)));
  const input = (environment: "development" | "production" = "production") =>
    ({ platform: "android" as const, environment, challenge: CHALLENGE, attestation: { kind: "play-integrity" as const, token: "integrity-token" } });
  const verifierWith = async (fetch: unknown, debugCertDigests: string[] = ["debug-digest"]) =>
    createPlayIntegrityVerifier({ packageName: "com.murage.mobile", serviceAccount: await serviceAccount(), debugCertDigests, fetch: fetch as typeof globalThis.fetch, now: () => NOW });

  it("accepts a Play-recognized app on a genuine device, for this challenge", async () => {
    const fetch = fetchWith(verdict());
    const v = createPlayIntegrityVerifier({ packageName: "com.murage.mobile", serviceAccount: await serviceAccount(), debugCertDigests: [], fetch: fetch as unknown as typeof globalThis.fetch, now: () => NOW });
    expect((await v.verify(input())).ok).toBe(true);
    expect(fetch.mock.calls[1][0]).toBe("https://playintegrity.googleapis.com/v1/com.murage.mobile:decodeIntegrityToken");
    const init = fetch.mock.calls[1][1]!;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer ya29.test");
    expect(JSON.parse(String(init.body))).toEqual({ integrity_token: "integrity-token" });
  });
  it("accepts the challenge's own bytes when Google returns them padded or in the standard alphabet (seen on a Samsung, 2026-09-27)", async () => {
    const challenge = "ab-_".repeat(11).slice(0, 43);
    const standard = challenge.replace(/-/g, "+").replace(/_/g, "/") + "=";
    for (const returned of [challenge, challenge + "=", standard]) {
      const v = await verifierWith(fetchWith(verdict({ requestDetails: { requestPackageName: "com.murage.mobile", nonce: returned, timestampMillis: String(NOW - 1000) } })));
      expect((await v.verify({ ...input(), challenge })).ok, returned).toBe(true);
    }
    for (const returned of ["ab-_".repeat(11).slice(1, 44), challenge.slice(0, 20), "not base64 !", 42]) {
      const v = await verifierWith(fetchWith(verdict({ requestDetails: { requestPackageName: "com.murage.mobile", nonce: returned, timestampMillis: String(NOW - 1000) } })));
      expect((await v.verify({ ...input(), challenge })).ok, String(returned)).toBe(false);
    }
  });
  it("refuses another nonce, a stale token, a failed device and an unrecognized app", async () => {
    for (const bad of [
      verdict({ requestDetails: { requestPackageName: "com.murage.mobile", nonce: "x".repeat(43), timestampMillis: String(NOW) } }),
      verdict({ requestDetails: { requestPackageName: "com.murage.mobile", nonce: CHALLENGE, timestampMillis: String(NOW - 11 * 60_000) } }),
      verdict({ deviceIntegrity: { deviceRecognitionVerdict: [] } }),
      verdict({ appIntegrity: { appRecognitionVerdict: "UNRECOGNIZED_VERSION", packageName: "com.murage.mobile", certificateSha256Digest: ["other"] } }),
    ]) expect((await (await verifierWith(fetchWith(bad))).verify(input())).ok).toBe(false);
  });
  it("refuses another package, a missing timestamp, a basic-only device and an unevaluated app", async () => {
    for (const bad of [
      verdict({ requestDetails: { requestPackageName: "com.evil.app", nonce: CHALLENGE, timestampMillis: String(NOW) } }),
      verdict({ appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: "com.evil.app", certificateSha256Digest: ["prod-digest"] } }),
      verdict({ requestDetails: { requestPackageName: "com.murage.mobile", nonce: CHALLENGE } }),
      verdict({ requestDetails: { requestPackageName: "com.murage.mobile", nonce: CHALLENGE, timestampMillis: "soon" } }),
      verdict({ deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY", "MEETS_VIRTUAL_INTEGRITY"] } }),
      verdict({ deviceIntegrity: {} }),
      verdict({ appIntegrity: { appRecognitionVerdict: "UNEVALUATED", packageName: "com.murage.mobile" } }),
      verdict({ appIntegrity: undefined }),
      {},
    ]) expect((await (await verifierWith(fetchWith(bad))).verify(input("development"))).ok).toBe(false);
  });
  it("accepts a sideloaded debug build only in development and only with a listed certificate", async () => {
    const debug = verdict({ appIntegrity: { appRecognitionVerdict: "UNRECOGNIZED_VERSION", packageName: "com.murage.mobile", certificateSha256Digest: ["debug-digest"] } });
    const v = await verifierWith(fetchWith(debug));
    expect((await v.verify(input("development"))).ok).toBe(true);
    expect((await v.verify(input("production"))).ok).toBe(false);
  });
  it("signs the OAuth JWT as Google expects: RS256, the service account, the scope, one hour", async () => {
    const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
    const sa = { client_email: "jwt@murage-test.iam.gserviceaccount.com", project_id: "murage-test", private_key: `-----BEGIN PRIVATE KEY-----\n${b64(pkcs8)}\n-----END PRIVATE KEY-----` };
    const fetch = fetchWith(verdict());
    const v = createPlayIntegrityVerifier({ packageName: "com.murage.mobile", serviceAccount: sa, debugCertDigests: [], fetch: fetch as unknown as typeof globalThis.fetch, now: () => NOW });
    expect((await v.verify(input())).ok).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(String(init!.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = form.get("assertion")!.split(".");
    const unb64url = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const text = (s: string) => JSON.parse(new TextDecoder().decode(unb64url(s)));
    expect(text(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const iat = Math.floor(NOW / 1000);
    expect(text(claims)).toEqual({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/playintegrity", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 });
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.publicKey, unb64url(signature), new TextEncoder().encode(`${header}.${claims}`))).toBe(true);
  });
  it("gives ok: false and never throws when Google fails", async () => {
    const throwing = vi.fn(async () => { throw new TypeError("network down"); });
    const oauth401 = vi.fn(async () => new Response("{}", { status: 401 }));
    const oauthJunk = vi.fn(async () => new Response("not json"));
    const decode500 = vi.fn(async (url: string) => url.startsWith("https://oauth2.googleapis.com/")
      ? new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 })) : new Response("{}", { status: 500 }));
    const decodeThrows = vi.fn(async (url: string) => { if (url.startsWith("https://oauth2.googleapis.com/")) return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 })); throw new TypeError("reset"); });
    for (const fetch of [throwing, oauth401, oauthJunk, decode500, decodeThrows]) {
      await expect((await verifierWith(fetch)).verify(input())).resolves.toEqual({ ok: false });
    }
  });
  it("refuses a bad service account key without throwing", async () => {
    const v = createPlayIntegrityVerifier({ packageName: "com.murage.mobile", serviceAccount: { client_email: "x@y", project_id: "p", private_key: "garbage" }, debugCertDigests: [], fetch: fetchWith(verdict()) as unknown as typeof fetch, now: () => NOW });
    await expect(v.verify(input())).resolves.toEqual({ ok: false });
  });
});

describe("combineVerifiers", () => {
  it("routes by platform and kind, and refuses a mismatch", async () => {
    const yes = { verify: async () => ({ ok: true as const }) };
    const v = combineVerifiers(yes, null);
    expect((await v.verify({ platform: "ios", environment: "production", challenge: CHALLENGE, attestation: { kind: "app-attest", keyId: "k", attestationObject: "a" } })).ok).toBe(true);
    expect((await v.verify({ platform: "android", environment: "production", challenge: CHALLENGE, attestation: { kind: "play-integrity", token: "t" } })).ok).toBe(false);
    expect((await v.verify({ platform: "ios", environment: "production", challenge: CHALLENGE, attestation: { kind: "play-integrity", token: "t" } })).ok).toBe(false);
    expect((await combineVerifiers(null, yes).verify({ platform: "android", environment: "production", challenge: CHALLENGE, attestation: { kind: "app-attest", keyId: "k", attestationObject: "a" } })).ok).toBe(false);
  });
});
