// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import {
  changePlan,
  createFluxClient,
  FluxError,
  FLUX_OFF_MESSAGE,
  fluxOffStubRoute,
  grantMonthlyCredits,
  stopForBilling,
  spendingOffMaxStalenessMs,
  spendingOffPollBatch,
  sweepFlux,
  type FluxClient,
  type FluxDependencies,
  type FluxGrant,
  type FluxHomeStatus,
  type FluxMint,
} from "../src/b4-flux";
import { DEFAULT_FLUX_CONFIG, defaultCapUsd, isFluxPath, readFluxConfig } from "../src/b4-flux-config";
import { DISPATCH_TTL_MS, ledgerPage } from "../src/b4-flux-ledger";
import { stubFluxHooks } from "../src/b5-billing";
import { readConfig } from "../src/config";
import { createWorker } from "../src/index";
import { sha256 } from "../src/installations";
import { authFetch, cloudMember, jwksFetch, supabaseEnv, supabaseToken } from "./cloud-member";
/** Astra INTEGRATED-1 #7: real billing hooks advertising the qualified router capability (the B4 launch gate open). */
const QUALIFIED_HOOKS = { stub: false, capabilities: { reversalTargets: true } } as unknown as NonNullable<import("../src/b4-flux").FluxDependencies["billingFlux"]>;

const HOME = "home-flux";
const HOME_IP = "203.0.113.7";
const MACHINE_TOKEN = "machine-credential-for-flux-tests-0123456789";
const FLUX_ACCOUNT = "11111111-2222-3333-4444-555555555555";
const ADMIN = "admin-token-for-flux-tests-0123456789abcdef";
const SERVICE_TOKEN = "s".repeat(40);
const DAY = 86_400_000;
/** Round 4: a failed op is retried by the sweep after its backoff (5 min for the first failure). */
const BACKOFF = 6 * 60_000;
const LEASE = 2 * 60_000;
const PERIOD_START = Date.parse("2026-10-01T00:00:00Z");
const PERIOD_END = Date.parse("2026-11-01T00:00:00Z");
/** A billing period; n shifts it by n days so a test can make several distinct periods. */
const addDays = (ms: number, days: number) => ms + days * DAY;
const period = (n = 0) => ({ periodStart: PERIOD_START + n * DAY, periodEnd: PERIOD_END + n * DAY });
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/** Reference router + Flux app, enforcing the B4 round-2 CONTRACT: version floors (409 stale_*),
 *  generation tombstones, and credit-grant tombstones. */
class FakeFlux implements FluxClient {
  // ── router ──
  mints: FluxMint[] = [];
  stops: string[] = [];
  stopVersions: number[] = [];
  stopLinkVersions: (number | undefined)[] = [];
  keyRevokes: { homeId: string; generation: number; lifecycleVersion: number }[] = [];
  caps: { homeId: string; capMicrocents: number; capVersion: number }[] = [];
  lifecycleFloor = 0;
  linkFloor = 0;
  capFloor = 0;
  stopped = false;
  keys = new Set<number>();
  tombstonedKeys = new Set<number>();
  highestGeneration = 0;
  enforceLink = true;
  mintError: FluxError | null = null;
  /** Runs before the router evaluates a mint (a Stop/unlink that wins the race). */
  onMint: (() => Promise<void>) | null = null;
  /** Runs after the key is published, before the answer returns (a Stop that lands in between). */
  afterMint: (() => Promise<void>) | null = null;
  onStop: (() => Promise<void>) | null = null;
  down = false;
  stopDown = false;
  keyRevokeDown = false;
  latestGeneration = 0;
  conflictOnce: string | null = null;
  statusFor: FluxHomeStatus = { state: "ok", capMicrocents: 30_000_000, spentMicrocents: 4_000_000, resetsAt: "2026-11-01T00:00:00Z", accountSpendableMicrocents: 12_000_000, accountAutoTopUpEnabled: true };
  // ── Flux app (credit grants) ──
  grants: FluxGrant[] = [];
  deliveries: { grantId: string; deliveryId: string }[] = [];
  credits = new Map<string, number>();
  tombstones = new Set<string>();
  seenGrantIds = new Set<string>();
  revokes: { grantId: string; reason: string }[] = [];
  /** Astra INTEGRATED-9: the account's prepaid funds and the credit spent per grant. No grant call may touch either: a revoke removes only a
   *  grant's UNSPENT value (credits). */
  prepaidMicrocents = 12_000_000;
  spent = new Map<string, number>();
  spend(grantId: string, microcents: number) {
    this.credits.set(grantId, (this.credits.get(grantId) ?? 0) - microcents);
    this.spent.set(grantId, (this.spent.get(grantId) ?? 0) + microcents);
  }
  balances() { return { prepaid: this.prepaidMicrocents, spent: [...this.spent.entries()].sort() }; }
  revokeDown = false;
  revoke404 = false;
  /** Runs inside a grant call before the credit is created. */
  onGrant: (() => Promise<void>) | null = null;
  /** Runs inside a grant call after the credit is created, before the answer returns. */
  afterGrant: (() => Promise<void>) | null = null;
  /** The credit is created but the answer is lost (a timeout). */
  grantAckLost = false;
  private check() { if (this.down) throw new FluxError(0, "unreachable"); }
  // ── round 3: the serializer's invariant, as seen by the router ──
  /** Router lifecycle calls (mint, stop, revokeKey, setCap) in flight right now. */
  inflight = 0;
  /** True if two of them ever overlapped: the per-home serializer must make that impossible. */
  overlapped = false;
  /** The cap and cap version the router ends up holding. */
  routerCap = 0;
  routerCapVersion = 0;
  /** Runs inside a key revoke before it takes effect. */
  onKeyRevoke: (() => Promise<void>) | null = null;
  /** The Stop takes effect but its answer is lost (a timeout). */
  stopAckLost = false;
  /** Round 4: homes whose every router call fails (502), and how many such calls were made. */
  failHomes = new Set<string>();
  failedCalls = 0;
  private failFor(homeId: string) { if (this.failHomes.has(homeId)) { this.failedCalls++; throw new FluxError(502, ""); } }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.inflight++;
    if (this.inflight > 1) this.overlapped = true;
    try { return await fn(); } finally { this.inflight--; }
  }
  mint(input: FluxMint) { return this.exclusive(() => this.mintImpl(input)); }
  stop(homeId: string, lifecycleVersion: number, options: { linkVersion?: number } = {}) { return this.exclusive(() => this.stopImpl(homeId, lifecycleVersion, options)); }
  revokeKey(homeId: string, generation: number, lifecycleVersion: number) { return this.exclusive(() => this.revokeKeyImpl(homeId, generation, lifecycleVersion)); }
  setCap(homeId: string, capMicrocents: number, capVersion: number) { return this.exclusive(() => this.setCapImpl(homeId, capMicrocents, capVersion)); }
  private async mintImpl(input: FluxMint) {
    this.check();
    if (this.mintError) throw this.mintError;
    if (this.onMint) { const hook = this.onMint; this.onMint = null; await hook(); }
    if (this.conflictOnce) { const detail = this.conflictOnce; this.conflictOnce = null; throw new FluxError(409, detail); }
    if (input.billingState !== "ok") throw new FluxError(403, "", "billing_hold");
    if (input.lifecycleVersion < this.lifecycleFloor) throw new FluxError(409, "", "stale_lifecycle");
    if (input.capVersion < this.capFloor) throw new FluxError(409, "", "stale_cap");
    if (this.enforceLink && input.linkVersion < this.linkFloor) throw new FluxError(409, "", "stale_link");
    if (this.tombstonedKeys.has(input.generation)) throw new FluxError(409, "", "generation_revoked");
    if (input.generation <= this.highestGeneration) throw new FluxError(409, `generation must be greater than ${this.highestGeneration}`);
    this.mints.push(input);
    this.routerCap = input.capMicrocents;
    this.routerCapVersion = input.capVersion;
    this.latestGeneration = input.generation;
    this.highestGeneration = input.generation;
    this.lifecycleFloor = Math.max(this.lifecycleFloor, input.lifecycleVersion);
    this.capFloor = Math.max(this.capFloor, input.capVersion);
    this.linkFloor = Math.max(this.linkFloor, input.linkVersion);
    this.stopped = false;
    this.keys.clear();
    this.keys.add(input.generation);
    if (this.afterMint) { const hook = this.afterMint; this.afterMint = null; await hook(); }
    return { key: `sk-flux-home-fake-${input.homeId}-g${input.generation}-0123456789abcdef`, expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(), generation: input.generation, capMicrocents: input.capMicrocents };
  }
  private async stopImpl(homeId: string, lifecycleVersion: number, options: { linkVersion?: number } = {}) {
    this.check();
    this.failFor(homeId);
    if (this.onStop) { const hook = this.onStop; this.onStop = null; await hook(); }
    if (this.stopDown) throw new FluxError(502, "");
    if (lifecycleVersion < this.lifecycleFloor) throw new FluxError(409, "", "stale_lifecycle");
    this.lifecycleFloor = lifecycleVersion;
    if (options.linkVersion !== undefined) this.linkFloor = Math.max(this.linkFloor, options.linkVersion);
    this.stopped = true;
    this.keys.clear();
    this.stops.push(homeId); this.stopVersions.push(lifecycleVersion); this.stopLinkVersions.push(options.linkVersion);
    if (this.stopAckLost) { this.stopAckLost = false; throw new FluxError(0, "unreachable"); }
  }
  private async revokeKeyImpl(homeId: string, generation: number, lifecycleVersion: number) {
    this.check();
    if (this.onKeyRevoke) { const hook = this.onKeyRevoke; this.onKeyRevoke = null; await hook(); }
    if (this.keyRevokeDown) throw new FluxError(502, "");
    this.keys.delete(generation);
    this.tombstonedKeys.add(generation); // idempotent; a never-published generation can no longer be published
    this.keyRevokes.push({ homeId, generation, lifecycleVersion });
  }
  private async setCapImpl(homeId: string, capMicrocents: number, capVersion: number) {
    this.check();
    this.failFor(homeId);
    if (capVersion < this.capFloor) throw new FluxError(409, "", "stale_cap");
    this.capFloor = capVersion;
    this.routerCap = capMicrocents;
    this.routerCapVersion = capVersion;
    this.caps.push({ homeId, capMicrocents, capVersion });
  }
  statusCalls = 0;
  async status() { this.statusCalls++; this.check(); return this.statusFor; }
  async grant(input: FluxGrant) {
    this.check();
    this.deliveries.push({ grantId: input.grantId, deliveryId: input.deliveryId });
    if (this.onGrant) { const hook = this.onGrant; this.onGrant = null; await hook(); }
    if (this.tombstones.has(input.grantId)) throw new FluxError(409, "", "revoked");
    if (!this.seenGrantIds.has(input.grantId)) {
      this.seenGrantIds.add(input.grantId);
      this.grants.push(input);
      this.credits.set(input.grantId, input.amountMicrocents);
    }
    if (this.afterGrant) { const hook = this.afterGrant; this.afterGrant = null; await hook(); }
    if (this.grantAckLost) throw new FluxError(0, "unreachable");
  }
  /** INTEGRATED-12 (R8c): Flux's own record of an operator's hand adjustment (by its reference). By default the adjustment was made exactly
   *  as the receipt states; `adjustments` sets what Flux actually holds after a given reference. */
  adjustments = new Map<string, number>();
  verifications: { grantId: string; adjustmentRef: string; appliedMicrocents: number }[] = [];
  async verifyAdjustment(input: { grantId: string; adjustmentRef: string; appliedMicrocents: number }) {
    this.check();
    this.verifications.push(input);
    return { appliedMicrocents: this.adjustments.get(input.adjustmentRef) ?? input.appliedMicrocents };
  }
  async revokeGrant(grantId: string, reason: string) {
    this.check();
    if (this.revokeDown) throw new FluxError(502, "");
    if (this.revoke404) throw new FluxError(404, "");
    this.tombstones.add(grantId); // ALWAYS, even if the grant is unknown
    this.revokes.push({ grantId, reason });
    return this.credits.delete(grantId) ? "revoked" as const : "tombstoned" as const;
  }
}

/** Wrap a D1 binding so a test can run code just before a statement (one-shot, see armDb). */
function hookDb(db: D1Database, hook: (sql: string) => Promise<void> | void): D1Database {
  type Stmt = D1PreparedStatement & { __real?: D1PreparedStatement; __sql?: string };
  const wrap = (stmt: D1PreparedStatement, sql: string): Stmt => new Proxy(stmt as Stmt, {
    get(target, prop) {
      if (prop === "__real") return target;
      if (prop === "__sql") return sql;
      if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
      if (prop === "run" || prop === "first" || prop === "all" || prop === "raw") {
        return async (...args: unknown[]) => { await hook(sql); return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop as string](...args); };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch") {
        return async (statements: Stmt[]) => {
          await hook(statements.map((s) => s.__sql ?? "").join(";\n"));
          return target.batch(statements.map((s) => s.__real ?? s));
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
let dbHook: ((sql: string) => Promise<void> | void) | null = null;
/** Run `action` once, just before the first statement whose SQL matches. */
function armDb(match: RegExp, action: () => Promise<void>) {
  dbHook = async (sql) => {
    if (!match.test(sql)) return;
    dbHook = null;
    await action();
  };
}

let flux = new FakeFlux();
let clock = Date.parse("2026-10-09T12:00:00Z");
const deps: FluxDependencies = { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock };
// Wiring step 3: the Flux owner routes take only the Supabase members-area token (Cloud scope), and link, key, cap and Stop
// need a fresh TRUSTED second factor (the real gate: aal2 + a fresh totp proof + an active cloud_trusted_factors row + the factor
// still verified in Supabase Auth's current record, which fluxAuthFetch answers).
const factors = new Map<string, string>();
const factorOf = (sub: string) => { let f = factors.get(sub); if (!f) { f = crypto.randomUUID(); factors.set(sub, f); } return f; };
/** Factors Supabase Auth no longer lists as verified (a removed factor). */
const unverified = new Set<string>();
const fluxAuthFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const bearer = new Headers(init?.headers).get("authorization")!.slice("Bearer ".length);
  const c = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()) as { sub: string; email: string };
  return Response.json({ id: c.sub, email: c.email, email_confirmed_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    factors: [{ id: factorOf(c.sub), factor_type: "totp", status: unverified.has(c.sub) ? "unverified" : "verified", friendly_name: "" }] });
}) as typeof fetch;
const worker = createWorker(undefined, undefined, {}, {}, {}, { jwksFetch, authFetch: fluxAuthFetch }, {}, deps);
/** A members-area token that proved the member's TOTP factor `ageS` seconds ago (aal2), or an aal1 sign-in only. */
const stepUpToken = (sub: string, email: string, options: { ageS?: number; aal1?: boolean } = {}) =>
  supabaseToken(sub, email, (s) => options.aal1 ? {} : { aal: "aal2", mfa_factor_id: factorOf(sub),
    amr: [{ method: "totp", timestamp: s - (options.ageS ?? 10) }, { method: "otp", timestamp: s - 60 }] });
let publicKeyB64 = "";
let signingKey: CryptoKey;

async function setupKeys() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  signingKey = pair.privateKey;
  publicKeyB64 = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
}

let extra: Record<string, string | undefined> = {};
const testEnv = () => ({
  ...env, DB: dbHook ? hookDb(env.DB, dbHook) : env.DB, MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined,
  ...supabaseEnv, CLOUD_ADMIN_TOKEN: ADMIN, FLUX_CLOUD_SERVICE_TOKEN: SERVICE_TOKEN, FLUX_LINK_PUBLIC_KEY: publicKeyB64,
  // The Flux routes and cron are default-off (Astra B4-PORT P1/P2); this suite exercises them switched on and configured.
  CLOUD_FLUX_ROUTES_ENABLED: "1", FLUX_API_BASE: "https://api.fluxrouter.ai", ...extra,
}) as Env;

async function call(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const h = new Headers({ "content-type": "application/json", ...headers });
  if (token) h.set("authorization", `Bearer ${token}`);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://auth.murage.test${path}`, {
    method, headers: h, body: body === undefined || method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body),
  }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
/** The Flux owner: a Murage Cloud member (Supabase identity, mapped Cloud account id) with a trusted TOTP factor and a token
 *  that just stepped up with it. `userId` is the mapped Cloud account id (supabase_identities.user_id). */
async function signIn(email: string) {
  const member = await cloudMember(email);
  await env.DB.prepare("INSERT OR IGNORE INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state) VALUES (?,?,'totp','email_code',0,0,'active')")
    .bind(member.userId, factorOf(member.sub)).run();
  return { token: await stepUpToken(member.sub, email), userId: member.userId, sub: member.sub, email };
}
/** The phone companion's Better Auth email-code session: never an identity on a Flux owner route. */
async function companionSignIn(email: string) {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  const response = await worker.fetch(new Request("https://auth.murage.test/api/auth/sign-in/email-otp", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, otp, name: "t" }),
  }), testEnv(), createExecutionContext());
  const token = response.headers.get("set-auth-token");
  if (!token) throw new Error("no token");
  return { token, userId: (await response.json<{ user: { id: string } }>()).user.id };
}
async function seedHome(ownerId: string, options: { homeId?: string; boundIps?: string[] | null; generation?: number } = {}) {
  const homeId = options.homeId ?? HOME;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO cloud_machines (id,home_id,generation,state,credential_hash,bound_ips,created_at,public_origin,admin_url)
      VALUES (?,?,?,'active',NULL,?,?,?,?)`).bind(homeId, homeId, options.generation ?? 1,
      options.boundIps === null ? null : JSON.stringify(options.boundIps ?? [HOME_IP]), now, "https://h.murage.test", "https://admin.murage.test"),
    env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
      VALUES (?,?,?,'ready','ready','sha256:x','k',?,?)`).bind(homeId, `inst-${homeId}`, ownerId, now, now),
  ]);
}
async function signedProof(state: string, overrides: Record<string, unknown> = {}, flipSignature = false) {
  const nowS = Math.floor(clock / 1000);
  const payload = { v: 1, aud: "murage-cloud-link", flux_account_id: FLUX_ACCOUNT, state, iat: nowS, exp: nowS + 300, jti: crypto.randomUUID(), ...overrides };
  const encoded = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, signingKey, new TextEncoder().encode(encoded)));
  if (flipSignature) signature[0] ^= 1;
  return `${encoded}.${b64url(signature)}`;
}
async function link(token: string, fluxAccount = FLUX_ACCOUNT) {
  const start = await (await call("POST", "/v1/flux/link/start", token)).json<{ state: string }>();
  const done = await call("POST", "/v1/flux/link/complete", token, { state: start.state, proof: await signedProof(start.state, { flux_account_id: fluxAccount }) });
  expect(done.status).toBe(200);
}
async function machineSetup(ownerToken: string, userId: string) {
  await seedHome(userId);
  await link(ownerToken);
}
const admin = (path: string, body: unknown, token: string | null = ADMIN) => call("POST", path, token, body);
const seedHomeKeyRow = () => env.DB.prepare(`INSERT OR IGNORE INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,updated_at)
  VALUES (?, 'starter', 0, 'none', 30000000, 0, ?)`).bind(HOME, Date.now()).run();
const homeRow = () => env.DB.prepare("SELECT * FROM flux_home_keys WHERE home_id=?").bind(HOME).first<Record<string, unknown>>();
/** Astra INTEGRATED-9: the B4 ledger as tests read it. */
const ledgerAcct = (grantId: string) => env.DB.prepare("SELECT * FROM flux_grant_accounts WHERE grant_id=?").bind(grantId).first<Record<string, unknown>>();
const ledgerAlert = async (grantId: string) => {
  const a = await env.DB.prepare("SELECT kind,detail,resolved_at FROM cloud_alerts WHERE id=?").bind(`alert:flux_ledger:${grantId}`)
    .first<{ kind: string; detail: string; resolved_at: number | null }>();
  return a ? { kind: a.kind, open: a.resolved_at === null, ...(JSON.parse(a.detail) as Record<string, unknown>) } : null;
};
/** A refunded payment's SUCCEEDED coverage (b5 reconcilePaymentCoverage writes it): `coveredCents` of `paidCents`. */
const coverRefund = (invoiceId: string, coveredCents: number, pi = `pi_${invoiceId}`, paidCents = 4900) => env.DB.prepare(`INSERT INTO refund_coverage
    (home_id,payment_intent,invoice_id,subscription_id,paid_cents,covered_cents,open_cents,end_plan,changed_at,created_at) VALUES (?,?,?,'sub_a',?,?,0,0,?,?)
  ON CONFLICT(home_id,payment_intent) DO UPDATE SET covered_cents=excluded.covered_cents`).bind(HOME, pi, invoiceId, paidCents, coveredCents, clock, clock).run();
/** What the customer keeps of a grant G when `returned` of `paid` came back: G - floor(G x min(returned, paid) / paid). */
const share = (G: number, returned: number, paid = 4900) => G - Number(BigInt(G) * BigInt(Math.min(returned, paid)) / BigInt(paid));

afterEach(async () => {
  dbHook = null;
  unverified.clear();
  flux = new FakeFlux();
  extra = {};
  clock = Date.parse("2026-10-09T12:00:00Z");
});

describe("default-off Flux routes (Astra B4-PORT P1)", () => {
  // Supabase identity wired in, so a real-shaped members-area token is on the request too.
  const offWorker = createWorker(undefined, undefined, {}, {}, {}, { jwksFetch, authFetch }, {}, deps);
  const ROUTES: [string, string][] = [
    ["POST", "/v1/flux/link/start"], ["POST", "/v1/flux/link/complete"], ["GET", "/v1/flux/link"], ["DELETE", "/v1/flux/link"],
    ["GET", "/v1/flux"], ["GET", `/v1/homes/${HOME}/flux`], ["POST", `/v1/homes/${HOME}/flux/subkey`],
    ["POST", `/v1/homes/${HOME}/flux/cap`], ["POST", `/v1/homes/${HOME}/flux/stop`],
    ["POST", "/v1/internal/flux/grant"], ["POST", "/v1/internal/flux/plan"], ["POST", "/v1/internal/flux/stop"],
    ["POST", `/v1/machines/${HOME}/flux/subkey`], ["POST", `/v1/machines/${HOME}/flux/subkey/ack`], ["POST", `/v1/machines/${HOME}/flux/renewal-due`],
  ];
  const BODIES: Record<string, unknown> = {
    "/v1/flux/link/complete": { state: "s".repeat(43), proof: "p.q" },
    [`/v1/homes/${HOME}/flux/cap`]: { capUsd: 50 },
    "/v1/internal/flux/grant": { homeId: HOME, plan: "starter", invoiceId: "in_off_0001", ...period() },
    "/v1/internal/flux/plan": { homeId: HOME, plan: "pro" },
    "/v1/internal/flux/stop": { homeId: HOME, reason: "cancelled" },
    [`/v1/machines/${HOME}/flux/subkey`]: { generation: 1, op_id: crypto.randomUUID() },
    [`/v1/machines/${HOME}/flux/subkey/ack`]: { generation: 1, op_id: crypto.randomUUID() },
    [`/v1/machines/${HOME}/flux/renewal-due`]: { generation: 1 },
  };
  const FLUX_TABLES = ["flux_grants", "flux_invoices", "flux_mint_ops", "flux_home_keys", "flux_link_proofs", "flux_link_challenges",
    "flux_links", "flux_link_floor", "flux_key_compensations", "flux_home_ops", "flux_entitlements"];
  const counts = async () => Object.fromEntries(await Promise.all(FLUX_TABLES.map(async (t) =>
    [t, (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())?.n])));

  it("answers 404 on every Flux route family, for every credential, before any auth or D1 statement, unless the switch is exactly \"1\"", async () => {
    await setupKeys();
    const companion = await companionSignIn("companion@example.test");
    const member = await cloudMember("member@example.test");
    await seedHome(companion.userId);
    const before = await counts();
    const credentials: [string, string | null][] = [
      ["none", null], ["Better Auth companion", companion.token], ["Supabase member", member.token], ["admin", ADMIN], ["machine", MACHINE_TOKEN],
    ];
    const seen: string[] = [];
    for (const value of [undefined, "", "0", "true", "yes", " 1", "1 ", "01"]) {
      extra = { ...supabaseEnv, CLOUD_FLUX_ROUTES_ENABLED: value };
      dbHook = (sql) => { seen.push(sql); };
      for (const [label, token] of credentials) {
        // The owner's spending Off (POST cap/stop) is authenticated and answered plainly instead (Astra JOURNEY-A-10 #4, its own test).
        for (const [method, path] of ROUTES.filter(([m, p]) => !fluxOffStubRoute(m, p))) {
          const h = new Headers({ "content-type": "application/json", "CF-Connecting-IP": HOME_IP });
          if (token) h.set("authorization", `Bearer ${token}`);
          const ctx = createExecutionContext();
          const response = await offWorker.fetch(new Request(`https://auth.murage.test${path}`, {
            method, headers: h, body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(BODIES[path] ?? {}),
          }), testEnv(), ctx);
          await waitOnExecutionContext(ctx);
          expect([label, value, method, path, response.status, await response.json()]).toEqual([label, value, method, path, 404, { error: "not_found" }]);
        }
      }
      dbHook = null;
    }
    // Not one statement: no Better Auth session lookup, no Supabase account resolution, no rate-limit row, no Flux row.
    expect(seen).toEqual([]);
    expect(await counts()).toEqual(before);
    expect([flux.mints, flux.stops, flux.grants, flux.caps]).toEqual([[], [], [], []]);
  });

  it("the deny is a PREFIX: every /v1/homes/<id>/flux* and /v1/machines/<id>/flux* path is 404 for GET, POST, OPTIONS and HEAD (Astra B4-PORT-2 #1)", async () => {
    const paths = [`/v1/homes/${HOME}/fluxfoo`, `/v1/machines/${HOME}/fluxfoo`, `/v1/homes/${HOME}/flux`, `/v1/machines/${HOME}/flux-x/y`,
      `/v1/homes/x/fluxcap`, "/v1/fluxfoo", "/v1/internal/fluxfoo"];
    for (const p of paths) expect([p, isFluxPath(p)]).toEqual([p, true]);
    for (const p of ["/v1/homes/x/status", "/v1/homes/x/xflux", "/v1/machines/x/heartbeat"]) expect([p, isFluxPath(p)]).toEqual([p, false]);
    for (const value of [undefined, "0"]) {
      extra = { ...supabaseEnv, CLOUD_FLUX_ROUTES_ENABLED: value };
      for (const path of paths) {
        for (const method of ["GET", "POST", "OPTIONS", "HEAD"]) {
          const h = new Headers({ "content-type": "application/json", "CF-Connecting-IP": HOME_IP, origin: "https://app.murage.test",
            "access-control-request-method": "POST" });
          const ctx = createExecutionContext();
          const response = await offWorker.fetch(new Request(`https://auth.murage.test${path}`, { method, headers: h, body: method === "POST" ? "{}" : undefined }), testEnv(), ctx);
          await waitOnExecutionContext(ctx);
          expect([value, method, path, response.status]).toEqual([value, method, path, 404]);
        }
      }
    }
  });

  it("switched on, the same routes are live again (a session is required, the admin token works)", async () => {
    await setupKeys();
    extra = { CLOUD_FLUX_ROUTES_ENABLED: "1" };
    expect((await call("POST", "/v1/flux/link/start", null)).status).toBe(401);
    expect((await call("POST", "/v1/internal/flux/plan", null, { homeId: HOME, plan: "pro" })).status).toBe(401);
  });

});

