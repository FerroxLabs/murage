// SPDX-License-Identifier: AGPL-3.0-or-later
// FLUX-ENSURE-EMAIL-VERIFIED (design-ev3 r3 + the round 3 changes + grok-runbook.md): the inbox proof, the typed email_unverified hold, the
// wire, the wake-up and support's routes (resend, dispute, dispute-clear; NO stamp route). Real workerd + D1. The Flux side is a FAKE that
// follows FluxMain's ensure-account contract row for row (ContractFlux below).
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alertTier, isPageKind } from "../src/alert-tiers";
import { fluxRoute } from "../src/b4-flux";
import { grantOnce, retryPendingGrants } from "../src/b5-billing";
import { acquireHomeLease, releaseHomeLease, withHomeLease } from "../src/billing-lease";
import { reconciledContactEmail, resolveCloudAccount } from "../src/cloud-accounts";
import type { Identity } from "../src/customer-identity";
import { writeFirstKeyHold } from "../src/b4-flux";
import {
  accountHeld, autoSendProof, queueAutoSendProof, fluxEmailProofOperatorRoute, fluxEmailProofRoute, issueChallenge, proofGate, sweepFluxEmailAutoSend, sweepFluxEmailStuck, PROOF_CODE_DIGITS, PROOF_CODE_TTL_MS, PROOF_MAX_GUESSES, PROOF_PURPOSE, PROOF_SEND_GAP_MS,
  PROOF_SENDS_PER_DAY, proofState, runWake, STUCK_PER_TICK, sweepFluxEmailWake, verifyProof, WAKE_MAX_TRIES, type FluxProofDependencies,
} from "../src/flux-email-proof";
import { ensureFluxAccount, ensureOwnerAccount, FluxEmailUnverified, FluxEnsureRefused, FluxHookRetry } from "../src/flux-grants";
import { createEnvFluxHooks, selectFluxMode } from "../src/flux-live-hooks";
import { CODE_DIGITS, CODE_TTL_SECONDS, MAX_GUESSES, SEND_GAP_MS, SENDS_PER_DAY } from "../src/step-up-email";
import { GrantsRouterDouble } from "./support/grants-router-double";

// @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
const sources = import.meta.glob("../src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const src = (name: string) => sources[`../src/${name}`]!;
// @ts-expect-error import.meta.glob is Vite's.
const runbook = Object.values(import.meta.glob("../../../docs/cloud/FLUX-EMAIL-HOLD-RUNBOOK.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>)[0]!;

const OWNER = "user-fp";
const SUB = "sub-fp";
const ADDR = "owner-fp@example.test";
const HOME = "home-fp";
const HOME2 = "home-fp-2";
const HOME3 = "home-fp-3";
const ADMIN = "test-only-admin-token-for-flux-email-proof";
const P_START = Date.UTC(2027, 0, 15, 12, 0, 0);
const P_END = Date.UTC(2027, 1, 15, 12, 0, 0);
type Json = Record<string, unknown>;

/** FluxMain's ensure-account contract (c) EXACTLY (design-pc2 "Test double"), row for row. State: accounts by email, and links by
 *  murage_account_id (the stored first answer). */
class ContractFlux {
  accounts = new Map<string, { id: string; linkedTo: string | null }>();
  links = new Map<string, { email: string; answer: Json }>();
  bodies: Json[] = [];
  /** Calls per murage_account_id: tests assert "no call while unproven". */
  calls = new Map<string, number>();
  down = false;
  /** The existing 422, 400 and 401 rows (an error answer for every call while set). */
  refuse: number | null = null;
  refuseVerified = false;
  private n = 0;
  answer(b: Json): { status: number; body: Json } {
    if (this.down) return { status: 503, body: { code: "ensure_disabled" } };
    if (this.refuse !== null) return { status: this.refuse, body: { error: this.refuse === 422 ? "disposable_email" : this.refuse === 401 ? "unauthorized" : "invalid_request" } };
    const email = String(b.email).trim().toLowerCase();
    const mid = String(b.murage_account_id);
    const link = this.links.get(mid);
    // An id already linked: the same email replays the stored 200, WHATEVER email_verified says; another email is 409 link_email_mismatch.
    if (link) return link.email === email ? { status: 200, body: link.answer } : { status: 409, body: { error: "link_email_mismatch" } };
    // An id not linked, email_verified !== true: 202, and nothing is stored.
    if (b.email_verified !== true) return { status: 202, body: { status: "pending_verification" } };
    // Not in contract (c): Flux answering 202 to a proven call (the anomaly flux.ensure_verified_refused pages for), a test knob.
    if (this.refuseVerified) return { status: 202, body: { status: "pending_verification" } };
    const acct = this.accounts.get(email);
    // An id not linked, email_verified === true: create or link, 200, and the answer is stored. `created` is random: no test leans on it.
    const id = acct?.id ?? `flux-${++this.n}`;
    this.accounts.set(email, { id, linkedTo: mid });
    const answer = { flux_account_id: id, created: Math.random() < 0.5, confirmed: true };
    this.links.set(mid, { email, answer });
    return { status: 200, body: answer };
  }
  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const b = JSON.parse(String(init?.body)) as Json;
    this.bodies.push(b);
    this.calls.set(String(b.murage_account_id), (this.calls.get(String(b.murage_account_id)) ?? 0) + 1);
    const a = this.answer(b);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
}

let flux: ContractFlux;
let router: GrantsRouterDouble;
let clock: number;
let mail: { to: string; text: string; from: string }[];
const envWith = (over: Partial<Env> = {}): Env => ({ ...env, CLOUD_FLUX_ROUTES_ENABLED: "1", FLUX_CLOUD_SERVICE_TOKEN: "s".repeat(40),
  FLUX_CLOUD_GRANTS_URL: "https://router.test", FLUX_CLOUD_GRANTS_TOKEN: router.token, FLUX_APP_BASE: "https://fluxrouter.ai", CLOUD_ADMIN_TOKEN: ADMIN, ...over } as Env);
let e: Env;
const deps = (over: FluxProofDependencies = {}): FluxProofDependencies => ({ now: () => clock, fluxFetch: flux.fetch,
  emailSender: () => ({ async send(m) { mail.push({ to: m.to, text: m.text, from: m.from.name }); } }), ...over });
const lastCode = () => /Your code is: (\d{6})/.exec(mail.at(-1)!.text)![1];
const stampOf = (user = OWNER) => env.DB.prepare("SELECT email_verified_at AS at,email_verified_for AS f,email_revision AS rev FROM supabase_identities WHERE user_id=?")
  .bind(user).first<{ at: number | null; f: string | null; rev: number }>();
const count = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;
const seedIdentity = async (user = OWNER, sub = SUB, email = ADDR) => {
  await env.DB.prepare(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)`).bind(user, "n", `cloud-${user}@cloud-account.invalid`).run();
  await env.DB.prepare("INSERT INTO supabase_identities (sub,user_id,via,created_at,email_revision,contact_email) VALUES (?,?,'created',1,0,?)").bind(sub, user, email).run();
};
const seedHome = (id = HOME, owner = OWNER, created = 1) => env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,created_at,updated_at)
  VALUES (?,?,?,'ready','ready','sha256:x','k',?,1)`).bind(id, `inst-${id}`, owner, created).run();
/** The first-key hold row b4-flux.ts writes on a 202 (failures 0, hold, +15 min). */
const holdHome = (id = HOME) => env.DB.prepare(`INSERT INTO flux_first_key_retry (home_id,failures,next_at,updated_at,hold) VALUES (?,0,?,?,'email_unverified')`)
  .bind(id, clock + 15 * 60_000, clock).run();
/** An existing Flux account (someone's) already uses ADDR. */
const existing = () => flux.accounts.set(ADDR, { id: "flux-theirs", linkedTo: null });
/** A TRUE stamp for the stored address at the current revision (what the proof consume writes). */
const stamp = (user = OWNER, email = ADDR) => env.DB.prepare("UPDATE supabase_identities SET email_verified_at=?,email_verified_for=? WHERE user_id=?").bind(clock, email, user).run();
/** The 24 h page as sweepFluxEmailStuck raises it, for the current revision. */
const stuckPage = (user = OWNER, rev = 0) => env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject)
  VALUES (?,?,'credit.email_unverified_hold','high','{}',1,?)`).bind(`alert:email_unverified_hold:${user}:${rev}`, HOME, `account:${user}`).run();
const ensure = (owner = OWNER, home = HOME) => ensureOwnerAccount(e, owner, home, (a) => ensureFluxAccount(e, flux.fetch, a), clock);
const send = (over: FluxProofDependencies = {}) => issueChallenge(e, OWNER, deps(over));
const verify = async (code: string, over: FluxProofDependencies = {}, challengeId?: string) => {
  const id = challengeId ?? (await env.DB.prepare("SELECT id FROM flux_email_proof WHERE account_id=?").bind(OWNER).first<{ id: string }>())!.id;
  return verifyProof(e, { accountId: OWNER, sub: SUB }, { challengeId: id, code }, deps(over));
};
const op = (act: string, body: unknown, token = ADMIN) => fluxRoute(new Request(`https://cp.test/v1/internal/flux/email-proof/${act}`, { method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), e, {} as never,
  { now: () => clock, emailSender: deps().emailSender });

beforeEach(async () => {
  flux = new ContractFlux(); router = new GrantsRouterDouble(); clock = 1_800_000_000_000; mail = []; e = envWith();
  await seedIdentity(); await seedHome();
});
const CLEAN = ["flux_email_proof_autosend", "flux_email_hold", "flux_email_proof", "flux_email_proof_events", "flux_email_wake", "flux_email_proof_disputes", "flux_email_proof_audit", "flux_first_key_retry",
  "flux_links", "cloud_alerts", "credit_grants", "billing_subscriptions", "cloud_homes", "supabase_identities", "flux_grants", "account_link_events"];
afterEach(async () => {
  await env.DB.prepare(`DELETE FROM "user" WHERE id LIKE 'user-fp%' OR id IN (SELECT user_id FROM supabase_identities)`).run();
  for (const t of CLEAN) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe("wire and the ensure-account contract", () => {
  it("an unproven owner: NO call to Flux at all (P-call); a proven owner: one call with email_verified:true, and the link", async () => {
    expect(await ensure()).toBe("email_unverified");
    expect(flux.bodies).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_hold")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts")).toBe(0);
    await stamp();
    expect(await ensure()).toBe("linked");
    expect(flux.bodies).toEqual([{ murage_account_id: OWNER, email: ADDR, email_verified: true }]);
    expect(await env.DB.prepare("SELECT flux_account_id FROM flux_links WHERE owner_user_id=?").bind(OWNER).first()).toEqual({ flux_account_id: "flux-1" });
  });
  it("an existing Flux account and an unproven address: a local hold, no call, no deadline, no alert (no page per buyer)", async () => {
    existing();
    expect(await ensure()).toBe("email_unverified");
    expect(await ensure()).toBe("email_unverified");
    expect(flux.calls.get(OWNER) ?? 0).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM flux_links")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_hold")).toBe(0);
  });
  it("the hold class is neither a retry nor a refusal; only a 202 with status exactly pending_verification is the hold", async () => {
    expect(new FluxEmailUnverified()).not.toBeInstanceOf(FluxHookRetry);
    expect(new FluxEmailUnverified()).not.toBeInstanceOf(FluxEnsureRefused);
    for (const body of [{ status: "queued" }, { status: "PENDING_VERIFICATION" }, {}, { code: "pending_verification" }]) {
      const f = async () => new Response(JSON.stringify(body), { status: 202 });
      const err = await ensureFluxAccount(e, f, { murageAccountId: OWNER, email: ADDR, emailVerified: true }).catch((x) => x);
      expect(err, JSON.stringify(body)).toBeInstanceOf(FluxHookRetry);
      expect(err).not.toBeInstanceOf(FluxEnsureRefused);
    }
    const held = await ensureFluxAccount(e, async () => new Response(JSON.stringify({ status: "pending_verification" }), { status: 202 }),
      { murageAccountId: OWNER, email: ADDR, emailVerified: true }).catch((x) => x);
    expect(held).toBeInstanceOf(FluxEmailUnverified);
  });
  it("the double is contract (c): a linked id replays its stored 200 whatever email_verified says; another email is 409 link_email_mismatch", async () => {
    await stamp();
    expect(await ensure()).toBe("linked");
    const first = flux.links.get(OWNER)!.answer;
    const replay = await ensureFluxAccount(e, flux.fetch, { murageAccountId: OWNER, email: ADDR, emailVerified: false });
    expect(replay).toEqual({ fluxAccountId: "flux-1", created: first.created === true });
    const mismatch = await ensureFluxAccount(e, flux.fetch, { murageAccountId: OWNER, email: "other@example.test", emailVerified: true }).catch((x) => x);
    expect(mismatch).toBeInstanceOf(FluxEnsureRefused);
    expect(mismatch).toMatchObject({ status: 409, reason: "link_email_mismatch" });
    // An id not linked with email_verified not true: 202, nothing stored.
    const other = await ensureFluxAccount(e, flux.fetch, { murageAccountId: "user-fp-x", email: "x@example.test", emailVerified: false }).catch((x) => x);
    expect(other).toBeInstanceOf(FluxEmailUnverified);
    expect(flux.links.has("user-fp-x")).toBe(false);
    for (const status of [422, 400, 401]) {
      flux.refuse = status;
      expect(await ensureFluxAccount(e, flux.fetch, { murageAccountId: "user-fp-x", email: "x@example.test", emailVerified: true }).catch((x) => x)).toMatchObject({ status });
    }
    flux.refuse = null; flux.down = true;
    const down = await ensureFluxAccount(e, flux.fetch, { murageAccountId: "user-fp-x", email: "x@example.test", emailVerified: true }).catch((x) => x);
    expect(down).toBeInstanceOf(FluxHookRetry);
    expect(down).not.toBeInstanceOf(FluxEnsureRefused);
  });
  it("email_verified is sent true only, and Flux is called only when email_verified_at is set AND email_verified_for equals the address", async () => {
    existing();
    for (const [at, f, want] of [[null, null, false], [null, ADDR, false], [5, "other@example.test", false], [5, ADDR, true]] as const) {
      flux.bodies = [];
      await env.DB.prepare("UPDATE supabase_identities SET email_verified_at=?,email_verified_for=? WHERE user_id=?").bind(at, f, OWNER).run();
      await env.DB.prepare("DELETE FROM flux_links").run(); await env.DB.prepare("DELETE FROM flux_email_hold").run();
      flux.links.clear(); flux.accounts.get(ADDR)!.linkedTo = null;
      await ensure();
      expect(flux.bodies, `${at} ${f}`).toEqual(want ? [{ murage_account_id: OWNER, email: ADDR, email_verified: true }] : []);
    }
  });
});

