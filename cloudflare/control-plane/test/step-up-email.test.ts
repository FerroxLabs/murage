// SPDX-License-Identifier: AGPL-3.0-or-later
// Step-up by an emailed 6-digit code (src/step-up-email.ts; Astra STEPUP-EMAIL-1 contract and findings 1-9). Real-shaped Supabase ES256
// tokens, a mocked Supabase GET /auth/v1/user (live session and address), an injected email sender; isolated Worker and D1.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { classifyEdge } from "../src/edge-limits";
import { REQUEUE_PATH, sixDigits, sweepStepUpEmail } from "../src/step-up-email";
import { keyWrapperFor } from "../src/key-wrapper";
import { sweepFlux, type FluxClient, type FluxMint } from "../src/b4-flux";
import { sha256 } from "../src/installations";
/** Astra INTEGRATED-1 #7: real billing hooks advertising the qualified router capability (the B4 launch gate open). */
const QUALIFIED_HOOKS = { stub: false, capabilities: { reversalTargets: true } } as unknown as NonNullable<import("../src/b4-flux").FluxDependencies["billingFlux"]>;

const REF_ORIGIN = "https://testref.supabase.co";
const ISS = `${REF_ORIGIN}/auth/v1`;
const SUB = "5f0c1b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const EMAIL = "pat@example.test";
const S1 = "0b1c2d3e-aaaa-4bbb-8ccc-123456789abc";
const S2 = "0b1c2d3e-bbbb-4bbb-8ccc-123456789abd";
const FM = "11111111-1111-4111-8111-111111111111";
const EXPORT = "/v1/account/export-request";
const HDR = "x-step-up-consumed";

const b64u = (b: ArrayBuffer | string) => Buffer.from(typeof b === "string" ? Buffer.from(b) : new Uint8Array(b)).toString("base64url");
let ec: CryptoKeyPair;
let jwks: { keys: Record<string, unknown>[] };
beforeAll(async () => {
  ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", ec.publicKey) as Record<string, unknown>), kid: "ec-1", alg: "ES256", use: "sig" }] };
});

let clock = 1_790_000_000_000;
const nowS = () => Math.floor(clock / 1000);
let supa: { email: string; updatedAt: string; factors?: { id: string; factor_type: string; status: string }[] };
let gen = 0;
const changeEmail = (to: string) => { supa.email = to; gen += 1; supa.updatedAt = `2026-10-02T00:00:${String(gen % 60).padStart(2, "0")}.${gen}Z`; };
/** Supabase sessions signed out server-side: /user answers 401 for their tokens. */
const revoked = new Set<string>();
let userCalls = 0;
const mail: { to: string; subject: string; text: string }[] = [];
let failMail = false;
let maxAge: string | undefined;

