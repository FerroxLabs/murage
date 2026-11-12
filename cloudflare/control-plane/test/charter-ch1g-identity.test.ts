// SPDX-License-Identifier: AGPL-3.0-or-later
// CH1-G (Astra ch1-f r1 M1, M2, M3): invite admission reads Supabase's live address once per request, invite-checks THAT address, and writes only
// under the revision it read against. Barriers are deterministic (a held Supabase answer, or a D1 trigger standing in for the concurrent writer Y).
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { carryBinding, createIdentity } from "../src/customer-identity";

const REF_ORIGIN = "https://testref.supabase.co";
const ISS = `${REF_ORIGIN}/auth/v1`;
const SUB = "7b2e3d40-5c6f-4a71-8bcd-2e3f4a5b6c7d";
const EMAIL = "owner@example.test";
const ROUTES = ["/v1/billing/reserve", "/v1/billing/checkout", "/v1/billing/checkout/resume"];
const NEW_EMAIL = "moved@example.test";

const b64u = (b: ArrayBuffer | string) => Buffer.from(typeof b === "string" ? Buffer.from(b) : new Uint8Array(b)).toString("base64url");
let ec: CryptoKeyPair;
let jwks: { keys: Record<string, unknown>[] };
let signingJwk: JsonWebKey;
beforeAll(async () => {
  ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", ec.publicKey) as Record<string, unknown>), kid: "ec-1", alg: "ES256", use: "sig" }] };
  const b3 = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  signingJwk = await crypto.subtle.exportKey("jwk", b3.privateKey);
});
const factorOf = (sub: string) => `${sub.slice(0, 24)}000000000f01`;
async function token(sub: string, email: string, over: Record<string, unknown> = {}) {
  const at = Math.floor(Date.now() / 1000);
  const c = { iss: ISS, aud: "authenticated", exp: at + 3600, iat: at - 5, sub, email, role: "authenticated", is_anonymous: false,
    app_metadata: { provider: "email", email_verified: true }, user_metadata: {}, session_id: `sess-${sub}`,
    mfa_factor_id: factorOf(sub), aal: "aal1", amr: [{ method: "password", timestamp: at - 5 }], ...over };
  const input = `${b64u(JSON.stringify({ alg: "ES256", kid: "ec-1", typ: "JWT" }))}.${b64u(JSON.stringify(c))}`;
  return `${input}.${b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, new TextEncoder().encode(input)))}`;
}
const jwksFetch = (async () => Response.json(jwks)) as typeof fetch;
/** Supabase Auth's CURRENT confirmed address, independent of the token's (null: follow the token). */
let authEmail: string | null = null;
/** CH1 P1: when set, the Nth Supabase Auth read answers seq[N] (the last entry for every later read), so a confirmed-address change BETWEEN two reads is exercised. */
let authSeq: string[] | null = null;
let authCalls = 0;
/** The factors Supabase Auth lists for the account (null: the one verified TOTP factor the token names). */
let authFactors: { id: string; factor_type: string; status: string; friendly_name: string }[] | null = null;
/** Barrier: called after the Nth Supabase read has computed its answer and before it is returned (n is 0-based). */
let authHold: ((n: number) => Promise<void>) | null = null;
const authFetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
  const bearer = new Headers(init?.headers).get("authorization")!.slice("Bearer ".length);
  const c = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()) as { sub: string; email: string };
  const answer = authSeq ? authSeq[Math.min(authCalls, authSeq.length - 1)] : (authEmail ?? c.email);
  const n = authCalls++;
  if (authHold) await authHold(n);
  return Response.json({ id: c.sub, email: answer, email_confirmed_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    factors: authFactors ?? [{ id: factorOf(c.sub), factor_type: "totp", status: "verified", friendly_name: "" }] });
}) as typeof fetch;
const workerAt = () => createWorker(fetch, fetch, {}, {}, {}, { jwksFetch, authFetch });

const OPEN_ENV = { CLOUD_B3_MODE: "fake", STRIPE_SECRET_KEY: ["sk_test_", "abcdefgh", "ijklmnop"].join(""), STRIPE_WEBHOOK_SECRET: "whsec_abcdefghij",
  STRIPE_PRICE_STARTER: "price_AAAAAAAA", STRIPE_PRICE_PRO: "price_BBBBBBBB", STRIPE_PRICE_MAX: "price_CCCCCCCC", BILLING_RETURN_ORIGIN: "https://cloud.murage.test",
  REFUND_KEY_SECRET: undefined, CLOUD_KEK_V1: btoa("k".repeat(32)),
  CLOUD_B3_CONFIG: JSON.stringify({ reservationMs: 1_800_000, graceMs: 259_200_000, retentionMs: 2_592_000_000, imageDigest: `sha256:${"a".repeat(64)}`,
    engineSubscriptionGates: { claudeAgent: true, codex: true, grokAgent: true, kimiAgent: true, opencodeGo: true }, quarantineRelayIP: "192.0.2.1", capacity: [] }),
  CLOUD_HOME_HOST_SUFFIX: "murage.test", CLOUD_HOME_ZONE_ID: "0".repeat(32), CLOUD_HOME_ACCOUNT_ID: "0".repeat(32), CLOUD_HOME_API_TOKEN: "test-only-cloud-home-token-no-access" };

