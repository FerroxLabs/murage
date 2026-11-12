// The onboarding announcement signup, on a real Worker.
//
// This endpoint exists because the two Sendlane keys used to ship inside the
// desktop app, where `asar: true` made them readable by everyone who installed
// it. Moving them here is only worth something if three things hold, so all
// three are asserted below rather than reasoned about:
//
//   1. THE KEYS GO TO SENDLANE AND NOWHERE ELSE. Not into a response body, not
//      into a header, not into an error.
//   2. THE RETRY RULES SURVIVED THE MOVE. Sendlane answers an HTML error page
//      with a 200 under concurrency, so an HTML body is retryable; a 4xx that
//      is not HTML is a deliberate rejection and must not be hammered.
//   3. AN UNCONFIGURED WORKER SAYS SO. The desktop's old version of this
//      wrote one console line at startup that nobody ever read, and collected
//      nothing in silence for ever.
//
// NO REAL CREDENTIAL APPEARS IN THIS FILE OR IN THIS SUITE. The Worker is
// bound to the obviously-fake values in vitest.config.ts and every Sendlane
// call is injected, so nothing here can reach api.sendlane.com.
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_LIST_ID, FORWARDER_HOURLY_CAP, UNSUBSCRIBE_HOURLY_CAP, type SendlaneFetch } from "../src/announcements";
import { createWorker } from "../src/index";

const BASE_URL = "https://auth.murage.test";
const PATH = "/v1/announcements/subscribe";

interface Answer {
  status: number;
  body: string;
}

const OK: Answer = { status: 200, body: '{"status":200}' };
const HTML: Answer = { status: 200, body: "<!DOCTYPE html><html><body>Server Error</body></html>" };
const REJECTED: Answer = { status: 400, body: '{"status":400,"message":"nope"}' };
const UNWELL: Answer = { status: 503, body: "upstream is unwell" };

/** One injected Sendlane that records what it was asked and answers a queue of
 *  canned responses. The last answer repeats, so a retry test does not have to
 *  count the attempts twice. */
function fakeSendlane(answers: Array<Answer | Error> = [OK]) {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  let index = 0;
  const impl: SendlaneFetch = async (url, init) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? "")) });
    const answer = answers[Math.min(index++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return new Response(answer.body, { status: answer.status });
  };
  return { impl, calls };
}

/** `wrangler types` gives a `var` the literal type of its configured value, so
 *  an override of the list id is not assignable to `Env` without a cast. The
 *  Worker reads it as a string; this is the only way a test can hand it a
 *  different one. */
function withEnv(overrides: Record<string, string>): Env {
  return { ...env, MURAGE_ENV: "live", ...overrides } as unknown as Env;
}

async function subscribe(
  sendlane: SendlaneFetch,
  body: unknown,
  options: { caller?: string; env?: Env; headers?: Record<string, string> } = {},
) {
  const headers = new Headers({ "content-type": "application/json", ...options.headers });
  headers.set("cf-connecting-ip", options.caller ?? "203.0.113.7");
  const request = new Request(`${BASE_URL}${PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const response = await createWorker(fetch, sendlane).fetch(request, options.env ?? withEnv({}), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("announcement signup", () => {
  it("refuses an address that is not an address, before anything reaches Sendlane", async () => {
    const sendlane = fakeSendlane();
    for (const bad of ["", "   ", "someone", "someone@", "@example.com", "some one@example.com"]) {
      const response = await subscribe(sendlane.impl, { email: bad }, { caller: "203.0.113.8" });
      expect(response.status, bad).toBe(400);
      await expect(response.json(), bad).resolves.toEqual({ error: "invalid_email" });
    }
    // The client is not trusted to have validated anything.
    expect(sendlane.calls).toHaveLength(0);
  });

  it("is a POST of JSON and nothing else", async () => {
    const sendlane = fakeSendlane();
    const ctx = createExecutionContext();
    const worker = createWorker(fetch, sendlane.impl);
    const getRequest = new Request(`${BASE_URL}${PATH}`);
    const get = await worker.fetch(getRequest, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(get.status).toBe(404);

    const formCtx = createExecutionContext();
    const form = await worker.fetch(
      new Request(`${BASE_URL}${PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "email=form@example.com",
      }),
      env,
      formCtx,
    );
    await waitOnExecutionContext(formCtx);
    expect(form.status).toBe(415);
    expect(sendlane.calls).toHaveLength(0);
  });

  it("refuses a body carrying fields it did not ask for", async () => {
    const sendlane = fakeSendlane();
    const response = await subscribe(
      sendlane.impl,
      { email: "extra@example.com", list_id: "9", api: "not-a-key" },
      { caller: "203.0.113.13" },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(sendlane.calls).toHaveLength(0);
  });
});


