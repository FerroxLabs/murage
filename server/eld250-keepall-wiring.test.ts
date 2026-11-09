// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ALL.eld250 (design ELD250-KEEPALL-R3 r3.1, the wiring half of tests 6.8, 6.9 and 6.10): where index.ts makes, holds, wakes behind and joins
// the keep-all repair gate. The behaviour of each piece is tested in memory/keepall-repair-sliced.test.ts; this pins the sites in the server
// entry, which a unit test cannot import. Each check names the mutation it rejects.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "server", "index.ts"), "utf8");
const at = (needle: string) => { const i = source.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
const block = (start: string, end: string) => { const i = at(start); const j = source.indexOf(end, i); expect(j, end).toBeGreaterThan(i); return source.slice(i, j); };

describe("the keep-all repair gate in index.ts (ALL.eld250)", () => {
  it("6.8 the gate is made once at module top level, right after the Store's first database open and before listen", () => {
    // rejects: a gate made at the after-listen step (r2 A4), and a gate made after listen
    expect(source.split("createKeepAllRepairGate(").length - 1).toBe(1); // the one call
    const made = at("const keepAllRepair = createKeepAllRepairGate(");
    expect(made).toBeGreaterThan(at("const store = new Store("));
    expect(made).toBeLessThan(at("server.listen(PORT"));
    expect(made).toBeLessThan(at("async function startTurnAdmitting("));
  });

  it("6.8 one barrier, at the top of startTurnAdmitting, before the writer-gate line and not inside it", () => {
    // rejects: a barrier nested in writersHeldForIndexBuild(), a second site, and two ceilings per admission
    const body = block("async function startTurnAdmitting(", "const rebuildOf = opts?.rebuildOf;");
    const barrier = body.indexOf("await keepAllRepairBarrier(keepAllRepair);");
    expect(barrier).toBeGreaterThan(-1);
    expect(barrier).toBeLessThan(body.indexOf("if (writersHeldForIndexBuild()) await awaitWriterGateForeground();"));
    expect(source.split("keepAllRepairBarrier(").length - 1).toBe(1); // the one site
  });

  it("6.9 the runner wakes only after the repair ends (at once for a repaired file), never while stopping", () => {
    // rejects: a wake before the repair
    // the behaviour of both helpers runs through the real runAfterListen in memory/keepall-repair-sliced.test.ts (6.9); here: the step
    // calls the runner ONLY from inside wakeAfterKeepAllRepair's callback (one call, and that callback is the step's only statement)
    const step = block(`{ name: "memoryRevocation", run: () => {`, `{ name: "heldReplies"`);
    expect(source.split("wakeMemoryRevocation(").length - 1).toBe(1);
    const wakeAt = step.indexOf("wakeAfterKeepAllRepair(keepAllRepair, () => {");
    expect(wakeAt).toBeGreaterThan(-1);
    const after = step.slice(wakeAt);
    expect(after.indexOf("wakeMemoryRevocation(")).toBeGreaterThan(-1);
    // nothing before the helper call but the step opener (the tip no longer carries a planned-bytes line here: the revoke drain is paced on its own bytes)
    expect(step.slice(0, wakeAt).split("\n").filter(line => line.trim() && !line.trim().startsWith("//")).length).toBe(1);
    expect(after.split("\n").filter(line => line.trim()).map(line => line.trim()).slice(0, 5)).toEqual([
      "wakeAfterKeepAllRepair(keepAllRepair, () => {",
      "try { wakeMemoryRevocation(database, { admit: awaitWriterGate, busy: () => workAdmission.liveTurns({}).length > 0 }); }",
      "catch (error) { console.warn(`[memory] revocation jobs: ${error instanceof Error ? error.message : String(error)}; the next start carries on`); }",
      "});",
      "} },",
    ]);
    const repair = block(`{ name: "keepallUnwedge", run: () => launchKeepAllRepair(keepAllRepair, () => {`, `{ name: "memoryRevocation"`);
    expect(repair).toContain("return startKeepAllRepair(db, DATA_DIR, keepAllRepair, {");
    expect(repair).not.toContain("startRecovery(");
    expect(repair).toContain("drainRevokeMarkerBounded(file, { rows: 4096, ms: 250 }, { background: true })");
  });

  it("6.10 the stop latch is set at shutdown entry, and the join runs inside the data-writer stop before anything closes", () => {
    // rejects: a join outside the writer stop (r2 item 9), and a latch only inside a cleanup job
    const shutdown = block("const gracefulShutdown = createGracefulShutdown({", "cleanup: [");
    expect(shutdown).toContain("onStart: () => keepAllRepair.stop(),");
    const writers = block("const dataWriterGate = createDataWriterGate(", "const gracefulShutdown");
    expect(writers).toMatch(/async \(\) => \{ await joinKeepAllRepair\(keepAllRepair\); await transcriptReader\.close\(\); return stopDataWriters\(/);
  });
});
