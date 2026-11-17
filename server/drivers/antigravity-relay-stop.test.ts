// The Antigravity relay-failure end, driven as shipped (endOnRelayFailure) with a real lease behind the binding:
// after the owner's Stop the refusal puts no card and no reply on the stream, and the turn still settles.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { createLedgerLease } from "../ledger-refusal.ts";
import { refuseConsumingTurn } from "../consuming-turn-response.ts";
import { LEDGER_REFUSAL_LINE, MCP_CLOUD_UNAVAILABLE_TEXT, type TurnEnd } from "../turn-end.ts";
import { endOnRelayFailure } from "./antigravity.ts";

const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const c of cleanups.splice(0).reverse()) await c(); });

function rig() {
  const settled: TurnEnd[] = [], presented: TurnEnd[] = [];
  const lease = createLedgerLease({ botId: "B", threadId: "T", dispatchGeneration: "G", lineageTurnIds: ["L"], adapterLeaseId: "G" }, {
    seal() {}, quarantine() {}, async interrupt() { return true; },
    settle(_reason, _verdict, end) { settled.push(end); }, present(end) { presented.push(end); },
  });
  lease.attach("P");
  // The fence refusal reaches the admitted lease, as index.ts wires it.
  const f = consumingFixture(undefined, { botId: randomUUID(), lease, onRefused: verdict => lease.onLedgerRefused(verdict) }); cleanups.push(() => f.close());
  const stream: string[] = [];
  let stops = 0, refusedSettles = 0;
  /** The relay seals (the ledger refusal through the binding), then calls the driver's failure callback. */
  const relayFails = () => {
    try { refuseConsumingTurn(f.binding); } catch { /* the refusal throws MEMORY_CONTEXT_REVOKED to its caller */ }
    endOnRelayFailure({ releaseBinding: f.binding }, () => { stops++; }, message => { stream.push(message); }, () => { refusedSettles++; });
  };
  // What the index presenter stores: no line for silent.
  const stored = () => presented.filter(e => e.kind !== "silent").map(e => (e as { line: string }).line);
  return { lease, relayFails, stream, stored, settled, get stops() { return stops; }, get refusedSettles() { return refusedSettles; } };
}

describe("Antigravity relay failure after the owner's Stop", () => {
  it("Stop first: the child stops, the turn settles refused, and no card or reply appears anywhere", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig();
    r.lease.noteCause("owner-stop"); // noteOwnerStop at the Stop route
    r.relayFails();
    expect({ stream: r.stream, stored: r.stored(), settled: r.settled, stops: r.stops, refusedSettles: r.refusedSettles })
      .toEqual({ stream: [], stored: [], settled: [{ kind: "silent" }], stops: 1, refusedSettles: 1 });
  });
  it("no Stop: the stream and the stored notice carry the one ledger sentence", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig(); r.relayFails();
    expect({ stream: r.stream, stored: r.stored(), refusedSettles: r.refusedSettles }).toEqual({ stream: [LEDGER_REFUSAL_LINE], stored: [LEDGER_REFUSAL_LINE], refusedSettles: 1 });
  });
  it("MCP cause first: the stream and the stored notice carry the MCP sentence", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig(); r.lease.noteCause("mcp-cloud-unavailable"); r.relayFails();
    expect({ stream: r.stream, stored: r.stored() }).toEqual({ stream: [MCP_CLOUD_UNAVAILABLE_TEXT], stored: [MCP_CLOUD_UNAVAILABLE_TEXT] });
  });
});
