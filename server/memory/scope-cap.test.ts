// A reader with more scopes than one helper message holds (the owner has hundreds) still gets semantic recall: the scope list
// travels in bounded messages and the helper answers from the whole list in one pass (scope-set.ts), so its ranking is the
// unchunked ranking. 1.0.4 lane fix/104-recall-scope-cap.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryWorkerController } from "./worker-controller.ts";
import { ScopeAssembler, SCOPE_PART_BYTES, SCOPE_PART_IDS, sendSearch, splitScopeIds } from "./scope-set.ts";
import { searchInputSchema, scopePartSchema, type MemorySearchInput, type MemorySearchResult } from "./worker-protocol.ts";
import { answerQuery } from "./worker-query.ts";

const logged = vi.hoisted(() => [] as Array<[string, string]>);
vi.mock("./worker-log.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./worker-log.ts")>();
  return { ...actual, logSwallowed: (subsystem: string, error: unknown) => { logged.push([subsystem, String(error)]); return true; } };
});

const baseInput = (scopeIds: string[]): MemorySearchInput => ({ query: "harbour lantern", scopeIds, policyRevision: 3, deletionEpoch: 2, historical: false, cursor: "", limit: 10, semantic: true });
const scopes = (n: number) => Array.from({ length: n }, (_, i) => `scope-${String(i).padStart(6, "0")}`);
const bytes = (message: unknown) => Buffer.byteLength(JSON.stringify(message));

type Internals = { child: unknown; ready: boolean; onWorkerMessage(child: unknown, message: unknown): void };
let controller: MemoryWorkerController, internals: Internals, wire: any[], answered: MemorySearchInput[];
beforeEach(() => {
  logged.length = 0; wire = []; answered = [];
  controller = new MemoryWorkerController();
  internals = controller as unknown as Internals;
  // A stand-in for the helper process: it applies the helper's own schemas and joins scope parts exactly as worker.ts does.
  const assembler = new ScopeAssembler();
  const child: any = { kill() {}, on() {}, send: (message: any) => {
    wire.push(message);
    try {
      if (message.type === "scopes") { const part = scopePartSchema.parse(message); assembler.add(message.requestId, part.part, part.ids); return; }
      if (message.type !== "query") return;
      const input = assembler.resolve(message.requestId, searchInputSchema.parse(message.input));
      answered.push(input);
      setImmediate(() => internals.onWorkerMessage(child, { type: "query-result", requestId: message.requestId, result: { hits: [], vectorRows: input.scopeIds.length } satisfies MemorySearchResult }));
    } catch { setImmediate(() => internals.onWorkerMessage(child, { type: "error", reason: "INVALID_MEMORY_SEARCH", requestId: message.requestId })); }
  } };
  internals.child = child; internals.ready = true;
});
afterEach(async () => { await controller.stop().catch(() => {}); });

it("an owner with 300 scopes gets a semantic answer, from all 300 scopes, in order", async () => {
  const ids = scopes(300);
  const result = await controller.search(baseInput(ids), new AbortController().signal);
  expect(result.vectorRows).toBe(300);
  expect(answered).toHaveLength(1);
  expect(answered[0]!.scopeIds).toEqual(ids);
  expect(answered[0]!.semantic).toBe(true);
  expect(logged).toEqual([]);
});

it("a reader within one message still sends one plain query", async () => {
  await controller.search(baseInput(scopes(40)), new AbortController().signal);
  expect(wire.map(m => m.type)).toEqual(["query"]);
  expect(wire[0].input.scopeCount).toBeUndefined();
});

