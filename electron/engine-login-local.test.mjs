// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The local sign-in runner (ENGINE-SIGNIN-SIMPLE-1014): no sign-in output enters Murage, and done detection.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createLocalEngineLogin, LOCAL_ENGINE_LOGIN_CHANNELS, LOCAL_ENGINE_LOGIN_LIMITS, registerLocalEngineLoginIpc } from "./engine-login-local.mjs";

const recipe = (over = {}) => ({ kind: "headless", argv: ["/bin/grok", "login", "--oauth"], env: { PATH: "/p", HOME: "/h" }, unsetKeys: ["XAI_API_KEY"], accountRoot: "/h/.grok", accountEnv: {}, label: "Grok", ...over });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function fixture({ reply = recipe(), signedIn = [false], setupCheck = { status: 200, body: { result: "ready" } }, spawnThrows = false, launchTerminal, closeOnKill = true } = {}) {
  const order = [];
  const sent = [];
  const child = Object.assign(new EventEmitter(), { pid: 4242 });
  const timers = [];
  const clock = {
    setTimeout: (fn, ms) => { const timer = { fn, ms, on: true }; timers.push(timer); return timer; }, clearTimeout: (timer) => { if (timer) timer.on = false; },
    setInterval: (fn, ms) => { const timer = { fn, ms, on: true, every: true }; timers.push(timer); return timer; }, clearInterval: (timer) => { if (timer) timer.on = false; },
  };
  const fire = async (ms) => { for (const timer of [...timers]) if (timer.on && timer.ms === ms) { if (!timer.every) timer.on = false; timer.fn(); } await flush(); };
  const readings = [...signedIn];
  const api = vi.fn(async (path, body) => {
    order.push(path);
    if (path === "/api/engine-signin-recipe") return { status: 200, body: reply };
    if (path === "/api/engine-signin-probe") return { status: 200, body: { authenticated: readings.length > 1 ? readings.shift() : readings[0] } };
    if (path === "/api/engine-setup-check") return setupCheck;
    return { status: 404, body: { path, body } };
  });
  const spawn = vi.fn(() => { order.push("spawn"); if (spawnThrows) throw new Error("ENOENT"); return child; });
  const killTree = vi.fn((target, signal) => { order.push(`kill-${signal}`); if (closeOnKill) queueMicrotask(() => target.emit("close", null)); });
  const runner = createLocalEngineLogin({ api, spawn, killTree, launchTerminal, timers: clock, newId: () => "session-1" });
  const sender = Object.assign(new EventEmitter(), { send: (channel, payload) => sent.push({ channel, payload }), isDestroyed: () => false });
  const closed = () => sent.find((entry) => entry.channel === LOCAL_ENGINE_LOGIN_CHANNELS.closed)?.payload;
  return { runner, sender, api, spawn, killTree, child, order, sent, closed, fire, timers };
}
const begin = async (rig) => { const started = await rig.runner.start({ sender: rig.sender, instanceId: "grok" }); expect(started).toEqual({ ok: true, id: "session-1" }); };
const { probeMs, finishMs, totalMs } = LOCAL_ENGINE_LOGIN_LIMITS;

describe("no sign-in output enters Murage", () => {
  it("spawns with all three stdio on ignore, no shell, the tree detached, and the recipe's environment alone", async () => {
    const rig = fixture({ reply: recipe({ env: { PATH: "/p", XAI_API_KEY: "left-over" } }) });
    await begin(rig);
    const [file, args, options] = rig.spawn.mock.calls[0];
    expect(file).toBe("/bin/grok");
    expect(args).toEqual(["login", "--oauth"]);
    expect(options.stdio).toEqual(["ignore", "ignore", "ignore"]);
    expect(options).toMatchObject({ shell: false, windowsHide: true, detached: process.platform !== "win32" });
    expect(options.env).toEqual({ PATH: "/p" });
  });
  it("the source holds no reader of a child's output, no clipboard, no link opener and no capture hold", () => {
    const source = readFileSync(new URL("./engine-login-local.mjs", import.meta.url), "utf8");
    for (const word of ["stdout", "stderr", "stdin", "openExternal", "clipboard", "setContentProtection", "/api/engine-signin-hold", "findSigninLink"]) expect(source).not.toContain(word);
  });
  it("the channels are the agreed few, with no input, no open-link and no copy-code", () => {
    expect(Object.values(LOCAL_ENGINE_LOGIN_CHANNELS).sort()).toEqual(["closed", "data", "open-terminal", "preview", "start", "stop"].map((name) => `local-engine-login:${name}`));
  });
});

