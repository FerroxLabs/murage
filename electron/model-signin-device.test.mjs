// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Plan sign-in with a code (ChatGPT and Grok device flows) and refresh
// hardening: 429 back-off, single flight, save-before-publish, a failed save
// keeping the pair, and a refused grant ending in the sign-in-again state.
// Fakes only: no network, no browser, no real account.
import { describe, expect, it } from "vitest";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import { trackedCredentialUpdate } from "./secure-credentials.mjs";
import { createModelSignIn, readSignInRecords } from "./model-signin.mjs";

const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const ID_TOKEN = `${b64({ alg: "none" })}.${b64({ exp: 2_000_000_000, email: "owner@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "plus" } })}.sig`;
const CODEX_UA = "codex_cli_rs/0.0.0 (Murage)";

/** routes: url substring -> array of replies (consumed in order; the last one repeats). */
function harness({ routes = {}, failSaves = false, onFetch, beforePersist, duringPersist, fire = ms => ms < 30_000 } = {}) {
  let document = {};
  let saveFails = failSaves;
  const state = createSecureCredentialState(document, async next => { if (saveFails) throw new Error("keychain busy"); await duringPersist?.(next); document = structuredClone(next); });
  const calls = [], published = [], delays = [], events = [], timerFns = [];
  let clock = 1_700_000_000_000, ids = 0;
  const fetch = async (url, init = {}) => {
    const body = init.body ? String(init.body) : "";
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url: String(url), headers, body });
    onFetch?.(String(url));
    events.push(`fetch:${String(url).split("/").slice(-1)[0]}`);
    const key = Object.keys(routes).find(k => String(url).includes(k));
    const queue = key ? routes[key] : undefined;
    if (!queue?.length) return Response.json({ error: "no fixture" }, { status: 500 });
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply === "offline") throw new TypeError("fetch failed");
    return Response.json(reply.body ?? reply, { status: reply.status ?? 200, headers: reply.headers ?? {} });
  };
  const signIn = createModelSignIn({
    readDocument: () => state.read(),
    updateDocument: (derive, afterPersist) => state.update(async current => { await beforePersist?.(); const next = await derive(current); events.push("persist"); return next; }, afterPersist),
    publish: entries => { events.push("publish"); published.push(structuredClone(entries)); },
    openExternal: async () => { throw new Error("a code sign-in never opens a browser"); },
    createServer: () => { throw new Error("a code sign-in never listens"); },
    fetch, env: { DISPLAY: "" }, platform: "linux", now: () => clock, randomId: () => `rev-${++ids}`,
    // Timers fire at once and move the clock, so polling needs no real waiting.
    // Only the short device-poll sleeps fire; refresh timers (30 s and up) are recorded and left.
    setTimeout: (fn, ms) => { delays.push(ms); timerFns.push({ ms, fn }); if (fire(ms)) { clock += ms; queueMicrotask(fn); } return { unref() {} }; },
    clearTimeout: () => {},
  });
  return { routes, timerFns, signIn, calls, published, delays, events, document: () => document, setFailSaves: value => { saveFails = value; }, tick: ms => { clock += ms; }, clock: () => clock };
}

const CHATGPT_TOKENS = { access_token: "at-1", refresh_token: "rt-1", id_token: ID_TOKEN, expires_in: 3600 };
const chatgptRoutes = (extra = {}) => ({
  "deviceauth/usercode": [{ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "5" }],
  "deviceauth/token": [{ status: 403, body: {} }, { status: 404, body: {} }, { authorization_code: "auth-code", code_verifier: "verifier-1" }],
  "oauth/token": [CHATGPT_TOKENS],
  ...extra,
});

async function signedInChatGpt(extra = {}) {
  const h = harness({ routes: chatgptRoutes() });
  expect(await h.signIn.startDevice("chatgpt")).toMatchObject({ ok: true, email: "owner@example.com", plan: "plus" });
  Object.assign(h.routes, extra); // what the vendor answers from here on
  h.calls.length = 0; h.events.length = 0; h.delays.length = 0;
  return h;
}

