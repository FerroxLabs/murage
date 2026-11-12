// Updates consent B1 (design UPDATES-CONSENT-1020-CP-v5.md v5.6.1), on the real D1 of the Worker test runtime with migration 0149 applied.
// Each test is named after its design test number (7.1). These run the design's own prepared statements (src/updates-consent/sql-design.ts)
// through the B1 batch builders, so they also show D1 accepts the 0149 schema, its four triggers and every request-path statement.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import * as Q from "../src/updates-consent/sql-design";
import {
  bindNumbered, desktopBatch, membersOnBatch, outcomeOf, signupBatch, updatesSignupsOpen, type GateBinds,
} from "../src/updates-consent/gate";
import { deriveToken, emailKeyOf, proveTokenId, sha256Hex } from "../src/updates-consent/tokens";
import { oneClickHeaders } from "../src/updates-send";

// @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
const sources = import.meta.glob(["../src/*.ts", "../src/updates-consent/*.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const SECRET = env.BETTER_AUTH_SECRET;
const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);
const TEXT = "v1";
let seq = 0;
const fresh = (p: string) => `${p}-${++seq}-${crypto.randomUUID()}`;

async function count(sql: string, ...args: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...args).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.batch([
    "DELETE FROM updates_mail_outbox", "DELETE FROM updates_tokens", "DELETE FROM updates_obligations", "DELETE FROM updates_consent_events",
    "DELETE FROM updates_consent", "DELETE FROM updates_requests", "DELETE FROM updates_retired_receipts", "DELETE FROM announcement_rate_limits",
    "DELETE FROM announcement_consents",
  ].map((s) => env.DB.prepare(s)));
  await env.DB.prepare("INSERT OR IGNORE INTO updates_consent_texts (version, locale, body, effective_from) VALUES (?, 'en', 'test words', 0)").bind(TEXT).run();
});

/** Events are append-only, so each test uses its own address and key. */
async function address(tag: string) {
  const email = `${tag}-${++seq}@example.test`;
  return { email, emailKey: await emailKeyOf(email, SECRET) };
}

async function desktopBinds(o: { email: string; emailKey: string; receipt: string; answeredAt: number; now: number; currentReceipt?: string | null }): Promise<GateBinds> {
  const outboxId = fresh("ob");
  const { tokenHash } = await deriveToken(proveTokenId(outboxId), 1, SECRET);
  return {
    consentId: fresh("c"), subjectRef: o.receipt, email: o.email, emailKey: o.emailKey, textVersion: TEXT, installId: "inst-1",
    appVersion: "1.0.20", answeredAt: o.answeredAt, now: o.now, currentReceipt: o.currentReceipt ?? null, proveTokenHash: tokenHash,
    keyVersion: 1, outboxId, mailCapKey: await sha256Hex(`cap:${o.emailKey}`), nonce: fresh("n"), template: "prove", withGuide: false,
    forwarderSource: null, consentWords: null, source: "desktop", requestId: `desk:${o.receipt}:${o.answeredAt}`, path: "desktop",
    subjectId: `receipt:${o.receipt}`, payloadHash: await sha256Hex(`${o.receipt}|${o.email}|${o.answeredAt}`),
  };
}

async function runDesktop(b: GateBinds) {
  const stmts = desktopBatch(env.DB, b);
  const results = await env.DB.batch(stmts);
  return outcomeOf(results, stmts.length - 1);
}

async function signupBinds(o: { email: string; emailKey: string; requestId: string; now: number; source?: string; legacy?: boolean;
  firstMax?: number; secondMax?: number; secondKey?: string }): Promise<GateBinds> {
  const outboxId = fresh("ob");
  const { tokenHash } = await deriveToken(proveTokenId(outboxId), 1, SECRET);
  const source = o.legacy ? "legacy_desktop" : (o.source ?? "footer");
  return {
    consentId: fresh("c"), subjectRef: null, email: o.email, emailKey: o.emailKey, textVersion: TEXT, installId: null, appVersion: "site",
    answeredAt: o.now, now: o.now, currentReceipt: null, proveTokenHash: tokenHash, keyVersion: 1, outboxId, mailCapKey: await sha256Hex(`cap:${o.emailKey}`),
    nonce: fresh("n"), template: "prove", withGuide: false, forwarderSource: o.legacy ? null : source, consentWords: o.legacy ? null : "I agree",
    source, requestId: o.requestId, path: o.legacy ? "legacy" : "forwarder",
    limits: {
      firstKey: await sha256Hex(`addr:${o.emailKey}`), firstCutoff: o.now - 15 * 60_000, firstMax: o.firstMax ?? 3,
      secondKey: await sha256Hex(o.secondKey ?? "fwd-cap:global"), secondCutoff: o.now - 60 * 60_000, secondMax: o.secondMax ?? 500,
    },
    subjectId: `signup:${o.emailKey}:${source}`, payloadHash: await sha256Hex(`${o.requestId}|${o.email}`),
  };
}