describe("the challenge (the only proof)", () => {
  beforeEach(async () => { existing(); await holdHome(); });

  it("limits are the step-up code's; its own HMAC purpose", () => {
    expect([PROOF_CODE_DIGITS, PROOF_CODE_TTL_MS, PROOF_MAX_GUESSES, PROOF_SENDS_PER_DAY, PROOF_SEND_GAP_MS])
      .toEqual([CODE_DIGITS, CODE_TTL_SECONDS * 1000, MAX_GUESSES, SENDS_PER_DAY, SEND_GAP_MS]);
    expect(PROOF_PURPOSE).not.toBe("murage.stepup-email.v1");
    expect(src("flux-email-proof.ts")).not.toMatch(/cloud_stepup_|sendCode|verifyCode/);
  });
  it("send mails the STORED contact_email, says it is from Murage Cloud and that nothing happens if ignored; verify stamps, wakes, links", async () => {
    await env.DB.prepare("UPDATE supabase_identities SET contact_email='Owner-FP@Example.test' WHERE user_id=?").bind(OWNER).run();
    expect(await proofState(e, OWNER)).toMatchObject({ needed: true });
    const sent = await send();
    expect(sent.kind).toBe("sent");
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: "Owner-FP@Example.test", from: "Murage Cloud" });
    expect(mail[0]!.text).toContain("This email is from Murage Cloud.");
    expect(mail[0]!.text).toContain("One more code: it switches on your Flux credit.");
    expect(mail[0]!.text).toContain("Nothing happens if you ignore it");
    expect(mail[0]!.text).not.toMatch(/[–—]|\bsafe\b|\bunsafe\b|\bsafety\b|\bfree\b|will fail/i);
    clock += 1000;
    expect(await verify(lastCode())).toBe("stamped");
    expect(await stampOf()).toEqual({ at: clock, f: ADDR, rev: 0 });
    // The wake-up ran inline: the hold is gone, Flux was asked once more with email_verified:true and linked the existing account.
    expect(await count("SELECT COUNT(*) AS n FROM flux_first_key_retry")).toBe(0);
    expect(flux.bodies.at(-1)).toEqual({ murage_account_id: OWNER, email: ADDR, email_verified: true });
    expect(await env.DB.prepare("SELECT flux_account_id FROM flux_links WHERE owner_user_id=?").bind(OWNER).first()).toEqual({ flux_account_id: "flux-theirs" });
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_wake")).toBe(0);
    expect(await proofState(e, OWNER)).toMatchObject({ needed: false });
    expect(await count("SELECT COUNT(*) AS n FROM cloud_stepup_intents") + await count("SELECT COUNT(*) AS n FROM cloud_stepup_challenges")).toBe(0);
  });
  it("a wrong code spends a guess; after 5 wrong guesses the right code is refused", async () => {
    await send();
    const right = lastCode();
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < PROOF_MAX_GUESSES; i++) expect(await verify(wrong)).toBe("refused");
    expect(await verify(right)).toBe("refused");
    expect((await stampOf())!.at).toBeNull();
  });
  it("the fifth guess may still be the right one", async () => {
    await send();
    const right = lastCode();
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < PROOF_MAX_GUESSES - 1; i++) expect(await verify(wrong)).toBe("refused");
    expect(await verify(right)).toBe("stamped");
  });
  it("an expired code is refused", async () => {
    await send();
    clock += PROOF_CODE_TTL_MS;
    expect(await verify(lastCode())).toBe("refused");
    expect((await stampOf())!.at).toBeNull();
  });
  it("a resend invalidates the previous code", async () => {
    const first = await send();
    const old = lastCode();
    clock += PROOF_SEND_GAP_MS;
    await send();
    if (first.kind !== "sent") throw new Error("not sent");
    expect(await verify(old, {}, first.challengeId)).toBe("refused");
    expect(await verify(lastCode())).toBe("stamped");
  });
  it("a resend racing the verify stamps nothing and queues no wake-up", async () => {
    const first = await send();
    if (first.kind !== "sent") throw new Error("not sent");
    const code = lastCode();
    const r = await verify(code, { beforeConsume: async () => { clock += PROOF_SEND_GAP_MS; await send(); } }, first.challengeId);
    expect(r).toBe("refused");
    expect((await stampOf())!.at).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_wake")).toBe(0);
  });
  it("a replay after consume is refused and never refreshes the proof time", async () => {
    await send();
    const code = lastCode();
    expect(await verify(code)).toBe("stamped");
    const at = (await stampOf())!.at;
    clock += 5000;
    expect(await verify(code)).toBe("refused");
    expect((await stampOf())!.at).toBe(at);
  });
  it("a code for another address or an older revision is refused", async () => {
    await send();
    const code = lastCode();
    await env.DB.prepare("UPDATE flux_email_proof SET address='other@example.test' WHERE account_id=?").bind(OWNER).run();
    expect(await verify(code)).toBe("refused");
    await env.DB.prepare("DELETE FROM flux_email_proof").run(); await env.DB.prepare("DELETE FROM flux_email_proof_events").run();
    await send();
    await env.DB.prepare("UPDATE supabase_identities SET email_revision=email_revision+1 WHERE user_id=?").bind(OWNER).run();
    expect(await verify(lastCode())).toBe("refused");
    expect((await stampOf())!.at).toBeNull();
  });
  it("send is refused with no held home, once proven, and past the quota (5 a day, 30 s apart)", async () => {
    await env.DB.prepare("DELETE FROM flux_first_key_retry").run();
    await expect(send()).rejects.toMatchObject({ status: 409, code: "not_needed" });
    await holdHome();
    expect((await send()).kind).toBe("sent");
    expect(await send()).toMatchObject({ kind: "limited" });
    for (let i = 0; i < 4; i++) { clock += PROOF_SEND_GAP_MS; expect((await send()).kind).toBe("sent"); }
    clock += PROOF_SEND_GAP_MS;
    expect(await send()).toMatchObject({ kind: "limited" });
    await env.DB.prepare("UPDATE supabase_identities SET email_verified_at=1,email_verified_for=? WHERE user_id=?").bind(ADDR, OWNER).run();
    await expect(send()).rejects.toMatchObject({ status: 409, code: "already_verified" });
  });
  it("a B5 claim held for it counts as held (the card shows)", async () => {
    await env.DB.prepare("DELETE FROM flux_first_key_retry").run();
    expect(await accountHeld(e, OWNER)).toBe(false);
    await env.DB.prepare("INSERT INTO credit_grants (invoice_id,kind,home_id,plan,claimed_at,last_error) VALUES ('in_h','period',?,'starter',1,'grant_held:email_unverified')").bind(HOME).run();
    expect(await accountHeld(e, OWNER)).toBe(true);
  });
  it("the Cloud page route: state, send, verify, signed in only", async () => {
    const identity = { customer: async () => ({ user: { id: OWNER, email: ADDR, name: "n", emailVerified: true }, session: { id: "s" }, supabase: { sub: SUB } }) } as unknown as Identity;
    const call = (method: string, path: string, body?: unknown) => fluxEmailProofRoute(new Request(`https://cp.test${path}`, { method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), e, identity, deps());
    expect(await (await call("GET", "/v1/account/flux/email-proof"))!.json()).toEqual({ needed: true, blocked: true, challengeId: null });
    const s = await call("POST", "/v1/account/flux/email-proof/send", {});
    expect(s!.status).toBe(202);
    const { challengeId } = await s!.json<{ challengeId: string }>();
    expect((await call("POST", "/v1/account/flux/email-proof/verify", { challengeId, code: lastCode() }))!.status).toBe(200);
    expect(await (await call("GET", "/v1/account/flux/email-proof"))!.json()).toEqual({ needed: false, blocked: false, challengeId: null });
    const anon = { customer: async () => null } as unknown as Identity;
    await expect(fluxEmailProofRoute(new Request("https://cp.test/v1/account/flux/email-proof"), e, anon)).rejects.toMatchObject({ status: 401 });
  });
});

describe("lifecycle: only the move clears, never a token", () => {
  const claims = (sub: string, email: string, amr: { method: string; timestamp: number }[]) =>
    ({ sub, email, sessionId: "s", aal: "aal1", amr, mfaFactorId: null, exp: 9_999_999_999, iat: 1 }) as unknown as Parameters<typeof resolveCloudAccount>[1];
  const stampNow = () => env.DB.prepare("UPDATE supabase_identities SET email_verified_at=?,email_verified_for=? WHERE user_id=?").bind(clock, ADDR, OWNER).run();

  it("create and legacy rows start unstamped; no sign-in method (generate_link otp, magic link, phone, OAuth, password, email change, refresh) stamps", async () => {
    expect(await stampOf()).toMatchObject({ at: null, f: null });
    for (const method of ["otp", "magiclink", "sms", "oauth", "password", "email/signup", "email_change", "token_refresh"]) {
      const email = `new-${method.replace(/\W/g, "")}@example.test`;
      const acct = await resolveCloudAccount(env.DB, claims(`sub-${method}`, email, [{ method, timestamp: 1 }]), clock, async () => ({ id: `sub-${method}`, email }));
      expect(await stampOf(acct.id), method).toMatchObject({ at: null, f: null });
    }
    // The member's own account, signed in again by every method (and after an admin SetEmail refresh: same address): still unstamped.
    for (const method of ["otp", "magiclink", "oauth", "password"]) await resolveCloudAccount(env.DB, claims(SUB, ADDR, [{ method, timestamp: 2 }]), clock, async () => ({ id: SUB, email: ADDR }));
    expect(await stampOf()).toMatchObject({ at: null, f: null });
  });
  it("the background reconcile move clears the stamp in the same statement; A -> B -> A stays cleared", async () => {
    await stampNow();
    expect(await reconciledContactEmail(env.DB, OWNER, clock, async () => ({ id: SUB, email: "b@example.test" }))).toBe("b@example.test");
    expect(await stampOf()).toMatchObject({ at: null, f: null, rev: 1 });
    expect(await reconciledContactEmail(env.DB, OWNER, clock, async () => ({ id: SUB, email: ADDR }))).toBe(ADDR);
    expect(await stampOf()).toMatchObject({ at: null, f: null, rev: 2 });
  });
  it("a code issued at revision r cannot stamp after A -> B -> A (the revision moved)", async () => {
    existing(); await holdHome();
    await send();
    const code = lastCode();
    await reconciledContactEmail(env.DB, OWNER, clock, async () => ({ id: SUB, email: "b@example.test" }));
    await reconciledContactEmail(env.DB, OWNER, clock, async () => ({ id: SUB, email: ADDR }));
    expect(await verify(code)).toBe("refused");
    expect((await stampOf())!.at).toBeNull();
  });
  it("a move racing the verify wins: nothing is stamped", async () => {
    existing(); await holdHome();
    await send();
    const r = await verify(lastCode(), { beforeConsume: async () => { await reconciledContactEmail(env.DB, OWNER, clock, async () => ({ id: SUB, email: "b@example.test" })); } });
    expect(r).not.toBe("stamped");
    expect(await stampOf()).toMatchObject({ at: null, f: null });
  });
  it("the conflict set keeps the stamp", async () => {
    await stampNow();
    await seedIdentity("user-fp-other", "sub-fp-other", "b@example.test");
    await expect(reconciledContactEmail(env.DB, OWNER, clock, async () => ({ id: SUB, email: "b@example.test" }))).rejects.toMatchObject({ status: 409 });
    expect(await stampOf()).toMatchObject({ at: clock, f: ADDR });
  });
  it("transfer between accounts: X moves off the address (cleared), Y moves onto it (unstamped)", async () => {
    await stampNow();
    await seedIdentity("user-fp-y", "sub-fp-y", "y@example.test");
    await reconciledContactEmail(env.DB, OWNER, clock, async () => ({ id: SUB, email: "x2@example.test" }));
    await reconciledContactEmail(env.DB, "user-fp-y", clock, async () => ({ id: "sub-fp-y", email: ADDR }));
    expect(await stampOf()).toMatchObject({ at: null, f: null });
    expect(await stampOf("user-fp-y")).toMatchObject({ at: null, f: null });
  });
  it("no code path reads amr for proof, and only the challenge consume (or a dispute/move clear) writes email_verified_at", () => {
    for (const f of ["flux-email-proof.ts", "flux-link.ts", "flux-grants.ts", "cloud-accounts.ts"]) expect(src(f), f).not.toMatch(/\bamr\b/);
    const writers = Object.entries(sources).filter(([, t]) => /email_verified_at\s*=/.test(t)).map(([p]) => p.replace("../src/", "")).sort();
    expect(writers).toEqual(["cloud-accounts.ts", "flux-email-proof.ts"]);
    // The ONE non-NULL write is the verify batch's stamp.
    const sets = Object.values(sources).flatMap((t) => [...t.matchAll(/email_verified_at\s*=\s*(\?|NULL)/g)].map((m) => m[1]));
    expect(sets.filter((v) => v === "?")).toHaveLength(1);
    expect(src("cloud-accounts.ts")).toMatch(/email_verified_at=NULL, email_verified_for=NULL/);
    const proof = src("flux-email-proof.ts");
    const verifyBody = proof.slice(proof.indexOf("export async function verifyProof"), proof.indexOf("export async function runWake"));
    expect(verifyBody).toMatch(/email_verified_at=\?/);
  });
  it("no operator path can stamp: the operator routes and b4-flux.ts never set email_verified_at", () => {
    const proof = src("flux-email-proof.ts");
    const operator = proof.slice(proof.indexOf("export async function fluxEmailProofOperatorRoute"));
    expect(operator.length).toBeGreaterThan(100);
    expect(operator).not.toMatch(/email_verified_at\s*=\s*\?/);
    expect(operator).not.toMatch(/verifyProof|flux_email_wake/);
    expect(src("b4-flux.ts")).not.toMatch(/email_verified_at|email_verified_for/);
    expect(proof).not.toMatch(/email-proof\/stamp|proof_kind/);
  });
});

