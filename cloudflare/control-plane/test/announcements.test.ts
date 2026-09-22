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
import { describe, expect, it } from "vitest";

import { DEFAULT_LIST_ID, type SendlaneFetch } from "../src/announcements";
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
  return { ...env, ...overrides } as unknown as Env;
}

async function subscribe(
  sendlane: SendlaneFetch,
  body: unknown,
  options: { caller?: string; env?: Env } = {},
) {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("cf-connecting-ip", options.caller ?? "203.0.113.7");
  const request = new Request(`${BASE_URL}${PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const response = await createWorker(fetch, sendlane).fetch(request, options.env ?? env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("announcement signup", () => {
  it("puts one address on Murage's own list, and the keys reach Sendlane only", async () => {
    const sendlane = fakeSendlane();
    const response = await subscribe(sendlane.impl, { email: "Someone@Example.COM ", name: "  Someone  " });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: true });

    expect(sendlane.calls).toHaveLength(1);
    const sent = sendlane.calls[0]!;
    expect(sent.url).toContain("https://api.sendlane.com/api/v1/list-subscriber-add");
    // The owner's ruling: "List ID 37 is Murage's list."
    expect(sent.body.get("list_id")).toBe(DEFAULT_LIST_ID);
    expect(sent.body.get("email")).toBe("someone@example.com");
    expect(sent.body.get("first_name")).toBe("Someone");
    expect(sent.body.get("tag_names")).toBe("murage,app-onboarding");
    expect(sent.body.get("api")).toBe(env.SENDLANE_API_KEY);
    expect(sent.body.get("hash")).toBe(env.SENDLANE_HASH_KEY);

    // And nowhere else. A credential that leaks into the answer is a
    // credential that has shipped to every caller of a public endpoint.
    expect(text).not.toContain(env.SENDLANE_API_KEY);
    expect(text).not.toContain(env.SENDLANE_HASH_KEY);
    response.headers.forEach((value) => {
      expect(value).not.toContain(env.SENDLANE_API_KEY);
      expect(value).not.toContain(env.SENDLANE_HASH_KEY);
    });
  });

  it("omits a name it does not have rather than sending an empty one", async () => {
    const sendlane = fakeSendlane();
    // Sendlane leaves omitted fields intact, so a blank name must be absent
    // rather than an empty string that wipes a name the record already has.
    const response = await subscribe(sendlane.impl, { email: "noname@example.com", name: "   " });
    expect(response.status).toBe(200);
    expect(sendlane.calls[0]!.body.has("first_name")).toBe(false);
  });

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

  it("treats an HTML error body as retryable, not as a rejection", async () => {
    // Sendlane answers with an HTML error page instead of JSON when it is
    // unhappy, including under concurrency, and it does it with a 200. Read as
    // a success, that body would report a subscriber who was never added.
    const sendlane = fakeSendlane([HTML, HTML, OK]);
    const response = await subscribe(sendlane.impl, { email: "html@example.com" });
    expect(response.status).toBe(200);
    expect(sendlane.calls).toHaveLength(3);
  });

  it("retries a server error and then reports failure rather than success", async () => {
    const sendlane = fakeSendlane([UNWELL]);
    const response = await subscribe(sendlane.impl, { email: "unwell@example.com" });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "announcements_upstream" });
    expect(sendlane.calls).toHaveLength(3);
  });

  it("does not retry a plain rejection", async () => {
    // A 4xx that is not an HTML error page is Sendlane saying no on purpose.
    // Hammering it three times changes nothing.
    const sendlane = fakeSendlane([REJECTED]);
    const response = await subscribe(sendlane.impl, { email: "rejected@example.com" });
    expect(response.status).toBe(502);
    expect(sendlane.calls).toHaveLength(1);
  });

  it("reports a network failure instead of throwing it at the caller", async () => {
    const sendlane = fakeSendlane([new Error("ECONNREFUSED")]);
    const response = await subscribe(sendlane.impl, { email: "down@example.com" });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "announcements_upstream" });
  });

  it("refuses, visibly, when the Worker holds no Sendlane credentials", async () => {
    // The failure that mattered was the silent one: a build that collected
    // nothing said nothing. An unconfigured Worker must not answer a cheerful
    // 200 that the desktop will record as a subscriber.
    const sendlane = fakeSendlane();
    const unset: Array<Record<string, string>> = [
      { SENDLANE_API_KEY: "" },
      { SENDLANE_HASH_KEY: "" },
      { SENDLANE_API_KEY: "   ", SENDLANE_HASH_KEY: "   " },
    ];
    for (const missing of unset) {
      const response = await subscribe(
        sendlane.impl,
        { email: "unconfigured@example.com" },
        { env: withEnv(missing), caller: "203.0.113.9" },
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "announcements_unconfigured" });
    }
    expect(sendlane.calls).toHaveLength(0);
  });

  it("refuses a list id that is not a list id rather than posting to one", async () => {
    const sendlane = fakeSendlane();
    const response = await subscribe(
      sendlane.impl,
      { email: "badlist@example.com" },
      { env: withEnv({ SENDLANE_LIST_ID: "thirty-seven" }), caller: "203.0.113.10" },
    );
    expect(response.status).toBe(503);
    expect(sendlane.calls).toHaveLength(0);
  });

  it("lets an operator point the signup at a different list", async () => {
    const sendlane = fakeSendlane();
    const response = await subscribe(
      sendlane.impl,
      { email: "otherlist@example.com" },
      { env: withEnv({ SENDLANE_LIST_ID: "412" }), caller: "203.0.113.11" },
    );
    expect(response.status).toBe(200);
    expect(sendlane.calls[0]!.body.get("list_id")).toBe("412");
  });

  it("stops one address being signed up over and over", async () => {
    const sendlane = fakeSendlane();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const allowed = await subscribe(
        sendlane.impl,
        { email: "repeat@example.com" },
        { caller: "203.0.113.12" },
      );
      expect(allowed.status, `attempt ${attempt}`).toBe(200);
    }
    const refused = await subscribe(
      sendlane.impl,
      { email: "repeat@example.com" },
      { caller: "203.0.113.12" },
    );
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toEqual({ error: "rate_limited" });
    // Refused means refused: the fourth attempt never reached Sendlane, and
    // the list never saw it.
    expect(sendlane.calls).toHaveLength(3);
  });

  it("stops one caller working through a list of addresses", async () => {
    // The per-address limit alone stops nothing — a script simply uses a new
    // address every time — so the caller is bounded too.
    const sendlane = fakeSendlane();
    for (let index = 0; index < 10; index += 1) {
      const allowed = await subscribe(
        sendlane.impl,
        { email: `flood-${index}@example.com` },
        { caller: "198.51.100.4" },
      );
      expect(allowed.status, `address ${index}`).toBe(200);
    }
    const refused = await subscribe(
      sendlane.impl,
      { email: "flood-10@example.com" },
      { caller: "198.51.100.4" },
    );
    expect(refused.status).toBe(429);
    expect(sendlane.calls).toHaveLength(10);

    // Somebody else's first run is not collateral damage.
    const elsewhere = await subscribe(
      sendlane.impl,
      { email: "flood-10@example.com" },
      { caller: "198.51.100.5" },
    );
    expect(elsewhere.status).toBe(200);
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
