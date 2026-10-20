// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP7: the isolated identity reader (support design 4.5 failure contract) and the Worker configs that keep it private.
import { describe, expect, it, vi } from "vitest";
import { endpointFor, IdentityUnavailable, readIdentity } from "../../identity-reader/src/read";
import readerEntry from "../../identity-reader/src/index.ts?raw";
import readerConfig from "../../identity-reader/wrangler.jsonc?raw";
import controlPlaneConfig from "../wrangler.jsonc?raw";

const USER = "5f0c1b2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const ENV = { SUPABASE_URL: "https://testref.supabase.co", SUPABASE_SECRET_KEY: "test-only-not-a-real-secret-key" };
const ok = (over: Record<string, unknown> = {}) => Response.json({ id: USER, email: "Pat@Example.test", updated_at: "2026-10-01T00:00:00Z", aud: "authenticated", ...over });
const fakeFetch = (res: () => Response | Promise<Response>) => vi.fn(async (..._a: Parameters<typeof fetch>) => res()) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
const failsClosed = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(IdentityUnavailable);

describe("identity reader: failure contract", () => {
  it("asks the fixed endpoint, with the secret key, no redirects, and projects only {id, email, updatedAt}", async () => {
    const f = fakeFetch(() => ok());
    expect(await readIdentity(ENV, USER, f)).toEqual({ id: USER, email: "pat@example.test", updatedAt: "2026-10-01T00:00:00Z" });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe(`https://testref.supabase.co/auth/v1/admin/users/${USER}`);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${ENV.SUPABASE_SECRET_KEY}`);
  });
  it("a redirect is never followed: every 3xx and the opaque redirect fail closed", async () => {
    for (const status of [301, 302, 307, 308]) {
      const f = fakeFetch(() => new Response(null, { status, headers: { location: "https://evil.example/auth/v1/admin/users/x" } }));
      await failsClosed(readIdentity(ENV, USER, f));
      expect(f).toHaveBeenCalledTimes(1);
    }
    await failsClosed(readIdentity(ENV, USER, fakeFetch(() => { const r = ok(); Object.defineProperty(r, "status", { value: 0 }); return r; })));
  });
  it("a timeout fails closed", async () => {
    const f = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    await failsClosed(readIdentity(ENV, USER, f, 20));
  });
  it("the default timeout is 5 seconds", async () => {
    const { READ_TIMEOUT_MS } = await import("../../identity-reader/src/read");
    expect(READ_TIMEOUT_MS).toBe(5000);
  });
  it("a different user id in the answer is an error (checked against the requested sub)", async () => {
    await failsClosed(readIdentity(ENV, USER, fakeFetch(() => ok({ id: "00000000-0000-4000-8000-000000000000" }))));
    await failsClosed(readIdentity(ENV, USER, fakeFetch(() => ok({ id: undefined }))));
  });
  it("non-200, a network error, bad JSON, a missing email or updated_at: all fail closed", async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 503]) await failsClosed(readIdentity(ENV, USER, fakeFetch(() => new Response("{}", { status }))));
    await failsClosed(readIdentity(ENV, USER, fakeFetch(() => { throw new TypeError("network"); })));
    await failsClosed(readIdentity(ENV, USER, fakeFetch(() => new Response("not json"))));
    await failsClosed(readIdentity(ENV, USER, fakeFetch(() => new Response("[]"))));
    await failsClosed(readIdentity(ENV, USER, fakeFetch(() => ok({ email: "" }))));
    await failsClosed(readIdentity(ENV, USER, fakeFetch(() => ok({ email: null }))));
    await failsClosed(readIdentity(ENV, USER, fakeFetch(() => ok({ updated_at: null }))));
    await failsClosed(readIdentity(ENV, USER, fakeFetch(() => ok({ updated_at: "" }))));
    await failsClosed(readIdentity(ENV, USER, fakeFetch(() => new Response("x".repeat(70_000)))));
  });
  it("the error carries no detail and no secret", async () => {
    const e = await readIdentity(ENV, USER, fakeFetch(() => new Response(ENV.SUPABASE_SECRET_KEY, { status: 500 }))).catch((x: Error) => x);
    expect((e as Error).message).toBe("identity_unavailable");
    expect(String((e as Error).stack)).not.toContain(ENV.SUPABASE_SECRET_KEY);
  });
  it("config problems fail closed without any request: no key, http, a path, credentials, a query, an empty URL, a non-uuid user", async () => {
    const f = fakeFetch(() => ok());
    await failsClosed(readIdentity({ SUPABASE_URL: ENV.SUPABASE_URL }, USER, f));
    for (const url of ["http://testref.supabase.co", "https://testref.supabase.co/rest", "https://u:p@testref.supabase.co", "https://testref.supabase.co/?x=1", "", "not a url"]) {
      await failsClosed(readIdentity({ ...ENV, SUPABASE_URL: url }, USER, f));
    }
    await failsClosed(readIdentity({ SUPABASE_SECRET_KEY: ENV.SUPABASE_SECRET_KEY }, USER, f));
    for (const id of ["../x", `${USER}/../../x`, "", "123", `${USER}?a=b`]) await failsClosed(readIdentity(ENV, id, f));
    expect(f).not.toHaveBeenCalled();
    expect(() => endpointFor(ENV, USER)).not.toThrow();
  });
  it("exposes exactly one method, emailGen, and answers no HTTP request with anything but 404", () => {
    expect(readerEntry.match(/^\s+async\s+\w+\s*\(/gm)).toHaveLength(1);
    expect(readerEntry).toMatch(/async emailGen\(userId: string\)/);
    expect(readerEntry).toMatch(/status: 404/);
    expect(readerEntry).not.toMatch(/console\./);                 // nothing about an identity is ever logged
  });
});

/** Full-line comments out; the JSONC files here keep their comments on their own lines. */
const jsonc = (text: string) => text.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

describe("Worker configs", () => {
  const reader = JSON.parse(jsonc(readerConfig)) as Record<string, unknown> & { env: { staging: Record<string, unknown> } };
  it("the reader has no public URL: workers_dev and preview_urls off, no routes, no custom domain, no cron, in every environment", () => {
    for (const cfg of [reader, reader.env.staging]) {
      expect(cfg.workers_dev).toBe(false);
      expect(cfg.preview_urls).toBe(false);
      for (const key of ["routes", "route", "triggers", "custom_domain", "zone_id", "zone_name", "pattern", "assets", "site"]) expect(cfg, key).not.toHaveProperty(key);
    }
    const flat = jsonc(readerConfig);
    expect(flat).not.toMatch(/"(routes?|custom_domain|pattern|triggers)"/);
    expect(flat).not.toMatch(/murage\.ai|\.workers\.dev/);
  });
  it("the Supabase secret key is a secret of the reader (never a var), and only of the reader", () => {
    expect((reader.secrets as { required: string[] }).required).toEqual(["SUPABASE_SECRET_KEY"]);
    expect(Object.keys(reader.vars as object)).toEqual(["SUPABASE_URL"]);
    expect(jsonc(controlPlaneConfig)).not.toMatch(/service_role|SUPABASE_SECRET|SUPABASE_SERVICE|sb_secret/i);
  });
  it("the control plane reaches the reader only through a service binding, in production and staging", () => {
    const cp = JSON.parse(jsonc(controlPlaneConfig).replace(/,(\s*[}\]])/g, "$1")) as { account_id: string; services: Record<string, string>[]; env: { staging: { account_id: string; services: Record<string, string>[] } } };
    expect(cp.services).toEqual([{ binding: "IDENTITY_READER", service: "murage-identity-reader", entrypoint: "IdentityReader" }]);
    expect(cp.env.staging.services).toEqual([{ binding: "IDENTITY_READER", service: "murage-identity-reader-staging", entrypoint: "IdentityReader" }]);
    expect(reader.name).toBe("murage-identity-reader");
    expect(reader.env.staging.name).toBe("murage-identity-reader-staging");
    expect(reader.account_id).toBe(cp.account_id);                       // service bindings do not cross accounts
    expect(reader.env.staging.account_id).toBe(cp.env.staging.account_id);
  });
});

describe("r1: the body is counted in bytes as it streams, under the same timeout (ASTRA-WP7-1 #5)", () => {
  const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
  const respond = (stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) => fakeFetch(() => new Response(stream, { status: 200, headers }));
  it("an endless body is cancelled just past 64 KiB, not buffered", async () => {
    let pulled = 0; let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1; c.enqueue(chunk); }, cancel() { cancelled = true; } });
    await failsClosed(readIdentity(ENV, USER, respond(endless)));
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);                                     // 5 chunks of 16 KiB cross 64 KiB; a few more may be queued, never thousands
  });
  it("bytes, not characters: 33,000 two-byte characters (66 KB) are refused even though they are fewer than 65,536 characters", async () => {
    const body = JSON.stringify({ id: USER, email: "pat@example.test", updated_at: "2026-10-01T00:00:00Z", pad: "é".repeat(33_000) });
    expect(body.length).toBeLessThan(65_536);
    await failsClosed(readIdentity(ENV, USER, fakeFetch(() => new Response(body))));
  });
  it("a declared content-length over the cap fails on the header alone, even when the body itself is small and valid", async () => {
    const res = ok();
    res.headers.set("content-length", String(70_000));
    expect(res.headers.get("content-length")).toBe("70000");
    await failsClosed(readIdentity(ENV, USER, fakeFetch(() => res)));
    expect(res.bodyUsed).toBe(false);                                   // never read
  });
  it("headers on time, then a stalled body: the timeout still fires during the body read", async () => {
    const t0 = Date.now();
    const stalled = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"id":"')); } });   // never closes
    await failsClosed(readIdentity(ENV, USER, respond(stalled), 30));
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
  it("a body that arrives in many small chunks under the cap is read whole", async () => {
    const text = JSON.stringify({ id: USER, email: "Pat@Example.test", updated_at: "2026-10-01T00:00:00Z", pad: "y".repeat(60_000) });
    const bytes = new TextEncoder().encode(text);
    const s = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i += 1000) c.enqueue(bytes.slice(i, i + 1000)); c.close(); } });
    expect(await readIdentity(ENV, USER, respond(s))).toEqual({ id: USER, email: "pat@example.test", updatedAt: "2026-10-01T00:00:00Z" });
  });
});

describe("r1: reader RPC wiring", () => {
  it("the IdentityReader entrypoint answers through readIdentity with its own env, and the control plane accepts that answer", async () => {
    const { IdentityReader } = await import("../../identity-reader/src/index");
    const { createExecutionContext } = await import("cloudflare:test");
    const f = vi.fn(async () => ok());
    vi.stubGlobal("fetch", f);
    try {
      const entry = new IdentityReader(createExecutionContext(), ENV as never);
      expect(await entry.emailGen(USER)).toEqual({ id: USER, email: "pat@example.test", updatedAt: "2026-10-01T00:00:00Z" });
      expect(f).toHaveBeenCalledTimes(1);
      expect(String((f.mock.calls[0] as unknown[])[0])).toBe(`https://testref.supabase.co/auth/v1/admin/users/${USER}`);
      const broken = new IdentityReader(createExecutionContext(), { SUPABASE_URL: ENV.SUPABASE_URL } as never);
      await expect(broken.emailGen(USER)).rejects.toBeInstanceOf(IdentityUnavailable);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("the control plane's IDENTITY_READER service binding is a live RPC stub, and a failing reader there is identity_unavailable", async () => {
    const { env } = await import("cloudflare:workers");
    const { issueToken, verifyToken, readerOf } = await import("../src/public-tokens");
    const binding = (env as unknown as { IDENTITY_READER: { emailGen(id: string): Promise<unknown> } }).IDENTITY_READER;
    expect(readerOf(env, {})).toBe(binding);
    // the stand-in Worker answers over RPC and fails closed (the RPC promise is settled inside a plain promise: vitest must not probe its properties)
    const outcome = await new Promise<string>((resolve) => { binding.emailGen(USER).then(() => resolve("resolved"), () => resolve("rejected")); });
    expect(outcome).toBe("rejected");
    const now = Date.now();
    const t = (await issueToken(env, { now: () => now }, { purpose: "confirm", subjectKind: "notice", subjectId: "rpc-1", accountId: USER,
      accountEmail: "pat@example.test", supabaseUpdatedAt: "2026-10-01T00:00:00Z", receivedAt: now }))!;
    const [selector, secret] = t.token.split(".");
    expect(await verifyToken(env, { now: () => now }, selector, secret, "confirm")).toEqual({ ok: false, code: "identity_unavailable" });
  });
});
