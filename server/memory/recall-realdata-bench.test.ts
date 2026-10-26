// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Recall on a real data COPY (1.0.7 memory-recall-hydration): runs searchMemory the way a turn does (caller "turn", recall's own
// allowance, production wall-clock budgets) and the way the memory_search tool does, over the owner's own recent words in each
// bot's thread as queries, and prints counts and timings only: never a query, a record or any memory text. Then it times every
// step of authorizing the word-index candidates one by one, so the cost of hydration can be read per step.
// Skipped unless RECALL_REALDATA=1, RECALL_SCRATCH_ROOT names a scratch folder and RECALL_COPY a copied data dir INSIDE it: any other data
// dir is refused (never a live one). It logs counts, timings and fixed codes only (never an error's message: it can quote memory text).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MemoryAccess, MemoryRoster } from "./policy.ts";
import type { MemoryWorkerController } from "./worker-controller.ts";

// The test setup points HOME at a throwaway folder and drops MURAGE_DATA_DIR; the copy is named by RECALL_COPY and every repo module is
// loaded only after it is set, so DATA_DIR is the copy.
const COPY = process.env.RECALL_COPY;
if (COPY) process.env.MURAGE_DATA_DIR = COPY;
const load = async () => (vi.resetModules(), {
  ...await import("../config.ts"), ...await import("../database.ts"), ...await import("../internal-capabilities.ts"), ...await import("../human-principals.ts"),
  ...await import("./index-reader.ts"), ...await import("./lineage-allowance.ts"), ...await import("./policy.ts"), ...await import("./readable.ts"),
  ...await import("./replay-lineage.ts"), ...await import("./search.ts"), ...await import("./worker-controller.ts"),
});
let M: Awaited<ReturnType<typeof load>>;

const SCRATCH = process.env.RECALL_SCRATCH_ROOT;
const ON = process.env.RECALL_REALDATA === "1" && Boolean(COPY) && Boolean(SCRATCH);
/** The data dir must be strictly inside the explicit scratch root, and never the home data dir. */
const insideScratch = (dir: string) => { const root = resolve(SCRATCH!); const at = resolve(dir); return at !== root && at.startsWith(root.endsWith(sep) ? root : root + sep); };
/** A fixed code for a thrown error: its leading MEMORY_* code when it has one, else "other" (an error's message can quote memory text). */
const codeOf = (error: unknown): string => { const m = error instanceof Error ? /^(MEMORY_[A-Z0-9_]{1,60})(?::|$)/.exec(error.message) : null; return m ? m[1]! : "other"; };
const BOTS = Number(process.env.RECALL_BOTS ?? 8);
const PER_BOT = Number(process.env.RECALL_QUERIES ?? 12);
const out = (o: Record<string, unknown>) => console.log(`RECALL ${JSON.stringify(o)}`);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : 0; };
const list = (raw: unknown, key: string): any[] => Array.isArray(raw) ? raw : Array.isArray((raw as any)?.[key]) ? (raw as any)[key] : [];

