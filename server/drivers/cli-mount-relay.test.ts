import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { connect, Socket } from "node:net";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { createProxyReleaseAuthority, frameDigest } from "../consuming-turn-ingress.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createMcpMountAdmission, assertConsumingMountAdmission } from "./mcp-mounts.ts";
import { createTurnCredentialStore } from "./turn-credentials.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { cloudMcpStanza, CLOUD_MCP_PROXIES } from "../cloud-home/engine-render.ts";
import type { SendTurnInput } from "../contracts.ts";
import * as procs from "../procs.ts";
import { CHAT_MCP_SNAPSHOT_CAP_MS, ChatMcpDescendants, openChatMcpServers } from "./chat-mcp-client.ts";

const stop = vi.hoisted(() => ({ confirmed: true }));
vi.mock("../procs.ts", async original => ({
  ...await original<typeof import("../procs.ts")>(),
  killCliTree: vi.fn(), awaitCliTreeStopped: async () => stop.confirmed,
  cliTreeStoppedSignal: () => new Promise<true>(() => {}),
}));
// A base checkout fails an assertion, not module loading.
const api = existsSync(new URL("./cli-mount-relay.ts", import.meta.url)) ? await import("./cli-mount-relay.ts") : undefined;
function relayApi() {
  expect(api?.CliMountRelay, "S1 must provide the server-owned relay").toBeTypeOf("function");
  return api!;
}
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { stop.confirmed = true; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const custom = { command: "fixture-mcp", args: [], env: {} };
function fixture(pid?: number) {
  const f = consumingFixture(undefined, { botId: randomUUID() }); cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(caps);
  const admission = createMcpMountAdmission(f.binding, authority, "http://127.0.0.1:1");
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "isolated", warmIdentity: { botId: f.binding.identity.botId, audience: "owner" }, releaseBinding: f.binding, mountAdmission: admission };
  const children: ChildProcess[] = [];
  const envs: Record<string, string>[] = [];
  const spawn = vi.fn((_command: string, _args: string[], env: Record<string, string>) => {
    envs.push(env);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid, exitCode: null, signalCode: null, connected: Boolean(env.MURAGE_RELEASE_INSTANCE),
      send: vi.fn((_message: unknown, callback: (error: Error | null) => void) => { callback(null); return true; }),
    }) as unknown as ChildProcess;
    children.push(child); return child;
  });
  const create = async (servers: Record<string, unknown> = { one: custom }) => {
    const relay = await relayApi().CliMountRelay.create(turn, servers, { one: { MURAGE_COMMS_TOKEN: "turn-secret" } }, cred, spawn);
    cleanups.push(() => relay.finish()); return relay;
  };
  return { f, caps, authority, admission, cred, turn, children, envs, spawn, create };
}
async function socketFor(relay: import("./cli-mount-relay.ts").CliMountRelay,
  server = "one", ticket = relay.ticket): Promise<Socket> {
  const socket = connect(relay.socketPath); cleanups.push(() => { socket.destroy(); });
  socket.on("error", () => {}); await once(socket, "connect");
  socket.write(JSON.stringify({ ticket, server }) + "\n"); return socket;
}
const request = (id: number, method = "tools/list") => JSON.stringify({ jsonrpc: "2.0", id, method });