describe("opening the dialog starts nothing", () => {
  it("preview names the engine and folder, spawns nothing, and hands a window no argv or env", async () => {
    const rig = fixture();
    expect(await rig.runner.preview({ instanceId: "grok" })).toEqual({ ok: true, kind: "headless", label: "Grok", accountRoot: "/h/.grok" });
    expect(rig.spawn).not.toHaveBeenCalled();
    expect(rig.runner.isOpen()).toBe(false);
  });
  it("start refuses anything but a headless recipe", async () => {
    const rig = fixture({ reply: recipe({ kind: "terminal" }) });
    expect(await rig.runner.start({ sender: rig.sender, instanceId: "grok" })).toMatchObject({ ok: false, code: "start-failed" });
    expect(rig.spawn).not.toHaveBeenCalled();
    expect(rig.runner.isOpen()).toBe(false);
  });
  it("one sign-in at a time, seen before any await", async () => {
    const rig = fixture();
    const first = rig.runner.start({ sender: rig.sender, instanceId: "grok" });
    expect(await rig.runner.start({ sender: rig.sender, instanceId: "grok" })).toMatchObject({ ok: false, code: "busy" });
    await first;
  });
  it("records the starting state before the child runs", async () => {
    const rig = fixture();
    await begin(rig);
    expect(rig.order.slice(0, 3)).toEqual(["/api/engine-signin-recipe", "/api/engine-signin-probe", "spawn"]);
  });
});

