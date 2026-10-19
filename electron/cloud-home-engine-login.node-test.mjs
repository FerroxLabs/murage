// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP5: the main-side engine sign-in relay. Fake socket, fake clock, fake client: no network, no Electron.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { CloudHomeError } from "./cloud-home-client.mjs";
import {
  COPY, ENGINE_LOGIN_AUTH_HOSTS, ENGINE_LOGIN_CHANNELS, ENGINE_LOGIN_LIMITS, checkAuthUrl, createEngineLoginRelay, engineLoginPath, refusalFor, registerEngineLoginIpc,
} from "./cloud-home-engine-login.mjs";
import { CLASS_LOCAL_ONLY, channelClass, isClassified, isCloudRefusedChannel } from "./ipc-channel-classes.mjs";

const HOME = "h-abc";

function fakeClock() {
  let now = 0, seq = 0;
  const jobs = new Map();
  const add = (fn, ms, every) => { const id = ++seq; jobs.set(id, { fn, at: now + ms, every }); return id; };
  return {
    timers: {
      setTimeout: (fn, ms) => add(fn, ms),
      setInterval: (fn, ms) => add(fn, ms, ms),
      clearTimeout: (id) => jobs.delete(id),
      clearInterval: (id) => jobs.delete(id),
    },
    pending: () => jobs.size,
    /** Advance time, firing due jobs in order. */
    tick(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...jobs.entries()].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, job] = due;
        now = job.at;
        if (job.every) job.at += job.every; else jobs.delete(id);
        job.fn();
      }
      now = target;
    },
  };
}

class FakeSocket extends EventEmitter {
  sent = []; closed = null; terminated = false;
  send(data) { this.sent.push(String(data)); }
  close(code, reason) { this.closed = { code, reason }; queueMicrotask(() => this.emit("close", code, Buffer.from(reason ?? ""))); }
  terminate() { this.terminated = true; }
}

function fixture({ engine = "codex", authorize, socketBehavior = "open", responseStatus = 403, responseBody = "" } = {}) {
  const clock = fakeClock();
  const sockets = [];
  const opened = [];
  const sent = [];
  const sender = { send: (channel, payload) => sent.push({ channel, payload }), isDestroyed: () => false, once() {} };
  const client = {
    authorizeUpgrade: authorize ?? (async (homeId, path) => ({ url: `wss://home.example${path}`, headers: { authorization: "Bearer t", "x-murage-step-up": "s" }, homeId })),
  };
  const relay = createEngineLoginRelay({
    client, timers: clock.timers,
    createSocket: (url, options) => {
      const ws = new FakeSocket();
      ws.url = url; ws.options = options;
      sockets.push(ws);
      queueMicrotask(() => {
        if (socketBehavior === "open") ws.emit("open");
        else if (socketBehavior === "refuse") {
          const response = new EventEmitter();
          response.statusCode = responseStatus;
          ws.emit("unexpected-response", {}, response);
          response.emit("data", Buffer.from(responseBody));
          response.emit("end");
        } else ws.emit("error", new Error("ECONNREFUSED"));
      });
      return ws;
    },
    openExternal: async (url) => { opened.push(url); },
  });
  return { relay, clock, sockets, opened, sent, sender, engine, client };
}

const start = (f, extra = {}) => f.relay.start({ sender: f.sender, homeId: HOME, engine: f.engine, action: "login", ...extra });
const channelCount = (f, channel) => f.sent.filter((entry) => entry.channel === channel).length;
const closedReasons = (f) => f.sent.filter((entry) => entry.channel === ENGINE_LOGIN_CHANNELS.closed).map((entry) => entry.payload.reason);

// ── allow-list ───────────────────────────────────────────────────────────────

test("the allow-list is exactly the vendor auth hosts the CLIs print", () => {
  assert.deepEqual([...ENGINE_LOGIN_AUTH_HOSTS], ["accounts.x.ai", "auth.openai.com", "claude.ai", "claude.com", "platform.claude.com", "www.kimi.ai"]);
  // The two URLs Sean saw on the live sign-in.
  assert.equal(checkAuthUrl("https://auth.openai.com/codex/device"), "https://auth.openai.com/codex/device");
  assert.equal(checkAuthUrl("https://accounts.x.ai/oauth2/device?user_code=ABCD-1234"), "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234");
  assert.equal(checkAuthUrl("https://www.kimi.ai/code/authorize_device?user_code=ABCD-1234"), "https://www.kimi.ai/code/authorize_device?user_code=ABCD-1234");
  assert.equal(checkAuthUrl("https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y"), "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y");
});

