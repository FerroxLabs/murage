// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: the chat MCP descendant stop (chat-mcp-client.ts ChatMcpDescendants.ready) and the server's shutdown allowance
// (graceful-shutdown.ts SERVER_SHUTDOWN_TIMEOUT_MS). Off Linux a stop waits for a full `ps` listing before it ends a mount
// server's stdin and signals its process group, so a descendant that left the group is still found. That wait is as long as the
// whole shutdown allowance. At Quit the server exits when the allowance ends: a listing that has not answered by then meant the
// stdin end and the group signal were never sent, and the detached mount servers outlived Murage. Quit never waits on a listing.
// The process table here is a fixture (the `ps` child is replaced); the shutdown, the stop and the relay are the real ones.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";

type PsCallback = (error: Error | null, stdout: string, stderr: string) => void;
const ps = vi.hoisted(() => ({ calls: [] as string[][], delayMs: 0, rows: [] as string[], alive: new Map<number, string>() }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      if (args[0] !== "ps") return Reflect.apply(actual.execFile, actual, args);
      const argv = args[1] as string[];
      const callback = args[args.length - 1] as PsCallback;
      ps.calls.push(argv);
      const rows = argv.includes("-A") ? ps.rows : argv[argv.indexOf("-p") + 1]!.split(",").map(Number)
        .map((pid) => ps.alive.get(pid)).filter((row): row is string => row !== undefined);
      setTimeout(() => callback(null, rows.join("\n") + "\n", ""), argv.includes("-A") ? ps.delayMs : 0).unref();
      return {};
    },
  };
});
vi.mock("../procs.ts", async (original) => ({
  ...await original<typeof import("../procs.ts")>(),
  killCliTree: vi.fn(), awaitCliTreeStopped: async () => true,
  cliTreeStoppedSignal: () => new Promise<true>(() => {}),
}));
import * as procs from "../procs.ts";
import { createGracefulShutdown, SERVER_SHUTDOWN_TIMEOUT_MS } from "../graceful-shutdown.ts";
import { CHAT_MCP_SNAPSHOT_CAP_MS, ChatMcpDescendants } from "./chat-mcp-client.ts";
import { CliMountRelay } from "./cli-mount-relay.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { createTurnCredentialStore } from "./turn-credentials.ts";
import { resetServerQuitForTest } from "../quit-latch.ts";
import type { SendTurnInput } from "../contracts.ts";

const ROOT = 4_100_001;
const ESCAPED = 4_100_002;
const START = "Sat Nov 21 11:00:00 2026";
const realPlatform = process.platform;
const cleanups: Array<() => void | Promise<unknown>> = [];

beforeEach(() => {
  ps.calls.length = 0;
  ps.delayMs = 0;
  ps.rows = [`${ROOT} 1 ${START} mcp-server`];
  ps.alive.clear();
  vi.mocked(procs.killCliTree).mockClear();
  vi.spyOn(process, "kill").mockImplementation((() => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); }) as typeof process.kill);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  resetServerQuitForTest();
  vi.restoreAllMocks();
});

/** One mount server as a stop sees it: its stdin and its process group. */
function mountServer(events: Array<{ what: string; atMs: number }>, began: () => number) {
  const stdin = new PassThrough();
  const child = { pid: ROOT, stdin } as unknown as ChildProcess;
  const descendants = new ChatMcpDescendants(child, "darwin");
  // what ChatMcpConnection and the relay do at a stop (cli-mount-relay.ts settle): stdin ends and the group is signalled only once
  // ready() resolved
  const end = async () => {
    await descendants.ready();
    stdin.end(); events.push({ what: "stdin-end", atMs: Date.now() - began() });
    events.push({ what: "group-signal", atMs: Date.now() - began() });
  };
  return { stdin, child, descendants, end };
}
/** The real shutdown at its real allowance; resolves when it calls exit. */
function quit(cleanup: Array<() => void | Promise<void>>, events: Array<{ what: string; atMs: number }>, began: number): Promise<void> {
  return new Promise<void>((resolve) => {
    createGracefulShutdown({ cleanup, exit: () => { events.push({ what: "exit", atMs: Date.now() - began }); resolve(); } })();
  });
}

