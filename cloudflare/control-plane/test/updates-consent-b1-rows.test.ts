// Updates consent B1, the remaining design rows (UPDATES-CONSENT-1020-CP-v5.md v5.6.2, 7.1): 3, 7, 8, 11, 12, 19, 27, 33 to 36, 46, 55, 56,
// 60, 64, 68, 76 to 78, 81, 82 (37 and the account half of 55 are in updates-consent-members.test.ts). Route rows go through the Worker's
// exported fetch on real D1; rows that need time to pass (expiry, buckets, windows) run the same request batches with a chosen `now`.
// Parts that belong to later batches are named in each test and not faked: the snapshot and P (B3), K2, K7, K8 and erase (B4), the
// Resend webhook and read (B2/B3). Where a test needs the state such a job leaves, it writes that state in D1 and says so.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { subjectKey } from "../src/announcements";
import { createWorker } from "../src/index";
import { DAY_MS, desktopBatch, outcomeOf, signupBatch, type GateBinds } from "../src/updates-consent/gate";
import { sendUpdatesOutbox } from "../src/updates-consent/routes";
import { deriveToken, emailKeyOf, proveTokenId, sha256Hex } from "../src/updates-consent/tokens";

const BASE = "https://auth.murage.test";
const TOKEN = "site-forwarder-test-token-1234567890"; // secret-scan: fixture
const SECRET = env.BETTER_AUTH_SECRET;
const FORM = { "content-type": "application/x-www-form-urlencoded" };
let seq = 0;
const ip = () => `198.51.100.${(++seq % 250) + 1}`;
const rid = () => `req-${++seq}-${crypto.randomUUID()}`;
const fresh = (p: string) => `${p}-${++seq}-${crypto.randomUUID()}`;
const addr = (tag: string) => `rows-${tag}-${++seq}-${crypto.randomUUID().slice(0, 8)}@example.test`;
const tick = () => new Promise((r) => setTimeout(r, 3));
const keyOf = (email: string) => emailKeyOf(email, SECRET);

