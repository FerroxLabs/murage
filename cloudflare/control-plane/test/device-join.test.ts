// SPDX-License-Identifier: AGPL-3.0-or-later
// Door device confirmation (src/device-join.ts, migration 0135, DOOR_JOIN_REQUIRED) with the r8 corrections.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { releaseItem9HoldForTests } from "../src/held-until-item9-highs";
// ITEM 9: this suite exercises the join switched on; the launch guard (held-until-item9-highs.ts) is released here only.
beforeAll(() => releaseItem9HoldForTests(true));
afterAll(() => releaseItem9HoldForTests(false));
import { doorReadySql } from "../src/b3-control";
import { cancelJoin, ensureLaterJoin, hasUsedRow, joinRequired, JOIN_MAIL_PER_DAY, JOIN_MAIL_PER_HOUR, liveLaterJoin, noteHomeHadComputer, revokeBinds, settleFirstRows,
  sweepDeviceJoins, takeJoinMail, ticketStatements, cancelMark, type JoinRow } from "../src/device-join";
import { cloudMember } from "./cloud-member";
import { serverReadyData } from "../src/legal-flows";
import { pairingRoute } from "../src/pairing";
import { commitToken, DEVICE_JOIN_EMAIL_GEN, issueToken, verifyToken, whenConsumed, type IdentityRead, type TokenDeps } from "../src/public-tokens";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = 1_790_000_000_000;
const USER = "5f0c1b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const HOME = "home-join";
const B1 = "a".repeat(64);
const B2 = "b".repeat(64);
/** The test env with some vars set, without writing through to the shared bindings object. */
const withEnv = (over: Record<string, string>) => new Proxy(env, { get: (t, k) => (typeof k === "string" && k in over ? over[k] : (t as never)[k]) }) as Env;
const on = withEnv({ DOOR_JOIN_REQUIRED: "1" });

let supa: IdentityRead;
let readerDown = false;
let clock = T0;
const reader = { async emailGen(id: string): Promise<IdentityRead> { if (readerDown) throw new Error("down"); return { ...supa, id }; } };
const deps = (): TokenDeps => ({ now: () => clock, reader });