it("the listing wait is as long as the shutdown allowance (why a Quit must not wait on it)", () => {
  expect(CHAT_MCP_SNAPSHOT_CAP_MS).toBeGreaterThanOrEqual(SERVER_SHUTDOWN_TIMEOUT_MS);
});

it("Quit with the process list still outstanding: stdin ends and the group is signalled at once, before the server exits", async () => {
  ps.delayMs = 60_000;
  const events: Array<{ what: string; atMs: number }> = [];
  const began = Date.now();
  const server = mountServer(events, () => began);
  await quit([() => server.end()], events, began);
  expect(events.map((event) => event.what)).toEqual(["stdin-end", "group-signal", "exit"]);
  expect(events[0]!.atMs).toBeLessThan(1_000);
  expect(server.stdin.writableEnded).toBe(true);
  // nothing confirms what no listing showed: the stop stays unconfirmed (fail closed), it is only never waited for at Quit
  expect(await server.descendants.stop()).toBe(false);
}, 20_000);

it("a Stop already waiting for its process list is released the moment Quit begins", async () => {
  ps.delayMs = 60_000;
  const events: Array<{ what: string; atMs: number }> = [];
  let quitAt = 0;
  const server = mountServer(events, () => quitAt);
  const stopping = server.end();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(events).toEqual([]);
  quitAt = Date.now();
  await quit([() => stopping], events, quitAt);
  expect(events.map((event) => event.what)).toEqual(["stdin-end", "group-signal", "exit"]);
  // not at the end of the stop's own listing bound (which here ends just inside the allowance): at once
  expect(events[0]!.atMs).toBeLessThan(1_000);
  expect(await server.descendants.stop()).toBe(false);
}, 20_000);

it("a stop that begins after Quit began does not start waiting for a listing either", async () => {
  ps.delayMs = 60_000;
  const events: Array<{ what: string; atMs: number }> = [];
  const began = Date.now();
  const server = mountServer(events, () => began);
  // the shutdown's own cleanup job is slow to reach this server's stop
  const exited = quit([async () => { await new Promise((resolve) => setTimeout(resolve, 200)); await server.end(); }], events, began);
  await exited;
  expect(events.map((event) => event.what)).toEqual(["stdin-end", "group-signal", "exit"]);
  expect(events[2]!.atMs).toBeLessThan(1_000);
}, 20_000);

it("with no Quit a stop still waits for its slow process list, and confirms on it", async () => {
  ps.delayMs = 700;
  const events: Array<{ what: string; atMs: number }> = [];
  const began = Date.now();
  const server = mountServer(events, () => began);
  await server.end();
  expect(events[0]!.atMs).toBeGreaterThanOrEqual(650);
  expect(await server.descendants.stop()).toBe(true);
}, 20_000);

it("the real mount relay at Quit: the mount server's stdin is ended and its tree killed before the server exits, list or no list", async () => {
  ps.delayMs = 60_000;
  const f = consumingFixture(undefined, { botId: randomUUID() }); cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "isolated", warmIdentity: { botId: f.binding.identity.botId, audience: "owner" }, releaseBinding: f.binding, mountAdmission: admission };
  const children: ChildProcess[] = [];
  const spawn = vi.fn((_command: string, _args: string[], env: Record<string, string>) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: ROOT, exitCode: null, signalCode: null, connected: Boolean(env.MURAGE_RELEASE_INSTANCE),
      send: vi.fn((_message: unknown, callback: (error: Error | null) => void) => { callback(null); return true; }),
    }) as unknown as ChildProcess;
    children.push(child); return child;
  });
  // the relay builds its own ChatMcpDescendants for the running platform: off Linux its snapshot is the `ps` listing
  Object.defineProperty(process, "platform", { value: "darwin" });
  const relay = await CliMountRelay.create(turn, { one: { command: "fixture-mcp", args: [], env: {} } }, { one: { MURAGE_COMMS_TOKEN: "turn-secret" } }, cred, spawn);
  cleanups.push(() => relay.finish());
  const cli = Object.assign(new EventEmitter(), { stdin: new PassThrough(), pid: undefined, exitCode: null, signalCode: null }) as unknown as ChildProcess;
  const events: Array<{ what: string; atMs: number }> = [];
  const began = Date.now();
  vi.mocked(procs.killCliTree).mockImplementation((child) => { events.push({ what: child === cli ? "engine-kill" : "mount-kill", atMs: Date.now() - began }); });
  children[0]!.stdin!.once("finish", () => events.push({ what: "mount-stdin-end", atMs: Date.now() - began }));
  // a Quit disposes the engine; its relay stop is one of the shutdown's cleanup jobs
  await quit([async () => { await relay.finish(cli); }], events, began);
  expect(ps.calls.some((argv) => argv.includes("-A"))).toBe(true);
  const order = events.map((event) => event.what);
  expect(order).toContain("mount-kill");
  expect(order).toContain("mount-stdin-end");
  expect(order.indexOf("mount-kill")).toBeLessThan(order.indexOf("exit"));
  expect(order.indexOf("mount-stdin-end")).toBeLessThan(order.indexOf("exit"));
  expect(events.find((event) => event.what === "mount-kill")!.atMs).toBeLessThan(1_000);
}, 30_000);

