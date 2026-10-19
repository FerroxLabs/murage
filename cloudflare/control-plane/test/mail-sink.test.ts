// SPDX-License-Identifier: AGPL-3.0-or-later
// TRUST-FIRST-FACTOR.md revision 2, part C (Astra TRUST-1 #8, TRUST-2 F2-F5): the staging mail sink engages only with BOTH the
// staging-only MAIL_SINK D1 binding and STAGING_MAIL_SINK=1; every sender goes through email.ts's transactionalSender; nothing else
// touches the EMAIL binding; the deploy check refuses the sink outside env.staging. src/email.ts, scripts/check-deploy.mjs.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MAIL_SINK_RETENTION_MS, mailSink, senderOrFail, sinkRecipientAllowed, sendOTPEmailChecked, sweepMailSink, transactionalSender } from "../src/email";
import worker, { createWorker } from "../src/index";
import { acquireHomeLease } from "../src/billing-lease";
import { defaultNotifier } from "../src/b5-billing";
import { cloudMember, jwksFetch, supabaseEnv } from "./cloud-member";
import sinkSql from "../migrations-mailsink/0001_sink.sql?raw";
import wranglerText from "../wrangler.jsonc?raw";
import indexSource from "../src/index.ts?raw";
import { checkConfig, SINK_DATABASE_ID } from "../scripts/check-deploy.mjs";