/** The rig env with CLOUD_SALES_OPEN set to `mode`, or, when `mode` is "UNSET", with the key REMOVED from the object (not "" and not undefined). */
function envWith(mode: string, db: D1Database = env.DB): Env {
  const e: Record<string, unknown> = { ...env, CLOUD_B3_SIGNING_JWK: JSON.stringify(signingJwk), SUPABASE_URL: REF_ORIGIN,
    SUPABASE_PUBLISHABLE_KEY: ["sb_publi", "shable_t", "estkey_0", "12345678", "9abcdef"].join(""), MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined, ...OPEN_ENV, DB: db };
  if (mode === "UNSET") delete e.CLOUD_SALES_OPEN; else e.CLOUD_SALES_OPEN = mode;
  return e as unknown as Env;
}
async function post(path: string, bearerToken: string, e: Env) {
  const ctx = createExecutionContext();
  const res = await workerAt().fetch(new Request(`https://auth.murage.test${path}`, { method: "POST",
    headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json" }, body: "{}" }), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
async function signIn(sub: string, email: string) {
  const t = await token(sub, email);
  const ctx = createExecutionContext();
  const res = await workerAt().fetch(new Request("https://auth.murage.test/v1/account/terms", { headers: { authorization: `Bearer ${t}` } }), envWith("true"), ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return t;
}
/** Every table's full content, so ANY new or changed row (not only homes and intents) fails the comparison. */
async function snapshot(): Promise<Record<string, unknown[]>> {
  const names = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>()).results;
  const out: Record<string, unknown[]> = {};
  for (const { name } of names) out[name] = (await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results;
  return out;
}


const A = "stored-a@example.test", B = "token-b@example.test", C = "current-c@example.test";
const invite = (email: string) => env.DB.prepare("INSERT INTO sales_invites (email,added_at,added_by,note) VALUES (?,?,?,NULL)").bind(email, 1, "sean").run();
const revisionOf = async () => (await env.DB.prepare("SELECT email_revision AS r FROM supabase_identities WHERE sub=?").bind(SUB).first<{ r: number }>())!.r;
const storedOf = async () => (await env.DB.prepare("SELECT contact_email AS e FROM supabase_identities WHERE sub=?").bind(SUB).first<{ e: string }>())?.e ?? null;
const movedEvents = async () => (await env.DB.prepare("SELECT email FROM account_link_events WHERE sub=? AND kind='email_updated'").bind(SUB).all<{ email: string }>()).results.map((r) => r.email);
const errorOf = async (res: Response) => ((await res.clone().json().catch(() => ({}))) as { error?: string }).error;
/** Everything except the one revision counter of the mapping row (the concurrent writer's own bumps), so "nothing else changed" is exact. */
function withoutRevision(s: Record<string, unknown[]>): Record<string, unknown[]> {
  return { ...s, supabase_identities: (s.supabase_identities as Record<string, unknown>[]).map((r) => ({ ...r, email_revision: 0 })) };
}
afterEach(async () => {
  authSeq = null; authEmail = null; authHold = null; authFactors = null;
  for (const t of ["g_bump_after_event", "g_steal_token"]) await env.DB.exec(`DROP TRIGGER IF EXISTS ${t}`);
});
/** env.DB whose move batch (four statements: the swap, the alert resolve, the marker, the event) first runs `hook()`, the first `times` times: a concurrent
 *  writer commits between this request's read of the revision and its compare-and-swap, so the swap is a genuine miss. */
function dbBeforeMoveBatch(times: number, hook: () => Promise<void>): D1Database {
  let left = times;
  // The worker reaches D1 through a session (withSession), so the session is wrapped the same way.
  const wrap = <T extends object>(target: T): T => new Proxy(target, { get(t, k) {
    if (k === "batch") return async (stmts: D1PreparedStatement[]) => { if (stmts.length === 4 && left > 0) { left--; await hook(); } return (t as unknown as D1Database).batch(stmts); };
    if (k === "withSession") return (...a: unknown[]) => wrap((t as unknown as D1Database).withSession(...(a as [])) as unknown as object);
    const v = Reflect.get(t, k, t);
    return typeof v === "function" ? v.bind(t) : v;
  } });
  return wrap(env.DB);
}
/** env.DB (and every session of it) with two barriers: `beforeRead(sql)` runs before a statement's first/run/all, `afterBatch(sqls)` after a batch has COMMITTED
 *  (so a concurrent writer lands between this request's commit and its next step). Statements keep their SQL so the barrier can pick the one it wants. */
interface DbHooks { beforeRead?: (sql: string) => Promise<void>; beforeBatch?: (sqls: string[]) => Promise<void>; afterBatch?: (sqls: string[]) => Promise<void> }
function dbWithHooks(h: DbHooks): D1Database {
  type Stmt = D1PreparedStatement & { __real?: D1PreparedStatement; __sql?: string };
  const wrapStmt = (stmt: D1PreparedStatement, sql: string): Stmt => new Proxy(stmt as Stmt, { get(t, k) {
    if (k === "__real") return t;
    if (k === "__sql") return sql;
    if (k === "bind") return (...a: unknown[]) => wrapStmt(t.bind(...a), sql);
    if (k === "run" || k === "first" || k === "all" || k === "raw") return async (...a: unknown[]) => { await h.beforeRead?.(sql); return (t as unknown as Record<string, (...x: unknown[]) => unknown>)[k as string](...a); };
    const v = Reflect.get(t, k, t);
    return typeof v === "function" ? v.bind(t) : v;
  } });
  const wrap = <T extends object>(target: T): T => new Proxy(target, { get(t, k) {
    if (k === "prepare") return (sql: string) => wrapStmt((t as unknown as D1Database).prepare(sql), sql);
    if (k === "batch") return async (stmts: Stmt[]) => {
      await h.beforeBatch?.(stmts.map((x) => x.__sql ?? ""));
      const res = await (t as unknown as D1Database).batch(stmts.map((x) => x.__real ?? x));
      await h.afterBatch?.(stmts.map((x) => x.__sql ?? ""));
      return res;
    };
    if (k === "withSession") return (...a: unknown[]) => wrap((t as unknown as D1Database).withSession(...(a as [])) as unknown as object);
    const v = Reflect.get(t, k, t);
    return typeof v === "function" ? v.bind(t) : v;
  } });
  return wrap(env.DB);
}
const bumpRevision = () => env.DB.prepare("UPDATE supabase_identities SET email_revision=email_revision+1 WHERE sub=?").bind(SUB).run().then(() => undefined);
const reset = () => { authSeq = null; authEmail = null; authHold = null; authFactors = null; authCalls = 0; };

const FACTOR_AGE = 5;
/** An account that exists (mapped at `email`), owns a ready home (so no purchase bootstrap applies), and trusts its TOTP factor: the step-up gate reads LIVE factors. */
async function stepRig(email: string) {
  reset();
  await signIn(SUB, email); await invite(email);
  const u = await userIdOf();
  for (const h of ["home-a", "home-b", "home-c"]) await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
    VALUES (?,?,?,'ready','ready',?,'k',0,0)`).bind(h, crypto.randomUUID(), u, `sha256:${"a".repeat(64)}`).run();
  await env.DB.prepare("INSERT INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state) VALUES (?,?,'totp','email_code',0,0,'active')")
    .bind(u, factorOf(SUB)).run();
}
const aal2 = (email: string) => { const n = Math.floor(Date.now() / 1000); return token(SUB, email, { aal: "aal2", mfa_factor_id: factorOf(SUB),
  amr: [{ method: "totp", timestamp: n - FACTOR_AGE }, { method: "otp", timestamp: n - 3000 }] }); };
/** What POST /v1/billing/checkout answers, with an empty body, for a request that PASSED the invite and step-up gates: the handler's own body validation. */
const GATE_PASSED = { status: 400, error: "invalid_request" } as const;
/** One purchase request through the whole worker with live address `live`. trusted: an aal2 token that just verified the trusted TOTP factor (the gate asks for LIVE factors); otherwise aal1. */
async function gateRaw(live: string, trusted: boolean) {
  authEmail = live; authCalls = 0;
  const res = await post("/v1/billing/checkout", trusted ? await aal2(B) : await token(SUB, B), envWith("invite"));
  const body = (await res.clone().json().catch(() => ({}))) as { error?: string; step_up?: { reason?: string } };
  return { res, body, calls: authCalls };
}
/** "passed" ONLY for the exact downstream answer of a request that cleared both gates (GATE_PASSED); every other status, including an unrelated 401, 500 or 503, is reported as
 *  `other:<status>:<error>` so it fails the assertion instead of counting as a pass. */
async function gateRun(live: string, trusted: boolean) {
  const { res, body, calls } = await gateRaw(live, trusted);
  const status = res.status === 403 && body.error === "step_up_required" ? "step_up_required"
    : res.status === 403 && body.error === "not_invited" ? "not_invited"
    : res.status === GATE_PASSED.status && body.error === GATE_PASSED.error ? "passed"
    : `other:${res.status}:${body.error ?? ""}`;
  return { status, calls };
}
const intentState = async (id: string) => (await env.DB.prepare("SELECT state FROM cloud_stepup_intents WHERE id=?").bind(id).first<{ state: string }>())?.state ?? null;
/** The real approved-intent claim (step-up-email.ts claim) for `home`: the aal1 request is refused with a frozen intent, the intent is approved (the emailed code's effect, set
 *  directly), then the request is resent with stepUpIntentId. `liveAtClaim` is Supabase's address when the claim request arrives. */
async function claimRun(liveAtClaim: string, home: string) {
  authEmail = B; authCalls = 0;
  const t = await token(SUB, B);
  const body = { home };
  // CH1-G: the claim step's own Supabase reads. The claim begins when the named intent is loaded (loadIntent, after admission); every Supabase Auth read counted
  // from that statement on belongs to the claim, and the claim must make none: it consumes the admission the request carries.
  let claimStartedAt: number | null = null;
  const db = dbWithHooks({ beforeRead: async (sql) => {
    if (call.extra && claimStartedAt === null && sql.includes("FROM cloud_stepup_intents WHERE id=? AND user_id=? AND session_id=?")) claimStartedAt = authCalls;
  } });
  const call = async () => {
    const ctx = createExecutionContext();
    const res = await workerAt().fetch(new Request("https://auth.murage.test/v1/billing/checkout/resume", { method: "POST",
      headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify(call.extra ? { ...body, stepUpIntentId: call.extra } : body) }), envWith("invite", db), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  call.extra = "";
  const refused = await call();
  expect(refused.status).toBe(403);
  const intent = ((await refused.json()) as { step_up: { email_code: { intent_id: string } } }).step_up.email_code.intent_id;
  const now = Date.now();
  await env.DB.prepare("UPDATE cloud_stepup_intents SET state='approved', email=?, email_gen='2026-10-01T00:00:00Z', approved_at=?, grant_expires_at=?, expires_at=? WHERE id=?")
    .bind(B, now, now + 600_000, now + 1_800_000, intent).run();
  authEmail = liveAtClaim; authCalls = 0;
  call.extra = intent;
  const before = await snapshot();
  const log = vi.spyOn(console, "log");
  const res = await call();
  const claimed = log.mock.calls.some((c) => String(c[0]).includes("step-up approval claimed"));
  log.mockRestore();
  return { status: res.status, error: await errorOf(res), claimed, state: await intentState(intent), calls: authCalls, before, after: await snapshot(),
    claimReached: claimStartedAt !== null, admissionReads: claimStartedAt, claimReads: claimStartedAt === null ? null : authCalls - claimStartedAt };
}

describe("CH1-G M1: the invite check sees Supabase's live address on EVERY invite-gated request", () => {
  it("T1 stored B == token B (invited), live C uninvited: 403 not_invited with zero changed rows in every table", async () => {
    reset();
    await signIn(SUB, B); await invite(B);
    const t = await token(SUB, B);
    authEmail = C; authCalls = 0;
    const before = await snapshot();
    const res = await post("/v1/billing/reserve", t, envWith("invite"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_invited" });
    expect(await snapshot()).toEqual(before);
  });
  it("T2 unmapped subject, token B (invited), live C uninvited: 403 not_invited and zero rows", async () => {
    reset();
    await invite(B);
    const t = await token(SUB, B);
    authEmail = C; authCalls = 0;
    const before = await snapshot();
    const res = await post("/v1/billing/reserve", t, envWith("invite"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_invited" });
    expect(await snapshot()).toEqual(before);
  });
  it("T5 step-up path, stored B == token B, live C uninvited: 403 not_invited before any step-up write, ONE Supabase read, zero rows", async () => {
    reset();
    await signIn(SUB, B); await invite(B);
    const t = await token(SUB, B);          // aal1: the purchase would need a step-up
    authEmail = C; authCalls = 0;
    const before = await snapshot();
    const res = await post("/v1/billing/checkout", t, envWith("invite"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_invited" });
    expect(authCalls).toBe(1);
    expect(await snapshot()).toEqual(before);
  });
  it("T5b an invited live address: the TRUSTED aal2 gate (live factors) and an approved-intent claim each reuse the admission's read: ONE Supabase read per request, and aal1 is still refused", async () => {
    await stepRig(B);
    expect(await gateRun(B, true)).toEqual({ status: "passed", calls: 1 });
    expect(await gateRun(B, false)).toEqual({ status: "step_up_required", calls: 1 });
    const claimed = await claimRun(B, "home-a");
    expect(claimed).toMatchObject({ claimed: true, calls: 1 });
    // the claim itself reads nothing: the one read was the request's admission, made before the claim began
    expect(claimed).toMatchObject({ claimReached: true, admissionReads: 1, claimReads: 0 });
  });
});

describe("CH1-G M1b: an aal2 token is accepted only while its factor is LIVE and verified in Supabase", () => {
  it("T5c aal2 token for the trusted factor, but Supabase lists that factor as missing or unverified: refused 403 step_up_required (untrusted_factor), ONE read; with it verified the gate accepts", async () => {
    await stepRig(B);
    expect(await gateRun(B, true)).toEqual({ status: "passed", calls: 1 });
    for (const factors of [[], [{ id: factorOf(SUB), factor_type: "totp", status: "unverified", friendly_name: "" }]]) {
      authFactors = factors;
      const { res, body, calls } = await gateRaw(B, true);
      expect([res.status, body.error, body.step_up?.reason, calls]).toEqual([403, "step_up_required", "untrusted_factor", 1]);
    }
    authFactors = null;
    expect(await gateRun(B, true)).toEqual({ status: "passed", calls: 1 });
  });
});

describe("CH1-G M2: a live read is applied only to the revision it was read against", () => {
  async function runX(c: string, invitedC: boolean) {
    reset();
    await signIn(SUB, A); await invite(B); if (invitedC) await invite(c);
    const x = await token(SUB, B);
    authSeq = [B, c]; authCalls = 0;
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // A barrier that is never reached fails the test (red) instead of hanging it.
    const reached = Promise.race([new Promise<void>((r) => { entered = r; }), new Promise<void>((_, no) => setTimeout(() => no(new Error("barrier not reached")), 4000))]);
    authHold = async (n) => { if (n === 0) { entered(); await held; } };
    const xp = post("/v1/billing/reserve", x, envWith("invite"));
    await reached;                                       // X has read r0 and live B
    // Y commits C (r0 + 1) while X is held
    await env.DB.prepare("UPDATE supabase_identities SET contact_email=?, email_revision=email_revision+1 WHERE sub=?").bind(c, SUB).run();
    const afterY = await snapshot();
    release();
    return { res: await xp, afterY };
  }
  it("T3a Y commits uninvited C while X holds live B: X reruns, reads C and is refused; X wrote nothing and the stored address stays C", async () => {
    const { res, afterY } = await runX(C, false);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_invited" });
    expect(await storedOf()).toBe(C);
    expect(await snapshot()).toEqual(afterY);
  });
  it("T3b Y commits INVITED C while X holds live B: X reruns and admits C; B is never written over C", async () => {
    const { res } = await runX(C, true);
    expect(await errorOf(res)).not.toBe("not_invited");
    expect(await storedOf()).toBe(C);
    expect(await movedEvents()).not.toContain(B);
  });
});

describe("CH1-G M3: the email_updated event is inside the batch, and a moved revision after commit answers 503", () => {
  const bumpAfterEvent = () => env.DB.exec(
    "CREATE TRIGGER g_bump_after_event AFTER INSERT ON account_link_events WHEN NEW.kind='email_updated' BEGIN UPDATE supabase_identities SET email_revision=email_revision+1 WHERE sub=NEW.sub; END");
  it("T4 concurrent writer Y moves the revision after X's unit commits: X answers 503 (not 403), makes no further read, and its unit is COMPLETE (address, revision, ONE event, the old page resolved, the new marker)", async () => {
    reset();
    await signIn(SUB, A); await invite(B);
    const u = await userIdOf(); const r = await revisionOf();
    await seedAlert(u, r); await seedMarker(u, r);
    const t = await token(SUB, B);
    authSeq = [B, C]; authCalls = 0;                     // a second read would answer uninvited C
    await bumpAfterEvent();
    const res = await post("/v1/billing/reserve", t, envWith("invite"));
    expect(res.status).toBe(503);
    expect(authCalls).toBe(1);
    expect(await storedOf()).toBe(B);
    expect(await revisionOf()).toBe(r + 2);              // X's move + Y's bump
    expect(await movedEvents()).toEqual([B]);
    expect(await alertOpen(u, r)).toBe(false);           // the alert of the old revision is resolved by X's own unit
    expect(await markersAt(u, r + 1)).toBe(1);           // and the marker of the new revision is carried
  });
  it("T4b a CAS miss changes zero rows in EVERY table, and the rerun then writes exactly one event", async () => {
    reset();
    await signIn(SUB, A); await invite(B);
    const u = await userIdOf(); const r = await revisionOf();
    await seedAlert(u, r); await seedMarker(u, r);
    const t = await token(SUB, B);
    authEmail = B; authCalls = 0;
    const seen: Record<string, unknown[]>[] = [];
    let afterY: Record<string, unknown[]> | null = null;
    authHold = async (n) => { if (n === 1) seen.push(await snapshot()); };   // at the rerun's read the missed attempt has left nothing in any table
    // Y wins the race for revision r between X's read and X's swap: the swap changes nothing.
    const res = await post("/v1/billing/reserve", t, envWith("invite", dbBeforeMoveBatch(1, async () => { await bumpRevision(); afterY = await snapshot(); })));
    expect(await errorOf(res)).not.toBe("not_invited");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(afterY);                      // EVERY table identical to what Y left
    expect(authCalls).toBe(2);
    expect(await storedOf()).toBe(B);
    expect(await movedEvents()).toEqual([B]);
  });
  it("T8 X answers 503 after its batch committed; retrying X SUCCEEDS the purchase and the event table holds exactly one event for X's move", async () => {
    reset();
    await signIn(SUB, A); await invite(B);
    const t = await token(SUB, B);
    authSeq = [B]; authCalls = 0;
    await bumpAfterEvent();
    const first = await post("/v1/billing/reserve", t, envWith("invite"));
    expect(first.status).toBe(503);
    await env.DB.exec("DROP TRIGGER g_bump_after_event");
    authCalls = 0;
    const retry = await post("/v1/billing/reserve", t, envWith("invite"));
    expect(retry.status).toBe(202);                      // the purchase reservation itself succeeded
    expect(await errorOf(retry)).toBeUndefined();
    expect(await storedOf()).toBe(B);
    expect(await movedEvents()).toEqual([B]);            // exactly one, no duplicate
  });
});

describe("CH1-G: bound and controls", () => {
  it("T7 CAS misses twice in a row: 503 after exactly two admission rounds (two live reads), nothing written but the other writer's bumps", async () => {
    reset();
    await signIn(SUB, A); await invite(B);
    const t = await token(SUB, B);
    const r0 = await revisionOf();
    authEmail = B; authCalls = 0;
    const before = withoutRevision(await snapshot());
    const res = await post("/v1/billing/reserve", t, envWith("invite", dbBeforeMoveBatch(9, bumpRevision)));
    expect(res.status).toBe(503);
    expect(authCalls).toBe(2);
    expect(await revisionOf()).toBe(r0 + 2);
    expect(withoutRevision(await snapshot())).toEqual(before);
    expect(await storedOf()).toBe(A);
  });
  it("T6a control: invited B stays B: admitted with ONE live read for the whole request", async () => {
    reset();
    await signIn(SUB, B); await invite(B);
    const t = await token(SUB, B);
    authEmail = B; authCalls = 0;
    const res = await post("/v1/billing/reserve", t, envWith("invite"));
    expect(await errorOf(res)).not.toBe("not_invited");
    expect(authCalls).toBe(1);
    expect(await storedOf()).toBe(B);
  });
  it("T6b control: invited change A to B reconciles to B with ONE live read", async () => {
    reset();
    await signIn(SUB, A); await invite(B);
    const t = await token(SUB, B);
    authEmail = B; authCalls = 0;
    const res = await post("/v1/billing/reserve", t, envWith("invite"));
    expect(await errorOf(res)).not.toBe("not_invited");
    expect(authCalls).toBe(1);
    expect(await storedOf()).toBe(B);
    expect(await movedEvents()).toEqual([B]);
  });
  it("T6c control: sales \"true\" makes no extra read (the count is what ch1-f made)", async () => {
    reset();
    await signIn(SUB, B);
    const t = await token(SUB, B);
    authEmail = B; authCalls = 0;
    const res = await post("/v1/billing/reserve", t, envWith("true"));
    expect(await errorOf(res)).not.toBe("not_invited");
    expect(authCalls).toBe(0);
  });
});

const userIdOf = async () => (await env.DB.prepare("SELECT user_id AS u FROM supabase_identities WHERE sub=?").bind(SUB).first<{ u: string }>())!.u;
const markersAt = async (userId: string, rev: number) => (await env.DB.prepare("SELECT COUNT(*) n FROM flux_email_proof_autosend WHERE account_id=? AND email_revision=?").bind(userId, rev).first<{ n: number }>())!.n;
const seedMarker = (userId: string, rev: number) => env.DB.prepare("INSERT INTO flux_email_proof_autosend (account_id,email_revision,state,tries,at,first_at) VALUES (?,?,'sent',1,5,5)").bind(userId, rev).run();
const seedAlert = (userId: string, rev: number) => env.DB.prepare("INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at) VALUES (?,?,?,?,?,?)")
  .bind(`alert:email_unverified_hold:${userId}:${rev}`, "h-1", "credit.email_unverified_hold", "page", "{}", 1).run();
const alertOpen = async (userId: string, rev: number) => (await env.DB.prepare("SELECT resolved_at AS r FROM cloud_alerts WHERE id=?").bind(`alert:email_unverified_hold:${userId}:${rev}`).first<{ r: number | null }>())!.r === null;
const countOf = async (kind: string) => (await env.DB.prepare("SELECT COUNT(*) n FROM account_link_events WHERE sub=? AND kind=?").bind(SUB, kind).first<{ n: number }>())!.n;
/** Y's own committed unit, written by a trigger the moment X's compare-and-swap runs: Y holds the same revision r + 1 and its OWN win token, and X's UPDATE is skipped. */
const yWinsTrigger = (name: string, table: string, col: string, when: string, setSql: string, event: string | null) => env.DB.exec(
  `CREATE TRIGGER ${name} BEFORE UPDATE OF ${col} ON ${table} WHEN ${when} BEGIN UPDATE supabase_identities SET ${setSql}, email_revision=OLD.email_revision+1, win_token='y-win' WHERE sub=OLD.sub; ${event ?? ""} SELECT RAISE(IGNORE); END`);

describe("CH1-G rule 9 and 14: a losing writer writes nothing (a win token proves which batch won)", () => {
  afterEach(async () => { await env.DB.exec("DROP TRIGGER IF EXISTS g_y_wins"); });
  it("T9 X and Y both go to the same address B; Y commits B at r + 1 first: X changes zero rows (its alert resolve and event do not run)", async () => {
    reset();
    await signIn(SUB, A); await invite(B);
    const t = await token(SUB, B);
    const u = await userIdOf(); const r = await revisionOf();
    await seedAlert(u, r);
    authEmail = B; authCalls = 0;
    await yWinsTrigger("g_y_wins", "supabase_identities", "contact_email", `OLD.email_revision=${r}`, "contact_email=NEW.contact_email",
      `INSERT INTO account_link_events (id,sub,user_id,email,kind,at) VALUES (OLD.sub||':'||(OLD.email_revision+1)||':email_updated',OLD.sub,OLD.user_id,NEW.contact_email,'email_updated',9);`);
    const res = await post("/v1/billing/reserve", t, envWith("invite"));
    expect(await errorOf(res)).not.toBe("not_invited");
    expect(await storedOf()).toBe(B);
    expect(await countOf("email_updated")).toBe(1);        // Y's, none of X's
    expect(await alertOpen(u, r)).toBe(true);              // only the winner resolves the old revision's page
  });
  it("T14 a delayed old-revision autosend marker is present, then X's same-address CAS loses: X inserts no r + 1 marker", async () => {
    reset();
    await signIn(SUB, A); await invite(B);
    const t = await token(SUB, B);
    const u = await userIdOf(); const r = await revisionOf();
    await seedMarker(u, r);                                 // the delayed marker of revision r
    authEmail = B; authCalls = 0;
    await yWinsTrigger("g_y_wins", "supabase_identities", "contact_email", `OLD.email_revision=${r}`, "contact_email=NEW.contact_email", null);
    const res = await post("/v1/billing/reserve", t, envWith("invite"));
    expect(await errorOf(res)).not.toBe("not_invited");
    expect(await storedOf()).toBe(B);
    expect(await markersAt(u, r + 1)).toBe(0);
  });
  it("T13 X intends a conflict clear at r, Y moves to C at r + 1: X writes no email_conflict_cleared event and no r + 1 marker", async () => {
    reset();
    await signIn(SUB, A); await invite(A); await invite(C);
    const u = await userIdOf();
    await env.DB.prepare("UPDATE supabase_identities SET email_conflict=?, email_revision=email_revision+1 WHERE sub=?").bind(B, SUB).run();
    const r = await revisionOf();
    await seedMarker(u, r);
    const t = await token(SUB, A);
    authSeq = [A, C]; authCalls = 0;                        // X reads A (back on the stored address); every later read says C
    await yWinsTrigger("g_y_wins", "supabase_identities", "email_conflict", `OLD.email_revision=${r} AND NEW.email_conflict IS NULL`, `contact_email='${C}', email_conflict=NULL`, null);
    const res = await post("/v1/billing/reserve", t, envWith("invite"));
    expect(await errorOf(res)).not.toBe("not_invited");
    expect(await countOf("email_conflict_cleared")).toBe(0);
    expect(await markersAt(u, r + 1)).toBe(0);
    expect(await storedOf()).toBe(C);
  });
});

describe("CH1-G rules 10 to 13: one unit per mutation, one admission per request, one invite decision", () => {
  afterEach(async () => { await env.DB.exec("DROP TRIGGER IF EXISTS g_clear_bump"); await env.DB.exec("DROP TRIGGER IF EXISTS g_y_creates"); await env.DB.exec("DROP TRIGGER IF EXISTS g_drop_invite"); });
  it("T10a a conflict clear overtaken after it committed answers 503, never a 403 from a second read", async () => {
    reset();
    await signIn(SUB, A); await invite(A);
    await env.DB.prepare("UPDATE supabase_identities SET email_conflict=?, email_revision=email_revision+1 WHERE sub=?").bind(B, SUB).run();
    const t = await token(SUB, A);
    authSeq = [A, C]; authCalls = 0;                        // a second read would answer uninvited C
    await env.DB.exec("CREATE TRIGGER g_clear_bump AFTER INSERT ON account_link_events WHEN NEW.kind='email_conflict_cleared' BEGIN UPDATE supabase_identities SET email_revision=email_revision+1 WHERE sub=NEW.sub; END");
    const res = await post("/v1/billing/reserve", t, envWith("invite"));
    expect(res.status).toBe(503);
    expect(authCalls).toBe(1);
    expect(await countOf("email_conflict_cleared")).toBe(1);
  });
  it("T10b creation race: Y creates the mapping while X holds its live read; X reruns, writes no second account and no created event", async () => {
    reset();
    await invite(B);
    const t = await token(SUB, B);
    authEmail = B; authCalls = 0;
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const reached = Promise.race([new Promise<void>((r) => { entered = r; }), new Promise<void>((_, no) => setTimeout(() => no(new Error("barrier not reached")), 4000))]);
    authHold = async (n) => { if (n === 0) { entered(); await held; } };
    const xp = post("/v1/billing/reserve", t, envWith("invite"));
    await reached;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO "user" (id,name,email,"emailVerified",image,"createdAt","updatedAt") VALUES ('y-user',?,'cloud-y-user@cloud-account.invalid',1,NULL,'t','t')`).bind(B),
      env.DB.prepare("INSERT INTO supabase_identities (sub,user_id,via,created_at,contact_email) VALUES (?,'y-user','created',1,?)").bind(SUB, B),
    ]);
    release();
    const res = await xp;
    expect(await errorOf(res)).not.toBe("not_invited");
    expect(res.status).not.toBe(503);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM supabase_identities WHERE sub=?").bind(SUB).first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM "user"').first<{ n: number }>())!.n).toBe(1);
    expect(await countOf("created")).toBe(0);
  });
  it("T10c a creation that loses its compare-and-swap leaves no orphan user row: the parent insert and the identity insert are one batch (503, zero rows)", async () => {
    reset();
    await invite(B);
    const t = await token(SUB, B);
    authEmail = B; authCalls = 0;
    // A concurrent creator's rows land inside X's first statement, so X's identity insert conflicts on the sub and the whole batch must roll back.
    await env.DB.exec(`CREATE TRIGGER g_y_creates BEFORE INSERT ON "user" WHEN NEW.id<>'y-user' BEGIN INSERT INTO "user" (id,name,email,"emailVerified",image,"createdAt","updatedAt") VALUES ('y-user','y','cloud-y-user@cloud-account.invalid',1,NULL,'t','t'); INSERT INTO supabase_identities (sub,user_id,via,created_at,contact_email) VALUES ('${SUB}','y-user','created',1,'${B}'); END`);
    const before = await snapshot();
    const res = await post("/v1/billing/reserve", t, envWith("invite"));
    await env.DB.exec("DROP TRIGGER g_y_creates");
    expect(res.status).toBe(503);
    expect(await snapshot()).toEqual(before);
  });
  it("T11 the admission record survives a request copy and the step-up / emailed-approval claim reuse it: one Supabase read in total", async () => {
    reset();
    await signIn(SUB, B); await invite(B);
    authEmail = B; authCalls = 0;
    const identity = createIdentity({ jwksFetch, authFetch });
    const e = envWith("invite");
    const original = new Request("https://auth.murage.test/v1/billing/checkout", { method: "POST", headers: { authorization: `Bearer ${await token(SUB, B)}`, "content-type": "application/json" }, body: "{}" });
    identity.bind(original, e);
    await identity.admit(original, e);
    const copy = new Request(original.url, { method: "POST", headers: original.headers, body: "{}" });
    carryBinding(original, copy);
    const a = await identity.supabaseUser(copy, e);
    const b = await identity.supabaseUser(original, e);
    expect([a.email, b.email]).toEqual([B, B]);
    expect(authCalls).toBe(1);
  });
  it("T11 TRUSTED aal2 gate and approved-intent claim: invited live reuses the admission's ONE read (aal1 still refused); uninvited live is refused 403 before any write and before any claim", async () => {
    await stepRig(B);
    expect(await gateRun(B, true)).toEqual({ status: "passed", calls: 1 });
    expect(await gateRun(B, false)).toEqual({ status: "step_up_required", calls: 1 });
    const ok = await claimRun(B, "home-b");
    expect(ok).toMatchObject({ claimed: true, calls: 1, claimReached: true, admissionReads: 1, claimReads: 0 });
    // uninvited live address C: the aal2 gate and the claim are never reached; nothing is written
    const before = await snapshot();
    expect(await gateRun(C, true)).toEqual({ status: "not_invited", calls: 1 });
    expect(await snapshot()).toEqual(before);
    const refused = await claimRun(C, "home-c");
    // refused at admission: the claim step is never reached, so it makes no read and no invite check of its own
    expect(refused).toMatchObject({ status: 403, error: "not_invited", claimed: false, state: "approved", calls: 1, claimReached: false, claimReads: null });
    expect(refused.after).toEqual(refused.before);
  });
  it("T12 the invite is removed after admission and the unit committed: the request completes, never not_invited after a write", async () => {
    reset();
    await signIn(SUB, A); await invite(B);
    const t = await token(SUB, B);
    authEmail = B; authCalls = 0;
    await env.DB.exec("CREATE TRIGGER g_drop_invite AFTER INSERT ON account_link_events WHEN NEW.kind='email_updated' BEGIN DELETE FROM sales_invites; END");
    const res = await post("/v1/billing/reserve", t, envWith("invite"));
    expect(await errorOf(res)).not.toBe("not_invited");
    expect(await storedOf()).toBe(B);
    // the next request is judged by the table as it is now
    const next = await post("/v1/billing/reserve", t, envWith("invite"));
    expect(next.status).toBe(403);
    expect(await next.json()).toEqual({ error: "not_invited" });
  });
});