// Wiring step 3: the Flux owner routes on the Supabase identity (Astra B4-PORT P1, ruling A of ASTRA-WP5-P4-CP-2). Worker-level:
// real members-area tokens (JWKS-verified), the real Cloud-scope binding and the real trusted step-up gate.
describe("wiring step 3: Flux owner routes on the Supabase Cloud account", () => {
  const OWNER_ROUTES: [string, string, unknown?][] = [
    ["POST", "/v1/flux/link/start"], ["POST", "/v1/flux/link/complete", { state: "s".repeat(43), proof: "p.q" }], ["GET", "/v1/flux/link"],
    ["DELETE", "/v1/flux/link"], ["GET", `/v1/homes/${HOME}/flux`], ["POST", `/v1/homes/${HOME}/flux/subkey`, {}],
    ["POST", `/v1/homes/${HOME}/flux/cap`, { capUsd: 50 }], ["POST", `/v1/homes/${HOME}/flux/stop`, {}],
  ];
  const linkState = async (ownerId: string) => ({
    challenges: (await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_link_challenges WHERE owner_user_id=?").bind(ownerId).first<{ n: number }>())!.n,
    links: (await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_links WHERE owner_user_id=?").bind(ownerId).first<{ n: number }>())!.n,
  });
  const mappedId = async (sub: string) => (await env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(sub).first<{ user_id: string }>())!.user_id;

  it("step 3: a Supabase Cloud owner (mapped Cloud account id) can link, mint, cap and Stop their own home", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    expect(owner.userId).toBe(await mappedId(owner.sub));
    await seedHome(owner.userId);
    await link(owner.token);
    // The link and its challenge are stored under the mapped Cloud account id (supabase_identities.user_id).
    expect(await linkState(owner.userId)).toMatchObject({ links: 1 });
    expect((await linkState(owner.userId)).challenges)
      .toBe((await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_link_challenges").first<{ n: number }>())!.n);
    const status = await call("GET", "/v1/flux/link", owner.token);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ linked: true, fluxAccountHint: FLUX_ACCOUNT.slice(-4) });
    const minted = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect(minted.status).toBe(200);
    expect(flux.mints.map((m) => [m.homeId, m.accountId])).toEqual([[HOME, FLUX_ACCOUNT]]);
    const cap = await call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, { capUsd: 55 });
    expect(await cap.json()).toEqual({ capUsd: 55, enabled: true });
    expect(flux.caps.map((c) => [c.homeId, c.capMicrocents])).toEqual([[HOME, 55_000_000]]);
    expect((await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).status).toBe(200);
    expect((await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {})).status).toBe(200);
    expect(flux.stops).toEqual([HOME]);
    expect((await homeRow())?.state).toBe("stopped");
  });

  it("step 3: a Better Auth companion bearer is refused on every Flux owner route (401), with no link state created under a companion id", async () => {
    await setupKeys();
    const companion = await companionSignIn("companion@example.test");
    // Even a home recorded under the companion id (and a real link proof) gets the companion nowhere.
    await seedHome(companion.userId);
    const before = await linkState(companion.userId);
    for (const [method, path, body] of OWNER_ROUTES) {
      const response = await call(method, path, companion.token, body);
      expect([method, path, response.status, await response.json()]).toEqual([method, path, 401, { error: "unauthorized" }]);
    }
    const proof = await signedProof("x".repeat(43));
    expect((await call("POST", "/v1/flux/link/complete", companion.token, { state: "x".repeat(43), proof })).status).toBe(401);
    expect(before).toEqual({ challenges: 0, links: 0 });
    expect(await linkState(companion.userId)).toEqual({ challenges: 0, links: 0 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_links").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_link_challenges").first<{ n: number }>())!.n).toBe(0);
    expect([flux.mints, flux.caps, flux.stops]).toEqual([[], [], []]);
  });

  it("step 3: a Supabase member who does not own the home gets 404 on /v1/homes/:id/flux*, identical to an unknown home", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    const other = await signIn("other@example.test");
    await link(other.token, "22222222-3333-4444-5555-666666666666"); // a linked member, stepped up: still not the owner
    for (const [method, action, body] of [["GET", ""], ["POST", "/subkey", {}], ["POST", "/cap", { capUsd: 50 }], ["POST", "/stop", {}]] as [string, string, unknown?][]) {
      const theirs = await call(method, `/v1/homes/${HOME}/flux${action}`, other.token, body);
      const unknown = await call(method, `/v1/homes/home-nobody/flux${action}`, other.token, body);
      const a = [theirs.status, await theirs.text()];
      expect([method, action, ...a]).toEqual([method, action, 404, JSON.stringify({ error: "not_found" })]);
      expect([method, action, unknown.status, await unknown.text()]).toEqual([method, action, ...a]);
    }
    expect([flux.mints, flux.caps, flux.stops]).toEqual([[], [], []]);
  });

  it("step 3: link start/complete, subkey, cap and stop need a fresh trusted second factor: missing, stale (outside the window) or untrusted factor is 403 step_up_required", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    const stale = await stepUpToken(owner.sub, owner.email, { ageS: 3700 }); // older than any allowed window (60..3600 s)
    // A member whose factor was never put on the trusted list (cloud_trusted_factors).
    const untrustedMember = await cloudMember("untrusted@example.test");
    const untrusted = await stepUpToken(untrustedMember.sub, "untrusted@example.test");
    await seedHome(untrustedMember.userId, { homeId: "home-untrusted" });
    const start = await (await call("POST", "/v1/flux/link/start", owner.token)).json<{ state: string }>();
    const proof = await signedProof(start.state);
    const gated: [string, unknown, string?][] = [
      ["/v1/flux/link/start", undefined], ["/v1/flux/link/complete", { state: start.state, proof }],
      [`/v1/homes/${HOME}/flux/subkey`, {}], [`/v1/homes/${HOME}/flux/cap`, { capUsd: 50 }], [`/v1/homes/${HOME}/flux/stop`, {}],
    ];
    const refused = async (token: string, path: string, body: unknown, reason: string) => {
      const response = await call("POST", path, token, body);
      const out = await response.json<{ error: string; step_up?: { reason: string } }>();
      expect([path, reason, response.status, out.error, out.step_up?.reason]).toEqual([path, reason, 403, "step_up_required", reason]);
    };
    for (const [path, body] of gated) {
      await refused(aal1, path, body, "aal1");
      await refused(stale, path, body, "stale");
      await refused(untrusted, path.replace(HOME, "home-untrusted"), body, "untrusted_factor");
    }
    // A factor Supabase no longer lists as verified (removed after the session was made) is untrusted too.
    unverified.add(owner.sub);
    for (const [path, body] of gated) await refused(owner.token, path, body, "untrusted_factor");
    unverified.delete(owner.sub);
    // Nothing happened: no link, no key, no cap, no Stop.
    expect((await linkState(owner.userId)).links).toBe(0);
    expect((await linkState(untrustedMember.userId))).toEqual({ challenges: 0, links: 0 });
    expect([flux.mints, flux.caps, flux.stops]).toEqual([[], [], []]);
    // Sign-in only: link status.
    expect((await call("GET", "/v1/flux/link", aal1)).status).toBe(200);
    // The fresh trusted factor passes, and the challenge the gate held back still completes.
    const done = await call("POST", "/v1/flux/link/complete", owner.token, { state: start.state, proof });
    expect(done.status).toBe(200);
    expect(await linkState(owner.userId)).toMatchObject({ links: 1 });
    // Sign-in only too: the home's status.
    expect((await call("GET", `/v1/homes/${HOME}/flux`, aal1)).status).toBe(200);
  });

  it("step 3: grants resolve flux_links by the mapped Cloud account id and only a link with fenced=0", async () => {
    const { fluxRecipientOf, linkOf } = await import("../src/flux-link");
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    // A pre-step-3 style row under a companion id (another Flux account): no grant may ever reach it.
    const companion = await companionSignIn("companion@example.test");
    expect(companion.userId).not.toBe(owner.userId);
    await env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,?,?,?,1,0)")
      .bind(companion.userId, "99999999-8888-7777-6666-555555555555", Date.now(), "companionlink0000000000000000000").run();
    expect(await fluxRecipientOf(env, HOME)).toBe(FLUX_ACCOUNT);
    const granted = await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_step3_1", ...period() });
    expect(await granted.json()).toMatchObject({ status: "done", amountUsd: 10 });
    expect(flux.grants.map((g) => g.recipientFluxAccountId)).toEqual([FLUX_ACCOUNT]);
    // Fenced (being unlinked): counts as no link for the keys and the grants clients alike.
    await env.DB.prepare("UPDATE flux_links SET fenced=1 WHERE owner_user_id=?").bind(owner.userId).run();
    expect(await linkOf(env, owner.userId)).toBeNull();
    expect(await fluxRecipientOf(env, HOME)).toBeNull();
    const held = await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_step3_2", ...period(31) });
    expect((await held.json<{ status: string }>()).status).not.toBe("done");
    expect(flux.grants.map((g) => g.recipientFluxAccountId)).toEqual([FLUX_ACCOUNT]);
  });

  it("step 3: with the switch off every owner route is still 404 for a stepped-up Cloud owner, and nothing is written", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    for (const value of [undefined, "0"]) {
      extra = { CLOUD_FLUX_ROUTES_ENABLED: value };
      for (const [method, path, body] of OWNER_ROUTES) {
        const response = await call(method, path, owner.token, body);
        // Astra JOURNEY-A-10 #4: spending Off (cap or stop) tells the owner plainly that Flux is unavailable and that nothing changed.
        const want = fluxOffStubRoute(method, path) ? [200, { state: "flux_unavailable", fluxAvailable: false, changed: false, message: FLUX_OFF_MESSAGE }]
          : [404, { error: "not_found" }];
        expect([value, method, path, response.status, await response.json()]).toEqual([value, method, path, ...want]);
        if (fluxOffStubRoute(method, path)) {
          // Unauthenticated: still refused (401/403), never the answer.
          expect([401, 403]).toContain((await call(method, path, null, body)).status);
        }
      }
    }
    expect(FLUX_OFF_MESSAGE).not.toMatch(/stopped|switched off|turned off\b/i); // no false stop promise
    expect(await linkState(owner.userId)).toEqual({ challenges: 0, links: 0 });
    // No Flux call and no Flux row (Astra JOURNEY-A-10 #4: the probe answered 404 before this fix).
    expect([flux.mints, flux.caps, flux.stops]).toEqual([[], [], []]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_home_keys").first<{ n: number }>())!.n).toBe(0);
  });

  it("Astra JOURNEY-A-11 #1: with Flux off, an owner WITHOUT a fresh step-up gets the plain answer on both cap and stop; others are refused", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    const other = await signIn("other@example.test");
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    const otherAal1 = await stepUpToken(other.sub, other.email, { aal1: true });
    for (const value of [undefined, "0"]) {
      extra = { CLOUD_FLUX_ROUTES_ENABLED: value };
      for (const [path, body] of [[`/v1/homes/${HOME}/flux/stop`, {}], [`/v1/homes/${HOME}/flux/cap`, { capUsd: 0 }]] as const) {
        // The probe: /stop answered 403 step_up_required here before the fix (only /cap was exempt).
        const response = await call("POST", path, aal1, body);
        expect([value, path, response.status, await response.json()])
          .toEqual([value, path, 200, { state: "flux_unavailable", fluxAvailable: false, changed: false, message: FLUX_OFF_MESSAGE }]);
        // Authentication and ownership still hold: no session is 401/403; another account's sign-in is never the answer.
        expect([401, 403]).toContain((await call("POST", path, null, body)).status);
        const foreign = await call("POST", path, otherAal1, body);
        expect([403, 404]).toContain(foreign.status);
        expect((await foreign.json<{ state?: string }>()).state).toBeUndefined();
      }
    }
    expect([flux.mints, flux.caps, flux.stops]).toEqual([[], [], []]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_home_keys").first<{ n: number }>())!.n).toBe(0);
  });

  const grantRow = (grantId: string) => env.DB.prepare("SELECT * FROM flux_grants WHERE grant_id=?").bind(grantId).first<Record<string, unknown>>();
  const openHeldAlert = () => env.DB.prepare("SELECT json_extract(detail,'$.reason') AS reason,json_extract(detail,'$.grantId') AS grantId FROM cloud_alerts WHERE home_id=? AND kind='flux.grant_held' AND resolved_at IS NULL")
    .bind(HOME).first<{ reason: string; grantId: string }>();
  /** A $10 grant whose delivery reached Flux (the credit exists) but whose answer was lost, then an AAL1 (sign-in only) unlink. */
  const ackLostThenAal1Unlink = async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    expect((await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {})).status).toBe(200);
    flux.grantAckLost = true;
    const first = await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_acklost_1", ...period() });
    expect(await first.json()).toMatchObject({ status: "pending", amountUsd: 10 });
    flux.grantAckLost = false;
    expect(flux.credits.has("inv:in_acklost_1")).toBe(true);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    const unlinked = await call("DELETE", "/v1/flux/link", aal1);
    expect([unlinked.status, await unlinked.json()]).toEqual([200, { linked: false, stoppedHomes: 1 }]);
    expect(flux.stops).toEqual([HOME]); // keys fenced: cancellation-like, sign-in only
    // The paid credit is NOT forfeited: not cancelled, no reversal, recipient frozen, no attempt burned, held for review.
    expect(await grantRow("inv:in_acklost_1")).toMatchObject({ status: "pending", recipient_flux_account_id: FLUX_ACCOUNT,
      attempts: 1, last_error: "grant_held:recipient_unlinked" });
    expect(await openHeldAlert()).toEqual({ reason: "recipient_unlinked", grantId: "inv:in_acklost_1" });
    clock += 11 * 60_000;
    await sweepFlux(testEnv(), deps); // while unlinked nothing is sent, nothing burned
    expect(flux.revokes).toEqual([]);
    expect(flux.credits.has("inv:in_acklost_1")).toBe(true);
    expect(await grantRow("inv:in_acklost_1")).toMatchObject({ status: "pending", attempts: 1 });
    return owner;
  };

  it("Astra FLUX-STEP3 #1: an AAL1 unlink never destroys a paid grant; relinking the same Flux account and replaying the invoice settles it once", async () => {
    const owner = await ackLostThenAal1Unlink();
    await link(owner.token);
    const replay = await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_acklost_1", ...period() });
    expect(await replay.json()).toMatchObject({ status: "done", amountUsd: 10 });
    const row = await grantRow("inv:in_acklost_1");
    expect(row).toMatchObject({ status: "done", recipient_flux_account_id: FLUX_ACCOUNT, last_error: null, attempts: 2 });
    // Flux answered the redelivery as already granted: ONE credit, to the original recipient, never revoked.
    expect(flux.grants.map((g) => [g.grantId, g.recipientFluxAccountId])).toEqual([["inv:in_acklost_1", FLUX_ACCOUNT]]);
    expect(flux.deliveries.map((d) => d.grantId)).toEqual(["inv:in_acklost_1", "inv:in_acklost_1"]);
    expect(flux.revokes).toEqual([]);
    // Entitlement consistent: the period counts exactly the credit that exists, and a second invoice in it grants nothing.
    const ent = await env.DB.prepare("SELECT granted_microcents AS g FROM flux_entitlements WHERE home_id=? AND period_start=?").bind(HOME, PERIOD_START).first<{ g: number }>();
    expect(ent?.g).toBe(row!.amount_microcents);
    expect(ent?.g).toBe(flux.credits.get("inv:in_acklost_1"));
    expect(await (await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_acklost_2", ...period() })).json())
      .toMatchObject({ status: "duplicate_period", amountUsd: 0 });
    expect(await openHeldAlert()).toBeNull(); // released
  });

  it("Astra FLUX-STEP3 #1: a relink to a DIFFERENT Flux account never moves the paid grant; it stays held for operator review", async () => {
    const owner = await ackLostThenAal1Unlink();
    const other = "77777777-2222-3333-4444-555555555555";
    await link(owner.token, other);
    const replay = await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_acklost_1", ...period() });
    expect(await replay.json()).toMatchObject({ status: "pending" });
    clock += 11 * 60_000;
    await sweepFlux(testEnv(), deps);
    expect(await grantRow("inv:in_acklost_1")).toMatchObject({ status: "pending", recipient_flux_account_id: FLUX_ACCOUNT,
      attempts: 1, last_error: "grant_held:recipient_mismatch" });
    expect(flux.grants.map((g) => g.recipientFluxAccountId)).toEqual([FLUX_ACCOUNT]); // nothing ever sent to the new account
    expect(flux.deliveries).toHaveLength(1);
    expect(flux.revokes).toEqual([]);
    expect(await openHeldAlert()).toEqual({ reason: "recipient_mismatch", grantId: "inv:in_acklost_1" });
  });

  it("Astra FLUX-STEP3 #2: on the CP0 staging rig a companion-owned machine_owners home with a leftover companion link has no owner and no recipient; its grants are held", async () => {
    const { fluxRecipientOf, homeOwnerOf } = await import("../src/flux-link");
    const { composeFrozenBody } = await import("../src/flux-grants");
    await setupKeys();
    const companion = await companionSignIn("companion@example.test");
    extra = { CLOUD_CP0_STAGING: "1" };
    const staging = testEnv();
    const STAGED = "home-cp0-staged";
    // No live cloud_homes row; the machine is assigned to the companion id, which still has a pre-step-3 link.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO machine_owners (machine_id,owner_user_id,assigned_at) VALUES (?,?,?)").bind(STAGED, companion.userId, Date.now()),
      env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,?,?,?,1,0)")
        .bind(companion.userId, "99999999-8888-7777-6666-555555555555", Date.now(), "companionlink0000000000000000000"),
    ]);
    expect(await homeOwnerOf(staging, STAGED)).toBeNull();
    expect(await fluxRecipientOf(staging, STAGED)).toBeNull();
    // The WP5 grants client freezes no body: held recipient_unlinked.
    expect(await composeFrozenBody(staging, { homeId: STAGED, plan: "starter", invoiceId: "in_cp0_1", ...period() })).toEqual({ held: "recipient_unlinked" });
    // The B4 keys client records the grant with no recipient and delivers nothing.
    const held = await admin("/v1/internal/flux/grant", { homeId: STAGED, plan: "starter", invoiceId: "in_cp0_2", ...period() });
    expect(await held.json()).toMatchObject({ status: "pending" });
    expect(await grantRow("inv:in_cp0_2")).toMatchObject({ status: "pending", recipient_flux_account_id: null, attempts: 0 });
    clock += 11 * 60_000;
    await sweepFlux(staging, deps);
    expect(flux.grants).toEqual([]);
    expect(flux.deliveries).toEqual([]);
    // The staging fallback itself is kept, fail-closed: a mapped Cloud account still owns its assigned staging machine, and
    // only while CLOUD_CP0_STAGING is "1".
    const member = await cloudMember("staged@example.test");
    await env.DB.prepare("INSERT INTO machine_owners (machine_id,owner_user_id,assigned_at) VALUES ('home-cp0-mapped',?,?)").bind(member.userId, Date.now()).run();
    expect(await homeOwnerOf(staging, "home-cp0-mapped")).toBe(member.userId);
    expect(await homeOwnerOf({ ...staging, CLOUD_CP0_STAGING: undefined } as Env, "home-cp0-mapped")).toBeNull();
  });

  it("Astra FLUX-STEP3 #3: under CP0 staging, a foreign home, a foreign staged machine and an unknown home answer byte-identical 404s, headers included", async () => {
    await setupKeys();
    extra = { CLOUD_CP0_STAGING: "1" };
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    const stagedOwner = await cloudMember("staged-owner@example.test");
    await env.DB.prepare("INSERT INTO machine_owners (machine_id,owner_user_id,assigned_at) VALUES ('home-cp0-foreign',?,?)").bind(stagedOwner.userId, Date.now()).run();
    const other = await signIn("other@example.test");
    // Everything but the per-request id, which is random for every answer and says nothing about the home.
    const snapshot = async (response: Response) => {
      const headers: [string, string][] = [];
      response.headers.forEach((value, name) => { if (name !== "x-request-id") headers.push([name, value]); });
      return [response.status, headers, await response.text()];
    };
    for (const [method, action, body] of [["GET", ""], ["POST", "/subkey", {}], ["POST", "/cap", { capUsd: 50 }], ["POST", "/stop", {}]] as [string, string, unknown?][]) {
      const theirs = await snapshot(await call(method, `/v1/homes/${HOME}/flux${action}`, other.token, body));
      const staged = await snapshot(await call(method, `/v1/homes/home-cp0-foreign/flux${action}`, other.token, body));
      const unknown = await snapshot(await call(method, `/v1/homes/home-nobody/flux${action}`, other.token, body));
      expect(theirs[0]).toBe(404);
      expect(theirs[2]).toBe(JSON.stringify({ error: "not_found" }));
      expect((theirs[1] as [string, string][]).some(([k]) => k === "server-timing" || k === "x-d1-bookmark")).toBe(false);
      expect([method, action, staged]).toEqual([method, action, theirs]);
      expect([method, action, unknown]).toEqual([method, action, theirs]);
    }
    // The owner's own answers keep their telemetry.
    expect((await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).headers.get("server-timing")).toMatch(/^d1;dur=/);
    expect([flux.mints, flux.caps, flux.stops]).toEqual([[], [], []]);
  });
});

describe("the Flux cron while off or unconfigured (Astra B4-PORT P2)", () => {
  it("off: only the ledger's accounting runs (INTEGRATED-10): a linked pending grant keeps attempts 0 across three sweeps, unclaimed, no reversal, no dispatch", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    const held = await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_cron_off_1", ...period() });
    expect(await held.json()).toMatchObject({ status: "pending" });
    await link(owner.token);
    const row = () => env.DB.prepare("SELECT * FROM flux_grants").first<Record<string, unknown>>();
    const before = await row();
    // INTEGRATED-10 P2: examined while unbound, it was stamped (it waits its retry interval like every other grant).
    expect(before).toMatchObject({ status: "pending", attempts: 0, claim_id: null, last_attempt_at: clock });
    const unconfigured: Record<string, string | undefined>[] = [
      { CLOUD_FLUX_ROUTES_ENABLED: undefined }, { CLOUD_FLUX_ROUTES_ENABLED: "0" },
      { FLUX_CLOUD_SERVICE_TOKEN: undefined }, { FLUX_CLOUD_SERVICE_TOKEN: "short" },
      { FLUX_API_BASE: undefined }, { FLUX_API_BASE: "" }, { FLUX_API_BASE: "http://api.fluxrouter.test" },
    ];
    for (const settings of unconfigured) {
      extra = settings;
      const seen: string[] = [];
      dbHook = (sql) => { seen.push(sql); };
      for (let i = 0; i < 3; i++) {
        clock += 11 * 60_000;
        await sweepFlux(testEnv(), { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
        // The real client too: unconfigured, it refuses every call, and the sweep must not spend attempts on that.
        await sweepFlux(testEnv(), { now: () => clock });
      }
      dbHook = null;
      // INTEGRATED-10: off, the sweep keeps only the ledger's accounting: no claim, no dispatch, no outbox or op change, no router call.
      const writes = seen.join("\n");
      expect([settings, /flux_grant_dispatches \(|UPDATE flux_grants|flux_home_ops|flux_home_keys SET/.test(writes)]).toEqual([settings, false]);
      expect([settings, /flux_ledger_cursors/.test(writes)]).toEqual([settings, true]);
      expect(await row()).toEqual(before);
      expect(flux.grants).toHaveLength(0);
    }
    // Configured and on: the same grant was due all along, and is delivered once.
    extra = {};
    clock += 11 * 60_000;
    await sweepFlux(testEnv(), { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect(flux.grants).toHaveLength(1);
    expect(await row()).toMatchObject({ status: "done", recipient_flux_account_id: FLUX_ACCOUNT });
  });
});

describe("config", () => {
  it("holds the plan face values as config, with the defaults Sean set", () => {
    expect(DEFAULT_FLUX_CONFIG.plans).toEqual({
      starter: { creditsUsd: 10 }, pro: { creditsUsd: 20 }, max: { creditsUsd: 40 },
      team: { creditsUsd: 50, pooled: true }, business: { creditsUsd: 200, pooled: true },
    });
    expect(defaultCapUsd(DEFAULT_FLUX_CONFIG, "starter")).toBe(30);
    expect(defaultCapUsd(DEFAULT_FLUX_CONFIG, "max")).toBe(120);
    const custom = readFluxConfig({ FLUX_B4_CONFIG: JSON.stringify({ ...DEFAULT_FLUX_CONFIG, plans: { starter: { creditsUsd: 12 } } }) });
    expect(custom.plans.starter.creditsUsd).toBe(12);
    expect(defaultCapUsd(custom, "starter")).toBe(36);
  });
  it("refuses a set-but-broken config instead of falling back", () => {
    expect(() => readFluxConfig({ FLUX_B4_CONFIG: "{" })).toThrow();
    expect(() => readFluxConfig({ FLUX_B4_CONFIG: JSON.stringify({ ...DEFAULT_FLUX_CONFIG, defaultPlan: "nope" }) })).toThrow();
    expect(() => readFluxConfig({ FLUX_B4_CONFIG: JSON.stringify({ ...DEFAULT_FLUX_CONFIG, extra: 1 }) })).toThrow();
    expect(() => readFluxConfig({ FLUX_B4_CONFIG: JSON.stringify({ ...DEFAULT_FLUX_CONFIG, minCapUsd: 50, maxCapUsd: 10 }) })).toThrow();
  });
});

describe("linking a Murage account to a Flux account", () => {
  it("needs a Murage session on every account route", async () => {
    await setupKeys();
    for (const [method, path] of [["POST", "/v1/flux/link/start"], ["POST", "/v1/flux/link/complete"], ["GET", "/v1/flux/link"], ["DELETE", "/v1/flux/link"], ["GET", `/v1/homes/${HOME}/flux`], ["POST", `/v1/homes/${HOME}/flux/subkey`]]) {
      expect((await call(method, path, null, {})).status).toBe(401);
    }
  });

  it("starts with a one-time state whose hash alone is stored, then links on a signed Flux proof", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    const start = await call("POST", "/v1/flux/link/start", owner.token);
    expect(start.status).toBe(200);
    const { state, authorizeUrl } = await start.json<{ state: string; authorizeUrl: string }>();
    expect(authorizeUrl.startsWith("https://")).toBe(true);
    expect(new URL(authorizeUrl).searchParams.get("state")).toBe(state);
    const stored = await env.DB.prepare("SELECT state_hash FROM flux_link_challenges").all<{ state_hash: string }>();
    expect(stored.results).toEqual([{ state_hash: await sha256(state) }]);
    const done = await call("POST", "/v1/flux/link/complete", owner.token, { state, proof: await signedProof(state) });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ linked: true, fluxAccountHint: FLUX_ACCOUNT.slice(-4) });
    const status = await (await call("GET", "/v1/flux/link", owner.token)).json<Record<string, unknown>>();
    expect(status.linked).toBe(true);
    expect(JSON.stringify(status)).not.toContain(FLUX_ACCOUNT);
  });

  it("refuses a proof that is replayed, forged, for another state, wrong audience or expired", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    const start = async () => (await (await call("POST", "/v1/flux/link/start", owner.token)).json<{ state: string }>()).state;
    const complete = (state: string, proof: string) => call("POST", "/v1/flux/link/complete", owner.token, { state, proof });

    const s1 = await start();
    const proof = await signedProof(s1);
    expect((await complete(s1, proof)).status).toBe(200);
    expect((await complete(s1, proof)).status).toBe(400); // state and proof are both spent

    const s2 = await start();
    expect((await complete(s2, await signedProof(s2, {}, true))).status).toBe(400); // forged signature
    const s3 = await start();
    expect((await complete(s3, await signedProof(s2))).status).toBe(400); // proof for a different state
    const s4 = await start();
    expect((await complete(s4, await signedProof(s4, { aud: "someone-else" }))).status).toBe(400);
    const s5 = await start();
    expect((await complete(s5, await signedProof(s5, { exp: Math.floor(clock / 1000) - 1 }))).status).toBe(400);
    const s6 = await start();
    expect((await complete(s6, await signedProof(s6, { iat: Math.floor(clock / 1000) - 3600, exp: Math.floor(clock / 1000) + 3600 }))).status).toBe(400);
    const s7 = await start();
    const reusedJti = await signedProof(s7, { jti: JSON.parse(atob(proof.split(".")[0].replaceAll("-", "+").replaceAll("_", "/"))).jti });
    expect((await complete(s7, reusedJti)).status).toBe(400); // a proof id works once
    expect((await complete("not-a-known-state-0123456789", await signedProof("not-a-known-state-0123456789"))).status).toBe(400);
    expect((await complete(s7, "garbage")).status).toBe(400);
  });

  it("will not let a different Murage account use someone else's challenge", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    const thief = await signIn("thief@example.test");
    const { state } = await (await call("POST", "/v1/flux/link/start", owner.token)).json<{ state: string }>();
    expect((await call("POST", "/v1/flux/link/complete", thief.token, { state, proof: await signedProof(state) })).status).toBe(400);
  });

  it("expires an unused challenge", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    const { state } = await (await call("POST", "/v1/flux/link/start", owner.token)).json<{ state: string }>();
    await env.DB.prepare("UPDATE flux_link_challenges SET expires_at=?").bind(clock - 1).run();
    expect((await call("POST", "/v1/flux/link/complete", owner.token, { state, proof: await signedProof(state) })).status).toBe(400);
  });

  it("is one Flux account per Murage account, both ways", async () => {
    await setupKeys();
    const a = await signIn("a@example.test");
    const b = await signIn("b@example.test");
    await link(a.token);
    const again = await (await call("POST", "/v1/flux/link/start", a.token)).json<{ state: string }>();
    const other = "99999999-2222-3333-4444-555555555555";
    expect((await call("POST", "/v1/flux/link/complete", a.token, { state: again.state, proof: await signedProof(again.state, { flux_account_id: other }) })).status).toBe(409);
    const second = await (await call("POST", "/v1/flux/link/start", b.token)).json<{ state: string }>();
    expect((await call("POST", "/v1/flux/link/complete", b.token, { state: second.state, proof: await signedProof(second.state) })).status).toBe(409);
    expect(await (await call("GET", "/v1/flux/link", b.token)).json()).toEqual({ linked: false });
  });

  it("says so, with a 503, when the Flux public key is not configured", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    const { state } = await (await call("POST", "/v1/flux/link/start", owner.token)).json<{ state: string }>();
    extra = { FLUX_LINK_PUBLIC_KEY: "" };
    expect((await call("POST", "/v1/flux/link/complete", owner.token, { state, proof: await signedProof(state) })).status).toBe(503);
  });
});