describe("the typed hold in B5 (askGrant)", () => {
  let hooks: ReturnType<typeof createEnvFluxHooks>;
  const both = async (url: string, init?: RequestInit) => (new URL(url).pathname === "/api/internal/cloud-home/accounts/ensure" ? flux.fetch(url, init) : router.fetch(url, init));
  const INPUT = { homeId: HOME, plan: "starter", invoiceId: "in_fp", periodStart: P_START, periodEnd: P_END, kind: "period" as const };
  const row = () => env.DB.prepare("SELECT granted_at AS g,attempts AS a,tries AS t,last_error AS err FROM credit_grants WHERE invoice_id='in_fp'").first();
  beforeEach(async () => {
    router.bind(HOME, "flux-theirs");
    router.reversalTargets = true;
    hooks = createEnvFluxHooks(both);
    selectFluxMode(e, hooks);
    await env.DB.prepare("INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,current_period_start,current_period_end,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,1)")
      .bind(HOME, "cus_1", "sub_1", "starter", "active", P_START, P_END).run();
  });
  it("a 202 holds the claim locally before any router call: grant_held:email_unverified, tries rolled back, attempts unchanged, one grant_held alert", async () => {
    existing();
    expect(await withHomeLease(e, HOME, (lease) => grantOnce(e, lease, hooks, INPUT, "sub_1", clock, []))).toBe(false);
    expect(await row()).toMatchObject({ g: null, a: 0, t: 0, err: "grant_held:email_unverified" });
    await withHomeLease(e, HOME, (lease) => retryPendingGrants(e, lease, hooks, HOME, clock + 60_000));
    expect(await row()).toMatchObject({ g: null, a: 0, t: 0, err: "grant_held:email_unverified" });
    expect(router.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.grant_held' AND resolved_at IS NULL")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.grant_pending'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM flux_links")).toBe(0);
    // The owner proves the inbox: the wake lifts the hold and links; the next ask grants.
    expect(await proofState(e, OWNER)).toMatchObject({ needed: true });
    await issueChallenge(e, OWNER, deps());
    expect(await verify(lastCode())).toBe("stamped");
    expect((await row())!.err).toBeNull();
    await withHomeLease(e, HOME, (lease) => retryPendingGrants(e, lease, hooks, HOME, clock + 120_000));
    expect((await row())!.g).not.toBeNull();
  });
});

describe("the wake-up", () => {
  beforeEach(async () => { existing(); await seedHome(HOME2, OWNER, 2); await seedHome(HOME3, OWNER, 3); await holdHome(HOME); await holdHome(HOME2); });

  it("clears every held home of the account and keeps real-failure rows", async () => {
    await env.DB.prepare("INSERT INTO flux_first_key_retry (home_id,failures,next_at,updated_at) VALUES (?,2,?,1)").bind(HOME3, clock + 120_000).run();
    await send();
    expect(await verify(lastCode())).toBe("stamped");
    expect((await env.DB.prepare("SELECT home_id,failures,hold FROM flux_first_key_retry").all()).results).toEqual([{ home_id: HOME3, failures: 2, hold: null }]);
  });
  it("transition only: a repeat proof for an already stamped address queues nothing and touches no retry row", async () => {
    await send();
    const r = await verify(lastCode(), { beforeConsume: async () => {
      await env.DB.prepare("UPDATE supabase_identities SET email_verified_at=1,email_verified_for=? WHERE user_id=?").bind(ADDR, OWNER).run(); } });
    expect(r).toBe("already_verified");
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_wake")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM flux_first_key_retry")).toBe(2);
    expect((await stampOf())!.at).toBe(1);
  });
  it("an interrupted wake-up is recovered by the sweep", async () => {
    await send();
    expect(await verify(lastCode(), { inlineWake: false })).toBe("stamped");
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_wake")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM flux_links")).toBe(0);
    expect(await sweepFluxEmailWake(e, deps())).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_wake")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM flux_links")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM flux_first_key_retry")).toBe(0);
  });
  it("at most 5 tries, then ONE flux.email_wake_exhausted page (an INSERT, stable id), resolved when the account links", async () => {
    await send();
    flux.down = true;
    expect(await verify(lastCode())).toBe("stamped"); // the inline try fails (503)
    for (let i = 0; i < 8; i++) { clock += 61_000; await sweepFluxEmailWake(e, deps()); }
    expect(await env.DB.prepare("SELECT tries FROM flux_email_wake").first()).toEqual({ tries: WAKE_MAX_TRIES });
    const pages = () => env.DB.prepare("SELECT id,subject,resolved_at AS r,json_extract(detail,'$.accountId') AS acct,json_extract(detail,'$.revision') AS rev FROM cloud_alerts WHERE kind='flux.email_wake_exhausted'").all();
    expect((await pages()).results).toEqual([{ id: `alert:email_wake_exhausted:${OWNER}:0`, subject: `account:${OWNER}`, r: null, acct: OWNER, rev: 0 }]);
    const asked = flux.bodies.length;
    clock += 61_000; await sweepFluxEmailWake(e, deps());
    expect(flux.bodies.length).toBe(asked);
    expect((await pages()).results).toHaveLength(1);
    // Any ensure reaching "linked" resolves it.
    flux.down = false;
    expect(await ensure()).toBe("linked");
    expect((await pages()).results).toEqual([expect.objectContaining({ r: expect.any(Number) })]);
  });
  it("astra-code3: a wake try that THROWS at tries=4 counts to 5 and pages ONCE in the same batch; a further sweep pages nothing more", async () => {
    await stamp();
    await env.DB.prepare("INSERT INTO flux_email_wake (account_id,email_revision,created_at,tries) VALUES (?,0,1,?)").bind(OWNER, WAKE_MAX_TRIES - 1).run();
    // An injected read failure inside runWake (its first-home read), after the sweep's claim.
    const db = env.DB;
    const failing = new Proxy(db, { get(t, k) {
      if (k === "prepare") return (sql: string) => { if (sql.startsWith("SELECT id FROM cloud_homes WHERE owner_id=?")) throw new Error("injected"); return t.prepare(sql); };
      const v = (t as unknown as Record<PropertyKey, unknown>)[k];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    } });
    expect(await sweepFluxEmailWake(envWith({ DB: failing }), deps())).toBe(0);
    expect(await env.DB.prepare("SELECT tries FROM flux_email_wake").first()).toEqual({ tries: WAKE_MAX_TRIES });
    const pages = () => env.DB.prepare("SELECT id,subject,home_id AS h,resolved_at AS r FROM cloud_alerts WHERE kind='flux.email_wake_exhausted'").all().then((x) => x.results);
    expect(await pages()).toEqual([{ id: `alert:email_wake_exhausted:${OWNER}:0`, subject: `account:${OWNER}`, h: HOME, r: null }]);
    clock += 61_000;
    await sweepFluxEmailWake(e, deps());
    expect(await pages()).toHaveLength(1);
    expect(flux.bodies).toHaveLength(0);
  });
  it("ITEM4-FIX2 section 4: two calls with the SAME expected tries move tries once and page once at the cap", async () => {
    await stamp();
    await env.DB.prepare("INSERT INTO flux_email_wake (account_id,email_revision,created_at,tries) VALUES (?,0,1,?)").bind(OWNER, WAKE_MAX_TRIES - 1).run();
    flux.down = true; // a real try: unavailable, counted
    expect(await runWake(e, OWNER, 0, deps(), WAKE_MAX_TRIES - 1)).toBe("retry");
    expect(await runWake(e, OWNER, 0, deps(), WAKE_MAX_TRIES - 1)).toBe("retry"); // a replay of the same attempt
    expect(await env.DB.prepare("SELECT tries FROM flux_email_wake").first()).toEqual({ tries: WAKE_MAX_TRIES });
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='flux.email_wake_exhausted'")).toBe(1);
  });
});

describe("support's routes (no stamp)", () => {
  beforeEach(async () => { existing(); await holdHome(); });

  it("admin credential only", async () => {
    await expect(op("resend", { account_id: OWNER, by: "ops" }, "wrong")).rejects.toMatchObject({ status: 401 });
  });
  it("resend never takes an address: the code goes to the stored contact_email; the audit row is written", async () => {
    await expect(op("resend", { account_id: OWNER, by: "ops", address: "attacker@example.test" })).rejects.toMatchObject({ status: 400 });
    expect(mail).toHaveLength(0);
    const r = await op("resend", { account_id: OWNER, by: "ops" });
    expect(r!.status).toBe(202);
    expect(mail.map((m) => m.to)).toEqual([ADDR]);
    expect(await env.DB.prepare("SELECT act,operator,email_revision,sent_at,message_id FROM flux_email_proof_audit").first())
      .toEqual({ act: "resend", operator: "ops", email_revision: 0, sent_at: clock, message_id: null });
    expect(await verify(lastCode())).toBe("stamped"); // a normal challenge: still the owner types it
  });
  it("there is no stamp route", async () => {
    await expect(op("stamp", { account_id: OWNER, address: ADDR, proof_kind: "inbox_reply", note: "x" })).resolves.toBeNull();
    expect((await stampOf())!.at).toBeNull();
  });
  it("a dispute blocks stamp and wake; dispute-clear re-allows them", async () => {
    await send();
    const code = lastCode();
    expect(await (await op("dispute", { account_id: OWNER, note: "not my email", by: "ops" }))!.json()).toEqual({ linked: false, disputed: true });
    expect(await verify(code)).toBe("disputed");
    expect((await stampOf())!.at).toBeNull();
    await expect(send()).rejects.toMatchObject({ code: "proof_disputed" });
    expect(await proofState(e, OWNER)).toMatchObject({ needed: false });
    // A wake-up queued before the dispute does not run while it stands.
    await env.DB.prepare("UPDATE supabase_identities SET email_verified_at=1,email_verified_for=? WHERE user_id=?").bind(ADDR, OWNER).run();
    await env.DB.prepare("INSERT INTO flux_email_wake (account_id,email_revision,created_at) VALUES (?,0,1)").bind(OWNER).run();
    expect(await runWake(e, OWNER, 0, deps())).toBe("blocked");
    expect(await count("SELECT COUNT(*) AS n FROM flux_links")).toBe(0);
    await env.DB.prepare("UPDATE supabase_identities SET email_verified_at=NULL,email_verified_for=NULL WHERE user_id=?").bind(OWNER).run();
    await env.DB.prepare("DELETE FROM flux_email_wake").run();
    expect(await (await op("dispute-clear", { account_id: OWNER, by: "ops" }))!.json()).toEqual({ cleared: true });
    clock += PROOF_SEND_GAP_MS;
    await send();
    expect(await verify(lastCode())).toBe("stamped");
    expect(await count("SELECT COUNT(*) AS n FROM flux_links")).toBe(1);
    expect((await env.DB.prepare("SELECT act FROM flux_email_proof_audit ORDER BY at,act").all()).results.map((r) => r.act).sort()).toEqual(["dispute", "dispute_clear"]);
  });
  it("a dispute clears an existing stamp on an unlinked account", async () => {
    await env.DB.prepare("UPDATE supabase_identities SET email_verified_at=1,email_verified_for=? WHERE user_id=?").bind(ADDR, OWNER).run();
    await op("dispute", { account_id: OWNER, note: "not my email", by: "ops" });
    expect(await stampOf()).toMatchObject({ at: null, f: null });
  });
  it("a dispute on a linked account only pages: no unlink, no dispute row, the stamp kept", async () => {
    await env.DB.prepare("UPDATE supabase_identities SET email_verified_at=1,email_verified_for=? WHERE user_id=?").bind(ADDR, OWNER).run();
    await env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,'flux-theirs',1,'flux-theirs',1,0)").bind(OWNER).run();
    expect(await (await op("dispute", { account_id: OWNER, note: "not my email", by: "ops" }))!.json()).toEqual({ linked: true, alerted: true, unlinked: false });
    expect(await count("SELECT COUNT(*) AS n FROM flux_links")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_proof_disputes")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.email_proof_disputed'")).toBe(1);
    expect((await stampOf())!.at).toBe(1);
    expect(await env.DB.prepare("SELECT act FROM flux_email_proof_audit").first()).toEqual({ act: "dispute_linked" });
  });
});