interface Mail { to: string; subject: string; text: string; headers?: Record<string, string> }
function setup(extra: Record<string, string> = {}) {
  const mails: Mail[] = [];
  const fetches: string[] = [];
  const spy = async (url: RequestInfo | URL) => { fetches.push(String(url)); return new Response("{}"); };
  const e = {
    ...env, MURAGE_ENV: "live", SITE_FORWARDER_TOKEN: TOKEN, UPDATES_SIGNUPS_OPEN: "1", CP_ONECLICK_DKIM_VERIFIED: "1", ...extra,
    EMAIL: { async send(m: Mail) { mails.push(m); } },
  } as unknown as Env;
  async function call(path: string, init: { method?: string; body?: unknown; form?: string; headers?: Record<string, string> } = {}, envOver?: Env) {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", ip());
    let body: BodyInit | undefined;
    if (init.form !== undefined) { body = init.form; if (!headers.has("content-type")) headers.set("content-type", FORM["content-type"]); }
    else if (init.body !== undefined) { body = JSON.stringify(init.body); headers.set("content-type", "application/json"); }
    const ctx = createExecutionContext();
    const res = await createWorker(spy as typeof fetch, spy).fetch(new Request(`${BASE}${path}`, { method: init.method ?? "POST", headers, body, redirect: "manual" }), envOver ?? e, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  const forward = (body: Record<string, unknown>) => call("/v1/announcements/subscribe", { body: { source: "footer", consentText: "Yes", ...body }, headers: { "X-Murage-Site-Token": TOKEN } });
  const desk = (o: { email: string; receipt: string; answeredAt: number; currentReceipt?: string }) => sha256Hex(o.receipt).then((receiptHash) =>
    call("/v1/updates-consent/email", { body: { email: o.email, installId: fresh("inst"), textVersion: "v1", appVersion: "1.0.20", answeredAt: o.answeredAt,
      receiptHash, ...(o.currentReceipt ? { currentReceipt: o.currentReceipt } : {}) } }));
  const deliver = (over?: Env) => sendUpdatesOutbox(over ?? e);
  const lastMail = (to: string) => mails.filter((m) => m.to === to).at(-1)!;
  const proveLink = (m: Mail) => new URL(m.text.split("\n").find((l) => l.includes("/v1/updates-consent/prove?token="))!).searchParams.get("token")!;
  const unsubLink = (m: Mail) => new URL(m.headers!["List-Unsubscribe"]!.slice(1, -1)).searchParams.get("token")!;
  const prove = async (token: string, over?: Env) => (await call("/v1/updates-consent/prove", { form: `token=${token}` }, over)).headers.get("location");
  const unsub = (token: string, over?: Env) => call(`/v1/updates-consent/unsubscribe?token=${token}`, { form: "List-Unsubscribe=One-Click" }, over);
  return { e, mails, fetches, call, forward, desk, deliver, lastMail, proveLink, unsubLink, prove, unsub };
}

const count = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0;
const row = <T = Record<string, unknown>>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<T>();
const consentOf = (email: string) => row<Record<string, unknown>>("SELECT * FROM updates_consent WHERE email=? ORDER BY created_at LIMIT 1", email);
const ourUnsubs = async (email: string) => count("SELECT count(*) AS n FROM updates_exclusion_events WHERE email_key=? AND kind='our_unsub'", await keyOf(email));
const audits = async (email: string) => (await env.DB.prepare("SELECT old_kind, old_observed_at, consent_id FROM updates_reconsent_audit WHERE email_key=? ORDER BY id")
  .bind(await keyOf(email)).all<{ old_kind: string; old_observed_at: number; consent_id: string }>()).results;
async function appendEvent(email: string, kind: string, observedAt: number, source = "operator") {
  await env.DB.prepare("INSERT INTO updates_exclusion_events (email_key,kind,observed_at,source,ref,at) VALUES (?,?,?,?,NULL,?)")
    .bind(await keyOf(email), kind, observedAt, source, observedAt).run();
}
// Route rows run many Worker fetches in one test; on the shared host (load 50 to 85) the 5 s default times out in files B1 never touches
// as well (handoff, the side-by-side runs). 20 s keeps a slow host from reading as a failure without hiding a hang.
const ROUTE_TIMEOUT_MS = 20_000;
const PAGE_OK = "<h1>You won't get any more updates.</h1>";

beforeEach(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO updates_consent_texts (version, locale, body, effective_from) VALUES ('v1', 'en', 'test words', 0)").run();
});

// ---- Batches with a chosen `now` (the binds of updates-consent-v5.test.ts) -------------------------------------------------------
const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);
const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, "0")).join("");
async function binds(kind: "desktop" | "forwarder" | "legacy", o: { email: string; now: number; receipt?: string; answeredAt?: number;
  currentReceipt?: string | null; requestId?: string; keyVersion?: number; callerKey?: string; callerMax?: number }): Promise<GateBinds> {
  const emailKey = await keyOf(o.email);
  const outboxId = fresh("ob");
  const keyVersion = o.keyVersion ?? 1;
  const { tokenHash } = await deriveToken(proveTokenId(outboxId), keyVersion, SECRET);
  const common = { consentId: fresh("c"), email: o.email, emailKey, textVersion: "v1", now: o.now, proveTokenHash: tokenHash, keyVersion, outboxId,
    mailCapKey: await sha256Hex(`cap:${emailKey}`), nonce: fresh("n"), template: "prove" as const, withGuide: false };
  if (kind === "desktop") {
    const answeredAt = o.answeredAt ?? o.now;
    return { ...common, subjectRef: o.receipt!, installId: "inst-1", appVersion: "1.0.20", answeredAt, currentReceipt: o.currentReceipt ?? null,
      forwarderSource: null, consentWords: null, source: "desktop", requestId: o.requestId ?? `desk:${o.receipt}:${answeredAt}`, path: "desktop",
      subjectId: `receipt:${o.receipt}`, payloadHash: await sha256Hex(`${o.receipt}|${o.email}|${answeredAt}`) };
  }
  const legacy = kind === "legacy";
  const source = legacy ? "legacy_desktop" : "footer";
  return { ...common, subjectRef: null, installId: null, appVersion: legacy ? "1.0.19" : "site", answeredAt: o.now, currentReceipt: null,
    forwarderSource: legacy ? null : source, consentWords: legacy ? null : "Yes", source, path: legacy ? "legacy" : "forwarder",
    requestId: o.requestId ?? (legacy ? `legacy:${emailKey}:${Math.floor(o.now / 600_000)}` : fresh("site-request")),
    limits: { firstKey: await sha256Hex(`addr:${emailKey}`), firstCutoff: o.now - 15 * 60_000, firstMax: 3,
      secondKey: o.callerKey ?? await sha256Hex("caller:default"), secondCutoff: o.now - 60 * 60_000, secondMax: o.callerMax ?? 500 },
    subjectId: `signup:${emailKey}:${source}`, payloadHash: await sha256Hex(`${legacy ? "legacy" : "fwd"}|${o.email}`) };
}
async function run(b: GateBinds) {
  const stmts = b.path === "desktop" ? desktopBatch(env.DB, b) : signupBatch(env.DB, b);
  return outcomeOf(await env.DB.batch(stmts), stmts.length - 1);
}
const totals = async (email: string) => {
  const k = await keyOf(email);
  return {
    obligations: await count("SELECT count(*) AS n FROM updates_obligations WHERE email_key=?", k),
    tokens: await count("SELECT count(*) AS n FROM updates_tokens WHERE email_key=? AND purpose='prove'", k),
    mails: await count("SELECT count(*) AS n FROM updates_mail_outbox m JOIN updates_consent c ON c.id=m.consent_id WHERE c.email_key=?", k),
    cap: (await row<{ attempts: number }>("SELECT attempts FROM announcement_rate_limits WHERE subject_key=?", await sha256Hex(`cap:${k}`)))?.attempts ?? 0,
  };
};

