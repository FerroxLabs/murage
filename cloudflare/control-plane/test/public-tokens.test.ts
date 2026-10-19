// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP7: the single-use link technique (plan section 5.3(2), (2a); support design 4.5). Plan Test 6 token rows.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  commitToken, constantTimeEqual, issueToken, lostCommitRefusal, peekToken, redeemToken, reserveMail, RESEND_TOTAL_WINDOW_MS, sweepPublicTokens, takeSlots, verifyToken,
  type IdentityRead, type TokenBinding, type TokenDeps,
} from "../src/public-tokens";
import { acquireHomeLease, LeaseLost, q } from "../src/billing-lease";
import source from "../src/public-tokens.ts?raw";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = 1_790_000_000_000;
const USER = "5f0c1b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";

let supa: IdentityRead;
let readerDown = false;
let readerCalls = 0;
let clock = T0;
function reset() {
  supa = { id: USER, email: "pat@example.test", updatedAt: "2026-10-01T00:00:00.000Z" };
  readerDown = false; readerCalls = 0; clock = T0;
}
const reader = { async emailGen(userId: string): Promise<IdentityRead> {
  readerCalls += 1;
  if (readerDown) throw new Error("identity_unavailable");
  expect(userId).toBe(USER);
  return { ...supa };
} };
const deps = (over: Partial<TokenDeps> = {}): TokenDeps => ({ now: () => clock, reader, ...over });
const binding = (over: Partial<TokenBinding> = {}): TokenBinding => ({
  purpose: "confirm", subjectKind: "notice", subjectId: "notice-1", accountId: USER, accountEmail: "pat@example.test",
  supabaseUpdatedAt: "2026-10-01T00:00:00.000Z", receivedAt: T0, ...over,
});
const split = (t: string) => { const [selector, secret] = t.split("."); return { selector, secret }; };
const rowOf = (selector: string) => env.DB.prepare("SELECT * FROM verify_tokens WHERE selector=?").bind(selector).first<Record<string, unknown>>();

async function issue(over: Partial<TokenBinding> = {}, d = deps()) {
  const t = await issueToken(env, d, binding(over));
  if (!t) throw new Error("not issued");
  return { ...t, ...split(t.token) };
}

describe("issue", () => {
  it("makes #selector.secret with a 32-byte secret, stores only the selector and a 64-hex HMAC", async () => {
    reset();
    const t = await issue();
    expect(t.selector).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(t.secret, "base64url")).toHaveLength(32);
    const rows = (await env.DB.prepare("SELECT * FROM verify_tokens").all<Record<string, unknown>>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0].hmac).toMatch(/^[0-9a-f]{64}$/);
    for (const v of Object.values(rows[0])) expect(String(v)).not.toContain(t.secret);
    expect(rows[0].email).toBe("pat@example.test");
  });
  it("two tokens never share a selector or a secret", async () => {
    reset();
    const a = await issue(); const b = await issue({ subjectId: "notice-2" });
    expect(a.selector).not.toBe(b.selector);
    expect(a.secret).not.toBe(b.secret);
  });
  it("expiry is min(issued + 7 days, received + 14 days)", async () => {
    reset();
    expect((await issue()).expiresAt).toBe(T0 + 7 * DAY);                                   // fresh notice: 7 days
    expect((await issue({ subjectId: "n2", receivedAt: T0 - 10 * DAY })).expiresAt).toBe(T0 + 4 * DAY); // received 10 days ago: the refund deadline caps it
    expect((await issue({ subjectId: "n3", receivedAt: T0 - 14 * DAY + 1 })).expiresAt).toBe(T0 + 1);
  });
  it("issues nothing at or after received + 14 days", async () => {
    reset();
    expect(await issueToken(env, deps(), binding({ receivedAt: T0 - 14 * DAY }))).toBeNull();
    expect(await issueToken(env, deps(), binding({ receivedAt: T0 - 20 * DAY }))).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM verify_tokens").first<{ n: number }>())!.n).toBe(0);
  });
  it("clarify needs an action and a revision; the other purposes refuse an action", async () => {
    reset();
    await expect(issueToken(env, deps(), binding({ purpose: "clarify" }))).rejects.toThrow();
    await expect(issueToken(env, deps(), binding({ purpose: "clarify", action: "withdraw_now" }))).rejects.toThrow();
    await expect(issueToken(env, deps(), binding({ purpose: "confirm", action: "withdraw_now" }))).rejects.toThrow();
    expect(await issueToken(env, deps(), binding({ purpose: "clarify", action: "withdraw_now", classificationRev: 3 }))).not.toBeNull();
  });
  it("two clarify buttons for one notice coexist; each is its own link", async () => {
    reset();
    const a = await issue({ purpose: "clarify", action: "withdraw_now", classificationRev: 1 });
    const b = await issue({ purpose: "clarify", action: "cancel_at_end", classificationRev: 1 });
    expect(a.selector).not.toBe(b.selector);
    expect((await verifyToken(env, deps(), a.selector, a.secret, "clarify", "withdraw_now")).ok).toBe(true);
    expect((await verifyToken(env, deps(), b.selector, b.secret, "clarify", "cancel_at_end")).ok).toBe(true);
  });
});

