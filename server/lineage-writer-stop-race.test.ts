// R8b/R8c: the owner's Stop against the synchronous writer transaction that refuses the turn (database.ts transaction: operation, then COMMIT or ROLLBACK, no await).
// An HTTP Stop cannot run inside it: S1 awaits readBody first and the loop is blocked until COMMIT. So the real orderings are BEFORE and AFTER, and the
// "inside" cell is an explicit synchronous injection of the production noteOwnerStop. Everything runs through the real createLedgerLease and the real writer.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLedgerLease } from "./ledger-refusal.ts";
import { LEDGER_REFUSAL_LINE, storedRefusalLine, type TurnEnd } from "./turn-end.ts";
import { transaction } from "./database.ts";
import { checkedOpenTurns, refuseRetainedTurn } from "./memory/lineage-write.ts";
import { consumingFixture } from "./testing/consuming-fixture.ts";

const verdict = { state: "checking", reason: "not-built" } as const;
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
afterEach(() => vi.restoreAllMocks());

async function rig() {
  const stored: (string | undefined)[] = [], settled: TurnEnd[] = [], presented: TurnEnd[] = [];
  const lease = createLedgerLease({ botId: "B", threadId: "T", dispatchGeneration: "G", lineageTurnIds: ["L"], adapterLeaseId: "G" }, {
    seal() {}, quarantine() {}, async interrupt() { return true; },
    settle(_reason, _verdict, end) { settled.push(end); stored.push(storedRefusalLine(end)); },
    present(end) { presented.push(end); },
  });
  lease.attach("P");
  const f = consumingFixture(undefined, { onRefused: v => lease.onLedgerRefused(v) });
  const open = checkedOpenTurns(f.turn)[0]!;
  // The production function text over this scope, as the owner-Stop test does.
  const start = source.indexOf("function noteOwnerStop("), text = source.slice(start, source.indexOf("\n}\n", start) + 2);
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const stop = new Function("directRuns", "internalTurnOwners", "admittedLedgerLeases", `${js}\nreturn noteOwnerStop;`)(
    new Map([["T", { generation: "G" }]]), new Map(), new Map([["G", lease]])) as (threadId: string) => void;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const late = () => warn.mock.calls.map(call => String(call[0])).filter(line => line.startsWith("[turn] late-cause="));
  return { lease, open, stop, settled, presented, stored, late, close: () => f.close() };
}
const refuse = (r: Awaited<ReturnType<typeof rig>>) => refuseRetainedTurn(r.open, verdict);
const L = { kind: "ledger", line: LEDGER_REFUSAL_LINE } as const;

describe("owner Stop against the writer transaction that refuses the turn", () => {
  it("BEFORE: Stop applied first, then the transaction refuses: silence, one full settlement, no late cause", async () => {
    const r = await rig();
    r.stop("T");
    transaction(() => { refuse(r); });
    expect({ settled: r.settled, presented: r.presented, stored: r.stored, late: r.late() })
      .toEqual({ settled: [{ kind: "silent" }], presented: [{ kind: "silent" }], stored: [undefined], late: [] });
    r.close();
  });
  it.each([["R8b commit", false], ["R8c rollback", true]] as const)("INSIDE (explicit synchronous injection), %s: Stop is a late cause, the owner reads the ledger sentence once, persisted after the transaction ends", async (_name, rollback) => {
    const r = await rig();
    const inside: unknown[] = [];
    const run = () => transaction(() => {
      refuse(r);
      r.stop("T"); // injection point: the production noteOwnerStop runs synchronously between the refusal and COMMIT/ROLLBACK
      inside.push([[...r.settled], r.late()]);
      if (rollback) throw new Error("injected rollback");
    });
    if (rollback) expect(run).toThrow("injected rollback"); else run();
    expect(inside).toEqual([[[], ["[turn] late-cause=owner-stop after=ledger"]]]); // frozen at the refusal; nothing persisted while the transaction is open
    expect({ settled: r.settled, presented: r.presented, stored: r.stored, late: r.late() })
      .toEqual({ settled: [L], presented: [L], stored: [LEDGER_REFUSAL_LINE], late: ["[turn] late-cause=owner-stop after=ledger"] });
    r.close();
  });
  it("INSIDE, as a real HTTP Stop would arrive: queued behind the synchronous transaction, so it runs AFTER the commit, never inside", async () => {
    const r = await rig();
    const order: string[] = [];
    const queued = new Promise<void>(resolve => setImmediate(() => { order.push("stop-ran"); r.stop("T"); resolve(); })); // the route continuation after readBody
    transaction(() => { refuse(r); order.push("refused"); });
    order.push("committed");
    expect(order).toEqual(["refused", "committed"]); // the queued Stop has not run: it cannot interleave
    await queued;
    expect(order).toEqual(["refused", "committed", "stop-ran"]);
    expect({ settled: r.settled, presented: r.presented, stored: r.stored, late: r.late() })
      .toEqual({ settled: [L], presented: [L], stored: [LEDGER_REFUSAL_LINE], late: ["[turn] late-cause=owner-stop after=ledger"] });
    r.close();
  });
  it("AFTER: Stop applied once the transaction has committed and the line persisted: the ledger sentence stands, Stop is a late cause", async () => {
    const r = await rig();
    transaction(() => { refuse(r); });
    expect(r.stored).toEqual([LEDGER_REFUSAL_LINE]);
    r.stop("T");
    expect({ settled: r.settled, presented: r.presented, stored: r.stored, late: r.late() })
      .toEqual({ settled: [L], presented: [L], stored: [LEDGER_REFUSAL_LINE], late: ["[turn] late-cause=owner-stop after=ledger"] });
    r.close();
  });
  it("the writer refuses a promise, so no awaited Stop can be held inside it", () => {
    expect(() => transaction((() => Promise.resolve()) as () => void)).toThrow("ASYNC_DATABASE_TRANSACTION");
  });
});

describe("S1 route proof: the Stop button route reads its body before it notes the Stop, and notes it first in the Stop routine", () => {
  const at = source.indexOf('m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/interrupt$/);');
  const route = source.slice(at, at + 9000);
  it("S1 awaits readBody before any stop call, and the direct branch reaches stopDirectThreadForOwner, whose first statement is noteOwnerStop", () => {
    expect(at).toBeGreaterThan(-1);
    expect(route.indexOf("await readBody(req)")).toBeGreaterThan(-1);
    expect(route.indexOf("await readBody(req)")).toBeLessThan(route.indexOf("stopDirectThreadForOwner(bot,threadId)"));
    const fn = source.slice(source.indexOf("async function stopDirectThreadForOwner("));
    expect(fn.split("\n")[1]).toBe("  noteOwnerStop(threadId);");
  });
});
