// The Cloud launch refusal is noted on the admitted lease by the real CliMountRelay.create, before the owner sentence is chosen.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { fixtureBoundTurn } from "../testing/mcp-admission-fixture.ts";
import { createLedgerLease } from "../ledger-refusal.ts";
import { LEDGER_REFUSAL_LINE, MCP_CLOUD_UNAVAILABLE_TEXT, type TurnEnd } from "../turn-end.ts";
import { setCloudMcpScopeLauncher, McpScopeUnavailableError } from "./mcp-stop-runtime.ts";
import type { SendTurnInput } from "../contracts.ts";

// Run the real planner as the Cloud role would (no broker directory exists in a test container): same function, cloud forced on.
const planned = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./mcp-stop-runtime.ts", async original => {
  const real = await original<typeof import("./mcp-stop-runtime.ts")>();
  return { ...real, planMcpSpawn: (owner: string, options: Parameters<typeof real.planMcpSpawn>[1] = {}) => { planned.calls++; return real.planMcpSpawn(owner, { ...options, platform: "linux", cloud: true }); } };
});
const { CliMountRelay, setRelayListenHookForTest } = await import("./cli-mount-relay.ts");

const verdict = { state: "checking", reason: "not-built" } as const;
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { setRelayListenHookForTest?.(undefined); planned.calls = 0; setCloudMcpScopeLauncher(null); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function rig() {
  const settled: TurnEnd[] = [], presented: TurnEnd[] = [];
  const lease = createLedgerLease({ botId: "B", threadId: "T", dispatchGeneration: "G", lineageTurnIds: ["L"], adapterLeaseId: "G" }, {
    seal() {}, quarantine() {}, async interrupt() { return true; },
    settle(_reason, _verdict, end) { settled.push(end); }, present(end) { presented.push(end); },
  });
  lease.attach("P");
  const f = consumingFixture(undefined, { botId: randomUUID(), lease }); cleanups.push(() => f.close());
  const base: SendTurnInput = { threadId: f.turn.threadId, text: "isolated", warmIdentity: { botId: f.binding.identity.botId, audience: "owner" }, releaseBinding: f.binding };
  const turn = fixtureBoundTurn(base);
  const spawn = vi.fn();
  const create = () => CliMountRelay.create(turn, { one: { command: "fixture-mcp", args: [], env: {} } }, {}, null, spawn as never);
  const text = (ends: TurnEnd[]) => ends.map(e => e.kind === "silent" ? null : e.line);
  return { lease, settled, presented, spawn, create, text, turn, revoke: () => f.replace() };
}

describe("relay origin: the Cloud refusal reaches the lease through the real CliMountRelay.create", () => {
  it("C1: the relay notes the cause itself; the lease then refuses and the owner sees the MCP sentence, stored and presented", async () => {
    const r = rig();
    await expect(r.create()).rejects.toBeInstanceOf(McpScopeUnavailableError);
    expect(r.spawn).not.toHaveBeenCalled();
    expect(r.lease.state).toBe("open");
    r.lease.onLedgerRefused(verdict); // what antigravity's catch does next (refuseConsumingTurn)
    expect({ settled: r.text(r.settled), presented: r.text(r.presented) }).toEqual({ settled: [MCP_CLOUD_UNAVAILABLE_TEXT], presented: [MCP_CLOUD_UNAVAILABLE_TEXT] });
  });
  it("C4 late: a ledger refusal already settled keeps its line; the relay's later cause is logged once and changes nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig();
    r.lease.onLedgerRefused(verdict);
    await expect(r.create()).rejects.toBeInstanceOf(McpScopeUnavailableError);
    expect({ settled: r.text(r.settled), presented: r.text(r.presented) }).toEqual({ settled: [LEDGER_REFUSAL_LINE], presented: [LEDGER_REFUSAL_LINE] });
    expect(warn.mock.calls.filter(c => String(c[0]).startsWith("[turn] late-cause"))).toEqual([["[turn] late-cause=mcp-cloud-unavailable after=ledger"]]);
  });
  it("owner Stop first, then the relay's refusal: silence, the cause is logged, never a sentence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig();
    r.lease.noteCause("owner-stop");
    await expect(r.create()).rejects.toBeInstanceOf(McpScopeUnavailableError);
    r.lease.onLedgerRefused(verdict);
    expect(r.presented).toEqual([{ kind: "silent" }]);
    expect(r.settled).toEqual([{ kind: "silent" }]);
    expect(warn.mock.calls.filter(c => String(c[0]).startsWith("[turn] late-cause"))).toEqual([]);
  });
});

describe("C7 seam: a test can hold the real create between its listen and its admission recheck", () => {
  const lateCauses = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter(c => String(c[0]).startsWith("[turn] late-cause"));
  /** Holds the hook; `entered` resolves when the real create reaches it, `release` lets it continue. */
  function hold() {
    let release!: () => void, enter!: (turn: SendTurnInput) => void;
    const entered = new Promise<SendTurnInput>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const seen: { plans: number }[] = [];
    setRelayListenHookForTest(async turn => { seen.push({ plans: planned.calls }); enter(turn); await gate; });
    return { entered, release, seen };
  }
  async function held(r: ReturnType<typeof rig>) {
    const h = hold();
    let outcome: "pending" | "done" = "pending";
    const created = r.create().then(() => undefined, (error: unknown) => error).finally(() => { outcome = "done"; });
    expect(await h.entered).toBe(r.turn);
    await new Promise(resolve => setTimeout(resolve, 20));
    // The create is parked inside the hook: nothing planned, nothing spawned, not settled.
    expect({ outcome, hook: h.seen, spawned: r.spawn.mock.calls.length }).toEqual({ outcome: "pending", hook: [{ plans: 0 }], spawned: 0 });
    return { ...h, created };
  }
  it("outcome A: the admission ends while held; the recheck refuses, nothing is planned, no MCP cause and no late-cause log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig(); const h = await held(r);
    r.revoke(); h.release();
    expect(((await h.created) as Error).message).toBe("MEMORY_CONTEXT_REVOKED");
    r.lease.onLedgerRefused(verdict);
    expect({ plans: planned.calls, presented: r.text(r.presented), settled: r.text(r.settled), late: lateCauses(warn) })
      .toEqual({ plans: 0, presented: [LEDGER_REFUSAL_LINE], settled: [LEDGER_REFUSAL_LINE], late: [] });
  });
  it("outcome B: the result froze while held and the admission still stands; the earlier line stays and the MCP cause is logged once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig(); const h = await held(r);
    r.lease.onLedgerRefused(verdict); h.release();
    expect(await h.created).toBeInstanceOf(McpScopeUnavailableError);
    expect({ plans: planned.calls, presented: r.text(r.presented), settled: r.text(r.settled), late: lateCauses(warn) })
      .toEqual({ plans: 1, presented: [LEDGER_REFUSAL_LINE], settled: [LEDGER_REFUSAL_LINE], late: [["[turn] late-cause=mcp-cloud-unavailable after=ledger"]] });
  });
  it("outcome C: nothing froze while held; the MCP cause is noted first and the owner reads the MCP sentence, no log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig(); const h = await held(r);
    h.release();
    expect(await h.created).toBeInstanceOf(McpScopeUnavailableError);
    r.lease.onLedgerRefused(verdict);
    expect({ plans: planned.calls, presented: r.text(r.presented), settled: r.text(r.settled), late: lateCauses(warn) })
      .toEqual({ plans: 1, presented: [MCP_CLOUD_UNAVAILABLE_TEXT], settled: [MCP_CLOUD_UNAVAILABLE_TEXT], late: [] });
  });
});
