// Copyright 2026 Ferrox Labs
// Supervision cases follow Hermes bridge.reconnect.test.mjs and server/memory/worker-controller.ts behaviour (MIT / AGPL).
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The host is tested two ways: against a real forked fixture child (genuine IPC, spawn flags, kill) and against a
// scripted fake child under fake timers (backoff, deadlines, ordering). Neither touches Baileys or a network.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeHost, BridgeRequestError, type BridgeHostOptions, type ForkFn, type HostLifecycle } from "./bridge-host.ts";
import type { ChildMessage } from "./core/protocol.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "testing", "fixture-child.ts");
const KEY = "ab".repeat(32);

const realSetTimeout = globalThis.setTimeout;
const tick = (ms = 4): Promise<void> => new Promise((resolve) => { realSetTimeout(resolve, ms); });
async function until(condition: () => boolean, label = "condition", limit = 2500): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (condition()) return;
    await tick(4);
  }
  throw new Error(`timed out waiting for ${label}`);
}

let roots: string[] = [];
let hosts: BridgeHost[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hosts.map((h) => h.stop().catch(() => undefined)));
  hosts = [];
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

interface Harness { host: BridgeHost; messages: ChildMessage[]; events: HostLifecycle[]; dir: string; forkCalls: Array<Parameters<ForkFn>> }

function harness(extra: Partial<BridgeHostOptions> = {}, fork?: ForkFn): Harness {
  const dir = mkdtempSync(join(tmpdir(), "murage-wa-host-"));
  roots.push(dir);
  const messages: ChildMessage[] = [];
  const events: HostLifecycle[] = [];
  const forkCalls: Array<Parameters<ForkFn>> = [];
  const host = new BridgeHost({
    connectionId: "c1", dataDir: dir, mode: "self-chat", appVersion: "0.1.64", getAuthKey: () => KEY, script: FIXTURE,
    onMessage: (m) => messages.push(m), onLifecycle: (e) => events.push(e),
    ...(fork ? { fork: ((...args: Parameters<ForkFn>) => { forkCalls.push(args); return fork(...args); }) as ForkFn } : {}),
    ...extra,
  });
  hosts.push(host);
  return { host, messages, events, dir, forkCalls };
}

const states = (h: Harness): string[] => h.messages.filter((m): m is Extract<ChildMessage, { kind: "connection" }> => m.kind === "connection").map((m) => m.state);

