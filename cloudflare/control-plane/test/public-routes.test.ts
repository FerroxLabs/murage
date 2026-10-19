// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP7: the public route shell (BUILD-PLAN C.1) over the real worker: no login, inert GET, deliberate POST, errors {error}.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { clearPublicHandlers, publicRoute, registerPublicHandlers } from "../src/public-routes";
import { commitToken, issueToken, sweepPublicTokens, whenConsumed, type IdentityRead, type TokenBinding, type Verified } from "../src/public-tokens";
import { q } from "../src/billing-lease";

const USER = "5f0c1b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const DAY = 86_400_000;
let supa: IdentityRead;
let readerDown = false;
let readerCalls = 0;
const reader = { async emailGen(): Promise<IdentityRead> { readerCalls += 1; if (readerDown) throw new Error("down"); return { ...supa }; } };
const worker = createWorker();
const testEnv = () => ({ ...env, IDENTITY_READER: reader, MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined }) as unknown as Env;

async function call(path: string, body?: unknown, method = "POST", headers: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://cp.test${path}`, {
    method, headers: { "content-type": "application/json", ...headers }, body: method === "GET" ? undefined : JSON.stringify(body) }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
const binding = (over: Partial<TokenBinding> = {}): TokenBinding => ({ purpose: "confirm", subjectKind: "notice", subjectId: "notice-1", accountId: USER,
  accountEmail: "pat@example.test", supabaseUpdatedAt: "2026-10-01T00:00:00.000Z", receivedAt: Date.now(), ...over });
async function issue(over: Partial<TokenBinding> = {}) {
  const t = (await issueToken(testEnv(), { reader }, binding(over)))!;
  const [selector, secret] = t.token.split(".");
  return { ...t, selector, secret };
}
const usedAt = async (selector: string) => (await env.DB.prepare("SELECT used_at FROM verify_tokens WHERE selector=?").bind(selector).first<{ used_at: number | null }>())!.used_at;

beforeEach(() => { supa = { id: USER, email: "pat@example.test", updatedAt: "2026-10-01T00:00:00.000Z" }; readerDown = false; readerCalls = 0; clearPublicHandlers(); });
afterEach(() => clearPublicHandlers());

