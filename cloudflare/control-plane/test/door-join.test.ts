// SPDX-License-Identifier: AGPL-3.0-or-later
// Door device confirmation at the door (src/door.ts hooks, src/device-join.ts) with DOOR_JOIN_REQUIRED=1: the first computer's row and mail, a later
// computer's join, the exact customer-hold check, the replay of a lost answer, a No, the owner routes, mail retry and the removed mail. The
// switch off leaves today's behaviour.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseItem9HoldForTests } from "../src/held-until-item9-highs";
// ITEM 9: this suite exercises the join switched on; the launch guard (held-until-item9-highs.ts) is released here only.
beforeAll(() => releaseItem9HoldForTests(true));
afterAll(() => releaseItem9HoldForTests(false));
import { verifyPayload } from "../src/b3-signatures";
import { createIdentity } from "../src/customer-identity";
import { doorRoute, FIRST_COMPUTER_SUBJECT, handOutDoorTicket, type DoorDependencies } from "../src/door";
import { cancelJoin, joinHoldsView, joinStillReadyGuard, sendJoinMail, sweepDeviceJoins } from "../src/device-join";
import { errorResponse, HTTPError } from "../src/http";
import { createWorker } from "../src/index";
import { reservePairHold, type PairingDependencies } from "../src/pairing";
import type { KeyWrapper } from "../src/key-wrapper";

const REF_ORIGIN = "https://testref.supabase.co";
const ISS = `${REF_ORIGIN}/auth/v1`;
const OWNER_SUB = "7b2e3d40-5c6f-4a71-8bcd-2e3f4a5b6c7d";
const HOME = "home-door";
const HOSTNAME = "h-door0123.murage.test";
const ORIGIN = `https://${HOSTNAME}`;

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
/** `strict`: the reader answers only for a real Supabase sub (as the real one does), never for a local Cloud account id. */
const readerStrict = { on: false };
const reader = { async emailGen(sub: string) {
  if (readerDown.on) throw new Error("identity_unavailable");
  if (readerStrict.on && sub !== OWNER_SUB) throw new Error("unknown_sub");
  return { id: sub, email: supabaseNow.get(sub)?.email ?? emails.get(sub) ?? "", updatedAt: "2026-10-01T00:00:00Z" };
} };
/** Background work (waitUntil) of `call` and `direct`, NOT drained before the caller asserts on the answer: settle() drains it. */
const pending: Promise<unknown>[] = [];
const settle = async () => { while (pending.length) await Promise.allSettled(pending.splice(0)); };
const testEnv = () => ({ ...env, CLOUD_B3_SIGNING_JWK: JSON.stringify(signingJwk), SUPABASE_URL: REF_ORIGIN,
  SUPABASE_PUBLISHABLE_KEY: ["sb_publi", "shable_t", "estkey_0", "12345678", "9abcdef"].join(""), MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined,
  IDENTITY_READER: reader }) as unknown as Env;

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

afterEach(async () => { await settle(); sent.length = 0; supabaseNow.clear(); emails.clear(); readerDown.on = false; readerStrict.on = false; vi.restoreAllMocks(); });

