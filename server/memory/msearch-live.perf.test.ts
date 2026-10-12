// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Real end-to-end memory_search on the 60k fixture, through the live helper process (round 4 asked for this instead of a
// precomputed helper answer): the real MemoryWorkerController forks the real worker, the real eligibility read and index
// search run in it, and searchMemory runs in this process exactly as the memory_search tool runs it. Measures p50 and p95
// per search and the longest event-loop stall of this process, on the plain fixture and with 1,000 refused candidates that
// outrank every readable one. Off unless MEMORY_PERF_LIVE=1. The file uses only APIs that exist on the round-3 head too, so
// the same file gives the "before" figures from an older checkout.
//
// Run with MEMORY_PERF_PENDING=0 so the fixture holds no capture backlog for the helper to drain while it is measured.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { MemoryIndex } from "./index.ts";
import { closeMemoryIndexReader, lexicalPage } from "./index-reader.ts";
import { searchMemory } from "./search.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { accessFor, THREAD } from "./testing/recall-fixture.ts";
import { conversationScope, loadPerfFixture, perfQueries, perfShape } from "./testing/perf-fixture.ts";

const suite = process.env.MEMORY_PERF_LIVE === "1" ? describe : describe.skip;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : 0; };
const round = (value: number) => Math.round(value * 10) / 10;
const SAMPLES = Number(process.env.MEMORY_PERF_SAMPLES ?? 200);