describe("a Flux key for one home", () => {
  it("needs the account linked and the machine bound, and never reveals foreign homes", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    const stranger = await signIn("stranger@example.test");
    await seedHome(owner.userId);
    expect((await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {})).status).toBe(409);
    expect((await (await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {})).json<{ error: string }>()).error).toBe("flux_not_linked");
    await link(owner.token);
    const foreign = await call("POST", `/v1/homes/${HOME}/flux/subkey`, stranger.token, {});
    const unknown = await call("POST", "/v1/homes/no-such-home/flux/subkey", stranger.token, {});
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe(await unknown.text());
    expect(flux.mints).toHaveLength(0);
    await env.DB.prepare("UPDATE cloud_machines SET bound_ips=NULL").run();
    expect((await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {})).status).toBe(409);
  });

  it("issues a capped, expiring key bound to the machine's IPs, once, and stores no secret", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    const response = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json<{ key: string; generation: number; expiresAt: string; capUsd: number }>();
    expect(body.key.startsWith("sk-flux-home-")).toBe(true);
    expect(body.generation).toBe(1);
    expect(body.capUsd).toBe(30);
    expect(flux.mints).toEqual([{
      accountId: FLUX_ACCOUNT, homeId: HOME, generation: 1, boundIps: [HOME_IP], capMicrocents: 30_000_000, ttlSeconds: 35 * 86_400,
      lifecycleVersion: 1, ownerResume: true, opId: expect.stringMatching(/^owner:home-flux:/),
      linkId: expect.stringMatching(/^[0-9a-f]{32}$/), linkVersion: 1, capVersion: 1, billingState: "ok",
    }]);
    const row = await homeRow();
    expect(row).toMatchObject({ generation: 1, state: "active", cap_microcents: 30_000_000, cap_custom: 0, plan: "starter" });
    for (const table of ["flux_home_keys", "flux_links", "flux_grants", "flux_link_challenges"]) {
      expect(JSON.stringify((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results)).not.toContain(body.key);
    }
  });

  it("re-issues with a higher generation, and recovers when Flux is ahead of us", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    const second = await (await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {})).json<{ generation: number }>();
    expect(second.generation).toBe(2);
    flux.conflictOnce = "generation must be greater than 7";
    const third = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect((await third.json<{ generation: number }>()).generation).toBe(8);
    expect((await homeRow())?.generation).toBe(8);
  });

  it("changes nothing when Flux is down", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    flux.down = true;
    const response = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect(response.status).toBe(502);
    expect((await response.json<{ error: string }>()).error).toBe("flux_unavailable");
    expect((await homeRow())?.generation).toBe(0);
    expect((await homeRow())?.state).toBe("none");
  });

  it("lets the home itself RENEW its key with its machine credential, generation and IP, never resume", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await env.DB.prepare("UPDATE cloud_machines SET credential_hash=? WHERE id=?").bind(await sha256(MACHINE_TOKEN), HOME).run();
    const ip = { "CF-Connecting-IP": HOME_IP };
    const renew = (token = MACHINE_TOKEN, generation = 1, headers: Record<string, string> = ip) =>
      call("POST", `/v1/machines/${HOME}/flux/subkey`, token, { generation }, headers);
    // A home with no key yet is not active: a machine cannot be the first minter.
    expect((await renew()).status).toBe(409);
    expect(flux.mints).toHaveLength(0);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    // Fresh key: renewal is not due.
    const early = await renew();
    expect(early.status).toBe(409);
    expect((await early.json<{ error: string }>()).error).toBe("renewal_not_due");
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock + 3 * DAY, HOME).run();
    const ok = await renew();
    expect(ok.status).toBe(200);
    expect((await ok.json<{ key: string }>()).key.startsWith("sk-flux-home-")).toBe(true);
    expect(flux.mints.at(-1)).toMatchObject({ ownerResume: false, opId: `renew:${HOME}:1:1` });
    expect((await renew(MACHINE_TOKEN, 1, { "CF-Connecting-IP": "198.51.100.9" })).status).toBe(403);
    expect((await renew(MACHINE_TOKEN, 2)).status).toBe(401);
    expect((await renew("wrong-credential-0123456789abcdef")).status).toBe(401);
    expect((await renew(owner.token)).status).toBe(401);
    expect(flux.mints).toHaveLength(2);
  });

  it("rejects a replayed renewal operation instead of minting again", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await env.DB.prepare("UPDATE cloud_machines SET credential_hash=? WHERE id=?").bind(await sha256(MACHINE_TOKEN), HOME).run();
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock + DAY, HOME).run();
    await env.DB.prepare("INSERT INTO flux_mint_ops (op_id,home_id,created_at) VALUES (?,?,?)").bind(`renew:${HOME}:1:1`, HOME, clock).run();
    const replay = await call("POST", `/v1/machines/${HOME}/flux/subkey`, MACHINE_TOKEN, { generation: 1 }, { "CF-Connecting-IP": HOME_IP });
    expect(replay.status).toBe(409);
    expect((await replay.json<{ error: string }>()).error).toBe("renewal_replayed");
    expect(flux.mints).toHaveLength(1);
    // A renewal that fails at Flux frees its operation identity so it can be retried.
    await env.DB.prepare("DELETE FROM flux_mint_ops").run();
    flux.down = true;
    expect((await call("POST", `/v1/machines/${HOME}/flux/subkey`, MACHINE_TOKEN, { generation: 1 }, { "CF-Connecting-IP": HOME_IP })).status).toBe(502);
    flux.down = false;
    expect((await call("POST", `/v1/machines/${HOME}/flux/subkey`, MACHINE_TOKEN, { generation: 1 }, { "CF-Connecting-IP": HOME_IP })).status).toBe(200);
  });

  it("hole 11: a renewal mint does not advance the recorded expiry until the poller acks delivery", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await env.DB.prepare("UPDATE cloud_machines SET credential_hash=? WHERE id=?").bind(await sha256(MACHINE_TOKEN), HOME).run();
    const ip = { "CF-Connecting-IP": HOME_IP };
    const post = (path: string, body: unknown, token = MACHINE_TOKEN) => call("POST", `/v1/machines/${HOME}/flux/${path}`, token, body, ip);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    const dueAt = clock + DAY;
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(dueAt, HOME).run();
    const due = await (await post("renewal-due", { generation: 1 })).json<{ due: boolean; op_id: string }>();
    expect(due).toEqual({ due: true, op_id: `renew:${HOME}:1:1` });
    // Mint with the named operation: the old expiry stands, renewal is still due, and the new key waits for its ack.
    const minted = await post("subkey", { generation: 1, op_id: due.op_id });
    expect(minted.status).toBe(200);
    const body = await minted.json<{ key: string; generation: number; expiresAt: string; capUsd: number }>();
    expect(Object.keys(body).sort()).toEqual(["capUsd", "expiresAt", "generation", "key"]);
    expect((await homeRow())?.key_expires_at).toBe(dueAt);
    const stillDue = await (await post("renewal-due", { generation: 1 })).json<{ due: boolean; op_id: string }>();
    expect(stillDue).toEqual({ due: true, op_id: `renew:${HOME}:1:${body.generation}` });
    // A stale or foreign operation name is not acknowledged; a bad credential is refused.
    expect((await post("subkey/ack", { generation: 1, op_id: `renew:${HOME}:1:77` })).status).toBe(409);
    expect((await post("subkey/ack", { generation: 1, op_id: due.op_id, key_generation: body.generation + 5 })).status).toBe(409);
    expect((await post("subkey/ack", { generation: 1, op_id: due.op_id }, "wrong-credential-0123456789abcdef")).status).toBe(401);
    expect((await homeRow())?.key_expires_at).toBe(dueAt);
    // The ack moves the expiry; a repeat of it (a lost response) is still 200; renewal is no longer due.
    const ack = await post("subkey/ack", { generation: 1, op_id: due.op_id, key_generation: body.generation });
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ acked: true });
    expect((await homeRow())?.key_expires_at).toBe(Date.parse(body.expiresAt));
    expect((await post("subkey/ack", { generation: 1, op_id: due.op_id })).status).toBe(200);
    expect(await (await post("renewal-due", { generation: 1 })).json()).toEqual({ due: false });
  });

  it("hole 11: an unacknowledged renewal can be redone: the next attempt gets a new operation and a higher generation", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await env.DB.prepare("UPDATE cloud_machines SET credential_hash=? WHERE id=?").bind(await sha256(MACHINE_TOKEN), HOME).run();
    const ip = { "CF-Connecting-IP": HOME_IP };
    const post = (path: string, body: unknown) => call("POST", `/v1/machines/${HOME}/flux/${path}`, MACHINE_TOKEN, body, ip);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock + DAY, HOME).run();
    expect((await post("subkey", { generation: 1 })).status).toBe(200); // delivery lost: no ack
    const next = await (await post("renewal-due", { generation: 1 })).json<{ due: boolean; op_id: string }>();
    expect(next.due).toBe(true);
    const second = await post("subkey", { generation: 1, op_id: next.op_id });
    expect(second.status).toBe(200);
    expect((await second.json<{ generation: number }>()).generation).toBeGreaterThan(flux.mints[1].generation);
    // The first, superseded operation can no longer be acknowledged; the latest one can.
    expect((await post("subkey/ack", { generation: 1, op_id: `renew:${HOME}:1:1` })).status).toBe(409);
    expect((await post("subkey/ack", { generation: 1, op_id: next.op_id })).status).toBe(200);
    expect(await (await post("renewal-due", { generation: 1 })).json()).toEqual({ due: false });
  });

  it("hole 11: a renewal that names the wrong operation is refused and mints nothing", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await env.DB.prepare("UPDATE cloud_machines SET credential_hash=? WHERE id=?").bind(await sha256(MACHINE_TOKEN), HOME).run();
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock + DAY, HOME).run();
    const response = await call("POST", `/v1/machines/${HOME}/flux/subkey`, MACHINE_TOKEN, { generation: 1, op_id: `renew:${HOME}:1:42` }, { "CF-Connecting-IP": HOME_IP });
    expect(response.status).toBe(409);
    expect((await response.json<{ error: string }>()).error).toBe("renewal_op_mismatch");
    expect(flux.mints).toHaveLength(1);
  });

  it("renewal never undoes an owner Stop or a billing hold; only the owner resumes, and not under a hold", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await env.DB.prepare("UPDATE cloud_machines SET credential_hash=? WHERE id=?").bind(await sha256(MACHINE_TOKEN), HOME).run();
    const renew = () => call("POST", `/v1/machines/${HOME}/flux/subkey`, MACHINE_TOKEN, { generation: 1 }, { "CF-Connecting-IP": HOME_IP });
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock - 1000, HOME).run(); // expired: renewal due
    await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {});
    const afterStop = await renew();
    expect(afterStop.status).toBe(409);
    expect((await afterStop.json<{ error: string }>()).error).toBe("home_not_active");
    expect(flux.mints).toHaveLength(1);
    expect((await homeRow())?.state).toBe("stopped");
    const resumed = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect(resumed.status).toBe(200);
    expect(flux.mints.at(-1)).toMatchObject({ ownerResume: true });
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock - 1000, HOME).run();
    await admin("/v1/internal/flux/stop", { homeId: HOME, reason: "refunded" });
    const underHold = await renew();
    expect((await underHold.json<{ error: string }>()).error).toBe("billing_hold");
    expect((await (await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {})).json<{ error: string }>()).error).toBe("billing_hold");
    expect(flux.mints).toHaveLength(2);
  });

  it("the machine renewal-due question answers true only for an active, un-held home with a key due, and needs the machine credential", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await env.DB.prepare("UPDATE cloud_machines SET credential_hash=? WHERE id=?").bind(await sha256(MACHINE_TOKEN), HOME).run();
    const ask = (token: string) => call("POST", `/v1/machines/${HOME}/flux/renewal-due`, token, { generation: 1 }, { "CF-Connecting-IP": HOME_IP });
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect(await (await ask(MACHINE_TOKEN)).json()).toEqual({ due: false });
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock + 86_400_000, HOME).run();
    expect(await (await ask(MACHINE_TOKEN)).json()).toEqual({ due: true, op_id: `renew:${HOME}:1:1` });
    expect((await ask("wrong-token-wrong-token-wrong-token-0000")).status).toBeGreaterThanOrEqual(401);
    await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {});
    expect(await (await ask(MACHINE_TOKEN)).json()).toEqual({ due: false });
  });

  it("closes the Stop-versus-mint race with a lifecycle version: the raced key is revoked and never returned", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect(flux.mints.at(-1)).toMatchObject({ lifecycleVersion: 1 });
    // Stop bumps the version before Flux is told, and Flux is told that version.
    await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {});
    expect(flux.stopVersions).toEqual([2]);
    expect((await homeRow())?.lifecycle_version).toBe(2);
    // Resume claims version 3; a Stop lands after Flux published the key but before the answer returned.
    flux.stops.length = 0; flux.stopVersions.length = 0;
    flux.afterMint = async () => { await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {}); };
    const raced = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect(raced.status).toBe(409);
    expect(await raced.text()).not.toContain("sk-flux-home-");
    expect(flux.mints.at(-1)).toMatchObject({ lifecycleVersion: 3, ownerResume: true });
    expect(flux.stopVersions).toEqual([4]); // the Stop
    expect(flux.keyRevokes.map((r) => r.generation)).toEqual([2]); // and the exact raced key
    expect(flux.keys.size).toBe(0);
    expect(await homeRow()).toMatchObject({ state: "stopped", generation: 1, lifecycle_version: 4 });
  });

  it("a Stop that reaches the router first makes the router refuse the older mint (409 stale_lifecycle), nothing is published", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    flux.onMint = async () => { await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {}); };
    const raced = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect(raced.status).toBe(409);
    expect((await raced.json<{ error: string }>()).error).toBe("stale_lifecycle");
    expect(flux.keys.size).toBe(0);
    expect((await homeRow())?.state).toBe("stopped");
  });

  it("a raced mint is also revoked when unlink wins, and the sweep finishes the revoke if Flux is down", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    flux.keyRevokeDown = true;
    flux.afterMint = async () => { await call("DELETE", "/v1/flux/link", owner.token); };
    const raced = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect(raced.status).toBe(409);
    expect(await raced.text()).not.toContain("sk-flux-home-");
    expect(await (await call("GET", "/v1/flux/link", owner.token)).json()).toEqual({ linked: false });
    expect(await homeRow()).toMatchObject({ state: "stopped", generation: 0 });
    expect(flux.stops).toEqual([HOME]);
    expect(flux.keyRevokes).toEqual([]); // Flux was unreachable for the key revoke
    clock += 11 * 60_000;
    flux.keyRevokeDown = false;
    await sweepFlux(testEnv(), { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect(flux.keyRevokes.map((r) => r.generation)).toEqual([1]);
  });

  it("maps Flux's own stale_lifecycle and home_stopped answers to 409, and treats any other 409 as final", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    for (const reason of ["stale_lifecycle", "home_stopped"]) {
      flux.mintError = new FluxError(409, reason);
      const response = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
      expect(response.status).toBe(409);
      expect((await response.json<{ error: string }>()).error).toBe(reason);
    }
    flux.mintError = new FluxError(409, "", "stale_lifecycle");
    expect((await (await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {})).json<{ error: string }>()).error).toBe("stale_lifecycle");
    // Not the generation catch-up phrase, even though it ends in a number: final, no second attempt.
    flux.mintError = new FluxError(409, "key limit reached 7");
    const final = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect(final.status).toBe(409);
    expect((await final.json<{ error: string }>()).error).toBe("flux_conflict");
    expect(flux.mints).toHaveLength(0);
    expect((await homeRow())?.generation).toBe(0);
  });

  it("a Flux billing-identity failure is a retryable 503, not a final answer", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    flux.mintError = new FluxError(503, "billing_identity_unavailable");
    const first = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect(first.status).toBe(503);
    expect((await first.json<{ error: string }>()).error).toBe("billing_identity_unavailable");
    flux.mintError = new FluxError(503, "", "billing_identity_unavailable");
    expect((await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {})).status).toBe(503);
    expect((await homeRow())?.state).toBe("none");
    flux.mintError = null; // Flux recovered: the same request now succeeds
    expect((await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {})).status).toBe(200);
  });
});

describe("cap, Stop and status", () => {
  it("sets the monthly cap inside the allowed range and tells Flux", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    for (const bad of [4.99, 1000.01, -5]) expect((await call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, { capUsd: bad })).status).toBe(400);
    expect((await call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, { capUsd: "50" })).status).toBe(400);
    const ok = await call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, { capUsd: 55.5 });
    expect(await ok.json()).toEqual({ capUsd: 55.5, enabled: true });
    expect(flux.caps).toEqual([{ homeId: HOME, capMicrocents: 55_500_000, capVersion: 2 }]);
    expect(await homeRow()).toMatchObject({ cap_microcents: 55_500_000, cap_custom: 1 });
    // Round 3: nothing is undone. The new cap and version are recorded with their push intent; the push is retried.
    flux.down = true;
    const pending = await call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, { capUsd: 70 });
    expect(await pending.json()).toEqual({ capUsd: 70, enabled: true, pending: true });
    expect(await homeRow()).toMatchObject({ cap_microcents: 70_000_000, cap_version: 3 });
    flux.down = false;
    clock += BACKOFF; // round 4: a failed op is retried after its backoff
    await sweepFlux(testEnv(), { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect(flux.caps.at(-1)).toEqual({ homeId: HOME, capMicrocents: 70_000_000, capVersion: 3 });
  });

  it("Stop revokes at Flux; if Flux is down it stays 'stopping' and the sweep finishes it", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    flux.down = true;
    expect((await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {})).status).toBe(502);
    expect((await homeRow())?.state).toBe("stopping");
    await sweepFlux(testEnv(), { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect((await homeRow())?.state).toBe("stopping");
    flux.down = false;
    clock += BACKOFF;
    await sweepFlux(testEnv(), { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect(flux.stops).toEqual([HOME]);
    expect((await homeRow())?.state).toBe("stopped");
    expect((await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {})).status).toBe(200);
    const resumed = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect(resumed.status).toBe(200);
    expect((await homeRow())?.state).toBe("active");
  });

  it("reports state, cap, spend and the plain pause message at the cap", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    expect(await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json()).toMatchObject({ state: "none", paused: true, plan: "starter", includedCreditsUsd: 10, defaultCapUsd: 30 });
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    const ok = await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<Record<string, unknown>>();
    expect(ok).toMatchObject({ state: "active", flux: "ok", paused: false, message: null, capUsd: 30, spentUsd: 4, accountSpendableUsd: 12, autoTopUpOn: true });
    // Unknown stays unknown: never reported as on.
    flux.statusFor = { ...flux.statusFor, accountAutoTopUpEnabled: null, accountSpendableMicrocents: null };
    expect(await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json()).toMatchObject({ accountSpendableUsd: null, autoTopUpOn: null });
    flux.statusFor = { ...flux.statusFor, accountSpendableMicrocents: 0, accountAutoTopUpEnabled: null };
    expect((await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<{ message: string | null }>()).message).toBeNull();
    flux.statusFor = { state: "ok", capMicrocents: 30_000_000, spentMicrocents: 4_000_000, accountSpendableMicrocents: 12_000_000, accountAutoTopUpEnabled: true };
    flux.statusFor = { ...flux.statusFor, state: "capped", spentMicrocents: 30_000_000 };
    const capped = await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<{ paused: boolean; message: string }>();
    expect(capped.paused).toBe(true);
    expect(capped.message).toContain("$30.00 monthly Flux limit");
    expect(capped.message).toContain("Claude and ChatGPT sign-ins keep working");
    expect(capped.message).not.toContain(String.fromCharCode(0x2014));
    flux.statusFor = { state: "ok", capMicrocents: 30_000_000, spentMicrocents: 0, accountSpendableMicrocents: 0, accountAutoTopUpEnabled: false };
    const low = await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<{ paused: boolean; message: string }>();
    expect(low.paused).toBe(false);
    expect(low.message).toContain("automatic top-up");
    flux.down = true;
    const down = await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<{ paused: boolean; flux: string; message: string }>();
    expect(down).toMatchObject({ paused: true, flux: "unavailable" });
    expect(down.message).toContain("Claude and ChatGPT sign-ins keep working");
  });

  it("unlinking stops every home first", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    const result = await call("DELETE", "/v1/flux/link", owner.token);
    expect(await result.json()).toEqual({ linked: false, stoppedHomes: 1 });
    expect(flux.stops).toEqual([HOME]);
    expect((await homeRow())?.state).toBe("stopped");
    expect(await (await call("GET", "/v1/flux/link", owner.token)).json()).toEqual({ linked: false });
  });
});

describe("journey A8: the monthly spend limit needs the second factor only to raise it", () => {
  const capPath = `/v1/homes/${HOME}/flux/cap`;
  const post = async (token: string, capUsd: number) => {
    const r = await call("POST", capPath, token, { capUsd });
    return [r.status, (await r.json<{ error?: string }>()).error ?? null] as const;
  };
  it("lowering or keeping the limit is sign-in only (aal1); a raise is 403 step_up_required without a fresh factor and passes with one", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect(await post(owner.token, 80)).toEqual([200, null]);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    expect(await post(aal1, 60)).toEqual([200, null]);
    expect(await homeRow()).toMatchObject({ cap_microcents: 60_000_000 });
    expect(flux.caps.at(-1)).toMatchObject({ homeId: HOME, capMicrocents: 60_000_000 });
    expect(await post(aal1, 60)).toEqual([200, null]); // unchanged
    expect(await post(aal1, 60.01)).toEqual([403, "step_up_required"]);
    expect(await post(aal1, 500)).toEqual([403, "step_up_required"]);
    expect(await homeRow()).toMatchObject({ cap_microcents: 60_000_000 });
    expect(await post(owner.token, 90)).toEqual([200, null]);
    expect(await homeRow()).toMatchObject({ cap_microcents: 90_000_000 });
  });
  it("the handler re-checks in the write: a limit lowered concurrently turns a sign-in-only 'lower' request into a raise, which is refused", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect(await post(owner.token, 80)).toEqual([200, null]);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    // The gate compares 50 with 80 (a lowering); just before the write, another request lowers the limit to 30.
    armDb(/UPDATE flux_home_keys SET plan=\?,cap_microcents=\?/, async () => {
      await env.DB.prepare("UPDATE flux_home_keys SET cap_microcents=30000000 WHERE home_id=?").bind(HOME).run();
    });
    expect(await post(aal1, 50)).toEqual([403, "step_up_required"]);
    expect(await homeRow()).toMatchObject({ cap_microcents: 30_000_000 });
    // Another member, or no home row to compare with: never exempt.
    const other = await signIn("other@example.test");
    const otherAal1 = await stepUpToken(other.sub, other.email, { aal1: true });
    expect((await call("POST", capPath, otherAal1, { capUsd: 5 })).status).toBe(403);
  });
});

describe("journey A8 (Astra JOURNEY-A-2): spending can be switched off with sign-in only; switching it back on keeps the step-up", () => {
  const capPath = `/v1/homes/${HOME}/flux/cap`;
  const post = async (token: string, body: unknown) => {
    const r = await call("POST", capPath, token, body);
    return [r.status, await r.json<Record<string, unknown>>()] as const;
  };
  it("{enabled:false} and {capUsd:0} store the off state (a zero limit, kept across plan changes) and push it to Flux; the status says off", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect((await call("POST", capPath, owner.token, { capUsd: 80 })).status).toBe(200);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    // The probe: {capUsd:0} passed the exemption but was 400 invalid_cap; {enabled:false} was rejected outright.
    expect(await post(aal1, { enabled: false })).toEqual([200, { capUsd: 0, enabled: false }]);
    expect(await homeRow()).toMatchObject({ spending_off: 1, cap_microcents: 80_000_000, cap_custom: 1 }); // the owner's limit is kept for switching back on
    expect(flux.caps.at(-1)).toMatchObject({ homeId: HOME, capMicrocents: 0 });
    expect(await post(aal1, { capUsd: 0 })).toEqual([200, { capUsd: 0, enabled: false }]);
    flux.statusFor = { ...flux.statusFor, capMicrocents: 0 }; // the router confirms the zero limit
    const status = await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<{ capUsd: number; spendingEnabled: boolean; paused: boolean; message: string }>();
    expect(status).toMatchObject({ capUsd: 0, spendingEnabled: false, paused: true });
    expect(status.message).toContain("switched off");
    // Malformed off bodies are never read as off: the gate does not exempt them (403 without the step-up) and the handler refuses them (400).
    for (const bad of [{ enabled: false, capUsd: 500 }, { enabled: "false" }]) {
      expect((await call("POST", capPath, aal1, bad)).status).toBe(403);
      expect((await call("POST", capPath, owner.token, bad)).status).toBe(400);
    }
    expect(await homeRow()).toMatchObject({ spending_off: 1 });
    // A plan change never switches it back on.
    await changePlan(testEnv(), { homeId: HOME, plan: "max" }, { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect(await homeRow()).toMatchObject({ spending_off: 1 });
  });
  it("Astra JOURNEY-A-3 #8: off requested but the router still enforcing a limit reads as pending with the live cap, never switched off", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect((await call("POST", capPath, owner.token, { capUsd: 80 })).status).toBe(200);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    expect((await post(aal1, { enabled: false }))[0]).toBe(200);
    type Status = { capUsd: number; spendingEnabled: boolean; spendingOff: Record<string, boolean>; paused: boolean; message: string };
    // The probe: Flux still reports an $80 cap.
    flux.statusFor = { ...flux.statusFor, state: "ok", capMicrocents: 80_000_000 };
    const pending = await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<Status>();
    expect(pending).toMatchObject({ capUsd: 80, spendingEnabled: false, spendingOff: { requested: true, confirmed: false, pending: true }, paused: false });
    expect(pending.message).toContain("switching off");
    expect(pending.message).toContain("$80.00");
    expect(pending.message).not.toContain("switched off");
    // Flux unreachable: still pending (nothing confirms it), never "switched off".
    flux.down = true;
    const unknown = await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<Status>();
    expect(unknown.spendingOff).toMatchObject({ requested: true, confirmed: false, pending: true });
    expect(unknown.capUsd).toBe(80);
    flux.down = false;
    // The router confirms 0: switched off.
    flux.statusFor = { ...flux.statusFor, capMicrocents: 0 };
    const off = await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<Status>();
    expect(off).toMatchObject({ capUsd: 0, spendingOff: { requested: true, confirmed: true, pending: false }, paused: true });
    expect(off.message).toContain("switched off");
  });
  it("Astra JOURNEY-A-4 #6: a switch-off the router keeps failing is retried, alerts ops after an hour and gives the customer its duration and support", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect((await call("POST", capPath, owner.token, { capUsd: 80 })).status).toBe(200);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    const offAt = clock;
    flux.down = true; // the router fails every call
    expect(await post(aal1, { enabled: false })).toEqual([200, { capUsd: 0, enabled: false, pending: true }]);
    expect(await homeRow()).toMatchObject({ spending_off: 1, spending_off_at: offAt });
    type Status = { spendingOff: { pending: boolean; pendingSince: number | null; pendingForMs: number | null; supportAction: { action: string; message: string } | null }; message: string };
    const status = async () => (await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<Status>());
    const alerts = () => env.DB.prepare("SELECT id,resolved_at FROM cloud_alerts WHERE kind='flux.spending_off_unconfirmed'").all<{ id: string; resolved_at: number | null }>().then((r) => r.results);
    const sweepDeps = { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock };
    clock += 30 * 60_000;
    await sweepFlux(testEnv(), sweepDeps);
    expect(await alerts()).toEqual([]); // still retrying, not yet an hour
    expect((await status()).spendingOff).toMatchObject({ pending: true, pendingSince: offAt, pendingForMs: 30 * 60_000, supportAction: null });
    clock += 31 * 60_000;
    await sweepFlux(testEnv(), sweepDeps);
    expect(await alerts()).toEqual([{ id: `alert:spending_off:${HOME}:${offAt}`, resolved_at: null }]);
    const late = await status();
    expect(late.spendingOff).toMatchObject({ pending: true, pendingForMs: 61 * 60_000, supportAction: { action: "contact_support" } });
    expect(late.spendingOff.supportAction!.message).toContain("contact support");
    // A later sweep does not raise it twice; the router recovers, the queued op lands, the alert is resolved.
    await sweepFlux(testEnv(), sweepDeps);
    expect(await alerts()).toHaveLength(1);
    flux.down = false;
    clock += 2 * 60 * 60_000;
    await sweepFlux(testEnv(), sweepDeps);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_home_ops WHERE home_id=? AND kind='cap' AND state IN ('queued','running')").bind(HOME).first()).toEqual({ n: 0 });
    expect(await alerts()).toEqual([{ id: `alert:spending_off:${HOME}:${offAt}`, resolved_at: clock }]);
  });
  it("Astra JOURNEY-A-5 #7: a positive limit after a confirmed switch-off is drift: zero is requeued and a new incident stays open until it lands", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect((await call("POST", capPath, owner.token, { capUsd: 80 })).status).toBe(200);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    expect(await post(aal1, { enabled: false })).toEqual([200, { capUsd: 0, enabled: false }]);
    type Status = { spendingOff: { confirmed: boolean; pending: boolean; pendingSince: number | null } };
    const status = async () => (await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<Status>());
    const alerts = () => env.DB.prepare("SELECT id,resolved_at,detail FROM cloud_alerts WHERE kind='flux.spending_off_unconfirmed' ORDER BY raised_at,id")
      .all<{ id: string; resolved_at: number | null; detail: string }>().then((r) => r.results);
    const queuedCaps = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_home_ops WHERE home_id=? AND kind='cap' AND state IN ('queued','running')").bind(HOME).first<{ n: number }>())!.n;
    const sweepDeps = { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock };
    // Confirmed: the router enforces zero.
    flux.statusFor = { ...flux.statusFor, capMicrocents: 0 };
    expect((await status()).spendingOff).toMatchObject({ confirmed: true, pending: false });
    expect(await alerts()).toEqual([]);
    // Later the router reports a positive limit again (and cannot be told zero right now): drift.
    flux.statusFor = { ...flux.statusFor, capMicrocents: 80_000_000 };
    flux.failHomes.add(HOME);
    clock += 10 * 60_000;
    const driftAt = clock;
    expect((await status()).spendingOff).toMatchObject({ confirmed: false, pending: true, pendingSince: driftAt });
    expect(await queuedCaps()).toBe(1);
    const raised = await alerts();
    expect(raised.map((a) => [a.id, a.resolved_at])).toEqual([[`alert:spending_off:${HOME}:${driftAt}`, null]]);
    expect(JSON.parse(raised[0].detail)).toMatchObject({ drift: 1, observedCapMicrocents: 80_000_000 });
    // Read again: never requeued twice, one incident.
    clock += 60_000;
    await status();
    expect(await queuedCaps()).toBe(1);
    expect(await alerts()).toHaveLength(1);
    // The sweep keeps the incident open while zero is not confirmed.
    clock += 5 * 60_000;
    await sweepFlux(testEnv(), sweepDeps);
    expect((await alerts())[0].resolved_at).toBeNull();
    // The router takes the zero again: the op lands and the incident is resolved.
    flux.failHomes.delete(HOME);
    clock += 2 * 60 * 60_000;
    await sweepFlux(testEnv(), sweepDeps);
    expect(await queuedCaps()).toBe(0);
    expect(flux.caps.at(-1)).toMatchObject({ homeId: HOME, capMicrocents: 0 });
    expect((await alerts())[0].resolved_at).toBe(clock);
    // A later drift opens a NEW incident (the resolved one never blocks it).
    clock += 60_000;
    await status();
    expect((await alerts()).map((a) => a.resolved_at === null)).toEqual([false, true]);
  });
  it("Astra JOURNEY-A-6 #6: the sweep polls switched-off homes for drift in turn (no page visit, no pending op) and requeues zero", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    expect(await post(aal1, { enabled: false })).toEqual([200, { capUsd: 0, enabled: false }]);
    const sweepDeps = { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock };
    const queuedCaps = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_home_ops WHERE home_id=? AND kind='cap' AND state IN ('queued','running')").bind(HOME).first<{ n: number }>())!.n;
    const checkedAt = async () => (await env.DB.prepare("SELECT spending_off_checked_at AS c FROM flux_home_keys WHERE home_id=?").bind(HOME).first<{ c: number | null }>())!.c;
    const alerts = () => env.DB.prepare("SELECT id,resolved_at FROM cloud_alerts WHERE kind='flux.spending_off_unconfirmed' ORDER BY raised_at,id").all().then((r) => r.results);
    // Zero confirmed by the router, nothing queued.
    flux.statusFor = { ...flux.statusFor, capMicrocents: 0 };
    clock += 60_000;
    await sweepFlux(testEnv(), sweepDeps);
    expect(await queuedCaps()).toBe(0);
    expect(await checkedAt()).toBe(clock);
    // Nobody visits the page; the router drifts to a positive limit (and cannot be told zero right now).
    flux.statusFor = { ...flux.statusFor, capMicrocents: 80_000_000 };
    flux.failHomes.add(HOME);
    // Not yet its turn again (polled at most every 15 minutes): no router read.
    const reads = flux.statusCalls;
    clock += 5 * 60_000;
    await sweepFlux(testEnv(), sweepDeps);
    expect(flux.statusCalls).toBe(reads);
    expect(await queuedCaps()).toBe(0);
    // Its turn: the drift is found by the sweep itself, zero enforcement is requeued and a new incident raised.
    clock += 15 * 60_000;
    const driftAt = clock;
    await sweepFlux(testEnv(), sweepDeps);
    expect(await checkedAt()).toBe(driftAt);
    expect(await queuedCaps()).toBe(1);
    expect((await alerts()).map((a) => [a.id, a.resolved_at])).toEqual([[`alert:spending_off:${HOME}:${driftAt}`, null]]);
    // While the zero is queued the home is not re-polled (never requeued twice); once it lands the incident is resolved.
    flux.failHomes.delete(HOME);
    flux.statusFor = { ...flux.statusFor, capMicrocents: 0 };
    clock += 2 * 60 * 60_000;
    await sweepFlux(testEnv(), sweepDeps);
    expect(await queuedCaps()).toBe(0);
    expect(flux.caps.at(-1)).toMatchObject({ homeId: HOME, capMicrocents: 0 });
    expect((await alerts()).map((a) => a.resolved_at)).toEqual([clock]);
  });
  it("Astra JOURNEY-A-7: drift polling is bounded: 1,000 switched-off homes are each re-read within an hour of five-minute sweeps", async () => {
    // The documented bound: one round of the cohort per hour up to 1,200 homes, 15 minutes for a small cohort.
    expect([spendingOffPollBatch(0), spendingOffPollBatch(30), spendingOffPollBatch(1_000), spendingOffPollBatch(1_200), spendingOffPollBatch(5_000)])
      .toEqual([10, 10, 84, 100, 100]);
    expect([spendingOffMaxStalenessMs(1), spendingOffMaxStalenessMs(30), spendingOffMaxStalenessMs(500), spendingOffMaxStalenessMs(1_000), spendingOffMaxStalenessMs(1_200)])
      .toEqual([15 * 60_000, 15 * 60_000, 60 * 60_000, 60 * 60_000, 60 * 60_000]);
    for (let n = 1; n <= 1_000; n += 37) expect(spendingOffMaxStalenessMs(n)).toBeLessThanOrEqual(60 * 60_000);
    await setupKeys();
    const N = 1_000;
    const ids = Array.from({ length: N }, (_, i) => `home-off-${String(i).padStart(4, "0")}`);
    for (let i = 0; i < N; i += 50) {
      await env.DB.batch(ids.slice(i, i + 50).map((id) => env.DB.prepare(`INSERT INTO flux_home_keys (home_id,plan,state,cap_microcents,spending_off,spending_off_at,updated_at)
        VALUES (?,'starter','active',30000000,1,?,?)`).bind(id, clock, clock)));
    }
    // The router confirms zero for every home: polling finds no drift, it only has to keep every home fresh.
    flux.statusFor = { ...flux.statusFor, capMicrocents: 0 };
    const start = clock;
    const sweepDeps = { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock };
    let worst = 0;
    for (let s = 0; s <= 24; s++) {
      await sweepFlux(testEnv(), sweepDeps);
      if (clock - start >= 60 * 60_000) {
        const oldest = (await env.DB.prepare("SELECT MIN(COALESCE(spending_off_checked_at,0)) AS m FROM flux_home_keys WHERE home_id LIKE 'home-off-%'").first<{ m: number }>())!.m;
        worst = Math.max(worst, clock - oldest);
      }
      clock += 5 * 60_000;
    }
    // Every home was re-read, none older than an hour at any sweep of the second hour.
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(60 * 60_000);
  }, 30_000); // a simulated fleet, budgeted like the suite's other fleet tests: ~1.5-2.7 s on the build server, over 5 s on a hosted runner
  it("Astra JOURNEY-A-3 #9: a plan change racing a switch-off never overwrites the remembered limit nor clears cap_custom", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    const before = (await homeRow())!;
    expect(before.cap_custom).toBe(0); // the plan's own limit, untouched
    // The plan change has read its row (not custom) when the owner switches spending off, keeping that limit as their own.
    dbHook = async (sql) => {
      if (!sql.includes("UPDATE flux_home_keys SET plan=?")) return;
      dbHook = null;
      await env.DB.prepare("UPDATE flux_home_keys SET spending_off=1,cap_custom=1,cap_version=cap_version+1 WHERE home_id=?").bind(HOME).run();
    };
    const moved = await changePlan(testEnv(), { homeId: HOME, plan: "max" }, { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect(await homeRow()).toMatchObject({ plan: "max", cap_microcents: before.cap_microcents, cap_custom: 1, spending_off: 1 });
    expect(moved).toEqual({ plan: "max", capUsd: (before.cap_microcents as number) / 1_000_000 });
    // What the router is told is the stored state: off, so zero.
    expect(flux.caps.at(-1)).toMatchObject({ homeId: HOME, capMicrocents: 0 });
  });
  it("switching spending back on, or raising it from off, needs the fresh second factor", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    expect((await post(aal1, { enabled: false }))[0]).toBe(200);
    expect(await post(aal1, { enabled: true })).toEqual([403, expect.objectContaining({ error: "step_up_required" })]);
    expect(await post(aal1, { enabled: true, capUsd: 20 })).toEqual([403, expect.objectContaining({ error: "step_up_required" })]);
    expect(await post(aal1, { capUsd: 5 })).toEqual([403, expect.objectContaining({ error: "step_up_required" })]);
    expect(await homeRow()).toMatchObject({ spending_off: 1 });
    const [st, on] = await post(owner.token, { enabled: true });
    expect(st).toBe(200);
    expect(on).toMatchObject({ enabled: true });
    expect((on.capUsd as number) > 0).toBe(true);
    expect(await homeRow()).toMatchObject({ spending_off: 0 });
    expect(flux.caps.at(-1)!.capMicrocents).toBeGreaterThan(0);
  });
});