describe("lookup", () => {
  it("is read-only: open, then still open after many lookups; never consumes, never calls the reader; no login needed", async () => {
    const t = await issue({ receivedAt: Date.now() - DAY });
    for (let i = 0; i < 5; i += 1) {
      const r = await call("/v1/public/token/lookup", { selector: t.selector, secret: t.secret });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ kind: "withdrawal", state: "open" });
      expect(r.body.executeByDate).toBe(new Date(Date.now() - DAY + 13 * DAY).toISOString().slice(0, 10));
    }
    expect(readerCalls).toBe(0);
    expect(await usedAt(t.selector)).toBeNull();
  });
  it("kinds: cancellation subject, clarify with its action", async () => {
    const c = await issue({ subjectKind: "cancellation", subjectId: "c-1", purpose: "repudiate" });
    expect((await call("/v1/public/token/lookup", { selector: c.selector, secret: c.secret })).body).toMatchObject({ kind: "cancellation", state: "open" });
    const k = await issue({ purpose: "clarify", action: "cancel_at_end", classificationRev: 2 });
    expect((await call("/v1/public/token/lookup", { selector: k.selector, secret: k.secret })).body).toMatchObject({ kind: "clarify", action: "cancel_at_end", state: "open" });
  });
  it("an unknown selector and a wrong secret get the identical shape: state refused", async () => {
    const t = await issue();
    const a = await call("/v1/public/token/lookup", { selector: "q".repeat(22), secret: t.secret });
    const b = await call("/v1/public/token/lookup", { selector: t.selector, secret: "z".repeat(43) });
    const c = await call("/v1/public/token/lookup", { selector: "short", secret: "x" });
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a).toEqual({ status: 200, body: { kind: "withdrawal", state: "refused" } });
  });
  it("shows used and expired from the committed row", async () => {
    const t = await issue();
    await env.DB.prepare("UPDATE verify_tokens SET used_at=1,used_by='x' WHERE selector=?").bind(t.selector).run();
    expect((await call("/v1/public/token/lookup", { selector: t.selector, secret: t.secret })).body.state).toBe("used");
    const e = await issue({ subjectId: "n2" });
    await env.DB.prepare("UPDATE verify_tokens SET expires_at=? WHERE selector=?").bind(Date.now() - 1, e.selector).run();
    // the stored expiry is part of the HMAC: an edited row is refused rather than reported
    expect((await call("/v1/public/token/lookup", { selector: e.selector, secret: e.secret })).body.state).toBe("refused");
  });
  it("is rate limited per selector (429 {error})", async () => {
    const t = await issue();
    let last = { status: 0, body: {} as Record<string, unknown> };
    for (let i = 0; i < 31; i += 1) last = await call("/v1/public/token/lookup", { selector: t.selector, secret: t.secret });
    expect(last).toEqual({ status: 429, body: { error: "rate_limited" } });
    const other = await issue({ subjectId: "n3" });
    expect((await call("/v1/public/token/lookup", { selector: other.selector, secret: other.secret })).status).toBe(200);
  });
  it("adds what the subject's owner describes, never overriding the token facts", async () => {
    registerPublicHandlers({ describe: async () => ({ planName: "Pro", planStartedOn: "2026-10-01", effectiveAt: 1234 }) });
    const t = await issue();
    expect((await call("/v1/public/token/lookup", { selector: t.selector, secret: t.secret })).body).toMatchObject({ planName: "Pro", planStartedOn: "2026-10-01", effectiveAt: 1234 });
  });
  it("bad JSON shape is 400 {error: invalid_request}; wrong content type 415", async () => {
    expect(await call("/v1/public/token/lookup", { selector: "x" })).toEqual({ status: 400, body: { error: "invalid_request" } });
    expect(await call("/v1/public/token/lookup", { selector: "x", secret: "y", extra: 1 })).toEqual({ status: 400, body: { error: "invalid_request" } });
    const r = await call("/v1/public/token/lookup", "x", "POST", { "content-type": "text/plain" });
    expect(r.status).toBe(415);
  });
});