describe("with a real forked fixture child", () => {
  it("forks the bridge, hands the key over IPC, and runs the real engine", async () => {
    const h = harness({ env: { WA_FIXTURE_MODE: "engine" } });
    await h.host.start();
    await until(() => states(h).includes("idle") && h.host.status().ready, "initialized idle");
    expect(h.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["spawned", "ready"]));
    expect(h.host.status()).toMatchObject({ ready: true, failures: 0, stopped: false });
    h.host.link("qr");
    await until(() => h.messages.some((m) => m.kind === "qr"), "qr");
    expect(h.messages.find((m) => m.kind === "qr")).toMatchObject({ text: "2@fixture-qr", version: 1 });
    expect(states(h)).toContain("linking");
  });

  it("spawns like the memory worker and keeps the key out of argv and the environment", async () => {
    const calls: Array<Parameters<ForkFn>> = [];
    const { fork } = await import("node:child_process");
    const h = harness({ env: { WA_FIXTURE_MODE: "engine" } }, (...args) => { calls.push(args); return (fork as unknown as ForkFn)(...args); });
    await h.host.start();
    await until(() => states(h).includes("idle") && h.host.status().ready, "initialized idle");
    const [script, args, options] = calls[0];
    expect(script).toBe(FIXTURE);
    expect(options.stdio).toEqual(["ignore", "ignore", "ignore", "ipc"]);
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(options.execArgv).toEqual(["--experimental-strip-types", "--max-old-space-size=512"]);
    expect(JSON.stringify({ script, args, execArgv: options.execArgv, env: options.env })).not.toContain(KEY);
    expect(Object.keys(options.env).sort()).toEqual(expect.arrayContaining(["ELECTRON_RUN_AS_NODE", "WA_FIXTURE_MODE"]));
  });

  it("answers ping with pong: a healthy child is never counted as missing", async () => {
    const h = harness({ env: { WA_FIXTURE_MODE: "engine" }, timings: { pingEveryMs: 40, missLimit: 3 } });
    await h.host.start();
    await until(() => h.host.status().ready, "ready");
    await tick(400);
    expect(h.host.status()).toMatchObject({ misses: 0, ready: true });
    expect(h.events.some((e) => e.kind === "unresponsive")).toBe(false);
  });

  it("kills a child that stops answering pings after three misses", async () => {
    const h = harness({ env: { WA_FIXTURE_MODE: "silent" }, timings: { pingEveryMs: 30, missLimit: 3 } });
    await h.host.start();
    await until(() => h.events.some((e) => e.kind === "unresponsive"), "unresponsive");
    await until(() => h.events.some((e) => e.kind === "exited"), "exited");
    expect(h.events.find((e) => e.kind === "exited")).toMatchObject({ signal: "SIGKILL", respawnInMs: 5000 });
    expect(h.host.status().failures).toBe(1);
  });

  it("kills a child that never says ready", async () => {
    const h = harness({ env: { WA_FIXTURE_MODE: "mute" }, timings: { handshakeMs: 120 } });
    await h.host.start();
    await until(() => h.events.some((e) => e.kind === "handshake-timeout"), "handshake timeout");
    await until(() => h.events.some((e) => e.kind === "exited"), "exited");
  });

  it("notes a crashed child and schedules a respawn", async () => {
    const h = harness({ env: { WA_FIXTURE_MODE: "crash" } });
    await h.host.start();
    await until(() => h.events.some((e) => e.kind === "exited"), "exited");
    expect(h.events.find((e) => e.kind === "exited")).toMatchObject({ code: 3, respawnInMs: 5000 });
    expect(h.host.status().respawnAt).not.toBeNull();
  });

  it("runs reserve and send through the real engine and the fake socket", async () => {
    const h = harness({ env: { WA_FIXTURE_MODE: "engine", WA_FIXTURE_OPEN: "1" } });
    await h.host.start();
    await until(() => states(h).includes("idle") && h.host.status().ready, "initialized idle");
    h.host.link("qr");
    await until(() => states(h).includes("connected"), "connected");
    const ids = await h.host.reserve("15550001111@s.whatsapp.net", { type: "text", text: "hello **there**" });
    expect(ids).toHaveLength(1);
    expect(await h.host.send("15550001111@s.whatsapp.net", ids, { type: "text", text: "hello **there**" })).toEqual(ids);
    await expect(h.host.send("15550001111@s.whatsapp.net", ["NOT-RESERVED"], { type: "text", text: "x" })).rejects.toBeInstanceOf(BridgeRequestError);
  });

  it("answers a query that fails in the child with a typed error", async () => {
    const h = harness({ env: { WA_FIXTURE_MODE: "engine" } });
    await h.host.start();
    await until(() => states(h).includes("idle") && h.host.status().ready, "initialized idle");
    await expect(h.host.groups()).rejects.toMatchObject({ error: { code: "offline" } });
    await expect(h.host.resolve("pn-for-lid", "1@lid")).rejects.toMatchObject({ error: { code: "offline" } });
  });

  it("stop() ends the child cleanly and does not respawn it", async () => {
    const h = harness({ env: { WA_FIXTURE_MODE: "engine" } });
    await h.host.start();
    await until(() => h.host.status().ready, "ready");
    await h.host.stop();
    expect(h.events.some((e) => e.kind === "exited" && e.respawnInMs === null)).toBe(true);
    expect(h.events.at(-1)).toEqual({ kind: "stopped" });
    expect(h.host.status()).toMatchObject({ ready: false, stopped: true, respawnAt: null });
    await h.host.stop(); // a second stop is harmless
  });
});