test("main refuses an off-list link: other hosts, lookalikes, http, credentials, ports, odd schemes", () => {
  for (const bad of [
    "https://evil.example/codex/device", "http://auth.openai.com/codex/device", "https://auth.openai.com.evil.example/", "https://evilclaude.ai/",
    "https://claude.ai.evil.example/", "https://user:pw@claude.ai/", "https://claude.ai:8443/", "javascript:alert(1)", "file:///etc/passwd",
    "https://chatgpt.com/", "https://sub.claude.ai/", "https://claude.ai@evil.example/", "https://claude.ai/ x", "https://claude.ai/\n", "//claude.ai/", "", null, 7,
    `https://claude.ai/${"a".repeat(3000)}`,
  ]) assert.equal(checkAuthUrl(bad), null, String(bad));
});

test("openLink: an off-list URL never reaches shell.openExternal; a listed one does", async () => {
  const f = fixture();
  const { id } = await start(f);
  const refused = await f.relay.openLink({ sender: f.sender, id, url: "https://evil.example/phish" });
  assert.deepEqual([refused.ok, refused.code, refused.message], [false, "link-not-allowed", COPY.notAllowedLink]);
  assert.deepEqual(f.opened, []);
  assert.deepEqual(await f.relay.openLink({ sender: f.sender, id, url: "https://auth.openai.com/codex/device" }), { ok: true });
  assert.deepEqual(f.opened, ["https://auth.openai.com/codex/device"]);
  // not from another window, not for another session id
  assert.equal((await f.relay.openLink({ sender: { send() {} }, id, url: "https://claude.ai/" })).code, "not-open");
  assert.equal((await f.relay.openLink({ sender: f.sender, id: "nope", url: "https://claude.ai/" })).code, "not-open");
  assert.equal(f.opened.length, 1);
});

// ── keepalive ────────────────────────────────────────────────────────────────

test("codex relay sends one space every 45 s once the CLI has spoken", async () => {
  const f = fixture({ engine: "codex" });
  const { ok } = await start(f);
  assert.equal(ok, true);
  const ws = f.sockets[0];
  f.clock.tick(60_000);
  assert.deepEqual(ws.sent, [], "no keepalive before the CLI has printed anything");
  ws.emit("message", Buffer.from("Open https://auth.openai.com/codex/device\r\n"));
  f.clock.tick(44_999);
  assert.deepEqual(ws.sent, []);
  f.clock.tick(1);
  assert.deepEqual(ws.sent, [" "]);
  f.clock.tick(90_000);
  assert.deepEqual(ws.sent, [" ", " ", " "]);
});

test("claudeAgent relay never sends a keepalive", async () => {
  const f = fixture({ engine: "claudeAgent" });
  await start(f);
  const ws = f.sockets[0];
  ws.emit("message", Buffer.from("https://claude.com/cai/oauth/authorize\r\n"));
  f.clock.tick(100_000);
  assert.deepEqual(ws.sent, []);
});

// ── caps ─────────────────────────────────────────────────────────────────────

test("120 s of silence closes the relay (claude has no keepalive); traffic either way resets it", async () => {
  const f = fixture({ engine: "claudeAgent" });
  const { id } = await start(f);
  const ws = f.sockets[0];
  f.clock.tick(119_000);
  assert.equal(f.relay.isOpen(), true);
  ws.emit("message", Buffer.from("x"));
  f.clock.tick(119_000);
  assert.equal(f.relay.isOpen(), true, "output reset the idle timer");
  assert.equal((await f.relay.input({ sender: f.sender, id, data: "abc-123\r" })).ok, true);
  f.clock.tick(119_000);
  assert.equal(f.relay.isOpen(), true, "the owner's input reset it too");
  f.clock.tick(1_000);
  assert.equal(f.relay.isOpen(), false);
  assert.deepEqual(closedReasons(f), ["idle-timeout"]);
  assert.equal(ws.terminated, true);
  assert.equal(f.clock.pending(), 0, "no timer outlives the relay");
});

test("the 15 minute total cap fires even while a codex keepalive holds the session open", async () => {
  const f = fixture({ engine: "codex" });
  await start(f);
  f.sockets[0].emit("message", Buffer.from("code\r\n"));
  f.clock.tick(ENGINE_LOGIN_LIMITS.totalMs - 1);
  assert.equal(f.relay.isOpen(), true, "keepalive beat the idle cap");
  f.clock.tick(1);
  assert.equal(f.relay.isOpen(), false);
  assert.deepEqual(closedReasons(f), ["total-timeout"]);
  assert.equal(f.clock.pending(), 0);
});