describe("done detection", () => {
  it("started signed out: child exit plus a true re-probe is Signed in", async () => {
    const rig = fixture({ signedIn: [false, true] });
    await begin(rig);
    rig.child.emit("close", 0);
    await flush();
    expect(rig.closed()).toEqual({ id: "session-1", result: "signed-in" });
    expect(rig.api).not.toHaveBeenCalledWith("/api/engine-setup-check", expect.anything(), expect.anything());
  });
  it("a child that left with the probe still false is Not finished, so a port taken offers Terminal", async () => {
    const rig = fixture({ signedIn: [false] });
    await begin(rig);
    rig.child.emit("close", 1);
    await flush();
    expect(rig.closed().result).toBe("not-finished");
  });
  it("false to true shows Finishing and ends nothing; the child gets 30 seconds, then is ended and it is Signed in", async () => {
    const rig = fixture({ signedIn: [false, true] });
    await begin(rig);
    await rig.fire(probeMs);
    expect(rig.sent).toContainEqual({ channel: LOCAL_ENGINE_LOGIN_CHANNELS.data, payload: { id: "session-1", finishing: true } });
    expect(rig.killTree).not.toHaveBeenCalled();
    await rig.fire(finishMs);
    await flush();
    expect(rig.killTree).toHaveBeenCalled();
    expect(rig.closed().result).toBe("signed-in");
  });
  it("a change the login itself did not finish needs the real reply: a failed exit, a child Murage ended, a Terminal", async () => {
    const refused = { status: 200, body: { result: "signin" } };
    const failedExit = fixture({ signedIn: [false, true], setupCheck: refused });
    await begin(failedExit);
    failedExit.child.emit("close", 1);
    await flush();
    expect(failedExit.closed().result).toBe("not-finished");
    expect(failedExit.api).not.toHaveBeenCalledWith("/api/engine-signin-probe", { instanceId: "grok", signedIn: true });
    const ended = fixture({ signedIn: [false, true], setupCheck: refused });
    await begin(ended);
    await ended.fire(probeMs);
    await ended.fire(finishMs);
    await flush();
    expect(ended.closed().result).toBe("not-finished");
    const passed = fixture({ signedIn: [false, true] });
    await begin(passed);
    passed.child.emit("close", 1);
    await flush();
    expect(passed.closed().result).toBe("signed-in");
    expect(passed.api).toHaveBeenCalledWith("/api/engine-setup-check", { instanceId: "grok" }, { timeoutMs: 120_000 });
  });
  it("Finishing and a child that leaves by itself is Signed in with no kill", async () => {
    const rig = fixture({ signedIn: [false, true] });
    await begin(rig);
    await rig.fire(probeMs);
    rig.child.emit("close", 0);
    await flush();
    expect(rig.closed().result).toBe("signed-in");
    expect(rig.killTree).not.toHaveBeenCalled();
  });
  it("started signed in: the flag is ignored, nothing ends on a probe", async () => {
    const rig = fixture({ signedIn: [true] });
    await begin(rig);
    await rig.fire(probeMs);
    await rig.fire(probeMs);
    expect(rig.sent).toEqual([]);
    expect(rig.killTree).not.toHaveBeenCalled();
    expect(rig.runner.isOpen()).toBe(true);
  });
  it("started signed in: on child exit, Signed in needs the one real reply to pass", async () => {
    const rig = fixture({ signedIn: [true] });
    await begin(rig);
    rig.child.emit("close", 0);
    await flush();
    expect(rig.api).toHaveBeenCalledWith("/api/engine-setup-check", { instanceId: "grok" }, { timeoutMs: 120_000 });
    expect(rig.closed().result).toBe("signed-in");
  });
  it("started signed in: a real reply that fails is Not finished, with the engine's own line", async () => {
    const rig = fixture({ signedIn: [true], setupCheck: { status: 200, body: { result: "limit", line: "You've hit your plan limit." } } });
    await begin(rig);
    rig.child.emit("close", 0);
    await flush();
    expect(rig.closed()).toEqual({ id: "session-1", result: "not-finished", message: "You've hit your plan limit." });
  });
  it("a probe that could not answer at the start counts as signed in, so a stale login proves nothing", async () => {
    const rig = fixture({ signedIn: [null, true], setupCheck: { status: 200, body: { result: "signin" } } });
    await begin(rig);
    rig.child.emit("close", 0);
    await flush();
    expect(rig.api).toHaveBeenCalledWith("/api/engine-setup-check", { instanceId: "grok" }, { timeoutMs: 120_000 });
    expect(rig.closed().result).toBe("not-finished");
  });
  it("an engine whose probe cannot say at the end is decided by the real reply, not read as signed out", async () => {
    const rig = fixture({ signedIn: [false, null] });
    await begin(rig);
    rig.child.emit("close", 0);
    await flush();
    expect(rig.api).toHaveBeenCalledWith("/api/engine-setup-check", { instanceId: "grok" }, { timeoutMs: 120_000 });
    expect(rig.closed().result).toBe("signed-in");
  });
  it("a finished sign-in tells the server, so an older rejection stops marking the engine signed out", async () => {
    const rig = fixture({ signedIn: [false, true] });
    await begin(rig);
    rig.child.emit("close", 0);
    await flush();
    expect(rig.api).toHaveBeenCalledWith("/api/engine-signin-probe", { instanceId: "grok", signedIn: true });
  });
  it("timeout: Not finished unless the flag changed from false to true", async () => {
    const out = fixture({ signedIn: [false] });
    await begin(out);
    await out.fire(totalMs);
    await flush();
    expect(out.closed().result).toBe("not-finished");
    const flipped = fixture({ signedIn: [false, true] });
    await begin(flipped);
    await flipped.fire(totalMs);
    await flush();
    expect(flipped.closed().result).toBe("signed-in");
  });
  it("a timeout on a session that started signed in stays Not finished", async () => {
    const rig = fixture({ signedIn: [true] });
    await begin(rig);
    await rig.fire(totalMs);
    await flush();
    expect(rig.closed().result).toBe("not-finished");
  });
});

describe("stop and quit", () => {
  it("stop ends the tree and says stopped; another sender cannot", async () => {
    const rig = fixture();
    await begin(rig);
    expect(await rig.runner.stop({ sender: new EventEmitter(), id: "session-1" })).toMatchObject({ ok: false });
    expect(await rig.runner.stop({ sender: rig.sender, id: "session-1" })).toEqual({ ok: true });
    expect(rig.killTree).toHaveBeenCalled();
    expect(rig.closed().result).toBe("stopped");
  });
  it("a window that goes away stops the sign-in", async () => {
    const rig = fixture();
    await begin(rig);
    rig.sender.emit("destroyed");
    await flush();
    expect(rig.killTree).toHaveBeenCalled();
  });
  it("quit ends what is open, awaits it, and refuses new starts", async () => {
    const rig = fixture();
    await begin(rig);
    await rig.runner.shutdown();
    expect(rig.killTree).toHaveBeenCalled();
    expect(await rig.runner.start({ sender: rig.sender, instanceId: "grok" })).toMatchObject({ ok: false, code: "closing" });
  });
  it("a child that cannot start refuses", async () => {
    const rig = fixture({ spawnThrows: true });
    expect(await rig.runner.start({ sender: rig.sender, instanceId: "grok" })).toMatchObject({ ok: false, code: "start-failed" });
    expect(rig.runner.isOpen()).toBe(false);
  });
});

