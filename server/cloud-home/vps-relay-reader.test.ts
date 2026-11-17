import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ socket: undefined as any, opened: vi.fn(), reserve: vi.fn(), release: vi.fn(), lost: vi.fn() }));
vi.mock("ws", () => ({ WebSocket: function () { transport.opened(); return transport.socket; } }));
const originalArgv = process.argv, originalExitCode = process.exitCode;
let detach: (() => void) | undefined;
afterEach(() => {
  detach?.(); detach = undefined;
  process.argv = originalArgv; process.exitCode = originalExitCode;
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); syncBuiltinESMExports(); vi.clearAllMocks();
});
async function fixture(crossing: boolean) {
  vi.resetModules(); vi.useFakeTimers();
  const budgets = await import("../memory/release-budget.ts").catch(() => null);
  expect(budgets?.ReleaseBudget, "VPS relay incoming frames must reserve before concatenation").toBeTypeOf("function");
  const stop = vi.fn();
  const counter = new budgets!.ReleaseBudget(stop), other = new budgets!.ReleaseBudget(vi.fn());
  const frame = JSON.stringify({ jsonrpc: "2.0", id: "é😀", result: {} });
  const bytes = Buffer.from(frame);
  // The outer bridge charges the raw stdio frame, including its delimiter.
  counter.charge({ bytes: budgets!.RELEASE_LIMITS.bytes - bytes.length - 1 + (crossing ? 1 : 0) });
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const socket = Object.assign(new EventEmitter(), { pause: vi.fn(), resume: vi.fn(), terminate: vi.fn(finish), send: vi.fn(), close: vi.fn() });
  transport.socket = socket;
  transport.reserve.mockImplementation(async (_role, size) => { counter.charge({ bytes: size, work: 1 }); });
  transport.release.mockImplementation(async () => { finish(); });
  const proxy = await import("../proxy-turn-release.ts");
  vi.spyOn(proxy, "reserveProxyUpstream").mockImplementation(transport.reserve);
  vi.spyOn(proxy, "releaseProxyFrame").mockImplementation(transport.release);
  vi.spyOn(proxy, "proxyTransportLost").mockImplementation(transport.lost);
  vi.stubEnv("MURAGE_CONTROL_URL", "http://127.0.0.1:1"); vi.stubEnv("MURAGE_CONTROL_TOKEN", "fixture");
  process.argv = [process.execPath, "fixture", "pipe"];
  vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
  // The pipe child is deliberately raw. Drive its bytes through the real
  // outer bridge, which now owns intake accounting and the release boundary.
  const raw = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { socket.terminate(); return true; }),
  });
  const stdinBefore = new Map(["data", "end"].map(event => [event, new Set(process.stdin.listeners(event))]));
  const signalBefore = new Map(["SIGTERM", "SIGINT"].map(event => [event, new Set(process.listeners(event))]));
  detach = () => {
    for (const [event, before] of stdinBefore) for (const listener of process.stdin.listeners(event)) if (!before.has(listener)) process.stdin.removeListener(event, listener);
    for (const [event, before] of signalBefore) for (const listener of process.listeners(event)) if (!before.has(listener)) process.removeListener(event, listener);
    raw.stdin.destroy(); raw.stdout.destroy(); raw.stderr.destroy();
  };
  vi.spyOn(childProcess, "spawn").mockReturnValue(raw as never);
  syncBuiltinESMExports();
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((...args: Parameters<typeof raw.stdout.write>) => raw.stdout.write(...args)) as typeof process.stdout.write);
  try {
    const { runMcpBridge } = await import("../mcp-bridge.ts");
    runMcpBridge({ command: process.execPath, args: ["isolated-raw-relay"], label: "Fixture relay", releaseRole: "vpsRelayMcp" });
    await import("./vps-relay-mcp.ts");
    const readers = await import("../memory/upstream-reader.ts");
    await readers.withUpstreamOwner({ budgets: [other], refuse: (): never => { throw new Error("wrong owner"); } }, async () => {
      socket.emit("message", [...bytes].map(byte => Buffer.from([byte])));
      await finished;
    });
  } finally { stdout.mockRestore(); }
  return { budgets: budgets!, counter, other, stop, socket, frame };
}
// red-at-4df086541: the WS callback converted/forwarded unreserved input and
// could release a crossing frame; cancellation must not reconnect or retry.
it("T-UPSTREAM-BUDGET VPS relay frames crossing", async () => {
  const f = await fixture(true);
  expect(f.stop).toHaveBeenCalledTimes(1); expect(f.socket.terminate).toHaveBeenCalledTimes(1);
  expect(transport.release).not.toHaveBeenCalled(); expect(transport.lost).toHaveBeenCalledTimes(1);
  expect(transport.opened).toHaveBeenCalledTimes(1); expect(f.socket.send).not.toHaveBeenCalled();
  expect(f.other.counts.bytes).toBe(0);
});
// control: fragmented RawData is joined only after paying; UTF-8 is preserved.
it("T-UPSTREAM-BUDGET VPS relay frames split UTF-8 exact cap", async () => {
  const f = await fixture(false);
  expect(transport.release).toHaveBeenCalledExactlyOnceWith("vpsRelayMcp", f.frame);
  expect(f.counter.counts.bytes).toBe(f.budgets.RELEASE_LIMITS.bytes); expect(f.other.counts.bytes).toBe(0);
  expect(f.stop).not.toHaveBeenCalled(); expect(f.socket.terminate).not.toHaveBeenCalled();
  expect(transport.opened).toHaveBeenCalledTimes(1);
});
