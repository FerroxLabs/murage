// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW 1.0.18 Part A WP1, r3.2.6 A1': T14f' (stop in place) on the real clock, 10 min (MEMW_T14F_MS shortens it for mutant runs only).
// Controller acks stuck from t=0. (a) a breach past C: within one tick a -walstop with the right fileId and seq; every 1 s for the run the
// -wal length is what the breach left, the main file's sha256 is unchanged (no checkpoint), the set's paths are unchanged (no rename) and
// no SQLite statement runs; merge/tier/seal/delete/group refused. A second index whose check was refused first, then grew past C, stops
// the same way. (b) an ordinary owed check: no stop, the -wal constant. (c) acks resume: the stop is noted once however often a start
// reports it, the reset moves the set aside with -walstop left live (r3.2.8: presence-only), the fresh open ignores it, removeStopMarker
// removes it, and every record is indexed. The reset{R} timing at due_at (k=1, k=2)
// is the controller's half (WP3).
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { quarantineIndex, removeStopMarker } from "./index-quarantine.ts";
import { IndexWalWriter, MEMW_C_BYTES, MEMW_W_STEP_BYTES, openIndexWal, readSidecar, WalStop, walTestHooks, WalUnresolved, type ChargeTransport, type OpenedIndexWal } from "./index-wal.ts";

