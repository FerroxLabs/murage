// 1.0.21 cause17: a busy server loop must not silently close an engine's mount connection before its ticket is read.
// Rig comb43ab4b9a55: 40/160 turns ended "custom tool failed: the <mount> server closed its output" with no [mount-relay]
// line at all. The relay closed every engine connection whose ticket had not been read within 5 s of the accept; a loop
// that is late by that much (dispatch burst, ledger lock hold) closed all of a turn's shims at once, without a word.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { connect, Server, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { createTurnCredentialStore } from "./turn-credentials.ts";
import { TURN_RELEASE_WAIT_MS } from "../turn-release-wait.ts";
import type { SendTurnInput } from "../contracts.ts";
import { CliMountRelay } from "./cli-mount-relay.ts";

vi.mock("../procs.ts", async original => ({
  ...await original<typeof import("../procs.ts")>(),
  killCliTree: vi.fn(), awaitCliTreeStopped: async () => true,
  cliTreeStoppedSignal: () => new Promise<true>(() => {}),
}));
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const f = consumingFixture(undefined, { botId: randomUUID() }); cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "isolated", warmIdentity: { botId: f.binding.identity.botId, audience: "owner" }, releaseBinding: f.binding, mountAdmission: admission };
  const children: ChildProcess[] = [];
  const launch = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: undefined, exitCode: null, signalCode: null, connected: false, send: vi.fn() }) as unknown as ChildProcess;
    children.push(child); return child;
  });
  const create = async () => {
    const relay = await CliMountRelay.create(turn, { one: { command: "fixture-mcp", args: [], env: {} } }, {}, cred, launch);
    cleanups.push(() => relay.finish()); return relay;
  };
  return { f, children, create };
}
const request = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" });
/** Block this process's event loop, synchronously, as a long main-loop task does. */
const blockLoop = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const warnings = () => {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => spy.mock.calls.map(call => String(call[0])).filter(line => line.startsWith("[mount-relay]"));
};
/** Real I/O turns while fake timers hold the clock. */
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

describe("cause17: engine connection before its ticket is read", () => {
  it("C17-1: a loop stalled 6 s right after the accept still authenticates the real shim and relays its call", async () => {
    const x = fixture(); const relay = await x.create(); const lines = warnings();
    const spec = relay.servers.one as { command: string; args: string[]; env: Record<string, string> };
    // The stall lands in the same loop turn as the relay's own accept, before the shim's ticket bytes are read.
    const emit = Server.prototype.emit;
    let stalled = false;
    vi.spyOn(Server.prototype, "emit").mockImplementation(function (this: Server, event: string | symbol, ...args: unknown[]) {
      const result = emit.call(this, event, ...args);
      if (event === "connection" && !stalled && this.address() === relay.socketPath) { stalled = true; blockLoop(6_000); }
      return result;
    });
    const shim = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<void>(resolve => shim.once("close", () => resolve()));
    cleanups.push(async () => { shim.kill(); await exited; });
    shim.stderr.resume();
    shim.stdin.write(request(1) + "\n");
    const outcome = await Promise.race([
      once(x.children[0]!.stdin!, "data").then(([chunk]) => `relayed ${String(chunk).trim()}`),
      once(shim.stdout, "end").then(() => "the shim's output closed"),
    ]);
    expect(stalled, "the witness must stall the loop after a real accept").toBe(true);
    expect(outcome).toBe(`relayed ${request(1)}`);
    const reply = once(shim.stdout, "data");
    x.children[0]!.stdout!.emit("data", Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n'));
    expect(String((await reply)[0])).toBe('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n');
    expect(x.f.refusals).toBe(0);
    expect(lines()).toEqual([]);
  }, 30_000);

  it("C17-2: a connection that never sends a ticket is still closed by the hang guard, at TURN_RELEASE_WAIT_MS, without a refusal", async () => {
    const x = fixture(); const relay = await x.create(); const lines = warnings();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const before = vi.getTimerCount();
    const socket: Socket = connect(relay.socketPath); cleanups.push(() => { socket.destroy(); }); socket.on("error", () => {});
    const closed = once(socket, "close");
    await once(socket, "connect");
    for (let i = 0; i < 200 && vi.getTimerCount() <= before; i++) await settle();
    expect(vi.getTimerCount(), "the relay arms one hang guard per unauthenticated connection").toBe(before + 1);
    vi.advanceTimersByTime(TURN_RELEASE_WAIT_MS - 1); await settle();
    expect(socket.destroyed, "still open just before the guard").toBe(false);
    vi.advanceTimersByTime(1); await closed;
    expect(x.f.refusals).toBe(0);
    expect(relay.mountUnavailable("one")).toBe(false);
    expect(lines()).toEqual(["[mount-relay] engine connection closed before its ticket reason=timeout"]);
  });

  it("C17-3: a wrong ticket or an unknown mount still closes at once and is named by reason only, never by its bytes", async () => {
    const x = fixture(); const relay = await x.create(); const lines = warnings();
    const sameLength = "x".repeat(Buffer.byteLength(relay.ticket));
    for (const auth of [{ ticket: "fixture-wrong-ticket", server: "one" }, { ticket: sameLength, server: "one" }, { ticket: relay.ticket, server: "fixture-unknown-mount" }]) {
      const socket: Socket = connect(relay.socketPath); cleanups.push(() => { socket.destroy(); }); socket.on("error", () => {});
      await once(socket, "connect");
      socket.write(JSON.stringify(auth) + "\n");
      await once(socket, "close");
    }
    expect(x.f.refusals).toBe(0);
    expect(relay.mountUnavailable("one")).toBe(false);
    expect(lines()).toEqual([
      "[mount-relay] engine connection closed before its ticket reason=ticket",
      "[mount-relay] engine connection closed before its ticket reason=ticket",
      "[mount-relay] engine connection closed before its ticket reason=mount",
    ]);
  });
});
