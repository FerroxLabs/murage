// Updates consent B1 routes (design UPDATES-CONSENT-1020-CP-v5.md v5.6.1, 4.1 and 4.2) through the Worker's exported fetch, on real D1.
// Named by design test number (7.1). Every Sendlane call is counted by the injected fetch: all of these paths make none.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { subjectKey, type SendlaneFetch } from "../src/announcements";
import { createWorker } from "../src/index";
import { isUpdatesEarlyRequest, sendUpdatesOutbox, updatesProve } from "../src/updates-consent/routes";
import { emailKeyOf, sha256Hex } from "../src/updates-consent/tokens";

// @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
const sources = import.meta.glob(["../src/announcements.ts", "../src/updates-consent/*.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const BASE = "https://auth.murage.test";
const TOKEN = "site-forwarder-test-token-1234567890"; // secret-scan: fixture
let seq = 0;
const ip = () => `198.51.100.${(++seq % 250) + 1}`;
const rid = () => `req-${++seq}-${crypto.randomUUID()}`;
const addr = (tag: string) => `${tag}-${++seq}-${crypto.randomUUID().slice(0, 8)}@example.test`;

interface Mail { to: string; subject: string; text: string; headers?: Record<string, string> }
/** `true`: both T-C1 flags on; `false`: both off; an object: exactly those flags. */
function setup(open: boolean | Record<string, string> = true) {
  const mails: Mail[] = [];
  const fetches: string[] = [];
  const e = {
    ...env, MURAGE_ENV: "live", SITE_FORWARDER_TOKEN: TOKEN,
    ...(open === true ? { UPDATES_SIGNUPS_OPEN: "1", CP_ONECLICK_DKIM_VERIFIED: "1" } : open === false ? {} : open),
    EMAIL: { async send(m: Mail) { mails.push(m); } },
  } as unknown as Env;
  const sendlane: SendlaneFetch = async (url) => { fetches.push(String(url)); return new Response("{}"); };
  async function call(path: string, init: { method?: string; body?: unknown; form?: string; headers?: Record<string, string>; caller?: string } = {}) {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", init.caller ?? ip());
    let body: BodyInit | undefined;
    if (init.form !== undefined) body = init.form;
    else if (init.body !== undefined) { body = JSON.stringify(init.body); if (!headers.has("content-type")) headers.set("content-type", "application/json"); }
    const ctx = createExecutionContext();
    const res = await createWorker(fetch, sendlane).fetch(new Request(`${BASE}${path}`, { method: init.method ?? "POST", headers, body, redirect: "manual" }), e, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  const forward = (body: Record<string, unknown>) => call("/v1/announcements/subscribe", { body, headers: { "X-Murage-Site-Token": TOKEN } });
  return { e, mails, fetches, call, forward };
}

const count = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? 0;
const tokenFrom = (url: string) => new URL(url).searchParams.get("token")!;
const unsubUrlOf = (m: Mail) => m.headers!["List-Unsubscribe"]!.slice(1, -1);
const proveUrlOf = (m: Mail) => m.text.split("\n").find((l) => l.includes("/v1/updates-consent/prove?token="))!;
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const CP_ORIGIN = new URL(env.BETTER_AUTH_URL).origin;
const provenCount = (email: string) => count("SELECT count(*) AS n FROM updates_consent WHERE email=? AND proven_at IS NOT NULL", email);
/** Sends whatever is queued from earlier tests, so a test that counts claims sees only its own rows. */
async function drainOutbox(e: Env) {
  for (let i = 0; i < 40; i++) {
    const t = await sendUpdatesOutbox(e);
    if (t.sent + t.dropped + t.uncertain === 0) return;
  }
}

beforeEach(async () => {
  // 0149 seeds the real text rows (v5.6.2); the desktop tests also use a test-only version, v1.
  await env.DB.batch(["v1"].map((v) =>
    env.DB.prepare("INSERT OR IGNORE INTO updates_consent_texts (version, locale, body, effective_from) VALUES (?, 'en', 'test words', 0)").bind(v)));
});

// Route tests run many Worker fetches each; on the shared test host (load 50 to 85) the 5 s default times out in files B1 never
// touches as well (handoff, side-by-side runs). 20 s keeps a slow host from reading as a failure without hiding a hang.
const ROUTE_TIMEOUT_MS = 20_000;

describe("forwarder and 1.0.19 (4.2)", { timeout: ROUTE_TIMEOUT_MS }, () => {
  it("14: forwarded and 1.0.19 signups answer ok, call no provider, and queue one prove mail; only the forwarded one writes a 0145 row", async () => {
    const s = setup();
    const a = addr("fwd");
    const r1 = await s.forward({ email: a, source: "footer", consentText: "Yes, send me updates", requestId: rid() });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true });
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email=? AND source='footer' AND text_version='site-news'", a)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM updates_mail_outbox m JOIN updates_consent c ON c.id=m.consent_id WHERE c.email=? AND m.template='prove'", a)).toBe(1);
    const b = addr("leg");
    const r2 = await s.call("/v1/announcements/subscribe", { body: { email: b, name: "Pat" } });
    expect(r2.status).toBe(200);
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email=? AND source='legacy_desktop' AND text_version='legacy-pre-1.0.7'", b)).toBe(1);
    const consents = await count("SELECT count(*) AS n FROM announcement_consents");
    expect(consents).toBeGreaterThanOrEqual(1);
    expect(s.fetches).toEqual([]);
    expect(await s.e.DB.prepare("SELECT source FROM announcement_consents ORDER BY id DESC LIMIT 1").first<{ source: string }>()).toEqual({ source: "footer" });
  });

  it("59: a retry with the same requestId answers the first outcome, charges nothing and adds no row or mail", async () => {
    const s = setup();
    const a = addr("retry");
    const id = rid();
    for (let i = 0; i < 3; i++) expect(await (await s.forward({ email: a, source: "download", consentText: "Yes", requestId: id })).json()).toEqual({ ok: true });
    expect(await count("SELECT count(*) AS n FROM updates_mail_outbox m JOIN updates_consent c ON c.id=m.consent_id WHERE c.email=?", a)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM updates_requests WHERE request_id=?", id)).toBe(1);
  });

  it("61, 72: withGuide while unproven queues one guide_prove (guide: queued); a second ticked submission gets guide: none and no mail", async () => {
    const s = setup();
    const a = addr("guide");
    expect(await (await s.forward({ email: a, source: "guide", consentText: "Yes", withGuide: true, requestId: rid() })).json()).toEqual({ ok: true, guide: "queued" });
    expect(await (await s.forward({ email: a, source: "guide", consentText: "Yes", withGuide: true, requestId: rid() })).json()).toEqual({ ok: true, guide: "none" });
    expect(await count("SELECT count(*) AS n FROM updates_mail_outbox WHERE template='guide_prove'")).toBeGreaterThanOrEqual(1);
    expect(await count("SELECT count(*) AS n FROM updates_mail_outbox m JOIN updates_consent c ON c.id=m.consent_id WHERE c.email=?", a)).toBe(1);
  });

  it("80: a validation failure commits invalid once (committed: false); the same id with another payload gets no committed flag", async () => {
    const s = setup();
    const id = rid();
    const r1 = await s.forward({ email: "not an address", requestId: id });
    expect(r1.status).toBe(400);
    expect(await r1.json()).toEqual({ error: "invalid", committed: false });
    const r2 = await s.forward({ email: "still not", source: "footer", requestId: id });
    expect(r2.status).toBe(400);
    expect(await r2.json()).not.toHaveProperty("committed");
    // An admitted id later failing validation is answered as admitted, never committed: false.
    const ok = rid();
    await s.forward({ email: addr("adm"), requestId: ok });
    const r3 = await s.forward({ email: "bad", requestId: ok });
    expect(r3.status).toBe(200);
  });

  it("18, 81: a blocked address and an allowed one get the same answer and the same caller charge; at the caller limit both answer 429, in SQL", async () => {
    const s = setup();
    const caller = "203.0.113.99";
    const callerKey = await subjectKey("announce-caller", caller, env.BETTER_AUTH_SECRET);
    const charged = async () => (await env.DB.prepare("SELECT attempts FROM announcement_rate_limits WHERE subject_key=?").bind(callerKey)
      .first<{ attempts: number }>())?.attempts ?? 0;
    const block = async (email: string) => env.DB.prepare("INSERT INTO updates_exclusion_events (email_key,kind,observed_at,source,ref,at) VALUES (?,'complaint',?,'operator',NULL,?)")
      .bind(await emailKeyOf(email, env.BETTER_AUTH_SECRET), Date.now() - 60_000, Date.now() - 60_000).run();
    const seen: Array<[string, number, string, string, number]> = [];
    for (let i = 0; i < 10; i++) {
      const kind = i % 2 === 0 ? "blocked" : "allowed";
      const email = addr(kind);
      if (kind === "blocked") await block(email);
      const before = await charged();
      const r = await s.call("/v1/announcements/subscribe", { body: { email }, caller });
      const headers = Array.from(r.headers as unknown as Iterable<[string, string]>, ([h]) => h).filter((h) => h !== "x-request-id").sort().join(",");
      seen.push([kind, r.status, await r.text(), headers, (await charged()) - before]);
      expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email=?", email)).toBe(kind === "blocked" ? 0 : 1);
    }
    const shape = (k: string) => seen.filter((x) => x[0] === k).map((x) => x.slice(1));
    expect(shape("blocked")).toEqual(shape("allowed"));
    expect(shape("allowed")[0]).toEqual([200, JSON.stringify({ ok: true }), expect.any(String), 1]);
    for (const kind of ["blocked", "allowed"]) {
      const email = addr(kind);
      if (kind === "blocked") await block(email);
      const r = await s.call("/v1/announcements/subscribe", { body: { email }, caller });
      expect([kind, r.status, await r.json()]).toEqual([kind, 429, { error: "rate_limited" }]);
    }
    expect(await charged()).toBe(10);
    expect(s.fetches).toEqual([]);
  });

  it("67: either T-C1 flag alone off: /email charges no limit and writes nothing; an invalid forwarded body writes no request row and answers 400 without committed", async () => {
    const flagSets: Record<string, string>[] = [{ UPDATES_SIGNUPS_OPEN: "1" }, { CP_ONECLICK_DKIM_VERIFIED: "1" }];
    for (const flags of flagSets) {
      const s = setup(flags);
      const install = `inst-closed-${++seq}`;
      const caller = `203.0.113.${(++seq % 50) + 150}`;
      const keys = [await subjectKey("updates-install", install, env.BETTER_AUTH_SECRET), await subjectKey("updates-ip", caller, env.BETTER_AUTH_SECRET)];
      const limitRows = () => count(`SELECT count(*) AS n FROM announcement_rate_limits WHERE subject_key IN (?, ?)`, ...keys);
      const receipts: string[] = [];
      for (let i = 0; i < 7; i++) {
        const receiptHash = await sha256Hex(`rcpt-67-${crypto.randomUUID()}`);
        receipts.push(receiptHash);
        const r = await s.call("/v1/updates-consent/email", { body: { email: addr("cl67"), installId: install, textVersion: "v1", appVersion: "1.0.20",
          answeredAt: Date.now(), receiptHash }, caller });
        expect([JSON.stringify(flags), r.status, await r.json()]).toEqual([JSON.stringify(flags), 200, { ok: true, cloudContractVersion: 1 }]);
      }
      expect(await limitRows()).toBe(0);
      for (const receiptHash of receipts) {
        expect(await count("SELECT count(*) AS n FROM updates_requests WHERE subject_id=?", `receipt:${receiptHash}`)).toBe(0);
        expect(await count("SELECT count(*) AS n FROM updates_consent WHERE receipt_hash=?", receiptHash)).toBe(0);
      }
      for (const body of [{ email: "not an address" }, { email: addr("bad67"), source: "nowhere" }, { email: addr("bad67"), consentText: "   " }]) {
        const id = rid();
        const bad = await s.forward({ ...body, requestId: id });
        expect([bad.status, await bad.json()]).toEqual([400, { error: "invalid" }]);
        expect(await count("SELECT count(*) AS n FROM updates_requests WHERE request_id=?", id)).toBe(0);
      }
      const ok = addr("ok67");
      expect((await s.forward({ email: ok, requestId: rid() })).status).toBe(200);
      expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email=?", ok)).toBe(0);
    }
  });

  it("67: with CP_ONECLICK_DKIM_VERIFIED unset the new signup paths write nothing and the outbox sends nothing", async () => {
    const s = setup(false);
    const a = addr("closed");
    expect((await s.forward({ email: a, requestId: rid() })).status).toBe(200);
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email=?", a)).toBe(0);
    const open = setup(true);
    await open.forward({ email: a, requestId: rid() });
    expect(await sendUpdatesOutbox({ ...s.e, UPDATES_SIGNUPS_OPEN: "1" } as Env)).toEqual({ sent: 0, dropped: 0, uncertain: 0 });
    expect(s.mails).toEqual([]);
  });

  it("13: the site unsubscribe writes the opt-outs and our_unsub, withdraws the rows, and calls no provider", async () => {
    const s = setup();
    const a = addr("su");
    await s.forward({ email: a, requestId: rid() });
    const r = await s.call("/v1/announcements/unsubscribe", { body: { email: a }, headers: { "X-Murage-Site-Token": TOKEN } });
    expect(r.status).toBe(200);
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email=? AND status='withdrawn' AND off_by='site'", a)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM updates_mail_outbox m JOIN updates_consent c ON c.id=m.consent_id WHERE c.email=? AND m.state='dropped'", a)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM updates_exclusion_events e JOIN updates_consent c ON c.email_key=e.email_key WHERE c.email=? AND e.kind='our_unsub' AND e.source='site'", a)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM updates_exclusion_events e JOIN updates_consent c ON c.email_key=e.email_key WHERE c.email=? AND e.kind='list37'", a)).toBe(1);
    expect(s.fetches).toEqual([]);
  });

  it("18: source rule: no updates path calls refundAttempt, writeGate, addSubscriber or settleRace", () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(text, file).not.toMatch(/\b(refundAttempt|writeGate|addSubscriber|settleRace|optedOutShortCircuit|clearCompPending)\s*\(/);
    }
  });
});

