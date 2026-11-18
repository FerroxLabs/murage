// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Bounded fake exchange/rotation cases adapted from OpenMausBot highlevel.test.ts
// (Apache-2.0; Copyright 2026 Milind Soni and the OpenMausBot contributors).
import { test } from "node:test";
import assert from "node:assert/strict";
import { exchangeOAuth, HIGHLEVEL_TOKEN_CONTRACT, HIGHLEVEL_TOKEN_URL, OAUTH_RESPONSE_MAX_BYTES } from "../src/oauth.ts";

const config = { clientId: "fixture-client", clientSecret: "fixture-marketplace-secret", redirectUri: "https://connect.murage.ai/v1/crm/callback" };
const now = () => 1_800_000_000_000;
const answer = (overrides: Record<string, unknown> = {}) => ({
  access_token: "fixture-access-1", refresh_token: "fixture-refresh-1", expires_in: 86399,
  token_type: "Bearer", userType: "Location", locationId: "location-1", companyId: "company-1", userId: "user-1",
  scope: "contacts.readonly locations.readonly", ...overrides,
});
function fixture(body: unknown = answer(), status = 200) {
  const calls: Request[] = [];
  const fake = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(url, init));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetch: fake, now };
}
test("G1 exchange pins URL/form/schema and uses the actual subset, never requested scopes", async () => {
  const f = fixture();
  const result = await exchangeOAuth(config, { kind: "code", code: "fixture-code" }, f);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(result.credentials.scopes, ["contacts.readonly", "locations.readonly"]);
  assert.ok(!result.credentials.scopes.includes("contacts.write"));
  assert.equal(result.credentials.scopeProvenance, "oauth-token-response");
  assert.equal(result.credentials.locationId, "location-1");
  assert.equal(result.credentials.expiresAt, now() + 86399_000);
  assert.equal(HIGHLEVEL_TOKEN_CONTRACT, "2021-07-28");
  assert.equal(f.calls.length, 1);
  const request = f.calls[0]!;
  assert.equal(request.url, HIGHLEVEL_TOKEN_URL);
  assert.equal(request.method, "POST");
  assert.equal(request.redirect, "manual");
  assert.equal(request.headers.get("version"), null);
  assert.match(request.headers.get("content-type")!, /^application\/x-www-form-urlencoded/);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(await request.text())), {
    client_id: config.clientId, client_secret: config.clientSecret, user_type: "Location", redirect_uri: config.redirectUri,
    grant_type: "authorization_code", code: "fixture-code",
  });
});
for (const [name, overrides] of Object.entries({
  missingScope: { scope: undefined }, emptyScope: { scope: "" }, malformedScope: { scope: ["contacts.write"] },
  doubleSpace: { scope: "contacts.readonly  contacts.write" }, widerScope: { scope: "contacts.readonly unknown.write" },
  oauthScope: { scope: "oauth.write" }, pseudoScope: { scope: "none" },
  company: { userType: "Company" }, missingRole: { userType: undefined }, missingLocation: { locationId: undefined },
  hostileLocation: { locationId: "../other" }, missingUser: { userId: undefined },
  emptyAccess: { access_token: "" }, emptyRefresh: { refresh_token: "" }, wrongType: { token_type: "Basic" },
  expired: { expires_in: 0 }, infiniteExpiry: { expires_in: "86399" },
})) {
  test(`G1 refuses ${name} on exchange AND refresh without scope fallback`, async () => {
    for (const grant of [{ kind: "code", code: "fixture-code" }, { kind: "refresh", refreshToken: "fixture-refresh-old" }] as const) {
      const f = fixture(answer(overrides));
      assert.deepEqual(await exchangeOAuth(config, grant, f), { kind: "error", error: "reconnect_required" });
      assert.equal(f.calls.length, 1);
    }
  });
}
test("G1 refresh supplies rotated tokens and narrowed actual permissions", async () => {
  const f = fixture(answer({ access_token: "fixture-access-2", refresh_token: "fixture-refresh-2", scope: "contacts.readonly" }));
  const result = await exchangeOAuth(config, { kind: "refresh", refreshToken: "fixture-refresh-old" }, f);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.credentials.refreshToken, "fixture-refresh-2");
  assert.equal(result.credentials.accessToken, "fixture-access-2");
  assert.deepEqual(result.credentials.scopes, ["contacts.readonly"]);
  const form = new URLSearchParams(await f.calls[0]!.text());
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "fixture-refresh-old");
  assert.equal(form.get("user_type"), "Location");
  assert.equal(form.has("code"), false);
});
test("bounded upstream failures never retry or disclose response/exception secrets", async () => {
  for (const status of [302, 400, 401, 429, 500]) {
    const f = fixture({ error: "fixture-refresh-secret" }, status);
    const result = await exchangeOAuth(config, { kind: "code", code: "fixture-code" }, f);
    assert.equal(result.kind, "error");
    assert.ok(!JSON.stringify(result).includes("fixture-"));
    assert.equal(f.calls.length, 1);
  }
  const result = await exchangeOAuth(config, { kind: "code", code: "fixture-code" }, {
    fetch: (async () => { throw new Error("fixture-refresh-secret"); }) as typeof fetch,
  });
  assert.deepEqual(result, { kind: "error", error: "exchange_failed" });
});
test("invalid input and arbitrary redirect produce zero network calls", async () => {
  const f = fixture();
  assert.deepEqual(await exchangeOAuth(config, { kind: "code", code: "\nsecret" }, f), { kind: "error", error: "invalid_request" });
  for (const redirectUri of ["https://evil.test/v1/crm/callback", "http://connect.murage.ai/v1/crm/callback", "https://connect.murage.ai/v1/crm/callback?secret=x"]) {
    assert.deepEqual(await exchangeOAuth({ ...config, redirectUri }, { kind: "code", code: "fixture-code" }, f), { kind: "error", error: "invalid_request" });
  }
  assert.equal(f.calls.length, 0);
});
test("bounded body including chunked overflow and invalid JSON", async () => {
  for (const body of ["not-json", "x".repeat(OAUTH_RESPONSE_MAX_BYTES + 1)]) {
    let calls = 0;
    const result = await exchangeOAuth(config, { kind: "code", code: "fixture-code" }, {
      fetch: (async () => { calls++; return new Response(body); }) as typeof fetch,
    });
    assert.equal(result.kind, "error");
    assert.equal(calls, 1);
  }
});
test("deadline bounds both request and streamed response body", async () => {
  for (const fake of [
    async () => new Promise<Response>(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ]) {
    const started = Date.now();
    const result = await exchangeOAuth(config, { kind: "code", code: "fixture-code" }, { fetch: fake as typeof fetch, timeoutMs: 15 });
    assert.deepEqual(result, { kind: "error", error: "exchange_failed" });
    assert.ok(Date.now() - started < 2000);
  }
});

test("late transport response after deadline is discarded and its body cancelled", async () => {
  let cancelled = false;
  const result = await exchangeOAuth(config, { kind: "code", code: "fixture-code" }, {
    timeoutMs: 5,
    fetch: (async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    }) as typeof fetch,
  });
  assert.deepEqual(result, { kind: "error", error: "exchange_failed" });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(cancelled, true);
});
test("upstream token and failure material never enters logging sinks", async () => {
  const sinks: unknown[][] = [];
  const saved = [console.log, console.error, console.warn];
  try {
    console.log = console.error = console.warn = (...args: unknown[]) => { sinks.push(args); };
    await exchangeOAuth(config, { kind: "code", code: "fixture-code" }, fixture());
    await exchangeOAuth(config, { kind: "refresh", refreshToken: "fixture-refresh-old" }, fixture({ error: "fixture-upstream-secret" }, 401));
  } finally { [console.log, console.error, console.warn] = saved; }
  assert.deepEqual(sinks, []);
});