describe("desktop rows by receipt", { timeout: ROUTE_TIMEOUT_MS }, () => {
  it("3: another address on the same receipt changes nothing without currentReceipt; with it the row moves (generation 2, proof cleared, one mail)", async () => {
    const s = setup();
    const a = addr("t3a"), b = addr("t3b");
    const R = `rcpt-${crypto.randomUUID()}`, H = await sha256Hex(R);
    const t = Date.now() - 60_000;
    await s.desk({ email: a, receipt: R, answeredAt: t });
    await s.deliver();
    expect(await s.prove(s.proveLink(s.lastMail(a)))).toBe("https://murage.ai/updates/confirmed");
    const before = await row("SELECT * FROM updates_consent WHERE receipt_hash=?", H);
    const statusBefore = await (await s.call("/v1/updates-consent/status", { body: { receipt: R } })).json();
    const r1 = await s.desk({ email: b, receipt: R, answeredAt: t + 1 });
    expect([r1.status, await r1.json()]).toEqual([200, { ok: true, cloudContractVersion: 1 }]);
    expect(await row("SELECT * FROM updates_consent WHERE receipt_hash=?", H)).toEqual(before);
    expect(await (await s.call("/v1/updates-consent/status", { body: { receipt: R } })).json()).toEqual(statusBefore);
    expect(await count("SELECT count(*) AS n FROM updates_mail_outbox WHERE consent_id=? AND state='queued'", before!.id)).toBe(0);

    const r2 = await s.desk({ email: b, receipt: R, answeredAt: t + 2, currentReceipt: R });
    expect([r2.status, await r2.json()]).toEqual([200, { ok: true, cloudContractVersion: 1 }]);
    const moved = await row<Record<string, unknown>>("SELECT * FROM updates_consent WHERE receipt_hash=?", H);
    expect(moved).toMatchObject({ id: before!.id, email: b, email_key: await keyOf(b), generation: (before!.generation as number) + 1, proven_at: null, proof_minted_at: null });
    expect(moved!.unproven_since).toBeGreaterThan(before!.updated_at as number);
    await s.deliver();
    expect(s.mails.filter((m) => m.to === b)).toHaveLength(1);
    expect(s.mails.filter((m) => m.to === a)).toHaveLength(1);
  });

  it("68: an email change with the current receipt sent three times (same answeredAt): one generation, one mail, one cap charge; after our link the replay changes nothing; a new tick re-opts in", async () => {
    const s = setup();
    const a = addr("t68a"), b = addr("t68b");
    const R = `rcpt-${crypto.randomUUID()}`, H = await sha256Hex(R);
    const t = Date.now() - 120_000;
    // The install limit is 5 an hour (3.5): the first five posts share one install, the new tick comes from a second one.
    const post = (email: string, answeredAt: number, currentReceipt?: string, installId = "inst-68") => s.call("/v1/updates-consent/email", { body: { email, installId,
      textVersion: "v1", appVersion: "1.0.20", answeredAt, receiptHash: H, ...(currentReceipt ? { currentReceipt } : {}) } });
    const state = () => row<Record<string, unknown>>("SELECT status, email, generation, consented_at, mut_nonce FROM updates_consent WHERE receipt_hash=?", H);
    expect((await post(a, t)).status).toBe(200);
    await s.deliver();
    const g0 = (await state())!.generation as number;
    for (let i = 0; i < 3; i++) expect((await post(b, t + 1, R)).status).toBe(200);
    expect(await state()).toMatchObject({ status: "opted_in", email: b, generation: g0 + 1 });
    await s.deliver();
    expect(s.mails.filter((m) => m.to === b)).toHaveLength(1);
    const capKey = await subjectKey("updates-prove-mail", await keyOf(b), SECRET);
    expect(await row("SELECT attempts FROM announcement_rate_limits WHERE subject_key=?", capKey)).toEqual({ attempts: 1 });
    // Our one-click link withdraws the row; the same tick replayed afterwards changes nothing and queues nothing.
    expect((await s.unsub(s.unsubLink(s.lastMail(b)))).status).toBe(200);
    const off = await state();
    expect(off).toMatchObject({ status: "withdrawn" });
    await tick();
    expect((await post(b, t + 1, R)).status).toBe(200);
    expect(await state()).toEqual(off);
    await s.deliver();
    expect(s.mails.filter((m) => m.to === b)).toHaveLength(1);
    // A new tick (newer answeredAt) re-opts in with one new mail; over 5 minutes ahead of server time is 400 with no write.
    expect((await post(b, t + 2, R, "inst-68b")).status).toBe(200);
    expect(await state()).toMatchObject({ status: "opted_in", email: b });
    await s.deliver();
    expect(s.mails.filter((m) => m.to === b)).toHaveLength(2);
    const on = await state();
    expect((await post(b, Date.now() + 6 * 60_000, R, "inst-68c")).status).toBe(400);
    expect(await state()).toEqual(on);
  });

  it("8: withdraw, then (K2 having cleared the address: B4, state written here) a re-opt-in restores it, moves the generation and queues a prove mail", async () => {
    const s = setup();
    const a = addr("t8"), R = `rcpt-${crypto.randomUUID()}`, H = await sha256Hex(R);
    const t = Date.now() - 60_000;
    await s.desk({ email: a, receipt: R, answeredAt: t });
    const g1 = (await row<{ generation: number }>("SELECT generation FROM updates_consent WHERE receipt_hash=?", H))!.generation;
    expect((await s.call("/v1/updates-consent/withdraw", { body: { receipt: R } })).status).toBe(204);
    expect((await row<{ generation: number }>("SELECT generation FROM updates_consent WHERE receipt_hash=?", H))!.generation).toBe(g1 + 1);
    await env.DB.prepare("UPDATE updates_consent SET email=NULL WHERE receipt_hash=?").bind(H).run();
    await s.desk({ email: a, receipt: R, answeredAt: t + 1 });
    expect(await row("SELECT status, email, generation FROM updates_consent WHERE receipt_hash=?", H)).toEqual({ status: "opted_in", email: a, generation: g1 + 2 });
    await s.deliver();
    expect(s.mails.filter((m) => m.to === a)).toHaveLength(1);
    expect(await s.prove(s.proveLink(s.lastMail(a)))).toBe("https://murage.ai/updates/confirmed");
    // The snapshot half ("passes the snapshot after proof") is the send job, B3.
  });
});