describe("S1 admitted relay", () => {
  it("T-S1-SHIM-TRANSPORT: the real shim authenticates from the credential file and relays accepted bytes", async () => {
    const x = fixture(); const relay = await x.create();
    const spec = relay.servers.one as { command: string; args: string[]; env: Record<string, string> };
    const shim = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<void>(resolve => shim.once("close", () => resolve()));
    cleanups.push(async () => { await relay.finish(); shim.kill(); await exited; });
    shim.stderr.resume();
    const input = once(x.children[0]!.stdin!, "data");
    shim.stdin.write(request(1) + "\n");
    expect((await input)[0].toString()).toBe(request(1) + "\n");
    const output = once(shim.stdout, "data");
    const frame = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}';
    x.children[0]!.stdout!.emit("data", Buffer.from(frame + "\n"));
    expect((await output)[0].toString()).toBe(frame + "\n");
    expect(x.f.refusals).toBe(0);
  });
  it("T-S1-SERVER-SPAWN: the admitted default spawn requests server MCP ownership and IPC", async () => {
    const x = fixture();
    const spawn = vi.spyOn(procs, "spawnCli").mockImplementation((command, args, options) =>
      x.spawn(command, args, options.env as Record<string, string>) as ReturnType<typeof procs.spawnCli>);
    try {
      const relay = await relayApi().CliMountRelay.create(x.turn,
        { one: { command: process.execPath, args: [SPAWNED_PROXIES.memory], env: {} } }, {}, x.cred);
      cleanups.push(() => relay.finish());
      expect(spawn).toHaveBeenCalledOnce();
      expect(spawn.mock.calls[0]![2]).toMatchObject({ stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: { MURAGE_RELEASE_INSTANCE: expect.any(String), MURAGE_RELEASE_TOKEN: expect.any(String) } });
      expect(spawn.mock.calls[0]![4]).toEqual({ serverTool: "mcp" });
    } finally { spawn.mockRestore(); }
  });
  it("T-EXTERNAL-REFUSED: valid dispatcher admission never authorizes external mounts", async () => {
    const x = fixture();
    const relay = await x.create(); // red: no server-owned relay on base
    for (const stanza of Object.values(relay.servers) as any[]) expect(stanza.args[0]).toBe(SPAWNED_PROXIES.cliMountShim);
    expect(() => assertConsumingMountAdmission(x.turn, "external", true)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(x.f.refusals).toBe(1);
  });
  it.each([false, true])("T-ROUNDTRIP: custom/bundled=%s request, acceptance, then IPC ack", async bundled => {
    const x = fixture();
    const relay = await x.create({ one: bundled ? { command: process.execPath, args: [SPAWNED_PROXIES.memory], env: {} } : custom });
    const socket = await socketFor(relay);
    for (const [index, method] of ["initialize", "tools/list", "tools/call"].entries()) {
      const input = once(x.children[0]!.stdin!, "data"); socket.write(request(index + 1, method) + "\n"); await input;
      const frame = JSON.stringify({ jsonrpc: "2.0", id: index + 1, result: {} });
      let wire = frame;
      if (bundled) {
        const env = x.envs[0]!;
        const claim = x.caps.resolve(`Bearer ${env.MURAGE_RELEASE_TOKEN}`)!;
        wire = JSON.stringify(x.authority.verdict(claim, { bytes: Buffer.byteLength(frame), descriptor: "proxy:memory:frame",
          digest: frameDigest(frame), frame, instanceId: env.MURAGE_RELEASE_INSTANCE, requestId: index + 1, sequence: index + 1 }));
      }
      const output = once(socket, "data"); x.children[0]!.stdout!.emit("data", Buffer.from(wire + "\n"));
      expect((await output)[0].toString()).toBe(frame + "\n");
      expect(x.children[0]!.send).toHaveBeenCalledTimes(bundled ? index + 1 : 0);
    }
    await relay.finish(); expect(x.f.refusals).toBe(0);
  });
  it.each(["bundled", "unsolicited", "bad-json"])("T-UNACCEPTED: %s seals with no fallback reply", async kind => {
    const x = fixture();
    const relay = await x.create({ one: kind === "bundled" ? { command: process.execPath, args: [SPAWNED_PROXIES.memory] } : custom });
    const socket = await socketFor(relay); const output: Buffer[] = []; socket.on("data", chunk => output.push(chunk as Buffer));
    x.children[0]!.stdout!.emit("data", Buffer.from(kind === "bad-json" ? "oops\n" : '{"jsonrpc":"2.0","id":1,"result":{}}\n'));
    expect(x.f.refusals).toBe(1); expect(output).toEqual([]);
  });
  it("T-S1-COLD-ORDER: secrets, ticket and release env exist before child spawn", async () => {
    const x = fixture();
    x.spawn.mockImplementationOnce((_command, _args, env) => {
      const file = JSON.parse(readFileSync(x.cred.path, "utf8"));
      expect(file.one.MURAGE_COMMS_TOKEN).toBe("turn-secret");
      expect(file.one.MURAGE_RELAY_TICKET).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(env.MURAGE_RELEASE_INSTANCE).toBeTruthy(); expect(env.MURAGE_RELEASE_TOKEN).toBeTruthy();
      expect(env.MURAGE_RELEASE_URL).toBe("http://127.0.0.1:1");
      return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined }) as unknown as ChildProcess;
    });
    await x.create({ one: { command: process.execPath, args: [SPAWNED_PROXIES.memory], env: {} } });
    expect(x.spawn).toHaveBeenCalledOnce();
  });
  it("T-MOUNTS-64/65: all admission precedes every spawn", async () => {
    const x = fixture();
    await x.create(Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`m${i}`, custom])));
    expect(x.spawn).toHaveBeenCalledTimes(64);
    const y = fixture();
    await expect(y.create(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`m${i}`, custom])))).rejects.toThrow();
    expect(y.spawn).not.toHaveBeenCalled(); expect(y.f.refusals).toBe(1);
  });
  it("T-DRAFT: only a mount-free draft needs no admission", async () => {
    const { mountedTurn } = relayApi();
    const draft: SendTurnInput = { threadId: "draft", text: "draft", draftOnly: true };
    expect(mountedTurn(draft)).toBe(false);
    expect(() => assertConsumingMountAdmission(draft, "server")).not.toThrow();
    const connected = { ...draft, integrations: { memory: { command: "fixture", args: [], env: {} } } };
    expect(mountedTurn(connected)).toBe(true);
    expect(() => assertConsumingMountAdmission(connected, "server")).toThrow("MEMORY_CONTEXT_REVOKED");
  });
  it("T-RACE-2: a retired child's late stdout never reaches the next relay", async () => {
    const x = fixture(); const first = await x.create(); await first.finish();
    const y = fixture(); const second = await y.create();
    const socket = await socketFor(second); const output: Buffer[] = []; socket.on("data", chunk => output.push(chunk as Buffer));
    x.children[0]!.stdout!.emit("data", Buffer.from(request(5) + "\n"));
    expect(output).toEqual([]); expect(x.f.refusals).toBe(0); expect(y.f.refusals).toBe(0);
  });
  it("T-CLOUD-RELAY: strangers cannot refuse; authenticated duplicates seal", async () => {
    const x = fixture(); const relay = await x.create();
    expect(CLOUD_MCP_PROXIES.relay).toEqual({ script: "drivers/cli-mount-shim", arg: "server", env: ["MURAGE_RELAY_TICKET", "MURAGE_RELAY_SOCKET"] });
    const bad = await socketFor(relay, "one", "bad"); await once(bad, "close"); expect(x.f.refusals).toBe(0);
    const socket = await socketFor(relay); const input = once(x.children[0]!.stdin!, "data"); socket.write(request(1) + "\n"); await input;
    const duplicate = await socketFor(relay); await once(duplicate, "close"); expect(x.f.refusals).toBe(1);
    // The actual Python mount plan is covered by T-S1-BROKER-BIND.
  });
  it("T-CLOUD-CODEX-ONE-TICKET: equal env, distinct names, unknown name cannot refuse", async () => {
    const x = fixture(); const relay = await x.create({ one: custom, two: custom });
    const ticket = JSON.parse(readFileSync(x.cred.path, "utf8"));
    expect(ticket.one.MURAGE_RELAY_TICKET).toBe(ticket.two.MURAGE_RELAY_TICKET);
    expect(ticket.one.MURAGE_RELAY_SOCKET).toBe(ticket.two.MURAGE_RELAY_SOCKET);
    for (const name of ["one", "two"]) {
      const stanza = cloudMcpStanza({ ...(relay.servers[name] as object), env: ticket[name] }, { mounted: true });
      expect(stanza).toEqual({ proxy: "relay", server: name, env: { MURAGE_RELAY_TICKET: relay.ticket, MURAGE_RELAY_SOCKET: relay.socketPath } });
      const socket = await socketFor(relay, name);
      const target = x.children[name === "one" ? 0 : 1]!; const input = once(target.stdin!, "data");
      socket.write(request(1) + "\n"); expect((await input)[0].toString()).toBe(request(1) + "\n");
    }
    const unknown = await socketFor(relay, "unknown"); await once(unknown, "close"); expect(x.f.refusals).toBe(0);
  });
  it("T-CLOUD-REFUSED: mounted raw stdio and URL are refused before render", () => {
    expect(() => cloudMcpStanza(custom, { mounted: true })).toThrow("MEMORY_CONTEXT_REVOKED"); // red: base silently returns null
    expect(() => cloudMcpStanza({ type: "http", url: "https://example.invalid" }, { mounted: true })).toThrow("MEMORY_CONTEXT_REVOKED");
  });
  it.each(["retire", "kill", "confirmation", "clear", "dispose", "admission", "close"])("T-H5-FINALLY: fault at %s cannot skip later cleanup", async step => {
    const x = fixture(); const relay = await x.create();
    const clear = vi.spyOn(x.cred, "clear"); const dispose = vi.spyOn(x.cred, "dispose"); const close = vi.spyOn(relay, "close");
    // Admission is frozen; inject its failure through the owning turn instead.
    const admission = vi.fn(() => x.admission.dispose()); Object.defineProperty(x.turn, "mountAdmission", { value: { ...x.admission, dispose: admission } });
    const fail = () => { throw new Error("injected"); };
    if (step === "retire") vi.spyOn(relay, "retire").mockImplementationOnce(fail);
    if (step === "kill") vi.mocked(procs.killCliTree).mockImplementationOnce(fail);
    const confirmation = step === "confirmation" ? vi.spyOn(procs, "awaitCliTreeStopped").mockRejectedValueOnce(new Error("injected")) : undefined;
    if (step === "clear") clear.mockImplementationOnce(fail);
    if (step === "dispose") dispose.mockImplementationOnce(fail);
    if (step === "admission") admission.mockImplementationOnce(fail);
    if (step === "close") close.mockImplementationOnce(fail);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await relay.finish(x.children[0]);
    if (step === "clear") expect(warning).toHaveBeenCalledWith("[mount-relay] credential clear failed");
    warning.mockRestore();
    confirmation?.mockRestore();
    expect(clear).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce(); expect(admission).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    close.mockRestore(); relay.close(); dispose.mockRestore(); x.cred.dispose();
  });
  it("T-TEARDOWN-FAIL: unconfirmed CLI stop quarantines the bot and clears credentials", async () => {
    const x = fixture(); const relay = await x.create(); stop.confirmed = false;
    expect(await relay.finish(x.children[0])).toBe(false);
    expect(existsSync(x.cred.path)).toBe(false);
    expect(() => relayApi().assertRelayAvailable(x.turn)).toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
  });
  it("T-A3F-STOP-CONFIRM-MUTANT: a closed CLI without tree confirmation cannot launch another mounted turn", async () => {
    const x = fixture(); const relay = await x.create();
    const cli = x.children[0]!;
    stop.confirmed = false;
    // Root exit is not positive confirmation of its whole tree. This remains
    // refused even though the fake presents the normal exit/close events.
    cli.emit("exit", 0, null);
    cli.emit("close", 0, null);
    expect(await relay.finish(cli)).toBe(false);
    expect(() => relayApi().assertRelayAvailable(x.turn)).toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
    const next = fixture();
    const turn = { ...next.turn, warmIdentity: x.turn.warmIdentity };
    await expect(relayApi().CliMountRelay.create(turn, { one: custom }, {}, next.cred, next.spawn))
      .rejects.toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
    expect(next.spawn).not.toHaveBeenCalled();
  });
  it("RR1 nlrace: an unproven MCP stop holds the bot, a later proof from the bounded recovery releases it, and the next turn then spawns", async () => {
    const stopMod = await import("./mcp-stop-runtime.ts");
    const root = 424242;
    const rows = { alive: true };
    const table = (): import("./mcp-stop-proof.ts").DesktopRow[] => (rows.alive ? [{ pid: root, ppid: 1, start: "proc:424242", startKind: "proc", state: "S", threads: 1 }] : []);
    const probes: Array<(rec: import("./mcp-stop-proof.ts").StopRecord) => import("./mcp-stop-recovery.ts").ProbeOutcome> = [];
    const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
    let now = 0;
    stopMod.configureMcpStop({
      ownerHeld: (owner, key) => relayApi().holdRecordOwner(owner, key), ownerReleased: (owner, key) => relayApi().releaseRecordOwner(owner, key),
      targetDeps: {
        desktopEnv: (platform) => ({ platform, bootId: async () => "b", pidns: async () => "pid:[1]", visibility: async () => ({ hidepid: false, sameNs: true }), table: async () => table() }),
        signalEnv: (platform) => ({ platform, identity: async () => "absent", kill: () => {}, residual: () => {} }),
      },
      recoveryDeps: {
        clock: { now: () => now, setTimeout: (fn, ms) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; } },
        launch: (rec) => { const out = (probes.shift() ?? (() => ({ v: "unknown" as const, why: "x" })))(rec); return { result: Promise.resolve(out), kill() {}, alive: () => false, exited: Promise.resolve() }; },
        reKill: async () => { rows.alive = false; },
      },
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cliGone = vi.spyOn(procs, "cliTreeStoppedSignal").mockResolvedValue(true);
    try {
      const x = fixture(root); const relay = await x.create();
      expect(await relay.finish(x.children[0])).toBe(false);
      expect(() => relayApi().assertRelayAvailable(x.turn), "unproven: the bot stays refused").toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
      rows.alive = false; probes.push(() => ({ v: "gone" }));
      x.children[0]!.emit("close", 0, null);
      const held = relayApi().relayHoldReleased(x.turn, 10_000);
      expect(held).not.toBeNull();
      for (let i = 0; i < 5 && timers.some((t) => t.live); i++) { const t = timers.filter((c) => c.live).sort((a, b) => a.at - b.at)[0]!; t.live = false; now = t.at; t.fn(); await new Promise<void>((r) => setImmediate(r)); }
      await held;
      expect(() => relayApi().assertRelayAvailable(x.turn), "a proof released the bot").not.toThrow();
      const next = fixture();
      const again = await relayApi().CliMountRelay.create({ ...next.turn, warmIdentity: x.turn.warmIdentity }, { one: custom }, {}, next.cred, next.spawn);
      cleanups.push(() => again.finish());
      expect(next.spawn).toHaveBeenCalled();
    } finally { warning.mockRestore(); cliGone.mockRestore(); stopMod.resetMcpStopForTests(); }
  }, 30_000);
  it("N705 captureBeforeStop at its snapshot cap stays UNKNOWN and refuses the owner", async () => {
    const runtime = await import("./mcp-stop-runtime.ts");
    let release!: (value: boolean) => void;
    const held = new Promise<boolean>(resolve => { release = resolve; });
    let signal: AbortSignal | undefined;
    const prove = vi.fn(async () => ({ v: "gone" as const }));
    const target = vi.spyOn(runtime.McpStopLifecycle.prototype, "target").mockImplementation(function (this: import("./mcp-stop-runtime.ts").McpStopLifecycle) {
      return { record: this.record, track: async () => {}, capture: abort => { signal = abort; return held; },
        prove, kill: async () => {} };
    });
    runtime.configureMcpStop({ recoveryDeps: {
      clock: { now: () => 0, setTimeout: () => () => {} },
      launch: () => ({ result: new Promise(() => {}), kill() {}, alive: () => false, exited: Promise.resolve() }),
      reKill: async () => {},
    } });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let finishing: Promise<boolean> | undefined;
    try {
      const x = fixture(424242); const relay = await x.create();
      vi.useFakeTimers();
      let captured = false, stopped: boolean | null = null;
      const capture = relay.captureBeforeStop().then(() => { captured = true; });
      finishing = relay.finish().then(ok => { stopped = ok; return ok; });
      x.children[0]!.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(CHAT_MCP_SNAPSHOT_CAP_MS - 1);
      expect(captured, "capture is still held just before the bound").toBe(false);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await capture;
      expect(captured, "capture wait ends exactly at the existing bound").toBe(true);
      expect(signal?.aborted, "the capture read is aborted at the bound").toBe(true);
      expect(stopped, "the cap cannot certify a stop").not.toBe(true);
      expect(() => relayApi().assertRelayAvailable(x.turn), "UNKNOWN refuses the owner at the bound")
        .toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
      release(true);
      await vi.advanceTimersByTimeAsync(procs.CLI_CALLER_DEADLINE_MS);
      expect(await finishing, "even a late capture and a gone proof cannot erase the UNKNOWN").toBe(false);
      expect(prove).not.toHaveBeenCalled();
      const next = fixture();
      await expect(relayApi().CliMountRelay.create({ ...next.turn, warmIdentity: x.turn.warmIdentity },
        { one: custom }, {}, next.cred, next.spawn)).rejects.toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
      expect(next.spawn).not.toHaveBeenCalled();
    } finally {
      release(false);
      await vi.advanceTimersByTimeAsync(procs.CLI_CALLER_DEADLINE_MS);
      await finishing;
      vi.useRealTimers(); target.mockRestore(); warning.mockRestore(); runtime.resetMcpStopForTests();
    }
  });
  // MC63 ruling A (2026-11-17): one relay stop is ONE pre-stop capture request. Under load every helper spawn is slow; the fake helpers
  // below start one after another (each costs SPAWN_MS after the previous one), the way a contended machine starts node children.
  const SPAWN_MS = 300;
  function slowHelpers(children: () => ChildProcess[], stallCaptureMany = false, stallWalksAfter = Infinity, proofSpawnMs = SPAWN_MS) {
    const events: string[] = [];
    const requests: Array<{ op: string; rootPids?: number[]; killed: string[] }> = [];
    const killedRoots = new Set<number>();
    let lane = 0, open = 0;
    const found = (pid: number) => ({ root: { pid, start: `proc:${pid}` }, pairs: [{ pid, start: `proc:${pid}` }],
      context: { bootId: "b", pidns: "pid:[1]", visibility: { hidepid: false, sameNs: true } } });
    type Rec = import("./mcp-stop-proof.ts").StopRecord;
    const proof = (record?: Rec) => {
      const root = record?.desktop?.rootPair?.pid ?? 0;
      return { verdict: killedRoots.has(root) ? { v: "gone" } : { v: "alive", why: "still running" }, reparented: [] };
    };
    const answer = (request: { op: string; rootPid?: number; rootPids?: number[]; record?: Rec; records?: Rec[] }) => {
      if (request.op === "capture") return { found: found(request.rootPid!), rows: [] };
      if (request.op === "captureMany") return { found: request.rootPids!.map(found) };
      if (request.op === "proveMany") return { answers: request.records!.map(proof) };
      return proof(request.record);
    };
    const spawn = () => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), closed: false, request: undefined as undefined | typeof requests[number] });
      open++;
      const close = () => { if (child.closed) return; child.closed = true; open--; child.emit("close", 0, null); };
      const stdin = { on() { return stdin; }, end(data: string) {
        const request = JSON.parse(data) as Parameters<typeof answer>[0];
        const entry = { op: request.op, ...(request.rootPids ? { rootPids: request.rootPids } : {}), killed: [] as string[] };
        child.request = entry; requests.push(entry); events.push(`helper ${request.op}`);
        // a later walk that never answers (a stalled re-walk after an answered call): it holds no spawn lane, it only hangs until killed
        if (request.op === "capture" && requests.length > stallWalksAfter) return;
        lane = Math.max(Date.now(), lane) + (request.op === "desktopProof" || request.op === "proveMany" ? proofSpawnMs : SPAWN_MS);
        setTimeout(() => {
          if (child.closed || (stallCaptureMany && request.op === "captureMany")) return;
          child.stdout.write(JSON.stringify(answer(request))); close();
        }, lane - Date.now());
      } };
      return Object.assign(child, { stdin, kill(signal: string) { child.request?.killed.push(signal); close(); return true; } }) as unknown as ChildProcess;
    };
    const signalEnv = (platform: "linux" | "darwin") => ({ platform, residual: () => {},
      identity: async (pid: number) => killedRoots.has(pid) ? "absent" as const : { start: `proc:${pid}`, kind: "proc" as const },
      kill: (pid: number, signal: NodeJS.Signals) => {
        events.push(`signal ${signal}`); killedRoots.add(pid);
        for (const mcp of children()) if (!(mcp as unknown as { gone?: boolean }).gone) { (mcp as unknown as { gone?: boolean }).gone = true; mcp.emit("close", 0, null); }
      } });
    return { events, requests, spawn, signalEnv, open: () => open };
  }
  const eight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`s${i}`, custom]));
  // R8-C (MC63 2026-11-17): a fake warm helper child. It answers one request line per stdout line after WARM_MS, says ready once started,
  // and records every request, crash and kill, so a witness can tell a warm answer from a spawn on the stop path.
  const WARM_MS = 20;
  function warmHelpers(options: { neverReady?: boolean; dieBeforeReady?: boolean } = {}) {
    const spawned: Array<{ killed: string[]; ops: string[]; child: ChildProcess & EventEmitter }> = [];
    const found = (pid: number) => ({ root: { pid, start: `proc:${pid}` }, pairs: [{ pid, start: `proc:${pid}` }],
      context: { bootId: "b", pidns: "pid:[1]", visibility: { hidepid: false, sameNs: true } } });
    const spawn = (_script: string, env: Record<string, string>) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), pid: 90_000 + spawned.length, closed: false });
      const entry = { killed: [] as string[], ops: [] as string[], child: child as unknown as ChildProcess & EventEmitter, env };
      spawned.push(entry);
      const close = () => { if (child.closed) return; child.closed = true; child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL"); };
      const stdin = { on() { return stdin; }, end() {}, write(line: string) {
        const { id, request } = JSON.parse(line) as { id: number; request: { op: string; rootPids?: number[] } };
        entry.ops.push(request.op);
        setTimeout(() => { if (!child.closed) child.stdout.write(`${JSON.stringify({ id, answer: request.op === "captureMany" ? { found: request.rootPids!.map(found) } : null })}\n`); }, WARM_MS);
        return true;
      } };
      if (!options.neverReady) setTimeout(() => { if (!child.closed) child.stdout.write(`${JSON.stringify({ ready: true })}\n`); }, WARM_MS);
      if (options.dieBeforeReady) setTimeout(close, 1);
      return Object.assign(child, { stdin, kill(signal: string) { entry.killed.push(signal); close(); return true; }, crash: close }) as unknown as ChildProcess;
    };
    return { spawned, spawn, alive: () => spawned.filter((one) => !(one.child as unknown as { closed: boolean }).closed) };
  }
  async function slowStop(stallCaptureMany: boolean, stalledRewalks = false, proofSpawnMs = SPAWN_MS,
    warm?: ReturnType<typeof warmHelpers>, beforeStop?: (helpers: ReturnType<typeof slowHelpers>) => Promise<void>) {
    const runtime = await import("./mcp-stop-runtime.ts");
    const { makeHelperRunner, WarmHelper } = await import("./mcp-stop-helper.ts");
    const x = fixture(424242);
    const helpers = slowHelpers(() => x.children, stallCaptureMany, stalledRewalks ? 8 : Infinity, proofSpawnMs);
    const servers = new Set<ChatMcpDescendants>();
    const track = ChatMcpDescendants.prototype.track;
    const spy = vi.spyOn(ChatMcpDescendants.prototype, "track").mockImplementation(function (this: ChatMcpDescendants) { servers.add(this); return track.call(this); });
    runtime.configureMcpStop({
      ownerHeld: (owner, key) => relayApi().holdRecordOwner(owner, key), ownerReleased: (owner, key) => relayApi().releaseRecordOwner(owner, key),
      targetDeps: { helper: makeHelperRunner({ script: "fixture-probe", spawn: helpers.spawn }), signalEnv: helpers.signalEnv,
        ...(warm ? { warmHelper: () => new WarmHelper({ script: "fixture-warm", spawn: warm.spawn }) } : {}) },
      recoveryDeps: { clock: { now: () => 0, setTimeout: () => () => {} }, reKill: async () => {},
        launch: () => ({ result: new Promise(() => {}), kill() {}, alive: () => false, exited: Promise.resolve() }) },
    });
    const relay = await x.create(eight);
    expect(x.children).toHaveLength(8);
    // the eight startup walks (U1) finish first, so the stop below measures only the stop's own capture
    await vi.waitFor(() => { expect(helpers.requests).toHaveLength(8); expect(helpers.open()).toBe(0); }, { timeout: 8 * SPAWN_MS + 5_000, interval: 50 });
    // each server answered a call: its re-walk starts and stalls (B1: the stop's capture must not wait on it)
    if (stalledRewalks) { for (const server of servers) void server.track(); expect(helpers.requests).toHaveLength(16); }
    spy.mockRestore();
    await beforeStop?.(helpers);
    const before = helpers.requests.length;
    helpers.events.length = 0;
    const began = Date.now();
    const stopped = await relay.finish();
    const firstSignal = helpers.events.findIndex((event) => event.startsWith("signal"));
    const captures = helpers.requests.slice(before).filter((request) => request.op === "capture" || request.op === "captureMany");
    return { x, helpers, stopped, captures, firstSignal, began, runtime };
  }
  it("CM1 MC63 A: a stop of 8 MCP servers under slow helper spawns runs ONE captureMany helper, before any signal, and the stop is proven", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let run: Awaited<ReturnType<typeof slowStop>> | undefined;
    try {
      run = await slowStop(false);
      expect(run.stopped, "per-child helpers miss the 1 s cap here and leave CLAUDE_SESSION_NOT_STOPPED; one helper proves the stop").toBe(true);
      expect(run.captures.map((request) => request.op), "one pre-stop capture request (one helper spawn) for the whole relay stop").toEqual(["captureMany"]);
      expect(run.captures[0]!.rootPids).toHaveLength(8);
      expect(run.helpers.events.indexOf("helper captureMany"), "the capture starts before any signal").toBeLessThan(run.firstSignal);
      expect(run.firstSignal).toBeGreaterThan(-1);
      expect(() => relayApi().assertRelayAvailable(run!.x.turn)).not.toThrow();
    } finally { warning.mockRestore(); run?.runtime.resetMcpStopForTests(); }
  }, 30_000);
  it("CM2 MC63 A fail closed: a stalled captureMany helper is SIGKILLed at the cap and all 8 servers stay owned", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let run: Awaited<ReturnType<typeof slowStop>> | undefined;
    try {
      run = await slowStop(true);
      expect(run.captures.map((request) => request.op)).toEqual(["captureMany"]);
      expect(run.captures[0]!.killed, "the stalled helper alone is ended at the snapshot cap").toEqual(["SIGKILL"]);
      expect(run.stopped, "a blind capture can never certify a stop").toBe(false);
      expect(run.helpers.requests.filter((request) => request.op === "desktopProof"), "no proof that could read gone is even asked").toEqual([]);
      expect(() => relayApi().assertRelayAvailable(run!.x.turn), "every server of the blind capture stays owned").toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
    } finally { warning.mockRestore(); run?.runtime.resetMcpStopForTests(); }
  }, 30_000);
  it("CM3 MC63 B1: the shared capture waits only on the startup walks; 8 stalled re-walks are ended, not waited on, and the stop is proven", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let run: Awaited<ReturnType<typeof slowStop>> | undefined;
    try {
      run = await slowStop(false, true);
      const rewalks = run.helpers.requests.slice(8, 16);
      expect(rewalks.map((request) => request.killed), "every stalled re-walk helper is killed at the stop's capture").toEqual(rewalks.map(() => ["SIGKILL"]));
      expect(run.captures.map((request) => request.op)).toEqual(["captureMany"]);
      expect(run.stopped, "waiting on the re-walks leaves the capture blind at the 1 s cap (CLAUDE_SESSION_NOT_STOPPED)").toBe(true);
      expect(() => relayApi().assertRelayAvailable(run!.x.turn)).not.toThrow();
    } finally { warning.mockRestore(); run?.runtime.resetMcpStopForTests(); }
  }, 30_000);
  it("CM4 MC63 B2: the 8 post-kill proofs of one stop share one proveMany helper per round, so slow proof spawns still prove the stop", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let run: Awaited<ReturnType<typeof slowStop>> | undefined;
    try {
      // 8 serialised 500 ms proof spawns (4 s) outlast the 3 s SIGTERM grace and the 1 s SIGKILL wait for the last servers
      run = await slowStop(false, false, 500);
      const proofs = run.helpers.requests.slice(run.helpers.requests.findIndex((request) => request.op === "captureMany") + 1);
      expect(proofs.map((request) => request.op), "one proof helper per round for the whole stop").toEqual(["proveMany"]);
      expect(run.stopped, "per-server proof helpers miss the proof windows (CLAUDE_SESSION_NOT_STOPPED)").toBe(true);
      expect(() => relayApi().assertRelayAvailable(run!.x.turn)).not.toThrow();
    } finally { warning.mockRestore(); run?.runtime.resetMcpStopForTests(); }
  }, 30_000);
  it("CM5 MC63 B2 fail closed: a proveMany helper that gives no answer leaves every server it carried owned", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ProofBatch } = await import("./mcp-stop-target.ts");
    const round = vi.spyOn(ProofBatch.prototype, "prove");
    let run: Awaited<ReturnType<typeof slowStop>> | undefined;
    try {
      run = await slowStop(false, false, 100_000);
      expect(round).toHaveBeenCalled();
      const proofs = run.helpers.requests.filter((request) => request.op === "proveMany");
      expect(proofs.length, "one shared proof helper at a time").toBeGreaterThan(0);
      expect(proofs.every((request) => request.killed.includes("SIGKILL")), "the stalled shared helper is killed once every proof window it carried ended").toBe(true);
      expect(run.stopped).toBe(false);
      expect(() => relayApi().assertRelayAvailable(run!.x.turn)).toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
    } finally { round.mockRestore(); warning.mockRestore(); run?.runtime.resetMcpStopForTests(); }
  }, 30_000);
  const warmUp = (warm: ReturnType<typeof warmHelpers>) => async () => {
    await vi.waitFor(() => { expect(warm.alive()).toHaveLength(1); }, { timeout: 5_000, interval: 10 });
    await new Promise((resolve) => setTimeout(resolve, WARM_MS * 3));
  };
  it("WC1 MC63 R8-C C1: a relay's warm helper answers the stop's capture; nothing is spawned on the stop path and the stop is proven", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warm = warmHelpers();
    let run: Awaited<ReturnType<typeof slowStop>> | undefined;
    try {
      run = await slowStop(false, false, SPAWN_MS, warm, warmUp(warm));
      expect(run.captures.map((request) => request.op), "a capture helper spawned on the stop path (C1: the warm helper answers it)").toEqual([]);
      expect(warm.spawned.map((one) => one.ops), "one captureMany for the 8 servers, on the one warm helper").toEqual([["captureMany"]]);
      expect(run.stopped).toBe(true);
      expect(() => relayApi().assertRelayAvailable(run!.x.turn)).not.toThrow();
    } finally { warning.mockRestore(); run?.runtime.resetMcpStopForTests(); }
  }, 30_000);
  it("WC2 MC63 R8-C C2: the stop's capture request is sent at the stop request, before the markStopRequested loop runs", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ChildTeardown } = await import("./child-teardown.ts");
    let events: string[] = [];
    const mark = ChildTeardown.prototype.markStopRequested;
    const spy = vi.spyOn(ChildTeardown.prototype, "markStopRequested").mockImplementation(function (this: InstanceType<typeof ChildTeardown>) { events.push("markStopRequested"); return mark.call(this); });
    let run: Awaited<ReturnType<typeof slowStop>> | undefined;
    try {
      // the stop's helper events and its markStopRequested calls go to one list, in the order they happen
      run = await slowStop(false, false, SPAWN_MS, undefined, async (helpers) => { events = helpers.events; });
      expect(run.stopped).toBe(true);
      const first = events.indexOf("markStopRequested");
      expect(first).toBeGreaterThan(-1);
      expect(events.indexOf("helper captureMany"), "the capture request precedes the markStopRequested loop (C2), not after it").toBeLessThan(first);
    } finally { spy.mockRestore(); warning.mockRestore(); run?.runtime.resetMcpStopForTests(); }
  }, 30_000);
  it("WC3 MC63 R8-C C3: a crashed warm helper is restarted and answers the next stop; it dies with the relay (no orphan)", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warm = warmHelpers();
    let run: Awaited<ReturnType<typeof slowStop>> | undefined;
    try {
      run = await slowStop(false, false, SPAWN_MS, warm, async () => {
        await warmUp(warm)();
        (warm.spawned[0]!.child as unknown as { crash: () => void }).crash();
        await vi.waitFor(() => { expect(warm.spawned, "the crashed warm helper is started again").toHaveLength(2); }, { timeout: 5_000, interval: 10 });
        await new Promise((resolve) => setTimeout(resolve, WARM_MS * 3));
      });
      expect(run.captures.map((request) => request.op), "the restarted warm helper answers, nothing spawned on the stop path").toEqual([]);
      expect(warm.spawned[1]!.ops).toEqual(["captureMany"]);
      expect(run.stopped).toBe(true);
      expect(warm.alive(), "the warm helper dies with its relay").toEqual([]);
      expect(warm.spawned[1]!.killed).toEqual(["SIGKILL"]);
    } finally { warning.mockRestore(); run?.runtime.resetMcpStopForTests(); }
  }, 30_000);
  it("WC5 MC63 R8-C C3 no orphan: a real warm probe helper answers a captureMany and exits when the process that started it is SIGKILLed", async () => {
    const helperUrl = new URL("./mcp-stop-helper.ts", import.meta.url).href;
    const probe = new URL("./mcp-stop-probe.ts", import.meta.url).pathname;
    const code = `const { WarmHelper } = await import(${JSON.stringify(helperUrl)});
      const warm = new WarmHelper({ script: ${JSON.stringify(probe)}, capMs: 20000 });
      if (!WarmHelper) process.exit(3);
      warm.start();
      const tick = setInterval(async () => {
        if (!warm.ready) return;
        clearInterval(tick);
        const answer = await warm.run({ op: "captureMany", platform: "linux", rootPids: [process.pid] });
        process.stdout.write(JSON.stringify({ helper: warm.pid, roots: answer && Array.isArray(answer.found) ? answer.found.length : -1 }) + "\\n");
      }, 10);
      setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    parent.stdout!.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    try {
      await vi.waitFor(() => { expect(out).toContain("\n"); }, { timeout: 20_000, interval: 50 });
      const { helper, roots } = JSON.parse(out.trim()) as { helper: number; roots: number };
      expect(roots, "the warm helper answers one capture per root").toBe(1);
      expect(() => process.kill(helper, 0), "the warm helper runs while its relay's process runs").not.toThrow();
      parent.kill("SIGKILL");
      await vi.waitFor(() => { expect(() => process.kill(helper, 0), "the warm helper is left as an orphan").toThrow(); }, { timeout: 10_000, interval: 50 });
    } finally { parent.kill("SIGKILL"); }
  }, 40_000);
  it("WC4 MC63 R8-C C3 fail closed: a warm helper that is not ready means one on-demand spawn, which still fails closed at the cap", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warm = warmHelpers({ neverReady: true });
    let run: Awaited<ReturnType<typeof slowStop>> | undefined;
    try {
      run = await slowStop(true, false, SPAWN_MS, warm, warmUp(warm));
      expect(warm.spawned.map((one) => one.ops), "a warm helper that never said ready is never asked").toEqual([[]]);
      expect(run.captures.map((request) => request.op)).toEqual(["captureMany"]);
      expect(run.captures[0]!.killed).toEqual(["SIGKILL"]);
      expect(run.stopped, "a blind capture can never certify a stop").toBe(false);
      expect(() => relayApi().assertRelayAvailable(run!.x.turn)).toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
      expect(warm.alive(), "the warm helper dies with its relay").toEqual([]);
    } finally { warning.mockRestore(); run?.runtime.resetMcpStopForTests(); }
  }, 30_000);
  // MC63 backoff ruling (2026-11-17): a warm helper that never reaches ready is restarted after 250 ms doubling to a 30 s ceiling, and the
  // delay resets only after a healthy start. A fake helper child whose deaths and ready line the witness drives on a fake clock.
  function backoffHelpers() {
    const spawns: number[] = [];
    const deaths: number[] = [];
    let current: (EventEmitter & { stdout: EventEmitter }) | null = null;
    const spawn = () => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), pid: 91_000 + spawns.length });
      spawns.push(Date.now()); current = child;
      return Object.assign(child, { stdin: { on() { return this; }, end() {}, write() { return true; } }, kill() { child.emit("exit", null, "SIGKILL"); return true; } }) as unknown as ChildProcess;
    };
    const die = () => { const child = current!; current = null; deaths.push(Date.now()); child.emit("exit", 1, null); };
    const ready = () => { current!.stdout.emit("data", Buffer.from(`${JSON.stringify({ ready: true })}\n`)); };
    // how long each death waited for its restart
    const waits = () => deaths.flatMap((at, i) => spawns[i + 1] === undefined ? [] : [spawns[i + 1]! - at]);
    return { spawns, spawn, die, ready, waits };
  }
  it("WB1 MC63 backoff: a warm helper that always dies before ready is respawned on the 250 ms doubling series capped at 30 s, not every 250 ms", async () => {
    vi.useFakeTimers({ now: 0 });
    const { WarmHelper, WARM_HELPER_RESTART_MS, WARM_HELPER_RESTART_MAX_MS } = await import("./mcp-stop-helper.ts");
    const fake = backoffHelpers();
    const warm = new WarmHelper({ script: "fixture-warm", spawn: fake.spawn });
    try {
      expect([WARM_HELPER_RESTART_MS, WARM_HELPER_RESTART_MAX_MS]).toEqual([250, 30_000]);
      warm.start();
      // every helper dies at once, before it says ready; run the relay for 120 s of fake time
      for (let at = 0; at < 120_000; at += 50) { if (fake.spawns.length && warm.pid !== undefined) fake.die(); await vi.advanceTimersByTimeAsync(50); }
      expect(warm.ready).toBe(false);
      expect(fake.spawns.length, "spawns over 120 s are bounded by the backoff series, not one per 250 ms (480)").toBeLessThanOrEqual(12);
      expect(fake.waits(), "each restart waits twice the last, up to the 30 s ceiling")
        .toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    } finally { warm.dispose(); vi.useRealTimers(); }
  });
  it("WB2 MC63 backoff: a healthy start (the helper reached ready) resets the restart delay to 250 ms", async () => {
    vi.useFakeTimers({ now: 0 });
    const { WarmHelper } = await import("./mcp-stop-helper.ts");
    const fake = backoffHelpers();
    const warm = new WarmHelper({ script: "fixture-warm", spawn: fake.spawn });
    const settle = async (ms: number) => { for (let left = ms; left > 0; left -= 50) await vi.advanceTimersByTimeAsync(50); };
    try {
      warm.start();
      for (let deaths = 0; deaths < 4; deaths++) { fake.die(); await settle(10_000); }
      expect(fake.waits(), "four deaths before ready back off").toEqual([250, 500, 1_000, 2_000]);
      fake.ready();
      expect(warm.ready).toBe(true);
      // the healthy helper crashes: it is started again at once (as before), that one dies before ready, and the next wait is 250 ms again
      const before = fake.spawns.length;
      fake.die();
      expect(fake.spawns).toHaveLength(before + 1);
      expect(warm.ready).toBe(false);
      fake.die();
      await settle(1_000);
      expect(fake.waits().slice(4), "the delay after a healthy start is 250 ms, not 4 s").toEqual([0, 250]);
      fake.die(); await settle(1_000);
      expect(fake.waits().slice(-1), "and it backs off again from there").toEqual([500]);
    } finally { warm.dispose(); vi.useRealTimers(); }
  });
  it("WB3 MC63 backoff fail closed: a Stop while the warm helper backs off never waits on it; it captures on demand and the helper ends with the relay", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warm = warmHelpers({ dieBeforeReady: true });
    let run: Awaited<ReturnType<typeof slowStop>> | undefined;
    try {
      run = await slowStop(false, false, SPAWN_MS, warm, async () => {
        await vi.waitFor(() => { expect(warm.spawned.length, "the dying warm helper is restarted").toBeGreaterThanOrEqual(3); }, { timeout: 5_000, interval: 10 });
      });
      expect(warm.spawned.every((one) => one.ops.length === 0), "a warm helper that never said ready is never asked").toBe(true);
      expect(run.captures.map((request) => request.op), "the Stop captures on demand under the same cap").toEqual(["captureMany"]);
      expect(run.stopped).toBe(true);
      const after = warm.spawned.length;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(warm.spawned, "no respawn after the relay ended its warm helper").toHaveLength(after);
    } finally { warning.mockRestore(); run?.runtime.resetMcpStopForTests(); }
  }, 30_000);
  it("T-TEARDOWN-DESCENDANT: CLI death alone cannot release mount quarantine", async () => {
    const x = fixture(); const relay = await x.create();
    const stopDescendants = vi.spyOn(ChatMcpDescendants.prototype, "stop").mockResolvedValue(false);
    let confirmDescendants!: (value: true) => void;
    const gone = vi.spyOn(ChatMcpDescendants.prototype, "goneSignal").mockReturnValue(new Promise<true>(resolve => { confirmDescendants = resolve; }));
    const cliGone = vi.spyOn(procs, "cliTreeStoppedSignal").mockResolvedValue(true);
    try {
      expect(await relay.finish(x.children[0])).toBe(false);
      expect(existsSync(x.cred.path)).toBe(false);
      expect(() => relayApi().assertRelayAvailable(x.turn)).toThrow("MOUNT_RELAY_STOP_UNCONFIRMED");
      x.children[0]!.emit("close", 0, null);
      confirmDescendants(true);
      await relay.stopped;
      expect(await relay.finish(x.children[0])).toBe(true);
      expect(() => relayApi().assertRelayAvailable(x.turn)).not.toThrow();
    } finally { stopDescendants.mockRestore(); gone.mockRestore(); cliGone.mockRestore(); }
  });
});

// R1: observe the actual streams, including the delimiter that the relay adds.
it.each(["request", "response"])("actual relay %s owns the writer through enqueue and charges the complete frame", async direction => {
  const x = fixture();
  x.f.f.db.exec("PRAGMA journal_mode=WAL");
  const other = new DatabaseSync(String(x.f.f.db.prepare("PRAGMA database_list").get()!.file));
  other.exec("PRAGMA busy_timeout=0"); cleanups.push(() => other.close());
  const competing = () => other.exec("BEGIN IMMEDIATE; COMMIT");
  const relay = await x.create();
  const socket = await socketFor(relay);
  const requestFrame = request(177);
  const responseFrame = '{"jsonrpc":"2.0","id":177,"result":{"fixture":"é"}}';
  let writes = 0;
  const observe = () => {
    writes++;
    expect(x.f.f.db.isTransaction).toBe(true);
    expect(competing).toThrow(/busy|locked/i);
  };
  const stream = x.children[0]!.stdin!;
  const original = stream.write.bind(stream);
  const inputSpy = vi.spyOn(stream, "write").mockImplementation(((...args: Parameters<typeof stream.write>) => {
    if (direction === "request") observe();
    return original(...args);
  }) as typeof stream.write);
  const socketWrite = Socket.prototype.write;
  const outputSpy = vi.spyOn(Socket.prototype, "write").mockImplementation(function(this: Socket, ...args: Parameters<Socket["write"]>) {
    if (direction === "response" && String(args[0]) === responseFrame + "\n") observe();
    return socketWrite.apply(this, args);
  });
  try {
    let before = x.f.budget.counts;
    const input = once(stream, "data"); socket.write(requestFrame + "\n"); await input;
    if (direction === "response") {
      before = x.f.budget.counts;
      const output = once(socket, "data");
      x.children[0]!.stdout!.emit("data", Buffer.from(responseFrame + "\n"));
      expect(String((await output)[0])).toBe(responseFrame + "\n");
    }
    expect(writes).toBe(1);
    expect(competing).not.toThrow();
    expect(x.f.budget.counts.attempts - before.attempts).toBe(1);
    expect(x.f.budget.counts.bytes - before.bytes).toBe(Buffer.byteLength((direction === "request" ? requestFrame : responseFrame) + "\n") * (direction === "response" ? 2 : 1));
  } finally { inputSpy.mockRestore(); outputSpy.mockRestore(); }
});

it.each(["request", "response"] as const)("R1 relay %s writer failure keeps its native identity across all mounts", async direction => {
  const x = fixture(), relay = await x.create({ one: custom, two: custom });
  const failed = vi.fn(), native = Object.assign(new Error("fixture native write failure"), { code: "EPIPE" });
  relay.attach(x.children[0]!, failed);
  const mount = relay.mounts.get("one")!;
  if (direction === "response") mount.request(request(1));
  const before = x.f.budget.counts;
  const writer = direction === "request"
    ? vi.spyOn(x.children[0]!.stdin!, "write").mockImplementation(() => { throw native; })
    : vi.spyOn(mount, "write").mockImplementation(() => { throw native; });
  try {
    if (direction === "request") mount.request(request(1));
    else mount.data(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'));
    expect(failed).toHaveBeenCalledExactlyOnceWith(native);
    expect(x.f.refusals).toBe(0);
    expect(x.f.budget.counts.attempts - before.attempts).toBe(1);
    expect(x.f.budget.counts.bytes).toBeGreaterThan(before.bytes);
    expect(relay.mounts.get("two")!.mount.ingress.retired).toBe(true);
  } finally { writer.mockRestore(); }
});

it.each(["child-error", "child-exit", "stdout-end", "stdin-error", "socket-close"])("R1 native transport %s retires all authority without a ledger refusal", async event => {
  const x = fixture(), relay = await x.create({ one: custom, two: custom });
  const failed = vi.fn(), native = Object.assign(new Error("fixture transport loss"), { code: "EPIPE" });
  relay.attach(x.children[0]!, failed);
  const first = relay.mounts.get("one")!, next = relay.mounts.get("two")!;
  first.request(request(1));
  const before = x.f.budget.counts;
  if (event === "socket-close") {
    const socket = await socketFor(relay);
    const received = once(x.children[0]!.stdin!, "data"); socket.write(request(2) + "\n"); await received;
    socket.destroy();
    await expect.poll(() => failed.mock.calls.length).toBe(1);
  } else if (event === "child-error") x.children[0]!.emit("error", native);
  else if (event === "child-exit") x.children[0]!.emit("exit", 1, null);
  else if (event === "stdin-error") x.children[0]!.stdin!.emit("error", native);
  else x.children[0]!.stdout!.emit("end");
  expect(failed).toHaveBeenCalledOnce();
  expect(failed.mock.calls[0]![0]).toBeInstanceOf(Error);
  if (event.endsWith("error")) expect(failed.mock.calls[0]![0]).toBe(native);
  expect(x.f.refusals).toBe(0);
  expect(first.mount.ingress.retired).toBe(true);
  expect(next.mount.ingress.retired).toBe(true);
  const write = vi.spyOn(x.children[1]!.stdin!, "write");
  next.request(request(3));
  expect(write).not.toHaveBeenCalled();
  expect(x.f.budget.counts.attempts - before.attempts).toBe(event === "socket-close" ? 1 : 0);
});

it.each(["callback", "throw", "disconnected"])("R1 IPC acknowledgement %s failure preserves the released frame without memory refusal", async failure => {
  const x = fixture(), relay = await x.create({ one: { command: process.execPath, args: [SPAWNED_PROXIES.memory], env: {} } });
  const child = x.children[0]!, failed = vi.fn(), native = Object.assign(new Error("fixture IPC loss"), { code: "EPIPE" });
  relay.attach(child, failed);
  const mount = relay.mounts.get("one")!;
  const socket = await socketFor(relay);
  const input = once(child.stdin!, "data"); socket.write(request(1) + "\n"); await input;
  const env = x.envs[0]!, claim = x.caps.resolve(`Bearer ${env.MURAGE_RELEASE_TOKEN}`)!;
  const frame = '{"jsonrpc":"2.0","id":1,"result":{}}';
  const permit = x.authority.verdict(claim, { bytes: Buffer.byteLength(frame), descriptor: "proxy:memory:frame", digest: frameDigest(frame), frame,
    instanceId: env.MURAGE_RELEASE_INSTANCE, requestId: 1, sequence: 1 });
  if (failure === "callback") vi.mocked(child.send).mockImplementation(((_message: unknown, callback: (error: Error | null) => void) => { callback(native); return false; }) as typeof child.send);
  else if (failure === "throw") vi.mocked(child.send).mockImplementation(() => { throw native; });
  else Object.defineProperty(child, "connected", { value: false });
  const before = x.f.budget.counts;
  mount.data(Buffer.from(JSON.stringify(permit) + "\n"));
  expect(x.f.budget.counts.attempts - before.attempts).toBe(1);
  expect(failed).toHaveBeenCalledOnce();
  if (failure !== "disconnected") expect(failed.mock.calls[0]![0]).toBe(native);
  else expect(failed.mock.calls[0]![0]).toBeInstanceOf(Error);
  expect(x.f.refusals).toBe(0);
  expect(mount.mount.ingress.retired).toBe(true);
});

it.each(["cli-relay", "chat-client"])("R1 %s spawn failure is native and leaves no usable mount", async target => {
  const x = fixture(), native = Object.assign(new Error("fixture spawn refused"), { code: "EACCES" });
  if (target === "cli-relay") {
    x.spawn.mockImplementation(() => { throw native; });
    await expect(x.create()).rejects.toBe(native);
  } else {
    const entry = x.admission.mount(custom);
    const cwd = dirname(String(x.f.f.db.prepare("PRAGMA database_list").get()!.file));
    const result = await openChatMcpServers({ one: entry }, { cwd, spawn: () => { throw native; } });
    expect(result.sessions).toEqual([]);
    expect(result.failed).toEqual(["one"]);
  }
  expect(x.f.refusals).toBe(0);
});
it("T12 owned metering IPC preserves relay authority while unrelated IPC still seals it",async()=>{
 const {observeChildIo}=await import("../sentinel/io-child-receipts.ts");
 const x=fixture(),relay=await x.create(),child=x.children[0]!;
 observeChildIo(child,"fixture-owned-meter");
 child.emit("message",{type:"io",ioProtocol:1,generation:"fixture-owned-meter",sequence:1,fsWriteBlocks:0,ioBytes:8192,known:true,final:true});
 expect(relay.mounts.get("one")!.mount.ingress.sealed,"private metering receipts must not revoke application authority").toBe(false);
 expect(x.f.refusals).toBe(0);
 child.emit("message",{type:"io",ioProtocol:1,generation:"unowned-generation",sequence:1});
 expect(relay.mounts.get("one")!.mount.ingress.sealed,"unowned IPC remains an application protocol failure").toBe(true);
 expect(x.f.refusals).toBe(1);
 child.emit("exit",0,null);
});

it("LLM relay seal hands the pre-entry refusal error to the consumer; a native failure carries none", async () => {
  const { isMemoryRefusal } = await import("./engine-input.ts");
  const x = fixture(), relay = await x.create();
  const failed = vi.fn();
  relay.attach(x.children[0]!, failed);
  x.f.replace();
  relay.mounts.get("one")!.request(request(1));
  expect(failed).toHaveBeenCalledOnce();
  expect(failed.mock.calls[0]![0]).toBeUndefined();
  expect(isMemoryRefusal(failed.mock.calls[0]![1]), "the consumer receives the refusal error to claim with refusalFor").toBe(true);
  const y = fixture(), relayY = await y.create(), failedY = vi.fn(), native = Object.assign(new Error("fixture transport loss"), { code: "EPIPE" });
  relayY.attach(y.children[0]!, failedY);
  y.children[0]!.emit("error", native);
  expect(failedY).toHaveBeenCalledExactlyOnceWith(native);
});

it("LLM a relay sealed before attach replays the refusal error to the late consumer", async () => {
  const { isMemoryRefusal } = await import("./engine-input.ts");
  const x = fixture(), relay = await x.create(), failed = vi.fn();
  const refusal = Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" });
  relay.seal(undefined, refusal);
  relay.attach(x.children[0]!, failed);
  expect(failed).toHaveBeenCalledOnce();
  expect(failed.mock.calls[0]![0]).toBeUndefined();
  expect(isMemoryRefusal(failed.mock.calls[0]![1]), "late attach receives the sealed refusal").toBe(true);
});
