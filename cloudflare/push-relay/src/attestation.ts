// Spec §3.5 "Only genuine app installs can create bindings". One interface,
// two real verifiers, and fakes in the tests. A verifier never throws and never
// logs: every failure is { ok: false }, and which check failed is not reported.
import * as x509 from "@peculiar/x509";
import { decodeCbor } from "./cbor";
import { googleAccessToken, type ServiceAccount } from "./google";

x509.cryptoProvider.set(crypto);

export type Attestation = { kind: "app-attest"; keyId: string; attestationObject: string } | { kind: "play-integrity"; token: string };
export interface AttestInput { platform: "ios" | "android"; environment: "development" | "production"; challenge: string; attestation: Attestation }
export interface AttestationVerifier { verify(input: AttestInput): Promise<{ ok: true; attestKey?: string } | { ok: false }> }

const NO = { ok: false } as const;
const NONCE_OID = "1.2.840.113635.100.8.2";
const NONCE_PREFIX = new Uint8Array([0x30, 0x24, 0xa1, 0x22, 0x04, 0x20]);
const b64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const utf8 = (value: string) => new TextEncoder().encode(value);
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const concat = (a: Uint8Array, b: Uint8Array) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };
const aaguid = (value: string) => { const out = new Uint8Array(16); out.set(utf8(value)); return out; };
const AAGUID = { development: aaguid("appattestdevelop"), production: aaguid("appattest") };

/** The nonce extension is exactly SEQUENCE { [1] EXPLICIT OCTET STRING (32) }. */
function extensionNonce(der: Uint8Array): Uint8Array | null {
  return der.length === NONCE_PREFIX.length + 32 && equal(der.slice(0, NONCE_PREFIX.length), NONCE_PREFIX) ? der.slice(NONCE_PREFIX.length) : null;
}

const within = (cert: x509.X509Certificate, time: number) => cert.notBefore.getTime() < time && time < cert.notAfter.getTime();

export function createAppAttestVerifier(o: { teamId: string; bundleId: string; rootPem: string; now: () => number }): AttestationVerifier {
  const root = new x509.X509Certificate(o.rootPem);
  return {
    async verify(input) {
      if (input.platform !== "ios" || input.attestation.kind !== "app-attest") return NO;
      try {
        const object = decodeCbor(b64(input.attestation.attestationObject));
        if (!object || typeof object !== "object" || Array.isArray(object)) return NO;
        const { fmt, attStmt, authData } = object as { fmt?: unknown; attStmt?: unknown; authData?: unknown };
        if (fmt !== "apple-appattest" || !(authData instanceof Uint8Array) || !attStmt || typeof attStmt !== "object") return NO;
        const x5c = (attStmt as { x5c?: unknown }).x5c;
        if (!Array.isArray(x5c) || x5c.length !== 2 || !x5c.every((c) => c instanceof Uint8Array)) return NO;

        // 1. leaf <- intermediate <- the pinned root, each valid at now().
        const leaf = new x509.X509Certificate(x5c[0] as Uint8Array);
        const intermediate = new x509.X509Certificate(x5c[1] as Uint8Array);
        const date = new Date(o.now());
        if (!within(root, date.getTime())) return NO;
        if (intermediate.issuer !== root.subject || leaf.issuer !== intermediate.subject) return NO;
        if (!(await intermediate.verify({ publicKey: root.publicKey, date }))) return NO;
        if (!(await leaf.verify({ publicKey: intermediate.publicKey, date }))) return NO;

        // 2-4. nonce = SHA256(authData || SHA256(challenge)) is what the leaf carries.
        const nonce = await sha256(concat(authData, await sha256(utf8(input.challenge))));
        const ext = leaf.getExtension(NONCE_OID);
        const carried = ext ? extensionNonce(new Uint8Array(ext.value)) : null;
        if (!carried || !equal(carried, nonce)) return NO;

        // 5. keyId is SHA256 of the leaf's P-256 public key.
        const spki = new Uint8Array(leaf.publicKey.rawData);
        const leafKey = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
        const point = new Uint8Array((await crypto.subtle.exportKey("raw", leafKey)) as ArrayBuffer);
        const keyId = b64(input.attestation.keyId);
        if (!equal(await sha256(point), keyId)) return NO;

        // 6-9. authData: rpIdHash, flags, counter 0, aaguid for this environment, credentialId.
        if (authData.length < 55) return NO;
        if (!equal(authData.slice(0, 32), await sha256(utf8(`${o.teamId}.${o.bundleId}`)))) return NO;
        if ((authData[32] & 0x40) === 0) return NO;
        if (!equal(authData.slice(33, 37), new Uint8Array(4))) return NO;
        if (!equal(authData.slice(37, 53), AAGUID[input.environment])) return NO;
        const credentialLength = (authData[53] << 8) | authData[54];
        if (!equal(authData.slice(55, 55 + credentialLength), keyId)) return NO;
        return { ok: true, attestKey: btoa(String.fromCharCode(...spki)) };
      } catch {
        return NO;
      }
    },
  };
}