describe("site forwarder (X-Murage-Site-Token)", () => {
  // Test-only value, bound only in this file.
  const TOKEN = "test-only-site-forwarder-token-not-a-real-one"; // secret-scan: fixture
  const WITH_TOKEN = { "X-Murage-Site-Token": TOKEN };
  const forwarderEnv = (overrides: Record<string, string> = {}) => withEnv({ SITE_FORWARDER_TOKEN: TOKEN, ...overrides });
  const hmac = async (scope: string, value: string) => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.BETTER_AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${scope}:${value}`))), (b) => b.toString(16).padStart(2, "0")).join("");
  };
  const consents = async () => (await env.DB.prepare(
    "SELECT email_key, source, consent_text, list_id, created_at FROM announcement_consents ORDER BY id",
  ).all<{ email_key: string; source: string; consent_text: string | null; list_id: string | null; created_at: number }>()).results;

  it("a valid token skips the edge limiter (MACHINE_OPEN_LIMIT); no token and a wrong token do not", async () => {
    const sendlane = fakeSendlane();
    const limiter = { calls: 0, async limit() { limiter.calls += 1; return { success: false }; } };
    const limited = (overrides: Record<string, string> = {}) => ({ ...forwarderEnv(overrides), MACHINE_OPEN_LIMIT: limiter }) as unknown as Env;
    const ok = await subscribe(sendlane.impl, { email: "edge@example.com", source: "footer", requestId: "edge-request-0000000001" }, { env: limited(), headers: WITH_TOKEN });
    expect(ok.status).toBe(200);
    expect(limiter.calls).toBe(0);
    const anonymous = await subscribe(sendlane.impl, { email: "edge2@example.com" }, { env: limited() });
    expect(anonymous.status).toBe(429);
    const wrong = await subscribe(sendlane.impl, { email: "edge3@example.com" }, { env: limited(), headers: { "X-Murage-Site-Token": "nope" } });
    expect(wrong.status).toBe(429);
    // Updates consent B1: the forwarder is D1 only, no Sendlane call.
    expect(sendlane.calls).toHaveLength(0);
  });

  it("a wrong token is 401, logged with names only, and nothing is sent or recorded", async () => {
    const sendlane = fakeSendlane();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await subscribe(sendlane.impl, { email: "wrong@example.com", name: "Wrong Name", source: "site" },
      { env: forwarderEnv(), headers: { "X-Murage-Site-Token": `${TOKEN}x` } });
    const lines = error.mock.calls.map((c) => String(c[0]));
    error.mockRestore();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(sendlane.calls).toHaveLength(0);
    expect(await consents()).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM announcement_rate_limits").first<{ n: number }>())?.n).toBe(0);
    expect(lines.some((l) => l.includes("forwarder_unauthorized"))).toBe(true);
    for (const l of lines) {
      expect(l).not.toContain(TOKEN);
      expect(l).not.toContain("wrong@example.com");
      expect(l).not.toContain("Wrong Name");
    }
  });

  it("with the secret missing or blank the token is ignored: today's strict path, no forwarder", async () => {
    for (const secret of ["", "   "]) {
      const sendlane = fakeSendlane();
      const off = withEnv({ SITE_FORWARDER_TOKEN: secret });
      // An empty secret never matches an empty or any other header.
      for (const header of [TOKEN, "", secret]) {
        const extra = await subscribe(sendlane.impl, { email: "off@example.com", source: "site" },
          { env: off, caller: "203.0.113.60", headers: { "X-Murage-Site-Token": header } });
        expect(extra.status, `secret "${secret}" header "${header}"`).toBe(400);
        await expect(extra.json()).resolves.toEqual({ error: "invalid_request" });
      }
      const plain = await subscribe(sendlane.impl, { email: `plain${secret.length}@example.com` },
        { env: off, caller: "203.0.113.61", headers: WITH_TOKEN });
      expect(plain.status).toBe(200);
      // Updates consent B1: the 1.0.19 path is D1 only, no Sendlane call.
      expect(sendlane.calls).toHaveLength(0);
    }
    expect(await consents()).toHaveLength(0);
  });

});

describe("POST /v1/announcements/unsubscribe (site forwarder only)", () => {
  const TOKEN = "test-only-site-forwarder-token-not-a-real-one"; // secret-scan: fixture
  const WITH_TOKEN = { "X-Murage-Site-Token": TOKEN };
  const UNSUB = "/v1/announcements/unsubscribe";
  const unsubEnv = (overrides: Record<string, string> = {}) => withEnv({ SITE_FORWARDER_TOKEN: TOKEN, SENDLANE_WAITLIST_LIST_ID: "39", ...overrides });
  const SUCCESS: Answer = { status: 200, body: '{"success":"Unsubscribed Successfully."}' };
  const hmac = async (scope: string, value: string) => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.BETTER_AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${scope}:${value}`))), (b) => b.toString(16).padStart(2, "0")).join("");
  };

  async function unsubscribe(sendlane: SendlaneFetch, body: unknown, options: { env?: Env; headers?: Record<string, string>; caller?: string } = {}) {
    const headers = new Headers({ "content-type": "application/json", ...(options.headers ?? WITH_TOKEN) });
    headers.set("cf-connecting-ip", options.caller ?? "198.51.100.90");
    const request = new Request(`${BASE_URL}${UNSUB}`, { method: "POST", headers, body: JSON.stringify(body) });
    const ctx = createExecutionContext();
    const response = await createWorker(fetch, sendlane).fetch(request, options.env ?? unsubEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  it("answers the unknown-route 404 without the token, with a wrong token, and with the secret unset", async () => {
    const sendlane = fakeSendlane();
    const unknown = await subscribeUnknownRoute();
    for (const attempt of [
      await unsubscribe(sendlane.impl, { email: "a@example.com" }, { headers: {} }),
      await unsubscribe(sendlane.impl, { email: "a@example.com" }, { headers: { "X-Murage-Site-Token": "nope" } }),
      await unsubscribe(sendlane.impl, { email: "a@example.com" }, { env: withEnv({}), headers: WITH_TOKEN }),
    ]) {
      expect(attempt.status).toBe(404);
      expect(await attempt.text()).toBe(unknown);
    }
    expect(sendlane.calls).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM announcement_optouts").first<{ n: number }>())?.n).toBe(0);
  });

  async function subscribeUnknownRoute() {
    const ctx = createExecutionContext();
    const response = await createWorker(fetch, fakeSendlane().impl).fetch(
      new Request(`${BASE_URL}/v1/announcements/nothing-here`, { method: "POST", body: "{}" }), withEnv({}), ctx);
    await waitOnExecutionContext(ctx);
    return response.text();
  }

  it("strict body: unknown fields and bad addresses are 400", async () => {
    const sendlane = fakeSendlane();
    expect((await unsubscribe(sendlane.impl, { email: "x@example.com", extra: 1 })).status).toBe(400);
    expect((await unsubscribe(sendlane.impl, { email: "not-an-address" })).status).toBe(400);
    expect(sendlane.calls).toHaveLength(0);
  });

  it("the per-address limit applies; the per-IP edge limiter is skipped for the forwarder", async () => {
    const sendlane = fakeSendlane([SUCCESS]);
    const limiter = { calls: 0, async limit() { limiter.calls += 1; return { success: false }; } };
    const limited = { ...unsubEnv(), MACHINE_OPEN_LIMIT: limiter } as unknown as Env;
    for (let index = 0; index < 3; index += 1) expect((await unsubscribe(sendlane.impl, { email: "lim@example.com" }, { env: limited })).status).toBe(200);
    expect((await unsubscribe(sendlane.impl, { email: "lim@example.com" }, { env: limited })).status).toBe(429);
    expect(limiter.calls).toBe(0);
  });

  const waitFor = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); expect(condition()).toBe(true); };
  const nonceRow = async (key: string) => env.DB.prepare("SELECT comp_pending, comp_nonce FROM announcement_optouts WHERE email_key = ? AND list_id = ?").bind(key, DEFAULT_LIST_ID).first<{ comp_pending: number; comp_nonce: string | null }>();

});
