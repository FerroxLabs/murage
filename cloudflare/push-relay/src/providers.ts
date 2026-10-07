// Carried over from the Codex mobile-notification-providers.ts: the ES256
// APNs JWT cached encrypted in D1 (APNs refuses a new token more often than
// every 20 minutes, so it lives 30 and is re-minted early only once 20 old), the RS256 Google token, 16 KiB bounded provider reads,
// and the same result mapping. The request shapes are payloads.ts.
// Both provider credentials are cached in relay_provider_auth with their
// expiry, sealed under a key derived from the secret that made them, so the
// table alone never yields a usable token. Nothing here logs.
import type { RelayEvent } from "../../../shared/mobile-push";
import type { Db } from "./db";
import { googleToken, type ServiceAccount } from "./google";
import { base64url, fromBase64url, sha256Hex } from "./http";
import { apnsRequest, fcmMessage } from "./payloads";

/** `network` marks a send that never got an answer (connect failure,
 *  timeout, abort): the drain backs it off without using up the event. */
export type ProviderResult = "accepted" | "invalid-token" | "rejected" | { retryAfterMs: number; network?: true };
export interface Providers {
  send(device: { platform: "ios" | "android"; environment: "development" | "production"; push_token: string }, event: RelayEvent, deviceBadge: number, signal: AbortSignal): Promise<ProviderResult>;
}
interface ApnsKey { teamId: string; keyId: string; privateKey: string }

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** The first wait after an unanswered send; events.ts grows it from there. */
export const NETWORK_RETRY_MS = 2_000;

function pkcs8(pem: string): Uint8Array {
  return Uint8Array.from(atob(pem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replaceAll(/\s/g, "")), (c) => c.charCodeAt(0));
}
async function bounded(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 16_384) return null;
  try { return JSON.parse(text); } catch { return null; }
}
function discard<T>(response: Response, result: T): T {
  void response.body?.cancel().catch(() => {});
  return result;
}
function retry(response: Response, now: number): { retryAfterMs: number } {
  const raw = response.headers.get("retry-after");
  const specified = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : raw ? Date.parse(raw) - now : 0;
  return { retryAfterMs: Math.min(3_600_000, Math.max(60_000, Number.isFinite(specified) ? specified : 0)) };
}