describe("round 1 review (astra-code1, grok-code1)", () => {
  const move = (email: string) => reconciledContactEmail(env.DB, OWNER, clock, async () => ({ id: SUB, email }));
  /** Flux's answer arrives AFTER `during` ran: the state moves while ensure-account is in flight. */
  const inFlight = (during: () => Promise<unknown>) => async (u: string, i?: RequestInit) => { await during(); return flux.fetch(u, i); };
  const ensureVia = (f: (u: string, i?: RequestInit) => Promise<Response>, home = HOME, opts: { wake?: boolean } = {}) =>
    ensureOwnerAccount(e, OWNER, home, (a) => ensureFluxAccount(e, f, a), clock, opts);
  const links = () => count("SELECT COUNT(*) AS n FROM flux_links");
  const holdRow = () => env.DB.prepare("SELECT email_revision AS rev,until_at AS until FROM flux_email_hold WHERE account_id=?").bind(OWNER).first<{ rev: number; until: number }>();

  it("A -> B -> A with the replay double: the TRUE call commits at Flux, the move clears the stamp, STALE; back at A unproven there is NO call and no link; a proof at the current revision links exactly once", async () => {
    await stamp();
    expect(await ensureVia(inFlight(async () => { await move("b@example.test"); await move(ADDR); }))).toBe("stale");
    expect(flux.links.has(OWNER)).toBe(true); // committed at Flux: a later call for A would get the replay 200
    expect(await links()).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts")).toBe(0);
    expect(await holdRow()).toBeNull();
    // Back at A, revision 2, unproven: no fetch, so the replay is never fetched (the High, closed).
    const calls = flux.calls.get(OWNER);
    expect(await ensure()).toBe("email_unverified");
    expect(await ensure(OWNER, HOME2)).toBe("email_unverified");
    expect(flux.calls.get(OWNER)).toBe(calls);
    expect(await links()).toBe(0);
    // A new code for A at revision 2: the wake's TRUE call gets the replay 200 and the INSERT links, once.
    existing(); await holdHome();
    await send();
    expect(await verify(lastCode())).toBe("stamped");
    expect(flux.calls.get(OWNER)).toBe(calls! + 1);
    expect(await links()).toBe(1);
    expect(await ensure()).toBe("linked");
    expect(await links()).toBe(1);
  });
  it("A -> B with B proven: the TRUE call for B gets 409 link_email_mismatch: the M-d page (account id only), only this account blocked, terminal on the wake", async () => {
    await stamp();
    expect(await ensureVia(inFlight(() => move("b@example.test")))).toBe("stale");
    expect(flux.links.get(OWNER)!.email).toBe(ADDR);
    await stamp(OWNER, "b@example.test");
    expect(await ensure()).toBe("refused");
    const page = () => env.DB.prepare("SELECT id,subject,detail,resolved_at AS r FROM cloud_alerts WHERE kind='flux.link_email_mismatch_unlinked'").all<{ detail: string }>();
    const rows = (await page()).results;
    expect(rows).toEqual([{ id: `alert:link_email_mismatch_unlinked:${OWNER}`, subject: `account:${OWNER}`, detail: JSON.stringify({ accountId: OWNER }), r: null }]);
    expect(rows[0]!.detail).not.toMatch(/@/);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='flux.ensure_account_refused'")).toBe(0);
    // Blocked while it is open: no further call, and the wake is terminal (dropped, counts toward nothing).
    const calls = flux.calls.get(OWNER);
    expect(await ensure()).toBe("refused");
    await env.DB.prepare("INSERT INTO flux_email_wake (account_id,email_revision,created_at,tries) VALUES (?,1,1,0)").bind(OWNER).run();
    await seedHome(HOME2, OWNER, 2);
    expect(await runWake(e, OWNER, 1, deps())).toBe("done");
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_wake")).toBe(0);
    expect(flux.calls.get(OWNER)).toBe(calls);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='flux.email_wake_exhausted'")).toBe(0);
    expect(await links()).toBe(0);
    // Nothing else stops: another proven account links.
    await seedIdentity("user-fp-other", "sub-fp-other", "other-fp@example.test"); await seedHome("home-fp-other", "user-fp-other", 9);
    await stamp("user-fp-other", "other-fp@example.test");
    expect(await ensure("user-fp-other", "home-fp-other")).toBe("linked");
  });
  it("M-d on the wake path: the first 409 link_email_mismatch is terminal too (no 5 retries, no flux.email_wake_exhausted)", async () => {
    flux.links.set(OWNER, { email: "earlier@example.test", answer: { flux_account_id: "flux-e", created: false, confirmed: true } });
    await holdHome();
    await send();
    expect(await verify(lastCode())).toBe("stamped"); // the inline wake: one TRUE call, 409 link_email_mismatch
    expect(flux.calls.get(OWNER)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_wake")).toBe(0);
    for (let i = 0; i < 6; i++) { clock += 61_000; await sweepFluxEmailWake(e, deps()); }
    expect(flux.calls.get(OWNER)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='flux.link_email_mismatch_unlinked' AND resolved_at IS NULL")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='flux.email_wake_exhausted'")).toBe(0);
  });
  it("an INSERT whose stamp was cleared after the call gives STALE: nothing linked", async () => {
    await stamp();
    const clear = () => env.DB.prepare("UPDATE supabase_identities SET email_verified_at=NULL,email_verified_for=NULL WHERE user_id=?").bind(OWNER).run();
    expect(await ensureVia(inFlight(clear))).toBe("stale");
    expect(await links()).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts")).toBe(0);
    // The next ask is unproven: no call.
    const calls = flux.calls.get(OWNER);
    expect(await ensure()).toBe("email_unverified");
    expect(flux.calls.get(OWNER)).toBe(calls);
  });
  it("H1: a proof cleared by A -> B -> A while the wake's verified ensure is in flight links nothing; the next proof at the current revision links", async () => {
    existing(); await holdHome();
    await send();
    expect(await verify(lastCode(), { inlineWake: false })).toBe("stamped");
    const r = await runWake(e, OWNER, 0, deps({ fluxFetch: inFlight(async () => { await move("b@example.test"); await move(ADDR); }) }));
    expect(r).toBe("retry");
    expect(flux.bodies.at(-1)).toMatchObject({ email_verified: true });
    expect(await links()).toBe(0);
    expect(await stampOf()).toMatchObject({ at: null, f: null, rev: 2 });
    // The held home is still held (nothing was lifted), so the card shows; a proof at the current revision links.
    expect(await count("SELECT COUNT(*) AS n FROM flux_first_key_retry WHERE hold='email_unverified'")).toBe(1);
    expect(await proofState(e, OWNER)).toMatchObject({ needed: true });
    clock += PROOF_SEND_GAP_MS;
    await send();
    expect(await verify(lastCode())).toBe("stamped");
    expect(await links()).toBe(1);
    // The stale wake row (revision 0) is dropped by the sweep.
    clock += 61_000; await sweepFluxEmailWake(e, deps());
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_wake")).toBe(0);
  });
  it("H1 + H2: a dispute opened while the wake's ensure is in flight links nothing", async () => {
    existing(); await holdHome();
    await send();
    expect(await verify(lastCode(), { inlineWake: false })).toBe("stamped");
    const r = await runWake(e, OWNER, 0, deps({ fluxFetch: inFlight(() => op("dispute", { account_id: OWNER, note: "not my email", by: "ops" })) }));
    expect(r).toBe("retry");
    expect(await links()).toBe(0);
    // The same with a dispute that leaves the stamp in place: the INSERT's own dispute fence holds.
    await env.DB.prepare("UPDATE supabase_identities SET email_verified_at=?,email_verified_for=? WHERE user_id=?").bind(clock, ADDR, OWNER).run();
    flux.links.clear(); flux.accounts.get(ADDR)!.linkedTo = null;
    await env.DB.prepare("DELETE FROM flux_email_proof_disputes").run();
    const dispute = () => env.DB.prepare("INSERT INTO flux_email_proof_disputes (account_id,note,by,email_revision,at) VALUES (?,'x','ops',0,1)").bind(OWNER).run();
    expect(await ensureVia(inFlight(dispute), HOME, { wake: true })).toBe("stale");
    expect(await links()).toBe(0);
  });
  it("H2: a disputed account that moves to an unused email is never created or linked (no call to Flux); dispute-clear re-allows it", async () => {
    existing(); await holdHome();
    await op("dispute", { account_id: OWNER, note: "not my email", by: "ops" });
    await move("unused@example.test");
    expect(await ensure()).toBe("email_unverified");
    expect(await ensure(OWNER, HOME2)).toBe("email_unverified");
    expect(flux.bodies).toHaveLength(0);
    expect(flux.accounts.has("unused@example.test")).toBe(false);
    expect(await links()).toBe(0);
    expect(await op("dispute-clear", { account_id: OWNER, by: "ops" }).then((r) => r!.json())).toEqual({ cleared: true });
    // Cleared, but still unproven: no call. Once the new address is proven it links.
    expect(await ensure()).toBe("email_unverified");
    expect(flux.bodies).toHaveLength(0);
    await stamp(OWNER, "unused@example.test");
    expect(await ensure()).toBe("linked");
    expect(flux.bodies).toEqual([{ murage_account_id: OWNER, email: "unused@example.test", email_verified: true }]);
    expect(await links()).toBe(1);
  });
  it("M1: ONE account deadline; homes never renew each other's hold; it moves only on an actual 202 (to a TRUE call)", async () => {
    existing(); await seedHome(HOME2, OWNER, 2); await stamp(); flux.refuseVerified = true;
    const t0 = clock;
    expect(await ensure(OWNER, HOME)).toBe("email_unverified");
    expect(await holdRow()).toEqual({ rev: 0, until: t0 + 15 * 60_000 });
    clock = t0 + 14 * 60_000;
    expect(await ensure(OWNER, HOME2)).toBe("email_unverified");
    expect(flux.bodies).toHaveLength(1);
    expect(await holdRow()).toEqual({ rev: 0, until: t0 + 15 * 60_000 }); // a standing hold never moves the deadline
    clock = t0 + 15 * 60_000 + 1;
    expect(await ensure(OWNER, HOME2)).toBe("email_unverified");
    expect(flux.bodies).toHaveLength(2);
    expect(await holdRow()).toEqual({ rev: 0, until: clock + 15 * 60_000 });
    expect(await ensure(OWNER, HOME)).toBe("email_unverified");
    expect(flux.bodies).toHaveLength(2);
    // An hour, every caller every minute: at most 4 or 5 asks.
    for (let i = 0; i < 60; i++) { clock += 60_000; await ensure(OWNER, i % 2 ? HOME : HOME2); }
    expect(flux.bodies.length).toBeLessThanOrEqual(7);
    // A deadline for an older revision does not hold the new address (proven).
    await move("b@example.test");
    await stamp(OWNER, "b@example.test");
    const before = flux.bodies.length;
    await ensure();
    expect(flux.bodies.length).toBe(before + 1);
  });
  it("M1: a late 202 that arrives after the wake linked is discarded (no deadline, no alert)", async () => {
    existing(); await stamp(); flux.refuseVerified = true;
    const linkMeanwhile = () => env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,'flux-theirs',1,'flux-theirs',1,0)").bind(OWNER).run();
    expect(await ensureVia(inFlight(linkMeanwhile))).toBe("linked");
    expect(await holdRow()).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts")).toBe(0);
    // A 202 for a revision that moved in flight is discarded too.
    await env.DB.prepare("DELETE FROM flux_links").run();
    expect(await ensureVia(inFlight(() => move("b@example.test")))).toBe("stale");
    expect(await holdRow()).toBeNull();
  });
  it("M3: a wake that does not link keeps the hold rows and the wake row (the 24 h page resolved by the proof itself); once linked they all go", async () => {
    existing(); await holdHome();
    expect(await ensure()).toBe("email_unverified");
    expect(await holdRow()).toBeNull(); // unproven: no call, so no deadline
    await stuckPage();
    await send();
    flux.down = true;
    expect(await verify(lastCode())).toBe("stamped");
    expect(await count("SELECT COUNT(*) AS n FROM flux_first_key_retry WHERE hold='email_unverified'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_wake")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.email_unverified_hold' AND resolved_at IS NULL")).toBe(0);
    flux.down = false; clock += 61_000;
    expect(await sweepFluxEmailWake(e, deps())).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM flux_first_key_retry")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_wake")).toBe(0);
    expect(await links()).toBe(1);
  });
  it("M3: Flux off or no live home never drops the wake", async () => {
    existing(); await holdHome();
    expect(await ensure()).toBe("email_unverified");
    await send();
    e = envWith({ CLOUD_FLUX_ROUTES_ENABLED: "0", FLUX_CLOUD_SERVICE_TOKEN: "" } as Partial<Env>);
    expect(await verify(lastCode())).toBe("stamped");
    expect(await runWake(e, OWNER, 0, deps())).toBe("retry");
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_wake")).toBe(1);
    e = envWith();
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleted' WHERE owner_id=?").bind(OWNER).run();
    expect(await runWake(e, OWNER, 0, deps())).toBe("retry");
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_wake")).toBe(1);
    expect(await links()).toBe(0);
  });
  it("M2: disputed rows are never selected, every row is claimed before work (exceptions included), and blocked rows cannot starve the rest", async () => {
    // 25 queued wakes of disputed accounts, all older than the one that can run.
    for (let i = 0; i < 25; i++) {
      await env.DB.prepare("INSERT INTO flux_email_wake (account_id,email_revision,created_at,tries) VALUES (?,0,?,0)").bind(`user-fp-d${i}`, i).run();
      await env.DB.prepare("INSERT INTO flux_email_proof_disputes (account_id,note,by,email_revision,at) VALUES (?,'x','ops',0,1)").bind(`user-fp-d${i}`).run();
    }
    existing(); await holdHome();
    await send();
    expect(await verify(lastCode(), { inlineWake: false })).toBe("stamped");
    expect(await sweepFluxEmailWake(e, deps())).toBe(1);
    expect(await links()).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_wake WHERE last_try_at IS NOT NULL")).toBe(0);
    // An exception mid-work: the row was claimed first, so it is not due again at once, and the throw is a counted try.
    await env.DB.prepare("DELETE FROM flux_email_proof_disputes WHERE account_id='user-fp-d0'").run();
    await seedIdentity("user-fp-d0", "sub-fp-d0", "d0@example.test");
    let calls = 0;
    const throwing = deps({ now: () => { if (++calls > 1) throw new Error("boom"); return clock; } });
    expect(await sweepFluxEmailWake(e, throwing)).toBe(0);
    expect(await env.DB.prepare("SELECT tries,last_try_at AS at FROM flux_email_wake WHERE account_id='user-fp-d0'").first()).toEqual({ tries: 1, at: clock });
    calls = -1_000;
    expect(await sweepFluxEmailWake(e, deps())).toBe(0);
    expect(await env.DB.prepare("SELECT tries,last_try_at AS at FROM flux_email_wake WHERE account_id='user-fp-d0'").first()).toEqual({ tries: 1, at: clock });
  });
  it("M5: a code from a support resend can be entered: the page reads the CURRENT challenge from the account state", async () => {
    existing(); await holdHome();
    const identity = { customer: async () => ({ user: { id: OWNER, email: ADDR, name: "n", emailVerified: true }, session: { id: "s" }, supabase: { sub: SUB } }) } as unknown as Identity;
    const call = (method: string, path: string, body?: unknown) => fluxEmailProofRoute(new Request(`https://cp.test${path}`, { method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), e, identity, deps());
    const pageSend = await (await call("POST", "/v1/account/flux/email-proof/send", {}))!.json<{ challengeId: string }>();
    expect(await (await call("GET", "/v1/account/flux/email-proof"))!.json()).toEqual({ needed: true, blocked: true, challengeId: pageSend.challengeId });
    clock += PROOF_SEND_GAP_MS;
    expect((await op("resend", { account_id: OWNER, by: "ops" }))!.status).toBe(202);
    const state = await (await call("GET", "/v1/account/flux/email-proof"))!.json<{ needed: boolean; challengeId: string }>();
    expect(state.needed).toBe(true);
    expect(state.challengeId).toMatch(/^fp_[0-9a-f]{32}$/);
    expect(state.challengeId).not.toBe(pageSend.challengeId);
    // The page's earlier id no longer works with the newest code; the current one does.
    await expect(call("POST", "/v1/account/flux/email-proof/verify", { challengeId: pageSend.challengeId, code: lastCode() })).rejects.toMatchObject({ status: 403 });
    expect((await call("POST", "/v1/account/flux/email-proof/verify", { challengeId: state.challengeId, code: lastCode() }))!.status).toBe(200);
    expect(await links()).toBe(1);
  });
});

