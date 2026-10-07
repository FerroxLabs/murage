// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MCP-LINK T10: the loopback listener and PKCE shared by plan sign-in
// (ChatGPT, Grok) and MCP server sign-in. Real node:http listeners on
// 127.0.0.1 with ephemeral ports; no browser, no network beyond loopback.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { callbackPage, runLoopback, LOOPBACK_HOST } from "./oauth/loopback.mjs";
import { createPkce, createState, createVerifier, s256Challenge } from "./oauth/pkce.mjs";

/** A real listener factory that remembers what it made. */
function realServers() {
  const made = [];
  return { made, create: () => { const server = http.createServer(); made.push(server); return server; } };
}

/** GET on a fresh connection (no keep-alive pool), so "closed" means refused. */
function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", agent: false, headers: { connection: "close" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start a loopback flow and hand back its port once it listens. */
function start(options = {}) {
  const servers = realServers();
  let controls;
  let listening;
  const ready = new Promise((resolve) => { listening = resolve; });
  const result = runLoopback({
    createServer: servers.create,
    path: "/callback",
    ports: [0],
    state: "STATE-1",
    timeoutMs: 60_000,
    register: (c) => { controls = c; },
    onListening: async (port) => { listening(port); },
    ...options,
  });
  return { servers, result, ready, controls: () => controls };
}

test("binds 127.0.0.1 only, never localhost or every interface", async () => {
  const flow = start();
  const port = await flow.ready;
  const address = flow.servers.made[0].address();
  assert.equal(LOOPBACK_HOST, "127.0.0.1");
  assert.equal(address.address, "127.0.0.1");
  assert.equal(address.family, "IPv4");
  assert.equal(address.port, port);
  flow.controls().finish({ error: "cancelled" });
  await flow.result;
  // The loopback module passes the literal host to listen: never "localhost", "::" or "0.0.0.0".
  const source = readFileSync(new URL("./oauth/loopback.mjs", import.meta.url), "utf8");
  assert.match(source, /listen\(port, LOOPBACK_HOST/);
  assert.doesNotMatch(source, /"localhost"|"0\.0\.0\.0"|"::"/);
});

test("answers /callback only; any other path is 404 and the flow keeps waiting", async () => {
  const flow = start();
  const port = await flow.ready;
  assert.equal((await get(port, "/")).status, 404);
  assert.equal((await get(port, "/auth/callback?code=x&state=STATE-1")).status, 404);
  assert.equal((await get(port, "/callback/extra?code=x&state=STATE-1")).status, 404);
  assert.equal(flow.servers.made[0].listening, true, "still waiting");
  const answer = await get(port, "/callback?code=real&state=STATE-1");
  assert.equal(answer.status, 200);
  const result = await flow.result;
  assert.equal(result.code, "real");
  assert.equal(result.port, port);
});

test("a wrong or missing state is refused with 400 and cannot end the flow", async () => {
  const flow = start();
  const port = await flow.ready;
  assert.equal((await get(port, "/callback?code=x&state=not-it")).status, 400);
  assert.equal((await get(port, "/callback?error=access_denied")).status, 400);
  assert.equal(flow.servers.made[0].listening, true);
  await get(port, "/callback?code=good&state=STATE-1");
  assert.equal((await flow.result).code, "good");
});

test("one-shot: after the first code the listener is closed and a second code is never taken", async () => {
  const flow = start();
  const port = await flow.ready;
  await get(port, "/callback?code=first&state=STATE-1");
  const result = await flow.result;
  assert.equal(result.code, "first");
  assert.equal(flow.servers.made[0].listening, false);
  await assert.rejects(get(port, "/callback?code=second&state=STATE-1"), /ECONNREFUSED/);
});

test("closes on success, on an error answer, on timeout and on cancel", async () => {
  // success
  const ok = start();
  await get(await ok.ready, "/callback?code=c&state=STATE-1");
  assert.equal((await ok.result).code, "c");
  assert.equal(ok.servers.made[0].listening, false, "closed after success");

  // the authorization server answered with an error
  const denied = start();
  const deniedAnswer = await get(await denied.ready, "/callback?error=access_denied&state=STATE-1");
  assert.equal(deniedAnswer.status, 200);
  const deniedResult = await denied.result;
  assert.equal(deniedResult.error, "cancelled");
  assert.equal(deniedResult.providerError, "access_denied");
  assert.equal(denied.servers.made[0].listening, false, "closed after an error answer");

  // timeout
  const slow = start({ timeoutMs: 30 });
  await slow.ready;
  assert.equal((await slow.result).error, "timeout");
  assert.equal(slow.servers.made[0].listening, false, "closed after timeout");

  // cancel
  const cancelled = start();
  await cancelled.ready;
  cancelled.controls().finish({ error: "cancelled" });
  assert.equal((await cancelled.result).error, "cancelled");
  assert.equal(cancelled.servers.made[0].listening, false, "closed after cancel");

  // the browser could not be opened
  const noBrowser = start({ onListening: async () => { throw new Error("no browser"); } });
  assert.equal((await noBrowser.result).error, "browser");
  assert.equal(noBrowser.servers.made[0].listening, false, "closed when the browser did not open");
});

test("an extra check (the iss parameter) that fails ends the flow with a failure page", async () => {
  const flow = start({ accept: (params) => params.get("iss") === "https://as.example" });
  const port = await flow.ready;
  const answer = await get(port, "/callback?code=c&state=STATE-1&iss=https://evil.example");
  assert.equal(answer.status, 400);
  assert.match(answer.body, /did not finish/);
  const result = await flow.result;
  assert.equal(result.error, "rejected");
  assert.equal(result.code, undefined);
  assert.equal(flow.servers.made[0].listening, false);
});

test("falls back to the next port when the first is busy, and reports which one it got", async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const busy = blocker.address().port;
  try {
    const flow = start({ ports: [busy, 0] });
    const port = await flow.ready;
    assert.notEqual(port, busy);
    await get(port, "/callback?code=c&state=STATE-1");
    assert.equal((await flow.result).port, port);
    const none = start({ ports: [busy] });
    const result = await none.result;
    assert.equal(result.error, "port");
  } finally {
    blocker.close();
  }
});