const MB = 1024 * 1024, TICK_MS = 50, SAMPLE_MS = 1_000;
const RUN_MS = Number(process.env.MEMW_T14F_MS ?? 600_000);
const roots: string[] = [], handles: OpenedIndexWal[] = [];
afterEach(() => {
  for (const key of Object.keys(walTestHooks) as Array<keyof typeof walTestHooks>) delete walTestHooks[key];
  for (const o of handles.splice(0)) { try { (o.wal as IndexWalWriter).closeForQuarantine(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) removeTempDirSync(root);
});
const walLen = (path: string) => { try { return statSync(`${path}-wal`).size; } catch { return 0; } };
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** The host's timer quantum q (MurageMain 22:29Z): the median lateness of 21 short sleeps, capped at 16 ms (Windows' ~15.6 ms tick). */
async function timerQuantum(): Promise<number> {
  const late: number[] = [];
  for (let i = 0; i < 21; i++) { const t0 = performance.now(); await sleep(1); late.push(performance.now() - t0 - 1); }
  late.sort((x, y) => x - y);
  return Math.min(16, Math.max(0, late[10]!));
}
/** Today's implicit slack in the sample floor at the gate's 10 min: 600,000 ms - 598 samples x 1,000 ms. */
const SAMPLE_SLACK_MS = 2_000;
/** MurageMain 22:58Z (case a): one sample's checks are test-side observation plus 20 instant product refusals; the p99 of the per-sample
 * check time catches a stall in the checked paths without charging a host's slower stat/read to the lateness budget. */
const CHECK_P99_MS = 25;
function fresh(name: string): string { const root = mkdtempSync(join(tmpdir(), `memw-t14f-${name}-`)); roots.push(root); return join(root, "memory-index.db"); }
function rows(db: DatabaseSync, bytes: number): void {
  db.exec("CREATE TABLE IF NOT EXISTS t(x BLOB)");
  const put = db.prepare("INSERT INTO t VALUES(randomblob(?))");
  for (let left = bytes; left > 0; left -= 4000) put.run(Math.min(4000, left));
}
/** Counts every statement the writer's two connections run from now on (the "no SQLite statement" seam). */
function countStatements(o: OpenedIndexWal): () => number {
  let n = 0;
  for (const db of [o.writable, o.guard]) {
    const exec = db.exec.bind(db), prepare = db.prepare.bind(db);
    Object.assign(db, { exec: (sql: string) => { n++; return exec(sql); }, prepare: (sql: string) => { n++; return prepare(sql); } });
  }
  return () => n;
}
/** The controller stand-in: acks stuck or flowing; notes a reported stop once per (fileId, seq) however often a start reports it. */
class Controller {
  stuck = false;
  readonly noted = new Map<string, unknown>();
  reports = 0;
  readonly charge: ChargeTransport = () => this.stuck ? new Promise<boolean>(() => undefined) : Promise.resolve(true);
  initialised(walOverStop: { fileId: string; seq: number } | null): void {
    if (!walOverStop) return;
    this.reports++;
    const key = `${walOverStop.fileId}:${walOverStop.seq}`;
    if (!this.noted.has(key)) this.noted.set(key, walOverStop);
  }
}
/** The helper tick: check while owed; a WalStop is the stop in place (recorded, nothing else is done). */
function ticker(o: () => OpenedIndexWal, stops: Array<{ at: number; error: WalStop }>, errors: unknown[]): () => void {
  return () => {
    const cur = o();
    if (!cur.wal.checkOwed() || cur.wal.stopped) return;
    cur.wal.check().catch((error: unknown) => { if (error instanceof WalStop) stops.push({ at: Date.now(), error }); else errors.push(error); });
  };
}

it("T14f': stop in place on the real clock: acks stuck from t=0; a breach past C stops in place within one tick and the set is frozen (no statement, checkpoint, close or rename); a refused check then a log past C stops the same way; an ordinary owed check never stops; acks resume: the stop noted once, the reset moves it aside, every record indexed", async () => {
  const controller = new Controller();
  const pathA = fresh("a"), pathB = fresh("b"), pathC = fresh("c");
  const opened = [pathA, pathB, pathC].map(p => openIndexWal(p, { charge: controller.charge }));
  handles.push(...opened);
  const [a, b, c] = opened as [OpenedIndexWal, OpenedIndexWal, OpenedIndexWal];
  for (const o of opened) {
    expect(await o.wal.openCheck()).toEqual({ state: "writable" });
    o.wal.write("open", 4 * MB, () => rows(o.writable, 100_000)); await o.wal.check();
  }
  const pending = Array.from({ length: 200 }, (_, i) => `rec-${i}`); // every record stays pending in the main DB (the index is derived)

  // The host's timer quantum is measured before the breach and before any helper tick, so product stalls cannot inflate the allowance and
  // the calibration sleeps cannot eat the 2 x TICK_MS stop-response window.
  const q = await timerQuantum();
  // t = 0: the controller stuck.
  controller.stuck = true; walTestHooks.chargeAckMs = 2_000;
  b.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(b.writable, 100_000)); // (b) ordinary, within its reserve
  c.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(c.writable, 100_000)); // refused first, then past C
  const lenB = walLen(pathB);
  a.wal.write("fill", MEMW_W_STEP_BYTES, () => rows(a.writable, 30 * MB)); // (a) a breach past C in one transaction
  const breachAt = Date.now(), seqA = (a.wal as IndexWalWriter).seq;
  const lenA = walLen(pathA), mainA = sha(pathA), statementsA = countStatements(a), statementsC = countStatements(c);
  expect(lenA).toBeGreaterThan(MEMW_C_BYTES);
  const stopsA: Array<{ at: number; error: WalStop }> = [], stopsB: typeof stopsA = [], stopsC: typeof stopsA = [], errors: unknown[] = [];
  const ticks = [ticker(() => a, stopsA, errors), ticker(() => b, stopsB, errors), ticker(() => c, stopsC, errors)];
  const timer = setInterval(() => { for (const t of ticks) t(); }, TICK_MS);
  let samples = 0, filesA: string[] | null = null, grewC = false, lenC = 0, mainC = "";
  // The sampler (MurageMain 22:29Z): sample n is due at start + n x SAMPLE_MS, with no catch-up (a tick whose deadline passed while a
  // sample ran is lost), so timer lateness never adds up across samples; the floor stays floor(RUN_MS / SAMPLE_MS) - 2 on every OS.
  // So that it is not looser than the old sleep(SAMPLE_MS) loop: the lateness beyond the host's timer quantum q (event-loop stalls from
  // the product's ticks between samples) plus the product time inside the samples (the admit/write refusals) must fit today's implicit slack,
  // sum(max(0, lateness - q)) + productMs <= SAMPLE_SLACK_MS (MurageMain "productMs yes"), and the p99 of
  // one sample's check time (observation + the product refusals at the admit/write loop) must stay <= CHECK_P99_MS (MurageMain 22:58Z).
  let lateMs = 0, checkMs = 0, productMs = 0, lost = 0;
  const checkTimes: number[] = [];
  try {
    const start = Date.now(), end = start + RUN_MS;
    let tick = 0;
    while (Date.now() < end) {
      const deadline = start + (tick + 1) * SAMPLE_MS;
      await sleep(Math.max(0, deadline - Date.now()));
      const wake = Date.now(), checkStart = performance.now();
      lateMs += Math.max(0, wake - deadline - q);
      // C: once its charge has been refused (timed out), the log grows past C outside any transaction (the test hook).
      if (!grewC && (c.wal as IndexWalWriter).counters.charge_refused > 0) { truncateSync(`${pathC}-wal`, MEMW_C_BYTES + 4096); grewC = true; lenC = walLen(pathC); mainC = sha(pathC); }
      expect(stopsA).toHaveLength(1);
      const side = readSidecar(pathA, "-walstop");
      expect(side.state).toBe("ok");
      if (side.state === "ok") expect(side.value).toMatchObject({ fileId: a.wal.fileId.toString(), seq: seqA, kind: "fill" });
      expect(walLen(pathA)).toBe(lenA);
      expect(sha(pathA)).toBe(mainA);
      const names = readdirSync(dirname(pathA)).sort();
      filesA ??= names;
      expect(names).toEqual(filesA);
      expect(statementsA()).toBe(0);
      const productStart = performance.now();
      for (const kind of ["merge", "tier", "seal", "delete", "group"] as const) {
        expect(a.wal.admit(kind, 1)).toBe(false);
        expect(() => a.wal.write(kind, MEMW_W_STEP_BYTES, () => undefined)).toThrow(WalStop);
        expect(b.wal.admit(kind, 1)).toBe(false);
        expect(() => b.wal.write(kind, MEMW_W_STEP_BYTES, () => undefined)).toThrow(WalUnresolved);
      }
      expect(b.wal.stopped).toBe(false);
      productMs += performance.now() - productStart;
      expect(stopsB).toHaveLength(0);
      expect(walLen(pathB)).toBe(lenB);
      expect(existsSync(`${pathB}-walstop`)).toBe(false);
      if (grewC && samples > 3 + Math.ceil(2_000 / SAMPLE_MS)) {
        expect(stopsC).toHaveLength(1);
        expect(readSidecar(pathC, "-walstop").state).toBe("ok");
        expect(walLen(pathC)).toBe(lenC);
        expect(sha(pathC)).toBe(mainC);
        expect(statementsC()).toBe(0);
      }
      samples++;
      const done = Date.now(), checkTime = performance.now() - checkStart;
      checkTimes.push(checkTime); checkMs += checkTime;
      const next = Math.floor((done - start) / SAMPLE_MS); // the last deadline already passed: never caught up
      lost += Math.max(0, next - (tick + 1));
      tick = Math.max(tick + 1, next);
    }
    expect(await b.wal.sealAndTruncate()).toEqual({ truncated: false });
  } finally { clearInterval(timer); }
  expect(errors).toEqual([]);
  const sorted = [...checkTimes].sort((x, y) => x - y), p99 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)] ?? 0;
  console.log(`T14F_SAMPLER samples=${samples} floor=${Math.floor(RUN_MS / SAMPLE_MS) - 2} q=${q.toFixed(2)} lateMs=${lateMs.toFixed(1)} budget=${(lateMs + productMs).toFixed(1)}/${SAMPLE_SLACK_MS} checkMs=${checkMs.toFixed(1)} checkP99=${p99.toFixed(2)}/${CHECK_P99_MS} checkMax=${(sorted.at(-1) ?? 0).toFixed(2)} productMs=${productMs.toFixed(1)} lost=${lost}`);
  expect(samples).toBeGreaterThanOrEqual(Math.floor(RUN_MS / SAMPLE_MS) - 2);
  expect(p99).toBeLessThanOrEqual(CHECK_P99_MS); // first, so a per-sample stall fails by name on the p99 line, not on the budget
  expect(lateMs + productMs).toBeLessThanOrEqual(SAMPLE_SLACK_MS);
  expect(stopsA[0]!.at - breachAt).toBeLessThanOrEqual(2 * TICK_MS); // the first tick after the breach
  expect(stopsA[0]!.error.message).toContain("stop_in_place");
  expect(grewC).toBe(true);
  expect(stopsC).toHaveLength(1);

  // (c) acks resume. B's check passes; A and C stay stopped. Every start reports the stop (the sidecar binds); the controller notes it once.
  controller.stuck = false; delete walTestHooks.chargeAckMs;
  const resumed = setInterval(() => { for (const t of ticks) t(); }, TICK_MS);
  try { for (let i = 0; i < 200 && b.wal.checkOwed(); i++) await sleep(TICK_MS); }
  finally { clearInterval(resumed); }
  expect(b.wal.checkOwed()).toBe(false);
  expect(a.wal.stopped && c.wal.stopped).toBe(true);
  for (let start = 0; start < 3; start++) {
    const again = openIndexWal(pathA, { charge: controller.charge }); handles.push(again);
    expect(again.verdict.state).toBe("stopped");
    controller.initialised(again.verdict.state === "stopped" ? { fileId: String(again.verdict.fileId), seq: Number(again.verdict.seq) } : null);
  }
  expect(controller.reports).toBe(3);
  expect(controller.noted.size).toBe(1);
  // The normal reset (handleReset's file half): writable first, guard last, the whole set aside, a fresh file.
  for (const o of handles.splice(0)) { if ([pathA, pathC].includes((o.wal as IndexWalWriter).indexPath)) (o.wal as IndexWalWriter).closeForQuarantine(); else handles.push(o); }
  for (const p of [pathA, pathC]) {
    const aside = quarantineIndex(p);
    expect(existsSync(`${aside}-walstop`)).toBe(false);
    expect(readSidecar(p, "-walstop").state).toBe("ok"); // presence-only: it stays live until the reset completes
  }
  const ra = openIndexWal(pathA, { charge: controller.charge, reset: true, ignoreMarker: true }), rc = openIndexWal(pathC, { charge: controller.charge, reset: true, ignoreMarker: true }); handles.push(ra, rc);
  for (const o of [ra, rc]) expect(await o.wal.openCheck()).toEqual({ state: "writable" });
  for (const p of [pathA, pathC]) { removeStopMarker(p); expect(existsSync(`${p}-walstop`)).toBe(false); }
  for (const o of [ra, b, rc]) {
    for (let i = 0; i < pending.length; i += 50) {
      const unit = pending.slice(i, i + 50);
      o.wal.write("group", MEMW_W_STEP_BYTES, () => {
        o.writable.exec("CREATE TABLE IF NOT EXISTS rec(id TEXT PRIMARY KEY)");
        const put = o.writable.prepare("INSERT OR IGNORE INTO rec VALUES(?)");
        for (const id of unit) put.run(id);
      });
      await o.wal.check();
    }
    expect(o.writable.prepare("SELECT count(*) AS n FROM rec").get()?.n).toBe(pending.length);
    expect(o.wal.stopped).toBe(false);
  }
}, RUN_MS + 120_000);