describe("GET is inert", () => {
  it("every token route answers 405 {error} to GET, with the token in the query or not, and changes nothing", async () => {
    const t = await issue();
    let seen = 0;
    registerPublicHandlers({ confirm: async () => { seen += 1; return null; }, repudiate: async () => { seen += 1; return null; }, clarify: async () => { seen += 1; return null; } });
    for (const path of ["/v1/public/token/lookup", "/v1/public/withdrawal/confirm", "/v1/public/withdrawal/repudiate", "/v1/public/withdrawal/new-link", "/v1/public/clarify"]) {
      for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
        const ctx = createExecutionContext();
        const res = await worker.fetch(new Request(`https://cp.test${path}?selector=${t.selector}&secret=${t.secret}#${t.token}`, { method }), testEnv(), ctx);
        await waitOnExecutionContext(ctx);
        expect(res.status, `${method} ${path}`).toBe(405);
      }
    }
    expect(seen).toBe(0);
    expect(readerCalls).toBe(0);
    expect(await usedAt(t.selector)).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM public_mail_limits").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("act routes: token checks come first, nothing is consumed by a refusal", () => {
  const confirm = (t: { selector: string; secret: string }) => call("/v1/public/withdrawal/confirm", { selector: t.selector, secret: t.secret });
  const repudiate = (t: { selector: string; secret: string }) => call("/v1/public/withdrawal/repudiate", { selector: t.selector, secret: t.secret });
  it("a genuine link with no handler registered is 501 not_implemented and stays unconsumed", async () => {
    const t = await issue();
    expect(await confirm(t)).toEqual({ status: 501, body: { error: "not_implemented" } });
    expect(await usedAt(t.selector)).toBeNull();
  });
  it("a confirm token at the repudiate endpoint is refused, and the reverse; neither is consumed", async () => {
    const calls: string[] = [];
    registerPublicHandlers({ confirm: async () => { calls.push("confirm"); return null; }, repudiate: async () => { calls.push("repudiate"); return null; } });
    const c = await issue({ purpose: "confirm" });
    const r = await issue({ purpose: "repudiate" });
    expect(await repudiate(c)).toEqual({ status: 409, body: { error: "link_invalid", canResend: false } });
    expect(await confirm(r)).toEqual({ status: 409, body: { error: "link_invalid", canResend: false } });
    expect(await call("/v1/public/clarify", { selector: c.selector, secret: c.secret, action: "withdraw_now" })).toEqual({ status: 409, body: { error: "link_invalid", canResend: false } });
    expect(calls).toEqual([]);
    expect(await usedAt(c.selector)).toBeNull();
    expect(await usedAt(r.selector)).toBeNull();
  });
  it("expired and identity-changed links offer a new link; the reader being down is 503 identity_unavailable; none consume", async () => {
    registerPublicHandlers({ confirm: async () => { throw new Error("handler must not run"); } });
    const e = await issue({ receivedAt: Date.now() - 14 * DAY + 50 });
    await new Promise((r) => setTimeout(r, 80));
    expect(await confirm(e)).toEqual({ status: 409, body: { error: "link_expired", canResend: true } });
    const t = await issue({ subjectId: "n2" });
    supa.updatedAt = "2026-10-05T00:00:00.000Z";
    expect(await confirm(t)).toEqual({ status: 409, body: { error: "identity_changed", canResend: true } });
    supa.updatedAt = "2026-10-01T00:00:00.000Z";
    readerDown = true;
    expect(await confirm(t)).toEqual({ status: 503, body: { error: "identity_unavailable" } });
    expect(await usedAt(t.selector)).toBeNull();
    expect(await usedAt(e.selector)).toBeNull();
  });
  it("a registered handler gets the verified link, commits it in its own batch; a second press is link_invalid; two at once give one win", async () => {
    let wins = 0;
    registerPublicHandlers({
      confirm: async (e, result) => {
        if (!result.ok) return null;
        const v: Verified = result;
        const { won } = await commitToken(e, v, { extra: (x) => [q(
          `INSERT INTO public_mail_limits (bucket,window_start,count) SELECT ?,0,1 WHERE ${whenConsumed(x)[0]}`, `done-${x.opId}`, x.row.selector, x.opId)] });
        if (won) wins += 1;
        return Response.json({ outcome: won ? "confirmed" : "already_executing" });
      },
    });
    const t = await issue();
    const both = await Promise.all([confirm(t), confirm(t), confirm(t)]);
    expect(wins).toBe(1);
    expect(both.filter((r) => r.body.outcome === "confirmed")).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM public_mail_limits WHERE bucket LIKE 'done-%'").first<{ n: number }>())!.n).toBe(1);
    expect(await usedAt(t.selector)).not.toBeNull();
    // later press: the handler is told it is used and can render the committed state; with no answer it is link_invalid
    registerPublicHandlers({ confirm: async (_e, result) => (result.ok ? null : Response.json({ outcome: "already_executing", used: result.code })) });
    expect((await confirm(t)).body).toEqual({ outcome: "already_executing", used: "link_used" });
    registerPublicHandlers({ confirm: async () => null });
    expect(await confirm(t)).toEqual({ status: 409, body: { error: "link_invalid", canResend: false } });
  });
  it("clarify: the action in the request must be the link's own button", async () => {
    registerPublicHandlers({ clarify: async (_e, result, call2) => (result.ok ? Response.json({ outcome: "withdrawn", action: call2.action }) : null) });
    const t = await issue({ purpose: "clarify", action: "withdraw_now", classificationRev: 1 });
    expect((await call("/v1/public/clarify", { selector: t.selector, secret: t.secret, action: "cancel_at_end" })).body).toEqual({ error: "link_invalid", canResend: false });
    expect((await call("/v1/public/clarify", { selector: t.selector, secret: t.secret, action: "bogus" })).body).toEqual({ error: "invalid_request" });
    expect((await call("/v1/public/clarify", { selector: t.selector, secret: t.secret, action: "withdraw_now" })).body).toEqual({ outcome: "withdrawn", action: "withdraw_now" });
  });
  it("every error body is exactly {error, canResend?} with no token, email or detail", async () => {
    const t = await issue();
    const r = await call("/v1/public/withdrawal/confirm", { selector: t.selector, secret: "z".repeat(43) });
    expect(Object.keys(r.body).sort()).toEqual(["canResend", "error"]);
    expect(JSON.stringify(r.body)).not.toContain(t.secret);
  });
});

describe("new-link", () => {
  it("is always 202 {}: unknown, malformed, known, limited, and with or without a handler", async () => {
    const sent: string[] = [];
    const t = await issue();
    expect(await call("/v1/public/withdrawal/new-link", { selector: t.selector })).toEqual({ status: 202, body: {} });
    registerPublicHandlers({ newLink: async (_e, selector) => { sent.push(selector); } });
    for (let i = 0; i < 4; i += 1) expect(await call("/v1/public/withdrawal/new-link", { selector: t.selector })).toEqual({ status: 202, body: {} });
    expect(await call("/v1/public/withdrawal/new-link", { selector: "q".repeat(22) })).toEqual({ status: 202, body: {} });
    expect(await call("/v1/public/withdrawal/new-link", { selector: "bad" })).toEqual({ status: 202, body: {} });
    expect(await call("/v1/public/withdrawal/new-link", {})).toEqual({ status: 202, body: {} });
    expect(sent.filter((s) => s === t.selector)).toHaveLength(1);                 // 1 an hour per selector
  });
  it("a failing handler is still 202 {}", async () => {
    registerPublicHandlers({ newLink: async () => { throw new Error("provider down"); } });
    expect(await call("/v1/public/withdrawal/new-link", { selector: "a".repeat(22) })).toEqual({ status: 202, body: {} });
  });
});

describe("routing", () => {
  it("public paths need no Authorization and sit outside the Cloud scope", async () => {
    const { isCloudScopePath } = await import("../src/customer-identity");
    for (const p of ["/v1/public/token/lookup", "/v1/public/withdrawal/confirm", "/v1/public/withdrawal/repudiate", "/v1/public/withdrawal/new-link", "/v1/public/clarify"]) {
      expect(isCloudScopePath(p)).toBe(false);
      expect((await call(p, { selector: "x".repeat(22), secret: "y".repeat(43), action: "withdraw_now" })).status).not.toBe(401);
    }
  });
  it("other /v1/public paths fall through to 404 {error}", async () => {
    expect(await call("/v1/public/nothing", {})).toEqual({ status: 404, body: { error: "not_found" } });
  });
});

describe("r1: resend limits belong to the subject, not the selector (ASTRA-WP7-1 #3)", () => {
  const HOUR = 3_600_000;
  let clock = 0;
  const T = () => clock;
  const post = async (path: string, body: unknown, e: Env = testEnv()) => {
    const res = (await publicRoute(new Request(`https://cp.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), e, { now: T, reader }))!;
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const reissue = async (over: Partial<TokenBinding> = {}) => {
    const t = (await issueToken(testEnv(), { now: T, reader }, binding({ receivedAt: clock, ...over })))!;
    return t.token.split(".")[0];
  };
  const newLinkFor = (selector: string) => post("/v1/public/withdrawal/new-link", { selector });
  it("a replacement selector buys no fresh hourly allowance; the hour resets; three per notice in all", async () => {
    clock = Date.now();
    const sent: string[] = [];
    registerPublicHandlers({ newLink: async (_e, selector) => { sent.push(selector); } });
    const s1 = await reissue();
    expect(await newLinkFor(s1)).toEqual({ status: 202, body: {} });
    expect(sent).toEqual([s1]);
    const s2 = await reissue();                                     // the resend replaced the link: a new selector, the same notice
    expect(s2).not.toBe(s1);
    expect(await newLinkFor(s2)).toEqual({ status: 202, body: {} });
    expect(sent).toHaveLength(1);                                   // same hour, same notice: suppressed
    clock += HOUR;                                                  // the hour resets
    expect(await newLinkFor(s2)).toEqual({ status: 202, body: {} });
    expect(sent).toEqual([s1, s2]);
    const s3 = await reissue();
    clock += HOUR;
    await newLinkFor(s3);
    expect(sent).toEqual([s1, s2, s3]);
    const s4 = await reissue();
    for (let i = 0; i < 5; i += 1) { clock += HOUR; expect(await newLinkFor(s4)).toEqual({ status: 202, body: {} }); }
    expect(sent).toHaveLength(3);                                   // lifetime: three per notice, across every selector
    const buckets = (await env.DB.prepare("SELECT bucket, count FROM public_mail_limits WHERE bucket LIKE 'nl%' ORDER BY bucket").all<{ bucket: string; count: number }>()).results;
    expect(buckets.map((b) => b.bucket)).toEqual(["nl:notice:notice-1", "nlt:notice:notice-1"]);
    expect(buckets.find((b) => b.bucket.startsWith("nlt:"))!.count).toBe(3);
    for (const sel of [s1, s2, s3, s4]) expect(JSON.stringify(buckets)).not.toContain(sel);
  });
  it("an attempt refused by the hourly limit does not spend the lifetime allowance", async () => {
    clock = Date.now();
    const sent: string[] = [];
    registerPublicHandlers({ newLink: async (_e, selector) => { sent.push(selector); } });
    const s = await reissue();
    for (let i = 0; i < 10; i += 1) await newLinkFor(s);           // one goes through, nine are refused by the hour
    expect(sent).toHaveLength(1);
    expect((await env.DB.prepare("SELECT count FROM public_mail_limits WHERE bucket='nlt:notice:notice-1'").first<{ count: number }>())!.count).toBe(1);
    clock += HOUR; await newLinkFor(s);
    clock += HOUR; await newLinkFor(s);
    expect(sent).toHaveLength(3);
  });
  it("r2: another notice has its own allowance; every purpose and button of ONE notice shares one (ASTRA-WP7-2 #1)", async () => {
    clock = Date.now();
    const sent: string[] = [];
    registerPublicHandlers({ newLink: async (_e, selector) => { sent.push(selector); } });
    await newLinkFor(await reissue());
    await newLinkFor(await reissue({ subjectId: "notice-2" }));
    await newLinkFor(await reissue({ purpose: "repudiate" }));       // same notice, same hour: the confirm resend spent it
    expect(sent).toHaveLength(2);
    await newLinkFor(await reissue({ purpose: "clarify", action: "withdraw_now", classificationRev: 1 }));
    expect(sent).toHaveLength(2);
    // across hours: confirm, repudiate and clarify together get three in all for notice-1, not three each
    const purposes: Partial<TokenBinding>[] = [{ purpose: "repudiate" }, { purpose: "clarify", action: "cancel_at_end", classificationRev: 1 }, {}, { purpose: "repudiate" }, {}];
    for (const p of purposes) { clock += HOUR; await newLinkFor(await reissue(p)); }
    expect(sent).toHaveLength(4);                                   // notice-1: three; notice-2: one
    const total = await env.DB.prepare("SELECT count FROM public_mail_limits WHERE bucket='nlt:notice:notice-1'").first<{ count: number }>();
    expect(total!.count).toBe(3);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM public_mail_limits WHERE bucket LIKE 'nl%notice-1:%'").first<{ n: number }>())!.n).toBe(0);
  });
  it("r2: a hold link's selector still resolves for /new-link after a sweep past expiry + 30 days, until its cap (ASTRA-WP7-2 #2)", async () => {
    clock = Date.now();
    const sent: string[] = [];
    registerPublicHandlers({ newLink: async (_e, selector) => { sent.push(selector); } });
    const s = await reissue({ purpose: "repudiate", subjectKind: "cancellation", subjectId: "cancel-r2", capAt: clock + 90 * DAY });
    clock += 40 * DAY;                                              // the link expired on day 7; day 37 would have swept it
    await sweepPublicTokens(testEnv(), clock);
    expect(await newLinkFor(s)).toEqual({ status: 202, body: {} });
    expect(sent).toEqual([s]);
  });
  it("r2: coalesced sends: many /new-link presses at once, across selectors and purposes of one notice, send exactly one", async () => {
    clock = Date.now();
    const sent: string[] = [];
    registerPublicHandlers({ newLink: async (_e, selector) => { sent.push(selector); } });
    const a = await reissue();
    const b = await reissue({ purpose: "repudiate" });
    const c = await reissue({ purpose: "clarify", action: "withdraw_now", classificationRev: 1 });
    const results = await Promise.all([a, b, c, a, b, c, a, b].map((sel) => newLinkFor(sel)));
    for (const r of results) expect(r).toEqual({ status: 202, body: {} });
    expect(sent).toHaveLength(1);
    expect((await env.DB.prepare("SELECT count FROM public_mail_limits WHERE bucket='nlt:notice:notice-1'").first<{ count: number }>())!.count).toBe(1);
  });
  it("r2: crossing the 14-day counter window: a hold link's three-in-all does not reset while it can still be reissued", async () => {
    clock = Date.now();
    const sent: string[] = [];
    registerPublicHandlers({ newLink: async (_e, selector) => { sent.push(selector); } });
    const hold = { purpose: "repudiate" as const, subjectKind: "cancellation" as const, subjectId: "cancel-w", capAt: clock + 90 * DAY };
    for (let i = 0; i < 3; i += 1) { await newLinkFor(await reissue(hold)); clock += HOUR; }
    expect(sent).toHaveLength(3);
    clock += 15 * DAY;                                              // past the 14-day window of the ordinary counters
    await sweepPublicTokens(testEnv(), clock);
    expect(await env.DB.prepare("SELECT 1 FROM public_mail_limits WHERE bucket='nl:cancellation:cancel-w'").first()).toBeNull();   // hourly: swept
    expect((await env.DB.prepare("SELECT count FROM public_mail_limits WHERE bucket='nlt:cancellation:cancel-w'").first<{ count: number }>())!.count).toBe(3);
    for (let i = 0; i < 3; i += 1) { await newLinkFor(await reissue(hold)); clock += 20 * DAY; }
    expect(sent).toHaveLength(3);
  });
  it("an unknown selector sends nothing and spends nothing", async () => {
    clock = Date.now();
    const sent: string[] = [];
    registerPublicHandlers({ newLink: async (_e, selector) => { sent.push(selector); } });
    expect(await newLinkFor("q".repeat(22))).toEqual({ status: 202, body: {} });
    expect(sent).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM public_mail_limits").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("r1: /new-link always answers 202 {}; the other routes reject bad bodies (ASTRA-WP7-1 #4)", () => {
  async function raw(path: string, body: BodyInit, e: Env = testEnv(), headers: Record<string, string> = {}) {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`https://cp.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }), e, ctx);
    await waitOnExecutionContext(ctx);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }
  const streamed = (bytes: number) => new ReadableStream<Uint8Array>({
    start(c) { for (let sent = 0; sent < bytes; sent += 4096) c.enqueue(new TextEncoder().encode("x".repeat(4096))); c.close(); },
  });
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});
  it("malformed JSON: 400 invalid_request on lookup and the act routes, 202 {} on new-link", async () => {
    const log = quiet();
    for (const p of ["/v1/public/token/lookup", "/v1/public/withdrawal/confirm", "/v1/public/withdrawal/repudiate", "/v1/public/clarify"]) {
      expect(await raw(p, "{not json"), p).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    registerPublicHandlers({ newLink: async () => { throw new Error("must not run"); } });
    expect(await raw("/v1/public/withdrawal/new-link", "{not json")).toEqual({ status: 202, body: {} });
    expect(await raw("/v1/public/withdrawal/new-link", "x", testEnv(), { "content-type": "text/plain" })).toEqual({ status: 202, body: {} });
    log.mockRestore();
  });
  it("an oversized body, declared or streamed: 413 on the other routes, 202 {} on new-link, nothing written", async () => {
    const log = quiet();
    const sent: string[] = [];
    registerPublicHandlers({ newLink: async (_e, s) => { sent.push(s); } });
    const big = JSON.stringify({ selector: "a".repeat(22), pad: "x".repeat(20_000) });
    for (const p of ["/v1/public/token/lookup", "/v1/public/withdrawal/confirm", "/v1/public/clarify"]) {
      expect((await raw(p, big)).status, p).toBe(413);
      expect((await raw(p, streamed(40_000))).status, p).toBe(413);
    }
    expect(await raw("/v1/public/withdrawal/new-link", big)).toEqual({ status: 202, body: {} });
    expect(await raw("/v1/public/withdrawal/new-link", streamed(40_000))).toEqual({ status: 202, body: {} });
    expect(sent).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM public_mail_limits").first<{ n: number }>())!.n).toBe(0);
    log.mockRestore();
  });
  it("a counter or lookup failure inside new-link is 202 {}, logged without detail, and sends nothing", async () => {
    const log = quiet();
    const t = await issue();
    const sent: string[] = [];
    registerPublicHandlers({ newLink: async (_e, s) => { sent.push(s); } });
    const failingBatch = { ...testEnv(), DB: { prepare: (sql: string) => env.DB.prepare(sql), batch: async () => { throw new Error("D1 down"); } } } as unknown as Env;
    expect(await raw("/v1/public/withdrawal/new-link", JSON.stringify({ selector: t.selector }), failingBatch)).toEqual({ status: 202, body: {} });
    const failingLookup = { ...testEnv(), DB: { prepare: () => { throw new Error("D1 down"); }, batch: async () => { throw new Error("D1 down"); } } } as unknown as Env;
    expect(await raw("/v1/public/withdrawal/new-link", JSON.stringify({ selector: t.selector }), failingLookup)).toEqual({ status: 202, body: {} });
    expect(sent).toEqual([]);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("new link suppressed"))).toBe(true);
    for (const l of lines) { expect(l).not.toContain(t.selector); expect(l).not.toContain("D1 down"); }
    log.mockRestore();
  });
  it("the edge limiter saying no: new-link is still 202 {} and does no D1 work; the other public routes are 429", async () => {
    const log = quiet();
    const t = await issue();
    const sent: string[] = [];
    registerPublicHandlers({ newLink: async (_e, s) => { sent.push(s); } });
    const limit = vi.fn(async () => ({ success: false }));
    const prepare = vi.fn((sql: string) => env.DB.prepare(sql));
    const limited = { ...testEnv(), MACHINE_OPEN_LIMIT: { limit }, DB: { prepare, batch: (s: D1PreparedStatement[]) => env.DB.batch(s) } } as unknown as Env;
    expect(await raw("/v1/public/withdrawal/new-link", JSON.stringify({ selector: t.selector }), limited, { "CF-Connecting-IP": "203.0.113.9" })).toEqual({ status: 202, body: {} });
    expect(await raw("/v1/public/token/lookup", JSON.stringify({ selector: t.selector, secret: t.secret }), limited, { "CF-Connecting-IP": "203.0.113.9" }))
      .toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(prepare).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    log.mockRestore();
  });
});
