// Updates consent B1, the members area (design UPDATES-CONSENT-1020-CP-v5.md v5.6.1, 4.2 and 3.3 "AO and AF"), through the Worker's
// exported fetch with a real-shaped Supabase token, on real D1. Named by design test number (7.1).
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { subjectKey } from "../src/announcements";
import { createWorker } from "../src/index";
import { HTTPError } from "../src/http";
import { updatesMembersRoute } from "../src/updates-consent/members";
import { sendUpdatesOutbox } from "../src/updates-consent/routes";
import { emailKeyOf, sha256Hex } from "../src/updates-consent/tokens";
import { authFetch, cloudMember, jwksFetch, supabaseEnv, supabaseToken } from "./cloud-member";

const BASE = "https://auth.murage.test";
const TV = "site-news";
let seq = 0;
const addr = (tag: string) => `mem-${tag}-${++seq}-${crypto.randomUUID().slice(0, 8)}@example.test`;
const worker = createWorker(fetch, async () => new Response("{}"), {}, {}, {}, { jwksFetch, authFetch });

interface Mail { to: string; subject: string; text: string; headers?: Record<string, string> }
function setup(open = true) {
  const mails: Mail[] = [];
  const e = {
    ...env, ...supabaseEnv, MURAGE_ENV: "live",
    ...(open ? { UPDATES_SIGNUPS_OPEN: "1", CP_ONECLICK_DKIM_VERIFIED: "1" } : {}),
    EMAIL: { async send(m: Mail) { mails.push(m); } },
  } as unknown as Env;
  async function call(token: string | null, method: string, path = "/v1/updates-consent", body?: unknown) {
    const headers = new Headers({ "cf-connecting-ip": `198.51.100.${(++seq % 250) + 1}` });
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (body !== undefined) headers.set("content-type", "application/json");
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), e, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  const on = (token: string, answeredAt: number, extra: Record<string, unknown> = {}) =>
    call(token, "POST", "/v1/updates-consent", { status: "opted_in", textVersion: TV, answeredAt, ...extra });
  const off = (token: string, answeredAt: number) => call(token, "POST", "/v1/updates-consent", { status: "withdrawn", textVersion: TV, answeredAt });
  return { e, mails, call, on, off };
}

const count = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0;
const mailsFor = (userId: string) => count(`SELECT count(*) AS n FROM updates_mail_outbox m JOIN updates_consent c ON c.id=m.consent_id
  WHERE c.subject_id=?`, `account:${userId}`);
const obligationsFor = (userId: string) => count(`SELECT count(*) AS n FROM updates_obligations o JOIN updates_consent c ON c.id=o.consent_id
  WHERE c.subject_id=?`, `account:${userId}`);
const keyOf = (email: string) => emailKeyOf(email, env.BETTER_AUTH_SECRET);
/** The members request id: account, identity revision, answeredAt (B1 r1 Grok M4). */
const reqId = async (userId: string, answeredAt: number) => `acct:${userId}:${(await env.DB.prepare("SELECT email_revision AS r FROM supabase_identities WHERE user_id=?")
  .bind(userId).first<{ r: number }>())!.r}:${answeredAt}`;
async function event(email: string, kind: string, at = Date.now() - 60_000) {
  await env.DB.prepare("INSERT INTO updates_exclusion_events (email_key,kind,observed_at,source,ref,at) VALUES (?,?,?,'operator',NULL,?)")
    .bind(await keyOf(email), kind, at, at).run();
}
async function capMail(email: string, attempts = 3) {
  const k = await subjectKey("updates-prove-mail", await keyOf(email), env.BETTER_AUTH_SECRET);
  await env.DB.prepare(`INSERT INTO announcement_rate_limits (subject_key, window_started_at, attempts, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(subject_key) DO UPDATE SET window_started_at=excluded.window_started_at, attempts=excluded.attempts`).bind(k, Date.now(), attempts, Date.now()).run();
}
async function uncap(email: string) {
  const k = await subjectKey("updates-prove-mail", await keyOf(email), env.BETTER_AUTH_SECRET);
  await env.DB.prepare("DELETE FROM announcement_rate_limits WHERE subject_key=?").bind(k).run();
}

beforeEach(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO updates_consent_texts (version, locale, body, effective_from) VALUES (?, 'en', 'test words', 0)").bind(TV).run();
});

