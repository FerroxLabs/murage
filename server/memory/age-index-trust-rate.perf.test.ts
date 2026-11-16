// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMW Part A, T11 (spec 1.15, r22 5, r31 11, r32 13 F10): the index trust rate.
//   line A, strictly no worse than today: 10 interleaved pairs, the 5fe4904c2 build ("today") first in each pair, the same fixture
//     and the same meter (WAL frame bytes from walFrameReader, divided by records written): mean bytes/record of this build <= today's.
//   line B, a real clock, per 60 s window: the trust rate stays under 50 MiB/min.
//   red: the negative fixture (one record per txn) must FAIL both lines.
// The meter and the fixture are identical in both builds, so this one file runs in both trees (it detects MemoryIndex.create).
// The correctness checks at the top are plain unit tests (no clock, no index) and always run. The measured legs need a quiet host
// (MEMORY_PERF_T11=1) and never run on a loaded one:
//   today tree:  git worktree of 5fe4904c2 with node_modules, this file copied to server/memory/ (T11_TODAY_TREE=<that tree>)
//   gate lane:   MEMORY_PERF_T11=1 T11_TODAY_TREE=<tree> node_modules/.bin/vitest run server/memory/age-index-trust-rate.perf.test.ts
// Knobs: T11_PAIRS (10), T11_WINDOW_MS (60000, a real 60 s window), T11_RECORDS_PER_SEC (arrival rate, default 200), T11_PER_TXN (16),
//   T11_NEG_MS (window of the negative fixture, 20000). A run with T11_WINDOW_MS < 60000 is a smoke run and says so.
// Arrival rate (owner ruling 11-08): no spec-given rate. Calibrate on the quiet host: pick T11_RECORDS_PER_SEC so the TODAY arm lands near
//   60% of 50 MiB/min (about 30 MiB/min), print the rate and the today figure, and use the SAME rate for both arms. Default 200 is a
//   placeholder until that calibration is recorded here and in MUTANTS-wp3.tsv. CALIBRATED RATE: not yet measured.
// Hybrid clock: not used (real clock only, owner ruling 11-08). The real clock is the allowed default; hybridEquivalent() below is the check that must pass first.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { walFrameReader } from "../io-budget.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { MemoryIndex, type IndexedMemory } from "./index.ts";

export const TRUST_LIMIT_BYTES_PER_MIN = 50 * 1024 * 1024;
export interface ArmResult { arm: "today" | "r32"; perTxn: number; records: number; bytes: number; elapsedMs: number; chargeCalls: number; chargeBytes: number; stopped: string | null }
export interface Verdict { noWorse: boolean; rateOk: boolean; meanToday: number; meanThis: number; maxRatePerMin: number }

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const bytesPerRecord = (r: ArmResult) => (r.records > 0 ? r.bytes / r.records : Number.POSITIVE_INFINITY);
const ratePerMin = (r: ArmResult) => (r.elapsedMs > 0 ? (r.bytes * 60_000) / r.elapsedMs : Number.POSITIVE_INFINITY);

/** The two lines. Line A: mean bytes/record of this build <= today's (equal passes). Line B: every window strictly under 50 MiB/min. */
export function verdict(today: ArmResult[], current: ArmResult[]): Verdict {
  const meanToday = mean(today.map(bytesPerRecord)), meanThis = mean(current.map(bytesPerRecord));
  const maxRatePerMin = Math.max(0, ...current.map(ratePerMin));
  return { noWorse: meanThis <= meanToday, rateOk: maxRatePerMin < TRUST_LIMIT_BYTES_PER_MIN, meanToday, meanThis, maxRatePerMin };
}

/** The hybrid clock may replace the real clock only if, for BOTH builds, the report count differs by at most 1 per window and the
 * bytes by at most 2% against the real-clock run. Anything else: real clock. */
export function hybridEquivalent(real: Array<{ count: number; bytes: number }>, hybrid: Array<{ count: number; bytes: number }>): boolean {
  if (real.length !== hybrid.length || real.length === 0) return false;
  return real.every((w, i) => Math.abs(w.count - hybrid[i]!.count) <= 1 && Math.abs(w.bytes - hybrid[i]!.bytes) <= 0.02 * Math.max(w.bytes, 1));
}

const arm = (over: Partial<ArmResult>): ArmResult => ({ arm: "r32", perTxn: 16, records: 1000, bytes: 1_000_000, elapsedMs: 60_000, chargeCalls: 0, chargeBytes: 0, stopped: null, ...over });

