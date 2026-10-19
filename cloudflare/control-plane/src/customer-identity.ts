// SPDX-License-Identifier: AGPL-3.0-or-later
// Who the caller is, by ROUTE SCOPE. Two products share accounts.murage.ai and its "user" table, as SEPARATE accounts:
//   - Murage Cloud (the murage.ai members area): the Supabase access token (verified against the project's JWKS, mapped
//     to a Cloud account by `sub`, cloud-accounts.ts). It is the ONLY identity on the Cloud routes (isCloudScopePath):
//     /v1/account/*, the customer /v1/billing/* routes, /v1/legal/quote, /v1/homes, /v1/homes/:id/pairing/* and the B4 Flux
//     owner routes /v1/flux/link* and /v1/homes/:id/flux*, and the door POST /v1/homes/:id/door.
//   - The phone companion (the desktop's managed relay, Settings > Phone): the Better Auth email-code session (/api/auth/*)
//     as a bearer on /v1/me and /v1/installations*. It is the ONLY account identity there (auth.ts accountSession refuses
//     a Supabase token), and never one on a Cloud route: a Better Auth bearer on a Cloud route is unauthenticated (401).
// There is no switch to put Better Auth back on Cloud routes (the old CLOUD_LEGACY_CUSTOMER_AUTH is gone). The operator's
// admin token and the machine and installation credentials are unchanged. The desktop does not use any Cloud route at
// launch; POST /v1/pairing/desktop (pairing.ts) is kept for a future Cloud-home desktop feature.
import { resolveCloudAccount, type CloudAccount, type CurrentSupabaseUser } from "./cloud-accounts";
import { HTTPError } from "./http";
import { trustedStepUpRequirement } from "./trusted-factors";
import {
  CLOCK_SKEW_SECONDS, isRedirect, JWKS_TIMEOUT_MS, JwksCache, JwksUnavailable, readSupabaseAuthConfig, stepUpRequirement, TokenRejected, UUID_RE, verifySupabaseToken,
  type StepUpRequirement, type SupabaseAuthConfig, type SupabaseClaims,
} from "./supabase-jwt";

export interface IdentityDependencies {
  /** Fetch for the Supabase JWKS. Default: global fetch. */
  jwksFetch?: typeof fetch;
  /** Fetch for Supabase Auth's GET /auth/v1/user (email reconciliation only). Default: global fetch. */
  authFetch?: typeof fetch;
  now?: () => number;
}

export interface CustomerSession {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  session: { id: string };
  supabase: SupabaseClaims;
}

/** The Cloud customer routes. /v1/legal/disclosure is public; /v1/billing/webhook and snapshot-receipt are not customer routes. */
export function isCloudCustomerPath(path: string): boolean {
  return path === "/v1/billing/reserve" || path === "/v1/billing/checkout" || path === "/v1/billing/portal"
    || path === "/v1/billing/checkout/resume" || path === "/v1/legal/quote" || path.startsWith("/v1/account/");
}
const HOME_PAIRING = /^\/v1\/homes\/[^/]+\/pairing\/[^/]+$/;
/** The door (door.ts): the signed-in owner mints a 60-second, CP-signed ticket that opens their home's /enter page. */
export const DOOR_ROUTE = /^\/v1\/homes\/([\w-]{1,128})\/door$/;
/** The door's fresh second factor is younger than this, whatever CLOUD_STEPUP_MAX_AGE_SECONDS says (door v2, CLOUD-DOOR-V2-DESIGN.md 3.4:
 *  the emailed sign-in counts as the door's second step for 15 minutes). A v2 home refuses a ticket whose stepUpAt is older than
 *  issuedAt - 900 s. */
