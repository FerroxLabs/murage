// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Search latency on the 60k fixture for the msearch round-3 fix (authorize before ranking). Off unless MEMORY_PERF=1.
// The helper's answer is worked out once outside the timing (the helper is another process); what is timed is the main
// thread's whole searchMemory: word index read, candidate checks, ranking, hydration. Prints one PERF line.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { MemoryEligibility } from "./eligibility.ts";
import { MemoryIndex } from "./index.ts";
import { closeMemoryIndexReader } from "./index-reader.ts";
import { searchMemory } from "./search.ts";
import { accessFor } from "./testing/recall-fixture.ts";
import { loadPerfFixture, perfEnabled, perfQueries, perfShape } from "./testing/perf-fixture.ts";

const suite = perfEnabled() ? describe : describe.skip;
const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : 0; };

suite("msearch round 3: search latency on the 60k fixture", () => {
  beforeAll(() => { loadPerfFixture(perfShape()); }, 30 * 60_000);
  afterAll(() => { closeMemoryIndexReader(); closeDatabase(); });

  it("tool search p50 with the helper's answer in hand", async () => {
    const queries = perfQueries(60), { access } = accessFor();
    const authority = new MemoryEligibility(join(DATA_DIR, "messages.db")), index = new MemoryIndex(join(DATA_DIR, "memory-index.db"));
    const answers = new Map<string, Record<string, unknown>>();
    for (const query of queries) {
      const eligible = authority.read({ scopeIds: [...access.scopeIds], policyRevision: access.policyRevision, deletionEpoch: access.deletionEpoch, historical: false, cursor: "" });
      answers.set(query, { ...index.search(query, eligible.allowed, null, "none", 20), coverageComplete: true });
    }
    authority.close(); index.close();
    const bridge = { search: async (input: { query: string }) => (answers.get(input.query) ?? { hits: [], vectorRows: 0 }) as never };
    const times: number[] = [];
    for (let n = 0; n < 5 + 120; n++) {
      const query = queries[n % queries.length], started = performance.now();
      await searchMemory(query, access, bridge, { caller: "tool", limit: 20 });
      if (n >= 5) times.push(performance.now() - started);
    }
    const line = JSON.stringify({ label: process.env.MEMORY_PERF_LABEL ?? "run", name: "msearch-r3.search", n: times.length, p50: Math.round(percentile(times, 0.5) * 10) / 10, p95: Math.round(percentile(times, 0.95) * 10) / 10, max: Math.round(Math.max(...times) * 10) / 10 });
    console.log(`PERF ${line}`);
    if (process.env.MEMORY_PERF_OUT) appendFileSync(process.env.MEMORY_PERF_OUT, `${line}\n`);
    expect(times.length).toBe(120);
  }, 30 * 60_000);
});
