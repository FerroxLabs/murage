// SPDX-License-Identifier: AGPL-3.0-or-later
// The door (src/door.ts; lanes/cloud-door/DESIGN.md sections 2 and 6): POST /v1/homes/:id/door mints a 60-second, CP-signed ticket that
// opens the owner's home at <publicOrigin>/enter. Contract tests for every status, the exact claim set, the limits and the notice.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPayload } from "../src/b3-signatures";
import { createIdentity } from "../src/customer-identity";
import { reconciledContactEmail } from "../src/cloud-accounts";
import { noticeBackoff } from "../src/b5-billing";
import { DOOR_ATTEMPT_SUBJECT, DOOR_HANDING_OUT, DOOR_NOTICE_CLAIM_MS, DOOR_NOTICE_SUBJECT, doorRoute, handOutDoorTicket, sweepDoorNotices, type DoorDependencies } from "../src/door";
import { errorResponse, HTTPError } from "../src/http";
import { createWorker } from "../src/index";
import { readyPairHolds, reservePairHold, selectPairHold, spendPairHold, type PairingDependencies } from "../src/pairing";
import type { KeyWrapper } from "../src/key-wrapper";

const REF_ORIGIN = "https://testref.supabase.co";
const ISS = `${REF_ORIGIN}/auth/v1`;
const OWNER_SUB = "7b2e3d40-5c6f-4a71-8bcd-2e3f4a5b6c7d";
const OTHER_SUB = "8c3f4e51-6d70-4b82-9cde-3f4a5b6c7d8e";
const HOME = "home-door";
const HOSTNAME = "h-door0123.murage.test";
const ORIGIN = `https://${HOSTNAME}`;
const CLAIM_KEYS = ["type", "homeId", "generation", "publicOrigin", "account", "nonce", "stepUpAt", "issuedAt", "expiresAt"];

const b64u = (b: ArrayBuffer | string) => Buffer.from(typeof b === "string" ? Buffer.from(b) : new Uint8Array(b)).toString("base64url");
let ec: CryptoKeyPair;
let jwks: { keys: Record<string, unknown>[] };
let signingJwk: JsonWebKey;
let publicJwk: JsonWebKey;
beforeAll(async () => {
  ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", ec.publicKey) as Record<string, unknown>), kid: "ec-1", alg: "ES256", use: "sig" }] };
  // The B3 signing key (CLOUD_B3_SIGNING_JWK) and the public half a home pins.
  const b3 = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  signingJwk = await crypto.subtle.exportKey("jwk", b3.privateKey);
  publicJwk = await crypto.subtle.exportKey("jwk", b3.publicKey);
});
const factorOf = (sub: string) => `${sub.slice(0, 24)}000000000f01`;
/** Each member's one browser (Supabase session) unless a test names another: the door notice is owed per session (door v2). */
const sessionOf = (sub: string) => `sess-${sub}`;
/** A member's token. `totpAgo`: seconds since the TOTP proof (null: an aal1 session). `at`: the clock (s); `sessionId`: a fixed session. */
async function token(sub: string, email: string, totpAgo: number | null = 10, opts: { at?: number; sessionId?: string } = {}) {
  const s = opts.at ?? Math.floor(Date.now() / 1000);
  const c = { iss: ISS, aud: "authenticated", exp: s + 3600, iat: s - 5, sub, email, role: "authenticated", is_anonymous: false,
    app_metadata: { provider: "email", email_verified: true }, user_metadata: {}, session_id: opts.sessionId ?? sessionOf(sub),
    mfa_factor_id: factorOf(sub), aal: totpAgo === null ? "aal1" : "aal2",
    // A password sign-in, never an emailed one: the door's 15-minute reuse (door v2, 3.4) is tested on its own (amrToken).
    amr: totpAgo === null ? [{ method: "password", timestamp: s - 60 }] : [{ method: "totp", timestamp: s - totpAgo }, { method: "password", timestamp: s - 900 }] };
  const input = `${b64u(JSON.stringify({ alg: "ES256", kid: "ec-1", typ: "JWT" }))}.${b64u(JSON.stringify(c))}`;
  return `${input}.${b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, new TextEncoder().encode(input)))}`;
}

const sent: { to: string; subject: string; text: string }[] = [];
const deps: PairingDependencies = { emailSender: () => ({ async send(m) { sent.push({ to: m.to, subject: m.subject, text: m.text }); } }) };
const jwksFetch = (async () => Response.json(jwks)) as typeof fetch;
/** Supabase Auth's current record of a sub, where a test makes it differ from the token: its address, its factor list. */
const supabaseNow = new Map<string, { email?: string; factors?: unknown[] }>();
const authFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const bearer = new Headers(init?.headers).get("authorization")!.slice("Bearer ".length);
  const c = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()) as { sub: string; email: string };
  const over = supabaseNow.get(c.sub) ?? {};
  return Response.json({ id: c.sub, email: over.email ?? c.email, email_confirmed_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    factors: over.factors ?? [{ id: factorOf(c.sub), factor_type: "totp", status: "verified", friendly_name: "" }] });
}) as typeof fetch;
const worker = createWorker(fetch, fetch, {}, deps, {}, { jwksFetch, authFetch });
/** Each member's address as Supabase first knew it (member()); supabaseNow overrides it. */
const emails = new Map<string, string>();
/** The identity reader (the sweep's source of Supabase's current address, no token): down while `readerDown.on`. */
const readerDown = { on: false };
const reader = { async emailGen(sub: string) {
  if (readerDown.on) throw new Error("identity_unavailable");
  return { id: sub, email: supabaseNow.get(sub)?.email ?? emails.get(sub) ?? "", updatedAt: "2026-10-01T00:00:00Z" };
} };
/** Background work (waitUntil) of `call` and `direct`, NOT drained before the caller asserts on the answer: settle() drains it. */
const pending: Promise<unknown>[] = [];
const settle = async () => { while (pending.length) await Promise.allSettled(pending.splice(0)); };
const testEnv = () => ({ ...env, CLOUD_B3_SIGNING_JWK: JSON.stringify(signingJwk), SUPABASE_URL: REF_ORIGIN,
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_testkey_0123456789abcdef", MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined,
  IDENTITY_READER: reader }) as unknown as Env;

/** The worker's answer as a browser gets it: its background work (waitUntil) is NOT drained first; settle() drains it. */
async function call(path: string, bearer: string | null, body: unknown = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://auth.murage.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }), testEnv(), ctx);
  pending.push(waitOnExecutionContext(ctx));
  return res;
}
const door = (t: string | null, home = HOME, body: unknown = {}) => call(`/v1/homes/${home}/door`, t, body);
async function member(sub: string, email: string) {
  emails.set(sub, email);
  const t = await token(sub, email);
  const ctx = createExecutionContext();
  expect((await worker.fetch(new Request("https://auth.murage.test/v1/account/terms", { headers: { authorization: `Bearer ${t}` } }), testEnv(), ctx)).status).toBe(200);
  await waitOnExecutionContext(ctx);
  const row = await env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(sub).first<{ user_id: string }>();
  await env.DB.prepare("INSERT OR IGNORE INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state) VALUES (?,?,'totp','email_code',0,0,'active')")
    .bind(row!.user_id, factorOf(sub)).run();
  return { token: t, id: row!.user_id };
}
/** A home of `ownerId`; `endpoint`: the machine_endpoints row (null: none). */
async function seedHome(ownerId: string, opts: { desired?: string; generation?: number; endpoint?: { status: string; tunnel: boolean; dns: boolean } | null } = {}) {
  const now = Date.now();
  const endpoint = opts.endpoint === undefined ? { status: "ready", tunnel: true, dns: true } : opts.endpoint;
  await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,generation,created_at,updated_at)
    VALUES (?,?,?,?,'ready','sha256:x','k',?,?,?)`).bind(HOME, "inst-door", ownerId, opts.desired ?? "ready", opts.generation ?? 3, now, now).run();
  if (endpoint) {
    await env.DB.prepare(`INSERT INTO machine_endpoints (machine_id,hostname,tunnel_name,tunnel_id,dns_record_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(HOME, HOSTNAME, `t-${HOME}`, endpoint.tunnel ? "tun-door" : null, endpoint.dns ? "dns-door" : null, endpoint.status, now, now).run();
  }
}
/** The ticket of a 200 answer: its URL fragment split as the home splits it, and the verified claims. */
async function ticketOf(res: Response) {
  const body = await res.json<{ url: string; expiresIn: number }>();
  const ticket = body.url.slice(`${ORIGIN}/enter#t=`.length);
  const [payload, signature, ...rest] = ticket.split(".");
  expect(rest).toEqual([]);
  const claims = await verifyPayload({ payload, signature, algorithm: "ES256" }, publicJwk) as Record<string, unknown>;
  return { body, ticket, payload, signature, claims };
}

afterEach(async () => { await settle(); sent.length = 0; supabaseNow.clear(); emails.clear(); readerDown.on = false; vi.restoreAllMocks(); });

/** doorRoute itself, as the worker calls it after its gate, then the worker's last step (handOutDoorTicket), with test hooks and an optional
 *  fixed clock; `beforeHandOut` stands in for the step-up intent's finalization (recordOutcome) in between. A refusal is its error response.
 *  The owed notice's send is left running (pending): the answer is asserted before it, as a browser gets it. */
