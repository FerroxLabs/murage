// SPDX-License-Identifier: AGPL-3.0-or-later
// A Murage Cloud member for worker tests: a Cloud account (keyed by a Supabase `sub`) and a real-shaped ES256 Supabase
// access token for it. The Cloud routes (/v1/account/*, /v1/billing/*, /v1/legal/quote, /v1/homes, /v1/homes/:id/pairing/*)
// take only this identity, never a Better Auth session (customer-identity.ts).
import { env } from "cloudflare:workers";
import { resolveCloudAccount } from "../src/cloud-accounts";

export const SUPABASE_ORIGIN = "https://testref.supabase.co";
export const supabaseEnv = { SUPABASE_URL: SUPABASE_ORIGIN, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_testkey_0123456789abcdef" };

const b64u = (b: ArrayBuffer | string) => Buffer.from(typeof b === "string" ? Buffer.from(b) : new Uint8Array(b)).toString("base64url");
let keys: Promise<CryptoKeyPair> | null = null;
const pair = () => (keys ??= crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>);

/** The project's JWKS, for createWorker's identity dependencies. */
export const jwksFetch = (async () => {
  const jwk = await crypto.subtle.exportKey("jwk", (await pair()).publicKey) as Record<string, unknown>;
  return Response.json({ keys: [{ ...jwk, kid: "ec-1", alg: "ES256", use: "sig" }] });
}) as typeof fetch;

/** Supabase Auth must not be asked in these tests: every token names the member's stored email. */
export const authFetch = (async () => { throw new Error("Supabase Auth must not be asked"); }) as typeof fetch;

/** `claims` overrides the token's claims (an aal2 step-up: aal, amr, mfa_factor_id). */
export async function supabaseToken(sub: string, email: string, claims: (s: number) => Record<string, unknown> = () => ({})) {
  const s = Math.floor(Date.now() / 1000);
  const c = { iss: `${SUPABASE_ORIGIN}/auth/v1`, aud: "authenticated", exp: s + 3600, iat: s - 5, sub, email, role: "authenticated",
    is_anonymous: false, app_metadata: { provider: "email", email_verified: true }, user_metadata: {}, session_id: crypto.randomUUID(),
    aal: "aal1", amr: [{ method: "otp", timestamp: s - 60 }], ...claims(s) };
  const input = `${b64u(JSON.stringify({ alg: "ES256", kid: "ec-1", typ: "JWT" }))}.${b64u(JSON.stringify(c))}`;
  return `${input}.${b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, (await pair()).privateKey, new TextEncoder().encode(input)))}`;
}

/** The Cloud member with this email (same email, same member): their Supabase token and Cloud account id. */
export async function cloudMember(email: string) {
  const sub = `m-${email.replace(/[^\w-]/g, "-")}`;
  const s = Math.floor(Date.now() / 1000);
  const account = await resolveCloudAccount(env.DB, { sub, email, sessionId: "s", aal: "aal1", amr: [], mfaFactorId: null, exp: s + 3600, iat: s }, Date.now(),
    async () => { throw new Error("Supabase Auth must not be asked"); });
  return { token: await supabaseToken(sub, email), userId: account.id, sub };
}
