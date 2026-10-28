// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { HEALTH_LIMITS, encodeWindowLine } from "../../shared/health-protocol.mjs";
import { DETECTOR_VERSIONS, type DetectorRun } from "./detectors/index.ts";
import { at, tok, win } from "./detectors/fixtures.ts";
import { VIEW_FILE, readPublishedView } from "./publication.ts";
import { DETECTOR_STATES_COMMIT_BYTES, FAILURES_FILE, LEASE_FILE, acquireLease, recordScanFailure, runScan, type ScanOptions } from "./scan.ts";
import { INST, T0, cleanupFixtures, issueRecord, makeInstall, type FixtureInstall } from "./scan-fixtures.ts";
import { STORE_FILE, SentinelStore } from "./store.ts";
import type { DetectorInput, DetectorResult } from "./types.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

afterEach(() => cleanupFixtures());
const MIN = 60_000;

function clock(start = T0, monoStart = 5_000_000) {
  let wall = start;
  let mono = monoStart;
  return { now: () => wall, monotonicMs: () => mono, advance(ms: number, monoMs = ms) { wall += ms; mono += monoMs; } };
}

function result(n: number, overrides: Partial<DetectorResult> = {}): DetectorResult {
  return {
    tuple: { installationId: INST, detectorId: "extraction", subsystem: "memory", engineKind: "claude", sourceKey: tok(n), errorClass: "unusable" },
    triggered: "medium", occurrences: 1, recovery: { positive: false, complete: false }, coverage: "complete", pageEligible: false,
    titleKey: "extraction.unusable", window: { startAt: T0 - MIN, endAt: T0 }, metrics: {}, evidence: [], ...overrides,
  };
}

/** A detector run stand-in: records each input and answers the scripted results with constant state. */
function scripted(script: (input: DetectorInput, call: number) => DetectorResult[]) {
  const inputs: DetectorInput[] = [];
  const run = (input: DetectorInput): DetectorRun[] => {
    inputs.push(input);
    return [{ id: "extraction", version: DETECTOR_VERSIONS.extraction, results: script(input, inputs.length), nextState: { version: DETECTOR_VERSIONS.extraction, state: { fixed: true } }, oversize: false, failed: false }];
  };
  return { run, inputs };
}

/** The test runner's own CPU and RSS are not the scanner's: the runtime ceilings are covered in budget.test.ts. */
const QUIET = { cpuMicros: () => 0, rssBytes: () => 0 };
const scan = (fx: FixtureInstall, c: ReturnType<typeof clock>, extra: Partial<ScanOptions> = {}) => runScan({ descriptor: fx.descriptor, now: c.now, monotonicMs: c.monotonicMs, budget: QUIET, ...extra });
const storeOf = (fx: FixtureInstall) => {
  const opened = SentinelStore.open(fx.descriptor.outputRoot, { installationId: INST, readOnly: true });
  if (!opened.store) throw new Error(opened.status);
  return opened.store;
};

describe("scan lifecycle with the real detectors", () => {
  it("turns a failed backup manifest into one High S01 issue and exactly one page intent", () => {
    const fx = makeInstall();
    fx.writeBackup({ configuredAt: T0, lastVerified: null, phase: "failed", failureCode: "capture-failed", failureAt: T0 + MIN });
    const c = clock(T0 + 2 * MIN);
    const first = scan(fx, c);
    expect(first.status).toBe("published");
    expect(first.phase).toBe("published");
    const view = readPublishedView(fx.descriptor.outputRoot)!;
    expect(view.storeRevision).toBe(first.revision);
    const backupRow = view.rows.find(r => r.detectorId === "backup");
    expect(backupRow).toMatchObject({ severity: "high", state: "open", delivery: "page", nextAction: "backups" });
    c.advance(2 * MIN);
    scan(fx, c);
    const store = storeOf(fx);
    const pages = store.db.prepare("SELECT count(*) AS n FROM intents WHERE delivery = 'page'").get() as { n: number };
    expect(Number(pages.n)).toBe(1);
    store.close();
  });

  it("with no inputs at all it publishes, says coverage is unavailable, and invents nothing", () => {
    const fx = makeInstall();
    removeTempDirSync(fx.health);
    const out = scan(fx, clock());
    expect(out.status).toBe("published");
    expect(out.coverage).toBe("unavailable");
    expect(readPublishedView(fx.descriptor.outputRoot)!.summary.coverage).toBe("unavailable");
  });

  it("keeps scan cost constant with 10,000 historical windows on disk", () => {
    const fx = makeInstall();
    fx.appendRaw("server", Array.from({ length: 10_000 }, (_, i) => (encodeWindowLine(win(i + 1, { seq: i + 1 })) as { ok: true; value: string }).value).join(""));
    const c = clock(at(10_000));
    const first = scan(fx, c);
    expect(first.readBytes).toBeLessThanOrEqual(HEALTH_LIMITS.baselineTailBytes + 1024);
    fx.append("server", win(10_001, { seq: 10_001 }));
    c.advance(2 * MIN);
    const second = scan(fx, c);
    expect(second.readBytes).toBeLessThan(2 * HEALTH_LIMITS.recordBytes);
  });
});

