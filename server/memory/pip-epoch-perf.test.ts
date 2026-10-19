// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP-REDESIGN r3 T1, T1b and the T5 equal-time window, on the 100,000-source shape (MEMORY_PERF=1). "Hold" is the longest contiguous
// occupation of the event loop, measured by a setImmediate ticker alongside the run (not per named step), so sorts, flattens and trigger
// work all count. Statements inside each write transaction are counted by a db.prepare spy: O(1) + O(threads), never O(sources).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { gcPauseMs, startLoopStallWatch, stopLoopStallWatch } from "../observe.ts";
import { captureMessage } from "./capture.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { perfEnabled } from "./testing/perf-fixture.ts";
import { ADMISSION_DENY_SQL, ADMISSION_EPOCH_SQL, ADMISSION_TRIGGERS, admissionStamp, ensureAdmissionEpochs, stampMoved } from "./pip-admission.ts";
import { listEpisodes } from "./pip-episodes.ts";
import { maybeTraceEpisodeSliced, readReflectState, runPipReflect, sliceBetween, type ReflectBot, type ReflectDeps } from "./pip-reflect.ts";
import type { IsolationReport, TextOnlyTurnInput, TextOnlyTurnResult } from "./pip-transport.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const T0 = 1_760_000_000_000;
const DAY = 24 * 3600_000;
const TASKS = Array.from({ length: 40 }, (_, i) => ({ threadId: `task-${i}` }));
const roster = { bots: [{ id: "moss", threadId: "private", tasks: TASKS }], groups: [] as never[] };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never);
});
afterEach(() => { setMemoryCaptureRoster(null); });

/** `pairs` owner turns and replies in one thread; `at(i)` places owner turn i. */
function seed(pairs: number, at: (i: number) => number, thread = "private"): void {
  const db = database();
  db.exec("PRAGMA synchronous=OFF");
  db.exec("BEGIN");
  for (let i = 1; i <= pairs; i++) {
    captureMessage(db, thread, { id: `o${i}`, at: at(i), role: "user", kind: "text", text: `Please be brief ${i}.`, origin: "desktop" } as never);
    captureMessage(db, thread, { id: `b${i}`, at: at(i) + 500, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } } as never);
  }
  db.exec("COMMIT");
  db.exec("UPDATE memory_jobs SET status='complete',cursor=100");
}
const iso: IsolationReport = { mcpServers: [], tools: [], homeNewFiles: [], cwdNewFiles: [], exited: true, initLine: true, stopReason: "end_turn" };
const empty = { proposals: [], stance: [], episode: null };
function rig(threadIds = ["private"], now = T0 + 30 * DAY): { deps: ReflectDeps; bot: ReflectBot; calls: TextOnlyTurnInput[] } {
  const bot: ReflectBot = { id: "moss", name: "Moss", threadIds, continuity: true, options: { reflect: true } };
  const calls: TextOnlyTurnInput[] = [];
  const deps: ReflectDeps = {
    now: () => now, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [bot], memoryMode: () => "active",
    resolveRoute: async () => ({ fingerprint: "fp-1", engine: "Stub engine", kind: "cli", model: "stub-model", textOnlyTurn: async (input): Promise<TextOnlyTurnResult> => {
      calls.push(input);
      return { text: JSON.stringify(empty), usage: { inputTokens: 100, outputTokens: 50 }, isolation: iso, verdict: { state: "validated", structured: empty } };
    } }),
  };
  return { deps, bot, calls };
}
/** The longest contiguous hold of the loop while `body` runs, less the collector's pauses in it (the stall line's own subtraction). */
async function ticking<T>(body: () => Promise<T>): Promise<{ value: T; longest: number }> {
  startLoopStallWatch(60_000);
  let last = performance.now(), longest = 0, on = true;
  const held = (t: number) => t - last - gcPauseMs(last, t);
  const tick = () => { if (!on) return; const t = performance.now(); longest = Math.max(longest, held(t)); last = t; setImmediate(tick); };
  setImmediate(tick);
  try { const value = await body(); return { value, longest: Math.max(longest, held(performance.now())) }; } finally { on = false; stopLoopStallWatch(); }
}
/** Counts the statements each top-level transaction prepares on `db` while `body` runs. */
async function statementsPerTransaction<T>(db: DatabaseSync, body: () => Promise<T>): Promise<{ value: T; counts: number[] }> {
  const prepare = db.prepare.bind(db), exec = db.exec.bind(db);
  const counts: number[] = [];
  let open = -1;
  (db as { prepare: unknown }).prepare = (sql: string) => { if (open >= 0) counts[open]++; return prepare(sql); };
  (db as { exec: unknown }).exec = (sql: string) => {
    if (/^\s*BEGIN/i.test(sql)) { open = counts.length; counts.push(0); }
    const out = exec(sql);
    if (/^\s*(COMMIT|ROLLBACK)\s*$/i.test(sql)) open = -1;
    return out;
  };
  try { return { value: await body(), counts }; } finally { (db as { prepare: unknown }).prepare = prepare; (db as { exec: unknown }).exec = exec; }
}
const quantile = (values: number[], q: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; };

