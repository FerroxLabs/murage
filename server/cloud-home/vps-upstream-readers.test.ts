import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { expect, it, vi } from "vitest";
const socket = vi.hoisted(() => ({ current: undefined as any, upgrades: vi.fn() }));
vi.mock("ws", () => ({ WebSocketServer: class {
  handleUpgrade(_req: unknown, _socket: unknown, _head: unknown, accept: (ws: unknown) => void) { socket.upgrades(); accept(socket.current); }
} }));
const fixtureApi = await import("../testing/consuming-fixture.ts").catch(() => null);
const budgets = await import("../memory/release-budget.ts").catch(() => null);
const ingress = await import("../consuming-turn-ingress.ts").catch(() => null);
async function fixture(direction: "child" | "incoming", crossing: boolean) {
  expect(budgets?.ReleaseBudget, "VPS concrete readers require generation reservations before frame conversion").toBeTypeOf("function");
  expect(ingress?.createConsumingIngress).toBeTypeOf("function");
  expect(fixtureApi?.consumingFixture).toBeTypeOf("function");
  const { createVpsMcpRelay, VPS_MCP_RELAY_PATH } = await import("./vps-mcp-relay.ts");
  const f = fixtureApi!.consumingFixture({ audience: null }, { empty: true });
  const downstream = ingress!.createConsumingIngress(f.binding, "downstream");
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, bufferedAmount: 0, send: vi.fn((_frame, done) => done?.()), close: vi.fn(), terminate: vi.fn(), ping: vi.fn() });
  socket.current = ws; socket.upgrades.mockClear();
  const writes = vi.fn();
  const child = Object.assign(new EventEmitter(), { stdin: new Writable({ write(chunk, _encoding, done) { writes(chunk.toString()); done(); } }), stdout: new PassThrough(), kill: vi.fn() });
  child.kill.mockImplementation(() => { queueMicrotask(() => child.emit("exit", 0)); return true; });
  const spawn = vi.fn(() => child);
  const claim = { botId: "B", threadId: "T", generation: f.binding.identity.dispatchGeneration, kind: "computer" as const, depth: 0, skillAuthoring: false, expiresAt: Date.now() + 60_000 };
  const container = { alias: "host", container: "container" };
  const relay = createVpsMcpRelay({ resolveClaim: () => claim, isActive: () => true, boundContainer: () => container,
    admit: () => ({ binding: f.binding, instanceId: "fixture", container, downstream }), spawn: spawn as unknown as NonNullable<Parameters<typeof createVpsMcpRelay>[0]["spawn"]> });
  await relay({ method: "GET", headers: { upgrade: "websocket" } } as IncomingMessage,
    { end: vi.fn(), destroy: vi.fn() } as unknown as Duplex, Buffer.alloc(0), new URL(VPS_MCP_RELAY_PATH, "http://localhost"));
  expect(spawn).toHaveBeenCalledTimes(1);
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { text: "é😀" } });
  const response = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [], text: "é😀" } });
  if (direction === "child") ws.emit("message", Buffer.from(request), false);
  writes.mockClear();
  const frame = direction === "child" ? response : request;
  const bytes = Buffer.from(frame + (direction === "child" ? "\n" : ""));
  // Raw intake plus the final writer's debit. Response issuance preflights
  // availability; it does not debit bytes before the destination accepts them.
  const cost = bytes.length + Buffer.byteLength(frame);
  f.budget.charge({ bytes: budgets!.RELEASE_LIMITS.bytes - f.budget.counts.bytes - (crossing ? bytes.length - 1 : cost) });
  const other = new budgets!.ReleaseBudget(vi.fn());
  const readers = await import("../memory/upstream-reader.ts");
  readers.withUpstreamOwner({ budgets: [other], refuse: (): never => { throw new Error("wrong owner"); } }, () => {
    if (direction === "child") for (const byte of bytes) child.stdout.emit("data", Buffer.from([byte]));
    else ws.emit("message", [...bytes].map(byte => Buffer.from([byte])), false);
  });
  return { f, downstream, other, ws, child, writes, spawn, frame,
    close: async () => { ws.emit("close"); await Promise.resolve(); child.stdin.destroy(); child.stdout.destroy(); f.close(); } };
}
// red-at-4df086541: concrete websocket/child listeners could accumulate or
// forward crossing bytes without reserving against the captured generation.
it.each(["child", "incoming"] as const)("T-UPSTREAM-BUDGET VPS %s crossing", async direction => {
  const t = await fixture(direction, true);
  try {
    expect(t.f.refusals).toBe(1); expect(t.downstream.sealed).toBe(true);
    expect(t.ws.send).not.toHaveBeenCalled(); expect(t.writes).not.toHaveBeenCalled();
    expect(t.child.kill).toHaveBeenCalledTimes(1); expect(t.ws.close).toHaveBeenCalledTimes(1);
    expect(t.spawn).toHaveBeenCalledTimes(1); expect(t.other.counts.bytes).toBe(0);
  } finally { await t.close(); }
});
// control: split UTF-8 at every raw byte, including array-valued WS data;
// upstream plus issuance/delivery gates lands exactly at the shared cap.
it.each(["child", "incoming"] as const)("T-UPSTREAM-BUDGET VPS %s split UTF-8 exact cap", async direction => {
  const t = await fixture(direction, false);
  try {
    expect(t.f.refusals).toBe(0); expect(t.f.budget.counts.bytes).toBe(budgets!.RELEASE_LIMITS.bytes);
    expect(t.other.counts.bytes).toBe(0); expect(t.child.kill).not.toHaveBeenCalled();
    if (direction === "child") expect(t.ws.send).toHaveBeenCalledWith(t.frame, expect.any(Function));
    else expect(t.writes).toHaveBeenCalledExactlyOnceWith(t.frame + "\n");
    expect(t.spawn).toHaveBeenCalledTimes(1);
  } finally { await t.close(); }
});