describe("producers an installation runs", () => {
  const coverageRows = (fx: FixtureInstall, role: "desktop" | "backup") => {
    const store = storeOf(fx);
    const rows = (store.db.prepare("SELECT record FROM issues").all() as Array<{ record: string }>).map(r => JSON.parse(r.record) as { issue: { titleKey: string; state: string } })
      .filter(r => r.issue.titleKey === `health.coverage.source-unavailable-${role}`);
    store.close();
    return rows;
  };
  const desktopRows = (fx: FixtureInstall) => coverageRows(fx, "desktop");

  it("a server-only installation (self-host, Cloud) has no backup coordinator, so no backup manifest is nothing missing", () => {
    const fx = makeInstall();
    fx.append("server", win(1));
    const c = clock(at(2));
    scan(fx, c);
    c.advance(2 * MIN);
    scan({ ...fx, descriptor: { ...fx.descriptor, producers: ["server"] as const } }, c);
    expect(coverageRows(fx, "backup")).toEqual([]);
  });

  it("a desktop installation without its backup manifest is short of it", () => {
    const declared = makeInstall();
    declared.append("server", win(1));
    scan({ ...declared, descriptor: { ...declared.descriptor, producers: ["server", "desktop"] } }, clock(at(2)));
    expect(coverageRows(declared, "backup").map(r => r.issue.state)).toEqual(["open"]);
    const seen = makeInstall();
    seen.append("server", win(1));
    seen.append("desktop", win(1, { producer: "desktop" }));
    scan(seen, clock(at(2)));
    expect(coverageRows(seen, "backup").map(r => r.issue.state)).toEqual(["open"]);
  });

  it("a server-only installation is never short of a desktop producer it does not have", () => {
    const fx = makeInstall();
    fx.append("server", win(1));
    const c = clock(at(2));
    expect(scan(fx, c).status).toBe("published");
    c.advance(2 * MIN);
    fx.append("server", win(3, { seq: 3 }));
    scan(fx, c);
    expect(desktopRows(fx)).toEqual([]);
    const declared = { ...fx, descriptor: { ...fx.descriptor, producers: ["server"] as const } };
    c.advance(2 * MIN);
    scan(declared, c);
    expect(desktopRows(fx)).toEqual([]);
  });

  it("a desktop producer the descriptor expects, or one that published before and went missing, is unavailable", () => {
    const expected = makeInstall();
    expected.append("server", win(1));
    scan({ ...expected, descriptor: { ...expected.descriptor, producers: ["server", "desktop"] } }, clock(at(2)));
    expect(desktopRows(expected).map(r => r.issue.state)).toEqual(["open"]);

    const vanished = makeInstall();
    vanished.append("server", win(1));
    vanished.append("desktop", win(1, { producer: "desktop" }));
    const c = clock(at(2));
    scan(vanished, c);
    expect(desktopRows(vanished)).toEqual([]);
    rmSync(vanished.file("desktopCurrent"));
    c.advance(2 * MIN);
    scan(vanished, c);
    expect(desktopRows(vanished).map(r => r.issue.state)).toEqual(["open"]);
  });
});