describe("T11 verdict and equivalence (no clock, no index)", () => {
  it("line A: equal mean bytes/record passes, a greater mean fails", () => {
    expect(verdict([arm({ arm: "today" })], [arm({})]).noWorse).toBe(true);
    expect(verdict([arm({ arm: "today" })], [arm({ bytes: 1_000_001 })]).noWorse).toBe(false);
    expect(verdict([arm({ arm: "today" })], [arm({ bytes: 900_000 })]).noWorse).toBe(true);
  });
  it("line B: strictly under 50 MiB/min; exactly 50 MiB/min fails; a short window is scaled to a minute", () => {
    expect(verdict([arm({})], [arm({ bytes: TRUST_LIMIT_BYTES_PER_MIN - 1 })]).rateOk).toBe(true);
    expect(verdict([arm({})], [arm({ bytes: TRUST_LIMIT_BYTES_PER_MIN })]).rateOk).toBe(false);
    expect(verdict([arm({})], [arm({ bytes: TRUST_LIMIT_BYTES_PER_MIN / 2, elapsedMs: 15_000 })]).rateOk).toBe(false);
  });
  it("line B looks at the worst window, not the mean", () => {
    const quiet = arm({ bytes: 1_000_000 }), loud = arm({ bytes: TRUST_LIMIT_BYTES_PER_MIN + 1 });
    expect(verdict([arm({})], [quiet, quiet, loud]).rateOk).toBe(false);
  });
  it("an arm that wrote no record can never pass line A", () => {
    expect(verdict([arm({ arm: "today" })], [arm({ records: 0, bytes: 0 })]).noWorse).toBe(false);
  });
  it("hybrid equivalence: count within 1 and bytes within 2% per window, else not equivalent", () => {
    const real = [{ count: 10, bytes: 1_000_000 }, { count: 12, bytes: 2_000_000 }];
    expect(hybridEquivalent(real, [{ count: 11, bytes: 1_020_000 }, { count: 11, bytes: 1_960_000 }])).toBe(true);
    expect(hybridEquivalent(real, [{ count: 12, bytes: 1_000_000 }, { count: 12, bytes: 2_000_000 }])).toBe(false);
    expect(hybridEquivalent(real, [{ count: 10, bytes: 1_020_001 }, { count: 12, bytes: 2_000_000 }])).toBe(false);
    expect(hybridEquivalent(real, [{ count: 10, bytes: 1_000_000 }])).toBe(false);
    expect(hybridEquivalent([], [])).toBe(false);
  });
});

// ---- the measured legs ----
const WORDS = Array.from({ length: 600 }, (_, n) => `w${(n * 2654435761 % 1_000_003).toString(36)}`);
/** The fixture, identical in both builds: record n has 14 words drawn from a 600-word pool by a fixed generator, in one of 8 scopes. */
export function fixtureRecord(n: number): IndexedMemory {
  let state = (n + 1) * 2246822519 % 4294967296;
  const words: string[] = [];
  for (let k = 0; k < 14; k++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; words.push(WORDS[state % WORDS.length]!); }
  return { id: `t11-${String(n).padStart(8, "0")}`, version: 1, scopeId: `s${n % 8}`, text: words.join(" "), deleted: false };
}

const env = (name: string, fallback: number) => { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? v : fallback; };
const WINDOW_MS = () => env("T11_WINDOW_MS", 60_000);
const RATE = () => env("T11_RECORDS_PER_SEC", 200);
const hasCreate = () => typeof (MemoryIndex as unknown as { create?: unknown }).create === "function";
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** One window on a real clock: records arrive at RATE per second in chunks of perTxn, written by the build's own path
 * (today: upsert; this build: applyBatch, maintenanceStep when it asks for one), the meter reads the WAL frame bytes. */
async function runArm(perTxn: number, windowMs: number): Promise<ArmResult> {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  const path = join(DATA_DIR, "memory-index.db");
  let chargeCalls = 0, chargeBytes = 0, stopped: string | null = null;
  const modern = hasCreate();
  const index = modern
    ? await MemoryIndex.create(path, { charge: async c => { chargeCalls++; chargeBytes += Number(c.bytes) || 0; return true; } })
    : new (MemoryIndex as unknown as { new(path: string): MemoryIndex })(path);
  const meter = walFrameReader(path);
  const baseline = meter();
  const gap = (perTxn / RATE()) * 1000;
  let written = 0, elapsedMs = 0, bytes = 0;
  const started = performance.now();
  try {
    while (performance.now() - started < windowMs && stopped === null) {
      const tick = performance.now();
      const chunk = Array.from({ length: perTxn }, (_, k) => fixtureRecord(written + k));
      if (!modern) (index as unknown as { upsert(records: IndexedMemory[]): void }).upsert(chunk);
      for (let tries = 0; modern; tries++) {
        const result = await index.applyBatch(chunk);
        if (result.status === "done") break;
        const reason = result.reason ?? "unknown";
        if (reason === "wal-over" || reason === "merge-floor" || tries > 200) { stopped = reason; break; }
        await index.maintenanceStep();
      }
      if (stopped === null) written += perTxn;
      const wait = gap - (performance.now() - tick);
      if (wait > 1) await sleep(wait);
    }
  } finally {
    elapsedMs = performance.now() - started;
    bytes = meter() - baseline;
    index.close(); meter.close();
  }
  return { arm: modern ? "r32" : "today", perTxn, records: written, bytes, elapsedMs, chargeCalls, chargeBytes, stopped };
}