describe("monthly included credits (Billing calls these)", () => {
  const sweep = () => sweepFlux(testEnv(), { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
  const grantBody = (plan: string, invoiceId: string, n = 0, extraFields: Record<string, unknown> = {}) =>
    ({ homeId: HOME, plan, invoiceId, ...period(n), ...extraFields });
  const grantRow = (grantId: string) => env.DB.prepare("SELECT * FROM flux_grants WHERE grant_id=?").bind(grantId).first<Record<string, unknown>>();

  it("needs the admin token", async () => {
    await setupKeys();
    for (const token of [null, "wrong"]) expect((await admin("/v1/internal/flux/grant", grantBody("starter", "in_123456"), token)).status).toBe(401);
    const owner = await signIn("owner@example.test");
    expect((await admin("/v1/internal/flux/grant", grantBody("starter", "in_123456"), owner.token)).status).toBe(401);
  });

  it("grants each plan's face value from config, once per invoice, with the entitlement fields Flux needs", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    let n = 0;
    for (const [plan, usd] of [["starter", 10], ["pro", 20], ["max", 40]] as const) {
      const response = await admin("/v1/internal/flux/grant", grantBody(plan, `in_${plan}_1`, n++));
      expect(await response.json()).toMatchObject({ status: "done", amountUsd: usd });
    }
    expect(flux.grants.map((g) => [g.plan, g.amountMicrocents, g.recipientFluxAccountId])).toEqual([
      ["starter", 10_000_000, FLUX_ACCOUNT], ["pro", 20_000_000, FLUX_ACCOUNT], ["max", 40_000_000, FLUX_ACCOUNT],
    ]);
    expect(flux.grants[0]).toEqual({
      deliveryId: expect.stringMatching(/^[0-9a-f-]{36}$/), invoiceId: "in_starter_1", kind: "period", onRevision: expect.any(Function), dispatchToken: expect.stringMatching(/^[0-9a-f-]{36}$/), // lane H1, H3
      grantId: "inv:in_starter_1", entitlementKey: `home:${HOME}:period:${PERIOD_START}`, recipientFluxAccountId: FLUX_ACCOUNT, homeId: HOME,
      plan: "starter", amountMicrocents: 10_000_000, periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z", // period end plus one month of carryover
    });
    const replay = await admin("/v1/internal/flux/grant", grantBody("pro", "in_pro_1", 1));
    expect(replay.status).toBe(200);
    expect(flux.grants).toHaveLength(3);
    expect((await admin("/v1/internal/flux/grant", grantBody("max", "in_pro_1", 1))).status).toBe(409);
    expect((await admin("/v1/internal/flux/grant", grantBody("nope", "in_x_1234"))).status).toBe(400);
    expect((await admin("/v1/internal/flux/grant", grantBody("pro", "in_x_1234", 0, { amountUsd: 500 }))).status).toBe(400);
    expect((await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "pro", invoiceId: "in_x_1234" })).status).toBe(400); // period is required
  });

  it("takes the amount from config, so Sean can change it without code", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    extra = { FLUX_B4_CONFIG: JSON.stringify({ ...DEFAULT_FLUX_CONFIG, plans: { ...DEFAULT_FLUX_CONFIG.plans, starter: { creditsUsd: 15 } } }) };
    const result = await grantMonthlyCredits(testEnv(), { homeId: HOME, plan: "starter", invoiceId: "in_cfg_001", ...period() }, { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect(result.amountUsd).toBe(15);
    expect(flux.grants[0].amountMicrocents).toBe(15_000_000);
  });

  it("a second distinct invoice in the same period grants nothing", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_period_a"));
    const second = await admin("/v1/internal/flux/grant", grantBody("starter", "in_period_b"));
    expect(await second.json()).toMatchObject({ status: "duplicate_period", amountUsd: 0 });
    expect(flux.grants).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_grants").first()).toEqual({ n: 1 });
    // The next period is a new entitlement.
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_period_c", 31));
    expect(flux.grants).toHaveLength(2);
  });

  it("an upgrade grants only the delta, once", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_base_001"));
    const up = await admin("/v1/internal/flux/grant", grantBody("max", "in_up_0001", 0, { kind: "upgrade_delta", previousPlan: "starter" }));
    expect(await up.json()).toMatchObject({ status: "done", amountUsd: 30 });
    expect(flux.grants.at(-1)).toMatchObject({ plan: "max", amountMicrocents: 30_000_000, entitlementKey: `home:${HOME}:period:${PERIOD_START}:delta:max` });
    const again = await admin("/v1/internal/flux/grant", grantBody("max", "in_up_0002", 0, { kind: "upgrade_delta", previousPlan: "starter" }));
    expect(await again.json()).toMatchObject({ status: "duplicate_period", amountUsd: 0 });
    expect(flux.grants).toHaveLength(2);
    expect((await admin("/v1/internal/flux/grant", grantBody("starter", "in_down_001", 5, { kind: "upgrade_delta", previousPlan: "max" }))).status).toBe(400);
    expect((await admin("/v1/internal/flux/grant", grantBody("max", "in_nopr_001", 6, { kind: "upgrade_delta" }))).status).toBe(400);
  });

  it("refuses a pooled plan: it gets no per-home grant", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    for (const plan of ["team", "business"]) {
      const response = await admin("/v1/internal/flux/grant", grantBody(plan, `in_pool_${plan}`));
      expect(response.status).toBe(400);
      expect((await response.json<{ error: string }>()).error).toBe("pooled_plan_not_supported_yet");
    }
    expect(flux.grants).toHaveLength(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_grants").first()).toEqual({ n: 0 });
  });

  it("holds a grant paid before the account is linked, and delivers it exactly once after", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    const held = await admin("/v1/internal/flux/grant", grantBody("starter", "in_early_1"));
    expect(await held.json()).toMatchObject({ status: "pending" });
    expect(flux.grants).toHaveLength(0);
    await link(owner.token);
    // INTEGRATED-10 P2: the unbound hold was examined (stamped), so it waits its retry interval like every other grant (never monopolizing).
    await sweep();
    expect(flux.grants).toHaveLength(0);
    clock += 11 * 60_000;
    await sweep();
    await sweep();
    expect(flux.grants).toHaveLength(1);
    expect(await env.DB.prepare("SELECT status,recipient_flux_account_id FROM flux_grants").first()).toEqual({ status: "done", recipient_flux_account_id: FLUX_ACCOUNT });
  });

  it("never delivers to a different Flux account than the one linked when the grant was made: held for review, never cancelled (Astra FLUX-STEP3 #1)", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    flux.down = true;
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_fixed_01"));
    expect(await grantRow("inv:in_fixed_01")).toMatchObject({ status: "pending", recipient_flux_account_id: FLUX_ACCOUNT });
    // Unlinked: HELD (not cancelled), and a relink to another Flux account does not move it.
    flux.down = false;
    await call("DELETE", "/v1/flux/link", owner.token);
    expect(await grantRow("inv:in_fixed_01")).toMatchObject({ status: "pending", recipient_flux_account_id: FLUX_ACCOUNT,
      last_error: "grant_held:recipient_unlinked" });
    await link(owner.token, "99999999-2222-3333-4444-555555555555");
    clock += 11 * 60_000;
    await sweep();
    expect(flux.grants).toHaveLength(0);
    expect(await grantRow("inv:in_fixed_01")).toMatchObject({ status: "pending", recipient_flux_account_id: FLUX_ACCOUNT,
      last_error: "grant_held:recipient_mismatch" });
    // Same outcome when the link changes underneath a pending grant without an unlink.
    flux.down = true;
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_fixed_02", 40));
    expect(await grantRow("inv:in_fixed_02")).toMatchObject({ status: "pending", recipient_flux_account_id: "99999999-2222-3333-4444-555555555555" });
    await env.DB.prepare("UPDATE flux_grants SET recipient_flux_account_id=? WHERE grant_id='inv:in_fixed_02'").bind(FLUX_ACCOUNT).run();
    flux.down = false;
    clock += 11 * 60_000;
    await sweep();
    expect(await grantRow("inv:in_fixed_02")).toMatchObject({ status: "pending", last_error: "grant_held:recipient_mismatch" });
    expect(flux.grants).toHaveLength(0);
    expect(flux.revokes).toEqual([]);
  });

  it("Astra FLUX-STEP3-2: 51 open held alerts - the one whose grant was cancelled still closes in one sweep (no starvation)", async () => {
    const now = Date.now();
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 51; i++) {
      const home = `home-held-${String(i).padStart(2, "0")}`;
      stmts.push(
        env.DB.prepare("INSERT INTO flux_grants (grant_id,entitlement_key,home_id,plan,amount_microcents,period_start,period_end,expires_at,status,last_error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
          .bind(`g-held-${i}`, `ek-held-${i}`, home, "starter", 1000, now, now + 1e9, now + 1e12, i === 50 ? "cancelled" : "pending", "grant_held:recipient_unlinked", now + i),
        env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?)")
          .bind(`alert-held-${i}`, home, "flux.grant_held", "high", JSON.stringify({ grantId: `g-held-${i}`, reason: "recipient_unlinked", grants: [{ grantId: `g-held-${i}`, reason: "recipient_unlinked" }] }), now + i),
      );
    }
    await env.DB.batch(stmts);
    await sweepFlux(testEnv(), deps);
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='flux.grant_held' AND resolved_at IS NULL").first<{ n: number }>();
    const last = await env.DB.prepare("SELECT resolved_at FROM cloud_alerts WHERE home_id='home-held-50'").first<{ resolved_at: number | null }>();
    expect(last?.resolved_at).not.toBeNull();
    expect(open?.n).toBe(50);
  });

  it("expires an undelivered grant on its original schedule and never delivers it", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_old_0001"));
    clock = Date.parse("2026-12-01T00:00:01Z"); // past period end + one month
    await link(owner.token);
    await sweep();
    expect(flux.grants).toHaveLength(0);
    expect(await grantRow("inv:in_old_0001")).toMatchObject({ status: "expired" });
    // A late invoice for a long-finished period is expired on arrival, not delivered.
    const late = await grantMonthlyCredits(testEnv(), { homeId: HOME, plan: "pro", invoiceId: "in_old_0002", periodStart: PERIOD_START - 90 * DAY, periodEnd: PERIOD_START - 60 * DAY }, { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect(late.status).toBe("expired");
    expect(flux.grants).toHaveLength(0);
  });

  it("retries a failed delivery on the sweep and gives up after 20 tries", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    flux.down = true;
    const first = await admin("/v1/internal/flux/grant", grantBody("pro", "in_retry_1"));
    expect(await first.json()).toMatchObject({ status: "pending" });
    await sweep();
    expect((await env.DB.prepare("SELECT attempts FROM flux_grants").first<{ attempts: number }>())?.attempts).toBe(1); // too soon to retry
    clock += 11 * 60_000;
    flux.down = false;
    await sweep();
    expect(flux.grants).toHaveLength(1);
    // The give-up path: a grant that has failed 19 times fails on the 20th.
    flux.down = true;
    await env.DB.prepare("INSERT INTO flux_grants (grant_id,entitlement_key,home_id,plan,amount_microcents,period_start,period_end,expires_at,attempts,created_at) VALUES ('inv:in_dead_001','k-dead',?,?,?,?,?,?,19,?)")
      .bind(HOME, "pro", 20_000_000, PERIOD_START, PERIOD_END, addDays(PERIOD_END, 30), clock).run();
    await sweep();
    expect(await env.DB.prepare("SELECT status,last_error FROM flux_grants WHERE grant_id='inv:in_dead_001'").first()).toEqual({ status: "failed", last_error: "flux_0" });
  });

  it("a billing stop cannot be undone by the owner; only a NEW later paid invoice lifts it", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_before_1"));
    expect((await admin("/v1/internal/flux/stop", { homeId: HOME, reason: "cancelled" })).status).toBe(200);
    expect(flux.stops).toEqual([HOME]);
    expect((await homeRow())?.state).toBe("stopped");
    expect(await homeRow()).toMatchObject({ billing_hold: 1, billing_hold_at: clock });
    const blocked = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect(blocked.status).toBe(409);
    expect((await blocked.json<{ error: string }>()).error).toBe("billing_hold");
    // An old invoice replayed, and an old period arriving as a new invoice: both leave the hold alone.
    const replayed = await admin("/v1/internal/flux/grant", grantBody("starter", "in_before_1"));
    expect(replayed.status).toBe(200);
    expect(await homeRow()).toMatchObject({ billing_hold: 1 });
    const stale = await admin("/v1/internal/flux/grant", grantBody("starter", "in_stale_01", -40));
    expect(await stale.json()).toMatchObject({ status: "held_by_billing_hold", amountUsd: 0 });
    expect(await homeRow()).toMatchObject({ billing_hold: 1 });
    expect((await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {})).status).toBe(409);
    // A new paid invoice for a period that starts after the hold.
    clock += 2 * DAY;
    const fresh = await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_after_01", periodStart: clock - DAY, periodEnd: clock + 30 * DAY });
    expect(await fresh.json()).toMatchObject({ status: "done", amountUsd: 10 });
    expect(await homeRow()).toMatchObject({ billing_hold: 0 });
    expect((await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {})).status).toBe(200);
    // A replay of that invoice, even after a newer hold, must not clear it.
    await admin("/v1/internal/flux/stop", { homeId: HOME, reason: "chargeback" });
    await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_after_01", periodStart: clock - DAY, periodEnd: clock + 30 * DAY });
    expect(await homeRow()).toMatchObject({ billing_hold: 1 });
    expect((await admin("/v1/internal/flux/stop", { homeId: HOME, reason: "mystery" })).status).toBe(400);
  });

  it("an invoice that was reversed can never lift a hold", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    // The refund arrives before the paid-invoice event does.
    await admin("/v1/internal/flux/stop", { homeId: HOME, reason: "refunded", invoiceId: "in_refunded1" });
    clock += DAY;
    const late = await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_refunded1", periodStart: clock, periodEnd: clock + 30 * DAY });
    expect(await late.json()).toMatchObject({ status: "reversed", amountUsd: 0 });
    expect(await homeRow()).toMatchObject({ billing_hold: 1 });
    expect(flux.grants).toHaveLength(0);
  });

  describe("round 8b (Astra TAXCOUNTRY-7 P1-a): a replacement contract's paid invoice and a hold set by another contract's reversal", () => {
    /** The home's current contract (B5's billing_subscriptions) and each invoice's contract (B5's grant claims, credit_grants). */
    const contracts = async (current: string, invoices: Record<string, string>) => {
      await env.DB.prepare(`INSERT OR REPLACE INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at)
        VALUES (?,'cus_1',?,'starter','active',1,1)`).bind(HOME, current).run();
      for (const [invoiceId, sub] of Object.entries(invoices)) {
        await env.DB.prepare(`INSERT OR REPLACE INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,subscription_id) VALUES (?,'period',?,'starter',1,?)`)
          .bind(invoiceId, HOME, sub).run();
      }
    };
    const grantB = () => admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_b_paid1", periodStart: clock - 2 * DAY, periodEnd: clock + 28 * DAY });

    it("the exact reordering: A's invoice refunded (hold) and B, the current contract, paid for a period that started BEFORE the hold: B's credits are on, once", async () => {
      await setupKeys();
      const owner = await signIn("owner@example.test");
      await machineSetup(owner.token, owner.userId);
      await contracts("sub_b", { in_a_paid1: "sub_a", in_b_paid1: "sub_b" });
      await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_a_paid1", periodStart: clock - 5 * DAY, periodEnd: clock + 25 * DAY });
      expect((await admin("/v1/internal/flux/stop", { homeId: HOME, reason: "refunded", invoiceId: "in_a_paid1" })).status).toBe(200);
      expect(await homeRow()).toMatchObject({ billing_hold: 1, billing_hold_unattributed: 0 });
      clock += DAY;
      const b = await grantB();
      expect(await b.json()).toMatchObject({ status: "done", amountUsd: 10 });
      expect(await homeRow()).toMatchObject({ billing_hold: 0 });
      expect((await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {})).status).toBe(200);
      // No double grant: B's invoice replayed grants nothing more.
      const grants = flux.grants.length;
      expect(await (await grantB()).json()).toMatchObject({ status: "done", amountUsd: 10 });
      expect(flux.grants).toHaveLength(grants);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_grants WHERE invoice_id='in_b_paid1'").first()).toEqual({ n: 1 });
    });

    it("the hold stays when the reversal belongs to the current contract (B's own reversed invoice), or the hold includes a stop without an invoice", async () => {
      await setupKeys();
      const owner = await signIn("owner@example.test");
      await machineSetup(owner.token, owner.userId);
      await contracts("sub_b", { in_b_old01: "sub_b", in_b_paid1: "sub_b" });
      await admin("/v1/internal/flux/stop", { homeId: HOME, reason: "refunded", invoiceId: "in_b_old01" });
      clock += DAY;
      expect(await (await grantB()).json()).toMatchObject({ status: "held_by_billing_hold", amountUsd: 0 });
      expect(await homeRow()).toMatchObject({ billing_hold: 1 });
    });

    it("a hold with a stop that named no invoice (a cancellation) is never lifted by another contract's invoice", async () => {
      await setupKeys();
      const owner = await signIn("owner@example.test");
      await machineSetup(owner.token, owner.userId);
      await contracts("sub_b", { in_a_paid1: "sub_a", in_b_paid1: "sub_b" });
      await admin("/v1/internal/flux/stop", { homeId: HOME, reason: "refunded", invoiceId: "in_a_paid1" });
      await admin("/v1/internal/flux/stop", { homeId: HOME, reason: "cancelled" });
      expect(await homeRow()).toMatchObject({ billing_hold: 1, billing_hold_unattributed: 1 });
      clock += DAY;
      expect(await (await grantB()).json()).toMatchObject({ status: "held_by_billing_hold" });
      expect(await homeRow()).toMatchObject({ billing_hold: 1 });
    });

    describe("round 9b (Astra TAXCOUNTRY-8 P1-2): billing_hold_line, the payment line a stop without an invoice suspended", () => {
      const stopLine = (line: string | null) => stopForBilling(testEnv(), HOME, { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock }, { line });
      const ready = async () => {
        await setupKeys();
        const owner = await signIn("owner@example.test");
        await machineSetup(owner.token, owner.userId);
        await contracts("sub_b", { in_b_paid1: "sub_b" });
      };

      it("a hold set by suspending ANOTHER contract's line (A) is lifted by the current contract's (B's) paid invoice, once: no double grant", async () => {
        await ready();
        await stopLine("sub_a");
        expect(await homeRow()).toMatchObject({ billing_hold: 1, billing_hold_unattributed: 1, billing_hold_line: "sub_a" });
        clock += DAY;
        expect(await (await grantB()).json()).toMatchObject({ status: "done", amountUsd: 10 });
        expect(await homeRow()).toMatchObject({ billing_hold: 0, billing_hold_unattributed: 0, billing_hold_line: null });
        const grants = flux.grants.length;
        expect(await (await grantB()).json()).toMatchObject({ status: "done", amountUsd: 10 });
        expect(flux.grants).toHaveLength(grants);
        expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_grants WHERE invoice_id='in_b_paid1'").first()).toEqual({ n: 1 });
      });

      it("the current contract's OWN line keeps the hold", async () => {
        await ready();
        await stopLine("sub_b"); // B's own suspension
        clock += DAY;
        expect(await (await grantB()).json()).toMatchObject({ status: "held_by_billing_hold" });
        expect(await homeRow()).toMatchObject({ billing_hold: 1, billing_hold_line: "sub_b" });
      });
      it("an unknown line keeps the hold", async () => {
        await ready();
        await stopLine(null);
        clock += DAY;
        expect(await (await grantB()).json()).toMatchObject({ status: "held_by_billing_hold" });
      });
      it("two different lines in one hold (A, then C) keep it", async () => {
        await ready();
        await stopLine("sub_a"); await stopLine("sub_c");
        expect(await homeRow()).toMatchObject({ billing_hold: 1, billing_hold_line: null });
        clock += DAY;
        expect(await (await grantB()).json()).toMatchObject({ status: "held_by_billing_hold" });
      });
      it("another line's hold is not lifted by B's invoice while that invoice has an open or lost dispute", async () => {
        await ready();
        await stopLine("sub_a");
        await env.DB.prepare(`INSERT INTO payment_disputes (dispute_id,home_id,charge_id,invoice_id,subscription_id,scope,opened_at,closed_at,outcome)
          VALUES ('dp_b9','${HOME}','ch_b','in_b_paid1','sub_b','current',1,2,'lost')`).run();
        clock += DAY;
        expect(await (await grantB()).json()).toMatchObject({ status: "held_by_billing_hold" });
        expect(await homeRow()).toMatchObject({ billing_hold: 1 });
      });
    });

    it("B's invoice under an open dispute, or B no longer the current contract, never lifts it", async () => {
      await setupKeys();
      const owner = await signIn("owner@example.test");
      await machineSetup(owner.token, owner.userId);
      await contracts("sub_c", { in_a_paid1: "sub_a", in_b_paid1: "sub_b" });
      await admin("/v1/internal/flux/stop", { homeId: HOME, reason: "refunded", invoiceId: "in_a_paid1" });
      clock += DAY;
      expect(await (await grantB()).json()).toMatchObject({ status: "held_by_billing_hold" });
      expect(await homeRow()).toMatchObject({ billing_hold: 1 });
      await contracts("sub_b", {});
      await env.DB.prepare(`INSERT INTO payment_disputes (dispute_id,home_id,charge_id,invoice_id,subscription_id,scope,opened_at) VALUES ('dp_b','${HOME}','ch_b','in_b_paid2','sub_b','current',1)`).run();
      await contracts("sub_b", { in_b_paid2: "sub_b" });
      expect(await (await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_b_paid2", periodStart: clock - 2 * DAY, periodEnd: clock + 28 * DAY })).json())
        .toMatchObject({ status: "held_by_billing_hold" });
      expect(await homeRow()).toMatchObject({ billing_hold: 1 });
    });
  });

  // ── Astra INTEGRATED-9: the B4 grant ledger (b4-flux-ledger.ts). Every test asserts prepaid funds and spent credit untouched. ──
  const D = () => ({ fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
  const ledgerReady = async () => { await setupKeys(); const owner = await signIn("owner@example.test"); await machineSetup(owner.token, owner.userId); return owner; };
  const causes = (id: string) => env.DB.prepare("SELECT cause,ref,returned_cents,retained_microcents,revision FROM flux_grant_causes WHERE grant_id=? ORDER BY cause,ref")
    .bind(id).all<Record<string, unknown>>().then((r) => r.results);
  const dispatches = (id: string) => env.DB.prepare("SELECT kind,state,revision,outcome FROM flux_grant_dispatches WHERE grant_id=? ORDER BY claimed_at,rowid")
    .bind(id).all<Record<string, unknown>>().then((r) => r.results);
  const openDispute = (id: string, invoiceId: string) => env.DB.prepare(`INSERT INTO payment_disputes (dispute_id,home_id,charge_id,invoice_id,subscription_id,scope,opened_at)
    VALUES (?,?,'ch_1',?,'sub_a','current',1)`).bind(id, HOME, invoiceId).run();
  const closeDispute = (id: string, outcome: "won" | "lost", returnedCents: number | null = null) =>
    env.DB.prepare("UPDATE payment_disputes SET closed_at=?,outcome=?,returned_cents=? WHERE dispute_id=?").bind(clock, outcome, returnedCents, id).run();
  const sweeps = async (n = 1) => { for (let i = 0; i < n; i++) { clock += 20 * 60_000; await sweepFlux(testEnv(), D()); } };
  const opClaim = (id: string, b: Record<string, unknown> = { by: "ops-sean" }) => admin(`/v1/internal/flux/grants/${id}/claim`, b);
  /** INTEGRATED-10/11 (R8/R8b): a receipt names its grant, the claim's revision and the claim's ISSUED Flux adjustment reference (filled in unless given). */
  const opApplied = async (id: string, b: Record<string, unknown>) => {
    const rev = (await env.DB.prepare("SELECT revision FROM flux_grant_dispatches WHERE dispatch_id=?").bind(b.token ?? "").first<{ revision: number }>())?.revision ?? 1;
    const ref = (await env.DB.prepare("SELECT adjustment_ref AS r FROM flux_grant_dispatches WHERE dispatch_id=?").bind(b.token ?? "").first<{ r: string }>())?.r ?? `adj-${crypto.randomUUID()}`;
    // H2: the claim's allocated Flux wire revision (the hand adjustment carries it), filled in unless given.
    const wire = (await env.DB.prepare("SELECT remote_revision AS w FROM flux_grant_dispatches WHERE dispatch_id=?").bind(b.token ?? "").first<{ w: number | null }>())?.w;
    return admin(`/v1/internal/flux/grants/${id}/applied`, { grantId: id, revision: rev, adjustmentRef: ref, ...(wire ? { wireRevision: wire } : {}), ...b });
  };
  const amountOf = async (id: string) => (await ledgerAcct(id))!.amount_microcents as number;
  /** A paused router call: `inside` resolves when the call is at the router, `release()` lets it answer. */
  const pause = () => {
    let entered!: () => void; let release!: () => void;
    const inside = new Promise<void>((r) => { entered = r; }); const paused = new Promise<void>((r) => { release = r; });
    return { inside, release, wait: async () => { entered(); await paused; } };
  };

  it("refund (INTEGRATED-9): the stop cancels only ITS invoice's pending delivery; the delivered credit is revoked once the payment is fully refunded, retried by the cron", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_cur_0001")); // current period, delivered
    flux.down = true;
    await admin("/v1/internal/flux/grant", grantBody("pro", "in_next_0001", 40)); // pending, another invoice
    flux.down = false;
    const before = flux.balances();
    expect(await grantRow("inv:in_next_0001")).toMatchObject({ status: "pending" });
    await coverRefund("in_cur_0001", 4900); // the whole payment refunded (succeeded)
    flux.revokeDown = true;
    expect((await admin("/v1/internal/flux/stop", { homeId: HOME, reason: "refunded", invoiceId: "in_cur_0001" })).status).toBe(200);
    expect(await grantRow("inv:in_next_0001")).toMatchObject({ status: "pending" }); // another invoice's delivery is never cancelled by this stop
    expect(await grantRow("inv:in_cur_0001")).toMatchObject({ status: "done" });
    expect(await ledgerAcct("inv:in_cur_0001")).toMatchObject({ desired_microcents: 0, router_state: "revoking" });
    expect(flux.revokes).toHaveLength(0);
    clock += 5 * 60_000;
    await sweep();
    expect(flux.revokes).toHaveLength(0); // too soon to retry
    clock += 11 * 60_000;
    flux.revokeDown = false;
    await sweep();
    expect(flux.revokes).toEqual([{ grantId: "inv:in_cur_0001", reason: "returned_money" }]);
    expect(await grantRow("inv:in_cur_0001")).toMatchObject({ status: "reversed" });
    expect(await ledgerAcct("inv:in_cur_0001")).toMatchObject({ router_state: "revoked", applied_microcents: 0 });
    await sweep();
    expect(flux.revokes).toHaveLength(1);
    expect(flux.balances()).toEqual(before);
  });

  it("Astra TAXCOUNTRY-9 P1-6 / INTEGRATED-9: dispute -> B3 suspension -> stops never remove credit; a full refund's revoke waits while the contract's dispute is OPEN (read at revoke time) and goes ahead after WON", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_cur_0001")); // the disputed month, delivered
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_old_0001", -1)); // an earlier month of the same contract
    for (const inv of ["in_cur_0001", "in_old_0001"]) {
      await env.DB.prepare(`INSERT OR REPLACE INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,subscription_id) VALUES (?,'period',?,'starter',1,'sub_a')`).bind(inv, HOME).run();
    }
    const before = flux.balances();
    const d = D();
    await openDispute("dp_r10", "in_cur_0001");
    await stopForBilling(testEnv(), HOME, d, { invoiceId: "in_cur_0001", keepGrants: true, line: "sub_a" });
    await stopForBilling(testEnv(), HOME, d, { line: "sub_a" }); // B3 suspension
    await stopForBilling(testEnv(), HOME, d, { invoiceId: "in_old_0001" }); // any other stop of the same contract
    expect(await grantRow("inv:in_cur_0001")).toMatchObject({ status: "done" });
    expect(await grantRow("inv:in_old_0001")).toMatchObject({ status: "done" });
    expect(flux.revokes).toEqual([]); // a stop returns no money: it removes no credit
    // The earlier month is refunded in full while the contract's dispute is OPEN: the revoke waits (read at revoke time).
    await coverRefund("in_old_0001", 4900);
    await sweeps(2);
    expect(flux.revokes).toEqual([]);
    expect(await ledgerAcct("inv:in_old_0001")).toMatchObject({ desired_microcents: 0, router_state: "delivered" });
    await closeDispute("dp_r10", "won");
    await sweeps();
    // WON returned nothing: the disputed month keeps its credit; the refunded month is revoked.
    expect(flux.revokes).toEqual([{ grantId: "inv:in_old_0001", reason: "returned_money" }]);
    expect(await ledgerAcct("inv:in_cur_0001")).toMatchObject({ desired_microcents: (await amountOf("inv:in_cur_0001")), router_state: "delivered" });
    expect(flux.balances()).toEqual(before);
  });

  it("Astra TAXCOUNTRY-9 P1-6 / INTEGRATED-9: a LOST dispute whose payment amount is unknown is never revoked by a stop or the sweep: sized by hand (alerted), the receipt settles that revision", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_cur_0001"));
    const id = "inv:in_cur_0001";
    const before = flux.balances();
    await env.DB.prepare(`INSERT INTO payment_disputes (dispute_id,home_id,charge_id,invoice_id,subscription_id,scope,opened_at,closed_at,outcome,returned_cents)
      VALUES ('dp_r10l','${HOME}','ch_1','in_cur_0001','sub_a','current',1,2,'lost',4900)`).run();
    await stopForBilling(testEnv(), HOME, D(), { line: "sub_a" });
    await sweeps(2);
    expect(await grantRow(id)).toMatchObject({ status: "done" });
    expect(flux.revokes).toEqual([]);
    expect(await ledgerAcct(id)).toMatchObject({ sized: 0, returned_cents: 4900, paid_cents: null });
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.removal_owed", open: true, sized: 0, returnedCents: 4900 });
    const claim = await opClaim(id);
    expect(claim.status).toBe(200);
    const { token } = await claim.json<{ token: string }>();
    expect((await opApplied(id, { token, appliedMicrocents: 0, sizing: { paidCents: 4900, evidence: "Stripe invoice in_cur_0001: amount paid $49.00" }, evidence: "bank statement: $49.00 returned; Flux adjustment adj_l (by hand)", by: "ops-sean" })).status).toBe(200);
    await sweeps();
    expect(await ledgerAlert(id)).toMatchObject({ open: false });
    expect(await ledgerAcct(id)).toMatchObject({ router_state: "manual", desired_microcents: 0, applied_microcents: 0 });
    expect(flux.revokes).toEqual([]);
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-7/9 a dispute's Stop cancels its pending delivery (held, nothing sent while OPEN); LOST of a known payment: the lost share is a removal owed by hand, never a full revoke", async () => {
    await ledgerReady();
    flux.down = true; // the delivery's answer is lost: the grant stays pending, it may be at Flux
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_amb_dp1"));
    flux.down = false;
    const id = "inv:in_amb_dp1"; const G = await amountOf(id);
    const before = flux.balances();
    await openDispute("dp_i7f", "in_amb_dp1");
    await stopForBilling(testEnv(), HOME, D(), { invoiceId: "in_amb_dp1", keepGrants: true, line: "sub_a" });
    expect(await grantRow(id)).toMatchObject({ status: "cancelled", redeliver: "held" });
    expect(await causes(id)).toContainEqual(expect.objectContaining({ cause: "cancellation", returned_cents: 0, retained_microcents: G }));
    await sweeps();
    expect(flux.revokes).toEqual([]);
    expect(await ledgerAlert(id)).toBeNull(); // held for the bank's decision: nothing owed yet
    await coverRefund("in_amb_dp1", 0); // the payment's amount is known (nothing refunded)
    await closeDispute("dp_i7f", "lost", 1000);
    await sweeps(2);
    expect(flux.revokes).toEqual([]);
    expect(await ledgerAcct(id)).toMatchObject({ returned_cents: 1000, desired_microcents: share(G, 1000), applied_microcents: 0, router_state: "maybe" });
    // Flux may hold the whole grant (maybe) or nothing: the alert says so; the operator reads the router before adjusting by hand.
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.delivery_owed", open: true, routerState: "maybe", desiredMicrocents: share(G, 1000) });
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-8/9 OPEN -> WON/$0: the dispute Stop's cancelled delivery (its answer was lost) is re-delivered under the SAME id on WON: one credit, nothing revoked", async () => {
    await ledgerReady();
    flux.grantAckLost = true; // the credit is created at Flux, its answer lost
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_won_i8"));
    flux.grantAckLost = false;
    const id = "inv:in_won_i8"; const G = await amountOf(id);
    const before = flux.balances();
    await openDispute("dp_i8w", "in_won_i8");
    await stopForBilling(testEnv(), HOME, D(), { invoiceId: "in_won_i8", keepGrants: true, line: "sub_a" });
    expect(await grantRow(id)).toMatchObject({ status: "cancelled", redeliver: "held" });
    await sweeps();
    expect(flux.revokes).toEqual([]);
    await closeDispute("dp_i8w", "won");
    await sweeps(3);
    expect(flux.revokes).toEqual([]);
    expect(await grantRow(id)).toMatchObject({ status: "done", redeliver: null });
    expect(await ledgerAcct(id)).toMatchObject({ router_state: "delivered", applied_microcents: G, desired_microcents: G });
    expect(flux.grants.filter((g) => g.grantId === id)).toHaveLength(1);
    expect(flux.credits.get(id)).toBe(G);
    expect(await ledgerAlert(id)).toBeNull();
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-8b/9 partial refund with a cancelled possibly-delivered grant: never a revoke for a share (removal owed by hand); the full refund revokes it once; prepaid and spent untouched", async () => {
    await ledgerReady();
    flux.grantAckLost = true; // the credit is created at Flux, its answer lost: pending, it may be there
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_rf_i8b"));
    flux.grantAckLost = false;
    const id = "inv:in_rf_i8b"; const G = await amountOf(id);
    flux.spend(id, 3_000_000);
    const before = flux.balances();
    await stopForBilling(testEnv(), HOME, D(), { invoiceId: "in_rf_i8b", keepGrants: true });
    expect(await grantRow(id)).toMatchObject({ status: "cancelled" });
    // Nothing returned yet: nothing sent; the cancelled delivery stays owed (the router may hold it).
    await sweeps();
    expect(flux.revokes).toEqual([]);
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.delivery_owed", open: true, routerState: "maybe", debtMicrocents: G });
    await coverRefund("in_rf_i8b", 1000);
    await sweeps(2);
    expect(flux.revokes).toEqual([]);
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.delivery_owed", open: true, routerState: "maybe", desiredMicrocents: share(G, 1000) });
    expect(share(G, 1000)).toBe(G - Number(BigInt(G) * 1000n / 4900n));
    await coverRefund("in_rf_i8b", 4900);
    await sweeps(2);
    expect(flux.revokes).toEqual([{ grantId: id, reason: "returned_money" }]);
    expect(await ledgerAcct(id)).toMatchObject({ router_state: "revoked", applied_microcents: 0, desired_microcents: 0 });
    expect(await ledgerAlert(id)).toMatchObject({ open: false });
    expect(flux.balances()).toEqual(before); // prepaid funds and the spent part are never touched by a grant revoke
  });

  it("INTEGRATED-8b/9 WON re-delivery: each dispute's Stop holds its own invoice's delivery; both are delivered again under the SAME id: one credit each", async () => {
    await ledgerReady();
    flux.grantAckLost = true;
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_rd_a"));
    flux.grantAckLost = false;
    flux.down = true;
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_rd_b", 31));
    flux.down = false;
    const G = await amountOf("inv:in_rd_a");
    const before = flux.balances();
    expect([flux.credits.has("inv:in_rd_a"), flux.credits.has("inv:in_rd_b")]).toEqual([true, false]);
    for (const [dp, inv] of [["dp_rd_a", "in_rd_a"], ["dp_rd_b", "in_rd_b"]]) {
      await openDispute(dp, inv);
      await stopForBilling(testEnv(), HOME, D(), { invoiceId: inv, keepGrants: true, line: "sub_a" });
    }
    for (const id of ["inv:in_rd_a", "inv:in_rd_b"]) expect(await grantRow(id)).toMatchObject({ status: "cancelled", redeliver: "held" });
    await sweeps();
    expect(await grantRow("inv:in_rd_a")).toMatchObject({ status: "cancelled", redeliver: "held" }); // still OPEN: nothing moves
    await closeDispute("dp_rd_a", "won"); await closeDispute("dp_rd_b", "won");
    flux.grantAckLost = true; // the first re-delivery lands but its answer is lost again
    await sweeps();
    flux.grantAckLost = false;
    await sweeps(2);
    for (const id of ["inv:in_rd_a", "inv:in_rd_b"]) {
      expect(await grantRow(id)).toMatchObject({ status: "done", redeliver: null });
      expect(flux.grants.filter((g) => g.grantId === id)).toHaveLength(1); // ONE credit per grant id, however often it was delivered
      expect(flux.credits.get(id)).toBe(G);
    }
    expect(flux.deliveries.filter((x) => x.grantId === "inv:in_rd_a").length).toBeGreaterThanOrEqual(3);
    expect(flux.revokes).toEqual([]);
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-9 slow sweep then claim: the revoke's claim time is the database's at the claim (never the sweep's start); while it is at the router no operator can claim", async () => {
    await ledgerReady();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_l9_slow"));
    const id = "inv:in_l9_slow";
    flux.spend(id, 1_000_000);
    const before = flux.balances();
    await coverRefund("in_l9_slow", 4900);
    const p = pause();
    const orig = flux.revokeGrant.bind(flux);
    flux.revokeGrant = async (g: string, reason: string) => { await p.wait(); return orig(g, reason); };
    const realStart = Date.now();
    clock += 20 * 60_000;
    const staleNow = clock; // the sweep's own clock never moves while it works
    const a = sweepFlux(testEnv(), D());
    await p.inside;
    const open = await env.DB.prepare("SELECT * FROM flux_grant_dispatches WHERE grant_id=? AND state='open'").bind(id).first<Record<string, number | string>>();
    expect(open).toMatchObject({ kind: "revoke", revision: (await ledgerAcct(id))!.revision });
    expect(open!.claimed_at as number).toBeGreaterThanOrEqual(realStart - 1000);
    expect(open!.claimed_at).not.toBe(staleNow);
    expect(open!.expires_at).toBe((open!.claimed_at as number) + DISPATCH_TTL_MS);
    const refused = await opClaim(id, { by: "ops-sean", evidence: "router shows the grant active" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "dispatch_in_flight", open: { kind: "revoke" } });
    p.release(); await a;
    expect(await ledgerAcct(id)).toMatchObject({ router_state: "revoked", applied_microcents: 0, desired_microcents: 0 });
    expect((await dispatches(id)).map((x) => `${x.kind}:${x.state}`)).toEqual(["deliver:applied", "revoke:applied"]);
    expect(flux.revokes).toEqual([{ grantId: id, reason: "returned_money" }]);
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-9 crash BEFORE dispatch: the claim survives; nothing is sent while it is open (time alone never settles it); once expired a revoke supersedes it, sent once", async () => {
    await ledgerReady();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_l9_cb"));
    const id = "inv:in_l9_cb";
    const before = flux.balances();
    await coverRefund("in_l9_cb", 4900);
    armDb(/SELECT revision,claimed_at FROM flux_grant_dispatches/, async () => { throw new Error("crash"); }); // dies right after the claim
    await sweeps();
    expect(flux.revokes).toEqual([]);
    expect((await dispatches(id)).map((x) => `${x.kind}:${x.state}`)).toEqual(["deliver:applied", "revoke:open"]);
    expect(await ledgerAcct(id)).toMatchObject({ router_state: "revoking" }); // the claim itself says it may be at the router
    await sweeps(2);
    expect(flux.revokes).toEqual([]);
    await env.DB.prepare("UPDATE flux_grant_dispatches SET expires_at=0 WHERE grant_id=? AND state='open'").bind(id).run();
    await sweeps();
    expect(flux.revokes).toEqual([{ grantId: id, reason: "returned_money" }]);
    expect((await dispatches(id)).map((x) => `${x.kind}:${x.state}`)).toEqual(["deliver:applied", "revoke:superseded", "revoke:applied"]);
    expect(await ledgerAcct(id)).toMatchObject({ router_state: "revoked", applied_microcents: 0 });
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-9 crash AFTER dispatch: the router applied the delivery, its completion was lost; the expired claim is superseded by a re-delivery under the same id: one credit (R1)", async () => {
    await ledgerReady();
    const before = flux.balances();
    armDb(/UPDATE flux_grant_dispatches SET state=\?,outcome=\?/, async () => { throw new Error("crash"); });
    await expect(grantMonthlyCredits(testEnv(), grantBody("starter", "in_l9_ca"), D())).rejects.toThrow("crash");
    const id = "inv:in_l9_ca"; const G = await amountOf(id);
    expect(flux.credits.get(id)).toBe(G);
    expect(await grantRow(id)).toMatchObject({ status: "pending", attempts: 1 });
    expect(await ledgerAcct(id)).toMatchObject({ router_state: "maybe", applied_microcents: 0 });
    await sweeps();
    expect(flux.deliveries).toHaveLength(1); // the claim is still open: no second request
    await env.DB.prepare("UPDATE flux_grant_dispatches SET expires_at=0 WHERE grant_id=? AND state='open'").bind(id).run();
    await sweeps();
    expect(flux.deliveries).toHaveLength(2);
    expect(flux.grants.filter((g) => g.grantId === id)).toHaveLength(1);
    expect(await grantRow(id)).toMatchObject({ status: "done" });
    expect(await ledgerAcct(id)).toMatchObject({ router_state: "delivered", applied_microcents: G, delivered_confirmed_microcents: G });
    expect((await dispatches(id)).map((x) => x.state)).toEqual(["superseded", "applied"]);
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-9 expiry: an expired OPERATOR claim is never taken over by an automatic send, nor by another operator without evidence", async () => {
    await ledgerReady();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_l9_exp"));
    const id = "inv:in_l9_exp";
    const before = flux.balances();
    await coverRefund("in_l9_exp", 1000);
    await sweeps();
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.removal_owed", open: true });
    expect((await opClaim(id)).status).toBe(200);
    await env.DB.prepare("UPDATE flux_grant_dispatches SET expires_at=0 WHERE grant_id=? AND state='open'").bind(id).run();
    await coverRefund("in_l9_exp", 4900); // fully refunded now: a revoke would be automatic, but the operator may be adjusting by hand
    await sweeps(2);
    expect(flux.revokes).toEqual([]);
    expect((await opClaim(id, { by: "ops-b" })).status).toBe(409);
    const taken = await opClaim(id, { by: "ops-b", evidence: "Flux admin: grant untouched, no hand adjustment recorded by ops-sean" });
    expect(taken.status).toBe(200);
    expect((await dispatches(id)).filter((x) => x.kind === "operator").map((x) => x.state)).toEqual(["superseded", "open"]);
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-9 failed send racing a cause change: a revoke claimed at full coverage fails while one refund fails; the new cause and revision are kept, nothing more is sent, the removal stays owed", async () => {
    await ledgerReady();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_l9_race"));
    const id = "inv:in_l9_race"; const G = await amountOf(id);
    const before = flux.balances();
    await coverRefund("in_l9_race", 2000, "pi_r1");
    await coverRefund("in_l9_race", 2900, "pi_r2");
    const p = pause();
    const orig = flux.revokeGrant.bind(flux);
    flux.revokeGrant = async (g: string, reason: string) => { await p.wait(); return orig(g, reason); };
    clock += 20 * 60_000;
    const a = sweepFlux(testEnv(), D());
    await p.inside;
    const rev = (await ledgerAcct(id))!.revision as number;
    // Meanwhile the second refund fails, and another stop of the home re-reads the account (where the old code folded).
    await coverRefund("in_l9_race", 0, "pi_r2");
    await stopForBilling(testEnv(), HOME, D(), { invoiceId: "in_l9_race", keepGrants: true });
    expect(await ledgerAcct(id)).toMatchObject({ desired_microcents: share(G, 2000), revision: rev + 1 });
    flux.revokeDown = true;
    p.release(); await a;
    flux.revokeGrant = orig;
    expect(await ledgerAcct(id)).toMatchObject({ desired_microcents: share(G, 2000), revision: rev + 1, router_state: "revoking", applied_microcents: G });
    // INTEGRATED-10 (L5): an ambiguous answer keeps the revoke OPEN (it may still execute): ownership is never released by it.
    expect((await dispatches(id)).at(-1)).toMatchObject({ kind: "revoke", state: "open" });
    flux.revokeDown = false;
    await sweeps(2);
    expect(flux.revokes).toEqual([]);
    expect(await causes(id)).toContainEqual(expect.objectContaining({ cause: "refund", ref: "pi_r2", returned_cents: 0, revision: rev + 1 }));
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.removal_owed", open: true, revision: rev + 1, routerState: "revoking" });
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-9 late acknowledgement with a stale token: a delivery outlives its claim, a re-delivery supersedes it; the late answer changes nothing", async () => {
    await ledgerReady();
    const before = flux.balances();
    const p = pause();
    flux.onGrant = () => p.wait();
    const first = grantMonthlyCredits(testEnv(), grantBody("starter", "in_l9_late"), D());
    await p.inside;
    const id = "inv:in_l9_late"; const G = await amountOf(id);
    const firstToken = flux.deliveries[0].deliveryId;
    await env.DB.prepare("UPDATE flux_grant_dispatches SET expires_at=0 WHERE dispatch_id=?").bind(firstToken).run();
    await sweeps(); // the re-delivery supersedes the expired claim and is applied
    expect(await ledgerAcct(id)).toMatchObject({ router_state: "delivered", applied_microcents: G });
    const settled = { grant: await grantRow(id), acct: await ledgerAcct(id) };
    flux.afterGrant = async () => { throw new FluxError(400, "", "invalid_request"); }; // the late answer is a refusal
    p.release(); await first;
    expect(await grantRow(id)).toEqual(settled.grant);
    expect(await ledgerAcct(id)).toEqual(settled.acct);
    expect((await dispatches(id)).map((x) => x.state)).toEqual(["superseded", "applied"]);
    expect(flux.grants.filter((g) => g.grantId === id)).toHaveLength(1);
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-9 operator: /applied without a claim is refused; the claim excludes every automatic send; /applied with it settles the account (manual), once", async () => {
    await ledgerReady();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_l9_op"));
    const id = "inv:in_l9_op"; const G = await amountOf(id);
    flux.spend(id, 2_000_000);
    const before = flux.balances();
    await coverRefund("in_l9_op", 1000);
    await sweeps();
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.removal_owed", open: true, desiredMicrocents: share(G, 1000), appliedMicrocents: G,
      debtMicrocents: share(G, 1000) - G });
    expect((await opApplied(id, { token: crypto.randomUUID(), appliedMicrocents: share(G, 1000), evidence: "Flux adjustment adj_1", by: "ops-sean" })).status).toBe(409);
    const claim = await opClaim(id);
    expect(claim.status).toBe(200);
    const { token, debtMicrocents } = await claim.json<{ token: string; debtMicrocents: number }>();
    expect(debtMicrocents).toBe(share(G, 1000) - G);
    await coverRefund("in_l9_op", 4900); // fully refunded while ops holds the claim: the automatic revoke never runs alongside
    await sweeps(2);
    expect(flux.revokes).toEqual([]);
    expect((await opApplied(id, { token, appliedMicrocents: 0, evidence: "Flux adjustment adj_9: unspent remainder removed by hand", by: "ops-sean" })).status).toBe(200);
    expect(await ledgerAcct(id)).toMatchObject({ router_state: "manual", applied_microcents: 0, desired_microcents: 0 });
    await sweeps();
    expect(await ledgerAlert(id)).toMatchObject({ open: false });
    expect((await opApplied(id, { token, appliedMicrocents: 0, evidence: "again, the same receipt", by: "ops-sean" })).status).toBe(409);
    expect(flux.revokes).toEqual([]);
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-9 partial refund + OPEN dispute -> LOST: both causes are kept (the refund's share is never lost to the dispute); one partial debt, alerted, nothing revoked", async () => {
    await ledgerReady();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_l9_mix"));
    const id = "inv:in_l9_mix"; const G = await amountOf(id);
    const before = flux.balances();
    await coverRefund("in_l9_mix", 1000);
    await openDispute("dp_l9_mix", "in_l9_mix");
    await sweeps();
    expect(await ledgerAcct(id)).toMatchObject({ returned_cents: 1000, desired_microcents: share(G, 1000) }); // OPEN: the bank returned nothing yet
    await closeDispute("dp_l9_mix", "lost", 2000);
    await sweeps();
    expect(await ledgerAcct(id)).toMatchObject({ returned_cents: 3000, desired_microcents: share(G, 3000), applied_microcents: G, sized: 1 });
    expect(await causes(id)).toMatchObject([{ cause: "dispute_loss", ref: "dp_l9_mix", returned_cents: 2000 }, { cause: "refund", ref: "pi_in_l9_mix", returned_cents: 1000 }]);
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.removal_owed", open: true, debtMicrocents: share(G, 3000) - G });
    expect(flux.revokes).toEqual([]);
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-9 cancellation then OPEN -> WON: a cancelled delivery that may have landed is never revoked with nothing returned; its delivery stays owed (alerted)", async () => {
    await ledgerReady();
    flux.grantAckLost = true; // created at Flux, its answer lost
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_l9_won"));
    flux.grantAckLost = false;
    const id = "inv:in_l9_won"; const G = await amountOf(id);
    const before = flux.balances();
    await stopForBilling(testEnv(), HOME, D(), { line: "sub_a" }); // a suspension cancels its delivery (nothing returned)
    expect(await grantRow(id)).toMatchObject({ status: "cancelled", redeliver: null });
    expect(await causes(id)).toMatchObject([{ cause: "cancellation", returned_cents: 0, retained_microcents: G }]);
    await openDispute("dp_l9_won", "in_l9_won");
    await sweeps();
    await closeDispute("dp_l9_won", "won");
    await sweeps(3);
    expect(flux.revokes).toEqual([]);
    expect(flux.credits.get(id)).toBe(G);
    expect(await ledgerAcct(id)).toMatchObject({ desired_microcents: G, router_state: "maybe" });
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.delivery_owed", open: true, routerState: "maybe", debtMicrocents: G });
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-9 two partial refunds reach full coverage (revoked once), then one fails: the restoration debt is owed and alerted, never left settled", async () => {
    await ledgerReady();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_l9_two"));
    const id = "inv:in_l9_two"; const G = await amountOf(id);
    flux.spend(id, 5_000_000);
    const before = flux.balances();
    await coverRefund("in_l9_two", 2000, "pi_t1");
    await sweeps();
    expect(flux.revokes).toEqual([]);
    await coverRefund("in_l9_two", 2900, "pi_t2");
    await sweeps();
    expect(flux.revokes).toEqual([{ grantId: id, reason: "returned_money" }]);
    expect(await ledgerAcct(id)).toMatchObject({ desired_microcents: 0, applied_microcents: 0, router_state: "revoked" });
    expect(await ledgerAlert(id)).toMatchObject({ open: false });
    const rev = (await ledgerAcct(id))!.revision as number;
    await coverRefund("in_l9_two", 0, "pi_t2"); // the second refund failed
    await sweeps();
    expect(await ledgerAcct(id)).toMatchObject({ returned_cents: 2000, desired_microcents: share(G, 2000), applied_microcents: 0, revision: rev + 1 });
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.delivery_owed", open: true, debtMicrocents: share(G, 2000), routerState: "revoked" });
    expect(flux.revokes).toHaveLength(1);
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-9 never-dispatched grant + partial refund: its retained entitlement is journaled before the cancellation; another invoice's pending grant is untouched", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId); // never linked: paid before linking, never dispatched
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_l9_nda"));
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_l9_ndb", 31));
    const a = "inv:in_l9_nda"; const b = "inv:in_l9_ndb"; const G = await amountOf(a);
    const before = flux.balances();
    expect(flux.deliveries).toEqual([]);
    await coverRefund("in_l9_nda", 1000);
    await stopForBilling(testEnv(), HOME, D(), { invoiceId: "in_l9_nda", keepGrants: true });
    expect(await grantRow(a)).toMatchObject({ status: "cancelled", attempts: 0 });
    expect(await grantRow(b)).toMatchObject({ status: "pending" });
    expect(await causes(a)).toMatchObject([{ cause: "cancellation", returned_cents: 0, retained_microcents: share(G, 1000) }, { cause: "refund", returned_cents: 1000 }]);
    expect(await causes(b)).toEqual([]);
    await sweeps();
    expect(await ledgerAlert(a)).toMatchObject({ kind: "credit.delivery_owed", open: true, debtMicrocents: share(G, 1000), routerState: "none" });
    expect(await ledgerAlert(b)).toBeNull();
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-9 WON + partial refund: a grant that never arrived keeps its unrefunded share owed (never suppressed); re-delivered by hand through the claim", async () => {
    await ledgerReady();
    flux.down = true; // never arrived
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_l9_wp"));
    flux.down = false;
    const id = "inv:in_l9_wp"; const G = await amountOf(id);
    const before = flux.balances();
    await openDispute("dp_l9_wp", "in_l9_wp");
    await stopForBilling(testEnv(), HOME, D(), { invoiceId: "in_l9_wp", keepGrants: true, line: "sub_a" });
    expect(await grantRow(id)).toMatchObject({ status: "cancelled", redeliver: "held" });
    await coverRefund("in_l9_wp", 1000);
    await closeDispute("dp_l9_wp", "won");
    await sweeps(2);
    expect(flux.grants).toEqual([]); // a share is never delivered automatically (the grant's amount is frozen)
    expect(await ledgerAcct(id)).toMatchObject({ desired_microcents: share(G, 1000), applied_microcents: 0 });
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.delivery_owed", open: true, debtMicrocents: share(G, 1000) });
    // INTEGRATED-10 (L5): the lost delivery may still land (its dispatch stays open): the operator first writes the grant's tombstone, which
    // subsumes it, then credits the share by hand.
    const { token } = await (await opClaim(id, { by: "ops-sean", tombstone: true, evidence: "wrote the tombstone of inv:in_l9_wp at the Flux app" })).json<{ token: string }>();
    expect((await opApplied(id, { token, appliedMicrocents: share(G, 1000), evidence: "Flux credit adj_wp (by hand, the unrefunded share)", by: "ops-sean" })).status).toBe(200);
    await sweeps();
    expect(await ledgerAlert(id)).toMatchObject({ open: false });
    expect(flux.revokes).toEqual([]);
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-9 19 ambiguous attempts, then the WON re-delivery fails once more: retry exhaustion keeps the delivery owed and alerted, never discharged", async () => {
    await ledgerReady();
    flux.down = true;
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_l9_x20"));
    const id = "inv:in_l9_x20"; const G = await amountOf(id);
    const before = flux.balances();
    await env.DB.prepare("UPDATE flux_grants SET attempts=19 WHERE grant_id=?").bind(id).run();
    await openDispute("dp_l9_x20", "in_l9_x20");
    await stopForBilling(testEnv(), HOME, D(), { invoiceId: "in_l9_x20", keepGrants: true, line: "sub_a" }).catch(() => undefined); // Flux down: the router Stop is retried
    await closeDispute("dp_l9_x20", "won");
    await sweeps(); // re-delivered under the same id: attempt 20 fails too
    expect(await grantRow(id)).toMatchObject({ status: "failed", attempts: 20 });
    await sweeps(3);
    expect(await ledgerAcct(id)).toMatchObject({ desired_microcents: G, applied_microcents: 0, router_state: "maybe" });
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.delivery_owed", open: true, debtMicrocents: G, grantStatus: "failed" });
    expect(flux.revokes).toEqual([]);
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-9 ops removes a partial target by hand, then the refund fails: the restoration debt is owed and alerted", async () => {
    await ledgerReady();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_l9_kc"));
    const id = "inv:in_l9_kc"; const G = await amountOf(id);
    const before = flux.balances();
    await coverRefund("in_l9_kc", 1000);
    await sweeps();
    const { token } = await (await opClaim(id)).json<{ token: string }>();
    expect((await opApplied(id, { token, appliedMicrocents: share(G, 1000), evidence: "Flux adjustment adj_kc", by: "ops-sean" })).status).toBe(200);
    await sweeps();
    expect(await ledgerAlert(id)).toMatchObject({ open: false });
    const rev = (await ledgerAcct(id))!.revision as number;
    await coverRefund("in_l9_kc", 0); // the refund failed: nothing returned
    await sweeps();
    expect(await ledgerAcct(id)).toMatchObject({ desired_microcents: G, applied_microcents: share(G, 1000), router_state: "manual", revision: rev + 1 });
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.delivery_owed", open: true, debtMicrocents: G - share(G, 1000) });
    expect(flux.revokes).toEqual([]);
    expect(flux.balances()).toEqual(before);
  });

  // ── Astra INTEGRATED-10. Every test asserts prepaid funds and spent credit untouched. ──
  const openDispatches = (id: string) => env.DB.prepare("SELECT kind,state,by FROM flux_grant_dispatches WHERE grant_id=? AND state='open'").bind(id)
    .all<Record<string, unknown>>().then((r) => r.results);
  const dispatchCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_grant_dispatches").first<{ n: number }>())!.n;
  const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;
  const lostDispute = (id: string, invoiceId: string, returnedCents: number) => env.DB.prepare(`INSERT INTO payment_disputes
    (dispute_id,home_id,charge_id,invoice_id,subscription_id,scope,opened_at,closed_at,outcome,returned_cents) VALUES (?,?,'ch_1',?,'sub_a','current',1,2,'lost',?)`)
    .bind(id, HOME, invoiceId, returnedCents).run();
  const workerWith = (d: FluxDependencies) => createWorker(undefined, undefined, {}, {}, {}, { jwksFetch, authFetch: fluxAuthFetch }, {}, d);
  async function adminVia(w: ReturnType<typeof workerWith>, path: string, body: unknown) {
    const ctx = createExecutionContext();
    const r = await w.fetch(new Request(`https://auth.murage.test${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify(body) }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return r;
  }

  it("INTEGRATED-10 Flux-off gate: grant, stop, sweep and the operator endpoints never reach the router nor open an automatic dispatch; the ledger still records refunds, disputes and cancellations", async () => {
    await ledgerReady();
    const variants: [string, Record<string, string | undefined>, FluxDependencies["billingFlux"]][] = [
      ["switch unset (launch)", { CLOUD_FLUX_ROUTES_ENABLED: undefined }, QUALIFIED_HOOKS],
      ["stub hooks", {}, stubFluxHooks],
      ["no service token", { FLUX_CLOUD_SERVICE_TOKEN: undefined }, QUALIFIED_HOOKS],
    ];
    let i = 0;
    for (const [label, over, hooks] of variants) {
      i++;
      extra = over;
      const calls: string[] = [];
      // A router that fails the test if called: every call is recorded (a thrown error alone could be swallowed by a retry path).
      const failing = new Proxy({}, { get: (_t, name) => async () => { calls.push(String(name)); throw new Error(`router called with Flux off: ${String(name)}`); } }) as unknown as FluxClient;
      const d: FluxDependencies = { fluxClient: () => failing, billingFlux: hooks, now: () => clock };
      const before = flux.balances();
      const dispatchesBefore = await dispatchCount();
      const pendingId = `inv:in_off${i}_a`; const doneId = `inv:in_off${i}_b`;
      expect(await grantMonthlyCredits(testEnv(), grantBody("starter", `in_off${i}_a`, i * 40), d)).toMatchObject({ status: "pending" });
      // A grant delivered before Flux was switched off, then refunded in part and charged back in part.
      await env.DB.prepare(`INSERT INTO flux_grants (grant_id,entitlement_key,home_id,invoice_id,plan,amount_microcents,period_start,period_end,expires_at,status,attempts,created_at)
        VALUES (?,?,?,?,'starter',10000000,0,1,?,'done',1,?)`).bind(doneId, `k:${doneId}`, HOME, `in_off${i}_b`, clock + 40 * DAY, clock).run();
      await coverRefund(`in_off${i}_b`, 1000, `pi_off${i}_b`);
      await lostDispute(`dp_off${i}`, `in_off${i}_b`, 2000);
      await coverRefund(`in_off${i}_a`, 0, `pi_off${i}_a`);
      await stopForBilling(testEnv(), HOME, d, { invoiceId: `in_off${i}_a` }).catch(() => undefined); // the cancellation (journal only)
      clock += 20 * 60_000;
      await sweepFlux(testEnv(), d);
      clock += 20 * 60_000;
      await sweepFlux(testEnv(), d);
      // The ledger's accounting still follows the money: causes, desired and the debt's alert.
      const G = 10_000_000;
      expect([label, await ledgerAcct(doneId)]).toMatchObject([label, { returned_cents: 3000, desired_microcents: share(G, 3000), applied_microcents: G, router_state: "delivered" }]);
      expect([label, await causes(doneId)]).toMatchObject([label, [{ cause: "dispute_loss", returned_cents: 2000 }, { cause: "refund", returned_cents: 1000 }]]);
      expect([label, await ledgerAlert(doneId)]).toMatchObject([label, { kind: "credit.removal_owed", open: true, debtMicrocents: share(G, 3000) - G }]);
      expect([label, (await causes(pendingId)).map((c) => c.cause)]).toEqual([label, ["cancellation", "refund"]]);
      // INTEGRATED-11 (ledger R9): the operator's evidenced recovery makes no router call and works while off: a claim (an OPERATOR row),
      // and a receipt that needs the claim's own issued reference. No automatic dispatch is ever opened.
      const w = workerWith(d);
      const acct = await ledgerAcct(doneId);
      const claimed = await adminVia(w, `/v1/internal/flux/grants/${doneId}/claim`, { by: "ops-sean" });
      expect([label, claimed.status]).toEqual([label, 200]);
      const c = await claimed.json<{ token: string; revision: number; adjustmentRef: string }>();
      expect([label, c.adjustmentRef]).toEqual([label, `murage:${doneId}:r${c.revision}:${c.token}`]);
      const r = await adminVia(w, `/v1/internal/flux/grants/${doneId}/applied`,
        { token: c.token, grantId: doneId, revision: c.revision, appliedMicrocents: 0, adjustmentRef: "fx-off", evidence: "Flux adjustment fx-off", by: "ops-sean" });
      expect([label, r.status, await r.json()]).toEqual([label, 409, { error: "adjustment_ref_mismatch" }]);
      expect([label, await ledgerAcct(doneId)]).toEqual([label, acct]);
      expect([label, await dispatchCount()]).toEqual([label, dispatchesBefore + 1]); // the operator's claim only
      expect([label, await count("SELECT COUNT(*) AS n FROM flux_grant_dispatches WHERE kind<>'operator'")]).toEqual([label, 0]);
      expect([label, calls]).toEqual([label, []]);
      expect([label, flux.grants, flux.revokes, flux.balances()]).toEqual([label, [], [], before]);
    }
  });

  it("INTEGRATED-10 expiry: a confirmed revoke, the grant's expiry, then the refund fails: desired rises again and the restoration pages; an undelivered grant that expires pages, never dropped", async () => {
    await ledgerReady();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_x10_r"));
    const id = "inv:in_x10_r"; const G = await amountOf(id);
    flux.spend(id, 1_000_000);
    await coverRefund("in_x10_r", 4900);
    await sweeps();
    expect(flux.revokes).toEqual([{ grantId: id, reason: "returned_money" }]);
    flux.onGrant = async () => { throw new FluxError(400, "", "invalid_request"); }; // R3: refused, nothing applied
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_x10_u", 3));
    const u = "inv:in_x10_u";
    expect(await grantRow(u)).toMatchObject({ status: "pending" });
    const before = flux.balances();
    clock = Math.max((await grantRow(id))!.expires_at as number, (await grantRow(u))!.expires_at as number) + DAY;
    await coverRefund("in_x10_r", 0); // the refund failed after the grant expired
    await sweeps(2);
    expect(await ledgerAcct(id)).toMatchObject({ desired_microcents: G, applied_microcents: 0, router_state: "revoked" });
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.delivery_owed", open: true, debtMicrocents: G });
    expect(await grantRow(u)).toMatchObject({ status: "expired" });
    expect(await ledgerAlert(u)).toMatchObject({ kind: "credit.delivery_owed", open: true, debtMicrocents: G, blockedBy: "grant_expired" });
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-10 unsized receipts never erase the debt: no receipt without evidenced sizing; a sized receipt for less than owed keeps the difference alerted", async () => {
    await ledgerReady();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_x10_us"));
    const id = "inv:in_x10_us"; const G = await amountOf(id);
    const before = flux.balances();
    await lostDispute("dp_x10_us", "in_x10_us", 4900); // the payment's amount is in no record
    await sweeps();
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.removal_owed", open: true, sized: 0, blockedBy: "unsized_return" });
    const { token } = await (await opClaim(id)).json<{ token: string }>();
    const base = { token, appliedMicrocents: 0, evidence: "Flux adjustment adj_us (by hand)", by: "ops-sean" };
    const unsized = await opApplied(id, base);
    expect([unsized.status, await unsized.json()]).toEqual([409, { error: "unsized" }]);
    expect((await opApplied(id, { ...base, desiredMicrocents: 0 })).status).toBe(400); // a typed entitlement is never accepted
    expect((await opApplied(id, { ...base, appliedMicrocents: 80, sizing: { paidCents: 4900, evidence: "Stripe invoice in_x10_us: amount paid 49.00" } })).status).toBe(200);
    await sweeps();
    expect(await ledgerAcct(id)).toMatchObject({ sized: 1, paid_cents: 4900, paid_source: "operator", desired_microcents: 0, applied_microcents: 80, router_state: "manual" });
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.removal_owed", open: true, debtMicrocents: -80 });
    expect(G).toBeGreaterThan(80);
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-10/11 evidence is bound to the grant: the claim ISSUES the adjustment reference (grant, revision, claim); a reference of another grant, revision or claim never settles this one", async () => {
    await ledgerReady();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_x10_ea"));
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_x10_eb", 31));
    const a = "inv:in_x10_ea"; const b = "inv:in_x10_eb"; const G = await amountOf(a);
    const before = flux.balances();
    await coverRefund("in_x10_ea", 1000, "pi_ea"); await coverRefund("in_x10_eb", 1000, "pi_eb");
    await sweeps();
    const ca = await (await opClaim(a)).json<{ token: string; revision: number; adjustmentRef: string }>();
    const cb = await (await opClaim(b)).json<{ token: string; revision: number; adjustmentRef: string }>();
    expect(ca.adjustmentRef).toBe(`murage:${a}:r${ca.revision}:${ca.token}`);
    const receipt = { appliedMicrocents: share(G, 1000), evidence: "Flux adjustment by hand (memo = the issued reference)", by: "ops-sean" };
    // B's own issued reference, presented for A (an unused reference that belongs to another grant): refused.
    const foreign = await opApplied(a, { ...receipt, token: ca.token, revision: ca.revision, adjustmentRef: cb.adjustmentRef });
    expect([foreign.status, await foreign.json()]).toEqual([409, { error: "adjustment_ref_mismatch" }]);
    const madeUp = await opApplied(a, { ...receipt, token: ca.token, revision: ca.revision, adjustmentRef: "fx-adj-1" });
    expect([madeUp.status, await madeUp.json()]).toEqual([409, { error: "adjustment_ref_mismatch" }]);
    expect((await opApplied(a, { ...receipt, token: ca.token, revision: ca.revision, adjustmentRef: ca.adjustmentRef, grantId: b })).status).toBe(409); // another grant named
    const moved = await opApplied(a, { ...receipt, token: ca.token, revision: ca.revision + 1, adjustmentRef: ca.adjustmentRef });
    expect([moved.status, await moved.json()]).toEqual([409, { error: "revision_mismatch" }]);
    expect((await opApplied(b, { ...receipt, token: cb.token, revision: cb.revision, adjustmentRef: cb.adjustmentRef })).status).toBe(200);
    expect((await ledgerAcct(a))!.router_state).not.toBe("manual");
    expect((await opApplied(a, { ...receipt, token: ca.token, revision: ca.revision, adjustmentRef: ca.adjustmentRef })).status).toBe(200);
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-10 an ambiguous revoke keeps ownership: no operator claim while it may execute, never released by time; only a written tombstone supersedes it", async () => {
    await ledgerReady();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_x10_amb"));
    const id = "inv:in_x10_amb";
    flux.spend(id, 1_000_000);
    const before = flux.balances();
    await coverRefund("in_x10_amb", 4900);
    flux.revokeDown = true; // the revoke times out: it may still execute
    await sweeps();
    expect(await openDispatches(id)).toMatchObject([{ kind: "revoke", state: "open" }]);
    expect((await opClaim(id, { by: "ops-b", evidence: "Flux admin: grant still active" })).status).toBe(409);
    await env.DB.prepare("UPDATE flux_grant_dispatches SET expires_at=0 WHERE grant_id=? AND state='open'").bind(id).run();
    expect((await opClaim(id, { by: "ops-b", evidence: "Flux admin: grant still active" })).status).toBe(409); // an observation never releases it
    expect((await opClaim(id, { by: "ops-b", tombstone: true })).status).toBe(400); // a tombstone claim names its evidence
    const taken = await opClaim(id, { by: "ops-b", tombstone: true, evidence: "wrote the tombstone of inv:in_x10_amb at the Flux app (ticket fx-77)" });
    expect(taken.status).toBe(200);
    expect(await openDispatches(id)).toMatchObject([{ kind: "operator", by: "ops-b" }]);
    flux.revokeDown = false;
    await sweeps(2);
    expect(flux.revokes).toEqual([]); // the operator's claim excludes every automatic revoke
    expect(await ledgerAlert(id)).toMatchObject({ open: true, blockedBy: "operator_claim", openDispatch: { kind: "operator", by: "ops-b" } });
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-10 a blocked obligation pages: an operator claims a partial removal and crashes, the payment is then fully returned: paged with the claim owner, never suppressed by eligibility", async () => {
    await ledgerReady();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_x10_crash"));
    const id = "inv:in_x10_crash";
    const before = flux.balances();
    await coverRefund("in_x10_crash", 1000);
    await sweeps();
    expect((await opClaim(id)).status).toBe(200); // ... and the operator never comes back
    await coverRefund("in_x10_crash", 4900);
    await sweeps(3);
    expect(flux.revokes).toEqual([]);
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.removal_owed", open: true, desiredMicrocents: 0, blockedBy: "operator_claim",
      openDispatch: { kind: "operator", by: "ops-sean" }, debtSince: expect.any(Number) });
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-10 R7: an unconfirmed 2xx is never a delivery: the dispatch stays open and nothing is counted as applied", async () => {
    const at = async (status: number, body: string | null) => (async () => new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    // Lane H1: the router's grant route (flux-grants.ts shapes): only 200 granted/already_granted for this amount confirms a delivery.
    extra = { FLUX_CLOUD_GRANTS_URL: "https://router.test", FLUX_CLOUD_GRANTS_TOKEN: "g".repeat(40) };
    const g: FluxGrant = { grantId: "inv:r7", entitlementKey: "k", recipientFluxAccountId: FLUX_ACCOUNT, homeId: HOME, plan: "starter", amountMicrocents: 10_000_000,
      periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z", deliveryId: "d", invoiceId: "r7", kind: "period" };
    const ok = JSON.stringify({ status: "granted", amount_microcents: 10_000_000 });
    for (const [status, body] of [[202, "{}"], [202, ok], [200, ""], [200, "{}"], [200, JSON.stringify({ status: "granted", amount_microcents: 1 })],
      [200, JSON.stringify({ status: "queued", amount_microcents: 10_000_000 })], [204, null]] as [number, string | null][]) {
      await expect(createFluxClient(testEnv(), await at(status, body)).grant(g)).rejects.toMatchObject({ status: 502, code: "unconfirmed_delivery" });
    }
    await expect(createFluxClient(testEnv(), await at(200, ok)).grant(g)).resolves.toBeUndefined();
    const ctx = { invoiceId: "r7", kind: "period", homeId: HOME };
    await expect(createFluxClient(testEnv(), await at(200, JSON.stringify({ status: "revoked" }))).revokeGrant("inv:r7", "x", ctx)).rejects.toBeInstanceOf(FluxError);
    await expect(createFluxClient(testEnv(), await at(202, JSON.stringify({ status: "reversed" }))).revokeGrant("inv:r7", "x", ctx)).rejects.toBeInstanceOf(FluxError);
    extra = {};
    // Through the ledger: the router took the credit but answered without definitive evidence.
    await ledgerReady();
    flux.afterGrant = async () => { throw new FluxError(502, "unconfirmed_delivery", "unconfirmed_delivery"); };
    const before = flux.balances();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_x10_r7"));
    const id = "inv:in_x10_r7";
    expect(await ledgerAcct(id)).toMatchObject({ router_state: "maybe", applied_microcents: 0 });
    expect(await openDispatches(id)).toMatchObject([{ kind: "deliver", state: "open" }]);
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-10 unbound grants never monopolize the delivery page: each examined hold is stamped; a deliverable grant behind 55 of them is delivered; overdue unbound debt pages", async () => {
    const owner = await ledgerReady();
    const other = await signIn("unlinked@example.test");
    await seedHome(other.userId, { homeId: "home-unbound" });
    for (let n = 0; n < 55; n++) {
      await env.DB.prepare(`INSERT INTO flux_grants (grant_id,entitlement_key,home_id,invoice_id,plan,amount_microcents,period_start,period_end,expires_at,created_at)
        VALUES (?,?,'home-unbound',?,'starter',10000000,0,1,?,?)`).bind(`inv:ub_${n}`, `k:ub_${n}`, `ub_${n}`, clock + 60 * DAY, clock - 3 * DAY + n).run();
    }
    flux.onGrant = async () => { throw new FluxError(400, "", "invalid_request"); }; // refused once (R3): pending behind them, no dispatch open
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_x10_ok"));
    const before = flux.balances();
    await sweeps(2);
    expect(flux.grants.map((g) => g.grantId)).toEqual(["inv:in_x10_ok"]);
    expect((await grantRow("inv:ub_0"))!.last_attempt_at).toEqual(expect.any(Number));
    clock += 25 * 3_600_000;
    await sweeps();
    expect(await ledgerAlert("inv:ub_0")).toMatchObject({ kind: "credit.delivery_owed", open: true, blockedBy: "recipient_unbound" });
    expect(owner.userId).not.toBe(other.userId);
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-10 bounded reconciliation: the durable cursor pages through the accounts and wraps", async () => {
    for (const n of [1, 2, 3]) {
      await env.DB.prepare(`INSERT INTO flux_grants (grant_id,entitlement_key,home_id,invoice_id,plan,amount_microcents,period_start,period_end,expires_at,created_at)
        VALUES (?,?,?,?,'starter',10000000,0,1,?,0)`).bind(`inv:cur_${n}`, `k:cur_${n}`, HOME, `cur_${n}`, clock + DAY).run();
    }
    const step = async () => { const p = await ledgerPage(env.DB, clock, 2); await p.advance.run(); return p.ids; };
    expect(await step()).toEqual(["inv:cur_1", "inv:cur_2"]);
    expect(await step()).toEqual(["inv:cur_3"]);
    expect(await step()).toEqual(["inv:cur_1", "inv:cur_2"]);
  });

  // ── Astra INTEGRATED-11. Every test asserts prepaid funds and spent credit untouched, and no router call while Flux is off. ──
  /** A failing router: every call is recorded (a thrown error alone could be swallowed by a retry path). */
  const failingRouter = (calls: string[]) => new Proxy({}, { get: (_t, name) => async () => { calls.push(String(name)); throw new Error(`router called with Flux off: ${String(name)}`); } }) as unknown as FluxClient;
  /** The shapes migration 0106 leaves behind (test-node/integrated-10-migration.test.mjs): an UNCONFIRMED revoke of a fully refunded
   *  delivered grant ('revoking', its open revoke dispatch, already past its expiry) and a delivery claim in flight ('maybe', its open
   *  delivery dispatch). */
  async function migratedShapes(G: number) {
    const ins = (id: string, inv: string, status: string, claim: string | null) => env.DB.prepare(`INSERT INTO flux_grants (grant_id,entitlement_key,home_id,invoice_id,plan,
      amount_microcents,period_start,period_end,expires_at,status,attempts,claim_id,claimed_at,created_at) VALUES (?,?,?,?,'starter',?,0,1,?,?,1,?,?,?)`)
      .bind(id, `k:${id}`, HOME, inv, G, clock + 40 * DAY, status, claim, claim ? clock - 2 * 3_600_000 : null, clock - DAY).run();
    const acct = (id: string, inv: string, state: string, applied: number) => env.DB.prepare(`INSERT INTO flux_grant_accounts (grant_id,home_id,invoice_id,amount_microcents,
      desired_microcents,applied_microcents,delivered_confirmed_microcents,router_state,debt_since,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, HOME, inv, G, G, applied, applied, state, clock - DAY, clock - DAY).run();
    const disp = (dispatch: string, id: string, kind: string, target: number) => env.DB.prepare(`INSERT INTO flux_grant_dispatches (dispatch_id,grant_id,kind,revision,
      target_microcents,claimed_at,expires_at,last_outcome) VALUES (?,?,?,1,?,?,?,'migration:0106')`).bind(dispatch, id, kind, target, clock - 2 * 3_600_000, clock - 2 * 3_600_000).run();
    await ins("inv:in_m3", "in_m3", "done", null); await acct("inv:in_m3", "in_m3", "revoking", G); await disp("migration:revoke:inv:in_m3", "inv:in_m3", "revoke", 0);
    await coverRefund("in_m3", 4900);
    await ins("inv:in_m5", "in_m5", "pending", "tok_m5"); await acct("inv:in_m5", "in_m5", "maybe", 0); await disp("tok_m5", "inv:in_m5", "deliver", G);
  }

  it("INTEGRATED-11/12 Flux off: a migrated revoke and an open delivery are blocked debts whose alerts are kept across sweeps; the operator's receipts while off stay PENDING VERIFICATION (no router call, no balance moved); switched on, the same receipts are verified against Flux's record and nothing is applied twice", async () => {
    await ledgerReady();
    const G = 10_000_000;
    await migratedShapes(G);
    extra = { CLOUD_FLUX_ROUTES_ENABLED: undefined };
    const calls: string[] = [];
    const off: FluxDependencies = { fluxClient: () => failingRouter(calls), billingFlux: QUALIFIED_HOOKS, now: () => clock };
    const before = flux.balances();
    for (let i = 0; i < 3; i++) { clock += 20 * 60_000; await sweepFlux(testEnv(), off); }
    expect(await ledgerAlert("inv:in_m3")).toMatchObject({ kind: "credit.removal_owed", open: true, blockedBy: "flux_off", fluxOn: 0, routerState: "revoking",
      debtMicrocents: -G, debtSince: expect.any(Number), openDispatch: { dispatchId: "migration:revoke:inv:in_m3", kind: "revoke" } });
    expect(await ledgerAlert("inv:in_m5")).toMatchObject({ kind: "credit.delivery_owed", open: true, blockedBy: "flux_off", routerState: "maybe",
      debtMicrocents: G, openDispatch: { dispatchId: "tok_m5", kind: "deliver" } });
    const w = workerWith(off);
    const claim = async (id: string, body: Record<string, unknown>) => adminVia(w, `/v1/internal/flux/grants/${id}/claim`, body);
    const receipt = async (id: string, c: { token: string; revision: number; adjustmentRef: string; wireRevision?: number | null }, applied: number, via = w) =>
      adminVia(via, `/v1/internal/flux/grants/${id}/applied`, { token: c.token, grantId: id, revision: c.revision, appliedMicrocents: applied,
        ...(c.wireRevision ? { wireRevision: c.wireRevision } : {}),
        adjustmentRef: c.adjustmentRef, evidence: "Flux admin: adjustment made by hand, memo = the issued reference", by: "ops-sean" });
    // The open (migrated) dispatch may still execute: only a written tombstone supersedes it, with evidence.
    expect((await claim("inv:in_m3", { by: "ops-sean" })).status).toBe(409);
    const c3 = await (await claim("inv:in_m3", { by: "ops-sean", tombstone: true, evidence: "wrote the tombstone of inv:in_m3 in the Flux admin (ticket fx-11)" }))
      .json<{ token: string; revision: number; adjustmentRef: string }>();
    const c5 = await (await claim("inv:in_m5", { by: "ops-sean", tombstone: true, evidence: "wrote the tombstone of inv:in_m5 in the Flux admin (ticket fx-12)" }))
      .json<{ token: string; revision: number; adjustmentRef: string }>();
    const acct3 = await ledgerAcct("inv:in_m3"); const acct5 = await ledgerAcct("inv:in_m5");
    // INTEGRATED-12 (R8c): while off nothing can be read from Flux: each receipt is kept PENDING VERIFICATION (202), no stored balance moves.
    expect((await receipt("inv:in_m3", c3, 0)).status).toBe(202);
    expect((await receipt("inv:in_m5", c5, G)).status).toBe(202);
    clock += 20 * 60_000; await sweepFlux(testEnv(), off);
    expect(await ledgerAcct("inv:in_m3")).toEqual(acct3);
    expect(await ledgerAcct("inv:in_m5")).toEqual(acct5);
    expect(await ledgerAlert("inv:in_m3")).toMatchObject({ open: true, blockedBy: "pending_verification",
      pendingReceipt: { state: "pending_verification", appliedMicrocents: 0, adjustmentRef: c3.adjustmentRef } });
    expect(await ledgerAlert("inv:in_m5")).toMatchObject({ open: true, blockedBy: "pending_verification",
      pendingReceipt: { state: "pending_verification", appliedMicrocents: G, adjustmentRef: c5.adjustmentRef } });
    expect(calls).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM flux_grant_dispatches WHERE kind<>'operator' AND state='open'")).toBe(0);
    // Switched on: the operator's open claims (pending receipts) exclude every automatic send and revoke.
    extra = {};
    await sweeps(3);
    expect(flux.deliveries.filter((d) => d.grantId === "inv:in_m5")).toEqual([]);
    expect(flux.revokes.filter((r) => r.grantId === "inv:in_m3")).toEqual([]);
    // The same receipts, now verified against Flux's own record of the adjustments: applied once.
    const on = workerWith(D());
    expect((await receipt("inv:in_m3", c3, 0, on)).status).toBe(200);
    expect((await receipt("inv:in_m5", c5, G, on)).status).toBe(200);
    expect(flux.verifications.map((v) => v.adjustmentRef)).toEqual([c3.adjustmentRef, c5.adjustmentRef]);
    await sweeps(2);
    expect(await ledgerAcct("inv:in_m3")).toMatchObject({ applied_microcents: 0, desired_microcents: 0, router_state: "manual" });
    expect(await ledgerAcct("inv:in_m5")).toMatchObject({ applied_microcents: G, desired_microcents: G, router_state: "manual" });
    expect(await ledgerAlert("inv:in_m3")).toMatchObject({ open: false });
    expect(await ledgerAlert("inv:in_m5")).toMatchObject({ open: false });
    expect(flux.deliveries.filter((d) => d.grantId === "inv:in_m5")).toEqual([]);
    expect(flux.revokes.filter((r) => r.grantId === "inv:in_m3")).toEqual([]);
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-12 R8c: with Flux off a receipt echoing the issued reference with a WRONG amount changes no stored balance and resolves nothing (pending, shown in the alert); a contradicting second receipt is refused; no path applies it while off; switched on, Flux's record decides", async () => {
    await ledgerReady();
    const G = 10_000_000;
    await migratedShapes(G);
    extra = { CLOUD_FLUX_ROUTES_ENABLED: undefined };
    const calls: string[] = [];
    const off: FluxDependencies = { fluxClient: () => failingRouter(calls), billingFlux: QUALIFIED_HOOKS, now: () => clock };
    const before = flux.balances();
    clock += 20 * 60_000; await sweepFlux(testEnv(), off);
    const w = workerWith(off);
    const c = await (await adminVia(w, "/v1/internal/flux/grants/inv:in_m5/claim", { by: "ops-sean", tombstone: true, evidence: "wrote the tombstone of inv:in_m5 (ticket fx-21)" }))
      .json<{ token: string; revision: number; adjustmentRef: string; wireRevision: number | null }>();
    const acct = await ledgerAcct("inv:in_m5");
    expect(acct).toMatchObject({ applied_microcents: 0, desired_microcents: G });
    const receipt = (applied: number, via = w) => adminVia(via, "/v1/internal/flux/grants/inv:in_m5/applied", { token: c.token, grantId: "inv:in_m5",
      ...(c.wireRevision ? { wireRevision: c.wireRevision } : {}),
      revision: c.revision, appliedMicrocents: applied, adjustmentRef: c.adjustmentRef, evidence: "Flux admin: credited by hand", by: "ops-sean" });
    // The operator meant 10,000,000 but typed 1: before the fix, the stored applied balance became 1 and the alert's debt changed on their word.
    expect((await receipt(1)).status).toBe(202);
    expect((await receipt(1)).status).toBe(202); // the same receipt again: idempotent
    const conflict = await receipt(G);
    expect([conflict.status, await conflict.json()]).toEqual([409, { error: "receipt_conflict" }]);
    for (let i = 0; i < 3; i++) { clock += 20 * 60_000; await sweepFlux(testEnv(), off); }
    expect(await ledgerAcct("inv:in_m5")).toMatchObject({ applied_microcents: 0, desired_microcents: G, router_state: acct!.router_state });
    expect(await ledgerAlert("inv:in_m5")).toMatchObject({ open: true, debtMicrocents: G, blockedBy: "pending_verification",
      pendingReceipt: { state: "pending_verification", appliedMicrocents: 1, adjustmentRef: c.adjustmentRef, by: "ops-sean" } });
    // No other operator can supersede the claim holding the pending receipt, even after its expiry.
    await env.DB.prepare("UPDATE flux_grant_dispatches SET expires_at=0 WHERE dispatch_id=?").bind(c.token).run();
    expect((await adminVia(w, "/v1/internal/flux/grants/inv:in_m5/claim", { by: "ops-b", evidence: "taking over" })).status).toBe(409);
    expect(calls).toEqual([]);
    // Switched on: Flux's own record says the adjustment credited 10,000,000, not 1: refused as a mismatch, still nothing applied.
    extra = {};
    flux.adjustments.set(c.adjustmentRef, G);
    const on = workerWith(D());
    const mismatch = await receipt(1, on);
    expect([mismatch.status, await mismatch.json()]).toEqual([409, { error: "verification_mismatch" }]);
    expect(await ledgerAcct("inv:in_m5")).toMatchObject({ applied_microcents: 0 });
    expect(flux.balances()).toEqual(before);
    expect(flux.grants.filter((g) => g.grantId === "inv:in_m5")).toEqual([]);
  });

  it("INTEGRATED-11 R10: after an AMBIGUOUS revoke is superseded by a written tombstone, a restoration is refused until a revoke is confirmed; only a receipt of nothing held is accepted and the restoration stays an alerted debt", async () => {
    await ledgerReady();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_x11_r10"));
    const id = "inv:in_x11_r10"; const G = await amountOf(id);
    flux.spend(id, 1_000_000);
    const before = flux.balances();
    await coverRefund("in_x11_r10", 4900);
    flux.revokeDown = true; // the revoke times out: it may still execute later
    await sweeps();
    expect(await openDispatches(id)).toMatchObject([{ kind: "revoke", state: "open" }]);
    await coverRefund("in_x11_r10", 0); // the refund then failed: the customer is owed the grant again
    await env.DB.prepare("UPDATE flux_grant_dispatches SET expires_at=0 WHERE grant_id=? AND state='open'").bind(id).run();
    const c = await (await opClaim(id, { by: "ops-b", tombstone: true, evidence: "wrote the tombstone of inv:in_x11_r10 at the Flux app (ticket fx-88)" }))
      .json<{ token: string; revision: number }>();
    const restore = await opApplied(id, { token: c.token, appliedMicrocents: G, evidence: "Flux adjustment: credit restored by hand", by: "ops-b" });
    expect([restore.status, await restore.json()]).toEqual([409, { error: "termination_unconfirmed" }]);
    expect((await opApplied(id, { token: c.token, appliedMicrocents: 0, evidence: "Flux admin: grant holds nothing (tombstoned)", by: "ops-b" })).status).toBe(200);
    flux.revokeDown = false;
    await sweeps(2);
    expect(await ledgerAcct(id)).toMatchObject({ desired_microcents: G, applied_microcents: 0, router_state: "manual" });
    expect(await ledgerAlert(id)).toMatchObject({ kind: "credit.delivery_owed", open: true, debtMicrocents: G });
    expect(flux.grants.filter((g) => g.grantId === id)).toHaveLength(1); // never delivered a second time automatically
    expect(flux.balances()).toEqual(before);
  });

  it("INTEGRATED-11 expired open deliveries never monopolize the delivery page: each examined expired grant is stamped whoever owns its dispatch; a deliverable grant behind 55 of them is delivered", async () => {
    await ledgerReady();
    const G = 10_000_000;
    for (let n = 0; n < 55; n++) {
      await env.DB.prepare(`INSERT INTO flux_grants (grant_id,entitlement_key,home_id,invoice_id,plan,amount_microcents,period_start,period_end,expires_at,attempts,claim_id,created_at)
        VALUES (?,?,?,?,'starter',?,0,1,?,1,?,?)`).bind(`inv:ex_${n}`, `k:ex_${n}`, HOME, `ex_${n}`, G, clock - DAY, `tok_ex_${n}`, clock - 3 * DAY + n).run();
      await env.DB.prepare(`INSERT INTO flux_grant_dispatches (dispatch_id,grant_id,kind,revision,target_microcents,claimed_at,expires_at) VALUES (?,?,'deliver',1,?,?,?)`)
        .bind(`tok_ex_${n}`, `inv:ex_${n}`, G, clock - 2 * DAY, clock + 30 * DAY).run();
    }
    flux.onGrant = async () => { throw new FluxError(400, "", "invalid_request"); }; // refused once (R3): pending behind them, no dispatch open
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_x11_ok"));
    const before = flux.balances();
    await sweeps(2);
    expect(flux.grants.map((g) => g.grantId)).toEqual(["inv:in_x11_ok"]);
    expect((await grantRow("inv:ex_0"))!.last_attempt_at).toEqual(expect.any(Number));
    expect((await grantRow("inv:ex_0"))!.status).toBe("pending"); // its open dispatch still owns it: never expired under it
    expect(flux.balances()).toEqual(before);
  });

  it("a plan change moves an untouched cap and leaves a chosen one alone", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect(await (await admin("/v1/internal/flux/plan", { homeId: HOME, plan: "pro" })).json()).toEqual({ plan: "pro", capUsd: 60 });
    expect(flux.caps.at(-1)).toEqual({ homeId: HOME, capMicrocents: 60_000_000, capVersion: 2 });
    await call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, { capUsd: 45 });
    flux.caps.length = 0;
    expect(await (await admin("/v1/internal/flux/plan", { homeId: HOME, plan: "max" })).json()).toEqual({ plan: "max", capUsd: 45 });
    expect(flux.caps).toHaveLength(0);
    expect((await admin("/v1/internal/flux/plan", { homeId: HOME, plan: "nope" })).status).toBe(400);
    expect(await changePlan(testEnv(), { homeId: HOME, plan: "starter" }, { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock })).toEqual({ plan: "starter", capUsd: 45 });
    expect(await stopForBilling(testEnv(), HOME, { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock })).toEqual({ state: "stopped" });
  });
});