describe("launch flow A (contract (c)): every new buyer proves the email before the first home links", () => {
  /** A home being provisioned: its subscription exists and has not ended. No Flux 202 and no hold yet. */
  const provisioning = (home = HOME) => env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at)
    VALUES (?,'cus_fp',?,'starter','active',1,1)`).bind(home, `sub_${home}`).run();
  const identity = { customer: async () => ({ user: { id: OWNER, email: ADDR, name: "n", emailVerified: true }, session: { id: "s" }, supabase: { sub: SUB } }) } as unknown as Identity;
  const page = (method: string, path: string, body?: unknown) => fluxEmailProofRoute(new Request(`https://cp.test${path}`, { method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), e, identity, deps());
  const state = async () => (await page("GET", "/v1/account/flux/email-proof"))!.json<{ needed: boolean; blocked: boolean; challengeId: string | null }>();
  const marker = () => env.DB.prepare("SELECT state,tries FROM flux_email_proof_autosend WHERE account_id=?").bind(OWNER).first<{ state: string; tries: number }>();
  beforeEach(async () => { await provisioning(); });

  it("the auto-send mails exactly one code; a second delivery (or two racing) sends none", async () => {
    const [a, b] = await Promise.all([autoSendProof(e, OWNER, deps()), autoSendProof(e, OWNER, deps())]);
    expect([a, b].sort()).toEqual(["sent", "skipped"]);
    clock += PROOF_SEND_GAP_MS * 10;
    expect(await autoSendProof(e, OWNER, deps())).toBe("skipped");
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: ADDR, from: "Murage Cloud" });
    expect(mail[0]!.text).toContain("Type this code in the \"Confirm your email\" box on your My Cloud page. It is not the code for opening Murage.");
    expect(mail[0]!.text).not.toMatch(/[\u2013\u2014]|\bsafe\b|\bunsafe\b|\bsafety\b|\bfree\b|will fail/i);
    expect(await marker()).toEqual({ state: "sent", tries: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_proof_events WHERE account_id=? AND kind='code_reserved'", OWNER)).toBe(1);
    // A new address revision is a new auto-send (the proof is per address).
    await env.DB.prepare("UPDATE supabase_identities SET email_revision=1,contact_email='new-fp@example.test' WHERE user_id=?").bind(OWNER).run();
    expect(await autoSendProof(e, OWNER, deps())).toBe("sent");
    expect(mail.at(-1)!.to).toBe("new-fp@example.test");
  });
  it("an already-proven account, a linked account, a disputed account, Flux off, or no home being provisioned gets none", async () => {
    await env.DB.prepare("UPDATE supabase_identities SET email_verified_at=1,email_verified_for=? WHERE user_id=?").bind(ADDR, OWNER).run();
    expect(await autoSendProof(e, OWNER, deps())).toBe("skipped");
    await env.DB.prepare("UPDATE supabase_identities SET email_verified_at=NULL,email_verified_for=NULL WHERE user_id=?").bind(OWNER).run();
    expect(await autoSendProof(envWith({ CLOUD_FLUX_ROUTES_ENABLED: undefined }), OWNER, deps())).toBe("skipped");
    // ITEM 9 M1: Flux off sends nothing, but the obligation is kept (queued, sent once Flux is ready: its own test below).
    expect(await marker()).toEqual({ state: "queued", tries: 1 });
    await env.DB.prepare("DELETE FROM flux_email_proof_autosend").run();
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled'").run();
    expect(await autoSendProof(e, OWNER, deps())).toBe("skipped");
    await env.DB.prepare("UPDATE billing_subscriptions SET status='active'").run();
    await env.DB.prepare("INSERT INTO flux_email_proof_disputes (account_id,note,by,email_revision,at) VALUES (?,'n','ops',0,1)").bind(OWNER).run();
    expect(await autoSendProof(e, OWNER, deps())).toBe("skipped");
    await env.DB.prepare("DELETE FROM flux_email_proof_disputes").run();
    await env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at) VALUES (?,'flux-old',1)").bind(OWNER).run();
    expect(await autoSendProof(e, OWNER, deps())).toBe("skipped");
    expect(mail).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_proof_autosend")).toBe(0);
  });
  it("a failed send never throws: it is recorded and the sweep tries it again at most once; a live code from the page is never replaced", async () => {
    const failing = deps({ emailSender: () => ({ async send() { throw new Error("mail down"); } }) });
    expect(await autoSendProof(e, OWNER, failing)).toBe("failed");
    expect(await marker()).toEqual({ state: "failed", tries: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_proof_events WHERE kind='send_failed'")).toBe(1);
    expect(await sweepFluxEmailAutoSend(e, failing)).toBe(0); // not due yet
    clock += 60_000;
    expect(await sweepFluxEmailAutoSend(e, failing)).toBe(0);
    expect(await marker()).toEqual({ state: "failed", tries: 2 });
    clock += 60_000;
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(0); // at most once
    expect(mail).toHaveLength(0);
    // Again from the start (the quota reset): the retry sends; and a code the buyer asked for meanwhile is never replaced.
    const reset = async () => { await env.DB.prepare("DELETE FROM flux_email_proof_autosend").run(); await env.DB.prepare("DELETE FROM flux_email_proof_events").run(); };
    await reset();
    expect(await autoSendProof(e, OWNER, failing)).toBe("failed");
    clock += 60_000;
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(1);
    expect(mail).toHaveLength(1);
    expect(await marker()).toEqual({ state: "sent", tries: 2 });
    await reset();
    // ITEM 9 r2 H1: an automatic send never replaces a live code, so the code the retry just mailed runs out first.
    await env.DB.prepare("UPDATE flux_email_proof SET expires_at=0").run();
    expect(await autoSendProof(e, OWNER, failing)).toBe("failed");
    clock += PROOF_SEND_GAP_MS;
    expect((await page("POST", "/v1/account/flux/email-proof/send", {}))!.status).toBe(202);
    const pageCode = lastCode();
    clock += 60_000;
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(0);
    expect(await marker()).toEqual({ state: "skipped", tries: 2 });
    expect(lastCode()).toBe(pageCode);
  });
  it("a page refresh or reopen never sends a code; the page's resend works only on a click, within the quota", async () => {
    for (let i = 0; i < 5; i++) expect(await state()).toEqual({ needed: true, blocked: true, challengeId: null });
    expect(mail).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_proof_events")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_proof_autosend")).toBe(0);
    // No hold yet (no Flux 202): the page's own resend is allowed while the home is being provisioned; support's resend still needs a hold.
    expect(await accountHeld(e, OWNER)).toBe(false);
    expect((await page("POST", "/v1/account/flux/email-proof/send", {}))!.status).toBe(202);
    expect(mail).toHaveLength(1);
    expect((await page("POST", "/v1/account/flux/email-proof/send", {}))!.status).toBe(429);
    await expect(issueChallenge(e, OWNER, deps())).rejects.toMatchObject({ status: 409, code: "not_needed" });
    const live = (await state()).challengeId;
    expect(live).toMatch(/^fp_[0-9a-f]{32}$/);
    for (let i = 0; i < 3; i++) expect((await state()).challengeId).toBe(live);
    expect(mail).toHaveLength(1);
  });
  it("an expired code: the state has no live code (the page offers Send a new code), and that resend works: no dead end", async () => {
    expect(await autoSendProof(e, OWNER, deps())).toBe("sent");
    const first = lastCode();
    clock += PROOF_CODE_TTL_MS + 1;
    expect(await state()).toEqual({ needed: true, blocked: true, challengeId: null });
    expect(await verify(first)).toBe("refused");
    const s = await page("POST", "/v1/account/flux/email-proof/send", {});
    expect(s!.status).toBe(202);
    const { challengeId } = await s!.json<{ challengeId: string }>();
    expect((await state()).challengeId).toBe(challengeId);
    clock += 1000;
    expect((await page("POST", "/v1/account/flux/email-proof/verify", { challengeId, code: lastCode() }))!.status).toBe(200);
    expect(await state()).toEqual({ needed: false, blocked: false, challengeId: null });
  });
  it("Open Murage stays disabled (blocked) until the email is proven; a dispute keeps it blocked with the box hidden", async () => {
    expect(await proofGate(e, OWNER)).toMatchObject({ blocked: true, disputed: false });
    await env.DB.prepare("INSERT INTO flux_email_proof_disputes (account_id,note,by,email_revision,at) VALUES (?,'n','ops',0,1)").bind(OWNER).run();
    expect(await state()).toEqual({ needed: false, blocked: true, challengeId: null });
    await env.DB.prepare("DELETE FROM flux_email_proof_disputes").run();
    expect(await autoSendProof(e, OWNER, deps())).toBe("sent");
    expect((await state()).blocked).toBe(true);
    expect(await verify(lastCode())).toBe("stamped");
    expect(await proofGate(e, OWNER)).toMatchObject({ blocked: false });
    expect(await state()).toEqual({ needed: false, blocked: false, challengeId: null });
  });
});

