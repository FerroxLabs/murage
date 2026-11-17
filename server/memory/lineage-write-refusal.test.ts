// R8: a refusal raised by the retained turn inside the writer transaction of a real lineage write. The lease picks its one sentence at the
// refusal, the commit or rollback only delays persistence, and a cause that arrives inside the same transaction is late.
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { appendMessage, closeMessageDb } from "../message-db.ts";
import { checkedOpenTurns, closeTurnLineage, openTurnLineage, refuseRetainedTurn } from "./lineage-write.ts";
import { prepareRetainedFence } from "./send-fence.ts";
import { MEMBER } from "./testing/writetime-fixture.ts";
import { createLedgerLease } from "../ledger-refusal.ts";
import { LEDGER_REFUSAL_LINE, MCP_CLOUD_UNAVAILABLE_TEXT, type TurnEnd } from "../turn-end.ts";
import type { LineageVerdict } from "./lineage-types.ts";

const verdict: LineageVerdict = { state: "checking", reason: "not-built" };
afterAll(() => closeMessageDb());
beforeEach(() => { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); vi.restoreAllMocks(); });

function rig() {
  const settled: TurnEnd[] = [], presented: TurnEnd[] = [];
  const lease = createLedgerLease({ botId: "B", threadId: "R8", dispatchGeneration: "G", lineageTurnIds: ["L"], adapterLeaseId: "G" }, {
    seal() {}, quarantine() {}, async interrupt() { return true; },
    settle(_reason, _verdict, end) { settled.push(end); }, present(end) { presented.push(end); },
  });
  lease.attach("P");
  const turn = openTurnLineage(database(), { threadId: "R8", turnId: randomUUID() });
  prepareRetainedFence(turn, MEMBER, v => lease.onLedgerRefused(v), database());
  const [open] = checkedOpenTurns(turn);
  const text = (ends: TurnEnd[]) => ends.map(e => e.kind === "silent" ? null : e.line);
  // The real lineage write: a message append inside the same writer transaction.
  const write = (id: string) => appendMessage("R8", { id, role: "bot", kind: "text", text: id, at: Date.now() });
  return { lease, open: open!, turn, settled, presented, text, write };
}
const written = () => (database().prepare("SELECT json FROM messages WHERE thread_id = ?").all("R8") as Array<{ json: string }>).map(row => (JSON.parse(row.json) as { id: string }).id);
const late = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter(c => String(c[0]).startsWith("[turn] late-cause")).map(c => c[0]);

describe("R8: the refusal inside the lineage-write transaction", () => {
  it("R8a: MCP noted before the refusal, commit: the MCP sentence, one persistence, written after the commit", () => {
    const r = rig(); r.lease.noteCause("mcp-cloud-unavailable");
    transaction(() => { r.write("a1"); refuseRetainedTurn(r.open, verdict); expect(r.settled).toEqual([]); });
    expect({ settled: r.text(r.settled), presented: r.text(r.presented) }).toEqual({ settled: [MCP_CLOUD_UNAVAILABLE_TEXT], presented: [MCP_CLOUD_UNAVAILABLE_TEXT] });
    expect(written()).toContain("a1");
    closeTurnLineage(r.turn);
  });
  it("R8b: owner Stop arrives inside the same transaction after the refusal, commit: the ledger sentence stands, one persistence, one late log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig();
    transaction(() => { r.write("b1"); refuseRetainedTurn(r.open, verdict); expect(r.lease.noteCause("owner-stop")).toBe(false); });
    expect({ settled: r.text(r.settled), presented: r.text(r.presented) }).toEqual({ settled: [LEDGER_REFUSAL_LINE], presented: [LEDGER_REFUSAL_LINE] });
    expect(late(warn)).toEqual(["[turn] late-cause=owner-stop after=ledger"]);
    closeTurnLineage(r.turn);
  });
  it("R8c: the same, rolled back: the lineage write is gone, the refusal is still persisted once with the same sentence", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig();
    expect(() => transaction(() => { r.write("c1"); refuseRetainedTurn(r.open, verdict); r.lease.noteCause("owner-stop"); throw new Error("writer failed"); })).toThrow("writer failed");
    expect(written()).not.toContain("c1");
    expect({ settled: r.text(r.settled), presented: r.text(r.presented) }).toEqual({ settled: [LEDGER_REFUSAL_LINE], presented: [LEDGER_REFUSAL_LINE] });
    expect(late(warn)).toEqual(["[turn] late-cause=owner-stop after=ledger"]);
    closeTurnLineage(r.turn);
  });
  it("R8d: MCP noted, rolled back: the MCP sentence, one persistence", () => {
    const r = rig(); r.lease.noteCause("mcp-cloud-unavailable");
    expect(() => transaction(() => { r.write("d1"); refuseRetainedTurn(r.open, verdict); throw new Error("writer failed"); })).toThrow("writer failed");
    expect({ settled: r.text(r.settled), presented: r.text(r.presented) }).toEqual({ settled: [MCP_CLOUD_UNAVAILABLE_TEXT], presented: [MCP_CLOUD_UNAVAILABLE_TEXT] });
    closeTurnLineage(r.turn);
  });
  it("R8 stop first: an owner Stop noted before the transaction makes the refusal silent, settled once", () => {
    const r = rig(); r.lease.noteCause("owner-stop");
    transaction(() => { r.write("e1"); refuseRetainedTurn(r.open, verdict); });
    expect(r.settled).toEqual([{ kind: "silent" }]); expect(r.presented).toEqual([{ kind: "silent" }]);
    closeTurnLineage(r.turn);
  });
});