export const DOOR_STEP_UP_MAX_AGE_SECONDS = 900;
/** A v1 home (door_version not 'v2') still refuses a stepUpAt older than issuedAt - 300 s: a v1 ticket is minted only inside it (door.ts). */
export const DOOR_V1_STEP_UP_MAX_AGE_SECONDS = 300;
/** Supabase amr methods that are an emailed sign-in (a code or a link): the door's reuse (3.4). A password never counts. */
export const DOOR_EMAIL_PROOF_METHODS: ReadonlySet<string> = new Set(["otp", "magiclink"]);
/** Device management on My Cloud (3.2): the home's devices, through the CP's one HMAC call to the home (devices.ts). */
export const DEVICES_ROUTE = /^\/v1\/homes\/([\w-]{1,128})\/devices$/;
export const DEVICE_REVOKE_ROUTE = /^\/v1\/homes\/([\w-]{1,128})\/devices\/([\w-]{1,128})\/revoke$/;

/** The door's 15-minute reuse (CLOUD-DOOR-V2-DESIGN.md 3.4), bound to the account and THIS Supabase session: the freshest of (1) the
 *  session's amr entry with an emailed method (otp, magiclink) within 900 s (amr is session-level: the age is the sign-in's, never the
 *  token's; no amr contributes nothing) and (2) a CP emailed-code `granted` event in this session within 900 s, counted even when its own
 *  action later claimed it (the claim is a separate row). Null when neither. Used for the door ONLY (the gate's exemption names DOOR_ROUTE
 *  and nothing else; door.ts stepUpAt checks it again). */
export async function doorRecentProofAt(env: Env, session: CustomerSession, now: number): Promise<{ at: number; proof: "amr" | "granted" } | null> {
  const windowMs = DOOR_STEP_UP_MAX_AGE_SECONDS * 1000;
  const fresh = (at: number) => now - at <= windowMs && at <= now + CLOCK_SKEW_SECONDS * 1000;
  let best: { at: number; proof: "amr" | "granted" } | null = null;
  for (const e of session.supabase.amr ?? []) {
    const at = e.timestamp * 1000;
    if (DOOR_EMAIL_PROOF_METHODS.has(e.method) && fresh(at) && (!best || at > best.at)) best = { at, proof: "amr" };
  }
  if (session.supabase.sessionId) {
    const row = await env.DB.prepare("SELECT MAX(at) AS at FROM cloud_stepup_events WHERE user_id=? AND session_id=? AND kind='granted' AND at>=?")
      .bind(session.user.id, session.supabase.sessionId, now - windowMs).first<{ at: number | null }>();
    if (typeof row?.at === "number" && fresh(row.at) && (!best || row.at > best.at)) best = { at: row.at, proof: "granted" };
  }
  return best;
}
/** DOOR_V2_REQUIRED (a CP var, default off; declared in door.ts): only exactly "1" turns it on ("v2 is the only door"). */
export const doorV2Required = (env: { DOOR_V2_REQUIRED?: string }): boolean => env.DOOR_V2_REQUIRED === "1";
/** The step-up freshness window of a route: the account-wide window, capped at 900 s on the door. */
export const stepUpMaxAgeFor = (path: string, configured: number): number =>
  DOOR_ROUTE.test(path) ? Math.min(configured, DOOR_STEP_UP_MAX_AGE_SECONDS) : configured;
/** The B4 Flux OWNER routes (b4-flux.ts LINK_ROUTE and HOME_ROUTE), as prefixes: /v1/flux/link* and /v1/homes/:id/flux*.
 *  Their account is the mapped Cloud account (supabase_identities.user_id), never a Better Auth companion id (Astra
 *  B4-PORT P1, ruling A of ASTRA-WP5-P4-CP-2). The machine (/v1/machines/:id/flux/*) and operator (/v1/internal/flux/*)
 *  Flux routes keep their own credentials and are not Cloud scope. */
const FLUX_OWNER = /^\/v1\/(?:flux\/link|homes\/[^/]+\/flux)(?:\/|$)/;
export const isFluxOwnerPath = (path: string): boolean => FLUX_OWNER.test(path);
/** Every route whose account is the Cloud (Supabase) account: the customer routes plus the Cloud home routes and the Flux
 *  owner routes. A Better Auth session never authenticates on any of these. */
export const isCloudScopePath = (path: string): boolean =>
  isCloudCustomerPath(path) || path === "/v1/homes" || HOME_PAIRING.test(path) || DOOR_ROUTE.test(path) || isFluxOwnerPath(path)
    || DEVICES_ROUTE.test(path) || DEVICE_REVOKE_ROUTE.test(path);

