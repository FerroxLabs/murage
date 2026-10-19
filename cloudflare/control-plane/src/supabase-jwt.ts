// SPDX-License-Identifier: AGPL-3.0-or-later
// Supabase access-token verification for Cloud customers (the murage.ai members area, MakerKit on Supabase Auth).
// Asymmetric keys only: the token is checked against the project's published JWKS, so nothing the members-area
// server holds can mint an identity here. Contract: lanes/cloud-v2/makerkit/CONTRACT.md.
//   https://supabase.com/docs/guides/auth/signing-keys   (JWKS path, ES256, 10-minute edge cache)
//   https://supabase.com/docs/guides/auth/jwt-fields     (iss, aud, exp, sub, role, aal, amr, session_id, is_anonymous)

export interface SupabaseAuthConfig {
  /** The exact `iss`: https://<ref>.supabase.co/auth/v1. Supabase keeps the project-domain issuer even when a custom
   *  domain is active, so it is never derived from a custom domain. */
  issuer: string;
  /** Where the public keys are fetched: https://<ref>.supabase.co/auth/v1/.well-known/jwks.json unless configured. */
  jwksUrl: string;
  audience: string;
  /** A money or destructive action needs a second factor proved within this many seconds. */
  stepUpMaxAgeSeconds: number;
  /** amr methods that count as that proof. Supabase only raises a session to aal2 for MFA methods. */
  stepUpMethods: ReadonlySet<string>;
  /** Supabase Auth's "current user" endpoint (https://<ref>.supabase.co/auth/v1/user): the authority on the account's
   *  confirmed email when a token disagrees with the stored one (cloud-accounts.ts). */
  userUrl: string;
  /** The project's publishable (anon) key, sent as `apikey` to that endpoint. Public by design; never a secret key. */
  publishableKey: string;
}

export interface SupabaseClaims {
  sub: string;
  email: string;
  sessionId: string;
  aal: string;
  amr: { method: string; timestamp: number }[];
  /** The MFA factor that last verified this session (auth.sessions.factor_id), set server-side by the members area's
   *  Custom Access Token Hook as the top-level claim `mfa_factor_id`; null when absent or not a UUID. Step-up counts
   *  only a trusted factor (trusted-factors.ts, Astra SUPPORT5 P1 #2). */
  mfaFactorId: string | null;
  exp: number;
  iat: number;
}

export class TokenRejected extends Error {
  constructor(public reason: string) { super(reason); }
}
export class JwksUnavailable extends Error {}

/** ES256 only. RS256, HS256 (the legacy shared secret), "none" and anything else are refused before any key lookup. */
const ALLOWED_ALG = "ES256";
export const DEFAULT_STEPUP_MAX_AGE_SECONDS = 600;
/** TOTP and a WebAuthn MFA factor. Not "passkey": a Supabase passkey sign-in is a single factor and stays aal1
 *  (supabase/auth internal/models/amr.go IsAAL2Claim). Not SMS or recovery codes for money. */
export const DEFAULT_STEPUP_METHODS = ["totp", "mfa/webauthn"] as const;
const MAX_TOKEN_LENGTH = 8192;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CLOCK_SKEW_SECONDS = 30;
const JWKS_TTL_MS = 10 * 60_000;
const JWKS_MISS_REFETCH_MS = 60_000;
/** A response to a redirect: manual mode hands back the 3xx itself (or an opaque redirect, status 0, outside Workers). */
export const isRedirect = (res: Response) => res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);

/** One JWKS fetch may take this long; then it is a transport failure (503 identity_unavailable). */
export const JWKS_TIMEOUT_MS = 5_000;
/** After a failed fetch, no new attempt for this long: callers get 503 at once instead of piling onto a failing endpoint. */
export const JWKS_FAILURE_COOLDOWN_MS = 10_000;

function httpsUrl(value: string, originOnly: boolean): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
    if (originOnly) return u.pathname === "/" || u.pathname === "" ? u.origin : null;
    // Exactly as written (no trailing-slash or case normalisation): `iss` is compared byte for byte.
    return u.pathname.length > 1 && u.href === value ? value : null;
  } catch { return null; }
}