beforeEach(async () => {
  supa = { id: USER, email: "pat@example.test", updatedAt: "u1" };
  readerDown = false; clock = T0;
  for (const t of ["cloud_device_joins", "cloud_door_desktop_tickets", "cloud_device_join_mail", "cloud_recovery_holds", "verify_tokens", "cloud_homes"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.prepare(`INSERT INTO cloud_homes (id,installation_id,owner_id,desired_state,observed_state,image_digest,home_key,generation,created_at,updated_at)
    VALUES (?,?,?,'ready','ready','sha256:x','k',3,?,?)`).bind(HOME, "inst-j", USER, T0, T0).run();
});

const mk = (id = "j1", over: Partial<Record<string, unknown>> = {}) => {
  const r: Record<string, unknown> = { id, account_id: USER, email: "pat@example.test", home_id: HOME, generation: 3, kind: "desktop", tier: "later", state: "waiting", created_at: T0, ...over };
  return env.DB.prepare(`INSERT INTO cloud_device_joins (id,account_id,email,home_id,generation,kind,tier,state,created_at,hold_until,mail_sent_at,ready_at,redeemed_bind,last_ticket_exp,cancel_until)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(r.id, r.account_id, r.email, r.home_id, r.generation, r.kind, r.tier, r.state, r.created_at, r.hold_until ?? null,
    r.mail_sent_at ?? null, r.ready_at ?? null, r.redeemed_bind ?? null, r.last_ticket_exp ?? null, r.cancel_until ?? 0).run();
};
const row = (id: string) => env.DB.prepare("SELECT * FROM cloud_device_joins WHERE id=?").bind(id).first<JoinRow & Record<string, unknown>>();
const ticket = (nonce: string, bind: string, issuedAt: number) => env.DB.prepare(
  "INSERT INTO cloud_door_desktop_tickets (home_id,bind,nonce,join_id,issued_at,expires_at,retain_until) VALUES (?,?,?,NULL,?,?,?)").bind(HOME, bind, nonce, issuedAt, issuedAt + 60_000, issuedAt + 15 * DAY).run();
const dj = (id: string, purpose: "confirm" | "repudiate", email = "pat@example.test", accountId = USER) => issueToken(env, deps(),
  { purpose, subjectKind: "device_join", subjectId: id, accountId, accountEmail: email, supabaseUpdatedAt: DEVICE_JOIN_EMAIL_GEN, receivedAt: clock }, { ttlMs: 14 * DAY }).then((t) => {
  const [selector, secret] = t!.token.split("."); return { selector, secret };
});

describe("device_join links", () => {
  it("compare the email only: an updated_at that moved (an ordinary sign-in) does not kill a Yes link", async () => {
    const t = await dj("j1:1", "confirm", "pat@example.test", (await cloudMember("pat-dj@example.test")).userId);
    supa = { ...supa, updatedAt: "u2-after-sign-in" };
    expect((await verifyToken(env, deps(), t.selector, t.secret, "confirm")).ok).toBe(true);
    supa = { ...supa, email: "someone-else@example.test" };
    expect(await verifyToken(env, deps(), t.selector, t.secret, "confirm")).toMatchObject({ ok: false, code: "identity_changed" });
  });
  it("No and Remove skip the identity reader; Yes fails closed when it is down", async () => {
    const no = await dj("j1:1", "repudiate"); const yes = await dj("j1:2", "confirm", "pat@example.test", (await cloudMember("pat-dj@example.test")).userId);
    readerDown = true;
    expect((await verifyToken(env, deps(), no.selector, no.secret, "repudiate", undefined, { skipIdentity: true })).ok).toBe(true);
    expect(await verifyToken(env, deps(), yes.selector, yes.secret, "confirm")).toMatchObject({ ok: false, code: "identity_unavailable" });
  });
  it("Yes reads the identity of the mapped Supabase sub; an account with no mapping is unavailable", async () => {
    const m = await cloudMember("pat-dj@example.test");
    const asked: string[] = [];
    const spy: TokenDeps = { now: () => clock, reader: { async emailGen(id: string) { asked.push(id); return { ...supa, id }; } } };
    const yes = await dj("j1:3", "confirm", "pat@example.test", m.userId);
    expect((await verifyToken(env, spy, yes.selector, yes.secret, "confirm")).ok).toBe(true);
    expect(asked).toEqual([m.sub]);
    const orphan = await dj("j1:4", "confirm", "pat@example.test", "no-such-account");
    expect(await verifyToken(env, spy, orphan.selector, orphan.secret, "confirm")).toMatchObject({ ok: false, code: "identity_unavailable" });
  });
  it("need an explicit ttl, and a device_join subject must use the constant email_gen", async () => {
    const b = { purpose: "repudiate" as const, subjectKind: "device_join" as const, subjectId: "j:1", accountId: USER, accountEmail: "p@x.test", receivedAt: T0 };
    await expect(issueToken(env, deps(), { ...b, supabaseUpdatedAt: DEVICE_JOIN_EMAIL_GEN })).rejects.toThrow("invalid_binding");
    await expect(issueToken(env, deps(), { ...b, supabaseUpdatedAt: "u1" }, { ttlMs: 1000 })).rejects.toThrow("invalid_binding");
    const t = await issueToken(env, deps(), { ...b, supabaseUpdatedAt: DEVICE_JOIN_EMAIL_GEN }, { ttlMs: 1000 });
    expect(t!.expiresAt).toBe(T0 + 1000);
  });
  it("a resend (its own subject id) leaves the earlier No link working", async () => {
    const first = await dj("j1:1", "repudiate"); await dj("j1:2", "repudiate");
    expect((await verifyToken(env, deps(), first.selector, first.secret, "repudiate", undefined, { skipIdentity: true })).ok).toBe(true);
  });
  it("one press wins: the second press of the same link is used", async () => {
    const t = await dj("j1:1", "repudiate");
    const v = await verifyToken(env, deps(), t.selector, t.secret, "repudiate", undefined, { skipIdentity: true });
    if (!v.ok) throw new Error("x");
    expect((await commitToken(env, v, { now: () => clock, extra: () => [["SELECT 1", []]] })).won).toBe(true);
    expect(await verifyToken(env, deps(), t.selector, t.secret, "repudiate", undefined, { skipIdentity: true })).toMatchObject({ ok: false, code: "link_used" });
    void whenConsumed;
  });
});

describe("tiers and joins", () => {
  it("a used row makes the home later for good, written once", async () => {
    expect(await hasUsedRow(env.DB, HOME)).toBe(false);
    await noteHomeHadComputer(env.DB, USER, "p@x.test", HOME, 3, T0);
    await noteHomeHadComputer(env.DB, USER, "p@x.test", HOME, 4, T0 + 1);
    expect(await hasUsedRow(env.DB, HOME)).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_device_joins WHERE home_id=?").bind(HOME).first<{ n: number }>())!.n).toBe(1);
  });
  it("one live later join per home, whoever asks; it holds no key", async () => {
    const a = { accountId: USER, email: "p@x.test", homeId: HOME, generation: 3, kind: "desktop" as const, place: null };
    const one = await ensureLaterJoin(env, a, T0); const two = await ensureLaterJoin(env, a, T0 + 5);
    expect(one.created).toBe(true); expect(two.created).toBe(false); expect(two.join.id).toBe(one.join.id);
    expect(two.join.redeemed_bind).toBeNull();
    await expect(mk("j9")).rejects.toThrow();
  });
  it("a first ticket writes one ticketed row and the ticket row, and never after a used row", async () => {
    const t = { homeId: HOME, accountId: USER, email: "p@x.test", generation: 3, bind: B1, nonce: "n1", issuedAt: T0, expiresAt: T0 + 60_000, tier: "first" as const, joinId: null };
    await env.DB.batch(ticketStatements(env.DB, t));
    await env.DB.batch(ticketStatements(env.DB, { ...t, nonce: "n2", bind: B2 }));
    const rows = (await env.DB.prepare("SELECT * FROM cloud_device_joins WHERE home_id=?").bind(HOME).all<JoinRow>()).results;
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ tier: "first", state: "ticketed", redeemed_bind: B2 });
    await settleFirstRows(env.DB, HOME, [{ scope: "owner-desktop", bind: B2 }], T0 + 1000);
    expect((await row(rows[0].id))!.state).toBe("used");
    await env.DB.batch(ticketStatements(env.DB, { ...t, nonce: "n3" }));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_device_joins WHERE state='ticketed'").first<{ n: number }>())!.n).toBe(0);
  });
  it("a first row with no device after its last ticket ends, and the home is still first", async () => {
    await env.DB.batch(ticketStatements(env.DB, { homeId: HOME, accountId: USER, email: "p@x.test", generation: 3, bind: B1, nonce: "n1", issuedAt: T0, expiresAt: T0 + 60_000, tier: "first", joinId: null }));
    await settleFirstRows(env.DB, HOME, [], T0 + DAY);
    expect(await hasUsedRow(env.DB, HOME)).toBe(false);
    expect((await env.DB.prepare("SELECT state FROM cloud_device_joins WHERE home_id=?").bind(HOME).first<{ state: string }>())!.state).toBe("ended");
  });
});

describe("mail budget", () => {
  it("3 an hour and 10 a day per home, apart from the notice slots", async () => {
    for (let i = 0; i < JOIN_MAIL_PER_HOUR; i++) expect(await takeJoinMail(env.DB, HOME, T0 + i)).toBe(true);
    expect(await takeJoinMail(env.DB, HOME, T0 + 10)).toBe(false);
    let n = JOIN_MAIL_PER_HOUR;
    for (let h = 1; h < 8; h++) for (let i = 0; i < JOIN_MAIL_PER_HOUR; i++) if (await takeJoinMail(env.DB, HOME, T0 + h * 61 * 60_000 + i)) n++;
    expect(n).toBe(JOIN_MAIL_PER_DAY);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_door_notice_slots WHERE home_id=?").bind(HOME).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("No and Remove (r8)", () => {
  it("reach only keys issued from the join's start, never one issued before; an older customer hold keeps running", async () => {
    await mk("j1", { created_at: T0 + 1000, state: "waiting" });
    await ticket("old", B1, T0 - 1000); await ticket("during", B2, T0 + 2000);
    const mkHold = (id: string, started: number) => env.DB.prepare(`INSERT INTO cloud_recovery_holds (id,home_id,generation,action,reason,started_at,completes_at,source) VALUES (?,?,3,'pair','t',?,?,'customer')`)
      .bind(id, HOME, started, started + 72 * HOUR).run();
    await mkHold("hold-old", T0 - HOUR).catch(() => {}); await mkHold("hold-new", T0 + 5000).catch(() => {});
    expect(await cancelJoin(env, USER, HOME, "j1", T0 + 10_000)).toBe(true);
    const j = (await row("j1"))!;
    expect(j).toMatchObject({ state: "cancelled", needs_revoke: 1, ended_by: "my_cloud" });
    expect([...await revokeBinds(env.DB, j, T0 + 10_000)]).toEqual([B2]);
    expect(await cancelMark(env.DB, HOME)).toBe(T0 + 10_000);
    const holds = (await env.DB.prepare("SELECT id, canceled_at FROM cloud_recovery_holds").all<{ id: string; canceled_at: number | null }>()).results;
    if (holds.length) { expect(holds.find((h) => h.id === "hold-old")!.canceled_at).toBeNull(); expect(holds.find((h) => h.id === "hold-new")!.canceled_at).not.toBeNull(); }
  });
  it("a Remove on a first row makes the next computer later", async () => {
    await mk("f1", { tier: "first", state: "ticketed", redeemed_bind: B1 });
    expect(await cancelJoin(env, USER, HOME, "f1", T0 + 5)).toBe(true);
    expect(await hasUsedRow(env.DB, HOME)).toBe(true);
    expect(await cancelJoin(env, USER, HOME, "f1", T0 + 6)).toBe(false);
  });
  it("another account cannot cancel", async () => {
    await mk("j1");
    expect(await cancelJoin(env, "other-user", HOME, "j1", T0)).toBe(false);
  });
  it("ticket rows outlive the latest cancellation link (r8-1)", async () => {
    await mk("j1", { cancel_until: T0 + 20 * DAY });
    await ticket("t", B1, T0);
    await sweepDeviceJoins(on, T0 + 16 * DAY);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_door_desktop_tickets").first<{ n: number }>())!.n).toBe(1);
    await sweepDeviceJoins(on, T0 + 21 * DAY);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_door_desktop_tickets").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("sweep", () => {
  it("is inert with the switch off", async () => {
    await mk("j1", { mail_sent_at: T0, hold_until: T0 + 1 });
    expect(joinRequired(env)).toBe(false);
    expect(await sweepDeviceJoins(env, T0 + HOUR)).toBe(0);
    expect((await row("j1"))!.state).toBe("waiting");
  });
  it("Ready only after a mail went out and the hold ended; lapses 7 days after Ready", async () => {
    await mk("nomail", { state: "waiting", hold_until: null });
    await sweepDeviceJoins(on, T0 + 100 * HOUR);
    expect((await row("nomail"))!.state).toBe("waiting");
    await env.DB.prepare("DELETE FROM cloud_device_joins").run();
    await mk("j1", { mail_sent_at: T0, hold_until: T0 + 72 * HOUR });
    await sweepDeviceJoins(on, T0 + 71 * HOUR);
    expect((await row("j1"))!.state).toBe("waiting");
    await sweepDeviceJoins(on, T0 + 73 * HOUR);
    expect((await row("j1"))!.state).toBe("ready");
    await sweepDeviceJoins(on, T0 + 73 * HOUR + 8 * DAY);
    expect((await row("j1"))!.state).toBe("lapsed");
    expect(await liveLaterJoin(env.DB, HOME)).toBeNull();
  });
  it("a join whose home moved to another generation lapses", async () => {
    await mk("j1", { generation: 2, mail_sent_at: T0, hold_until: T0 + HOUR });
    await sweepDeviceJoins(on, T0 + 1000);
    expect((await row("j1"))!.state).toBe("lapsed");
  });
});

describe("pairing routes close with the switch on (410 use_connect)", () => {
  const paths: [string, string][] = [["POST", "/v1/homes/h1/pairing/start"], ["POST", "/v1/homes/h1/pairing/code"], ["POST", "/v1/homes/h1/pairing/device"],
    ["POST", "/v1/account/homes/h1/desktop-code"], ["POST", "/v1/pairing/desktop"]];
  for (const [m, p] of paths) {
    it(`${p}`, async () => {
      const err = await pairingRoute(new Request(`https://cp.test${p}`, { method: m, body: "{}" }), on, undefined as never).catch((e) => e);
      expect(err).toMatchObject({ status: 410, code: "use_connect" });
    });
  }
  it("is unchanged with the switch off", async () => {
    const res = await pairingRoute(new Request("https://cp.test/v1/pairing/desktop", { method: "POST", body: "{}" }), env, undefined as never).catch((e) => e);
    expect((res as Response).status ?? (res as { status: number }).status).not.toBe(410);
  });
});