/** Customer actions that start or change charges, or can lose or leak data, need a fresh second factor, checked before any
 *  other work. Cancel and withdraw need sign-in only (Sean, 2026-10-10): leaving must be as easy as joining (click-to-cancel,
 *  the EU withdrawal function), and each sends its confirmation email. Self-service (self-service.ts): delete, start fresh and
 *  add-a-device (behind the 72-hour hold), Reset my Cloud and its undo, logs and the export download. Each handler checks again. */
export const STEP_UP_ROUTES: ReadonlySet<string> = new Set([
  // POST /v1/billing/reserve is NOT here: it is sign-in only (one purchase = at most ONE emailed code, at checkout; purchase-bootstrap.ts).
  "/v1/billing/checkout", "/v1/billing/portal", "/v1/account/topup",
  // Members area (members-api.ts, SPEC §5): Finish checkout and an upgrade start or change charges; the data export request needs a fresh
  // second step (SPEC §5 item 8). Each handler checks again.
  "/v1/billing/checkout/resume", "/v1/account/plan", "/v1/account/export-request",
  "/v1/account/home/hold", "/v1/account/home/reset", "/v1/account/home/reset/undo", "/v1/account/home/logs/request",
  "/v1/account/export/download",
]);
/** Routes with an id in the path that need the same fresh second factor: making a desktop pairing code (pairing.ts). */
// "Keep my plan" is NOT here (owner rule, 2026-10-12, B5): a plain Keep restores the customer's own prior state, moves no money and
// changes no price, so it is sign-in only like Cancel plan.
// B4 Flux (wiring step 3): linking a Flux account (start and complete) names who receives the paid plan's credits; a home's
// Flux key, its spending cap and its Stop spend or cut off money on that account. Unlink (DELETE) and status (GET) are
// sign-in only: unlink fences keys and stops homes (cancellation-like) but never forfeits paid credit, whose grants stay
// held for their frozen recipient (b4-flux.ts, Astra FLUX-STEP3 #1). b4-flux.ts checks the owner again; this gate runs first.
// The door (POST /v1/homes/:id/door) hands out a ticket that signs a browser in at the home: a fresh second factor, within 300 s
// (stepUpMaxAgeFor), checked here and again in door.ts.
export const STEP_UP_PATTERNS: readonly RegExp[] = [/^\/v1\/account\/homes\/[^/]+\/desktop-code$/,
  /^\/v1\/flux\/link\/(?:start|complete)$/, /^\/v1\/homes\/[^/]+\/flux\/(?:subkey|cap|stop)$/, DOOR_ROUTE,
  // Removing a device from a home (devices.ts): the ordinary emailed code or a fresh trusted factor; the door's reuse never applies.
  DEVICE_REVOKE_ROUTE];
export const needsStepUp = (method: string, path: string) =>
  method === "POST" && (STEP_UP_ROUTES.has(path) || STEP_UP_PATTERNS.some((p) => p.test(path)));
/** The one body-aware exception to the route-level rule above (journey A3). A top-up change that only switches the top-up OFF, or only LOWERS
 *  its amount, threshold or cap while it stays on, cannot raise spending, so it needs sign-in only; switching it ON or raising anything keeps the
 *  fresh second factor. The rule itself is topupReduces (legal-routes.ts); the worker gate (index.ts) asks it for this route, and the
 *  handler asks it again, so a crafted body cannot get an enable or a raise past the gate. Every other route stays route-level. */
export const TOPUP_ROUTE = "/v1/account/topup";
export const isTopupChange = (method: string, path: string) => method === "POST" && path === TOPUP_ROUTE;
/** Journey A8, the same body-aware rule for a home's monthly Flux spend limit (POST /v1/homes/{id}/flux/cap): a limit no higher than today's
 *  needs sign-in only; a raise keeps the fresh second factor. The rule is fluxCapStepUpExempt (b4-flux.ts); setCap enforces it again. */
export const isFluxCapChange = (method: string, path: string) => method === "POST" && /^\/v1\/homes\/[^/]+\/flux\/cap$/.test(path);