const KEK = btoa("x".repeat(32));
/** A Flux router stand-in: mints a recognisable key; Stop, revoke and cap succeed. */
/** The router refuses every revocation (a compensation that cannot be confirmed). */
let revokeFails = false;
const fluxCalls = { mints: [] as FluxMint[], revokes: [] as { homeId: string; generation: number; reason: string }[] };
const fakeFlux = {
  async mint(input: FluxMint) {
    fluxCalls.mints.push(input);
    return { key: `sk-flux-stepup-secret-${input.homeId}-g${input.generation}-0123456789abcdef`, expiresAt: new Date(clock + 30 * 86_400_000).toISOString(),
      generation: input.generation, capMicrocents: input.capMicrocents };
  },
  async stop() {}, async setCap() {},
  async revokeKey(homeId: string, generation: number, _lifecycle: number, reason: string) {
    if (revokeFails) throw new Error("router unreachable");
    fluxCalls.revokes.push({ homeId, generation, reason });
  },
} as unknown as FluxClient;
/** Runs `hook` with each statement's SQL (a batch's joined) before D1 sees it: a test arms one to change state at an exact point. */
let dbHook: ((sql: string) => Promise<void> | void) | null = null;
function armDb(match: RegExp, action: () => Promise<unknown>) {
  dbHook = async (sql) => { if (!match.test(sql)) return; dbHook = null; await action(); };
}
function hookDb(db: D1Database): D1Database {
  type Stmt = D1PreparedStatement & { __real?: D1PreparedStatement; __sql?: string };
  const wrap = (stmt: D1PreparedStatement, sql: string): Stmt => new Proxy(stmt as Stmt, {
    get(target, prop) {
      if (prop === "__real") return target;
      if (prop === "__sql") return sql;
      if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
      if (prop === "run" || prop === "first" || prop === "all" || prop === "raw") {
        return async (...args: unknown[]) => { await dbHook?.(sql); return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop as string](...args); };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(db, {
    get(target, prop) {
      // No D1 session (d1-session.ts would query the binding itself, past this hook).
      if (prop === "withSession") return undefined;
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch") {
        return async (statements: Stmt[]) => {
          await dbHook?.(statements.map((x) => x.__sql ?? "").join(";\n"));
          return target.batch(statements.map((x) => x.__real ?? x));
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const sessionOf = (bearer: string) => (JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()) as { session_id: string }).session_id;
const makeWorker = (billing: Record<string, unknown> = {}) => createWorker(fetch, fetch, {}, {
  emailSender: () => ({ async send(m) {
    if (failMail) throw new Error("provider down");
    mail.push({ to: m.to, subject: m.subject, text: m.text });
  } }),
}, billing, {
  jwksFetch: (async () => Response.json(jwks)) as typeof fetch,
  authFetch: (async (_url: string, init?: RequestInit) => {
    userCalls += 1;
    const bearer = new Headers(init?.headers).get("authorization")!.slice(7);
    if (revoked.has(sessionOf(bearer))) return Response.json({ msg: "session_not_found" }, { status: 403 });
    return Response.json({ id: SUB, email: supa.email, email_confirmed_at: "2026-10-01T00:00:00Z", updated_at: supa.updatedAt,
      factors: (supa.factors ?? []).map((f) => ({ friendly_name: "", created_at: "2026-10-01T00:00:00Z", ...f })) });
  }) as unknown as typeof fetch,
  now: () => clock,
}, {}, { fluxClient: () => fakeFlux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
const worker = makeWorker();
/** Extra bindings for one test (cleared after each). */
let extraEnv: Record<string, unknown> = {};
const testEnv = () => ({ ...env, ...extraEnv, DB: hookDb(env.DB), SUPABASE_URL: REF_ORIGIN, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_testkey_0123456789abcdef",
  CLOUD_KEK_V1: KEK, CLOUD_FLUX_ROUTES_ENABLED: "1", FLUX_API_BASE: "https://api.fluxrouter.ai", FLUX_CLOUD_SERVICE_TOKEN: "s".repeat(40),
  ...(maxAge ? { CLOUD_STEPUP_MAX_AGE_SECONDS: maxAge } : {}), MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined }) as unknown as Env;

/** An aal1 sign-in token of session `sid` (the emailed sign-in code: no authenticator). */
async function token(sid = S1, over: Record<string, unknown> = {}) {
  const s = nowS();
  const c = { iss: ISS, aud: "authenticated", exp: s + 3600, iat: s - 5, sub: SUB, email: EMAIL, role: "authenticated", is_anonymous: false,
    app_metadata: { provider: "email", email_verified: true }, user_metadata: {}, session_id: sid, aal: "aal1", mfa_factor_id: null,
    amr: [{ method: "otp", timestamp: s - 3000 }], ...over };
  const input = `${b64u(JSON.stringify({ alg: "ES256", kid: "ec-1", typ: "JWT" }))}.${b64u(JSON.stringify(c))}`;
  return `${input}.${b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, new TextEncoder().encode(input)))}`;
}
async function call(method: string, path: string, bearer: string, body?: unknown, w = worker) {
  const ctx = createExecutionContext();
  const res = await w.fetch(new Request(`https://auth.murage.test${path}`, { method,
    headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const out = async (res: Response) => [res.status, await res.json<Body>()] as const;
const userId = async () => (await env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(SUB).first<{ user_id: string }>())!.user_id;
const codeFromMail = () => /Your code is: (\d{6})/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
const exports = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM data_export_requests").first<{ n: number }>())!.n;

/** The refused protected request: its 403 body, and the frozen intent's id. */
async function refused(t: string, path = EXPORT, body: unknown = {}, method = "POST") {
  const [status, b] = await out(await call(method, path, t, method === "GET" ? undefined : body));
  expect(status).toBe(403);
  expect(b.error).toBe("step_up_required");
  return { body: b, intent: b.step_up.email_code.intent_id as string };
}
async function send(t: string, intentId: string) { return call("POST", "/v1/account/step-up/email/send", t, { intentId }); }
async function verify(t: string, intentId: string, challengeId: string, code: string) {
  return call("POST", "/v1/account/step-up/email/verify", t, { intentId, challengeId, code });
}
/** Send, read the code from the mail, verify. */
async function approve(t: string, intentId: string) {
  const [s, sent] = await out(await send(t, intentId));
  expect(s).toBe(202);
  const res = await verify(t, intentId, sent.challengeId, codeFromMail());
  expect(res.status).toBe(200);
  return sent.challengeId as string;
}
/** The home's self-service runner has polled (the actions that need commands are possible). */
const runner = (home = "home-se") => env.DB.prepare("INSERT OR REPLACE INTO cloud_home_runner (home_id,generation,polled_at) VALUES (?,1,0)").bind(home).run();
/** A newer live home of the same account: the one "the current home" would now resolve to. */
const newerHome = async () => env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
  VALUES ('home-new',?,?,'ready','ready',?,'k',1,1)`).bind(crypto.randomUUID(), await userId(), `sha256:${"b".repeat(64)}`).run();
const commands = async () => (await env.DB.prepare("SELECT id,home_id,kind FROM cloud_home_commands").all<{ id: string; home_id: string; kind: string }>()).results;
const intentRow = (id: string) => env.DB.prepare("SELECT * FROM cloud_stepup_intents WHERE id=?").bind(id).first<Body>();
/** Every row of every table, as one string: a probe that nothing secret was persisted anywhere in D1. */
async function everything(): Promise<string> {
  const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'")
    .all<{ name: string }>()).results.map((r) => r.name);
  const dump: unknown[] = [];
  for (const t of tables) dump.push((await env.DB.prepare(`SELECT * FROM "${t}"`).all()).results);
  return JSON.stringify(dump);
}
/** An aal2 token of session `sid` that just verified the trusted TOTP factor FM (an ordinary fresh authenticator step-up). */
async function authenticatorToken(sid = S1) {
  supa.factors = [{ id: FM, factor_type: "totp", status: "verified" }];
  await env.DB.prepare("INSERT OR IGNORE INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state) VALUES (?,?,'totp','email_code',0,0,'active')")
    .bind(await userId(), FM).run();
  return token(sid, { aal: "aal2", mfa_factor_id: FM, amr: [{ method: "totp", timestamp: nowS() - 5 }, { method: "otp", timestamp: nowS() - 3000 }] });
}
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

beforeEach(async () => {
  clock = 1_790_000_000_000;
  supa = { email: EMAIL, updatedAt: "2026-10-01T00:00:00.000000Z" };
  revoked.clear();
  mail.length = 0;
  failMail = false;
  maxAge = undefined;
  userCalls = 0;
  // The account exists (first Cloud call) and owns a ready home: something to protect, so no purchase bootstrap applies.
  expect((await call("GET", "/v1/account/mfa/factors", await token())).status).toBe(200);
  await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
    VALUES ('home-se',?,?,'ready','ready',?,'k',0,0)`).bind(crypto.randomUUID(), await userId(), `sha256:${"a".repeat(64)}`).run();
});
afterEach(async () => {
  vi.restoreAllMocks();
  dbHook = null;
  extraEnv = {};
  fluxCalls.mints.length = 0;
  fluxCalls.revokes.length = 0;
  revokeFails = false;
  await env.DB.batch(["selfservice_rate_limits", "selfservice_audit", "cloud_home_commands", "cloud_home_runner", "cloud_home_logs", "billing_home_leases",
    "cloud_export_jobs", "cloud_export_downloads", "cloud_export_key_disclosures", "data_export_requests"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("403 step_up_required: the shared serializer", () => {
  it("adds email_code bound to a frozen intent, keeps the existing fields, and lists email_code last in methods", async () => {
    const { body } = await refused(await token());
    expect(body.step_up).toMatchObject({ reason: "aal1", max_age_seconds: 600, verified_at: null, methods: ["email_code"] });
    expect(body.step_up.email_code).toEqual({ available: true, digits: 6, ttl_seconds: 600, grant_ttl_seconds: 600, intent_id: expect.stringMatching(/^si_[0-9a-f]{32}$/) });
  });

  it("STEPUP-EMAIL-7 #4 a refusal that cannot be built (its intent cannot be stored) is a 503, never a bare 403 step_up_required", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = await token();
    armDb(/INSERT INTO cloud_stepup_intents \(id,user_id/, async () => { throw new Error("storage down"); });
    const [s, b] = await out(await call("POST", EXPORT, t, {}));
    expect([s, b.error]).toEqual([503, "step_up_unavailable"]);
    expect(b.step_up).toBeUndefined();
    expect(await exports()).toBe(0);
    // Storage back: the same request is refused whole, with every email_code field.
    expect((await refused(t)).body.step_up.email_code).toMatchObject({ available: true, digits: 6, intent_id: expect.stringMatching(/^si_[0-9a-f]{32}$/) });
  });

  it("offers a usable trusted authenticator first, email_code always last; a held one is not offered", async () => {
    await env.DB.prepare("INSERT INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state) VALUES (?,?,'totp','email_code',0,?,'active')")
      .bind(await userId(), FM, clock + 3_600_000).run();
    expect((await refused(await token())).body.step_up.methods).toEqual(["email_code"]);
    await env.DB.prepare("UPDATE cloud_trusted_factors SET usable_at=0").run();
    expect((await refused(await token())).body.step_up.methods).toEqual(["totp", "email_code"]);
    await env.DB.prepare("INSERT INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state) VALUES (?,?,'webauthn','trusted_factor',0,0,'active')")
      .bind(await userId(), "22222222-2222-4222-8222-222222222222").run();
    expect((await refused(await token())).body.step_up.methods).toEqual(["totp", "webauthn", "email_code"]);
  });

  it("purchase routes keep bootstrap:false; the same request reuses its pending intent; GET logs carries it too", async () => {
    const t = await token();
    const r = await refused(t, "/v1/billing/checkout/resume", { homeId: "home-x" });
    expect(r.body.step_up.bootstrap).toBe(false);
    expect(r.body.step_up.email_code.available).toBe(true);
    expect((await refused(t)).intent).toBe((await refused(t)).intent);
    expect((await refused(t, "/v1/account/home/logs", undefined, "GET")).body.step_up.methods).toEqual(["email_code"]);
  });

  it("grant_ttl_seconds = min(600, CLOUD_STEPUP_MAX_AGE_SECONDS)", async () => {
    maxAge = "120";
    expect((await refused(await token())).body.step_up.email_code.grant_ttl_seconds).toBe(120);
    maxAge = "3600";
    expect((await refused(await token())).body.step_up.email_code.grant_ttl_seconds).toBe(600);
  });
});

describe("send and verify", () => {
  it("the full path: code sent to the live address with a fixed code-free subject, verified, the frozen action runs once", async () => {
    const logs: string[] = [];
    for (const k of ["log", "error", "warn", "info"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    const t = await token();
    const { intent } = await refused(t);
    const sendRes = await send(t, intent);
    const [s, sent] = await out(sendRes);
    expect(s).toBe(202);
    expect(sendRes.headers.get(HDR)).toBeNull();
    expect(sendRes.headers.get("cache-control")).toBe("no-store");
    expect(sent).toEqual({ sent: true, challengeId: expect.stringMatching(/^sc_[0-9a-f]{32}$/), digits: 6, expiresAt: nowS() + 600, expiresIn: 600, resendIn: 30 });
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe(EMAIL);
    expect(mail[0].subject).toBe("Your Murage security code");
    const code = codeFromMail();
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify((await env.DB.prepare("SELECT * FROM cloud_stepup_challenges").all()).results)).not.toContain(code);
    const vres = await verify(t, intent, sent.challengeId, code);
    expect(vres.headers.get(HDR)).toBeNull();
    expect(await out(vres)).toEqual([200, { verified: true, intentId: intent, expiresAt: nowS() + 600, expiresIn: 600 }]);
    const run = await call("POST", EXPORT, t, { stepUpIntentId: intent });
    expect(run.status).toBe(201);
    expect(run.headers.get(HDR)).toBe("1");
    const first = await run.json<Body>();
    expect(first.existing).toBe(false);
    expect(await exports()).toBe(1);
    // A retry of the same operation gets its minimal replay record (status and operation reference, never the stored body), never a
    // second request.
    const again = await call("POST", EXPORT, t, { stepUpIntentId: intent });
    expect([again.status, await again.json<Body>()]).toEqual([201, { replayed: true, operation: { id: intent, ref: `requestId:${first.requestId}` } }]);
    expect(again.headers.get(HDR)).toBe("1");
    expect(await exports()).toBe(1);
    // The approval authorized that one operation only: the same action without it is refused again.
    expect((await call("POST", EXPORT, t, {})).status).toBe(403);
    expect(logs.join("\n")).not.toContain(code);
    expect(logs.join("\n")).not.toContain(EMAIL);
  });

  it("strict bodies: 400 invalid_request; unknown or foreign intent: 403 intent_refused; 405 on GET", async () => {
    const t = await token();
    const { intent } = await refused(t);
    expect(await out(await call("POST", "/v1/account/step-up/email/send", t, { intentId: intent, extra: 1 }))).toEqual([400, { error: "invalid_request" }]);
    expect(await out(await call("POST", "/v1/account/step-up/email/send", t, { intentId: "si_x" }))).toEqual([400, { error: "invalid_request" }]);
    expect(await out(await send(t, `si_${"0".repeat(32)}`))).toEqual([403, { error: "intent_refused" }]);
    expect((await call("GET", "/v1/account/step-up/email/send", t)).status).toBe(405);
    const [, sent] = await out(await send(t, intent));
    for (const code of ["12345", "1234567", "12345a", 123456]) {
      expect(await out(await call("POST", "/v1/account/step-up/email/verify", t, { intentId: intent, challengeId: sent.challengeId, code }))).toEqual([400, { error: "invalid_request" }]);
    }
  });

  it("five guesses per issuance: the 5th may be right; after five wrong the right code is refused, uniformly, with no attemptsLeft", async () => {
    const t = await token();
    const { intent } = await refused(t);
    const [, sent] = await out(await send(t, intent));
    const code = codeFromMail();
    for (let i = 0; i < 4; i += 1) expect(await out(await verify(t, intent, sent.challengeId, wrong(code)))).toEqual([403, { error: "code_refused" }]);
    expect((await verify(t, intent, sent.challengeId, code)).status).toBe(200);

    clock += 31_000;
    const second = await refused(t, "/v1/billing/portal", {});
    const [, s2] = await out(await send(t, second.intent));
    const c2 = codeFromMail();
    for (let i = 0; i < 5; i += 1) expect(await out(await verify(t, second.intent, s2.challengeId, wrong(c2)))).toEqual([403, { error: "code_refused" }]);
    expect(await out(await verify(t, second.intent, s2.challengeId, c2))).toEqual([403, { error: "code_refused" }]);
  });

  it("concurrent guesses never exceed five; a concurrent double submit of the right code grants once", async () => {
    const t = await token();
    const { intent } = await refused(t);
    const [, sent] = await out(await send(t, intent));
    const code = codeFromMail();
    const both = await Promise.all([verify(t, intent, sent.challengeId, code), verify(t, intent, sent.challengeId, code)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 403]);
    clock += 31_000;
    const other = await refused(t, "/v1/billing/portal", {});
    const [, s2] = await out(await send(t, other.intent));
    const c2 = codeFromMail();
    await Promise.all(Array.from({ length: 8 }, () => verify(t, other.intent, s2.challengeId, wrong(c2))));
    expect((await env.DB.prepare("SELECT attempts FROM cloud_stepup_challenges WHERE challenge_id=?").bind(s2.challengeId).first<{ attempts: number }>())!.attempts).toBe(5);
    expect((await verify(t, other.intent, s2.challengeId, c2)).status).toBe(403);
  });

  it("a resend invalidates the previous challenge in that session", async () => {
    const t = await token();
    const { intent } = await refused(t);
    const [, first] = await out(await send(t, intent));
    const oldCode = codeFromMail();
    clock += 31_000;
    const [s, second] = await out(await send(t, intent));
    expect(s).toBe(202);
    expect(await out(await verify(t, intent, first.challengeId, oldCode))).toEqual([403, { error: "code_refused" }]);
    expect((await verify(t, intent, second.challengeId, codeFromMail())).status).toBe(200);
  });

  it("limits: 30 s between sends, five issuances per account per rolling 24 h including failed delivery, new sessions never reset it", async () => {
    const t = await token();
    const { intent } = await refused(t);
    expect((await send(t, intent)).status).toBe(202);
    const quick = await send(t, intent);
    const [qs, qb] = await out(quick);
    expect(qs).toBe(429);
    expect(qb.error).toBe("rate_limited");
    expect(qb.retryAfter).toBeGreaterThan(0);
    expect(qb.retryAfter).toBeLessThanOrEqual(30);
    expect(quick.headers.get("retry-after")).toBe(String(qb.retryAfter));
    // Astra STEPUP-EMAIL-9 #5: the same value under the name the site reads, too.
    expect(qb.retry_after_seconds).toBe(qb.retryAfter);
    clock += 31_000;
    failMail = true;
    expect(await out(await send(t, intent))).toEqual([503, { error: "email_unavailable" }]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_stepup_challenges").first<{ n: number }>())!.n).toBe(0);
    failMail = false;
    for (let i = 0; i < 3; i += 1) { clock += 31_000; expect((await send(t, intent)).status).toBe(202); }
    clock += 31_000;
    const other = await token(S2);
    const fresh = await refused(other);
    const [s6, b6] = await out(await send(other, fresh.intent));
    expect(s6).toBe(429);
    expect(b6.retryAfter).toBeGreaterThan(23 * 3600);
    clock += 24 * 3_600_000;
    const later = await token(S2);
    expect((await send(later, (await refused(later)).intent)).status).toBe(202);
  });

  it("concurrent sends: one reservation wins", async () => {
    const t = await token();
    const { intent } = await refused(t);
    const both = await Promise.all([send(t, intent), send(t, intent)]);
    expect(both.map((r) => r.status).sort()).toEqual([202, 429]);
  });

  it("expiry: a code dies after 600 s, an approval after its grant window, with no sliding renewal", async () => {
    const t = await token();
    const { intent } = await refused(t);
    const [, sent] = await out(await send(t, intent));
    clock += 600_000;
    expect(await out(await verify(t, intent, sent.challengeId, codeFromMail()))).toEqual([403, { error: "code_refused" }]);

    maxAge = "120";
    const t2 = await token();
    const second = await refused(t2);
    clock += 31_000;
    await approve(t2, second.intent);
    clock += 119_000;
    // A refreshed token of the same session (new iat) does not extend it.
    const refreshed = await token(S1);
    clock += 2_000;
    const [st, b] = await out(await call("POST", EXPORT, refreshed, { stepUpIntentId: second.intent }));
    expect(st).toBe(403);
    expect(b.step_up.email_code.intent_id).not.toBe(second.intent);
    expect(await exports()).toBe(0);
  });
});

describe("the frozen operation", () => {
  it("concurrent retries of one approval: exactly one execution; the duplicate is 409 action_in_progress or the stored answer, both marked consumed", async () => {
    const t = await token();
    const { intent } = await refused(t);
    await approve(t, intent);
    const both = await Promise.all([call("POST", EXPORT, t, { stepUpIntentId: intent }), call("POST", EXPORT, t, { stepUpIntentId: intent })]);
    expect(await exports()).toBe(1);
    for (const r of both) expect(r.headers.get(HDR)).toBe("1");
    const statuses = both.map((r) => r.status).sort();
    expect([[201, 201], [201, 409]]).toContainEqual(statuses);
  });

  it("changed parameters after approval: refused with a FRESH intent, and the stale one is invalidated", async () => {
    const t = await token();
    const { intent } = await refused(t);
    await approve(t, intent);
    const [s, b] = await out(await call("POST", EXPORT, t, { homeId: "home-se", stepUpIntentId: intent }));
    expect(s).toBe(403);
    expect(b.error).toBe("step_up_required");
    expect(b.step_up.email_code.intent_id).not.toBe(intent);
    // The stale approval is gone: even the exact original request cannot use it now.
    const [s2, b2] = await out(await call("POST", EXPORT, t, { stepUpIntentId: intent }));
    expect(s2).toBe(403);
    expect(b2.step_up.email_code.intent_id).not.toBe(intent);
    expect(await exports()).toBe(0);
  });

  it("another action with an approved intent is refused (no action category), and a changed account state voids the approval", async () => {
    const t = await token();
    const { intent } = await refused(t);
    await approve(t, intent);
    const res = await call("POST", "/v1/billing/portal", t, { stepUpIntentId: intent });
    expect(res.status).toBe(403);
    expect(res.headers.get(HDR)).toBeNull();
    clock += 31_000;
    const second = await refused(t);
    await approve(t, second.intent);
    await env.DB.prepare("UPDATE cloud_homes SET generation=generation+1").run();
    expect((await call("POST", EXPORT, t, { stepUpIntentId: second.intent })).status).toBe(403);
    expect(await exports()).toBe(0);
  });

  it("COPIED TOKEN: a stolen aal1 token of the same session gains nothing beyond the exact approved operation", async () => {
    const owner = await token();
    const stolen = owner; // the attacker holds an exact copy
    const { intent } = await refused(owner);
    // Before approval the attacker gets nothing with the reference.
    expect((await call("POST", EXPORT, stolen, { stepUpIntentId: intent })).status).toBe(403);
    const again = await refused(owner);
    await approve(owner, again.intent);
    // After the owner's verification: any other action, with or without the reference, is still refused.
    expect((await call("POST", "/v1/billing/portal", stolen, {})).status).toBe(403);
    expect((await call("POST", "/v1/account/topup", stolen, { stepUpIntentId: again.intent })).status).toBe(403);
    expect((await call("POST", "/v1/account/home/reset", stolen, {})).status).toBe(403);
    expect(await exports()).toBe(0);
  });

  it("cross-session: another session can neither send for, verify, nor use this session's intent", async () => {
    const a = await token(S1);
    const b = await token(S2);
    const { intent } = await refused(a);
    expect(await out(await send(b, intent))).toEqual([403, { error: "intent_refused" }]);
    const [, sent] = await out(await send(a, intent));
    expect(await out(await verify(b, intent, sent.challengeId, codeFromMail()))).toEqual([403, { error: "code_refused" }]);
    expect((await verify(a, intent, sent.challengeId, codeFromMail())).status).toBe(200);
    const [s, body] = await out(await call("POST", EXPORT, b, { stepUpIntentId: intent }));
    expect(s).toBe(403);
    expect(body.step_up.email_code.intent_id).not.toBe(intent);
    expect((await call("POST", EXPORT, a, { stepUpIntentId: intent })).status).toBe(201);
  });

  it("address generations: a change after sending refuses the code; A->B->A after approval voids it", async () => {
    const t = await token();
    const { intent } = await refused(t);
    const [, sent] = await out(await send(t, intent));
    const code = codeFromMail();
    changeEmail("other@example.test");
    changeEmail(EMAIL);
    expect(await out(await verify(t, intent, sent.challengeId, code))).toEqual([403, { error: "code_refused" }]);

    clock += 31_000;
    const second = await refused(t);
    await approve(t, second.intent);
    changeEmail("other@example.test");
    changeEmail(EMAIL);
    expect((await call("POST", EXPORT, t, { stepUpIntentId: second.intent })).status).toBe(403);
    expect(await exports()).toBe(0);
  });

  it("logout (Supabase server revocation): send, verify and the approved action are all refused", async () => {
    const t = await token();
    const { intent } = await refused(t);
    const [, sent] = await out(await send(t, intent));
    const code = codeFromMail();
    revoked.add(S1);
    expect((await verify(t, intent, sent.challengeId, code)).status).toBe(401);
    revoked.clear();
    expect((await verify(t, intent, sent.challengeId, code)).status).toBe(200);
    revoked.add(S1);
    expect((await call("POST", EXPORT, t, { stepUpIntentId: intent })).status).toBe(401);
    expect((await send(t, intent)).status).toBe(401);
    expect(await exports()).toBe(0);
  });

  it("Supabase unavailable at the claim: 503 identity_unavailable, never authority", async () => {
    const t = await token();
    const { intent } = await refused(t);
    await approve(t, intent);
    supa.updatedAt = "";
    expect(await out(await call("POST", EXPORT, t, { stepUpIntentId: intent }))).toEqual([503, { error: "identity_unavailable" }]);
    expect(await exports()).toBe(0);
  });
});

describe("logs, ignored references, factor administration", () => {
  it("GET logs takes ?stepUpIntentId=, its handler's repeated checks see the claimed proof, and the answer is marked consumed", async () => {
    const t = await token();
    const { intent } = await refused(t, "/v1/account/home/logs", undefined, "GET");
    await approve(t, intent);
    const res = await call("GET", `/v1/account/home/logs?stepUpIntentId=${intent}`, t);
    expect(res.status).toBe(200);
    expect(res.headers.get(HDR)).toBe("1");
    expect(await res.json<Body>()).toMatchObject({ pending: false, lines: [] });
  });

  it("POST logs/request takes stepUpIntentId in its body (stripped before the strict empty-body check)", async () => {
    const t = await token();
    await runner();
    const { intent } = await refused(t, "/v1/account/home/logs/request", {});
    await approve(t, intent);
    const res = await call("POST", "/v1/account/home/logs/request", t, { stepUpIntentId: intent });
    expect(res.headers.get(HDR)).toBe("1");
    const [s, b] = await out(res);
    expect(s).toBe(202);
    expect(b).toMatchObject({ state: "requested", commandId: expect.any(String) });
  });

  it("a stepUpIntentId on an unprotected route is stripped and ignored, never refused, never marked consumed", async () => {
    const t = await token();
    const listed = await call("GET", `/v1/account/mfa/factors?stepUpIntentId=si_${"1".repeat(32)}`, t);
    expect(listed.status).toBe(200);
    expect(listed.headers.get(HDR)).toBeNull();
    const { intent } = await refused(t);
    // A strict-body unprotected route: the field is gone before its validation.
    const [s, b] = await out(await call("POST", "/v1/account/step-up/email/send", t, { intentId: intent, stepUpIntentId: "anything" }));
    expect(s).toBe(202);
    expect(b.sent).toBe(true);
  });

  it("a malformed reference on a protected route is a normal refusal with a fresh intent", async () => {
    const [s, b] = await out(await call("POST", EXPORT, await token(), { stepUpIntentId: "nope" }));
    expect(s).toBe(403);
    expect(b.step_up.email_code.intent_id).toMatch(/^si_/);
  });

  it("factor administration still refuses an email approval (trusted-factors.ts calls trustedStepUpRequirement directly)", async () => {
    const t = await token();
    supa.factors = [{ id: FM, factor_type: "totp", status: "verified" }, { id: "22222222-2222-4222-8222-222222222222", factor_type: "totp", status: "verified" }];
    await env.DB.prepare("INSERT INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state) VALUES (?,?,'totp','email_code',0,0,'active')")
      .bind(await userId(), FM).run();
    const { intent } = await refused(t);
    await approve(t, intent);
    const [s, b] = await out(await call("POST", "/v1/account/mfa/trust", t, { factorId: "22222222-2222-4222-8222-222222222222", stepUpIntentId: intent }));
    expect(s).toBe(403);
    expect(b.error).toBe("step_up_required");
    expect(b.step_up.email_code).toBeUndefined();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_trusted_factors").first<{ n: number }>())!.n).toBe(1);
  });

  it("both endpoints are classified by the edge limiter, in their own key space", () => {
    for (const p of ["send", "verify"]) {
      expect(classifyEdge(new Request(`https://auth.murage.test/v1/account/step-up/email/${p}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9" } })))
        .toEqual({ limiter: "MACHINE_OPEN_LIMIT", key: "stepup:203.0.113.9" });
    }
  });

  it("six digits, uniformly drawn, leading zeros kept", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) { const c = sixDigits(); expect(c).toMatch(/^\d{6}$/); seen.add(c[0]); }
    expect(seen.size).toBe(10);
  });
});

describe("STEPUP-EMAIL-2: no stored answers, frozen targets, atomic claims, bound continuations, the execution journal", () => {
  const LOGS_REQUEST = "/v1/account/home/logs/request";
  const SUBKEY = "/v1/homes/home-se/flux/subkey";
  /** A ready export archive of home-se whose decryption key has not been shown yet. */
  async function exportReady() {
    const requestId = crypto.randomUUID();
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await keyWrapperFor({ ...env, CLOUD_KEK_V1: KEK } as unknown as Env).wrap("home-se", keyBytes);
    await env.DB.prepare(`INSERT INTO cloud_export_jobs (request_id,home_id,state,requested_at,deliver_by,ready_at,available_until,file,format,bytes,sha256,wrapped_key,archive_id)
      VALUES (?,'home-se','ready',0,?,0,?,?,'tar.zst.age',19,?,?,?)`)
      .bind(requestId, Date.now() + 86_400_000, Date.now() + 86_400_000, `exports/${requestId}/archive.tar.zst.age`, "a".repeat(64), wrapped, requestId).run();
    return { requestId, raw: Buffer.from(keyBytes).toString("base64url"), hex: Buffer.from(keyBytes).toString("hex") };
  }
  /** home-se as a Flux home: an active machine with a bound IP, the owner's link, and (optionally) an active key row. */
  async function fluxHome(keyRow = true) {
    const owner = await userId();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cloud_machines (id,home_id,generation,state,credential_hash,bound_ips,created_at,public_origin,admin_url)
        VALUES ('home-se','home-se',1,'active',NULL,'["203.0.113.7"]',0,'https://h.murage.test','https://admin.murage.test')`),
      env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,?,0,'link-1',1,0)")
        .bind(owner, "11111111-2222-3333-4444-555555555555"),
      ...(keyRow ? [env.DB.prepare(`INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,lifecycle_version,updated_at)
        VALUES ('home-se','starter',0,'active',30000000,0,3,0)`)] : []),
    ]);
  }

  it("#1 the export decryption key is never stored: the answer is delivered once, its duplicate is 410 with the reference only", async () => {
    const t = await token();
    const { requestId, raw, hex } = await exportReady();
    const { intent } = await refused(t, "/v1/account/export/download", { requestId });
    await approve(t, intent);
    const res = await call("POST", "/v1/account/export/download", t, { requestId, stepUpIntentId: intent });
    expect(res.headers.get(HDR)).toBe("1");
    const [s, b] = await out(res);
    expect(s).toBe(200);
    expect(b.key).toMatch(/^AGE-SECRET-KEY-1/);
    const downloadToken = (b.url as string).split("/").at(-1)!;
    const again = await call("POST", "/v1/account/export/download", t, { requestId, stepUpIntentId: intent });
    expect(again.headers.get(HDR)).toBe("1");
    expect(await out(again)).toEqual([410, { error: "already_completed", operation: { id: intent } }]);
    // The probe: nothing of the secret answer anywhere in D1.
    const all = await everything();
    for (const secret of [b.key as string, downloadToken, raw, hex]) expect(all).not.toContain(secret);
    expect(await intentRow(intent)).toMatchObject({ state: "done", secret: 1, response_status: 200, response_code: null, response_ref: null });
  });

  it("#1 the Flux key is never stored; the mint runs under the approval's operation key", async () => {
    await fluxHome();
    const t = await token();
    const { intent } = await refused(t, SUBKEY, {});
    await approve(t, intent);
    const res = await call("POST", SUBKEY, t, { stepUpIntentId: intent });
    expect(res.headers.get(HDR)).toBe("1");
    const [s, b] = await out(res);
    expect(s).toBe(200);
    expect(b.key).toMatch(/^sk-flux-stepup-secret-/);
    expect(fluxCalls.mints).toHaveLength(1);
    expect(fluxCalls.mints[0].opId).toBe(`owner:home-se:${intent}`);
    const again = await call("POST", SUBKEY, t, { stepUpIntentId: intent });
    expect(await out(again)).toEqual([410, { error: "already_completed", operation: { id: intent } }]);
    expect(fluxCalls.mints).toHaveLength(1);
    expect(await everything()).not.toContain(b.key as string);
  });

  it("COPIED TOKEN race on a secret-bearing operation: one execution, and the loser never receives the secret", async () => {
    const t = await token();
    const { requestId } = await exportReady();
    const { intent } = await refused(t, "/v1/account/export/download", { requestId });
    await approve(t, intent);
    const both = await Promise.all([1, 2].map(() => call("POST", "/v1/account/export/download", t, { requestId, stepUpIntentId: intent })));
    const bodies = await Promise.all(both.map((r) => out(r)));
    for (const r of both) expect(r.headers.get(HDR)).toBe("1");
    const winners = bodies.filter(([s]) => s === 200);
    expect(winners).toHaveLength(1);
    const key = winners[0][1].key as string;
    const loser = bodies.find(([s]) => s !== 200)!;
    expect([409, 410]).toContain(loser[0]);
    expect(JSON.stringify(loser[1])).not.toContain(key);
    expect(loser[1].operation).toEqual({ id: intent });
    const later = await call("POST", "/v1/account/export/download", t, { requestId, stepUpIntentId: intent });
    const [ls, lb] = await out(later);
    expect(ls).toBe(410);
    expect(JSON.stringify(lb)).not.toContain(key);
  });

  it("#2 an approved /flux/subkey intent is void after an owner Stop: refused with a fresh intent, nothing minted", async () => {
    await fluxHome();
    const t = await token();
    const { intent } = await refused(t, SUBKEY, {});
    await approve(t, intent);
    // The owner's Stop (b4-flux.ts ownerStop) advances the lifecycle version and stops the home.
    await env.DB.prepare("UPDATE flux_home_keys SET lifecycle_version=lifecycle_version+1, state='stopped' WHERE home_id='home-se'").run();
    const res = await call("POST", SUBKEY, t, { stepUpIntentId: intent });
    const [s, b] = await out(res);
    expect(s).toBe(403);
    expect(b.error).toBe("step_up_required");
    expect(b.step_up.email_code.intent_id).not.toBe(intent);
    expect(res.headers.get(HDR)).toBeNull();
    expect(fluxCalls.mints).toHaveLength(0);
    expect(await intentRow(intent)).toBeNull();
  });

  it("#2 a cap or link change after approval voids it too", async () => {
    await fluxHome();
    const t = await token();
    const first = await refused(t, SUBKEY, {});
    await approve(t, first.intent);
    await env.DB.prepare("UPDATE flux_home_keys SET cap_version=cap_version+1 WHERE home_id='home-se'").run();
    expect((await call("POST", SUBKEY, t, { stepUpIntentId: first.intent })).status).toBe(403);
    clock += 31_000;
    const second = await refused(t, SUBKEY, {});
    await approve(t, second.intent);
    await env.DB.prepare("UPDATE flux_links SET link_version=link_version+1").run();
    expect((await call("POST", SUBKEY, t, { stepUpIntentId: second.intent })).status).toBe(403);
    expect(fluxCalls.mints).toHaveLength(0);
  });

  it("#3 a newer home inserted immediately before the claiming statement: the claim fails, neither home is acted on", async () => {
    await runner();
    await runner("home-new");
    const t = await token();
    const { intent } = await refused(t, LOGS_REQUEST, {});
    await approve(t, intent);
    armDb(/SET state='executing', phase=/, newerHome);
    const [s, b] = await out(await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent }));
    expect(s).toBe(403);
    expect(b.error).toBe("step_up_required");
    expect(b.step_up.email_code.intent_id).not.toBe(intent);
    expect(await commands()).toEqual([]);
  });

  it("#3 a newer home inserted after the claim, before the handler resolves its home: the pinned home wins, nothing is selected", async () => {
    await runner();
    await runner("home-new");
    const t = await token();
    const { intent } = await refused(t, LOGS_REQUEST, {});
    await approve(t, intent);
    armDb(/SET state='executing', phase=/, async () => { armDb(/^SELECT \* FROM cloud_homes WHERE owner_id=\?/, newerHome); });
    const res = await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent });
    const [s, b] = await out(res);
    expect(s).toBe(403);
    expect(b.error).toBe("step_up_required");
    expect(b.step_up.email_code.intent_id).not.toBe(intent);
    expect(res.headers.get(HDR)).toBe("1");
    expect(await commands()).toEqual([]);
    expect(await intentRow(intent)).toBeNull();
  });

  it("#4 the logs continuation reads only that collection of that home, and never past the ORIGINAL grant deadline", async () => {
    await runner();
    const t = await token();
    const { intent } = await refused(t, LOGS_REQUEST, {});
    await approve(t, intent);
    const approvedAt = clock;
    clock += 300_000;
    const [rs, rb] = await out(await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent }));
    expect(rs).toBe(202);
    const line = (m: string) => JSON.stringify([{ at: 1, level: "info", source: "murage", message: m }]);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cloud_home_logs (home_id,chunk,command_id,lines,collected_at,expires_at) VALUES ('home-se',0,?,?,1,?)").bind(rb.commandId, line("ours"), Date.now() + 3_600_000),
      env.DB.prepare("INSERT INTO cloud_home_logs (home_id,chunk,command_id,lines,collected_at,expires_at) VALUES ('home-se',1,'other-cmd',?,1,?)").bind(line("theirs"), Date.now() + 3_600_000),
    ]);
    const read = () => call("GET", `/v1/account/home/logs?stepUpIntentId=${intent}`, t);
    const [gs, gb] = await out(await read());
    expect(gs).toBe(200);
    expect(gb.lines.map((l: Body) => l.message)).toEqual(["ours"]);
    // Another session, or another home becoming the current one: refused.
    expect((await call("GET", `/v1/account/home/logs?stepUpIntentId=${intent}`, await token(S2))).status).toBe(403);
    await newerHome();
    expect((await read()).status).toBe(403);
    await env.DB.prepare("DELETE FROM cloud_homes WHERE id='home-new'").run();
    expect((await read()).status).toBe(200);
    // The original grant ends 600 s after approval (here 300 s after the collection was requested): no new window.
    clock = approvedAt + 600_000 + 1;
    expect((await read()).status).toBe(403);
  });

  it("#5 a busy home consumes nothing: 409 home_busy, the approval stays, the exact retry runs once the lease is free", async () => {
    await runner();
    const t = await token();
    const { intent } = await refused(t, LOGS_REQUEST, {});
    await approve(t, intent);
    await env.DB.prepare("INSERT INTO billing_home_leases (home_id,holder,lease_until,generation) VALUES ('home-se','other',?,1)").bind(Date.now() + 120_000).run();
    const busy = await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent });
    expect(busy.status).toBe(409);
    expect((await busy.json<Body>()).error).toBe("home_busy");
    expect(busy.headers.get(HDR)).toBeNull();
    expect((await intentRow(intent))!.state).toBe("approved");
    await env.DB.prepare("DELETE FROM billing_home_leases").run();
    const ran = await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent });
    expect(ran.status).toBe(202);
    expect(ran.headers.get(HDR)).toBe("1");
    expect(await commands()).toHaveLength(1);
  });

  it("#5 home_busy inside the handler before any write releases the approval for an exact retry", async () => {
    await runner();
    const t = await token();
    const { intent } = await refused(t, LOGS_REQUEST, {});
    await approve(t, intent);
    // The claim took the home's lease; before the handler wrote anything, another holder took it over (the claim's lease lost).
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/UPDATE billing_home_leases SET lease_until=/, async () => {
        await env.DB.prepare("UPDATE billing_home_leases SET holder='other', lease_until=?, generation=generation+1 WHERE home_id='home-se'").bind(Date.now() + 120_000).run();
      });
    });
    const busy = await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent });
    expect(busy.status).toBe(409);
    expect((await busy.json<Body>()).error).toBe("home_busy");
    expect(busy.headers.get(HDR)).toBeNull();
    expect(await intentRow(intent)).toMatchObject({ state: "approved", phase: null, exec_token: null });
    await env.DB.prepare("DELETE FROM billing_home_leases").run();
    const ran = await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent });
    expect(ran.status).toBe(202);
    expect(ran.headers.get(HDR)).toBe("1");
    expect(await commands()).toHaveLength(1);
  });

  it("#5 an interruption after the claim leaves a resumable record: 409 while it may run, then the retry resumes it once", async () => {
    await runner();
    const t = await token();
    const { intent } = await refused(t, LOGS_REQUEST, {});
    await approve(t, intent);
    // A worker claimed it and died before any write.
    await env.DB.prepare("UPDATE cloud_stepup_intents SET state='executing', phase='claimed', exec_token='dead-worker', exec_until=?, claimed_at=? WHERE id=?")
      .bind(clock + 120_000, clock, intent).run();
    const running = await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent });
    expect(await out(running)).toEqual([409, { error: "action_in_progress", operation: { id: intent } }]);
    expect(running.headers.get(HDR)).toBe("1");
    clock += 120_001;
    const resumed = await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent });
    expect(resumed.status).toBe(202);
    expect(resumed.headers.get(HDR)).toBe("1");
    expect(await commands()).toHaveLength(1);
    expect((await intentRow(intent))!.state).toBe("done");
  });

  it("#5 an interruption after the handler's writes committed reconciles to completed, never a second execution", async () => {
    await runner();
    const t = await token();
    const { intent } = await refused(t, LOGS_REQUEST, {});
    await approve(t, intent);
    await env.DB.prepare("UPDATE cloud_stepup_intents SET state='executing', exec_token='dead-worker', exec_until=?, claimed_at=?, phase='committed' WHERE id=?")
      .bind(clock + 120_000, clock, intent).run();
    clock += 120_001;
    const res = await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent });
    expect(await out(res)).toEqual([410, { error: "already_completed", operation: { id: intent } }]);
    expect(res.headers.get(HDR)).toBe("1");
    expect(await commands()).toHaveLength(0);
  });

  it("#5 an unexpected exception after the claim is marked consumed and stays resumable; the exact retry resumes it", async () => {
    await runner();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = await token();
    const { intent } = await refused(t, LOGS_REQUEST, {});
    await approve(t, intent);
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/selfservice_rate_limits/, async () => { throw new Error("worker fell over"); });
    });
    const failed = await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent });
    expect(failed.status).toBe(500);
    expect(failed.headers.get(HDR)).toBe("1");
    expect(await intentRow(intent)).toMatchObject({ state: "executing", phase: "claimed" });
    const resumed = await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent });
    expect(resumed.status).toBe(202);
    expect(resumed.headers.get(HDR)).toBe("1");
    expect(await commands()).toHaveLength(1);
  });

  it("#5 the journal fences a stale runner: once the operation was taken over, its writes roll back", async () => {
    await runner();
    const t = await token();
    const { intent } = await refused(t, LOGS_REQUEST, {});
    await approve(t, intent);
    // While this request runs, a reconciling retry takes the operation over (its token changes): this runner's command must not land.
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/INSERT INTO cloud_home_commands/, async () => {
        await env.DB.prepare("UPDATE cloud_stepup_intents SET exec_token='other-runner' WHERE id=?").bind(intent).run();
      });
    });
    const res = await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent });
    expect(res.headers.get(HDR)).toBe("1");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await commands()).toHaveLength(0);
  });

  it("#6 an exact retry after completion with a fresh authenticator gets the replay record, never a second execution", async () => {
    const t = await token();
    const { intent } = await refused(t);
    await approve(t, intent);
    const [s] = await out(await call("POST", EXPORT, t, { stepUpIntentId: intent }));
    expect(s).toBe(201);
    const strong = await authenticatorToken();
    const again = await call("POST", EXPORT, strong, { stepUpIntentId: intent });
    expect(again.headers.get(HDR)).toBe("1");
    const [s2, b2] = await out(again);
    expect(s2).toBe(201);
    expect(b2).toMatchObject({ replayed: true, operation: { id: intent } });
    expect(await exports()).toBe(1);
  });

  it("#6 a pending intent retried with a fresh authenticator is recorded as the operation: its exact retry is answered, not re-run", async () => {
    const t = await token();
    const { intent } = await refused(t);
    const strong = await authenticatorToken();
    const first = await call("POST", EXPORT, strong, { stepUpIntentId: intent });
    expect(first.status).toBe(201);
    expect(first.headers.get(HDR)).toBe("1");
    const [s, b] = await out(await call("POST", EXPORT, strong, { stepUpIntentId: intent }));
    expect(s).toBe(201);
    expect(b).toMatchObject({ replayed: true, operation: { id: intent } });
    // It was never email-approved: the email path cannot claim it.
    expect((await intentRow(intent))!.approved_at).toBeNull();
  });
});

