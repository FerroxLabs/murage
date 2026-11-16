// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { IncrementalRoutineRollup, ROUTINE_DAY_MS as DAY, ROUTINE_WINDOW_MS as WINDOW, routineNumberKey, type OrderedRoutineFact } from "./inbox-routine-aggregate.ts";
import { connectionsToRestore, rollUpRoutineRuns } from "./inbox-rollup.ts";

const NOW = 1_800_000_000_000;
function rng(seed: number) { return () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 2 ** 32; }; }
function history(size: number, seed: number): OrderedRoutineFact[] {
  const random = rng(seed);
  return Array.from({ length: size }, (_, i) => {
    const routine = Math.floor(random() * 20), failed = random() < .6;
    return { id: `run-${i}`, position: routineNumberKey(i), fact: {
      routineKey: `routine:${routine}`, routineName: `Routine ${routine}`, botLabel: `Bot ${i % 3}`,
      // Ties, old history and future timestamps are intentional.
      at: NOW - Math.floor(random() * 18 * 24) * 3_600_000,
      failed, owed: !failed && random() < .3,
      detail: ["401 unauthorized", "529 overloaded", "bad output"][Math.floor(random() * 3)],
      ...(random() < .5 ? { link: { threadId: `thread-${routine}`, messageId: `message-${i}` } } : {}),
    } };
  });
}
function oracle(entries: readonly OrderedRoutineFact[], now: number) {
  return rollUpRoutineRuns([...entries].sort((a, b) => a.position.localeCompare(b.position)).filter(entry => entry.fact.at >= now - WINDOW).map(entry => entry.fact), now);
}