interface Bound { resolve(): Promise<CustomerSession | null> }
const bound = new WeakMap<Request, Bound>();

/** The Supabase identity bound to this request, when the request is on a Cloud route (isCloudScopePath). */
export const boundCustomer = (request: Request): Bound | undefined => bound.get(request);
/** The worker authenticates the original request before it buffers the body (Astra MAKERKIT8 P3) and routes the buffered
 *  copy: the copy carries the same, already-resolved binding. */
export function carryBinding(from: Request, to: Request) {
  const b = bound.get(from);
  if (b && from !== to) bound.set(to, b);
  const p = proofs.get(from);
  if (p && from !== to) proofs.set(to, p);
}
/** An emailed-code approval CLAIMED for exactly this request (step-up-email.ts prepareStepUp): it travels in request context, so the
 *  worker gate and every repeated handler check see the same proof, and nothing re-claims it. Never set from anything the caller sends.
 *  It carries the frozen target: every check re-validates that target (and that this request still holds the claim) in D1, not just the
 *  proof's presence, and the handlers that resolve "the current home" must land on the pinned one (Astra STEPUP-EMAIL-2 #3). */
export interface StepUpProof {
  /** The intent: also the operation's idempotency key (stepUpOperationKey). */
  intentId: string;
  /** The home the approval was frozen for, when the route acts on "the current home". */
  homeId: string | null;
  /** The bound logs continuation: only this collect_logs command's lines may be read. */
  logsCommand: string | null;
  /** A Flux home approval: the lifecycle version it was frozen at (an owner resume it authorizes must still find it). */
  fluxLifecycle?: number | null;
  /** True while the claim is still this request's and the target and its versions are unchanged. */
  revalidate: () => Promise<boolean>;
}
const proofs = new WeakMap<Request, StepUpProof>();
export const markStepUpProof = (request: Request, proof: StepUpProof) => { proofs.set(request, proof); };
export const stepUpProof = (request: Request): StepUpProof | null => proofs.get(request) ?? null;
/** The proof counts only while its target re-validates (a Stop, a newer home, a changed plan in between voids it). */
export async function stepUpProofValid(request: Request): Promise<boolean> {
  const p = proofs.get(request);
  if (!p) return false;
  try { return await p.revalidate(); } catch { return false; }
}
/** The home an emailed approval was frozen for (null: no pin). A handler resolving another home must refuse. */
export const pinnedHome = (request: Request): string | null => proofs.get(request)?.homeId ?? null;
/** A handler resolved `homeId` for this request: under an emailed approval frozen for another home it is refused (the approval is void). */
export function assertPinnedHome(request: Request, homeId: string): void {
  const pin = proofs.get(request)?.homeId ?? null;
  if (pin !== null && pin !== homeId) throw new HTTPError(403, "step_up_required");
}
/** The collect_logs command a logs continuation is bound to (null: none). */
export const pinnedLogsCommand = (request: Request): string | null => proofs.get(request)?.logsCommand ?? null;
/** The stable operation key of a claimed approval: a retry that resumes an interrupted operation reuses it as its idempotency key. */
export const stepUpOperationKey = (request: Request): string | null => proofs.get(request)?.intentId ?? null;

function bearer(request: Request): string | null {
  const m = request.headers.get("authorization")?.match(/^Bearer\s+([^\s]+)$/i);
  return m ? m[1] : null;
}
/** Supabase Auth's current record of the token's user: the authority on its confirmed email (cloud-accounts.ts).
 *  Called only when a token's email disagrees with the stored one, or a conflict is open. A session Supabase no longer
 *  honours (signed out, user deleted) is 401; anything else that is not an answer is 503 identity_unavailable. */
/** One MFA factor as Supabase Auth's GET /auth/v1/user lists it (models.Factor: id, factor_type, status, friendly_name;
 *  the user is loaded eagerly with its factors, supabase/auth ce9a8ee internal/models/user.go findUser). */