// Route tests run many Worker fetches each; on the shared test host (load 50 to 85) the 5 s default times out in files B1 never
// touches as well (handoff, side-by-side runs). 20 s keeps a slow host from reading as a failure without hiding a hang.
const ROUTE_TIMEOUT_MS = 20_000;

describe("members GET, POST and history (4.2)", { timeout: ROUTE_TIMEOUT_MS }, () => {
  it("401 without a member; GET with no row answers consent: null", async () => {
    const s = setup();
    expect((await s.call(null, "GET")).status).toBe(401);
    expect((await s.call(null, "POST", "/v1/updates-consent", { status: "opted_in", textVersion: TV, answeredAt: Date.now() })).status).toBe(401);
    const m = await cloudMember(addr("none"));
    expect(await (await s.call(m.token, "GET")).json()).toEqual({ consent: null, cloudContractVersion: 1 });
    expect(await (await s.call(m.token, "GET", "/v1/updates-consent/history")).json()).toEqual({ consent: null, events: [], cloudContractVersion: 1 });
  });

  it("15, 62, 83: a key with no event is proven by sign-in (proof_minted_at = 0), zero obligations and mails; history holds the event", async () => {
    const s = setup();
    const a = addr("signin");
    const m = await cloudMember(a);
    const t = Date.now() - 1_000;
    const r = await s.on(m.token, t);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ consent: { status: "opted_in", textVersion: TV, answeredAt: t, proven: true }, cloudContractVersion: 1 });
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE subject_id=? AND proof_minted_at=0 AND proven_at IS NOT NULL", `account:${m.userId}`)).toBe(1);
    expect(await obligationsFor(m.userId)).toBe(0);
    expect(await mailsFor(m.userId)).toBe(0);
    const h = await (await s.call(m.token, "GET", "/v1/updates-consent/history")).json() as { events: { toStatus: string; actor: string }[] };
    expect(h.events.map((e) => [e.toStatus, e.actor])).toEqual([["opted_in", "account"]]);
  });

  it("62, 69, 83: a list37 key switched on while capped: capped, unproven, mailPending false; replay nothing; after the window one prove mail", async () => {
    const s = setup();
    const a = addr("cap");
    const m = await cloudMember(a);
    await event(a, "list37");
    await capMail(a);
    const t1 = Date.now() - 5_000;
    expect(await (await s.on(m.token, t1)).json()).toEqual({ consent: { status: "opted_in", textVersion: TV, answeredAt: t1, proven: false, mailPending: false }, cloudContractVersion: 1 });
    expect(await count("SELECT count(*) AS n FROM updates_requests WHERE request_id=? AND outcome='capped'", await reqId(m.userId, t1))).toBe(1);
    expect(await mailsFor(m.userId)).toBe(0);
    // The same request again: a replay (RQ inserts nothing), zero mails.
    await s.on(m.token, t1);
    expect(await count("SELECT count(*) AS n FROM updates_requests WHERE subject_id=?", `account:${m.userId}`)).toBe(1);
    // A new answeredAt inside the window: capped again, zero mails.
    await s.on(m.token, t1 + 1);
    expect(await mailsFor(m.userId)).toBe(0);
    // After the window with a new answeredAt: one prove mail, mailPending true.
    await uncap(a);
    const gen = (await env.DB.prepare("SELECT generation FROM updates_consent WHERE subject_id=?").bind(`account:${m.userId}`).first<{ generation: number }>())!.generation;
    const t3 = t1 + 2;
    expect(await (await s.on(m.token, t3)).json()).toEqual({ consent: { status: "opted_in", textVersion: TV, answeredAt: t3, proven: false, mailPending: true }, cloudContractVersion: 1 });
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE subject_id=? AND generation=?", `account:${m.userId}`, gen + 1)).toBe(1);
    expect(await mailsFor(m.userId)).toBe(1);
    // A new answeredAt while that mail is live: noop, nothing minted.
    await s.on(m.token, t1 + 3);
    expect(await count("SELECT count(*) AS n FROM updates_requests WHERE request_id=? AND outcome='noop'", await reqId(m.userId, t1 + 3))).toBe(1);
    expect(await mailsFor(m.userId)).toBe(1);
    // The mail goes out through the outbox with the one-click pair.
    await sendUpdatesOutbox(s.e);
    expect(s.mails.filter((x) => x.to === a)).toHaveLength(1);
    expect(s.mails.find((x) => x.to === a)!.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("75, 87: a key the gate refuses writes nothing and answers the GET body (null with no row, else the row as it stands)", async () => {
    const s = setup();
    for (const kind of ["erase", "complaint", "bounce", "resend_unsub", "sendlane_global"]) {
      const a = addr(`ref-${kind}`);
      const m = await cloudMember(a);
      await event(a, kind);
      const r = await s.on(m.token, Date.now() - 1_000);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ consent: null, cloudContractVersion: 1 });
      expect(await count("SELECT count(*) AS n FROM updates_consent WHERE subject_id=?", `account:${m.userId}`)).toBe(0);
      expect(await obligationsFor(m.userId)).toBe(0);
    }
    // An earlier generation left in place is returned as the GET returns it.
    const a = addr("ref-row");
    const m = await cloudMember(a);
    const t = Date.now() - 2_000;
    await s.on(m.token, t);
    const get = await (await s.call(m.token, "GET")).json();
    await event(a, "complaint");
    const r = await s.on(m.token, t + 1);
    expect(await r.json()).toEqual(get);
    expect(await count("SELECT count(*) AS n FROM updates_requests WHERE request_id=? AND outcome='refused'", await reqId(m.userId, t + 1))).toBe(1);
  });

  it("15, 83: a stale page posting the old address answers 409 retry and writes nothing", async () => {
    const s = setup();
    const a = addr("stale");
    const m = await cloudMember(a);
    const r = await s.on(m.token, Date.now() - 1_000, { email: addr("old") });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("retry");
    expect(await count("SELECT count(*) AS n FROM updates_requests WHERE subject_id=?", `account:${m.userId}`)).toBe(0);
    expect(await obligationsFor(m.userId)).toBe(0);
  });

  it("bad_answered_at and bad_text_version answer 400 with no write", async () => {
    const s = setup();
    const m = await cloudMember(addr("bad"));
    expect((await s.on(m.token, Date.now() + 10 * 60_000)).status).toBe(400);
    expect((await s.call(m.token, "POST", "/v1/updates-consent", { status: "opted_in", textVersion: "nope-not-a-version", answeredAt: Date.now() })).status).toBe(400);
    // Held (MurageMain 11-07): the unbuilt 1.0.20 card row is never selectable, even with T-C1 open.
    const held = await s.call(m.token, "POST", "/v1/updates-consent", { status: "opted_in", textVersion: "2026-11-06", answeredAt: Date.now() });
    expect([held.status, await held.json()]).toEqual([400, { error: "bad_text_version" }]);
    expect(await count("SELECT count(*) AS n FROM updates_requests WHERE subject_id=?", `account:${m.userId}`)).toBe(0);
  });

  it("no_contact_email: an account whose contact address is NULL or blank gets 409 and no write (the route's own check, called directly)", async () => {
    // Through fetch this is unreachable: resolveCloudAccount throws on a NULL contact_email before any route runs (pre-existing on e0bcf48ec,
    // cloud-accounts.ts:192). So the route is called with a resolved session for an account seeded straight into D1.
    const s = setup();
    for (const contact of [null, "   "]) {
      const id = crypto.randomUUID();
      const at = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified",image,"createdAt","updatedAt") VALUES (?,?,?,1,NULL,?,?)')
          .bind(id, "n", `cloud-${id}@cloud-account.invalid`, at, at),
        env.DB.prepare("INSERT INTO supabase_identities (sub,user_id,via,created_at,contact_email) VALUES (?,?,'created',?,?)")
          .bind(crypto.randomUUID(), id, Date.now(), contact),
      ]);
      const session = { user: { id, email: "", name: "n", emailVerified: true }, session: { id: "s" }, supabase: {} } as unknown as
        NonNullable<Awaited<ReturnType<Parameters<typeof updatesMembersRoute>[2]>>>;
      const req = new Request(`${BASE}/v1/updates-consent`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "opted_in", textVersion: TV, answeredAt: Date.now() - 1_000 }) });
      const err = await updatesMembersRoute(req, s.e, async () => session).then(() => null, (x: unknown) => x);
      expect(err).toBeInstanceOf(HTTPError);
      expect([(err as HTTPError).status, (err as HTTPError).code]).toEqual([409, "no_contact_email"]);
      expect(await count("SELECT count(*) AS n FROM updates_consent WHERE subject_id=?", `account:${id}`)).toBe(0);
      expect(await count("SELECT count(*) AS n FROM updates_requests WHERE subject_id=?", `account:${id}`)).toBe(0);
    }
  });

  it("an identity move during the switch on (409 retry) leaves no replay tombstone: the retry after the move is a new request and switches on (B1 r1 Grok M4)", async () => {
    const s = setup();
    const id = crypto.randomUUID();
    const a = addr("moved");
    const at = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified",image,"createdAt","updatedAt") VALUES (?,?,?,1,NULL,?,?)')
        .bind(id, "n", `cloud-${id}@cloud-account.invalid`, at, at),
      env.DB.prepare("INSERT INTO supabase_identities (sub,user_id,via,created_at,contact_email) VALUES (?,?,'created',?,?)")
        .bind(crypto.randomUUID(), id, Date.now(), a),
    ]);
    const session = { user: { id, email: "", name: "n", emailVerified: true }, session: { id: "s" }, supabase: {} } as unknown as
      NonNullable<Awaited<ReturnType<Parameters<typeof updatesMembersRoute>[2]>>>;
    const answeredAt = Date.now() - 1_000;
    const req = () => new Request(`${BASE}/v1/updates-consent`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "opted_in", textVersion: TV, answeredAt }) });
    // The identity moves (a new revision, same address) between the route's read and its batch.
    const real = s.e.DB;
    let move = true;
    const racing = new Proxy(real, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (move) {
              move = false;
              await real.prepare("UPDATE supabase_identities SET email_revision=email_revision+1 WHERE user_id=?").bind(id).run();
            }
            return real.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const err = await updatesMembersRoute(req(), { ...s.e, DB: racing } as Env, async () => session).then(() => null, (x: unknown) => x);
    expect(err).toBeInstanceOf(HTTPError);
    expect([(err as HTTPError).status, (err as HTTPError).code]).toEqual([409, "retry"]);
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE subject_id=?", `account:${id}`)).toBe(0);
    const retry = await updatesMembersRoute(req(), s.e, async () => session);
    expect(retry!.status).toBe(200);
    expect(await retry!.json()).toMatchObject({ consent: { status: "opted_in", textVersion: TV, answeredAt } });
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE subject_id=? AND status='opted_in'", `account:${id}`)).toBe(1);
    expect((await env.DB.prepare("SELECT request_id, outcome FROM updates_requests WHERE subject_id=? ORDER BY at, request_id").bind(`account:${id}`)
      .all<{ request_id: string; outcome: string }>()).results.map((r) => r.request_id)).toEqual(expect.arrayContaining([`acct:${id}:0:${answeredAt}`, `acct:${id}:1:${answeredAt}`]));
  });

  it("67: with T-C1 closed the switch on writes nothing and answers the GET body", async () => {
    const s = setup(false);
    const m = await cloudMember(addr("closed"));
    expect(await (await s.on(m.token, Date.now() - 1_000)).json()).toEqual({ consent: null, cloudContractVersion: 1 });
    expect(await count("SELECT count(*) AS n FROM updates_requests WHERE subject_id=?", `account:${m.userId}`)).toBe(0);
  });

  it("B1 r2 (Astra M): with T-C1 closed, a switch on from a Supabase identity with no Cloud account writes no consent, request or event row", async () => {
    // The Cloud account mapping itself is the shared session resolver's (customer(), unchanged since base e0bcf48ec): every signed-in
    // Cloud route but GET step-up state and the members GETs creates it, so it is account identity, not a consent write (handoff, design addendum).
    const s = setup(false);
    const a = addr("closed-unmapped");
    const sub = `unmapped-${crypto.randomUUID()}`;
    expect(await count("SELECT count(*) AS n FROM supabase_identities WHERE sub=?", sub)).toBe(0);
    const key = await keyOf(a);
    const before = await Promise.all(["updates_consent", "updates_requests", "updates_consent_events", "updates_obligations", "updates_mail_outbox", "updates_tokens"]
      .map((t) => count(`SELECT count(*) AS n FROM ${t}`)));
    const r = await s.on(await supabaseToken(sub, a), Date.now() - 1_000);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ consent: null, cloudContractVersion: 1 });
    const after = await Promise.all(["updates_consent", "updates_requests", "updates_consent_events", "updates_obligations", "updates_mail_outbox", "updates_tokens"]
      .map((t) => count(`SELECT count(*) AS n FROM ${t}`)));
    expect(after).toEqual(before);
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email_key=?", key)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM updates_requests WHERE email_key=?", key)).toBe(0);
    const userId = (await env.DB.prepare("SELECT user_id FROM supabase_identities WHERE sub=?").bind(sub).first<{ user_id: string }>())?.user_id;
    expect(userId).toBeTruthy();
    expect(await count("SELECT count(*) AS n FROM updates_requests WHERE subject_id=?", `account:${userId}`)).toBe(0);
  });

  it("37, 55 (account): switch on after an unsubscribe is unproven (AO1 proves by sign-in only with no event), the prove mail's proof writes the audit row", async () => {
    // The design names AO3 for this audit; the v5.5 statement set has no AO3: AO1 queues a prove mail whenever any event exists, and PV4 audits.
    const s = setup();
    const a = addr("reconsent");
    const m = await cloudMember(a);
    const t = Date.now() - 5_000;
    expect(await (await s.on(m.token, t)).json()).toMatchObject({ consent: { status: "opted_in", proven: true } });
    await s.off(m.token, t + 1);
    await event(a, "our_unsub", Date.now() - 1_000);
    expect(await (await s.on(m.token, t + 2)).json()).toMatchObject({ consent: { status: "opted_in", proven: false } });
    await sendUpdatesOutbox(s.e);
    const mail = s.mails.filter((x) => x.to === a).at(-1)!;
    const token = new URL(mail.text.split("\n").find((l) => l.includes("/v1/updates-consent/prove?token="))!).searchParams.get("token")!;
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${BASE}/v1/updates-consent/prove`, { method: "POST", body: `token=${token}`,
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.77" }, redirect: "manual" }), s.e, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.headers.get("location")).toBe("https://murage.ai/updates/confirmed");
    const id = (await env.DB.prepare("SELECT id FROM updates_consent WHERE subject_id=?").bind(`account:${m.userId}`).first<{ id: string }>())!.id;
    expect((await env.DB.prepare("SELECT old_kind, consent_id FROM updates_reconsent_audit WHERE email_key=?").bind(await keyOf(a)).all()).results)
      .toEqual([{ old_kind: "our_unsub", consent_id: id }]);
  });

  it("19 (site GET): the members GET and history make no provider call", async () => {
    const calls: string[] = [];
    const w = createWorker((async (u: RequestInfo | URL) => { calls.push(String(u)); return new Response("{}"); }) as typeof fetch,
      async (u) => { calls.push(String(u)); return new Response("{}"); }, {}, {}, {}, { jwksFetch, authFetch });
    const m = await cloudMember(addr("t19"));
    for (const path of ["/v1/updates-consent", "/v1/updates-consent/history"]) {
      const ctx = createExecutionContext();
      const res = await w.fetch(new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${m.token}`, "cf-connecting-ip": "198.51.100.78" } }), setup().e, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
    }
    expect(calls).toEqual([]);
  });

  it("AF: switch off withdraws only the account row; otherSignups counts the address's other proven rows; a later on is a new answer", async () => {
    const s = setup();
    const a = addr("af");
    const m = await cloudMember(a);
    const t = Date.now() - 3_000;
    await s.on(m.token, t);
    // A proven desktop row for the same address (another subject).
    const key = await keyOf(a);
    const rh = await sha256Hex(crypto.randomUUID());
    await env.DB.prepare(`INSERT INTO updates_consent (id,kind,subject_id,receipt_hash,email,email_key,status,generation,proven_at,proof_minted_at,consented_at,
      mut_nonce,text_version,app_version,source,answered_at,status_changed_at,created_at,updated_at)
      VALUES (?, 'receipt', ?, ?, ?, ?, 'opted_in', 1, ?, 1, ?, ?, ?, '1.0.20', 'desktop', ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), `receipt:${rh}`, rh, a, key, t, t, crypto.randomUUID(), TV, t, t, t, t).run();
    const r = await s.off(m.token, t + 1);
    expect(await r.json()).toEqual({ consent: { status: "withdrawn", textVersion: TV, answeredAt: t, proven: false }, otherSignups: 1, cloudContractVersion: 1 });
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email_key=? AND status='opted_in'", key)).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM updates_consent_events e JOIN updates_consent c ON c.id=e.consent_id
      WHERE c.subject_id=? AND e.to_status='withdrawn' AND e.actor='account'`, `account:${m.userId}`)).toBe(1);
    // No exclusion event: switching on again with a newer answer proves by sign-in again (no event for the key).
    expect(await count("SELECT count(*) AS n FROM updates_exclusion_events WHERE email_key=?", key)).toBe(0);
    const again = await (await s.on(m.token, t + 2)).json() as { consent: { status: string; proven: boolean } };
    expect(again.consent).toMatchObject({ status: "opted_in", proven: true });
  });
});
