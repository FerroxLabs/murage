// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra SUPPORT5 P1 #2: a stolen aal2 session can enrol its own TOTP factor through Supabase's MFA API. Fresh step-up
// counts only when the factor that verified the session (the hook's server-set `mfa_factor_id`) is on the Cloud
// account's trusted list and out of its hold. CONTRACT.md section 3a; src/trusted-factors.ts.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWorker } from "../src/index";
import { dropSink, engagedSink, installSink, realSends, sunk } from "./sink-fixture";

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
let sinkOn = false;   // the staging mail sink engaged and NO injected sender (Astra TRUSTCODE-1 P3-3)
const sinkWorker = createWorker(fetch, fetch, {}, {}, {}, {
  jwksFetch: (async () => Response.json(jwks)) as typeof fetch,
  authFetch: (async () => Response.json({ id: SUB, email: supa.email, email_confirmed_at: "2026-10-01T00:00:00Z", updated_at: supa.updatedAt,
    factors: supa.factors.map((f) => ({ friendly_name: "", created_at: "2026-10-01T00:00:00Z", ...f })) })) as typeof fetch,
  now: () => clock,
});
const testEnv = () => ({ ...env, ...(sinkOn ? engagedSink() : {}), SUPABASE_URL: REF_ORIGIN, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_testkey_0123456789abcdef",
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
  const res = await (sinkOn ? sinkWorker : worker).fetch(new Request(`https://auth.murage.test${path}`, { method,
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

/** The member's first factor, trusted the only way a first factor can be: emailed code, then the 24-hour hold. */
async function trustFirstFactor() {
  const t = await token(FM);
  expect((await call("POST", "/v1/account/mfa/trust-code", t, { factorId: FM })).status).toBe(202);
  expect((await call("POST", "/v1/account/mfa/trust", t, { factorId: FM, code: codeFromMail() })).status).toBe(201);
  clock += 24 * HOUR + 1000;
}

beforeEach(async () => {
  clock = 1_790_000_000_000;
  supa = { email: EMAIL, updatedAt: "2026-10-01T00:00:00.000000Z", factors: [{ id: FM, factor_type: "totp", status: "verified", friendly_name: "Pat's phone" }] };
  mail.length = 0;
  failMail = false;
  duringSend = null;
  // These tests are about the HELD first-factor path, so the account has something to protect (TRUST-FIRST-FACTOR.md part B): a staging
  // machine assignment, which no route in this file reaches. The no-hold waiver for an account with nothing: test/trust-bootstrap.test.ts.
  expect((await call("GET", "/v1/account/mfa/factors", await token(FM))).status).toBe(200);
  await env.DB.prepare("INSERT INTO machine_owners (machine_id,owner_user_id,assigned_at) VALUES ('held-path-fixture',?,0)").bind(await userId()).run();
  mail.length = 0;
});

describe("trusted factors: who may approve money and desktop pairing", () => {
  it("THE DECISIVE CASE: an attacker-enrolled factor is refused, and still refused 25 hours later", async () => {
    await trustFirstFactor();
    // The member's own fresh proof passes the gate.
    for (const r of await gated(await token(FM))) expect(passedGate(r)).toBe(true);
    // The attacker, holding the member's aal2 session, enrols and verifies their own TOTP factor directly in Supabase.
    supa.factors.push({ id: FA, factor_type: "totp", status: "verified" });
    const attacker = async () => token(FA, 10);
    for (const [status, body] of await gated(await attacker())) {
      expect([status, body.error, (body.step_up as { reason: string }).reason]).toEqual([403, "step_up_required", "untrusted_factor"]);
    }
    // No way to trust it: the email path is closed while a usable trusted factor exists, and a proof from FA is no proof.
    expect(await out(await call("POST", "/v1/account/mfa/trust-code", await attacker(), { factorId: FA }))).toEqual([409, { error: "trusted_factor_required" }]);
    const [st, body] = await out(await call("POST", "/v1/account/mfa/trust", await attacker(), { factorId: FA }));
    expect([st, body.error, (body.step_up as { reason: string; max_age_seconds: number })]).toEqual([403, "step_up_required",
      expect.objectContaining({ reason: "untrusted_factor", max_age_seconds: 300 })]);
    // The notice period passes unread.
    clock += 25 * HOUR;
    for (const [status, b] of await gated(await attacker())) {
      expect([status, b.error, (b.step_up as { reason: string }).reason]).toEqual([403, "step_up_required", "untrusted_factor"]);
    }
    expect((await call("POST", "/v1/account/mfa/trust", await attacker(), { factorId: FA })).status).toBe(403);
    expect((await trustedRows()).map((r) => r.factor_id)).toEqual([FM]);
    // The member is unaffected.
    for (const r of await gated(await token(FM))) expect(passedGate(r)).toBe(true);
  });

  it("a stolen aal1 session enrolling the FIRST factor never gets trusted authorization, also after 25 hours", async () => {
    supa.factors = []; // the member never enrolled a factor
    const stolenAal1 = await token(null);
    // The attacker enrols and verifies their own factor in Supabase with the stolen session.
    supa.factors = [{ id: FA, factor_type: "totp", status: "verified" }];
    for (const [status, b] of await gated(await token(FA, 10))) expect([status, (b.step_up as { reason: string }).reason]).toEqual([403, "untrusted_factor"]);
    // Trusting it needs the code mailed to the member's Supabase address; no code, a guessed code: refused.
    expect((await call("POST", "/v1/account/mfa/trust", stolenAal1, { factorId: FA })).status).toBe(400);
    expect((await call("POST", "/v1/account/mfa/trust-code", stolenAal1, { factorId: FA })).status).toBe(202);
    expect(mail.map((m) => m.to)).toEqual([EMAIL]);
    expect((await call("POST", "/v1/account/mfa/trust", stolenAal1, { factorId: FA, code: "00000000" })).status).toBe(403);
    clock += 25 * HOUR;
    for (const [status, b] of await gated(await token(FA, 10))) expect([status, (b.step_up as { reason: string }).reason]).toEqual([403, "untrusted_factor"]);
    expect(await trustedRows()).toEqual([]);
  });

  it("removing a trusted factor and recreating one never carries trust over, and waiting does not create it", async () => {
    await trustFirstFactor();
    const history = await trustedRows();
    supa.factors = []; // every factor removed
    supa.factors = [{ id: FN, factor_type: "totp", status: "verified" }]; // recreated: Supabase issues a new factor id
    for (const [status, b] of await gated(await token(FN, 10))) expect([status, (b.step_up as { reason: string }).reason]).toEqual([403, "untrusted_factor"]);
    clock += 25 * HOUR;
    for (const [status, b] of await gated(await token(FN, 10))) expect([status, (b.step_up as { reason: string }).reason]).toEqual([403, "untrusted_factor"]);
    // The history is kept: the removed factor's row stays (inert: Supabase cleared it from every session), nothing new was added.
    expect(await trustedRows()).toEqual(history);
    expect((await (await call("GET", "/v1/account/mfa/factors", await token(FN))).json<{ newFactorNeeds: string }>()).newFactorNeeds).toBe("email_code");
  });

  it("an attacker who also removes the member's factor still cannot trust their own: the code goes to the member's mailbox", async () => {
    await trustFirstFactor();
    supa.factors = [{ id: FA, factor_type: "totp", status: "verified" }]; // member's factor unenrolled with the stolen session
    const attacker = await token(FA, 10);
    mail.length = 0;
    expect((await call("POST", "/v1/account/mfa/trust-code", attacker, { factorId: FA })).status).toBe(202);
    expect(mail.map((m) => m.to)).toEqual([EMAIL]); // Supabase's current address, never a caller-supplied one
    const real = codeFromMail();
    // Guessing: every wrong code spends an attempt; after 5 even the right code is refused.
    for (let i = 0; i < 5; i += 1) {
      const wrong = String((Number(real) + 1 + i) % 100_000_000).padStart(8, "0");
      expect(await out(await call("POST", "/v1/account/mfa/trust", attacker, { factorId: FA, code: wrong }))).toEqual([403, { error: "code_refused" }]);
    }
    expect((await call("POST", "/v1/account/mfa/trust", attacker, { factorId: FA, code: real })).status).toBe(403);
    clock += 25 * HOUR;
    for (const [status, b] of await gated(await token(FA, 10))) expect([status, (b.step_up as { reason: string }).reason]).toEqual([403, "untrusted_factor"]);
  });

  it("the first factor: emailed code to Supabase's current address, then a 24-hour hold; every change emails the member", async () => {
    const t = await token(FM);
    // Before any trust, a fresh aal2 proof is not enough.
    for (const [status, b] of await gated(t)) expect([status, (b.step_up as { reason: string }).reason]).toEqual([403, "untrusted_factor"]);
    const list = await (await call("GET", "/v1/account/mfa/factors", t)).json();
    expect(list).toEqual({ factors: [{ id: FM, type: "totp", friendlyName: "Pat's phone", eligible: true, trust: "none", usableAt: null }],
      newFactorNeeds: "email_code", sessionFactorId: FM, holdSeconds: 86400, proofMaxAgeSeconds: 300 });
    expect(await out(await call("POST", "/v1/account/mfa/trust", t, { factorId: FM }))).toEqual([400, { error: "email_code_required" }]);
    expect(await out(await call("POST", "/v1/account/mfa/trust-code", t, { factorId: FM }))).toEqual([202, { sent: true, expiresIn: 600 }]);
    expect(mail.at(-1)).toMatchObject({ to: EMAIL, subject: "Your code to trust an authenticator on your Murage Cloud account" });
    const code = codeFromMail();
    expect(code).toMatch(/^\d{8}$/);
    // Only the HMAC is stored.
    expect(JSON.stringify((await env.DB.prepare("SELECT * FROM cloud_factor_trust_codes").all()).results)).not.toContain(code);
    expect(await out(await call("POST", "/v1/account/mfa/trust", t, { factorId: FM, code })))
      .toEqual([201, { factorId: FM, trust: "pending", usableAt: nowS() + 86400, via: "email_code" }]);
    expect(mail.at(-1)).toMatchObject({ to: EMAIL, subject: "An authenticator was added to the trusted list on your Murage Cloud account" });
    expect(mail.at(-1)!.text).toContain("24-hour hold");
    // Single use.
    expect((await call("POST", "/v1/account/mfa/trust-code", t, { factorId: FM })).status).toBe(409); // already_trusted
    // During the hold: refused, with when it ends.
    const holdEnds = nowS() + 86400;
    clock += 23 * HOUR;
    for (const [status, b] of await gated(await token(FM))) {
      expect([status, b.step_up]).toEqual([403, expect.objectContaining({ reason: "untrusted_factor", pending_until: holdEnds })]);
    }
    clock += HOUR + 1000;
    for (const r of await gated(await token(FM))) expect(passedGate(r)).toBe(true);
    // A stale proof from the trusted factor is "stale", not "untrusted".
    for (const [status, b] of await gated(await token(FM, 700))) expect([status, (b.step_up as { reason: string }).reason]).toEqual([403, "stale"]);
    expect((await env.DB.prepare("SELECT kind FROM cloud_factor_trust_events ORDER BY at, rowid").all()).results.map((r) => r.kind))
      .toEqual(["code_sent", "trusted_email_code"]);
  });

  it("the code is bound to the factor, the address it went to, and 10 minutes", async () => {
    supa.factors.push({ id: FN, factor_type: "totp", status: "verified" });
    const t = await token(FM);
    await call("POST", "/v1/account/mfa/trust-code", t, { factorId: FM });
    let code = codeFromMail();
    expect((await call("POST", "/v1/account/mfa/trust", t, { factorId: FN, code })).status).toBe(403); // another factor
    await call("POST", "/v1/account/mfa/trust-code", t, { factorId: FM });
    code = codeFromMail();
    changeEmail("moved@example.test"); // the Supabase address changed after the code was sent
    expect((await call("POST", "/v1/account/mfa/trust", t, { factorId: FM, code })).status).toBe(403);
    changeEmail(EMAIL);
    await call("POST", "/v1/account/mfa/trust-code", t, { factorId: FM });
    code = codeFromMail();
    clock += 11 * 60_000;
    expect((await call("POST", "/v1/account/mfa/trust", await token(FM), { factorId: FM, code })).status).toBe(403);
    expect(await trustedRows()).toEqual([]);
  });

  it("removing every factor does not reset the rule: a new factor needs the emailed code and the hold again", async () => {
    await trustFirstFactor();
    supa.factors = [{ id: FN, factor_type: "totp", status: "verified" }];
    const t = await token(FN);
    expect((await (await call("GET", "/v1/account/mfa/factors", t)).json<{ newFactorNeeds: string }>()).newFactorNeeds).toBe("email_code");
    expect((await call("POST", "/v1/account/mfa/trust", t, { factorId: FN })).status).toBe(400); // email_code_required
    await call("POST", "/v1/account/mfa/trust-code", t, { factorId: FN });
    expect((await call("POST", "/v1/account/mfa/trust", t, { factorId: FN, code: codeFromMail() })).status).toBe(201);
    for (const [status, b] of await gated(await token(FN))) expect([status, (b.step_up as { reason: string }).reason]).toEqual([403, "untrusted_factor"]);
    clock += 24 * HOUR + 1000;
    for (const r of await gated(await token(FN))) expect(passedGate(r)).toBe(true);
  });

  it("adding a factor while a trusted one exists needs a proof FROM a trusted factor within 5 minutes, then counts at once", async () => {
    await trustFirstFactor();
    supa.factors.push({ id: FN, factor_type: "totp", status: "verified", friendly_name: "Pat's tablet" });
    // The new factor's own proof is not a trusted proof.
    expect((await call("POST", "/v1/account/mfa/trust", await token(FN), { factorId: FN })).status).toBe(403);
    // A trusted proof older than 5 minutes is stale for this.
    const [st, b] = await out(await call("POST", "/v1/account/mfa/trust", await token(FM, 301), { factorId: FN }));
    expect([st, b.step_up]).toEqual([403, expect.objectContaining({ reason: "stale", max_age_seconds: 300 })]);
    mail.length = 0;
    expect(await out(await call("POST", "/v1/account/mfa/trust", await token(FM, 120), { factorId: FN })))
      .toEqual([201, { factorId: FN, trust: "trusted", usableAt: nowS(), via: "trusted_factor" }]);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: EMAIL, subject: "An authenticator was added to the trusted list on your Murage Cloud account" });
    expect(mail[0].text).toContain("Pat's tablet");
    for (const r of await gated(await token(FN))) expect(passedGate(r)).toBe(true);
  });

  it("no notice, no change; SMS and unverified factors are never trusted; a token without the hook's claim never counts", async () => {
    const t = await token(FM);
    failMail = true;
    expect(await out(await call("POST", "/v1/account/mfa/trust-code", t, { factorId: FM }))).toEqual([503, { error: "email_unavailable" }]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_factor_trust_codes").first())).toEqual({ n: 0 });
    failMail = false;
    await call("POST", "/v1/account/mfa/trust-code", t, { factorId: FM });
    const code = codeFromMail();
    failMail = true;
    expect(await out(await call("POST", "/v1/account/mfa/trust", t, { factorId: FM, code }))).toEqual([503, { error: "email_unavailable" }]);
    expect(await trustedRows()).toEqual([]);
    failMail = false;
    supa.factors.push({ id: FP, factor_type: "phone", status: "verified" }, { id: FN, factor_type: "totp", status: "unverified" });
    for (const f of [FP, FN, FA]) {
      expect(await out(await call("POST", "/v1/account/mfa/trust-code", t, { factorId: f }))).toEqual([409, { error: "factor_not_eligible" }]);
    }
    // Trusted, out of hold, fresh, but the token carries no mfa_factor_id (the hook is not installed): refused.
    await env.DB.prepare("INSERT INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state) VALUES (?,?,'totp','email_code',0,0,'active')")
      .bind(await userId(), FM).run();
    for (const [status, b] of await gated(await token(FM, 10, { mfa_factor_id: undefined }))) {
      expect([status, (b.step_up as { reason: string }).reason]).toEqual([403, "untrusted_factor"]);
    }
    for (const r of await gated(await token(FM))) expect(passedGate(r)).toBe(true);
  });

  it("at most 5 codes a day per account", async () => {
    const t = await token(FM);
    for (let i = 0; i < 5; i += 1) expect((await call("POST", "/v1/account/mfa/trust-code", t, { factorId: FM })).status).toBe(202);
    expect(await out(await call("POST", "/v1/account/mfa/trust-code", t, { factorId: FM }))).toEqual([429, { error: "rate_limited" }]);
    clock += 24 * HOUR + 1000;
    expect((await call("POST", "/v1/account/mfa/trust-code", await token(FM), { factorId: FM })).status).toBe(202);
  });

  // ---- Astra MAKERKIT8 ------------------------------------------------------------------------------------------------

  it("MAKERKIT8 #2 REPRODUCTION: a saved JWT from a REMOVED trusted factor approves nothing (promotion, money, desktop)", async () => {
    await trustFirstFactor();
    supa.factors.push({ id: FN, factor_type: "totp", status: "verified" });
    expect((await call("POST", "/v1/account/mfa/trust", await token(FM, 60), { factorId: FN })).status).toBe(201); // A and B trusted
    const savedA = await token(FM, 30); // a fresh proof from A, saved
    // A is removed in Supabase; B stays enrolled (so a usable trusted factor still exists); the attacker enrols C.
    supa.factors = supa.factors.filter((f) => f.id !== FM);
    supa.factors.push({ id: FA, factor_type: "totp", status: "verified" });
    const [st, b] = await out(await call("POST", "/v1/account/mfa/trust", savedA, { factorId: FA }));
    expect([st, b.error, (b.step_up as { reason: string }).reason]).toEqual([403, "step_up_required", "untrusted_factor"]);
    expect((await trustedRows()).map((r) => r.factor_id)).toEqual([FM, FN]); // history kept, C never added
    for (const [status, body] of await gated(savedA)) expect([status, (body.step_up as { reason: string }).reason]).toEqual([403, "untrusted_factor"]);
    for (const [status, body] of await gated(await token(FA, 10))) expect([status, (body.step_up as { reason: string }).reason]).toEqual([403, "untrusted_factor"]);
    // An unverified (or re-typed) factor with A's id counts no more than a removed one.
    supa.factors.push({ id: FM, factor_type: "totp", status: "unverified" });
    for (const [status] of await gated(savedA)) expect(status).toBe(403);
    // B, still enrolled, is unaffected.
    for (const r of await gated(await token(FN))) expect(passedGate(r)).toBe(true);
  });

  it("MAKERKIT8 #3 REPRODUCTION: while the notice is in flight the new factor approves nothing; a failed notice leaves no authority", async () => {
    await trustFirstFactor();
    supa.factors.push({ id: FN, factor_type: "totp", status: "verified" }, { id: FA, factor_type: "totp", status: "verified" });
    const inFlight: unknown[] = [];
    duringSend = async () => {
      // N is staged, not trusted: it fails the money and desktop gates and cannot approve A.
      inFlight.push(...(await gated(await token(FN, 5))).map(([status, body]) => [status, (body.step_up as { reason: string } | undefined)?.reason]));
      const [st, b] = await out(await call("POST", "/v1/account/mfa/trust", await token(FN, 5), { factorId: FA }));
      inFlight.push([st, (b.step_up as { reason: string } | undefined)?.reason]);
      failMail = true; // ...and then the notice for N fails.
    };
    expect(await out(await call("POST", "/v1/account/mfa/trust", await token(FM, 60), { factorId: FN }))).toEqual([503, { error: "email_unavailable" }]);
    expect(inFlight).toEqual([[403, "untrusted_factor"], [403, "untrusted_factor"], [403, "untrusted_factor"]]);
    failMail = false;
    expect((await trustedRows()).map((r) => r.factor_id)).toEqual([FM]); // neither N nor A
    for (const [status] of await gated(await token(FN, 5))) expect(status).toBe(403);
    for (const [status] of await gated(await token(FA, 5))) expect(status).toBe(403);
    // A second attempt while one is in flight is refused, not doubled.
    duringSend = async () => {
      expect(await out(await call("POST", "/v1/account/mfa/trust", await token(FM, 60), { factorId: FN }))).toEqual([409, { error: "trust_in_progress" }]);
    };
    expect((await call("POST", "/v1/account/mfa/trust", await token(FM, 60), { factorId: FN })).status).toBe(201);
    expect((await trustedRows()).filter((r) => r.factor_id === FN)).toEqual([expect.objectContaining({ state: "active", via: "trusted_factor" })]);
  });

  it("MAKERKIT8 #3: a crash after staging leaves an inert row that a later attempt replaces", async () => {
    await trustFirstFactor();
    supa.factors.push({ id: FN, factor_type: "totp", status: "verified" });
    // What a request that died after staging leaves behind.
    await env.DB.prepare("INSERT INTO cloud_trusted_factors (user_id,factor_id,factor_type,via,trusted_at,usable_at,state,op) VALUES (?,?,'totp','trusted_factor',?,0,'staged','dead')")
      .bind(await userId(), FN, clock).run();
    for (const [status] of await gated(await token(FN, 5))) expect(status).toBe(403);
    expect((await (await call("GET", "/v1/account/mfa/factors", await token(FM))).json<{ factors: { id: string; trust: string }[] }>()).factors
      .find((f) => f.id === FN)?.trust).toBe("none");
    expect((await call("POST", "/v1/account/mfa/trust", await token(FM, 60), { factorId: FN })).status).toBe(409); // trust_in_progress
    clock += 3 * 60_000;
    expect((await call("POST", "/v1/account/mfa/trust", await token(FM, 60), { factorId: FN })).status).toBe(201);
    for (const r of await gated(await token(FN))) expect(passedGate(r)).toBe(true);
  });

  it("MAKERKIT8 #3/#5: an email change or a removed approver while the notice is in flight: nothing activates", async () => {
    await trustFirstFactor();
    supa.factors.push({ id: FN, factor_type: "totp", status: "verified" });
    duringSend = async () => { changeEmail("attacker@example.test"); };
    expect(await out(await call("POST", "/v1/account/mfa/trust", await token(FM, 60), { factorId: FN }))).toEqual([409, { error: "account_changed" }]);
    expect((await trustedRows()).map((r) => r.factor_id)).toEqual([FM]);
    changeEmail(EMAIL);
    duringSend = async () => { supa.factors = supa.factors.filter((f) => f.id !== FM); };
    expect(await out(await call("POST", "/v1/account/mfa/trust", await token(FM, 60), { factorId: FN }))).toEqual([409, { error: "account_changed" }]);
    expect((await trustedRows()).map((r) => r.factor_id)).toEqual([FM]);
    for (const [status] of await gated(await token(FN, 5))) expect(status).toBe(403);
  });

  it("MAKERKIT8 #3 on the email path: the code is spent, the row is only staged until the notice is out", async () => {
    const t = await token(FM);
    await call("POST", "/v1/account/mfa/trust-code", t, { factorId: FM });
    const code = codeFromMail();
    let during: unknown = null;
    duringSend = async () => { during = await trustedRows(); failMail = true; };
    expect((await call("POST", "/v1/account/mfa/trust", t, { factorId: FM, code })).status).toBe(503);
    expect(during).toEqual([expect.objectContaining({ factor_id: FM, state: "staged" })]);
    failMail = false;
    expect(await trustedRows()).toEqual([]);
    expect((await call("POST", "/v1/account/mfa/trust", t, { factorId: FM, code })).status).toBe(403); // single use, even on failure
  });

  it("MAKERKIT8 P2 REPRODUCTION: eight concurrent code requests send exactly five", async () => {
    supa.factors = [{ id: FM, factor_type: "totp", status: "verified" }];
    const t = await token(FM);
    const statuses = await Promise.all(Array.from({ length: 8 }, () => call("POST", "/v1/account/mfa/trust-code", t, { factorId: FM }).then((r) => r.status)));
    expect(statuses.filter((x) => x === 202)).toHaveLength(5);
    expect(statuses.filter((x) => x === 429)).toHaveLength(3);
    expect(mail).toHaveLength(5);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_factor_trust_events WHERE kind='code_sent'").first()).toEqual({ n: 5 });
  });

  it("MAKERKIT8 P2 REPRODUCTION: A->B->A voids the code (the user record's generation moved)", async () => {
    const t = await token(FM);
    await call("POST", "/v1/account/mfa/trust-code", t, { factorId: FM });
    const code = codeFromMail();
    changeEmail("b@example.test");
    changeEmail(EMAIL); // the same address again, a different generation
    expect(await out(await call("POST", "/v1/account/mfa/trust", t, { factorId: FM, code }))).toEqual([403, { error: "code_refused" }]);
    expect(await trustedRows()).toEqual([]);
    // A fresh code at the current generation works.
    await call("POST", "/v1/account/mfa/trust-code", t, { factorId: FM });
    expect((await call("POST", "/v1/account/mfa/trust", t, { factorId: FM, code: codeFromMail() })).status).toBe(201);
  });

  it("MAKERKIT8 P2: a Supabase answer without updated_at binds nothing: 503, no code", async () => {
    supa.updatedAt = "";
    expect(await out(await call("POST", "/v1/account/mfa/trust-code", await token(FM), { factorId: FM }))).toEqual([503, { error: "identity_unavailable" }]);
    expect(mail).toHaveLength(0);
  });
});

describe("the staging mail sink through the production sender (Astra TRUSTCODE-1 P3-3)", () => {
  it("the trusted-factor code AND the activation notice are written to the sink with no injected sender; nothing reaches a provider", async () => {
    await installSink();
    sinkOn = true;
    try {
      const t = await token(FM);
      expect((await call("POST", "/v1/account/mfa/trust-code", t, { factorId: FM })).status).toBe(202);
      const code = /Your one-time code is: (\d{8})/.exec((await sunk()).at(-1)?.text ?? "")?.[1] ?? "";
      expect(code).toMatch(/^\d{8}$/);
      expect((await call("POST", "/v1/account/mfa/trust", t, { factorId: FM, code })).status).toBe(201);
      const rows = await sunk();
      expect(rows).toHaveLength(2);
      expect(rows[0].to_addr).toBe(EMAIL);
      expect([rows[1].to_addr, rows[1].subject]).toEqual([EMAIL, "An authenticator was added to the trusted list on your Murage Cloud account"]);
      expect(mail).toEqual([]);
      expect(realSends).toEqual([]);
    } finally { sinkOn = false; await dropSink(); }
  });
});