export interface SupabaseFactor { id: string; type: string; status: string; friendlyName: string; createdAt: string }
export interface SupabaseUserRecord extends CurrentSupabaseUser {
  factors: SupabaseFactor[];
  /** auth.users.updated_at as Supabase Auth returns it ("" when absent). Supabase bumps it on every write to the user
   *  record (gobuffalo/pop UpdateColumns touches updated_at), every email change included; trusted-factors.ts binds its
   *  emailed codes and its activation to it (Astra MAKERKIT8 #5). */
  updatedAt: string;
}

async function currentSupabaseUser(config: SupabaseAuthConfig, token: string, fetcher: typeof fetch): Promise<SupabaseUserRecord> {
  let res: Response;
  try {
    // redirect "manual": a fixed endpoint never redirects, and following one could forward the member's token and the
    // apikey to another origin (Astra MAKERKIT4 #5). Any redirect is refused as unavailable.
    res = await fetcher(config.userUrl, { headers: { authorization: `Bearer ${token}`, apikey: config.publishableKey, accept: "application/json" },
      redirect: "manual", signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
  } catch { throw new HTTPError(503, "identity_unavailable"); }
  if (isRedirect(res)) {
    console.log(JSON.stringify({ message: "supabase auth redirected; refused", status: res.status }));
    throw new HTTPError(503, "identity_unavailable");
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    console.log(JSON.stringify({ message: "customer token rejected", reason: "session_not_current" }));
    throw new HTTPError(401, "unauthorized");
  }
  if (!res.ok) throw new HTTPError(503, "identity_unavailable");
  const u = await res.json<{ id?: unknown; email?: unknown; email_confirmed_at?: unknown; updated_at?: unknown; factors?: unknown }>().catch(() => null);
  if (!u || typeof u.id !== "string" || typeof u.email !== "string" || !u.email.trim()) throw new HTTPError(503, "identity_unavailable");
  // Supabase keeps `email` as the confirmed address until a change is confirmed (secure email change); an unconfirmed
  // account is not a customer.
  if (typeof u.email_confirmed_at !== "string" || !u.email_confirmed_at) throw new HTTPError(401, "unauthorized");
  const factors = (Array.isArray(u.factors) ? u.factors : []).flatMap((f): SupabaseFactor[] => {
    const x = f as Record<string, unknown> | null;
    return x && typeof x.id === "string" && UUID_RE.test(x.id) && typeof x.factor_type === "string" && typeof x.status === "string"
      ? [{ id: x.id.toLowerCase(), type: x.factor_type, status: x.status, friendlyName: typeof x.friendly_name === "string" ? x.friendly_name.slice(0, 120) : "",
        createdAt: typeof x.created_at === "string" ? x.created_at : "" }]
      : [];
  });
  return { id: u.id, email: u.email.trim().toLowerCase(), factors, updatedAt: typeof u.updated_at === "string" ? u.updated_at : "" };
}

export const looksLikeJWT = (t: string) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t);

export function createIdentity(deps: IdentityDependencies = {}) {
  const now = deps.now ?? Date.now;
  let cache: JwksCache | null = null;
  const jwks = () => (cache ??= new JwksCache(deps.jwksFetch ?? ((input, init) => fetch(input, init)), now));
  const authFetch: typeof fetch = deps.authFetch ?? ((input, init) => fetch(input, init));

  async function resolve(request: Request, env: Env): Promise<CustomerSession | null> {
    const token = bearer(request);
    // No bearer, the operator's admin token, an installation token: not a Supabase customer.
    if (!token || !looksLikeJWT(token)) return null;
    let config: SupabaseAuthConfig | null;
    try { config = readSupabaseAuthConfig(env); } catch { throw new HTTPError(503, "customer_auth_misconfigured"); }
    if (!config) throw new HTTPError(503, "customer_auth_unconfigured");
    let claims: SupabaseClaims;
    try { claims = await verifySupabaseToken(token, config, jwks(), now()); }
    catch (e) {
      if (e instanceof JwksUnavailable) throw new HTTPError(503, "identity_unavailable");
      if (e instanceof TokenRejected) {
        console.log(JSON.stringify({ message: "customer token rejected", reason: e.reason }));
        return null;
      }
      throw e;
    }
    const verified = config;
    const account: CloudAccount = await resolveCloudAccount(env.DB, claims, now(), () => currentSupabaseUser(verified, token, authFetch));
    return { user: account, session: { id: `supabase:${claims.sessionId}` }, supabase: claims };
  }

  async function supabaseUser(request: Request, env: Env): Promise<SupabaseUserRecord> {
    const s = await bound.get(request)?.resolve();
    const token = bearer(request);
    const config = readSupabaseAuthConfig(env);
    if (!s || !token || !config) throw new HTTPError(401, "unauthorized");
    const u = await currentSupabaseUser(config, token, authFetch);
    if (u.id !== s.supabase.sub) throw new HTTPError(401, "unauthorized");
    return u;
  }
  // One Supabase read per request for the step-up gate (it may ask twice: the decision, then the 403 body).
  const gateUser = new WeakMap<Request, Promise<SupabaseUserRecord>>();

  async function stepUpNeeded(request: Request, env: Env): Promise<StepUpRequirement | null> {
    const config = readSupabaseAuthConfig(env);
    const s = await bound.get(request)?.resolve();
    if (!s || !config) return null;
    // Observational: an approval already claimed for this very request (emailed code) satisfies it; nothing is consumed here.
    if (proofs.has(request) && await stepUpProofValid(request)) return null;
    // The factor that verified this session must still be enrolled and verified in Supabase NOW (Astra MAKERKIT8 #2): a
    // saved token keeps its mfa_factor_id after the factor is removed. Asked only once every local check has passed.
    const currentFactors = async () => {
      let p = gateUser.get(request);
      if (!p) { p = supabaseUser(request, env); gateUser.set(request, p); }
      return (await p).factors;
    };
    // The route's window: the account-wide one, capped at 300 s on the door (stepUpMaxAgeFor). The refusal says which.
    const maxAge = stepUpMaxAgeFor(new URL(request.url).pathname, config.stepUpMaxAgeSeconds);
    const windowed = maxAge === config.stepUpMaxAgeSeconds ? config : { ...config, stepUpMaxAgeSeconds: maxAge };
    return stepUpRequirement(s.supabase, windowed, now())
      ?? trustedStepUpRequirement(env.DB, s.user.id, s.supabase, windowed, now(), maxAge, currentFactors);
  }

  return {
    /** Binds lazy, memoized Supabase resolution to every Cloud-scope request, whatever its bearer: on these routes the
     *  account is the Supabase identity or nobody (a Better Auth bearer resolves to null). No-op off those routes. */
    bind(request: Request, _env: Env) {
      if (!isCloudScopePath(new URL(request.url).pathname)) return;
      let memo: Promise<CustomerSession | null> | null = null;
      bound.set(request, { resolve: () => (memo ??= resolve(request, _env)) });
    },
    /** True when the bound customer proved a TRUSTED second factor within the window (trusted-factors.ts). */
    async stepUp(request: Request, env: Env): Promise<boolean> {
      const s = await bound.get(request)?.resolve();
      return Boolean(s && readSupabaseAuthConfig(env)) && (await stepUpNeeded(request, env)) === null;
    },
    /** What the members area must do to step up (the 403 body), or null when the step-up is fresh and came from a
     *  trusted factor, or there is no verified Supabase customer on this request. Two checks, in order: aal2 with an
     *  accepted method proved within the window (supabase-jwt.ts), then the factor that verified this session
     *  (`mfa_factor_id`) is on the account's trusted list (active), out of its hold, its own method's proof is fresh, and
     *  it is still a verified factor in Supabase's current list. */
    stepUpNeeded,
    /** The bound, verified Cloud member of this request, or null. */
    customer: async (request: Request): Promise<CustomerSession | null> => (await bound.get(request)?.resolve()) ?? null,
    config: (env: Env): SupabaseAuthConfig | null => { try { return readSupabaseAuthConfig(env); } catch { return null; } },
    now,
    /** Supabase Auth's current record of this request's member (confirmed email, updated_at and MFA factors), asked
     *  with the member's own token, fresh on every call. Throws HTTPError 401/503. */
    supabaseUser,
  };
}
export type Identity = ReturnType<typeof createIdentity>;