async function direct(t: string, extra: DoorDependencies = {}, now?: () => number, beforeHandOut?: () => void | Promise<void>,
  db?: D1Database): Promise<Response> {
  const identity = createIdentity({ jwksFetch, authFetch, ...(now ? { now } : {}) });
  const e = db ? { ...testEnv(), DB: db } as Env : testEnv();
  const request = new Request(`https://auth.murage.test/v1/homes/${HOME}/door`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, body: "{}" });
  identity.bind(request, e);
  try {
    const res = (await doorRoute(request, e, identity, "req-direct", { emailSender: deps.emailSender, waitUntil: (w) => { pending.push(w); }, ...extra }))!;
    await beforeHandOut?.();
    return await handOutDoorTicket(request, res);
  } catch (err) {
    if (err instanceof HTTPError) return errorResponse(err.status, err.code);
    throw err;
  }
}
/** The worker `w` answering a POST, its background work NOT drained: the caller drains `ctx` (waitOnExecutionContext) when it chooses. */
async function held(w: ReturnType<typeof createWorker>, path: string, bearer: string, body: unknown = {}, e: Env = testEnv()) {
  const ctx = createExecutionContext();
  const res = await w.fetch(new Request(`https://auth.murage.test${path}`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) }), e, ctx);
  return { res, ctx };
}
/** A door refusal's step-up intent, in session `sessionId` (an aal1 token). */
async function refusedIntent(sessionId: string, w = worker): Promise<string> {
  const { res, ctx } = await held(w, `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", null, { sessionId }));
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(403);
  return (await res.json<{ step_up: { email_code: { intent_id: string } } }>()).step_up.email_code.intent_id;
}
/** env.DB with `onSql` told of every statement prepared on it (a test moves its clock there). */
const jumpingDb = (onSql: (sql: string) => void) => new Proxy(env.DB, { get(target, prop) {
  if (prop === "prepare") return (sql: string) => { onSql(sql); return target.prepare(sql); };
  const v = Reflect.get(target, prop, target);
  return typeof v === "function" ? v.bind(target) : v;
} });
/** env.DB whose notice STAGE batch (the hand-out's, door.ts stageNotice) runs `onArm(n)` first (n: 0 for the first arm batch, 1 for the next):
 *  it may move a clock, change the home, throw (the batch fails) or return the batch's results instead (nothing executed). A statement
 *  `failSql` accepts is prepared to fail when run. */
const armingDb = (onArm: (n: number) => unknown, failSql: (sql: string) => boolean = () => false) => {
  let n = 0;
  let arming = false;
  return new Proxy(env.DB, { get(target, prop) {
    if (prop === "prepare") return (sql: string) => {
      if (failSql(sql)) return { bind: () => ({ run: async () => { throw new Error("D1 unavailable"); } }) };
      if (sql.includes("INSERT INTO cloud_door_notices") && sql.includes("WHERE EXISTS")) arming = true;
      return target.prepare(sql);
    };
    if (prop === "batch") return async (statements: D1PreparedStatement[]) => {
      if (arming) {
        arming = false;
        const instead = await onArm(n++);
        if (instead) return instead;
      }
      return target.batch(statements);
    };
    const v = Reflect.get(target, prop, target);
    return typeof v === "function" ? v.bind(target) : v;
  } }) as D1Database;
};
/** A door intent of session `sessionId` (refused through `w`), approved by an emailed code at clock `at` (s), the approval then aged `agedMs`. */
async function emailApproved(w: ReturnType<typeof createWorker>, sessionId: string, agedMs: number, at: number): Promise<string> {
  const t = await token(OWNER_SUB, "owner@example.test", null, { sessionId, at });
  const intentId = await refusedIntent(sessionId, w);
  const send = await held(w, "/v1/account/step-up/email/send", t, { intentId });
  await waitOnExecutionContext(send.ctx);
  expect(send.res.status).toBe(202);
  const { challengeId } = await send.res.json<{ challengeId: string }>();
  const code = /\b(\d{6})\b/.exec(sent.filter((m) => m.subject === "Your Murage security code").at(-1)!.text)![1];
  const verify = await held(w, "/v1/account/step-up/email/verify", t, { intentId, challengeId, code });
  await waitOnExecutionContext(verify.ctx);
  expect(verify.res.status).toBe(200);
  await env.DB.prepare("UPDATE cloud_stepup_intents SET approved_at=approved_at-?, grant_expires_at=grant_expires_at-? WHERE id=?").bind(agedMs, agedMs, intentId).run();
  // Its granted event (the door's 15-minute reuse reads it, door v2 3.4) ages with it.
  await env.DB.prepare("UPDATE cloud_stepup_events SET at=at-? WHERE intent_id=? AND kind='granted'").bind(agedMs, intentId).run();
  return intentId;
}
/** env.DB whose statements `match` accepts (by SQL) first run `before()`, the first `times` times they are run (a concurrent request lands
 *  there). */
const hookedDb = (match: (sql: string) => boolean, before: () => Promise<void>, times = 1) => {
  let left = times;
  const fire = async () => { if (left > 0) { left--; await before(); } };
  return new Proxy(env.DB, { get(target, prop) {
    if (prop === "prepare") return (sql: string) => {
      const stmt = target.prepare(sql);
      if (!match(sql)) return stmt;
      return { bind: (...args: unknown[]) => {
        const bound = stmt.bind(...args);
        return { run: async () => { await fire(); return bound.run(); }, first: async () => { await fire(); return bound.first(); },
          all: async () => { await fire(); return bound.all(); } };
      } };
    };
    const v = Reflect.get(target, prop, target);
    return typeof v === "function" ? v.bind(target) : v;
  } }) as D1Database;
};
/** An ARMED owed notice of (accountId, HOME), due at `now` (its hand-out confirmed, its first attempt interrupted). */
const owedRow = (accountId: string, now: number) =>
  env.DB.prepare("INSERT INTO cloud_door_notices (account_id,home_id,session_id,bind,created_at,sent_at,attempts,next_attempt_at,armed,delivered) VALUES (?,?,'','',?,NULL,0,?,1,1)")
    .bind(accountId, HOME, now - DOOR_NOTICE_CLAIM_MS - 1000, now - 1000).run();
const noticeRows = async () => (await env.DB.prepare("SELECT COUNT(*) n FROM cloud_door_notices").first<{ n: number }>())!.n;
const armedRows = async () => (await env.DB.prepare("SELECT COUNT(*) n FROM cloud_door_notices WHERE armed=1").first<{ n: number }>())!.n;
const errorOf = async (res: Response) => [res.status, (await res.clone().json<{ error?: string }>()).error];

describe("POST /v1/homes/:id/door", () => {
  it("the owner gets a signed 60-second ticket URL at the home's /enter, no-store, with exactly the claim set", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const before = Date.now();
    const res = await door(owner.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { body, claims, payload } = await ticketOf(res);
    expect(body.url.startsWith(`${ORIGIN}/enter#t=`)).toBe(true);
    expect(body.expiresIn).toBe(60);
    expect(Object.keys(body).sort()).toEqual(["expiresIn", "url"]);
    expect(Object.keys(claims)).toEqual(CLAIM_KEYS);
    expect(claims).toMatchObject({ type: "murage-door-v1", homeId: HOME, generation: 3, publicOrigin: ORIGIN, account: owner.id });
    expect(claims.publicOrigin).toBe(ORIGIN);
    expect((claims.expiresAt as number) - (claims.issuedAt as number)).toBe(60_000);
    expect(claims.issuedAt as number).toBeGreaterThanOrEqual(before);
    expect(claims.nonce).toMatch(/^[A-Za-z0-9_-]{22,43}$/);
    // The TOTP proof the session carries (10 s ago), in ms, never after issuedAt.
    expect(claims.issuedAt as number - (claims.stepUpAt as number)).toBeGreaterThanOrEqual(9_000);
    expect(claims.issuedAt as number - (claims.stepUpAt as number)).toBeLessThan(300_000);
    // The payload is base64url (no padding) of the JSON, as b3-signatures.ts encodePayload makes it.
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual(claims);
    // The publicOrigin is the one GET /v1/homes answers.
    const ctx = createExecutionContext();
    const homes = await worker.fetch(new Request("https://auth.murage.test/v1/homes", { headers: { authorization: `Bearer ${owner.token}` } }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect((await homes.json<{ homes: { publicOrigin: string }[] }>()).homes[0].publicOrigin).toBe(claims.publicOrigin);
  });

  it("a wrong signing key does not verify the ticket", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const { payload, signature } = await ticketOf(await door(owner.token));
    const other = await crypto.subtle.exportKey("jwk", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair).publicKey);
    await expect(verifyPayload({ payload, signature, algorithm: "ES256" }, other)).rejects.toThrow("invalid_signature");
  });

  it("each mint has a fresh nonce; the first per (account, home) emails the owner once, before the ticket", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const a = await ticketOf(await door(owner.token));
    await settle();
    expect(sent).toEqual([expect.objectContaining({ to: "owner@example.test", subject: DOOR_NOTICE_SUBJECT })]);
    expect(sent[0].text).not.toContain(a.ticket);
    expect(sent[0].text).not.toContain(a.claims.nonce as string);
    const b = await ticketOf(await door(owner.token));
    expect(b.claims.nonce).not.toBe(a.claims.nonce);
    expect(b.ticket).not.toBe(a.ticket);
    expect(sent).toHaveLength(1);
    // Nothing of the ticket is stored anywhere.
    const rows = JSON.stringify((await env.DB.prepare("SELECT * FROM cloud_door_notices").all()).results);
    expect(rows).toContain(owner.id);
    expect(rows).not.toContain(a.claims.nonce as string);
  });

  it("a failed notice never blocks the ticket: it is owed, backed off, sent once by the sweep, never again", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const failing = createWorker(fetch, fetch, {}, { emailSender: () => ({ async send() { throw new Error("provider down"); } }) }, {}, { jwksFetch, authFetch });
    const ctx = createExecutionContext();
    const before = Date.now();
    const res = await failing.fetch(new Request(`https://auth.murage.test/v1/homes/${HOME}/door`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}` }, body: "{}" }), testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    await ticketOf(res);
    const row = (await env.DB.prepare("SELECT * FROM cloud_door_notices").first<{ sent_at: number | null; attempts: number; next_attempt_at: number }>())!;
    expect(row.sent_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).toBeGreaterThanOrEqual(before + 60_000);
    // Another mint is not a retry (the row is the dedupe), and the sweep waits for the backoff.
    expect((await door(owner.token)).status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(await sweepDoorNotices(testEnv(), Date.now(), deps)).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await sweepDoorNotices(testEnv(), row.next_attempt_at, deps)).toBe(1);
    expect(sent).toEqual([expect.objectContaining({ to: "owner@example.test", subject: DOOR_NOTICE_SUBJECT })]);
    expect((await env.DB.prepare("SELECT sent_at FROM cloud_door_notices").first<{ sent_at: number | null }>())!.sent_at).not.toBeNull();
    expect(await sweepDoorNotices(testEnv(), row.next_attempt_at + 86_400_000, deps)).toBe(0);
    expect((await door(owner.token)).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("a crash after the notice was armed (the ticket handed out) is retried by the cron sweep, once", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const now = Date.now();
    // As the hand-out leaves it when the worker dies after arming, before its send: armed, claimed until now + the claim.
    await env.DB.prepare("INSERT INTO cloud_door_notices (account_id,home_id,session_id,bind,created_at,sent_at,attempts,next_attempt_at,armed) VALUES (?,?,'','',?,NULL,0,?,1)")
      .bind(owner.id, HOME, now - DOOR_NOTICE_CLAIM_MS - 1000, now - 1000).run();
    const ctx = createExecutionContext();
    worker.scheduled({ scheduledTime: now, cron: "*/5 * * * *", noRetry() {} }, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    // Its delivery was never recorded (the worker died first): the notice describes the attempt, never asserting the link was given.
    expect(sent.filter((m) => m.subject === DOOR_ATTEMPT_SUBJECT)).toEqual([expect.objectContaining({ to: "owner@example.test" })]);
    expect(sent[0].text).toContain("asked to open your home from a new browser");
    expect(sent[0].text).not.toContain("was just given");
    expect(await sweepDoorNotices(testEnv(), Date.now() + 86_400_000, deps)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("concurrent first mints owe and send exactly one notice", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const all = await Promise.all([door(owner.token), door(owner.token), door(owner.token)]);
    expect(all.map((r) => r.status)).toEqual([200, 200, 200]);
    await settle();
    expect(sent).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM cloud_door_notices WHERE sent_at IS NOT NULL").first<{ n: number }>())!.n).toBe(1);
  });

  it("a deleted home's notice rows go with it (deletion and the retention sweep)", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    expect((await door(owner.token)).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM cloud_door_notices").first<{ n: number }>())!.n).toBe(1);
    await env.DB.prepare("INSERT INTO cloud_door_notices (account_id,home_id,session_id,bind,created_at,sent_at,attempts,next_attempt_at) VALUES (?,?,'','',0,NULL,0,0)")
      .bind(owner.id, "home-gone").run();
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleted' WHERE id=?").bind(HOME).run();
    const { sweepCloudRetention } = await import("../src/cloud-machines");
    await sweepCloudRetention(testEnv());
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM cloud_door_notices").first<{ n: number }>())!.n).toBe(0);
  });

  it("logs the mint with homeId, account and requestId, never the ticket", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const lines: string[] = [];
    const capture = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    const res = await door(owner.token);
    const { ticket, payload, signature, claims } = await ticketOf(res);
    const minted = lines.filter((l) => l.includes("door ticket minted"));
    expect(minted).toHaveLength(1);
    expect(JSON.parse(minted[0])).toEqual({ message: "door ticket minted", homeId: HOME, account: owner.id, requestId: res.headers.get("x-request-id"),
      door: "v1", kind: "browser", proof: "factor" });
    const all = lines.join("\n");
    for (const secret of [ticket, payload, signature, claims.nonce as string]) expect(all).not.toContain(secret);
  });

  it("no session is 401; a Better Auth-shaped or garbage bearer is 401", async () => {
    expect([(await door(null)).status, (await door("not-a-jwt")).status]).toEqual([401, 401]);
  });

  it("another member's home and a missing home are the same 404", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    const other = await member(OTHER_SUB, "other@example.test");
    await seedHome(owner.id);
    const foreign = await door(other.token);
    const missing = await door(other.token, "home-none");
    expect([foreign.status, missing.status]).toEqual([404, 404]);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(sent).toHaveLength(0);
  });

  it("a deleted home is 404", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id, { desired: "deleted" });
    expect((await door(owner.token)).status).toBe(404);
  });

  for (const [name, opts] of [
    ["checking, without an endpoint", { desired: "checking", endpoint: null }],
    ["endpoint still provisioning", { endpoint: { status: "provisioning", tunnel: true, dns: true } }],
    ["endpoint ready without a tunnel id", { endpoint: { status: "ready", tunnel: false, dns: true } }],
    ["endpoint ready without a DNS record", { endpoint: { status: "ready", tunnel: true, dns: false } }],
    ["home not live (suspended)", { desired: "suspended" }],
    ["home still provisioning", { desired: "provisioning" }],
  ] as const) {
    it(`a home that is not ready is 409 home_not_ready: ${name}`, async () => {
      const owner = await member(OWNER_SUB, "owner@example.test");
      await seedHome(owner.id, opts as Parameters<typeof seedHome>[1]);
      const res = await door(owner.token);
      expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([409, "home_not_ready"]);
      expect(sent).toHaveLength(0);
    });
  }

  it("checking and payment_problem homes with a ready endpoint open", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    for (const desired of ["checking", "payment_problem"]) {
      await env.DB.batch([env.DB.prepare("DELETE FROM cloud_homes"), env.DB.prepare("DELETE FROM machine_endpoints")]);
      await seedHome(owner.id, { desired });
      expect((await door(owner.token)).status).toBe(200);
    }
  });

  it("no fresh second factor is 403 step_up_required; the door's window is 300 s", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const aal1 = await door(await token(OWNER_SUB, "owner@example.test", null));
    expect(aal1.status).toBe(403);
    const refusal = await aal1.json<{ error: string; step_up: { max_age_seconds: number; email_code: { grant_ttl_seconds: number } } }>();
    expect(refusal.error).toBe("step_up_required");
    // Door v2: the door's cap is 900 s (customer-identity.ts stepUpMaxAgeFor), so the account-wide 600 s window applies; a v1 ticket
    // (this home has not advertised v2) is still minted only inside 300 s (door.ts).
    expect(refusal.step_up.max_age_seconds).toBe(600);
    expect(refusal.step_up.email_code.grant_ttl_seconds).toBe(600);
    // 400 s old: inside the account-wide 600 s window, outside the v1 ticket's 300 s.
    const stale = await door(await token(OWNER_SUB, "owner@example.test", 400));
    expect([stale.status, (await stale.json<{ error: string }>()).error]).toEqual([403, "step_up_required"]);
    expect((await door(await token(OWNER_SUB, "owner@example.test", 250))).status).toBe(200);
    await settle();
    expect(sent.map((m) => m.subject)).toEqual([DOOR_NOTICE_SUBJECT]);
  });

  it("an emailed-code approval opens the door once; its verification time is stepUpAt", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const t = await token(OWNER_SUB, "owner@example.test", null);
    const refused = await (await door(t)).json<{ step_up: { email_code: { intent_id: string } } }>();
    const intentId = refused.step_up.email_code.intent_id;
    const sendRes = await call("/v1/account/step-up/email/send", t, { intentId });
    expect(sendRes.status).toBe(202);
    const { challengeId } = await sendRes.json<{ challengeId: string }>();
    const mail = sent.find((m) => m.subject === "Your Murage security code")!;
    expect(mail.text).toContain("opening your Murage home");
    const code = /\b(\d{6})\b/.exec(mail.text)![1];
    const verified = await call("/v1/account/step-up/email/verify", t, { intentId, challengeId, code });
    expect(verified.status).toBe(200);
    expect((await verified.json<{ expiresIn: number }>()).expiresIn).toBe(600);
    const approvedAt = (await env.DB.prepare("SELECT approved_at FROM cloud_stepup_intents WHERE id=?").bind(intentId).first<{ approved_at: number }>())!.approved_at;
    const res = await door(t, HOME, { stepUpIntentId: intentId });
    expect(res.status).toBe(200);
    const { claims } = await ticketOf(res);
    expect(claims.stepUpAt).toBe(approvedAt);
    // Spent: the same approval does not mint a second ticket.
    expect((await door(t, HOME, { stepUpIntentId: intentId })).status).not.toBe(200);
  });

  it("the body must be {}", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    expect((await door(owner.token, HOME, { next: "/admin" })).status).toBe(400);
  });

  it("the 11th mint in a minute is 429 with Retry-After (10 a minute per account)", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    for (let i = 0; i < 10; i++) expect((await door(owner.token)).status).toBe(200);
    const res = await door(owner.token);
    expect(res.status).toBe(429);
    const retry = Number(res.headers.get("retry-after"));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    expect(await res.json()).toEqual({ error: "rate_limited", retryAfter: retry, retry_after_seconds: retry });
    // The account budget counts attempts on any home, so a stranger's or a missing home spends it too.
    expect((await door(owner.token, "home-none")).status).toBe(429);
  });

  it("the account budget is 60 an hour and the home budget 30 a minute", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const now = Date.now();
    // An account that already used 60 this hour (its minute window fresh).
    await env.DB.prepare("INSERT INTO selfservice_rate_limits (subject,window_started_at,attempts) VALUES (?,?,60)").bind(`door_account:3600000:${owner.id}`, now - 1000).run();
    const hourly = await door(owner.token);
    expect(hourly.status).toBe(429);
    expect(Number(hourly.headers.get("retry-after"))).toBeGreaterThan(60);
    await env.DB.prepare("DELETE FROM selfservice_rate_limits").run();
    await env.DB.prepare("INSERT INTO selfservice_rate_limits (subject,window_started_at,attempts) VALUES (?,?,30)").bind(`door_home:60000:${HOME}`, now - 1000).run();
    const perHome = await door(owner.token);
    expect([perHome.status, Number(perHome.headers.get("retry-after")) > 0]).toEqual([429, true]);
  });
  it("a fresh authenticator proved after the refusal mints with that intent; stepUpAt is the authenticator's proof", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const sessionId = crypto.randomUUID();
    const refused = await door(await token(OWNER_SUB, "owner@example.test", null, { sessionId }));
    expect(refused.status).toBe(403);
    const intentId = (await refused.json<{ step_up: { email_code: { intent_id: string } } }>()).step_up.email_code.intent_id;
    const s = Math.floor(Date.now() / 1000);
    const res = await door(await token(OWNER_SUB, "owner@example.test", 5, { sessionId, at: s }), HOME, { stepUpIntentId: intentId });
    expect(res.status).toBe(200);
    const { claims } = await ticketOf(res);
    expect(claims.stepUpAt).toBe((s - 5) * 1000);
    // Claimed by the authenticator, not by an emailed code.
    expect((await env.DB.prepare("SELECT approved_at FROM cloud_stepup_intents WHERE id=?").bind(intentId).first<{ approved_at: number | null }>())!.approved_at).toBeNull();
  });

  it("a code approved for another purpose (the data export) does not open the door", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const t = await token(OWNER_SUB, "owner@example.test", null);
    const exportRefused = await call("/v1/account/export-request", t, {});
    expect(exportRefused.status).toBe(403);
    const intentId = (await exportRefused.json<{ step_up: { email_code: { intent_id: string } } }>()).step_up.email_code.intent_id;
    const sendRes = await call("/v1/account/step-up/email/send", t, { intentId });
    expect(sendRes.status).toBe(202);
    const { challengeId } = await sendRes.json<{ challengeId: string }>();
    const code = /\b(\d{6})\b/.exec(sent.find((m) => m.subject === "Your Murage security code")!.text)![1];
    expect((await call("/v1/account/step-up/email/verify", t, { intentId, challengeId, code })).status).toBe(200);
    // Door v2 (3.4): an emailed code granted in THIS Supabase session within 900 s counts for the door, whatever it approved; the
    // export's intent itself never authorizes the door (the door mints on the session's grant, not on that intent).
    const res = await door(t, HOME, { stepUpIntentId: intentId });
    expect(res.status).toBe(200);
    // In another session the same grant counts for nothing.
    expect(await errorOf(await door(await token(OWNER_SUB, "owner@example.test", null, { sessionId: "sess-elsewhere" })))).toEqual([403, "step_up_required"]);
  });

  it("the home changing owner between the step-up and the mint is 404, with no notice owed", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    const other = await member(OTHER_SUB, "other@example.test");
    await seedHome(owner.id);
    const res = await direct(owner.token, { afterRead: async () => {
      await env.DB.prepare("UPDATE cloud_homes SET owner_id=? WHERE id=?").bind(other.id, HOME).run();
    } });
    expect(await errorOf(res)).toEqual([404, "not_found"]);
    expect(await noticeRows()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("the home's generation changing between the read and the mint is 409, with no notice owed", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const res = await direct(owner.token, { afterRead: async () => {
      await env.DB.prepare("UPDATE cloud_homes SET generation=generation+1 WHERE id=?").bind(HOME).run();
    } });
    expect(await errorOf(res)).toEqual([409, "home_not_ready"]);
    expect(await noticeRows()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("concurrent mints share the account limit: exactly 10 of 12 succeed", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const statuses = (await Promise.all(Array.from({ length: 12 }, () => door(owner.token)))).map((r) => r.status);
    expect(statuses.filter((x) => x === 200)).toHaveLength(10);
    expect(statuses.filter((x) => x === 429)).toHaveLength(2);
    await settle();
    expect(sent).toHaveLength(1);
  });

  it("the step-up window boundary: proved exactly 300 s ago mints, 301 s does not", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const NOW = Math.floor(Date.now() / 1000) * 1000;
    const at300 = await direct(await token(OWNER_SUB, "owner@example.test", 300, { at: NOW / 1000 }), {}, () => NOW);
    expect(at300.status).toBe(200);
    const { claims } = await ticketOf(at300);
    expect([claims.issuedAt, (claims.issuedAt as number) - (claims.stepUpAt as number)]).toEqual([NOW, 300_000]);
    const at301 = await direct(await token(OWNER_SUB, "owner@example.test", 301, { at: NOW / 1000 }), {}, () => NOW);
    expect(await errorOf(at301)).toEqual([403, "step_up_required"]);
  });

  it("the ticket's 60 s: handed out with 55 s left, re-minted once below that, 503 if still too slow", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const NOW = Math.floor(Date.now() / 1000) * 1000;
    const tok = await token(OWNER_SUB, "owner@example.test", 10, { at: NOW / 1000 });
    let t = NOW;
    // Exactly 55 s left after the signature: handed out as minted.
    const edge = await direct(tok, { afterSign: (n) => { if (n === 0) t += 5_000; } }, () => t);
    expect(edge.status).toBe(200);
    const a = (await ticketOf(edge)).claims;
    expect([a.issuedAt, (a.expiresAt as number) - (a.issuedAt as number)]).toEqual([NOW, 60_000]);
    // 1 ms less: minted again, stamped after the delay.
    t = NOW;
    const slow = await direct(tok, { afterSign: (n) => { if (n === 0) t += 5_001; } }, () => t);
    expect(slow.status).toBe(200);
    const b = (await ticketOf(slow)).claims;
    expect([b.issuedAt, b.expiresAt]).toEqual([NOW + 5_001, NOW + 5_001 + 60_000]);
    // Still too slow the second time: no ticket.
    t = NOW;
    const never = await direct(tok, { afterSign: () => { t += 5_001; } }, () => t);
    expect(await errorOf(never)).toEqual([503, "door_unavailable"]);
  });
  it("a deferred notice sent after the claimed intent was finalized records sent_at; the sweep never sends it again", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const sessionId = crypto.randomUUID();
    const intentId = await refusedIntent(sessionId);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gated = createWorker(fetch, fetch, {}, { emailSender: () => ({ async send(m) { await gate; sent.push({ to: m.to, subject: m.subject, text: m.text }); } }) },
      {}, { jwksFetch, authFetch });
    const { res, ctx } = await held(gated, `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", 5, { sessionId }), { stepUpIntentId: intentId });
    // The answer is out and the intent finalized while the notice is still being sent.
    expect(res.status).toBe(200);
    await ticketOf(res);
    expect((await env.DB.prepare("SELECT state FROM cloud_stepup_intents WHERE id=?").bind(intentId).first<{ state: string }>())!.state).toBe("done");
    expect(sent).toHaveLength(0);
    expect((await env.DB.prepare("SELECT sent_at FROM cloud_door_notices").first<{ sent_at: number | null }>())!.sent_at).toBeNull();
    release();
    await waitOnExecutionContext(ctx);
    expect(sent.filter((m) => m.subject === DOOR_NOTICE_SUBJECT)).toHaveLength(1);
    expect((await env.DB.prepare("SELECT sent_at FROM cloud_door_notices").first<{ sent_at: number | null }>())!.sent_at).not.toBeNull();
    expect(await sweepDoorNotices(testEnv(), Date.now() + 86_400_000, deps)).toBe(0);
    expect(sent.filter((m) => m.subject === DOOR_NOTICE_SUBJECT)).toHaveLength(1);
  });

  it("a deferred notice that fails after finalization is backed off for the sweep", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const sessionId = crypto.randomUUID();
    const intentId = await refusedIntent(sessionId);
    const failing = createWorker(fetch, fetch, {}, { emailSender: () => ({ async send() { await new Promise((r) => setTimeout(r, 20)); throw new Error("provider down"); } }) },
      {}, { jwksFetch, authFetch });
    const before = Date.now();
    const { res, ctx } = await held(failing, `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", 5, { sessionId }), { stepUpIntentId: intentId });
    expect(res.status).toBe(200);
    await waitOnExecutionContext(ctx);
    const row = (await env.DB.prepare("SELECT * FROM cloud_door_notices").first<{ sent_at: number | null; attempts: number; next_attempt_at: number }>())!;
    expect([row.sent_at, row.attempts, row.next_attempt_at >= before + 60_000]).toEqual([null, 1, true]);
  });

  it("an emailed approval older than 300 s does not shadow a fresh authenticator on the same intent: stepUpAt is the freshest proof", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const sessionId = crypto.randomUUID();
    const t = await token(OWNER_SUB, "owner@example.test", null, { sessionId });
    const intentId = await refusedIntent(sessionId);
    const sendRes = await call("/v1/account/step-up/email/send", t, { intentId });
    expect(sendRes.status).toBe(202);
    const { challengeId } = await sendRes.json<{ challengeId: string }>();
    const code = /\b(\d{6})\b/.exec(sent.find((m) => m.subject === "Your Murage security code")!.text)![1];
    expect((await call("/v1/account/step-up/email/verify", t, { intentId, challengeId, code })).status).toBe(200);
    // The approval ages 301 s (its grant and its granted event with it).
    await env.DB.prepare("UPDATE cloud_stepup_intents SET approved_at=approved_at-301000, grant_expires_at=grant_expires_at-301000 WHERE id=?").bind(intentId).run();
    await env.DB.prepare("UPDATE cloud_stepup_events SET at=at-301000 WHERE intent_id=? AND kind='granted'").bind(intentId).run();
    const s = Math.floor(Date.now() / 1000);
    const res = await door(await token(OWNER_SUB, "owner@example.test", 10, { sessionId, at: s }), HOME, { stepUpIntentId: intentId });
    expect(res.status).toBe(200);
    expect((await ticketOf(res)).claims.stepUpAt).toBe((s - 10) * 1000);
  });

  it("the 55 s check runs again after the intent's finalization: a slow finalization re-mints once, else 503", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const NOW = Math.floor(Date.now() / 1000) * 1000;
    const tok = await token(OWNER_SUB, "owner@example.test", 10, { at: NOW / 1000 });
    let t = NOW;
    // Exactly 55 s left at the hand-out: the route's ticket.
    const edge = await direct(tok, {}, () => t, () => { t += 5_000; });
    expect((await ticketOf(edge)).claims.issuedAt).toBe(NOW);
    // 1 ms less: minted again at the hand-out, stamped after the delay.
    t = NOW;
    const slow = await direct(tok, {}, () => t, () => { t += 5_001; });
    expect(slow.status).toBe(200);
    expect(slow.headers.get("cache-control")).toContain("no-store");
    const b = (await ticketOf(slow)).claims;
    expect([b.issuedAt, b.expiresAt]).toEqual([NOW + 5_001, NOW + 5_001 + 60_000]);
    // The route already minted twice (a slow signature): a slow finalization is 503, never a third mint.
    t = NOW;
    let signs = 0;
    const spent = await direct(tok, { afterSign: (n) => { signs++; if (n === 0) t += 5_001; } }, () => t, () => { t += 5_001; });
    expect(await errorOf(spent)).toEqual([503, "door_unavailable"]);
    expect(signs).toBe(2);
    // The re-mint at the hand-out is slow too: 503.
    t = NOW;
    const never = await direct(tok, { afterSign: (n) => { if (n === 1) t += 5_001; } }, () => t, () => { t += 5_001; });
    expect(await errorOf(never)).toEqual([503, "door_unavailable"]);
  });

  it("through the worker: a claimed intent whose finalization is slow gets a ticket re-minted after it, with >= 55 s left", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const T = Math.floor(Date.now() / 1000) * 1000;
    let clock = T;
    const clocked = createWorker(fetch, fetch, {}, deps, {}, { jwksFetch, authFetch, now: () => clock });
    const sessionId = crypto.randomUUID();
    const intentId = await refusedIntent(sessionId, clocked);
    // recordOutcome's phase read (after the route answered, before its finalization) takes 6 s.
    let slowed = false;
    const db = new Proxy(env.DB, { get(target, prop) {
      if (prop === "prepare") return (sql: string) => {
        if (!slowed && sql.startsWith("SELECT phase, state FROM cloud_stepup_intents")) { slowed = true; clock += 6_000; }
        return target.prepare(sql);
      };
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    } });
    const { res, ctx } = await held(clocked, `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", 5, { sessionId, at: T / 1000 }),
      { stepUpIntentId: intentId }, { ...testEnv(), DB: db } as Env);
    expect(slowed).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-step-up-consumed")).toBe("1");
    const { claims } = await ticketOf(res);
    expect(claims.issuedAt).toBe(T + 6_000);
    expect((claims.expiresAt as number) - clock).toBeGreaterThanOrEqual(55_000);
    await waitOnExecutionContext(ctx);
  });

  it("the notice goes to the account's current address at send time, not the minting session's", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const res = await direct(owner.token, { afterSign: async (n) => {
      // Moved by another request's reconciliation: Supabase has the new address too.
      if (n === 0) {
        supabaseNow.set(OWNER_SUB, { email: "moved@example.test" });
        await env.DB.prepare("UPDATE supabase_identities SET contact_email=? WHERE user_id=?").bind("moved@example.test", owner.id).run();
      }
    } });
    expect(res.status).toBe(200);
    await settle();
    expect(sent).toEqual([expect.objectContaining({ to: "moved@example.test", subject: DOOR_NOTICE_SUBJECT })]);
    expect((await env.DB.prepare("SELECT sent_at FROM cloud_door_notices").first<{ sent_at: number | null }>())!.sent_at).not.toBeNull();
  });
  it("a factor the gate would refuse (in its hold, or removed from Supabase) never supplies the freshest proof; a live one does", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const T = Math.floor(Date.now() / 1000) * 1000;
    let clock = T;
    const clocked = createWorker(fetch, fetch, {}, deps, {}, { jwksFetch, authFetch, now: () => clock });
    // The mint's final check runs 2 s after the proof was chosen (the clock moves at the route's second read of the home).
    let homeReads = 0;
    const db = jumpingDb((sql) => { if (sql.includes("FROM cloud_homes h LEFT JOIN machine_endpoints") && ++homeReads === 2) clock += 2_000; });
    const cases = [
      { name: "held", usableAt: T + 3_600_000, factors: undefined, expected: 403 },
      { name: "removed", usableAt: 0, factors: [] as unknown[], expected: 403 },
      { name: "live", usableAt: 0, factors: undefined, expected: 200 },
    ];
    for (const [i, c] of cases.entries()) {
      clock = T + i * 60_000; // past the emailed code's send gap
      homeReads = 0;
      supabaseNow.clear();
      await env.DB.prepare("UPDATE cloud_trusted_factors SET usable_at=? WHERE user_id=?").bind(c.usableAt, owner.id).run();
      const sessionId = crypto.randomUUID();
      // The emailed approval is 299 s old: valid when the proof is chosen, 301 s at the mint.
      const intentId = await emailApproved(clocked, sessionId, 299_000, clock / 1000);
      if (c.factors) supabaseNow.set(OWNER_SUB, { factors: c.factors });
      const at = clock;
      // The session's newer authenticator proof (1 s ago).
      const { res, ctx } = await held(clocked, `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", 1, { sessionId, at: at / 1000 }),
        { stepUpIntentId: intentId }, { ...testEnv(), DB: db } as Env);
      await waitOnExecutionContext(ctx);
      if (c.expected === 403) {
        expect([c.name, ...await errorOf(res)]).toEqual([c.name, 403, "step_up_required"]);
      } else {
        expect([c.name, res.status]).toEqual([c.name, 200]);
        expect((await ticketOf(res)).claims.stepUpAt).toBe(at - 1_000);
      }
    }
  });

  it("through the worker: a ticket too late after the intent's finalization is recorded 503 and answered with a fresh step-up, which mints", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const T = Math.floor(Date.now() / 1000) * 1000;
    let clock = T;
    // From recordOutcome's phase read on, every clock read is 6 s later: the hand-out's re-mint is stale too.
    let drifting = false;
    const clocked = createWorker(fetch, fetch, {}, deps, {}, { jwksFetch, authFetch, now: () => (drifting ? (clock += 6_000) : clock) });
    const sessionId = crypto.randomUUID();
    const intentId = await refusedIntent(sessionId, clocked);
    const db = jumpingDb((sql) => { if (sql.startsWith("SELECT phase, state FROM cloud_stepup_intents")) drifting = true; });
    const late = await held(clocked, `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", 5, { sessionId, at: T / 1000 }),
      { stepUpIntentId: intentId }, { ...testEnv(), DB: db } as Env);
    drifting = false;
    await waitOnExecutionContext(late.ctx);
    expect(late.res.status).toBe(503);
    expect(late.res.headers.get("x-step-up-consumed")).toBe("1");
    const body = await late.res.json<{ error: string; retry: string; step_up: { methods: string[]; email_code: { intent_id: string; available: boolean } } }>();
    expect([body.error, body.retry, body.step_up.email_code.available]).toEqual(["door_unavailable", "step_up", true]);
    const fresh = body.step_up.email_code.intent_id;
    expect(fresh).toMatch(/^si_[0-9a-f]{32}$/);
    expect(fresh).not.toBe(intentId);
    // What the member actually got, never a delivered 200; the spent intent stays spent.
    expect(await env.DB.prepare("SELECT state, response_status, response_code FROM cloud_stepup_intents WHERE id=?").bind(intentId).first())
      .toEqual({ state: "done", response_status: 503, response_code: "door_unavailable" });
    const again = await held(clocked, `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", 5, { sessionId, at: clock / 1000 }),
      { stepUpIntentId: intentId });
    await waitOnExecutionContext(again.ctx);
    const replayed = await again.res.json<{ error: string; retry?: string }>();
    expect([again.res.status, replayed.error, replayed.retry]).toEqual([503, "door_unavailable", "step_up"]);
    // The fresh step-up (a fresh authenticator proof on the new intent) mints.
    const s = Math.floor(clock / 1000);
    const minted = await held(clocked, `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", 3, { sessionId, at: s }), { stepUpIntentId: fresh });
    await waitOnExecutionContext(minted.ctx);
    expect(minted.res.status).toBe(200);
    const { claims } = await ticketOf(minted.res);
    expect(claims.stepUpAt).toBe((s - 3) * 1000);
  });

  it("the notice goes to Supabase's current address when the stored contact is stale, and the stored contact moves to it", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    // Supabase moved A -> B; the bearer still names A, which matches the stored contact.
    supabaseNow.set(OWNER_SUB, { email: "new@example.test" });
    const res = await door(owner.token);
    expect(res.status).toBe(200);
    await settle();
    expect(sent.filter((m) => m.subject === DOOR_NOTICE_SUBJECT)).toEqual([expect.objectContaining({ to: "new@example.test" })]);
    expect((await env.DB.prepare("SELECT contact_email FROM supabase_identities WHERE user_id=?").bind(owner.id).first<{ contact_email: string }>())!.contact_email)
      .toBe("new@example.test");
    expect((await env.DB.prepare("SELECT sent_at FROM cloud_door_notices").first<{ sent_at: number | null }>())!.sent_at).not.toBeNull();
  });

  it("a notice whose live address cannot be read is not sent to the stored one: backed off for the sweep", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    // Every Supabase read of the gate and the door comes before the notice is owed; the background notice's read fails.
    let owed = false;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => (owed ? new Response("down", { status: 503 }) : authFetch(input, init))) as typeof fetch;
    const w = createWorker(fetch, fetch, {}, deps, {}, { jwksFetch, authFetch: flaky });
    const db = jumpingDb((sql) => { if (sql.includes("INSERT INTO cloud_door_notices")) owed = true; });
    const { res, ctx } = await held(w, `/v1/homes/${HOME}/door`, owner.token, {}, { ...testEnv(), DB: db } as Env);
    expect(res.status).toBe(200);
    await waitOnExecutionContext(ctx);
    expect(sent.filter((m) => m.subject === DOOR_NOTICE_SUBJECT)).toHaveLength(0);
    const row = (await env.DB.prepare("SELECT sent_at, attempts FROM cloud_door_notices").first<{ sent_at: number | null; attempts: number }>())!;
    expect([row.sent_at, row.attempts]).toEqual([null, 1]);
  });

  // ---- Astra DOORMINT-4 ------------------------------------------------------------------------------------------------------------

  /** A door answer through `w` whose owed notice's FIRST attempt cannot read Supabase (every read before the notice row is written passes). */
  async function firstReadFails(ownerToken: string) {
    let owed = false;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => (owed ? new Response("down", { status: 503 }) : authFetch(input, init))) as typeof fetch;
    const w = createWorker(fetch, fetch, {}, deps, {}, { jwksFetch, authFetch: flaky });
    const db = jumpingDb((sql) => { if (sql.includes("INSERT INTO cloud_door_notices")) owed = true; });
    const { res, ctx } = await held(w, `/v1/homes/${HOME}/door`, ownerToken, {}, { ...testEnv(), DB: db } as Env);
    expect(res.status).toBe(200);
    await waitOnExecutionContext(ctx);
    const row = (await env.DB.prepare("SELECT sent_at, attempts, next_attempt_at FROM cloud_door_notices").first<{ sent_at: number | null; attempts: number; next_attempt_at: number }>())!;
    expect([row.sent_at, row.attempts]).toEqual([null, 1]);
    return row;
  }
  const contactOf = async (id: string) => (await env.DB.prepare("SELECT contact_email, email_conflict FROM supabase_identities WHERE user_id=?").bind(id)
    .first<{ contact_email: string; email_conflict: string | null }>())!;
  const notices = () => sent.filter((m) => m.subject === DOOR_NOTICE_SUBJECT || m.subject === DOOR_ATTEMPT_SUBJECT);

  it("the sweep's retry reconciles the live address first: Supabase moved A -> B after a failed first read, the retry goes to B, never A", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const row = await firstReadFails(owner.token);
    // Supabase moves to B; the stored contact (and the token) still say A.
    supabaseNow.set(OWNER_SUB, { email: "b@example.test" });
    // The reader is down at the first retry: backed off again, nothing sent, never to the stored A.
    readerDown.on = true;
    expect(await sweepDoorNotices(testEnv(), row.next_attempt_at, deps)).toBe(0);
    expect(notices()).toHaveLength(0);
    const again = (await env.DB.prepare("SELECT sent_at, attempts, next_attempt_at FROM cloud_door_notices").first<{ sent_at: number | null; attempts: number; next_attempt_at: number }>())!;
    expect([again.sent_at, again.attempts, again.next_attempt_at > row.next_attempt_at]).toEqual([null, 2, true]);
    // The reader answers: the stored contact moves to B and the notice goes there, once.
    readerDown.on = false;
    expect(await sweepDoorNotices(testEnv(), again.next_attempt_at, deps)).toBe(1);
    expect(notices()).toEqual([expect.objectContaining({ to: "b@example.test" })]);
    expect((await contactOf(owner.id)).contact_email).toBe("b@example.test");
    expect(await sweepDoorNotices(testEnv(), again.next_attempt_at + 86_400_000, deps)).toBe(0);
    expect(notices()).toHaveLength(1);
  });

  it("a recorded email conflict does not strand the notice: the member changes back to A and the next sweep clears it and sends to A", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await member(OTHER_SUB, "b@example.test");
    await seedHome(owner.id);
    // Supabase moved the owner to B, which another Cloud account holds: the first attempt records the conflict and sends nothing.
    supabaseNow.set(OWNER_SUB, { email: "b@example.test" });
    expect((await door(owner.token)).status).toBe(200);
    await settle();
    expect(notices()).toHaveLength(0);
    expect(await contactOf(owner.id)).toEqual({ contact_email: "owner@example.test", email_conflict: "b@example.test" });
    const row = (await env.DB.prepare("SELECT attempts, next_attempt_at FROM cloud_door_notices").first<{ attempts: number; next_attempt_at: number }>())!;
    expect(row.attempts).toBe(1);
    // Still in conflict at the sweep: backed off again.
    expect(await sweepDoorNotices(testEnv(), row.next_attempt_at, deps)).toBe(0);
    const again = (await env.DB.prepare("SELECT attempts, next_attempt_at FROM cloud_door_notices").first<{ attempts: number; next_attempt_at: number }>())!;
    expect(again.attempts).toBe(2);
    // The member changes back to A and never makes another request: the sweep clears the conflict and sends to A.
    supabaseNow.delete(OWNER_SUB);
    expect(await sweepDoorNotices(testEnv(), again.next_attempt_at, deps)).toBe(1);
    expect(notices()).toEqual([expect.objectContaining({ to: "owner@example.test" })]);
    expect(await contactOf(owner.id)).toEqual({ contact_email: "owner@example.test", email_conflict: null });
  });

  it("a recorded conflict whose address was freed is resolved by the sweep to Supabase's address", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    const other = await member(OTHER_SUB, "b@example.test");
    await seedHome(owner.id);
    supabaseNow.set(OWNER_SUB, { email: "b@example.test" });
    expect((await door(owner.token)).status).toBe(200);
    await settle();
    expect((await contactOf(owner.id)).email_conflict).toBe("b@example.test");
    const row = (await env.DB.prepare("SELECT next_attempt_at FROM cloud_door_notices").first<{ next_attempt_at: number }>())!;
    // The other account moves off B.
    await env.DB.prepare("UPDATE supabase_identities SET contact_email='elsewhere@example.test' WHERE user_id=?").bind(other.id).run();
    expect(await sweepDoorNotices(testEnv(), row.next_attempt_at, deps)).toBe(1);
    expect(notices()).toEqual([expect.objectContaining({ to: "b@example.test" })]);
    expect(await contactOf(owner.id)).toEqual({ contact_email: "b@example.test", email_conflict: null });
  });

  it("an address change between the hand-out and the send: the send goes to Supabase's address at send time", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    // The first send fails at the provider (address A read and confirmed); the member then moves to B before the sweep.
    const failing = createWorker(fetch, fetch, {}, { emailSender: () => ({ async send() { throw new Error("provider down"); } }) }, {}, { jwksFetch, authFetch });
    const { res, ctx } = await held(failing, `/v1/homes/${HOME}/door`, owner.token);
    expect(res.status).toBe(200);
    await waitOnExecutionContext(ctx);
    const row = (await env.DB.prepare("SELECT next_attempt_at FROM cloud_door_notices").first<{ next_attempt_at: number }>())!;
    supabaseNow.set(OWNER_SUB, { email: "b@example.test" });
    expect(await sweepDoorNotices(testEnv(), row.next_attempt_at, deps)).toBe(1);
    expect(notices()).toEqual([expect.objectContaining({ to: "b@example.test" })]);
  });

  it("a mint refused after the final check (proof expired at the signature) owes no notice; the first later success does, worded for a hand-out", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const NOW = Math.floor(Date.now() / 1000) * 1000;
    let t = NOW;
    // Proved 299 s ago; 2 s pass after the home was read: the mint crosses the 300 s boundary.
    const refused = await direct(await token(OWNER_SUB, "owner@example.test", 299, { at: NOW / 1000 }), { afterRead: async () => { t += 2_000; } }, () => t);
    expect(await errorOf(refused)).toEqual([403, "step_up_required"]);
    // Too slow twice: 503, no ticket.
    t = NOW;
    const slow = await direct(await token(OWNER_SUB, "owner@example.test", 10, { at: NOW / 1000 }), { afterSign: () => { t += 5_001; } }, () => t);
    expect(await errorOf(slow)).toEqual([503, "door_unavailable"]);
    // The home changes after the route answered, before the hand-out: no ticket, nothing owed.
    t = NOW;
    const moved = await direct(await token(OWNER_SUB, "owner@example.test", 10, { at: NOW / 1000 }), {}, () => t, async () => {
      await env.DB.prepare("UPDATE cloud_homes SET generation=generation+1 WHERE id=?").bind(HOME).run();
    });
    expect(await errorOf(moved)).toEqual([409, "home_not_ready"]);
    await settle();
    expect(await noticeRows()).toBe(0);
    expect(await sweepDoorNotices(testEnv(), NOW + 86_400_000, deps)).toBe(0);
    expect(notices()).toHaveLength(0);
    // The first success is the one that owes it.
    const ok = await door(owner.token);
    expect(ok.status).toBe(200);
    await settle();
    expect(notices()).toEqual([expect.objectContaining({ to: "owner@example.test" })]);
    expect(notices()[0].text).toContain("was just given the one-time link that opens your Murage Cloud home");
  });

  it("through the worker: a late re-mint refused 403 (proof expired after finalization) is recorded 403, answered with retry and a fresh step-up, replayed the same, never 410", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await member(OTHER_SUB, "other@example.test");
    await seedHome(owner.id);
    const T = Math.floor(Date.now() / 1000) * 1000;
    let clock = T;
    const clocked = createWorker(fetch, fetch, {}, deps, {}, { jwksFetch, authFetch, now: () => clock });
    const sessionId = crypto.randomUUID();
    const intentId = await refusedIntent(sessionId, clocked);
    // Proved 290 s ago; the finalization takes 11 s: the hand-out's re-mint would carry a 301 s old proof.
    const db = jumpingDb((sql) => { if (sql.startsWith("SELECT phase, state FROM cloud_stepup_intents")) clock += 11_000; });
    const proofToken = await token(OWNER_SUB, "owner@example.test", 290, { sessionId, at: T / 1000 });
    const late = await held(clocked, `/v1/homes/${HOME}/door`, proofToken, { stepUpIntentId: intentId }, { ...testEnv(), DB: db } as Env);
    await waitOnExecutionContext(late.ctx);
    expect(late.res.status).toBe(403);
    expect(late.res.headers.get("x-step-up-consumed")).toBe("1");
    const body = await late.res.json<{ error: string; retry: string; url?: string; step_up: { email_code: { intent_id: string; available: boolean } } }>();
    expect([body.error, body.retry, body.url, body.step_up.email_code.available]).toEqual(["step_up_required", "step_up", undefined, true]);
    const fresh = body.step_up.email_code.intent_id;
    expect(fresh).not.toBe(intentId);
    expect(await env.DB.prepare("SELECT state, response_status, response_code FROM cloud_stepup_intents WHERE id=?").bind(intentId).first())
      .toEqual({ state: "done", response_status: 403, response_code: "step_up_required" });
    // No ticket was handed out: the arming is withdrawn, nothing owed, nothing sent.
    expect(await armedRows()).toBe(0);
    expect(notices()).toHaveLength(0);
    // The old intent's replay is that refusal with its retry fields, never 410.
    const s = Math.floor(clock / 1000);
    const replay = await held(clocked, `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", 3, { sessionId, at: s }), { stepUpIntentId: intentId });
    await waitOnExecutionContext(replay.ctx);
    const replayed = await replay.res.json<{ error: string; retry?: string; step_up?: { email_code: { intent_id: string } } }>();
    expect([replay.res.status, replayed.error, replayed.retry, typeof replayed.step_up?.email_code.intent_id]).toEqual([403, "step_up_required", "step_up", "string"]);
    // The fresh intent without a renewed proof (the same 301 s old authenticator proof, no emailed code): 403, no ticket.
    const reuse = await held(clocked, `/v1/homes/${HOME}/door`, proofToken, { stepUpIntentId: fresh });
    await waitOnExecutionContext(reuse.ctx);
    expect(await errorOf(reuse.res)).toEqual([403, "step_up_required"]);
    // (Another member and the owner's other session against a still-valid approved intent: the binding test below.)
    // A renewed proof on the fresh intent, in the session it was issued to, mints; that hand-out owes the notice.
    const minted = await held(clocked, `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", 3, { sessionId, at: s }), { stepUpIntentId: fresh });
    await waitOnExecutionContext(minted.ctx);
    expect(minted.res.status).toBe(200);
    expect(notices()).toEqual([expect.objectContaining({ to: "owner@example.test" })]);
  });

  it("through the worker: a home change after finalization refuses the hand-out with its real status, recorded, with retry; nothing owed", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const sessionId = crypto.randomUUID();
    const intentId = await refusedIntent(sessionId);
    // At recordOutcome's phase read (after the route answered, before the finalization), the home's generation moves.
    const db = new Proxy(env.DB, { get(target, prop) {
      if (prop === "prepare") return (sql: string) => {
        const st = target.prepare(sql);
        if (!sql.startsWith("SELECT phase, state FROM cloud_stepup_intents")) return st;
        return { bind: (...args: unknown[]) => { const b = st.bind(...args); return { first: async () => {
          await env.DB.prepare("UPDATE cloud_homes SET generation=generation+1 WHERE id=?").bind(HOME).run();
          return b.first();
        } }; } };
      };
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    } });
    const t = await token(OWNER_SUB, "owner@example.test", 5, { sessionId });
    const late = await held(worker, `/v1/homes/${HOME}/door`, t, { stepUpIntentId: intentId }, { ...testEnv(), DB: db } as Env);
    await waitOnExecutionContext(late.ctx);
    const body = await late.res.json<{ error: string; retry?: string }>();
    expect([late.res.status, body.error, body.retry]).toEqual([409, "home_not_ready", "step_up"]);
    expect(await env.DB.prepare("SELECT response_status, response_code FROM cloud_stepup_intents WHERE id=?").bind(intentId).first())
      .toEqual({ response_status: 409, response_code: "home_not_ready" });
    expect(await noticeRows()).toBe(0);
    const replay = await held(worker, `/v1/homes/${HOME}/door`, t, { stepUpIntentId: intentId });
    await waitOnExecutionContext(replay.ctx);
    const replayed = await replay.res.json<{ error: string; retry?: string }>();
    expect([replay.res.status, replayed.error, replayed.retry]).toEqual([409, "home_not_ready", "step_up"]);
  });

  it("exhausted limits at the retry after a refused hand-out: 429, the fresh intent stays usable, nothing owed", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const T = Math.floor(Date.now() / 1000) * 1000;
    let clock = T;
    const clocked = createWorker(fetch, fetch, {}, deps, {}, { jwksFetch, authFetch, now: () => clock });
    const sessionId = crypto.randomUUID();
    const intentId = await refusedIntent(sessionId, clocked);
    const db = jumpingDb((sql) => { if (sql.startsWith("SELECT phase, state FROM cloud_stepup_intents")) clock += 11_000; });
    const late = await held(clocked, `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", 290, { sessionId, at: T / 1000 }),
      { stepUpIntentId: intentId }, { ...testEnv(), DB: db } as Env);
    await waitOnExecutionContext(late.ctx);
    expect(late.res.status).toBe(403);
    const fresh = (await late.res.json<{ step_up: { email_code: { intent_id: string } } }>()).step_up.email_code.intent_id;
    // The account's minute budget is spent (10 mints a minute, the refused one counted).
    const s = Math.floor(clock / 1000);
    for (let i = 0; i < 9; i++) {
      const r = await held(clocked, `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", 3, { at: s }));
      await waitOnExecutionContext(r.ctx);
      expect(r.res.status).toBe(200);
    }
    await env.DB.prepare("DELETE FROM cloud_door_notices").run();
    sent.length = 0;
    const limited = await held(clocked, `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", 3, { sessionId, at: s }), { stepUpIntentId: fresh });
    await waitOnExecutionContext(limited.ctx);
    expect(limited.res.status).toBe(429);
    expect(await noticeRows()).toBe(0);
    expect(notices()).toHaveLength(0);
    // A minute later the same fresh intent mints.
    clock += 61_000;
    const later = await held(clocked, `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", 3, { sessionId, at: Math.floor(clock / 1000) }),
      { stepUpIntentId: fresh });
    await waitOnExecutionContext(later.ctx);
    expect(later.res.status).toBe(200);
  });
  it("an approved door intent is bound to its account and session: another member and the owner's other session are refused while it is still valid; its own session then mints", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await member(OTHER_SUB, "other@example.test");
    await seedHome(owner.id);
    const s = Math.floor(Date.now() / 1000);
    const sessionId = crypto.randomUUID();
    const intentId = await emailApproved(worker, sessionId, 0, s);
    const approvedAt = (await env.DB.prepare("SELECT approved_at FROM cloud_stepup_intents WHERE id=?").bind(intentId).first<{ approved_at: number }>())!.approved_at;
    const path = `/v1/homes/${HOME}/door`;
    const stranger = await held(worker, path, await token(OTHER_SUB, "other@example.test", null, { at: s }), { stepUpIntentId: intentId });
    await waitOnExecutionContext(stranger.ctx);
    expect([403, 404]).toContain(stranger.res.status);
    expect(JSON.stringify(await stranger.res.json())).not.toContain("/enter#t=");
    const otherSession = await held(worker, path, await token(OWNER_SUB, "owner@example.test", null, { at: s }), { stepUpIntentId: intentId });
    await waitOnExecutionContext(otherSession.ctx);
    expect([403, 404]).toContain(otherSession.res.status);
    expect(JSON.stringify(await otherSession.res.json())).not.toContain("/enter#t=");
    // Neither refusal spent or voided it: still approved, and its own session mints with it.
    expect((await env.DB.prepare("SELECT state FROM cloud_stepup_intents WHERE id=?").bind(intentId).first<{ state: string }>())!.state).toBe("approved");
    expect(await noticeRows()).toBe(0);
    const minted = await held(worker, path, await token(OWNER_SUB, "owner@example.test", null, { sessionId, at: s }), { stepUpIntentId: intentId });
    await waitOnExecutionContext(minted.ctx);
    expect(minted.res.status).toBe(200);
    expect((await ticketOf(minted.res)).claims.stepUpAt).toBe(approvedAt);
  });

  it("the 55 s check is the last step, after the notice batch: a 6 s batch re-mints (>= 55 s left at the answer); slow twice is 503 with the notice withdrawn", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const NOW = Math.floor(Date.now() / 1000) * 1000;
    const tok = await token(OWNER_SUB, "owner@example.test", 10, { at: NOW / 1000 });
    let t = NOW;
    // The first notice batch takes 6 s: the route's ticket has 54 s left after it, so it is minted again and the notice armed again.
    let signs = 0;
    const slowOnce = await direct(tok, { afterSign: () => { signs++; } }, () => t, undefined, armingDb((n) => { if (n === 0) t += 6_000; }));
    expect(slowOnce.status).toBe(200);
    expect(signs).toBe(2);
    const { claims } = await ticketOf(slowOnce);
    expect(claims.issuedAt).toBe(NOW + 6_000);
    expect((claims.expiresAt as number) - t).toBeGreaterThanOrEqual(55_000);
    await settle();
    expect(await noticeRows()).toBe(1);
    expect(notices()).toEqual([expect.objectContaining({ to: "owner@example.test" })]);
    await env.DB.prepare("DELETE FROM cloud_door_notices").run();
    sent.length = 0;
    // Every notice batch takes 6 s: 503, and the row this hand-out armed is taken back (unarmed): no notice for a ticket nobody got.
    t = NOW;
    const slowAlways = await direct(tok, {}, () => t, undefined, armingDb(() => { t += 6_000; }));
    expect(await errorOf(slowAlways)).toEqual([503, "door_unavailable"]);
    await settle();
    expect(await armedRows()).toBe(0);
    expect(await sweepDoorNotices(testEnv(), Date.now() + 86_400_000, deps)).toBe(0);
    expect(notices()).toHaveLength(0);
    // The re-armed batch fails after a slow first one: 503, withdrawn too.
    t = NOW;
    const failedAgain = await direct(tok, {}, () => t, undefined, armingDb((n) => { if (n === 0) t += 6_000; else throw new Error("D1 unavailable"); }));
    expect(await errorOf(failedAgain)).toEqual([503, "door_unavailable"]);
    await settle();
    expect(await armedRows()).toBe(0);
    expect(notices()).toHaveLength(0);
    // A concurrent hand-out that succeeded (and claimed the row) while this one was being refused keeps its notice: never disarmed.
    t = NOW;
    const raced = await direct(tok, { afterSign: async (n) => {
      if (n !== 1) return;
      const other = await door(owner.token);
      expect(other.status).toBe(200);
      await settle();
    } }, () => t, undefined, armingDb((n) => { if (n === 0) t += 6_000; else throw new Error("D1 unavailable"); }));
    expect(await errorOf(raced)).toEqual([503, "door_unavailable"]);
    await settle();
    expect(await noticeRows()).toBe(1);
    expect(await armedRows()).toBe(1);
    expect(notices()).toHaveLength(1);
    expect(await sweepDoorNotices(testEnv(), Date.now() + 86_400_000, deps)).toBe(0);
    expect(notices()).toHaveLength(1);
    // Astra DOORMINT-8, the exact interleaving: A arms (handouts 1, armed_by 1), its 6 s batch re-mints; B arms (2) and is answered 200,
    // leaving the send to A; A's second batch WRITES (3) and is slow again, so A is refused. B's write between A's two is seen: A never
    // unarms, the row stays armed and exactly one notice goes, worded for the delivered hand-out (B's).
    await env.DB.prepare("DELETE FROM cloud_door_notices").run();
    sent.length = 0;
    t = NOW;
    let bStatus = 0;
    const interleaved = await direct(tok, { afterSign: async (n) => {
      if (n !== 1) return;
      bStatus = (await door(owner.token)).status;
      await settle();
    } }, () => t, undefined, armingDb(() => { t += 6_000; }));
    expect(bStatus).toBe(200);
    expect(await errorOf(interleaved)).toEqual([503, "door_unavailable"]);
    await settle();
    const row = await env.DB.prepare("SELECT armed, handouts, armed_by, delivered, sent_at FROM cloud_door_notices")
      .first<{ armed: number; handouts: number; armed_by: number; delivered: number; sent_at: number | null }>();
    expect([row!.armed, row!.handouts, row!.armed_by, row!.delivered]).toEqual([1, 3, 1, 1]);
    expect(row!.sent_at).not.toBeNull();
    expect(notices()).toEqual([expect.objectContaining({ to: "owner@example.test", subject: DOOR_NOTICE_SUBJECT })]);
    expect(await sweepDoorNotices(testEnv(), Date.now() + 86_400_000, deps)).toBe(0);
    expect(notices()).toHaveLength(1);
  });

  it("through the worker: a failed notice batch is 503 with retry and a fresh step-up, recorded, nothing armed", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const sessionId = crypto.randomUUID();
    const intentId = await refusedIntent(sessionId);
    const t = await token(OWNER_SUB, "owner@example.test", 5, { sessionId });
    const late = await held(worker, `/v1/homes/${HOME}/door`, t, { stepUpIntentId: intentId },
      { ...testEnv(), DB: armingDb(() => { throw new Error("D1 unavailable"); }) } as Env);
    await waitOnExecutionContext(late.ctx);
    expect(late.res.status).toBe(503);
    expect(late.res.headers.get("x-step-up-consumed")).toBe("1");
    expect(late.res.headers.get("cache-control")).toContain("no-store");
    const body = await late.res.json<{ error: string; retry: string; url?: string; step_up: { email_code: { intent_id: string } } }>();
    expect([body.error, body.retry, body.url]).toEqual(["door_unavailable", "step_up", undefined]);
    expect(body.step_up.email_code.intent_id).not.toBe(intentId);
    expect(await env.DB.prepare("SELECT state, response_status, response_code FROM cloud_stepup_intents WHERE id=?").bind(intentId).first())
      .toEqual({ state: "done", response_status: 503, response_code: "door_unavailable" });
    expect(await noticeRows()).toBe(0);
    expect(notices()).toHaveLength(0);
  });

  it("through the worker: a refusal that cannot be recorded leaves the intent handing out; its replay is that refusal with retry, never 410, never a ticket", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const sessionId = crypto.randomUUID();
    const intentId = await refusedIntent(sessionId);
    const t = await token(OWNER_SUB, "owner@example.test", 5, { sessionId });
    const db = armingDb(() => { throw new Error("D1 unavailable"); }, (sql) => sql.startsWith("UPDATE cloud_stepup_intents SET response_status=?, response_code=?"));
    const late = await held(worker, `/v1/homes/${HOME}/door`, t, { stepUpIntentId: intentId }, { ...testEnv(), DB: db } as Env);
    await waitOnExecutionContext(late.ctx);
    const body = await late.res.json<{ error: string; retry?: string }>();
    expect([late.res.status, body.error, body.retry]).toEqual([503, "door_unavailable", "step_up"]);
    // Never a delivered 200: the record still says the ticket was being handed out.
    expect(await env.DB.prepare("SELECT state, phase, response_status, response_code FROM cloud_stepup_intents WHERE id=?").bind(intentId).first())
      .toEqual({ state: "done", phase: "delivered", response_status: 200, response_code: DOOR_HANDING_OUT });
    const replay = await held(worker, `/v1/homes/${HOME}/door`, t, { stepUpIntentId: intentId });
    await waitOnExecutionContext(replay.ctx);
    expect(replay.res.headers.get("x-step-up-consumed")).toBe("1");
    expect(replay.res.headers.get("cache-control")).toContain("no-store");
    const replayed = await replay.res.json<{ error: string; retry?: string; step_up?: { email_code: { intent_id: string } } }>();
    expect([replay.res.status, replayed.error, replayed.retry]).toEqual([503, "door_unavailable", "step_up"]);
    expect(replayed.step_up?.email_code.intent_id).toMatch(/^si_[0-9a-f]{32}$/);
    expect(replayed.step_up?.email_code.intent_id).not.toBe(intentId);
    expect(JSON.stringify(replayed)).not.toContain("/enter#t=");
    expect(await noticeRows()).toBe(0);
    // A handed-out ticket is recorded delivered/200 beside its answer (the handing-out code cleared): its replay is 409 already_completed
    // with retry and a fresh intent (the browser may have lost the answer), never a second ticket, never 410.
    const sessionB = crypto.randomUUID();
    const intentB = await refusedIntent(sessionB);
    const tB = await token(OWNER_SUB, "owner@example.test", 5, { sessionId: sessionB });
    const ok = await held(worker, `/v1/homes/${HOME}/door`, tB, { stepUpIntentId: intentB });
    await waitOnExecutionContext(ok.ctx);
    expect(ok.res.status).toBe(200);
    expect(await env.DB.prepare("SELECT response_status, response_code FROM cloud_stepup_intents WHERE id=?").bind(intentB).first())
      .toEqual({ response_status: 200, response_code: null });
    const again = await held(worker, `/v1/homes/${HOME}/door`, tB, { stepUpIntentId: intentB });
    await waitOnExecutionContext(again.ctx);
    expect(again.res.headers.get("x-step-up-consumed")).toBe("1");
    const done = await again.res.json<{ error: string; retry?: string; operation?: { id: string }; step_up?: { email_code: { intent_id: string } } }>();
    expect([again.res.status, done.error, done.retry, done.operation?.id]).toEqual([409, "already_completed", "step_up", intentB]);
    expect(done.step_up?.email_code.intent_id).toMatch(/^si_[0-9a-f]{32}$/);
    expect(done.step_up?.email_code.intent_id).not.toBe(intentB);
    expect(JSON.stringify(done)).not.toContain("/enter#t=");
  });

  it("through the worker: late 404 and 500 hand-out refusals are recorded, answered and replayed with retry and the consumed header, never 410", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    const other = await member(OTHER_SUB, "other@example.test");
    await seedHome(owner.id);
    const cases = [
      { name: "owner changed", status: 404, code: "not_found",
        onArm: async () => { await env.DB.prepare("UPDATE cloud_homes SET owner_id=? WHERE id=?").bind(other.id, HOME).run(); } },
      // A batch that answers nothing: an unexpected throw, sanitized to 500 internal_error.
      { name: "batch answered nothing", status: 500, code: "internal_error", onArm: () => [] },
    ];
    for (const c of cases) {
      await env.DB.prepare("UPDATE cloud_homes SET owner_id=? WHERE id=?").bind(owner.id, HOME).run();
      const sessionId = crypto.randomUUID();
      const intentId = await refusedIntent(sessionId);
      const t = await token(OWNER_SUB, "owner@example.test", 5, { sessionId });
      const late = await held(worker, `/v1/homes/${HOME}/door`, t, { stepUpIntentId: intentId }, { ...testEnv(), DB: armingDb(c.onArm) } as Env);
      await waitOnExecutionContext(late.ctx);
      expect([c.name, late.res.status, late.res.headers.get("x-step-up-consumed")]).toEqual([c.name, c.status, "1"]);
      expect(late.res.headers.get("cache-control")).toContain("no-store");
      const body = await late.res.json<Record<string, unknown>>();
      expect([c.name, body.error, body.retry]).toEqual([c.name, c.code, "step_up"]);
      // Nothing but the code and how to recover (no message, no stack).
      expect([c.name, Object.keys(body).filter((k) => !["error", "retry", "step_up"].includes(k))]).toEqual([c.name, []]);
      expect(await env.DB.prepare("SELECT response_status, response_code FROM cloud_stepup_intents WHERE id=?").bind(intentId).first())
        .toEqual({ response_status: c.status, response_code: c.code });
      await env.DB.prepare("UPDATE cloud_homes SET owner_id=? WHERE id=?").bind(owner.id, HOME).run();
      const replay = await held(worker, `/v1/homes/${HOME}/door`, t, { stepUpIntentId: intentId });
      await waitOnExecutionContext(replay.ctx);
      expect([c.name, replay.res.status, replay.res.headers.get("x-step-up-consumed")]).toEqual([c.name, c.status, "1"]);
      expect(replay.res.headers.get("cache-control")).toContain("no-store");
      const replayed = await replay.res.json<{ error: string; retry?: string; step_up?: { email_code: { intent_id: string } } }>();
      expect([c.name, replayed.error, replayed.retry, typeof replayed.step_up?.email_code.intent_id]).toEqual([c.name, c.code, "step_up", "string"]);
      expect(await noticeRows()).toBe(0);
    }
  });

  it("the sweep's delayed reader answer never overrides a newer reconciliation: fenced by the revision, both read again, sent to B", async () => {
    const owner = await member(OWNER_SUB, "a@example.test");
    await seedHome(owner.id);
    const now = Date.now();
    await owedRow(owner.id, now);
    let calls = 0;
    const delayed = { async emailGen(sub: string) {
      calls++;
      if (calls === 1) {
        // The reader captured A; before its answer arrives the member moves to B and a member request reconciles B (a new revision).
        supabaseNow.set(OWNER_SUB, { email: "b@example.test" });
        expect(await reconciledContactEmail(env.DB, owner.id, Date.now(), async (s) => ({ id: s, email: "b@example.test" }))).toBe("b@example.test");
        return { id: sub, email: "a@example.test", updatedAt: "2026-10-01T00:00:00Z" };
      }
      return { id: sub, email: supabaseNow.get(sub)?.email ?? "", updatedAt: "2026-10-01T00:00:00Z" };
    } };
    expect(await sweepDoorNotices(testEnv(), now, { emailSender: deps.emailSender, reader: delayed })).toBe(1);
    expect(calls).toBe(2);
    expect(notices()).toEqual([expect.objectContaining({ to: "b@example.test" })]);
    expect((await env.DB.prepare("SELECT contact_email FROM supabase_identities WHERE user_id=?").bind(owner.id).first<{ contact_email: string }>())!.contact_email)
      .toBe("b@example.test");
  });

  it("a day-long identity-reader outage keeps the notice owed with backoff capped at 6 h; on recovery it is sent once", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const start = Date.now();
    await owedRow(owner.id, start);
    readerDown.on = true;
    let at = start;
    let attempts = 0;
    while (at - start < 86_400_000) {
      const before = Date.now();
      expect(await sweepDoorNotices(testEnv(), at, { emailSender: deps.emailSender })).toBe(0);
      const row = (await env.DB.prepare("SELECT attempts, sent_at, next_attempt_at FROM cloud_door_notices").first<{ attempts: number; sent_at: number | null; next_attempt_at: number }>())!;
      if (row.attempts === attempts && row.sent_at === null) {
        // Door v2: at most three attempts an (account, home) clock hour; no slot left, so released to the next hour's start, not counted.
        expect(row.next_attempt_at).toBe((Math.floor(at / 3_600_000) + 1) * 3_600_000);
        at = row.next_attempt_at;
        continue;
      }
      expect([row.attempts, row.sent_at]).toEqual([++attempts, null]);
      const gap = row.next_attempt_at - before;
      expect(gap).toBeGreaterThanOrEqual(noticeBackoff(attempts - 1));
      expect(gap).toBeLessThanOrEqual(6 * 3_600_000 + 5_000);
      at = Math.max(at + gap, row.next_attempt_at);
    }
    expect(attempts).toBeGreaterThanOrEqual(10);
    expect(notices()).toHaveLength(0);
    readerDown.on = false;
    expect(await sweepDoorNotices(testEnv(), at, { emailSender: deps.emailSender })).toBe(1);
    expect(notices()).toEqual([expect.objectContaining({ to: "owner@example.test" })]);
    expect(await sweepDoorNotices(testEnv(), at + 2 * 86_400_000, { emailSender: deps.emailSender })).toBe(0);
    expect(notices()).toHaveLength(1);
  });
  // ---- Astra DOORMINT-6 ------------------------------------------------------------------------------------------------------------

  const noticeRow = () => env.DB.prepare("SELECT armed, sent_at, attempts, next_attempt_at FROM cloud_door_notices")
    .first<{ armed: number; sent_at: number | null; attempts: number; next_attempt_at: number }>();

  it("an unarmed row (an arming withdrawn) is never sent by the sweep; the first genuine hand-out arms it and sends once", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const now = Date.now();
    // As withdrawNotice leaves it (a hand-out refused after its arming write): unarmed, nothing cleaned up.
    await env.DB.prepare("INSERT INTO cloud_door_notices (account_id,home_id,session_id,bind,created_at,sent_at,attempts,next_attempt_at) VALUES (?,?,?,'',?,NULL,0,?)")
      .bind(owner.id, HOME, sessionOf(OWNER_SUB), now - 60_000, now - 60_000).run();
    expect((await noticeRow())!.armed).toBe(0);
    expect(await sweepDoorNotices(testEnv(), now + DOOR_NOTICE_CLAIM_MS + 60_000, deps)).toBe(0);
    const ctx = createExecutionContext();
    worker.scheduled({ scheduledTime: now + DOOR_NOTICE_CLAIM_MS + 60_000, cron: "*/5 * * * *", noRetry() {} }, testEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(notices()).toHaveLength(0);
    expect(await noticeRow()).toEqual(expect.objectContaining({ armed: 0, sent_at: null, attempts: 0 }));
    // The first genuine hand-out arms the old row and its notice goes out once; its sent_at then dedupes every later one.
    expect((await door(owner.token)).status).toBe(200);
    await settle();
    expect(notices()).toEqual([expect.objectContaining({ to: "owner@example.test" })]);
    expect((await noticeRow())!.armed).toBe(1);
    expect((await noticeRow())!.sent_at).not.toBeNull();
    expect(await sweepDoorNotices(testEnv(), Date.now() + 86_400_000, deps)).toBe(0);
    expect((await door(owner.token)).status).toBe(200);
    await settle();
    expect(notices()).toHaveLength(1);
  });

  it("a hand-out refused after its arming write: withdrawn, the row is never sent and tidied after a day; a failed withdrawal keeps it owed, sent once", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const NOW = Math.floor(Date.now() / 1000) * 1000;
    const tok = await token(OWNER_SUB, "owner@example.test", 10, { at: NOW / 1000 });
    let t = NOW;
    // Every arming batch takes 6 s (503): the arming is withdrawn, the row stays unarmed.
    const refused = await direct(tok, {}, () => t, undefined, armingDb(() => { t += 6_000; }));
    expect(await errorOf(refused)).toEqual([503, "door_unavailable"]);
    await settle();
    expect(await noticeRows()).toBe(1);
    expect((await noticeRow())!.armed).toBe(0);
    expect(await sweepDoorNotices(testEnv(), Date.now() + DOOR_NOTICE_CLAIM_MS + 60_000, deps)).toBe(0);
    expect(notices()).toHaveLength(0);
    expect(await noticeRows()).toBe(1);
    // A day on, the sweep tidies it away (best-effort; nothing depends on it).
    expect(await sweepDoorNotices(testEnv(), Date.now() + 2 * 86_400_000, deps)).toBe(0);
    expect(await noticeRows()).toBe(0);
    expect(notices()).toHaveLength(0);
    // The same refusal whose withdrawal fails: the arming write already owed the notice, so this hand-out makes its first attempt, once.
    t = NOW;
    const stuck = await direct(tok, {}, () => t, undefined, armingDb(() => { t += 6_000; }, (sql) => sql.startsWith("UPDATE cloud_door_notices SET armed=0")));
    expect(await errorOf(stuck)).toEqual([503, "door_unavailable"]);
    await settle();
    // Sent deliberately, but no ticket was handed out: it describes the access attempt, never that the link was given (Astra DOORMINT-8).
    expect(notices()).toEqual([expect.objectContaining({ to: "owner@example.test", subject: DOOR_ATTEMPT_SUBJECT })]);
    expect(notices()[0].text).toContain("Someone signed in to your Murage Cloud account and asked to open your home from a new browser.");
    expect(notices()[0].text).not.toContain("was just given");
    expect(await sweepDoorNotices(testEnv(), Date.now() + 86_400_000, deps)).toBe(0);
    expect((await door(owner.token)).status).toBe(200);
    await settle();
    expect(notices()).toHaveLength(1);
  });

  it("through the worker: a hand-out whose confirmation fails still sends its notice once (armed by the hand-out's write); the intent replays step_up", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const sessionId = crypto.randomUUID();
    const intentId = await refusedIntent(sessionId);
    const t = await token(OWNER_SUB, "owner@example.test", 5, { sessionId });
    // The confirmation (the intent recorded delivered) fails after the ticket was handed out.
    const db = armingDb(() => undefined, (sql) => sql.startsWith("UPDATE cloud_stepup_intents SET response_code=NULL"));
    const handed = await held(worker, `/v1/homes/${HOME}/door`, t, { stepUpIntentId: intentId }, { ...testEnv(), DB: db } as Env);
    expect(handed.res.status).toBe(200);
    await ticketOf(handed.res);
    await waitOnExecutionContext(handed.ctx);
    expect(notices()).toEqual([expect.objectContaining({ to: "owner@example.test" })]);
    expect(await noticeRow()).toEqual(expect.objectContaining({ armed: 1, attempts: 0 }));
    expect((await noticeRow())!.sent_at).not.toBeNull();
    expect(await env.DB.prepare("SELECT response_status, response_code FROM cloud_stepup_intents WHERE id=?").bind(intentId).first())
      .toEqual({ response_status: 200, response_code: DOOR_HANDING_OUT });
    expect(await sweepDoorNotices(testEnv(), Date.now() + 86_400_000, deps)).toBe(0);
    // The intent's replay: 503 with retry and a fresh intent, never 410, never a ticket.
    const replay = await held(worker, `/v1/homes/${HOME}/door`, t, { stepUpIntentId: intentId });
    await waitOnExecutionContext(replay.ctx);
    const replayed = await replay.res.json<{ error: string; retry?: string }>();
    expect([replay.res.status, replayed.error, replayed.retry]).toEqual([503, "door_unavailable", "step_up"]);
    // The same session (door v2: the notice is owed per Supabase session) owes nothing more.
    expect((await door(t)).status).toBe(200);
    await settle();
    expect(notices()).toHaveLength(1);
  });

  it("a refusal before the hand-out's write (a home change at the arming recheck) arms nothing and sends nothing", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const NOW = Math.floor(Date.now() / 1000) * 1000;
    const tok = await token(OWNER_SUB, "owner@example.test", 10, { at: NOW / 1000 });
    const moved = await direct(tok, {}, () => NOW, undefined, armingDb(async () => {
      await env.DB.prepare("UPDATE cloud_homes SET generation=generation+1 WHERE id=?").bind(HOME).run();
    }));
    expect(await errorOf(moved)).toEqual([409, "home_not_ready"]);
    await settle();
    expect(await noticeRows()).toBe(0);
    expect(await sweepDoorNotices(testEnv(), Date.now() + 86_400_000, deps)).toBe(0);
    expect(notices()).toHaveLength(0);
  });

  it("through the worker: a replay is classified from its record as re-read last, not from the read that built it: 503/403 with retry, delivered 409 with retry, never 410", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const cases = [
      { name: "recorded 503 meanwhile", status: 503 as number | null, code: "door_unavailable" as string | null, want: [503, "door_unavailable", "step_up"] },
      { name: "recorded 403 meanwhile", status: 403, code: "step_up_required", want: [403, "step_up_required", "step_up"] },
      { name: "confirmed meanwhile", status: 200, code: null, want: [409, "already_completed", "step_up"] },
    ];
    for (const c of cases) {
      // An intent left handing out: its refusal could not be recorded.
      const sessionId = crypto.randomUUID();
      const intentId = await refusedIntent(sessionId);
      const t = await token(OWNER_SUB, "owner@example.test", 5, { sessionId });
      const stuck = armingDb(() => { throw new Error("D1 unavailable"); }, (sql) => sql.startsWith("UPDATE cloud_stepup_intents SET response_status=?, response_code=?"));
      const late = await held(worker, `/v1/homes/${HOME}/door`, t, { stepUpIntentId: intentId }, { ...testEnv(), DB: stuck } as Env);
      await waitOnExecutionContext(late.ctx);
      expect([c.name, late.res.status]).toEqual([c.name, 503]);
      expect(await env.DB.prepare("SELECT response_status, response_code FROM cloud_stepup_intents WHERE id=?").bind(intentId).first())
        .toEqual({ response_status: 200, response_code: DOOR_HANDING_OUT });
      // The replay's first read sees "handing out"; the original records its outcome before the replay reads the record again.
      let landed = false;
      const db = hookedDb((sql) => sql.startsWith("SELECT phase, response_status, response_code") && sql.includes("FROM cloud_stepup_intents WHERE id=? AND state='done'"), async () => {
        await env.DB.prepare("UPDATE cloud_stepup_intents SET response_status=?, response_code=? WHERE id=?").bind(c.status, c.code, intentId).run();
        landed = true;
      });
      const replay = await held(worker, `/v1/homes/${HOME}/door`, t, { stepUpIntentId: intentId }, { ...testEnv(), DB: db } as Env);
      await waitOnExecutionContext(replay.ctx);
      expect([c.name, landed]).toEqual([c.name, true]);
      expect([c.name, replay.res.headers.get("x-step-up-consumed")]).toEqual([c.name, "1"]);
      const body = await replay.res.json<{ error: string; retry?: string; url?: string; step_up?: { email_code: { intent_id: string } } }>();
      expect([c.name, replay.res.status, body.error, body.retry]).toEqual([c.name, ...c.want]);
      expect([c.name, body.url, JSON.stringify(body).includes("/enter#t=")]).toEqual([c.name, undefined, false]);
      if (c.want[2] === "step_up") expect([c.name, typeof body.step_up?.email_code.intent_id]).toEqual([c.name, "string"]);
    }
    expect(notices()).toHaveLength(0);
  });

  it("the sweep's reconciliation A -> B is fenced after its event log: a move B -> C that lands meanwhile is never answered as B; sent to C", async () => {
    const owner = await member(OWNER_SUB, "a@example.test");
    await seedHome(owner.id);
    const now = Date.now();
    await owedRow(owner.id, now);
    supabaseNow.set(OWNER_SUB, { email: "b@example.test" });
    let landed = false;
    const db = hookedDb((sql) => sql.startsWith("INSERT INTO account_link_events"), async () => {
      // While the sweep logs its A -> B move, the member moves on to C and a member request reconciles it.
      supabaseNow.set(OWNER_SUB, { email: "c@example.test" });
      expect(await reconciledContactEmail(env.DB, owner.id, Date.now(), async (s) => ({ id: s, email: "c@example.test" }))).toBe("c@example.test");
      landed = true;
    });
    expect(await sweepDoorNotices({ ...testEnv(), DB: db } as Env, now, { emailSender: deps.emailSender, reader })).toBe(1);
    expect(landed).toBe(true);
    expect(notices()).toEqual([expect.objectContaining({ to: "c@example.test" })]);
    expect((await contactOf(owner.id)).contact_email).toBe("c@example.test");
  });

  it("INTEGRATED-7 P2 door stale recipient: a move to C reconciled while the sweep reads the delivered flag never leaves the send on B; sent to C", async () => {
    const owner = await member(OWNER_SUB, "a@example.test");
    await seedHome(owner.id);
    const now = Date.now();
    await owedRow(owner.id, now);
    supabaseNow.set(OWNER_SUB, { email: "b@example.test" });
    let landed = false;
    const db = hookedDb((sql) => sql.startsWith("UPDATE cloud_door_notices SET claim_id="), async () => {
      // While the sweep reads the delivered flag, the member moves on to C and a member request reconciles it.
      supabaseNow.set(OWNER_SUB, { email: "c@example.test" });
      expect(await reconciledContactEmail(env.DB, owner.id, Date.now(), async (s) => ({ id: s, email: "c@example.test" }))).toBe("c@example.test");
      landed = true;
    });
    expect(await sweepDoorNotices({ ...testEnv(), DB: db } as Env, now, { emailSender: deps.emailSender, reader })).toBe(1);
    expect(landed).toBe(true);
    // Before the fix: reconciled to B first, then the flag read let C land, and B (stale) was emailed and the row marked sent.
    expect(notices()).toEqual([expect.objectContaining({ to: "c@example.test", subject: DOOR_NOTICE_SUBJECT })]);
    expect((await contactOf(owner.id)).contact_email).toBe("c@example.test");
  });

  it("the sweep's conflict clearing is fenced after its event log: a move to C that lands meanwhile is never answered as A; sent to C", async () => {
    const owner = await member(OWNER_SUB, "a@example.test");
    await seedHome(owner.id);
    const now = Date.now();
    await owedRow(owner.id, now);
    // A conflict recorded earlier; Supabase is back on the stored A, so the sweep clears it.
    await env.DB.prepare("UPDATE supabase_identities SET email_conflict='b@example.test', email_revision=email_revision+1 WHERE user_id=?").bind(owner.id).run();
    let landed = false;
    const db = hookedDb((sql) => sql.startsWith("INSERT INTO account_link_events"), async () => {
      supabaseNow.set(OWNER_SUB, { email: "c@example.test" });
      expect(await reconciledContactEmail(env.DB, owner.id, Date.now(), async (s) => ({ id: s, email: "c@example.test" }))).toBe("c@example.test");
      landed = true;
    });
    expect(await sweepDoorNotices({ ...testEnv(), DB: db } as Env, now, { emailSender: deps.emailSender, reader })).toBe(1);
    expect(landed).toBe(true);
    expect(notices()).toEqual([expect.objectContaining({ to: "c@example.test" })]);
    expect(await contactOf(owner.id)).toEqual({ contact_email: "c@example.test", email_conflict: null });
  });

  it("three revision collisions in one sweep attempt: backed off, nothing sent; a later sweep sends once", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const now = Date.now();
    await owedRow(owner.id, now);
    let calls = 0;
    // Every round's revision is overtaken by a concurrent write while Supabase is being asked.
    const racing = { async emailGen(sub: string) {
      calls++;
      await env.DB.prepare("UPDATE supabase_identities SET email_revision=email_revision+1 WHERE sub=?").bind(sub).run();
      return { id: sub, email: "owner@example.test", updatedAt: "2026-10-01T00:00:00Z" };
    } };
    const before = Date.now();
    expect(await sweepDoorNotices(testEnv(), now, { emailSender: deps.emailSender, reader: racing })).toBe(0);
    expect(calls).toBe(3);
    expect(notices()).toHaveLength(0);
    const row = (await noticeRow())!;
    expect([row.sent_at, row.attempts, row.next_attempt_at >= before + noticeBackoff(0)]).toEqual([null, 1, true]);
    expect(await sweepDoorNotices(testEnv(), row.next_attempt_at, deps)).toBe(1);
    expect(notices()).toEqual([expect.objectContaining({ to: "owner@example.test" })]);
    expect(await sweepDoorNotices(testEnv(), row.next_attempt_at + 86_400_000, deps)).toBe(0);
    expect(notices()).toHaveLength(1);
  });

  it("through the worker: a lost response is recovered with one more step-up: the delivered intent's replay is 409 with a fresh intent, which mints", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const sessionId = crypto.randomUUID();
    const intentId = await refusedIntent(sessionId);
    const t = await token(OWNER_SUB, "owner@example.test", 5, { sessionId });
    // The hand-out commits (ticket answered, intent recorded delivered), but the browser never receives the answer.
    const lost = await held(worker, `/v1/homes/${HOME}/door`, t, { stepUpIntentId: intentId });
    await waitOnExecutionContext(lost.ctx);
    expect(lost.res.status).toBe(200);
    // The member presses Open again with the same (consumed) intent: no second ticket, but the way back in.
    const again = await held(worker, `/v1/homes/${HOME}/door`, t, { stepUpIntentId: intentId });
    await waitOnExecutionContext(again.ctx);
    const body = await again.res.json<{ error: string; retry?: string; url?: string; step_up?: { email_code: { intent_id: string; available: boolean } } }>();
    expect([again.res.status, body.error, body.retry, body.url]).toEqual([409, "already_completed", "step_up", undefined]);
    expect(again.res.headers.get("x-step-up-consumed")).toBe("1");
    expect(JSON.stringify(body)).not.toContain("/enter#t=");
    const fresh = body.step_up!.email_code.intent_id;
    expect(fresh).toMatch(/^si_[0-9a-f]{32}$/);
    expect(fresh).not.toBe(intentId);
    // One more step-up on the fresh intent (a fresh authenticator proof), and the door opens.
    const minted = await held(worker, `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", 3, { sessionId }), { stepUpIntentId: fresh });
    await waitOnExecutionContext(minted.ctx);
    expect(minted.res.status).toBe(200);
    await ticketOf(minted.res);
    // Still one notice for the (account, home).
    expect(notices()).toHaveLength(1);
  });

  it("the cleanup racing a hand-out's arming of an old unarmed row: in either order the notice is armed and sent once", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    const oldRow = () => env.DB.prepare("INSERT INTO cloud_door_notices (account_id,home_id,session_id,bind,created_at,sent_at,attempts,next_attempt_at,armed,handouts,armed_by) VALUES (?,?,?,'',?,NULL,0,?,0,1,1)")
      .bind(owner.id, HOME, sessionOf(OWNER_SUB), Date.now() - 2 * 86_400_000, Date.now() - 2 * 86_400_000).run();
    // The arming lands first, inside the sweep's cleanup: the cleanup finds an armed row and leaves it.
    await oldRow();
    const cleanupLate = hookedDb((sql) => sql.startsWith("DELETE FROM cloud_door_notices WHERE armed=0"), async () => {
      expect((await door(owner.token)).status).toBe(200);
    });
    expect(await sweepDoorNotices({ ...testEnv(), DB: cleanupLate } as Env, Date.now(), deps)).toBe(0);
    await settle();
    expect(notices()).toHaveLength(1);
    expect(await noticeRow()).toEqual(expect.objectContaining({ armed: 1 }));
    expect((await noticeRow())!.sent_at).not.toBeNull();
    // The cleanup lands first, inside the hand-out's arming batch: the arming writes a new row.
    await env.DB.prepare("DELETE FROM cloud_door_notices").run();
    sent.length = 0;
    await oldRow();
    const NOW = Math.floor(Date.now() / 1000) * 1000;
    const tok = await token(OWNER_SUB, "owner@example.test", 10, { at: NOW / 1000 });
    const handed = await direct(tok, {}, () => NOW, undefined, armingDb(async () => { await sweepDoorNotices(testEnv(), Date.now(), deps); }));
    expect(handed.status).toBe(200);
    await settle();
    expect(notices()).toHaveLength(1);
    expect(await noticeRow()).toEqual(expect.objectContaining({ armed: 1 }));
    expect(await sweepDoorNotices(testEnv(), Date.now() + 86_400_000, deps)).toBe(0);
    expect(notices()).toHaveLength(1);
  });

  it("the unarmed cleanup has its own partial index and uses it", async () => {
    const index = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='cloud_door_notices_unarmed'").first<{ sql: string }>();
    expect(index?.sql).toMatch(/\(created_at\) WHERE sent_at IS NULL AND armed=0/);
    const plan = await env.DB.prepare("EXPLAIN QUERY PLAN DELETE FROM cloud_door_notices WHERE armed=0 AND sent_at IS NULL AND created_at<?").bind(0)
      .all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(" ")).toContain("cloud_door_notices_unarmed");
  });

  it("through the worker: a delivered intent's replay is bound to its account and session: another member and the owner's other session get no recovery", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await member(OTHER_SUB, "other@example.test");
    await seedHome(owner.id);
    const sessionId = crypto.randomUUID();
    const intentId = await refusedIntent(sessionId);
    const path = `/v1/homes/${HOME}/door`;
    const t = await token(OWNER_SUB, "owner@example.test", 5, { sessionId });
    const lost = await held(worker, path, t, { stepUpIntentId: intentId });
    await waitOnExecutionContext(lost.ctx);
    expect(lost.res.status).toBe(200);
    for (const other of [await token(OTHER_SUB, "other@example.test", null), await token(OWNER_SUB, "owner@example.test", null)]) {
      const r = await held(worker, path, other, { stepUpIntentId: intentId });
      await waitOnExecutionContext(r.ctx);
      const text = JSON.stringify(await r.res.json());
      expect([403, 404]).toContain(r.res.status);
      expect(text).not.toContain("/enter#t=");
      expect(text).not.toContain("already_completed");
      expect(r.res.headers.get("x-step-up-consumed")).toBeNull();
    }
    // Its own session still gets the recovery.
    const again = await held(worker, path, t, { stepUpIntentId: intentId });
    await waitOnExecutionContext(again.ctx);
    expect([again.res.status, (await again.res.json<{ error: string }>()).error]).toEqual([409, "already_completed"]);
    expect(notices()).toHaveLength(1);
  });

  it("through the worker: the fresh intent of a delivered replay meets the account's exhausted budget: 429, still usable a minute later", async () => {
    const owner = await member(OWNER_SUB, "owner@example.test");
    await seedHome(owner.id);
    let clock = Math.floor(Date.now() / 1000) * 1000;
    const clocked = createWorker(fetch, fetch, {}, deps, {}, { jwksFetch, authFetch, now: () => clock });
    const sessionId = crypto.randomUUID();
    const intentId = await refusedIntent(sessionId, clocked);
    const path = `/v1/homes/${HOME}/door`;
    const t = await token(OWNER_SUB, "owner@example.test", 5, { sessionId, at: Math.floor(clock / 1000) });
    const lost = await held(clocked, path, t, { stepUpIntentId: intentId });
    await waitOnExecutionContext(lost.ctx);
    expect(lost.res.status).toBe(200);
    const again = await held(clocked, path, t, { stepUpIntentId: intentId });
    await waitOnExecutionContext(again.ctx);
    expect(again.res.status).toBe(409);
    const fresh = (await again.res.json<{ step_up: { email_code: { intent_id: string } } }>()).step_up.email_code.intent_id;
    // Spend the account's minute budget (10 a minute).
    const s = Math.floor(clock / 1000);
    let limitedAt = -1;
    for (let i = 0; i < 12 && limitedAt < 0; i++) {
      const r = await held(clocked, path, await token(OWNER_SUB, "owner@example.test", 3, { sessionId, at: s }));
      await waitOnExecutionContext(r.ctx);
      if (r.res.status === 429) limitedAt = i; else expect(r.res.status).toBe(200);
    }
    expect(limitedAt).toBeGreaterThanOrEqual(0);
    const before = notices().length;
    const limited = await held(clocked, path, await token(OWNER_SUB, "owner@example.test", 3, { sessionId, at: s }), { stepUpIntentId: fresh });
    await waitOnExecutionContext(limited.ctx);
    expect(limited.res.status).toBe(429);
    expect(JSON.stringify(await limited.res.json())).not.toContain("/enter#t=");
    expect(notices()).toHaveLength(before);
    clock += 61_000;
    const later = await held(clocked, path, await token(OWNER_SUB, "owner@example.test", 3, { sessionId, at: Math.floor(clock / 1000) }),
      { stepUpIntentId: fresh });
    await waitOnExecutionContext(later.ctx);
    expect(later.res.status).toBe(200);
    await ticketOf(later.res);
    expect(notices()).toHaveLength(1);
  });
});

// ---- door v2 (CLOUD-DOOR-V2-DESIGN.md r4 4B, r4.1, r4.2) ----------------------------------------------------------------------------

describe("D1 door v2", () => {
  const BIND_A = "a".repeat(64);
  const BIND_B = "b".repeat(64);
  const bindN = (n: number) => n.toString(16).padStart(64, "0");
  const V1_KEYS = CLAIM_KEYS;
  const V2_KEYS = [...CLAIM_KEYS, "bind", "kind"];
  const HOLD = "hold-door-0123456789";
  const ONE_HOUR = 3_600_000;
  /** The home's side of device management (pairing.ts homeManagementCall): every call recorded; `homeAnswer` answers it. */
  const homeCalls: { path: string; body: Record<string, unknown>; signature: string | null; origin: string | null }[] = [];
  let homeAnswer: (path: string, body: Record<string, unknown>) => Response = () => Response.json({ devices: [] });
  const fakeWrapper = () => ({ unwrap: async () => new Uint8Array(32).fill(7) }) as unknown as KeyWrapper;
  beforeEach(() => {
    homeCalls.length = 0;
    homeAnswer = () => Response.json({ devices: [] });
    deps.homeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const path = new URL(String(input)).pathname;
      homeCalls.push({ path, body, signature: h.get("x-murage-signature"), origin: h.get("origin") });
      return homeAnswer(path, body);
    }) as typeof fetch;
    deps.keyWrapper = fakeWrapper;
  });
  afterEach(() => { delete deps.homeFetch; delete deps.keyWrapper; });

  /** The worker's answer with any method and extra env (DOOR_V2_REQUIRED). */
  async function req(method: string, path: string, bearer: string | null, body: unknown = undefined, extra: Record<string, string> = {}, w = worker) {
    const headers = new Headers({ "content-type": "application/json" });
    if (bearer) headers.set("authorization", `Bearer ${bearer}`);
    const ctx = createExecutionContext();
    const res = await w.fetch(new Request(`https://auth.murage.test${path}`, { method, headers,
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}) }), { ...testEnv(), ...extra } as Env, ctx);
    pending.push(waitOnExecutionContext(ctx));
    return res;
  }
  const flag = { DOOR_V2_REQUIRED: "1" };
  const mintWith = (t: string, body: unknown, extra: Record<string, string> = {}) => req("POST", `/v1/homes/${HOME}/door`, t, body, extra);
  const errorOf = async (r: Response) => [r.status, (await r.json<{ error: string }>()).error];
  const setDoor = (v: string | null) => env.DB.prepare("UPDATE cloud_homes SET door_version=? WHERE id=?").bind(v, HOME).run();
  /** A member's aal1 token whose amr is exactly `amr` (seconds ago), in session `sessionId`. */
  async function amrToken(sub: string, email: string, amr: { method: string; ago: number }[], sessionId: string = crypto.randomUUID(), at?: number) {
    const s = at ?? Math.floor(Date.now() / 1000);
    const c = { iss: ISS, aud: "authenticated", exp: s + 3600, iat: s - 5, sub, email, role: "authenticated", is_anonymous: false,
      app_metadata: { provider: "email", email_verified: true }, user_metadata: {}, session_id: sessionId, aal: "aal1",
      amr: amr.map((a) => ({ method: a.method, timestamp: s - a.ago })) };
    const input = `${b64u(JSON.stringify({ alg: "ES256", kid: "ec-1", typ: "JWT" }))}.${b64u(JSON.stringify(c))}`;
    return `${input}.${b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, new TextEncoder().encode(input)))}`;
  }
  async function seedKeys() {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cloud_machines (id,home_id,generation,state,created_at,public_origin,admin_url) VALUES (?,?,3,'active',?,?,?)`)
        .bind(HOME, HOME, Date.now(), ORIGIN, "https://admin.murage.test"),
      env.DB.prepare("INSERT INTO cloud_home_keys VALUES (?,?,?,?,?)").bind(HOME, "w1", "w2", "w3", "v1"),
    ]);
  }
  const hold = (over: Record<string, unknown> = {}) => {
    const now = Date.now();
    const row: Record<string, unknown> = { id: HOLD, home_id: HOME, action: "pair", generation: 3, started_at: now - 73 * ONE_HOUR,
      completes_at: now - ONE_HOUR, completed_at: now - ONE_HOUR, canceled_at: null, source: "customer", ...over };
    const k = Object.keys(row);
    return env.DB.prepare(`INSERT INTO cloud_recovery_holds (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`).bind(...k.map((x) => row[x])).run();
  };
  const holdRow = () => env.DB.prepare("SELECT reserved_by,reserved_until,spent_device_digest,spent_at FROM cloud_recovery_holds WHERE id=?").bind(HOLD)
    .first<{ reserved_by: string | null; reserved_until: number | null; spent_device_digest: string | null; spent_at: number | null }>();
  /** The home says a full-scope device ever enrolled (devices/list fullScopeEver: true; the last one may be revoked). */
  const hadDesktop = async () => { homeAnswer = () => Response.json({ devices: [], fullScopeEver: true }); };
  /** A legacy pairing code the CP issued (cloud_unwrap_log pairing_ok), which proves no enrollment. */
  const issuedCode = () => env.DB.prepare("INSERT INTO cloud_unwrap_log (home_id,generation,at,source_ip,outcome) VALUES (?,3,?,NULL,'pairing_ok')")
    .bind(HOME, Date.now()).run();
  async function v2Home(sub = OWNER_SUB, email = "owner@example.test") {
    const m = await member(sub, email);
    await seedHome(m.id);
    await seedKeys();
    await setDoor("v2");
    return m;
  }
  const notices = () => env.DB.prepare("SELECT session_id,bind,armed,sent_at,next_attempt_at,attempts FROM cloud_door_notices ORDER BY created_at, bind").all<Record<string, unknown>>()
    .then((r) => r.results);
  const slots = () => env.DB.prepare("SELECT hour,n FROM cloud_door_notice_slots ORDER BY hour,n").all<{ hour: number; n: number }>().then((r) => r.results);

  // ---- the 4B mint table ----
  it("D1 mint: v2 home {bind, kind} -> murage-door-v2 with exactly those claims, flag off and on", async () => {
    const m = await v2Home();
    for (const extra of [{}, flag]) {
      const res = await mintWith(m.token, { bind: BIND_A, kind: "browser" }, extra);
      expect(res.status).toBe(200);
      const { claims, body } = await ticketOf(res);
      expect(body.expiresIn).toBe(60);
      expect(Object.keys(claims)).toEqual(V2_KEYS);
      expect(claims).toMatchObject({ type: "murage-door-v2", homeId: HOME, generation: 3, publicOrigin: ORIGIN, account: m.id, bind: BIND_A, kind: "browser" });
      expect((claims.expiresAt as number) - (claims.issuedAt as number)).toBe(60_000);
    }
  });
  it("D1 mint: a door_proof=1 home adds proof to a browser ticket; door_proof=0 adds none (CLOUD-DOOR-OWNER-FACTOR-DESIGN-r3 4.1)", async () => {
    const m = await v2Home();
    const setDoorProof = (v: number) => env.DB.prepare("UPDATE cloud_homes SET door_proof=? WHERE id=?").bind(v, HOME).run();
    const emailTok = await amrToken(OWNER_SUB, "owner@example.test", [{ method: "otp", ago: 10 }]);
    // door_proof off (the default): a browser ticket carries exactly the v2 keys, no proof.
    expect(Object.keys((await ticketOf(await mintWith(emailTok, { bind: BIND_A, kind: "browser" }))).claims)).toEqual(V2_KEYS);
    // door_proof on: a browser ticket whose sign-in carried an emailed code (amr otp -> "email") carries proof.
    await setDoorProof(1);
    const browser = await ticketOf(await mintWith(emailTok, { bind: BIND_A, kind: "browser" }));
    expect(Object.keys(browser.claims).sort()).toEqual([...V2_KEYS, "proof"].sort());
    expect(browser.claims.proof).toBe("email");
  });
  it("D1 mint: v2 home {} is 400 door_body_required, with and without the flag, logged", async () => {
    const m = await v2Home();
    const log = vi.spyOn(console, "log");
    for (const extra of [{}, flag]) expect(await errorOf(await mintWith(m.token, {}, extra))).toEqual([400, "door_body_required"]);
    expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("door body required"))).toHaveLength(2);
  });
  it("D1 mint: v1 home {} -> v1 claims with the flag off, 409 door_needs_update with it on", async () => {
    const m = await member(OWNER_SUB, "owner@example.test");
    await seedHome(m.id);
    const res = await mintWith(m.token, {});
    expect(res.status).toBe(200);
    const { claims } = await ticketOf(res);
    expect(Object.keys(claims)).toEqual(V1_KEYS);
    expect(claims.type).toBe("murage-door-v1");
    const refused = await mintWith(m.token, {}, flag);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "door_needs_update" });
  });
  it("D1 mint: v1 home browser {bind, kind} -> v1 claims with bind dropped (flag off), 409 with it on; desktop -> 409 either way", async () => {
    const m = await member(OWNER_SUB, "owner@example.test");
    await seedHome(m.id);
    const res = await mintWith(m.token, { bind: BIND_A, kind: "browser" });
    expect(res.status).toBe(200);
    const { claims } = await ticketOf(res);
    expect(Object.keys(claims)).toEqual(V1_KEYS);
    expect(JSON.stringify(claims)).not.toContain(BIND_A);
    expect(await errorOf(await mintWith(m.token, { bind: BIND_A, kind: "browser" }, flag))).toEqual([409, "door_needs_update"]);
    for (const extra of [{}, flag]) {
      const d = await mintWith(m.token, { bind: BIND_A, kind: "desktop" }, extra);
      expect(d.status).toBe(409);
      expect(await d.json()).toEqual({ error: "door_needs_update" });
    }
  });
  it("D1 mint: {bind} alone, bad hex, upper-case hex, a bad kind and extra fields are 400 invalid_request", async () => {
    const m = await v2Home();
    for (const body of [{ bind: BIND_A }, { kind: "browser" }, { bind: "g".repeat(64), kind: "browser" }, { bind: "A".repeat(64), kind: "browser" },
      { bind: "a".repeat(63), kind: "browser" }, { bind: BIND_A, kind: "phone" }, { bind: BIND_A, kind: "browser", extra: 1 }, { extra: 1 }]) {
      expect(await errorOf(await mintWith(m.token, body))).toEqual([400, "invalid_request"]);
    }
  });
  it("D1 mint: the mint log carries door, kind and proof, never the bind, nonce or ticket", async () => {
    const m = await v2Home();
    const log = vi.spyOn(console, "log");
    const res = await mintWith(m.token, { bind: BIND_A, kind: "browser" });
    const { claims, ticket } = await ticketOf(res);
    await settle();
    const lines = log.mock.calls.map((c) => String(c[0]));
    const minted = lines.filter((l) => l.includes("door ticket minted")).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(minted).toEqual([expect.objectContaining({ door: "v2", kind: "browser", proof: "factor", homeId: HOME })]);
    for (const l of lines) for (const secret of [BIND_A, claims.nonce as string, ticket]) expect(l).not.toContain(secret);
  });
  it("D1 mint: first press after ready (MurageCloud (a)): a stamped home with the flag on mints murage-door-v2, never v1", async () => {
    const m = await v2Home();
    const res = await mintWith(m.token, { bind: BIND_A, kind: "browser" }, flag);
    expect((await ticketOf(res)).claims.type).toBe("murage-door-v2");
  });
  it("D1 mint: a home whose door changes between the read and the recheck is 409 home_not_ready", async () => {
    const m = await v2Home();
    const identity = createIdentity({ jwksFetch, authFetch });
    const e = testEnv();
    const request = new Request(`https://auth.murage.test/v1/homes/${HOME}/door`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${m.token}` }, body: JSON.stringify({ bind: BIND_A, kind: "browser" }) });
    identity.bind(request, e);
    await expect(doorRoute(request, e, identity, "req-x", { afterRead: async () => { await setDoor(null); } })).rejects.toMatchObject({ status: 409, code: "home_not_ready" });
  });
  it("D1 GET /v1/homes says door v1 until the home stamps v2", async () => {
    const m = await member(OWNER_SUB, "owner@example.test");
    await seedHome(m.id);
    const list = async () => (await (await req("GET", "/v1/homes", m.token)).json<{ homes: { id: string; door: string }[] }>()).homes;
    expect(await list()).toEqual([expect.objectContaining({ id: HOME, door: "v1" })]);
    await setDoor("v2");
    expect(await list()).toEqual([expect.objectContaining({ id: HOME, door: "v2" })]);
  });

  // ---- the door's 15-minute reuse (3.4) ----
  it("D1 reuse: the emailed sign-in (amr otp) counts for 900 s, not 901; magiclink counts; password never", async () => {
    const m = await v2Home();
    // The worker's clock pinned to a whole second: the sign-in's age is exact.
    const T = Math.floor(Date.now() / 1000) * 1000;
    const pinned = createWorker(fetch, fetch, {}, deps, {}, { jwksFetch, authFetch, now: () => T });
    const at = async (method: string, ago: number) => req("POST", `/v1/homes/${HOME}/door`,
      await amrToken(OWNER_SUB, "owner@example.test", [{ method, ago }], undefined, T / 1000), { bind: BIND_A, kind: "browser" }, {}, pinned);
    const ok = await at("otp", 600);
    expect(ok.status).toBe(200);
    expect((await ticketOf(ok)).claims.stepUpAt).toBe((Math.floor(T / 1000) - 600) * 1000);
    expect((await at("otp", 900)).status).toBe(200);
    expect(await errorOf(await at("otp", 901))).toEqual([403, "step_up_required"]);
    expect(await errorOf(await at("otp", 960))).toEqual([403, "step_up_required"]);
    expect((await at("magiclink", 60)).status).toBe(200);
    expect(await errorOf(await at("password", 10))).toEqual([403, "step_up_required"]);
    void m;
  });
  it("D1 reuse: no amr, a granted emailed code 5 minutes old in THIS session mints; in another session or account it does not; claimed still counts", async () => {
    const m = await v2Home();
    const other = await member(OTHER_SUB, "other@example.test");
    const now = Date.now();
    const grant = (user: string, session: string, kind = "granted") => env.DB.prepare(
      "INSERT INTO cloud_stepup_events (id,user_id,session_id,kind,intent_id,challenge_id,at) VALUES (?,?,?,?,NULL,NULL,?)")
      .bind(crypto.randomUUID(), user, session, kind, now - 300_000).run();
    await grant(m.id, "sess-mine");
    await grant(m.id, "sess-mine", "claimed");
    await grant(other.id, "sess-theirs");
    const mint = async (session: string) => mintWith(await amrToken(OWNER_SUB, "owner@example.test", [], session), { bind: BIND_A, kind: "browser" });
    expect((await mint("sess-mine")).status).toBe(200);
    expect(await errorOf(await mint("sess-other"))).toEqual([403, "step_up_required"]);
    expect(await errorOf(await mint("sess-theirs"))).toEqual([403, "step_up_required"]);
    // 16 minutes old: no longer.
    await env.DB.prepare("UPDATE cloud_stepup_events SET at=? WHERE session_id='sess-mine'").bind(now - 960_000).run();
    expect(await errorOf(await mint("sess-mine"))).toEqual([403, "step_up_required"]);
  });
  it("D1 reuse: a v1 ticket keeps the 300 s window (a v1 home refuses older)", async () => {
    const m = await member(OWNER_SUB, "owner@example.test");
    await seedHome(m.id);
    expect((await mintWith(await amrToken(OWNER_SUB, "owner@example.test", [{ method: "otp", ago: 200 }]), {})).status).toBe(200);
    expect(await errorOf(await mintWith(await amrToken(OWNER_SUB, "owner@example.test", [{ method: "otp", ago: 600 }]), {}))).toEqual([403, "step_up_required"]);
  });
  it("D1 gate: the reuse exemption names only the door: the pair hold, a desktop code and a device revoke with a 5-minute-old sign-in are 403", async () => {
    const m = await v2Home();
    const t = await amrToken(OWNER_SUB, "owner@example.test", [{ method: "otp", ago: 300 }]);
    expect((await mintWith(t, { bind: BIND_A, kind: "browser" })).status).toBe(200);
    expect(await errorOf(await req("POST", "/v1/account/home/hold", t, { action: "pair" }))).toEqual([403, "step_up_required"]);
    expect(await errorOf(await req("POST", `/v1/account/homes/${HOME}/desktop-code`, t, {}))).toEqual([403, "step_up_required"]);
    expect(await errorOf(await req("POST", `/v1/homes/${HOME}/devices/dev-1/revoke`, t, {}))).toEqual([403, "step_up_required"]);
    expect(homeCalls.filter((c) => c.path.endsWith("/revoke"))).toEqual([]);
    void m;
  });

  // ---- devices (3.2) ----
  it("D1 devices list: the owner gets the home's devices without key material, through one HMAC call with operation = the path and a fresh nonce", async () => {
    const m = await v2Home();
    homeAnswer = () => Response.json({ devices: [
      { id: "dev-1", scope: "owner-desktop", addedAt: 1000, lastSeenAt: 2000, keyHash: "f".repeat(64) },
      { id: "dev-2", scope: "browser", addedAt: 3000, lastSeenAt: null, keyHash: "e".repeat(64), factor: "remembered-owner", factorExpiresAt: 5000 }] });
    const r = await req("GET", `/v1/homes/${HOME}/devices`, m.token);
    expect(r.status).toBe(200);
    const body = await r.json();
    // factor/factorExpiresAt pass through (null when the home omits them); key material never does.
    expect(body).toEqual({ devices: [{ id: "dev-1", scope: "owner-desktop", addedAt: 1000, lastSeenAt: 2000, factor: null, factorExpiresAt: null }, { id: "dev-2", scope: "browser", addedAt: 3000, lastSeenAt: null, factor: "remembered-owner", factorExpiresAt: 5000 }] });
    expect(JSON.stringify(body)).not.toContain("f".repeat(64));
    await req("GET", `/v1/homes/${HOME}/devices`, m.token);
    expect(homeCalls).toHaveLength(2);
    for (const c of homeCalls) {
      expect(c.path).toBe("/api/cloud/devices/list");
      expect(c.body).toMatchObject({ operation: "/api/cloud/devices/list", account: m.id, generation: 3 });
      expect(c.signature).toMatch(/^[0-9a-f]{64}$/);
      expect(c.origin).toBe(ORIGIN);
    }
    expect(homeCalls[0].body.nonce).not.toBe(homeCalls[1].body.nonce);
  });
  it("D1 devices list: another account 404, a v1 home 409 door_needs_update, an unreachable home 503 home_unreachable", async () => {
    const m = await v2Home();
    const other = await member(OTHER_SUB, "other@example.test");
    const r404 = await req("GET", `/v1/homes/${HOME}/devices`, other.token);
    expect([r404.status, await r404.json()]).toEqual([404, { error: "not_found" }]);
    expect(homeCalls).toEqual([]);
    deps.homeFetch = (async () => { throw new Error("down"); }) as typeof fetch;
    const r503 = await req("GET", `/v1/homes/${HOME}/devices`, m.token);
    expect([r503.status, await r503.json()]).toEqual([503, { error: "home_unreachable" }]);
    await setDoor(null);
    const r409 = await req("GET", `/v1/homes/${HOME}/devices`, m.token);
    expect([r409.status, await r409.json()]).toEqual([409, { error: "door_needs_update" }]);
  });
  it("D1 devices list: the 31st list in a minute is 429", async () => {
    const m = await v2Home();
    for (let i = 0; i < 30; i++) expect((await req("GET", `/v1/homes/${HOME}/devices`, m.token)).status).toBe(200);
    expect(await errorOf(await req("GET", `/v1/homes/${HOME}/devices`, m.token))).toEqual([429, "rate_limited"]);
  });
  it("D1 devices revoke: with a fresh second step, one HMAC call naming the device; unknown 404 device_not_found; one log line per outcome", async () => {
    const m = await v2Home();
    const log = vi.spyOn(console, "log");
    homeAnswer = (_p, b) => (b.deviceId === "dev-1" ? Response.json({ revoked: true }) : Response.json({ error: "not found" }, { status: 404 }));
    const ok = await req("POST", `/v1/homes/${HOME}/devices/dev-1/revoke`, m.token, {});
    expect([ok.status, await ok.json()]).toEqual([200, { revoked: true }]);
    expect(homeCalls).toEqual([expect.objectContaining({ path: "/api/cloud/devices/revoke",
      body: expect.objectContaining({ operation: "/api/cloud/devices/revoke", deviceId: "dev-1", account: m.id, generation: 3 }) })]);
    const missing = await req("POST", `/v1/homes/${HOME}/devices/dev-9/revoke`, m.token, {});
    expect([missing.status, await missing.json()]).toEqual([404, { error: "device_not_found" }]);
    expect(await errorOf(await req("POST", `/v1/homes/${HOME}/devices/dev-1/revoke`, m.token, { deviceId: "dev-1" }))).toEqual([400, "invalid_request"]);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("home device revoked")).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l.deviceId, l.outcome])).toEqual([["dev-1", "revoked"], ["dev-9", "device_not_found"]]);
    await setDoor(null);
    expect(await errorOf(await req("POST", `/v1/homes/${HOME}/devices/dev-1/revoke`, m.token, {}))).toEqual([409, "door_needs_update"]);
  });
  it("D1 devices revoke: the 11th revoke in a minute is 429", async () => {
    const m = await v2Home();
    homeAnswer = () => Response.json({ revoked: true });
    for (let i = 0; i < 10; i++) expect((await req("POST", `/v1/homes/${HOME}/devices/dev-${i}/revoke`, m.token, {})).status).toBe(200);
    expect(await errorOf(await req("POST", `/v1/homes/${HOME}/devices/dev-x/revoke`, m.token, {}))).toEqual([429, "rate_limited"]);
  });

  // ---- the desktop ticket and the pair hold (2.5.3, r4.1, r4.2) ----
  it("D1 r4.2 (a)+(d): a home that had a desktop and a completed hold: the desktop ticket carries pairHold, RESERVED (not spent) until expiry + skew", async () => {
    const m = await v2Home();
    await hadDesktop();
    await hold();
    const res = await mintWith(m.token, { bind: BIND_A, kind: "desktop" });
    expect(res.status).toBe(200);
    const { claims } = await ticketOf(res);
    expect(Object.keys(claims)).toEqual([...V2_KEYS, "pairHold"]);
    expect(claims).toMatchObject({ type: "murage-door-v2", kind: "desktop", bind: BIND_A, pairHold: HOLD });
    expect(await holdRow()).toEqual({ reserved_by: claims.nonce, reserved_until: (claims.expiresAt as number) + 30_000, spent_device_digest: null, spent_at: null });
    // A browser ticket never carries pairHold.
    const b = await ticketOf(await mintWith(m.token, { bind: BIND_B, kind: "browser" }));
    expect(b.claims.pairHold).toBeUndefined();
  });
  it("D1 r4.2 (d): lost the only computer (none active, the home says it had one): no hold is 409, with the hold it carries the claim", async () => {
    const m = await v2Home();
    homeAnswer = () => Response.json({ devices: [{ id: "b-1", scope: "browser", addedAt: 1 }], fullScopeEver: true });
    expect(await errorOf(await mintWith(m.token, { bind: BIND_A, kind: "desktop" }))).toEqual([409, "door_needs_hold"]);
    await hold();
    expect((await ticketOf(await mintWith(m.token, { bind: BIND_A, kind: "desktop" }))).claims.pairHold).toBe(HOLD);
  });
  it("D1 r4.2: the first full-scope device a home ever has needs no hold (no claim); an active desktop at the home needs one", async () => {
    const m = await v2Home();
    homeAnswer = () => Response.json({ devices: [{ id: "b-1", scope: "browser", addedAt: 1 }], fullScopeEver: false });
    const first = await ticketOf(await mintWith(m.token, { bind: BIND_A, kind: "desktop" }));
    expect(Object.keys(first.claims)).toEqual(V2_KEYS);
    homeAnswer = () => Response.json({ devices: [{ id: "d-1", scope: "owner-desktop", addedAt: 1 }] });
    expect(await errorOf(await mintWith(m.token, { bind: BIND_A, kind: "desktop" }))).toEqual([409, "door_needs_hold"]);
    deps.homeFetch = (async () => { throw new Error("down"); }) as typeof fetch;
    expect(await errorOf(await mintWith(m.token, { bind: BIND_A, kind: "desktop" }))).toEqual([503, "home_unreachable"]);
  });
  it("D1 r4.2 (b)+(c): no hold is 409 door_needs_hold with nothing else; a running hold adds completesAt; cancelled or another generation gives none", async () => {
    const m = await v2Home();
    await hadDesktop();
    const none = await mintWith(m.token, { bind: BIND_A, kind: "desktop" });
    expect([none.status, await none.json()]).toEqual([409, { error: "door_needs_hold" }]);
    const completesAt = Date.now() + 5 * ONE_HOUR;
    await hold({ completed_at: null, completes_at: completesAt });
    const running = await mintWith(m.token, { bind: BIND_A, kind: "desktop" });
    expect([running.status, await running.json()]).toEqual([409, { error: "door_needs_hold", completesAt }]);
    await env.DB.prepare("DELETE FROM cloud_recovery_holds").run();
    await hold({ canceled_at: Date.now() });
    expect(await errorOf(await mintWith(m.token, { bind: BIND_A, kind: "desktop" }))).toEqual([409, "door_needs_hold"]);
    await env.DB.prepare("DELETE FROM cloud_recovery_holds").run();
    await hold({ generation: 2 });
    expect(await errorOf(await mintWith(m.token, { bind: BIND_A, kind: "desktop" }))).toEqual([409, "door_needs_hold"]);
  });
  it("D1 r4.1: mint with no exchange: the hold is reserved, another key gets no claim until expiry + skew, then it is usable again", async () => {
    const m = await v2Home();
    await hadDesktop();
    await hold();
    const first = await ticketOf(await mintWith(m.token, { bind: BIND_A, kind: "desktop" }));
    expect(first.claims.pairHold).toBe(HOLD);
    expect((await holdRow())?.reserved_until).toBe((first.claims.expiresAt as number) + 30_000);
    expect(await errorOf(await mintWith(m.token, { bind: BIND_B, kind: "desktop" }))).toEqual([409, "door_needs_hold"]);
    // The ticket was never exchanged: at expiry + skew the reservation lapses (as if that time had come).
    await env.DB.prepare("UPDATE cloud_recovery_holds SET reserved_until=? WHERE id=?").bind(Date.now() + 60_000, HOLD).run();
    expect(await errorOf(await mintWith(m.token, { bind: BIND_B, kind: "desktop" }))).toEqual([409, "door_needs_hold"]);
    await env.DB.prepare("UPDATE cloud_recovery_holds SET reserved_until=? WHERE id=?").bind(Date.now() - 1, HOLD).run();
    const again = await ticketOf(await mintWith(m.token, { bind: BIND_B, kind: "desktop" }));
    expect(again.claims.pairHold).toBe(HOLD);
    expect((await holdRow())?.reserved_by).toBe(again.claims.nonce);
  });
  it("D1 r4.1: two racing mints for one hold: exactly one claim", async () => {
    const m = await v2Home();
    await hadDesktop();
    await hold();
    const results = await Promise.all([BIND_A, BIND_B].map((bind) => mintWith(m.token, { bind, kind: "desktop" })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const won = results.find((r) => r.status === 200)!;
    expect((await ticketOf(won)).claims.pairHold).toBe(HOLD);
    expect(await (results.find((r) => r.status === 409)!).json()).toEqual({ error: "door_needs_hold" });
  });
  it("D1 r4.1: mint then spend: the CP never spends at mint; a spend while reserved is refused; after the lapse the hold is spent exactly once", async () => {
    const m = await v2Home();
    await hadDesktop();
    await hold();
    const T = Date.now();
    const { claims } = await ticketOf(await mintWith(m.token, { bind: BIND_A, kind: "desktop" }));
    expect(await holdRow()).toMatchObject({ spent_device_digest: null, spent_at: null });
    expect(await spendPairHold(env.DB, HOLD, "digest-x", T)).toBe(false);
    expect(await selectPairHold(env.DB, HOME, "digest-x", T)).toBeNull();
    const lapsed = (claims.expiresAt as number) + 30_000;
    expect(await selectPairHold(env.DB, HOME, "digest-x", lapsed)).toMatchObject({ id: HOLD });
    expect(await spendPairHold(env.DB, HOLD, "digest-x", lapsed)).toBe(true);
    expect(await spendPairHold(env.DB, HOLD, "digest-y", lapsed)).toBe(false);
    expect(await holdRow()).toMatchObject({ spent_device_digest: "digest-x", spent_at: lapsed });
    // Spent: no door ticket can reserve it either.
    expect(await reservePairHold(env.DB, HOME, 3, BIND_B, "n2", lapsed + 90_000, lapsed + 1)).toBeNull();
  });

  // ---- D2: Astra D1 #1-#3 ----
  it("D2 Astra D1 #1: an issued but never redeemed pairing code is not a desktop: the first computer mints with no claim, a ready hold left alone", async () => {
    const m = await v2Home();
    await issuedCode();
    homeAnswer = () => Response.json({ devices: [{ id: "b-1", scope: "browser", addedAt: 1 }], fullScopeEver: false, consumedHoldIds: [] });
    const first = await mintWith(m.token, { bind: BIND_A, kind: "desktop" });
    expect(first.status).toBe(200);
    expect(Object.keys((await ticketOf(first)).claims)).toEqual(V2_KEYS);
    await hold();
    const again = await ticketOf(await mintWith(m.token, { bind: BIND_A, kind: "desktop" }));
    expect(again.claims.pairHold).toBeUndefined();
    expect(await holdRow()).toEqual({ reserved_by: null, reserved_until: null, spent_device_digest: null, spent_at: null });
  });
  it("D2 Astra D1 #2: enrolled then the last desktop revoked, the home says fullScopeEver: no hold is 409, a completed hold is reserved and claimed", async () => {
    const m = await v2Home();
    homeAnswer = () => Response.json({ devices: [], fullScopeEver: true });
    expect(await errorOf(await mintWith(m.token, { bind: BIND_A, kind: "desktop" }))).toEqual([409, "door_needs_hold"]);
    await hold();
    const t = await ticketOf(await mintWith(m.token, { bind: BIND_A, kind: "desktop" }));
    expect(t.claims.pairHold).toBe(HOLD);
    expect((await holdRow())?.reserved_by).toBe(t.claims.nonce);
  });
  it("D2 Astra D1 #2: an older home omits fullScopeEver: history unknown, never 'never enrolled': a ready hold is reserved and claimed; none mints claimless, never 409", async () => {
    const m = await v2Home();
    await issuedCode();
    homeAnswer = () => Response.json({ devices: [] });
    // No hold: not imposed on unknown history alone; minted as before, the home's exchange decides.
    const none = await mintWith(m.token, { bind: BIND_A, kind: "desktop" });
    expect(none.status).toBe(200);
    expect(Object.keys((await ticketOf(none)).claims)).toEqual(V2_KEYS);
    // A ready hold: never claimless.
    await hold();
    const withHold = await ticketOf(await mintWith(m.token, { bind: BIND_A, kind: "desktop" }));
    expect(withHold.claims.pairHold).toBe(HOLD);
    expect(await holdRow()).toMatchObject({ reserved_by: withHold.claims.nonce, spent_device_digest: null });
    // Held by that ticket: another key gets no claim and no 409 (the home decides).
    const other = await mintWith(m.token, { bind: BIND_B, kind: "desktop" });
    expect(other.status).toBe(200);
    expect((await ticketOf(other)).claims.pairHold).toBeUndefined();
  });
  it("D2 Astra D1 #3 consumedHoldIds present: a hold the home consumed is marked spent, never listed ready nor reserved again, also after its reservation lapses", async () => {
    const m = await v2Home();
    await hadDesktop();
    await hold();
    const t = await ticketOf(await mintWith(m.token, { bind: BIND_A, kind: "desktop" }));
    expect(t.claims.pairHold).toBe(HOLD);
    // The home spends H at exchange; its next devices/list reports it.
    homeAnswer = () => Response.json({ devices: [{ id: "d-1", scope: "owner-desktop", addedAt: 1 }], fullScopeEver: true, consumedHoldIds: [HOLD] });
    expect((await req("GET", `/v1/homes/${HOME}/devices`, m.token)).status).toBe(200);
    expect(await holdRow()).toMatchObject({ reserved_by: null, reserved_until: null, spent_device_digest: "home-consumed" });
    const T = Date.now() + 120_000; // past the 90 s reservation
    expect(await readyPairHolds(env.DB, HOME, T)).toEqual([]);
    expect(await selectPairHold(env.DB, HOME, BIND_B, T)).toBeNull();
    expect(await reservePairHold(env.DB, HOME, 3, BIND_B, "n2", T + 90_000, T)).toBeNull();
    expect(await errorOf(await mintWith(m.token, { bind: BIND_B, kind: "desktop" }))).toEqual([409, "door_needs_hold"]);
  });
  it("D2 Astra D1 #3 consumedHoldIds present at mint: reconciled before the reservation, so the consumed hold is not reserved for another key", async () => {
    const m = await v2Home();
    await hold();
    homeAnswer = () => Response.json({ devices: [], fullScopeEver: true, consumedHoldIds: ["older-hold", HOLD] });
    expect(await errorOf(await mintWith(m.token, { bind: BIND_B, kind: "desktop" }))).toEqual([409, "door_needs_hold"]);
    expect(await holdRow()).toMatchObject({ reserved_by: null, spent_device_digest: "home-consumed" });
  });
  it("D3 Astra D1 #3: the reconcile UPDATE fails: the hold the home reported consumed is still never reserved for another key", async () => {
    const m = await v2Home();
    await hold();
    homeAnswer = () => Response.json({ devices: [], fullScopeEver: true, consumedHoldIds: [HOLD] });
    let failed = 0;
    const DB = new Proxy(env.DB, { get(t, p) {
      if (p === "prepare") return (sql: string) => sql.includes("SET spent_device_digest=COALESCE")
        ? { bind: () => ({ run: async () => { failed++; throw new Error("D1_ERROR: injected"); } }) } : t.prepare(sql);
      const v = Reflect.get(t, p); return typeof v === "function" ? v.bind(t) : v;
    } });
    const res = await mintWith(m.token, { bind: BIND_B, kind: "desktop" }, { DB } as unknown as Record<string, string>);
    expect(failed).toBe(1);
    expect(await errorOf(res)).toEqual([409, "door_needs_hold"]);
    expect(await holdRow()).toEqual({ reserved_by: null, reserved_until: null, spent_device_digest: null, spent_at: null });
  });
  it("D2 Astra D1 #3 consumedHoldIds absent: consumption unknown, nothing inferred: the hold stays ready and reservable", async () => {
    const m = await v2Home();
    await hold();
    homeAnswer = () => Response.json({ devices: [{ id: "d-1", scope: "owner-desktop", addedAt: 1 }], fullScopeEver: true });
    expect((await req("GET", `/v1/homes/${HOME}/devices`, m.token)).status).toBe(200);
    expect(await holdRow()).toEqual({ reserved_by: null, reserved_until: null, spent_device_digest: null, spent_at: null });
    expect(await readyPairHolds(env.DB, HOME, Date.now())).toEqual([expect.objectContaining({ holdId: HOLD, state: "ready" })]);
    expect((await ticketOf(await mintWith(m.token, { bind: BIND_A, kind: "desktop" }))).claims.pairHold).toBe(HOLD);
  });
  it("D2 Astra D1 #3 a consumed id the CP does not know (or another home's) changes nothing; the list still answers", async () => {
    const m = await v2Home();
    await hold();
    await hold({ id: "hold-other-home-0001", home_id: "other-home" });
    homeAnswer = () => Response.json({ devices: [], fullScopeEver: true, consumedHoldIds: ["hold-never-issued-01", "hold-other-home-0001"] });
    const r = await req("GET", `/v1/homes/${HOME}/devices`, m.token);
    expect([r.status, await r.json()]).toEqual([200, { devices: [] }]);
    const rows = await env.DB.prepare("SELECT id,spent_device_digest,spent_at FROM cloud_recovery_holds ORDER BY id").all();
    expect(rows.results).toEqual([
      { id: HOLD, spent_device_digest: null, spent_at: null },
      { id: "hold-other-home-0001", spent_device_digest: null, spent_at: null },
    ]);
    expect((await ticketOf(await mintWith(m.token, { bind: BIND_A, kind: "desktop" }))).claims.pairHold).toBe(HOLD);
  });

  // ---- notices (4B) ----
  it("D1 notices: two sessions, two emails; the same session and bind twice, one; a second bind, a second", async () => {
    const m = await v2Home();
    const t1 = await token(OWNER_SUB, "owner@example.test", 10, { sessionId: "sess-1" });
    const t2 = await token(OWNER_SUB, "owner@example.test", 10, { sessionId: "sess-2" });
    expect((await mintWith(t1, { bind: BIND_A, kind: "browser" })).status).toBe(200); await settle();
    expect((await mintWith(t2, { bind: BIND_A, kind: "browser" })).status).toBe(200); await settle();
    expect(sent).toHaveLength(2);
    expect((await mintWith(t1, { bind: BIND_A, kind: "browser" })).status).toBe(200); await settle();
    expect(sent).toHaveLength(2);
    expect((await mintWith(t1, { bind: BIND_B, kind: "browser" })).status).toBe(200); await settle();
    expect(sent).toHaveLength(3);
    expect(sent.every((s) => s.subject === DOOR_NOTICE_SUBJECT)).toBe(true);
    expect((await notices()).map((n) => [n.session_id, n.bind])).toEqual([["sess-1", BIND_A], ["sess-2", BIND_A], ["sess-1", BIND_B]]);
    void m;
  });
  it("D1 notices: the row is armed before the hand-out answer", async () => {
    const m = await v2Home();
    expect(await errorOf(await mintWith(m.token, {}))).toEqual([400, "door_body_required"]); // refused before the hand-out: nothing armed
    expect(await notices()).toEqual([]);
    const ok = await mintWith(m.token, { bind: BIND_A, kind: "browser" });
    expect(ok.status).toBe(200);
    expect((await notices())[0]).toMatchObject({ bind: BIND_A, armed: 1 });
  });
  it("D1 notices: five binds in one hour: exactly three emails and three slots; the rest released to the next hour, then ONE email for them", async () => {
    const m = await v2Home();
    // Five mints inside one clock hour (never across its end).
    const left = ONE_HOUR - (Date.now() % ONE_HOUR);
    if (left < 20_000) await new Promise((r) => setTimeout(r, left + 100));
    const H = Math.floor(Date.now() / ONE_HOUR);
    const T = Date.now();
    const t = await token(OWNER_SUB, "owner@example.test", 10, { sessionId: "sess-1" });
    for (let i = 1; i <= 5; i++) { expect((await mintWith(t, { bind: bindN(i), kind: "browser" })).status).toBe(200); await settle(); }
    expect(sent).toHaveLength(3);
    expect(await slots()).toEqual([{ hour: H, n: 1 }, { hour: H, n: 2 }, { hour: H, n: 3 }]);
    const rest = (await notices()).filter((n) => n.sent_at === null);
    expect(rest.map((n) => [n.bind, n.next_attempt_at])).toEqual([[bindN(4), (H + 1) * ONE_HOUR], [bindN(5), (H + 1) * ONE_HOUR]]);
    // Within the hour nothing more is sent.
    expect(await sweepDoorNotices(testEnv(), T + 60_000, { reader, emailSender: deps.emailSender })).toBe(0);
    expect(await sweepDoorNotices(testEnv(), (H + 1) * ONE_HOUR + 1, { reader, emailSender: deps.emailSender })).toBe(1);
    expect(sent).toHaveLength(4);
    expect(sent[3].text).toContain("And 1 more new sign-in since the last notice.");
    expect((await notices()).every((n) => n.sent_at !== null)).toBe(true);
  });
  it("D1 notices: two concurrent sweeps over the same rows send one email; a failed send keeps its slot spent", async () => {
    const m = await v2Home();
    const now = Date.now();
    const arm = (session: string) => env.DB.prepare(`INSERT INTO cloud_door_notices (account_id,home_id,session_id,bind,created_at,next_attempt_at,armed,handouts,armed_by,delivered)
      VALUES (?,?,?,?,?,?,1,1,1,1)`).bind(m.id, HOME, session, BIND_A, now, now).run();
    await arm("s-1"); await arm("s-2");
    const sweepDeps = { reader, emailSender: deps.emailSender };
    const [a, b] = await Promise.all([sweepDoorNotices(testEnv(), now + 1, sweepDeps), sweepDoorNotices(testEnv(), now + 1, sweepDeps)]);
    expect(a + b).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("And 1 more");
    await arm("s-3");
    const failing = { reader, emailSender: () => ({ async send() { throw new Error("down"); } }) };
    expect(await sweepDoorNotices(testEnv(), now + 2, failing)).toBe(0);
    expect((await slots()).length).toBe(2);
    expect((await notices()).find((n) => n.session_id === "s-3")).toMatchObject({ attempts: 1, sent_at: null });
  });
  it("D1 notices: a legacy armed row from before 0107 (session '', bind '') is claimed and sent once", async () => {
    const m = await v2Home();
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO cloud_door_notices (account_id,home_id,session_id,bind,created_at,next_attempt_at,armed,handouts,armed_by,delivered)
      VALUES (?,?,'','',?,?,1,1,1,1)`).bind(m.id, HOME, now - 1000, now - 1000).run();
    const sweepDeps = { reader, emailSender: deps.emailSender };
    expect(await sweepDoorNotices(testEnv(), now, sweepDeps)).toBe(1);
    expect(await sweepDoorNotices(testEnv(), now + ONE_HOUR * 2, sweepDeps)).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe(DOOR_NOTICE_SUBJECT);
  });
});
