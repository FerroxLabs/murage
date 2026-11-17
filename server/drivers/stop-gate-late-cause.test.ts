// Late cause on a detached startup (the Codex shape): the lease's earlier line stays the owner's one sentence; later causes and
// later failures are logged, never presented. Real createStopGate, real createLedgerLease, the refusal thrown by refuseConsumingTurn.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStopGate } from "./stop-gate.ts";
import { createLedgerLease } from "../ledger-refusal.ts";
import { refuseConsumingTurn, type ConsumingTurnBinding } from "../consuming-turn-response.ts";
import { LEDGER_REFUSAL_LINE, MCP_CLOUD_UNAVAILABLE_TEXT, type TurnEnd } from "../turn-end.ts";

const verdict = { state: "checking", reason: "not-built" } as const;
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
afterEach(() => vi.restoreAllMocks());

function rig() {
  const presented: TurnEnd[] = [], settled: TurnEnd[] = [], events: Array<Record<string, unknown>> = [];
  const lease = createLedgerLease({ botId: "B", threadId: "t", dispatchGeneration: "G", lineageTurnIds: ["L"], adapterLeaseId: "G" }, {
    seal() {}, quarantine() {}, async interrupt() { return true; },
    settle(_reason, _verdict, end) { settled.push(end); }, present(end) { presented.push(end); },
  });
  lease.attach("P");
  const binding = { onLedgerRefused: lease.onLedgerRefused, noteCause: (cause: Parameters<typeof lease.noteCause>[0]) => { lease.noteCause(cause); }, turnEnd: () => lease.end() } as unknown as ConsumingTurnBinding;
  const gate = createStopGate({ engineName: "Fake", emit: event => events.push(event), base: (threadId, turnId) => ({ threadId, turnId }) });
  const lines = (ends: TurnEnd[]) => ends.map(end => end.kind === "silent" ? null : end.line);
  const endings = () => events.filter(event => event.type === "turn.completed").length;
  return { lease, binding, gate, presented, settled, lines, endings };
}
const logged = (warn: { mock: { calls: unknown[][] } }, prefix: string) => warn.mock.calls.filter(call => String(call[0]).startsWith(prefix)).map(call => String(call[0]));

describe("detached startup: the later cause and the later failure are logged, the earlier line stays", () => {
  it("C9 ledger then Stop, detached: the owner reads the ledger sentence once; the Stop and the startup's own refusal add no line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig();
    const entry = r.gate.enter("t"); entry.turnId = "x";
    r.lease.onLedgerRefused(verdict);            // the ledger ends the turn first
    r.lease.noteCause("owner-stop");             // the owner's Stop arrives after it
    r.gate.handoff(entry, async () => { refuseConsumingTurn(r.binding); }, () => null); // the detached startup then meets the revoked context
    await flush();
    expect({ presented: r.lines(r.presented), settled: r.lines(r.settled), endings: r.endings(), open: r.gate.size(), late: logged(warn, "[turn] late-cause") })
      .toEqual({ presented: [LEDGER_REFUSAL_LINE], settled: [LEDGER_REFUSAL_LINE], endings: 1, open: 0, late: ["[turn] late-cause=owner-stop after=ledger"] });
  });
  it("C4 MCP then ledger, detached: the cause noted on the way to the refusal picks the MCP sentence; a second rejection after the ending is logged by the gate, not ended again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig();
    const entry = r.gate.enter("t"); entry.turnId = "x";
    let fail!: (error: Error) => void;
    r.gate.handoff(entry, () => new Promise<void>((_resolve, reject) => { fail = reject; }), () => null);
    try { refuseConsumingTurn(r.binding, verdict, "mcp-cloud-unavailable"); } catch { /* the startup's own throw */ }
    entry.finish({ ok: false, stopReason: "memory-refused" });   // the turn's single terminal
    r.lease.noteCause("owner-stop");
    fail(new Error("spawn failed late"));
    await flush();
    expect({ presented: r.lines(r.presented), settled: r.lines(r.settled), endings: r.endings(), late: logged(warn, "[turn] late-cause"), gate: logged(warn, "stop-gate: late rejection") })
      .toEqual({ presented: [MCP_CLOUD_UNAVAILABLE_TEXT], settled: [MCP_CLOUD_UNAVAILABLE_TEXT], endings: 1,
        late: ["[turn] late-cause=owner-stop after=mcp-cloud"], gate: ["stop-gate: late rejection after the turn ended"] });
  });
});
