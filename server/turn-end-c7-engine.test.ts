// C7 rule B through the shipped index.ts functions: the engine's error freezes on the admitted lease, completion drops the lease
// from the map, and the relay's later Cloud refusal still reaches that lease and is logged against the engine result.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { consumingFixture } from "./testing/consuming-fixture.ts";
import { fixtureBoundTurn } from "./testing/mcp-admission-fixture.ts";
import { createLedgerLease } from "./ledger-refusal.ts";
import { MCP_CLOUD_UNAVAILABLE_TEXT, ENGINE_FALLBACK_TEXT, ownerEngineText, type TurnEnd } from "./turn-end.ts";
import { ERROR_MESSAGE_MAX } from "../shared/provider-error.ts";
import { wiring } from "./decision-wiring/fixture.ts";
import { setCloudMcpScopeLauncher, McpScopeUnavailableError } from "./drivers/mcp-stop-runtime.ts";
import type { SendTurnInput } from "./contracts.ts";

const planned = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./drivers/mcp-stop-runtime.ts", async original => {
  const real = await original<typeof import("./drivers/mcp-stop-runtime.ts")>();
  return { ...real, planMcpSpawn: (owner: string, options: Parameters<typeof real.planMcpSpawn>[1] = {}) => { planned.calls++; return real.planMcpSpawn(owner, { ...options, platform: "linux", cloud: true }); } };
});
const { CliMountRelay, setRelayListenHookForTest } = await import("./drivers/cli-mount-relay.ts");

const verdict = { state: "checking", reason: "not-built" } as const;
const ENGINE_LINE = "The engine closed before it answered.";
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { setRelayListenHookForTest(undefined); planned.calls = 0; setCloudMcpScopeLauncher(null); vi.restoreAllMocks(); for (const c of cleanups.splice(0).reverse()) await c(); });
const lateCauses = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter(c => String(c[0]).startsWith("[turn] late-cause"));

function rig(handedBack = true) {
  const settled: TurnEnd[] = [], presented: TurnEnd[] = [];
  const lease = createLedgerLease({ botId: "B", threadId: "T", dispatchGeneration: "G", lineageTurnIds: ["L"], adapterLeaseId: "G" }, {
    seal() {}, quarantine() {}, async interrupt() { return true; },
    settle(_reason, _verdict, end) { settled.push(end); }, present(end) { presented.push(end); },
  });
  if (handedBack) lease.attach("P");
  const admittedLedgerLeases = new Map([["G", lease]]);
  // The dispatch's admission source, as the bus records it for each execution event and admitLedgerLease maps it.
  const admission = {}, source = { admission, attachment: "A" }, sources = new WeakMap<object, typeof source>();
  const index = wiring(["runtimeErrorCardName", "admittedLeaseForEvent", "admittedTurnEndPorts", "terminalDispatchFor"], { ownerEngineText, ERROR_MESSAGE_MAX, admittedLedgerLeases,
    bus: { sourceForExecution: (event: object) => sources.get(event) }, ledgerLeasesByAdmission: new Map([[admission, lease]]),
    ledgerCompletionSources: new Map([[lease, source]]), ledgerProviderInstances: new Map([[lease, "I"]]) });
  // The binding gets its ports exactly as index.ts builds them at bind time.
  const ports = index.admittedTurnEndPorts!("G");
  const f = consumingFixture(undefined, { botId: randomUUID(), lease: { noteCause: ports.noteCause, end: ports.turnEnd } }); cleanups.push(() => f.close());
  const turn = fixtureBoundTurn({ threadId: f.turn.threadId, text: "isolated", warmIdentity: { botId: f.binding.identity.botId, audience: "owner" }, releaseBinding: f.binding } as SendTurnInput);
  const create = () => CliMountRelay.create(turn, { one: { command: "fixture-mcp", args: [], env: {} } }, {}, null, vi.fn() as never);
  /** The fold's two steps for one provider event: find the lease (completion drops it), then the error card if any. */
  const fold = (type: "runtime.error" | "turn.completed", message = ENGINE_LINE) => {
    const event = { type, threadId: "T", turnId: "P", providerInstanceId: "I" }; sources.set(event, source);
    const found = index.admittedLeaseForEvent!(event);
    return type === "runtime.error" ? index.runtimeErrorCardName!(message, found.lease) as string : undefined;
  };
  const text = (ends: TurnEnd[]) => ends.map(e => e.kind === "silent" ? null : e.line);
  return { lease, admittedLedgerLeases, settled, presented, create, fold, text, turn };
}
function hold() {
  let release!: () => void, enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  setRelayListenHookForTest(async () => { calls++; enter(); await gate; });
  return { entered, release, get calls() { return calls; } };
}

