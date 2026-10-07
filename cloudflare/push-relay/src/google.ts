// Google OAuth for a service account (RS256 JWT bearer), shared by FCM and
// Play Integrity. Carried over from the Codex relay's googleToken. Never
// throws and never logs: any failure is null.
import { base64url, sha256Hex } from "./http";

export interface ServiceAccount { client_email: string; private_key: string; project_id: string }
const OAUTH_URL = "https://oauth2.googleapis.com/token";
const cache = new Map<string, { value: string; expiresAt: number }>();

function pkcs8(pem: string): Uint8Array {
  const body = pem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replaceAll(/\s/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

export async function googleAccessToken(sa: ServiceAccount, scope: string, fetchImpl: typeof fetch, now: () => number): Promise<string | null> {
  return (await googleToken(sa, scope, fetchImpl, now))?.value ?? null;
}

/** The token with its expiry, so a caller can cache it beyond this isolate. */
export async function googleToken(sa: ServiceAccount, scope: string, fetchImpl: typeof fetch, now: () => number, signal?: AbortSignal): Promise<{ value: string; expiresAt: number } | null> {
  try {
    // Keyed by a digest of the key too, so a rotated key never reuses the old token.
    const key = `${sa.client_email}:${scope}:${await sha256Hex(sa.private_key)}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now() + 60_000) return cached;
    const iat = Math.floor(now() / 1000);
    const enc = (v: object) => base64url(new TextEncoder().encode(JSON.stringify(v)));
    const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.client_email, scope, aud: OAUTH_URL, iat, exp: iat + 3600 })}`;
    const signingKey = await crypto.subtle.importKey("pkcs8", pkcs8(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(input)));
    const res = await fetchImpl(OAUTH_URL, { method: "POST", redirect: "manual", signal, headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${input}.${base64url(signature)}` }).toString() });
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || !body.access_token || typeof body.expires_in !== "number") return null;
    const token = { value: body.access_token, expiresAt: now() + body.expires_in * 1000 };
    cache.set(key, token);
    return token;
  } catch {
    return null;
  }
}
