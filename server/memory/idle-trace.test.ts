// The memory idle pass and the memory turn lines are traceable (MURAGE_TURN_TRACE=1):
// a slow synchronous step is logged by its fixed name, and a turn can report
// the search hits, lineage rows and lineage cache counts it caused.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { timedStep } from "./claim-trace.ts";
import { capturedMessageWithheld } from "./replay-lineage.ts";
import { memoryStatsSince, memoryStatsSnapshot, noteMemorySearch } from "./turn-stats.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); process.env.MURAGE_TURN_TRACE = "1"; });
afterEach(() => { delete process.env.MURAGE_TURN_TRACE; vi.restoreAllMocks(); });

it("a step over 50 ms is logged by name, a fast one and an untraced one are not", () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const lines: string[] = [];
  expect(timedStep("memory.idle.reveal-scan", () => { now += 80; return 7; }, line => lines.push(line))).toBe(7);
  timedStep("memory.idle.notebook-sync", () => { now += 10; }, line => lines.push(line));
  expect(lines).toEqual(["[turn-trace] phase=memory.idle.reveal-scan slow=true ms=80"]);
  delete process.env.MURAGE_TURN_TRACE;
  timedStep("memory.idle.migrate", () => { now += 500; }, line => lines.push(line));
  expect(lines).toHaveLength(1);
});

it("the turn stats report hits, search ms, lineage rows and cache hits and misses since a snapshot", () => {
  database();
  const before = memoryStatsSnapshot();
  noteMemorySearch(3, 12.4);
  capturedMessageWithheld("t", "m1");
  capturedMessageWithheld("t", "m1");
  const delta = memoryStatsSince(before);
  expect(delta).toMatchObject({ hits: 3, searchMs: 12, lineageHit: 1, lineageMiss: 1 });
  expect(delta.lineageRows).toBeGreaterThanOrEqual(0);
});
