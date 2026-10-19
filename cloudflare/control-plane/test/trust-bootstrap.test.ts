// SPDX-License-Identifier: AGPL-3.0-or-later
// TRUST-FIRST-FACTOR.md revision 2, part B (Astra TRUST-1 #5/#6, TRUST-2 Q1/Q2/F1/F6): after the emailed code is verified, the 24-hour
// first-factor hold is waived only for an account with NOTHING TO PROTECT, at most once per account, decided again inside the
// activation statement. The held path itself: test/trusted-factors.test.ts. src/trusted-factors.ts.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWorker } from "../src/index";

const REF_ORIGIN = "https://testref.supabase.co";
const ISS = `${REF_ORIGIN}/auth/v1`;
const SUB = "5f0c1b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const EMAIL = "pat@example.test";
const FM = "11111111-1111-4111-8111-111111111111"; // the member's authenticator app
const FN = "22222222-2222-4222-8222-222222222222"; // the member's second (new) authenticator
const FA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // the attacker's, enrolled with the stolen session
const FP = "33333333-3333-4333-8333-333333333333"; // an SMS factor
const HOUR = 3_600_000;

const b64u = (b: ArrayBuffer | string) => Buffer.from(typeof b === "string" ? Buffer.from(b) : new Uint8Array(b)).toString("base64url");
let ec: CryptoKeyPair;
let jwks: { keys: Record<string, unknown>[] };
beforeAll(async () => {
  ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", ec.publicKey) as Record<string, unknown>), kid: "ec-1", alg: "ES256", use: "sig" }] };
});

let clock = 1_790_000_000_000;
const nowS = () => Math.floor(clock / 1000);
/** Supabase Auth's current record of the member (GET /auth/v1/user). */
let supa: { email: string; updatedAt: string; factors: { id: string; factor_type: string; status: string; friendly_name?: string }[] };
/** Supabase Auth bumps auth.users.updated_at on every write to the user record, every email change included. */
let gen = 0;
const changeEmail = (to: string) => { supa.email = to; supa.updatedAt = `2026-10-02T00:00:${String((gen += 1) % 60).padStart(2, "0")}.${gen}Z`; };
const mail: { to: string; subject: string; text: string }[] = [];
let failMail = false;
/** Runs inside the provider's send, before it answers: lets a test act while a notice is in flight. */
let duringSend: ((m: { subject: string }) => Promise<void>) | null = null;

const worker = createWorker(fetch, fetch, {}, {
  emailSender: () => ({ async send(m) {
    if (duringSend) { const hook = duringSend; duringSend = null; await hook(m); }
    if (failMail) throw new Error("provider down");
    mail.push({ to: m.to, subject: m.subject, text: m.text });
  } }),
}, {}, {
  jwksFetch: (async () => Response.json(jwks)) as typeof fetch,
  authFetch: (async () => Response.json({ id: SUB, email: supa.email, email_confirmed_at: "2026-10-01T00:00:00Z", updated_at: supa.updatedAt,
    factors: supa.factors.map((f) => ({ friendly_name: "", created_at: "2026-10-01T00:00:00Z", ...f })) })) as typeof fetch,
  now: () => clock,
});
const testEnv = () => ({ ...env, SUPABASE_URL: REF_ORIGIN, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_testkey_0123456789abcdef",
  MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined }) as unknown as Env;

/** A session token. `factor`: the factor that last verified the session (null: aal1), verified `ageS` seconds ago. */
async function token(factor: string | null, ageS = 30, over: Record<string, unknown> = {}) {
  const s = nowS();
  const c = { iss: ISS, aud: "authenticated", exp: s + 3600, iat: s - 5, sub: SUB, email: EMAIL, role: "authenticated", is_anonymous: false,
    app_metadata: { provider: "email", email_verified: true }, user_metadata: {}, session_id: "0b1c2d3e-aaaa-4bbb-8ccc-123456789abc",
    aal: factor ? "aal2" : "aal1", mfa_factor_id: factor,
    amr: factor ? [{ method: "totp", timestamp: s - ageS }, { method: "otp", timestamp: s - 3000 }] : [{ method: "otp", timestamp: s - 3000 }], ...over };
  const input = `${b64u(JSON.stringify({ alg: "ES256", kid: "ec-1", typ: "JWT" }))}.${b64u(JSON.stringify(c))}`;
  return `${input}.${b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, new TextEncoder().encode(input)))}`;
}
async function call(method: string, path: string, bearer: string, body?: unknown) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://auth.murage.test${path}`, { method,
    headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const out = async (res: Response) => [res.status, await res.json<Record<string, unknown>>()] as const;