describe("the Flux client", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (status = 200, body: unknown = {}) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  it("sends only the narrow service token, never follows redirects, and uses https origins", async () => {
    calls.length = 0;
    const client = createFluxClient(testEnv(), fakeFetch(200, { key: "sk-" + "flux-home-" + "x".repeat(24), expires_at: "2026-11-13T00:00:00Z", generation: 3, cap_microcents: 30_000_000 }));
    const minted = await client.mint({ accountId: FLUX_ACCOUNT, homeId: HOME, generation: 3, boundIps: [HOME_IP], capMicrocents: 30_000_000, ttlSeconds: 3600, lifecycleVersion: 4, ownerResume: false, opId: "renew:h:1:2", linkId: "l", linkVersion: 1, capVersion: 1, billingState: "ok" });
    expect(minted.generation).toBe(3);
    expect(calls[0].url).toBe("https://api.fluxrouter.ai/internal/cloud-home/subkeys");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
    expect(calls[0].init.redirect).toBe("manual");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ lifecycle_version: 4, owner_resume: false, op_id: "renew:h:1:2", generation: 3 });
  });

  it("sends the lifecycle version on revoke", async () => {
    calls.length = 0;
    await createFluxClient(testEnv(), fakeFetch(200, {})).stop(HOME, 7);
    expect(calls[0].url).toBe("https://api.fluxrouter.ai/internal/cloud-home/subkeys/revoke");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ home_id: HOME, lifecycle_version: 7, scope: "home", reason: "stop" });
  });

  it("maps the real recharge setting and the consumed-adjusted balance, and leaves unknown unknown", async () => {
    const known = await createFluxClient(testEnv(), fakeFetch(200, { state: "active", account_spendable_microcents: 7_000_000, account_auto_topup_enabled: false, account_funded_microcents: 99, account_credit_armed: true })).status(HOME);
    expect(known).toMatchObject({ accountSpendableMicrocents: 7_000_000, accountAutoTopUpEnabled: false });
    const unknown = await createFluxClient(testEnv(), fakeFetch(200, { state: "active", account_credit_armed: true, account_funded_microcents: 99 })).status(HOME);
    expect(unknown).toMatchObject({ accountSpendableMicrocents: null, accountAutoTopUpEnabled: null });
  });

  it("H1 sends credit grants to the router's grant route with a fenced top-level revision, never to the Flux app route", async () => {
    calls.length = 0;
    extra = { FLUX_CLOUD_GRANTS_URL: "https://router.test", FLUX_CLOUD_GRANTS_TOKEN: "g".repeat(40) };
    await createFluxClient(testEnv(), fakeFetch(200, { status: "granted", amount_microcents: 20_000_000 })).grant({
      grantId: "inv:x", entitlementKey: "home:h:period:1", recipientFluxAccountId: FLUX_ACCOUNT, homeId: HOME, plan: "pro", amountMicrocents: 20_000_000,
      periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z", deliveryId: "d-9", invoiceId: "x", kind: "period",
    });
    expect(calls[0].url).toBe("https://router.test/internal/cloud-home/credit-grants");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${"g".repeat(40)}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      grant_id: "x:period", invoice_id: "x", kind: "period", home_id: HOME, account_id: FLUX_ACCOUNT, plan: "pro", amount_microcents: 20_000_000,
      period_start: "2026-10-01T00:00:00+00:00", period_end: "2026-11-01T00:00:00+00:00", expires_at: "2026-12-01T00:00:00+00:00", revision: 1,
    });
    expect(calls.filter((c) => c.url.includes("/api/internal/cloud/credit-grants"))).toEqual([]);
  });

  it("H1 asks the router's /reverse (fenced) to revoke an unspent grant, never the Flux app route", async () => {
    calls.length = 0;
    extra = { FLUX_CLOUD_GRANTS_URL: "https://router.test", FLUX_CLOUD_GRANTS_TOKEN: "g".repeat(40) };
    expect(await createFluxClient(testEnv(), fakeFetch(200, { status: "reversed" })).revokeGrant("inv:x", "billing_stop", { invoiceId: "x", kind: "period", homeId: HOME }))
      .toBe("revoked");
    expect(calls[0].url).toBe("https://router.test/internal/cloud-home/credit-grants/reverse");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ grant_id: "x:period", invoice_id: "x", kind: "period", home_id: HOME, reason: "billing_stop", revision: 1 });
    expect(calls.filter((c) => c.url.includes("/api/internal/cloud/credit-grants"))).toEqual([]);
  });

  it("turns Flux errors into FluxError and refuses a bad mint answer", async () => {
    await expect(createFluxClient(testEnv(), fakeFetch(500, {})).stop(HOME, 1)).rejects.toMatchObject({ status: 500 });
    await expect(createFluxClient(testEnv(), fakeFetch(409, { error: { message: "generation must be greater than 4" } })).stop(HOME, 1)).rejects.toMatchObject({ status: 409, detail: "generation must be greater than 4" });
    await expect(createFluxClient(testEnv(), fakeFetch(200, { key: "short" })).mint({ accountId: FLUX_ACCOUNT, homeId: HOME, generation: 1, boundIps: [HOME_IP], capMicrocents: 1, ttlSeconds: 3600, lifecycleVersion: 0, ownerResume: true, opId: "o", linkId: "l", linkVersion: 1, capVersion: 1, billingState: "ok" })).rejects.toBeInstanceOf(FluxError);
    const unreachable = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
    await expect(createFluxClient(testEnv(), unreachable).status(HOME)).rejects.toMatchObject({ status: 0 });
  });

  it("fails closed with no or a short service token, and rejects a non-https base", async () => {
    await expect(createFluxClient({ ...testEnv(), FLUX_CLOUD_SERVICE_TOKEN: "" } as Env, fakeFetch()).stop(HOME, 1)).rejects.toMatchObject({ code: "flux_not_configured" });
    await expect(createFluxClient({ ...testEnv(), FLUX_CLOUD_SERVICE_TOKEN: "short" } as Env, fakeFetch()).stop(HOME, 1)).rejects.toMatchObject({ code: "flux_not_configured" });
    expect(() => createFluxClient({ ...testEnv(), FLUX_API_BASE: "http://api.fluxrouter.ai" } as Env, fakeFetch())).toThrow();
    expect(() => createFluxClient({ ...testEnv(), FLUX_API_BASE: "https://user:pw@api.fluxrouter.ai" } as Env, fakeFetch())).toThrow();
  });
});