class FakeChild extends EventEmitter {
  connected = true;
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  sent: Array<Record<string, unknown>> = [];
  send(message: unknown): boolean { this.sent.push(message as Record<string, unknown>); return true; }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean { this.die(null, signal); return true; }
  die(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.connected = false;
    this.emit("exit", code, signal);
  }
  emitMessage(message: unknown): void { this.emit("message", message); }
}

describe("with a scripted fake child (fake timers)", () => {
  let children: FakeChild[];
  const fakeFork: ForkFn = () => { const c = new FakeChild(); children.push(c); return c as unknown as ChildProcess; };

  beforeEach(() => {
    children = [];
    vi.useFakeTimers();
  });

  async function started(extra: Partial<BridgeHostOptions> = {}): Promise<Harness> {
    const h = harness(extra, fakeFork);
    await h.host.start();
    return h;
  }
  async function becomeReady(child: FakeChild): Promise<void> {
    child.emitMessage({ kind: "ready", v: 1 });
    await vi.advanceTimersByTimeAsync(0);
    child.emitMessage({ kind: "initialized" });
  }

  it("sends init after ready with the key from getAuthKey, the extras and the options", async () => {
    const h = await started({ options: { readReceipts: true }, dryRun: true, initExtras: () => ({ lastGoodWebVersion: [2, 3000, 1], lastSeenAtMs: 77 }) });
    await becomeReady(children[0]);
    expect(children[0].sent[0]).toEqual({
      kind: "init", v: 1, connectionId: "c1", dataDir: h.dir, authKeyHex: KEY, mode: "self-chat", appVersion: "0.1.64",
      lastGoodWebVersion: [2, 3000, 1], lastSeenAtMs: 77, options: { readReceipts: true }, dryRun: true,
    });
  });

  it("pings every 10 s and kills the child after three unanswered ticks", async () => {
    const h = await started();
    await becomeReady(children[0]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children[0].sent.filter((m) => m.kind === "ping")).toHaveLength(1);
    children[0].emitMessage({ kind: "pong", n: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children[0].sent.filter((m) => m.kind === "ping")).toHaveLength(2);
    expect(h.host.status().misses).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000); // ping 2 unanswered: miss 1
    await vi.advanceTimersByTimeAsync(10_000); // miss 2
    expect(children[0].signalCode).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000); // miss 3: killed
    expect(children[0].signalCode).toBe("SIGKILL");
    expect(h.events.some((e) => e.kind === "unresponsive")).toBe(true);
  });

  it("respawns with a doubling backoff from 5 s, and resets once a child has been stable for a minute", async () => {
    const h = await started({ timings: { pingEveryMs: 3_600_000 } });
    const exited = (): number[] => h.events.filter((e): e is Extract<HostLifecycle, { kind: "exited" }> => e.kind === "exited").map((e) => e.respawnInMs ?? -1);
    children[0].die(1);
    expect(exited()).toEqual([5000]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(2);
    children[1].die(1);
    expect(exited()).toEqual([5000, 10_000]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children).toHaveLength(3);
    children[2].die(1);
    expect(exited()).toEqual([5000, 10_000, 20_000]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(children).toHaveLength(4);
    await becomeReady(children[3]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.host.status().failures).toBe(0);
    children[3].die(1);
    expect(exited().at(-1)).toBe(5000);
  });

  it("caps the backoff at 30 minutes", async () => {
    const h = await started();
    for (let i = 0; i < 12; i++) {
      children.at(-1)!.die(1);
      const last = h.events.filter((e): e is Extract<HostLifecycle, { kind: "exited" }> => e.kind === "exited").at(-1)!;
      await vi.advanceTimersByTimeAsync(last.respawnInMs ?? 0);
    }
    const last = h.events.filter((e): e is Extract<HostLifecycle, { kind: "exited" }> => e.kind === "exited").at(-1)!;
    expect(last.respawnInMs).toBe(30 * 60_000);
  });

  it("a key that cannot be produced is a failed start with backoff, and nothing is sent", async () => {
    const h = await started({ getAuthKey: () => { throw new Error("credential store unavailable"); } });
    await becomeReady(children[0]);
    expect(h.events.find((e) => e.kind === "key-unavailable")).toEqual({ kind: "key-unavailable", respawnInMs: 5000 });
    expect(children[0].sent).toEqual([]);
    expect(children[0].signalCode).toBe("SIGKILL");
  });

  it("rejects a pending send as uncertain when the child dies, and a pending reserve as offline", async () => {
    const h = await started();
    await becomeReady(children[0]);
    const reserve = h.host.reserve("c", { type: "text", text: "x" });
    const sending = h.host.send("c", ["A"], { type: "text", text: "x" });
    const reserveCheck = expect(reserve).rejects.toMatchObject({ error: { code: "offline" } });
    const sendCheck = expect(sending).rejects.toMatchObject({ error: { code: "timeout", uncertain: true } });
    children[0].die(1);
    await reserveCheck;
    await sendCheck;
  });

  it("applies per-call deadlines: reserve 15 s, send 5 min, queries 30 s; a send timeout is uncertain", async () => {
    const h = await started({ timings: { pingEveryMs: 3_600_000 } });
    await becomeReady(children[0]);
    const reserve = h.host.reserve("c", { type: "text", text: "x" });
    const reserveCheck = expect(reserve).rejects.toMatchObject({ error: { code: "timeout" } });
    await vi.advanceTimersByTimeAsync(15_000);
    await reserveCheck;
    const sending = h.host.send("c", ["A"], { type: "text", text: "x" });
    const sendCheck = expect(sending).rejects.toMatchObject({ error: { code: "timeout", uncertain: true } });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await sendCheck;
    const query = h.host.groups();
    const queryCheck = expect(query).rejects.toMatchObject({ error: { code: "timeout" } });
    await vi.advanceTimersByTimeAsync(30_000);
    await queryCheck;
  });

  it("routes each response to its own request and delivers everything else to onMessage", async () => {
    const h = await started();
    await becomeReady(children[0]);
    const a = h.host.reserve("c", { type: "text", text: "x" });
    const b = h.host.groups();
    const sent = children[0].sent.filter((m) => m.kind === "reserve" || m.kind === "groups") as Array<{ kind: string; reqId: string }>;
    children[0].emitMessage({ kind: "result", reqId: sent[1].reqId, ok: true, value: [{ jid: "g@g.us", subject: "G", size: 3 }] });
    children[0].emitMessage({ kind: "reserved", reqId: sent[0].reqId, ids: ["ID1"] });
    expect(await a).toEqual(["ID1"]);
    expect(await b).toEqual([{ jid: "g@g.us", subject: "G", size: 3 }]);
    children[0].emitMessage({ kind: "inbound", seq: 1, envelope: { messageId: "M", chatJid: "c", fromMe: true, timestampMs: 1, upsertType: "notify", mentionedJids: [] } });
    children[0].emitMessage({ kind: "bogus" });
    children[0].emitMessage({ kind: "pong", n: 1 });
    expect(h.messages.map((m) => m.kind)).toEqual(["inbound"]);
  });

  it("a send that fails after part of a reply carries the ids that went out", async () => {
    const h = await started();
    await becomeReady(children[0]);
    const sending = h.host.send("c", ["A", "B"], { type: "text", text: "x" });
    const check = expect(sending).rejects.toMatchObject({ sentIds: ["A"], error: { uncertain: true } });
    const req = children[0].sent.find((m) => m.kind === "send") as { reqId: string };
    children[0].emitMessage({ kind: "send-result", reqId: req.reqId, ok: false, error: { code: "forbidden", message: "partial: no", uncertain: true }, sentIds: ["A"] });
    await check;
  });

  it("refuses requests while the child is not ready, and fire-and-forget calls report whether they were delivered", async () => {
    const h = await started();
    await expect(h.host.reserve("c", { type: "text", text: "x" })).rejects.toMatchObject({ error: { code: "offline" } });
    expect(h.host.ack(1)).toBe(true);
    children[0].connected = false;
    expect(h.host.ack(1)).toBe(false);
    await expect(h.host.link("qr")).rejects.toBeInstanceOf(BridgeRequestError);
  });

  it("sends the fire-and-forget messages in their documented shapes", async () => {
    const h = await started();
    await becomeReady(children[0]);
    h.host.link("code", "15550001111");
    h.host.ack(9);
    h.host.replay();
    const logout = h.host.logout();
    children[0].emitMessage({ kind: "result", reqId: "r1", ok: true });
    await logout;
    h.host.presence("c", "composing");
    h.host.read([{ remoteJid: "c", id: "1" }]);
    expect(children[0].sent.slice(1)).toEqual([
      { kind: "link", method: "code", phone: "15550001111" }, { kind: "ack", seq: 9 }, { kind: "replay" }, { kind: "logout", reqId: "r1" },
      { kind: "presence", chatId: "c", state: "composing" }, { kind: "read", keys: [{ remoteJid: "c", id: "1" }] },
    ]);
  });

  it("stop() asks the child to stop, kills it after the grace period if it lingers, and never respawns", async () => {
    const h = await started();
    await becomeReady(children[0]);
    const stopping = h.host.stop();
    expect(children[0].sent.at(-1)).toEqual({ kind: "stop" });
    await vi.advanceTimersByTimeAsync(2000);
    await stopping;
    expect(children[0].signalCode).toBe("SIGKILL");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(children).toHaveLength(1);
  });

  it.each(["false", "throw", "error", "delayed"])("requires confirmed exit when kill returns %s", async mode => {
    const h = await started({ timings: { stopGraceMs: 20 } });
    const child = children[0];
    child.kill = () => {
      if (mode === "throw") throw new Error("kill refused");
      if (mode === "error") child.emit("error", new Error("kill refused"));
      return mode === "delayed";
    };
    let settled = false;
    const stopping = h.host.stop();
    const outcome = stopping.then(() => { settled = true; return null; }, error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(20);
    expect(settled).toBe(false);
    expect(h.host.status().pid).toBe(child.pid);
    if (mode === "delayed") {
      child.die(0); expect(await outcome).toBeNull();
    } else {
      await vi.advanceTimersByTimeAsync(20);
      expect(await outcome).toBeInstanceOf(Error);
      expect(h.host.status().pid).toBe(child.pid);
      await expect(h.host.start()).rejects.toThrow();
      expect(children).toHaveLength(1);
      child.die(0); await h.host.stop();
    }
  });
});

 it("holds a fresh link until initialization is acknowledged", async () => {
  const child = new FakeChild(); const h = harness({}, () => child as unknown as ChildProcess);
  await h.host.start();
  const linking = h.host.link("qr");
  child.emitMessage({ kind: "ready", v: 1 }); await tick();
  expect(child.sent.some(m => m.kind === "init")).toBe(true);
  expect(child.sent.some(m => m.kind === "link")).toBe(false);
  child.emitMessage({ kind: "initialized" });
  expect(await linking).toBe(true);
  expect(child.sent.at(-1)).toEqual({ kind: "link", method: "qr" });
});

it("reports spawn errors without waiting for an exit event", async () => {
  const child = new FakeChild(); child.connected = false; child.pid = undefined;
  const h = harness({}, () => child as unknown as ChildProcess);
  await h.host.start(); child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
  expect(h.events).toContainEqual({ kind: "spawn-error" });
  expect(h.host.status().ready).toBe(false); expect(h.host.status().pid).toBeUndefined();
  await h.host.stop();
});
it("bounds host cleanup when killing produces no exit event", async () => {
  const child = new FakeChild(); child.kill = () => false;
  const h = harness({ timings: { stopGraceMs: 5 } }, () => child as unknown as ChildProcess);
  await h.host.start(); await expect(h.host.stop()).rejects.toThrow("exit is not confirmed");
  expect(h.host.status().pid).toBe(child.pid);
  child.die(0); await h.host.stop();
}, 1000);