test("the home closing the socket ends the relay with 'done'; stop() ends it with 'stopped'; a new sign-in can follow", async () => {
  const f = fixture({ engine: "claudeAgent" });
  await start(f);
  f.sockets[0].emit("close", 1000, Buffer.from("done"));
  assert.deepEqual(closedReasons(f), ["done"]);
  const second = await start(f);
  assert.equal(second.ok, true);
  assert.deepEqual(f.relay.stop({ sender: f.sender, id: second.id }), { ok: true });
  assert.deepEqual(closedReasons(f), ["done", "stopped"]);
  assert.equal(f.sockets[1].closed.reason, "stopped");
});

test("only one relay at a time, and a second start while the first is still starting is refused", async () => {
  const f = fixture();
  const first = start(f);
  const during = await start(f);
  assert.deepEqual([during.ok, during.code], [false, "busy"]);
  assert.equal((await first).ok, true);
  const after = await start(f, { engine: "claudeAgent" });
  assert.deepEqual([after.ok, after.code, after.message], [false, "busy", COPY.busy]);
});

// ── refusal paths ────────────────────────────────────────────────────────────

test("a browser-class session is refused with a clean error, and no CLI-relay is left open", async () => {
  const f = fixture({ socketBehavior: "refuse", responseStatus: 403, responseBody: JSON.stringify({ error: "Open this on the desktop you paired as the owner." }) });
  const result = await start(f);
  assert.deepEqual(result, { ok: false, code: "owner-desktop-required", message: COPY.ownerDesktopRequired });
  assert.equal(f.relay.isOpen(), false);
  assert.equal(f.sockets[0].terminated, true);
  assert.deepEqual(f.sent, []);
  assert.equal((await start(f)).code, "owner-desktop-required", "a refusal does not wedge the next attempt");
});

test("a missing step-up surfaces cleanly, whether the person cancels or the home asks for it", async () => {
  const cancelled = fixture({ authorize: async () => { throw new CloudHomeError("step-up-cancelled", "You cancelled the confirmation, so nothing was changed."); } });
  assert.deepEqual(await start(cancelled), { ok: false, code: "step-up-cancelled", message: "You cancelled the confirmation, so nothing was changed." });
  assert.equal(cancelled.sockets.length, 0, "no socket is opened without the step-up");

  const asked = fixture({ socketBehavior: "refuse", responseStatus: 403, responseBody: JSON.stringify({ error: "step-up required" }) });
  assert.deepEqual(await start(asked), { ok: false, code: "step-up-required", message: COPY.stepUpRequired });
});

test("other refusals map to plain codes: 409 already open, 401 needs re-pair, 400, edge 502, unreachable, pin mismatch", async () => {
  for (const [status, code] of [[409, "already-open"], [401, "needs-repair"], [400, "bad-request"], [502, "unreachable"], [500, "refused"]]) {
    assert.equal(refusalFor(status).code, code, String(status));
    const f = fixture({ socketBehavior: "refuse", responseStatus: status });
    assert.equal((await start(f)).code, code);
  }
  assert.equal((await start(fixture({ socketBehavior: "error" }))).code, "unreachable");
  const pin = fixture({ authorize: async () => { throw new CloudHomeError("pin-mismatch", "This isn't the Cloud home you paired with. Pair it again."); } });
  assert.deepEqual(await start(pin), { ok: false, code: "pin-mismatch", message: "This isn't the Cloud home you paired with. Pair it again." });
});

test("bad requests never reach the client: unknown engine or action, bad home id, no sender", async () => {
  const f = fixture();
  let asked = 0;
  f.client.authorizeUpgrade = async () => { asked++; throw new Error("must not be called"); };
  for (const extra of [{ engine: "gemini" }, { action: "wipe" }, { homeId: "../x" }, { homeId: "" }, { engine: "codex/../../x" }]) assert.equal((await start(f, extra)).code, "bad-request");
  assert.equal((await f.relay.start({ homeId: HOME, engine: "codex" })).code, "bad-request");
  assert.equal(asked, 0);
});

test("the step-up covers the exact path with the action: /api/engine-login/<engine>?action=<login|logout>", async () => {
  const seen = [];
  const f = fixture({ engine: "claudeAgent", authorize: async (homeId, path) => { seen.push([homeId, path]); return { url: `wss://home.example${path}`, headers: {} }; } });
  const { id } = await start(f, { action: "logout" });
  assert.deepEqual(seen, [[HOME, "/api/engine-login/claudeAgent?action=logout"]]);
  f.relay.stop({ sender: f.sender, id });
});

