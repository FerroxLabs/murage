// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import { alertTier } from "../src/alert-tiers";
import { weeklyReviewLines } from "../src/alert-pages";
import { firstKeyRetryDelayMs, renewalHeldBack } from "../src/b4-flux-renewal";
import { FluxEmailUnverified, FluxEnsureRefused, FluxHookRetry, FluxNotDispatched } from "../src/flux-grants";
import { fluxEmailProofOperatorRoute } from "../src/flux-email-proof";
import {
  changePlan,
  createFluxClient,
  FluxError,
  FLUX_OFF_MESSAGE,
  fluxOffStubRoute,
  grantMonthlyCredits,
  linkRedirectForTests,
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
import { reconcileQueuedStops } from "../src/legal-refunds";
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
/** 8b: the compatible site sends this on POST /flux/cap; with FLUX_RESUME_VIA_POLLER=1 it lets ON resume a stopped home through the poller. */
const SITE_COMPAT = { "x-murage-site-compat": "spending-2" };
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
  /** 8b router models, all opt-in (the older tests keep the older, looser router). */
  /** L:681: a home stopped at lifecycle V refuses a mint at V or lower (409 home_stopped); a higher one lifts the Stop whatever owner_resume says. */
  strictStop = false;
  /** Router PR 624: a mint that would lift a Stop is refused unless owner_resume is true. */
  requireOwnerResume = false;
  /** R:~500: a generation at or below the latest is 409 stale_generation by CODE (no number in the words). */
  staleByCode = false;
  /** Every router call, in order: "mint:<lifecycle>", "stop:<lifecycle>", "revoke:<generation>", "cap:<version>". */
  log: string[] = [];
  /** Router calls of any kind (the exclusive wrapper) and mint calls that reached the router (even refused ones). */
  calls = 0;
  mintCalls = 0;
  statusHomes: string[] = [];
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
    this.calls++;
    if (this.inflight > 1) this.overlapped = true;
    try { return await fn(); } finally { this.inflight--; }
  }
  mint(input: FluxMint) { return this.exclusive(() => this.mintImpl(input)); }
  stop(homeId: string, lifecycleVersion: number, options: { linkVersion?: number } = {}) { return this.exclusive(() => this.stopImpl(homeId, lifecycleVersion, options)); }
  revokeKey(homeId: string, generation: number, lifecycleVersion: number) { return this.exclusive(() => this.revokeKeyImpl(homeId, generation, lifecycleVersion)); }
  setCap(homeId: string, capMicrocents: number, capVersion: number) { return this.exclusive(() => this.setCapImpl(homeId, capMicrocents, capVersion)); }
  private async mintImpl(input: FluxMint) {
    this.mintCalls++;
    this.check();
    if (this.mintError) throw this.mintError;
    if (this.onMint) { const hook = this.onMint; this.onMint = null; await hook(); }
    if (this.conflictOnce) { const detail = this.conflictOnce; this.conflictOnce = null; throw new FluxError(409, detail); }
    if (input.billingState !== "ok") throw new FluxError(403, "", "billing_hold");
    if (input.lifecycleVersion < this.lifecycleFloor) throw new FluxError(409, "", "stale_lifecycle");
    if (input.capVersion < this.capFloor) throw new FluxError(409, "", "stale_cap");
    if (this.enforceLink && input.linkVersion < this.linkFloor) throw new FluxError(409, "", "stale_link");
    if (this.tombstonedKeys.has(input.generation)) throw new FluxError(409, "", "generation_revoked");
    if (this.strictStop && this.stopped && input.lifecycleVersion <= this.lifecycleFloor) throw new FluxError(409, "", "home_stopped");
    if (this.requireOwnerResume && this.stopped && !input.ownerResume) throw new FluxError(409, "", "owner_resume_required");
    if (input.generation <= this.highestGeneration) throw this.staleByCode ? new FluxError(409, "", "stale_generation") : new FluxError(409, `generation must be greater than ${this.highestGeneration}`);
    this.log.push(`mint:${input.lifecycleVersion}`);
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
    this.log.push(`stop:${lifecycleVersion}`);
    this.stops.push(homeId); this.stopVersions.push(lifecycleVersion); this.stopLinkVersions.push(options.linkVersion);
    if (this.stopAckLost) { this.stopAckLost = false; throw new FluxError(0, "unreachable"); }
  }
  private async revokeKeyImpl(homeId: string, generation: number, lifecycleVersion: number) {
    this.check();
    if (this.onKeyRevoke) { const hook = this.onKeyRevoke; this.onKeyRevoke = null; await hook(); }
    if (this.keyRevokeDown) throw new FluxError(502, "");
    this.keys.delete(generation);
    this.log.push(`revoke:${generation}`);
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
  async status(homeId?: string) { this.statusCalls++; if (homeId) this.statusHomes.push(homeId); this.check(); return this.statusFor; }
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
// 8b: the owner mint is closed in the product; this suite takes its keys through the home's own poller (pollerKey).
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
const worker8b = worker; // kept so a parallel branch that adds tests to the 8b block still merges
let activeWorker = worker;
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
  CLOUD_FLUX_ROUTES_ENABLED: "1", FLUX_API_BASE: "https://api.fluxrouter.ai", FLUX_CLOUD_GRANTS_TOKEN: "g".repeat(40), ...extra,
}) as Env;

async function call(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const h = new Headers({ "content-type": "application/json", ...headers });
  if (token) h.set("authorization", `Bearer ${token}`);
  const ctx = createExecutionContext();
  const response = await activeWorker.fetch(new Request(`https://auth.murage.test${path}`, {
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
  const token = await stepUpToken(member.sub, email);
  tokenUsers.set(token, member.userId);
  return { token, userId: member.userId, sub: member.sub, email };
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
/** Stage A: the redirect link flow is retired (/v1/flux/link/start is 404). An owner's link is the one ensureOwnerLinked writes: link_id =
 *  the Flux account id, version 1. The tests seed exactly that row. */
const tokenUsers = new Map<string, string>();
async function link(token: string, fluxAccount = FLUX_ACCOUNT) {
  const userId = tokenUsers.get(token);
  if (userId === undefined) throw new Error("link(): token not from signIn");
  await env.DB.prepare(`INSERT OR IGNORE INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced)
    SELECT ?,?,?,?,COALESCE((SELECT version FROM flux_link_floor WHERE owner_user_id=?),0)+1,0`)
    .bind(userId, fluxAccount, Date.now(), fluxAccount, userId).run();
}
async function machineSetup(ownerToken: string, userId: string) {
  await seedHome(userId);
  await link(ownerToken);
}
const admin = (path: string, body: unknown, token: string | null = ADMIN) => call("POST", path, token, body);
const seedHomeKeyRow = () => env.DB.prepare(`INSERT OR IGNORE INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,updated_at)
  VALUES (?, 'starter', 0, 'none', 30000000, 0, ?)`).bind(HOME, Date.now()).run();
const homeRow = () => env.DB.prepare("SELECT * FROM flux_home_keys WHERE home_id=?").bind(HOME).first<Record<string, unknown>>();
/** What the home's own poller needs to take a key: its machine credential, a paid live home and an active subscription. Idempotent. */
async function pollerReady(homeId = HOME) {
  await env.DB.batch([
    env.DB.prepare("UPDATE cloud_machines SET credential_hash=? WHERE id=?").bind(await sha256(MACHINE_TOKEN), homeId),
    env.DB.prepare("UPDATE cloud_homes SET entitlement='paid', heartbeat_at=COALESCE(heartbeat_at, ?) WHERE id=?").bind(clock, homeId),
    env.DB.prepare(`INSERT OR IGNORE INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at)
      VALUES (?,'cus_1','sub_1','starter','active',?,?)`).bind(homeId, clock, clock),
  ]);
}
/** The poller's mint: renewal-due, then subkey with the named operation (the only way a key is minted). A home that already holds a live
 *  key is made due first, so a second call is a renewal. Answers the mint response (not acked). */
async function pollerMint(generation = 1): Promise<Response> {
  await pollerReady();
  await env.DB.prepare("DELETE FROM flux_first_key_retry WHERE home_id=?").bind(HOME).run(); // the seed does not wait out the poller's bound
  const post = (route: string, body: unknown) => call("POST", `/v1/machines/${HOME}/flux/${route}`, MACHINE_TOKEN, body, { "CF-Connecting-IP": HOME_IP });
  let due = await (await post("renewal-due", { generation })).json<{ due: boolean; op_id?: string }>();
  if (!due.due) {
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock, HOME).run();
    due = await (await post("renewal-due", { generation })).json<{ due: boolean; op_id?: string }>();
  }
  return post("subkey", { generation, op_id: due.op_id });
}
/** Spending back ON through the cap route (8b: writes the resume, mints nothing); resumeAndKey then takes the poller's resume mint and ack. */
async function spendingOn(ownerToken: string): Promise<Response> {
  extra = { ...extra, FLUX_RESUME_VIA_POLLER: "1" };
  const on = await call("POST", `/v1/homes/${HOME}/flux/cap`, ownerToken, { enabled: true }, { "x-murage-site-compat": "spending-2" });
  expect(on.status).toBe(200);
  return on;
}
async function resumeAndKey(ownerToken: string): Promise<Response> {
  await spendingOn(ownerToken);
  return pollerKey();
}
/** pollerMint, then the poller's ack when the mint landed: the key is delivered and adopted. Answers the mint response. */
async function pollerKey(generation = 1): Promise<Response> {
  const minted = await pollerMint(generation);
  if (minted.status === 200) {
    const k = await minted.clone().json<{ generation: number }>();
    const op = await env.DB.prepare("SELECT pending_op_id FROM flux_home_keys WHERE home_id=?").bind(HOME).first<{ pending_op_id: string }>();
    const ack = await call("POST", `/v1/machines/${HOME}/flux/subkey/ack`, MACHINE_TOKEN, { generation, op_id: op!.pending_op_id, key_generation: k.generation }, { "CF-Connecting-IP": HOME_IP });
    expect(ack.status).toBe(200);
    await env.DB.prepare("DELETE FROM flux_mint_ops WHERE op_id=?").bind(op!.pending_op_id).run(); // a seed leaves no operation marker behind
  }
  return minted;
}
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
    const minted = await pollerKey();
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
    for (const [method, action, body] of [["GET", ""], ["POST", "/cap", { capUsd: 50 }], ["POST", "/stop", {}]] as [string, string, unknown?][]) {
      const theirs = await call(method, `/v1/homes/${HOME}/flux${action}`, other.token, body);
      const unknown = await call(method, `/v1/homes/home-nobody/flux${action}`, other.token, body);
      const a = [theirs.status, await theirs.text()];
      expect([method, action, ...a]).toEqual([method, action, 404, JSON.stringify({ error: "not_found" })]);
      expect([method, action, unknown.status, await unknown.text()]).toEqual([method, action, ...a]);
    }
    // 8b: the owner mint is closed for every home, so /subkey answers one 410 for a foreign and an unknown home alike (it never reaches the owner check).
    for (const id of [HOME, "home-nobody"]) {
      const retired = await call("POST", `/v1/homes/${id}/flux/subkey`, other.token, {});
      expect([id, retired.status, await retired.json()]).toEqual([id, 410, { error: "owner_mint_retired", message: "Your Cloud takes its own Flux key. Nothing to do here." }]);
    }
    expect([flux.mints, flux.caps, flux.stops]).toEqual([[], [], []]);
  });

  it("step 3: link start/complete, cap and stop need a fresh trusted second factor: missing, stale (outside the window) or untrusted factor is 403 step_up_required", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    const stale = await stepUpToken(owner.sub, owner.email, { ageS: 3700 }); // older than any allowed window (60..3600 s)
    // A member whose factor was never put on the trusted list (cloud_trusted_factors).
    const untrustedMember = await cloudMember("untrusted@example.test");
    const untrusted = await stepUpToken(untrustedMember.sub, "untrusted@example.test");
    await seedHome(untrustedMember.userId, { homeId: "home-untrusted" });
    const start = { state: "s".repeat(43) }; // Stage A: the redirect flow is retired, no challenge can be made; the routes keep their gate
    const proof = await signedProof(start.state);
    const gated: [string, unknown, string?][] = [
      ["/v1/flux/link/start", undefined], ["/v1/flux/link/complete", { state: start.state, proof }],
      [`/v1/homes/${HOME}/flux/cap`, { capUsd: 50 }], [`/v1/homes/${HOME}/flux/stop`, {}],
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
    // 8b: the retired owner mint has no step-up gate in front of it: a sign-in-only session gets the 410, not step_up_required.
    const retired = await call("POST", `/v1/homes/${HOME}/flux/subkey`, aal1, {});
    expect([retired.status, (await retired.json<{ error: string }>()).error]).toEqual([410, "owner_mint_retired"]);
    // Nothing happened: no link, no key, no cap, no Stop.
    expect((await linkState(owner.userId)).links).toBe(0);
    expect((await linkState(untrustedMember.userId))).toEqual({ challenges: 0, links: 0 });
    expect([flux.mints, flux.caps, flux.stops]).toEqual([[], [], []]);
    // Sign-in only: link status.
    expect((await call("GET", "/v1/flux/link", aal1)).status).toBe(200);
    // The fresh trusted factor passes the gate; the retired start and complete answer 404.
    expect((await call("POST", "/v1/flux/link/start", owner.token)).status).toBe(404);
    expect((await call("POST", "/v1/flux/link/complete", owner.token, { state: start.state, proof })).status).toBe(404);
    expect(await linkState(owner.userId)).toMatchObject({ links: 0, challenges: 0 });
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
    expect((await pollerKey()).status).toBe(200);
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
    for (const [method, action, body] of [["GET", ""], ["POST", "/cap", { capUsd: 50 }], ["POST", "/stop", {}]] as [string, string, unknown?][]) {
      const theirs = await snapshot(await call(method, `/v1/homes/${HOME}/flux${action}`, other.token, body));
      const staged = await snapshot(await call(method, `/v1/homes/home-cp0-foreign/flux${action}`, other.token, body));
      const unknown = await snapshot(await call(method, `/v1/homes/home-nobody/flux${action}`, other.token, body));
      expect(theirs[0]).toBe(404);
      expect(theirs[2]).toBe(JSON.stringify({ error: "not_found" }));
      expect((theirs[1] as [string, string][]).some(([k]) => k === "server-timing" || k === "x-d1-bookmark")).toBe(false);
      expect([method, action, staged]).toEqual([method, action, theirs]);
      expect([method, action, unknown]).toEqual([method, action, theirs]);
    }
    // 8b: the retired owner mint answers the same 410 for the foreign, the staged and the unknown home.
    const retiredAll = await Promise.all([HOME, "home-cp0-foreign", "home-nobody"].map(async (id) => {
      const r = await call("POST", `/v1/homes/${id}/flux/subkey`, other.token, {});
      return [r.status, await r.text()];
    }));
    expect(retiredAll[0][0]).toBe(410);
    expect(retiredAll[1]).toEqual(retiredAll[0]);
    expect(retiredAll[2]).toEqual(retiredAll[0]);
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

  // The retired flow, switched on in the test only (b4-flux.ts linkRedirectForTests): its own checks still hold.
  it("will not let a different Murage account use someone else's challenge", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    const thief = await signIn("thief@example.test");
    linkRedirectForTests.enabled = true;
    try {
      const { state } = await (await call("POST", "/v1/flux/link/start", owner.token)).json<{ state: string }>();
      expect((await call("POST", "/v1/flux/link/complete", thief.token, { state, proof: await signedProof(state) })).status).toBe(400);
    } finally { linkRedirectForTests.enabled = false; }
  });

  it("expires an unused challenge", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    linkRedirectForTests.enabled = true;
    try {
      const { state } = await (await call("POST", "/v1/flux/link/start", owner.token)).json<{ state: string }>();
      await env.DB.prepare("UPDATE flux_link_challenges SET expires_at=?").bind(clock - 1).run();
      expect((await call("POST", "/v1/flux/link/complete", owner.token, { state, proof: await signedProof(state) })).status).toBe(400);
    } finally { linkRedirectForTests.enabled = false; }
  });

  it("ITEM4-PROOF-CURRENT: /complete 404s while the flow is retired; switched on, its INSERT refuses without a TRUE stamp and with an open dispute", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await env.DB.prepare("UPDATE supabase_identities SET contact_email=? WHERE user_id=?").bind(owner.email, owner.userId).run();
    const challenge = async () => {
      const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
      await env.DB.prepare("INSERT INTO flux_link_challenges (state_hash,owner_user_id,expires_at) VALUES (?,?,?)").bind(await sha256(state), owner.userId, clock + 600_000).run();
      return { state, proof: await signedProof(state) };
    };
    const links = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_links").first<{ n: number }>())!.n;
    const c0 = await challenge();
    expect((await call("POST", "/v1/flux/link/complete", owner.token, c0)).status).toBe(404);
    expect(await links()).toBe(0);
    linkRedirectForTests.enabled = true;
    try {
      // Unproven: refused, nothing linked.
      const r1 = await call("POST", "/v1/flux/link/complete", owner.token, await challenge());
      expect([r1.status, (await r1.json<{ error: string }>()).error]).toEqual([409, "flux_email_unverified"]);
      expect(await links()).toBe(0);
      // Proven but disputed: refused.
      await env.DB.prepare("UPDATE supabase_identities SET email_verified_at=1, email_verified_for=lower(contact_email) WHERE user_id=?").bind(owner.userId).run();
      await env.DB.prepare("INSERT INTO flux_email_proof_disputes (account_id,note,by,email_revision,at) VALUES (?,'x','ops',0,1)").bind(owner.userId).run();
      const r2 = await call("POST", "/v1/flux/link/complete", owner.token, await challenge());
      expect([r2.status, (await r2.json<{ error: string }>()).error]).toEqual([409, "flux_email_unverified"]);
      expect(await links()).toBe(0);
      // A proof for another address (the stamp is not for the current one): refused.
      await env.DB.prepare("DELETE FROM flux_email_proof_disputes").run();
      await env.DB.prepare("UPDATE supabase_identities SET email_verified_for='other@example.test' WHERE user_id=?").bind(owner.userId).run();
      expect((await call("POST", "/v1/flux/link/complete", owner.token, await challenge())).status).toBe(409);
      expect(await links()).toBe(0);
      // A TRUE stamp, no dispute: it links.
      await env.DB.prepare("UPDATE supabase_identities SET email_verified_for=lower(contact_email) WHERE user_id=?").bind(owner.userId).run();
      expect((await call("POST", "/v1/flux/link/complete", owner.token, await challenge())).status).toBe(200);
      expect(await links()).toBe(1);
    } finally {
      linkRedirectForTests.enabled = false;
      await env.DB.prepare("DELETE FROM flux_email_proof_disputes").run();
    }
  });

});

describe("a Flux key for one home", () => {
  it("the owner route mints nothing for anyone: linked or not, own home, foreign home or unknown home all answer the same 410 owner_mint_retired, with no writes and no router call", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    const stranger = await signIn("stranger@example.test");
    await seedHome(owner.userId);
    const refusals = async (token: string, path: string) => {
      const r = await call("POST", path, token, {});
      return [r.status, (await r.json<{ error: string }>()).error];
    };
    const retired = [410, "owner_mint_retired"];
    expect(await refusals(owner.token, `/v1/homes/${HOME}/flux/subkey`)).toEqual(retired); // not linked yet
    await link(owner.token);
    expect(await refusals(owner.token, `/v1/homes/${HOME}/flux/subkey`)).toEqual(retired);
    expect(await refusals(stranger.token, `/v1/homes/${HOME}/flux/subkey`)).toEqual(retired);
    expect(await refusals(stranger.token, "/v1/homes/no-such-home/flux/subkey")).toEqual(retired);
    await env.DB.prepare("UPDATE cloud_machines SET bound_ips=NULL").run();
    expect(await refusals(owner.token, `/v1/homes/${HOME}/flux/subkey`)).toEqual(retired);
    expect(flux.calls).toBe(0);
    expect([flux.mints.length, (await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_home_keys").first<{ n: number }>())!.n]).toEqual([0, 0]);
  });

  it("issues a capped, expiring key bound to the machine's IPs, once, and stores no secret", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    const response = await pollerMint();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json<{ key: string; generation: number; expiresAt: string; capUsd: number }>();
    expect(body.key.startsWith("sk-flux-home-")).toBe(true);
    expect(body.generation).toBe(1);
    expect(body.capUsd).toBe(30);
    expect(flux.mints).toEqual([{
      accountId: FLUX_ACCOUNT, homeId: HOME, generation: 1, boundIps: [HOME_IP], capMicrocents: 30_000_000, ttlSeconds: 35 * 86_400,
      lifecycleVersion: 1, ownerResume: false, opId: `renew:${HOME}:1:0`,
      linkId: FLUX_ACCOUNT, linkVersion: 1, capVersion: 1, billingState: "ok",
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
    await pollerKey();
    const second = await (await pollerKey()).json<{ generation: number }>();
    expect(second.generation).toBe(2);
    flux.conflictOnce = "generation must be greater than 7";
    const third = await pollerKey();
    expect((await third.json<{ generation: number }>()).generation).toBe(8);
    expect((await homeRow())?.generation).toBe(8);
  });

  it("changes nothing when Flux is down", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    flux.down = true;
    const response = await pollerKey();
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
    await pollerKey();
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
    await pollerKey();
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
    clock += 60_000; // 8b fix r1 (Astra M5): the failed attempt waits the bound's first minute
    expect((await call("POST", `/v1/machines/${HOME}/flux/subkey`, MACHINE_TOKEN, { generation: 1 }, { "CF-Connecting-IP": HOME_IP })).status).toBe(200);
  });

  it("hole 11: a renewal mint does not advance the recorded expiry until the poller acks delivery", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await env.DB.prepare("UPDATE cloud_machines SET credential_hash=? WHERE id=?").bind(await sha256(MACHINE_TOKEN), HOME).run();
    const ip = { "CF-Connecting-IP": HOME_IP };
    const post = (path: string, body: unknown, token = MACHINE_TOKEN) => call("POST", `/v1/machines/${HOME}/flux/${path}`, token, body, ip);
    await pollerKey();
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
    // Undelivered: renewal waits the 60 s bound before it is cued again.
    expect(await (await post("renewal-due", { generation: 1 })).json()).toEqual({ due: false });
    clock += 60_000;
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
    await pollerKey();
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock + DAY, HOME).run();
    expect((await post("subkey", { generation: 1 })).status).toBe(200); // delivery lost: no ack
    const early = await post("subkey", { generation: 1 });
    expect([early.status, (await early.json<{ error: string }>()).error]).toEqual([429, "renewal_retry_later"]);
    clock += 60_000;
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
    await pollerKey();
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock + DAY, HOME).run();
    const response = await call("POST", `/v1/machines/${HOME}/flux/subkey`, MACHINE_TOKEN, { generation: 1, op_id: `renew:${HOME}:1:42` }, { "CF-Connecting-IP": HOME_IP });
    expect(response.status).toBe(409);
    expect((await response.json<{ error: string }>()).error).toBe("renewal_op_mismatch");
    expect(flux.mints).toHaveLength(1);
  });

  it("renewal never undoes an owner Stop or a billing hold; the owner route no longer resumes (410), and a hold still refuses", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await env.DB.prepare("UPDATE cloud_machines SET credential_hash=? WHERE id=?").bind(await sha256(MACHINE_TOKEN), HOME).run();
    const renew = () => call("POST", `/v1/machines/${HOME}/flux/subkey`, MACHINE_TOKEN, { generation: 1 }, { "CF-Connecting-IP": HOME_IP });
    await pollerKey();
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock - 1000, HOME).run(); // expired: renewal due
    await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {});
    const afterStop = await renew();
    expect(afterStop.status).toBe(409);
    expect((await afterStop.json<{ error: string }>()).error).toBe("home_not_active");
    expect(flux.mints).toHaveLength(1);
    expect((await homeRow())?.state).toBe("stopped");
    // 8b: the owner's /subkey no longer resumes a stopped home (spending back ON goes through the poller: see the 8b block).
    const retired = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect([retired.status, (await retired.json<{ error: string }>()).error]).toEqual([410, "owner_mint_retired"]);
    expect((await homeRow())?.state).toBe("stopped");
    await admin("/v1/internal/flux/stop", { homeId: HOME, reason: "refunded" });
    const underHold = await renew();
    expect((await underHold.json<{ error: string }>()).error).toBe("billing_hold");
    expect(flux.mints).toHaveLength(1);
  });

  it("the machine renewal-due question answers true only for an active, un-held home with a key due, and needs the machine credential", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await env.DB.prepare("UPDATE cloud_machines SET credential_hash=? WHERE id=?").bind(await sha256(MACHINE_TOKEN), HOME).run();
    const ask = (token: string) => call("POST", `/v1/machines/${HOME}/flux/renewal-due`, token, { generation: 1 }, { "CF-Connecting-IP": HOME_IP });
    await pollerKey();
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
    await pollerKey();
    expect(flux.mints.at(-1)).toMatchObject({ lifecycleVersion: 1 });
    // Stop bumps the version before Flux is told, and Flux is told that version.
    await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {});
    expect(flux.stopVersions).toEqual([2]);
    expect((await homeRow())?.lifecycle_version).toBe(2);
    // Spending back ON writes resume version 3 for the poller's mint (8b); a Stop lands after Flux published the key but before the answer returned.
    extra = { FLUX_RESUME_VIA_POLLER: "1" };
    expect((await call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, { enabled: true }, { "x-murage-site-compat": "spending-2" })).status).toBe(200);
    flux.stops.length = 0; flux.stopVersions.length = 0;
    flux.afterMint = async () => { await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {}); };
    const raced = await pollerKey();
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
    const raced = await pollerKey();
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
    const raced = await pollerKey();
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
      const response = await pollerKey();
      expect(response.status).toBe(409);
      expect((await response.json<{ error: string }>()).error).toBe(reason);
    }
    flux.mintError = new FluxError(409, "", "stale_lifecycle");
    expect((await (await pollerKey()).json<{ error: string }>()).error).toBe("stale_lifecycle");
    // Not the generation catch-up phrase, even though it ends in a number: final, no second attempt.
    flux.mintError = new FluxError(409, "key limit reached 7");
    const final = await pollerKey();
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
    const first = await pollerKey();
    expect(first.status).toBe(503);
    expect((await first.json<{ error: string }>()).error).toBe("billing_identity_unavailable");
    flux.mintError = new FluxError(503, "", "billing_identity_unavailable");
    expect((await pollerKey()).status).toBe(503);
    expect((await homeRow())?.state).toBe("none");
    flux.mintError = null; // Flux recovered: the same request now succeeds
    expect((await pollerKey()).status).toBe(200);
  });
});