/** null: Supabase customer auth is not configured. Throws on a value that is set but invalid. */
export function readSupabaseAuthConfig(env: Env): SupabaseAuthConfig | null {
  const raw = env as unknown as Record<string, unknown>;
  const read = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string).trim() : "");
  const url = read("SUPABASE_URL");
  if (!url) return null;
  const origin = httpsUrl(url, true);
  if (!origin) throw new Error("SUPABASE_URL must be an https origin");
  // SUPABASE_URL is the project URL (https://<ref>.supabase.co), even with a custom domain: Supabase Auth keeps the
  // project-domain issuer then. A deployment that must fetch keys through the custom domain sets SUPABASE_JWKS_URL;
  // SUPABASE_JWT_ISSUER exists for an issuer Supabase documents differently. Both are trusted config, never token input.
  const issuer = read("SUPABASE_JWT_ISSUER") || `${origin}/auth/v1`;
  const jwksUrl = read("SUPABASE_JWKS_URL") || `${origin}/auth/v1/.well-known/jwks.json`;
  if (!httpsUrl(issuer, false)) throw new Error("SUPABASE_JWT_ISSUER must be an https URL with a path");
  if (!httpsUrl(jwksUrl, false)) throw new Error("SUPABASE_JWKS_URL must be an https URL with a path");
  const maxAge = read("CLOUD_STEPUP_MAX_AGE_SECONDS");
  const seconds = maxAge ? Number(maxAge) : DEFAULT_STEPUP_MAX_AGE_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600) throw new Error("CLOUD_STEPUP_MAX_AGE_SECONDS must be 60..3600");
  // Publishable key (sb_publishable_...) or the legacy anon JWT: public values. A secret or service_role key is refused
  // (it would let this Worker bypass row-level security, and it does not belong in a var).
  const publishableKey = read("SUPABASE_PUBLISHABLE_KEY");
  if (!/^[A-Za-z0-9._-]{20,2048}$/.test(publishableKey) || publishableKey.startsWith("sb_secret_") || jwtRole(publishableKey) === "service_role") {
    throw new Error("SUPABASE_PUBLISHABLE_KEY must be the project's publishable (anon) key");
  }
  return {
    issuer,
    jwksUrl,
    audience: read("SUPABASE_JWT_AUDIENCE") || "authenticated",
    stepUpMaxAgeSeconds: seconds,
    stepUpMethods: new Set(DEFAULT_STEPUP_METHODS),
    userUrl: `${origin}/auth/v1/user`,
    publishableKey,
  };
}