describe("incremental routine day counters", () => {
  for (const size of [100, 2_000]) it(`equals the old rollup through randomized changes and expiry (${size} runs)`, () => {
    for (let seed = 1; seed <= 12; seed++) {
      const entries = history(size, seed), aggregate = new IncrementalRoutineRollup();
      aggregate.rebuild(entries, NOW, true);
      expect(aggregate.read(NOW)).toEqual(oracle(entries, NOW));
      for (let i = 0; i < 24; i++) {
        const entry = entries[i]!;
        entry.fact = { ...entry.fact, failed: i % 2 === 0, owed: i % 5 === 0, at: NOW + i };
        aggregate.upsert(entry);
        expect(aggregate.read(NOW)).toEqual(oracle(entries, NOW));
      }
      for (let i = 0; i < 4; i++) { const [entry] = entries.splice(i, 1); aggregate.remove(entry!.id); }
      for (const now of [NOW + 1, NOW + DAY, NOW + WINDOW, NOW + WINDOW + DAY]) {
        expect(aggregate.read(now)).toEqual(oracle(entries, now));
        expect(connectionsToRestore(aggregate.read(now))).toEqual(connectionsToRestore(oracle(entries, now)));
        expect(aggregate.needsConnection(now)).toBe(connectionsToRestore(oracle(entries, now)).length > 0);
      }
    }
  });

  it("counts a terminal transition once using start time across midnight, and keeps the inclusive cutoff", () => {
    const midnight = Math.floor(NOW / DAY) * DAY, aggregate = new IncrementalRoutineRollup();
    const entry: OrderedRoutineFact = { id: "cross-midnight", position: routineNumberKey(0), fact: {
      routineKey: "routine:a", routineName: "A", botLabel: "Bot", at: midnight - 1, failed: true, detail: "401 unauthorized",
    } };
    aggregate.rebuild([], midnight);
    // The run finishes after midnight; at remains the start, as before.
    aggregate.upsert(entry); aggregate.upsert(entry);
    expect(aggregate.read(midnight + WINDOW - 1)).toMatchObject([{ runs: 1, failed: 1, verdict: "stuck" }]);
    expect(aggregate.read(midnight + WINDOW)).toEqual([]);
    // Retirement after a whole bucket expired must be harmless.
    aggregate.remove(entry.id);
    expect(aggregate.read(midnight + WINDOW)).toEqual([]);
  });

  it("checks the startup rebuild against the reference computation", () => {
    const entries = history(100, 44), aggregate = new IncrementalRoutineRollup();
    aggregate.rebuild(entries, NOW, true);
    aggregate.remove(entries.find(entry => entry.fact.at >= NOW - WINDOW)!.id);
    expect(() => aggregate.assertConsistent(entries, NOW)).toThrow("consistency");
  });

  it("rebuilds from the durable source after a child exits without saving aggregate state", () => {
    const root = mkdtempSync(join(tmpdir(), "murage-rollup-restart-"));
    const source = join(root, "facts.json"), entries = history(2_000, 101);
    try {
      // The child durably writes source history, then dies before any derived
      // aggregate can be saved. No aggregate file exists by design.
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { openSync, writeSync, fsyncSync, readFileSync } from "node:fs";
        const fd = openSync(process.argv[1], "w");
        writeSync(fd, readFileSync(0)); fsyncSync(fd);
        process.exit(23);
      `, source], { encoding: "utf8", input: JSON.stringify(entries) });
      expect(child.status, child.stderr).toBe(23);
      const restored = JSON.parse(readFileSync(source, "utf8")) as OrderedRoutineFact[];
      const restarted = new IncrementalRoutineRollup();
      restarted.rebuild(restored, NOW, false);
      expect(restarted.read(NOW)).toEqual(oracle(entries, NOW));
      expect(restarted.work.rebuilt).toBe(1);
    } finally { removeTempDirSync(root); }
  });

  it("handles future runs, wall-clock rollback and fractional cutoff timestamps", () => {
    const entries = history(100, 99);
    entries[0]!.fact.at = NOW + DAY;
    entries[1]!.fact.at = NOW - WINDOW + .5;
    const aggregate = new IncrementalRoutineRollup();
    aggregate.rebuild(entries, NOW, true);
    for (const now of [NOW + .5, NOW + .6, NOW + WINDOW, NOW - DAY]) {
      expect(aggregate.read(now)).toEqual(oracle(entries, now));
    }
  });

  it("terminal updates do fixed work at both history sizes", () => {
    const counts = [100, 2_000].map(size => {
      const aggregate = new IncrementalRoutineRollup(), entries = history(size, 7).map((entry, i) => ({ ...entry, fact: {
        ...entry.fact, routineKey: `routine:${i % 20}`, at: NOW - i % 14 * DAY, failed: true, owed: false, detail: "401 unauthorized",
      } }));
      aggregate.rebuild(entries, NOW, true);
      const nodes = aggregate.work.nodes, updates = aggregate.work.updates;
      aggregate.upsert({ ...entries[0]!, fact: { ...entries[0]!.fact, at: NOW, failed: true } });
      return { nodes: aggregate.work.nodes - nodes, updates: aggregate.work.updates - updates };
    });
    expect(counts[0]).toEqual(counts[1]);
    expect(counts[1]!.nodes).toBeLessThanOrEqual(400);
    expect(counts[1]!.updates).toBe(2);
  });

  it("badge aggregate reads and day expiry do the same bounded work at two history sizes", () => {
    const counts = [100, 2_000].map(size => {
      const aggregate = new IncrementalRoutineRollup();
      const entries = history(size, 9).map((entry, i) => ({ ...entry, fact: { ...entry.fact, routineKey: `routine:${i % 20}`, at: NOW - i % 14 * DAY } }));
      aggregate.rebuild(entries, NOW, true);
      const before = aggregate.work.nodes;
      let visited = 0, lookups = 0;
      const original = Map.prototype[Symbol.iterator], get = Map.prototype.get;
      const getter = vi.spyOn(Map.prototype, "get").mockImplementation(function <K, V>(this: Map<K, V>, key: K) {
        lookups++; return get.call(this, key) as V | undefined;
      });
      const spy = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (this: Map<unknown, unknown>) {
        const iterator = original.call(this), next = iterator.next;
        iterator.next = () => { const result = next.call(iterator); if (!result.done) visited++; return result; };
        return iterator;
      });
      try { connectionsToRestore(aggregate.read(NOW + 1)); } finally { spy.mockRestore(); getter.mockRestore(); }
      return { nodes: aggregate.work.nodes - before, visited, lookups };
    });
    expect(counts[0]).toEqual(counts[1]);
    expect(counts[1]!.nodes).toBeLessThanOrEqual(20 * 34);
    expect(counts[1]!.visited).toBe(20);
    expect(counts[1]!.lookups).toBeLessThanOrEqual(20 * 34 * 17);
  });
});