describe("cap, Stop and status", () => {
  it("sets the monthly cap inside the allowed range and tells Flux", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await pollerKey();
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
    // The double always reports a $30 cap, which reads as a flushed router, so the same sweep's cap catch-up also repairs it at a higher version.
    expect(flux.caps).toContainEqual({ homeId: HOME, capMicrocents: 70_000_000, capVersion: 3 });
  });

  it("Stop revokes at Flux; if Flux is down it stays 'stopping' and the sweep finishes it", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await pollerKey();
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
    // The owner route no longer resumes (410); spending back ON goes through the poller (8b block).
    const retired = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
    expect([retired.status, (await retired.json<{ error: string }>()).error]).toEqual([410, "owner_mint_retired"]);
    expect((await homeRow())?.state).toBe("stopped");
  });

  it("reports state, cap, spend and the plain pause message at the cap", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    expect(await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json()).toMatchObject({ state: "none", paused: true, plan: "starter", includedCreditsUsd: 10, defaultCapUsd: 30 });
    await pollerKey();
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
    await pollerKey();
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
    await pollerKey();
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
    await pollerKey();
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

// PRODFLUX r4 C: switched on with the real hooks, switching spending off journals a real Stop, so it needs the step-up too (the sign-in-only
// off of journey A8 stays for Flux off, where it changes nothing). These cases post off with the stepped-up token.
describe("journey A8 (Astra JOURNEY-A-2): spending off is stored and revoked (stepped up while Flux is switched on); switching it back on keeps the step-up", () => {
  const capPath = `/v1/homes/${HOME}/flux/cap`;
  beforeEach(() => { extra = { FLUX_RESUME_VIA_POLLER: "1" }; }); // 8b: switching back on resumes through the home's poller
  const post = async (token: string, body: unknown) => {
    const r = await call("POST", capPath, token, body, SITE_COMPAT);
    return [r.status, await r.json<Record<string, unknown>>()] as const;
  };
  it("{enabled:false} and {capUsd:0} store the off state (a zero limit, kept across plan changes) and push it to Flux; the status says off", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await pollerKey();
    expect((await call("POST", capPath, owner.token, { capUsd: 80 })).status).toBe(200);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    // PRODFLUX r4 C: sign-in only is refused for both OFF bodies (nothing written), the step-up switches it off.
    for (const off of [{ enabled: false }, { capUsd: 0 }]) expect((await post(aal1, off))[0]).toBe(403);
    expect(await homeRow()).toMatchObject({ spending_off: 0 });
    // The probe: {capUsd:0} passed the exemption but was 400 invalid_cap; {enabled:false} was rejected outright.
    expect(await post(owner.token, { enabled: false })).toEqual([200, { capUsd: 0, enabled: false }]);
    expect(await homeRow()).toMatchObject({ spending_off: 1, cap_microcents: 80_000_000, cap_custom: 1 }); // the owner's limit is kept for switching back on
    expect(flux.stops.at(-1)).toBe(HOME); expect(flux.caps.some((c) => c.capMicrocents === 0)).toBe(false); // Stage A: off is a home-scope revoke, never cap 0
    expect(await post(owner.token, { capUsd: 0 })).toEqual([200, { capUsd: 0, enabled: false }]);
    flux.statusFor = { ...flux.statusFor, state: "stopped", capMicrocents: 0 }; // the router confirms the zero limit
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
    await pollerKey();
    expect((await call("POST", capPath, owner.token, { capUsd: 80 })).status).toBe(200);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    expect((await post(owner.token, { enabled: false }))[0]).toBe(200);
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
    flux.statusFor = { ...flux.statusFor, state: "stopped", capMicrocents: 0 };
    const off = await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<Status>();
    expect(off).toMatchObject({ capUsd: 0, spendingOff: { requested: true, confirmed: true, pending: false }, paused: true });
    expect(off.message).toContain("switched off");
  });
  it("Astra JOURNEY-A-4 #6: a switch-off the router keeps failing is retried, alerts ops after an hour and gives the customer its duration and support", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await pollerKey();
    expect((await call("POST", capPath, owner.token, { capUsd: 80 })).status).toBe(200);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    const offAt = clock;
    flux.down = true; // the router fails every call
    expect(await post(owner.token, { enabled: false })).toEqual([200, { capUsd: 0, enabled: false, pending: true }]);
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
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_home_ops WHERE home_id=? AND kind IN ('cap','stop') AND state IN ('queued','running')").bind(HOME).first()).toEqual({ n: 0 });
    expect(await alerts()).toEqual([{ id: `alert:spending_off:${HOME}:${offAt}`, resolved_at: clock }]);
  });
  it("Astra JOURNEY-A-5 #7: a positive limit after a confirmed switch-off is drift: zero is requeued and a new incident stays open until it lands", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await pollerKey();
    expect((await call("POST", capPath, owner.token, { capUsd: 80 })).status).toBe(200);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    expect(await post(owner.token, { enabled: false })).toEqual([200, { capUsd: 0, enabled: false }]);
    type Status = { spendingOff: { confirmed: boolean; pending: boolean; pendingSince: number | null } };
    const status = async () => (await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<Status>());
    const alerts = () => env.DB.prepare("SELECT id,resolved_at,detail FROM cloud_alerts WHERE kind='flux.spending_off_unconfirmed' ORDER BY raised_at,id")
      .all<{ id: string; resolved_at: number | null; detail: string }>().then((r) => r.results);
    const queuedCaps = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_home_ops WHERE home_id=? AND kind IN ('cap','stop') AND state IN ('queued','running')").bind(HOME).first<{ n: number }>())!.n;
    const sweepDeps = { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock };
    // Confirmed: the router enforces zero.
    flux.statusFor = { ...flux.statusFor, state: "stopped", capMicrocents: 0 };
    expect((await status()).spendingOff).toMatchObject({ confirmed: true, pending: false });
    expect(await alerts()).toEqual([]);
    // Later the router reports a positive limit again (and cannot be told zero right now): drift.
    flux.statusFor = { ...flux.statusFor, state: "ok", capMicrocents: 80_000_000 };
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
    expect(flux.stops.at(-1)).toBe(HOME); expect(flux.caps.some((c) => c.capMicrocents === 0)).toBe(false); // Stage A: off is a home-scope revoke, never cap 0
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
    await pollerKey();
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    expect(await post(owner.token, { enabled: false })).toEqual([200, { capUsd: 0, enabled: false }]);
    const sweepDeps = { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock };
    const queuedCaps = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_home_ops WHERE home_id=? AND kind IN ('cap','stop') AND state IN ('queued','running')").bind(HOME).first<{ n: number }>())!.n;
    const checkedAt = async () => (await env.DB.prepare("SELECT spending_off_checked_at AS c FROM flux_home_keys WHERE home_id=?").bind(HOME).first<{ c: number | null }>())!.c;
    const alerts = () => env.DB.prepare("SELECT id,resolved_at FROM cloud_alerts WHERE kind='flux.spending_off_unconfirmed' ORDER BY raised_at,id").all().then((r) => r.results);
    // Zero confirmed by the router, nothing queued.
    flux.statusFor = { ...flux.statusFor, state: "stopped", capMicrocents: 0 };
    clock += 60_000;
    await sweepFlux(testEnv(), sweepDeps);
    expect(await queuedCaps()).toBe(0);
    expect(await checkedAt()).toBe(clock);
    // Nobody visits the page; the router drifts to a positive limit (and cannot be told zero right now).
    flux.statusFor = { ...flux.statusFor, state: "ok", capMicrocents: 80_000_000 };
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
    flux.statusFor = { ...flux.statusFor, state: "stopped", capMicrocents: 0 };
    clock += 2 * 60 * 60_000;
    await sweepFlux(testEnv(), sweepDeps);
    expect(await queuedCaps()).toBe(0);
    expect(flux.stops.at(-1)).toBe(HOME); expect(flux.caps.some((c) => c.capMicrocents === 0)).toBe(false); // Stage A: off is a home-scope revoke, never cap 0
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
    flux.statusFor = { ...flux.statusFor, state: "stopped", capMicrocents: 0 };
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
    await pollerKey();
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
    // The plan change sends nothing for an off home (no cap 0); the revoke the race left undone is finished by the sweep's off poll.
    expect(flux.caps).toEqual([]);
    clock += 10 * 60_000;
    flux.statusFor = { ...flux.statusFor, state: "none" }; // the Stop took: the router no longer reports the key live (8b: a live stopped home gets a repair Stop)
    await sweepFlux(testEnv(), { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect(flux.stops).toEqual([HOME]);
    expect(await homeRow()).toMatchObject({ state: "stopped", spending_off: 1 });
  });
  it("switching spending back on, or raising it from off, needs the fresh second factor", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await pollerKey();
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    expect((await post(owner.token, { enabled: false }))[0]).toBe(200);
    expect(await post(aal1, { enabled: true })).toEqual([403, expect.objectContaining({ error: "step_up_required" })]);
    expect(await post(aal1, { enabled: true, capUsd: 20 })).toEqual([403, expect.objectContaining({ error: "step_up_required" })]);
    expect(await post(aal1, { capUsd: 5 })).toEqual([403, expect.objectContaining({ error: "step_up_required" })]);
    expect(await homeRow()).toMatchObject({ spending_off: 1 });
    const [st, on] = await post(owner.token, { enabled: true });
    expect(st).toBe(200);
    expect(on).toMatchObject({ enabled: true });
    expect((on.capUsd as number) > 0).toBe(true);
    expect(await homeRow()).toMatchObject({ spending_off: 0 });
    expect(on.resume).toBe("pending"); // 8b: the route mints nothing; the home's poller takes its own key
    expect(flux.mints).toHaveLength(1);
  });
});