/** A step-up-gated money route and the desktop pairing code: both must refuse unless the proof came from a trusted factor. */
async function gated(bearer: string) {
  const portal = await call("POST", "/v1/billing/portal", bearer, {});
  const desktop = await call("POST", "/v1/account/homes/home-x/desktop-code", bearer, {});
  return [await out(portal), await out(desktop)];
}
const passedGate = ([status, body]: readonly [number, Record<string, unknown>]) => status !== 401 && body.error !== "step_up_required";
const codeFromMail = () => /Your one-time code is: (\d{8})/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
const userId = async () => (await env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(SUB).first<{ user_id: string }>())!.user_id;
const trustedRows = async () => (await env.DB.prepare("SELECT factor_id,via,usable_at,state FROM cloud_trusted_factors ORDER BY factor_id").all()).results;

const SESSION_A = "0b1c2d3e-aaaa-4bbb-8ccc-123456789abc"; // the harness token's default session
const SESSION_B = "0b1c2d3e-bbbb-4bbb-8ccc-123456789abc";
const DAY_S = 86400;
const asSession = (factor: string, session: string) => token(factor, 30, { session_id: session });
const requestCode = async (t: string, factorId: string) => (await call("POST", "/v1/account/mfa/trust-code", t, { factorId })).status;
const verify = async (t: string, factorId: string, code = codeFromMail()) => out(await call("POST", "/v1/account/mfa/trust", t, { factorId, code }));
const bootstraps = async () => (await env.DB.prepare("SELECT factor_id,session_id,op,consumed_at FROM cloud_factor_bootstraps").all()).results;
/** Creates the Cloud account (first identified call) so a test can give it something to protect before the first factor. */
const account = async () => { expect((await call("GET", "/v1/account/mfa/factors", await token(FM))).status).toBe(200); return userId(); };
const addHome = async (owner: string, id = "home-1", state = "parked") => env.DB.prepare(`INSERT INTO cloud_homes
  (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at) VALUES (?,?,?,?,?,'sha256:x','k',0,0)`)
  .bind(id, `inst-${id}`, owner, state, state).run();

beforeEach(() => {
  clock = 1_790_000_000_000;
  supa = { email: EMAIL, updatedAt: "2026-10-01T00:00:00.000000Z", factors: [
    { id: FM, factor_type: "totp", status: "verified", friendly_name: "Pat's phone" },
    { id: FN, factor_type: "totp", status: "verified", friendly_name: "Pat's tablet" }] };
  mail.length = 0;
  failMail = false;
  duringSend = null;
});