describe("scan commit and crash story", () => {
  it("a no-op scan with unchanged inputs commits nothing and rewrites nothing", () => {
    const fx = makeInstall();
    fx.append("server", win(1));
    const det = scripted(() => []);
    const c = clock(at(2));
    expect(scan(fx, c, { runDetectors: det.run }).status).toBe("published");
    const file = join(fx.descriptor.outputRoot, STORE_FILE);
    const before = readFileSync(file);
    const viewBefore = statSync(join(fx.descriptor.outputRoot, VIEW_FILE)).mtimeMs;
    c.advance(2 * MIN);
    const second = scan(fx, c, { runDetectors: det.run });
    expect(second.status).toBe("no-op");
    expect(second.readBytes).toBe(0);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(statSync(join(fx.descriptor.outputRoot, VIEW_FILE)).mtimeMs).toBe(viewBefore);
    expect(det.inputs).toHaveLength(2); // detectors still ran: due times and freshness are evaluated
  });

  it("writes a heartbeat at most once per 15 minutes", () => {
    const fx = makeInstall();
    const det = scripted(() => []);
    const c = clock();
    scan(fx, c, { runDetectors: det.run });
    c.advance(15 * MIN - 1);
    expect(scan(fx, c, { runDetectors: det.run }).status).toBe("no-op");
    c.advance(1);
    expect(scan(fx, c, { runDetectors: det.run }).status).toBe("published");
    const store = storeOf(fx);
    expect(store.meta("heartbeat_at")).toBe(T0 + 15 * MIN);
    store.close();
  });

  it("a crash before commit replays the same records next scan", () => {
    const fx = makeInstall();
    fx.append("server", [win(1), win(2)]);
    const det = scripted(() => []);
    const c = clock(at(3));
    expect(() => scan(fx, c, { runDetectors: det.run, hooks: { beforeCommit: () => { throw new Error("crash"); } } })).toThrow("crash");
    c.advance(2 * MIN);
    scan(fx, c, { runDetectors: det.run });
    expect(det.inputs.map(i => i.windows.server.map(w => w.seq))).toEqual([[1, 2], [1, 2]]);
  });

  it("a crash after commit republishes the same revision without recounting", () => {
    const fx = makeInstall();
    const det = scripted((_input, call) => (call === 1 ? [result(1)] : []));
    const c = clock();
    expect(() => scan(fx, c, { runDetectors: det.run, hooks: { afterCommit: () => { throw new Error("crash"); } } })).toThrow("crash");
    expect(readPublishedView(fx.descriptor.outputRoot)).toBeNull();
    c.advance(2 * MIN);
    const next = scan(fx, c, { runDetectors: det.run });
    expect(next.republished).toBe(true);
    const view = readPublishedView(fx.descriptor.outputRoot)!;
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]!.count).toBe(1);
  });

  it("a duplicate concurrent start exits already-running and never steals the lease", () => {
    const fx = makeInstall();
    const lease = acquireLease(fx.descriptor.outputRoot)!;
    expect(lease).not.toBeNull();
    expect(acquireLease(fx.descriptor.outputRoot)).toBeNull();
    expect(scan(fx, clock()).status).toBe("already-running");
    lease.release();
    expect(scan(fx, clock()).status).toBe("published");
  });

  it("the lease is held by a live process and released when that process dies", async () => {
    const fx = makeInstall();
    const file = join(fx.descriptor.outputRoot, LEASE_FILE);
    const holder = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(${JSON.stringify(file)}, { timeout: 0 });
      db.exec("PRAGMA locking_mode=EXCLUSIVE"); db.exec("BEGIN EXCLUSIVE");
      process.stdout.write("locked\\n");
      setInterval(() => {}, 1000);
    `], { stdio: ["ignore", "pipe", "ignore"], env: {} });
    await new Promise<void>((resolve, reject) => {
      holder.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("locked")) resolve(); });
      holder.once("exit", () => reject(new Error("holder exited")));
    });
    expect(scan(fx, clock()).status).toBe("already-running");
    const exited = new Promise(resolve => holder.once("exit", resolve));
    holder.kill("SIGKILL");
    await exited;
    expect(scan(fx, clock()).status).toBe("published");
  });

  it("an unknown store schema keeps the last view, reports upgrade-needed and stops writing", () => {
    const fx = makeInstall();
    const det = scripted(() => [result(1)]);
    scan(fx, clock(), { runDetectors: det.run });
    const file = join(fx.descriptor.outputRoot, STORE_FILE);
    const db = new DatabaseSync(file);
    db.exec("PRAGMA user_version=9");
    db.close();
    const before = readFileSync(file);
    const out = scan(fx, clock(T0 + 2 * MIN), { runDetectors: det.run });
    expect(out.status).toBe("upgrade-needed");
    expect(readFileSync(file).equals(before)).toBe(true);
    const view = readPublishedView(fx.descriptor.outputRoot)!;
    expect(view.summary.scanner).toBe("upgrade-needed");
    expect(view.rows).toHaveLength(1);
  });

  it("a corrupt store is preserved and the view says unavailable", () => {
    const fx = makeInstall();
    const file = join(fx.descriptor.outputRoot, STORE_FILE);
    writeFileSync(file, "garbage ".repeat(1000), { mode: 0o600 });
    const before = readFileSync(file);
    expect(scan(fx, clock()).status).toBe("unavailable");
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(readPublishedView(fx.descriptor.outputRoot)!.summary.scanner).toBe("unavailable");
  });
});

describe("scan caps", () => {
  it("changes at most 32 issue rows per scan; the rest wait and land next scan without loss or recount", () => {
    const fx = makeInstall();
    const det = scripted((_input, call) => (call === 1 ? Array.from({ length: 40 }, (_, i) => result(i + 1)) : []));
    const c = clock();
    const first = scan(fx, c, { runDetectors: det.run });
    expect(first.changedIssues).toBe(32);
    expect(first.deferred).toBe(8);
    c.advance(2 * MIN);
    const second = scan(fx, c, { runDetectors: det.run });
    expect(second.changedIssues).toBe(8);
    const store = storeOf(fx);
    expect(store.issueCount()).toBe(40);
    expect(store.pendingCount()).toBe(0);
    const counts = store.db.prepare("SELECT record FROM issues").all() as Array<{ record: string }>;
    expect(counts.every(r => JSON.parse(r.record).issue.count === 1)).toBe(true);
    store.close();
  });

  it("at 256 rows a new issue evicts the oldest resolved one, and with none resolved it is counted as overflow", () => {
    const fx = makeInstall();
    const opened = SentinelStore.open(fx.descriptor.outputRoot, { installationId: INST });
    if (opened.status !== "ok") throw new Error(opened.status);
    for (let start = 0; start < 256; start += 32) opened.store.commit({ issues: Array.from({ length: 32 }, (_, i) => issueRecord(1000 + start + i, start + i === 5 ? { state: "resolved", resolvedAt: T0, resolution: "observed-recovery" } : {})) });
    opened.store.close();
    const det = scripted((_input, call) => (call === 1 ? [result(1)] : call === 2 ? [result(2)] : []));
    const c = clock(T0 + 1000);
    scan(fx, c, { runDetectors: det.run });
    let store = storeOf(fx);
    expect(store.issueCount()).toBe(256);
    expect(store.oldestResolved(5)).toEqual([]);
    store.close();
    c.advance(2 * MIN);
    scan(fx, c, { runDetectors: det.run });
    store = storeOf(fx);
    expect(store.issueCount()).toBe(256);
    expect(store.selfHealth().overflow.count).toBe(1);
    store.close();
  });

  it("detector state can never stop every commit: the worst case fits, cursors move and issue rows still land", () => {
    const fx = makeInstall();
    fx.append("server", win(1));
    const big = (input: DetectorInput, tag: string) => ({ tag, at: input.now, filler: "x".repeat(60 * 1024) }); // just under the 64 KiB per-detector cap
    const ids = ["extraction", "send-fence", "dispatch-exhausted", "resets", "isolation-noise"] as const;
    const run = (input: DetectorInput): DetectorRun[] => ids.map((id, k) => ({
      id, version: DETECTOR_VERSIONS[id], results: k === 0 ? [result(1)] : [], nextState: { version: DETECTOR_VERSIONS[id], state: big(input, id) }, oversize: false, failed: false,
    }));
    const c = clock(at(2));
    const first = scan(fx, c, { runDetectors: run });
    expect(first.status).toBe("published");
    expect(first.changedIssues).toBe(1);
    fx.append("server", win(2));
    c.advance(2 * MIN);
    const second = scan(fx, c, { runDetectors: run });
    expect(second.status).toBe("published");
    const store = storeOf(fx);
    expect(store.cursor("server")!.lastSeq).toBe(2);
    expect(store.issueCount()).toBe(1);
    const states = Object.values(store.detectorStates());
    expect(states.reduce((n, s) => n + JSON.stringify(s).length, 0)).toBeLessThanOrEqual(DETECTOR_STATES_COMMIT_BYTES + ids.length * 64 * 1024);
    expect(store.selfHealth().overflow.count).toBeGreaterThan(0); // the states that did not fit are counted, never silently lost
    store.close();
  });

  it("a state that changes only its stored awake clock is no reason to commit", () => {
    const fx = makeInstall();
    fx.append("server", win(1));
    const run = (input: DetectorInput): DetectorRun[] => [{ id: "coverage", version: DETECTOR_VERSIONS.coverage, results: [], nextState: { version: DETECTOR_VERSIONS.coverage, state: { awake: input.awake.awakeNowMs, fixed: true } }, oversize: false, failed: false }];
    const c = clock(at(2));
    expect(scan(fx, c, { runDetectors: run }).status).toBe("published");
    c.advance(2 * MIN);
    expect(scan(fx, c, { runDetectors: run }).status).toBe("no-op");
  });

  it("an exhausted daily write budget stops source work and records the stop once from the reserve", () => {
    const fx = makeInstall();
    fx.append("server", win(1));
    const c = clock(at(2));
    scan(fx, c);
    const opened = SentinelStore.open(fx.descriptor.outputRoot, { installationId: INST });
    if (opened.status !== "ok") throw new Error(opened.status);
    opened.store.commit({ meta: { write_bucket: { tokens: 70 * 1024, at: at(2) } } });
    opened.store.close();
    fx.append("server", win(2));
    const out = scan(fx, c);
    expect(out.status).toBe("budget-exhausted");
    expect(out.readBytes).toBe(0);
    const again = scan(fx, c);
    expect(again.status).toBe("budget-exhausted");
    expect(again.revision).toBeNull();
    const store = storeOf(fx);
    expect(store.selfHealth().lastStop).toBe("write-budget");
    expect(store.cursor("server")!.lastSeq).toBe(1);
    store.close();
  });
});

describe("scan clocks and failures", () => {
  it("a wall-clock jump against the awake clock is a discontinuity; plain cadence is not", () => {
    const fx = makeInstall();
    const det = scripted(() => []);
    const c = clock();
    scan(fx, c, { runDetectors: det.run });
    c.advance(15 * MIN);
    scan(fx, c, { runDetectors: det.run });
    c.advance(60 * MIN, 2 * MIN); // slept, or the clock moved
    scan(fx, c, { runDetectors: det.run });
    expect(det.inputs.map(i => i.awake.discontinuity)).toEqual([false, false, true]);
    expect(det.inputs[1]!.awake.previousAwakeMs).toBe(5_000_000);
  });

  it("supervisor-recorded failures reach the detectors and are merged into the store", () => {
    const fx = makeInstall();
    recordScanFailure(fx.descriptor.outputRoot, T0 - 5 * MIN);
    recordScanFailure(fx.descriptor.outputRoot, T0 - 3 * MIN);
    const det = scripted(() => []);
    scan(fx, clock(), { runDetectors: det.run });
    expect(det.inputs[0]!.scanFailures).toEqual([T0 - 5 * MIN, T0 - 3 * MIN]);
    expect(existsSync(join(fx.descriptor.outputRoot, FAILURES_FILE))).toBe(false);
    const store = storeOf(fx);
    expect(store.meta("scan_failures")).toEqual([T0 - 5 * MIN, T0 - 3 * MIN]);
    store.close();
  });

  it("refuses an output root that is not owner-only material before taking any lease", () => {
    const fx = makeInstall();
    const out = runScan({ descriptor: { ...fx.descriptor, outputRoot: join(fx.base, "elsewhere", INST) }, now: () => T0 });
    expect(out.status).toBe("output-refused");
  });
});
