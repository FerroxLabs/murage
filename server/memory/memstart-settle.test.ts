import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Run the production function body with a deterministic clock and drain boundary.
// This observes exactly the existing loop's waits, returns and throws; no real time or store is shared.
const source = readFileSync(new URL("./memory-revocation.ts", import.meta.url), "utf8");
const start = source.indexOf("export async function settleRevokesForTurn(");
const end = source.indexOf("/** Wakes the runner", start);
const js = ts.transpile(source.slice(start, end).replace("export async", "async"), { target: ts.ScriptTarget.ES2022 });
function fixture(opts: { pending?: boolean[]; wait?: number; tx?: boolean; drainError?: boolean; queryError?: boolean; waitError?: boolean; logError?: boolean; releaseTx?: boolean } = {}) {
  let now = 0, calls = 0; const waits: string[] = [], logs: string[] = [];
  const failure = new Error("private diagnostic detail");
  const db = { isTransaction: opts.tx ?? false, prepare: vi.fn(() => { if (opts.queryError) throw failure; return { get: () => ({ activeJobs: 7 }) }; }) };
  const drain = vi.fn(() => { calls++; if (opts.drainError) throw failure; return opts.pending?.[calls - 1] ?? true; });
  const settle = new Function("performance", "drainRevokeMarkerBounded", "revokeWriteWaitMs", "revokeSliceNeed", "setTimeout", "setImmediate", "console", js + ";return settleRevokesForTurn;")(
    { now: () => now }, drain, () => { if (opts.waitError) throw failure; return opts.wait ?? 0; }, () => 1,
    (fn: () => void, ms: number) => { waits.push(`timeout:${ms}`); now += ms; fn(); return { unref() {} }; },
    (fn: () => void) => { waits.push("immediate"); now += 10; if (opts.releaseTx) db.isTransaction = false; fn(); },
    { warn: (line: string) => { logs.push(line); if (opts.logError) throw failure; } },
  );
  return { db, drain, waits, logs, failure, run: (ms = 20) => settle(db, ms) };
}
function line(f: ReturnType<typeof fixture>, outcome: string, ms: number, slices: number, jobs = 7) {
  expect(f.logs).toEqual([`[memory] settle outcome=${outcome} ms=${ms} slices=${slices} activeJobs=${jobs}`]);
}
describe("MEMSTART D / T11 observes existing settle exits", () => {
  it("cleared, one actual drain attempt", async () => { const f = fixture({ pending: [false] }); expect(await f.run()).toBe(true); expect(f.waits).toEqual([]); line(f, "cleared", 0, 1); });
  it("deadline keeps the same yields and drain count", async () => { const f = fixture(); expect(await f.run()).toBe(false); expect(f.waits).toEqual(["immediate", "immediate"]); expect(f.drain).toHaveBeenCalledTimes(3); line(f, "deadline", 20, 3); });
  it("budget beyond deadline exits without a wait", async () => { const f = fixture({ wait: 21 }); expect(await f.run()).toBe(false); expect(f.waits).toEqual([]); line(f, "budget", 0, 1); });
  it("shorter budget wait still retries", async () => { const f = fixture({ wait: 6, pending: [true, false] }); expect(await f.run()).toBe(true); expect(f.waits).toEqual(["timeout:6"]); line(f, "cleared", 6, 2); });
  it("in-tx loops to the existing deadline, never drains", async () => { const f = fixture({ tx: true }); expect(await f.run()).toBe(false); expect(f.waits).toEqual(["immediate", "immediate"]); expect(f.drain).not.toHaveBeenCalled(); line(f, "in-tx", 20, 0); });
  it("in-tx can end and then clear, with only one drain", async () => { const f = fixture({ tx: true, releaseTx: true, pending: [false] }); expect(await f.run()).toBe(true); expect(f.waits).toEqual(["immediate"]); line(f, "cleared", 10, 1); });
  it("in-tx budget is still the budget exit", async () => { const f = fixture({ tx: true, wait: 21 }); expect(await f.run()).toBe(false); line(f, "budget", 0, 0); });
  it("caught drain error still returns false", async () => { const f = fixture({ drainError: true }); expect(await f.run()).toBe(false); line(f, "error", 0, 1); });
  it("uncaught wait computation error still throws the same object", async () => { const f = fixture({ waitError: true }); await expect(f.run()).rejects.toBe(f.failure); line(f, "error", 0, 1); });
  it("query failure does not hide the exit or invent a count", async () => { const f = fixture({ queryError: true, pending: [false] }); expect(await f.run()).toBe(true); line(f, "cleared", 0, 1, -1); });
  it("logging failure changes neither return nor exception", async () => { const f = fixture({ logError: true, pending: [false] }); expect(await f.run()).toBe(true); const g = fixture({ logError: true, waitError: true }); await expect(g.run()).rejects.toBe(g.failure); });
});