describe("Terminal", () => {
  const supervisor = (alive = true) => ({ alive: () => alive, stop: vi.fn(async () => {}) });
  it("from a running sign-in: the child is stopped and awaited before the launch, and that session closes with no word", async () => {
    const launch = vi.fn(async () => ({ ok: true, supervisor: supervisor() }));
    const rig = fixture({ launchTerminal: launch });
    await begin(rig);
    const reply = await rig.runner.openTerminal({ sender: rig.sender, instanceId: "grok" });
    expect(reply).toEqual({ ok: true, id: "session-1" });
    expect(rig.order.indexOf("kill-SIGTERM")).toBeGreaterThan(-1);
    expect(rig.killTree.mock.invocationCallOrder[0]).toBeLessThan(launch.mock.invocationCallOrder[0]);
    expect(rig.closed()).toBeUndefined();
  });
  it("from an ended sign-in of the same dialog it starts clean", async () => {
    const launch = vi.fn(async () => ({ ok: true, supervisor: supervisor() }));
    const rig = fixture({ launchTerminal: launch });
    await begin(rig);
    rig.child.emit("close", 1);
    await flush();
    expect((await rig.runner.openTerminal({ sender: rig.sender, instanceId: "grok" })).ok).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
  });
  it("another engine's sign-in stays busy", async () => {
    const launch = vi.fn();
    const rig = fixture({ launchTerminal: launch });
    await begin(rig);
    expect(await rig.runner.openTerminal({ sender: rig.sender, instanceId: "codex" })).toMatchObject({ ok: false, code: "busy" });
    expect(launch).not.toHaveBeenCalled();
    expect(rig.killTree).not.toHaveBeenCalled();
  });
  it("quit during a launch waits for it and stops what it opened", async () => {
    const opened = supervisor();
    let land;
    const launch = vi.fn(() => new Promise((resolve) => { land = resolve; }));
    const rig = fixture({ launchTerminal: launch });
    const pressed = rig.runner.openTerminal({ sender: rig.sender, instanceId: "grok" });
    await flush();
    let quit = false;
    const quitting = rig.runner.shutdown().then(() => { quit = true; });
    await flush();
    expect(quit).toBe(false);
    land({ ok: true, supervisor: opened });
    await quitting;
    expect(opened.stop).toHaveBeenCalled();
    expect(await pressed).toMatchObject({ ok: false, code: "not-open" });
  });
  it("a supervisor that ended and a probe that flipped is Signed in", async () => {
    let alive = true;
    const rig = fixture({ signedIn: [false, true], launchTerminal: async () => ({ ok: true, supervisor: { alive: () => alive, stop: async () => {} } }) });
    await rig.runner.openTerminal({ sender: rig.sender, instanceId: "grok" });
    alive = false;
    await rig.fire(LOCAL_ENGINE_LOGIN_LIMITS.supervisorPollMs);
    await flush();
    expect(rig.closed().result).toBe("signed-in");
  });
  it("the setup terminal path takes the same road and reports a window it could not open", async () => {
    const rig = fixture({ launchTerminal: async () => ({ ok: false, code: "failed" }) });
    expect(await rig.runner.openRecipeTerminal({ instanceId: "grok" })).toBe(false);
    expect(rig.runner.isOpen()).toBe(false);
  });
});

describe("the channels", () => {
  it("answers the main frame alone", async () => {
    const handlers = new Map();
    const runner = { preview: vi.fn(async () => "previewed"), start: vi.fn(), stop: vi.fn(), openTerminal: vi.fn() };
    registerLocalEngineLoginIpc({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, runner });
    const mainFrame = {};
    const event = { sender: { mainFrame }, senderFrame: mainFrame };
    expect(await handlers.get(LOCAL_ENGINE_LOGIN_CHANNELS.preview)(event, { instanceId: "grok" })).toBe("previewed");
    expect(await handlers.get(LOCAL_ENGINE_LOGIN_CHANNELS.preview)({ sender: { mainFrame }, senderFrame: {} }, { instanceId: "grok" })).toMatchObject({ ok: false, code: "bad-request" });
  });
});