describe("STEPUP-EMAIL-3: claims under the handler's lease, fenced disclosure, explicit phases", () => {
  const SUBKEY = "/v1/homes/home-se/flux/subkey";
  const PORTAL = "/v1/billing/portal";
  async function fluxHome() {
    const owner = await userId();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cloud_machines (id,home_id,generation,state,credential_hash,bound_ips,created_at,public_origin,admin_url)
        VALUES ('home-se','home-se',1,'active',NULL,'["203.0.113.7"]',0,'https://h.murage.test','https://admin.murage.test')`),
      env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,?,0,'link-1',1,0)")
        .bind(owner, "11111111-2222-3333-4444-555555555555"),
      env.DB.prepare(`INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,lifecycle_version,updated_at)
        VALUES ('home-se','starter',0,'stopped',30000000,0,3,0)`),
    ]);
  }
  const keyRow = () => env.DB.prepare("SELECT state,lifecycle_version,op_holder FROM flux_home_keys WHERE home_id='home-se'").first<Body>();
  afterEach(async () => {
    await env.DB.batch(["flux_home_ops", "flux_home_keys", "flux_links", "cloud_machines", "billing_subscriptions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it("#2 the claim holds the Flux home lease: an owner Stop that lands after it voids the approved resume (never 200, never active)", async () => {
    await fluxHome();
    const t = await token();
    const { intent } = await refused(t, SUBKEY, {});
    await approve(t, intent);
    const strong = await authenticatorToken(S2);
    let stop: [number, Body] | null = null;
    // The claim passes; then, before the handler mints, the owner's Stop (another session, a trusted authenticator) completes its batch.
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/INSERT OR IGNORE INTO flux_home_keys/, async () => { stop = [...await out(await call("POST", "/v1/homes/home-se/flux/stop", strong, {}))]; });
    });
    const res = await call("POST", SUBKEY, t, { stepUpIntentId: intent });
    expect(stop![0]).toBeGreaterThanOrEqual(200);
    expect(stop![0]).toBeLessThan(300);
    // Refused: the Stop moved the target the approval was frozen at, so the approval is void and a fresh one is asked for (Astra
    // STEPUP-EMAIL-7 #2: the mint's reservation validates the whole frozen target).
    const [status, refusal] = await out(res);
    expect([status, refusal.error]).toEqual([403, "step_up_required"]);
    expect(fluxCalls.mints).toHaveLength(0);
    const k = await keyRow();
    expect(k!.state).not.toBe("active");
    expect(k!.op_holder).toBeNull();
  });

  it("STEPUP-EMAIL-6 #2 an approved cap increase superseded by a newer reduction (cap_version 2) is refused, never committed as version 3", async () => {
    const CAP = "/v1/homes/home-se/flux/cap";
    await fluxHome();
    await env.DB.prepare("UPDATE flux_home_keys SET cap_version=1 WHERE home_id='home-se'").run();
    const t = await token();
    const { intent } = await refused(t, CAP, { capUsd: 500 });
    await approve(t, intent);
    const capRow = () => env.DB.prepare("SELECT cap_microcents,cap_version FROM flux_home_keys WHERE home_id='home-se'").first<Body>();
    // The claim passes and the handler holds the Flux lease; then, just before the approved increase is written, another cap writer
    // (a plan change, a reduction from a trusted authenticator) lands a NEWER cap: version 2.
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/UPDATE flux_home_keys SET plan=\?,cap_microcents=/, async () => {
        await env.DB.prepare("UPDATE flux_home_keys SET cap_microcents=1000000000,cap_custom=1,cap_version=2 WHERE home_id='home-se'").run();
      });
    });
    const [status, b] = await out(await call("POST", CAP, t, { capUsd: 500, stepUpIntentId: intent }));
    expect([status, b.error]).toEqual([403, "step_up_required"]);
    expect(b.step_up.email_code.intent_id).not.toBe(intent);
    // The reduction stands; nothing of the stale approval was written or queued.
    expect(await capRow()).toEqual({ cap_microcents: 1000000000, cap_version: 2 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_home_ops WHERE home_id='home-se'").first<{ n: number }>())!.n).toBe(0);
    expect(await intentRow(intent)).toBeNull();
    expect((await keyRow())!.op_holder).toBeNull();
  });

  it("STEPUP-EMAIL-6 #2 the same approved cap change with no newer writer commits exactly once, at the next version", async () => {
    const CAP = "/v1/homes/home-se/flux/cap";
    await fluxHome();
    await env.DB.prepare("UPDATE flux_home_keys SET cap_version=1 WHERE home_id='home-se'").run();
    const t = await token();
    const { intent } = await refused(t, CAP, { capUsd: 500 });
    await approve(t, intent);
    const res = await call("POST", CAP, t, { capUsd: 500, stepUpIntentId: intent });
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT cap_version FROM flux_home_keys WHERE home_id='home-se'").first<Body>()).toEqual({ cap_version: 2 });
    expect(await intentRow(intent)).toMatchObject({ state: "done" });
  });

  it("#2 a busy Flux lease at claim time consumes nothing; the claim itself takes the lease in the same batch", async () => {
    await fluxHome();
    const t = await token();
    const { intent } = await refused(t, SUBKEY, {});
    await approve(t, intent);
    await env.DB.prepare("UPDATE flux_home_keys SET op_holder='someone', op_lease_until=? WHERE home_id='home-se'").bind(clock + 60_000).run();
    const busy = await call("POST", SUBKEY, t, { stepUpIntentId: intent });
    // Never claimed: nothing consumed, and the answer says nothing of the kind.
    expect(busy.headers.get(HDR)).toBeNull();
    expect(await out(busy)).toEqual([409, { error: "home_busy" }]);
    expect((await intentRow(intent))!.state).toBe("approved");
    await env.DB.prepare("UPDATE flux_home_keys SET op_holder=NULL, op_lease_until=NULL WHERE home_id='home-se'").run();
    let held: Body | null = null;
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/INSERT OR IGNORE INTO flux_home_keys/, async () => { held = await keyRow(); });
    });
    const ran = await call("POST", SUBKEY, t, { stepUpIntentId: intent });
    expect(ran.status).toBe(200);
    expect(held!.op_holder).toMatch(/^stepup-/);
    expect(await intentRow(intent)).toMatchObject({ state: "done", phase: "delivered", lease_kind: "flux" });
    expect((await keyRow())!.op_holder).toBeNull();
  });

  it("#3 the real portal handler, two runners: the superseded one never returns a URL; only the finalizing one does", async () => {
    await env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at)
      VALUES ('home-se','cus_se','sub_se','starter','active',0,0)`).run();
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const atStripe = new Promise<void>((r) => { reached = r; });
    const stripeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.startsWith("/v1/billing_portal/configurations")) {
        return Response.json({ id: decodeURIComponent(url.pathname.split("/")[4] ?? "bpc_default"), features: { subscription_update: { enabled: false } } });
      }
      if (url.pathname === "/v1/billing_portal/sessions" && (init?.method ?? "GET") === "POST") {
        const mine = ++n;
        if (mine === 1) { reached(); await gate; }
        return Response.json({ url: `https://billing.stripe.test/p/${mine}` });
      }
      return Response.json({ error: { code: "unexpected" } }, { status: 500 });
    }) as typeof fetch;
    const w = makeWorker({ stripeFetch, now: () => clock });
    extraEnv = { STRIPE_SECRET_KEY: "sk_test_stepupportal0123", STRIPE_WEBHOOK_SECRET: "whsec_stepupportal0123", BILLING_RETURN_ORIGIN: "https://cloud.murage.test",
      STRIPE_PRICE_STARTER: "price_stepupstarter1", STRIPE_PRICE_PRO: "price_stepuppro00001", STRIPE_PRICE_MAX: "price_stepupmax00001", STRIPE_PORTAL_CONFIGURATION: "bpc_stepup000001" };
    const t = await token();
    const { intent } = await refused(t, PORTAL, {});
    await approve(t, intent);
    const first = call("POST", PORTAL, t, { stepUpIntentId: intent }, w);
    // (A first runner that ended before reaching Stripe fails here with its answer, instead of waiting forever.)
    await Promise.race([atStripe, first.then(async (r) => { throw new Error(`first runner ended early: ${r.status} ${await r.clone().text()}`); })]);
    expect((await intentRow(intent))!.phase).toBe("dispatched");
    // The first runner's execution lease runs out while Stripe is still answering it: an exact retry takes the operation over.
    clock += 120_001;
    const second = await call("POST", PORTAL, t, { stepUpIntentId: intent }, w);
    release();
    const late = await first;
    const answers = [[second.status, await second.text()], [late.status, await late.text()]] as const;
    const withUrl = answers.filter(([, b]) => b.includes("billing.stripe.test"));
    expect(withUrl).toHaveLength(1);
    expect(answers[0][0]).toBe(200);
    expect(answers[1][0]).toBe(409);
    expect(JSON.parse(answers[1][1])).toEqual({ error: "action_in_progress", operation: { id: intent } });
    expect(late.headers.get(HDR)).toBe("1");
    expect(await intentRow(intent)).toMatchObject({ state: "done", phase: "delivered" });
    expect(await env.DB.prepare("SELECT holder FROM billing_home_leases WHERE home_id='home-se'").first<Body>()).toMatchObject({ holder: null });
  });

  it("#4 an interruption before the mint (only lease bookkeeping happened) is NOT done: the exact retry mints once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await fluxHome();
    const t = await token();
    const { intent } = await refused(t, SUBKEY, {});
    await approve(t, intent);
    // The runner acquired the Flux lease and died before anything of the mint.
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/SELECT op_id,seq,kind,payload,attempts FROM flux_home_ops/, async () => { throw new Error("worker fell over"); });
    });
    const failed = await call("POST", SUBKEY, t, { stepUpIntentId: intent });
    expect(failed.status).toBe(500);
    expect(failed.headers.get(HDR)).toBe("1");
    expect(fluxCalls.mints).toHaveLength(0);
    expect(await intentRow(intent)).toMatchObject({ state: "executing", phase: "claimed" });
    expect((await keyRow())!.op_holder).toBeNull();
    const retried = await call("POST", SUBKEY, t, { stepUpIntentId: intent });
    expect(retried.status).toBe(200);
    expect(fluxCalls.mints).toHaveLength(1);
    expect(fluxCalls.mints[0].opId).toBe(`owner:home-se:${intent}`);
    expect(await intentRow(intent)).toMatchObject({ state: "done", phase: "delivered" });
  });

  it("#4 an interruption after the key committed leaves delivery pending; the sweep revokes that undelivered key by phase", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await fluxHome();
    const t = await token();
    const { intent } = await refused(t, SUBKEY, {});
    await approve(t, intent);
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/UPDATE flux_home_keys SET generation=\?,state='active'/, async () => {
        armDb(/SELECT op_id,seq,kind,payload,attempts FROM flux_home_ops/, async () => { throw new Error("worker fell over"); });
      });
    });
    const failed = await call("POST", SUBKEY, t, { stepUpIntentId: intent });
    expect(failed.status).toBe(500);
    expect(failed.headers.get(HDR)).toBe("1");
    expect(JSON.stringify(await failed.json())).not.toMatch(/sk-flux/);
    expect(fluxCalls.mints).toHaveLength(1);
    const generation = fluxCalls.mints[0].generation;
    expect(await intentRow(intent)).toMatchObject({ state: "done", phase: "committed", dispatch_ref: `flux:home-se:${generation}` });
    // Never re-run: its duplicate is 410 with the reference only.
    expect(await out(await call("POST", SUBKEY, t, { stepUpIntentId: intent }))).toEqual([410, { error: "already_completed", operation: { id: intent } }]);
    expect(fluxCalls.mints).toHaveLength(1);
    await sweepStepUpEmail(testEnv(), clock);
    // Queued, not yet confirmed: 'compensating' (STEPUP-EMAIL-4 #3), never compensated on the queue alone.
    expect((await intentRow(intent))!.phase).toBe("compensating");
    const comp = await env.DB.prepare("SELECT payload FROM flux_home_ops WHERE home_id='home-se' AND kind='compensate' AND state IN ('queued','running')").all<{ payload: string }>();
    expect(comp.results.map((r) => JSON.parse(r.payload).generation)).toContain(generation);
    // A second sweep compensates nothing more.
    await sweepStepUpEmail(testEnv(), clock);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_home_ops WHERE kind='compensate'").first<{ n: number }>())!.n).toBe(comp.results.length);
    // STEPUP-EMAIL-4 #3: the drain revokes EXACTLY that generation (the committed one) once, the key stops being active, and only the
    // router's confirmation records the operation compensated.
    expect((await env.DB.prepare("SELECT state,generation FROM flux_home_keys WHERE home_id='home-se'").first<Body>())).toMatchObject({ state: "active", generation });
    await sweepFlux(testEnv(), { fluxClient: () => fakeFlux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect(fluxCalls.revokes.filter((r) => r.generation === generation)).toEqual([{ homeId: "home-se", generation, reason: "undelivered" }]);
    expect((await keyRow())!.state).not.toBe("active");
    expect((await intentRow(intent))!.phase).toBe("compensated");
    expect(await env.DB.prepare("SELECT state FROM flux_home_ops WHERE op_id=?").bind(`undelivered:${intent}`).first<Body>()).toEqual({ state: "done" });
    await sweepStepUpEmail(testEnv(), clock);
    await sweepFlux(testEnv(), { fluxClient: () => fakeFlux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect(fluxCalls.revokes.filter((r) => r.generation === generation)).toHaveLength(1);
  });

  it("#5 a committed export whose journal read then fails still answers x-step-up-consumed: 1", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = await token();
    const { intent } = await refused(t);
    await approve(t, intent);
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/SELECT phase, state FROM cloud_stepup_intents/, async () => { throw new Error("D1 hiccup"); });
    });
    const res = await call("POST", EXPORT, t, { stepUpIntentId: intent });
    expect(res.status).toBe(500);
    expect(res.headers.get(HDR)).toBe("1");
    expect(await exports()).toBe(1);
    expect((await intentRow(intent))!.phase).toBe("committed");
  });

  it("billing routes freeze only the home they act on: a change on ANOTHER home of the account does not void the approval", async () => {
    const t = await token();
    const { intent } = await refused(t);
    await approve(t, intent);
    await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
      VALUES ('home-old',?,?,'ready','ready',?,'k',-5,-5)`).bind(crypto.randomUUID(), await userId(), `sha256:${"b".repeat(64)}`).run();
    await env.DB.prepare("UPDATE cloud_homes SET generation=generation+1 WHERE id='home-old'").run();
    const res = await call("POST", EXPORT, t, { stepUpIntentId: intent });
    expect(res.status).toBe(201);
    expect(await intentRow(intent)).toMatchObject({ state: "done", lease_kind: "billing", lease_home: "home-se" });
    await env.DB.prepare("DELETE FROM cloud_homes WHERE id='home-old'").run();
  });
});

describe("STEPUP-EMAIL-4: link revisions, undelivered keys, own reservations, settled-only collection, consumed takeovers", () => {
  const SUBKEY = "/v1/homes/home-se/flux/subkey";
  const LINK = "/v1/flux/link/complete";
  const FLUX_ACCOUNT = "11111111-2222-3333-4444-555555555555";
  let signer: CryptoKey;
  let linkKey = "";
  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    signer = pair.privateKey;
    linkKey = b64u(await crypto.subtle.exportKey("raw", pair.publicKey));
  });
  /** home-se as a Flux home: an active machine, optionally the owner's link (v1) and a key row (stopped, lifecycle 3). */
  async function fluxHome(o: { link?: boolean; keyRow?: boolean } = {}) {
    const owner = await userId();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cloud_machines (id,home_id,generation,state,credential_hash,bound_ips,created_at,public_origin,admin_url)
        VALUES ('home-se','home-se',1,'active',NULL,'["203.0.113.7"]',0,'https://h.murage.test','https://admin.murage.test')`),
      ...(o.link === false ? [] : [env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,?,0,'link-1',1,0)")
        .bind(owner, FLUX_ACCOUNT)]),
      ...(o.keyRow === false ? [] : [env.DB.prepare(`INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,lifecycle_version,updated_at)
        VALUES ('home-se','starter',0,'stopped',30000000,0,3,0)`)]),
    ]);
  }
  /** A link challenge of the owner and Flux's signed proof for it: a /flux/link/complete body the handler accepts. */
  async function linkBody() {
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    await env.DB.prepare("INSERT INTO flux_link_challenges (state_hash,owner_user_id,expires_at) VALUES (?,?,?)").bind(await sha256(state), await userId(), clock + 3_600_000).run();
    const payload = { v: 1, aud: "murage-cloud-link", flux_account_id: FLUX_ACCOUNT, state, iat: nowS(), exp: nowS() + 3000, jti: crypto.randomUUID() };
    const encoded = b64u(JSON.stringify(payload));
    const signature = await crypto.subtle.sign({ name: "Ed25519" }, signer, new TextEncoder().encode(encoded));
    return { state, proof: `${encoded}.${b64u(signature)}` };
  }
  /** What an unlink leaves once finalized (b4-flux.ts finalizeUnlinkStmts): the fenced version in the floor, no link row. */
  const unlinked = async (version: number) => env.DB.batch([
    env.DB.prepare("DELETE FROM flux_links"),
    env.DB.prepare("INSERT INTO flux_link_floor (owner_user_id,version) VALUES (?,?) ON CONFLICT(owner_user_id) DO UPDATE SET version=excluded.version").bind(await userId(), version),
  ]);
  const links = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM flux_links").first<{ n: number }>())!.n;
  const keyRow = () => env.DB.prepare("SELECT state,lifecycle_version,op_holder,generation FROM flux_home_keys WHERE home_id='home-se'").first<Body>();
  /** The mint runner dies right after its key was committed (the key is active, never delivered). */
  async function undeliveredMint(t: string) {
    const { intent } = await refused(t, SUBKEY, {});
    await approve(t, intent);
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/UPDATE flux_home_keys SET generation=\?,state='active'/, async () => {
        armDb(/SELECT op_id,seq,kind,payload,attempts FROM flux_home_ops/, async () => { throw new Error("worker fell over"); });
      });
    });
    expect((await call("POST", SUBKEY, t, { stepUpIntentId: intent })).status).toBe(500);
    return intent;
  }
  beforeEach(() => { extraEnv = { FLUX_LINK_PUBLIC_KEY: linkKey }; });
  afterEach(async () => {
    await env.DB.batch(["flux_home_ops", "flux_home_keys", "flux_links", "flux_link_floor", "flux_link_challenges", "flux_link_proofs", "cloud_machines", "cloud_alerts"]
      .map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  });

  it("#2 absent -> linked -> unlinked: the approval frozen while absent never recreates the link", async () => {
    const t = await token();
    const body = await linkBody();
    const { intent } = await refused(t, LINK, body);
    await approve(t, intent);
    // Linked (v1), then unlinked and finalized: absent again, but at a later revision.
    await env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,?,0,'link-1',1,0)").bind(await userId(), FLUX_ACCOUNT).run();
    await env.DB.prepare("UPDATE flux_links SET link_version=2, fenced=1").run();
    await unlinked(2);
    const res = await call("POST", LINK, t, { ...body, stepUpIntentId: intent });
    const [s, b] = await out(res);
    expect([s, b.error]).toEqual([403, "step_up_required"]);
    expect(b.step_up.email_code.intent_id).not.toBe(intent);
    expect(await links()).toBe(0);
    expect(await intentRow(intent)).toBeNull();
  });

  it("#2 an unlink that completes between the claim and the link write: the relink is refused inside the inserting statement", async () => {
    await env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,?,0,'link-1',1,0)").bind(await userId(), FLUX_ACCOUNT).run();
    const t = await token();
    const body = await linkBody();
    const { intent } = await refused(t, LINK, body);
    await approve(t, intent);
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/INSERT OR IGNORE INTO flux_links /, async () => { await unlinked(2); });
    });
    const [s, b] = await out(await call("POST", LINK, t, { ...body, stepUpIntentId: intent }));
    expect([s, b.error]).toEqual([403, "step_up_required"]);
    expect(await links()).toBe(0);
    // Without an intervening change the same approval shape links: the revision check is not a blanket refusal.
    clock += 31_000;
    const body2 = await linkBody();
    const second = await refused(t, LINK, body2);
    await approve(t, second.intent);
    expect((await call("POST", LINK, t, { ...body2, stepUpIntentId: second.intent })).status).toBe(200);
    expect(await env.DB.prepare("SELECT link_version FROM flux_links").first<Body>()).toEqual({ link_version: 3 });
  });

  it("#4 a home with no key row yet: the claim's seeding is not a target change; the approved mint runs once", async () => {
    await fluxHome({ keyRow: false });
    const t = await token();
    const { intent } = await refused(t, SUBKEY, {});
    await approve(t, intent);
    const res = await call("POST", SUBKEY, t, { stepUpIntentId: intent });
    expect(res.status).toBe(200);
    expect(fluxCalls.mints).toHaveLength(1);
    expect(await intentRow(intent)).toMatchObject({ state: "done", phase: "delivered" });
  });

  it("#4 an interruption after the mint's own lifecycle reservation, before dispatch: the retry recognises it and mints once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await fluxHome();
    const t = await token();
    const { intent } = await refused(t, SUBKEY, {});
    await approve(t, intent);
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/UPDATE flux_home_ops SET payload=json_set/, async () => { throw new Error("worker fell over"); });
    });
    const failed = await call("POST", SUBKEY, t, { stepUpIntentId: intent });
    expect(failed.status).toBe(500);
    expect(failed.headers.get(HDR)).toBe("1");
    expect(fluxCalls.mints).toHaveLength(0);
    expect((await keyRow())!.lifecycle_version).toBe(4);
    const row = (await intentRow(intent))!;
    expect(row).toMatchObject({ state: "executing", phase: "claimed" });
    expect(row.reserved_target).not.toBeNull();
    const retried = await call("POST", SUBKEY, t, { stepUpIntentId: intent });
    expect(retried.status).toBe(200);
    expect(fluxCalls.mints).toHaveLength(1);
    expect(fluxCalls.mints[0].opId).toBe(`owner:home-se:${intent}`);
    expect(await intentRow(intent)).toMatchObject({ state: "done", phase: "delivered" });
  });

  it("#4 ... but an owner Stop that intervenes after that reservation still voids the approval: nothing minted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await fluxHome();
    const t = await token();
    const { intent } = await refused(t, SUBKEY, {});
    await approve(t, intent);
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/UPDATE flux_home_ops SET payload=json_set/, async () => { throw new Error("worker fell over"); });
    });
    expect((await call("POST", SUBKEY, t, { stepUpIntentId: intent })).status).toBe(500);
    const strong = await authenticatorToken(S2);
    const stop = await call("POST", "/v1/homes/home-se/flux/stop", strong, {});
    expect(stop.status).toBeLessThan(300);
    const [s, b] = await out(await call("POST", SUBKEY, t, { stepUpIntentId: intent }));
    expect([s, b.error]).toEqual([403, "step_up_required"]);
    expect(fluxCalls.mints).toHaveLength(0);
    expect((await keyRow())!.state).not.toBe("active");
    expect(await intentRow(intent)).toBeNull();
  });

  it("STEPUP-EMAIL-7 #2 after the claim, the home generation advances with the Flux lifecycle unchanged: 403 fresh intent, nothing minted or reserved", async () => {
    await fluxHome();
    const t = await token();
    const { intent } = await refused(t, SUBKEY, {});
    await approve(t, intent);
    const before = (await keyRow())!;
    // The claim passes; then, right before the mint's own reservation, the home moves to its next generation (a reset, a restore).
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/UPDATE flux_home_keys SET lifecycle_version = lifecycle_version \+/, async () => {
        await env.DB.prepare("UPDATE cloud_homes SET generation=generation+1 WHERE id='home-se'").run();
      });
    });
    const [s, b] = await out(await call("POST", SUBKEY, t, { stepUpIntentId: intent }));
    expect([s, b.error]).toEqual([403, "step_up_required"]);
    expect(b.step_up).toBeTruthy();
    expect(fluxCalls.mints).toHaveLength(0);
    const after = (await keyRow())!;
    expect([after.lifecycle_version, after.state]).toEqual([before.lifecycle_version, before.state]);
    // Never recorded as an own reservation: the approval is gone, not resumable at the new generation.
    expect(await intentRow(intent)).toBeNull();
    const again = await out(await call("POST", SUBKEY, t, { stepUpIntentId: intent }));
    expect(again[0]).toBe(403);
    expect(fluxCalls.mints).toHaveLength(0);
  });

  it("#5 a fresh refusal after expiry never deletes an undelivered mint record; the sweep then compensates it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await fluxHome();
    const t = await token();
    const intent = await undeliveredMint(t);
    expect(await intentRow(intent)).toMatchObject({ state: "done", phase: "committed" });
    // Past the record's expiry (the intent's 30 minutes); a fresh sign-in token of the same session refuses a new action.
    clock += 31 * 60_000;
    await refused(await token());
    expect(await intentRow(intent)).toMatchObject({ state: "done", phase: "committed" });
    await sweepStepUpEmail(testEnv(), clock);
    expect((await intentRow(intent))!.phase).toBe("compensating");
    await sweepFlux(testEnv(), { fluxClient: () => fakeFlux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    expect(fluxCalls.revokes.filter((r) => r.generation === fluxCalls.mints[0].generation)).toHaveLength(1);
    expect((await intentRow(intent))!.phase).toBe("compensated");
  });

  it("#6 a retry of an expired executing operation that meets the sweep's lease: 409 home_busy, marked consumed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await fluxHome();
    const t = await token();
    const { intent } = await refused(t, SUBKEY, {});
    await approve(t, intent);
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/SELECT op_id,seq,kind,payload,attempts FROM flux_home_ops/, async () => { throw new Error("worker fell over"); });
    });
    expect((await call("POST", SUBKEY, t, { stepUpIntentId: intent })).status).toBe(500);
    // The sweep drains the home meanwhile: it holds the Flux lease.
    await env.DB.prepare("UPDATE flux_home_keys SET op_holder='sweep-holder', op_lease_until=? WHERE home_id='home-se'").bind(clock + 60_000).run();
    const busy = await call("POST", SUBKEY, t, { stepUpIntentId: intent });
    expect(busy.headers.get(HDR)).toBe("1");
    expect(await out(busy)).toEqual([409, { error: "home_busy" }]);
    expect(fluxCalls.mints).toHaveLength(0);
    expect((await intentRow(intent))!.state).toBe("executing");
  });
  it("STEPUP-EMAIL-5 #4: link completion is ONE transaction: a failure inside it commits nothing, and the exact retry links once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = await token();
    const body = await linkBody();
    const { intent } = await refused(t, LINK, body);
    await approve(t, intent);
    // The failure lands between the challenge's consumption and the link insert: they are one batch now, so it lands on all of it.
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/UPDATE flux_link_challenges SET used_at[\s\S]*INSERT OR IGNORE INTO flux_links/, async () => { throw new Error("D1 fell over"); });
    });
    const failed = await call("POST", LINK, t, { ...body, stepUpIntentId: intent });
    expect(failed.status).toBe(500);
    expect(failed.headers.get(HDR)).toBe("1");
    expect(await links()).toBe(0);
    expect(await intentRow(intent)).toMatchObject({ state: "executing", phase: "claimed" });
    expect(await env.DB.prepare("SELECT used_at FROM flux_link_challenges WHERE state_hash=?").bind(await sha256(body.state)).first()).toEqual({ used_at: null });
    const done = await call("POST", LINK, t, { ...body, stepUpIntentId: intent });
    expect(done.headers.get(HDR)).toBe("1");
    expect(await out(done)).toEqual([200, { linked: true, fluxAccountHint: FLUX_ACCOUNT.slice(-4) }]);
    expect(await links()).toBe(1);
    expect(await intentRow(intent)).toMatchObject({ state: "done", phase: "delivered", dispatch_ref: "flux_link" });
    expect((await call("POST", LINK, t, { ...body, stepUpIntentId: intent })).status).toBe(200);
    expect(await links()).toBe(1);
  });

  it("STEPUP-EMAIL-5 #6: an unconfirmed revocation past its threshold raises ONE alert, keeps its records, and the operator re-queues it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ADMIN = "test-only-stepup-admin-token";
    extraEnv = { FLUX_LINK_PUBLIC_KEY: linkKey, CLOUD_ADMIN_TOKEN: ADMIN };
    await fluxHome();
    const t = await token();
    const intent = await undeliveredMint(t);
    const generation = fluxCalls.mints[0].generation;
    const opId = `undelivered:${intent}`;
    const alerts = async () => (await env.DB.prepare("SELECT home_id,severity,detail,resolved_at FROM cloud_alerts WHERE kind='flux.undelivered_key_unrevoked'")
      .all<Body>()).results;
    const opRow = () => env.DB.prepare("SELECT state,attempts FROM flux_home_ops WHERE op_id=?").bind(opId).first<Body>();
    const drain = () => sweepFlux(testEnv(), { fluxClient: () => fakeFlux, billingFlux: QUALIFIED_HOOKS, now: () => clock });
    revokeFails = true;
    await sweepStepUpEmail(testEnv(), clock);
    await drain();
    await sweepStepUpEmail(testEnv(), clock);
    // Below the threshold (one failed attempt, minutes old): retried, not escalated.
    expect(await opRow()).toMatchObject({ state: "queued", attempts: 1 });
    expect(await alerts()).toHaveLength(0);
    clock += 61 * 60_000;
    await drain();
    await sweepStepUpEmail(testEnv(), clock);
    await sweepStepUpEmail(testEnv(), clock + 60_000);
    const raised = await alerts();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ home_id: "home-se", severity: "high", resolved_at: null });
    expect(JSON.parse(raised[0].detail)).toMatchObject({ intents: [intent], recovery: expect.stringContaining(REQUEUE_PATH) });
    // The records stay: the operation 'compensating', its revocation op queued, even past the collection horizon.
    await sweepStepUpEmail(testEnv(), clock + 3 * 86_400_000);
    expect((await intentRow(intent))!.phase).toBe("compensating");
    expect((await opRow())!.state).toBe("queued");
    expect(await alerts()).toHaveLength(1);
    // The operator's recovery: only the admin token; it re-queues (attempts and backoff reset), and the next sweep revokes.
    expect((await call("POST", REQUEUE_PATH, t, { intentId: intent })).status).not.toBe(200);
    expect(await out(await call("POST", REQUEUE_PATH, ADMIN, { intentId: intent }))).toEqual([200, { requeued: true, intentId: intent, homeId: "home-se" }]);
    expect(await opRow()).toEqual({ state: "queued", attempts: 0 });
    revokeFails = false;
    await drain();
    expect(fluxCalls.revokes.filter((r) => r.generation === generation)).toEqual([{ homeId: "home-se", generation, reason: "undelivered" }]);
    expect((await intentRow(intent))!.phase).toBe("compensated");
    expect((await alerts())[0].resolved_at).not.toBeNull();
    expect(await out(await call("POST", REQUEUE_PATH, ADMIN, { intentId: intent }))).toEqual([409, { error: "not_requeueable" }]);
  });
});