it("10,000 scopes travel in messages that each stay within the size bound, and arrive whole", async () => {
  const ids = scopes(10_000);
  await controller.search(baseInput(ids), new AbortController().signal);
  expect(wire.filter(m => m.type === "scopes").length).toBeGreaterThanOrEqual(Math.ceil(10_000 / SCOPE_PART_IDS));
  for (const message of wire) { expect(bytes(message)).toBeLessThan(SCOPE_PART_BYTES + 1024); if (message.type === "scopes") expect(message.ids.length).toBeLessThanOrEqual(SCOPE_PART_IDS); }
  expect(answered[0]!.scopeIds).toEqual(ids);
  // long ids are bounded by bytes, not only by count
  const long = Array.from({ length: 400 }, (_, i) => `${i}-${"x".repeat(400)}`);
  for (const part of splitScopeIds(long)) expect(bytes(part)).toBeLessThan(SCOPE_PART_BYTES + 1024);
});

it("the helper refuses a count that does not match, and what it holds never leaks into another search", () => {
  const assembler = new ScopeAssembler();
  assembler.add("a", 0, ["s1", "s2"]);
  expect(() => assembler.resolve("a", { ...baseInput([]), scopeCount: 3 })).toThrow("scope count mismatch");
  expect(assembler.size).toBe(0);
  expect(() => assembler.resolve("b", { ...baseInput([]), scopeCount: 1 })).toThrow("scope count mismatch");
  assembler.add("c", 0, ["s1"]);
  expect(() => assembler.add("c", 5, ["s2"])).toThrow("out of order");
  expect(assembler.size).toBe(0);
  assembler.add("d", 0, ["s1"]);
  expect(() => assembler.resolve("d", baseInput(["other"]))).toThrow("without a count");
});

it("a search the helper refuses fails as a recall error and is not logged as capture", async () => {
  await expect(controller.search(baseInput([...scopes(5), "x".repeat(600)]), new AbortController().signal)).rejects.toThrow("MEMORY_QUERY_REFUSED");
  expect(logged.some(([subsystem]) => subsystem === "recall")).toBe(true);
  expect(logged.some(([subsystem]) => subsystem === "capture")).toBe(false);
});

it("a refusal for a search that already ended never reaches the capture work", async () => {
  internals.onWorkerMessage(internals.child, { type: "error", reason: "INVALID_MEMORY_SEARCH", requestId: "gone" });
  expect(logged.some(([subsystem]) => subsystem === "recall")).toBe(true);
  expect(logged.some(([subsystem]) => subsystem === "capture")).toBe(false);
  await expect(controller.search(baseInput(scopes(3)), new AbortController().signal)).resolves.toBeDefined();
});

it("ranking from a split scope list equals the unsplit ranking on a small fixture", () => {
  // The helper's ranking is a function of the scope list it is handed; split delivery hands it the same list.
  const eligibleBy = (scopeIds: string[]) => scopeIds.flatMap(s => [{ id: `${s}-r1`, version: 1 }, { id: `${s}-r2`, version: 1 }]).sort((a, b) => a.id.localeCompare(b.id));
  const index: any = { search: (_q: string, allowed: Array<{ id: string; version: number }>) => {
    const lexicalRanked = allowed.map(r => [r.id, r.version] as [string, number]);
    const vectorRanked = allowed.map((r, i) => [r.id, r.version, 1 - i / 100] as [string, number, number]);
    return { hits: [], vectorRows: allowed.length, lexicalRanked, vectorRanked, unvectored: [], unvectoredMore: false, timings: {} };
  } };
  const eligibility: any = { read: (input: MemorySearchInput) => ({ allowed: eligibleBy(input.scopeIds), capacity: false }) };
  const ids = scopes(7);
  const received: MemorySearchInput[] = [];
  const assembler = new ScopeAssembler();
  sendSearch(m => { const message = m as any; if (message.type === "scopes") assembler.add(message.requestId, message.part, message.ids); else received.push(assembler.resolve(message.requestId, message.input)); }, "r", baseInput(ids), 2);
  expect(received[0]!.scopeIds).toEqual(ids);
  const whole = answerQuery(index, eligibility, baseInput(ids), [1], "model").result;
  const split = answerQuery(index, eligibility, received[0]!, [1], "model").result;
  expect(split).toEqual(whole);
  expect(split.vectorRanked!.length).toBe(14);
});