describe("ITEM4-PROOF-CURRENT (design-pc2 r2 + r2.1): Flux is called only on a current proof, and the alert lifecycle", () => {
  const DAY = 24 * 60 * 60_000;
  const provisioning = (home = HOME) => env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at)
    VALUES (?,'cus_fp',?,'starter','active',1,1)`).bind(home, `sub_${home}`).run();
  const move = (email: string, user = OWNER, sub = SUB) => reconciledContactEmail(env.DB, user, clock, async () => ({ id: sub, email }));
  const stuck = (user = OWNER) => env.DB.prepare(`SELECT id,subject,resolved_at AS r,detail FROM cloud_alerts WHERE kind='credit.email_unverified_hold' AND subject=? ORDER BY raised_at`)
    .bind(`account:${user}`).all<{ id: string; subject: string; r: number | null; detail: string }>().then((x) => x.results);
  /** The page's own "Send a new code" (allowed while a home is being provisioned). */
  const pageSend = () => issueChallenge(e, OWNER, deps(), { provisioning: true });
  const firstAt = (rev = 0) => env.DB.prepare("SELECT first_at AS f,state FROM flux_email_proof_autosend WHERE account_id=? AND email_revision=?").bind(OWNER, rev).first<{ f: number; state: string }>();

  it("no fetch while unproven on the B5 ask and the wake (first key and B4 delivery: test/b4-flux.test.ts)", async () => {
    const hooks = createEnvFluxHooks(async (url: string, init?: RequestInit) => (new URL(url).pathname === "/api/internal/cloud-home/accounts/ensure" ? flux.fetch(url, init) : router.fetch(url, init)));
    selectFluxMode(e, hooks);
    await env.DB.prepare("INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,current_period_start,current_period_end,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,1)")
      .bind(HOME, "cus_1", "sub_1", "starter", "active", P_START, P_END).run();
    const INPUT = { homeId: HOME, plan: "starter", invoiceId: "in_fp", periodStart: P_START, periodEnd: P_END, kind: "period" as const };
    expect(await withHomeLease(e, HOME, (lease) => grantOnce(e, lease, hooks, INPUT, "sub_1", clock, []))).toBe(false);
    expect(await env.DB.prepare("SELECT last_error AS err FROM credit_grants WHERE invoice_id='in_fp'").first()).toEqual({ err: "grant_held:email_unverified" });
    // The wake: a queued row whose proof is gone (cleared by a move) is dropped with no fetch.
    await env.DB.prepare("INSERT INTO flux_email_wake (account_id,email_revision,created_at,tries) VALUES (?,0,1,0)").bind(OWNER).run();
    expect(await runWake(e, OWNER, 0, deps())).toBe("done");
    expect(flux.calls.get(OWNER) ?? 0).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind<>'credit.grant_held'")).toBe(0);
  });

  it("no per-buyer page at checkout; ONE page 24 h after first_at; a retry never moves first_at; 23 h raises nothing; the proof resolves it in the consume batch", async () => {
    await provisioning();
    const t0 = clock;
    const failing = deps({ emailSender: () => ({ async send() { throw new Error("mail down"); } }) });
    expect(await autoSendProof(e, OWNER, failing)).toBe("failed");
    expect(await ensure()).toBe("email_unverified"); // the first key's ask: local, no page
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts")).toBe(0);
    clock = t0 + 61_000;
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(1); // the one retry sends
    expect(await firstAt()).toEqual({ f: t0, state: "sent" });
    clock = t0 + 23 * 60 * 60_000;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(0);
    clock = t0 + DAY;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(1);
    const [page] = await stuck();
    expect(page).toMatchObject({ id: `alert:email_unverified_hold:${OWNER}:0`, subject: `account:${OWNER}`, r: null });
    expect(JSON.parse(page!.detail)).toMatchObject({ accountId: OWNER, revision: 0 });
    expect(page!.detail).not.toMatch(/@/);
    clock += 60_000;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(0);
    expect(await stuck()).toHaveLength(1);
    // The buyer proves the inbox: the consume batch resolves the page (the wake links).
    clock += PROOF_SEND_GAP_MS;
    await pageSend();
    expect(await verify(lastCode(), { inlineWake: false })).toBe("stamped");
    expect((await stuck())[0]!.r).toBe(clock);
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_wake")).toBe(1);
    clock += DAY;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(0);
  });

  it("r2.1 fix 3: proving before 24 h (no page exists) still queues the wake row", async () => {
    await provisioning();
    expect(await autoSendProof(e, OWNER, deps())).toBe("sent");
    expect(await verify(lastCode(), { inlineWake: false })).toBe("stamped");
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_wake WHERE account_id=?", OWNER)).toBe(1);
    clock += 2 * DAY;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(0);
  });

  it("r2.1 fix 1: 55 eligible accounts across 3 ticks page every account exactly once (50, then 5, then 0)", async () => {
    for (let i = 0; i < 55; i++) {
      await seedIdentity(`user-fp-s${i}`, `sub-fp-s${i}`, `s${i}@example.test`);
      // ITEM 9 M3: the page is about a paying customer: a live home with a subscription that has not ended.
      await seedHome(`home-fp-s${i}`, `user-fp-s${i}`);
      await env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at) VALUES (?,'cus_fp',?,'starter','active',1,1)`)
        .bind(`home-fp-s${i}`, `sub_home-fp-s${i}`).run();
      await env.DB.prepare("INSERT INTO flux_email_proof_autosend (account_id,email_revision,state,tries,at,first_at) VALUES (?,0,'sent',1,?,?)")
        .bind(`user-fp-s${i}`, clock - DAY - i, clock - DAY - i).run();
    }
    expect(await sweepFluxEmailStuck(e, deps())).toBe(50);
    expect(await sweepFluxEmailStuck(e, deps())).toBe(5);
    expect(await sweepFluxEmailStuck(e, deps())).toBe(0);
    expect(await count("SELECT COUNT(DISTINCT subject) AS n FROM cloud_alerts WHERE kind='credit.email_unverified_hold'")).toBe(55);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.email_unverified_hold'")).toBe(55);
    // A resolved page is never raised again for the same revision, and never takes a slot.
    await env.DB.prepare("UPDATE cloud_alerts SET resolved_at=1").run();
    expect(await sweepFluxEmailStuck(e, deps())).toBe(0);
  });

  it("r2.1 fix 2: an address move resolves the old page; the new revision pages 24 h after the move if still unproven; the move mails nothing", async () => {
    await provisioning();
    expect(await autoSendProof(e, OWNER, deps())).toBe("sent");
    clock += DAY;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(1);
    const tMove = clock + 1000;
    clock = tMove;
    const mailed = mail.length;
    expect(await move("b@example.test")).toBe("b@example.test");
    expect(mail.length).toBe(mailed);
    expect((await stuck())[0]!.r).toBe(tMove);
    expect(await firstAt(1)).toEqual({ f: tMove, state: "skipped" });
    clock = tMove + 23 * 60 * 60_000;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(0);
    clock = tMove + DAY;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(1);
    expect((await stuck()).map((a) => [a.id, a.r === null])).toEqual([[`alert:email_unverified_hold:${OWNER}:0`, false], [`alert:email_unverified_hold:${OWNER}:1`, true]]);
    // The card's "Send a new code" still works at the new revision.
    expect((await pageSend()).kind).toBe("sent");
    expect(mail.at(-1)!.to).toBe("b@example.test");
  });

  it("astra-code3: a conflict set and clear carry the marker (first_at KEPT, nothing mailed); back at the stored address at r2, still unproven, ONE page 24 h after the ORIGINAL first_at", async () => {
    await provisioning();
    const t0 = clock;
    expect(await autoSendProof(e, OWNER, deps())).toBe("sent");
    await seedIdentity("user-fp-other", "sub-fp-other", "b@example.test");
    clock = t0 + 60 * 60_000;
    const mailed = mail.length;
    await expect(move("b@example.test")).rejects.toMatchObject({ status: 409 }); // conflict set: r1
    expect(await firstAt(1)).toEqual({ f: t0, state: "skipped" });
    clock = t0 + 2 * 60 * 60_000;
    expect(await move(ADDR)).toBe(ADDR); // conflict clear: r2
    expect((await stampOf())!.rev).toBe(2);
    expect(await firstAt(2)).toEqual({ f: t0, state: "skipped" });
    expect(mail.length).toBe(mailed);
    clock = t0 + DAY - 60_000;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(0);
    clock = t0 + DAY;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(1);
    expect((await stuck()).map((a) => [a.id, a.r])).toEqual([[`alert:email_unverified_hold:${OWNER}:2`, null]]);
    clock += 60_000;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(0);
  });
  it("astra-code3: a conflict set resolves the old revision's open page, as the address move does", async () => {
    await provisioning();
    expect(await autoSendProof(e, OWNER, deps())).toBe("sent");
    clock += DAY;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(1);
    await seedIdentity("user-fp-other", "sub-fp-other", "b@example.test");
    clock += 1000;
    await expect(move("b@example.test")).rejects.toMatchObject({ status: 409 });
    expect((await stuck())[0]!.r).toBe(clock);
  });
  it("r2.1 fix 2: an account whose home never went active (no marker) gets no marker from a move", async () => {
    await move("b@example.test");
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_proof_autosend")).toBe(0);
  });

  // ITEM4-FIX2 section 2: a LOSING clear, set or move (its revision UPDATE matches 0 rows) resolves only the OLD revision's page, never the
  // winner's rev+1 page. The loser's db runs the winner, then the sweep, right before the loser's `at`-th batch (the racing write); the state
  // is read right after it.
  const racing = (winner: () => Promise<unknown>, at = 1) => {
    const seen: { loserChanges: number | null; page1: number | null | undefined } = { loserChanges: null, page1: undefined };
    let n = 0;
    const db = new Proxy(env.DB, { get(t, k) {
      if (k === "batch") return async (stmts: D1PreparedStatement[]) => {
        if (++n !== at) return t.batch(stmts);
        await winner().catch(() => undefined);
        // The rev+1 page: its marker more than 24 h old, raised by the sweep.
        await env.DB.prepare("UPDATE flux_email_proof_autosend SET first_at=? WHERE account_id=? AND email_revision=1").bind(clock - DAY - 60_000, OWNER).run();
        expect(await sweepFluxEmailStuck(e, deps())).toBe(1);
        const r = await t.batch(stmts);
        seen.loserChanges = r[0]!.meta.changes ?? 0;
        seen.page1 = (await env.DB.prepare("SELECT resolved_at AS r FROM cloud_alerts WHERE id=?").bind(`alert:email_unverified_hold:${OWNER}:1`).first<{ r: number | null }>())?.r;
        return r;
      };
      const v = (t as unknown as Record<PropertyKey, unknown>)[k];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    } }) as D1Database;
    return { db, seen };
  };
  const pagedAt0 = async () => {
    await provisioning();
    expect(await autoSendProof(e, OWNER, deps())).toBe("sent");
    clock += DAY;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(1);
    clock += 1000;
  };
  it("ITEM4-FIX2 (i): a losing conflict CLEAR leaves the winner's rev+1 page OPEN", async () => {
    await pagedAt0();
    await env.DB.prepare("UPDATE supabase_identities SET email_conflict='b@example.test' WHERE user_id=?").bind(OWNER).run();
    const { db, seen } = racing(() => move(ADDR)); // the winner clears to r1
    await reconciledContactEmail(db, OWNER, clock, async () => ({ id: SUB, email: ADDR })).catch(() => undefined);
    expect(seen.loserChanges).toBe(0);
    expect(seen.page1).toBeNull();
  });
  it("ITEM4-FIX2 (ii): a losing conflict SET leaves the winner's rev+1 page OPEN", async () => {
    await pagedAt0();
    await seedIdentity("user-fp-other", "sub-fp-other", "b@example.test");
    // The loser's 1st batch is its move (refused: b is held), its 2nd the conflict set; the winner sets the conflict at r1 (409) just before it.
    const { db, seen } = racing(() => move("b@example.test"), 2);
    await reconciledContactEmail(db, OWNER, clock, async () => ({ id: SUB, email: "b@example.test" })).catch(() => undefined);
    expect(seen.loserChanges).toBe(0);
    expect(seen.page1).toBeNull();
  });
  it("ITEM4-FIX2 (iii): a losing address MOVE leaves the winner's rev+1 page OPEN", async () => {
    await pagedAt0();
    const { db, seen } = racing(() => move("c@example.test")); // the winner moves to c at r1
    await reconciledContactEmail(db, OWNER, clock, async () => ({ id: SUB, email: "c@example.test" })).catch(() => undefined);
    expect(seen.loserChanges).toBe(0);
    expect(seen.page1).toBeNull();
  });
  it("ITEM4-FIX2 (iv): the normal clear, set and move still resolve the OLD revision's page (the move's (?2-1) id)", async () => {
    const page = (rev: number) => env.DB.prepare("SELECT resolved_at AS r FROM cloud_alerts WHERE id=?").bind(`alert:email_unverified_hold:${OWNER}:${rev}`)
      .first<{ r: number | null }>().then((x) => x?.r);
    await pagedAt0();
    expect(await move("c@example.test")).toBe("c@example.test"); // move r0 -> r1
    expect(await page(0)).toBe(clock);
    await stuckPage(OWNER, 1);
    await seedIdentity("user-fp-other", "sub-fp-other", "b@example.test");
    clock += 1000;
    await expect(move("b@example.test")).rejects.toMatchObject({ status: 409 }); // set r1 -> r2
    expect(await page(1)).toBe(clock);
    await stuckPage(OWNER, 2);
    clock += 1000;
    expect(await move("c@example.test")).toBe("c@example.test"); // clear r2 -> r3
    expect((await stampOf())!.rev).toBe(3);
    expect(await page(2)).toBe(clock);
  });

  it("a 202 on a TRUE call: flux.ensure_verified_refused once, the 15 min hold, and a TERMINAL wake (one page, not five)", async () => {
    await holdHome();
    flux.refuseVerified = true;
    await send();
    expect(await verify(lastCode())).toBe("stamped"); // the inline wake: one TRUE call, 202
    expect(flux.bodies).toEqual([{ murage_account_id: OWNER, email: ADDR, email_verified: true }]);
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_wake")).toBe(0);
    expect(await env.DB.prepare("SELECT until_at AS u FROM flux_email_hold WHERE account_id=?").bind(OWNER).first()).toEqual({ u: clock + 15 * 60_000 });
    const pages = () => env.DB.prepare("SELECT id,subject,detail,resolved_at AS r FROM cloud_alerts WHERE kind='flux.ensure_verified_refused'").all<{ detail: string; r: number | null }>().then((x) => x.results);
    expect(await pages()).toEqual([{ id: `alert:ensure_verified_refused:${OWNER}:0`, subject: `account:${OWNER}`, detail: expect.any(String), r: null }]);
    expect(JSON.parse((await pages())[0]!.detail)).toMatchObject({ accountId: OWNER, revision: 0 });
    for (let i = 0; i < 6; i++) { clock += 61_000; await sweepFluxEmailWake(e, deps()); }
    expect(flux.bodies).toHaveLength(1);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='flux.email_wake_exhausted'")).toBe(0);
    // The normal callers keep to the 15 min hold; after it, they ask again (same page row).
    expect(await ensure()).toBe("email_unverified");
    expect(flux.bodies).toHaveLength(1);
    clock += 15 * 60_000;
    expect(await ensure()).toBe("email_unverified");
    expect(flux.bodies).toHaveLength(2);
    expect(await pages()).toHaveLength(1);
    // Resolved when the account links.
    flux.refuseVerified = false;
    clock += 15 * 60_000;
    expect(await ensure()).toBe("linked");
    expect((await pages())[0]!.r).toEqual(expect.any(Number));
  });

  it("M-a: the wake links, then a stale first-key continuation writes no hold row; a moved revision writes none either", async () => {
    await env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,'flux-1',1,'flux-1',1,0)").bind(OWNER).run();
    await writeFirstKeyHold(e, HOME, OWNER, 0, clock);
    expect(await count("SELECT COUNT(*) AS n FROM flux_first_key_retry")).toBe(0);
    await env.DB.prepare("DELETE FROM flux_links").run();
    await move("b@example.test");
    await writeFirstKeyHold(e, HOME, OWNER, 0, clock);
    expect(await count("SELECT COUNT(*) AS n FROM flux_first_key_retry")).toBe(0);
    await writeFirstKeyHold(e, HOME, OWNER, 1, clock);
    expect(await env.DB.prepare("SELECT failures,hold FROM flux_first_key_retry WHERE home_id=?").bind(HOME).first()).toEqual({ failures: 0, hold: "email_unverified" });
  });

  it("M-b: a link committing between the read and the dispute batch takes the linked branch; a repeat reports the same branch", async () => {
    await stamp();
    const dispute = (over: FluxProofDependencies = {}) => fluxEmailProofOperatorRoute(new Request("https://cp.test/v1/internal/flux/email-proof/dispute", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: OWNER, note: "not my email", by: "ops" }) }), e, "dispute", deps(over));
    const linkNow = async () => { await env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,'flux-1',1,'flux-1',1,0)").bind(OWNER).run(); };
    expect(await (await dispute({ beforeDisputeBatch: linkNow })).json()).toEqual({ linked: true, alerted: true, unlinked: false });
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_proof_disputes")).toBe(0);
    expect((await stampOf())!.at).toBe(clock);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.email_proof_disputed'")).toBe(1);
    expect(await (await dispute()).json()).toEqual({ linked: true, alerted: true, unlinked: false });
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.email_proof_disputed'")).toBe(1);
    expect((await env.DB.prepare("SELECT act FROM flux_email_proof_audit").all()).results.map((r) => r.act)).toEqual(["dispute_linked", "dispute_linked"]);
    // Unlinked, a repeat dispute reports the unlinked branch both times.
    await env.DB.prepare("DELETE FROM flux_links").run();
    expect(await (await dispute()).json()).toEqual({ linked: false, disputed: true });
    expect(await (await dispute()).json()).toEqual({ linked: false, disputed: true });
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_proof_disputes")).toBe(1);
    expect(await stampOf()).toMatchObject({ at: null, f: null });
  });

  it("M-e: an address move between the auto-send's claim and the issue: refused, nothing sent, the marker released", async () => {
    await provisioning();
    const r = await autoSendProof(e, OWNER, deps({ beforeAutoSendIssue: async () => { await move("b@example.test"); } }));
    expect(r).toBe("skipped");
    expect(mail).toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_proof_events WHERE kind='code_reserved'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_proof")).toBe(0);
    expect(await firstAt(0)).toBeNull();
    // The new revision's marker came from the move (fix 2): 'skipped', nothing mailed; the page's resend works.
    expect(await firstAt(1)).toMatchObject({ state: "skipped" });
    expect((await pageSend()).kind).toBe("sent");
  });

  it("the grep guard: exactly two flux_links INSERT sites (ensureOwnerLinked, linkComplete), both fenced; one funnel; every call is email_verified: true", () => {
    const sites = Object.entries(sources).flatMap(([p, t]) => [...t.matchAll(/INSERT (?:OR IGNORE )?INTO flux_links\b/g)].map((m) => {
      const stmt = t.slice(m.index!, t.indexOf("`)", m.index!));
      return { file: p.replace("../src/", ""), fenced: stmt.includes("linkFenceSql(") };
    }));
    expect(sites.sort((a, b) => a.file.localeCompare(b.file))).toEqual([{ file: "b4-flux.ts", fenced: true }, { file: "flux-link.ts", fenced: true }]);
    const link = src("flux-link.ts");
    expect(link.slice(link.indexOf("export async function ensureOwnerLinked"), link.indexOf("INSERT OR IGNORE INTO flux_links"))).toMatch(/linkFenceSql\("\?1", "\?4", "\?5"\)|emailVerified: true/);
    expect(link).toMatch(/ensure\(\{ murageAccountId: ownerId, email, emailVerified: true \}\)/);
    expect(link).not.toMatch(/email_verified_at IS \?\d/); // the false branch is gone
    // The fence: a TRUE stamp for the address and revision, no dispute, no link.
    const fence = link.slice(link.indexOf("export const linkFenceSql"), link.indexOf("export const LINK_RESOLVES_SQL"));
    for (const part of ["NOT EXISTS (SELECT 1 FROM flux_links", "NOT EXISTS (SELECT 1 FROM flux_email_proof_disputes", "s.email_verified_at IS NOT NULL", "s.email_verified_for=${addr}", "s.email_revision=${rev}"]) {
      expect(fence).toContain(part);
    }
    // One funnel: only flux-grants.ts ensureOwnerAccount calls ensureOwnerLinked; ensureFluxAccount is only ever its callback.
    expect(Object.entries(sources).filter(([, t]) => /ensureOwnerLinked\(/.test(t)).map(([p]) => p.replace("../src/", "")).sort()).toEqual(["flux-grants.ts", "flux-link.ts"]);
    // ensureFluxAccount is only ever the ensure callback: in an ensureOwnerAccount call, or the b4 client's ensureAccount, itself only passed
    // to ensureOwnerAccount.
    const callers = Object.entries(sources).flatMap(([p, t]) => [...t.matchAll(/(?<!function )ensureFluxAccount\(env/g)].map((m) => {
      const before = t.slice(Math.max(0, m.index! - 300), m.index!);
      return { file: p.replace("../src/", ""), via: /ensureOwnerAccount\([^;]*\(a\) => $/.test(before) ? "ensureOwnerAccount" : /ensureAccount[^;]*$/.test(before) ? "client" : "other" };
    }));
    expect(callers.filter((c) => c.via === "other")).toEqual([]);
    for (const m of src("b4-flux.ts").matchAll(/ensureAccount!\(a\)/g)) {
      expect(src("b4-flux.ts").slice(Math.max(0, m.index! - 120), m.index!)).toMatch(/ensureOwnerAccount\([^;]*\(a\) => flux\.$/);
    }
  });
});

describe("runbook: the hand re-point rule (ITEM4-FIX2 section 1)", () => {
  it("a hand re-point is link-only on MurageMain's word per case; hand operations NEVER change the sign-in; ONLY the reviewed relink route may", () => {
    const esc = runbook.slice(runbook.indexOf("## Escalate to Sean"));
    expect(esc).toContain("At launch a hand re-point is ALWAYS link-only.");
    expect(esc).toContain("only on MurageMain's word for each case");
    expect(esc).toContain("Hand operations NEVER change the buyer's Flux sign-in email.");
    expect(esc).toContain("ONLY the reviewed relink route");
    expect(esc).toContain("may move a sign-in");
    expect(esc).toContain("Wait for the relink route; no hand move. Tell the buyer we will move their Flux sign-in once that is ready. Post it in the Cloud alerts channel for its owner (MurageCloud); Sean only if money is involved.");
    for (const gone of ["provenance", "created no later than", "old sign-ins are ended"]) expect(runbook).not.toContain(gone);
  });
  it("a dispute is posted in the Cloud alerts channel for MurageCloud; Sean is paged only on money or a linked account; the mismatch page says the same", () => {
    const disp = runbook.slice(runbook.indexOf("## Someone else's email (dispute)"), runbook.indexOf("## Never"));
    expect(disp).toContain("and post it in the Cloud alerts channel for its owner (MurageCloud). Sean is paged only if money is involved or the account is already linked (then the route raises the page credit.email_proof_disputed itself).");
    expect(disp).not.toContain("and page Sean");
    expect(disp).toContain("After the clear the buyer asks for a new code on the card. If a clear returns cleared:false with reason newer_dispute, a newer dispute arrived: read it, then decide again. With reason no_dispute there was no dispute left to clear.");
    const esc = runbook.slice(runbook.indexOf("## Escalate to Sean"));
    expect(esc).not.toContain("- Any dispute.");
    expect(esc).toContain("- A dispute only if money is involved or the account is already linked (the route raises the page credit.email_proof_disputed). Every other dispute is posted in the Cloud alerts channel for its owner (MurageCloud); Sean is not paged for it.");
    const mismatch = "It is an automatic page to the Cloud alerts channel for its owner (MurageCloud), and to Sean personally only if money is involved. Flux (FluxMain) re-points the link on MurageMain's word, and that decision is posted in the same channel. Do not change anything yourself.";
    expect(esc).toContain(mismatch);
    const tier = alertTier("flux.link_email_mismatch_unlinked");
    expect(tier.tier).toBe("page");
    if (tier.tier === "page") { expect(tier.action).toContain(mismatch); expect(tier.action).not.toContain("Page Sean"); }
    expect(alertTier("credit.email_proof_disputed").tier).toBe("page");
  });
});

describe("CLOUD-DISPUTE-UNLINKED-DIGEST (MurageMain 11-03): an unlinked dispute raises one digest item, never a page", () => {
  const KIND = "credit.email_proof_disputed_unlinked";
  const alerts = async () => (await env.DB.prepare("SELECT id,kind,severity,subject,home_id,resolved_at,detail FROM cloud_alerts ORDER BY id").all<{
    id: string; kind: string; severity: string; subject: string; home_id: string; resolved_at: number | null; detail: string }>()).results;
  const dispute = () => op("dispute", { account_id: OWNER, note: "not my email", by: "ops" });

  it("an unlinked dispute raises exactly one digest alert of the new kind and no page; a repeat adds nothing", async () => {
    expect(await (await dispute())!.json()).toEqual({ linked: false, disputed: true });
    const a = await alerts();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ id: `alert:email_proof_disputed_unlinked:${OWNER}`, kind: KIND, subject: `account:${OWNER}`, home_id: HOME, resolved_at: null });
    expect(a[0]!.severity).toBe("info");
    expect(JSON.parse(a[0]!.detail)).toMatchObject({ accountId: OWNER, owner: "MurageCloud" });
    expect(a[0]!.detail).toContain("Someone follows up with the buyer within a day.");
    expect(a.filter((r) => isPageKind(r.kind))).toEqual([]);
    clock += 60_000;
    expect(await (await dispute())!.json()).toEqual({ linked: false, disputed: true });
    expect(await alerts()).toEqual(a);
  });
  it("dispute-clear resolves it", async () => {
    await dispute();
    clock += 60_000;
    expect(await (await op("dispute-clear", { account_id: OWNER, by: "ops" }))!.json()).toEqual({ cleared: true });
    const a = await alerts();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: KIND, resolved_at: clock });
    // No dispute row at all: its own reason, not newer_dispute.
    expect(await (await op("dispute-clear", { account_id: OWNER, by: "ops" }))!.json()).toEqual({ cleared: false, reason: "no_dispute" });
  });
  it("dispute, clear, dispute again: the same row is OPEN again with a fresh raised_at; an open repeat adds no row and keeps raised_at", async () => {
    await dispute();
    const first = clock;
    clock += 60_000;
    expect(await (await op("dispute-clear", { account_id: OWNER, by: "ops" }))!.json()).toEqual({ cleared: true });
    clock += 60_000;
    const again = clock;
    expect(await (await dispute())!.json()).toEqual({ linked: false, disputed: true });
    const raised = async () => (await env.DB.prepare("SELECT id,severity,resolved_at AS r,raised_at AS t FROM cloud_alerts WHERE kind=?").bind(KIND).all()).results;
    expect(await raised()).toEqual([{ id: `alert:email_proof_disputed_unlinked:${OWNER}`, severity: "info", r: null, t: again }]);
    expect(again).not.toBe(first);
    clock += 60_000;
    await dispute();
    expect(await raised()).toEqual([{ id: `alert:email_proof_disputed_unlinked:${OWNER}`, severity: "info", r: null, t: again }]);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts")).toBe(1);
  });
  it("a DIFFERENT newer dispute landing between dispute-clear's read and its batch: reason newer_dispute with the exact message, alert OPEN, not lifted", async () => {
    await dispute();
    clock += 60_000;
    const clear = () => fluxEmailProofOperatorRoute(new Request("https://cp.test/v1/internal/flux/email-proof/dispute-clear", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: OWNER, by: "ops" }) }), e, "dispute-clear",
      deps({ beforeClearBatch: async () => { clock += 1_000; await op("dispute", { account_id: OWNER, note: "a second ticket", by: "ops2" }); } }));
    expect(await (await clear()).json()).toEqual({ cleared: false, reason: "newer_dispute", message: "A newer dispute arrived. Read it, then decide again." });
    expect(await env.DB.prepare("SELECT note,by FROM flux_email_proof_disputes WHERE account_id=?").bind(OWNER).first()).toEqual({ note: "a second ticket", by: "ops2" });
    const a = await alerts();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: KIND, severity: "info", resolved_at: null });
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_proof_audit WHERE act='dispute_clear'")).toBe(0);
  });
  it("DISPUTE-CLEAR-SAME-MS-IDENTICAL is closed by the dispute version: an identical dispute rewritten in the same millisecond between the read and the batch is NOT cleared", async () => {
    // Before DISPUTE-FENCE-ACCOUNT the clear matched on note, by, revision and at, so an identical rewrite in the same millisecond was lifted
    // (an accepted residual). The account-level dispute carries a version that rises on every dispute, so the rewrite is a newer dispute now.
    await dispute();
    const clear = () => fluxEmailProofOperatorRoute(new Request("https://cp.test/v1/internal/flux/email-proof/dispute-clear", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: OWNER, by: "ops" }) }), e, "dispute-clear",
      deps({ beforeClearBatch: async () => { expect(await (await dispute())!.json()).toEqual({ linked: false, disputed: true }); } }));
    expect(await (await clear()).json()).toMatchObject({ cleared: false, reason: "newer_dispute" });
    expect(await env.DB.prepare("SELECT 1 AS x FROM flux_email_proof_disputes WHERE account_id=?").bind(OWNER).first()).not.toBeNull();
    const a = await alerts();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: KIND, resolved_at: null });
  });
  it("a linked dispute still raises only the high page and no digest item", async () => {
    await env.DB.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,'flux-theirs',1,'flux-theirs',1,0)").bind(OWNER).run();
    expect(await (await dispute())!.json()).toEqual({ linked: true, alerted: true, unlinked: false });
    const a = await alerts();
    expect(a.map((r) => [r.kind, r.severity])).toEqual([["credit.email_proof_disputed", "high"]]);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind=?", KIND)).toBe(0);
  });
});