describe("Stage A: spending off is a home-scope revoke, turning it on resumes through the poller (8b), the cap floor is $5", () => {
  const capPath = `/v1/homes/${HOME}/flux/cap`;
  beforeEach(() => { extra = { FLUX_RESUME_VIA_POLLER: "1" }; });
  const sweepDeps = () => ({ fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
  const start = async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await env.DB.prepare("UPDATE cloud_machines SET credential_hash=? WHERE id=?").bind(await sha256(MACHINE_TOKEN), HOME).run();
    await pollerKey();
    return owner;
  };
  const renew = () => call("POST", `/v1/machines/${HOME}/flux/subkey`, MACHINE_TOKEN, { generation: 1 }, { "CF-Connecting-IP": HOME_IP });
  const customerWords = (text: string) => {
    expect(text).not.toMatch(/\bkey\b|router|Flux|revoked|stale|\u2014|\u2013/i);
  };
  it("off sends a home-scope revoke and never cap 0; turning it on mints nothing at the route: the poller takes a fresh key at the higher versions", async () => {
    const owner = await start();
    expect((await call("POST", capPath, owner.token, { capUsd: 80 })).status).toBe(200);
    const before = await homeRow();
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    const off = await call("POST", capPath, owner.token, { enabled: false });
    expect([off.status, await off.json()]).toEqual([200, { capUsd: 0, enabled: false }]);
    expect(flux.stops).toEqual([HOME]);
    expect(flux.caps.every((c) => c.capMicrocents >= 5_000_000)).toBe(true);
    expect(await homeRow()).toMatchObject({ spending_off: 1, state: "stopped", cap_microcents: 80_000_000 });
    const mintsBefore = flux.mints.length;
    const on = await call("POST", capPath, owner.token, { capUsd: 80 }, SITE_COMPAT);
    expect([on.status, await on.json()]).toEqual([200, { capUsd: 80, enabled: true, resume: "pending" }]);
    expect(flux.mints).toHaveLength(mintsBefore); // the route mints nothing
    expect(await homeRow()).toMatchObject({ spending_off: 0, state: "active", key_expires_at: null });
    // The home's own poller takes the key: owner_resume true, at a higher lifecycle and generation.
    const taken = await renew();
    expect(taken.status).toBe(200);
    const body = await taken.json<{ generation: number }>();
    expect(flux.mints.at(-1)).toMatchObject({ ownerResume: true });
    expect(flux.mints.at(-1)!.lifecycleVersion).toBeGreaterThan(Number(before!.lifecycle_version));
    expect(flux.mints.at(-1)!.generation).toBeGreaterThan(Number(before!.generation));
    expect(await homeRow()).toMatchObject({ spending_off: 0, state: "active", generation: body.generation });
    expect(flux.keys.has(body.generation)).toBe(true);
  });
  it("if the poller's mint cannot land at once the resume stays pending and the poller's next attempt finishes it", async () => {
    const owner = await start();
    await call("POST", capPath, owner.token, { enabled: false });
    const on = await call("POST", capPath, owner.token, { capUsd: 80 }, SITE_COMPAT);
    expect([on.status, await on.json()]).toEqual([200, { capUsd: 80, enabled: true, resume: "pending" }]);
    flux.mintError = new FluxError(502, "");
    expect((await renew()).status).toBe(502);
    expect(await homeRow()).toMatchObject({ state: "active", spending_off: 0, key_expires_at: null });
    flux.mintError = null;
    clock += 60_000; // fix r1 (Astra M5): a failed resume attempt waits the bound's first minute
    expect((await renew()).status).toBe(200);
    expect(await homeRow()).toMatchObject({ state: "active", spending_off: 0, pending_op_id: expect.any(String) });
  });
  it("a renewal after a stop keeps the lifecycle version, stays stopped, raises no alert, and answers in plain words", async () => {
    const owner = await start();
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock - 1000, HOME).run();
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    await call("POST", capPath, owner.token, { enabled: false });
    const stopped = await homeRow();
    const answer = await renew();
    expect(answer.status).toBe(409);
    const refusal = await answer.json<{ error: string; message: string }>();
    expect(refusal.error).toBe("home_not_active");
    expect(refusal.message).toContain("Spending is switched off");
    expect(refusal.message).toContain("monthly limit of $5 or more");
    customerWords(refusal.message);
    expect(await homeRow()).toMatchObject({ state: "stopped", lifecycle_version: stopped!.lifecycle_version, generation: stopped!.generation });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE home_id=?").bind(HOME).first<{ n: number }>())!.n).toBe(0);
  });
  it("a renewal mint on an active home does not bump the lifecycle version", async () => {
    const owner = await start();
    const first = await homeRow();
    expect((await pollerKey()).status).toBe(200);
    expect((await homeRow())!.lifecycle_version).toBe(first!.lifecycle_version);
    expect(Number((await homeRow())!.generation)).toBeGreaterThan(Number(first!.generation));
  });
  it("a renewal in flight during a stop leaves no live key, and the stale renewal cannot block the resume", async () => {
    const owner = await start();
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock - 1000, HOME).run();
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    let renewalGeneration = 0;
    flux.afterMint = async () => { // the stop lands while the renewal's key exists at the router and the renewal holds the home
      renewalGeneration = flux.latestGeneration;
      await call("POST", capPath, owner.token, { enabled: false });
    };
    const answer = await renew();
    expect(answer.status).not.toBe(200); // the stale renewal is never delivered
    expect(renewalGeneration).toBeGreaterThan(1);
    clock += 10 * 60_000;
    await sweepFlux(testEnv(), sweepDeps());
    clock += 10 * 60_000;
    await sweepFlux(testEnv(), sweepDeps());
    expect(await homeRow()).toMatchObject({ state: "stopped", spending_off: 1 });
    expect(flux.keys.size).toBe(0);
    expect(flux.stopped).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_mint_ops WHERE home_id=?").bind(HOME).first<{ n: number }>())!.n).toBe(0);
    // Turning spending back on: the poller mints above the stale generation; nothing the renewal left behind blocks it.
    const on = await call("POST", capPath, owner.token, { capUsd: 80 }, SITE_COMPAT);
    expect(on.status).toBe(200);
    const taken = await renew();
    const body = await taken.json<{ key?: string; generation?: number }>();
    expect(taken.status).toBe(200);
    expect(body.key).toBeDefined();
    expect(body.generation!).toBeGreaterThan(renewalGeneration);
    clock += 10 * 60_000;
    await sweepFlux(testEnv(), sweepDeps());
    expect([...flux.keys]).toEqual([body.generation]);
  });
  it("a lowering on a STOPPED home needs the step-up like /subkey: a sign-in-only session gets 403, no key, no resume; on an active home it still works", async () => {
    const owner = await start();
    expect((await call("POST", capPath, owner.token, { capUsd: 80 })).status).toBe(200);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    // Active home: a plain lowering is sign-in only and answers no key.
    const lowered = await call("POST", capPath, aal1, { capUsd: 40 });
    expect(lowered.status).toBe(200);
    expect(await lowered.json()).toEqual({ capUsd: 40, enabled: true });
    expect(await homeRow()).toMatchObject({ state: "active", cap_microcents: 40_000_000 });
    // Stop leaves spending_off=0; the home is stopped.
    const stop = await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {});
    expect(stop.status).toBe(200);
    expect(await homeRow()).toMatchObject({ state: "stopped", spending_off: 0 });
    const mints = flux.mints.length;
    const refused = await call("POST", capPath, aal1, { capUsd: 5 });
    expect(refused.status).toBe(403);
    expect(flux.mints).toHaveLength(mints);
    expect(await homeRow()).toMatchObject({ state: "stopped", cap_microcents: 40_000_000 });
    // With the fresh verification it resumes and answers the key, as /subkey does.
    const resumed = await call("POST", capPath, owner.token, { capUsd: 5 }, SITE_COMPAT);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ resume: "pending", capUsd: 5 });
  });
  it("a Stop that commits between the cap read and its write refuses the sign-in-only lowering (403 step_up_required), never a 500", async () => {
    const owner = await start();
    expect((await call("POST", capPath, owner.token, { capUsd: 80 })).status).toBe(200);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    const mints = flux.mints.length;
    armDb(/UPDATE flux_home_keys SET plan=\?/, async () => {
      await env.DB.prepare("UPDATE flux_home_keys SET state='stopped' WHERE home_id=?").bind(HOME).run();
    });
    const raced = await call("POST", capPath, aal1, { capUsd: 50 });
    expect(raced.status).toBe(403);
    expect((await raced.json<{ error: string }>()).error).toBe("step_up_required");
    expect(flux.mints).toHaveLength(mints);
    expect(await homeRow()).toMatchObject({ state: "stopped", cap_microcents: 80_000_000 });
  });
  it("after an unlink the poller's next mint (spending back on) links again above the floor with no extra step; repeated or raced unlinks never reuse a version", async () => {
    const owner = await start();
    await env.DB.prepare("UPDATE supabase_identities SET contact_email=?, email_verified_at=1, email_verified_for=lower(?) WHERE user_id=?").bind(owner.email, owner.email, owner.userId).run();
    (flux as unknown as { ensureAccount: unknown }).ensureAccount = async () => ({ fluxAccountId: FLUX_ACCOUNT, created: false });
    const linkOf = () => env.DB.prepare("SELECT link_version AS v, fenced FROM flux_links WHERE owner_user_id=?").bind(owner.userId).first<{ v: number; fenced: number }>();
    const floor = async () => (await env.DB.prepare("SELECT version AS v FROM flux_link_floor WHERE owner_user_id=?").bind(owner.userId).first<{ v: number }>())?.v ?? 0;
    expect((await linkOf())!.v).toBe(1);
    expect((await call("DELETE", "/v1/flux/link", owner.token)).status).toBe(200);
    expect(await linkOf()).toBeNull();
    expect(await floor()).toBe(2);
    expect((await call("DELETE", "/v1/flux/link", owner.token)).status).toBe(200); // repeated: nothing moves
    expect(await floor()).toBe(2);
    const resume = async () => expect((await call("POST", capPath, owner.token, { enabled: true }, SITE_COMPAT)).status).toBe(200); // unlink stopped the home
    await resume();
    const again = await pollerKey();
    expect(again.status).toBe(200);
    expect(await linkOf()).toEqual({ v: 3, fenced: 0 });
    expect(flux.mints.at(-1)!.linkVersion).toBe(3);
    // Raced unlinks: every version stays strictly above the last one seen, and the next link is above the floor.
    await Promise.all([call("DELETE", "/v1/flux/link", owner.token), call("DELETE", "/v1/flux/link", owner.token)]);
    for (let i = 0; i < 3 && (await linkOf()) !== null; i += 1) await call("DELETE", "/v1/flux/link", owner.token);
    expect(await linkOf()).toBeNull();
    const f = await floor();
    expect(f).toBeGreaterThanOrEqual(4);
    await resume();
    expect((await pollerKey()).status).toBe(200);
    expect((await linkOf())!.v).toBe(f + 1);
  });
  it("the lowest monthly limit is $5: a smaller one is refused in plain words, $5 is accepted, and below $5 is never a sign-in-only lowering", async () => {
    const owner = await start();
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    expect((await call("POST", capPath, owner.token, { capUsd: 20 })).status).toBe(200);
    const refused = await call("POST", capPath, owner.token, { capUsd: 3 });
    expect(refused.status).toBe(400);
    const body = await refused.json<{ error: string; message: string }>();
    expect(body.message).toBe("The lowest monthly limit is $5. Enter $5 or more, or switch spending off.");
    expect((await call("POST", capPath, aal1, { capUsd: 3 })).status).toBe(403); // not exempt from the step-up
    expect((await call("POST", capPath, aal1, { capUsd: 5 })).status).toBe(200); // a lowering to the floor is sign-in only
    expect(flux.caps.at(-1)).toMatchObject({ capMicrocents: 5_000_000 });
    expect(await homeRow()).toMatchObject({ cap_microcents: 5_000_000 });
    expect(() => readFluxConfig({ FLUX_B4_CONFIG: JSON.stringify({ ...DEFAULT_FLUX_CONFIG, minCapUsd: 1 }) })).toThrow();
  });
  it("status words while spending is off: it is off, how to turn it on, no router words; the raw router state never reaches the answer", async () => {
    const owner = await start();
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    await call("POST", capPath, owner.token, { enabled: false });
    flux.statusFor = { ...flux.statusFor, state: "revoked", capMicrocents: 0 };
    const status = await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<{ message: string; flux: string; paused: boolean; spendingOff: { confirmed: boolean } }>();
    expect(status).toMatchObject({ paused: true, flux: "paused", spendingOff: { confirmed: true } });
    expect(status.message).toContain("Spending is switched off");
    expect(status.message).toContain("To turn it on");
    customerWords(status.message);
    flux.statusFor = { ...flux.statusFor, state: "unfunded", capMicrocents: 30_000_000 };
    await env.DB.prepare("UPDATE flux_home_keys SET spending_off=0,state='active' WHERE home_id=?").bind(HOME).run();
    const unfunded = await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<{ message: string; flux: string }>();
    expect(unfunded.flux).toBe("unfunded");
    expect(unfunded.message).toBe("Your credits are used up or not added yet. Add credits to keep going. Your Claude and ChatGPT sign-ins keep working.");
    flux.statusFor = { ...flux.statusFor, state: "ip_refused" };
    const other = await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<{ message: string; flux: string }>();
    expect(other.flux).toBe("paused");
    expect(other.message).not.toContain("ip_refused");
    customerWords(other.message);
  });
  it("a spending-off mint refusal carries the same plain words", async () => {
    const owner = await start();
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    await call("POST", capPath, owner.token, { enabled: false });
    const refused = await pollerKey();
    expect(refused.status).toBe(409);
    const body = await refused.json<{ error: string; message: string }>();
    expect(body.error).toBe("home_not_active"); // the poller's refusal for a stopped home, carrying the spending-off words
    expect(body.message).toContain("Spending is switched off");
    customerWords(body.message);
  });
  it("the redirect link flow is retired: /link/start is 404 and writes no challenge", async () => {
    const owner = await signIn("owner2@example.test");
    const response = await call("POST", "/v1/flux/link/start", owner.token);
    expect(response.status).toBe(404);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_link_challenges").first<{ n: number }>())!.n).toBe(0);
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
    // Paid with no credit and no retry left: ONE page-tier alert for the grant, never a second.
    const exhausted = () => env.DB.prepare("SELECT id,home_id,severity,resolved_at FROM cloud_alerts WHERE kind='credit.grant_exhausted'").all().then((r) => r.results);
    expect(await exhausted()).toEqual([{ id: "alert:grant_exhausted:inv:in_dead_001", home_id: HOME, severity: "high", resolved_at: null }]);
    expect(alertTier("credit.grant_exhausted")).toMatchObject({ tier: "page", group: "credit.undelivered" });
    clock += 11 * 60_000;
    await sweep();
    expect(await exhausted()).toHaveLength(1);
    // Only the 20th failure alerts: the 19th try of another grant raises nothing.
    await env.DB.prepare("INSERT INTO flux_grants (grant_id,entitlement_key,home_id,plan,amount_microcents,period_start,period_end,expires_at,attempts,created_at) VALUES ('inv:in_early_01','k-early',?,?,?,?,?,?,17,?)")
      .bind(HOME, "pro", 20_000_000, PERIOD_START, PERIOD_END, addDays(PERIOD_END, 30), clock).run();
    await sweep();
    expect(await env.DB.prepare("SELECT status,attempts FROM flux_grants WHERE grant_id='inv:in_early_01'").first()).toEqual({ status: "pending", attempts: 18 });
    expect(await exhausted()).toHaveLength(1);
  });

  it("a billing stop cannot be undone by the owner; only a NEW later paid invoice lifts it", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await pollerKey();
    await admin("/v1/internal/flux/grant", grantBody("starter", "in_before_1"));
    expect((await admin("/v1/internal/flux/stop", { homeId: HOME, reason: "cancelled" })).status).toBe(200);
    expect(flux.stops).toEqual([HOME]);
    expect((await homeRow())?.state).toBe("stopped");
    expect(await homeRow()).toMatchObject({ billing_hold: 1, billing_hold_at: clock });
    const blocked = await pollerKey();
    expect(blocked.status).toBe(409);
    expect((await blocked.json<{ error: string }>()).error).toBe("billing_hold");
    // An old invoice replayed, and an old period arriving as a new invoice: both leave the hold alone.
    const replayed = await admin("/v1/internal/flux/grant", grantBody("starter", "in_before_1"));
    expect(replayed.status).toBe(200);
    expect(await homeRow()).toMatchObject({ billing_hold: 1 });
    const stale = await admin("/v1/internal/flux/grant", grantBody("starter", "in_stale_01", -40));
    expect(await stale.json()).toMatchObject({ status: "held_by_billing_hold", amountUsd: 0 });
    expect(await homeRow()).toMatchObject({ billing_hold: 1 });
    expect((await pollerKey()).status).toBe(409);
    // A new paid invoice for a period that starts after the hold.
    clock += 2 * DAY;
    const fresh = await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_after_01", periodStart: clock - DAY, periodEnd: clock + 30 * DAY });
    expect(await fresh.json()).toMatchObject({ status: "done", amountUsd: 10 });
    expect(await homeRow()).toMatchObject({ billing_hold: 0 });
    expect((await resumeAndKey(owner.token)).status).toBe(200);
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
      expect((await resumeAndKey(owner.token)).status).toBe(200);
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
    await pollerKey();
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
    await pollerKey();
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
    await pollerKey();
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
    await pollerKey();
    expect(await (await admin("/v1/internal/flux/plan", { homeId: HOME, plan: "pro" })).json()).toEqual({ plan: "pro", capUsd: 60 });
    expect(flux.caps.at(-1)).toEqual({ homeId: HOME, capMicrocents: 60_000_000, capVersion: 2 });
    await call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, { capUsd: 45 });
    flux.caps.length = 0;
    expect(await (await admin("/v1/internal/flux/plan", { homeId: HOME, plan: "max" })).json()).toEqual({ plan: "max", capUsd: 45 });
    expect(flux.caps).toHaveLength(0);
    expect((await admin("/v1/internal/flux/plan", { homeId: HOME, plan: "nope" })).status).toBe(400);
    expect(await changePlan(testEnv(), { homeId: HOME, plan: "starter" }, { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock })).toEqual({ plan: "starter", capUsd: 45 });
    expect(await stopForBilling(testEnv(), HOME, { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock })).toEqual({ state: "stopped", opId: expect.any(String) });
  });

  it("CH1 P2: stopForBilling returns its own op id; queued behind another holder it stays pending, and the router's real stale_lifecycle answer supersedes it; the refund reconcile reads that terminal state and stamps the marker", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await pollerKey();
    const d = { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock };
    await env.DB.prepare("UPDATE flux_home_keys SET op_holder='other-worker',op_lease_until=? WHERE home_id=?").bind(clock + 60_000, HOME).run();
    const queued = await stopForBilling(testEnv(), HOME, d, { invoiceId: "in_p2_queue", keepGrants: true });
    expect(queued.state).toBe("stopping");
    const op = () => env.DB.prepare("SELECT state FROM flux_home_ops WHERE op_id=?").bind(queued.opId).first<{ state: string }>();
    expect(await op()).toEqual({ state: "queued" });
    await env.DB.prepare(`INSERT INTO refund_ops (id,kind,home_id,user_id,end_plan,done_at,flux_stop_op_id,created_at,updated_at) VALUES ('rf-p2','withdrawal',?,'u-p2',1,?,?,?,?)`)
      .bind(HOME, clock, queued.opId, clock, clock).run();
    const marker = () => env.DB.prepare("SELECT credits_revoked_at AS at FROM refund_ops WHERE id='rf-p2'").first<{ at: number | null }>();
    await reconcileQueuedStops(testEnv(), { deps: {}, now: clock });
    expect((await marker())!.at).toBeNull();                      // still pending: untouched
    flux.lifecycleFloor = 1_000_000;                              // a later resume owns the home: the router now answers stale_lifecycle to the Stop
    await env.DB.prepare("UPDATE flux_home_keys SET op_holder=NULL,op_lease_until=NULL WHERE home_id=?").bind(HOME).run();
    clock += BACKOFF;
    await sweepFlux(testEnv(), d);
    expect(await op()).toEqual({ state: "superseded" });
    await reconcileQueuedStops(testEnv(), { deps: {}, now: clock });
    expect((await marker())!.at).toBe(clock);
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
    // A delivered key: generation 1, acked (8b fix r1, Astra H1: an unacked adopted generation keeps renewal due).
    const put = (state: string, hold: number, expires: number | null, acked: number | null = 1) =>
      env.DB.prepare(
        "INSERT OR REPLACE INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,billing_hold,key_expires_at,updated_at,acked_generation) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).bind("home-renew", "starter", 1, state, 30_000_000, 0, hold, expires, now, acked).run();
    await put("active", 0, now + RENEWAL_WINDOW_MS - 1000);
    expect(await fluxRenewalDue(env, "home-renew", now)).toBe(true);
    await put("active", 0, now + 30 * 86_400_000, null);
    expect(await fluxRenewalDue(env, "home-renew", now)).toBe(true); // adopted, never acked
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
  /** The compensate ops, as {generation, state}: 'queued' is what the old table called due/armed. */
  const compRows = () => env.DB.prepare(`SELECT json_extract(payload,'$.generation') AS generation,state FROM flux_home_ops
    WHERE kind='compensate' ORDER BY seq`).all<{ generation: number; state: string }>();

  it("hole 5: a mint cannot return 200 with zero link rows when unlink completes between the link read and the claim", async () => {
    const owner = await ready();
    armDb(/UPDATE flux_home_keys SET\s+lifecycle_version/, async () => { await call("DELETE", "/v1/flux/link", owner.token); });
    const response = await pollerKey();
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("sk-flux-home-");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_links").first()).toEqual({ n: 0 });
    expect(flux.keys.size).toBe(0);
    expect((await homeRow())?.state).not.toBe("active");
  });

  it("hole 5: an unlink that lands while the mint is in flight fails the conditional D1 commit and revokes the specific key", async () => {
    const owner = await ready();
    flux.afterMint = async () => { await call("DELETE", "/v1/flux/link", owner.token); };
    const response = await pollerKey();
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("sk-flux-home-");
    expect(flux.keys.size).toBe(0);
    expect(flux.keyRevokes.map((r) => r.generation)).toEqual([flux.mints[0].generation]);
    expect((await homeRow())?.state).not.toBe("active");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_links").first()).toEqual({ n: 0 });
  });

  it("hole 5: unlink fences the link (version up, fenced) BEFORE it stops any home", async () => {
    const owner = await ready();
    await pollerKey();
    let atStop: Record<string, unknown> | null = null;
    flux.onStop = async () => { atStop = await env.DB.prepare("SELECT link_version,fenced FROM flux_links").first(); };
    await call("DELETE", "/v1/flux/link", owner.token);
    expect(atStop).toEqual({ link_version: 2, fenced: 1 });
    expect(flux.stopLinkVersions).toEqual([2]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_links").first()).toEqual({ n: 0 });
  });

  it("hole 5: an unfinished unlink leaves its home stopping, which issues no key, and the retry finishes it", async () => {
    const owner = await ready();
    await pollerKey();
    flux.stopDown = true;
    expect((await call("DELETE", "/v1/flux/link", owner.token)).status).toBe(502);
    expect(await env.DB.prepare("SELECT fenced FROM flux_links").first()).toEqual({ fenced: 1 });
    flux.stopDown = false;
    const mints = flux.mintCalls;
    const refused = await pollerKey();
    expect(refused.status).toBe(409);
    expect((await refused.json<{ error: string }>()).error).toBe("home_not_active"); // the home is stopping: refused before the link check
    expect(flux.mintCalls).toBe(mints);
    expect((await call("DELETE", "/v1/flux/link", owner.token)).status).toBe(200); // the retry finishes it
  });

  it("hole 5 (8b fix r2, Astra Low): a fenced link on a mint-eligible home is refused flux_not_linked before any claim, zero mint calls", async () => {
    const owner = await ready();
    await pollerKey();
    // The unlink's own fence statement, alone: the home stays active and keyed, so the poller's mint reaches the link check.
    await env.DB.prepare("UPDATE flux_links SET link_version=link_version+1,fenced=1 WHERE owner_user_id=?").bind(owner.userId).run();
    expect(await homeRow()).toMatchObject({ state: "active", billing_hold: 0, spending_off: 0 });
    const mints = flux.mintCalls;
    let claimed = false;
    armDb(/INSERT OR IGNORE INTO flux_mint_ops/, async () => { claimed = true; });
    const refused = await pollerMint();
    expect(refused.status).toBe(409);
    expect((await refused.json<{ error: string }>()).error).toBe("flux_not_linked");
    expect(flux.mintCalls).toBe(mints);
    expect(claimed).toBe(false); // refused at the fence itself, not later by the claim's own link guard
    expect(await homeRow()).toMatchObject({ state: "active" });
  });

  it("hole 5: compensation revokes the SPECIFIC minted key with a durable retry, and never a later resume", async () => {
    const owner = await ready();
    flux.keyRevokeDown = true;
    flux.afterMint = async () => { await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {}); };
    const raced = await pollerKey();
    expect(raced.status).toBe(409);
    expect(await raced.text()).not.toContain("sk-flux-home-");
    expect((await compRows()).results).toEqual([{ generation: 1, state: "queued" }]);
    // Round 4: a resume never runs ahead of a queued op that is failing: it is told so (502) and the
    // compensation stays queued.
    await spendingOn(owner.token);
    const blocked = await pollerKey();
    expect(blocked.status).toBe(502);
    expect(flux.mints).toHaveLength(1);
    // The poller resumes (generation 2) once the router answers: the compensation of 1 runs first.
    flux.keyRevokeDown = false;
    const resumed = await pollerKey();
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
    await pollerKey();
    expect((await compRows()).results).toEqual([]);
    flux.mintError = null;
    flux.down = true;
    await pollerKey();
    flux.down = false;
    expect((await compRows()).results).toHaveLength(1);
    expect((await compRows()).results[0].state).toBe("queued");
    // The next try uses a generation above the one that may have been published (and is now tombstoned).
    const ok = await pollerKey();
    expect((await ok.json<{ generation: number }>()).generation).toBeGreaterThan(1 + 0);
    await sweep();
    expect(flux.tombstonedKeys.size).toBeGreaterThan(0);
    expect([...flux.keys]).toEqual([flux.mints.at(-1)!.generation]);
  });

  it("hole 5: resume advances the lifecycle version, so a delayed Stop retry cannot revoke it", async () => {
    const owner = await ready();
    await pollerKey();
    expect(flux.mints[0].lifecycleVersion).toBe(1);
    // The Stop cannot reach the router; a resume is refused while that Stop is unfinished (round 4: a
    // mint never runs ahead of a failing queued op), then lands right after the Stop, above it.
    flux.stopDown = true;
    expect((await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {})).status).toBe(502);
    await spendingOn(owner.token);
    expect((await pollerKey()).status).toBe(429); // 8b: the poller's resume mint waits for the failing Stop (renewal_retry_later)
    flux.stopDown = false;
    expect((await pollerKey()).status).toBe(200);
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
    await pollerKey();
    const first = flux.mints[0];
    await call("DELETE", "/v1/flux/link", owner.token);
    expect(flux.linkFloor).toBe(2);
    await link(owner.token, "99999999-2222-3333-4444-555555555555");
    const again = await resumeAndKey(owner.token);
    expect(again.status).toBe(200);
    const second = flux.mints[1];
    expect(second.accountId).toBe("99999999-2222-3333-4444-555555555555");
    expect(second.linkVersion).toBe(3);
    expect(second.linkId).not.toBe(first.linkId);
    expect(second.lifecycleVersion).toBeGreaterThan(first.lifecycleVersion);
  });

  it("round 2 wire: a mint carries the link, lifecycle, cap and billing versions; a cap change bumps the cap version", async () => {
    const owner = await ready();
    await pollerKey();
    expect(flux.mints[0]).toMatchObject({ linkVersion: 1, lifecycleVersion: 1, capVersion: 1, billingState: "ok" });
    expect(flux.mints[0].linkId).toBe(FLUX_ACCOUNT);
    await call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, { capUsd: 40 });
    expect(flux.caps).toEqual([{ homeId: HOME, capMicrocents: 40_000_000, capVersion: 2 }]);
    await pollerKey();
    expect(flux.mints[1].capVersion).toBe(3);
    expect(flux.mints[1].capMicrocents).toBe(40_000_000);
  });

  it("hole 12: CP never refuses a prepaid-only account (no billing identity); the identity is kept locally and never sent on the mint", async () => {
    const owner = await ready();
    expect((await pollerKey()).status).toBe(200);
    await admin("/v1/internal/flux/plan", { homeId: HOME, plan: "pro", billingCustomerId: "cus_abc123" });
    expect((await pollerKey()).status).toBe(200);
    const row = await env.DB.prepare("SELECT billing_customer_id AS b FROM flux_home_keys WHERE home_id=?").bind(HOME).first<{ b: string }>();
    expect(row?.b).toBe("cus_abc123");
  });

  it("status: every router refusal state is paused; only ok is not, and an unreachable router is paused", async () => {
    const owner = await ready();
    await pollerKey();
    for (const state of ["capped", "stopped", "revoked", "ip_refused", "unavailable", "invalid", "unfunded", "fenced", "state_lost"]) {
      flux.statusFor = { ...flux.statusFor, state };
      const body = await (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<{ paused: boolean; message: string | null; flux: string }>();
      expect(body, state).toMatchObject({ paused: true, flux: state === "capped" || state === "unfunded" ? state : "paused" }); // the router's own words never reach the answer
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
    } as never);
    expect(sent()).toMatchObject({ link_id: "abc", link_version: 2, lifecycle_version: 4, cap_version: 5, billing_state: "ok" });
    expect(Object.keys(sent())).not.toContain("billing_customer_id");
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
  const stopReq = (token: string) => call("POST", `/v1/homes/${HOME}/flux/stop`, token, {});
  const errorOf = async (response: Response) => (await response.json<{ error: string }>()).error;
  const ops = () => env.DB.prepare("SELECT kind,state FROM flux_home_ops ORDER BY seq").all<{ kind: string; state: string }>();

  it("F2: a billing Stop interrupted right after its batch is finished by the sweep: router Stop with the bumped version, state stopped, reversals sent", async () => {
    const owner = await ready();
    await pollerKey();
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
    await pollerKey();
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
    const minted = await pollerKey();
    expect(minted.status).toBe(200);
    expect(flux.mints[0].capMicrocents).toBe(30_000_000); // the mint published the old cap
    expect(flux.routerCap).toBe(5_000_000); // and the queued cap op republished the new one
    expect(flux.routerCapVersion).toBe((await homeRow())?.cap_version);
    expect((await minted.json<{ capUsd: number }>()).capUsd).toBe(5);
    expect(flux.overlapped).toBe(false);
  });

  it("F4: a cap change that cannot reach the router is kept and retried, never undone", async () => {
    const owner = await ready();
    await pollerKey();
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
    // Spending back ON (8b) lands while the compensation is at the router; the poller's resume mint asks then.
    flux.onKeyRevoke = async () => {
      await spendingOn(owner.token);
      await env.DB.prepare("DELETE FROM flux_mint_ops").run(); // the poll that asks now is its own request, not a replay of the one in flight
      during = await pollerKey();
    };
    const raced = await pollerKey();
    expect(raced.status).toBe(409);
    expect(during).not.toBeNull();
    expect(during!.status).toBe(409);
    expect(await errorOf(during!)).toBe("home_busy");
    expect(flux.overlapped).toBe(false);
    expect(flux.keyRevokes.map((r) => r.generation)).toEqual([1]);
    // Retried after the home is free, the resume lands on a higher generation and is not revoked.
    const resumed = await pollerKey();
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
    await pollerKey();
    let resumeDuring: Response | null = null;
    // 8b: the owner's mint route is closed, so a resume asked for while the Stop is at the router is refused outright (410) and writes nothing.
    flux.onStop = async () => { resumeDuring = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {}); };
    const stop = await stopReq(owner.token);
    expect(stop.status).toBe(200);
    expect(resumeDuring!.status).toBe(410);
    expect(await errorOf(resumeDuring!)).toBe("owner_mint_retired");
    expect(flux.overlapped).toBe(false);
    expect(flux.stopVersions).toEqual([2]);
    expect(await homeRow()).toMatchObject({ state: "stopped" });
    const resumed = await resumeAndKey(owner.token);
    expect(resumed.status).toBe(200);
    expect(flux.keys.has(flux.mints.at(-1)!.generation)).toBe(true);
    await sweep();
    expect(flux.stopVersions).toEqual([2]); // the earlier Stop is never replayed over the resume
    expect(flux.keys.has(flux.mints.at(-1)!.generation)).toBe(true);
    expect(await homeRow()).toMatchObject({ state: "active" });
  });

  it("F7: a Stop that arrives while a resume is minting queues behind it and runs right after (resume then Stop, in order)", async () => {
    const owner = await ready();
    await pollerKey();
    flux.afterMint = async () => { expect((await stopReq(owner.token)).status).toBe(202); };
    const raced = await pollerKey();
    expect(raced.status).toBe(409); // the Stop wins; the resumed key is compensated, never returned
    expect(flux.overlapped).toBe(false);
    expect(flux.keys.size).toBe(0);
    expect(await homeRow()).toMatchObject({ state: "stopped" });
  });

  it("a crashed lease holder: an expired lease is taken over by the sweep; an unexpired one is left alone", async () => {
    const owner = await ready();
    await pollerKey();
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
    flux.statusFor = { state: "none" }; // 8b: a stopped home whose key the router reports live gets a repair Stop; these tests count the Stops they send
    const owner = await ready();
    await pollerKey();
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
    await pollerKey();
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
    const minted = await pollerKey();
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
    const retried = await pollerKey();
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
    const minted = await pollerKey();
    expect(minted.status).toBe(200);
    capWhenReturned = flux.routerCap;
    expect(pushedBeforeCommit).toBe(true);
    expect(capWhenReturned).toBe(7_000_000);
    expect((await minted.json<{ capUsd: number }>()).capUsd).toBe(7);
    expect(flux.overlapped).toBe(false);
  });

  it("#3: fifty failing homes cannot starve another home's billing Stop; retries back off and each sweep is bounded", async () => {
    const owner = await ready();
    expect((await pollerKey()).status).toBe(200);
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
    expect((await pollerKey()).status).toBe(200);
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
    flux.statusFor = { state: "none" }; // 8b: a stopped home whose key the router reports live gets a repair Stop; these tests count the Stops they send
    const owner = await ready();
    expect((await pollerKey()).status).toBe(200);
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
    flux.statusFor = { state: "none" }; // 8b: a stopped home whose key the router reports live gets a repair Stop; these tests count the Stops they send
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
    expect((await pollerKey()).status).toBe(200); // generation 1
    flux.stopDown = true;
    expect((await call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {})).status).toBe(502); // Stop queued
    flux.stopDown = false;
    await spendingOn(owner.token); // 8b: spending back ON; the poller's resume mint drains the older Stop first
    let b: Response | null = null;
    // A resumes and drains the older Stop; while that Stop is at the router A's lease expires and B
    // takes over, finishes the Stop and resumes successfully.
    flux.onStop = async () => {
      clock += 3 * 60_000;
      await env.DB.prepare("DELETE FROM flux_mint_ops").run(); // B's poll is its own request, not a replay of A's
      b = await pollerKey();
    };
    const a = await pollerKey();
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
    expect((await pollerKey()).status).toBe(200);
    // Take the lease away (another worker) between acquisition and the claim.
    armDb(/UPDATE flux_home_keys SET lifecycle_version = lifecycle_version/, async () => {
      await env.DB.prepare("UPDATE flux_home_keys SET op_holder='other-worker',op_lease_until=? WHERE home_id=?").bind(clock + LEASE, HOME).run();
    });
    const refused = await pollerKey();
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toBe("home_busy");
    expect(flux.mints).toHaveLength(1);
  });

  it("#5: a fenced link whose Stops all completed is finalized by the sweep (crash between the last Stop and the finalize)", async () => {
    const owner = await ready();
    expect((await pollerKey()).status).toBe(200);
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
    expect((await pollerKey()).status).toBe(200);
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

// The FIRST Flux key, taken by the home's own poller with the existing wire (renewal-due, subkey, ack): a brand-new paid home must answer
// with Fuigo without the customer signing in. Worker only: nothing here changes the poller or the wire.
describe("first Flux key by the poller (a brand-new paid home)", () => {
  const ip = { "CF-Connecting-IP": HOME_IP };
  const m = (route: string, body: unknown, id = HOME) => call("POST", `/v1/machines/${id}/flux/${route}`, MACHINE_TOKEN, body, ip);
  const due = async () => (await m("renewal-due", { generation: 1 })).json<{ due: boolean; op_id?: string }>();
  const retryRow = () => env.DB.prepare("SELECT failures,next_at FROM flux_first_key_retry WHERE home_id=?").bind(HOME).first<{ failures: number; next_at: number }>();
  const alerts = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts").first<{ n: number }>())!.n;
  let ensured: number;
  /** A fresh paid home: owned, ready, subscription active, NO link and NO Flux row (the owner has never signed in to Flux). */
  const fresh = async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    await env.DB.prepare("UPDATE cloud_machines SET credential_hash=? WHERE id=?").bind(await sha256(MACHINE_TOKEN), HOME).run();
    await env.DB.prepare("UPDATE cloud_homes SET entitlement='paid' WHERE id=?").bind(HOME).run();
    await env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at)
      VALUES (?,'cus_1','sub_1','starter','active',?,?)`).bind(HOME, clock, clock).run();
    // The owner proved the inbox (ITEM4-PROOF-CURRENT: Flux is called only on a TRUE stamp for the current address).
    await env.DB.prepare("UPDATE supabase_identities SET contact_email=?, email_verified_at=1, email_verified_for=lower(?) WHERE user_id=?").bind(owner.email, owner.email, owner.userId).run();
    ensured = 0;
    (flux as unknown as { ensureAccount: unknown }).ensureAccount = async () => { ensured += 1; return { fluxAccountId: FLUX_ACCOUNT, created: true }; };
    return owner;
  };
  const keyRow = (state: string, extraSql = "") => env.DB.prepare(`INSERT OR REPLACE INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,updated_at${extraSql ? "," + extraSql.split("=")[0] : ""})
    VALUES (?,'starter',0,?,30000000,0,?${extraSql ? "," + extraSql.split("=")[1] : ""})`).bind(HOME, state, clock).run();

  it("a fresh paid home is cued, ensures the owner's account, mints with the owner's cap, acks, and is then an ordinary active row", async () => {
    await fresh();
    expect(await due()).toEqual({ due: true, op_id: `renew:${HOME}:1:0` });
    const minted = await m("subkey", { generation: 1, op_id: `renew:${HOME}:1:0` });
    expect(minted.status).toBe(200);
    const body = await minted.json<{ key: string; generation: number; capUsd: number }>();
    expect([body.generation, body.capUsd, ensured]).toEqual([1, 30, 1]);
    expect(flux.mints).toEqual([expect.objectContaining({ homeId: HOME, generation: 1, capMicrocents: 30_000_000, ownerResume: false, lifecycleVersion: 1,
      opId: `renew:${HOME}:1:0`, accountId: FLUX_ACCOUNT, linkVersion: 1, billingState: "ok" })]);
    expect(await homeRow()).toMatchObject({ state: "active", generation: 1, key_expires_at: null, pending_op_id: `renew:${HOME}:1:0` });
    // Undelivered: cued again only after the bound (60 s), with the next identity.
    expect(await retryRow()).toEqual({ failures: 1, next_at: clock + 60_000 });
    expect(await due()).toEqual({ due: false });
    clock += 60_000;
    expect(await due()).toEqual({ due: true, op_id: `renew:${HOME}:1:1` });
    expect(await (await m("subkey/ack", { generation: 1, op_id: `renew:${HOME}:1:0`, key_generation: 1 })).json()).toEqual({ acked: true });
    expect((await homeRow())!.key_expires_at).not.toBeNull();
    expect(await due()).toEqual({ due: false });
    expect(await retryRow()).toBeNull();
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock + DAY, HOME).run();
    expect(await due()).toEqual({ due: true, op_id: `renew:${HOME}:1:1` });
  });

  it("a warm-pool server (no home row) and an ownerless or unpaid home are never cued and never minted for, with no ensure call", async () => {
    await fresh();
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO cloud_machines (id,home_id,generation,state,credential_hash,bound_ips,created_at,public_origin,admin_url)
      VALUES ('pool-1','pool-1',1,'active',?,?,?,'https://p.murage.test','https://a.murage.test')`).bind(await sha256(MACHINE_TOKEN), JSON.stringify([HOME_IP]), now).run();
    expect(await (await m("renewal-due", { generation: 1 }, "pool-1")).json()).toEqual({ due: false });
    expect((await m("subkey", { generation: 1 }, "pool-1")).status).toBe(404);
    for (const sql of [
      "UPDATE cloud_homes SET owner_id='' WHERE id='home-flux'",
      "UPDATE cloud_homes SET entitlement='pending' WHERE id='home-flux'",
      "UPDATE cloud_homes SET entitlement='refund_pending' WHERE id='home-flux'",
      "UPDATE cloud_homes SET desired_state='suspended' WHERE id='home-flux'",
      "UPDATE cloud_homes SET desired_state='provisioning' WHERE id='home-flux'",
      "UPDATE billing_subscriptions SET status='canceled' WHERE home_id='home-flux'",
      "UPDATE billing_subscriptions SET status='past_due' WHERE home_id='home-flux'",
      "UPDATE billing_subscriptions SET subscription_id=NULL WHERE home_id='home-flux'",
    ]) {
      await env.DB.batch([env.DB.prepare("UPDATE cloud_homes SET owner_id=(SELECT user_id FROM supabase_identities LIMIT 1),entitlement='paid',desired_state='ready' WHERE id=?").bind(HOME),
        env.DB.prepare("UPDATE billing_subscriptions SET status='active',subscription_id='sub_1' WHERE home_id=?").bind(HOME), env.DB.prepare(sql)]);
      expect([sql, await due()]).toEqual([sql, { due: false }]);
      expect([sql, (await m("subkey", { generation: 1 })).status]).toEqual([sql, 409]);
    }
    expect([flux.mints.length, ensured, await homeRow()]).toEqual([0, 0, null]);
  });

  it("a billing hold, spending off, stopped and stopping are refused at the cue and at the mint, and nothing is minted or ensured", async () => {
    await fresh();
    for (const [label, state, extraSql] of [["hold", "none", "billing_hold=1"], ["spending off", "none", "spending_off=1"], ["stopped", "stopped", ""], ["stopping", "stopping", ""]] as const) {
      await keyRow(state, extraSql);
      expect([label, await due()]).toEqual([label, { due: false }]);
      const refused = await m("subkey", { generation: 1 });
      expect([label, refused.status]).toEqual([label, 409]);
      expect([label, (await refused.json<{ error: string }>()).error]).toEqual([label, label === "hold" ? "billing_hold" : label === "spending off" ? "spending_off" : "home_not_active"]);
    }
    expect([flux.mints.length, ensured, await retryRow()]).toEqual([0, 0, null]);
  });

  it("a replayed operation is refused, a foreign op_id is refused, and a key already taken is not a first key again", async () => {
    await fresh();
    await env.DB.prepare("INSERT INTO flux_mint_ops (op_id,home_id,created_at) VALUES (?,?,?)").bind(`renew:${HOME}:1:0`, HOME, clock).run();
    expect((await (await m("subkey", { generation: 1, op_id: `renew:${HOME}:1:0` })).json<{ error: string }>()).error).toBe("renewal_replayed");
    await env.DB.prepare("DELETE FROM flux_mint_ops").run();
    expect((await (await m("subkey", { generation: 1, op_id: `renew:${HOME}:1:7` })).json<{ error: string }>()).error).toBe("renewal_op_mismatch");
    expect(flux.mints).toHaveLength(0);
    expect((await m("subkey", { generation: 1, op_id: `renew:${HOME}:1:0` })).status).toBe(200);
    // fix r1 (Astra H1): an unacked key keeps renewal due, so the home acks it first.
    expect((await m("subkey/ack", { generation: 1, op_id: `renew:${HOME}:1:0`, key_generation: 1 })).status).toBe(200);
    // Active now: a second first-key style request is an ordinary renewal and is refused while the key is fresh.
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock + 30 * DAY, HOME).run();
    expect((await (await m("subkey", { generation: 1 })).json<{ error: string }>()).error).toBe("renewal_not_due");
    expect(flux.mints).toHaveLength(1);
  });

  it("a failed mint is retried under the same identity, only after the bound, and the key lands", async () => {
    await fresh();
    const opId = `renew:${HOME}:1:0`;
    flux.mintError = new FluxError(503, "down");
    expect((await m("subkey", { generation: 1, op_id: opId })).status).toBe(502);
    expect(await retryRow()).toEqual({ failures: 1, next_at: clock + 60_000 });
    expect(await due()).toEqual({ due: false });
    const early = await m("subkey", { generation: 1, op_id: opId });
    expect([early.status, (await early.json<{ error: string }>()).error]).toEqual([429, "first_key_retry_later"]);
    clock += 60_000;
    expect(await due()).toEqual({ due: true, op_id: opId });
    flux.mintError = null;
    expect((await m("subkey", { generation: 1, op_id: opId })).status).toBe(200);
    expect(flux.mints.map((x) => x.opId)).toEqual([opId]);
    expect(await retryRow()).not.toBeNull(); // landed but not acked yet: still bounded
    expect(await homeRow()).toMatchObject({ state: "active" });
    expect((await m("subkey/ack", { generation: 1, op_id: opId, key_generation: flux.mints[0].generation })).status).toBe(200);
    expect(await retryRow()).toBeNull();
  });

  it("a persistently failing first key is asked of Flux about 9 times an hour, not 60, and raises no alert", async () => {
    await fresh();
    let calls = 0;
    const real = flux.mint.bind(flux);
    flux.mint = (input: FluxMint) => { calls += 1; return real(input); };
    flux.mintError = new FluxError(503, "down");
    for (let minute = 0; minute < 60; minute++) {
      const ask = await due();
      if (ask.due) await m("subkey", { generation: 1, op_id: ask.op_id });
      clock += 60_000;
    }
    expect(calls).toBe(9); // minutes 0, 1, 3, 7, 15, 25, 35, 45, 55
    expect((await retryRow())!.failures).toBe(9);
    expect(await alerts()).toBe(0);
    expect([1, 2, 3, 4, 5, 6].map(firstKeyRetryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  });

  it("ITEM4-PROOF-CURRENT first key: an UNPROVEN owner is a local hold with NO ensure call: 409 uncounted, failures 0, next_at = +15 min, no link, no page", async () => {
    const owner = await fresh();
    await env.DB.prepare("UPDATE supabase_identities SET email_verified_at=NULL, email_verified_for=NULL WHERE user_id=?").bind(owner.userId).run();
    const r = await m("subkey", { generation: 1 });
    expect([r.status, (await r.json<{ error: string }>()).error]).toEqual([409, "flux_email_unverified"]);
    expect(ensured).toBe(0);
    const row = () => env.DB.prepare("SELECT failures,next_at,hold FROM flux_first_key_retry WHERE home_id=?").bind(HOME).first();
    expect(await row()).toEqual({ failures: 0, next_at: clock + 15 * 60_000, hold: "email_unverified" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_links").first()).toEqual({ n: 0 });
    expect(await alerts()).toBe(0);
    // An hour of polling every minute: never an ensure call, failures never move, no page.
    for (let i = 0; i < 60; i++) {
      clock += 60_000;
      const ask = await due();
      if (ask.due) expect((await m("subkey", { generation: 1, op_id: ask.op_id })).status).toBe(409);
    }
    expect(ensured).toBe(0);
    expect(await row()).toMatchObject({ failures: 0, hold: "email_unverified" });
    expect(await alerts()).toBe(0);
    expect(flux.mints).toHaveLength(0);
  });

  it("ITEM4-PROOF-CURRENT B4 delivery: an unproven owner's grant stays pending with NO ensure call", async () => {
    const owner = await fresh();
    await env.DB.prepare("UPDATE supabase_identities SET email_verified_at=NULL, email_verified_for=NULL WHERE user_id=?").bind(owner.userId).run();
    const g = await grantMonthlyCredits(testEnv(), { homeId: HOME, plan: "starter", invoiceId: "in_unproven_01", ...period() }, { ...deps });
    expect(g.status).toBe("pending");
    clock += 11 * 60_000;
    await sweepFlux(testEnv(), deps);
    expect(ensured).toBe(0);
    expect(flux.grants).toHaveLength(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_links").first()).toEqual({ n: 0 });
  });

  it("ITEM4-PROOF-CURRENT first key: a 202 to a PROVEN call is a typed hold (409 uncounted, +15 min) and ONE flux.ensure_verified_refused page", async () => {
    const owner = await fresh();
    let sent: Record<string, unknown> | null = null;
    (flux as unknown as { ensureAccount: unknown }).ensureAccount = async (a: Record<string, unknown>) => { ensured += 1; sent = a; throw new FluxEmailUnverified(); };
    const r = await m("subkey", { generation: 1 });
    expect([r.status, (await r.json<{ error: string }>()).error]).toEqual([409, "flux_email_unverified"]);
    expect(sent).toMatchObject({ murageAccountId: owner.userId, emailVerified: true });
    const row = () => env.DB.prepare("SELECT failures,next_at,hold FROM flux_first_key_retry WHERE home_id=?").bind(HOME).first();
    expect(await row()).toEqual({ failures: 0, next_at: clock + 15 * 60_000, hold: "email_unverified" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='flux.ensure_verified_refused' AND subject=?").bind(`account:${owner.userId}`).first()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind LIKE 'flux.ensure_account%' OR kind='credit.email_unverified_hold'").first()).toEqual({ n: 0 });
    // An hour of polling every minute: ensure is asked at most 4 or 5 times, failures never move, one page for the account.
    for (let i = 0; i < 60; i++) {
      clock += 60_000;
      const ask = await due();
      if (ask.due) expect((await m("subkey", { generation: 1, op_id: ask.op_id })).status).toBe(409);
    }
    expect(ensured).toBeLessThanOrEqual(5);
    expect(ensured).toBeGreaterThanOrEqual(4);
    expect(await row()).toMatchObject({ failures: 0, hold: "email_unverified" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='flux.ensure_verified_refused'").first()).toEqual({ n: 1 });
    expect(flux.mints).toHaveLength(0);
    // A real failure on a held row is counted and clears the hold (the wake-up never deletes a real-failure row).
    clock += 15 * 60_000;
    (flux as unknown as { ensureAccount: unknown }).ensureAccount = async () => { ensured += 1; throw new FluxHookRetry("ensure_account_unavailable"); };
    const ask = await due();
    expect((await m("subkey", { generation: 1, op_id: ask.op_id })).status).toBe(502);
    expect(await row()).toMatchObject({ failures: 1, hold: null });
  });

  it("FLUX-ENSURE-EMAIL-VERIFIED first key: any other 202 stays a retry (counted), never the hold", async () => {
    await fresh();
    (flux as unknown as { ensureAccount: unknown }).ensureAccount = async () => { ensured += 1; throw new FluxHookRetry("ensure_account_unavailable"); };
    expect((await m("subkey", { generation: 1 })).status).toBe(502);
    expect(await env.DB.prepare("SELECT failures,hold FROM flux_first_key_retry WHERE home_id=?").bind(HOME).first()).toEqual({ failures: 1, hold: null });
  });

  it("ensure-account: unavailable is bounded and silent; a refusal is ONE alert and no further ensure call while it is open", async () => {
    const owner = await fresh();
    (flux as unknown as { ensureAccount: unknown }).ensureAccount = async () => { ensured += 1; throw new FluxHookRetry("ensure_account_unavailable"); };
    expect((await m("subkey", { generation: 1 })).status).toBe(502);
    expect([ensured, await alerts(), (await retryRow())!.failures]).toEqual([1, 0, 1]);
    (flux as unknown as { ensureAccount: unknown }).ensureAccount = async () => { ensured += 1; throw new FluxEnsureRefused(409); };
    for (let i = 0; i < 12; i++) {
      clock += 600_000;
      const ask = await due();
      if (ask.due) expect((await m("subkey", { generation: 1, op_id: ask.op_id })).status).toBe(409);
    }
    expect(ensured).toBe(2); // the refusal was asked once; the open alert blocks every later call
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='flux.ensure_account_refused' AND subject=?").bind(`ensure:${owner.userId}`).first()).toEqual({ n: 1 });
    expect(flux.mints).toHaveLength(0);
  });

  it("dark with the Flux route switch off: the cue question and the mint are 404 for a fresh paid home, nothing is read or written", async () => {
    await fresh();
    extra = { CLOUD_FLUX_ROUTES_ENABLED: undefined };
    const before = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM flux_home_keys)+(SELECT COUNT(*) FROM flux_first_key_retry)+(SELECT COUNT(*) FROM flux_mint_ops)+(SELECT COUNT(*) FROM flux_links) AS n").first();
    for (const route of ["renewal-due", "subkey", "subkey/ack"]) {
      const r = await m(route, { generation: 1, op_id: "renew:x:1:0" });
      expect([route, r.status, await r.json()]).toEqual([route, 404, { error: "not_found" }]);
    }
    expect(await env.DB.prepare("SELECT (SELECT COUNT(*) FROM flux_home_keys)+(SELECT COUNT(*) FROM flux_first_key_retry)+(SELECT COUNT(*) FROM flux_mint_ops)+(SELECT COUNT(*) FROM flux_links) AS n").first()).toEqual(before);
    expect([flux.mints.length, ensured]).toEqual([0, 0]);
  });

  it("grant ordering: a plan grant paid before the first key answers 503 unbound, stays pending, and lands after the first key binds", async () => {
    await fresh();
    const real = flux.grant.bind(flux);
    flux.grant = async (input: FluxGrant) => { if (flux.mints.length === 0) throw new FluxError(503, "", "unbound"); return real(input); };
    const g = await grantMonthlyCredits(testEnv(), { homeId: HOME, plan: "starter", invoiceId: "in_first_0001", ...period() }, { ...deps });
    expect(g.status).toBe("pending");
    expect(flux.grants).toHaveLength(0);
    expect((await m("subkey", { generation: 1, op_id: `renew:${HOME}:1:0` })).status).toBe(200);
    expect(flux.mints[0].capMicrocents).toBe(30_000_000); // the cap an owner mint sends for the same plan
    clock += 11 * 60_000;
    await sweepFlux(testEnv(), deps);
    expect(await env.DB.prepare("SELECT status FROM flux_grants WHERE grant_id='inv:in_first_0001'").first()).toEqual({ status: "done" });
    expect(flux.grants.map((x) => x.grantId)).toEqual(["inv:in_first_0001"]);
  });

  // Astra round 2 (first key). The fetch stub flips state INSIDE the mint await; the key must never be returned and must be revoked.
  const flipInMint = (sql: string[]) => { flux.afterMint = async () => { await env.DB.batch(sql.map((q) => env.DB.prepare(q))); }; };
  const deleteHome = ["UPDATE cloud_machines SET generation=generation+1,credential_hash=NULL,state='fenced' WHERE id='home-flux'",
    "UPDATE cloud_homes SET desired_state='deleted',generation=generation+1 WHERE id='home-flux'"];

  it("item 1 race: a payment-failed webhook during the mint refuses the first key, revokes the minted generation and keeps the home never-keyed", async () => {
    await fresh();
    flipInMint(["UPDATE billing_subscriptions SET status='past_due' WHERE home_id='home-flux'"]);
    const refused = await m("subkey", { generation: 1, op_id: `renew:${HOME}:1:0` });
    expect([refused.status, (await refused.json<{ error: string }>()).error]).toEqual([409, "home_not_active"]);
    expect(flux.mints).toHaveLength(1);
    expect(flux.keyRevokes.map((r) => r.generation)).toEqual([1]);
    expect(await homeRow()).toMatchObject({ state: "none", generation: 0 });
    expect(await due()).toEqual({ due: false });
  });

  it("item 1 race: a payment-failed webhook during ensure-account stops the claim before anything is minted", async () => {
    await fresh();
    (flux as unknown as { ensureAccount: unknown }).ensureAccount = async () => {
      await env.DB.prepare("UPDATE billing_subscriptions SET status='past_due' WHERE home_id='home-flux'").run();
      return { fluxAccountId: FLUX_ACCOUNT, created: true };
    };
    const refused = await m("subkey", { generation: 1 });
    expect([refused.status, (await refused.json<{ error: string }>()).error]).toEqual([409, "home_not_active"]);
    expect([flux.mints.length, flux.keyRevokes.length]).toEqual([0, 0]);
  });

  it("item 2 race: a delete that completes during the first mint refuses the key (401), revokes it, and never hands it out", async () => {
    await fresh();
    flipInMint(deleteHome);
    const refused = await m("subkey", { generation: 1, op_id: `renew:${HOME}:1:0` });
    expect(refused.status).toBe(401);
    expect(JSON.stringify(await refused.json())).not.toContain("sk-flux");
    expect(flux.keyRevokes.map((r) => r.generation)).toEqual([1]);
    expect(await homeRow()).toMatchObject({ state: "none", generation: 0 });
  });

  it("item 2 race: the same hole in ORDINARY renewal is closed (a delete during the renewal mint)", async () => {
    await fresh();
    expect((await m("subkey", { generation: 1, op_id: `renew:${HOME}:1:0` })).status).toBe(200);
    expect((await m("subkey/ack", { generation: 1, op_id: `renew:${HOME}:1:0`, key_generation: 1 })).status).toBe(200);
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock + DAY, HOME).run();
    flipInMint(deleteHome);
    const refused = await m("subkey", { generation: 1, op_id: `renew:${HOME}:1:1` });
    expect(refused.status).toBe(401);
    expect(flux.keyRevokes.map((r) => r.generation)).toEqual([2]);
    expect(await homeRow()).toMatchObject({ generation: 1, pending_op_id: null });
  });

  it("item 2: a home already deleted when the request arrives is refused without a mint", async () => {
    await fresh();
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleted' WHERE id=?").bind(HOME).run();
    expect((await m("subkey", { generation: 1 })).status).toBe(404); // the owner lookup already answers nothing for a deleted home
    expect(flux.mints).toHaveLength(0);
  });

  it("item 3: a first key whose ack never comes is re-minted on the 1, 2, 4, 8, then 10 minute bound, at the cue and at the route, and the ack clears it", async () => {
    await fresh();
    const start = clock;
    const mintedAt: number[] = [];
    for (let minute = 0; minute < 40; minute++) {
      clock = start + minute * 60_000;
      const ask = await due();
      if (ask.due) { expect((await m("subkey", { generation: 1, op_id: ask.op_id })).status).toBe(200); mintedAt.push(minute); }
      else {
        // The route holds the same line the cue does.
        const early = await m("subkey", { generation: 1 });
        expect([early.status, (await early.json<{ error: string }>()).error]).toEqual([429, "renewal_retry_later"]);
      }
    }
    expect(mintedAt).toEqual([0, 1, 3, 7, 15, 25, 35]);
    expect(flux.mints).toHaveLength(7);
    const last = flux.mints[6];
    expect((await m("subkey/ack", { generation: 1, op_id: last.opId, key_generation: last.generation })).status).toBe(200);
    expect(await retryRow()).toBeNull();
    expect(await due()).toEqual({ due: false });
  });

  it("item 4: the plan grant goes out right after the first key; a failing grant never fails the key, and the sweep delivers it later", async () => {
    await fresh();
    const real = flux.grant.bind(flux);
    flux.grant = async (input: FluxGrant) => { if (flux.mints.length === 0) throw new FluxError(503, "", "unbound"); return real(input); };
    await grantMonthlyCredits(testEnv(), { homeId: HOME, plan: "starter", invoiceId: "in_first_0004", ...period() }, { ...deps });
    expect(flux.grants).toHaveLength(0);
    expect((await env.DB.prepare("SELECT status FROM flux_grants WHERE grant_id='inv:in_first_0004'").first())).toEqual({ status: "pending" });
    const minted = await m("subkey", { generation: 1, op_id: `renew:${HOME}:1:0` });
    expect(minted.status).toBe(200);
    expect(flux.grants.map((x) => x.grantId)).toEqual(["inv:in_first_0004"]); // no sweep ran
    expect(await env.DB.prepare("SELECT status FROM flux_grants WHERE grant_id='inv:in_first_0004'").first()).toEqual({ status: "done" });
  });

  it("item 4: a grant that throws after the first key leaves the key response a 200 and the grant pending for the sweep", async () => {
    await fresh();
    flux.grant = async () => { throw new Error("boom"); };
    await grantMonthlyCredits(testEnv(), { homeId: HOME, plan: "starter", invoiceId: "in_first_0005", ...period() }, { ...deps });
    const minted = await m("subkey", { generation: 1, op_id: `renew:${HOME}:1:0` });
    expect(minted.status).toBe(200);
    expect((await minted.json<{ key: string }>()).key).toContain("sk-flux");
    expect(await env.DB.prepare("SELECT status FROM flux_grants WHERE grant_id='inv:in_first_0005'").first()).toEqual({ status: "pending" });
    expect(flux.keyRevokes).toHaveLength(0);
  });
});

describe("renewalHeldBack: the ack bound never outlasts a live key (Astra FIRSTKEY-2 P1)", () => {
  const now = 1_000_000_000;
  it("holds a due renewal back while the wait runs, and not after", () => {
    expect(renewalHeldBack(now + 60_000, now + 86_400_000, now)).toBe(true);
    expect(renewalHeldBack(now, now + 86_400_000, now)).toBe(false);
    expect(renewalHeldBack(null, now + 86_400_000, now)).toBe(false);
  });
  it("lets the last 15 minutes of a live key through, and holds an expired or unacked key", () => {
    expect(renewalHeldBack(now + 90_000, now + 120_000, now)).toBe(false);
    expect(renewalHeldBack(now + 90_000, now + 15 * 60_000, now)).toBe(false);
    expect(renewalHeldBack(now + 90_000, now - 1, now)).toBe(true);
    expect(renewalHeldBack(now + 90_000, null, now)).toBe(true);
  });
});

describe("ITEM 9 M2: support's email-proof routes work while Flux is off or a credential is missing (admin credential still required)", () => {
  const ACCT = "user-item9-m2";
  const seed = async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,'n','cloud-item9-m2@cloud-account.invalid',1,0,0)`).bind(ACCT).run();
    await env.DB.prepare("INSERT OR REPLACE INTO supabase_identities (sub,user_id,via,created_at,email_revision,contact_email) VALUES ('sub-item9-m2',?,'created',1,0,'m2@example.test')")
      .bind(ACCT).run();
  };
  const tidy = async () => {
    for (const t of ["flux_email_proof_disputes", "flux_email_proof_audit", "flux_email_proof_events", "flux_email_proof"]) await env.DB.prepare(`DELETE FROM ${t} WHERE account_id=?`).bind(ACCT).run();
    await env.DB.prepare("DELETE FROM cloud_alerts WHERE subject=?").bind(`account:${ACCT}`).run();
    await env.DB.prepare("DELETE FROM supabase_identities WHERE user_id=?").bind(ACCT).run();
    await env.DB.prepare(`DELETE FROM "user" WHERE id=?`).bind(ACCT).run();
  };
  afterEach(async () => { extra = {}; await tidy(); });
  for (const [label, over] of [["Flux off", { CLOUD_FLUX_ROUTES_ENABLED: undefined }], ["grants token missing", { FLUX_CLOUD_GRANTS_TOKEN: undefined }],
    ["service token missing", { FLUX_CLOUD_SERVICE_TOKEN: undefined }]] as const) {
    it(`${label}: dispute and dispute-clear are recorded; resend answers plainly (never a 404); no admin credential is refused`, async () => {
      await seed();
      extra = { ...over };
      const noAuth = await call("POST", "/v1/internal/flux/email-proof/dispute", null, { account_id: ACCT, note: "buyer says not theirs", by: "ops" });
      expect([401, 403]).toContain(noAuth.status);
      const wrong = await call("POST", "/v1/internal/flux/email-proof/dispute", "x".repeat(44), { account_id: ACCT, note: "buyer says not theirs", by: "ops" });
      expect([401, 403]).toContain(wrong.status);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_email_proof_disputes WHERE account_id=?").bind(ACCT).first()).toEqual({ n: 0 });
      const d = await call("POST", "/v1/internal/flux/email-proof/dispute", ADMIN, { account_id: ACCT, note: "buyer says not theirs", by: "ops" });
      expect([d.status, await d.json()]).toEqual([200, { linked: false, disputed: true }]);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_email_proof_disputes WHERE account_id=?").bind(ACCT).first()).toEqual({ n: 1 });
      const r = await call("POST", "/v1/internal/flux/email-proof/resend", ADMIN, { account_id: ACCT, by: "ops" });
      expect(r.status).not.toBe(404);
      expect(r.status).toBeGreaterThanOrEqual(400); // disputed and nothing held: refused plainly
      const c = await call("POST", "/v1/internal/flux/email-proof/dispute-clear", ADMIN, { account_id: ACCT, by: "ops" });
      expect([c.status, await c.json()]).toEqual([200, { cleared: true }]);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_email_proof_disputes WHERE account_id=?").bind(ACCT).first()).toEqual({ n: 0 });
    });
  }
});

describe("DISPUTE-FENCE-ACCOUNT: an open email-proof dispute is authoritative at every Flux commit point, linked or not", () => {
  const DISPUTE = "/v1/internal/flux/email-proof/dispute";
  const CLEAR = "/v1/internal/flux/email-proof/dispute-clear";
  const dispute = (account: string) => admin(DISPUTE, { account_id: account, note: "buyer says not theirs", by: "ops" });
  const clearOf = (account: string, version?: number) => admin(CLEAR, { account_id: account, by: "ops", ...(version === undefined ? {} : { version }) });
  const version = async (account: string) => (await env.DB.prepare("SELECT version,open FROM flux_account_dispute WHERE account_id=?").bind(account)
    .first<{ version: number; open: number }>());
  const err = async (r: Response) => [r.status, (await r.json<{ error?: string }>()).error] as const;
  const capPath = `/v1/homes/${HOME}/flux/cap`;
  const keyRow = (homeId = HOME) => env.DB.prepare("SELECT * FROM flux_home_keys WHERE home_id=?").bind(homeId).first<Record<string, unknown>>();
  const grantOf = (body = { homeId: HOME, plan: "starter", invoiceId: "in_fence_01", ...period() }) => admin("/v1/internal/flux/grant", body);

  it("a dispute on a LINKED account holds it without an unlink: the link, the stamp path and the accounting stay as they are", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    expect(await (await dispute(owner.userId)).json()).toEqual({ linked: true, alerted: true, unlinked: false });
    expect(await version(owner.userId)).toEqual({ version: 1, open: 1 });
    expect(await env.DB.prepare("SELECT fenced,link_id FROM flux_links WHERE owner_user_id=?").bind(owner.userId).first()).toEqual({ fenced: 0, link_id: FLUX_ACCOUNT });
  });

  it("commit point 1, the key claim: a linked, disputed account gets no key; a dispute landing after the early check is caught inside the claim statement", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await dispute(owner.userId);
    expect(await err(await pollerMint())).toEqual([409, "flux_email_unverified"]);
    expect(flux.mints).toHaveLength(0);
    expect((await clearOf(owner.userId)).status).toBe(200);
    // Race: the dispute opens between the early read and the claim UPDATE (the first statement that bumps gen_floor).
    armDb(/gen_floor = MAX\(generation, gen_floor\) \+ 1/, async () => { await dispute(owner.userId); });
    expect((await pollerMint()).status).toBe(409);
    expect(flux.mints).toHaveLength(0);
    expect(await keyRow()).toMatchObject({ generation: 0, state: "none" });
  });

  it("commit point 2, the key commit: a dispute opened while Flux was minting keeps the key out of the home (the generation is compensated)", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    flux.afterMint = async () => { await dispute(owner.userId); };
    const r = await pollerMint();
    expect(r.status).toBe(409);
    expect(await keyRow()).toMatchObject({ generation: 0, state: "none", proof_hold: 1 });
    expect(flux.mints).toHaveLength(1); // the router did publish it: the commit refused, so the generation is revoked, never adopted
    await sweepFlux(testEnv(), { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect(flux.keyRevokes.map((k) => k.generation)).toContain(1);
  });

  it("commit point 3, the credit grant dispatch: nothing is sent while the dispute stands (the grant stays pending); a dispute landing at the claim batch is caught there; after the clear it is delivered", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await dispute(owner.userId);
    const held = await grantOf();
    expect(held.status).toBe(200);
    expect(flux.grants).toHaveLength(0);
    expect(flux.deliveries).toHaveLength(0);
    expect(await env.DB.prepare("SELECT status FROM flux_grants WHERE grant_id='inv:in_fence_01'").first()).toEqual({ status: "pending" });
    expect((await clearOf(owner.userId)).status).toBe(200);
    clock += 6 * 3_600_000;
    await sweepFlux(testEnv(), { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect(flux.grants.map((g) => g.grantId)).toEqual(["inv:in_fence_01"]);
    // The race, on a second grant: the dispute opens just before the claim batch.
    armDb(/INSERT OR IGNORE INTO flux_grant_dispatches/, async () => { await dispute(owner.userId); });
    await grantOf({ homeId: HOME, plan: "starter", invoiceId: "in_fence_02", ...period(40) });
    expect(flux.grants.map((g) => g.grantId)).toEqual(["inv:in_fence_01"]);
    expect(flux.deliveries.map((d) => d.grantId)).not.toContain("inv:in_fence_02");
  });

  it("commit point 4, spending on / a cap raise above 0: refused while disputed (no step-up asked); lowering the limit and switching spending OFF always work", async () => {
    extra = { FLUX_RESUME_VIA_POLLER: "1" }; // 8b: switching spending back on resumes through the poller
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    expect((await pollerMint()).status).toBe(200);
    expect((await call("POST", capPath, owner.token, { capUsd: 80 })).status).toBe(200);
    await dispute(owner.userId);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    // A raise: with the step-up it is refused for the dispute (and no second factor is asked once the dispute is known); sign-in only is
    // stopped earlier by the gate, as for any raise.
    expect(await err(await call("POST", capPath, owner.token, { capUsd: 200 }))).toEqual([409, "flux_email_unverified"]);
    expect(await err(await call("POST", capPath, aal1, { capUsd: 200 }))).toEqual([403, "step_up_required"]);
    expect(await keyRow()).toMatchObject({ cap_microcents: 80_000_000, spending_off: 0 });
    // A lowering that keeps spending on is not a raise.
    expect((await call("POST", capPath, aal1, { capUsd: 50 })).status).toBe(200);
    expect(await keyRow()).toMatchObject({ cap_microcents: 50_000_000, spending_off: 0 });
    // Cap to 0 (spending off) is always allowed.
    expect((await call("POST", capPath, owner.token, { capUsd: 0 })).status).toBe(200);
    expect(await keyRow()).toMatchObject({ spending_off: 1 });
    // Switching it back on is a raise from zero: refused while the dispute stands, allowed after the clear.
    expect(await err(await call("POST", capPath, owner.token, { capUsd: 50 }))).toEqual([409, "flux_email_unverified"]);
    expect(await keyRow()).toMatchObject({ spending_off: 1 });
    expect((await clearOf(owner.userId)).status).toBe(200);
    expect((await call("POST", capPath, owner.token, { capUsd: 50 }, SITE_COMPAT)).status).toBe(200);
    expect(await keyRow()).toMatchObject({ spending_off: 0 });
  });

  it("commit point 4, the race: a dispute landing between the cap read and its write is caught inside the write", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    expect((await pollerMint()).status).toBe(200);
    armDb(/UPDATE flux_home_keys SET plan=\?,cap_microcents=\?,cap_custom=\?/, async () => { await dispute(owner.userId); });
    const r = await call("POST", capPath, owner.token, { capUsd: 200 });
    expect(r.status).toBe(409);
    expect(await keyRow()).toMatchObject({ cap_microcents: 30_000_000 });
  });

  it("8b fix: a raise that reaches the refused branch after a dispute landed answers 409 flux_email_unverified, never a step-up prompt", async () => {
    extra = { FLUX_RESUME_VIA_POLLER: "1" };
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    expect((await pollerMint()).status).toBe(200);
    expect((await call("POST", capPath, owner.token, { capUsd: 80 })).status).toBe(200);
    const aal1 = await stepUpToken(owner.sub, owner.email, { aal1: true });
    // The race: read as a lowering (80 to 50); before the write a concurrent lowering (to 30) makes it a raise and the account is disputed.
    armDb(/UPDATE flux_home_keys SET plan=\?,cap_microcents=\?,cap_custom=\?/, async () => {
      await env.DB.prepare("UPDATE flux_home_keys SET cap_microcents=30000000 WHERE home_id=?").bind(HOME).run();
      await dispute(owner.userId);
    });
    expect(await err(await call("POST", capPath, aal1, { capUsd: 50 }))).toEqual([409, "flux_email_unverified"]);
    expect(await keyRow()).toMatchObject({ cap_microcents: 30_000_000, spending_off: 0 });
  });

  it("8b fix: only the write-guard CHECK is retried; a UNIQUE failure is not retried and surfaces", async () => {
    extra = { FLUX_RESUME_VIA_POLLER: "1" };
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    expect((await pollerMint()).status).toBe(200);
    const CAP_WRITE = /UPDATE flux_home_keys SET plan=\?,cap_microcents=\?,cap_custom=\?/;
    let writes = 0;
    dbHook = async (sql) => {
      if (!CAP_WRITE.test(sql)) return;
      writes += 1;
      throw new Error("D1_ERROR: UNIQUE constraint failed: flux_home_ops.op_id: SQLITE_CONSTRAINT");
    };
    const r = await call("POST", capPath, owner.token, { capUsd: 200 });
    dbHook = null;
    expect(r.status).toBe(500);
    expect(writes).toBe(1);
    expect(await keyRow()).toMatchObject({ cap_microcents: 30_000_000 });
  });

  it("8b fix: a write-guard CHECK failure on a raise is retried once, as before", async () => {
    extra = { FLUX_RESUME_VIA_POLLER: "1" };
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    expect((await pollerMint()).status).toBe(200);
    const CAP_WRITE = /UPDATE flux_home_keys SET plan=\?,cap_microcents=\?,cap_custom=\?/;
    let writes = 0;
    dbHook = async (sql) => {
      if (!CAP_WRITE.test(sql)) return;
      writes += 1;
      if (writes === 1) throw new Error("D1_ERROR: CHECK constraint failed: ok=1: SQLITE_CONSTRAINT");
    };
    const r = await call("POST", capPath, owner.token, { capUsd: 200 });
    dbHook = null;
    expect(r.status).toBe(200);
    expect(writes).toBe(2);
    expect(await keyRow()).toMatchObject({ cap_microcents: 200_000_000 });
  });

  it("key rows made AFTER the dispute inherit the hold: a lazily created row and a home bought later; existing rows are held; the clear lifts all, and other accounts are untouched", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    const other = await signIn("other@example.test");
    await seedHome(owner.userId);
    await link(owner.token);
    await seedHome(other.userId, { homeId: "home-other" });
    await link(other.token, "99999999-2222-3333-4444-555555555555");
    expect(await keyRow()).toBeNull(); // no row yet: it is created lazily
    await dispute(owner.userId);
    expect(await keyRow()).toBeNull(); // still lazy: nothing to hold yet, the table is what decides
    // The lazy creation (the status read) while the dispute stands.
    expect((await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).status).toBe(200);
    expect(await keyRow()).toMatchObject({ proof_hold: 1 });
    // A home bought after the dispute.
    await seedHome(owner.userId, { homeId: "home-later" });
    expect((await call("GET", `/v1/homes/home-later/flux`, owner.token)).status).toBe(200);
    expect(await keyRow("home-later")).toMatchObject({ proof_hold: 1 });
    // Another account's home is not held.
    expect((await call("GET", `/v1/homes/home-other/flux`, other.token)).status).toBe(200);
    expect(await keyRow("home-other")).toMatchObject({ proof_hold: 0 });
    // A row that existed before the dispute is held when it opens.
    await env.DB.prepare("DELETE FROM flux_home_keys WHERE home_id='home-later'").run();
    await clearOf(owner.userId);
    expect(await keyRow()).toMatchObject({ proof_hold: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_home_keys WHERE proof_hold=1").first()).toEqual({ n: 0 });
    await dispute(owner.userId);
    expect(await keyRow()).toMatchObject({ proof_hold: 1 });
    await seedHome(owner.userId, { homeId: "home-third" });
    expect((await call("GET", `/v1/homes/home-third/flux`, owner.token)).status).toBe(200);
    expect(await keyRow("home-third")).toMatchObject({ proof_hold: 1 });
    await clearOf(owner.userId);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_home_keys WHERE proof_hold=1").first()).toEqual({ n: 0 });
  });

  it("a stale clear cannot lift a newer dispute: by version, across a repeat and across a clear and a re-open; a clear without a version lifts what it reads", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await dispute(owner.userId);
    expect(await version(owner.userId)).toEqual({ version: 1, open: 1 });
    await dispute(owner.userId); // a repeat rewrites the dispute: version 2
    expect(await version(owner.userId)).toEqual({ version: 2, open: 1 });
    const stale = await clearOf(owner.userId, 1);
    expect(await stale.json()).toMatchObject({ cleared: false, reason: "newer_dispute" });
    expect(await version(owner.userId)).toEqual({ version: 2, open: 1 });
    expect(await err(await pollerMint())).toEqual([409, "flux_email_unverified"]);
    expect(await (await clearOf(owner.userId, 2)).json()).toEqual({ cleared: true });
    expect(await version(owner.userId)).toEqual({ version: 3, open: 0 });
    // A clear with the old version after a re-open: the version only rises, so it never matches.
    await dispute(owner.userId);
    expect(await version(owner.userId)).toEqual({ version: 4, open: 1 });
    for (const old of [1, 2, 3]) expect(await (await clearOf(owner.userId, old)).json()).toMatchObject({ cleared: false });
    expect(await version(owner.userId)).toEqual({ version: 4, open: 1 });
    // A clear after nothing is open says so.
    expect(await (await clearOf(owner.userId)).json()).toEqual({ cleared: true });
    expect(await (await clearOf(owner.userId)).json()).toEqual({ cleared: false, reason: "no_dispute" });
    expect((await pollerMint()).status).toBe(200);
  });

  it("a dispute written between the clear's read and its batch is not lifted (the seam)", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await dispute(owner.userId);
    const r = await fluxEmailProofOperatorRoute(new Request("https://cp.test/v1/internal/flux/email-proof/dispute-clear", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: owner.userId, by: "ops" }) }), testEnv(), "dispute-clear",
      { beforeClearBatch: async () => { await dispute(owner.userId); } });
    expect(await r.json()).toMatchObject({ cleared: false, reason: "newer_dispute" });
    expect(await version(owner.userId)).toEqual({ version: 2, open: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.email_proof_disputed' AND resolved_at IS NULL").first()).toEqual({ n: 1 });
  });
});

// DISPUTE-FENCE-ACCOUNT round 2 (Astra + Opus reviews of 1b5ee3eac). Each scenario is an Astra fixture, red on 1b5ee3eac.
import { raiseCapToCover, writeDisputeFirstKeyHold } from "../src/b4-flux";
describe("DISPUTE-FENCE-ACCOUNT round 2: caps, clear snapshot, re-dispute alert, audit, held reasons", () => {
  const DISPUTE = "/v1/internal/flux/email-proof/dispute";
  const CLEAR = "/v1/internal/flux/email-proof/dispute-clear";
  const dispute = (account: string, note = "buyer says not theirs") => admin(DISPUTE, { account_id: account, note, by: "ops" });
  const clearOf = (account: string, version?: number) => admin(CLEAR, { account_id: account, by: "ops", ...(version === undefined ? {} : { version }) });
  const fenceOf = (account: string) => env.DB.prepare("SELECT version,open FROM flux_account_dispute WHERE account_id=?").bind(account).first<{ version: number; open: number }>();
  const keyRow = (homeId = HOME) => env.DB.prepare("SELECT * FROM flux_home_keys WHERE home_id=?").bind(homeId).first<Record<string, unknown>>();
  const deps = () => ({ fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
  const minted = async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    expect((await pollerMint()).status).toBe(200);
    return owner;
  };

  it("Astra H2: the automatic cap catch-up (raiseCapToCover) raises nothing while the account is disputed, and raises again after the clear", async () => {
    const owner = await minted();
    await dispute(owner.userId);
    flux.statusFor = { ...flux.statusFor, capMicrocents: 30_000_000, spentMicrocents: 4_000_000, accountSpendableMicrocents: 126_000_000 };
    const before = flux.caps.length;
    const r = await raiseCapToCover(testEnv(), HOME, deps());
    expect(r).not.toBe("raised");
    expect(await keyRow()).toMatchObject({ cap_microcents: 30_000_000 });
    expect(flux.caps.slice(before).filter((c) => c.capMicrocents > 30_000_000)).toEqual([]);
    expect((await clearOf(owner.userId)).status).toBe(200);
    expect(await raiseCapToCover(testEnv(), HOME, deps())).toBe("raised");
    expect(await keyRow()).toMatchObject({ cap_microcents: 130_000_000 });
  });

  it("Astra H2: a billing plan change while disputed records the plan but cannot raise the cap that follows it; after the clear the plan's cap applies", async () => {
    const owner = await minted();
    await dispute(owner.userId);
    const before = flux.caps.length;
    const moved = await changePlan(testEnv(), { homeId: HOME, plan: "pro" }, deps());
    expect(moved).toEqual({ plan: "pro", capUsd: 30 });
    expect(await keyRow()).toMatchObject({ plan: "pro", cap_microcents: 30_000_000 });
    expect(flux.caps.slice(before).filter((c) => c.capMicrocents > 30_000_000)).toEqual([]);
    expect((await clearOf(owner.userId)).status).toBe(200);
    expect(await changePlan(testEnv(), { homeId: HOME, plan: "pro" }, deps())).toEqual({ plan: "pro", capUsd: 60 });
  });

  it("Astra M4: a dispute that changes between the clear's two reads is never half cleared (the account fence and the proof dispute stand or fall together)", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId); // not linked: the proof dispute row exists beside the account fence
    expect((await dispute(owner.userId)).status).toBe(200);
    let fired = false; // the hook closure outlives one use: fire the second dispute once, between the clear's reads
    armDb(/FROM flux_account_dispute WHERE account_id=\? AND open=1/, async () => { if (fired) return; fired = true; await dispute(owner.userId, "second look at the same buyer"); });
    await clearOf(owner.userId);
    const proof = await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_email_proof_disputes WHERE account_id=?").bind(owner.userId).first<{ n: number }>();
    const fence = await fenceOf(owner.userId);
    expect(fence!.open === 1).toBe(proof!.n === 1);
    if (fence!.open === 1) expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_home_keys WHERE proof_hold=0").first()).toEqual({ n: 0 });
  });

  it("Astra M5 / Opus M1: dispute, clear, dispute again on a linked account reopens the paging alert and resets its delivery", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    const id = `alert:email_proof_disputed:${owner.userId}`;
    await dispute(owner.userId);
    await env.DB.prepare("UPDATE cloud_alerts SET delivered_at=5,delivery_attempts=3 WHERE id=?").bind(id).run();
    expect(await (await clearOf(owner.userId)).json()).toEqual({ cleared: true });
    expect(await env.DB.prepare("SELECT resolved_at IS NOT NULL AS r FROM cloud_alerts WHERE id=?").bind(id).first()).toEqual({ r: 1 });
    await dispute(owner.userId);
    expect(await env.DB.prepare("SELECT resolved_at,delivered_at,delivery_attempts FROM cloud_alerts WHERE id=?").bind(id).first())
      .toEqual({ resolved_at: null, delivered_at: null, delivery_attempts: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.email_proof_disputed' AND severity='high' AND resolved_at IS NULL").first()).toEqual({ n: 1 });
  });

  it("Astra L6: a stale clear that is refused writes no dispute_clear audit entry; the real clear writes exactly one", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId); // unlinked: the legacy dispute row is what the audit used to match
    await dispute(owner.userId);
    await dispute(owner.userId); // version 2
    const stale = await clearOf(owner.userId, 1);
    expect(await stale.json()).toMatchObject({ cleared: false, reason: "newer_dispute" });
    expect(await fenceOf(owner.userId)).toEqual({ version: 2, open: 1 });
    const audits = () => env.DB.prepare("SELECT COUNT(*) AS n FROM flux_email_proof_audit WHERE account_id=? AND act='dispute_clear'").bind(owner.userId).first<{ n: number }>();
    expect(await audits()).toEqual({ n: 0 });
    expect(await (await clearOf(owner.userId, 2)).json()).toEqual({ cleared: true });
    expect(await audits()).toEqual({ n: 1 });
  });

  it("Opus Low 1: a grant held by the dispute says so (grant_held:account_disputed), and is delivered after the clear", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await dispute(owner.userId);
    expect((await admin("/v1/internal/flux/grant", { homeId: HOME, plan: "starter", invoiceId: "in_round2_held", ...period() })).status).toBe(200);
    expect(await env.DB.prepare("SELECT status,last_error FROM flux_grants WHERE grant_id='inv:in_round2_held'").first()).toEqual({ status: "pending", last_error: "grant_held:account_disputed" });
    expect((await clearOf(owner.userId)).status).toBe(200);
    clock += 6 * 3_600_000;
    await sweepFlux(testEnv(), { fluxClient: () => flux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect(await env.DB.prepare("SELECT status,last_error FROM flux_grants WHERE grant_id='inv:in_round2_held'").first()).toEqual({ status: "done", last_error: null });
  });

  it("Opus Low 2/3: a renewal refused by the dispute is not asked again on every poll; the clear lifts that wait", async () => {
    const owner = await minted();
    await env.DB.prepare("UPDATE cloud_machines SET credential_hash=? WHERE id=?").bind(await sha256(MACHINE_TOKEN), HOME).run();
    const ip = { "CF-Connecting-IP": HOME_IP };
    const post = (path: string, body: unknown) => call("POST", `/v1/machines/${HOME}/flux/${path}`, MACHINE_TOKEN, body, ip);
    await env.DB.prepare("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?").bind(clock + DAY, HOME).run();
    await env.DB.prepare("DELETE FROM flux_first_key_retry WHERE home_id=?").bind(HOME).run(); // the seed mint's own poll bound is not what this test is about
    await dispute(owner.userId);
    const first = await post("subkey", { generation: 1 });
    expect([first.status, (await first.json<{ error: string }>()).error]).toEqual([409, "flux_email_unverified"]);
    const again = await post("subkey", { generation: 1 });
    expect([again.status, (await again.json<{ error: string }>()).error]).toEqual([429, "renewal_retry_later"]);
    expect((await clearOf(owner.userId)).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_first_key_retry WHERE home_id=?").bind(HOME).first()).toEqual({ n: 0 });
    expect((await post("subkey", { generation: 1 })).status).toBe(200);
  });

  // ---- polish round (Astra M1, Low 4; Opus Low 2, Low 3) ----
  const seedAttempts = (id: string, attempts: number) => env.DB.prepare("INSERT INTO flux_grants (grant_id,entitlement_key,home_id,plan,amount_microcents,period_start,period_end,expires_at,attempts,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(id, `k-${id}`, HOME, "pro", 20_000_000, PERIOD_START, PERIOD_END, addDays(PERIOD_END, 30), attempts, clock).run();
  const grantRow = (id: string) => env.DB.prepare("SELECT status,attempts,last_error FROM flux_grants WHERE grant_id=?").bind(id).first();
  const exhaustedAlerts = () => env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.grant_exhausted'").first();

  it("Astra M1: attempts=19, a dispute lands before the grant allocation (refused, nothing sent): the grant stays pending, the attempt is taken back, it says why, and it is delivered after the clear", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await seedAttempts("inv:in_m1_19", 19);
    flux.onGrant = async () => { await dispute(owner.userId); throw new FluxNotDispatched("account_disputed"); };
    await sweepFlux(testEnv(), deps());
    expect(await grantRow("inv:in_m1_19")).toEqual({ status: "pending", attempts: 19, last_error: "grant_held:account_disputed" });
    expect(await exhaustedAlerts()).toEqual({ n: 0 });
    expect(flux.grants.map((g) => g.grantId)).not.toContain("inv:in_m1_19");
    expect((await clearOf(owner.userId)).status).toBe(200);
    clock += 6 * 3_600_000;
    await sweepFlux(testEnv(), deps());
    expect(await grantRow("inv:in_m1_19")).toEqual({ status: "done", attempts: 20, last_error: null });
    expect(flux.grants.map((g) => g.grantId)).toContain("inv:in_m1_19");
  });

  it("Astra M1 (the 20th attempt): a dispute refusal on the last try leaves the grant pending, not failed, and raises no exhausted page; any other refusal on the 20th still fails it", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await seedAttempts("inv:in_m1_dispute", 19);
    flux.onGrant = async () => { throw new FluxNotDispatched("account_disputed"); };
    await sweepFlux(testEnv(), deps());
    expect(await grantRow("inv:in_m1_dispute")).toMatchObject({ status: "pending", attempts: 19, last_error: "grant_held:account_disputed" });
    expect(await exhaustedAlerts()).toEqual({ n: 0 });
    // Control: a refusal that is NOT the dispute spends the 20th attempt and fails the grant, as before.
    await seedAttempts("inv:in_m1_other", 19);
    flux.onGrant = async () => { throw new FluxNotDispatched("grant_owner_lost"); };
    clock += 6 * 3_600_000;
    await sweepFlux(testEnv(), deps());
    expect(await grantRow("inv:in_m1_other")).toMatchObject({ status: "failed", attempts: 20 });
  });

  it("Opus L2 (the race on attempt 20): a dispute opens just before the allocation and a clear lands right after the refusal: the refusal reason comes from the refusing statement, so it is still a HOLD (pending, attempt given back, no exhausted page)", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await machineSetup(owner.token, owner.userId);
    await seedAttempts("in_l2_race:period", 19);
    await env.DB.prepare("UPDATE flux_grants SET invoice_id='in_l2_race',kind='period' WHERE grant_id='in_l2_race:period'").run(); // the real client derives the grant id from invoice + kind
    let opened = 0;
    let cleared = 0;
    dbHook = async (sql) => {
      if (/UPDATE flux_grant_fence SET next_revision/.test(sql) && !opened) { opened++; const h = dbHook; dbHook = null; await dispute(owner.userId); dbHook = h; return; }
      // The OLD code re-read the dispute here, as its own statement, after the refusal; a clear lands in that gap. The new code has no such read.
      if (/^\s*SELECT EXISTS \(SELECT 1 FROM flux_account_dispute/.test(sql) && opened && !cleared) {
        cleared++; const h = dbHook; dbHook = null;
        await env.DB.prepare("UPDATE flux_account_dispute SET open=0 WHERE account_id=?").bind(owner.userId).run();
        dbHook = h;
      }
    };
    // The REAL grant client (fencedMutation -> allocateFenceRevision) over a fake router; every other call stays on the fake Flux.
    const savedExtra = extra;
    extra = { FLUX_CLOUD_GRANTS_URL: "https://router.test", FLUX_CLOUD_GRANTS_TOKEN: "g".repeat(40) };
    const real = createFluxClient(testEnv(), (async () => new Response(JSON.stringify({ status: "granted" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch);
    const hybrid = new Proxy(flux, { get(t, p) { if (p === "grant") return (g: Parameters<typeof real.grant>[0]) => real.grant(g); const v = (t as unknown as Record<string | symbol, unknown>)[p]; return typeof v === "function" ? v.bind(t) : v; } });
    try { await sweepFlux(testEnv(), { ...deps(), fluxClient: () => hybrid }); } finally { dbHook = null; extra = savedExtra; }
    expect(opened).toBe(1);
    expect(await grantRow("in_l2_race:period")).toEqual({ status: "pending", attempts: 19, last_error: "grant_held:account_disputed" });
    expect(await exhaustedAlerts()).toEqual({ n: 0 });
    expect(flux.grants.map((g) => g.grantId)).not.toContain("in_l2_race:period");
  });

  it("Astra Low 4: the dispute hold row is written only while the dispute is still open", async () => {
    await setupKeys();
    const owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    const rows = () => env.DB.prepare("SELECT COUNT(*) AS n FROM flux_first_key_retry WHERE home_id=?").bind(HOME).first();
    await writeDisputeFirstKeyHold(testEnv(), HOME, clock); // no dispute: nothing written (a clear that committed after the read leaves no wait)
    expect(await rows()).toEqual({ n: 0 });
    await dispute(owner.userId);
    await writeDisputeFirstKeyHold(testEnv(), HOME, clock);
    expect(await rows()).toEqual({ n: 1 });
  });

  it("Opus Low 2: a dispute cleared between the fence's refusal and the dispute read does not fail the cap write (made again, once)", async () => {
    const owner = await minted();
    await dispute(owner.userId);
    flux.statusFor = { ...flux.statusFor, capMicrocents: 30_000_000, spentMicrocents: 4_000_000, accountSpendableMicrocents: 126_000_000 };
    armDb(/JOIN cloud_homes[\s\S]*AS d\b/, async () => { expect((await clearOf(owner.userId)).status).toBe(200); });
    expect(await raiseCapToCover(testEnv(), HOME, deps())).toBe("raised");
    expect(await keyRow()).toMatchObject({ cap_microcents: 130_000_000 });
  });

  it("Opus Low 3: a plan change when the key row vanished in flight does not throw", async () => {
    await minted();
    armDb(/UPDATE flux_home_keys SET plan=/, async () => { await env.DB.prepare("DELETE FROM flux_home_keys WHERE home_id=?").bind(HOME).run(); });
    await expect(changePlan(testEnv(), { homeId: HOME, plan: "pro" }, deps())).resolves.toBeDefined();
  });
});

// ══ 8b: spending back ON goes through the home's own poller (SPENDING-RESUME-VIA-POLLER rev 1.5.3, section 7, CP tests) ══
// The owner mint is closed for every home; every key a home holds here came through its poller.
describe("8b: spending back ON goes through the home's own poller (SPENDING-RESUME-VIA-POLLER 1.5.3)", () => {
  const ip = { "CF-Connecting-IP": HOME_IP };
  const COMPAT = { "x-murage-site-compat": "spending-2" };
  const m = (route: string, body: unknown, id = HOME) => call("POST", `/v1/machines/${id}/flux/${route}`, MACHINE_TOKEN, body, ip);
  let owner: Awaited<ReturnType<typeof signIn>>;
  type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const rowOf = async (): Promise<Row> => (await homeRow()) as Row;
  const getStatus = async (): Promise<Row> => (await call("GET", `/v1/homes/${HOME}/flux`, owner.token)).json<Row>();
  const delivery = async () => (await getStatus()).spendingDelivery as { state: string; stopConfirmed: boolean; homeOnline: boolean | null; pendingSince: number | null };
  const capOn = (headers: Record<string, string> = COMPAT, body: unknown = { enabled: true }) => call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, body, headers);
  const capOff = () => call("POST", `/v1/homes/${HOME}/flux/cap`, owner.token, { enabled: false });
  const ownerStopCall = () => call("POST", `/v1/homes/${HOME}/flux/stop`, owner.token, {});
  const routerQuiet = () => { flux.statusFor = { state: "none" }; };
  const due = async () => (await m("renewal-due", { generation: 1 })).json<{ due: boolean; op_id?: string }>();
  const run = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).run();
  const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

  const setup = async () => {
    activeWorker = worker8b;
    extra = { FLUX_RESUME_VIA_POLLER: "1" };
    await setupKeys();
    owner = await signIn("owner@example.test");
    await seedHome(owner.userId);
    await link(owner.token);
    await run("UPDATE cloud_machines SET credential_hash=? WHERE id=?", await sha256(MACHINE_TOKEN), HOME);
    await run("UPDATE cloud_homes SET entitlement='paid', heartbeat_at=? WHERE id=?", clock, HOME);
    await run(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at) VALUES (?,'cus_1','sub_1','starter','active',?,?)`, HOME, clock, clock);
    routerQuiet();
  };
  afterEach(() => { activeWorker = worker; });

  /** The home's first key, taken by its poller and acked: generation 1 at lifecycle 1. */
  const keyed = async () => {
    const d = await due();
    expect(d.due).toBe(true);
    const minted = await m("subkey", { generation: 1, op_id: d.op_id });
    expect(minted.status).toBe(200);
    const k = await minted.json<{ generation: number; expiresAt: string }>();
    expect((await m("subkey/ack", { generation: 1, op_id: d.op_id, key_generation: k.generation })).status).toBe(200);
    return k;
  };
  /** A keyed home after an owner Stop: stopped at lifecycle 2, generation 1 dead, router quiet. */
  const stopped = async () => { await keyed(); expect((await ownerStopCall()).status).toBe(200); };
  /** Resume then take the key by the poller; returns the mint body. */
  const resumedAndKeyed = async () => {
    await stopped();
    expect((await capOn()).status).toBe(200);
    const d = await due();
    const minted = await m("subkey", { generation: 1, op_id: d.op_id });
    expect(minted.status).toBe(200);
    const k = await minted.json<{ generation: number }>();
    expect((await m("subkey/ack", { generation: 1, op_id: d.op_id, key_generation: k.generation })).status).toBe(200);
    return k;
  };
  const snapshot = async () => JSON.stringify(await Promise.all(["flux_home_keys", "flux_home_ops", "flux_first_key_retry", "cloud_write_guards", "flux_mint_ops"]
    .map(async (t) => (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()).results)));

  it("1. ON on a stopped home (flag on, header sent): zero router calls, row active at LV+1 with no key, resume pending", async () => {
    await setup(); await stopped();
    const before = flux.calls;
    const on = await capOn();
    expect([on.status, await on.json()]).toEqual([200, { capUsd: 30, enabled: true, resume: "pending" }]);
    expect(flux.calls).toBe(before);
    expect(await rowOf()).toMatchObject({ state: "active", lifecycle_version: 3, key_expires_at: null, resume_lv: 3, resume_from_generation: 1, resume_at: clock,
      pending_op_id: null, pending_generation: null, pending_expires_at: null, pending_lifecycle_version: null, spending_off: 0 });
  });

  it("2. the cue is true; the machine subkey sends owner_resume at V+1, again after a lost response; GET is pending after the commit and on after the ack", async () => {
    await setup(); await stopped(); await capOn();
    const d = await due();
    expect(d).toEqual({ due: true, op_id: `renew:${HOME}:1:1` });
    flux.afterMint = async () => { throw new FluxError(0, "unreachable"); }; // the key is published, the answer is lost
    expect((await m("subkey", { generation: 1, op_id: d.op_id })).status).toBe(502);
    // fix r1 (Astra M5): the failed resume attempt is counted: the next one waits the bound's first minute, never at the unchanged clock
    const early = await m("subkey", { generation: 1, op_id: d.op_id });
    expect([early.status, (await early.json<{ error: string }>()).error]).toEqual([429, "renewal_retry_later"]);
    expect((await due()).due).toBe(false);
    clock += 60_000;
    expect((await due()).due).toBe(true);
    const second = await m("subkey", { generation: 1, op_id: d.op_id });
    expect(second.status).toBe(200);
    expect(flux.mints.slice(-2).map((x) => [x.lifecycleVersion, x.ownerResume])).toEqual([[3, true], [3, true]]);
    expect(await delivery()).toMatchObject({ state: "pending" });
    const k = await second.json<{ generation: number }>();
    expect((await m("subkey/ack", { generation: 1, op_id: d.op_id, key_generation: k.generation })).status).toBe(200);
    expect(await delivery()).toMatchObject({ state: "on" });
    expect(await rowOf()).toMatchObject({ acked_lifecycle_version: 3, acked_generation: k.generation });
  });

  it("2b. an ordinary renewal sends owner_resume false", async () => {
    await setup(); await keyed();
    await run("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?", clock + DAY, HOME);
    const d = await due();
    expect((await m("subkey", { generation: 1, op_id: d.op_id })).status).toBe(200);
    expect(flux.mints.at(-1)).toMatchObject({ ownerResume: false });
  });

  describe("2d. fix r1 (Astra M5): failed resume and ordinary-renewal attempts wait 1, 2, 4, 8, then 10 minutes", () => {
    const retryAt = async () => (await env.DB.prepare("SELECT next_at FROM flux_first_key_retry WHERE home_id=?").bind(HOME).first<{ next_at: number }>())?.next_at ?? null;
    /** Every attempt fails ambiguously at the router (unreachable: the compensation queued by one keeps the next from minting either). */
    const progression = async () => {
      flux.down = true;
      for (const wait of [60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
        const d = await due();
        expect(d.due).toBe(true);
        expect((await m("subkey", { generation: 1, op_id: d.op_id })).status).toBe(502);
        expect((await retryAt())! - clock).toBe(wait);
        expect(await due()).toEqual({ due: false });
        clock += wait - 1;
        const early = await m("subkey", { generation: 1, op_id: d.op_id });
        expect([early.status, (await early.json<{ error: string }>()).error]).toEqual([429, "renewal_retry_later"]);
        clock += 1;
      }
      flux.down = false;
      const d = await due();
      const k = await (await m("subkey", { generation: 1, op_id: d.op_id })).json<{ generation: number }>();
      expect((await m("subkey/ack", { generation: 1, op_id: d.op_id, key_generation: k.generation })).status).toBe(200);
      expect(await retryAt()).toBeNull();
      expect((await delivery()).state).toBe("on");
    };
    it("a resume (NULL expiry)", async () => {
      await setup(); await stopped(); expect((await capOn()).status).toBe(200);
      expect((await rowOf()).key_expires_at).toBeNull();
      await progression();
    });
    it("an ordinary renewal inside the 7-day window", async () => {
      await setup(); await keyed();
      await run("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?", clock + DAY, HOME);
      await progression();
    });
  });

  it("2c. router PR 624: a Stop is lifted only by the poller's resume mint (owner_resume true); an ordinary renewal never reaches a stopped home", async () => {
    await setup(); flux.requireOwnerResume = true; flux.strictStop = true; await stopped(); await capOn();
    const d = await due();
    expect((await m("subkey", { generation: 1, op_id: d.op_id })).status).toBe(200); // the router accepts: owner_resume true, lifecycle 3 > 2
    expect(flux.stopped).toBe(false);
  });

  it("3. ON on a stopping home with the Stop queued: Stop(V) reaches the router before mint(V+1) and the row is not flipped back; a failing Stop holds the mint (renewal_retry_later, no mint call)", async () => {
    await setup(); await keyed();
    flux.stopDown = true;
    expect((await ownerStopCall()).status).toBe(502); // the Stop is journaled at lifecycle 2 and not sent
    expect(await rowOf()).toMatchObject({ state: "stopping", lifecycle_version: 2 });
    expect((await capOn()).status).toBe(200);
    expect(await rowOf()).toMatchObject({ state: "active", lifecycle_version: 3, resume_lv: 3 });
    const d = await due();
    const mintCalls = flux.mintCalls;
    const held = await m("subkey", { generation: 1, op_id: d.op_id });
    expect([held.status, (await held.json<{ error: string }>()).error]).toEqual([429, "renewal_retry_later"]);
    expect(flux.mintCalls).toBe(mintCalls);
    flux.stopDown = false;
    const ok = await m("subkey", { generation: 1, op_id: d.op_id });
    expect(ok.status).toBe(200);
    expect(flux.log.filter((e) => e.startsWith("stop:") || e.startsWith("mint:")).slice(-2)).toEqual(["stop:2", "mint:3"]);
    expect(await rowOf()).toMatchObject({ state: "active", lifecycle_version: 3 });
  });

  it("4. ON then OFF before the claim, and between commit and ack: nothing minted or compensated, ack is ack_unknown, the row reads turning off", async () => {
    await setup(); await stopped(); await capOn();
    const d = await due();
    expect((await capOff()).status).toBe(200); // OFF before the poller's claim: lifecycle 4, Stop sent
    const mintCalls = flux.mintCalls;
    const refused = await m("subkey", { generation: 1, op_id: d.op_id });
    expect([refused.status, (await refused.json<{ error: string }>()).error]).toEqual([409, "home_not_active"]);
    expect(flux.mintCalls).toBe(mintCalls);
    expect(await due()).toEqual({ due: false });
    // ON again, the poller commits, then OFF before the ack.
    expect((await capOn()).status).toBe(200);
    const d2 = await due();
    const k = await (await m("subkey", { generation: 1, op_id: d2.op_id })).json<{ generation: number }>();
    expect((await capOff()).status).toBe(200);
    const ack = await m("subkey/ack", { generation: 1, op_id: d2.op_id, key_generation: k.generation });
    expect([ack.status, (await ack.json<{ error: string }>()).error]).toEqual([409, "ack_unknown"]);
    expect(await delivery()).toMatchObject({ state: "off" });
    expect((await getStatus()).spendingOff).toMatchObject({ requested: true });
  });

  it("4b. OFF landing between the poller's claim and its commit: commit refused, the key compensated, the ack is unknown", async () => {
    await setup(); await stopped(); await capOn();
    const d = await due();
    armDb(/UPDATE flux_home_keys SET generation=\?,state='active'/, async () => { expect((await capOff()).status).toBeGreaterThanOrEqual(200); });
    const raced = await m("subkey", { generation: 1, op_id: d.op_id });
    expect(raced.status).toBe(409);
    expect(flux.log.filter((e) => e.startsWith("revoke:"))).toContain("revoke:2");
    expect((await m("subkey/ack", { generation: 1, op_id: d.op_id, key_generation: 2 })).status).toBe(409);
    expect((await delivery()).state).not.toBe("on");
  });

  it("5. ON, OFF, ON: one live resume_lv, the older mint and ack are refused", async () => {
    await setup(); await stopped(); await capOn();
    const d1 = await due();
    expect((await capOff()).status).toBe(200);
    expect((await capOn()).status).toBe(200);
    expect(await rowOf()).toMatchObject({ lifecycle_version: 5, resume_lv: 5, state: "active" });
    const stale = await m("subkey/ack", { generation: 1, op_id: d1.op_id, key_generation: 2 });
    expect(stale.status).toBe(409);
    const d2 = await due();
    expect((await m("subkey", { generation: 1, op_id: d2.op_id })).status).toBe(200);
    expect(flux.mints.at(-1)).toMatchObject({ lifecycleVersion: 5, ownerResume: true });
  });

  it("6. two concurrent ONs (the second lands between the first's read and its batch): LV moves once, both answers 200", async () => {
    await setup(); await stopped();
    let second: Response | undefined;
    armDb(/resume_lv=lifecycle_version\+1/, async () => { second = await capOn(); });
    const first = await capOn();
    expect([first.status, second?.status]).toEqual([200, 200]);
    expect(await first.json()).toEqual({ capUsd: 30, enabled: true, resume: "pending" });
    expect(await rowOf()).toMatchObject({ lifecycle_version: 3, resume_lv: 3 });
  });

  it("6b. a concurrent resume wins with a different cap: the losing ON answers the cap stored by the winner, not its own request", async () => {
    await setup(); await stopped();
    let second: Response | undefined;
    armDb(/resume_lv=lifecycle_version\+1/, async () => { second = await capOn(COMPAT, { capUsd: 50 }); });
    const first = await capOn(COMPAT, { capUsd: 80 });
    expect([first.status, second?.status]).toEqual([200, 200]);
    expect(await second!.json()).toEqual({ capUsd: 50, enabled: true, resume: "pending" });
    expect(await first.json()).toEqual({ capUsd: 50, enabled: true, resume: "pending" });
    expect(await rowOf()).toMatchObject({ lifecycle_version: 3, resume_lv: 3, cap_microcents: 50_000_000 });
  });

  it.each(["owner", "billing", "unlink"])("7. a %s Stop during the poller's mint: the commit is refused, the key compensated, delivery is not on", async (kind) => {
    await setup(); await stopped(); await capOn();
    const d = await due();
    const stop = async () => {
      if (kind === "owner") await ownerStopCall();
      else if (kind === "billing") await stopForBilling(testEnv(), HOME, deps);
      else await call("DELETE", "/v1/flux/link", owner.token);
    };
    armDb(/UPDATE flux_home_keys SET generation=\?,state='active'/, stop);
    const raced = await m("subkey", { generation: 1, op_id: d.op_id });
    expect(raced.status).toBeGreaterThanOrEqual(409);
    expect(flux.log).toContain("revoke:2");
    expect((await delivery()).state).not.toBe("on");
  });

  describe("8. a billing hold is row-identical for every ON (r2 H3)", () => {
    const hold = () => run("UPDATE flux_home_keys SET billing_hold=1,billing_hold_at=? WHERE home_id=?", clock, HOME);
    const expectHeld = async (res: Response, before: string, calls: number) => {
      expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([409, "billing_hold"]);
      expect(await snapshot()).toBe(before);
      expect(flux.calls).toBe(calls);
      expect(await due()).toEqual({ due: false });
    };
    it("(a) held before the press", async () => {
      await setup(); await stopped(); await hold();
      const before = await snapshot(); const calls = flux.calls;
      await expectHeld(await capOn(), before, calls);
    });
    it("(b) a hold lands between the read and the resume batch", async () => {
      await setup(); await stopped();
      let before = ""; let calls = 0;
      armDb(/resume_lv=lifecycle_version\+1/, async () => { await hold(); before = await snapshot(); calls = flux.calls; });
      await expectHeld(await capOn(), before, calls);
    });
    it("(c) an active row, a hold lands between the read and the notRaising batch", async () => {
      await setup(); await keyed();
      let before = ""; let calls = 0;
      armDb(/cap_microcents>=\?/, async () => { await hold(); before = await snapshot(); calls = flux.calls; });
      await expectHeld(await capOn(COMPAT, { capUsd: 30 }), before, calls);
    });
    it("(d) a hold lands between the notRaising refusal and the stepped-up batch", async () => {
      await setup(); await keyed();
      let before = ""; let calls = 0;
      // a raise is refused for the notRaising path without a write (it needs the step-up); the hold lands before the stepped-up batch
      armDb(/SET plan=/, async () => { await hold(); before = await snapshot(); calls = flux.calls; });
      await expectHeld(await capOn(COMPAT, { capUsd: 80 }), before, calls);
    });
    it("(e) a second ON on a pending-resume active row, hold injected before its batch", async () => {
      await setup(); await stopped(); await capOn();
      let before = ""; let calls = 0;
      armDb(/cap_microcents>=\?/, async () => { await hold(); before = await snapshot(); calls = flux.calls; });
      await expectHeld(await capOn(), before, calls);
    });
    // fix r1 (Astra M4): a never-keyed home (state none): every ON write is hold-fenced too
    it("(f) a never-keyed row, a stepped-up raise ($30 to $80), the hold lands before its batch", async () => {
      await setup(); await seedHomeKeyRow();
      expect(await rowOf()).toMatchObject({ state: "none", generation: 0, cap_microcents: 30_000_000 });
      let before = ""; let calls = 0;
      armDb(/SET plan=/, async () => { await hold(); before = await snapshot(); calls = flux.calls; });
      await expectHeld(await capOn(COMPAT, { capUsd: 80 }), before, calls);
      expect(await rowOf()).toMatchObject({ state: "none", cap_microcents: 30_000_000, billing_hold: 1 });
    });
    it("(g) a never-keyed row, a same-limit ON, the hold lands before the notRaising batch", async () => {
      await setup(); await seedHomeKeyRow();
      let before = ""; let calls = 0;
      armDb(/cap_microcents>=\?/, async () => { await hold(); before = await snapshot(); calls = flux.calls; });
      await expectHeld(await capOn(COMPAT, { capUsd: 30 }), before, calls);
    });
  });

  it("9. the undelivered compensation of a pre-deploy generation after a resume revokes it and leaves the row active", async () => {
    await setup(); await stopped(); await capOn();
    await run(`INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,created_at,updated_at)
      VALUES ('undelivered:intent-x',?,(SELECT COALESCE(MAX(seq),0)+1 FROM flux_home_ops),'compensate',json_object('generation',1,'lifecycleVersion',2,'undelivered','intent-x'),'queued',?,?)`, HOME, clock, clock);
    await sweepFlux(testEnv(), deps);
    expect(flux.log).toContain("revoke:1");
    expect(await rowOf()).toMatchObject({ state: "active", resume_lv: 3, resume_from_generation: 1 });
  });

  it("10. step-up: none gives 403 and no write; a raise while the resume is pending sends no cap call", async () => {
    await setup(); await stopped();
    const before = await snapshot(); const calls = flux.calls;
    const weak = await stepUpToken(owner.sub, owner.email, { aal1: true });
    tokenUsers.set(weak, owner.userId);
    const refused = await call("POST", `/v1/homes/${HOME}/flux/cap`, weak, { enabled: true }, COMPAT);
    expect([refused.status, (await refused.json<{ error: string }>()).error]).toEqual([403, "step_up_required"]);
    expect(await snapshot()).toBe(before);
    expect(flux.calls).toBe(calls);
    expect((await capOn()).status).toBe(200);
    expect((await capOn(COMPAT, { capUsd: 80 })).status).toBe(200); // a stepped-up raise while pending
    expect(flux.caps).toEqual([]);
    expect(flux.calls).toBe(calls);
  });

  it("11. a stale pre-resume ack gives 409; a pre-migration pending row (no pending lifecycle) still acks", async () => {
    await setup(); await keyed();
    await run("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?", clock + DAY, HOME);
    const d = await due();
    const k = await (await m("subkey", { generation: 1, op_id: d.op_id })).json<{ generation: number }>();
    expect((await ownerStopCall()).status).toBe(200);
    expect((await capOn()).status).toBe(200); // the resume clears pending_*
    const stale = await m("subkey/ack", { generation: 1, op_id: d.op_id, key_generation: k.generation });
    expect([stale.status, (await stale.json<{ error: string }>()).error]).toEqual([409, "ack_unknown"]);
    // a row minted before the migration: pending set, pending_lifecycle_version NULL
    await run("UPDATE flux_home_keys SET pending_op_id=?,pending_generation=generation,pending_expires_at=?,pending_lifecycle_version=NULL WHERE home_id=?", `renew:${HOME}:1:77`, clock + 5 * DAY, HOME);
    expect((await m("subkey/ack", { generation: 1, op_id: `renew:${HOME}:1:77` })).status).toBe(200);
    const row = await rowOf();
    expect(row).toMatchObject({ acked_lifecycle_version: row.lifecycle_version, acked_generation: row.generation, pending_op_id: null });
  });

  it("12. the owner /subkey answers 410 owner_mint_retired on stopped and active homes, zero writes or calls", async () => {
    await setup(); await keyed();
    for (const state of ["active", "stopped"]) {
      if (state === "stopped") expect((await ownerStopCall()).status).toBe(200);
      const before = await snapshot(); const calls = flux.calls;
      const intents = await count("SELECT COUNT(*) AS n FROM cloud_stepup_intents");
      const res = await call("POST", `/v1/homes/${HOME}/flux/subkey`, owner.token, {});
      expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([410, "owner_mint_retired"]);
      expect(await snapshot()).toBe(before);
      expect(flux.calls).toBe(calls);
      expect(await count("SELECT COUNT(*) AS n FROM cloud_stepup_intents")).toBe(intents);
    }
    const weak = await stepUpToken(owner.sub, owner.email, { aal1: true });
    tokenUsers.set(weak, owner.userId);
    expect((await call("POST", `/v1/homes/${HOME}/flux/subkey`, weak, {})).status).toBe(410); // no step-up gate in front of it
  });

  it("13. flag off, or the header absent with the flag on: ON on a stopped home answers 410 resume_unavailable, row-identical, zero router calls", async () => {
    await setup(); await stopped();
    const before = await snapshot(); const calls = flux.calls;
    for (const [flag, headers] of [["1", {}], [undefined, COMPAT]] as const) {
      extra = flag ? { FLUX_RESUME_VIA_POLLER: flag } : {};
      const res = await capOn(headers);
      expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([410, "resume_unavailable"]);
      expect(await snapshot()).toBe(before);
      expect(flux.calls).toBe(calls);
    }
  });

  it("14. expiry writers: a non-NULL key_expires_at is written only by the ack; NULL only by the resume batch and the undelivered compensation", async () => {
    await setup();
    const seen: string[] = [];
    dbHook = (sql) => { seen.push(sql); };
    await keyed(); await ownerStopCall(); await capOn();
    const d = await due();
    await m("subkey", { generation: 1, op_id: d.op_id });
    expect((await rowOf()).key_expires_at).toBeNull(); // minted and committed, not acked
    dbHook = (sql) => { seen.push(sql); };
    await m("subkey/ack", { generation: 1, op_id: d.op_id, key_generation: 2 });
    const acked = await rowOf();
    expect(acked.key_expires_at).not.toBeNull();
    // Fix r3 (Grok Low): drive the undelivered compensation of the CURRENT generation through its NULL arm (b4-flux.ts runOps).
    await run(`INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,created_at,updated_at)
      VALUES ('undelivered:intent-14',?,(SELECT COALESCE(MAX(seq),0)+1 FROM flux_home_ops),'compensate',json_object('generation',?,'lifecycleVersion',?,'undelivered','intent-14'),'queued',?,?)`,
      HOME, acked.generation, acked.lifecycle_version, clock, clock);
    await sweepFlux(testEnv(), deps);
    expect(flux.log).toContain(`revoke:${acked.generation}`);
    expect(await rowOf()).toMatchObject({ generation: acked.generation, state: "stopped", key_expires_at: null });
    dbHook = null;
    const setters = seen.filter((sql) => /key_expires_at\s*=/.test(sql));
    const kinds = new Set(setters.map((sql) => /key_expires_at=pending_expires_at/.test(sql) ? "ack" : /key_expires_at=NULL/.test(sql) ? "null-resume" : /key_expires_at=CASE WHEN generation=\?/.test(sql) ? "null-compensation" : "other"));
    expect([...kinds].sort()).toEqual(["ack", "null-compensation", "null-resume"]);
    expect(setters.some((sql) => /key_expires_at=CASE WHEN \?=1/.test(sql))).toBe(false); // the owner commit arm is gone from every statement run
  });

  it("15. a typed hold survives a resume and keeps the cue false until its own next_at", async () => {
    await setup(); await stopped();
    await run("INSERT INTO flux_first_key_retry (home_id,failures,next_at,updated_at,hold) VALUES (?,0,?,?,'email_unverified')", HOME, clock + 15 * 60_000, clock);
    expect((await capOn()).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM flux_first_key_retry WHERE home_id=? AND hold='email_unverified'", HOME)).toBe(1);
    expect(await due()).toEqual({ due: false });
    clock += 15 * 60_000;
    expect((await due()).due).toBe(true);
  });

  it("16. GET /flux spendingDelivery: all six states and stopConfirmed", async () => {
    await setup(); await keyed();
    const set = (sql: string, ...b: unknown[]) => run(`UPDATE flux_home_keys SET ${sql} WHERE home_id=?`, ...b, HOME);
    expect(await delivery()).toEqual({ state: "on", stopConfirmed: false, homeOnline: true, pendingSince: null });
    await set("key_expires_at=?", clock - 1);
    expect((await delivery()).state).toBe("pending"); // an expired key is never On
    await set("key_expires_at=?", clock + DAY);
    await set("gen_floor=generation+1");
    expect((await delivery()).state).toBe("pending"); // a later generation was dispatched
    await set("gen_floor=generation");
    await set("acked_generation=generation-1");
    expect((await delivery()).state).toBe("pending"); // the home acked a different generation
    await set("acked_generation=generation");
    await set("billing_hold=1");
    expect((await delivery()).state).toBe("held");
    await set("billing_hold=0, spending_off=1");
    expect((await delivery()).state).toBe("off");
    await set("spending_off=0, state='stopping'");
    expect(await delivery()).toMatchObject({ state: "stopping", stopConfirmed: false });
    await set("state='stopped'");
    flux.statusFor = { state: "ok", capMicrocents: 30_000_000 };
    expect(await delivery()).toMatchObject({ state: "stopping", stopConfirmed: false }); // the router still reports the key live
    routerQuiet();
    expect(await delivery()).toMatchObject({ state: "stopped", stopConfirmed: true });
    flux.down = true;
    expect(await delivery()).toMatchObject({ state: "stopping", stopConfirmed: false }); // Flux unreachable: not confirmed
    flux.down = false;
    await set("state='active', resume_lv=lifecycle_version, resume_at=?, acked_lifecycle_version=lifecycle_version-1", clock - 5);
    expect(await delivery()).toMatchObject({ state: "pending", pendingSince: clock - 5 });
    await run("UPDATE cloud_homes SET heartbeat_at=? WHERE id=?", clock - 3 * LEASE_FRESH, HOME);
    expect(await delivery()).toMatchObject({ homeOnline: false });
  });

  describe("17. cost", () => {
    it("GET /flux and setCap ON issue the same number of statements with 0 and 500 flux_home_ops rows", async () => {
      await setup(); await stopped();
      const statements = async (go: () => Promise<unknown>) => { let n = 0; dbHook = (sql) => { n += sql.split(";\n").length; }; await go(); dbHook = null; return n; };
      const getN0 = await statements(getStatus);
      const onN0 = await statements(() => capOn());
      await run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<500)
        INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,created_at,updated_at)
        SELECT 'bulk:'||i,'other-home',1000+i,'cap','{}','done',1,1 FROM n`);
      await run("UPDATE flux_home_keys SET state='stopped', resume_lv=NULL WHERE home_id=?", HOME);
      const getN1 = await statements(getStatus);
      const onN1 = await statements(() => capOn());
      expect([getN1, onN1]).toEqual([getN0, onN0]);
    });

    it("the two overdue passes read through the partial indexes (no full scan of the alert or key table)", async () => {
      await setup(); await stopped(); await capOn();
      await run("UPDATE cloud_homes SET heartbeat_at=? WHERE id=?", clock + 2 * 3_600_000, HOME);
      clock += 2 * 3_600_000;
      const seen: string[] = [];
      dbHook = (sql) => { seen.push(sql); };
      await sweepFlux(testEnv(), deps);
      dbHook = null;
      const raise = seen.find((sql) => /FROM flux_home_keys k JOIN cloud_homes h/.test(sql) && /resume_at/.test(sql));
      const resolve = seen.find((sql) => /FROM cloud_alerts a LEFT JOIN flux_home_keys k/.test(sql));
      expect([typeof raise, typeof resolve]).toEqual(["string", "string"]);
      await run("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,resolved_at) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5000) SELECT 'bulk-a'||i,'h-'||i,CASE WHEN i%2 THEN 'flux.grant_held' ELSE 'flux.resume_undelivered' END,'high','{}',i,i FROM n");
      const plan = async (sql: string) => {
        const binds = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 0);
        return (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>()).results.map((r) => r.detail).join("\n");
      };
      const p1 = await plan(raise!); const p2 = await plan(resolve!);
      expect(p1).toMatch(/SEARCH k USING INDEX flux_home_keys_resume_open/);
      expect(p1).not.toMatch(/SCAN (k|a)\b/);
      expect(p2).toMatch(/SCAN a USING INDEX cloud_alerts_resume_open/);
      expect(p2).not.toMatch(/SCAN k\b/);
    });
  });

  const LEASE_FRESH = 60_000;
  /** n homes whose resume is open: row active at LV 3, resume_lv 3, not acked, resumed at `at`, online (heartbeat now). */
  const bulkResumes = async (n: number, at: number, prefix = "bulk") => {
    await run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at,heartbeat_at)
      SELECT ?||i,'inst-'||?||i,'o','ready','ready','sha256:x','k',1,1,? FROM n`, n, prefix, prefix, clock);
    await run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,updated_at,lifecycle_version,resume_lv,resume_from_generation,resume_at,gen_floor)
      SELECT ?||i,'starter',1,'active',30000000,0,1,3,3,1,?,1 FROM n`, n, prefix, at);
  };

  it("18. overdue coverage: 30 online homes pending over 60 minutes: 25 raised, then 5, then none; acking 27 resolves 27 in one pass; offline, young and already-raised rows are never selected", async () => {
    await setup();
    await bulkResumes(30, clock - 61 * 60_000);
    await bulkResumes(3, clock - 61 * 60_000, "off"); await run("UPDATE cloud_homes SET heartbeat_at=? WHERE id LIKE 'off%'", clock - 10 * LEASE_FRESH);
    await bulkResumes(3, clock - 10 * 60_000, "young");
    const open = () => count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='flux.resume_undelivered' AND resolved_at IS NULL");
    await sweepFlux(testEnv(), deps); expect(await open()).toBe(25);
    await sweepFlux(testEnv(), deps); expect(await open()).toBe(30);
    await sweepFlux(testEnv(), deps); expect(await open()).toBe(30);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE home_id LIKE 'off%' OR home_id LIKE 'young%'")).toBe(0);
    await run("UPDATE flux_home_keys SET acked_lifecycle_version=3,acked_generation=2 WHERE home_id IN (SELECT home_id FROM flux_home_keys WHERE home_id LIKE 'bulk%' ORDER BY home_id LIMIT 27)");
    await sweepFlux(testEnv(), deps);
    expect(await open()).toBe(3);
  });

  it("19. migration 0150 (fix r2): its only writes are acked_lifecycle_version and acked_generation on active rows; every other key column is untouched", async () => {
    await setup();
    const migration = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS.find((x) => x.name.startsWith("0150"))!;
    expect(migration.name).toBe("0150_flux_resume_via_poller.sql");
    const writes = migration.queries.filter((q) => /\b(UPDATE|INSERT|DELETE)\b/i.test(q.replace(/--[^\n]*/g, "")));
    expect(writes).toHaveLength(1); // step 2 (the owner-resumed repair) is gone: no stored mint provenance selects its rows
    const mk = (id: string, state: string, generation: number, lv: number, cols: Record<string, number | string> = {}) => {
      const names = Object.keys(cols);
      return run(`INSERT INTO flux_home_keys (home_id,plan,generation,gen_floor,state,cap_microcents,cap_custom,updated_at,lifecycle_version,key_expires_at${names.map((n) => "," + n).join("")})
        VALUES (?,'starter',?,?,?,30000000,0,1,?,99${names.map(() => ",?").join("")})`, id, generation, generation + 1, state, lv, ...Object.values(cols));
    };
    const stopOp = (home: string, version: number) => run(`INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,created_at,updated_at)
      VALUES (?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM flux_home_ops),'stop',json_object('version',?),'done',1,1)`, `op-${home}`, home, version);
    await mk("mig-active", "active", 4, 5);
    await mk("mig-stopped", "stopped", 4, 5); await stopOp("mig-stopped", 5);
    await mk("mig-stopping", "stopping", 4, 6);
    await mk("mig-none", "none", 0, 1);
    await mk("mig-held", "active", 4, 5, { billing_hold: 1 });
    await mk("mig-off", "active", 4, 5, { spending_off: 1 });
    await mk("mig-pending", "active", 4, 5, { pending_op_id: "renew:x", pending_generation: 4, pending_expires_at: 777 });
    // The old step 2 candidate: active, its last done Stop one lifecycle below, no pending key, never acked. It now keeps every key column.
    await mk("mig-old-candidate", "active", 4, 5); await stopOp("mig-old-candidate", 4);
    const snapshot = async () => Object.fromEntries((await env.DB.prepare("SELECT * FROM flux_home_keys WHERE home_id LIKE 'mig-%' ORDER BY home_id")
      .all<Record<string, unknown>>()).results.map((r) => [r.home_id as string, r]));
    const before = await snapshot();
    expect(Object.keys(before)).toHaveLength(8);
    for (const q of writes) await env.DB.prepare(q).run();
    const after = await snapshot();
    for (const [id, row] of Object.entries(before)) {
      const active = row.state === "active";
      expect(after[id], id).toEqual({ ...row,
        acked_lifecycle_version: active ? row.lifecycle_version : row.acked_lifecycle_version,
        acked_generation: active ? row.generation : row.acked_generation });
      for (const c of ["resume_lv", "resume_from_generation", "resume_at", "acked_lifecycle_version", "acked_generation"]) if (!active) expect(after[id][c], `${id}.${c}`).toBeNull();
      expect(after[id].resume_lv, id).toBeNull();
    }
    expect(after["mig-old-candidate"]).toMatchObject({ acked_lifecycle_version: 5, acked_generation: 4, key_expires_at: 99, resume_lv: null, resume_from_generation: null, resume_at: null });
    expect(after["mig-pending"]).toMatchObject({ acked_lifecycle_version: 5, acked_generation: 4, pending_op_id: "renew:x", pending_generation: 4, pending_expires_at: 777 });
  });

  describe("20-21. renewal and rotation (r2 H1, H2)", () => {
    const renewalDue = async () => { await run("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?", clock + DAY, HOME); };
    it("20. acked g, the renewal claims g+1 and the answer is lost: delivery pending, the cue true, never on from g's expiry; the same for a lost ack; g+2 acked gives on", async () => {
      await setup(); await keyed(); await renewalDue();
      expect((await delivery()).state).toBe("on");
      const d = await due();
      flux.afterMint = async () => { throw new FluxError(0, "unreachable"); };
      expect((await m("subkey", { generation: 1, op_id: d.op_id })).status).toBe(502);
      expect((await delivery()).state).toBe("pending");
      expect((await due()).due).toBe(false); // fix r1 (Astra M5): the failed attempt waits the bound's first minute
      clock += 60_000;
      expect((await due()).due).toBe(true);
      // commit, then the poller never acks (a lost answer or a lost ack): still pending
      const ok = await m("subkey", { generation: 1, op_id: d.op_id });
      expect(ok.status).toBe(200);
      expect((await delivery()).state).toBe("pending");
      clock += 120_000; // the second consecutive wait on the bound (the failed attempt was the first)
      const d2 = await due();
      expect(d2.due).toBe(true);
      const k2 = await (await m("subkey", { generation: 1, op_id: d2.op_id })).json<{ generation: number }>();
      expect((await m("subkey/ack", { generation: 1, op_id: d2.op_id, key_generation: k2.generation })).status).toBe(200);
      expect(await delivery()).toMatchObject({ state: "on" });
      expect(await rowOf()).toMatchObject({ acked_generation: k2.generation, generation: k2.generation, gen_floor: k2.generation });
    });
    it("20b. an attempt never adopted outside the 7-day window keeps the cue true, bounded by the retry table", async () => {
      await setup(); await keyed();
      await run("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?", clock + 30 * DAY, HOME);
      expect(await due()).toEqual({ due: false });
      await run("UPDATE flux_home_keys SET gen_floor=generation+1 WHERE home_id=?", HOME); // an attempt was dispatched and never adopted
      expect((await due()).due).toBe(true);
      expect((await delivery()).state).toBe("pending");
      flux.mintError = new FluxError(502, "");
      expect((await m("subkey", { generation: 1, op_id: (await due()).op_id })).status).toBe(502);
      expect(await due()).toEqual({ due: false }); // counted on the bound table
      clock += 60_000;
      expect((await due()).due).toBe(true);
    });
    it("20c. fix r1 (Astra H1): a delayed ack of g+1 lands after g+2's claim and before its commit, g+2 commits and its answer is lost: renewal stays due and the poller gets a fresh key", async () => {
      await setup(); await keyed(); await renewalDue();
      const d1 = await due();
      const g2 = await (await m("subkey", { generation: 1, op_id: d1.op_id })).json<{ generation: number }>(); // delivered; its ack is delayed
      clock += 60_000; // the bound after a committed, unacked mint
      const d2 = await due();
      expect(d2.due).toBe(true);
      // the router publishes g+2 (g+1 is refused at the gate from now on), then the delayed ack of g+1 lands, then the CP commits g+2
      flux.afterMint = async () => { expect((await m("subkey/ack", { generation: 1, op_id: d1.op_id, key_generation: g2.generation })).status).toBe(200); };
      const lost = await m("subkey", { generation: 1, op_id: d2.op_id });
      expect(lost.status).toBe(200); // committed; this answer never reaches the home
      const g3 = (await lost.json<{ generation: number }>()).generation;
      expect(g3).toBeGreaterThan(g2.generation);
      expect(flux.keys.has(g2.generation)).toBe(false);
      const row = await rowOf();
      expect(row).toMatchObject({ generation: g3, gen_floor: g3, acked_generation: g2.generation, pending_generation: g3 });
      expect(row.key_expires_at - clock).toBeGreaterThan(7 * DAY); // the delayed ack moved the expiry past the window
      expect((await delivery()).state).toBe("pending");
      expect(await due()).toEqual({ due: false }); // still inside the bound of g+2's commit
      clock += 60_000;
      const d3 = await due();
      expect(d3.due).toBe(true);
      const fresh = await m("subkey", { generation: 1, op_id: d3.op_id });
      expect(fresh.status).toBe(200);
      const g4 = (await fresh.json<{ generation: number }>()).generation;
      expect(g4).toBeGreaterThan(g3);
      expect((await m("subkey/ack", { generation: 1, op_id: d3.op_id, key_generation: g4 })).status).toBe(200);
      expect((await delivery()).state).toBe("on");
      expect(await due()).toEqual({ due: false });
    });
    it("21. rotation: publishing g+1 makes g refused at the gate, no CP revoke call; an unadopted g+1 is compensated and the row reads pending and due", async () => {
      await setup(); await keyed(); await renewalDue();
      expect([...flux.keys]).toEqual([1]);
      const d = await due();
      const k = await (await m("subkey", { generation: 1, op_id: d.op_id })).json<{ generation: number }>();
      expect([...flux.keys]).toEqual([k.generation]);
      expect(flux.log.filter((e) => e.startsWith("revoke:"))).toEqual([]);
      await m("subkey/ack", { generation: 1, op_id: d.op_id, key_generation: k.generation });
      await run("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?", clock + DAY, HOME);
      flux.afterMint = async () => { throw new FluxError(0, "unreachable"); };
      const d2 = await due();
      expect((await m("subkey", { generation: 1, op_id: d2.op_id })).status).toBe(502);
      expect(flux.log.filter((e) => e.startsWith("revoke:"))).toEqual([`revoke:${k.generation + 1}`]);
      expect([...flux.keys]).toEqual([]);
      expect((await delivery()).state).toBe("pending");
      expect((await due()).due).toBe(false); // fix r1 (Astra M5): due again once the bound's first minute has passed
      clock += 60_000;
      expect((await due()).due).toBe(true);
    });
  });

  describe("28. G7: only a mint at a lifecycle the owner's resume wrote lifts a Stop", () => {
    it("a machine subkey on stopped, stopping and held rows reaches the router zero times", async () => {
      await setup(); flux.strictStop = true; await stopped();
      const mints = flux.mintCalls;
      for (const [label, sql] of [["stopped", "state='stopped'"], ["stopping", "state='stopping'"], ["held", "state='active', billing_hold=1"]] as const) {
        await run(`UPDATE flux_home_keys SET ${sql} WHERE home_id=?`, HOME);
        const res = await m("subkey", { generation: 1, op_id: `renew:${HOME}:1:1` });
        expect([label, res.status >= 400]).toEqual([label, true]);
      }
      expect(flux.mintCalls).toBe(mints);
    });
    it("a Stop committed between the claim and the dispatch: the mint carries the old lifecycle, the Stop is sent after it, the home ends stopped", async () => {
      await setup(); await keyed(); await run("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?", clock + DAY, HOME);
      const d = await due();
      flux.onMint = async () => { await ownerStopCall(); };
      const res = await m("subkey", { generation: 1, op_id: d.op_id });
      expect(res.status).toBeGreaterThanOrEqual(409);
      expect(flux.stopped).toBe(true);
      expect([...flux.keys]).toEqual([]);
      expect(await rowOf()).toMatchObject({ state: "stopped" });
    });
    it("with the strict router a stale mint cannot lift a Stop and the resume lifecycle does", async () => {
      await setup(); flux.strictStop = true; await stopped();
      expect(flux.stopped).toBe(true);
      await capOn();
      const d = await due();
      expect((await m("subkey", { generation: 1, op_id: d.op_id })).status).toBe(200);
      expect(flux.stopped).toBe(false);
    });
  });

  it("29. resolve is not starved: 120 stuck homes, the 10 newest ack and 5 more get an OFF: one pass resolves exactly those 15", async () => {
    await setup();
    await bulkResumes(120, clock - 2 * 3_600_000);
    await run("UPDATE cloud_homes SET heartbeat_at=NULL WHERE id LIKE 'bulk%'"); // offline: no new raise in this pass
    await run(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject) SELECT 'alert:resume:'||home_id||':3',home_id,'flux.resume_undelivered','high','{}',resume_at,'3' FROM flux_home_keys WHERE home_id LIKE 'bulk%'`);
    await run("UPDATE flux_home_keys SET acked_lifecycle_version=3,acked_generation=2 WHERE home_id IN (SELECT home_id FROM flux_home_keys WHERE home_id LIKE 'bulk%' ORDER BY home_id DESC LIMIT 10)");
    await run("UPDATE flux_home_keys SET lifecycle_version=4 WHERE home_id IN (SELECT home_id FROM flux_home_keys WHERE home_id LIKE 'bulk%' ORDER BY home_id LIMIT 5)");
    await sweepFlux(testEnv(), deps);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='flux.resume_undelivered' AND resolved_at IS NOT NULL")).toBe(15);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='flux.resume_undelivered' AND resolved_at IS NULL")).toBe(105);
  });

  it("30. overlap: V+1 raised; OFF and ON before any resolve; the V+3 raise opens a second row; the next pass closes V+1 only, V+3 closes at its ack", async () => {
    await setup(); await stopped(); await capOn();
    clock += 61 * 60_000; await run("UPDATE cloud_homes SET heartbeat_at=? WHERE id=?", clock, HOME);
    await sweepFlux(testEnv(), deps);
    const alerts = () => env.DB.prepare("SELECT subject,resolved_at FROM cloud_alerts WHERE kind='flux.resume_undelivered' ORDER BY subject").all<{ subject: string; resolved_at: number | null }>().then((r) => r.results);
    expect(await alerts()).toEqual([{ subject: "3", resolved_at: null }]);
    expect((await capOff()).status).toBe(200); expect((await capOn()).status).toBe(200);
    clock += 61 * 60_000; await run("UPDATE cloud_homes SET heartbeat_at=? WHERE id=?", clock, HOME);
    await sweepFlux(testEnv(), deps);
    const after = await alerts();
    expect(after.map((a) => [a.subject, a.resolved_at !== null])).toEqual([["3", true], ["5", false]]);
    const d = await due();
    const k = await (await m("subkey", { generation: 1, op_id: d.op_id })).json<{ generation: number }>();
    await m("subkey/ack", { generation: 1, op_id: d.op_id, key_generation: k.generation });
    await sweepFlux(testEnv(), deps);
    expect((await alerts()).map((a) => a.resolved_at !== null)).toEqual([true, true]);
  });

  it.each([
    ["403 (not a generation conflict)", new FluxError(403, "", "billing_hold"), 0],
    ["a non-generation 409", new FluxError(409, "", "stale_cap"), 0],
    ["503 billing_identity_unavailable", new FluxError(503, "", "billing_identity_unavailable"), 0],
    ["status 0", new FluxError(0, "unreachable"), 1],
    ["502", new FluxError(502, ""), 1],
  ])("31. G1: %s journals %i compensation", async (_name, error, expected) => {
    await setup(); await keyed(); await run("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?", clock + DAY, HOME);
    const d = await due();
    flux.mintError = error as FluxError;
    await m("subkey", { generation: 1, op_id: d.op_id });
    expect(await count("SELECT COUNT(*) AS n FROM flux_home_ops WHERE home_id=? AND kind='compensate'", HOME)).toBe(expected);
  });

  it("32. a same-generation retry that gets 409 stale_generation is treated as already landed: moved past once, nothing compensated, the retry mints above it", async () => {
    await setup(); await keyed(); await run("UPDATE flux_home_keys SET key_expires_at=? WHERE home_id=?", clock + DAY, HOME);
    flux.staleByCode = true;
    flux.highestGeneration = 2; // a key at generation 2 already landed (a lost answer); the CP still holds 1 (the router says it by code only)
    const d = await due();
    const res = await m("subkey", { generation: 1, op_id: d.op_id });
    expect(res.status).toBe(200);
    expect((await res.json<{ generation: number }>()).generation).toBe(3);
    expect(flux.mints.at(-1)).toMatchObject({ generation: 3 });
    expect(await count("SELECT COUNT(*) AS n FROM flux_home_ops WHERE home_id=? AND kind='compensate'", HOME)).toBe(0);
    expect(await rowOf()).toMatchObject({ gen_floor: 3, generation: 3 });
  });

  describe("33. a stopped row whose router key is live (2.6a)", () => {
    const resolveRoute = (id: string, body: unknown, token: string | null = ADMIN) => call("POST", `/v1/internal/alerts/${id}/resolve`, token, body);
    const incidents = () => env.DB.prepare("SELECT id,resolved_at FROM cloud_alerts WHERE kind='flux.stopped_key_live' ORDER BY raised_at,id").all<{ id: string; resolved_at: number | null }>().then((r) => r.results);
    const repairOps = () => count("SELECT COUNT(*) AS n FROM flux_home_ops WHERE home_id=? AND kind='stop' AND json_extract(payload,'$.reason')='stopped_live_repair'", HOME);
    const audits = () => count("SELECT COUNT(*) AS n FROM selfservice_audit WHERE action='alert_resolve'");
    const live = () => { flux.statusFor = { state: "ok", capMicrocents: 30_000_000 }; };
    /** a stopped home, key live at the router, the router ahead of the CP (409 stale_lifecycle): one open incident. */
    const incident = async () => {
      await setup(); await stopped(); live();
      flux.lifecycleFloor = 99;
      await sweepFlux(testEnv(), deps);
      const open = (await incidents()).filter((i) => i.resolved_at === null);
      expect(open).toHaveLength(1);
      return open[0].id;
    };

    it("one pass journals exactly one stopped_live_repair Stop at the next lifecycle, drains it; GET reads turning off until the router reports not live, then off", async () => {
      await setup(); await stopped(); live();
      await sweepFlux(testEnv(), deps);
      expect(await repairOps()).toBe(1);
      expect(flux.log.at(-1)).toBe("stop:3");
      expect(await rowOf()).toMatchObject({ state: "stopped", lifecycle_version: 3 });
      expect(await delivery()).toMatchObject({ state: "stopping", stopConfirmed: false });
      routerQuiet();
      expect(await delivery()).toMatchObject({ state: "stopped", stopConfirmed: true });
      await sweepFlux(testEnv(), deps); clock += 20 * 60_000; await sweepFlux(testEnv(), deps);
      expect(await repairOps()).toBe(1); // not live any more: nothing more is sent
    });

    it("fix r1 (Astra H2): grants token absent (revoke-only), a stopped row the router reports live, no Stop open: the sweep sends the repair Stop and raises the incident", async () => {
      await setup(); await stopped(); live();
      extra = { ...extra, FLUX_CLOUD_GRANTS_TOKEN: undefined }; // revocation ready, issuing not
      flux.lifecycleFloor = 99; // the key keeps spending: the router is ahead of the CP and answers the Stop 409 stale_lifecycle
      let stopsSent = 0;
      flux.onStop = async () => { stopsSent++; };
      const mints = flux.mintCalls; const statusHomes = flux.statusHomes.length;
      await sweepFlux(testEnv(), deps);
      expect(flux.statusHomes.slice(statusHomes)).toEqual([HOME]); // the one read the repair needs
      expect(stopsSent).toBe(1);
      expect(await repairOps()).toBe(1);
      expect((await incidents()).filter((i) => i.resolved_at === null)).toHaveLength(1);
      expect(await rowOf()).toMatchObject({ state: "stopped", lifecycle_version: 3 });
      expect([flux.mintCalls, flux.caps]).toEqual([mints, []]); // nothing that issues went out
      // the router no longer ahead: the next eligible pass re-sends the Stop, which lands; the incident stays open for a person
      flux.lifecycleFloor = 0; clock += 20 * 60_000;
      await sweepFlux(testEnv(), deps);
      expect(flux.log.at(-1)).toBe("stop:4");
      expect((await incidents()).filter((i) => i.resolved_at === null)).toHaveLength(1);
    });

    it("fix r1 (Grok Low): the repair's own drain sees its Stop pending, a later drain fails it: the incident opens", async () => {
      await setup(); await stopped(); live();
      // another holder takes the lease right as the repair Stop is journaled, so the repair's own drain cannot send it (pending, no attempt)
      armDb(/state='stopped'\s+AND NOT EXISTS \(SELECT 1 FROM flux_home_ops WHERE home_id=\? AND kind='stop'/, async () => {
        await run("UPDATE flux_home_keys SET op_holder='other',op_lease_until=? WHERE home_id=?", clock + 1_000, HOME);
      });
      await sweepFlux(testEnv(), deps);
      expect(await repairOps()).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM flux_home_ops WHERE home_id=? AND kind='stop' AND state='queued' AND attempts=0", HOME)).toBe(1);
      expect(await incidents()).toEqual([]);
      // the lease expires; the general drain sends the Stop and it fails at the router
      clock += 20 * 60_000; flux.stopDown = true;
      await sweepFlux(testEnv(), deps);
      expect(await count("SELECT COUNT(*) AS n FROM flux_home_ops WHERE home_id=? AND kind='stop' AND state='queued' AND attempts>0", HOME)).toBe(1);
      expect((await incidents()).filter((i) => i.resolved_at === null)).toHaveLength(1);
      // a further failed drain adds no second incident while one is open
      clock += 20 * 60_000;
      await sweepFlux(testEnv(), deps);
      expect(await incidents()).toHaveLength(1);
    });

    it("a Stop already open is skipped; more homes than the batch are all visited, oldest stop_checked_at first", async () => {
      await setup(); await stopped(); live();
      await run(`INSERT INTO flux_home_ops (op_id,home_id,seq,kind,payload,state,created_at,updated_at)
        VALUES ('open-stop',?,(SELECT COALESCE(MAX(seq),0)+1 FROM flux_home_ops),'stop',json_object('version',2,'reason','stop'),'queued',1,1)`, HOME);
      flux.stopDown = true; // the open Stop cannot go out in this test
      await sweepFlux(testEnv(), deps);
      expect(await repairOps()).toBe(0);
      expect(flux.statusHomes).not.toContain(HOME);
      flux.stopDown = false;
      await run("DELETE FROM flux_home_ops WHERE op_id='open-stop'");
      await run("UPDATE flux_home_keys SET state='active' WHERE home_id=?", HOME);
      await run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<12)
        INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,updated_at,lifecycle_version) SELECT 'stp-'||i,'starter',1,'stopped',30000000,0,1,2 FROM n`);
      await sweepFlux(testEnv(), deps);
      expect(await count("SELECT COUNT(*) AS n FROM flux_home_keys WHERE home_id LIKE 'stp-%' AND stop_checked_at IS NOT NULL")).toBe(spendingOffPollBatch(12));
      await sweepFlux(testEnv(), deps);
      expect(await count("SELECT COUNT(*) AS n FROM flux_home_keys WHERE home_id LIKE 'stp-%' AND stop_checked_at IS NOT NULL")).toBe(12);
      expect(await count("SELECT COUNT(*) AS n FROM flux_home_ops WHERE home_id LIKE 'stp-%' AND kind='stop' AND json_extract(payload,'$.reason')='stopped_live_repair'")).toBe(12);
    });

    it("a router 409 stale_lifecycle, or a failed Stop: the incident opens once (one per home); the repair keeps being re-sent each pass; no second Stop within one pass", async () => {
      await setup(); await stopped(); live();
      flux.lifecycleFloor = 99; // the router is ahead of the CP
      await sweepFlux(testEnv(), deps);
      expect(await incidents()).toHaveLength(1);
      expect(await repairOps()).toBe(1);
      clock += 20 * 60_000;
      await sweepFlux(testEnv(), deps);
      expect(await repairOps()).toBe(2); // re-sent, one per pass
      expect(await incidents()).toHaveLength(1); // cloud_alerts_open: no second row while one is open
    });

    it("the incident is closed by nothing but an operator: not a sweep, a router read, a resume, a Stop, an OFF or a hold", async () => {
      const id = await incident();
      const stillOpen = async () => expect((await incidents()).filter((i) => i.resolved_at === null).map((i) => i.id)).toEqual([id]);
      flux.lifecycleFloor = 3; routerQuiet();
      clock += 20 * 60_000; await sweepFlux(testEnv(), deps); await stillOpen();
      await getStatus(); await stillOpen();
      expect((await capOn()).status).toBe(200); await stillOpen();
      expect((await ownerStopCall()).status).toBeLessThan(300); await stillOpen();
      expect((await capOff()).status).toBe(200); await stillOpen();
      await run("UPDATE flux_home_keys SET billing_hold=1,billing_hold_at=? WHERE home_id=?", clock, HOME);
      clock += 20 * 60_000; await sweepFlux(testEnv(), deps); await stillOpen();
    });

    it("the operator resolve: admin only; by and reason; resolves once; one audit row whose at equals resolved_at; the Monday review counts it", async () => {
      const id = await incident();
      const body = { by: "sean", reason: "Flux reports the key stopped" };
      expect((await resolveRoute(id, body, null)).status).toBe(401);
      expect((await resolveRoute(id, body, "wrong-admin-token-0123456789abcdef")).status).toBe(401);
      expect(await audits()).toBe(0);
      const bad = [{}, { by: "sean" }, { reason: "r" }, { by: " ", reason: "r" }, { by: "sean", reason: "  " }, { by: "x".repeat(81), reason: "r" },
        { by: "sean", reason: "r".repeat(501) }, { by: 7, reason: "r" }, { by: "sean", reason: ["r"] }, { by: "sean", reason: "r", extra: 1 }];
      for (const b of bad) {
        const res = await resolveRoute(id, b);
        expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([400, "invalid_request"]);
      }
      expect(await audits()).toBe(0);
      expect((await incidents())[0].resolved_at).toBeNull();
      const ok = await resolveRoute(id, body);
      expect([ok.status, await ok.json()]).toEqual([200, { resolved: true, alertId: id, resolvedAt: clock }]);
      const audit = await env.DB.prepare("SELECT home_id,actor,outcome,detail,at FROM selfservice_audit WHERE action='alert_resolve'").all<{ home_id: string; actor: string; outcome: string; detail: string; at: number }>();
      expect(audit.results).toHaveLength(1);
      expect(audit.results[0]).toMatchObject({ home_id: HOME, actor: "operator", outcome: "resolved", at: clock });
      expect(JSON.parse(audit.results[0].detail)).toEqual({ alertId: id, kind: "flux.stopped_key_live", by: "sean", reason: "Flux reports the key stopped" });
      expect((await incidents())[0].resolved_at).toBe(clock);
      const again = await resolveRoute(id, body);
      expect([again.status, (await again.json<{ error: string }>()).error]).toEqual([409, "already_resolved"]);
      expect(await audits()).toBe(1);
      expect((await incidents())[0].resolved_at).toBe(clock);
      expect((await weeklyReviewLines(testEnv(), clock)).join("\n")).toMatch(/flux\.stopped_key_live: fired 1, .*action recorded on 1/);
      const unknown = await resolveRoute("no-such-alert", body);
      expect(unknown.status).toBe(404);
    });

    it("another kind sent to the resolve route: 409 wrong_kind, the row stays open and unchanged, no audit row", async () => {
      await setup();
      await run("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject) VALUES ('other-1',?,'flux.resume_undelivered','high','{}',?,'3')", HOME, clock);
      const res = await resolveRoute("other-1", { by: "sean", reason: "r" });
      expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([409, "wrong_kind"]);
      expect(await env.DB.prepare("SELECT resolved_at FROM cloud_alerts WHERE id='other-1'").first()).toEqual({ resolved_at: null });
      expect(await audits()).toBe(0);
    });

    it("after an operator resolve the key going live again opens a NEW incident; the old one stays resolved; the re-send continues", async () => {
      const id = await incident();
      expect((await resolveRoute(id, { by: "sean", reason: "checked" })).status).toBe(200);
      clock += 20 * 60_000;
      await sweepFlux(testEnv(), deps);
      const all = await incidents();
      expect(all).toHaveLength(2);
      expect(all.filter((i) => i.resolved_at === null)).toHaveLength(1);
      expect(all.find((i) => i.id === id)!.resolved_at).not.toBeNull();
      expect(all.find((i) => i.resolved_at === null)!.id).not.toBe(id);
    });
  });

  describe("34. the repair against an owner resume (2.6a race)", () => {
    it("repair first: a resume at V+1 goes to V+2 and the router sees Stop V+1 before mint V+2 (the pinned 403 half is in step-up-email.test.ts)", async () => {
      await setup(); flux.strictStop = true; await stopped(); flux.statusFor = { state: "ok", capMicrocents: 30_000_000 };
      flux.stopDown = true; // the repair Stop is journaled at V+1 = 3 and cannot go out yet
      await sweepFlux(testEnv(), deps);
      expect(await rowOf()).toMatchObject({ state: "stopped", lifecycle_version: 3 });
      expect((await capOn()).status).toBe(200);
      expect(await rowOf()).toMatchObject({ state: "active", lifecycle_version: 4, resume_lv: 4 });
      const d = await due();
      const held = await m("subkey", { generation: 1, op_id: d.op_id });
      expect([held.status, (await held.json<{ error: string }>()).error]).toEqual([429, "renewal_retry_later"]);
      flux.stopDown = false; routerQuiet();
      expect((await m("subkey", { generation: 1, op_id: d.op_id })).status).toBe(200);
      expect(flux.log.filter((e) => /^(stop|mint):/.test(e)).slice(-2)).toEqual(["stop:3", "mint:4"]);
    });
    it("resume committed first, then the repair: 0 rows, no Stop op; the repair selected, then the resume commits, then the repair writes: 0 rows", async () => {
      await setup(); await stopped(); flux.statusFor = { state: "ok", capMicrocents: 30_000_000 };
      armDb(/stopped_live_repair|SET state=CASE WHEN state='stopped'/, async () => { expect((await capOn()).status).toBe(200); }); // the resume lands between the status read and the repair write
      await sweepFlux(testEnv(), deps);
      expect(await rowOf()).toMatchObject({ state: "active", lifecycle_version: 3, resume_lv: 3 });
      expect(await count("SELECT COUNT(*) AS n FROM flux_home_ops WHERE home_id=? AND json_extract(payload,'$.reason')='stopped_live_repair'", HOME)).toBe(0);
    });
  });

  describe("35. cost of the stopped class", () => {
    it.each([30, 1200, 10_000])("%i stopped homes: one hour of sweeps makes 12 x batch status reads (capped at 1,200), each home read at most once an hour until all are read", async (N) => {
      await setup(); routerQuiet();
      await run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,updated_at,lifecycle_version) SELECT 'stp-'||i,'starter',1,'stopped',30000000,0,1,2 FROM n`, N);
      const batch = spendingOffPollBatch(N);
      const start = clock;
      for (let pass = 0; pass < 12; pass++) { await sweepFlux(testEnv(), deps); clock += 5 * 60_000; }
      const reads = flux.statusHomes.filter((h) => h.startsWith("stp-"));
      expect(reads.length).toBe(Math.min(12 * batch, 1200));
      if (N >= 1200) expect(new Set(reads).size).toBe(reads.length); // fewer than one read a home an hour
      const oldest = (await env.DB.prepare("SELECT MIN(COALESCE(stop_checked_at,0)) AS t FROM flux_home_keys WHERE home_id LIKE 'stp-%'").first<{ t: number }>())!.t;
      if (N <= 1200) expect(clock - 5 * 60_000 - oldest).toBeLessThanOrEqual(spendingOffMaxStalenessMs(N));
      if (N > 1200) {
        // Fix r3 (Grok Low): beyond 1,200 homes the hour does not cover the cohort; keep sweeping until every home is read once, and that
        // takes no longer than spendingOffMaxStalenessMs(N), with no home read twice before all are read.
        let last = clock - 5 * 60_000;
        for (let pass = 12; pass < 400 && await count("SELECT COUNT(*) AS n FROM flux_home_keys WHERE home_id LIKE 'stp-%' AND stop_checked_at IS NULL") > 0; pass++) {
          last = clock; await sweepFlux(testEnv(), deps); clock += 5 * 60_000;
        }
        expect(await count("SELECT COUNT(*) AS n FROM flux_home_keys WHERE home_id LIKE 'stp-%' AND stop_checked_at IS NULL")).toBe(0);
        const all = flux.statusHomes.filter((h) => h.startsWith("stp-"));
        expect(new Set(all).size).toBe(N);
        expect(all.length).toBe(N);
        expect(last - start).toBeLessThanOrEqual(spendingOffMaxStalenessMs(N));
      }
    }, 600_000);
    it("the spending-off class keeps its own batch: both classes run each pass", async () => {
      await setup(); routerQuiet();
      await run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50)
        INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,updated_at,lifecycle_version,spending_off,spending_off_at,stop_checked_at) SELECT 'off-'||i,'starter',1,'stopped',30000000,0,1,2,1,1,? FROM n`, clock);
      await run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<30)
        INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,updated_at,lifecycle_version) SELECT 'stp-'||i,'starter',1,'stopped',30000000,0,1,2 FROM n`);
      await sweepFlux(testEnv(), deps);
      expect(flux.statusHomes.filter((h) => h.startsWith("stp-")).length).toBe(spendingOffPollBatch(80));
      expect(flux.statusHomes.filter((h) => h.startsWith("off-")).length).toBe(spendingOffPollBatch(50)); // the spending-off class, from its own batch
    });
  });

  it("alert tiers: both new kinds are pages with their own groups and a plain action", () => {
    for (const [kind, group, action] of [
      ["flux.resume_undelivered", "flux.resume_stuck",
        "Open the home in admin. It is online and its poller has not taken a key for an hour. Check the poller log for renewal-due and subkey answers, then Flux status."],
      ["flux.stopped_key_live", "flux.stop_unenforced",
        "Open the home in admin and check Flux status for the key. The sweep re-sends the Stop each pass. Resolve this alert only when Flux reports stopped or revoked for the key, or the customer turned spending back on and Flux shows the current generation. Anything else, or Flux ahead of the CP lifecycle: tell FluxMain."],
    ] as const) {
      expect(alertTier(kind)).toMatchObject({ tier: "page", group, action });
    }
  });
});