export function createProviders(o: { apns: ApnsKey | null; fcm: ServiceAccount | null; bundleId: string; packageName: string; db: Db; fetch: typeof fetch; now: () => number }): Providers {
  const encoder = new TextEncoder();
  const sealKey = async (secret: string) =>
    crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", encoder.encode(secret)), "AES-GCM", false, ["encrypt", "decrypt"]);

  /** A cached credential still valid at `validAt`, or null (a row sealed under another key is a miss). */
  async function unseal(cacheKey: string, secret: string, validAt: number): Promise<string | null> {
    const row = await o.db.prepare("SELECT iv,ciphertext FROM relay_provider_auth WHERE cache_key=? AND expires_at>?").bind(cacheKey, validAt).first<{ iv: string; ciphertext: string }>();
    if (!row) return null;
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(row.iv), additionalData: encoder.encode(cacheKey) }, await sealKey(secret), fromBase64url(row.ciphertext));
      return new TextDecoder().decode(plain);
    } catch {
      return null;
    }
  }
  async function seal(cacheKey: string, secret: string, value: string, expiresAt: number): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(cacheKey) }, await sealKey(secret), encoder.encode(value)));
    await o.db.prepare("INSERT OR REPLACE INTO relay_provider_auth (cache_key,iv,ciphertext,expires_at) VALUES (?,?,?,?)").bind(cacheKey, base64url(iv), base64url(ciphertext), expiresAt).run();
  }

  // One JWT per APNs key, issued when minted and reused for 30 minutes
  // (Apple accepts up to 60, and refuses a new one more often than every 20).
  // The mint time is sealed with it, so a refusal can tell a token Apple
  // would let us replace from one it would answer with
  // TooManyProviderTokenUpdates.
  const APNS_JWT_TTL_MS = 1_800_000;
  const APNS_REMINT_GAP_MS = 1_200_000;
  const apnsCacheKey = async (key: ApnsKey) => `apns:${await sha256Hex(`${key.teamId}:${key.keyId}`)}`;
  async function cachedApnsJwt(key: ApnsKey, now: number): Promise<{ jwt: string; mintedAt: number } | null> {
    const sealed = await unseal(await apnsCacheKey(key), key.privateKey, now);
    if (!sealed) return null;
    try {
      const value = JSON.parse(sealed) as { jwt?: unknown; mintedAt?: unknown };
      return typeof value.jwt === "string" && typeof value.mintedAt === "number" ? { jwt: value.jwt, mintedAt: value.mintedAt } : null;
    } catch {
      return null;
    }
  }
  async function apnsJwt(key: ApnsKey): Promise<string> {
    const now = o.now();
    const cached = await cachedApnsJwt(key, now);
    if (cached) return cached.jwt;
    const enc = (v: object) => base64url(encoder.encode(JSON.stringify(v)));
    const input = `${enc({ alg: "ES256", kid: key.keyId })}.${enc({ iss: key.teamId, iat: Math.floor(now / 1000) })}`;
    const signing = await crypto.subtle.importKey("pkcs8", pkcs8(key.privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const jwt = `${input}.${base64url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signing, encoder.encode(input))))}`;
    await seal(await apnsCacheKey(key), key.privateKey, JSON.stringify({ jwt, mintedAt: now }), now + APNS_JWT_TTL_MS);
    return jwt;
  }
  /** Drop the cached JWT after Apple called it expired, but only once it is
   *  at least 20 minutes old: a younger one cannot be replaced yet, and a
   *  re-mint would only earn TooManyProviderTokenUpdates. A marker row also
   *  claims the slot in one statement, so isolates cannot pile up re-mints. */
  async function invalidateApnsJwt(key: ApnsKey): Promise<void> {
    const now = o.now();
    const cacheKey = await apnsCacheKey(key);
    const cached = await cachedApnsJwt(key, now);
    if (cached && now - cached.mintedAt < APNS_REMINT_GAP_MS) return;
    const claimed = await o.db.prepare(`INSERT INTO relay_provider_auth (cache_key,iv,ciphertext,expires_at) VALUES (?,'','',?)
      ON CONFLICT(cache_key) DO UPDATE SET expires_at=excluded.expires_at WHERE relay_provider_auth.expires_at<=?`)
      .bind(`apns-invalidated:${cacheKey}`, now + APNS_REMINT_GAP_MS, now).run();
    if (claimed.meta.changes) await o.db.prepare("DELETE FROM relay_provider_auth WHERE cache_key=?").bind(cacheKey).run();
  }

  async function fcmAccess(sa: ServiceAccount, signal: AbortSignal): Promise<string | null> {
    const now = o.now();
    const cacheKey = `fcm:${await sha256Hex(`${sa.client_email}\n${FCM_SCOPE}\n${await sha256Hex(sa.private_key)}`)}`;
    const cached = await unseal(cacheKey, sa.private_key, now + 60_000);
    if (cached) return cached;
    const token = await googleToken(sa, FCM_SCOPE, o.fetch, o.now, signal);
    if (!token) return null;
    await seal(cacheKey, sa.private_key, token.value, token.expiresAt);
    return token.value;
  }

  /** The provider call itself: no answer at all is a network retry. */
  async function post(url: string, init: RequestInit): Promise<Response | { retryAfterMs: number; network: true }> {
    try {
      return await o.fetch(url, { ...init, method: "POST", redirect: "manual" });
    } catch (error) {
      // The host and an allowlisted error kind only: never its message, which may
      // quote the URL, and an APNs path is /3/device/<push token>.
      const kind = error instanceof Error && ["Error", "TypeError", "AbortError", "TimeoutError"].includes(error.name) ? error.name : "unknown";
      console.error("push-relay", JSON.stringify({ unanswered: new URL(url).host, kind }));
      return { retryAfterMs: NETWORK_RETRY_MS, network: true };
    }
  }

  // A refusal ends the event, so say why: the provider's own error code
  // (allowlisted Apple reasons and FCM error codes), never arbitrary text.
  // The device is deleted on this answer, so say so: a build whose APNs
  // environment disagrees with its token would otherwise loop silently
  // (register, push, delete, register). Provider, status and a fixed reason
  // only; never the token.
  const invalidToken = (provider: "apns" | "fcm", status: number): "invalid-token" => {
    console.error("push-relay", JSON.stringify({ provider, status, reason: "invalid_token" }));
    return "invalid-token";
  };

  const refused = (provider: "apns" | "fcm", status: number, reason: unknown): "rejected" => {
    const reasons = ["expired", "BadCollapseId", "BadExpirationDate", "BadMessageId", "BadPriority", "BadTopic", "DeviceTokenNotForTopic", "DuplicateHeaders", "IdleTimeout", "MissingDeviceToken", "MissingTopic", "PayloadEmpty", "TopicDisallowed", "BadCertificate", "BadCertificateEnvironment", "Forbidden", "MissingProviderToken", "BadPath", "MethodNotAllowed", "PayloadTooLarge", "TooManyProviderTokenUpdates", "INVALID_ARGUMENT", "SENDER_ID_MISMATCH", "THIRD_PARTY_AUTH_ERROR", "UNSPECIFIED_ERROR"];
    const code = typeof reason === "string" && reasons.includes(reason) ? reason : "unknown";
    console.error("push-relay", JSON.stringify({ provider, status, reason: code }));
    return "rejected";
  };

  // A platform whose secret is missing or empty is a fault of this
  // deployment, not an answer about the event: hold the event (no attempt
  // spent, a minute apart) until the secret is fixed or the event expires,
  // and keep saying why.
  const notConfigured = (provider: "apns" | "fcm"): { retryAfterMs: number; network: true } => {
    console.error("push-relay", JSON.stringify({ provider, status: 0, reason: "not_configured" }));
    return { retryAfterMs: 60_000, network: true };
  };

  return {
    async send(device, event, deviceBadge, signal) {
      try {
        if (event.expiresAt <= o.now()) return refused(device.platform === "ios" ? "apns" : "fcm", 0, "expired");
        if (device.platform === "ios") {
          if (!o.apns) return notConfigured("apns");
          if (!/^[a-fA-F0-9]{64,200}$/.test(device.push_token)) return invalidToken("apns", 0);
          const request = apnsRequest(event, deviceBadge, device.push_token, o.bundleId);
          const origin = device.environment === "development" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
          const res = await post(origin + request.path, { signal,
            headers: { ...request.headers, authorization: `bearer ${await apnsJwt(o.apns)}`, "content-type": "application/json" }, body: JSON.stringify(request.body) });
          if (!(res instanceof Response)) return res;
          // Decided from the status first: a body cut off after a 200 must not become a retry and a second push.
          if (res.status === 200) return discard(res, "accepted");
          if (res.status === 429 || res.status >= 500) return discard(res, retry(res, o.now()));
          const body = (await bounded(res)) as { reason?: string } | null;
          if ((res.status === 410 && body?.reason === "Unregistered") || (res.status === 400 && body?.reason === "BadDeviceToken")) return invalidToken("apns", res.status);
          if (res.status === 403 && (body?.reason === "ExpiredProviderToken" || body?.reason === "InvalidProviderToken")) {
            // Clock skew: drop the cached JWT (age-gated) so a later try mints
            // a fresh one. InvalidProviderToken (a wrong or rotated key) is
            // not fixed by a new token from the same key, so it only retries.
            // Either way, retry against the budget rather than silently
            // losing the push.
            if (body.reason === "ExpiredProviderToken") await invalidateApnsJwt(o.apns);
            return { retryAfterMs: 60_000 };
          }
          return refused("apns", res.status, body?.reason);
        }
        if (!o.fcm) return notConfigured("fcm");
        const access = await fcmAccess(o.fcm, signal);
        if (!access) return { retryAfterMs: 60_000 };
        const res = await post(`https://fcm.googleapis.com/v1/projects/${o.fcm.project_id}/messages:send`, { signal,
          headers: { authorization: `Bearer ${access}`, "content-type": "application/json" }, body: JSON.stringify(fcmMessage(event, device.push_token, o.packageName, o.now())) });
        if (!(res instanceof Response)) return res;
        if (res.ok) return discard(res, "accepted");
        if (res.status === 429 || res.status >= 500) return discard(res, retry(res, o.now()));
        const body = (await bounded(res)) as { error?: { details?: Array<{ errorCode?: string }> } } | null;
        if (res.status === 404 && body?.error?.details?.some((d) => d.errorCode === "UNREGISTERED")) return invalidToken("fcm", res.status);
        return refused("fcm", res.status, body?.error?.details?.[0]?.errorCode);
      } catch {
        // A body cut off by the timeout is still an unanswered send; anything
        // else (a key that will not import, D1) retries against the budget.
        return signal.aborted ? { retryAfterMs: NETWORK_RETRY_MS, network: true } : { retryAfterMs: 60_000 };
      }
    },
  };
}