test("empty streamed chunks cannot bypass the bounded response reader", async () => {
  let pulls = 0;
  let cancelled = false;
  const result = await exchangeOAuth(config, { kind: "code", code: "fixture-code" }, {
    fetch: (async () => new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(0)); },
      cancel() { cancelled = true; },
    }))) as typeof fetch,
  });
  assert.deepEqual(result, { kind: "error", error: "exchange_failed" });
  assert.ok(pulls <= OAUTH_RESPONSE_MAX_BYTES + 1);
  assert.equal(cancelled, true);
});
test('T-OAUTH-STAGING: only explicitly configured HTTPS origin may supply callback',async()=>{
  const stagingOrigin='https://staging.fake.example',f=fixture();
  assert.equal((await exchangeOAuth({...config,stagingOrigin,redirectUri:`${stagingOrigin}/v1/crm/callback`},{kind:'code',code:'fixture-code'},f)).kind,'ok');
  assert.equal(new URLSearchParams(await f.calls[0]!.text()).get('redirect_uri'),`${stagingOrigin}/v1/crm/callback`);
  for(const uri of ['https://other.fake.example/v1/crm/callback',`${stagingOrigin}/wrong`,`${stagingOrigin}/v1/crm/callback?x=1`,'http://staging.fake.example/v1/crm/callback']){
    const other=fixture();assert.deepEqual(await exchangeOAuth({...config,stagingOrigin,redirectUri:uri},{kind:'code',code:'fixture-code'},other),{kind:'error',error:'invalid_request'});assert.equal(other.calls.length,0);
  }
});