describe("ITEM 9 (Astra launch-int Mediums M1, M3, M5): the proof mail obligation and the 24 h page", () => {
  const DAY = 24 * 60 * 60_000;
  const provisioning = (home = HOME) => env.DB.prepare(`INSERT INTO billing_subscriptions (home_id,customer_id,subscription_id,plan,status,created_at,updated_at)
    VALUES (?,'cus_fp',?,'starter','active',1,1)`).bind(home, `sub_${home}`).run();
  const marker = () => env.DB.prepare("SELECT state,tries,first_at AS f FROM flux_email_proof_autosend WHERE account_id=?").bind(OWNER).first<{ state: string; tries: number; f: number }>();
  const pages = () => env.DB.prepare("SELECT id,resolved_at AS r FROM cloud_alerts WHERE kind='credit.email_unverified_hold' AND subject=?").bind(`account:${OWNER}`)
    .all<{ id: string; r: number | null }>().then((x) => x.results);
  beforeEach(async () => { await provisioning(); });

  it("M1: a checkout during a Flux credential outage keeps the obligation: the code goes once Flux is ready, and the 24 h page still works", async () => {
    const t0 = clock;
    const outage = envWith({ FLUX_CLOUD_GRANTS_TOKEN: undefined });
    expect(await autoSendProof(outage, OWNER, deps())).toBe("skipped");
    expect(mail).toHaveLength(0);
    expect(await marker()).toEqual({ state: "queued", tries: 1, f: t0 });
    // Still out: nothing sent, still owed.
    clock += 60_000;
    expect(await sweepFluxEmailAutoSend(outage, deps())).toBe(0);
    expect(await marker()).toMatchObject({ state: "queued" });
    // The credentials recover: the sweep sends the one code; later sweeps send nothing more.
    clock += 60_000;
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(1);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.to).toBe(ADDR);
    expect(await marker()).toEqual({ state: "sent", tries: 1, f: t0 });
    clock += 60_000;
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(0);
    expect(mail).toHaveLength(1);
    clock = t0 + DAY;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(1);
    expect(await pages()).toEqual([{ id: `alert:email_unverified_hold:${OWNER}:0`, r: null }]);
  });

  it("M1: a queued row whose customer proved, linked or ended meanwhile is skipped for good, never sent", async () => {
    const outage = envWith({ CLOUD_FLUX_ROUTES_ENABLED: undefined });
    expect(await autoSendProof(outage, OWNER, deps())).toBe("skipped");
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled'").run();
    clock += 60_000;
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(0);
    expect(await marker()).toMatchObject({ state: "skipped" });
    expect(mail).toHaveLength(0);
  });

  it("M3: no page for an ended customer (canceled subscription or deleted home); an open page resolves when the customer ends", async () => {
    const t0 = clock;
    expect(await autoSendProof(e, OWNER, deps())).toBe("sent");
    clock = t0 + DAY;
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled'").run();
    expect(await sweepFluxEmailStuck(e, deps())).toBe(0);
    expect(await pages()).toEqual([]);
    await env.DB.prepare("UPDATE billing_subscriptions SET status='active'").run();
    expect(await sweepFluxEmailStuck(e, deps())).toBe(1);
    expect(await pages()).toEqual([{ id: `alert:email_unverified_hold:${OWNER}:0`, r: null }]);
    // The home is deleted: the open page resolves on the next tick and is not raised again.
    clock += 60_000;
    await env.DB.prepare("UPDATE cloud_homes SET desired_state='deleted' WHERE id=?").bind(HOME).run();
    expect(await sweepFluxEmailStuck(e, deps())).toBe(0);
    expect(await pages()).toEqual([{ id: `alert:email_unverified_hold:${OWNER}:0`, r: clock }]);
    clock += DAY;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(0);
    expect(await pages()).toHaveLength(1);
  });

  it.each(["past_due", "unpaid"])("M3: a buyer whose subscription is %s is still paying: the 24 h page still raises", async (status) => {
    const t0 = clock;
    expect(await autoSendProof(e, OWNER, deps())).toBe("sent");
    await env.DB.prepare("UPDATE billing_subscriptions SET status=?").bind(status).run();
    clock = t0 + DAY;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(1);
    expect(await pages()).toEqual([{ id: `alert:email_unverified_hold:${OWNER}:0`, r: null }]);
  });

  it("M5: the checkout only queues; a queued row is sent by the sweep exactly once, however many sweeps race", async () => {
    expect(await queueAutoSendProof(e, OWNER, deps())).toBe(0);
    expect(await queueAutoSendProof(e, OWNER, deps())).toBeNull(); // a second delivery queues nothing
    expect(mail).toHaveLength(0);
    expect(await marker()).toMatchObject({ state: "queued", tries: 1 });
    const sent = await Promise.all([sweepFluxEmailAutoSend(e, deps()), sweepFluxEmailAutoSend(e, deps()), sweepFluxEmailAutoSend(e, deps())]);
    expect(sent.reduce((a, b) => a + b, 0)).toBe(1);
    expect(mail).toHaveLength(1);
    expect(await marker()).toMatchObject({ state: "sent", tries: 1 });
    clock += DAY;
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(0);
    expect(mail).toHaveLength(1);
  });

  it("M5: the 24 h page keys off the marker's first_at, set when the checkout queued it, never moved by the send", async () => {
    const t0 = clock;
    expect(await queueAutoSendProof(e, OWNER, deps())).toBe(0);
    clock = t0 + 10 * 60_000;
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(1);
    expect(await marker()).toEqual({ state: "sent", tries: 1, f: t0 });
    clock = t0 + DAY - 1;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(0);
    clock = t0 + DAY;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(1);
  });

  it("M5 (r2 H1): a mailer that never answers stops holding the request after the send timeout: delivery unknown, the code stays live, no retry", async () => {
    const hung = deps({ emailSender: () => ({ send: () => new Promise<void>(() => undefined) }), sendTimeoutMs: 50 });
    const started = Date.now();
    expect(await autoSendProof(e, OWNER, hung)).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await marker()).toMatchObject({ state: "sent", tries: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM flux_email_proof WHERE account_id=? AND consumed_at IS NULL", OWNER)).toBe(1);
  });

  it("r2 H1 (a): a timed-out send that WAS delivered: one code, still valid, and no second mail from the sweep", async () => {
    // The provider takes the mail (the buyer gets it) but never acknowledges within the timeout.
    const late = deps({ sendTimeoutMs: 50, emailSender: () => ({ send: (m) => { mail.push({ to: m.to, text: m.text, from: m.from.name }); return new Promise<void>(() => undefined); } }) });
    expect(await autoSendProof(e, OWNER, late)).toBe("unknown");
    expect(mail).toHaveLength(1);
    const code = lastCode();
    // The card shows the code box AND "Send a new code" from the start: needed, with the live challenge.
    const live = (await env.DB.prepare("SELECT id FROM flux_email_proof WHERE account_id=?").bind(OWNER).first<{ id: string }>())!.id;
    expect(await proofState(e, OWNER, clock)).toEqual({ needed: true, blocked: true, challengeId: live });
    clock += 60_000;
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(0);
    clock += 2 * 60_000;
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(0);
    expect(mail).toHaveLength(1);
    expect(await verify(code)).toBe("stamped");
  });

  it("r2 H1 (b): a send that never left: the buyer presses Send a new code and gets a fresh code, within the rate limit", async () => {
    const hung = deps({ emailSender: () => ({ send: () => new Promise<void>(() => undefined) }), sendTimeoutMs: 50 });
    expect(await autoSendProof(e, OWNER, hung)).toBe("unknown");
    expect(mail).toHaveLength(0);
    // The card is up with a live code box and the button.
    expect((await proofState(e, OWNER, clock)).challengeId).not.toBeNull();
    // Inside the 30 s gap: refused (the quota still applies).
    expect(await issueChallenge(e, OWNER, deps(), { provisioning: true })).toMatchObject({ kind: "limited" });
    clock += PROOF_SEND_GAP_MS;
    expect(await issueChallenge(e, OWNER, deps(), { provisioning: true })).toMatchObject({ kind: "sent", delivery: "sent" });
    expect(mail).toHaveLength(1);
    expect(await verify(lastCode())).toBe("stamped");
  });

  it("r2 H1 (c): the sweep never replaces a live code: the buyer's own code survives a queued auto-send", async () => {
    expect(await queueAutoSendProof(e, OWNER, deps())).toBe(0);
    // The buyer presses Send a new code before the queued mail went.
    expect(await issueChallenge(e, OWNER, deps(), { provisioning: true })).toMatchObject({ kind: "sent" });
    expect(mail).toHaveLength(1);
    const code = lastCode();
    clock += PROOF_SEND_GAP_MS + 1_000;
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(0);
    clock += 2 * 60_000;
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(0);
    expect(mail).toHaveLength(1);
    expect(await marker()).toMatchObject({ state: "skipped" });
    expect(await verify(code)).toBe("stamped");
  });

  it("r2 H2 (second guard): a queued marker is not claimed while a billing lease of the account's home is held", async () => {
    expect(await queueAutoSendProof(e, OWNER, deps())).toBe(0);
    const lease = (await acquireHomeLease(e, HOME, "holder-1"))!;
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(0);
    expect(mail).toHaveLength(0);
    expect(await marker()).toMatchObject({ state: "queued" });
    await releaseHomeLease(e, lease);
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(1);
    expect(mail).toHaveLength(1);
  });

  it("r2 H3: a page resolved because the customer ended REOPENS when a paying home returns at the same address revision", async () => {
    const t0 = clock;
    expect(await autoSendProof(e, OWNER, deps())).toBe("sent");
    clock = t0 + DAY;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(1);
    // Ended: resolved.
    clock += 60_000;
    await env.DB.prepare("UPDATE billing_subscriptions SET status='canceled'").run();
    expect(await sweepFluxEmailStuck(e, deps())).toBe(0);
    expect(await pages()).toEqual([{ id: `alert:email_unverified_hold:${OWNER}:0`, r: clock }]);
    // Re-buy at the same email revision, still unproven past 24 h: the same page is open again, delivered afresh.
    clock += 60_000;
    await env.DB.prepare("UPDATE billing_subscriptions SET status='active'").run();
    expect(await sweepFluxEmailStuck(e, deps())).toBe(1);
    expect(await pages()).toEqual([{ id: `alert:email_unverified_hold:${OWNER}:0`, r: null }]);
    expect(await env.DB.prepare("SELECT raised_at AS at, delivered_at AS d FROM cloud_alerts WHERE id=?").bind(`alert:email_unverified_hold:${OWNER}:0`).first())
      .toEqual({ at: clock, d: null });
    // A proof resolves it for good: no reopen.
    await stamp();
    await env.DB.prepare("UPDATE cloud_alerts SET resolved_at=? WHERE kind='credit.email_unverified_hold'").bind(clock).run();
    clock += DAY;
    expect(await sweepFluxEmailStuck(e, deps())).toBe(0);
  });

  it("r3 (Astra High): 50 older accounts whose page was resolved other than 'ended' never starve a newer paying buyer past 24 h", async () => {
    for (let i = 0; i < STUCK_PER_TICK; i++) {
      await seedIdentity(`user-fp-r${i}`, `sub-fp-r${i}`, `r${i}@example.test`);
      await seedHome(`home-fp-r${i}`, `user-fp-r${i}`);
      await provisioning(`home-fp-r${i}`);
      await env.DB.prepare("INSERT INTO flux_email_proof_autosend (account_id,email_revision,state,tries,at,first_at) VALUES (?,0,'sent',1,?,?)")
        .bind(`user-fp-r${i}`, clock - 2 * DAY - i, clock - 2 * DAY - i).run();
      // Resolved by hand (no resolvedBy 'ended'): never reopens for this revision.
      await env.DB.prepare(`INSERT INTO cloud_alerts (id,home_id,kind,severity,detail,raised_at,subject,resolved_at)
        VALUES (?,?,'credit.email_unverified_hold','high','{}',1,?,2)`).bind(`alert:email_unverified_hold:user-fp-r${i}:0`, `home-fp-r${i}`, `account:user-fp-r${i}`).run();
    }
    await env.DB.prepare("INSERT INTO flux_email_proof_autosend (account_id,email_revision,state,tries,at,first_at) VALUES (?,0,'sent',1,?,?)")
      .bind(OWNER, clock - DAY, clock - DAY).run();
    expect(await sweepFluxEmailStuck(e, deps())).toBe(1);
    expect(await pages()).toEqual([{ id: `alert:email_unverified_hold:${OWNER}:0`, r: null }]);
    expect(await count("SELECT COUNT(*) AS n FROM cloud_alerts WHERE kind='credit.email_unverified_hold' AND resolved_at IS NULL")).toBe(1);
  });

  it.each(["failed", "sending"])("r3 (Astra Medium): a %s auto-send's retry is not claimed while a billing lease is held; once released it sends", async (state) => {
    const failing = deps({ emailSender: () => ({ async send() { throw new Error("mail down"); } }) });
    expect(await autoSendProof(e, OWNER, failing)).toBe("failed");
    await env.DB.prepare("UPDATE flux_email_proof_autosend SET state=? WHERE account_id=?").bind(state, OWNER).run();
    clock += 10 * 60_000; // due as a failed retry and as a stale sending row
    const lease = (await acquireHomeLease(e, HOME, "holder-1"))!;
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(0);
    expect(mail).toHaveLength(0);
    expect(await marker()).toMatchObject({ state, tries: 1 });
    await releaseHomeLease(e, lease);
    expect(await sweepFluxEmailAutoSend(e, deps())).toBe(1);
    expect(mail).toHaveLength(1);
    expect(await marker()).toMatchObject({ state: "sent", tries: 2 });
  });
});