test("input is bounded, string-only, and only from the window that opened the relay", async () => {
  const f = fixture({ engine: "claudeAgent" });
  const { id } = await start(f);
  assert.equal((await f.relay.input({ sender: { send() {} }, id, data: "x\r" })).code, "not-open");
  assert.equal((await f.relay.input({ sender: f.sender, id, data: "" })).code, "bad-request");
  assert.equal((await f.relay.input({ sender: f.sender, id, data: "a".repeat(ENGINE_LOGIN_LIMITS.maxInputBytes + 1) })).code, "bad-request");
  assert.deepEqual(f.sockets[0].sent, []);
  assert.equal((await f.relay.input({ sender: f.sender, id, data: "code-1\r" })).ok, true);
  assert.deepEqual(f.sockets[0].sent, ["code-1\r"]);
});

test("terminal bytes reach only the asking window, as bytes; the token and step-up header never leave main", async () => {
  const f = fixture();
  const { id } = await start(f);
  f.sockets[0].emit("message", Buffer.from("hello"));
  assert.equal(channelCount(f, ENGINE_LOGIN_CHANNELS.data), 1);
  const { payload } = f.sent.find((entry) => entry.channel === ENGINE_LOGIN_CHANNELS.data);
  assert.equal(payload.id, id);
  assert.ok(payload.data instanceof Uint8Array);
  assert.equal(Buffer.from(payload.data).toString(), "hello");
  assert.doesNotMatch(JSON.stringify(f.sent), /Bearer|step-up/i);
  assert.equal(f.sockets[0].options.followRedirects, false);
});

// ── IPC wiring and classes ───────────────────────────────────────────────────

test("registerEngineLoginIpc registers exactly the four invoke channels, validates payload shapes, and passes the sender", async () => {
  const handlers = new Map();
  const calls = [];
  const relay = { start: (a) => (calls.push(["start", a]), "s"), input: (a) => (calls.push(["input", a]), "i"), stop: (a) => (calls.push(["stop", a]), "x"), openLink: (a) => (calls.push(["openLink", a]), "o") };
  registerEngineLoginIpc({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, relay });
  assert.deepEqual([...handlers.keys()].sort(), [ENGINE_LOGIN_CHANNELS.input, ENGINE_LOGIN_CHANNELS.openLink, ENGINE_LOGIN_CHANNELS.start, ENGINE_LOGIN_CHANNELS.stop]);
  const sender = {};
  assert.equal(handlers.get(ENGINE_LOGIN_CHANNELS.start)({ sender }, { homeId: HOME, engine: "codex" }), "s");
  assert.deepEqual(calls[0][1], { sender, homeId: HOME, engine: "codex", action: "login" });
  assert.equal((await handlers.get(ENGINE_LOGIN_CHANNELS.start)({ sender }, "nope")).code, "bad-request");
  assert.equal((await handlers.get(ENGINE_LOGIN_CHANNELS.input)({ sender }, null)).code, "bad-request");
  handlers.get(ENGINE_LOGIN_CHANNELS.start)({ sender }, { homeId: { toString() { return HOME; } }, engine: ["codex"], action: 5 });
  assert.deepEqual([calls[1][1].homeId, calls[1][1].engine, calls[1][1].action], ["", "", ""], "non-string fields become empty and are refused as bad requests");
});

test("every engine-login channel is classified and unreachable from the Cloud-home window (main window only)", () => {
  for (const channel of Object.values(ENGINE_LOGIN_CHANNELS)) {
    assert.equal(isClassified(channel), true, channel);
    assert.equal(channelClass(channel), CLASS_LOCAL_ONLY, `${channel}: the gate refuses the Cloud-home window by name`);
  }
  assert.equal(isCloudRefusedChannel("cloud-home:engine-login:start"), false);
  // an unlisted cloud-home:engine-login:* name is still cloud-only (never a way for the main window to be reached by accident)
  assert.equal(channelClass("cloud-home:engine-login:other"), "cloud-only");
});

// ── per-bot sign-in and key enrollment (CLOUD-ENGINES-DESIGN.md r9) ──────────

const KEY = "sk-fixture-0123456789abcdefghij";