describe("ready gate and words", () => {
  it("door_proof=1 is required only with both switches on", () => {
    const v2 = withEnv({ DOOR_V2_REQUIRED: "1" });
    const both = withEnv({ DOOR_V2_REQUIRED: "1", DOOR_JOIN_REQUIRED: "1" });
    const joinOnly = withEnv({ DOOR_JOIN_REQUIRED: "1" });
    expect(doorReadySql(v2)).toBe(" AND h.door_version='v2'");
    expect(doorReadySql(both)).toBe(" AND h.door_version='v2' AND h.door_proof=1");
    expect(doorReadySql(joinOnly)).toBe("");
    expect(doorReadySql(env)).toBe("");
  });
  it("the welcome email carries the My Cloud link with the switch on or off when the origin is valid, with no token and no dashes", async () => {
    const origin = { BILLING_RETURN_ORIGIN: "https://cloud.murage.test" };
    const offText = (await serverReadyData(withEnv(origin), HOME, T0, T0)).emailText as string;
    const onText = (await serverReadyData(withEnv({ ...origin, DOOR_JOIN_REQUIRED: "1" }), HOME, T0, T0)).emailText as string;
    for (const text of [offText, onText]) {
      expect(/Open Murage: (\S+)/.exec(text)?.[1]).toBe("https://cloud.murage.test/home/cloud");
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
    expect(onText).toBe(offText);
    // No valid origin: the link is left out, never defaulted.
    expect((await serverReadyData(withEnv({ BILLING_RETURN_ORIGIN: "http://insecure.test" }), HOME, T0, T0)).emailText as string).not.toContain("/home/cloud");
  });
});
