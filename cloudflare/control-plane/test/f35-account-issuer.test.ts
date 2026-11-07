import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, type D1Migration, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import { createWorker } from "../src/index";

// F35 (better-auth 1.7.1 -> 1.7.7). 1.7.3+ never writes account.issuer; migration 0111 makes it nullable (step 1), and
// migrations-later/0112 drops it once no 1.7.1 Worker remains (step 2). These run on this file's own D1.

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_LATER_MIGRATIONS: D1Migration[];
    }
  }
}

const BASE_URL = "https://auth.murage.test";

async function signIn(worker: ReturnType<typeof createWorker>, email: string): Promise<string> {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  const request = new Request(`${BASE_URL}/api/auth/sign-in/email-otp`, {
    body: JSON.stringify({ email, name: "F35 owner", otp }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const rctx = createExecutionContext();
  const response = await worker.fetch(request, env, rctx);
  await waitOnExecutionContext(rctx);
  expect(response.status).toBe(200);
  return (await response.json<{ user: { id: string } }>()).user.id;
}

/** The one emailOTP route that writes an account row (a "credential" account); sign-in by code writes only "user". */
async function resetPassword(email: string): Promise<void> {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "forget-password" } });
  await auth.api.resetPasswordEmailOTP({ body: { email, otp, password: "f35-test-only-password-long-enough" } }); // secret-scan: fixture
  await waitOnExecutionContext(ctx);
}

async function accountColumns(): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT name FROM pragma_table_info('account')`).all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

describe("F35 step 1 (0111): account.issuer is nullable, column and index kept", () => {
  it("keeps the issuer column and its unique index, and accepts an account row without issuer", async () => {
    expect(await accountColumns()).toContain("issuer");
    const index = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='account_issuer_accountId_uidx'`).first();
    expect(index).not.toBeNull();
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('f35-u1', 'F35', 'f35-raw@example.com', 1, ?, ?)`)
      .bind(now, now).run();
    // Fails on the 0001 schema: NOT NULL constraint failed: account.issuer.
    await env.DB.prepare(`INSERT INTO "account" (id, accountId, providerId, userId, createdAt, updatedAt) VALUES ('f35-a1', 'f35-u1', 'credential', 'f35-u1', ?, ?)`)
      .bind(now, now).run();
    // A 1.7.1 Worker (now or after a rollback) still writes issuer: unchanged.
    await env.DB.prepare(`INSERT INTO "account" (id, issuer, accountId, providerId, userId, createdAt, updatedAt) VALUES ('f35-a2', 'local:x', 'f35-u1x', 'credential', 'f35-u1', ?, ?)`)
      .bind(now, now).run();
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE userId='f35-u1'`).first<{ n: number }>())?.n).toBe(2);
  });

  it("signs up and signs in by email code, and the password reset writes its account row with no issuer", async () => {
    const worker = createWorker();
    const email = "f35-signin@example.com";
    const first = await signIn(worker, email);
    expect(await signIn(worker, email)).toBe(first);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE userId=?`).bind(first).first<{ n: number }>())?.n).toBe(0);
    await resetPassword(email);
    const account = await env.DB.prepare(`SELECT providerId, issuer FROM "account" WHERE userId=?`).bind(first).first();
    expect(account).toEqual({ providerId: "credential", issuer: null });
  });

  it("asks D1 nothing about its schema when an auth instance serves a request (validateSchema: false)", async () => {
    const seen: string[] = [];
    const db = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") return (sql: string) => { seen.push(sql); return target.prepare(sql); };
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const ctx = createExecutionContext();
    const auth = createAuth({ ...env, DB: db }, ctx, readConfig(env), crypto.randomUUID());
    await auth.api.createVerificationOTP({ body: { email: "f35-introspect@example.com", type: "sign-in" } });
    await waitOnExecutionContext(ctx);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((sql) => /sqlite_master|sqlite_schema|pragma_table_info|PRAGMA /i.test(sql))).toEqual([]);
  });
});

describe("F35 step 2 (migrations-later/0112), applied after 0111 and the 1.7.7 Worker", () => {
  it("drops the index and the column, and sign-in and the password reset still work", async () => {
    expect(env.TEST_LATER_MIGRATIONS.map((m) => m.name)).toEqual(["0112_account_drop_issuer.sql"]);
    await applyD1Migrations(env.DB, env.TEST_LATER_MIGRATIONS);
    expect(await accountColumns()).not.toContain("issuer");
    const worker = createWorker();
    const email = "f35-after-drop@example.com";
    const id = await signIn(worker, email);
    await resetPassword(email);
    const account = await env.DB.prepare(`SELECT providerId FROM "account" WHERE userId=?`).bind(id).first();
    expect(account).toEqual({ providerId: "credential" });
  });
});