test("the result page carries no code, state or token and no em or en dash", async () => {
  const flow = start();
  const port = await flow.ready;
  const answer = await get(port, "/callback?code=SECRET-CODE-123&state=STATE-1");
  await flow.result;
  for (const body of [answer.body, callbackPage(true), callbackPage(false)]) {
    assert.doesNotMatch(body, /SECRET-CODE-123|STATE-1|token|access_token/i);
    assert.doesNotMatch(body, /[—–]/);
    assert.doesNotMatch(body, /\bsafe(ly|ty)?\b|\bunsafe\b/i);
    assert.doesNotMatch(body, /<script/i, "a static page");
  }
  assert.match(callbackPage(true), /signed in/i);
  assert.match(callbackPage(false), /did not finish/i);
});

test("PKCE verifier: 43 to 128 characters from the unreserved set", () => {
  for (const bytes of [32, 48, 64, 96]) {
    const verifier = createVerifier(bytes);
    assert.ok(verifier.length >= 43 && verifier.length <= 128, `${bytes} bytes gives ${verifier.length}`);
    assert.match(verifier, /^[A-Za-z0-9._~-]+$/);
  }
  assert.equal(createVerifier().length, 43, "the default is 32 bytes");
  assert.throws(() => createVerifier(31), /43/);
  assert.throws(() => createVerifier(97), /128/);
  assert.notEqual(createVerifier(), createVerifier());
  const pkce = createPkce();
  assert.equal(pkce.method, "S256");
  assert.equal(pkce.challenge, s256Challenge(pkce.verifier));
  assert.equal(Buffer.from(pkce.state, "base64url").length, 32, "state is 32 random bytes");
  assert.equal(Buffer.from(createState(16), "base64url").length, 16);
});

test("S256 matches the RFC 7636 appendix B vector", () => {
  assert.equal(s256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("plan sign-in uses the shared modules instead of its own copies", () => {
  const signin = readFileSync(new URL("./model-signin.mjs", import.meta.url), "utf8");
  const oauth = readFileSync(new URL("./model-signin-oauth.mjs", import.meta.url), "utf8");
  assert.match(signin, /from "\.\/oauth\/loopback\.mjs"/);
  assert.match(oauth, /from "\.\/oauth\/pkce\.mjs"/);
  assert.doesNotMatch(signin, /server\.listen\(/, "no private listener left in model-signin.mjs");
  assert.doesNotMatch(signin, /function callbackPage/);
  assert.doesNotMatch(oauth, /createHash\("sha256"\)/, "one S256 implementation");
});

test("a kept-alive browser socket does not carry the next flow's callback to the closed listener", async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const viaAgent = (port, path) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, agent }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.end();
  });
  try {
    const first = start();
    const port = await first.ready;
    assert.equal(await viaAgent(port, "/callback?code=one&state=STATE-1"), 200);
    assert.equal((await first.result).code, "one");
    await tick(20);
    const second = start({ ports: [port] });
    assert.equal(await second.ready, port, "the same port again");
    assert.equal(await viaAgent(port, "/callback?code=two&state=STATE-1"), 200);
    assert.equal((await second.result).code, "two");
  } finally {
    agent.destroy();
  }
});