describe("first factor on an account with nothing to protect: no 24-hour hold, after the emailed code", () => {
  it("a fresh account: the code is still required; once verified the factor is usable at once (usableAt = now)", async () => {
    const t = await token(FM);
    for (const [status, b] of await gated(t)) expect([status, (b.step_up as { reason: string }).reason]).toEqual([403, "untrusted_factor"]);
    expect(await out(await call("POST", "/v1/account/mfa/trust", t, { factorId: FM }))).toEqual([400, { error: "email_code_required" }]);
    expect(await requestCode(t, FM)).toBe(202);
    expect(mail.at(-1)!.text).toContain("trusted straight away");
    expect(await bootstraps()).toEqual([{ factor_id: FM, session_id: SESSION_A, op: null, consumed_at: null }]);
    expect((await call("POST", "/v1/account/mfa/trust", t, { factorId: FM, code: "00000000" })).status).toBe(403); // a wrong code: nothing
    expect(await verify(t, FM)).toEqual([201, { factorId: FM, trust: "trusted", usableAt: nowS(), via: "email_code" }]);
    expect(mail.at(-1)!.text).toContain("no 24-hour hold");
    const [b] = await bootstraps() as { consumed_at: number; op: string }[];
    expect(b.consumed_at).toBe(clock);
    expect((await trustedRows())).toEqual([{ factor_id: FM, via: "email_code", usable_at: clock, state: "active" }]);
    // The step_up gate passes now, without waiting.
    for (const r of await gated(await token(FM))) expect(passedGate(r)).toBe(true);
    const list = await (await call("GET", "/v1/account/mfa/factors", t)).json<{ factors: { id: string; trust: string; usableAt: number | null }[] }>();
    expect(list.factors.find((f) => f.id === FM)).toMatchObject({ trust: "trusted", usableAt: nowS() });
  });

  const held = async () => {
    const t = await token(FM);
    expect(await requestCode(t, FM)).toBe(202);
    expect(mail.at(-1)!.text).toContain("trusted 24 hours later");
    expect(await verify(t, FM)).toEqual([201, { factorId: FM, trust: "pending", usableAt: nowS() + DAY_S, via: "email_code" }]);
    expect(mail.at(-1)!.text).toContain("24-hour hold");
    for (const [status, b] of await gated(await token(FM))) {
      expect([status, b.step_up]).toEqual([403, expect.objectContaining({ reason: "untrusted_factor", pending_until: nowS() + DAY_S })]);
    }
  };
  it("held: the account owns a home (any state, here a parked order)", async () => {
    await addHome(await account(), "home-parked", "parked");
    await held();
  });
  it("held: the account has a billing_subscriptions row (any status, here canceled)", async () => {
    const owner = await account();
    await addHome(owner, "home-sub", "deleted");
    await env.DB.prepare("INSERT INTO billing_subscriptions (home_id,customer_id,plan,status,created_at,updated_at) VALUES ('home-sub','cus_x','starter','canceled',0,0)").run();
    await held();
  });
  it("held: the account has a staging machine_owners assignment (no cloud_homes row)", async () => {
    await env.DB.prepare("INSERT INTO machine_owners (machine_id,owner_user_id,assigned_at) VALUES ('mcq-1',?,0)").bind(await account()).run();
    await held();
  });
  it("held: the account has trust history (a factor trusted before and since removed from Supabase)", async () => {
    await env.DB.prepare(`INSERT INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state,op)
      VALUES (?,'99999999-9999-4999-8999-999999999999','totp','email_code',0,0,'active',NULL)`).bind(await account()).run();
    // Not usable (Supabase no longer lists it), so the email path is open; but it is history, so the hold applies.
    expect((await (await call("GET", "/v1/account/mfa/factors", await token(FM))).json<{ newFactorNeeds: string }>()).newFactorNeeds).toBe("email_code");
    await held();
  });

  it("concurrent first-factor requests from two sessions: one reservation, and at most one factor ever skips the hold", async () => {
    const [a, b] = [await asSession(FM, SESSION_A), await asSession(FN, SESSION_B)];
    const statuses = await Promise.all([requestCode(a, FM), requestCode(b, FN)]);
    expect(statuses).toEqual([202, 202]);
    const rows = await bootstraps() as { factor_id: string; session_id: string }[];
    expect(rows).toHaveLength(1);
    // Both now ask again and verify, the reservation holder LAST: by then the other factor is trust history, so the holder is held too.
    const [winner, winnerFactor, loser, loserFactor] = rows[0].session_id === SESSION_A ? [a, FM, b, FN] : [b, FN, a, FM];
    expect(await requestCode(loser, loserFactor)).toBe(202);
    expect(mail.at(-1)!.text).toContain("trusted 24 hours later"); // not the holder: no reservation
    expect((await verify(loser, loserFactor))[1]).toMatchObject({ trust: "pending" });
    expect(await requestCode(winner, winnerFactor)).toBe(202); // the holder's idempotent resend
    expect((await verify(winner, winnerFactor))[1]).toMatchObject({ trust: "pending" });
    expect((await trustedRows() as { usable_at: number }[]).filter((r) => r.usable_at <= clock)).toHaveLength(0);
  });

  it("concurrent first-factor requests, holder verifies first: exactly one factor skips the hold, the other is held", async () => {
    const [a, b] = [await asSession(FM, SESSION_A), await asSession(FN, SESSION_B)];
    await Promise.all([requestCode(a, FM), requestCode(b, FN)]);
    const [row] = await bootstraps() as { session_id: string }[];
    const [winner, winnerFactor, loser, loserFactor] = row.session_id === SESSION_A ? [a, FM, b, FN] : [b, FN, a, FM];
    expect(await requestCode(winner, winnerFactor)).toBe(202);
    expect((await verify(winner, winnerFactor))[1]).toMatchObject({ trust: "trusted", usableAt: nowS() });
    // With a usable trusted factor the email path is closed for the other session; and the consumed reservation is never reused.
    expect(await requestCode(loser, loserFactor)).toBe(409);
    expect((await bootstraps() as { consumed_at: number | null }[])[0].consumed_at).toBe(clock);
    expect((await trustedRows() as { usable_at: number }[]).filter((r) => r.usable_at <= clock)).toHaveLength(1);
  });

  it("the reservation is bound to its session: another session's verify of the same factor is held", async () => {
    expect(await requestCode(await asSession(FM, SESSION_A), FM)).toBe(202);
    // A second session (say, a stolen one) cannot take over a live reservation: its own request leaves the row alone ...
    const other = await asSession(FM, SESSION_B);
    expect(await requestCode(other, FM)).toBe(202);
    expect((await bootstraps() as { session_id: string }[])[0].session_id).toBe(SESSION_A);
    // ... and verifying the (current) code from it trusts the factor HELD.
    expect((await verify(other, FM))[1]).toMatchObject({ trust: "pending", usableAt: nowS() + DAY_S });
  });

  it("an abandoned reservation is reclaimed after its expiry by a new request from the account (F6)", async () => {
    expect(await requestCode(await asSession(FN, SESSION_A), FN)).toBe(202); // reserved, never verified
    const b = await asSession(FM, SESSION_B);
    clock += 5 * 60_000; // still live: not reclaimable
    expect(await requestCode(b, FM)).toBe(202);
    expect((await bootstraps() as { session_id: string }[])[0].session_id).toBe(SESSION_A);
    clock += 6 * 60_000; // past the code TTL (10 minutes from the reservation)
    const b2 = await asSession(FM, SESSION_B);
    expect(await requestCode(b2, FM)).toBe(202);
    expect(await bootstraps()).toEqual([{ factor_id: FM, session_id: SESSION_B, op: null, consumed_at: null }]);
    expect(await verify(b2, FM)).toEqual([201, { factorId: FM, trust: "trusted", usableAt: nowS(), via: "email_code" }]);
  });

  it("a home appearing after the code is verified but before activation keeps the hold (decided inside the activation UPDATE, F1)", async () => {
    const owner = await account();
    const t = await token(FM);
    expect(await requestCode(t, FM)).toBe(202);
    const code = codeFromMail();
    // While the "authenticator added" notice is in flight (after verification-time eligibility and consumption), a home appears.
    duringSend = async () => { await addHome(owner, "home-race", "payment_pending"); };
    expect(await verify(t, FM, code)).toEqual([201, { factorId: FM, trust: "pending", usableAt: nowS() + DAY_S, via: "email_code" }]);
    expect((await bootstraps() as { consumed_at: number | null }[])[0].consumed_at).toBe(clock); // spent, never reusable
    expect(await trustedRows()).toEqual([{ factor_id: FM, via: "email_code", usable_at: clock + DAY_S * 1000, state: "active" }]);
  });

  it("a home appearing between the code request and its verification: not consumed, held", async () => {
    const owner = await account();
    const t = await token(FM);
    expect(await requestCode(t, FM)).toBe(202);
    await addHome(owner, "home-early", "reserved");
    expect((await verify(t, FM))[1]).toMatchObject({ trust: "pending", usableAt: nowS() + DAY_S });
    expect((await bootstraps() as { consumed_at: number | null }[])[0].consumed_at).toBeNull();
  });
});