describe("outbox, prove and the one-click unsubscribe (3.3 O, 4.1)", { timeout: ROUTE_TIMEOUT_MS }, () => {
  it("50, 74, 42: the prove mail carries the one-click pair; one-click through fetch withdraws once; repeats answer the same 200", async () => {
    const s = setup();
    const a = addr("oc");
    await s.forward({ email: a, source: "waitlist", requestId: rid() });
    const tally = await sendUpdatesOutbox(s.e);
    expect(tally.sent).toBeGreaterThanOrEqual(1);
    const mail = s.mails.find((m) => m.to === a)!;
    expect(Object.keys(mail.headers!).sort()).toEqual(["List-Unsubscribe", "List-Unsubscribe-Post"]);
    expect(mail.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const unsub = unsubUrlOf(mail);
    expect(unsub).toMatch(/^https:\/\/.+\/v1\/updates-consent\/unsubscribe\?token=[0-9a-f]{64}$/);
    const path = `/v1/updates-consent/unsubscribe?token=${tokenFrom(unsub)}`;

    const g = await s.call(path, { method: "GET" });
    expect(g.status).toBe(200);
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email=? AND status='withdrawn'", a)).toBe(0);
    const p1 = await s.call(path, { form: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(p1.status).toBe(200);
    expect(p1.headers.get("server-timing")).toBeNull();
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email=? AND status='withdrawn' AND off_by='link'", a)).toBe(1);
    const events = "SELECT count(*) AS n FROM updates_exclusion_events e JOIN updates_consent c ON c.email_key=e.email_key WHERE c.email=? AND e.kind='our_unsub' AND e.source='one_click'";
    expect(await count(events, a)).toBe(1);
    const p2 = await s.call(path, { form: "confirm=1", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://cp.example" } });
    expect(p2.status).toBe(200);
    expect(await count(events, a)).toBe(1);
    expect((await s.call(path, { body: { x: 1 } })).status).toBe(415);
    expect((await s.call(`/v1/updates-consent/unsubscribe?token=${"a".repeat(64)}`, { form: "confirm=1", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(404);
    expect(s.fetches).toEqual([]);
  });

  it("6, 46: POST /prove proves once and answers 303 confirmed; a second POST answers link-expired; GET changes nothing", async () => {
    const s = setup();
    const a = addr("pv");
    await s.forward({ email: a, requestId: rid() });
    await sendUpdatesOutbox(s.e);
    const token = tokenFrom(proveUrlOf(s.mails.find((m) => m.to === a)!));
    expect((await s.call(`/v1/updates-consent/prove?token=${token}`, { method: "GET" })).status).toBe(200);
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email=? AND proven_at IS NOT NULL", a)).toBe(0);
    const p1 = await s.call("/v1/updates-consent/prove", { form: `token=${token}`, headers: { ...FORM, origin: CP_ORIGIN } });
    expect(p1.status).toBe(303);
    expect(p1.headers.get("location")).toBe("https://murage.ai/updates/confirmed");
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email=? AND proven_at IS NOT NULL", a)).toBe(1);
    const p2 = await s.call("/v1/updates-consent/prove", { form: `token=${token}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(p2.headers.get("location")).toBe("https://murage.ai/updates/link-expired");
    expect(await count("SELECT count(*) AS n FROM updates_consent_events e JOIN updates_consent c ON c.id=e.consent_id WHERE c.email=? AND e.actor='prove'", a)).toBe(1);
  });

  it("origin (B1 r1 Grok M3): only the one-click unsubscribe skips the origin check; POST /prove takes this Worker's own origin or none; GET /prove never confirms; other paths still refuse", async () => {
    const s = setup();
    const evil = "https://evil.example";
    const req = (path: string, method: string) => new Request(`${BASE}${path}`, { method });
    expect(isUpdatesEarlyRequest(req("/v1/updates-consent/prove", "POST"))).toBe(false);
    expect(isUpdatesEarlyRequest(req("/v1/updates-consent/prove", "GET"))).toBe(false);
    expect(isUpdatesEarlyRequest(req("/v1/updates-consent/unsubscribe", "POST"))).toBe(true);
    expect(isUpdatesEarlyRequest(req("/v1/updates-consent/unsubscribe", "GET"))).toBe(true);
    expect(isUpdatesEarlyRequest(req("/v1/updates-consent/unsubscribe", "PUT"))).toBe(false);
    expect(isUpdatesEarlyRequest(req("/v1/updates-consent/email", "POST"))).toBe(false);
    const a = addr("org");
    await s.forward({ email: a, requestId: rid() });
    await sendUpdatesOutbox(s.e);
    const mail = s.mails.find((m) => m.to === a)!;
    const token = tokenFrom(proveUrlOf(mail));
    // A foreign origin, and an origin the CP allows elsewhere (ALLOWED_ORIGINS), are both refused on POST /prove.
    for (const origin of [evil, "https://app.murage.test"]) {
      const r = await s.call("/v1/updates-consent/prove", { form: `token=${token}`, headers: { ...FORM, origin } });
      expect([origin, r.status, await r.json()]).toEqual([origin, 403, { error: "origin_not_allowed" }]);
    }
    expect(await provenCount(a)).toBe(0);
    // GET with no Origin (a navigation) is the page, through the normal path; it confirms nothing and makes its form POST carry this origin.
    const g = await s.call(`/v1/updates-consent/prove?token=${token}`, { method: "GET" });
    expect(g.status).toBe(200);
    expect(await g.text()).toContain(`<meta name="referrer" content="same-origin">`);
    expect(g.headers.get("server-timing")).toBeNull();
    expect((await s.call(`/v1/updates-consent/prove?token=${token}`, { method: "GET", headers: { origin: evil } })).status).toBe(403);
    expect(await provenCount(a)).toBe(0);
    const ok = await s.call("/v1/updates-consent/prove", { form: `token=${token}`, headers: { ...FORM, origin: CP_ORIGIN } });
    expect([ok.status, ok.headers.get("location"), ok.headers.get("server-timing")]).toEqual([303, "https://murage.ai/updates/confirmed", null]);
    expect(await provenCount(a)).toBe(1);
    // Every other updates path still enforces the origin check.
    for (const path of ["/v1/updates-consent/email", "/v1/updates-consent/status", "/v1/updates-consent/withdraw", "/v1/updates-consent/export", "/v1/announcements/subscribe"]) {
      const r = await s.call(path, { body: {}, headers: { origin: evil } });
      expect([path, r.status, await r.json()]).toEqual([path, 403, { error: "origin_not_allowed" }]);
    }
    // The one-click unsubscribe still answers whatever the Origin (RFC 8058).
    const u = await s.call(`/v1/updates-consent/unsubscribe?token=${tokenFrom(unsubUrlOf(mail))}`, { form: "List-Unsubscribe=One-Click", headers: { ...FORM, origin: evil } });
    expect(u.status).toBe(200);
  });

  it("prove reads the clock after the form body (B1 r1 Astra M): a body that arrives after the token expired confirms nothing", async () => {
    const s = setup();
    const a = addr("late");
    await s.forward({ email: a, requestId: rid() });
    await sendUpdatesOutbox(s.e);
    const token = tokenFrom(proveUrlOf(s.mails.find((m) => m.to === a)!));
    const expires = (await env.DB.prepare("SELECT expires_at AS x FROM updates_tokens WHERE token_hash=?").bind(await sha256Hex(token)).first<{ x: number }>())!.x;
    expect(expires).toBeGreaterThan(Date.now());
    // A request object whose body arrives only when read; reading it moves the clock past the token's expiry.
    const bytes = new TextEncoder().encode(`token=${token}`);
    let delivered = false;
    const late = {
      method: "POST", url: `${BASE}/v1/updates-consent/prove`, headers: new Headers({ ...FORM, "cf-connecting-ip": ip() }),
      body: { getReader: () => ({
        async read() {
          if (delivered) return { done: true, value: undefined };
          delivered = true;
          vi.spyOn(Date, "now").mockReturnValue(expires + 1);
          return { done: false, value: bytes };
        },
        async cancel() {}, releaseLock() {},
      }) },
    } as unknown as Request;
    let res: Response;
    try { res = await updatesProve(late, s.e); } finally { vi.restoreAllMocks(); }
    expect(delivered).toBe(true);
    expect(res.headers.get("location")).toBe("https://murage.ai/updates/link-expired");
    expect(await provenCount(a)).toBe(0);
    // The same token on time still proves.
    const ok = await s.call("/v1/updates-consent/prove", { form: `token=${token}`, headers: FORM });
    expect(ok.headers.get("location")).toBe("https://murage.ai/updates/confirmed");
  });

  it("the outbox reads the clock for each claim (B1 r1 Astra M): a slow earlier send past the next token's expiry drops that row unsent", async () => {
    const s = setup();
    await drainOutbox(s.e);
    const a1 = addr("slow1"), a2 = addr("slow2");
    await s.forward({ email: a1, requestId: rid() });
    await s.forward({ email: a2, requestId: rid() });
    const expiry = async (a: string) => (await env.DB.prepare(`SELECT max(t.expires_at) AS x FROM updates_tokens t JOIN updates_consent c ON c.id=t.consent_id
      WHERE c.email=? AND t.purpose='prove'`).bind(a).first<{ x: number }>())!.x;
    const past = Math.max(await expiry(a1), await expiry(a2)) + 1;
    let now = Date.now();
    const sent: string[] = [];
    const slow = { ...s.e, EMAIL: { async send(m: Mail) { sent.push(m.to); now = past; } } } as unknown as Env;
    const tally = await sendUpdatesOutbox(slow, () => now);
    expect(sent).toHaveLength(1);
    expect(tally).toEqual({ sent: 1, dropped: 1, uncertain: 0 });
    const states = await env.DB.prepare(`SELECT c.email AS email, m.state AS state FROM updates_mail_outbox m JOIN updates_consent c ON c.id=m.consent_id
      WHERE c.email IN (?, ?)`).bind(a1, a2).all<{ email: string; state: string }>();
    expect(Object.fromEntries(states.results.map((r) => [r.email, r.state]))).toEqual({ [sent[0]!]: "sent", [sent[0] === a1 ? a2 : a1]: "dropped" });
  });

  it("no telemetry on the anonymous signup and the site unsubscribe (B1 r1 Grok L6): no Server-Timing, no bookmark", async () => {
    const s = setup();
    const a = addr("st");
    const responses = [
      await s.call("/v1/announcements/subscribe", { body: { email: a } }),
      await s.forward({ email: addr("st"), requestId: rid() }),
      await s.call("/v1/announcements/unsubscribe", { body: { email: a }, headers: { "X-Murage-Site-Token": TOKEN } }),
    ];
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect([r.headers.get("server-timing"), r.headers.get("x-d1-bookmark")]).toEqual([null, null]);
    }
  });

  it("5: a send that throws settles the row uncertain and it is never claimed again", async () => {
    const s = setup();
    const a = addr("thr");
    await s.forward({ email: a, requestId: rid() });
    const failing = { ...s.e, EMAIL: { async send() { throw new Error("E_HEADER_NOT_ALLOWED"); } } } as unknown as Env;
    expect((await sendUpdatesOutbox(failing)).uncertain).toBeGreaterThanOrEqual(1);
    expect(await count("SELECT count(*) AS n FROM updates_mail_outbox m JOIN updates_consent c ON c.id=m.consent_id WHERE c.email=? AND m.state='uncertain'", a)).toBe(1);
    await sendUpdatesOutbox(s.e);
    expect(s.mails.filter((m) => m.to === a)).toEqual([]);
  });

  it("84: an our_unsub appended after G queued the mail drops it at claim; no send, no unsubscribe token", async () => {
    const s = setup();
    const a = addr("drop");
    await s.forward({ email: a, requestId: rid() });
    const key = (await env.DB.prepare("SELECT email_key FROM updates_consent WHERE email=?").bind(a).first<{ email_key: string }>())!.email_key;
    await env.DB.prepare("INSERT INTO updates_exclusion_events (email_key,kind,observed_at,source,ref,at) VALUES (?,'our_unsub',?,'operator',NULL,?)").bind(key, Date.now() + 1, Date.now() + 1).run();
    await sendUpdatesOutbox(s.e, () => Date.now() + 2);
    expect(s.mails.filter((m) => m.to === a)).toEqual([]);
    expect(await count("SELECT count(*) AS n FROM updates_mail_outbox m JOIN updates_consent c ON c.id=m.consent_id WHERE c.email=? AND m.state='dropped'", a)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM updates_tokens WHERE purpose='unsub' AND email_key=?", key)).toBe(0);
  });
});

describe("desktop routes by receipt (4.1)", { timeout: ROUTE_TIMEOUT_MS }, () => {
  it("1, 17, 9: /email queues one prove mail; /status, /export and /withdraw answer by receipt; unknown receipts answer the same shape", async () => {
    const s = setup();
    const a = addr("desk");
    const receipt = `rcpt-${crypto.randomUUID()}`;
    const receiptHash = await sha256Hex(receipt);
    const now = Date.now();
    const body = { email: a, installId: `inst-${seq}`, textVersion: "v1", appVersion: "1.0.20", answeredAt: now, receiptHash };
    const r = await s.call("/v1/updates-consent/email", { body });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, cloudContractVersion: 1 });
    expect(r.headers.get("server-timing")).toBeNull();
    expect(await count("SELECT count(*) AS n FROM updates_mail_outbox m JOIN updates_consent c ON c.id=m.consent_id WHERE c.receipt_hash=?", receiptHash)).toBe(1);
    // Before mailbox proof a receipt reads as unknown (B1 r2 Astra M: no blocked-address oracle).
    expect(await (await s.call("/v1/updates-consent/status", { body: { receipt } })).json()).toEqual({ status: null, cloudContractVersion: 1 });
    expect(await (await s.call("/v1/updates-consent/export", { body: { receipt } })).json()).toEqual({ consent: null, events: [], cloudContractVersion: 1 });
    await sendUpdatesOutbox(s.e);
    const token = tokenFrom(proveUrlOf(s.mails.filter((m) => m.to === a).at(-1)!));
    expect((await s.call("/v1/updates-consent/prove", { form: `token=${token}`, headers: { ...FORM, origin: CP_ORIGIN } })).status).toBe(303);
    expect(await (await s.call("/v1/updates-consent/status", { body: { receipt } })).json()).toEqual({ status: "opted_in", proven: true, cloudContractVersion: 1 });
    const ex = await (await s.call("/v1/updates-consent/export", { body: { receipt } })).json() as { consent: Record<string, unknown>; events: unknown[] };
    expect(ex.consent).toMatchObject({ status: "opted_in", textVersion: "v1", proven: true });
    expect(ex.events).toHaveLength(2); // the signup and the proof
    const unknown = await (await s.call("/v1/updates-consent/export", { body: { receipt: `rcpt-${crypto.randomUUID()}` } })).json();
    expect(unknown).toEqual({ consent: null, events: [], cloudContractVersion: 1 });
    expect((await s.call("/v1/updates-consent/withdraw", { body: { receipt } })).status).toBe(204);
    expect((await s.call("/v1/updates-consent/withdraw", { body: { receipt } })).status).toBe(204);
    // A withdraw keeps the proof marker, so the owner still reads the turned-off record.
    expect(await (await s.call("/v1/updates-consent/status", { body: { receipt } })).json()).toEqual({ status: "withdrawn", proven: false, offBy: "Turned off", cloudContractVersion: 1 });
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE receipt_hash=? AND generation=3", receiptHash)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM updates_tokens WHERE purpose='prove' AND email_key=(SELECT email_key FROM updates_consent WHERE receipt_hash=?)", receiptHash)).toBe(0);
    expect((await s.call("/v1/updates-consent/withdraw", { body: { receipt: `rcpt-${crypto.randomUUID()}` } })).status).toBe(204);
    expect(await (await s.call("/v1/updates-consent/status", { body: { receipt: `rcpt-${crypto.randomUUID()}` } })).json()).toEqual({ status: null, cloudContractVersion: 1 });
    expect(s.fetches).toEqual([]);
  });

  it("B1 r2 (Astra M): before mailbox proof /status and /export answer byte for byte the same for a refused address and an allowed one, mail-capped or not, withdrawn or not", async () => {
    const s = setup();
    const blocked = addr("oracle-blocked"), allowed = addr("oracle-allowed"), capped = addr("oracle-capped");
    await env.DB.prepare("INSERT INTO updates_exclusion_events (email_key,kind,observed_at,source,ref,at) VALUES (?,'complaint',?,'operator',NULL,?)")
      .bind(await emailKeyOf(blocked, env.BETTER_AUTH_SECRET), Date.now() - 1_000, Date.now() - 1_000).run();
    const k = await subjectKey("updates-prove-mail", await emailKeyOf(capped, env.BETTER_AUTH_SECRET), env.BETTER_AUTH_SECRET);
    await env.DB.prepare("INSERT INTO announcement_rate_limits (subject_key, window_started_at, attempts, updated_at) VALUES (?, ?, 3, ?)")
      .bind(k, Date.now(), Date.now()).run();
    const read = async (receipt: string) => [
      await (await s.call("/v1/updates-consent/status", { body: { receipt } })).text(),
      await (await s.call("/v1/updates-consent/export", { body: { receipt } })).text(),
    ];
    const bodies: string[][] = [];
    for (const email of [blocked, allowed, capped]) {
      const receipt = `rcpt-${crypto.randomUUID()}`;
      const r = await s.call("/v1/updates-consent/email", { body: { email, installId: `inst-${seq}`, textVersion: "v1", appVersion: "1.0.20",
        answeredAt: Date.now() - 1_000, receiptHash: await sha256Hex(receipt) } });
      expect(r.status).toBe(200);
      bodies.push(await read(receipt));
      expect((await s.call("/v1/updates-consent/withdraw", { body: { receipt } })).status).toBe(204);
      bodies.push(await read(receipt));
    }
    // The allowed and capped addresses did get a row; the refused one did not. The reads cannot tell them apart.
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email_key=?", await emailKeyOf(allowed, env.BETTER_AUTH_SECRET))).toBe(1);
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email_key=?", await emailKeyOf(blocked, env.BETTER_AUTH_SECRET))).toBe(0);
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect(bodies[0]).toEqual(['{"status":null,"cloudContractVersion":1}', '{"consent":null,"events":[],"cloudContractVersion":1}']);
  });

  it("B1 r3 (Astra M): a proven receipt that asks to change to an allowed or a refused address reads byte for byte the same afterwards, on the same receipt and on a rotation", async () => {
    const s = setup();
    const UNKNOWN = ['{"status":null,"cloudContractVersion":1}', '{"consent":null,"events":[],"cloudContractVersion":1}'];
    const read = async (receipt: string) => [
      await (await s.call("/v1/updates-consent/status", { body: { receipt } })).text(),
      await (await s.call("/v1/updates-consent/export", { body: { receipt } })).text(),
    ];
    const email = (b: Record<string, unknown>) => s.call("/v1/updates-consent/email", { body: { installId: `inst-${++seq}`, textVersion: "v1", appVersion: "1.0.20", ...b } });
    /** The attacker's own address A, proven on receipt R. */
    const provenReceipt = async () => {
      const own = addr("r3-own"), receipt = `rcpt-${crypto.randomUUID()}`;
      expect((await email({ email: own, answeredAt: Date.now() - 5_000, receiptHash: await sha256Hex(receipt) })).status).toBe(200);
      await drainOutbox(s.e);
      const token = tokenFrom(proveUrlOf(s.mails.filter((m) => m.to === own).at(-1)!));
      expect((await s.call("/v1/updates-consent/prove", { form: `token=${token}`, headers: { ...FORM, origin: CP_ORIGIN } })).status).toBe(303);
      expect(JSON.parse((await read(receipt))[0]!)).toMatchObject({ status: "opted_in", proven: true });
      return { own, receipt };
    };
    const blockedKeys: string[] = [];
    const target = async (blocked: boolean) => {
      const t = addr(blocked ? "r3-blocked" : "r3-allowed");
      if (blocked) {
        const k = await emailKeyOf(t, env.BETTER_AUTH_SECRET);
        blockedKeys.push(k);
        await env.DB.prepare("INSERT INTO updates_exclusion_events (email_key,kind,observed_at,source,ref,at) VALUES (?,'complaint',?,'operator',NULL,?)")
          .bind(k, Date.now() - 10_000, Date.now() - 10_000).run();
      }
      return t;
    };
    const events = (receiptHash: string) => count("SELECT count(*) AS n FROM updates_consent_events e JOIN updates_consent c ON c.id=e.consent_id WHERE c.receipt_hash=?", receiptHash);
    const out: Record<string, string[]> = {};
    for (const blocked of [false, true]) {
      // Same receipt: receiptHash = sha256(R), currentReceipt = R, a newer answeredAt.
      const a = await provenReceipt();
      const aHash = await sha256Hex(a.receipt);
      const before = await events(aHash);
      expect((await email({ email: await target(blocked), answeredAt: Date.now() - 1_000, receiptHash: aHash, currentReceipt: a.receipt })).status).toBe(200);
      out[`same-${blocked}`] = await read(a.receipt);
      // A refused target writes no event; an allowed one writes RS4's (hidden by the read gate until a new proof).
      expect(await events(aHash)).toBe(before + (blocked ? 0 : 1));
      // Rotation: receiptHash = sha256(R2), currentReceipt = R.
      const b = await provenReceipt();
      const r2 = `rcpt-${crypto.randomUUID()}`;
      expect((await email({ email: await target(blocked), answeredAt: Date.now() - 1_000, receiptHash: await sha256Hex(r2), currentReceipt: b.receipt })).status).toBe(200);
      out[`rot-old-${blocked}`] = await read(b.receipt);
      out[`rot-new-${blocked}`] = await read(r2);
      // The refused attempt kept A on its row and minted nothing for the target.
      if (blocked) {
        for (const r of [a, b]) {
          const row = await env.DB.prepare("SELECT email, proven_at, unproven_since FROM updates_consent WHERE receipt_hash=?").bind(await sha256Hex(r.receipt))
            .first<{ email: string; proven_at: number | null; unproven_since: number | null }>();
          expect(row).toMatchObject({ email: r.own, proven_at: null });
          expect(row?.unproven_since).not.toBeNull();
        }
      }
    }
    for (const k of blockedKeys) {
      expect(await count("SELECT count(*) AS n FROM updates_consent WHERE email_key=?", k)).toBe(0);
      expect(await count("SELECT count(*) AS n FROM updates_obligations WHERE email_key=?", k)).toBe(0);
    }
    for (const [name, b] of Object.entries(out)) expect([name, b]).toEqual([name, UNKNOWN]);
    // A same-address resubmit on a proven receipt is not an address change: the owner still reads the record.
    const c = await provenReceipt();
    const cHash = await sha256Hex(c.receipt);
    expect((await email({ email: c.own, answeredAt: Date.now() - 1_000, receiptHash: cHash, currentReceipt: c.receipt })).status).toBe(200);
    expect(JSON.parse((await read(c.receipt))[0]!)).toMatchObject({ status: "opted_in", proven: true });
    expect(s.fetches).toEqual([]);
  });

  it("bad textVersion and answeredAt answer 400 without revealing anything", async () => {
    const s = setup();
    const base = { email: addr("bad"), installId: "inst-bad", appVersion: "1.0.20", receiptHash: await sha256Hex("rcpt-bad-000000000"), answeredAt: Date.now() };
    const r1 = await s.call("/v1/updates-consent/email", { body: { ...base, textVersion: "nope" } });
    expect(r1.status).toBe(400);
    expect(await r1.json()).toEqual({ error: "bad_text_version" });
    const r2 = await s.call("/v1/updates-consent/email", { body: { ...base, textVersion: "v1", answeredAt: Date.now() + 10 * 60_000 } });
    expect(await r2.json()).toEqual({ error: "bad_answered_at" });
  });

  it("held text 2026-11-06 (the unbuilt 1.0.20 card, its row holds \"[field]\"): /email refuses it as bad_text_version and SQL refuses any row pointing at it", async () => {
    const s = setup();
    const receiptHash = await sha256Hex(`rcpt-held-${crypto.randomUUID()}`);
    const r = await s.call("/v1/updates-consent/email", { body: { email: addr("held"), installId: "inst-held", appVersion: "1.0.20", receiptHash,
      answeredAt: Date.now(), textVersion: "2026-11-06" } });
    expect([r.status, await r.json()]).toEqual([400, { error: "bad_text_version" }]);
    expect(await count("SELECT count(*) AS n FROM updates_consent WHERE receipt_hash=?", receiptHash)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM updates_consent_texts WHERE version='2026-11-06' AND body LIKE '%[field]%'")).toBe(1);
    // The backstop: no statement can write a consent row on that version, by INSERT or by UPDATE.
    const t = Date.now();
    const insert = (v: string, id: string, rh: string) => env.DB.prepare(`INSERT INTO updates_consent (id,kind,subject_id,receipt_hash,email,email_key,status,
      generation,unproven_since,consented_at,mut_nonce,text_version,app_version,source,answered_at,status_changed_at,created_at,updated_at)
      VALUES (?, 'receipt', ?, ?, ?, ?, 'opted_in', 1, ?, ?, ?, ?, '1.0.20', 'desktop', ?, ?, ?, ?)`)
      .bind(id, `receipt:${rh}`, rh, addr("heldsql"), "k".repeat(64), t, t, crypto.randomUUID(), v, t, t, t, t).run();
    await expect(insert("2026-11-06", crypto.randomUUID(), receiptHash)).rejects.toThrow(/text_version_held/);
    const id = crypto.randomUUID();
    await insert("v1", id, receiptHash);
    await expect(env.DB.prepare("UPDATE updates_consent SET text_version='2026-11-06' WHERE id=?").bind(id).run()).rejects.toThrow(/text_version_held/);
    expect((await env.DB.prepare("SELECT text_version AS v FROM updates_consent WHERE id=?").bind(id).first<{ v: string }>())?.v).toBe("v1");
  });
});