/** A server whose descendant left its process group (setsid): the group signal never reaches it, only a listing finds it. The
 *  fixture pids are not real: a signal to one is recorded and ends it, existence follows the fixture table. */
function escapedDescendant(): Array<{ pid: number; signal: string | number | undefined }> {
  ps.rows.push(`${ESCAPED} ${ROOT} ${START} escaped-daemon`);
  ps.alive.set(ESCAPED, `${ESCAPED} ${ROOT} ${START} escaped-daemon --serve`);
  const killed: Array<{ pid: number; signal: string | number | undefined }> = [];
  vi.mocked(process.kill).mockImplementation(((pid: number, signal?: string | number) => {
    if (signal === 0 || signal === undefined) {
      if (ps.alive.has(pid)) return true;
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }
    killed.push({ pid, signal });
    ps.alive.delete(pid);
    return true;
  }) as typeof process.kill);
  return killed;
}

it("Quit: the signal goes out at once, and a listing that answers afterwards while the server still runs still finds the escaped descendant and confirms", async () => {
  ps.delayMs = 700;
  const killed = escapedDescendant();
  const events: Array<{ what: string; atMs: number }> = [];
  const began = Date.now();
  const server = mountServer(events, () => began);
  let confirmed: boolean | undefined;
  await quit([async () => { await server.end(); confirmed = await server.descendants.stop(); }], events, began);
  expect(events.map((event) => event.what)).toEqual(["stdin-end", "group-signal", "exit"]);
  // the stdin end and the group signal never waited for the listing
  expect(events[0]!.atMs).toBeLessThan(500);
  // the server here ignores both (it still runs when the listing answers): the descendant it started outside the group is ended
  expect(killed).toEqual([{ pid: ESCAPED, signal: "SIGTERM" }]);
  expect(confirmed).toBe(true);
}, 20_000);

it("Quit: a listing that answers only after the server exited never confirms (the descendants may no longer hang off it)", async () => {
  ps.delayMs = 700;
  escapedDescendant();
  const events: Array<{ what: string; atMs: number }> = [];
  const began = Date.now();
  const server = mountServer(events, () => began);
  let confirmed: boolean | undefined;
  await quit([async () => {
    await server.end();
    // the server ends on its stdin end, before the listing answers
    Object.assign(server.child, { exitCode: 0 });
    confirmed = await server.descendants.stop();
  }], events, began);
  expect(events.map((event) => event.what)).toEqual(["stdin-end", "group-signal", "exit"]);
  expect(confirmed).toBe(false);
}, 20_000);

it("Quit: a descendant an earlier snapshot remembered is signalled at once, never held on the stop's outstanding listing", async () => {
  const killed = escapedDescendant();
  const events: Array<{ what: string; atMs: number }> = [];
  const began = Date.now();
  const server = mountServer(events, () => began);
  // a snapshot after startup answered and remembered it; the stop's own listing then never answers
  server.descendants.track();
  await vi.waitFor(() => expect(ps.calls.filter((argv) => argv.includes("-A"))).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  ps.delayMs = 60_000;
  let signalledAtExit: typeof killed = [];
  await new Promise<void>((resolve) => {
    createGracefulShutdown({
      cleanup: [async () => { await server.end(); await server.descendants.stop(); }],
      exit: () => { signalledAtExit = [...killed]; resolve(); },
    })();
  });
  expect(signalledAtExit).toEqual([{ pid: ESCAPED, signal: "SIGTERM" }]);
}, 20_000);