async function runSignup(b: GateBinds) {
  const stmts = signupBatch(env.DB, b);
  const results = await env.DB.batch(stmts);
  return outcomeOf(results, stmts.length - 1);
}

const receipt = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, "0")).join("");

async function appendEvent(emailKey: string, kind: string, observedAt: number, source = "operator") {
  await env.DB.prepare("INSERT INTO updates_exclusion_events (email_key,kind,observed_at,source,ref,at) VALUES (?,?,?,?,NULL,?)")
    .bind(emailKey, kind, observedAt, source, observedAt).run();
}

describe("updates consent B1: migration 0149", () => {
  it("57 append-only: the triggers refuse UPDATE and DELETE on updates_exclusion_events, and no src statement names the table after UPDATE or DELETE FROM", async () => {
    const { emailKey } = await address("t57");
    await appendEvent(emailKey, "our_unsub", T0);
    await expect(env.DB.prepare("UPDATE updates_exclusion_events SET observed_at=0 WHERE email_key=?").bind(emailKey).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM updates_exclusion_events WHERE email_key=?").bind(emailKey).run()).rejects.toThrow(/append-only/);
    expect(await count("SELECT count(*) AS n FROM updates_exclusion_events WHERE email_key=?", emailKey)).toBe(1);
    const offenders = Object.entries(sources).filter(([, text]) => /(UPDATE|DELETE\s+FROM)\s+updates_exclusion_events/i.test(text)).map(([p]) => p);
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it("0149 list 37 mirror: a 0146 list 37 write appends a list37 event; another list adds none", async () => {
    const { emailKey } = await address("l37");
    await env.DB.prepare("INSERT INTO announcement_optouts (email_key,list_id,unsubscribed_at) VALUES (?, '37', ?)").bind(emailKey, T0).run();
    await env.DB.prepare("INSERT INTO announcement_optouts (email_key,list_id,unsubscribed_at) VALUES (?, '99', ?)").bind(emailKey, T0).run();
    expect(await count("SELECT count(*) AS n FROM updates_exclusion_events WHERE email_key=? AND kind='list37' AND observed_at=?", emailKey, T0)).toBe(1);
  });
});

describe("updates consent B1: the gate on the desktop path", () => {
  it("1 /email new receipt: one row with unproven_since, one prove token prove:<outbox id>, one queued mail, one event, admitted", async () => {
    const a = await address("t1");
    const b = await desktopBinds({ ...a, receipt: receipt(), answeredAt: T0, now: T0 });
    expect(await runDesktop(b)).toBe("admitted");
    const row = await env.DB.prepare("SELECT unproven_since, generation, status FROM updates_consent WHERE subject_id=?").bind(b.subjectId).first();
    expect(row).toEqual({ unproven_since: T0, generation: 1, status: "opted_in" });
    expect(await count("SELECT count(*) AS n FROM updates_tokens WHERE token_id=? AND token_hash=?", proveTokenId(b.outboxId), b.proveTokenHash)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM updates_mail_outbox WHERE id=? AND state='queued' AND template='prove'", b.outboxId)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM updates_consent_events")).toBe(1);
    expect(await count("SELECT attempts AS n FROM announcement_rate_limits WHERE subject_key=?", b.mailCapKey)).toBe(1);
  });

  it("2 identical retry (same request id, new nonce): RQ inserts nothing; no row change, no event, no mail, no cap charge; the same answer", async () => {
    const a = await address("t2");
    const r = receipt();
    const first = await desktopBinds({ ...a, receipt: r, answeredAt: T0, now: T0 });
    expect(await runDesktop(first)).toBe("admitted");
    const replay = await desktopBinds({ ...a, receipt: r, answeredAt: T0, now: T0 + 5_000 });
    expect(await runDesktop(replay)).toBe("admitted");
    expect(await count("SELECT count(*) AS n FROM updates_mail_outbox")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM updates_consent_events")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM updates_obligations")).toBe(1);
    expect(await count("SELECT attempts AS n FROM announcement_rate_limits WHERE subject_key=?", first.mailCapKey)).toBe(1);
  });

  it("4 fourth mail in 24 h: no token, no mail (capped); after the window a token and a mail together", async () => {
    const a = await address("t4");
    for (let i = 0; i < 3; i++) {
      const b = await desktopBinds({ ...a, receipt: receipt(), answeredAt: T0 + i, now: T0 + i });
      expect(await runDesktop(b)).toBe("admitted");
    }
    const fourth = await desktopBinds({ ...a, receipt: receipt(), answeredAt: T0 + 10, now: T0 + 10 });
    expect(await runDesktop(fourth)).toBe("capped");
    expect(await count("SELECT count(*) AS n FROM updates_tokens WHERE token_hash=?", fourth.proveTokenHash)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM updates_mail_outbox")).toBe(3);
    const later = T0 + 25 * 60 * 60_000;
    const next = await desktopBinds({ ...a, receipt: fourth.subjectRef!, answeredAt: later, now: later });
    expect(await runDesktop(next)).toBe("admitted");
    expect(await count("SELECT count(*) AS n FROM updates_tokens WHERE token_hash=?", next.proveTokenHash)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM updates_mail_outbox WHERE id=?", next.outboxId)).toBe(1);
  });

  it("85 an unknown currentReceipt after a cap: noop, generation and mut_nonce unchanged, no obligation; a real new answer is admitted", async () => {
    const a = await address("t85");
    for (let i = 0; i < 3; i++) await runDesktop(await desktopBinds({ ...a, receipt: receipt(), answeredAt: T0 + i, now: T0 + i }));
    const r = receipt();
    expect(await runDesktop(await desktopBinds({ ...a, receipt: r, answeredAt: T0 + 9, now: T0 + 9 }))).toBe("capped");
    const before = await env.DB.prepare("SELECT generation, mut_nonce FROM updates_consent WHERE subject_id=?").bind(`receipt:${r}`).first();
    const later = T0 + 25 * 60 * 60_000;
    const unknown = await desktopBinds({ ...a, receipt: r, answeredAt: later, now: later, currentReceipt: receipt() });
    expect(await runDesktop(unknown)).toBe("noop");
    expect(await env.DB.prepare("SELECT generation, mut_nonce FROM updates_consent WHERE subject_id=?").bind(`receipt:${r}`).first()).toEqual(before);
    expect(await count("SELECT count(*) AS n FROM updates_obligations WHERE nonce=?", unknown.nonce)).toBe(0);
    const real = await desktopBinds({ ...a, receipt: r, answeredAt: later + 1, now: later + 1 });
    expect(await runDesktop(real)).toBe("admitted");
  });
});

describe("updates consent B1: the gate on every path, for every kind (test 75)", () => {
  for (const kind of ["erase", "complaint", "bounce", "resend_unsub", "sendlane_global"] as const) {
    it(`75 ${kind}: desktop, forwarder, 1.0.19 and members are refused with no row, obligation, token, mail, 0145 row or cap charge`, async () => {
      const a = await address(`t75-${kind}`);
      await appendEvent(a.emailKey, kind, T0 - 1_000, kind === "resend_unsub" ? "resend_read" : kind === "sendlane_global" ? "sendlane_read" : "operator");
      const d = await desktopBinds({ ...a, receipt: receipt(), answeredAt: T0, now: T0 });
      expect(await runDesktop(d)).toBe("refused");
      const f = await signupBinds({ ...a, requestId: fresh("site-request"), now: T0 });
      expect(await runSignup(f)).toBe("refused");
      const l = await signupBinds({ ...a, requestId: `legacy:${a.emailKey}:${Math.floor(T0 / 600_000)}`, now: T0, legacy: true });
      expect(await runSignup(l)).toBe("refused");
      const userId = fresh("user");
      await env.DB.prepare("INSERT INTO supabase_identities (user_id, contact_email, email_revision) VALUES (?, ?, 1)").bind(userId, a.email).run()
        .catch(() => undefined);
      const m = { ...(await desktopBinds({ ...a, receipt: receipt(), answeredAt: T0, now: T0 })), subjectRef: userId, subjectId: `account:${userId}`,
        requestId: `acct:${userId}:${T0}`, path: "members" as const, emailRevision: 1 };
      const ms = membersOnBatch(env.DB, m);
      expect(outcomeOf(await env.DB.batch(ms), ms.length - 2)).toBe("refused");
      for (const t of ["updates_consent", "updates_obligations", "updates_tokens", "updates_mail_outbox", "announcement_consents"]) {
        expect([t, await count(`SELECT count(*) AS n FROM ${t}`)]).toEqual([t, 0]);
      }
      expect(await count("SELECT count(*) AS n FROM announcement_rate_limits WHERE subject_key=?", d.mailCapKey)).toBe(0);
    });
  }

  it("75 a resend_unsub with a newer cleared event, and our_unsub, are admitted (one of each)", async () => {
    const a = await address("t75-cleared");
    await appendEvent(a.emailKey, "resend_unsub", T0 - 2_000, "resend_read");
    await appendEvent(a.emailKey, "cleared", T0 - 1_000, "support");
    expect(await runDesktop(await desktopBinds({ ...a, receipt: receipt(), answeredAt: T0, now: T0 }))).toBe("admitted");
    const b = await address("t75-our");
    await appendEvent(b.emailKey, "our_unsub", T0 - 1_000, "link");
    expect(await runSignup(await signupBinds({ ...b, requestId: fresh("site-request"), now: T0 }))).toBe("admitted");
  });
});

describe("updates consent B1: the limits in SQL (tests 18 and 81)", () => {
  it("18 an exhausted per-address limit gives a refused and an allowed address the same 429 outcome, both charged alike", async () => {
    const blocked = await address("t18-blocked");
    await appendEvent(blocked.emailKey, "complaint", T0 - 1_000);
    const allowed = await address("t18-allowed");
    const outcomes: Record<string, (string | null)[]> = { blocked: [], allowed: [] };
    for (const [name, a] of [["blocked", blocked], ["allowed", allowed]] as const) {
      for (let i = 0; i < 4; i++) outcomes[name]!.push(await runSignup(await signupBinds({ ...a, requestId: fresh("site-request"), now: T0 + i, firstMax: 3 })));
    }
    expect(outcomes.blocked!.at(-1)).toBe("rate_limited");
    expect(outcomes.allowed!.at(-1)).toBe("rate_limited");
    expect(await count("SELECT attempts AS n FROM announcement_rate_limits WHERE subject_key=?", await sha256Hex(`addr:${blocked.emailKey}`)))
      .toBe(await count("SELECT attempts AS n FROM announcement_rate_limits WHERE subject_key=?", await sha256Hex(`addr:${allowed.emailKey}`)));
  });

  it("18 an exhausted hourly cap gives both 429; a replay of a committed id is charged nothing and reads its first outcome", async () => {
    const blocked = await address("t18c-blocked");
    await appendEvent(blocked.emailKey, "bounce", T0 - 1_000);
    const allowed = await address("t18c-allowed");
    const capKey = fresh("cap");
    const first = await signupBinds({ ...allowed, requestId: fresh("site-request"), now: T0, secondKey: capKey, secondMax: 1 });
    expect(await runSignup(first)).toBe("admitted");
    expect(await runSignup(await signupBinds({ ...allowed, requestId: fresh("site-request"), now: T0 + 1, secondKey: capKey, secondMax: 1 }))).toBe("rate_limited");
    expect(await runSignup(await signupBinds({ ...blocked, requestId: fresh("site-request"), now: T0 + 2, secondKey: capKey, secondMax: 1 }))).toBe("rate_limited");
    const replay = { ...(await signupBinds({ ...allowed, requestId: first.requestId, now: T0 + 3, secondKey: capKey, secondMax: 1 })) };
    expect(await runSignup(replay)).toBe("admitted");
    expect(await count("SELECT count(*) AS n FROM updates_mail_outbox")).toBe(1);
  });

  it("18 source: refundAttempt and writeGate are not called from any updates path", () => {
    const updates = Object.entries(sources).filter(([p]) => p.includes("/updates-consent/") || p.endsWith("/updates-send.ts"));
    expect(updates.length).toBeGreaterThan(2);
    for (const [p, text] of updates) expect([p, /refundAttempt|writeGate/.test(text)]).toEqual([p, false]);
  });
});

describe("updates consent B1: mail headers and the DKIM gate", () => {
  it("50 oneClickHeaders returns exactly the RFC 8058 pair and refuses a non-https URL", () => {
    const url = "https://cp.murage.test/v1/updates-consent/unsubscribe?token=abc";
    expect(oneClickHeaders(url)).toEqual({ "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(() => oneClickHeaders("http://cp.murage.test/x")).toThrow(/not_https/);
    expect(() => oneClickHeaders("not a url")).toThrow(/invalid/);
  });

  it("67 DKIM gate: UPDATES_SIGNUPS_OPEN=1 is refused without CP_ONECLICK_DKIM_VERIFIED=1; both default off", () => {
    expect(updatesSignupsOpen({} as Env)).toBe(false);
    expect(updatesSignupsOpen({ UPDATES_SIGNUPS_OPEN: "1" } as Env)).toBe(false);
    expect(updatesSignupsOpen({ CP_ONECLICK_DKIM_VERIFIED: "1" } as Env)).toBe(false);
    expect(updatesSignupsOpen({ UPDATES_SIGNUPS_OPEN: "1", CP_ONECLICK_DKIM_VERIFIED: "1" } as Env)).toBe(true);
    expect(updatesSignupsOpen(env)).toBe(false);
  });

  it("every design statement binds on D1 (prepared with its own parameter count)", () => {
    for (const [name, sql] of Object.entries(Q)) expect([name, typeof bindNumbered(env.DB, sql as string, {})]).toEqual([name, "object"]);
  });
});