describe("C7 rule B on the real path: the engine result froze while the relay was held", () => {
  it("B: the card keeps the engine line, completion drops the lease, the late MCP cause is logged once after=engine, nothing else is shown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig(); const h = hold();
    const created = r.create().then(() => undefined, (error: unknown) => error);
    await h.entered;
    const card = r.fold("runtime.error");
    r.fold("turn.completed");
    expect({ card, frozen: r.lease.state, admitted: r.admittedLedgerLeases.size }).toEqual({ card: `error: ${ENGINE_LINE}`, frozen: "settled", admitted: 0 });
    h.release();
    expect(await created).toBeInstanceOf(McpScopeUnavailableError);
    r.lease.onLedgerRefused(verdict); // the driver's catch refuses next; the settled lease takes no second line
    expect({ hook: h.calls, plans: planned.calls, late: lateCauses(warn), settled: r.text(r.settled), presented: r.text(r.presented), noted: r.lease.noteCause("mcp-cloud-unavailable") })
      .toEqual({ hook: 1, plans: 1, late: [["[turn] late-cause=mcp-cloud-unavailable after=engine"]], settled: [], presented: [], noted: false });
  });
  it("C: nothing froze while held; the MCP cause is noted first and the later error card shows the MCP sentence, no log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig(); const h = hold();
    const created = r.create().then(() => undefined, (error: unknown) => error);
    await h.entered; h.release();
    expect(await created).toBeInstanceOf(McpScopeUnavailableError);
    expect({ card: r.fold("runtime.error"), late: lateCauses(warn) }).toEqual({ card: `error: ${MCP_CLOUD_UNAVAILABLE_TEXT}`, late: [] });
  });
  it("engine text that breaks the copy rules freezes as the fallback sentence", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig();
    expect(r.fold("runtime.error", "unsafe request")).toBe(`error: ${ENGINE_FALLBACK_TEXT}`);
    expect(r.lease.end()).toEqual({ kind: "engine", line: ENGINE_FALLBACK_TEXT });
  });
});

describe("C7 before handback: the engine emits its error and completion before sendTurn returns (ACP, core.ts sendTurn)", () => {
  it("the unattached lease is found through the dispatch's admission, freezes the engine line, and the late MCP cause logs after=engine once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig(false); const h = hold();
    const created = r.create().then(() => undefined, (error: unknown) => error);
    await h.entered;
    const card = r.fold("runtime.error");
    r.fold("turn.completed");
    expect({ card, id: r.lease.providerTurnId, frozen: r.lease.state, end: r.lease.end(), admitted: r.admittedLedgerLeases.size })
      .toEqual({ card: `error: ${ENGINE_LINE}`, id: "P", frozen: "settled", end: { kind: "engine", line: ENGINE_LINE }, admitted: 0 });
    r.lease.attach("P"); // sendTurn returns the same id afterwards: accepted, no refusal
    h.release();
    expect(await created).toBeInstanceOf(McpScopeUnavailableError);
    expect({ late: lateCauses(warn), settled: r.text(r.settled), presented: r.text(r.presented), verdict: r.lease.verdict })
      .toEqual({ late: [["[turn] late-cause=mcp-cloud-unavailable after=engine"]], settled: [], presented: [], verdict: undefined });
  });
});