const measured = process.env.MEMORY_PERF_T11 === "1" ? describe : describe.skip;
afterEach(() => { closeDatabase(); });

measured("T11 trust rate, measured on a quiet host", () => {
  const out = process.env.T11_OUT;
  const todayArm = process.env.T11_ARM === "today";

  // the child leg, run inside the 5fe4904c2 tree: one window, result to T11_OUT, no assertion
  (todayArm ? it : it.skip)("today arm: one window, result written to T11_OUT", async () => {
    expect(hasCreate()).toBe(false);
    expect(out).toBeTruthy();
    writeFileSync(out!, JSON.stringify(await runArm(env("T11_PER_TXN", 16), WINDOW_MS())));
  }, 600_000);

  (todayArm ? it.skip : it)("10 interleaved pairs (today first) and the negative fixture", async () => {
    expect(hasCreate()).toBe(true);
    const tree = process.env.T11_TODAY_TREE;
    expect(tree, "T11_TODAY_TREE must name a worktree of 5fe4904c2 with node_modules and this file").toBeTruthy();
    const pairs = env("T11_PAIRS", 10), perTxn = env("T11_PER_TXN", 16), windowMs = WINDOW_MS();
    const today: ArmResult[] = [], current: ArmResult[] = [];
    const dir = join(tmpdir(), `t11-${process.pid}`); mkdirSync(dir, { recursive: true });
    try {
      for (let pair = 0; pair < pairs; pair++) {
        const file = join(dir, `today-${pair}.json`);
        const child = spawnSync(join(tree!, "node_modules/.bin/vitest"), ["run", "server/memory/age-index-trust-rate.perf.test.ts"], {
          cwd: tree!, encoding: "utf8", timeout: windowMs + 180_000,
          env: { ...process.env, MEMORY_PERF_T11: "1", T11_ARM: "today", T11_OUT: file, T11_PER_TXN: String(perTxn), T11_WINDOW_MS: String(windowMs) },
        });
        expect(child.status, `today arm pair ${pair}: ${child.stdout?.slice(-600)}${child.stderr?.slice(-300)}`).toBe(0);
        today.push(JSON.parse(readFileSync(file, "utf8")) as ArmResult);
        current.push(await runArm(perTxn, windowMs));
      }
      const negative = await runArm(1, env("T11_NEG_MS", 20_000));
      const good = verdict(today, current), bad = verdict(today, [negative]);
      const f = (n: number) => n.toFixed(0);
      console.log(`[T11] ${windowMs < 60_000 ? "SMOKE RUN (window under 60 s, not gate evidence) " : ""}pairs=${pairs} per-txn=${perTxn} arrival=${RATE()}/s clock=real`);
      console.log(`[T11] bytes/record today=${f(good.meanToday)} this=${f(good.meanThis)} | worst window ${(good.maxRatePerMin / 1048576).toFixed(2)} MiB/min (limit 50)`);
      console.log(`[T11] charge calls/bytes per window (this build): ${current.map(r => `${r.chargeCalls}/${r.chargeBytes}`).join(" ")}; stopped: ${current.map(r => r.stopped ?? "-").join(",")}`);
      console.log(`[T11] negative (1 record/txn): bytes/record ${f(bad.meanThis)}, ${(bad.maxRatePerMin / 1048576).toFixed(2)} MiB/min, noWorse=${bad.noWorse}, rateOk=${bad.rateOk}`);
      expect(current.every(r => r.stopped === null), "no window stopped early").toBe(true);
      expect(good.noWorse, `line A: ${good.meanThis} vs today ${good.meanToday} bytes/record`).toBe(true);
      expect(good.rateOk, `line B: ${good.maxRatePerMin} B/min`).toBe(true);
      expect(bad.noWorse, "negative fixture must fail line A").toBe(false);
      expect(bad.rateOk, "negative fixture must fail line B").toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 7_200_000);
});