describe("STEPUP-EMAIL-5: the desktop code's generation, consumed on every path", () => {
  const DESKTOP = "/v1/account/homes/home-se/desktop-code";
  const LOGS_REQUEST = "/v1/account/home/logs/request";
  const codes = async () => (await env.DB.prepare("SELECT home_id,generation FROM desktop_pairing_codes").all<Body>()).results;
  const generation = async () => (await env.DB.prepare("SELECT generation FROM cloud_homes WHERE id='home-se'").first<{ generation: number }>())!.generation;
  /** The desktop app redeems a code: no account session at all. */
  async function redeem(code: string) {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://auth.murage.test/v1/pairing/desktop", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, mode: "first", device: { scope: "owner-desktop", publicKey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
        assertionKey: "-----BEGIN PUBLIC KEY-----\nBBBB\n-----END PUBLIC KEY-----\n" } }) }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  /** An approved intent whose operation a worker claimed and left past its execution lease (in `phase`). */
  async function interrupted(t: string, phase: "claimed" | "committed") {
    await runner();
    const { intent } = await refused(t, LOGS_REQUEST, {});
    await approve(t, intent);
    await env.DB.prepare("UPDATE cloud_stepup_intents SET state='executing', phase=?, op_kind='request', exec_token='dead-worker', exec_until=?, claimed_at=? WHERE id=?")
      .bind(phase, clock - 1, clock, intent).run();
    return intent;
  }
  afterEach(async () => { await env.DB.prepare("DELETE FROM desktop_pairing_codes").run(); });

  it("#2 a home generation that advances after the gate: no code is created (409), and the approval never issues one for the new generation", async () => {
    const t = await token();
    const { intent } = await refused(t, DESKTOP, {});
    await approve(t, intent);
    const before = await generation();
    armDb(/SET state='executing', phase=/, async () => {
      armDb(/INSERT INTO desktop_pairing_codes/, async () => { await env.DB.prepare("UPDATE cloud_homes SET generation=generation+1 WHERE id='home-se'").run(); });
    });
    const res = await call("POST", DESKTOP, t, { stepUpIntentId: intent });
    expect(await out(res)).toEqual([409, { error: "home_changed" }]);
    expect(await codes()).toHaveLength(0);
    expect(mail.filter((m) => m.subject.startsWith("A code to connect a desktop"))).toHaveLength(0);
    expect(await generation()).toBe(before + 1);
    // The exact retry: the target moved, so the approval is void (a fresh intent), and still no code.
    const [s, b] = await out(await call("POST", DESKTOP, t, { stepUpIntentId: intent }));
    expect([s, b.error]).toEqual([403, "step_up_required"]);
    expect(b.step_up.email_code.intent_id).not.toBe(intent);
    expect(await codes()).toHaveLength(0);
  });

  it("#2 a code is bound to the generation it was issued for: after the home moves to N+1 the code for N is refused (and spent)", async () => {
    const t = await token();
    const { intent } = await refused(t, DESKTOP, {});
    await approve(t, intent);
    const res = await call("POST", DESKTOP, t, { stepUpIntentId: intent });
    expect(res.status).toBe(201);
    const { code } = await res.json<{ code: string }>();
    const n = await generation();
    expect(await codes()).toEqual([{ home_id: "home-se", generation: n }]);
    await env.DB.prepare("UPDATE cloud_homes SET generation=generation+1 WHERE id='home-se'").run();
    const used = mail.length;
    expect(await out(await redeem(code))).toEqual([403, { error: "pairing_refused" }]);
    expect(await codes()).toHaveLength(0);
    expect(mail).toHaveLength(used);
  });

  it("#5 an exact duplicate whose live identity check fails still says consumed: 401 after logout, 503 when Supabase cannot say", async () => {
    const t = await token();
    const intent = await interrupted(t, "claimed");
    revoked.add(S1);
    const gone = await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent });
    expect(gone.status).toBe(401);
    expect(gone.headers.get(HDR)).toBe("1");
    revoked.clear();
    supa.updatedAt = "";
    const unsure = await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent });
    expect(await out(unsure)).toEqual([503, { error: "identity_unavailable" }]);
    expect(unsure.headers.get(HDR)).toBe("1");
    expect(await commands()).toHaveLength(0);
  });

  it("#5 an exact duplicate whose target moved is refused with a fresh intent, and says consumed", async () => {
    const t = await token();
    const intent = await interrupted(t, "claimed");
    await newerHome();
    const res = await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent });
    const [s, b] = await out(res);
    expect([s, b.error]).toEqual([403, "step_up_required"]);
    expect(b.step_up.email_code.intent_id).not.toBe(intent);
    expect(res.headers.get(HDR)).toBe("1");
    expect(await commands()).toHaveLength(0);
    // The moved address too: A->B voids the approval, and the answer still says consumed.
    clock += 31_000; // the account's 30 s between sends
    const t2 = await token(S2);
    const other = await interrupted(t2, "claimed");
    changeEmail("pat+b@example.test");
    const moved = await call("POST", LOGS_REQUEST, t2, { stepUpIntentId: other });
    expect(moved.status).toBe(403);
    expect(moved.headers.get(HDR)).toBe("1");
  });

  it("#5 a failure while a committed duplicate is reconciled: 500, still consumed; the next retry reconciles it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = await token();
    const intent = await interrupted(t, "committed");
    armDb(/SET state='done', done_at=\?, exec_until=NULL, response_status=NULL WHERE id=\? AND state='executing'/, async () => { throw new Error("D1 fell over"); });
    const failed = await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent });
    expect(failed.status).toBe(500);
    expect(failed.headers.get(HDR)).toBe("1");
    const again = await call("POST", LOGS_REQUEST, t, { stepUpIntentId: intent });
    expect(await out(again)).toEqual([410, { error: "already_completed", operation: { id: intent } }]);
    expect(again.headers.get(HDR)).toBe("1");
    expect(await commands()).toHaveLength(0);
  });
});