describe("CH1-G Astra r1 (round 2): same-sub creator, post-creation fence, token-gated creation event, explicit admission state", () => {
  afterEach(async () => { await env.DB.exec("DROP TRIGGER IF EXISTS g_steal_token"); vi.restoreAllMocks(); });
  const identityRows = async () => ({ ids: (await snapshot()).supabase_identities, users: (await snapshot()).user, events: (await snapshot()).account_link_events });
  const holderLookup = (sql: string) => sql.startsWith("SELECT user_id") && sql.includes("lower(contact_email)=?");

  it("T15 (M1) a concurrent creator of the SAME sub commits between X's read of the unmapped subject and X's holder lookup: X reruns, writes 0 rows, no refused_email_taken event or log, no 409", async () => {
    reset();
    await invite(B);
    const t = await token(SUB, B);
    authEmail = B; authCalls = 0;
    const logs = vi.spyOn(console, "log");
    let armed = true;
    let afterY: Record<string, unknown[]> | null = null;
    const db = dbWithHooks({ beforeRead: async (sql) => {
      if (!armed || !holderLookup(sql)) return;
      armed = false;
      // Y: the same subject, the same address, created (account, mapping and its created event).
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO "user" (id,name,email,"emailVerified",image,"createdAt","updatedAt") VALUES ('y-user',?,'cloud-y-user@cloud-account.invalid',1,NULL,'t','t')`).bind(B),
        env.DB.prepare("INSERT INTO supabase_identities (sub,user_id,via,created_at,contact_email,win_token) VALUES (?,'y-user','created',1,?,'y-win')").bind(SUB, B),
        env.DB.prepare("INSERT INTO account_link_events (id,sub,user_id,email,kind,at) VALUES ('y-created',?,'y-user',?,'created',1)").bind(SUB, B),
      ]);
      afterY = await snapshot();
    } });
    let atRerun: Record<string, unknown[]> | null = null;
    authHold = async (n) => { if (n === 1) atRerun = await snapshot(); };      // the rerun's own live read: X's first round has left nothing in ANY table
    const res = await post("/v1/billing/reserve", t, envWith("invite", db));
    expect(armed).toBe(false);
    expect(res.status).not.toBe(409);
    expect(await errorOf(res)).not.toBe("account_email_taken");
    expect(await errorOf(res)).not.toBe("not_invited");
    expect(authCalls).toBe(2);                                                  // X reran admission
    expect(atRerun).toEqual(afterY);                                            // 0 changed rows in every table for X
    expect(await countOf("refused_email_taken")).toBe(0);
    expect(logs.mock.calls.some((c) => String(c[0]).includes("refused_email_taken"))).toBe(false);
    expect((await identityRows()).users).toHaveLength(1);
    expect(await storedOf()).toBe(B);
  });

  it("T15b a DIFFERENT subject holds the address: the refusal is its own gated unit (409, one refused_email_taken event); if the holder changes first it writes nothing and reruns", async () => {
    reset();
    await invite(B);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO "user" (id,name,email,"emailVerified",image,"createdAt","updatedAt") VALUES ('h-user',?,'cloud-h-user@cloud-account.invalid',1,NULL,'t','t')`).bind(B),
      env.DB.prepare("INSERT INTO supabase_identities (sub,user_id,via,created_at,contact_email,win_token) VALUES ('other-sub','h-user','created',1,?,'h-win')").bind(B),
    ]);
    const t = await token(SUB, B);
    authEmail = B; authCalls = 0;
    const res = await post("/v1/billing/reserve", t, envWith("invite"));
    expect([res.status, await errorOf(res)]).toEqual([409, "account_email_taken"]);
    expect(await countOf("refused_email_taken")).toBe(1);
    expect((await env.DB.prepare("SELECT id FROM account_link_events WHERE kind='refused_email_taken'").first<{ id: string }>())!.id).toMatch(new RegExp(`^${SUB}:refused:other-sub:0:\\d+$`));
    // the holder moves its address away just before the refusal's batch: the refusal writes nothing and admission reruns (creating the account)
    await env.DB.prepare("DELETE FROM account_link_events").run();
    let armed = true;
    authCalls = 0;
    const holderMoves = dbWithHooks({ beforeBatch: async (sqls) => {
      if (!armed || !sqls.some((q) => q.includes("refused_email_taken") || q.includes("account_link_events"))) return;
      armed = false;
      await env.DB.prepare("UPDATE supabase_identities SET contact_email='moved-away@example.test', email_revision=email_revision+1, win_token='h-win-2' WHERE sub='other-sub'").run();
    } });
    const res2 = await post("/v1/billing/reserve", t, envWith("invite", holderMoves));
    expect(armed).toBe(false);
    expect(res2.status).not.toBe(409);
    expect(await countOf("refused_email_taken")).toBe(0);
    expect(await storedOf()).toBe(B);
    expect(authCalls).toBe(2);
  });

  it("T16 (M2) a creation overtaken after it COMMITTED answers a terminal 503 identity_busy: no further read, the unit is complete, no refusal", async () => {
    reset();
    await invite(B);
    const t = await token(SUB, B);
    authSeq = [B, C]; authCalls = 0;                                            // a second read would answer uninvited C
    let armed = true;
    const db = dbWithHooks({ afterBatch: async (sqls) => {
      if (!armed || !sqls.some((q) => q.startsWith('INSERT INTO "user"'))) return;
      armed = false;
      await bumpRevision();                                                     // Y moves the revision right after X's creation committed
    } });
    const res = await post("/v1/billing/reserve", t, envWith("invite", db));
    expect(armed).toBe(false);
    expect([res.status, await errorOf(res)]).toEqual([503, "identity_busy"]);
    expect(authCalls).toBe(1);
    expect(await storedOf()).toBe(B);
    expect(await revisionOf()).toBe(1);                                         // Y's bump
    expect(await countOf("created")).toBe(1);                                   // X's unit is complete
    expect((await identityRows()).users).toHaveLength(1);
    expect(await countOf("refused_email_taken")).toBe(0);
  });

  it("T17 (Low) the creation event has a deterministic id and is gated on the creation unit's win token", async () => {
    reset();
    await invite(B);
    const t = await token(SUB, B);
    authEmail = B; authCalls = 0;
    const res = await post("/v1/billing/reserve", t, envWith("invite"));
    expect(await errorOf(res)).not.toBe("not_invited");
    const ids = (await env.DB.prepare("SELECT id FROM account_link_events WHERE sub=? AND kind='created'").bind(SUB).all<{ id: string }>()).results.map((r) => r.id);
    expect(ids).toEqual([`${SUB}:0:created`]);
  });
  it("T17b a creation whose win token is no longer stored when its event runs writes no created event", async () => {
    reset();
    await invite(B);
    const t = await token(SUB, B);
    authEmail = B; authCalls = 0;
    await env.DB.exec("CREATE TRIGGER g_steal_token AFTER INSERT ON supabase_identities BEGIN UPDATE supabase_identities SET win_token='stolen' WHERE sub=NEW.sub; END");
    const res = await post("/v1/billing/reserve", t, envWith("invite"));
    expect(await errorOf(res)).not.toBe("not_invited");
    expect(await countOf("created")).toBe(0);
  });

  it("T18 (Low) an invite-gated request that reaches resolution, the step-up gate or the live user with NO admission is a terminal 503: no Auth read, no account written", async () => {
    reset();
    await invite(B);
    const e = envWith("invite");
    const t = await token(SUB, B);
    for (const use of ["customer", "supabaseUser", "stepUpNeeded"] as const) {
      authEmail = B; authCalls = 0;
      const identity = createIdentity({ jwksFetch, authFetch });
      const req = new Request("https://auth.murage.test/v1/billing/checkout", { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: "{}" });
      identity.bind(req, e);                                                    // bound, NEVER admitted
      const before = await snapshot();
      const call = use === "customer" ? identity.customer(req) : use === "supabaseUser" ? identity.supabaseUser(req, e) : identity.stepUpNeeded(req, e);
      await expect(call).rejects.toMatchObject({ status: 503 });
      expect(authCalls).toBe(0);
      expect(await snapshot()).toEqual(before);
    }
  });
  const termsAs = async (e: Env) => {
    const ctx = createExecutionContext();
    const res = await workerAt().fetch(new Request("https://auth.murage.test/v1/account/terms", { headers: { authorization: `Bearer ${await token(SUB, B)}` } }), e, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  const seedHolder = () => env.DB.batch([
    env.DB.prepare(`INSERT INTO "user" (id,name,email,"emailVerified",image,"createdAt","updatedAt") VALUES ('h-user',?,'cloud-h-user@cloud-account.invalid',1,NULL,'t','t')`).bind(B),
    env.DB.prepare("INSERT INTO supabase_identities (sub,user_id,via,created_at,contact_email,win_token) VALUES ('other-sub','h-user','created',1,?,'h-win')").bind(B),
  ]);
  it("T19 (Low, legacy site) outside invite mode the created event also has the deterministic id and the win-token gate", async () => {
    reset();
    expect((await termsAs(envWith("true"))).status).toBe(200);
    expect((await env.DB.prepare("SELECT id FROM account_link_events WHERE sub=? AND kind='created'").bind(SUB).all<{ id: string }>()).results.map((r) => r.id)).toEqual([`${SUB}:0:created`]);
  });
  it("T19b a legacy creation whose token is no longer stored when its event runs writes no created event", async () => {
    reset();
    await env.DB.exec("CREATE TRIGGER g_steal_token AFTER INSERT ON supabase_identities BEGIN UPDATE supabase_identities SET win_token='stolen' WHERE sub=NEW.sub; END");
    expect((await termsAs(envWith("true"))).status).toBe(200);
    expect(await countOf("created")).toBe(0);
  });
  it("T19c (Low, legacy site) outside invite mode a refusal is one gated unit with a deterministic id; if the holder moves first it writes nothing and the subject is created", async () => {
    reset();
    await seedHolder();
    const refused = await termsAs(envWith("true"));
    expect([refused.status, await errorOf(refused)]).toEqual([409, "account_email_taken"]);
    expect((await env.DB.prepare("SELECT id FROM account_link_events WHERE kind='refused_email_taken'").first<{ id: string }>())!.id).toMatch(new RegExp(`^${SUB}:refused:other-sub:0:\\d+$`));
    await env.DB.prepare("DELETE FROM account_link_events").run();
    let armed = true;
    const db = dbWithHooks({ beforeBatch: async (sqls) => {
      if (!armed || !sqls.some((q) => q.includes("refused_email_taken"))) return;
      armed = false;
      await env.DB.prepare("UPDATE supabase_identities SET contact_email='moved-away@example.test', email_revision=email_revision+1, win_token='h-win-2' WHERE sub='other-sub'").run();
    } });
    const res = await termsAs(envWith("true", db));
    expect(armed).toBe(false);
    expect(res.status).toBe(200);
    expect(await countOf("refused_email_taken")).toBe(0);
    expect(await storedOf()).toBe(B);
  });
  it("T18b outside invite mode the same unadmitted request resolves as before (sales true)", async () => {
    reset();
    const e = envWith("true");
    authEmail = B; authCalls = 0;
    const identity = createIdentity({ jwksFetch, authFetch });
    const req = new Request("https://auth.murage.test/v1/billing/checkout", { method: "POST", headers: { authorization: `Bearer ${await token(SUB, B)}`, "content-type": "application/json" }, body: "{}" });
    identity.bind(req, e);
    expect((await identity.customer(req))?.user.email).toBe(B);
  });
});