test("the path names the bot and the OpenCode provider; the key never rides the URL", () => {
  assert.equal(engineLoginPath({ engine: "codex", action: "login", bot: "bot-atlas" }), "/api/engine-login/codex?action=login&bot=bot-atlas");
  assert.equal(engineLoginPath({ engine: "opencodeGo", action: "login", bot: "bot-atlas" }), "/api/engine-login/opencodeGo?action=login&bot=bot-atlas");
  assert.equal(engineLoginPath({ engine: "kimiAgent", action: "logout", bot: "bot-atlas" }), "/api/engine-login/kimiAgent?action=logout&bot=bot-atlas");
  assert.equal(engineLoginPath({ engine: "codex", action: "enroll-key", secret: KEY }), "/api/engine-login/codex?action=enroll-key");
  assert.equal(engineLoginPath({ engine: "opencodeGo", action: "enroll-key", provider: "openai", secret: KEY }), "/api/engine-login/opencodeGo?action=enroll-key&provider=openai");
  for (const bad of [
    { engine: "codex", action: "login", bot: "../x" }, { engine: "codex", action: "login", bot: "a b" },
    { engine: "codex", action: "enroll-key" }, { engine: "codex", action: "enroll-key", secret: "short" },
    { engine: "codex", action: "enroll-key", secret: KEY, bot: "bot-atlas" }, { engine: "codex", action: "enroll-key", secret: KEY, provider: "openai" },
    { engine: "opencodeGo", action: "enroll-key", secret: KEY }, { engine: "opencodeGo", action: "enroll-key", secret: KEY, provider: "Open AI" },
    { engine: "claudeAgent", action: "enroll-key", secret: KEY }, { engine: "codex", action: "login", secret: KEY },
  ]) assert.equal(engineLoginPath(bad), null, JSON.stringify(bad));
  assert.ok(!engineLoginPath({ engine: "codex", action: "enroll-key", secret: KEY }).includes(KEY));
});

test("a per-bot sign-in asks the home for that bot's path", async () => {
  const seen = [];
  const f = fixture({ authorize: async (homeId, path) => { seen.push(path); return { url: `wss://home.example${path}`, headers: {} }; } });
  const { id } = await start(f, { bot: "bot-atlas" });
  assert.deepEqual(seen, ["/api/engine-login/codex?action=login&bot=bot-atlas"]);
  f.relay.stop({ sender: f.sender, id });
});

test("enroll-key sends the key as the socket's first message, takes no input after it, gets no keepalive and logs no key", async () => {
  const lines = [];
  const f = fixture({ engine: "opencodeGo" });
  const relay = createEngineLoginRelay({ client: f.client, timers: f.clock.timers, log: (line) => lines.push(line), openExternal: async () => {},
    createSocket: (url, options) => { const ws = new FakeSocket(); ws.url = url; ws.options = options; f.sockets.push(ws); queueMicrotask(() => ws.emit("open")); return ws; } });
  const result = await relay.start({ sender: f.sender, homeId: HOME, engine: "opencodeGo", action: "enroll-key", provider: "openai", secret: KEY });
  assert.equal(result.ok, true);
  const ws = f.sockets.at(-1);
  assert.deepEqual(ws.sent, [KEY]);
  assert.equal(ws.url, "wss://home.example/api/engine-login/opencodeGo?action=enroll-key&provider=openai");
  assert.equal(relay.input({ sender: f.sender, id: result.id, data: "more" }).code, "bad-request");
  ws.emit("message", Buffer.from("Saved."));
  f.clock.tick(ENGINE_LOGIN_LIMITS.keepaliveMs * 2);
  assert.deepEqual(ws.sent, [KEY]);
  assert.doesNotMatch(lines.join("\n"), new RegExp(KEY));
  assert.doesNotMatch(JSON.stringify(f.sent), new RegExp(KEY));
});

test("the IPC start passes bot, provider and secret through as strings only", async () => {
  const handlers = new Map();
  const calls = [];
  registerEngineLoginIpc({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, relay: { start: (a) => (calls.push(a), "s"), input() {}, stop() {}, openLink() {} } });
  const sender = {};
  handlers.get(ENGINE_LOGIN_CHANNELS.start)({ sender }, { homeId: HOME, engine: "opencodeGo", action: "enroll-key", provider: "openai", secret: KEY });
  assert.deepEqual(calls[0], { sender, homeId: HOME, engine: "opencodeGo", action: "enroll-key", provider: "openai", secret: KEY });
  handlers.get(ENGINE_LOGIN_CHANNELS.start)({ sender }, { homeId: HOME, engine: "codex", bot: { id: "x" } });
  assert.equal(calls[1].bot, "", "a non-string bot becomes empty and is refused as a bad request");
  assert.equal((await createEngineLoginRelay({ client: { authorizeUpgrade: async () => { throw new Error("must not be called"); } }, createSocket: () => null, openExternal: async () => {} })
    .start({ sender: { send() {} }, homeId: HOME, engine: "codex", bot: "" })).code, "bad-request");
});