describe("sign in with a code: ChatGPT", () => {
  it("requests a code, polls through not-yet answers, exchanges at the device callback and saves", async () => {
    const h = harness({ routes: chatgptRoutes() });
    const result = await h.signIn.startDevice("chatgpt");
    expect(result).toMatchObject({ ok: true, email: "owner@example.com", plan: "plus" });
    const [usercode, ...polls] = h.calls;
    expect(JSON.parse(usercode.body)).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
    expect(usercode.headers).toMatchObject({ originator: "codex_cli_rs", "user-agent": CODEX_UA });
    expect(polls.map(call => call.url.split("/").slice(-1)[0])).toEqual(["token", "token", "token", "token"]);
    expect(JSON.parse(polls[0].body)).toEqual({ device_auth_id: "dev-1", user_code: "ABCD-1234" });
    const exchange = h.calls.at(-1);
    const form = new URLSearchParams(exchange.body);
    expect(exchange.url).toBe("https://auth.openai.com/oauth/token");
    expect(exchange.headers).toMatchObject({ originator: "codex_cli_rs", "user-agent": CODEX_UA });
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("auth-code");
    expect(form.get("code_verifier")).toBe("verifier-1");
    expect(form.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
    const saved = readSignInRecords(h.document()).chatgpt;
    expect(saved).toMatchObject({ state: "connected", accessToken: "at-1", refreshToken: "rt-1", accountId: "acct-1" });
    expect(h.published.at(-1)[0]).toMatchObject({ provider: "chatgpt", accessToken: "at-1", accountId: "acct-1" });
    expect(h.published.at(-1)[0]).not.toHaveProperty("refreshToken");
  });

  it("shows the code and page while it waits, and clears them after", async () => {
    let waiting;
    const h = harness({ routes: chatgptRoutes(), onFetch: url => { if (url.endsWith("deviceauth/token") && !waiting) waiting = h.signIn.status().find(row => row.provider === "chatgpt"); } });
    expect((await h.signIn.startDevice("chatgpt")).ok).toBe(true);
    expect(waiting).toMatchObject({ state: "waiting", acceptsCode: false, device: { userCode: "ABCD-1234", verificationUrl: "https://auth.openai.com/codex/device" } });
    const done = h.signIn.status().find(row => row.provider === "chatgpt");
    expect(done).toMatchObject({ state: "connected" });
    expect(done).not.toHaveProperty("device");
  });

  it("can be cancelled while it waits", async () => {
    let run;
    const h = harness({ routes: chatgptRoutes({ "deviceauth/token": [{ status: 403, body: {} }] }), onFetch: url => { if (url.endsWith("deviceauth/token")) h.signIn.cancel("chatgpt"); } });
    run = h.signIn.startDevice("chatgpt");
    expect(await run).toEqual({ ok: false, error: "cancelled" });
    expect(readSignInRecords(h.document()).chatgpt).toBeUndefined();
  });

  it("a device code that was denied or whose request is refused ends without saving", async () => {
    const denied = harness({ routes: chatgptRoutes({ "deviceauth/token": [{ status: 400, body: { error: "access_denied" } }] }) });
    expect(await denied.signIn.startDevice("chatgpt")).toEqual({ ok: false, error: "unauthorized" });
    expect(readSignInRecords(denied.document()).chatgpt).toBeUndefined();
    const notEnabled = harness({ routes: chatgptRoutes({ "deviceauth/usercode": [{ status: 404, body: {} }] }) });
    expect(await notEnabled.signIn.startDevice("chatgpt")).toEqual({ ok: false, error: "unknown" });
    const offline = harness({ routes: chatgptRoutes({ "deviceauth/usercode": ["offline"] }) });
    expect(await offline.signIn.startDevice("chatgpt")).toEqual({ ok: false, error: "offline" });
  });

  it("gives up after the code's fifteen minutes", async () => {
    const h = harness({ routes: chatgptRoutes({ "deviceauth/token": [{ status: 403, body: {} }] }) });
    expect(await h.signIn.startDevice("chatgpt")).toEqual({ ok: false, error: "timeout" });
  });

  it("works on a headless Linux host, where the browser sign-in is refused", async () => {
    const h = harness({ routes: chatgptRoutes() });
    expect(await h.signIn.start("chatgpt")).toEqual({ ok: false, error: "headless" });
    expect((await h.signIn.startDevice("chatgpt")).ok).toBe(true);
  });
});

describe("sign in with a code: Grok", () => {
  const xaiRoutes = (extra = {}) => ({
    "openid-configuration": [{ authorization_endpoint: "https://accounts.x.ai/oauth2/authorize", token_endpoint: "https://auth.x.ai/oauth2/token", device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code" }],
    "oauth2/device/code": [{ device_code: "dc-1", user_code: "WXYZ-9999", verification_uri: "https://accounts.x.ai/device", verification_uri_complete: "https://accounts.x.ai/device?user_code=WXYZ-9999", expires_in: 600, interval: 5 }],
    "oauth2/token": [{ status: 400, body: { error: "authorization_pending" } }, { status: 400, body: { error: "slow_down" } }, { access_token: "xat-1", refresh_token: "xrt-1", expires_in: 21600 }],
    ...extra,
  });

  it("follows RFC 8628: pending, slow down, then tokens", async () => {
    const h = harness({ routes: xaiRoutes() });
    expect(await h.signIn.startDevice("supergrok")).toMatchObject({ ok: true });
    const device = h.calls.find(call => call.url.includes("device/code"));
    expect(new URLSearchParams(device.body).get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(device.headers).not.toHaveProperty("originator");
    const polls = h.calls.filter(call => call.url.endsWith("oauth2/token"));
    expect(polls).toHaveLength(3);
    expect(new URLSearchParams(polls[0].body).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(new URLSearchParams(polls[0].body).get("device_code")).toBe("dc-1");
    expect(readSignInRecords(h.document()).supergrok).toMatchObject({ state: "connected", accessToken: "xat-1", refreshToken: "xrt-1" });
    expect(h.delays.filter(ms => ms >= 5000).at(-1)).toBeGreaterThan(5000);
  });

  it("refuses a verification page off x.ai, a token with no refresh token, and a denial", async () => {
    const offsite = harness({ routes: xaiRoutes({ "oauth2/device/code": [{ device_code: "dc", user_code: "AAAA-1111", verification_uri: "https://evil.example/device", expires_in: 600, interval: 5 }] }) });
    expect(await offsite.signIn.startDevice("supergrok")).toEqual({ ok: false, error: "unknown" });
    const noRefresh = harness({ routes: xaiRoutes({ "oauth2/token": [{ access_token: "xat-1", expires_in: 100 }] }) });
    expect(await noRefresh.signIn.startDevice("supergrok")).toEqual({ ok: false, error: "unknown" });
    const denied = harness({ routes: xaiRoutes({ "oauth2/token": [{ status: 400, body: { error: "access_denied" } }] }) });
    expect(await denied.signIn.startDevice("supergrok")).toEqual({ ok: false, error: "unauthorized" });
    const expired = harness({ routes: xaiRoutes({ "oauth2/token": [{ status: 400, body: { error: "expired_token" } }] }) });
    expect(await expired.signIn.startDevice("supergrok")).toEqual({ ok: false, error: "timeout" });
  });
});

describe("refresh hardening", () => {
  it("a 429 backs off, keeps the old token, and never signs out", async () => {
    const h = await signedInChatGpt({ "oauth/token": [{ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "240" } }] });
    expect(await h.signIn.refresh("chatgpt")).toBe(false);
    const kept = readSignInRecords(h.document()).chatgpt;
    expect(kept).toMatchObject({ state: "connected", accessToken: "at-1", refreshToken: "rt-1" });
    expect(h.delays.at(-1)).toBe(240_000);
    expect(h.published).toHaveLength(1);
    // The next failure waits longer, up to the cap.
    h.calls.length = 0;
    await h.signIn.refresh("chatgpt");
    expect(h.delays.at(-1)).toBeGreaterThanOrEqual(120_000);
    expect(readSignInRecords(h.document()).chatgpt.state).toBe("connected");
  });

  it("while backed off, the gateway's reactive refreshes do not hit the vendor again", async () => {
    const h = await signedInChatGpt({ "oauth/token": [{ status: 429, body: {} }] });
    await h.signIn.refresh("chatgpt");
    h.calls.length = 0;
    expect(await h.signIn.refresh("chatgpt", { reactive: true })).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it("two callers share one refresh request", async () => {
    const h = await signedInChatGpt({ "oauth/token": [{ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }] });
    const [a, b] = await Promise.all([h.signIn.refresh("chatgpt"), h.signIn.refresh("chatgpt")]);
    expect([a, b]).toEqual([true, true]);
    expect(h.calls.filter(call => call.url.endsWith("oauth/token"))).toHaveLength(1);
    expect(h.calls[0].headers).toMatchObject({ originator: "codex_cli_rs", "user-agent": CODEX_UA });
  });

  it("saves the rotated refresh token before publishing the new access token", async () => {
    const h = await signedInChatGpt({ "oauth/token": [{ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }] });
    await h.signIn.refresh("chatgpt");
    expect(h.events.filter(event => event === "persist" || event === "publish")).toEqual(["persist", "publish"]);
    expect(readSignInRecords(h.document()).chatgpt.refreshToken).toBe("rt-2");
  });

  it("a failed save keeps the rotated pair private, never publishes it, and never reuses the spent token", async () => {
    const h = await signedInChatGpt({ "oauth/token": [{ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }, { access_token: "at-3", refresh_token: "rt-3", expires_in: 3600 }] });
    h.setFailSaves(true);
    expect(await h.signIn.refresh("chatgpt")).toBe(false);
    expect(readSignInRecords(h.document()).chatgpt.refreshToken, "the disk still has the old pair, intact").toBe("rt-1");
    expect(h.published, "nothing rotated is published before it is committed").toHaveLength(1);
    expect(h.published.at(-1)[0].accessToken).toBe("at-1");
    h.setFailSaves(false);
    expect(await h.signIn.refresh("chatgpt")).toBe(true);
    const refreshes = h.calls.filter(call => call.url.endsWith("oauth/token"));
    expect(new URLSearchParams(refreshes[1].body).get("refresh_token")).toBe("rt-2");
    expect(readSignInRecords(h.document()).chatgpt.refreshToken).toBe("rt-3");
    expect(h.published.at(-1)[0].accessToken).toBe("at-3");
  });

  it("the save is retried, and the replacement is published only after the retry commits", async () => {
    const h = await signedInChatGpt({ "oauth/token": [{ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }] });
    h.setFailSaves(true);
    await h.signIn.refresh("chatgpt");
    const retry = h.timerFns.filter(t => t.ms === 60_000).at(-1);
    expect(retry, "a persistence retry is scheduled").toBeTruthy();
    await retry.fn(); // still failing: stays private and schedules again
    expect(h.published).toHaveLength(1);
    const again = h.timerFns.filter(t => t.ms === 60_000).at(-1);
    expect(again).not.toBe(retry);
    h.setFailSaves(false);
    await again.fn();
    expect(readSignInRecords(h.document()).chatgpt).toMatchObject({ accessToken: "at-2", refreshToken: "rt-2" });
    expect(h.published).toHaveLength(2);
    expect(h.published.at(-1)[0].accessToken).toBe("at-2");
  });

  it("a refused grant ends the sign-in and asks for a new one, keeping who it was", async () => {
    for (const reply of [{ status: 400, body: { error: "invalid_grant" } }, { status: 401, body: {} }]) {
      const h = await signedInChatGpt({ "oauth/token": [reply] });
      expect(await h.signIn.refresh("chatgpt")).toBe(false);
      const ended = readSignInRecords(h.document()).chatgpt;
      expect(ended).toMatchObject({ state: "needs-sign-in", email: "owner@example.com" });
      expect(ended.accessToken).toBeUndefined();
      expect(ended.refreshToken).toBeUndefined();
      expect(h.published.at(-1)[0]).toMatchObject({ state: "needs-sign-in" });
      expect(h.published.at(-1)[0]).not.toHaveProperty("accessToken");
      expect(h.signIn.status().find(row => row.provider === "chatgpt")?.state).toBe("needs-sign-in");
    }
  });
});

describe("retry-after and back-off deadlines", () => {
  it("a Retry-After longer than our own cap is honored in full", async () => {
    const h = await signedInChatGpt({ "oauth/token": [{ status: 429, body: {}, headers: { "retry-after": "1800" } }] });
    await h.signIn.refresh("chatgpt");
    expect(h.delays.at(-1)).toBe(1_800_000);
    const long = await signedInChatGpt({ "oauth/token": [{ status: 429, body: {}, headers: { "retry-after": "7200" } }] });
    await long.signIn.refresh("chatgpt");
    expect(long.delays.at(-1)).toBe(7_200_000);
  });

  it("our own doubling still stops at fifteen minutes", async () => {
    const h = await signedInChatGpt({ "oauth/token": [{ status: 500, body: {} }] });
    for (let i = 0; i < 8; i++) { h.tick(16 * 60_000); await h.signIn.refresh("chatgpt"); }
    expect(h.delays.at(-1)).toBe(15 * 60_000);
  });

  it("a server restart (resume) during back-off sends nothing early and keeps the deadline", async () => {
    const h = await signedInChatGpt({ "oauth/token": [{ status: 429, body: {}, headers: { "retry-after": "600" } }] });
    h.tick(2 * 60 * 60_000); // the access token is now long expired
    await h.signIn.refresh("chatgpt");
    const backedOffFor = h.delays.at(-1);
    h.calls.length = 0;
    h.tick(60_000);
    h.signIn.resume();
    await Promise.resolve();
    expect(h.calls.filter(call => call.url.endsWith("oauth/token"))).toHaveLength(0);
    expect(h.delays.at(-1)).toBeGreaterThanOrEqual(backedOffFor - 60_000);
    expect(await h.signIn.refresh("chatgpt")).toBe(false);
    expect(h.calls).toHaveLength(0);
  });
});

describe("device polling discipline", () => {
  const grokRoutes = (tokenQueue, extra = {}) => ({
    "openid-configuration": [{ authorization_endpoint: "https://accounts.x.ai/oauth2/authorize", token_endpoint: "https://auth.x.ai/oauth2/token", device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code" }],
    "oauth2/device/code": [{ device_code: "dc-1", user_code: "WXYZ-9999", verification_uri: "https://accounts.x.ai/device", expires_in: 600, interval: 60, ...extra }],
    "oauth2/token": tokenQueue,
  });
  const pending = { status: 400, body: { error: "authorization_pending" } };
  const slow = { status: 400, body: { error: "slow_down" } };

  it("never shortens a long vendor interval and keeps cumulative slow_down increases", async () => {
    const h = harness({ routes: grokRoutes([pending, pending, slow, slow, { access_token: "xat-1", refresh_token: "xrt-1", expires_in: 21600 }]), fire: ms => ms <= 900_000 });
    expect(await h.signIn.startDevice("supergrok")).toMatchObject({ ok: true });
    expect(h.delays.filter(ms => ms <= 900_000)).toEqual([60_000, 60_000, 60_000, 65_000, 70_000]);
  });

  it("a 429 on the poll doubles the interval with no ceiling", async () => {
    const h = harness({ routes: grokRoutes([{ status: 429, body: {} }, { access_token: "xat-1", refresh_token: "xrt-1", expires_in: 21600 }]), fire: ms => ms <= 900_000 });
    await h.signIn.startDevice("supergrok");
    expect(h.delays.filter(ms => ms <= 900_000).slice(0, 2)).toEqual([60_000, 120_000]);
  });

  it("stops at the code's lifetime: no poll after it, and a late answer is not accepted", async () => {
    const h = harness({ routes: grokRoutes([pending, pending, { access_token: "xat-1", refresh_token: "xrt-1", expires_in: 21600 }], { expires_in: 12, interval: 5 }) });
    expect(await h.signIn.startDevice("supergrok")).toEqual({ ok: false, error: "timeout" });
    expect(h.calls.filter(call => call.url.endsWith("oauth2/token"))).toHaveLength(2);
    expect(h.delays.at(-1), "the last sleep is bounded by what is left").toBe(2000);
    expect(readSignInRecords(h.document()).supergrok).toBeUndefined();
    let late;
    late = harness({ routes: grokRoutes([{ access_token: "xat-1", refresh_token: "xrt-1", expires_in: 21600 }], { expires_in: 12, interval: 5 }), onFetch: url => { if (url.endsWith("oauth2/token")) late.tick(20_000); } });
    expect(await late.signIn.startDevice("supergrok")).toEqual({ ok: false, error: "timeout" });
    expect(readSignInRecords(late.document()).supergrok).toBeUndefined();
  });

  it("only exact xAI verification origins are shown", async () => {
    for (const uri of ["https://other.x.ai/device", "https://x.ai/device", "https://accounts.x.ai.evil.example/d", "https://accounts.x.ai:8443/d", "https://u:p@accounts.x.ai/d", "http://accounts.x.ai/d"]) {
      const h = harness({ routes: grokRoutes([pending], { verification_uri: uri }) });
      expect(await h.signIn.startDevice("supergrok"), uri).toEqual({ ok: false, error: "unknown" });
    }
  });
});

describe("sign-in generations", () => {
  it("a sign-in superseded while its credentials are being written does not overwrite the newer one", async () => {
    let started = false, second;
    const h = harness({ routes: chatgptRoutes({ "oauth/token": [CHATGPT_TOKENS, { ...CHATGPT_TOKENS, access_token: "at-B", refresh_token: "rt-B" }] }),
      beforePersist: async () => { if (!started) { started = true; second = h.signIn.startDevice("chatgpt"); } } });
    expect(await h.signIn.startDevice("chatgpt")).toEqual({ ok: false, error: "cancelled" });
    expect(await second).toMatchObject({ ok: true });
    expect(readSignInRecords(h.document()).chatgpt).toMatchObject({ accessToken: "at-B", refreshToken: "rt-B" });
  });

  it("a cancel that lands while credentials are being written wins", async () => {
    let done = false;
    const h = harness({ routes: chatgptRoutes(), beforePersist: async () => { if (!done) { done = true; h.signIn.cancel("chatgpt"); } } });
    expect(await h.signIn.startDevice("chatgpt")).toEqual({ ok: false, error: "cancelled" });
    expect(readSignInRecords(h.document()).chatgpt).toBeUndefined();
    expect(h.published).toHaveLength(0);
  });

  it("signing out during a sign-in leaves the account signed out", async () => {
    let done = false;
    const h = harness({ routes: chatgptRoutes(), beforePersist: async () => { if (!done) { done = true; void h.signIn.signOut("chatgpt"); } } });
    expect(await h.signIn.startDevice("chatgpt")).toEqual({ ok: false, error: "cancelled" });
    expect(readSignInRecords(h.document()).chatgpt).toBeUndefined();
  });
});

describe("recheck 3: commit fencing, spent-token retries and backoff", () => {
  const tokensOf = (access, refresh) => ({ access_token: access, refresh_token: refresh, expires_in: 3600 });

  it("a cancel that lands during the encrypted write rolls the write back: the cancelled account is not connected or published", async () => {
    let armed = true;
    const h = harness({ routes: chatgptRoutes(), duringPersist: async () => { if (armed) { armed = false; h.signIn.cancel("chatgpt"); } } });
    expect(await h.signIn.startDevice("chatgpt")).toEqual({ ok: false, error: "cancelled" });
    expect(readSignInRecords(h.document()).chatgpt, "the file is restored").toBeUndefined();
    expect(h.published).toHaveLength(0);
    expect(h.signIn.status().find(row => row.provider === "chatgpt")?.state).toBe("signed-out");
  });

  it("a newer sign-in that begins during the encrypted write of an older one wins", async () => {
    let armed = true, second;
    const h = harness({ routes: chatgptRoutes({ "oauth/token": [CHATGPT_TOKENS, { ...CHATGPT_TOKENS, access_token: "at-B", refresh_token: "rt-B" }] }),
      duringPersist: async () => { if (armed) { armed = false; second = h.signIn.startDevice("chatgpt"); } } });
    expect(await h.signIn.startDevice("chatgpt")).toEqual({ ok: false, error: "cancelled" });
    expect(await second).toMatchObject({ ok: true });
    expect(readSignInRecords(h.document()).chatgpt).toMatchObject({ accessToken: "at-B", refreshToken: "rt-B" });
    expect(h.published.every(entries => entries[0].accessToken !== "at-1")).toBe(true);
  });

  it("a sign-out during the encrypted write leaves the account signed out", async () => {
    let armed = true;
    const h = harness({ routes: chatgptRoutes(), duringPersist: async () => { if (armed) { armed = false; void h.signIn.signOut("chatgpt"); } } });
    expect(await h.signIn.startDevice("chatgpt")).toEqual({ ok: false, error: "cancelled" });
    await Promise.resolve();
    expect(readSignInRecords(h.document()).chatgpt).toBeUndefined();
    expect(h.published.every(entries => entries.length === 0 || entries[0].accessToken === undefined)).toBe(true);
  });

  it("a queued persistence retry never writes back a pair that was rotated again, and never publishes it", async () => {
    let gate = null;
    const h = harness({ routes: chatgptRoutes(), duringPersist: async () => { if (gate) { gate.entered(); await gate.promise; } } });
    await h.signIn.startDevice("chatgpt");
    Object.assign(h.routes, { "oauth/token": [tokensOf("at-2", "rt-2"), tokensOf("at-3", "rt-3")] });
    h.setFailSaves(true);
    await h.signIn.refresh("chatgpt"); // pair 2 is held privately; the save will be retried
    const retry = h.timerFns.filter(t => t.ms === 60_000).at(-1);
    expect(retry).toBeTruthy();
    h.setFailSaves(false);
    let entered; const inside = new Promise(resolve => { entered = resolve; });
    let release; gate = { entered, promise: new Promise(resolve => { release = resolve; }) };
    const rotating = h.signIn.refresh("chatgpt"); // spends pair 2, begins persisting pair 3
    await inside;
    const queuedRetry = retry.fn(); // captures pair 2 and queues behind pair 3's write
    await Promise.resolve();
    gate = null; release();
    expect(await rotating).toBe(true);
    await queuedRetry;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(readSignInRecords(h.document()).chatgpt.refreshToken, "the usable pair is still the stored one").toBe("rt-3");
    expect(h.published.map(entries => entries[0].accessToken)).not.toContain("at-2");
    expect(h.published.at(-1)[0].accessToken).toBe("at-3");
  });

  it("persistence recovery keeps an unrelated vendor backoff deadline", async () => {
    const h = await signedInChatGpt({ "oauth/token": [tokensOf("at-2", "rt-2"), { status: 429, body: {}, headers: { "retry-after": "600" } }] });
    h.setFailSaves(true);
    await h.signIn.refresh("chatgpt"); // pair 2 unsaved
    const retry = h.timerFns.filter(t => t.ms === 60_000).at(-1);
    h.tick(1000);
    await h.signIn.refresh("chatgpt"); // refreshing with pair 2 is refused: 10 minutes
    h.setFailSaves(false);
    h.tick(60_000);
    await retry.fn(); // the save recovers a minute later
    expect(readSignInRecords(h.document()).chatgpt.refreshToken).toBe("rt-2");
    h.calls.length = 0;
    h.tick(60_000);
    expect(await h.signIn.refresh("chatgpt")).toBe(false);
    expect(await h.signIn.refresh("chatgpt", { reactive: true })).toBe(false);
    expect(h.calls, "no early contact with the vendor").toHaveLength(0);
    h.tick(10 * 60_000);
    expect(await h.signIn.refresh("chatgpt")).toBe(false); // the vendor answers 429 again, not silence
    expect(h.calls).toHaveLength(1);
  });

  it("a Retry-After of days is held as a deadline, even past one timer", async () => {
    const h = await signedInChatGpt({ "oauth/token": [{ status: 429, body: {}, headers: { "retry-after": "172800" } }] });
    await h.signIn.refresh("chatgpt");
    expect(h.delays.at(-1)).toBe(172_800_000);
    h.calls.length = 0;
    h.tick(24 * 60 * 60_000);
    expect(await h.signIn.refresh("chatgpt")).toBe(false);
    expect(h.calls).toHaveLength(0);
    const long = await signedInChatGpt({ "oauth/token": [{ status: 429, body: {}, headers: { "retry-after": "3000000" } }] });
    await long.signIn.refresh("chatgpt");
    expect(long.delays.at(-1), "the timer is chunked").toBe(2 ** 31 - 1);
    long.calls.length = 0;
    long.tick(2 ** 31);
    expect(await long.signIn.refresh("chatgpt")).toBe(false);
    expect(long.calls, "the deadline still stands after the first chunk").toHaveLength(0);
  });

  it("device polling honors Retry-After, and stops at the code's lifetime", async () => {
    const h = harness({ fire: ms => ms <= 900_000, routes: chatgptRoutes({ "deviceauth/token": [{ status: 429, body: {}, headers: { "retry-after": "600" } }, { authorization_code: "auth-code", code_verifier: "verifier-1" }] }) });
    expect(await h.signIn.startDevice("chatgpt")).toMatchObject({ ok: true });
    expect(h.delays.filter(ms => ms <= 900_000)).toEqual([5000, 600_000]);
    const late = harness({ fire: ms => ms <= 900_000, routes: chatgptRoutes({ "deviceauth/token": [{ status: 429, body: {}, headers: { "retry-after": "7200" } }] }) });
    expect(await late.signIn.startDevice("chatgpt")).toEqual({ ok: false, error: "timeout" });
    expect(late.calls.filter(call => call.url.includes("deviceauth/token"))).toHaveLength(1);
    expect(Math.max(...late.delays.filter(ms => ms <= 900_000)), "bounded by what is left of the code").toBeLessThanOrEqual(900_000);
  });
});

describe("recheck 4: persistence serialization and timer chunks", () => {
  it("joins a failed newer refresh before retrying persistence and keeps the newest pair", async () => {
    const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
    const newerWrite = deferred(), rejectNewer = deferred(), olderEncryption = deferred();
    const initial = { state: "connected", revision: "rev-1", accessToken: "at-D", refreshToken: "rt-D" };
    let document = { modelSignIns: JSON.stringify({ chatgpt: initial }) }, failedOlder = false, failedNewer = false, spentWrites = 0;
    const state = createSecureCredentialState(document, async next => {
      const token = readSignInRecords(next).chatgpt.refreshToken;
      if (token === "rt-A") {
        if (!failedOlder) { failedOlder = true; throw Error("fixture write deferred"); }
        spentWrites++; await olderEncryption.promise;
      }
      if (token === "rt-B" && !failedNewer) { failedNewer = true; newerWrite.resolve(); await rejectNewer.promise; }
      document = structuredClone(next);
    });
    const timers = [], published = [], writes = new Set(), requested = [];
    const replies = ["A", "B"];
    const signIn = createModelSignIn({
      readDocument: () => state.read(),
      // The production caller wraps the tracked credential queue in a second async function.
      updateDocument: async (derive, afterPersist) => await trackedCredentialUpdate(state, writes, derive, afterPersist),
      publish: entries => published.push(entries), env: {}, now: () => 1_700_000_000_000,
      fetch: async (_url, init) => { requested.push(new URLSearchParams(init.body).get("refresh_token")); const pair = replies.shift(); return Response.json({ access_token: `at-${pair}`, refresh_token: `rt-${pair}` }); },
      setTimeout: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; }, clearTimeout: () => {},
    });
    try {
      expect(await signIn.refresh("chatgpt")).toBe(false); // D remains committed, A is pending.
      const retry = timers.at(-1);
      const rotating = signIn.refresh("chatgpt"); // Spends A for B.
      await newerWrite.promise;
      const queued = retry.fn();
      rejectNewer.reject(Error("fixture newer write deferred"));
      expect(await rotating).toBe(false);
      const suspendedSpentWrites = spentWrites;
      olderEncryption.resolve();
      await queued;
      if (timers.at(-1) !== retry) await timers.at(-1).fn();
      expect(suspendedSpentWrites, "a spent pair never enters encryption while B is pending").toBe(0);
      expect(readSignInRecords(document).chatgpt.refreshToken).toBe("rt-B");
      expect(requested).toEqual(["rt-D", "rt-A"]);
      expect(published.map(entries => entries[0].accessToken)).toEqual(["at-B"]);
      expect(writes.size).toBe(0);
    } finally { olderEncryption.resolve(); signIn.dispose(); }
  });

  it("rearms a long Retry-After from an actual timer callback without a token expiry", async () => {
    const h = harness({ routes: chatgptRoutes({ "oauth/token": [{ access_token: "at-1", refresh_token: "rt-1", id_token: ID_TOKEN }] }) });
    try {
      expect((await h.signIn.startDevice("chatgpt")).ok).toBe(true);
      expect(readSignInRecords(h.document()).chatgpt).not.toHaveProperty("expiresAt");
      h.routes["oauth/token"] = [{ status: 429, body: {}, headers: { "retry-after": "3000000" } }, { access_token: "at-2", refresh_token: "rt-2" }];
      await h.signIn.refresh("chatgpt");
      const first = h.timerFns.at(-1), count = h.timerFns.length, calls = h.calls.length;
      expect(first.ms).toBe(2 ** 31 - 1);
      h.tick(first.ms); await first.fn();
      expect(h.calls).toHaveLength(calls);
      expect(h.timerFns).toHaveLength(count + 1);
      const last = h.timerFns.at(-1);
      expect(last.ms).toBe(3_000_000_000 - first.ms);
      h.tick(last.ms); await last.fn();
      await h.signIn.refresh("chatgpt"); // Join the work the deadline callback started.
      expect(h.calls).toHaveLength(calls + 1);
      expect(readSignInRecords(h.document()).chatgpt.refreshToken).toBe("rt-2");
    } finally { h.signIn.dispose(); }
  });
});