/** The same bytes, whatever base64 dress Google returns them in: it may add
 * padding or use the standard alphabet for a nonce sent as unpadded
 * base64url. Anything that doesn't decode never matches. */
function sameNonce(returned: unknown, challenge: string): boolean {
  if (typeof returned !== "string" || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(returned)) return false;
  const bytes = (text: string) => {
    const standard = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    try { return atob(standard + "=".repeat((4 - (standard.length % 4)) % 4)); } catch { return null; }
  };
  const a = bytes(returned), b = bytes(challenge);
  return a !== null && b !== null && a.length >= 16 && a === b;
}

/** Why a Play Integrity check said no: the step, and Google's verdict enums
 * or an HTTP status only, never the token, the nonce or a digest. */
const playRefused = (step: string, detail: Record<string, unknown> = {}) => {
  console.error("push-relay", JSON.stringify({ integrity: step, ...detail }));
  return NO;
};
const enumOf = (value: unknown) => (typeof value === "string" && ["PLAY_RECOGNIZED", "UNRECOGNIZED_VERSION", "UNEVALUATED", "MEETS_BASIC_INTEGRITY", "MEETS_DEVICE_INTEGRITY", "MEETS_STRONG_INTEGRITY", "MEETS_VIRTUAL_INTEGRITY", "DEVELOPMENT", "PRODUCTION"].includes(value) ? value : "unknown");

export function createPlayIntegrityVerifier(o: { packageName: string; serviceAccount: ServiceAccount; debugCertDigests: string[]; approval?: { releaseCertDigests: string[]; testerCertDigests: string[] }; fetch: typeof fetch; now: () => number }): AttestationVerifier {
  return {
    async verify(input) {
      if (input.platform !== "android" || input.attestation.kind !== "play-integrity") return NO;
      try {
        const access = await googleAccessToken(o.serviceAccount, "https://www.googleapis.com/auth/playintegrity", o.fetch, o.now);
        if (!access) return playRefused("no_access_token");
        const res = await o.fetch(`https://playintegrity.googleapis.com/v1/${o.packageName}:decodeIntegrityToken`, {
          method: "POST", redirect: "manual", headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
          body: JSON.stringify({ integrity_token: input.attestation.token }),
        });
        if (!res.ok) return playRefused("decode", { status: res.status });
        const payload = ((await res.json()) as { tokenPayloadExternal?: Record<string, Record<string, unknown> | undefined> } | null)?.tokenPayloadExternal;
        const request = payload?.requestDetails, app = payload?.appIntegrity, device = payload?.deviceIntegrity;
        if (!request || !app || !device) return playRefused("payload_shape");
        if (request.requestPackageName !== o.packageName) return playRefused("request_package");
        if (!sameNonce(request.nonce, input.challenge)) return playRefused("nonce");
        const issuedAt = typeof request.timestampMillis === "string" && /^\d+$/.test(request.timestampMillis) ? Number(request.timestampMillis) : NaN;
        if (!Number.isFinite(issuedAt) || Math.abs(o.now() - issuedAt) > 10 * 60_000) return playRefused("time");
        if (app.packageName !== o.packageName) return playRefused("app_package", { app: enumOf(app.appRecognitionVerdict) });
        const verdicts = Array.isArray(device.deviceRecognitionVerdict) ? device.deviceRecognitionVerdict : [];
        if (!verdicts.includes("MEETS_DEVICE_INTEGRITY")) return playRefused("device", { device: verdicts.map(enumOf) });
        const digests = Array.isArray(app.certificateSha256Digest) ? app.certificateSha256Digest : [];
        const recognized = app.appRecognitionVerdict === "PLAY_RECOGNIZED";
        const debugBuild = input.environment === "development" && app.appRecognitionVerdict === "UNRECOGNIZED_VERSION"
          && digests.some((d) => typeof d === "string" && o.debugCertDigests.includes(d));
        if (o.approval) {
          // Approval statements (decision 8): a repackaged build must never pass.
          // PLAY_RECOGNIZED with our release certificate, or a pinned tester certificate.
          const listed = (list: string[]) => digests.some((d) => typeof d === "string" && list.includes(d));
          if ((recognized && listed(o.approval.releaseCertDigests)) || listed(o.approval.testerCertDigests)) return { ok: true };
          return playRefused("approval", { app: enumOf(app.appRecognitionVerdict) });
        }
        if (recognized || debugBuild) return { ok: true };
        return playRefused("app", { app: enumOf(app.appRecognitionVerdict), environment: enumOf(String(input.environment).toUpperCase()),
          debugCertMatch: digests.some((d) => typeof d === "string" && o.debugCertDigests.includes(d)) });
      } catch {
        return playRefused("threw");
      }
    },
  };
}

export function combineVerifiers(ios: AttestationVerifier | null, android: AttestationVerifier | null): AttestationVerifier {
  return {
    verify: async (input) => {
      const chosen = input.platform === "ios" && input.attestation.kind === "app-attest" ? ios
        : input.platform === "android" && input.attestation.kind === "play-integrity" ? android : null;
      if (!chosen) return NO;
      try { return await chosen.verify(input); } catch { return NO; }
    },
  };
}