describe("forwarder rows", { timeout: ROUTE_TIMEOUT_MS }, () => {
  it("7: a repeat signup while proven leaves text_version, answered_at and site_consent_id unchanged", async () => {
    const s = setup();
    const a = addr("t7");
    await s.forward({ email: a, consentText: "Words one", requestId: rid() });
    await s.deliver();
    await s.prove(s.proveLink(s.lastMail(a)));
    const before = await row("SELECT text_version, answered_at, site_consent_id, generation, proven_at FROM updates_consent WHERE email=?", a);
    await tick();
    expect(await (await s.forward({ email: a, source: "guide", consentText: "Words two", requestId: rid() })).json()).toEqual({ ok: true });
    await s.forward({ email: a, consentText: "Words three", requestId: rid() });
    const rows = (await env.DB.prepare("SELECT source, text_version, answered_at, site_consent_id, generation, proven_at FROM updates_consent WHERE email=? AND source='footer'").bind(a).all()).results;
    expect(rows).toEqual([{ source: "footer", ...before }]);
  });

  it("56: withdraw then a fresh forwarded signup points site_consent_id at the new 0145 row with the new words; an identical retry leaves it", async () => {
    const s = setup();
    const a = addr("t56");
    await s.forward({ email: a, consentText: "Old words", requestId: rid() });
    const first = (await consentOf(a))!.site_consent_id;
    expect((await s.call("/v1/announcements/unsubscribe", { body: { email: a }, headers: { "X-Murage-Site-Token": TOKEN } })).status).toBe(200);
    await tick();
    const id = rid();
    await s.forward({ email: a, consentText: "New words", requestId: id });
    const after = await consentOf(a);
    expect(after).toMatchObject({ status: "opted_in" });
    expect(after!.site_consent_id).not.toBe(first);
    expect(await row("SELECT consent_text FROM announcement_consents WHERE id=?", after!.site_consent_id)).toEqual({ consent_text: "New words" });
    await s.forward({ email: a, consentText: "New words", requestId: id });
    expect((await consentOf(a))!.site_consent_id).toBe(after!.site_consent_id);
  });

  it("19: /email, /status, the forwarder and SU issue zero fetch calls for any address (the site GET: updates-consent-members.test.ts)", async () => {
    const s = setup();
    const a = addr("t19"), R = `rcpt-${crypto.randomUUID()}`;
    await appendEvent(addr("t19-other"), "bounce", Date.now() - 1_000);
    await s.desk({ email: a, receipt: R, answeredAt: Date.now() - 1_000 });
    await s.call("/v1/updates-consent/status", { body: { receipt: R } });
    await s.forward({ email: a, requestId: rid() });
    await s.forward({ email: "rows-never-seen@example.test", requestId: rid() });
    await s.call("/v1/announcements/unsubscribe", { body: { email: a }, headers: { "X-Murage-Site-Token": TOKEN } });
    await s.call("/v1/announcements/unsubscribe", { body: { email: "rows-unknown@example.test" }, headers: { "X-Murage-Site-Token": TOKEN } });
    expect(s.fetches).toEqual([]);
  });

  it("27 (B1 part): with an erase event for the address, /email, the forwarder and 1.0.19 store no consent row and no address", async () => {
    // Erase itself is B4 (3.6); the event it leaves is written here. The webhook and Resend read halves are B2/B3.
    const s = setup();
    const a = addr("t27");
    await appendEvent(a, "erase", Date.now() - 1_000);
    await s.desk({ email: a, receipt: `rcpt-${crypto.randomUUID()}`, answeredAt: Date.now() - 500 });
    await s.forward({ email: a, consentText: `words for ${a}`, requestId: rid() });
    await s.call("/v1/announcements/subscribe", { body: { email: a, name: "Pat" } });
    const k = await keyOf(a);
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email_key=? OR email=?", k, a)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM announcement_consents WHERE email_key=?", k)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM updates_obligations WHERE email_key=?", k)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM updates_requests WHERE email_key=? AND outcome<>'refused'", k)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM updates_requests WHERE request_id LIKE ? OR payload_hash LIKE ?", `%${a}%`, `%${a}%`)).toBe(0);
  });
});