describe("redeem: single use", () => {
  it("works once; the second press is refused and nothing else changes", async () => {
    reset();
    const t = await issue();
    const first = await redeemToken(env, deps(), { selector: t.selector, secret: t.secret, purpose: "confirm" });
    expect(first).toMatchObject({ ok: true, won: true });
    const second = await redeemToken(env, deps(), { selector: t.selector, secret: t.secret, purpose: "confirm" });
    expect(second).toMatchObject({ ok: false, code: "link_used" });
    expect((await rowOf(t.selector))!.used_at).toBe(T0);
  });
  it("the same token posted twice at once: exactly one wins", async () => {
    reset();
    const t = await issue();
    const results = await Promise.all(Array.from({ length: 4 }, () => redeemToken(env, deps(), { selector: t.selector, secret: t.secret, purpose: "confirm" })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(3);
  });
  it("writes passed with the redeem happen only for the winner", async () => {
    reset();
    const t = await issue();
    const mark = (opId: string, selector: string) => q(
      "INSERT INTO public_mail_limits (bucket,window_start,count) SELECT ?,0,1 WHERE EXISTS (SELECT 1 FROM verify_tokens WHERE selector=? AND used_by=?)",
      `marker-${opId}`, selector, opId);
    const results = await Promise.all(Array.from({ length: 4 }, () => redeemToken(env, deps(), {
      selector: t.selector, secret: t.secret, purpose: "confirm", extra: (v) => [mark(v.opId, v.row.selector)] })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM public_mail_limits WHERE bucket LIKE 'marker-%'").first<{ n: number }>())!.n).toBe(1);
  });
  it("inside a fenced batch: the lease gates the consume; a lost lease leaves the token unused", async () => {
    reset();
    const t = await issue();
    const lease = (await acquireHomeLease(env, "home-1", "holder-a"))!;
    const v = await verifyToken(env, deps(), t.selector, t.secret, "confirm");
    if (!v.ok) throw new Error("expected ok");
    await env.DB.prepare("UPDATE billing_home_leases SET holder='someone-else',generation=generation+1 WHERE home_id='home-1'").run();
    await expect(commitToken(env, v, { lease })).rejects.toBeInstanceOf(LeaseLost);
    expect((await rowOf(t.selector))!.used_at).toBeNull();
    const lease2 = (await acquireHomeLease(env, "home-2", "holder-b"))!;
    expect(await commitToken(env, v, { lease: lease2 })).toMatchObject({ won: true });
    expect((await rowOf(t.selector))!.used_at).toBe(T0);
  });
});

describe("reissue", () => {
  it("replaces both parts: the old pair is refused, the new one works", async () => {
    reset();
    const old = await issue();
    clock += 1000;
    const fresh = await issue();
    expect(fresh.selector).not.toBe(old.selector);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM verify_tokens").first<{ n: number }>())!.n).toBe(1);
    expect(await redeemToken(env, deps(), { selector: old.selector, secret: old.secret, purpose: "confirm" })).toMatchObject({ ok: false, code: "link_invalid" });
    // old selector with the NEW secret is refused as well
    expect(await redeemToken(env, deps(), { selector: old.selector, secret: fresh.secret, purpose: "confirm" })).toMatchObject({ ok: false, code: "link_invalid" });
    // new selector with the OLD secret
    expect(await redeemToken(env, deps(), { selector: fresh.selector, secret: old.secret, purpose: "confirm" })).toMatchObject({ ok: false, code: "link_invalid" });
    expect(await redeemToken(env, deps(), { selector: fresh.selector, secret: fresh.secret, purpose: "confirm" })).toMatchObject({ ok: true });
  });
  it("a used link is never reissued", async () => {
    reset();
    const t = await issue();
    await redeemToken(env, deps(), { selector: t.selector, secret: t.secret, purpose: "confirm" });
    expect(await issueToken(env, deps(), binding())).toBeNull();
    expect((await rowOf(t.selector))!.used_at).toBe(T0);
  });
});

describe("refusals leave the link unconsumed", () => {
  it("expiry: valid until the last millisecond, refused from expires_at", async () => {
    reset();
    const t = await issue();
    clock = t.expiresAt;
    expect(await redeemToken(env, deps(), { selector: t.selector, secret: t.secret, purpose: "confirm" })).toMatchObject({ ok: false, code: "link_expired" });
    expect((await rowOf(t.selector))!.used_at).toBeNull();
    clock = t.expiresAt - 1;
    expect(await redeemToken(env, deps(), { selector: t.selector, secret: t.secret, purpose: "confirm" })).toMatchObject({ ok: true });
  });
  it("a late press near the 14-day cap is refused even inside 7 days of issue", async () => {
    reset();
    const t = await issue({ receivedAt: T0 - 13 * DAY });
    expect(t.expiresAt).toBe(T0 + DAY);
    clock = T0 + DAY + 5;
    expect(await redeemToken(env, deps(), { selector: t.selector, secret: t.secret, purpose: "confirm" })).toMatchObject({ ok: false, code: "link_expired" });
  });
  it("a wrong, truncated or malformed secret or selector", async () => {
    reset();
    const t = await issue();
    const bad = [["x".repeat(22), t.secret], [t.selector, "y".repeat(43)], [t.selector, t.secret.slice(1)], [t.selector, ""], ["", t.secret], [t.selector, t.secret + "A"],
      [t.selector, t.secret.slice(0, -1) + (t.secret.endsWith("A") ? "B" : "A")]];
    for (const [selector, secret] of bad) {
      expect(await redeemToken(env, deps(), { selector, secret, purpose: "confirm" })).toMatchObject({ ok: false, code: "link_invalid" });
    }
    expect((await rowOf(t.selector))!.used_at).toBeNull();
    expect(readerCalls).toBe(0);
  });
  it("a confirm token is refused as repudiate, and the reverse; neither is consumed", async () => {
    reset();
    const c = await issue({ purpose: "confirm" });
    const r = await issue({ purpose: "repudiate" });
    expect(await redeemToken(env, deps(), { selector: c.selector, secret: c.secret, purpose: "repudiate" })).toMatchObject({ ok: false, code: "link_invalid" });
    expect(await redeemToken(env, deps(), { selector: r.selector, secret: r.secret, purpose: "confirm" })).toMatchObject({ ok: false, code: "link_invalid" });
    expect(await redeemToken(env, deps(), { selector: r.selector, secret: r.secret, purpose: "clarify", action: "withdraw_now" })).toMatchObject({ ok: false, code: "link_invalid" });
    expect((await rowOf(c.selector))!.used_at).toBeNull();
    expect((await rowOf(r.selector))!.used_at).toBeNull();
    expect(readerCalls).toBe(0);
    expect(await redeemToken(env, deps(), { selector: c.selector, secret: c.secret, purpose: "confirm" })).toMatchObject({ ok: true });
  });
  it("a clarify token for the other button is refused", async () => {
    reset();
    const a = await issue({ purpose: "clarify", action: "withdraw_now", classificationRev: 2 });
    expect(await redeemToken(env, deps(), { selector: a.selector, secret: a.secret, purpose: "clarify", action: "cancel_at_end" })).toMatchObject({ ok: false, code: "link_invalid" });
    expect(await redeemToken(env, deps(), { selector: a.selector, secret: a.secret, purpose: "clarify" })).toMatchObject({ ok: false, code: "link_invalid" });
  });
  it("a token whose stored binding was altered fails its HMAC (purpose, action, revision, subject, account, email, generation, times)", async () => {
    reset();
    const edits: [string, string | number][] = [
      ["purpose", "repudiate"], ["classification_rev", 9], ["subject_id", "notice-other"], ["subject_kind", "cancellation"], ["account_id", "other-user"],
      ["email", "evil@example.test"], ["email_gen", "2026-10-02T00:00:00.000Z"], ["issued_at", T0 + 1], ["action", "cancel_at_end"],
    ];
    for (const [col, value] of edits) {
      const t = await issue({ purpose: col === "action" ? "clarify" : "confirm", ...(col === "action" ? { action: "withdraw_now", classificationRev: 1 } : { classificationRev: 1 }) });
      await env.DB.prepare(`UPDATE verify_tokens SET ${col}=? WHERE selector=?`).bind(value, t.selector).run();
      const expectedPurpose = col === "purpose" ? "repudiate" : col === "action" ? "clarify" : "confirm";
      const res = await redeemToken(env, deps(), { selector: t.selector, secret: t.secret, purpose: expectedPurpose, ...(col === "action" ? { action: "cancel_at_end" as const } : {}) });
      expect(res.ok, col).toBe(false);
      expect((res as { code: string }).code, col).toBe("link_invalid");
      await env.DB.prepare("DELETE FROM verify_tokens").run();
    }
  });
  it("the email changed, or changed A to B and back to A: identity_changed", async () => {
    reset();
    const t = await issue();
    supa.email = "new@example.test"; supa.updatedAt = "2026-10-02T00:00:00.000Z";
    expect(await redeemToken(env, deps(), { selector: t.selector, secret: t.secret, purpose: "confirm" })).toMatchObject({ ok: false, code: "identity_changed" });
    // back to the original address: updated_at has moved on, so the old link is still refused
    supa.email = "pat@example.test"; supa.updatedAt = "2026-10-03T00:00:00.000Z";
    expect(await redeemToken(env, deps(), { selector: t.selector, secret: t.secret, purpose: "confirm" })).toMatchObject({ ok: false, code: "identity_changed" });
    expect((await rowOf(t.selector))!.used_at).toBeNull();
  });
  it("address case alone is not a change; updated_at alone is", async () => {
    reset();
    const t = await issue();
    supa.email = "PAT@Example.Test";
    expect(await verifyToken(env, deps(), t.selector, t.secret, "confirm")).toMatchObject({ ok: true });
    supa.updatedAt = "2026-10-01T00:00:00.001Z";
    expect(await verifyToken(env, deps(), t.selector, t.secret, "confirm")).toMatchObject({ ok: false, code: "identity_changed" });
  });
  it("reader failure (error, timeout, wrong user id, no reader): identity_unavailable, link unconsumed, works after recovery", async () => {
    reset();
    const t = await issue();
    const input = { selector: t.selector, secret: t.secret, purpose: "confirm" as const };
    readerDown = true;
    expect(await redeemToken(env, deps(), input)).toMatchObject({ ok: false, code: "identity_unavailable" });
    readerDown = false;
    const hang: TokenDeps["reader"] = { emailGen: () => new Promise(() => {}) };
    expect(await redeemToken(env, deps({ reader: hang, readerTimeoutMs: 20 }), input)).toMatchObject({ ok: false, code: "identity_unavailable" });
    const wrongUser: TokenDeps["reader"] = { emailGen: async () => ({ ...supa, id: "00000000-0000-4000-8000-000000000000" }) };
    expect(await redeemToken(env, deps({ reader: wrongUser }), input)).toMatchObject({ ok: false, code: "identity_unavailable" });
    const noUpdatedAt: TokenDeps["reader"] = { emailGen: async () => ({ ...supa, updatedAt: "" }) };
    expect(await redeemToken(env, deps({ reader: noUpdatedAt }), input)).toMatchObject({ ok: false, code: "identity_unavailable" });
    expect(await redeemToken(env, { now: () => clock }, input)).toMatchObject({ ok: false, code: "identity_unavailable" });
    expect((await rowOf(t.selector))!.used_at).toBeNull();
    expect(await redeemToken(env, deps(), input)).toMatchObject({ ok: true, won: true });
  });
});

describe("peek (the inert landing page and lookup)", () => {
  it("never consumes and never calls the reader; states open, used, expired, refused", async () => {
    reset();
    const t = await issue();
    for (let i = 0; i < 5; i += 1) expect(await peekToken(env, deps(), t.selector, t.secret)).toMatchObject({ state: "open" });
    expect(readerCalls).toBe(0);
    expect((await rowOf(t.selector))!.used_at).toBeNull();
    expect(await peekToken(env, deps(), t.selector, "z".repeat(43))).toMatchObject({ state: "refused" });
    expect(await peekToken(env, deps(), "q".repeat(22), t.secret)).toMatchObject({ state: "refused" });
    clock = t.expiresAt;
    expect(await peekToken(env, deps(), t.selector, t.secret)).toMatchObject({ state: "expired" });
    clock = T0;
    await redeemToken(env, deps(), { selector: t.selector, secret: t.secret, purpose: "confirm" });
    expect(await peekToken(env, deps(), t.selector, t.secret)).toMatchObject({ state: "used" });
  });
});

describe("constant-time compare", () => {
  it("is exact for equal, different and different-length strings", () => {
    expect(constantTimeEqual("ab12", "ab12")).toBe(true);
    expect(constantTimeEqual("ab12", "ab13")).toBe(false);
    expect(constantTimeEqual("ab12", "ab1")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("a".repeat(64), "a".repeat(63) + "b")).toBe(false);
  });
  it("the module never compares the stored or computed HMAC with === or !==", () => {
    expect(source).toContain("constantTimeEqual(");
    expect(source).not.toMatch(/hmac\s*[!=]==/i);
    expect(source).not.toMatch(/[!=]==\s*\w*\.?hmac/i);
    expect(source).not.toMatch(/\.localeCompare/);
  });
  it("r1: the compare IS the runtime's timing-safe primitive, called with the bytes of both values (not string equality)", async () => {
    reset();
    const spy = vi.spyOn(crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean }, "timingSafeEqual");
    try {
      expect(constantTimeEqual("ab12", "ab13")).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      const [x, y] = spy.mock.calls[0] as unknown as [Uint8Array, Uint8Array];
      expect(new TextDecoder().decode(x)).toBe("ab12");
      expect(new TextDecoder().decode(y)).toBe("ab13");
      spy.mockClear();
      expect(constantTimeEqual("ab12", "ab1")).toBe(false);          // a length mismatch still does the same work
      expect(spy).toHaveBeenCalledTimes(1);
      // and the token path goes through it: a wrong secret and a genuine one each cost exactly one primitive compare
      const t = await issue();
      spy.mockClear();
      expect(await peekToken(env, deps(), t.selector, "z".repeat(43))).toEqual({ state: "refused" });
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      expect((await peekToken(env, deps(), t.selector, t.secret)).state).toBe("open");
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      expect(await peekToken(env, deps(), "q".repeat(22), t.secret)).toEqual({ state: "refused" });   // unknown selector: same single compare
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    const body = source.slice(source.indexOf("export function constantTimeEqual"), source.indexOf("const randomB64u"));
    expect(body).toMatch(/crypto\.subtle( as \w+\))?\.timingSafeEqual\(/);
    expect(body).not.toMatch(/===\s*b\b|a\s*===|charCodeAt/);
  });
});

describe("mail limits", () => {
  it("per recipient: 3 an hour, the window resets, addresses compare case-insensitively and are never stored", async () => {
    reset();
    const lim = { perRecipient: 3, global: 100 };
    for (let i = 0; i < 3; i += 1) expect(await reserveMail(env, deps(), "Pat@Example.test", lim)).toBe(true);
    expect(await reserveMail(env, deps(), "pat@example.test", lim)).toBe(false);
    expect(await reserveMail(env, deps(), "other@example.test", lim)).toBe(true);
    clock += HOUR;
    expect(await reserveMail(env, deps(), "pat@example.test", lim)).toBe(true);
    const buckets = (await env.DB.prepare("SELECT bucket FROM public_mail_limits").all<{ bucket: string }>()).results.map((r) => r.bucket).join(" ");
    expect(buckets).not.toContain("example.test");
  });
  it("global cap holds, and a refusal by the global cap does not spend the recipient's budget", async () => {
    reset();
    const tight = { perRecipient: 2, global: 3 };
    expect(await reserveMail(env, deps(), "c@example.test", tight)).toBe(true);
    expect(await reserveMail(env, deps(), "a@example.test", tight)).toBe(true);
    expect(await reserveMail(env, deps(), "b@example.test", tight)).toBe(true);
    expect(await reserveMail(env, deps(), "c@example.test", tight)).toBe(false); // global full
    const roomy = { perRecipient: 2, global: 100 };
    expect(await reserveMail(env, deps(), "c@example.test", roomy)).toBe(true);  // c had spent 1, the refused attempt spent nothing
    expect(await reserveMail(env, deps(), "c@example.test", roomy)).toBe(false);
  });
  it("concurrent reservations never exceed the cap", async () => {
    reset();
    const lim = { perRecipient: 3, global: 100 };
    const r = await Promise.all(Array.from({ length: 10 }, () => reserveMail(env, deps(), "race@example.test", lim)));
    expect(r.filter(Boolean)).toHaveLength(3);
  });
});

describe("sweep", () => {
  it("removes links 30 days past expiry and stale counters, keeps the rest", async () => {
    reset();
    const old = await issue({ subjectId: "old", receivedAt: T0 - 13 * DAY });
    const live = await issue({ subjectId: "live" });
    await reserveMail(env, deps(), "x@example.test", { perRecipient: 3, global: 10 });
    clock = T0 + 40 * DAY;
    await sweepPublicTokens(env, clock);
    expect(await rowOf(old.selector)).toBeNull();
    expect(await rowOf(live.selector)).toBeNull(); // 7 days + 30 days is past, too
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM public_mail_limits").first<{ n: number }>())!.n).toBe(0);
    reset();
    const keep = await issue({ subjectId: "keep" });
    clock = T0 + 8 * DAY;
    await sweepPublicTokens(env, clock);
    expect(await rowOf(keep.selector)).not.toBeNull();
  });
});

describe("r1: expiry is decided at the consume, on the database's clock (ASTRA-WP7-1 #1)", () => {
  const marker = (v: { opId: string; row: { selector: string } }) => q(
    "INSERT INTO public_mail_limits (bucket,window_start,count) SELECT ?,0,1 WHERE EXISTS (SELECT 1 FROM verify_tokens WHERE selector=? AND used_by=?)",
    `marker-${v.opId}`, v.row.selector, v.opId);
  const markers = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM public_mail_limits WHERE bucket LIKE 'marker-%'").first<{ n: number }>())!.n;
  it("expiry DURING the identity read: refused as link_expired, nothing consumed", async () => {
    reset();
    const t = await issue();
    clock = t.expiresAt - 1;
    const slow: TokenDeps["reader"] = { emailGen: async (id) => { const r = await reader.emailGen(id); clock = t.expiresAt; return r; } };
    expect(await redeemToken(env, deps({ reader: slow }), { selector: t.selector, secret: t.secret, purpose: "confirm", extra: (v) => [marker(v)] }))
      .toMatchObject({ ok: false, code: "link_expired" });
    expect((await rowOf(t.selector))!.used_at).toBeNull();
    expect(await markers()).toBe(0);
  });
  it("expiry AFTER verify and BEFORE commit: the commit refuses, whenConsumed is false, no dependent write runs", async () => {
    reset();
    const t = await issue();
    clock = t.expiresAt - 1;
    const v = await verifyToken(env, deps(), t.selector, t.secret, "confirm");
    if (!v.ok) throw new Error("expected ok");
    clock = t.expiresAt;                                   // the handler took a while
    expect(await commitToken(env, v, { extra: (x) => [marker(x)] })).toEqual({ won: false });
    expect((await rowOf(t.selector))!.used_at).toBeNull();
    expect(await markers()).toBe(0);
  });
  it("production path (no injected clock): the database's time decides, so a verify from the past cannot consume an expired link", async () => {
    reset();
    const t = await issue();                                // T0 is in the past: this link expired long ago in real time
    const v = await verifyToken(env, deps(), t.selector, t.secret, "confirm");
    if (!v.ok) throw new Error("expected ok");
    const { clock: _injected, ...prod } = v;
    expect(await commitToken(env, prod, { extra: (x) => [marker(x)] })).toEqual({ won: false });
    expect((await rowOf(t.selector))!.used_at).toBeNull();
    expect(await markers()).toBe(0);
  });
  it("production path: a live link is consumed and used_at is the database's time, not the verify time", async () => {
    reset();
    const before = Date.now();
    const t = (await issueToken(env, { reader }, binding({ receivedAt: before })))!;
    const [selector, secret] = t.token.split(".");
    const v = await verifyToken(env, { reader }, selector, secret, "confirm");
    if (!v.ok) throw new Error("expected ok");
    expect(v.clock).toBeUndefined();
    const stale = { ...v, now: before - 10 * DAY };          // whatever verify recorded, it is not what commits
    expect(await commitToken(env, stale)).toEqual({ won: true });
    const usedAt = (await rowOf(selector))!.used_at as number;
    expect(usedAt).toBeGreaterThanOrEqual(before - 5_000);
    expect(usedAt).toBeLessThanOrEqual(Date.now() + 5_000);
  });
  it("a statement AFTER the consume fails: the whole batch rolls back, the link stays unused and redeemable", async () => {
    reset();
    const t = await issue();
    const failing = q("INSERT INTO cloud_write_guards (id, ok) VALUES (?, 0)", "r1-fail");
    await expect(redeemToken(env, deps(), { selector: t.selector, secret: t.secret, purpose: "confirm", extra: (v) => [marker(v), failing] })).rejects.toThrow();
    expect((await rowOf(t.selector))!.used_at).toBeNull();
    expect(await markers()).toBe(0);
    expect(await redeemToken(env, deps(), { selector: t.selector, secret: t.secret, purpose: "confirm" })).toMatchObject({ ok: true, won: true });
  });
  it("redeem vs reissue, reissue first: a verified link whose row was replaced cannot commit; the new link works", async () => {
    reset();
    const t = await issue();
    const v = await verifyToken(env, deps(), t.selector, t.secret, "confirm");
    if (!v.ok) throw new Error("expected ok");
    clock += 1000;
    const fresh = await issue();                              // the reissue lands between verify and commit
    expect(await commitToken(env, v, { extra: (x) => [marker(x)] })).toEqual({ won: false });
    expect(await markers()).toBe(0);
    expect((await rowOf(fresh.selector))!.used_at).toBeNull();
    expect(await redeemToken(env, deps(), { selector: fresh.selector, secret: fresh.secret, purpose: "confirm" })).toMatchObject({ ok: true, won: true });
  });
  it("redeem vs reissue, redeem first: the consumed link is not replaced and the reissue returns null", async () => {
    reset();
    const t = await issue();
    const v = await verifyToken(env, deps(), t.selector, t.secret, "confirm");
    if (!v.ok) throw new Error("expected ok");
    expect(await commitToken(env, v)).toEqual({ won: true });
    clock += 1000;
    expect(await issueToken(env, deps(), binding())).toBeNull();
    const row = (await rowOf(t.selector))!;
    expect(row.used_at).toBe(T0);
    expect(row.used_by).toBe(v.opId);
  });
});

describe("r1: mail reservations are one transaction (ASTRA-WP7-1 #2)", () => {
  const counts = async () => Object.fromEntries((await env.DB.prepare("SELECT bucket, count, window_start FROM public_mail_limits ORDER BY bucket").all<{ bucket: string; count: number; window_start: number }>())
    .results.map((r) => [r.bucket.startsWith("mr:") ? "recipient" : r.bucket, [r.count, r.window_start]]));
  it("a refusal by the RECIPIENT budget leaves the global counter untouched", async () => {
    reset();
    const lim = { perRecipient: 1, global: 10 };
    expect(await reserveMail(env, deps(), "pat@example.test", lim)).toBe(true);
    expect(await reserveMail(env, deps(), "pat@example.test", lim)).toBe(false);
    expect(await counts()).toEqual({ mg: [1, T0], recipient: [1, T0] });
  });
  it("a refusal by the GLOBAL budget leaves the recipient counter untouched (no take-then-give-back)", async () => {
    reset();
    const lim = { perRecipient: 3, global: 1 };
    expect(await reserveMail(env, deps(), "a@example.test", lim)).toBe(true);
    expect(await reserveMail(env, deps(), "pat@example.test", lim)).toBe(false);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM public_mail_limits").first<{ n: number }>())!.n).toBe(2); // a's recipient row and mg; none for pat
  });
  it("an error in the middle of the reservation rolls back both counters and is not reported as a reservation", async () => {
    reset();
    const broken = { ...env, DB: { prepare: (sql: string) => env.DB.prepare(sql),
      batch: (stmts: D1PreparedStatement[]) => env.DB.batch([...stmts.slice(0, -2), env.DB.prepare("INSERT INTO no_such_table VALUES (1)"), ...stmts.slice(-1)]) } } as unknown as Env;
    await expect(reserveMail(broken, deps(), "pat@example.test")).rejects.toThrow();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM public_mail_limits").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cloud_write_guards").first<{ n: number }>())!.n).toBe(0);
  });
  it("window crossing: a delayed request from the old window that the global cap refuses cannot touch the recipient's NEW window", async () => {
    reset();
    const lim = { perRecipient: 3, global: 2 };
    expect(await reserveMail(env, deps(), "pat@example.test", lim)).toBe(true);           // old window
    clock = T0 + HOUR;
    expect(await reserveMail(env, deps(), "pat@example.test", lim)).toBe(true);           // both windows roll over
    expect(await reserveMail(env, deps(), "other@example.test", lim)).toBe(true);         // global now full
    const late = deps({ now: () => T0 + HOUR - 1 });                                       // started in the old window, lands now
    expect(await reserveMail(env, late, "pat@example.test", lim)).toBe(false);
    const c = await counts();
    expect(c.mg).toEqual([2, T0 + HOUR]);
    expect((await env.DB.prepare("SELECT count, window_start FROM public_mail_limits WHERE bucket LIKE 'mr:%' ORDER BY count DESC LIMIT 1").first())).toEqual({ count: 1, window_start: T0 + HOUR });
  });
  it("concurrent reservations against a tight global cap: never more than the cap, every refusal spends nothing", async () => {
    reset();
    const lim = { perRecipient: 5, global: 4 };
    const r = await Promise.all(Array.from({ length: 12 }, (_, i) => reserveMail(env, deps(), `u${i % 3}@example.test`, lim)));
    expect(r.filter(Boolean)).toHaveLength(4);
    const total = (await env.DB.prepare("SELECT SUM(count) AS n FROM public_mail_limits WHERE bucket LIKE 'mr:%'").first<{ n: number }>())!.n;
    expect(total).toBe(4);
  });
  it("takeSlots: all or nothing across any number of buckets", async () => {
    reset();
    expect(await takeSlots(env, [{ bucket: "a", limit: 1, windowMs: HOUR }, { bucket: "b", limit: 2, windowMs: HOUR }], T0)).toBe(true);
    expect(await takeSlots(env, [{ bucket: "b", limit: 2, windowMs: HOUR }, { bucket: "a", limit: 1, windowMs: HOUR }], T0)).toBe(false);
    expect(await counts()).toEqual({ a: [1, T0], b: [1, T0] });
    expect(await takeSlots(env, [{ bucket: "a", limit: 1, windowMs: HOUR }], T0 + HOUR)).toBe(true);
    expect((await counts()).a).toEqual([1, T0 + HOUR]);
  });
});

describe("r1: schema rules", () => {
  it("selector is UNIQUE: a second row with an existing selector is rejected, and issueToken never overwrites another subject's link", async () => {
    reset();
    const t = await issue();
    const row = (await rowOf(t.selector))!;
    await expect(env.DB.prepare(`INSERT INTO verify_tokens (selector,subject_kind,subject_id,purpose,action,classification_rev,account_id,email,email_gen,received_at,issued_at,expires_at,hmac)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(t.selector, "notice", "notice-other", "confirm", "", null, USER, "pat@example.test", "g", T0, T0, T0 + DAY, "0".repeat(64)).run()).rejects.toThrow(/UNIQUE/i);
    // a colliding random draw inside issueToken: the insert fails rather than replacing the other subject's link
    const fixed = vi.spyOn(crypto, "getRandomValues").mockImplementation(((a: ArrayBufferView) => { (a as Uint8Array).fill(7); return a; }) as typeof crypto.getRandomValues);
    try {
      const a = await issue({ subjectId: "collide-a" });
      await expect(issueToken(env, deps(), binding({ subjectId: "collide-b" }))).rejects.toThrow();
      expect((await rowOf(a.selector))!.subject_id).toBe("collide-a");
    } finally {
      fixed.mockRestore();
    }
    expect(await rowOf(t.selector)).toEqual(row);
  });
  it("migration 0062 is additive: it applies over a populated baseline and leaves the existing rows alone", async () => {
    reset();
    const migrations = (env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;
    const m = migrations.find((x) => x.name.startsWith("0062"))!;
    expect(m).toBeTruthy();
    for (const query of m.queries) expect(query.replace(/--.*$/gm, "").trim()).toMatch(/^CREATE (TABLE|INDEX) /);
    // a populated baseline: rows in tables that existed before 0062
    await env.DB.prepare("INSERT INTO billing_home_leases (home_id,holder,lease_until) VALUES ('home-baseline','h',123)").run();
    await env.DB.prepare("INSERT INTO cloud_write_guards (id, ok) VALUES ('baseline-guard', 1)").run();
    const before = await env.DB.prepare("SELECT * FROM billing_home_leases WHERE home_id='home-baseline'").first();
    // back to the pre-0062 schema, then apply 0062 as wrangler would
    await env.DB.batch([env.DB.prepare("DROP TABLE verify_tokens"), env.DB.prepare("DROP TABLE public_mail_limits")]);
    await env.DB.batch(m.queries.map((query) => env.DB.prepare(query)));
    expect(await env.DB.prepare("SELECT * FROM billing_home_leases WHERE home_id='home-baseline'").first()).toEqual(before);
    expect((await env.DB.prepare("SELECT ok FROM cloud_write_guards WHERE id='baseline-guard'").first<{ ok: number }>())!.ok).toBe(1);
    await env.DB.prepare("DELETE FROM cloud_write_guards WHERE id='baseline-guard'").run();
    // and the new tables work end to end
    const t = await issue();
    expect(await redeemToken(env, deps(), { selector: t.selector, secret: t.secret, purpose: "confirm" })).toMatchObject({ ok: true, won: true });
    expect(await reserveMail(env, deps(), "pat@example.test")).toBe(true);
    expect((await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='verify_tokens_expiry'").first())).not.toBeNull();
  });
});

describe("r1: per-issue cap for the 312k cancellation hold link (capAt)", () => {
  const hold = (capAt: number, over: Partial<TokenBinding> = {}) => binding({ purpose: "repudiate", subjectKind: "cancellation", subjectId: "cancel-1", receivedAt: T0, capAt, ...over });
  it("a hold link lives past received + 14 days up to hold_until; each issue still lasts at most 7 days; reissue after expiry works until hold_until", async () => {
    reset();
    const holdUntil = T0 + 90 * DAY;
    const first = (await issueToken(env, deps(), hold(holdUntil)))!;
    expect(first.expiresAt).toBe(T0 + 7 * DAY);
    clock = T0 + 30 * DAY;                                                  // the first link expired, received + 14 days is long gone
    const [s1, x1] = first.token.split(".");
    expect(await redeemToken(env, deps(), { selector: s1, secret: x1, purpose: "repudiate" })).toMatchObject({ ok: false, code: "link_expired" });
    const again = (await issueToken(env, deps(), hold(holdUntil)))!;
    expect(again.expiresAt).toBe(clock + 7 * DAY);
    const [s2, x2] = again.token.split(".");
    expect(await redeemToken(env, deps(), { selector: s2, secret: x2, purpose: "repudiate" })).toMatchObject({ ok: true, won: true });
    expect(await issueToken(env, deps(), hold(holdUntil))).toBeNull();      // single use: a used hold link is never reissued
  });
  it("close to hold_until the link stops at hold_until; nothing is issued at or after it", async () => {
    reset();
    const holdUntil = T0 + 2 * DAY;
    expect((await issueToken(env, deps(), hold(holdUntil, { subjectId: "c-2" })))!.expiresAt).toBe(holdUntil);
    clock = holdUntil;
    expect(await issueToken(env, deps(), hold(holdUntil, { subjectId: "c-3" }))).toBeNull();
  });
  it("the default stays the withdrawal rule; capAt is refused on a notice and when not finite", async () => {
    reset();
    expect((await issueToken(env, deps(), binding({ subjectId: "w-1", receivedAt: T0 - 10 * DAY })))!.expiresAt).toBe(T0 + 4 * DAY);
    await expect(issueToken(env, deps(), binding({ capAt: T0 + 90 * DAY }))).rejects.toThrow("invalid_binding");
    await expect(issueToken(env, deps(), hold(Number.NaN))).rejects.toThrow("invalid_binding");
  });
});

describe("r2: the sweep keeps a hold link's row until its cap has passed (ASTRA-WP7-2 #2)", () => {
  const hold = (capAt: number, over: Partial<TokenBinding> = {}) => binding({ purpose: "repudiate", subjectKind: "cancellation", subjectId: "cancel-s", receivedAt: T0, capAt, ...over });
  it("a USED hold link survives a sweep past expiry + 30 days, so the subject is never issued again; swept only after the cap + 30 days", async () => {
    reset();
    const holdUntil = T0 + 90 * DAY;
    const t = (await issueToken(env, deps(), hold(holdUntil)))!;
    const [selector, secret] = t.token.split(".");
    expect((await rowOf(selector))!.cap_at).toBe(holdUntil);
    clock = T0 + DAY;
    expect(await redeemToken(env, deps(), { selector, secret, purpose: "repudiate" })).toMatchObject({ ok: true, won: true });
    clock = T0 + 40 * DAY;                                   // expires_at (day 7) + 30 days is past; the cap (day 90) is not
    await sweepPublicTokens(env, clock);
    expect((await rowOf(selector))!.used_at).toBe(T0 + DAY);
    expect(await issueToken(env, deps(), hold(holdUntil))).toBeNull();
    clock = holdUntil + 30 * DAY;                            // the grace is inclusive: still kept at exactly cap + 30 days
    await sweepPublicTokens(env, clock);
    expect(await rowOf(selector)).not.toBeNull();
    clock = holdUntil + 31 * DAY;
    await sweepPublicTokens(env, clock);
    expect(await rowOf(selector)).toBeNull();
    expect(await issueToken(env, deps(), hold(holdUntil))).toBeNull();   // past the cap: nothing can be issued, row or no row
  });
  it("an UNUSED expired hold link keeps its selector through the sweep and can still be reissued before the cap; a reissue never shortens cap_at", async () => {
    reset();
    const holdUntil = T0 + 90 * DAY;
    const t = (await issueToken(env, deps(), hold(holdUntil)))!;
    clock = T0 + 40 * DAY;
    await sweepPublicTokens(env, clock);
    expect(await rowOf(t.selector)).not.toBeNull();
    const again = (await issueToken(env, deps(), hold(T0 + 60 * DAY)))!;
    expect(again.expiresAt).toBe(clock + 7 * DAY);
    expect((await rowOf(again.selector))!.cap_at).toBe(holdUntil);
  });
  it("lifetime resend counters (nlt:) outlive the 14-day sweep and go after RESEND_TOTAL_WINDOW_MS; other counters keep the 14-day rule", async () => {
    reset();
    await takeSlots(env, [{ bucket: "nlt:cancellation:c-x", limit: 3, windowMs: RESEND_TOTAL_WINDOW_MS }, { bucket: "nl:cancellation:c-x", limit: 1, windowMs: HOUR }], clock);
    const buckets = async () => (await env.DB.prepare("SELECT bucket FROM public_mail_limits ORDER BY bucket").all<{ bucket: string }>()).results.map((r) => r.bucket);
    await sweepPublicTokens(env, T0 + 15 * DAY);
    expect(await buckets()).toEqual(["nlt:cancellation:c-x"]);
    await sweepPublicTokens(env, T0 + RESEND_TOTAL_WINDOW_MS);
    expect(await buckets()).toEqual(["nlt:cancellation:c-x"]);
    await sweepPublicTokens(env, T0 + RESEND_TOTAL_WINDOW_MS + 1);
    expect(await buckets()).toEqual([]);
  });
  it("notices and default-cap links keep the 30-days-past-expiry rule (cap_at NULL)", async () => {
    reset();
    const n = await issue({ subjectId: "n-sweep" });
    expect((await rowOf(n.selector))!.cap_at).toBeNull();
    clock = n.expiresAt + 30 * DAY + 1;
    await sweepPublicTokens(env, clock);
    expect(await rowOf(n.selector)).toBeNull();
  });
});

describe("r2: a lost commit is classified from the row as it is now (ASTRA-WP7-2 #3)", () => {
  it("expiry AT the commit inside redeemToken: link_expired, not link_used; nothing consumed", async () => {
    reset();
    const t = await issue();
    let calls = 0;
    // verifyToken reads the clock twice (before and after the identity read): both see a live link; the commit and the classification do not
    const steps = () => { calls += 1; return calls <= 2 ? t.expiresAt - 1 : t.expiresAt; };
    const r = await redeemToken(env, deps({ now: steps }), { selector: t.selector, secret: t.secret, purpose: "confirm" });
    expect(r).toEqual({ ok: false, code: "link_expired" });
    expect(calls).toBeGreaterThanOrEqual(3);
    expect((await rowOf(t.selector))!.used_at).toBeNull();
  });
  it("production path (database time): an unused link that expired by the commit is link_expired", async () => {
    reset();
    const t = await issue();                                 // T0 lies in the past: expired in real time
    const v = await verifyToken(env, deps(), t.selector, t.secret, "confirm");
    if (!v.ok) throw new Error("expected ok");
    const { clock: _injected, ...prod } = v;
    expect(await commitToken(env, prod)).toEqual({ won: false });
    expect(await lostCommitRefusal(env, prod)).toEqual({ ok: false, code: "link_expired" });
  });
  it("someone else consumed it first: link_used with the committed row", async () => {
    reset();
    const t = await issue();
    const a = await verifyToken(env, deps(), t.selector, t.secret, "confirm");
    const b = await verifyToken(env, deps(), t.selector, t.secret, "confirm");
    if (!a.ok || !b.ok) throw new Error("expected ok");
    clock += 5;
    expect(await commitToken(env, a)).toEqual({ won: true });
    expect(await commitToken(env, b)).toEqual({ won: false });
    const r = await lostCommitRefusal(env, b);
    expect(r).toMatchObject({ ok: false, code: "link_used", row: { selector: t.selector, usedAt: T0 + 5 } });
  });
  it("replaced by a reissue between verify and commit: link_invalid, and redeemToken answers the same", async () => {
    reset();
    const t = await issue();
    const v = await verifyToken(env, deps(), t.selector, t.secret, "confirm");
    if (!v.ok) throw new Error("expected ok");
    clock += 1000;
    await issue();
    expect(await commitToken(env, v)).toEqual({ won: false });
    expect(await lostCommitRefusal(env, v)).toEqual({ ok: false, code: "link_invalid" });
    // through redeemToken: the reissue lands during the identity read
    reset();
    const u = await issue({ subjectId: "n-race" });
    const racing: TokenDeps["reader"] = { emailGen: async (id) => { const x = await reader.emailGen(id); clock += 1; await issue({ subjectId: "n-race" }); return x; } };
    expect(await redeemToken(env, deps({ reader: racing }), { selector: u.selector, secret: u.secret, purpose: "confirm" })).toEqual({ ok: false, code: "link_invalid" });
  });
});