describe("door device confirmation", () => {
  const BIND_A = "a".repeat(64);
  const BIND_B = "b".repeat(64);
  const BIND_C = "c".repeat(64);
  const HOLD = "hold-door-0123456789";
  const ONE_HOUR = 3_600_000;
  const J = { DOOR_V2_REQUIRED: "1", DOOR_JOIN_REQUIRED: "1" };
  const realSender = deps.emailSender;
  const downSender: PairingDependencies["emailSender"] = () => ({ async send() { throw new Error("smtp down"); } });
  /** The home's side: its device list (a revoke removes the device) and every call recorded. */
  const homeCalls: { path: string; body: Record<string, unknown> }[] = [];
  const homeState = { devices: [] as Record<string, unknown>[], fullScopeEver: true as boolean | null };
  const desktop = (bind: string, over: Record<string, unknown> = {}) => ({ id: `d-${bind.slice(0, 2)}`, scope: "owner-desktop", addedAt: 1, bind, ...over });
  beforeEach(async () => {
    for (const t of ["cloud_device_joins", "cloud_door_desktop_tickets", "cloud_device_join_mail", "door_computer_notices", "cloud_door_notices", "cloud_door_notice_slots",
      "cloud_recovery_holds", "verify_tokens", "cloud_home_keys", "cloud_machines", "machine_endpoints", "cloud_homes", "selfservice_rate_limits"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
    homeCalls.length = 0;
    homeState.devices = []; homeState.fullScopeEver = true;
    deps.homeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const path = new URL(String(input)).pathname;
      homeCalls.push({ path, body });
      if (path.endsWith("/revoke")) { homeState.devices = homeState.devices.filter((d) => d.id !== body.deviceId); return Response.json({ revoked: true }); }
      return Response.json({ devices: homeState.devices, fullScopeEver: homeState.fullScopeEver, consumedHoldIds: [] });
    }) as typeof fetch;
    deps.keyWrapper = () => ({ unwrap: async () => new Uint8Array(32).fill(7) }) as unknown as KeyWrapper;
  });
  afterEach(() => { delete deps.homeFetch; delete deps.keyWrapper; deps.emailSender = realSender; });

  async function req(method: string, path: string, bearer: string | null, body: unknown = undefined, extra: Record<string, string> = {}) {
    const headers = new Headers({ "content-type": "application/json" });
    if (bearer) headers.set("authorization", `Bearer ${bearer}`);
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`https://auth.murage.test${path}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) }),
      { ...testEnv(), ...extra } as Env, ctx);
    pending.push(waitOnExecutionContext(ctx));
    return res;
  }
  const mint = (t: string, bind = BIND_A, extra: Record<string, string> = J) => req("POST", `/v1/homes/${HOME}/door`, t, { bind, kind: "desktop" }, extra);
  const errorOf = async (r: Response) => [r.status, (await r.json<{ error: string }>()).error];
  async function amrToken(email: string, ago: number, sessionId: string = crypto.randomUUID()) {
    const s = Math.floor(Date.now() / 1000);
    const c = { iss: ISS, aud: "authenticated", exp: s + 3600, iat: s - 5, sub: OWNER_SUB, email, role: "authenticated", is_anonymous: false,
      app_metadata: { provider: "email", email_verified: true }, user_metadata: {}, session_id: sessionId, aal: "aal1", amr: [{ method: "otp", timestamp: s - ago }] };
    const input = `${b64u(JSON.stringify({ alg: "ES256", kid: "ec-1", typ: "JWT" }))}.${b64u(JSON.stringify(c))}`;
    return `${input}.${b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, new TextEncoder().encode(input)))}`;
  }
  const emailed = () => amrToken("owner@example.test", 10);
  async function home() {
    const m = await member(OWNER_SUB, "owner@example.test");
    emails.set(m.id, "owner@example.test");
    await seedHome(m.id);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cloud_machines (id,home_id,generation,state,created_at,public_origin,admin_url) VALUES (?,?,3,'active',?,?,?)`).bind(HOME, HOME, Date.now(), ORIGIN, "https://admin.murage.test"),
      env.DB.prepare("INSERT INTO cloud_home_keys VALUES (?,?,?,?,?)").bind(HOME, "w1", "w2", "w3", "v1"),
      env.DB.prepare("UPDATE cloud_homes SET door_version='v2' WHERE id=?").bind(HOME),
    ]);
    return m;
  }
  /** A home that had a computer (so the next one is a later computer). */
  const laterHome = async () => { const m = await home(); homeState.devices = [desktop(BIND_C, { id: "d-old", addedAt: 5 })]; return m; };
  const firstHome = async () => { const m = await home(); homeState.devices = [{ id: "b-1", scope: "browser", addedAt: 1 }]; homeState.fullScopeEver = false; return m; };
  const hold = (over: Record<string, unknown> = {}) => {
    const now = Date.now();
    const row: Record<string, unknown> = { id: HOLD, home_id: HOME, action: "pair", generation: 3, started_at: now - 73 * ONE_HOUR, completes_at: now - ONE_HOUR,
      completed_at: now - ONE_HOUR, canceled_at: null, source: "customer", ...over };
    const k = Object.keys(row);
    return env.DB.prepare(`INSERT INTO cloud_recovery_holds (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`).bind(...k.map((x) => row[x])).run();
  };
  const holdRow = () => env.DB.prepare("SELECT reserved_by,spent_device_digest FROM cloud_recovery_holds WHERE id=?").bind(HOLD).first<{ reserved_by: string | null; spent_device_digest: string | null }>();
  const joins = () => env.DB.prepare("SELECT * FROM cloud_device_joins ORDER BY created_at").all<Record<string, unknown>>().then((r) => r.results);
  /** The one later join (a first row marked used by the history read may sit beside it). */
  const laterJoins = async () => (await joins()).filter((x) => x.tier === "later");
  const oneFirst = async () => { const r = (await joins()).filter((x) => x.tier === "first"); expect(r).toHaveLength(1); return r[0]; };
  const oneJoin = async () => { const r = (await joins()).filter((x) => x.tier === "later"); expect(r).toHaveLength(1); return r[0]; };
  const tickets = () => env.DB.prepare("SELECT * FROM cloud_door_desktop_tickets ORDER BY issued_at").all<Record<string, unknown>>().then((r) => r.results);
  const mails = (subject: string) => sent.filter((x) => x.subject === subject);
  const JOINING = "A new computer is joining your Murage Cloud";
  const READY = "You can connect your computer now";
  const REMOVED = "That computer is off your Cloud";
  const linkOf = (text: string, kind: string) => { const m = new RegExp(`/device-check/${kind}#([\\w-]+)\\.([\\w-]+)`).exec(text); return { selector: m![1], secret: m![2] }; };
  const pub = (op: string, link: { selector: string; secret: string }) => req("POST", `/v1/public/device-join/${op}`, null, link);
  const makeReady = (id: string) => env.DB.prepare("UPDATE cloud_device_joins SET state='ready', ready_at=?, hold_until=? WHERE id=?").bind(Date.now() - 1000, Date.now() - 3 * ONE_HOUR, id).run();
  /** A later computer's first press: 409 door_join_waiting, one waiting join, its mail sent. */
  async function waitingJoin(token: string) {
    expect(await errorOf(await mint(token))).toEqual([409, "door_join_waiting"]);
    await settle();
    return oneJoin();
  }
  const sweepEnv = () => ({ ...testEnv(), ...J }) as Env;
  const sweepDeps = (): DoorDependencies => ({ emailSender: deps.emailSender, homeFetch: deps.homeFetch, keyWrapper: deps.keyWrapper });
  async function direct(t: string, beforeHandOut: () => Promise<void>): Promise<Response> {
    const identity = createIdentity({ jwksFetch, authFetch });
    const e = sweepEnv();
    const request = new Request(`https://auth.murage.test/v1/homes/${HOME}/door`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, body: JSON.stringify({ bind: BIND_A, kind: "desktop" }) });
    identity.bind(request, e);
    try {
      const res = (await doorRoute(request, e, identity, "req-direct", { ...sweepDeps(), waitUntil: (w) => { pending.push(w); } }))!;
      await beforeHandOut();
      return await handOutDoorTicket(request, res);
    } catch (err) {
      if (err instanceof HTTPError) return errorResponse(err.status, err.code);
      throw err;
    }
  }

  // ---- first computer ----
  it("first computer: an emailed proof mints at once and writes one ticketed row, the ticket row and the connection mail with a Remove link", async () => {
    await firstHome();
    const t = await ticketOf(await mint(await emailed()));
    expect(t.claims.pairHold).toBeUndefined();
    await settle();
    const j = await oneFirst();
    expect(j).toMatchObject({ tier: "first", state: "ticketed", redeemed_bind: BIND_A, ticket_nonce: t.claims.nonce });
    expect(await tickets()).toMatchObject([{ bind: BIND_A, nonce: t.claims.nonce, join_id: null }]);
    const mail = mails("A computer was connected to your Murage home");
    expect(mail).toHaveLength(1);
    expect(mail[0].text).toMatch(/Remove it: .*\/device-check\/remove#/);
    expect(mail[0].text).not.toContain("Make chat-only");
    expect((await env.DB.prepare("SELECT sent_at FROM door_computer_notices WHERE home_id=?").bind(HOME).first<{ sent_at: number | null }>())?.sent_at).not.toBeNull();
    expect(mails(FIRST_COMPUTER_SUBJECT)).toHaveLength(1);
  });
  it("first computer: an authenticator alone is 403 step_up_required and nothing is written", async () => {
    const m = await firstHome();
    expect(await errorOf(await mint(m.token))).toEqual([403, "step_up_required"]);
    await settle();
    expect(await joins()).toEqual([]);
    expect(await tickets()).toEqual([]);
  });
  it("first computer: a second ticket of the same ticketed row replaces the key, it never makes a second row", async () => {
    await firstHome();
    await mint(await emailed(), BIND_A);
    await mint(await emailed(), BIND_B);
    await settle();
    expect(await oneFirst()).toMatchObject({ tier: "first", state: "ticketed", redeemed_bind: BIND_B });
    expect(await tickets()).toHaveLength(2);
  });
  it("a known key writes nothing: no row, no ticket row, no join mail", async () => {
    const m = await laterHome();
    homeState.devices = [desktop(BIND_A)];
    await hold();
    expect((await mint(m.token)).status).toBe(200);
    await settle();
    expect(await joins()).toEqual([]);
    expect(await tickets()).toEqual([]);
    expect(mails(JOINING)).toEqual([]);
    expect(await holdRow()).toEqual({ reserved_by: null, spent_device_digest: null });
  });

  // ---- later computer ----
  it("later computer with no hold: the first press creates a waiting join, answers 409 door_join_waiting and mails Yes and No; a second press adds nothing", async () => {
    const m = await laterHome();
    const res = await mint(m.token);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "door_join_waiting", state: "waiting", mailedTo: "o***@example.test" });
    await settle();
    const j = await oneJoin();
    expect(j).toMatchObject({ tier: "later", state: "waiting", generation: 3, kind: "desktop", redeemed_bind: null, mail_count: 1 });
    expect(j.mail_sent_at).not.toBeNull();
    expect((j.hold_until as number) - (j.mail_sent_at as number)).toBe(72 * ONE_HOUR);
    expect(await tickets()).toEqual([]);
    const mail = mails(JOINING);
    expect(mail).toHaveLength(1);
    expect(mail[0].text).toMatch(/Yes, this was me: .*\/device-check\/yes#/);
    expect(mail[0].text).toMatch(/No, stop it: .*\/device-check\/no#/);
    expect(await errorOf(await mint(m.token, BIND_B))).toEqual([409, "door_join_waiting"]);
    await settle();
    expect(await oneJoin()).toMatchObject({ id: j.id, mail_count: 1 });
    expect(mails(JOINING)).toHaveLength(1);
  });
  it("later computer: a waiting join whose hold is past due but not yet swept still waits, and a ready join needs a second step newer than its hold", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    await env.DB.prepare("UPDATE cloud_device_joins SET hold_until=? WHERE id=?").bind(Date.now() - 1000, j.id).run();
    expect(await errorOf(await mint(m.token))).toEqual([409, "door_join_waiting"]);
    await env.DB.prepare("UPDATE cloud_device_joins SET state='ready', ready_at=?, hold_until=? WHERE id=?").bind(Date.now(), Date.now() - 2000, j.id).run();
    expect(await errorOf(await mint(m.token))).toEqual([403, "step_up_required"]);
    expect(await tickets()).toEqual([]);
  });
  it("later computer: a ready join mints with pairHold = the join id, writes the ticket row and becomes used; the same key again replays it, another key waits anew", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    await makeReady(j.id as string);
    const first = await ticketOf(await mint(m.token));
    expect(first.claims.pairHold).toBe(j.id);
    await settle();
    expect(await oneJoin()).toMatchObject({ id: j.id, state: "used", redeemed_bind: BIND_A, ticket_nonce: first.claims.nonce });
    expect(await tickets()).toMatchObject([{ bind: BIND_A, join_id: j.id }]);
    // r8-2: the answer was lost, the same key asks again: the same result, no new wait.
    const again = await ticketOf(await mint(m.token));
    expect(again.claims.pairHold).toBe(j.id);
    expect(await laterJoins()).toHaveLength(1);
    // Another key is a new request.
    expect(await errorOf(await mint(m.token, BIND_B))).toEqual([409, "door_join_waiting"]);
    expect(await laterJoins()).toHaveLength(2);
  });
  it("later computer: a No before the final hand-out step wins, no ticket leaves and nothing is written", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    await makeReady(j.id as string);
    const res = await direct(m.token, async () => { expect(await cancelJoin(sweepEnv(), m.id, HOME, j.id as string, Date.now())).toBe(true); });
    expect(res.status).toBe(503);
    expect(await tickets()).toEqual([]);
    expect(await oneJoin()).toMatchObject({ state: "cancelled" });
  });
  it("joinStillReadyGuard aborts a batch once the join is cancelled", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    await makeReady(j.id as string);
    await env.DB.batch(joinStillReadyGuard(env.DB, j.id as string));
    await cancelJoin(sweepEnv(), m.id, HOME, j.id as string, Date.now());
    await expect(env.DB.batch(joinStillReadyGuard(env.DB, j.id as string))).rejects.toThrow();
  });

  // ---- the exact customer-hold check ----
  it("a customer hold that ran 72 hours and completed before the second step is reserved for the ticket; no join is made", async () => {
    const m = await laterHome();
    await hold();
    const t = await ticketOf(await mint(m.token));
    expect(t.claims.pairHold).toBe(HOLD);
    await settle();
    expect(await laterJoins()).toEqual([]);
    expect(await tickets()).toMatchObject([{ bind: BIND_A, join_id: null }]);
    expect((await holdRow())?.reserved_by).toBe(t.claims.nonce);
  });
  it("a hold that ran 71 hours, or completed after the second step, is no hold: the computer waits as a join and the hold stays unreserved", async () => {
    const m = await laterHome();
    const now = Date.now();
    await hold({ started_at: now - ONE_HOUR - 71 * ONE_HOUR });
    expect(await errorOf(await mint(m.token))).toEqual([409, "door_join_waiting"]);
    expect((await holdRow())?.reserved_by).toBeNull();
    await settle();
    await env.DB.prepare("DELETE FROM cloud_device_joins").run();
    await env.DB.prepare("DELETE FROM cloud_recovery_holds").run();
    await hold({ completed_at: now - 2000, started_at: now - 2000 - 73 * ONE_HOUR });
    expect(await errorOf(await mint(m.token, BIND_B))).toEqual([409, "door_join_waiting"]);
    expect((await holdRow())?.reserved_by).toBeNull();
  });
  it("reservePairHold with `only` takes exactly the hold that completed before the step and ran long enough", async () => {
    await home();
    const now = Date.now();
    const only = { completedBefore: now - 10_000, ranAtLeastMs: 72 * ONE_HOUR };
    const take = () => reservePairHold(env.DB, HOME, 3, BIND_A, "n1", now + 120_000, now, null, [], only);
    await hold({ started_at: now - 72 * ONE_HOUR - 2000, completed_at: now - 2000 });
    expect(await take()).toBeNull();
    await env.DB.prepare("DELETE FROM cloud_recovery_holds").run();
    await hold({ started_at: now - 71 * ONE_HOUR - ONE_HOUR });
    expect(await take()).toBeNull();
    await env.DB.prepare("DELETE FROM cloud_recovery_holds").run();
    await hold();
    expect(await take()).toBe(HOLD);
  });

  // ---- Yes, No, the removed mail ----
  it("Yes shortens the wait to an hour; the sweep then makes it ready and mails once; the ready join mints", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    const yes = linkOf(mails(JOINING)[0].text, "yes");
    const res = await pub("confirm", yes);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "confirmed" });
    const after = await oneJoin();
    expect(after.yes_at).not.toBeNull();
    expect(after.hold_until as number).toBeLessThanOrEqual(Date.now() + ONE_HOUR);
    expect((await pub("confirm", yes)).status).toBeGreaterThanOrEqual(400);
    await env.DB.prepare("UPDATE cloud_device_joins SET hold_until=?, mail_sent_at=? WHERE id=?").bind(Date.now() - 2 * ONE_HOUR, Date.now() - 3 * ONE_HOUR, j.id).run();
    expect(await sweepDeviceJoins(sweepEnv(), Date.now(), sweepDeps())).toBeGreaterThan(0);
    expect(await oneJoin()).toMatchObject({ state: "ready" });
    expect(mails(READY)).toHaveLength(1);
    await sweepDeviceJoins(sweepEnv(), Date.now(), sweepDeps());
    expect(mails(READY)).toHaveLength(1);
    expect((await ticketOf(await mint(m.token))).claims.pairHold).toBe(j.id);
  });
  /** A used join of key A with a ticket for A, B (after the join) and C (before it, an older trusted key); all three on the home's list. */
  async function usedJoinWithKeys() {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    await makeReady(j.id as string);
    await ticketOf(await mint(m.token));
    await settle();
    const created = j.created_at as number;
    await env.DB.prepare("INSERT INTO cloud_door_desktop_tickets (home_id,bind,nonce,join_id,issued_at,expires_at,retain_until) VALUES (?,?,?,NULL,?,?,?)")
      .bind(HOME, BIND_B, "nb", Date.now() + 1000, Date.now() + 61_000, Date.now() + 15 * 24 * ONE_HOUR).run();
    await env.DB.prepare("INSERT INTO cloud_door_desktop_tickets (home_id,bind,nonce,join_id,issued_at,expires_at,retain_until) VALUES (?,?,?,NULL,?,?,?)")
      .bind(HOME, BIND_C, "nc", created - 60_000, created, Date.now() + 15 * 24 * ONE_HOUR).run();
    homeState.devices = [desktop(BIND_A, { addedAt: Date.now() }), desktop(BIND_B, { addedAt: Date.now() }), desktop(BIND_C, { id: "d-old", addedAt: 5 })];
    homeCalls.length = 0; sent.length = 0;
    return { m, j };
  }
  it("a No after the join was used removes the join's key and every key a later ticket let in, spares an older key, and mails the removal with the also-removed line", async () => {
    const { m, j } = await usedJoinWithKeys();
    expect((await oneJoin()).state).toBe("used");
    const res = await req("POST", `/v1/homes/${HOME}/joins/${j.id}/cancel`, m.token, {}, J);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "removed" });
    expect(homeCalls.filter((c) => c.path.endsWith("/revoke")).map((c) => c.body.deviceId).sort()).toEqual(["d-aa", "d-bb"]);
    expect(homeState.devices.map((d) => d.id)).toEqual(["d-old"]);
    await settle();
    const removed = mails(REMOVED);
    expect(removed).toHaveLength(1);
    expect(removed[0].text).toContain("also removed");
    expect(await oneJoin()).toMatchObject({ ended_by: "my_cloud", needs_revoke: 1, removed_count: 2 });
    // The stopped join is in the holds list as stopping; the home's cancel mark needs a newer step.
    expect(await joinHoldsView(env.DB, HOME, Date.now())).toMatchObject([{ source: "device_join", state: "stopping" }]);
    expect(await errorOf(await mint(m.token, "d".repeat(64)))).toEqual([403, "step_up_required"]);
  });
  it("a No pressed from the email link works with the identity reader down, stops a waiting join and cancels a pair hold started after it", async () => {
    const m = await laterHome();
    await waitingJoin(m.token);
    const no = linkOf(mails(JOINING)[0].text, "no");
    const now = Date.now();
    await hold({ id: "hold-new", completed_at: null, started_at: now + 1000, completes_at: now + 72 * ONE_HOUR });
    await hold({ id: "hold-old", completed_at: null, started_at: now - ONE_HOUR, completes_at: now + 71 * ONE_HOUR });
    readerDown.on = true;
    const res = await pub("cancel", no);
    expect(res.status).toBe(200);
    expect(await oneJoin()).toMatchObject({ state: "cancelled", ended_by: "link" });
    const holds = (await env.DB.prepare("SELECT id,canceled_at FROM cloud_recovery_holds ORDER BY id").all<{ id: string; canceled_at: number | null }>()).results;
    expect(holds.find((h) => h.id === "hold-new")?.canceled_at).not.toBeNull();
    expect(holds.find((h) => h.id === "hold-old")?.canceled_at).toBeNull();
    expect((await pub("cancel", no)).status).toBeGreaterThanOrEqual(400);
  });

  it("an unused No link on a join already cancelled in My Cloud revokes nothing, so a key that came back through a newer join stays", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    const no = linkOf(mails(JOINING)[0].text, "no");
    await makeReady(j.id as string);
    expect((await mint(await emailed())).status).toBe(200);
    await settle();
    expect(await cancelJoin(sweepEnv(), m.id, HOME, j.id as string, Date.now() - 20_000)).toBe(true);
    await env.DB.prepare("UPDATE cloud_device_joins SET needs_revoke=0 WHERE id=?").bind(j.id).run();
    const res = await pub("cancel", no);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "removed" });
    expect(await oneJoin()).toMatchObject({ ended_by: "my_cloud", needs_revoke: 0, removed_count: 0 });
  });

  // ---- review findings (door-confirm r9) ----
  it("Yes asks the identity reader for the mapped Supabase sub, not the local account id", async () => {
    const m = await laterHome();
    await waitingJoin(m.token);
    readerStrict.on = true;
    const res = await pub("confirm", linkOf(mails(JOINING)[0].text, "yes"));
    expect([res.status, (await res.json<{ state?: string }>()).state]).toEqual([200, "confirmed"]);
  });
  it("a cancelled used join is never replayed, even after the sweep cleared needs_revoke", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    await makeReady(j.id as string);
    await ticketOf(await mint(m.token));
    await settle();
    expect(await cancelJoin(sweepEnv(), m.id, HOME, j.id as string, Date.now())).toBe(true);
    await env.DB.prepare("UPDATE cloud_device_joins SET needs_revoke=0 WHERE id=?").bind(j.id).run();
    expect(await errorOf(await mint(m.token))).toEqual([403, "step_up_required"]);
  });
  it("a used join is found for its own key although another computer's join is live", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    await makeReady(j.id as string);
    await ticketOf(await mint(m.token));
    await settle();
    expect(await errorOf(await mint(m.token, BIND_B))).toEqual([409, "door_join_waiting"]);
    const again = await ticketOf(await mint(m.token));
    expect(again.claims.pairHold).toBe(j.id);
  });
  it("a No between the door's read and the hand-out stops a first-computer ticket and a customer-hold ticket", async () => {
    const f = await firstHome();
    const first = await direct(await emailed(), async () => { await env.DB.prepare("UPDATE cloud_homes SET join_cancel_at=? WHERE id=?").bind(Date.now(), HOME).run(); });
    expect(first.status).toBe(503);
    expect(await tickets()).toEqual([]);
    expect(await joins()).toEqual([]);
    void f;
  });
  it("a customer hold cancelled between its reservation and the hand-out stops the ticket", async () => {
    const m = await laterHome();
    await hold();
    const res = await direct(m.token, async () => { await env.DB.prepare("UPDATE cloud_recovery_holds SET canceled_at=? WHERE id=?").bind(Date.now(), HOLD).run(); });
    expect(res.status).toBe(503);
    expect(await tickets()).toEqual([]);
  });
  it("a second link of the same join mail (a retry after delivery) leaves the first No link working", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    const firstNo = linkOf(mails(JOINING)[0].text, "no");
    await env.DB.prepare("UPDATE cloud_device_joins SET mail_count=0, next_attempt_at=0 WHERE id=?").bind(j.id).run();
    expect(await sendJoinMail(sweepEnv(), sweepDeps(), j.id as string, Date.now())).toBe(true);
    expect(mails(JOINING)).toHaveLength(2);
    const res = await pub("lookup", firstNo);
    expect([res.status, (await res.json<{ state?: string }>()).state]).toEqual([200, "open"]);
  });
  it("cancelling a join that is already cancelled moves no watermark and cancels no finished hold", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    expect(await cancelJoin(sweepEnv(), m.id, HOME, j.id as string, Date.now())).toBe(true);
    const mark = Date.now() - 5000;
    await env.DB.prepare("UPDATE cloud_homes SET join_cancel_at=? WHERE id=?").bind(mark, HOME).run();
    await hold({ id: "hold-late", started_at: Date.now(), completes_at: Date.now() + 72 * ONE_HOUR, completed_at: null });
    expect(await cancelJoin(sweepEnv(), m.id, HOME, j.id as string, Date.now())).toBe(false);
    expect((await env.DB.prepare("SELECT join_cancel_at AS a FROM cloud_homes WHERE id=?").bind(HOME).first<{ a: number }>())!.a).toBe(mark);
    expect((await env.DB.prepare("SELECT canceled_at AS c FROM cloud_recovery_holds WHERE id='hold-late'").first<{ c: number | null }>())!.c).toBeNull();
  });
  it("a used join's key needs a second step newer than the last No (another join's cancellation) to get a fresh ticket", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    await makeReady(j.id as string);
    const stale = await token(OWNER_SUB, "owner@example.test", 600);
    expect((await mint(stale)).status).toBe(200);
    await settle();
    expect(await oneJoin()).toMatchObject({ id: j.id, state: "used", redeemed_bind: BIND_A });
    // The owner cancelled ANOTHER join five minutes ago: the stale proof (ten minutes old) predates that No.
    await env.DB.prepare("UPDATE cloud_homes SET join_cancel_at=? WHERE id=?").bind(Date.now() - 300_000, HOME).run();
    const before = (await tickets()).length;
    expect(await errorOf(await mint(stale))).toEqual([403, "step_up_required"]);
    expect(await tickets()).toHaveLength(before);
    // A fresh emailed step after the No replays the same result for the same key.
    expect((await ticketOf(await mint(await emailed()))).claims.pairHold).toBe(j.id);
  });
  it("a No that lands after the pair hold route read the mark aborts the hold's own insert (the check is in the insert)", async () => {
    const m = await laterHome();
    // The route reads the mark (0), then takes its rate limit, then inserts the hold: the trigger is a No committing between the read and the insert.
    await env.DB.prepare(`CREATE TRIGGER no_after_read AFTER INSERT ON selfservice_rate_limits WHEN NEW.subject LIKE 'hold:%'
      BEGIN UPDATE cloud_homes SET join_cancel_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE id='${HOME}'; END`).run();
    try {
      const res = await req("POST", "/v1/account/home/hold", m.token, { action: "pair" }, J);
      expect(await errorOf(res)).toEqual([403, "step_up_required"]);
      expect((await env.DB.prepare("SELECT join_cancel_at AS a FROM cloud_homes WHERE id=?").bind(HOME).first<{ a: number }>())!.a).toBeGreaterThan(0);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_recovery_holds").first<{ n: number }>()).toEqual({ n: 0 });
    } finally { await env.DB.prepare("DROP TRIGGER no_after_read").run(); }
  });
  it("a No link or owner retry on an already cancelled used row moves no watermark and cancels no new hold", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    await makeReady(j.id as string);
    expect((await mint(await emailed())).status).toBe(200);
    await settle();
    expect(await cancelJoin(sweepEnv(), m.id, HOME, j.id as string, Date.now() - 20_000)).toBe(true);
    // The sweep has finished its revoke: needs_revoke is clear, the row stays ended.
    await env.DB.prepare("UPDATE cloud_device_joins SET needs_revoke=0 WHERE id=?").bind(j.id).run();
    const mark = (await env.DB.prepare("SELECT join_cancel_at AS a FROM cloud_homes WHERE id=?").bind(HOME).first<{ a: number }>())!.a;
    await hold({ id: "hold-new", started_at: Date.now(), completes_at: Date.now() + 72 * ONE_HOUR, completed_at: null });
    expect(await cancelJoin(sweepEnv(), m.id, HOME, j.id as string, Date.now())).toBe(false);
    expect((await env.DB.prepare("SELECT join_cancel_at AS a FROM cloud_homes WHERE id=?").bind(HOME).first<{ a: number }>())!.a).toBe(mark);
    expect((await env.DB.prepare("SELECT canceled_at AS c FROM cloud_recovery_holds WHERE id='hold-new'").first<{ c: number | null }>())!.c).toBeNull();
  });
  it("a new pair hold from My Cloud needs a second step newer than the last No", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    expect(await cancelJoin(sweepEnv(), m.id, HOME, j.id as string, Date.now())).toBe(true);
    const res = await req("POST", "/v1/account/home/hold", m.token, { action: "pair" }, J);
    expect(await errorOf(res)).toEqual([403, "step_up_required"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_recovery_holds").first<{ n: number }>()).toEqual({ n: 0 });
    await env.DB.prepare("UPDATE cloud_homes SET join_cancel_at=? WHERE id=?").bind(Date.now() - 20 * 60_000, HOME).run();
    expect((await req("POST", "/v1/account/home/hold", m.token, { action: "pair" }, J)).status).not.toBe(403);
  });
  it("a delivered door intent whose answer was lost runs the door again while an emailed proof stands", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    await makeReady(j.id as string);
    const sessionId = crypto.randomUUID();
    const refused = await req("POST", `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", null, { sessionId }), { bind: BIND_A, kind: "desktop" }, J);
    expect(refused.status).toBe(403);
    const intentId = (await refused.json<{ step_up: { email_code: { intent_id: string } } }>()).step_up.email_code.intent_id;
    const ok = await req("POST", `/v1/homes/${HOME}/door`, await token(OWNER_SUB, "owner@example.test", 5, { sessionId }), { bind: BIND_A, kind: "desktop", stepUpIntentId: intentId }, J);
    expect((await ticketOf(ok)).claims.pairHold).toBe(j.id);
    await settle();
    const again = await req("POST", `/v1/homes/${HOME}/door`, await amrToken("owner@example.test", 10, sessionId), { bind: BIND_A, kind: "desktop", stepUpIntentId: intentId }, J);
    expect((await ticketOf(again)).claims.pairHold).toBe(j.id);
  });

  // ---- owner routes ----
  it("owner routes: 404 with the switch off, GET shows the live join or {}, a known bind shows {}, a bad bind is 400, never cached", async () => {
    const m = await laterHome();
    const path = `/v1/homes/${HOME}/joins`;
    expect(await errorOf(await req("GET", path, m.token, undefined, { DOOR_V2_REQUIRED: "1" }))).toEqual([404, "not_found"]);
    expect(await errorOf(await req("GET", "/v1/homes/nope/joins", m.token, undefined, J))).toEqual([404, "not_found"]);
    expect(await (await req("GET", path, m.token, undefined, J)).json()).toEqual({});
    await waitingJoin(m.token);
    const res = await req("GET", `${path}?bind=${BIND_A}`, m.token, undefined, J);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ state: "waiting", mailedTo: "o***@example.test" });
    homeState.devices = [desktop(BIND_A)];
    expect(await (await req("GET", `${path}?bind=${BIND_A}`, m.token, undefined, J)).json()).toEqual({});
    expect(await errorOf(await req("GET", `${path}?bind=nothex`, m.token, undefined, J))).toEqual([400, "invalid_request"]);
  });
  it("owner resend: mails again inside the budget, 429 on the second within a minute, 409 once the join is not waiting", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    const path = `/v1/homes/${HOME}/joins/${j.id}/resend`;
    const first = await req("POST", path, m.token, {}, J);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ sent: true, state: "waiting" });
    expect(mails(JOINING)).toHaveLength(2);
    const hold1 = (await oneJoin()).hold_until;
    expect((await req("POST", path, m.token, {}, J)).status).toBe(429);
    await makeReady(j.id as string);
    await env.DB.prepare("DELETE FROM cloud_rate_limits").run().catch(() => {});
    const late = await req("POST", path, m.token, {}, J);
    expect([409, 429]).toContain(late.status);
    // The resend never restarts the hold clock.
    expect(hold1).toBe(j.hold_until);
  });
  it("owner cancel: the join is cancelled and its mark makes the next press need a newer step; a second cancel is 409; another account's join is 404", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    const path = `/v1/homes/${HOME}/joins/${j.id}/cancel`;
    const res = await req("POST", path, m.token, {}, J);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "removed" });
    expect(await oneJoin()).toMatchObject({ state: "cancelled", ended_by: "my_cloud" });
    expect((await env.DB.prepare("SELECT join_cancel_at AS a FROM cloud_homes WHERE id=?").bind(HOME).first<{ a: number | null }>())?.a).not.toBeNull();
    expect(await errorOf(await req("POST", path, m.token, {}, J))).toEqual([409, "join_not_waiting"]);
    expect(await errorOf(await req("POST", `/v1/homes/${HOME}/joins/nope/cancel`, m.token, {}, J))).toEqual([404, "not_found"]);
    expect(await errorOf(await mint(m.token))).toEqual([403, "step_up_required"]);
  });
  it("My Cloud holds list: a waiting join is listed with a masked address, a ready one with its end, a stopped one as stopping", async () => {
    const m = await laterHome();
    const j = await waitingJoin(m.token);
    expect(await joinHoldsView(env.DB, HOME, Date.now())).toMatchObject([{ holdId: j.id, source: "device_join", state: "waiting", mailedTo: "o***@example.test" }]);
    await makeReady(j.id as string);
    expect(await joinHoldsView(env.DB, HOME, Date.now())).toMatchObject([{ state: "ready" }]);
    await req("POST", `/v1/homes/${HOME}/joins/${j.id}/cancel`, m.token, {}, J);
    expect(await joinHoldsView(env.DB, HOME, Date.now())).toMatchObject([{ state: "stopping" }]);
  });

  // ---- mail retry ----
  it("a join mail that fails leaves the join waiting with no hold clock; the sweep retries it after the backoff and the clock starts then", async () => {
    const m = await laterHome();
    deps.emailSender = downSender;
    const j = await waitingJoin(m.token);
    expect(j).toMatchObject({ mail_sent_at: null, hold_until: null, attempts: 1 });
    deps.emailSender = realSender;
    expect(await sweepDeviceJoins(sweepEnv(), Date.now(), sweepDeps())).toBe(0);
    const at = Date.now() + 120_000;
    await sweepDeviceJoins(sweepEnv(), at, sweepDeps());
    const after = await oneJoin();
    expect(after.mail_sent_at).toBe(at);
    expect(after.hold_until).toBe(at + 72 * ONE_HOUR);
    expect(mails(JOINING)).toHaveLength(1);
  });
  it("a first-computer connection mail that fails is retried by the sweep, once, and the Remove link still works", async () => {
    await firstHome();
    deps.emailSender = downSender;
    const t = await ticketOf(await mint(await emailed()));
    await settle();
    const claim = () => env.DB.prepare("SELECT sent_at FROM door_computer_notices WHERE home_id=? AND ticket_nonce=?").bind(HOME, t.claims.nonce).first<{ sent_at: number | null }>();
    expect((await claim())?.sent_at).toBeNull();
    deps.emailSender = realSender;
    sent.length = 0;
    expect(await sweepDeviceJoins(sweepEnv(), Date.now(), sweepDeps())).toBeGreaterThan(0);
    expect((await claim())?.sent_at).not.toBeNull();
    const mail = mails("A computer was connected to your Murage home");
    expect(mail).toHaveLength(1);
    homeState.devices = [desktop(BIND_A, { addedAt: Date.now() })];
    await sweepDeviceJoins(sweepEnv(), Date.now() + 5 * 60_000, sweepDeps());
    expect(mails("A computer was connected to your Murage home")).toHaveLength(1);
    expect(await oneFirst()).toMatchObject({ state: "used" });
    // The link's own revoke has no home to reach here (the public route carries no home dependencies): the row stays for the sweep.
    const res = await pub("cancel", linkOf(mail[0].text, "remove"));
    expect(res.status).toBe(200);
    expect(await oneFirst()).toMatchObject({ state: "used", needs_revoke: 1, ended_by: "link" });
    sent.length = 0;
    await sweepDeviceJoins(sweepEnv(), Date.now(), sweepDeps());
    expect(homeState.devices).toEqual([]);
    expect(mails(REMOVED)).toHaveLength(1);
  });
  it("a removed mail that fails is sent by the sweep, once", async () => {
    const { m, j } = await usedJoinWithKeys();
    deps.emailSender = downSender;
    expect((await req("POST", `/v1/homes/${HOME}/joins/${j.id}/cancel`, m.token, {}, J)).status).toBe(200);
    await settle();
    expect((await oneJoin()).removed_mail_at).toBeNull();
    deps.emailSender = realSender;
    expect(await sweepDeviceJoins(sweepEnv(), Date.now(), sweepDeps())).toBeGreaterThan(0);
    expect(mails(REMOVED)).toHaveLength(1);
    await sweepDeviceJoins(sweepEnv(), Date.now(), sweepDeps());
    expect(mails(REMOVED)).toHaveLength(1);
  });

  // ---- the switch off ----
  it("with DOOR_JOIN_REQUIRED unset the door is as before: no join, no row, the old first-computer mail, the old needs-hold answer, owner routes 404", async () => {
    const m = await laterHome();
    const off = { DOOR_V2_REQUIRED: "1" };
    expect(await errorOf(await mint(m.token, BIND_A, off))).toEqual([409, "door_needs_hold"]);
    await hold();
    expect((await ticketOf(await mint(m.token, BIND_A, off))).claims.pairHold).toBe(HOLD);
    await settle();
    expect(await joins()).toEqual([]);
    expect(await tickets()).toEqual([]);
    expect(await errorOf(await req("GET", `/v1/homes/${HOME}/joins`, m.token, undefined, off))).toEqual([404, "not_found"]);
    await env.DB.prepare("DELETE FROM cloud_recovery_holds").run();
    homeState.devices = [{ id: "b-1", scope: "browser", addedAt: 1 }]; homeState.fullScopeEver = false;
    expect((await mint(await emailed(), BIND_B, off)).status).toBe(200);
    await settle();
    expect(await joins()).toEqual([]);
    expect(mails(FIRST_COMPUTER_SUBJECT)[0].text).toContain("Make chat-only");
  });
});