// @ts-expect-error import.meta.glob is Vite's (vitest transforms it); the worker tsconfig does not load vite/client types.
const sources = import.meta.glob("../src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** The real EMAIL binding stand-in: records what reached it. */
const real: { to: string; subject: string }[] = [];
const fakeEmail = { async send(m: { to: string; subject: string }) { real.push({ to: m.to, subject: m.subject }); } };
const sinkEnv = (over: Record<string, unknown> = {}) =>
  ({ ...env, ...supabaseEnv, EMAIL: fakeEmail, MAIL_SINK: env.DB, STAGING_MAIL_SINK: "1", MAIL_SINK_ALLOWLIST: "@example.test", MACHINE_OPEN_LIMIT: undefined, MACHINE_BEARER_LIMIT: undefined, ...over }) as unknown as Env;
const sinkRows = async () => (await env.DB.prepare("SELECT to_addr,subject,text,created_at FROM staging_mail_sink ORDER BY created_at,subject").all<{ to_addr: string; subject: string; text: string; created_at: number }>()).results;
const msg = { to: "pat@example.test", from: { email: "noreply@murage.ai", name: "Murage" }, subject: "S", text: "T", html: "<p>H</p>" };

beforeAll(async () => {
  // The sink table lives in its own staging database; here the test D1 stands in for that binding.
  const sql = sinkSql.split("\n").map((l: string) => l.replace(/--.*$/, "")).join("\n");
  for (const stmt of sql.split(";").map((x: string) => x.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
});
afterEach(async () => { real.length = 0; await env.DB.prepare("DELETE FROM staging_mail_sink").run(); });
afterAll(async () => { await env.DB.prepare("DROP TABLE staging_mail_sink").run(); });

describe("staging mail sink: engaged only with the staging binding AND the var", () => {
  it("both: the sink; binding only, var only, a wrong var, a non-D1 binding: the real EMAIL binding", async () => {
    expect(mailSink(sinkEnv())).not.toBeNull();
    await transactionalSender(sinkEnv())!.send(msg);
    expect(real).toEqual([]);
    expect((await sinkRows()).map((r) => [r.to_addr, r.subject, r.text])).toEqual([["pat@example.test", "S", "T"]]);
    for (const over of [{ STAGING_MAIL_SINK: undefined }, { MAIL_SINK: undefined }, { STAGING_MAIL_SINK: "true" }, { STAGING_MAIL_SINK: 1 },
      { MAIL_SINK: { prepare: "not a database" } }, { MAIL_SINK: "7c9c6777-f7a1-4804-8596-7933a523d392" }]) {
      expect(mailSink(sinkEnv(over))).toBeNull();
      await transactionalSender(sinkEnv(over))!.send(msg);
    }
    expect(real).toHaveLength(6);
    expect(await sinkRows()).toHaveLength(1);
    // The test environment is the production configuration: no MAIL_SINK binding at all.
    expect((env as unknown as { MAIL_SINK?: unknown }).MAIL_SINK).toBeUndefined();
    expect(mailSink({ ...env, STAGING_MAIL_SINK: "1" } as unknown as Env)).toBeNull();
    // Neither sink nor EMAIL: no sender; senderOrFail's send fails.
    expect(transactionalSender(sinkEnv({ EMAIL: undefined, MAIL_SINK: undefined }))).toBeNull();
    await expect(senderOrFail(sinkEnv({ EMAIL: undefined, MAIL_SINK: undefined })).send(msg)).rejects.toThrow("email_unavailable");
  });

  it("every sender writes to the sink when engaged, and the sink logs no message body", async () => {
    const logged: string[] = [];
    const spies = (["log", "error", "warn", "info"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); }));
    try {
      const e = sinkEnv();
      // 1. Better Auth (companion) email OTP: src/auth.ts.
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request("https://auth.murage.test/api/auth/email-otp/send-verification-otp", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "companion@example.test", type: "sign-in" }) }), e, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
      // 2. The trusted-factor code: src/trusted-factors.ts send(), through the worker with no injected sender.
      const member = await cloudMember("cloud@example.test");
      const F = "11111111-1111-4111-8111-111111111111";
      const authFetch = (async () => Response.json({ id: member.sub, email: "cloud@example.test", email_confirmed_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z", factors: [{ id: F, factor_type: "totp", status: "verified", friendly_name: "", created_at: "2026-10-01T00:00:00Z" }] })) as typeof fetch;
      const w = createWorker(fetch, fetch, {}, {}, {}, { jwksFetch, authFetch });
      const ctx2 = createExecutionContext();
      const trust = await w.fetch(new Request("https://auth.murage.test/v1/account/mfa/trust-code", { method: "POST",
        headers: { authorization: `Bearer ${member.token}`, "content-type": "application/json" }, body: JSON.stringify({ factorId: F }) }), e, ctx2);
      await waitOnExecutionContext(ctx2);
      expect(trust.status).toBe(202);
      // 3. Billing and legal notices: b5-billing defaultNotifier (the former `const email = env.EMAIL` alias).
      await env.DB.prepare(`INSERT OR IGNORE INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('sink-owner','N','owner@example.test',1,1,1)`).run();
      const lease = (await acquireHomeLease(env, "sink-home", "sink-1"))!;
      await defaultNotifier.notify(e as never, { id: "payment_failed:sink-home:1", homeId: "sink-home", ownerId: "sink-owner", kind: "payment_failed", data: {} }, lease);
      // 4. Desktop pairing codes and notices (src/pairing.ts), withdrawal notices and cancellation mail (src/withdrawal-notices.ts,
      //    src/public-cancellation.ts) default to senderOrFail(env): the same resolver, with their message shapes.
      expect(await sendOTPEmailChecked(senderOrFail(e), "noreply@murage.ai", { email: "desk@example.test", otp: "12345678", type: "device-pairing" }, "t")).toBe(true);
      await senderOrFail(e).send({ ...msg, to: "notice@example.test", subject: "Withdrawal or cancellation notice" });
      const rows = await sinkRows();
      expect(rows.map((r) => r.to_addr).sort()).toEqual(["cloud@example.test", "companion@example.test", "desk@example.test", "notice@example.test", "owner@example.test"]);
      expect(real).toEqual([]); // nothing reached the real binding
      // No log line carries a body: no code, no message text.
      const codes = rows.flatMap((r) => r.text.match(/\b\d{8}\b/g) ?? []);
      expect(codes.length).toBeGreaterThanOrEqual(3);
      for (const line of logged) {
        for (const c of codes) expect(line).not.toContain(c);
        for (const r of rows) expect(line).not.toContain(r.text);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("retention: the cron sweep deletes rows older than 24 h (binding present, engaged or not); production has no binding", async () => {
    const now = 1_800_000_000_000;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO staging_mail_sink (id,to_addr,subject,text,created_at) VALUES ('old','a@x','s','t',?)").bind(now - MAIL_SINK_RETENTION_MS - 1),
      env.DB.prepare("INSERT INTO staging_mail_sink (id,to_addr,subject,text,created_at) VALUES ('new','a@x','s','t',?)").bind(now - 60_000),
    ]);
    await sweepMailSink({ ...env } as unknown as Env, now); // no binding: nothing happens
    expect(await sinkRows()).toHaveLength(2);
    await sweepMailSink(sinkEnv({ STAGING_MAIL_SINK: undefined }), now);
    expect((await env.DB.prepare("SELECT id FROM staging_mail_sink").all()).results).toEqual([{ id: "new" }]);
    expect(indexSource).toMatch(/scheduled\([\s\S]*await sweepMailSink\(env\)/);
  });
});

describe("sink recipient allowlist (Astra TRUSTCODE-1 P2-2): MAIL_SINK_ALLOWLIST", () => {
  const allow = (list: unknown, to: string) => sinkRecipientAllowed({ MAIL_SINK_ALLOWLIST: list } as unknown as Env, to);
  it("matches exact addresses and exact @domain entries, case-insensitively; an empty or missing list allows nothing", () => {
    expect(allow("sean@x.test, @staging.murage.test", "Sean@X.test")).toBe(true);
    expect(allow("sean@x.test, @staging.murage.test", "any.one@staging.murage.test")).toBe(true);
    for (const to of ["other@x.test", "sean@x.test.evil.test", "a@evil.staging.murage.test", "a@b@staging.murage.test", "a@staging.murage.test, b@x.test",
      "@staging.murage.test", "staging.murage.test", ""]) expect(allow("sean@x.test, @staging.murage.test", to), to).toBe(false);
    for (const list of [undefined, "", " , ", "@", 5, null]) expect(allow(list, "sean@x.test"), String(list)).toBe(false);
  });
  it("an allowed recipient is sunk; any other is REJECTED: no sink row, no real send, the send throws", async () => {
    const e = sinkEnv({ MAIL_SINK_ALLOWLIST: "sean@x.test,@staging.murage.test" });
    await transactionalSender(e)!.send({ ...msg, to: "sean@x.test" });
    await transactionalSender(e)!.send({ ...msg, to: "bot@staging.murage.test" });
    expect((await sinkRows()).map((r) => r.to_addr)).toEqual(["sean@x.test", "bot@staging.murage.test"]);
    await expect(transactionalSender(e)!.send({ ...msg, to: "customer@gmail.com" })).rejects.toThrow("mail_sink_recipient_rejected");
    expect(await sinkRows()).toHaveLength(2);
    expect(real).toEqual([]);
    // The callers' existing failure handling: the checked OTP sender reports false; senderOrFail throws.
    expect(await sendOTPEmailChecked(senderOrFail(e), "noreply@murage.ai", { email: "customer@gmail.com", otp: "12345678", type: "sign-in" }, "t")).toBe(false);
    expect(await sinkRows()).toHaveLength(2);
    expect(real).toEqual([]);
  });
  it("sink engaged with an empty or missing allowlist: everything is rejected, nothing falls through to the provider", async () => {
    for (const over of [{ MAIL_SINK_ALLOWLIST: undefined }, { MAIL_SINK_ALLOWLIST: "" }]) {
      await expect(transactionalSender(sinkEnv(over))!.send(msg)).rejects.toThrow("mail_sink_recipient_rejected");
    }
    expect(await sinkRows()).toEqual([]);
    expect(real).toEqual([]);
  });
  it("the trusted-factor code route answers 503 email_unavailable for a recipient off the allowlist, with zero sink rows and zero provider sends", async () => {
    const member = await cloudMember("stranger@gmail.com");
    const F = "11111111-1111-4111-8111-111111111111";
    const authFetch = (async () => Response.json({ id: member.sub, email: "stranger@gmail.com", email_confirmed_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z", factors: [{ id: F, factor_type: "totp", status: "verified", friendly_name: "", created_at: "2026-10-01T00:00:00Z" }] })) as typeof fetch;
    const w = createWorker(fetch, fetch, {}, {}, {}, { jwksFetch, authFetch });
    const ctx = createExecutionContext();
    const res = await w.fetch(new Request("https://auth.murage.test/v1/account/mfa/trust-code", { method: "POST",
      headers: { authorization: `Bearer ${member.token}`, "content-type": "application/json" }, body: JSON.stringify({ factorId: F }) }), sinkEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect([res.status, (await res.json<{ error: string }>()).error]).toEqual([503, "email_unavailable"]);
    expect(await sinkRows()).toEqual([]);
    expect(real).toEqual([]);
  });
});

describe("no EMAIL binding access outside src/email.ts (Astra TRUST-2 F5)", () => {
  /** Code with comments removed (full-line comments, block comments, trailing // comments that are not part of a URL). */
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l)).map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
  const offenders = (text: string) => code(text).split("\n").filter((l) => /\bEMAIL\b/.test(l));

  it("the detector catches every access shape (member, alias, destructuring, index)", () => {
    for (const bad of ["await env.EMAIL.send(m);", "const email = env.EMAIL;", "const { EMAIL } = env;", "const s = env[\"EMAIL\"];", "if (!env.EMAIL) x();"]) {
      expect(offenders(bad)).toHaveLength(1);
    }
    for (const ok of ["// handed to EMAIL", " * the EMAIL binding", "env.EMAIL_FROM", "x(); // EMAIL later", "/* EMAIL */ y();"]) expect(offenders(ok)).toEqual([]);
  });

  it("src/*.ts: only email.ts touches EMAIL, and every module that sends mail resolves its sender there", () => {
    const files = Object.entries(sources);
    expect(files.length).toBeGreaterThan(40);
    const found = files.filter(([f]) => !f.endsWith("/email.ts")).flatMap(([f, t]) => offenders(t).map((l) => `${f}: ${l.trim()}`));
    expect(found).toEqual([]);
    for (const f of ["auth.ts", "pairing.ts", "trusted-factors.ts", "withdrawal-notices.ts", "public-cancellation.ts", "b5-billing.ts"]) {
      expect(sources[`../src/${f}`], f).toMatch(/\b(senderOrFail|transactionalSender)\(env\)/);
    }
  });
});

describe("scripts/check-deploy.mjs (Astra TRUST-2 F2)", () => {
  const config = () => JSON.parse(wranglerText.split("\n").filter((l: string) => !/^\s*\/\//.test(l)).join("\n"));
  it("accepts the checked-in wrangler.jsonc: MAIL_SINK only in env.staging, with the staging sink id", () => {
    expect(checkConfig(wranglerText)).toEqual([]);
    const c = config();
    expect(c.d1_databases.map((d: { binding: string }) => d.binding)).toEqual(["DB"]);
    expect(c.env.staging.d1_databases.find((d: { binding: string }) => d.binding === "MAIL_SINK").database_id).toBe(SINK_DATABASE_ID);
  });
  it("refuses MAIL_SINK or STAGING_MAIL_SINK outside env.staging, a wrong sink id, or the sink on another Worker", () => {
    const bad = (mutate: (c: Record<string, any>) => void) => { const c = config(); mutate(c); return checkConfig(JSON.stringify(c)); };
    expect(bad((c) => { c.vars.STAGING_MAIL_SINK = "1"; })).toEqual([expect.stringContaining("STAGING_MAIL_SINK outside env.staging")]);
    expect(bad((c) => { c.d1_databases.push({ ...c.env.staging.d1_databases[1] }); }).join("\n")).toContain("MAIL_SINK outside env.staging");
    expect(bad((c) => { c.env.production = { d1_databases: [{ binding: "MAIL_SINK", database_name: "x", database_id: "y" }] }; }).join("\n")).toContain("MAIL_SINK outside env.staging");
    expect(bad((c) => { c.env.staging.d1_databases[1].database_id = "2bbc01ca-09b4-4ca9-8cb1-5471f8abb070"; }).join("\n")).toContain("database_id must be");
    expect(bad((c) => { c.env.staging.name = "murage-control-plane"; }).join("\n")).toContain("env.staging.name");
    expect(bad((c) => { c.env.staging.account_id = c.account_id; }).join("\n")).toContain("env.staging.account_id");
    expect(checkConfig("{ not json")).toEqual([expect.stringContaining("does not parse")]);
  });
});