describe.skipIf(!ON)("recall on a real data copy", () => {
  let roster: MemoryRoster;
  const cases: Array<{ access: MemoryAccess; queries: string[] }> = [];
  let controller: MemoryWorkerController;
  beforeAll(async () => {
    M = await load();
    const { DATA_DIR, database, InternalCapabilities, memoryAccess, MemoryWorkerController } = M;
    if (!insideScratch(COPY!) || resolve(DATA_DIR) !== resolve(COPY!) || resolve(DATA_DIR) === resolve(join(homedir(), ".murage"))) throw new Error("REFUSING: the data dir must be the named copy inside RECALL_SCRATCH_ROOT");
    const t0 = performance.now();
    const db = database();
    out({ k: "open", ms: Math.round(performance.now() - t0) });
    const n = (sql: string) => Number((db.prepare(sql).get() as any)?.n ?? 0);
    out({ k: "shape", records: n("SELECT count(*) n FROM memory_records"), active: n("SELECT count(*) n FROM memory_records WHERE state='active'"),
      evidence: n("SELECT count(*) n FROM memory_evidence"), sources: n("SELECT count(*) n FROM memory_sources"), scopes: n("SELECT count(*) n FROM memory_scopes"),
      tombstones: n("SELECT count(*) n FROM memory_tombstones"), denyMemory: n("SELECT count(*) n FROM memory_deny_memory"), messages: n("SELECT count(*) n FROM messages") });
    roster = { bots: list(JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")), "bots"), groups: list(JSON.parse(readFileSync(join(DATA_DIR, "groups.json"), "utf8")), "groups") };
    const registry = new InternalCapabilities();
    const built: Array<{ access: MemoryAccess; records: number }> = [];
    let refused = 0;
    for (const bot of roster.bots) {
      try {
        const generation = registry.begin(bot.id, bot.threadId);
        const token = registry.mint({ botId: bot.id, threadId: bot.threadId, generation, depth: 0, kind: "memory", skillAuthoring: false });
        const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
        const records = Number((db.prepare("SELECT count(*) n FROM memory_records WHERE state='active' AND scope_id IN (SELECT value FROM json_each(?))").get(JSON.stringify(access.scopeIds)) as any).n);
        built.push({ access, records });
      } catch { refused++; }
    }
    built.sort((a, b) => b.records - a.records);
    // the owner's own recent words in the bot's thread: what a turn's recall is asked
    const recent = db.prepare("SELECT text FROM messages WHERE thread_id=? AND role='user' AND text IS NOT NULL AND length(text) BETWEEN 8 AND 2000 ORDER BY at DESC LIMIT ?");
    for (const { access } of built.slice(0, BOTS)) {
      const queries = (recent.all(access.threadId, PER_BOT) as any[]).map(r => String(r.text).slice(0, 1500));
      if (queries.length) cases.push({ access, queries });
    }
    out({ k: "cases", bots: roster.bots.length, accessRefused: refused, used: cases.length, recordsPerBot: built.slice(0, BOTS).map(b => b.records), queries: cases.reduce((s, c) => s + c.queries.length, 0) });
    controller = new MemoryWorkerController({});
    controller.start();
    const readyBy = Date.now() + Number(process.env.RECALL_HELPER_WAIT_S ?? 600) * 1000, waitStart = Date.now();
    let lastNote = 0;
    while (!controller.status().ready && Date.now() < readyBy) { await sleep(1000); if (Date.now() - lastNote > 300_000) { lastNote = Date.now(); const st = controller.status(); out({ k: "helper-wait", s: Math.round((Date.now() - waitStart) / 1000), running: st.running, indexing: st.indexing, error: Boolean(st.error) }); } }
    // then the index catches up on what it owes (the idle lanes), as on a machine that has been running
    const settleBy = Date.now() + Number(process.env.RECALL_SETTLE_S ?? 0) * 1000;
    while (Date.now() < settleBy && controller.status().indexing) await sleep(1000);
    out({ k: "helper", ready: controller.status().ready, indexing: controller.status().indexing, error: Boolean(controller.status().error), waitedS: Math.round((Date.now() - waitStart) / 1000) });
    await sleep(2000);
  }, 6 * 3_600_000);
  afterAll(async () => { if (!M) return; try { await (controller as any)?.stop?.(); } catch { /* best effort */ } M.closeMemoryIndexReader(); M.closeDatabase(); });

  /** `lineageMs`: "production" is the search's own allowance with its production time (the hydration limit of the caller, D3); null is
   * unbounded time; a number is that time budget. */
  async function pass(label: string, caller: "turn" | "tool", lineageMs: number | null | "production") {
    const { setLineageTimeBudgetForTest, LineageAllowance, searchMemory, recallHydrationLimitMs } = M;
    const budget = lineageMs === "production" ? recallHydrationLimitMs(caller) : lineageMs;
    setLineageTimeBudgetForTest(budget);
    const ms: number[] = [], outcomes: Record<string, number> = {}, reasons: Record<string, number> = {};
    let withHits = 0, total = 0, hitSum = 0, timeCuts = 0, nodeCuts = 0, otherCuts = 0;
    const ids: string[][] = [];
    for (const { access, queries } of cases) for (const query of queries) {
      const allowance = LineageAllowance.search(recallHydrationLimitMs(caller));
      const t = performance.now();
      let answer: Awaited<ReturnType<typeof M.searchMemory>> | null = null;
      try { answer = await searchMemory(query, access, controller, { allowance, caller, limit: caller === "turn" ? 20 : 10 }); }
      catch (error) { const code = `throw:${codeOf(error)}`; reasons[code] = (reasons[code] ?? 0) + 1; }
      // where a search stopped on its allowance: its time (the hydration limit) or its nodes (TURN_LINEAGE_NODES), counted apart
      if (allowance.everHit) { if (allowance.overTime()) timeCuts++; else if (allowance.remaining <= 0) nodeCuts++; else otherCuts++; }
      ms.push(performance.now() - t); total++;
      const hits = answer?.hits.length ?? 0;
      hitSum += hits; if (hits) withHits++;
      ids.push((answer?.hits ?? []).map(h => `${h.id}:${h.version}`));
      const outcome = !hits ? "empty" : (answer as any)?.partial ? "partial" : "full";
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      const reason = `${answer?.degradedReason ?? "none"}${allowance.everHit ? "+lineage-limit" : ""}`;
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    setLineageTimeBudgetForTest(undefined);
    out({ k: "pass", label, caller, lineageMs: budget, queries: total, timeCuts, nodeCuts, otherCuts, withHits, hitRate: +(withHits / Math.max(1, total)).toFixed(3), meanHits: +(hitSum / Math.max(1, total)).toFixed(2),
      p50: Math.round(pct(ms, 0.5)), p95: Math.round(pct(ms, 0.95)), max: Math.round(Math.max(0, ...ms)), outcomes, reasons });
    return ids;
  }

  it("turn and tool recall: hit rate and latency, production budgets vs unbounded", async () => {
    expect(cases.length).toBeGreaterThan(0);
    await pass("warm-up", "turn", "production");
    const ideal = await pass("unbounded", "turn", null);
    const real = await pass("production", "turn", "production");
    // of what an unbounded recall finds (its top 10), how much the production recall returned
    let found = 0, wanted = 0;
    ideal.forEach((want, n) => { const got = new Set(real[n]); for (const id of want.slice(0, 10)) { wanted++; if (got.has(id)) found++; } });
    out({ k: "overlap", wanted, found, recallAt10: +(found / Math.max(1, wanted)).toFixed(3) });
    await pass("tool-production", "tool", "production");
  }, 3_600_000);

  it("where the hydration time goes, per step, on the word-index candidates", () => {
    const { database, lexicalPage, memoryAccessIsOwnerAudience, memoryAccessNotOwnerAudience, inMemoryAccessPass, plausiblyReadable, LineageAllowance, readableMemoryRecord, derivationAncestryCurrent, humanMayReadRecord, writetimeRecordRefusal, recordRestsOnWithheldMessage } = M;
    const db = database();
    const steps: Record<string, number[]> = { plausibleBatch: [], readable: [], recordRow: [], derivation: [], humanMay: [], evidence: [], writetime: [], withheldMsg: [] };
    const refusals: Record<string, number> = {};
    let candidates = 0, plausible = 0;
    for (const { access, queries } of cases) for (const query of queries.slice(0, 4)) {
      const page = lexicalPage(query, access.scopeIds, 100);
      const refs = (page?.hits ?? []).map(h => ({ id: h.id, version: h.version }));
      candidates += refs.length;
      const ownerReader = memoryAccessIsOwnerAudience(access) && !memoryAccessNotOwnerAudience(access);
      let t = performance.now();
      const ok = inMemoryAccessPass(() => plausiblyReadable(refs, access.scopeIds, "current", ownerReader));
      steps.plausibleBatch.push(performance.now() - t);
      plausible += ok.size;
      for (const ref of refs.filter(r => ok.has(`${r.id}:${r.version}`))) {
        const allowance = LineageAllowance.tool(1_000_000_000);
        t = performance.now();
        let verdict = "readable";
        try { const read = inMemoryAccessPass(() => readableMemoryRecord(ref.id, ref.version, access, { allowance, mode: "current", agent: true })); if (typeof read === "string") verdict = read; }
        catch (error) { verdict = `throw:${codeOf(error)}`; }
        steps.readable.push(performance.now() - t);
        refusals[verdict] = (refusals[verdict] ?? 0) + 1;
        const a2 = LineageAllowance.tool(1_000_000_000);
        t = performance.now(); const row = db.prepare("SELECT supersedes_id FROM memory_records WHERE id=? AND version=?").get(ref.id, ref.version) as any; steps.recordRow.push(performance.now() - t);
        t = performance.now(); try { derivationAncestryCurrent(a2, db, ref.id, ref.version, row?.supersedes_id, false); } catch { /* timed only */ } steps.derivation.push(performance.now() - t);
        t = performance.now(); try { humanMayReadRecord(db, ref.id, ref.version, access.humanPrincipal); } catch { /* timed only */ } steps.humanMay.push(performance.now() - t);
        t = performance.now(); const ev = db.prepare("SELECT source_id AS sourceId,source_revision AS revision,start_byte AS startByte,end_byte AS endByte FROM memory_evidence WHERE record_id=? AND record_version=?").all(ref.id, ref.version) as any[]; steps.evidence.push(performance.now() - t);
        t = performance.now(); try { writetimeRecordRefusal(db, { kind: "record", id: ref.id, version: ref.version, scopeId: "" } as any, ev); } catch { /* timed only */ } steps.writetime.push(performance.now() - t);
        t = performance.now(); try { recordRestsOnWithheldMessage(a2, ref.id, ref.version); } catch { /* timed only */ } steps.withheldMsg.push(performance.now() - t);
      }
    }
    const summary = Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { n: v.length, p50: +pct(v, 0.5).toFixed(1), p95: +pct(v, 0.95).toFixed(1), max: Math.round(Math.max(0, ...v)), sum: Math.round(v.reduce((s, x) => s + x, 0)) }]));
    out({ k: "steps", candidates, plausible, summary, refusals });
  }, 3_600_000);
});