/** The `role` of a legacy JWT-shaped API key ("" when it is not one). */
function jwtRole(key: string): string {
  const parts = key.split(".");
  if (parts.length !== 3) return "";
  try { const role = (JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/") + "===".slice((parts[1].length + 3) % 4))) as { role?: unknown }).role; return typeof role === "string" ? role : ""; }
  catch { return ""; }
}

const b64uBytes = (s: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new TokenRejected("malformed");
  let bin: string;
  try { bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); } catch { throw new TokenRejected("malformed"); }
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64uJSON = (s: string): Record<string, unknown> => {
  let v: unknown;
  try { v = JSON.parse(new TextDecoder().decode(b64uBytes(s))); } catch (e) { if (e instanceof TokenRejected) throw e; throw new TokenRejected("malformed"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new TokenRejected("malformed");
  return v as Record<string, unknown>;
};

interface Jwk { kty?: unknown; kid?: unknown; alg?: unknown; use?: unknown; crv?: unknown; x?: unknown; y?: unknown; key_ops?: unknown }
interface CacheEntry { keys: Map<string, Jwk>; fetchedAt: number }

/** Per-worker-instance JWKS cache (one isolate in production; a fresh one per test worker). */
export class JwksCache {
  private entry: CacheEntry | null = null;
  private inflight: Promise<CacheEntry> | null = null;
  /** When the last fetch failed (any failure), kept apart from a successful refresh's fetchedAt. */
  private failedAt: number | null = null;
  constructor(private readonly fetcher: typeof fetch, private readonly now: () => number) {}

  /** Every failure (network error, timeout, HTTP status, body shape) is JwksUnavailable: fail closed, 503, retryable. */
  private async load(url: string): Promise<CacheEntry> {
    if (this.failedAt !== null && this.now() - this.failedAt < JWKS_FAILURE_COOLDOWN_MS) throw new JwksUnavailable("jwks cooling down");
    this.inflight ??= (async () => {
      try {
        let res: Response;
        // Fixed endpoint: a redirect is never followed (Astra MAKERKIT4 #5), it is a failure.
        try { res = await this.fetcher(url, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) }); }
        catch { throw new JwksUnavailable("jwks transport"); }
        if (isRedirect(res)) throw new JwksUnavailable(`jwks redirect ${res.status}`);
        if (!res.ok) throw new JwksUnavailable(`jwks ${res.status}`);
        const body = await res.json<{ keys?: unknown }>().catch(() => null);
        if (!body || !Array.isArray(body.keys)) throw new JwksUnavailable("jwks shape");
        const keys = new Map<string, Jwk>();
        for (const k of body.keys as Jwk[]) if (k && typeof k.kid === "string") keys.set(k.kid, k);
        this.entry = { keys, fetchedAt: this.now() };
        this.failedAt = null;
        return this.entry;
      } catch (e) {
        this.failedAt = this.now();
        throw e instanceof JwksUnavailable ? e : new JwksUnavailable("jwks");
      } finally { this.inflight = null; }
    })();
    return this.inflight;
  }

  async key(url: string, kid: string): Promise<Jwk | null> {
    const now = this.now();
    let entry = this.entry;
    if (!entry || now - entry.fetchedAt > JWKS_TTL_MS) entry = await this.load(url);
    const hit = entry.keys.get(kid);
    if (hit) return hit;
    // An unknown kid may be a key Supabase just rotated in; refetch, but not more than once a minute.
    if (now - entry.fetchedAt > JWKS_MISS_REFETCH_MS) return (await this.load(url)).keys.get(kid) ?? null;
    return null;
  }
}

async function importKey(jwk: Jwk): Promise<CryptoKey> {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new TokenRejected("key_mismatch");
  if (jwk.alg !== undefined && jwk.alg !== ALLOWED_ALG) throw new TokenRejected("key_mismatch");
  if (jwk.use !== undefined && jwk.use !== "sig") throw new TokenRejected("key_mismatch");
  if (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes("verify")) throw new TokenRejected("key_mismatch");
  try {
    return await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch { throw new TokenRejected("key_mismatch"); }
}

/** Verifies signature and every claim the control plane relies on. Throws TokenRejected(reason) or JwksUnavailable. */
export async function verifySupabaseToken(token: string, config: SupabaseAuthConfig, jwks: JwksCache, nowMs: number): Promise<SupabaseClaims> {
  if (token.length > MAX_TOKEN_LENGTH) throw new TokenRejected("malformed");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw new TokenRejected("malformed");
  const header = b64uJSON(parts[0]);
  // ES256 only: RS256, "none", HS256 (the legacy shared secret) and anything else are refused before any key lookup.
  if (header.alg !== ALLOWED_ALG) throw new TokenRejected("alg_not_allowed");
  if (header.crit !== undefined) throw new TokenRejected("malformed");
  if (typeof header.kid !== "string" || !header.kid) throw new TokenRejected("unknown_key");
  const jwk = await jwks.key(config.jwksUrl, header.kid);
  if (!jwk) throw new TokenRejected("unknown_key");
  const key = await importKey(jwk);
  const signature = b64uBytes(parts[2]);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, signed))) throw new TokenRejected("bad_signature");

  const c = b64uJSON(parts[1]);
  const now = Math.floor(nowMs / 1000);
  if (c.iss !== config.issuer) throw new TokenRejected("wrong_issuer");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(config.audience)) throw new TokenRejected("wrong_audience");
  if (typeof c.exp !== "number" || c.exp <= now) throw new TokenRejected("expired");
  if (typeof c.iat !== "number" || c.iat > now + CLOCK_SKEW_SECONDS) throw new TokenRejected("not_yet_valid");
  if (c.nbf !== undefined && (typeof c.nbf !== "number" || c.nbf > now + CLOCK_SKEW_SECONDS)) throw new TokenRejected("not_yet_valid");
  if (c.role !== "authenticated") throw new TokenRejected("wrong_role");
  if (c.is_anonymous === true) throw new TokenRejected("anonymous");
  if (typeof c.sub !== "string" || !/^[\w-]{1,128}$/.test(c.sub)) throw new TokenRejected("malformed");
  if (typeof c.session_id !== "string" || !/^[\w-]{1,128}$/.test(c.session_id)) throw new TokenRejected("malformed");
  if (typeof c.email !== "string" || c.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) throw new TokenRejected("no_email");
  // Never user_metadata.email_verified: the user can write user_metadata (auth.updateUser({ data })). app_metadata is
  // server-only; the members area's Custom Access Token Hook sets this from auth.users.email_confirmed_at.
  const appMeta = c.app_metadata as Record<string, unknown> | undefined;
  if (!appMeta || typeof appMeta !== "object" || appMeta.email_verified !== true) throw new TokenRejected("email_unverified");
  if (typeof c.aal !== "string") throw new TokenRejected("malformed");
  const amr = Array.isArray(c.amr)
    ? (c.amr as unknown[]).flatMap((e) => {
      const m = e as { method?: unknown; timestamp?: unknown } | null;
      return m && typeof m.method === "string" && typeof m.timestamp === "number" ? [{ method: m.method, timestamp: m.timestamp }] : [];
    })
    : [];
  const mfaFactorId = typeof c.mfa_factor_id === "string" && UUID_RE.test(c.mfa_factor_id) ? c.mfa_factor_id.toLowerCase() : null;
  return { sub: c.sub, email: c.email.toLowerCase(), sessionId: c.session_id, aal: c.aal, amr, mfaFactorId, exp: c.exp, iat: c.iat };
}