describe.runIf(perfEnabled())("PIP admission stamp at 100,000 sources", () => {
  it("T1: run start, snapshot, attempt, validation, publication, settle and a 7-day trace: every hold under 50 ms, O(1) statements per transaction", async () => {
    // 50,000 owner turns over five days, 100,000 sources, with real learnability inputs (capture jobs complete)
    seed(50_000, i => T0 + i * 8_000);
    const db = database();
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_sources WHERE thread_id='private'").get()!.n)).toBeGreaterThanOrEqual(100_000);
    const { deps, bot, calls } = rig();
    const run = await statementsPerTransaction(db, () => ticking(() => runPipReflect(deps, "moss", new AbortController().signal)));
    expect(calls).toHaveLength(1);
    expect(run.value.value.status).toBe("applied");
    expect(run.value.longest).toBeLessThan(50);
    expect(Math.max(...run.counts)).toBeLessThan(200);
    // the trace: up to seven days in one maintenance pass, each written from counts and bounded handles
    const trace = await statementsPerTransaction(db, () => ticking(async () => {
      let wrote = 0;
      for (let i = 0; i < 7; i++) if (await maybeTraceEpisodeSliced(deps, bot, sliceBetween())) wrote++;
      return wrote;
    }));
    expect(trace.value.value).toBeGreaterThan(0);
    expect(trace.value.longest).toBeLessThan(50);
    expect(Math.max(...trace.counts)).toBeLessThan(200);
    console.log(`T1 run hold ${run.value.longest.toFixed(1)} ms, max ${Math.max(...run.counts)} statements/transaction; trace hold ${trace.value.longest.toFixed(1)} ms, ${trace.value.value} days, max ${Math.max(...trace.counts)} statements/transaction`);
  }, 900_000);

  it("T1: the trace stamp over a bot with 40 tasks of unequal epochs: statements in its transaction grow with threads, not turns", async () => {
    seed(2_000, i => T0 + i * 1_000);
    for (const [n, task] of TASKS.entries()) seed(1 + n, i => T0 + i * 1_000, task.threadId);
    const db = database(), threads = ["private", ...TASKS.map(t => t.threadId)];
    const { deps, bot } = rig(threads);
    const trace = await statementsPerTransaction(db, () => ticking(() => maybeTraceEpisodeSliced(deps, bot, sliceBetween())));
    expect(trace.value.value).toBe(true);
    expect(trace.value.longest).toBeLessThan(50);
    // the stamp: a few seeks per thread (epochs in one statement, audience per thread), plus the write
    expect(Math.max(...trace.counts)).toBeLessThan(40 + 4 * threads.length);
    expect(listEpisodes(db, "moss")[0].text).toMatch(/2000 messages/);
  }, 600_000);

  it("T5: 50,000 owner turns at one equal time: the request shows at most 256, publication re-reads exactly those, its transaction is O(1)", async () => {
    seed(50_000, () => T0);
    const db = database();
    const { deps, calls } = rig();
    let shown: number | undefined;
    const run = await statementsPerTransaction(db, () => ticking(async () => {
      const outcome = await runPipReflect(deps, "moss", new AbortController().signal);
      return outcome;
    }));
    shown = JSON.parse(calls[0].text).turns.filter((t: { from: string }) => t.from === "owner").length;
    expect(shown).toBeLessThanOrEqual(256);
    expect(run.value.value.status).toBe("applied");
    expect(run.value.longest).toBeLessThan(50);
    expect(Math.max(...run.counts)).toBeLessThan(200);
    expect(readReflectState(db, "moss").run).toBeUndefined();
  }, 900_000);

  it("T1b: capture on a disk-backed WAL file with the triggers: p50 within 10 %, p99 within 1 ms; bulk updates bounded; an identical re-capture moves nothing", () => {
    const db = database();
    db.exec("PRAGMA synchronous=FULL");
    expect(String(db.prepare("PRAGMA journal_mode").get()!.journal_mode)).toBe("wal");
    ensureAdmissionEpochs(db);
    const dropTriggers = () => { for (const name of ADMISSION_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS temp.${name}`); };
    const makeTriggers = () => { db.exec(ADMISSION_EPOCH_SQL); db.exec(ADMISSION_DENY_SQL); };
    const samples: Record<"without" | "with", number[]> = { without: [], with: [] };
    let n = 0;
    // interleaved blocks, so the disk's own drift falls on both sides
    for (let block = 0; block < 20; block++) {
      const mode = block % 2 === 0 ? "without" : "with";
      if (mode === "without") dropTriggers(); else makeTriggers();
      for (let i = 0; i < 500; i++) {
        n++;
        const started = performance.now();
        captureMessage(db, "private", { id: `c${n}`, at: T0 + n, role: "user", kind: "text", text: `Capture ${n}.`, origin: "desktop" } as never);
        samples[mode].push(performance.now() - started);
      }
    }
    makeTriggers();
    const p50 = { without: quantile(samples.without, 0.5), with: quantile(samples.with, 0.5) }, p99 = { without: quantile(samples.without, 0.99), with: quantile(samples.with, 0.99) };
    console.log(`T1b capture p50 ${p50.without.toFixed(3)} -> ${p50.with.toFixed(3)} ms, p99 ${p99.without.toFixed(3)} -> ${p99.with.toFixed(3)} ms`);
    expect(p50.with).toBeLessThan(p50.without * 1.1);
    expect(p99.with - p99.without).toBeLessThan(1);
    // one fake-transport send's own checks: the stamp compared over the bot's thread
    const deps = rig().deps, stamp = admissionStamp(db, deps, "moss", ["private"], { reflect: true });
    const checks: number[] = [];
    for (let i = 0; i < 1000; i++) { const started = performance.now(); expect(stampMoved(db, deps, "moss", stamp)).toBe("none"); checks.push(performance.now() - started); }
    expect(quantile(checks, 0.99)).toBeLessThan(1);
    // a 400-row branch slice (branch-change.ts flips up to 400 sources per slice) in one transaction
    db.exec("PRAGMA synchronous=OFF");
    seed(50_000, i => T0 + 1e9 + i, "other");
    const slice = (state: string) => { const started = performance.now(); db.exec("BEGIN IMMEDIATE"); db.prepare(`UPDATE memory_sources SET state='${state}' WHERE id IN (SELECT id FROM memory_sources WHERE thread_id='other' ORDER BY message_id LIMIT 400)`).run(); db.exec("COMMIT"); return performance.now() - started; };
    const sliceMs = slice("retired");
    expect(sliceMs).toBeLessThan(50);
    slice("active");
    // a thread-wide retire of 100,000 sources (settings.ts exclusion): what the triggers add to it, measured against the same write without them
    const retire = (state: string) => { const started = performance.now(); db.exec("BEGIN IMMEDIATE"); db.prepare(`UPDATE memory_sources SET state='${state}' WHERE thread_id='other' AND state!='${state}'`).run(); db.exec("COMMIT"); return performance.now() - started; };
    const withTriggers = retire("retired"); retire("active");
    dropTriggers(); const withoutTriggers = retire("retired"); retire("active"); makeTriggers();
    console.log(`T1b 400-row slice ${sliceMs.toFixed(1)} ms; 100,000-row retire ${withoutTriggers.toFixed(1)} -> ${withTriggers.toFixed(1)} ms`);
    expect(withTriggers - withoutTriggers).toBeLessThan(50);
    // r3: a metadata-only re-capture with an identical payload leaves both epochs unchanged
    const epochs = () => JSON.stringify([db.prepare("SELECT global FROM temp.memory_admission_epoch").get(), db.prepare("SELECT epoch FROM temp.memory_thread_admission WHERE thread_id='private'").get()]);
    const before = epochs();
    captureMessage(db, "private", { id: "c1", at: T0 + 1, role: "user", kind: "text", text: "Capture 1.", origin: "desktop" } as never);
    expect(epochs()).toBe(before);
  }, 900_000);
});