describe("flux_renewal_due (poller trigger)", () => {
  it("is true only for an active, un-held home with a key due; never for a stop or a hold", async () => {
    const { fluxRenewalDue, RENEWAL_WINDOW_MS } = await import("../src/b4-flux-renewal");
    const now = Date.now();
    const put = (state: string, hold: number, expires: number | null) =>
      env.DB.prepare(
        "INSERT OR REPLACE INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,billing_hold,key_expires_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      ).bind("home-renew", "starter", 1, state, 30_000_000, 0, hold, expires, now).run();
    await put("active", 0, now + RENEWAL_WINDOW_MS - 1000);
    expect(await fluxRenewalDue(env, "home-renew", now)).toBe(true);
    await put("active", 0, now + 30 * 86_400_000);
    expect(await fluxRenewalDue(env, "home-renew", now)).toBe(false);
    await put("stopped", 0, now - 1000);
    expect(await fluxRenewalDue(env, "home-renew", now)).toBe(false);
    await put("active", 1, now - 1000);
    expect(await fluxRenewalDue(env, "home-renew", now)).toBe(false);
    expect(await fluxRenewalDue(env, "no-such-home", now)).toBe(false);
    await env.DB.prepare("DELETE FROM flux_home_keys WHERE home_id=?").bind("home-renew").run();
  });
});

// ── Round 2 (Codex review 2026-10-09). Each test is named for the spec hole it reproduces. ──
describe("round 2: grants, delivery and entitlement (holes 4, 8, 10)", () => {
  const sweep = () => sweepFlux(testEnv(), { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
  const gdeps = () => ({ fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
  const grantBody = (plan: string, invoiceId: string, n = 0, extraFields: Record<string, unknown> = {}) =>
    ({ homeId: HOME, plan, invoiceId, ...period(n), ...extraFields });
  const grantRow = (grantId: string) => env.DB.prepare("SELECT * FROM flux_grants WHERE grant_id=?").bind(grantId).first<Record<string, unknown>>();
  const ready = async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    return owner;
  };

  it("hole 4 / INTEGRATED-9: a stop while the delivery is in flight keeps the credit the call then creates (nothing returned); a full refund then revokes it", async () => {
    await ready();
    const before = flux.balances();
    flux.afterGrant = async () => { await stopForBilling(testEnv(), HOME, gdeps()); };
    const result = await grantMonthlyCredits(testEnv(), grantBody("starter", "in_h4a_0001"), gdeps());
    expect(result.status).toBe("cancelled"); // delivery cancelled; the credit that arrived is the customer's
    const id = "inv:in_h4a_0001"; const G = (await ledgerAcct(id))!.amount_microcents as number;
    expect(flux.credits.get(id)).toBe(G);
    expect(await ledgerAcct(id)).toMatchObject({ router_state: "delivered", applied_microcents: G, desired_microcents: G });
    await coverRefund("in_h4a_0001", 4900);
    clock += 11 * 60_000;
    await sweep();
    expect(flux.credits.size).toBe(0); // the payment came back: the credit is gone
    expect(flux.tombstones.has(id)).toBe(true);
    expect(await ledgerAcct(id)).toMatchObject({ router_state: "revoked", applied_microcents: 0 });
    expect(flux.balances()).toEqual(before);
  });

  it("hole 4 / INTEGRATED-9: a full refund and its stop landing while the delivery is at the router never race it (one dispatch at a time): the revoke follows the delivery's answer", async () => {
    await ready();
    const before = flux.balances();
    flux.onGrant = async () => { await coverRefund("in_h4b_0001", 4900); await stopForBilling(testEnv(), HOME, gdeps(), { invoiceId: "in_h4b_0001", keepGrants: true }); };
    await grantMonthlyCredits(testEnv(), grantBody("starter", "in_h4b_0001"), gdeps());
    expect(flux.revokes).toEqual([]); // the delivery's claim was open: no revoke could be claimed alongside it
    clock += 11 * 60_000;
    await sweep();
    expect(flux.revokes).toEqual([{ grantId: "inv:in_h4b_0001", reason: "returned_money" }]);
    expect(flux.credits.size).toBe(0);
    expect(await grantRow("inv:in_h4b_0001")).toMatchObject({ status: "cancelled" });
    expect(flux.balances()).toEqual(before);
  });

  it("hole 4: a 404 from the revoke endpoint is never final while a delivery is unresolved", async () => {
    await ready();
    flux.grantAckLost = true; // Flux created the credit; the answer was lost
    await grantMonthlyCredits(testEnv(), grantBody("starter", "in_h4c_0001"), gdeps());
    flux.grantAckLost = false;
    expect(await grantRow("inv:in_h4c_0001")).toMatchObject({ status: "pending", attempts: 1 });
    await coverRefund("in_h4c_0001", 4900);
    flux.revoke404 = true;
    await stopForBilling(testEnv(), HOME, gdeps(), { invoiceId: "in_h4c_0001", keepGrants: true });
    expect(await grantRow("inv:in_h4c_0001")).toMatchObject({ status: "cancelled" });
    expect(await ledgerAcct("inv:in_h4c_0001")).toMatchObject({ router_state: "revoking" }); // not settled
    expect(flux.credits.size).toBe(1);
    flux.revoke404 = false;
    clock += 11 * 60_000;
    await sweep();
    expect(await ledgerAcct("inv:in_h4c_0001")).toMatchObject({ router_state: "revoked" });
    expect(flux.credits.size).toBe(0);
    expect(flux.tombstones.has("inv:in_h4c_0001")).toBe(true);
  });

  it("hole 4: delivery is claimed durably (claim id and attempt written before the network call)", async () => {
    await ready();
    let seen: Record<string, unknown> | null = null;
    flux.onGrant = async () => { seen = await grantRow("inv:in_h4d_0001"); };
    await grantMonthlyCredits(testEnv(), grantBody("starter", "in_h4d_0001"), gdeps());
    expect(seen).toMatchObject({ status: "pending", attempts: 1, claim_id: flux.deliveries[0].deliveryId });
    expect(flux.deliveries[0].deliveryId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("hole 4: a grant is not delivered after a billing Stop even though the delivery read the unheld home earlier", async () => {
    await ready();
    armDb(/UPDATE flux_grants SET\s+claim_id/, async () => { await stopForBilling({ ...testEnv(), DB: env.DB } as Env, HOME, gdeps()); }); // the flux switch must be on in this env too (the launch gate)
    const result = await grantMonthlyCredits(testEnv(), grantBody("starter", "in_h4e_0001"), gdeps());
    expect(result.status).toBe("cancelled");
    expect(flux.deliveries).toHaveLength(0);
    expect(flux.credits.size).toBe(0);
    expect(await grantRow("inv:in_h4e_0001")).toMatchObject({ status: "cancelled" });
  });

  it("hole 4: a 409 revoked answer from the Flux app ends the delivery for good", async () => {
    await ready();
    flux.tombstones.add("inv:in_h4f_0001");
    const result = await grantMonthlyCredits(testEnv(), grantBody("starter", "in_h4f_0001"), gdeps());
    expect(result.status).toBe("cancelled");
    expect(flux.credits.size).toBe(0);
    clock += 11 * 60_000;
    await sweep();
    expect(flux.deliveries).toHaveLength(1);
  });

  it("hole 8: Starter, upgrade to Max, back to Starter, then Pro never exceeds the highest plan amount", async () => {
    await ready();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_h8_start1"));
    await admin("/v1/internal/flux/grant", grantBody("max", "in_h8_max_01", 0, { kind: "upgrade_delta", previousPlan: "starter" }));
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_h8_back_1"));
    const pro = await admin("/v1/internal/flux/grant", grantBody("pro", "in_h8_pro_01", 0, { kind: "upgrade_delta", previousPlan: "starter" }));
    expect(await pro.json()).toMatchObject({ status: "duplicate_period", amountUsd: 0 });
    const total = flux.grants.reduce((sum, g) => sum + g.amountMicrocents, 0);
    expect(total).toBe(40_000_000);
    expect((await env.DB.prepare("SELECT granted_microcents FROM flux_entitlements WHERE home_id=? AND period_start=?").bind(HOME, PERIOD_START).first())).toEqual({ granted_microcents: 40_000_000 });
  });

  it("hole 8: a later, higher-plan invoice in the same period grants only the difference to what was already granted", async () => {
    await ready();
    await admin("/v1/internal/flux/grant", grantBody("pro", "in_h8b_pro_1"));
    const max = await admin("/v1/internal/flux/grant", grantBody("max", "in_h8b_max_1"));
    expect(await max.json()).toMatchObject({ status: "done", amountUsd: 20 });
    expect(flux.grants.reduce((sum, g) => sum + g.amountMicrocents, 0)).toBe(40_000_000);
  });

  it("hole 10: a crash that left an invoice marker without its grant is resumed on replay, not answered duplicate_period", async () => {
    await ready();
    // What the old two-step code left behind when it died between the two writes.
    await env.DB.prepare(`INSERT INTO flux_invoices (invoice_id,home_id,plan,kind,period_start,period_end,created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind("in_h10_0001", HOME, "starter", "period", PERIOD_START, PERIOD_END, clock).run();
    const replay = await admin("/v1/internal/flux/grant", grantBody("starter", "in_h10_0001"));
    expect(await replay.json()).toMatchObject({ status: "done", amountUsd: 10 });
    expect(flux.grants).toHaveLength(1);
    expect((await admin("/v1/internal/flux/grant", grantBody("starter", "in_h10_0001"))).status).toBe(200);
    expect(flux.grants).toHaveLength(1);
  });

  it("hole 10: invoice, entitlement and delivery outbox commit in one batch; a failed batch leaves nothing behind", async () => {
    await ready();
    let armed = true;
    dbHook = async (sql) => { if (armed && /INSERT OR IGNORE INTO flux_grants/.test(sql)) { armed = false; dbHook = null; throw new Error("crash"); } };
    await expect(grantMonthlyCredits(testEnv(), grantBody("starter", "in_h10_0002"), gdeps())).rejects.toThrow("crash");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_invoices WHERE invoice_id='in_h10_0002'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_entitlements").first()).toEqual({ n: 0 });
    const retry = await grantMonthlyCredits(testEnv(), grantBody("starter", "in_h10_0002"), gdeps());
    expect(retry).toMatchObject({ status: "done", amountUsd: 10 });
  });
});

describe("round 2: lifecycle, link fencing and compensation (hole 5, relink, status)", () => {
  const sweep = () => sweepFlux(testEnv(), { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
  const ready = async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    return owner;
  };
  const mintReq = (token: string) => call("POST", `/v1/homes/${HOME}/flux/subkey`, token, {});
  /** The compensate ops, as {generation, state}: 'queued' is what the old table called due/armed. */
  const compRows = () => env.DB.prepare(`SELECT json_extract(payload,'$.generation') AS generation,state FROM flux_home_ops
    WHERE kind='compensate' ORDER BY seq`).all<{ generation: number; state: string }>();

  it("hole 5: a mint cannot return 200 with zero link rows when unlink completes between the link read and the claim", async () => {
    const owner = await ready();
    armDb(/UPDATE flux_home_keys SET\s+lifecycle_version/, async () => { await call("DELETE", "/v1/flux/link", owner.token); });
    const response = await mintReq(owner.token);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("sk-flux-home-");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_links").first()).toEqual({ n: 0 });
    expect(flux.keys.size).toBe(0);
    expect((await homeRow())?.state).not.toBe("active");
  });

  it("hole 5: an unlink that lands while the mint is in flight fails the conditional D1 commit and revokes the specific key", async () => {
    const owner = await ready();
    flux.afterMint = async () => { await call("DELETE", "/v1/flux/link", owner.token); };
    const response = await mintReq(owner.token);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("sk-flux-home-");
    expect(flux.keys.size).toBe(0);
    expect(flux.keyRevokes.map((r) => r.generation)).toEqual([flux.mints[0].generation]);
    expect((await homeRow())?.state).not.toBe("active");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_links").first()).toEqual({ n: 0 });
  });

  it("hole 5: unlink fences the link (version up, fenced) BEFORE it stops any home", async () => {
    const owner = await ready();
    await mintReq(owner.token);
    let atStop: Record<string, unknown> | null = null;
    flux.onStop = async () => { atStop = await env.DB.prepare("SELECT link_version,fenced FROM flux_links").first(); };
    await call("DELETE", "/v1/flux/link", owner.token);
    expect(atStop).toEqual({ link_version: 2, fenced: 1 });
    expect(flux.stopLinkVersions).toEqual([2]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_links").first()).toEqual({ n: 0 });
  });

  it("hole 5: a fenced link cannot issue a key while the unlink is unfinished", async () => {
    const owner = await ready();
    await mintReq(owner.token);
    flux.stopDown = true;
    expect((await call("DELETE", "/v1/flux/link", owner.token)).status).toBe(502);
    expect(await env.DB.prepare("SELECT fenced FROM flux_links").first()).toEqual({ fenced: 1 });
    flux.stopDown = false;
    expect((await mintReq(owner.token)).status).toBe(409);
    expect((await call("DELETE", "/v1/flux/link", owner.token)).status).toBe(200); // the retry finishes it
  });

  it("hole 5: compensation revokes the SPECIFIC minted key with a durable retry, and never a later resume", async () => {
    const owner = await ready();
    flux.keyRevokeDown = true;
    flux.afterMint = async () => { await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {}); };
    const raced = await mintReq(owner.token);
    expect(raced.status).toBe(409);
    expect(await raced.text()).not.toContain("sk-flux-home-");
    expect((await compRows()).results).toEqual([{ generation: 1, state: "queued" }]);
    // Round 4: a resume never runs ahead of a queued op that is failing: it is told so (502) and the
    // compensation stays queued.
    const blocked = await mintReq(owner.token);
    expect(blocked.status).toBe(502);
    expect(flux.mints).toHaveLength(1);
    // The owner resumes (generation 2) once the router answers: the compensation of 1 runs first.
    flux.keyRevokeDown = false;
    const resumed = await mintReq(owner.token);
    expect(resumed.status).toBe(200);
    expect((await resumed.json<{ generation: number }>()).generation).toBe(2);
    clock += 11 * 60_000;
    await sweep();
    expect(flux.keyRevokes.map((r) => r.generation)).toEqual([1]);
    expect([...flux.keys]).toEqual([2]); // the resumed key survives
    expect((await compRows()).results).toEqual([{ generation: 1, state: "done" }]);
    expect((await homeRow())?.state).toBe("active");
    expect(flux.overlapped).toBe(false);
  });

  it("hole 5 / round 3: a mint that crashed after the router published (its op still running) is turned into a compensation of its generation by the sweep, never completed", async () => {
    await ready();
    await seedHomeKeyRow();
    flux.keys.add(5);
    await env.DB.prepare(`INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,created_at,updated_at)
      VALUES ('m1',?,1,'mint','{"generation":5,"lifecycleVersion":1}','running',?,?)`).bind(HOME, clock - 30 * 60_000, clock - 30 * 60_000).run();
    await sweep();
    expect(flux.keyRevokes.map((r) => r.generation)).toEqual([5]);
    expect(flux.mints).toEqual([]); // never completed as a mint
    expect(await env.DB.prepare("SELECT kind,state FROM flux_home_ops WHERE op_id='m1'").first()).toEqual({ kind: "compensate", state: "done" });
  });

  it("hole 5: a mint that Flux definitively refuses leaves no compensation, one that may have landed leaves a due one", async () => {
    const owner = await ready();
    flux.mintError = new FluxError(409, "", "stale_lifecycle");
    await mintReq(owner.token);
    expect((await compRows()).results).toEqual([]);
    flux.mintError = null;
    flux.down = true;
    await mintReq(owner.token);
    flux.down = false;
    expect((await compRows()).results).toHaveLength(1);
    expect((await compRows()).results[0].state).toBe("queued");
    // The next try uses a generation above the one that may have been published (and is now tombstoned).
    const ok = await mintReq(owner.token);
    expect((await ok.json<{ generation: number }>()).generation).toBeGreaterThan(1 + 0);
    await sweep();
    expect(flux.tombstonedKeys.size).toBeGreaterThan(0);
    expect([...flux.keys]).toEqual([flux.mints.at(-1)!.generation]);
  });

  it("hole 5: resume advances the lifecycle version, so a delayed Stop retry cannot revoke it", async () => {
    const owner = await ready();
    await mintReq(owner.token);
    expect(flux.mints[0].lifecycleVersion).toBe(1);
    // The Stop cannot reach the router; a resume is refused while that Stop is unfinished (round 4: a
    // mint never runs ahead of a failing queued op), then lands right after the Stop, above it.
    flux.stopDown = true;
    expect((await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {})).status).toBe(502);
    expect((await mintReq(owner.token)).status).toBe(502);
    flux.stopDown = false;
    expect((await mintReq(owner.token)).status).toBe(200);
    expect(flux.stopVersions).toEqual([2]);
    expect(flux.mints.at(-1)!.lifecycleVersion).toBe(3);
    clock += BACKOFF;
    await sweep(); // nothing left: the Stop is done and never replayed over the resume
    expect(flux.keys.has(flux.mints.at(-1)!.generation)).toBe(true);
    expect(flux.stopVersions).toEqual([2]);
    expect(await homeRow()).toMatchObject({ state: "active", lifecycle_version: 3 });
    expect(await env.DB.prepare("SELECT state FROM flux_home_ops WHERE kind='stop'").first()).toEqual({ state: "done" });
  });

  it("relink: after a versioned unlink and revoke the home can be re-issued under the new link, above the old link version", async () => {
    const owner = await ready();
    await mintReq(owner.token);
    const first = flux.mints[0];
    await call("DELETE", "/v1/flux/link", owner.token);
    expect(flux.linkFloor).toBe(2);
    await link(owner.token, "99999999-2222-3333-4444-555555555555");
    const again = await mintReq(owner.token);
    expect(again.status).toBe(200);
    const second = flux.mints[1];
    expect(second.accountId).toBe("99999999-2222-3333-4444-555555555555");
    expect(second.linkVersion).toBe(3);
    expect(second.linkId).not.toBe(first.linkId);
    expect(second.lifecycleVersion).toBeGreaterThan(first.lifecycleVersion);
  });

  it("round 2 wire: a mint carries the link, lifecycle, cap and billing versions; a cap change bumps the cap version", async () => {
    const owner = await ready();
    await mintReq(owner.token);
    expect(flux.mints[0]).toMatchObject({ linkVersion: 1, lifecycleVersion: 1, capVersion: 1, billingState: "ok" });
    expect(flux.mints[0].linkId).toMatch(/^[0-9a-f]{32}$/);
    await call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, { capUsd: 40 });
    expect(flux.caps).toEqual([{ homeId: HOME, capMicrocents: 40_000_000, capVersion: 2 }]);
    await mintReq(owner.token);
    expect(flux.mints[1].capVersion).toBe(3);
    expect(flux.mints[1].capMicrocents).toBe(40_000_000);
  });

  it("hole 12: CP never refuses a prepaid-only account (no billing identity) and passes the identity only when it has one", async () => {
    const owner = await ready();
    expect((await mintReq(owner.token)).status).toBe(200);
    expect(flux.mints[0].billingCustomerId).toBeUndefined();
    await admin("/v1/internal/flux/plan", { homeId: HOME, plan: "pro", billingCustomerId: "cus_abc123" });
    expect((await mintReq(owner.token)).status).toBe(200);
    expect(flux.mints[1].billingCustomerId).toBe("cus_abc123");
  });

  it("status: every router refusal state is paused; only ok is not, and an unreachable router is paused", async () => {
    const owner = await ready();
    await mintReq(owner.token);
    for (const state of ["capped", "stopped", "revoked", "ip_refused", "unavailable", "invalid", "unfunded", "fenced", "state_lost"]) {
      flux.statusFor = { ...flux.statusFor, state };
      const body = await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<{ paused: boolean; message: string | null; flux: string }>();
      expect(body, state).toMatchObject({ paused: true, flux: state });
      expect(body.message, state).toContain("Claude and ChatGPT sign-ins keep working");
    }
    flux.statusFor = { ...flux.statusFor, state: "ok" };
    expect(await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json()).toMatchObject({ paused: false });
    flux.down = true;
    expect(await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json()).toMatchObject({ paused: true });
  });
});

describe("round 2: the Flux client wire format", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (status = 200, body: unknown = {}) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const sent = () => JSON.parse(String(calls.at(-1)!.init.body));

  it("sends the contract fields on mint, stop (home), revoke (key), cap and grant", async () => {
    calls.length = 0;
    const key = "sk-" + "flux-home-" + "x".repeat(24);
    await createFluxClient(testEnv(), fakeFetch(200, { key, expires_at: "2026-11-13T00:00:00Z", generation: 3, cap_microcents: 30_000_000 })).mint({
      accountId: FLUX_ACCOUNT, homeId: HOME, generation: 3, boundIps: [HOME_IP], capMicrocents: 30_000_000, ttlSeconds: 3600,
      lifecycleVersion: 4, ownerResume: true, opId: "o", linkId: "abc", linkVersion: 2, capVersion: 5, billingState: "ok", billingCustomerId: "cus_1",
    });
    expect(sent()).toMatchObject({ link_id: "abc", link_version: 2, lifecycle_version: 4, cap_version: 5, billing_state: "ok", billing_customer_id: "cus_1" });
    await createFluxClient(testEnv(), fakeFetch(200, {})).stop(HOME, 7, { linkVersion: 3, reason: "unlink" });
    expect(sent()).toEqual({ home_id: HOME, lifecycle_version: 7, scope: "home", link_version: 3, reason: "unlink" });
    await createFluxClient(testEnv(), fakeFetch(200, {})).stop(HOME, 7);
    expect(sent()).toEqual({ home_id: HOME, lifecycle_version: 7, scope: "home", reason: "stop" });
    await createFluxClient(testEnv(), fakeFetch(200, {})).revokeKey(HOME, 3, 4, "mint_raced");
    expect(calls.at(-1)!.url).toBe("https://api.fluxrouter.ai/internal/cloud-home/subkeys/revoke");
    expect(sent()).toEqual({ home_id: HOME, lifecycle_version: 4, scope: "key", generation: 3, reason: "mint_raced" });
    await createFluxClient(testEnv(), fakeFetch(200, {})).setCap(HOME, 5_000_000, 9);
    expect(sent()).toEqual({ home_id: HOME, cap_microcents: 5_000_000, cap_version: 9 });
    // Lane H1: the grant goes to the router's grant route with its fenced revision (top-level, outside the frozen body).
    extra = { FLUX_CLOUD_GRANTS_URL: "https://router.test", FLUX_CLOUD_GRANTS_TOKEN: "g".repeat(40) };
    await createFluxClient(testEnv(), fakeFetch(200, { status: "granted", amount_microcents: 1 })).grant({
      grantId: "inv:x", entitlementKey: "k", recipientFluxAccountId: FLUX_ACCOUNT, homeId: HOME, plan: "pro", amountMicrocents: 1,
      periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", expiresAt: "c", deliveryId: "d-1", invoiceId: "x", kind: "period",
    });
    expect(calls.at(-1)!.url).toBe("https://router.test/internal/cloud-home/credit-grants");
    expect(sent()).toMatchObject({ grant_id: "x:period", invoice_id: "x", account_id: FLUX_ACCOUNT, revision: 1 });
  });

  it("requires a definitive revoked/tombstoned answer from the grant revoke endpoint, and reads a top-level error code", async () => {
    // Lane H1: the router's /reverse answers (reversed / already_reversed: revoked; no_grant: tombstoned); not_applied_reversed is R5.
    extra = { FLUX_CLOUD_GRANTS_URL: "https://router.test", FLUX_CLOUD_GRANTS_TOKEN: "g".repeat(40) };
    const ctx = { invoiceId: "g", kind: "period", homeId: HOME };
    await expect(createFluxClient(testEnv(), fakeFetch(200, { status: "reversed" })).revokeGrant("inv:g", "r", ctx)).resolves.toBe("revoked");
    await expect(createFluxClient(testEnv(), fakeFetch(200, { status: "already_reversed" })).revokeGrant("inv:g", "r", ctx)).resolves.toBe("revoked");
    await expect(createFluxClient(testEnv(), fakeFetch(200, { status: "no_grant" })).revokeGrant("inv:g", "r", ctx)).resolves.toBe("tombstoned");
    await expect(createFluxClient(testEnv(), fakeFetch(200, {})).revokeGrant("inv:g", "r", ctx)).rejects.toMatchObject({ status: 502 });
    const grant = { grantId: "inv:g", entitlementKey: "k", recipientFluxAccountId: FLUX_ACCOUNT, homeId: HOME, plan: "pro", amountMicrocents: 1,
      periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", expiresAt: "c", deliveryId: "d", invoiceId: "g", kind: "period" };
    await expect(createFluxClient(testEnv(), fakeFetch(200, { status: "not_applied_reversed" })).grant(grant)).rejects.toMatchObject({ status: 409, code: "revoked" });
    await expect(createFluxClient(testEnv(), fakeFetch(409, { code: "account_not_fresh" })).grant(grant)).rejects.toMatchObject({ status: 409, code: "account_not_fresh" });
  });
});

describe("round 3: one per-home serializer (Codex findings 2, 3, 4, 7, control-plane side)", () => {
  const sweep = () => sweepFlux(testEnv(), { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
  const ready = async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    return owner;
  };
  const mintReq = (token: string) => call("POST", `/v1/homes/${HOME}/flux/subkey`, token, {});
  const stopReq = (token: string) => call("POST", `/v1/homes/${HOME}/flux/stop`, token, {});
  const errorOf = async (response: Response) => (await response.json<{ error: string }>()).error;
  const ops = () => env.DB.prepare("SELECT kind,state FROM flux_home_ops ORDER BY seq").all<{ kind: string; state: string }>();

  it("F2: a billing Stop interrupted right after its batch is finished by the sweep: router Stop with the bumped version, state stopped, reversals sent", async () => {
    const owner = await ready();
    await mintReq(owner.token);
    await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_f2_0001", ...period(-10) }); // current period, delivered
    expect(flux.grants).toHaveLength(1);
    await coverRefund("in_f2_0001", 4900); // INTEGRATED-9: only money actually returned removes credit
    // Interrupt at the first statement after the hold is durable: the old code's grant cancellation, or the new
    // code's first read of the home's queue (its single batch has already committed).
    dbHook = (sql) => {
      const batch = sql.includes(";\n");
      if ((!batch && /UPDATE flux_grants SET status='cancelled'/.test(sql)) || /FROM flux_home_ops\s+WHERE home_id=\? AND state IN/.test(sql)) {
        dbHook = null;
        throw new Error("interrupted");
      }
    };
    await expect(stopForBilling(testEnv(), HOME, { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock }, { invoiceId: "in_f2_0001" })).rejects.toThrow("interrupted");
    expect(flux.stops).toEqual([]);
    expect(await homeRow()).toMatchObject({ billing_hold: 1 });
    await sweep();
    expect(flux.stopVersions).toEqual([2]); // minted at 1, bumped by the billing Stop
    expect(await homeRow()).toMatchObject({ state: "stopped", billing_hold: 1, lifecycle_version: 2 });
    expect(flux.revokes.map((r) => r.grantId)).toEqual(["inv:in_f2_0001"]);
    expect(flux.keys.size).toBe(0);
  });

  it("Astra JOURNEY-A-5 #3: a billing Stop that names its invoice reverses only that invoice's grant, never another current-period grant", async () => {
    const owner = await ready();
    await mintReq(owner.token);
    await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_a5_0001", ...period(-10) });
    await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_b5_0001", ...period(-5) });
    expect(flux.grants).toHaveLength(2);
    await coverRefund("in_a5_0001", 4900); // the named invoice's payment came back in full
    await stopForBilling(testEnv(), HOME, { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock }, { invoiceId: "in_a5_0001" });
    expect(flux.revokes.map((r) => r.grantId)).toEqual(["inv:in_a5_0001"]);
    expect(await env.DB.prepare("SELECT grant_id,router_state FROM flux_grant_accounts ORDER BY grant_id").all().then((r) => r.results))
      .toEqual([{ grant_id: "inv:in_a5_0001", router_state: "revoked" }, { grant_id: "inv:in_b5_0001", router_state: "delivered" }]);
  });

  it("F4: a cap lowered while the first mint is in flight (CP not active yet) is republished after the mint commits", async () => {
    const owner = await ready();
    flux.afterMint = async () => {
      expect((await call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, { capUsd: 5 })).status).toBe(200);
    };
    const minted = await mintReq(owner.token);
    expect(minted.status).toBe(200);
    expect(flux.mints[0].capMicrocents).toBe(30_000_000); // the mint published the old cap
    expect(flux.routerCap).toBe(5_000_000); // and the queued cap op republished the new one
    expect(flux.routerCapVersion).toBe((await homeRow())?.cap_version);
    expect((await minted.json<{ capUsd: number }>()).capUsd).toBe(5);
    expect(flux.overlapped).toBe(false);
  });

  it("F4: a cap change that cannot reach the router is kept and retried, never undone", async () => {
    const owner = await ready();
    await mintReq(owner.token);
    flux.down = true;
    await call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, { capUsd: 9 });
    expect(await homeRow()).toMatchObject({ cap_microcents: 9_000_000, cap_version: 2 });
    flux.down = false;
    clock += BACKOFF;
    await sweep();
    expect(flux.routerCap).toBe(9_000_000);
    expect(flux.routerCapVersion).toBe(2);
    // A stale push is a success: a newer version is already there.
    flux.capFloor = 10;
    await call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, { capUsd: 12 });
    expect((await ops()).results.every((o) => o.state === "done")).toBe(true);
  });

  it("F3: a compensation and a later-generation mint never run at the router at the same time (the mint is told home_busy)", async () => {
    const owner = await ready();
    let during: Response | null = null;
    flux.afterMint = async () => { await stopReq(owner.token); }; // the first mint is raced, so its key is compensated
    flux.onKeyRevoke = async () => { during = await mintReq(owner.token); }; // a resume arrives while the compensation is at the router
    const raced = await mintReq(owner.token);
    expect(raced.status).toBe(409);
    expect(during).not.toBeNull();
    expect(during!.status).toBe(409);
    expect(await errorOf(during!)).toBe("home_busy");
    expect(flux.overlapped).toBe(false);
    expect(flux.keyRevokes.map((r) => r.generation)).toEqual([1]);
    // Retried after the home is free, the resume lands on a higher generation and is not revoked.
    const resumed = await mintReq(owner.token);
    expect(resumed.status).toBe(200);
    expect((await resumed.json<{ generation: number }>()).generation).toBe(2);
    expect([...flux.keys]).toEqual([2]);
  });

  it("F3: a stale mint op (its caller crashed) becomes a compensation of that generation and is never completed", async () => {
    await ready();
    await seedHomeKeyRow();
    flux.keys.add(7);
    await env.DB.prepare(`INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,created_at,updated_at)
      VALUES ('m7',?,1,'mint','{"generation":7,"lifecycleVersion":1}','running',?,?)`).bind(HOME, clock - 60_000, clock - 60_000).run();
    await sweep();
    expect(flux.keyRevokes.map((r) => r.generation)).toEqual([7]);
    expect(flux.mints).toEqual([]);
    expect([...flux.keys]).toEqual([]);
  });

  it("F7: a Stop and a resume issued at the same time run in order: the resume is told home_busy while the Stop is at the router, and is not revoked on retry", async () => {
    const owner = await ready();
    await mintReq(owner.token);
    let resumeDuring: Response | null = null;
    flux.onStop = async () => { resumeDuring = await mintReq(owner.token); };
    const stop = await stopReq(owner.token);
    expect(stop.status).toBe(200);
    expect(resumeDuring!.status).toBe(409);
    expect(await errorOf(resumeDuring!)).toBe("home_busy");
    expect(flux.overlapped).toBe(false);
    expect(flux.stopVersions).toEqual([2]);
    expect(await homeRow()).toMatchObject({ state: "stopped" });
    const resumed = await mintReq(owner.token);
    expect(resumed.status).toBe(200);
    expect(flux.keys.has(flux.mints.at(-1)!.generation)).toBe(true);
    await sweep();
    expect(flux.stopVersions).toEqual([2]); // the earlier Stop is never replayed over the resume
    expect(flux.keys.has(flux.mints.at(-1)!.generation)).toBe(true);
    expect(await homeRow()).toMatchObject({ state: "active" });
  });

  it("F7: a Stop that arrives while a resume is minting queues behind it and runs right after (resume then Stop, in order)", async () => {
    const owner = await ready();
    await mintReq(owner.token);
    flux.afterMint = async () => { expect((await stopReq(owner.token)).status).toBe(202); };
    const raced = await mintReq(owner.token);
    expect(raced.status).toBe(409); // the Stop wins; the resumed key is compensated, never returned
    expect(flux.overlapped).toBe(false);
    expect(flux.keys.size).toBe(0);
    expect(await homeRow()).toMatchObject({ state: "stopped" });
  });

  it("a crashed lease holder: an expired lease is taken over by the sweep; an unexpired one is left alone", async () => {
    const owner = await ready();
    await mintReq(owner.token);
    flux.stopDown = true;
    await stopReq(owner.token); // 502, the Stop stays queued
    flux.stopDown = false;
    await env.DB.prepare("UPDATE flux_home_keys SET op_holder='dead-worker',op_lease_until=? WHERE home_id=?").bind(clock + 60_000, HOME).run();
    await sweep();
    expect(flux.stops).toEqual([]); // the holder may still be working
    clock += BACKOFF; // the lease has expired and the failed Stop's backoff has passed
    await sweep();
    expect(flux.stops).toEqual([HOME]);
    expect(await homeRow()).toMatchObject({ state: "stopped", op_holder: null });
  });

  it("ops are idempotent: a Stop whose answer was lost is sent again with the same version and ends the same", async () => {
    const owner = await ready();
    await mintReq(owner.token);
    flux.stopAckLost = true;
    expect((await stopReq(owner.token)).status).toBe(502);
    expect(flux.stopVersions).toEqual([2]); // it took effect at the router
    clock += BACKOFF;
    await sweep();
    expect(flux.stopVersions).toEqual([2, 2]);
    expect(await homeRow()).toMatchObject({ state: "stopped", lifecycle_version: 2 });
    expect((await ops()).results).toEqual([{ kind: "mint", state: "done" }, { kind: "stop", state: "done" }]);
    await sweep();
    expect(flux.stopVersions).toEqual([2, 2]); // done ops are not run again
  });

  it("unlink records every Stop with the fence in one batch, and the link row goes only when all are done", async () => {
    const owner = await ready();
    await mintReq(owner.token);
    flux.stopDown = true;
    expect((await call("DELETE", "/v1/flux/link", owner.token)).status).toBe(502);
    expect(await env.DB.prepare("SELECT fenced FROM flux_links").first()).toEqual({ fenced: 1 });
    flux.stopDown = false;
    clock += BACKOFF;
    await sweep(); // the sweep alone finishes the unlink
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_links").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT version FROM flux_link_floor").first()).toEqual({ version: 2 });
    expect(await homeRow()).toMatchObject({ state: "stopped" });
  });
});

describe("round 4 (Astra 2026-10-10): cap sync, fair sweep, lease ownership, unlink finalization", () => {
  const sweep = () => sweepFlux(testEnv(), { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
  const ready = async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    return owner;
  };
  const mintReq = (token: string) => call("POST", `/v1/homes/${HOME}/flux/subkey`, token, {});
  const errorOf = async (response: Response) => (await response.json<{ error: string }>()).error;
  const cpCap = async () => (await homeRow()) as { cap_microcents: number; cap_version: number; generation: number };

  it("#2: a key is never returned while the router enforces a higher cap than the control plane holds", async () => {
    const owner = await ready();
    // The reproduction: the mint publishes $30, the owner lowers the cap to $5 meanwhile, and the cap
    // publication then fails. The old code answered 200 capUsd 5 while Flux enforced $30.
    flux.afterMint = async () => {
      const lowered = await call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, { capUsd: 5 });
      expect(await lowered.json()).toEqual({ capUsd: 5, enabled: true, pending: true });
      flux.down = true;
    };
    const minted = await mintReq(owner.token);
    expect(minted.status).toBe(503);
    const text = await minted.text();
    expect(text).not.toContain("sk-flux-home-");
    expect(JSON.parse(text).error).toBe("cap_sync_pending");
    expect(flux.routerCap).toBe(30_000_000);
    expect((await cpCap()).cap_microcents).toBe(5_000_000);
    expect((await cpCap()).generation).toBe(0); // never adopted
    // Recovery: the sweep pushes the $5 cap and revokes the generation that was never handed out.
    flux.down = false;
    clock += BACKOFF;
    await sweep();
    expect(flux.tombstonedKeys.has(1)).toBe(true);
    expect([...flux.keys]).toEqual([]); // no usable key at the stale $30 cap
    const retried = await mintReq(owner.token);
    expect(retried.status).toBe(200);
    const body = await retried.json<{ capUsd: number; generation: number }>();
    expect(body.capUsd).toBe(5);
    expect(flux.routerCap).toBe(5_000_000);
    expect(flux.routerCapVersion).toBe((await cpCap()).cap_version);
    expect([...flux.keys]).toEqual([body.generation]);
  });

  it("#2: a cap change during the mint is pushed BEFORE the key is returned (router cap = CP cap at 200)", async () => {
    const owner = await ready();
    let capWhenReturned = -1;
    flux.afterMint = async () => { await call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, { capUsd: 7 }); };
    const origSetCap = flux.setCap.bind(flux);
    let pushedBeforeCommit = false;
    flux.setCap = async (h, c, v) => { const r = await origSetCap(h, c, v); if ((await cpCap()).generation === 0) pushedBeforeCommit = true; return r; };
    const minted = await mintReq(owner.token);
    expect(minted.status).toBe(200);
    capWhenReturned = flux.routerCap;
    expect(pushedBeforeCommit).toBe(true);
    expect(capWhenReturned).toBe(7_000_000);
    expect((await minted.json<{ capUsd: number }>()).capUsd).toBe(7);
    expect(flux.overlapped).toBe(false);
  });

  it("#3: fifty failing homes cannot starve another home's billing Stop; retries back off and each sweep is bounded", async () => {
    const owner = await ready();
    expect((await mintReq(owner.token)).status).toBe(200);
    // Fifty homes whose router calls always fail, queued BEFORE the billing Stop.
    for (let i = 0; i < 50; i++) {
      const id = `home-bad-${String(i).padStart(2, "0")}`;
      flux.failHomes.add(id);
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,updated_at)
          VALUES (?, 'starter', 1, 'active', 30000000, 0, ?)`).bind(id, clock),
        env.DB.prepare(`INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,created_at,updated_at)
          VALUES (?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM flux_home_ops),'cap','{}','queued',?,?)`).bind(`bad-${i}`, id, clock - 1000, clock - 1000),
      ]);
    }
    flux.stopDown = true; // the billing Stop is recorded but its first router call fails
    await expect(stopForBilling(testEnv(), HOME, { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock })).rejects.toThrow();
    flux.stopDown = false;
    expect(flux.stops).toEqual([]);
    clock += 2 * 60_000;
    await sweep();
    expect(flux.stops).toEqual([HOME]); // first sweep: the billing Stop goes first
    expect(await homeRow()).toMatchObject({ state: "stopped", billing_hold: 1 });
    expect(flux.failedCalls).toBeLessThanOrEqual(24); // the rest of the sweep's bounded batch
    // Three more sweeps a minute apart: every failing home is tried at most once (5-minute backoff).
    for (let i = 0; i < 3; i++) { clock += 60_000; await sweep(); }
    expect(flux.failedCalls).toBeLessThanOrEqual(50);
  });

  it("#3: an ordinary Stop queued behind sixty failing homes is reached within a few sweeps", async () => {
    const owner = await ready();
    expect((await mintReq(owner.token)).status).toBe(200);
    for (let i = 0; i < 60; i++) {
      const id = `home-bad-${String(i).padStart(2, "0")}`;
      flux.failHomes.add(id);
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,updated_at)
          VALUES (?, 'starter', 1, 'active', 30000000, 0, ?)`).bind(id, clock),
        env.DB.prepare(`INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,created_at,updated_at)
          VALUES (?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM flux_home_ops),'cap','{}','queued',?,?)`).bind(`bad-${i}`, id, clock - 1000, clock - 1000),
      ]);
    }
    flux.stopDown = true;
    expect((await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {})).status).toBe(502);
    flux.stopDown = false;
    for (let i = 0; i < 4 && flux.stops.length === 0; i++) { clock += 2 * 60_000; await sweep(); }
    expect(flux.stops).toEqual([HOME]);
  });

  it("round 5 #1: 25 failing billing Stops cannot starve another home's ordinary Stop across 4 sweeps", async () => {
    const owner = await ready();
    expect((await mintReq(owner.token)).status).toBe(200);
    // Astra review 5 reproduction: 25 homes with a billing Stop whose router call always fails (their
    // 1-minute backoff expires before every 10-minute sweep), plus one ordinary Stop.
    for (let i = 0; i < 25; i++) {
      const id = `home-bill-${String(i).padStart(2, "0")}`;
      flux.failHomes.add(id);
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,lifecycle_version,updated_at)
          VALUES (?, 'starter', 1, 'stopping', 30000000, 0, 1, ?)`).bind(id, clock),
        env.DB.prepare(`INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,created_at,updated_at)
          VALUES (?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM flux_home_ops),'stop',?,'queued',?,?)`)
          .bind(`bill-${i}`, id, JSON.stringify({ version: 1, reason: "billing_stop" }), clock - 1000, clock - 1000),
      ]);
    }
    flux.stopDown = true;
    expect((await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {})).status).toBe(502);
    flux.stopDown = false;
    expect(flux.stops).toEqual([]);
    const failedBefore = flux.failedCalls;
    for (let i = 0; i < 4; i++) { clock += 10 * 60_000; await sweep(); }
    expect(flux.stops).toEqual([HOME]); // the ordinary Stop reached the router (old code: never)
    expect(await homeRow()).toMatchObject({ state: "stopped" });
    // Billing Stops keep their priority: every one is retried in every sweep (backoff still applies).
    expect(flux.failedCalls - failedBefore).toBeGreaterThanOrEqual(4 * 20);
    expect(flux.failedCalls - failedBefore).toBeLessThanOrEqual(4 * 25);
  });

  it("round 5 #1: a full billing backlog still leaves reserved slots for ordinary work every sweep", async () => {
    await ready();
    for (let i = 0; i < 40; i++) {
      const id = `home-bill-${String(i).padStart(2, "0")}`;
      flux.failHomes.add(id);
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,lifecycle_version,updated_at)
          VALUES (?, 'starter', 1, 'stopping', 30000000, 0, 1, ?)`).bind(id, clock),
        env.DB.prepare(`INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,created_at,updated_at)
          VALUES (?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM flux_home_ops),'stop',?,'queued',?,?)`)
          .bind(`bill-${i}`, id, JSON.stringify({ version: 1, reason: "billing_stop" }), clock - 1000, clock - 1000),
      ]);
    }
    for (let i = 0; i < 12; i++) {
      const id = `home-ord-${String(i).padStart(2, "0")}`;
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,lifecycle_version,updated_at)
          VALUES (?, 'starter', 1, 'stopping', 30000000, 0, 1, ?)`).bind(id, clock),
        env.DB.prepare(`INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,created_at,updated_at)
          VALUES (?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM flux_home_ops),'stop',?,'queued',?,?)`)
          .bind(`ord-${i}`, id, JSON.stringify({ version: 1, reason: "stop" }), clock - 1000, clock - 1000),
      ]);
    }
    clock += 10 * 60_000;
    await sweep();
    expect(flux.stops.length).toBe(5); // SWEEP_RESERVED ordinary homes, oldest first
    expect(flux.failedCalls).toBe(20); // the remaining 20 slots: billing Stops
    clock += 10 * 60_000; await sweep();
    clock += 10 * 60_000; await sweep();
    expect(flux.stops.length).toBe(12); // every ordinary Stop within three sweeps
  });

  it("#4: a caller that loses its lease mid-drain stops; the later caller's key stays valid", async () => {
    const owner = await ready();
    expect((await mintReq(owner.token)).status).toBe(200); // generation 1
    flux.stopDown = true;
    expect((await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {})).status).toBe(502); // Stop queued
    flux.stopDown = false;
    let b: Response | null = null;
    // A resumes and drains the older Stop; while that Stop is at the router A's lease expires and B
    // takes over, finishes the Stop and resumes successfully.
    flux.onStop = async () => {
      clock += 3 * 60_000;
      b = await mintReq(owner.token);
    };
    const a = await mintReq(owner.token);
    expect(b!.status).toBe(200);
    const bGen = (await b!.json<{ generation: number }>()).generation;
    expect(bGen).toBe(2);
    expect(a.status).toBe(409);
    expect(await errorOf(a)).toBe("home_busy");
    expect(flux.mints.map((m) => m.generation)).toEqual([1, 2]); // A published nothing after losing the lease
    clock += BACKOFF;
    await sweep();
    expect([...flux.keys]).toEqual([2]);
    expect(flux.tombstonedKeys.has(2)).toBe(false);
    expect((await homeRow())?.generation).toBe(2);
  });

  it("#4: the mint claim needs the current holder and an unexpired lease", async () => {
    const owner = await ready();
    expect((await mintReq(owner.token)).status).toBe(200);
    // Take the lease away (another worker) between acquisition and the claim.
    armDb(/UPDATE flux_home_keys SET lifecycle_version = lifecycle_version/, async () => {
      await env.DB.prepare("UPDATE flux_home_keys SET op_holder='other-worker',op_lease_until=? WHERE home_id=?").bind(clock + LEASE, HOME).run();
    });
    const refused = await mintReq(owner.token);
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toBe("home_busy");
    expect(flux.mints).toHaveLength(1);
  });

  it("#5: a fenced link whose Stops all completed is finalized by the sweep (crash between the last Stop and the finalize)", async () => {
    const owner = await ready();
    expect((await mintReq(owner.token)).status).toBe(200);
    flux.stopDown = true;
    expect((await call("DELETE", "/v1/flux/link", owner.token)).status).toBe(502);
    flux.stopDown = false;
    // The state the old code left after a crash: every Stop done, the link still fenced.
    await env.DB.prepare("UPDATE flux_home_ops SET state='done' WHERE kind='stop'").run();
    expect(await env.DB.prepare("SELECT fenced FROM flux_links").first()).toEqual({ fenced: 1 });
    await sweep();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_links").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT version FROM flux_link_floor").first()).toEqual({ version: 2 });
  });

  it("#5: the last Stop's completion and the link finalization commit together", async () => {
    const owner = await ready();
    expect((await mintReq(owner.token)).status).toBe(200);
    flux.stopDown = true;
    expect((await call("DELETE", "/v1/flux/link", owner.token)).status).toBe(502);
    flux.stopDown = false;
    // A crash at the completion batch leaves the Stop open (it is re-run, idempotent), never done-but-fenced.
    armDb(/DELETE FROM flux_links/, async () => { throw new Error("crash"); });
    clock += BACKOFF;
    await sweep();
    expect(await env.DB.prepare("SELECT state FROM flux_home_ops WHERE kind='stop'").first()).toEqual({ state: "queued" });
    clock += BACKOFF;
    await sweep();
    expect(await env.DB.prepare("SELECT state FROM flux_home_ops WHERE kind='stop'").first()).toEqual({ state: "done" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_links").first()).toEqual({ n: 0 });
  });
});