/** Why a money route refused, for the members area (body of 403 step_up_required; CONTRACT.md section 3):
 *  - "aal1": this session has no second factor at all (the site challenges an enrolled factor, or sends the member to enrol one);
 *  - "stale": the session is aal2 but no accepted factor was proved within max_age_seconds (re-verify, even though already aal2);
 *  - "untrusted_factor": the factor that last verified this session is not on the account's trusted list, or is still in
 *    its 24-hour hold (`pending_until`): re-verify with a trusted factor, or trust this one first (trusted-factors.ts). */
export interface StepUpRequirement {
  reason: "aal1" | "stale" | "untrusted_factor";
  /** Unix seconds when the session's factor leaves its trust hold (reason "untrusted_factor" only). */
  pending_until?: number;
  methods: string[];
  max_age_seconds: number;
  /** Unix seconds of the newest accepted-method proof in this token, or null. */
  verified_at: number | null;
}

/** null when the token proves aal2 plus an accepted second factor (amr timestamps are Unix seconds) within the window. */
export function stepUpRequirement(claims: SupabaseClaims, config: SupabaseAuthConfig, nowMs: number): StepUpRequirement | null {
  const now = Math.floor(nowMs / 1000);
  const proofs = claims.amr.filter((e) => config.stepUpMethods.has(e.method) && e.timestamp <= now + CLOCK_SKEW_SECONDS);
  const newest = proofs.reduce<number | null>((m, e) => (m === null || e.timestamp > m ? e.timestamp : m), null);
  if (claims.aal === "aal2" && newest !== null && now - newest <= config.stepUpMaxAgeSeconds) return null;
  return { reason: claims.aal === "aal2" ? "stale" : "aal1", methods: [...config.stepUpMethods], max_age_seconds: config.stepUpMaxAgeSeconds, verified_at: newest };
}

export const stepUpFresh = (claims: SupabaseClaims, config: SupabaseAuthConfig, nowMs: number): boolean =>
  stepUpRequirement(claims, config, nowMs) === null;
