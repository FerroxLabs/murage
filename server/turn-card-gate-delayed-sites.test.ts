// W7: shipped watchdog writers while the real Stop waits for teardown.
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { source } from "./decision-wiring/fixture.ts";
import { stopCardRig } from "./decision-wiring/turn-card-fixture.ts";
import { TurnWatchdog } from "./turn-watchdog.ts";

const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function stallCallback(): string {
  let callback: ts.Node | undefined;
  function visit(n: ts.Node) {
    if (ts.isPropertyAssignment(n) && n.name.getText(ast) === "onStall") callback = n.initializer;
    ts.forEachChild(n, visit);
  }
  visit(ast);
  if (!callback) throw new Error("Missing production onStall");
  return callback.getText(ast);
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("STOP-CARD W7: watchdog fires while the owner's interrupt is held", () => {
  it.each([true, false])("fake clock runs the shipped onStall with direct run=%s; no card, settlement and drain still run", async running => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
    const held = deferred<{ status: string }>(), entered = deferred();
    const cards: unknown[] = [], settlements: unknown[] = [], drains: string[] = [];
    const r = stopCardRig(`
      const stalledWatch = new TurnWatchdog({ stallMs: 10, checkMs: 10, onStall: ${stallCallback()} });
      globalThis.extra = {
        arm: () => { stalledWatch.watch("T", "B", { generation: "G" }); stalledWatch.start(); },
        disarm: () => stalledWatch.stop()
      };`, {
      TurnWatchdog, setTimeout, clearTimeout,
      releaseBrowserCapabilityForThread: async () => {},
      registry: { get: () => ({ adapter: { interruptTurn: () => { entered.resolve(); return held.promise; } } }) },
      roomStallCompletions: { stall: () => false },
      recordMemorySettlement: (...args: unknown[]) => settlements.push(args),
      drainQueuedSends: () => drains.push("drain"), reportUnconfirmedDirectStop: vi.fn(),
      store: { appendMessage: (_t: string, m: unknown) => cards.push(m), activeLeaf: () => "leaf", setTaskActivity() {}, bot: () => ({ id: "B", modelSelection: { instanceId: "I" } }) },
      revokeInternalThread() {}, repeats: { settle() {} }, finalizeDelegationWatch() {}, status: (name: string) => name,
      turnUsage: new Map(), TURN_STALL_MS: 10, TURN_HEARTBEAT_ONLY_MS: 10,
    }, { running });
    if (!running) r.leases.clear();
    r.built.arm();
    r.built.noteOwnerStop("T");
    const stopping = r.built.interruptDirectThread("B", "T", running ? "G" : undefined);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10);
    expect(cards).toEqual([]);
    held.resolve({ status: "stopped" });
    await stopping;
    await vi.advanceTimersByTimeAsync(0);
    r.built.disarm();
    expect({ cards, settlements, drains }).toEqual({ cards: [], settlements: [["T", "watchdog:leaf", "interrupted"]], drains: running ? ["drain"] : [] });
  });
});