describe("unsubscribe links and key versions", { timeout: ROUTE_TIMEOUT_MS }, () => {
  it("12: one link withdraws every row of the key with one our_unsub; a concurrent replay and a replay after a fresh re-opt-in change nothing", async () => {
    const s = setup();
    const a = addr("t12");
    await s.forward({ email: a, requestId: rid() });
    await s.desk({ email: a, receipt: `rcpt-${crypto.randomUUID()}`, answeredAt: Date.now() - 1_000 });
    await s.deliver();
    const T = s.unsubLink(s.mails.find((m) => m.to === a)!);
    const [p1, p2] = await Promise.all([s.unsub(T), s.unsub(T)]);
    expect([p1.status, p2.status]).toEqual([200, 200]);
    const [b1, b2] = [await p1.text(), await p2.text()];
    expect(b1).toContain(PAGE_OK);
    expect(b2).toBe(b1);
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email_key=? AND status='withdrawn'", await keyOf(a))).toBe(2);
    expect(await ourUnsubs(a)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM updates_tokens WHERE purpose='unsub' AND email_key=? AND used_at IS NOT NULL", await keyOf(a))).toBe(1);
    await tick();
    await s.forward({ email: a, requestId: rid() });
    const reopened = await row("SELECT status, generation FROM updates_consent WHERE email=? AND source='footer'", a);
    expect(reopened).toMatchObject({ status: "opted_in" });
    const p3 = await s.unsub(T);
    expect([p3.status, await p3.text()]).toEqual([200, b1]);
    expect(await row("SELECT status, generation FROM updates_consent WHERE email=? AND source='footer'", a)).toEqual(reopened);
    expect(await ourUnsubs(a)).toBe(1);
  });

  it("11: a key_version bump: the old prove link expires with no change, an old queued mail is dropped, old unsubscribe links still work once", async () => {
    const s = setup();
    const bumped = { ...s.e, UPDATES_TOKEN_KEY_VERSION: "2" } as Env;
    const a = addr("t11a"), b = addr("t11b");
    await s.forward({ email: a, requestId: rid() });
    await s.deliver();
    await s.forward({ email: b, requestId: rid() });
    const mail = s.lastMail(a);
    const before = await consentOf(a);
    expect(await s.prove(s.proveLink(mail), bumped)).toBe("https://murage.ai/updates/link-expired");
    expect(await consentOf(a)).toEqual(before);
    expect((await s.deliver(bumped)).sent).toBe(0);
    expect(s.mails.filter((m) => m.to === b)).toEqual([]);
    expect(await count("SELECT count(*) AS n FROM updates_mail_outbox m JOIN updates_consent c ON c.id=m.consent_id WHERE c.email=? AND m.state='dropped'", b)).toBe(1);
    const u1 = await s.unsub(s.unsubLink(mail), bumped);
    expect([u1.status, (await u1.text()).includes(PAGE_OK)]).toEqual([200, true]);
    expect(await consentOf(a)).toMatchObject({ status: "withdrawn", off_by: "link" });
    const u2 = await s.unsub(s.unsubLink(mail), bumped);
    expect([u2.status, (await u2.text()).includes(PAGE_OK)]).toEqual([200, true]);
    expect(await ourUnsubs(a)).toBe(1);
    // K7's daily settle and the updates-mail links are B4 and B3.
  });

  it("64: expired and old-key_version unsubscribe tokens withdraw on first use with the success page; a used one appends nothing; unknown answers 404", async () => {
    const s = setup();
    const bumped = { ...s.e, UPDATES_TOKEN_KEY_VERSION: "2" } as Env;
    const a = addr("t64a"), b = addr("t64b");
    await s.forward({ email: a, requestId: rid() });
    await s.forward({ email: b, requestId: rid() });
    await s.deliver();
    const Ta = s.unsubLink(s.lastMail(a)), Tb = s.unsubLink(s.lastMail(b));
    // Past its expiry: U1 reads no expiry, so an unsubscribe link keeps working.
    await env.DB.prepare("UPDATE updates_tokens SET expires_at=1 WHERE token_hash=?").bind(await sha256Hex(Ta)).run();
    for (const [email, T, over] of [[a, Ta, undefined], [b, Tb, bumped]] as const) {
      const r = await s.unsub(T, over);
      expect([r.status, (await r.text()).includes(PAGE_OK)]).toEqual([200, true]);
      expect(await consentOf(email)).toMatchObject({ status: "withdrawn" });
      expect(await ourUnsubs(email)).toBe(1);
      const again = await s.unsub(T, over);
      expect([again.status, (await again.text()).includes(PAGE_OK)]).toEqual([200, true]);
      expect(await ourUnsubs(email)).toBe(1);
    }
    const unknown = await s.unsub("Z".repeat(43));
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('href="https://murage.ai/unsubscribe"');
  });

  it("78: one-click T, a fresh signup re-opts the row, T again changes nothing; the new mail's link withdraws again", async () => {
    const s = setup();
    const a = addr("t78");
    await s.forward({ email: a, requestId: rid() });
    await s.deliver();
    const T = s.unsubLink(s.lastMail(a));
    await s.unsub(T);
    expect(await consentOf(a)).toMatchObject({ status: "withdrawn" });
    await tick();
    await s.forward({ email: a, requestId: rid() });
    const reopened = await consentOf(a);
    expect(reopened).toMatchObject({ status: "opted_in" });
    const live = async () => ({
      obligations: await count("SELECT count(*) AS n FROM updates_obligations WHERE consent_id=? AND generation=?", reopened!.id, reopened!.generation),
      queued: await count("SELECT count(*) AS n FROM updates_mail_outbox WHERE consent_id=? AND generation=? AND state='queued'", reopened!.id, reopened!.generation),
      tokens: await count("SELECT count(*) AS n FROM updates_tokens WHERE consent_id=? AND generation=? AND purpose='prove' AND used_at IS NULL", reopened!.id, reopened!.generation),
    });
    expect(await live()).toEqual({ obligations: 1, queued: 1, tokens: 1 });
    const again = await s.unsub(T);
    expect([again.status, (await again.text()).includes(PAGE_OK)]).toEqual([200, true]);
    expect(await consentOf(a)).toEqual(reopened);
    expect(await live()).toEqual({ obligations: 1, queued: 1, tokens: 1 });
    expect(await ourUnsubs(a)).toBe(1);
    await s.deliver();
    await s.unsub(s.unsubLink(s.lastMail(a)));
    expect(await consentOf(a)).toMatchObject({ status: "withdrawn" });
    expect(await ourUnsubs(a)).toBe(2);
  });
});

describe("re-consent and exclusions (9.3, PV1, PV4)", { timeout: ROUTE_TIMEOUT_MS }, () => {
  it("33: after our link, a fresh signup and proof write one audit row with the old kind, old time and the new consent", async () => {
    const s = setup();
    const a = addr("t33");
    await s.forward({ email: a, requestId: rid() });
    await s.deliver();
    await s.unsub(s.unsubLink(s.lastMail(a)));
    const ev = (await row<{ observed_at: number }>("SELECT observed_at FROM updates_exclusion_events WHERE email_key=? AND kind='our_unsub'", await keyOf(a)))!;
    await tick();
    await s.forward({ email: a, requestId: rid() });
    await s.deliver();
    expect(await s.prove(s.proveLink(s.lastMail(a)))).toBe("https://murage.ai/updates/confirmed");
    const c = await consentOf(a);
    expect(c).toMatchObject({ status: "opted_in" });
    expect(c!.proven_at).not.toBeNull();
    expect(await audits(a)).toEqual([{ old_kind: "our_unsub", old_observed_at: ev.observed_at, consent_id: c!.id }]);
    // "The address is claimed" is P in the snapshot, B3.
  });

  it("35: after the site page (our_unsub and list 37) the same: the proof audits both", async () => {
    const s = setup();
    const a = addr("t35");
    await s.forward({ email: a, requestId: rid() });
    await s.call("/v1/announcements/unsubscribe", { body: { email: a }, headers: { "X-Murage-Site-Token": TOKEN } });
    await tick();
    await s.forward({ email: a, requestId: rid() });
    await s.deliver();
    expect(await s.prove(s.proveLink(s.lastMail(a)))).toBe("https://murage.ai/updates/confirmed");
    expect((await audits(a)).map((x) => x.old_kind).sort()).toEqual(["list37", "our_unsub"]);
  });

  it("34, 36: a Resend link, a bounce, a complaint or a Sendlane global is never beaten by a fresh signup: refused, no mail, no audit", async () => {
    const s = setup();
    for (const [kind, source] of [["resend_unsub", "resend_read"], ["bounce", "operator"], ["complaint", "operator"], ["sendlane_global", "sendlane_read"]] as const) {
      const a = addr(`t36-${kind}`);
      await s.forward({ email: a, requestId: rid() });
      await s.deliver();
      await s.prove(s.proveLink(s.lastMail(a)));
      await appendEvent(a, kind, Date.now(), source);
      await tick();
      const before = await consentOf(a);
      await s.forward({ email: a, requestId: rid() });
      await s.deliver();
      expect([kind, s.mails.filter((m) => m.to === a).length]).toEqual([kind, 1]);
      expect(await consentOf(a)).toEqual(before);
      expect(await audits(a)).toEqual([]);
      expect(await count("SELECT count(*) AS n FROM updates_requests WHERE email_key=?", await keyOf(a))).toBe(2);
      expect((await row<{ outcome: string }>("SELECT outcome FROM updates_requests WHERE email_key=? ORDER BY at DESC LIMIT 1", await keyOf(a)))!.outcome).toBe("refused");
    }
    // The webhook half of 34 is B2; the snapshot's live Sendlane read and P are B3.
  });

  it("46: a token minted at t is void after an opt-out of any kind at t or later; a token minted after the opt-out proves at its mint time", async () => {
    const s = setup();
    for (const kind of ["our_unsub", "list37", "resend_unsub", "bounce", "complaint", "cleared"]) {
      const a = addr(`t46-${kind}`);
      await s.forward({ email: a, requestId: rid() });
      await s.deliver();
      const token = s.proveLink(s.lastMail(a));
      const minted = (await row<{ created_at: number }>("SELECT created_at FROM updates_tokens WHERE token_hash=?", await sha256Hex(token)))!.created_at;
      await appendEvent(a, kind, minted);
      const before = await consentOf(a);
      expect([kind, await s.prove(token)]).toEqual([kind, "https://murage.ai/updates/link-expired"]);
      expect(await consentOf(a)).toEqual(before);
      if (!["our_unsub", "list37", "cleared"].includes(kind)) continue;
      await tick();
      await s.forward({ email: a, requestId: rid() });
      await s.deliver();
      const second = s.proveLink(s.lastMail(a));
      expect(second).not.toBe(token);
      const at = (await row<{ created_at: number }>("SELECT created_at FROM updates_tokens WHERE token_hash=?", await sha256Hex(second)))!.created_at;
      expect([kind, await s.prove(second)]).toEqual([kind, "https://murage.ai/updates/confirmed"]);
      expect((await consentOf(a))!.proof_minted_at).toBe(at);
    }
  });

  it("55: a proven row beaten by list 37 while it stays opted in: a fresh signup opens generation 2 (FS2b) and RS2b does the same for a receipt", async () => {
    const s = setup();
    const a = addr("t55f");
    await s.forward({ email: a, requestId: rid() });
    await s.deliver();
    await s.prove(s.proveLink(s.lastMail(a)));
    const g = (await consentOf(a))!.generation as number;
    await env.DB.prepare("INSERT INTO announcement_optouts (email_key,list_id,unsubscribed_at) VALUES (?, '37', ?)").bind(await keyOf(a), Date.now()).run();
    expect(await consentOf(a)).toMatchObject({ status: "opted_in" });
    await tick();
    await s.forward({ email: a, requestId: rid() });
    expect(await consentOf(a)).toMatchObject({ status: "opted_in", generation: g + 1, proven_at: null });
    await s.deliver();
    expect(s.mails.filter((m) => m.to === a)).toHaveLength(2);
    expect(await s.prove(s.proveLink(s.lastMail(a)))).toBe("https://murage.ai/updates/confirmed");
    expect((await audits(a)).map((x) => x.old_kind)).toEqual(["list37"]);

    const d = addr("t55d"), R = `rcpt-${crypto.randomUUID()}`, H = await sha256Hex(R);
    const t = Date.now() - 60_000;
    await s.desk({ email: d, receipt: R, answeredAt: t });
    await s.deliver();
    await s.prove(s.proveLink(s.lastMail(d)));
    const gd = (await row<{ generation: number }>("SELECT generation FROM updates_consent WHERE receipt_hash=?", H))!.generation;
    await appendEvent(d, "list37", Date.now(), "import");
    await tick();
    await s.desk({ email: d, receipt: R, answeredAt: t + 1 });
    expect(await row("SELECT status, generation, proven_at FROM updates_consent WHERE receipt_hash=?", H)).toEqual({ status: "opted_in", generation: gd + 1, proven_at: null });
    await s.deliver();
    expect(await s.prove(s.proveLink(s.lastMail(d)))).toBe("https://murage.ai/updates/confirmed");
    expect((await audits(d)).map((x) => x.old_kind)).toEqual(["list37"]);
  });
});

describe("obligations, replays and limits with a chosen now", { timeout: ROUTE_TIMEOUT_MS }, () => {
  it("60: retries of one answer make one obligation, token, mail and cap charge; after expiry a replay mints nothing; one new answer mints one", async () => {
    const a = addr("t60d"), R = hex();
    for (let i = 0; i < 4; i++) expect(await run(await binds("desktop", { email: a, receipt: R, answeredAt: T0, now: T0 + i }))).toBe("admitted");
    expect(await totals(a)).toEqual({ obligations: 1, tokens: 1, mails: 1, cap: 1 });
    const l = addr("t60l");
    for (let i = 0; i < 3; i++) await run(await binds("legacy", { email: l, now: T0 + i * 1_000 }));
    expect(await totals(l)).toEqual({ obligations: 1, tokens: 1, mails: 1, cap: 1 });
    const later = T0 + 8 * DAY_MS;
    expect(await run(await binds("desktop", { email: a, receipt: R, answeredAt: T0, now: later }))).toBe("admitted");
    expect(await run(await binds("legacy", { email: l, now: later, requestId: `legacy:${await keyOf(l)}:${Math.floor(T0 / 600_000)}` }))).toBe("admitted");
    expect(await totals(a)).toEqual({ obligations: 1, tokens: 1, mails: 1, cap: 1 });
    expect(await totals(l)).toEqual({ obligations: 1, tokens: 1, mails: 1, cap: 1 });
    expect(await run(await binds("desktop", { email: a, receipt: R, answeredAt: T0 + 1, now: later }))).toBe("admitted");
    expect(await run(await binds("legacy", { email: l, now: later }))).toBe("admitted");
    expect(await totals(a)).toEqual({ obligations: 2, tokens: 2, mails: 2, cap: 1 });
    expect(await totals(l)).toEqual({ obligations: 2, tokens: 2, mails: 2, cap: 1 });
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email_key=? AND generation=2", await keyOf(a))).toBe(1);
  });

  for (const path of ["desktop", "forwarder"] as const) {
    it(`76 ${path}: replays after expiry and after a key bump mint nothing; a new request after expiry admits once; while live noop; the cap`, async () => {
      const a = addr(`t76-${path}`), R = hex();
      const req = (over: { now: number; answeredAt?: number; requestId?: string; keyVersion?: number }) =>
        binds(path, { email: a, receipt: R, answeredAt: over.answeredAt ?? T0, ...over });
      const first = await req({ now: T0, requestId: path === "forwarder" ? "fwd-76-first-request" : undefined });
      expect(await run(first)).toBe("admitted");
      const firstOutbox = first.outboxId;
      const replay = (now: number, keyVersion = 1) => req({ now, keyVersion, requestId: first.requestId });
      expect(await run(await replay(T0 + 8 * DAY_MS))).toBe("admitted");
      expect(await run(await replay(T0 + 8 * DAY_MS, 2))).toBe("admitted");
      expect(await totals(a)).toEqual({ obligations: 1, tokens: 1, mails: 1, cap: 1 });
      // A new request after expiry: generation 2, one new obligation, the old queued mail dropped (GD).
      const t2 = T0 + 8 * DAY_MS;
      expect(await run(await req({ now: t2, answeredAt: T0 + 1 }))).toBe("admitted");
      expect(await totals(a)).toMatchObject({ obligations: 2, tokens: 2, mails: 2 });
      expect(await row("SELECT state FROM updates_mail_outbox WHERE id=?", firstOutbox)).toEqual({ state: "dropped" });
      // While that obligation is live: noop, nothing minted.
      expect(await run(await req({ now: t2 + 1_000, answeredAt: T0 + 2 }))).toBe("noop");
      expect(await totals(a)).toMatchObject({ obligations: 2, tokens: 2, mails: 2 });
      // The cap: exhausted in the window, then after it.
      await env.DB.prepare("UPDATE announcement_rate_limits SET attempts=3, window_started_at=? WHERE subject_key=?").bind(t2, first.mailCapKey).run();
      const t3 = t2 + 8 * DAY_MS - 60_000;
      await env.DB.prepare("UPDATE updates_tokens SET expires_at=? WHERE email_key=?").bind(t3 - 1, first.emailKey).run();
      await env.DB.prepare("UPDATE announcement_rate_limits SET window_started_at=? WHERE subject_key=?").bind(t3 - 1_000, first.mailCapKey).run();
      const capped = await req({ now: t3, answeredAt: T0 + 3 });
      expect(await run(capped)).toBe("capped");
      expect(await run(await req({ now: t3 + 1, answeredAt: T0 + 3, requestId: capped.requestId }))).toBe("capped");
      expect(await run(await req({ now: t3 + 2, answeredAt: T0 + 4 }))).toBe("capped");
      expect(await totals(a)).toMatchObject({ obligations: 2, tokens: 2, mails: 2 });
      expect(await run(await req({ now: t3 + DAY_MS, answeredAt: T0 + 5 }))).toBe("admitted");
      expect(await totals(a)).toMatchObject({ obligations: 3, tokens: 3, mails: 3 });
    });
  }

  it("77: a proven guide signup whose outbox row (K8) and token are gone mints nothing again; a capped ticked submission leaves zero outbox rows", async () => {
    // The first half runs end to end through the Worker: the forwarder with withGuide, the outbox sender, and the real POST /prove with
    // the link the guide_prove mail carries (no batch shortcut for the proof). A fresh forwarded row is at generation 1: FS1 inserts it
    // and FS2b's v5.6.2 guard (mut_nonce IS NOT ?17) keeps it from moving the row FS1 wrote in the same batch.
    const s = setup();
    const a = addr("t77");
    const r1 = await s.forward({ email: a, source: "guide", withGuide: true, requestId: rid() });
    expect(await r1.json()).toEqual({ ok: true, guide: "queued" });
    const k = await keyOf(a);
    const ob = (await row<{ id: string; template: string }>("SELECT m.id, m.template FROM updates_mail_outbox m JOIN updates_consent c ON c.id=m.consent_id WHERE c.email_key=?", k))!;
    expect(ob.template).toBe("guide_prove");
    await s.deliver();
    const mail = s.lastMail(a);
    expect(mail.subject).toBe("Your Murage setup guide");
    const before = Date.now();
    expect(await s.prove(s.proveLink(mail))).toBe("https://murage.ai/updates/confirmed");
    const proven = (await row<{ proven_at: number; unproven_since: number | null; generation: number; events: number }>(
      "SELECT proven_at, unproven_since, generation, (SELECT count(*) FROM updates_exclusion_events e WHERE e.email_key=c.email_key) AS events FROM updates_consent c WHERE c.email_key=?", k))!;
    expect(proven).toMatchObject({ unproven_since: null, generation: 1, events: 0 });
    expect(proven.proven_at).toBeGreaterThanOrEqual(before - 1_000);
    // K8 (B4) deletes the delivered guide_prove row; the token is gone too. Written here.
    await env.DB.prepare("DELETE FROM updates_mail_outbox WHERE id=?").bind(ob.id).run();
    await env.DB.prepare("DELETE FROM updates_tokens WHERE email_key=?").bind(k).run();
    await tick();
    const id2 = rid();
    expect(await (await s.forward({ email: a, source: "guide", withGuide: true, requestId: id2 })).json()).toEqual({ ok: true, guide: "none" });
    expect(await row("SELECT outcome FROM updates_requests WHERE request_id=?", id2)).toEqual({ outcome: "noop" });
    expect(await row("SELECT proven_at, generation FROM updates_consent WHERE email_key=?", k)).toEqual({ proven_at: proven.proven_at, generation: 1 });
    expect(await totals(a)).toMatchObject({ obligations: 1, tokens: 0, mails: 0 });

    const c = addr("t77c");
    const cb = await binds("forwarder", { email: c, now: T0 });
    await env.DB.prepare("INSERT INTO announcement_rate_limits (subject_key,window_started_at,attempts,updated_at) VALUES (?,?,3,?)").bind(cb.mailCapKey, T0 - 1_000, T0).run();
    expect(await run({ ...cb, withGuide: true })).toBe("capped");
    expect(await count("SELECT count(*) AS n FROM updates_mail_outbox m JOIN updates_consent x ON x.id=m.consent_id WHERE x.email_key=?", cb.emailKey)).toBe(0);
  });

  it("FS2b guard (v5.6.2, B1 r1 Grok M1): a fresh forwarded or 1.0.19 row is generation 1; a re-opt-in after a withdraw moves exactly one step", async () => {
    const s = setup();
    const a = addr("gen");
    expect(await (await s.forward({ email: a, requestId: rid() })).json()).toEqual({ ok: true });
    const first = (await row<{ id: string; generation: number }>("SELECT id, generation FROM updates_consent WHERE email=? AND source='footer'", a))!;
    expect(first.generation).toBe(1);
    expect(await count("SELECT count(*) AS n FROM updates_obligations WHERE consent_id=? AND generation=1", first.id)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM updates_consent_events WHERE consent_id=? AND generation=1 AND actor='signup'", first.id)).toBe(1);
    const l = addr("genl");
    expect((await s.call("/v1/announcements/subscribe", { body: { email: l } })).status).toBe(200);
    expect(await row("SELECT generation FROM updates_consent WHERE email=?", l)).toEqual({ generation: 1 });
    // Withdrawn by the site unsubscribe, then a new forwarded tick: FS2 moves it one step; FS2b (whose our_unsub test would match) leaves it.
    expect((await s.call("/v1/announcements/unsubscribe", { body: { email: a }, headers: { "X-Murage-Site-Token": TOKEN } })).status).toBe(200);
    const off = (await row<{ status: string; generation: number }>("SELECT status, generation FROM updates_consent WHERE id=?", first.id))!;
    expect(off.status).toBe("withdrawn");
    await tick();
    expect(await (await s.forward({ email: a, requestId: rid() })).json()).toEqual({ ok: true });
    expect(await row("SELECT status, generation FROM updates_consent WHERE id=?", first.id)).toEqual({ status: "opted_in", generation: off.generation + 1 });
  });

  it("81: 1.0.19 at the caller limit: 429-class rate_limited, zero rows, caller unchanged, address charged once; a later bucket admits; then noop", async () => {
    const a = addr("t81");
    const callerKey = await sha256Hex(`caller:${crypto.randomUUID()}`);
    await env.DB.prepare("INSERT INTO announcement_rate_limits (subject_key,window_started_at,attempts,updated_at) VALUES (?,?,10,?)").bind(callerKey, T0 - 1_000, T0).run();
    const first = await binds("legacy", { email: a, now: T0, callerKey, callerMax: 10 });
    const addrKey = first.limits!.firstKey;
    const attempts = async (k: string) => (await row<{ attempts: number }>("SELECT attempts FROM announcement_rate_limits WHERE subject_key=?", k))?.attempts ?? 0;
    expect(await run(first)).toBe("rate_limited");
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email_key=?", first.emailKey)).toBe(0);
    expect([await attempts(callerKey), await attempts(addrKey)]).toEqual([10, 1]);
    expect(await run(await binds("legacy", { email: a, now: T0 + 60_000, callerKey, callerMax: 10 }))).toBe("rate_limited");
    expect([await attempts(callerKey), await attempts(addrKey)]).toEqual([10, 1]);
    const next = T0 + 600_000;
    expect(await run(await binds("legacy", { email: a, now: next, callerKey: await sha256Hex(`caller:${crypto.randomUUID()}`), callerMax: 10 }))).toBe("admitted");
    expect(await totals(a)).toMatchObject({ obligations: 1, mails: 1 });
    expect(await run(await binds("legacy", { email: a, now: next + 600_000, callerKey: await sha256Hex(`caller:${crypto.randomUUID()}`), callerMax: 10 }))).toBe("noop");
    expect(await totals(a)).toMatchObject({ obligations: 1, mails: 1 });
  });

  it("82: retired receipts: rotation 70 to 76, then the replay, a new request on 70 and a rotation back onto 70 all leave the row on 76", async () => {
    const a = addr("t82"), R70 = hex(), R76 = hex();
    const orig = await binds("desktop", { email: a, receipt: R70, answeredAt: T0, now: T0 });
    expect(await run(orig)).toBe("admitted");
    const id = (await row<{ id: string }>("SELECT id FROM updates_consent WHERE subject_id=?", `receipt:${R70}`))!.id;
    await run(await binds("desktop", { email: a, receipt: R76, currentReceipt: R70, answeredAt: T0 + 1, now: T0 + 1_000 }));
    expect(await row("SELECT id, subject_id, generation FROM updates_consent WHERE id=?", id)).toEqual({ id, subject_id: `receipt:${R76}`, generation: 2 });
    const on70 = () => count("SELECT count(*) AS n FROM updates_consent WHERE subject_id=?", `receipt:${R70}`);
    expect(await run(await binds("desktop", { email: a, receipt: R70, answeredAt: T0, now: T0 + 2_000, requestId: orig.requestId }))).toBe("admitted");
    expect(await on70()).toBe(0);
    expect(await run(await binds("desktop", { email: a, receipt: R70, answeredAt: T0 + 5, now: T0 + 3_000 }))).toBe("noop");
    expect(await on70()).toBe(0);
    await run(await binds("desktop", { email: a, receipt: R70, currentReceipt: R76, answeredAt: T0 + 6, now: T0 + 4_000 }));
    expect(await row("SELECT subject_id, generation FROM updates_consent WHERE id=?", id)).toEqual({ subject_id: `receipt:${R76}`, generation: 2 });
  });
});