suite("msearch round 4: memory_search end to end through the live helper on the 60k fixture", () => {
  beforeAll(() => { loadPerfFixture(perfShape()); }, 30 * 60_000);
  afterAll(() => { closeMemoryIndexReader(); closeDatabase(); });

  /** One measurement in this process: a controller cannot be started twice in one process, so each case is its own run. */
  async function measure(denied: number) {
    const queries = perfQueries(60), { access } = accessFor();
    const controller = new MemoryWorkerController({ modelDirectory: join(DATA_DIR, "no-model") });
    controller.start();
    const readyBy = Date.now() + 120_000;
    while (!controller.status().ready) { if (Date.now() > readyBy) throw new Error(`the helper did not become ready: ${controller.status().error ?? "no error"}`); await sleep(100); }
    await sleep(1500);
    // the main-thread word-index page on its own (the synchronous part of every search), and how often ties needed a wider read
    const tieModule = await import("./rank-ties.ts").catch(() => null) as { tieStats?: { pages: number; widened: number } } | null;
    if (tieModule?.tieStats) { tieModule.tieStats.pages = 0; tieModule.tieStats.widened = 0; }
    const pageTimes: number[] = [];
    for (let n = 0; n < 60; n++) { const t = performance.now(); lexicalPage(queries[n % queries.length], access.scopeIds, 50); pageTimes.push(performance.now() - t); }
    const pageStats = { pageP50: round(percentile(pageTimes, 0.5)), pageMax: round(Math.max(...pageTimes)), ...tieModule?.tieStats ? { tie: { ...tieModule.tieStats } } : {} };
    const stalls: Array<{ n: number; query: string; gap: number }> = [];
    const times: number[] = [], prep: number[] = [], bridge: number[] = [], hydration: number[] = [], reasons: Record<string, number> = {};
    let hits = 0, paged = 0, vectorRows = 0;
    const loop = monitorEventLoopDelay({ resolution: 1 });
    try {
      for (let n = 0; n < 5 + SAMPLES; n++) {
        const query = queries[n % queries.length];
        if (n === 5) loop.enable();
        const started = performance.now();
        // the longest stall inside this one search, and which query had it
        let gap = 0, lastTick = started;
        const ticker = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - lastTick); lastTick = now; }, 1);
        let service: { preparationMs: number; bridgeMs: number; hydrationMs: number } | undefined;
        // the service's own timings are private telemetry here; the round-3 head put them in the answer
        const answer = await searchMemory(query, access, controller, { caller: "tool", limit: 20, profile: true, telemetry: facts => { vectorRows = Math.max(vectorRows, facts.vectorRows); service = (facts as { service?: typeof service }).service; } }) as Awaited<ReturnType<typeof searchMemory>> & { serviceProfile?: typeof service };
        clearInterval(ticker);
        if (n >= 5) stalls.push({ n, query, gap: round(Math.max(gap, performance.now() - lastTick)) });
        service ??= answer.serviceProfile;
        if (n >= 5) {
          times.push(performance.now() - started);
          prep.push(service?.preparationMs ?? 0); bridge.push(service?.bridgeMs ?? 0); hydration.push(service?.hydrationMs ?? 0);
          hits += answer.hits.length; if (answer.nextCursor) paged++;
          const reason = String(answer.degradedReason ?? "none"); reasons[reason] = (reasons[reason] ?? 0) + 1;
        }
      }
    } finally { loop.disable(); await controller.stop(); }
    const p = (values: number[], q: number) => round(percentile(values, q));
    console.log(`STALLS ${JSON.stringify(stalls.sort((a, b) => b.gap - a.gap).slice(0, 5))}`);
    const line = JSON.stringify({ label: process.env.MEMORY_PERF_LABEL ?? "run", name: "msearch-live.search", denied, n: times.length, p50: p(times, 0.5), p95: p(times, 0.95), max: round(Math.max(...times)),
      eventLoopMaxMs: round(loop.max / 1e6), eventLoopP99Ms: round(loop.percentile(99) / 1e6), meanHits: round(hits / times.length), paged, vectorRows, reasons,
      ...pageStats, parts: { prepP50: p(prep, 0.5), bridgeP50: p(bridge, 0.5), bridgeP95: p(bridge, 0.95), hydrationP50: p(hydration, 0.5), hydrationP95: p(hydration, 0.95) } });
    console.log(`PERF ${line}`);
    if (process.env.MEMORY_PERF_OUT) appendFileSync(process.env.MEMORY_PERF_OUT, `${line}\n`);
    return times;
  }

  it("memory_search through the live helper", async () => {
    const denied = Number(process.env.MEMORY_PERF_DENIED ?? 0);
    if (denied > 0) {
      // Refused records (a tool observation with no evidence) that match every query strongly and outrank every readable one.
      const db = database(), scope = conversationScope(db, THREAD);
      const text = "weekly client report timing weekly client report timing weekly client report timing";
      db.exec("BEGIN IMMEDIATE");
      // MEMORY_PERF_DENIED_KIND=read: owner statements derived from a forgotten record, refused only by a full read (the cheap
      // statement cannot spare them); the default is a tool observation with no evidence, which is never even eligible now.
      const byRead = process.env.MEMORY_PERF_DENIED_KIND === "read";
      if (byRead) {
        db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,created_at) VALUES('p-forgotten',1,?,'fact','gone','owner-statement','deleted',0,1,1)").run(scope);
        db.prepare("INSERT INTO memory_tombstones VALUES('t-p-forgotten','record','p-forgotten',NULL,NULL,1,'owner-forget',0)").run();
      }
      const derive = db.prepare("INSERT INTO memory_derivations VALUES('p-forgotten',1,?,1)");
      const insert = db.prepare(`INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,created_at) VALUES(?,1,?,'fact',?,'${byRead ? "owner-statement" : "tool-observation"}','active',0,1,1)`);
      const receipt = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,1,'indexed','indexed',NULL)");
      const entries = [];
      for (let n = 0; n < denied; n++) { const id = `refused-${String(n).padStart(4, "0")}`; insert.run(id, scope, text); receipt.run(id); if (byRead) derive.run(id); entries.push({ id, version: 1, scopeId: scope, text, deleted: false }); }
      db.exec("UPDATE memory_meta SET data_revision=data_revision+1; COMMIT");
      const index = new MemoryIndex(join(DATA_DIR, "memory-index.db"));
      try { index.upsert(entries); } finally { index.close(); }
      closeMemoryIndexReader();
    }
    expect((await measure(denied)).length).toBe(SAMPLES);
  }, 30 * 60_000);
});
