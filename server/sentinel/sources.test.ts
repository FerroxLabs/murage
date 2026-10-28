// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { appendFileSync, linkSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HEALTH_LIMITS, encodeWindowLine } from "../../shared/health-protocol.mjs";
import { HealthPublisher } from "../health/publisher.ts";
import { StatsPublisher } from "../health/stats-publisher.ts";
import { ScanBudget } from "./budget.ts";
import { at, win } from "./detectors/fixtures.ts";
import { INST, T0, cleanupFixtures, makeInstall, type FixtureInstall } from "./scan-fixtures.ts";
import { HEAD_BYTES, querySealedStats, readBackupStatus, readDbStats, readProducer, sealedUri, type ProducerCursor, type ReadContext } from "./sources.ts";

const posixOnly = process.platform === "win32" ? it.skip : it;
afterEach(() => cleanupFixtures());

/** The test runner's own CPU and RSS are not the scanner's: the runtime ceilings are covered in budget.test.ts. */
const QUIET = { cpuMicros: () => 0, rssBytes: () => 0 };
const quiet = (limits: ConstructorParameters<typeof ScanBudget>[0] = {}) => new ScanBudget({ ...QUIET, ...limits });
const ctx = (fx: FixtureInstall, now = at(100), budget = quiet()): ReadContext => ({ budget, installationId: INST, inputRoot: fx.health, now });
const paths = (fx: FixtureInstall) => ({ current: fx.file("serverCurrent"), previous: fx.file("serverPrevious") });
const seqs = (windows: { seq: number }[]) => windows.map(w => w.seq);

describe("operational segments", () => {
  it("is unavailable, not empty, when no segment exists", () => {
    const fx = makeInstall();
    const read = readProducer("server", paths(fx), null, ctx(fx));
    expect(read.coverage).toBe("unavailable");
    expect(read.cursor).toBeNull();
  });

  it("reads new complete lines incrementally and never rereads them", () => {
    const fx = makeInstall();
    fx.append("server", [win(91), win(92)]);
    const first = readProducer("server", paths(fx), null, ctx(fx));
    expect(seqs(first.windows)).toEqual([91, 92]);
    expect(first.coverage).toBe("complete");
    fx.append("server", win(93));
    const second = readProducer("server", paths(fx), first.cursor, ctx(fx));
    expect(seqs(second.windows)).toEqual([93]);
    expect(second.discontinuity).toBe(false);
    const third = readProducer("server", paths(fx), second.cursor, ctx(fx));
    expect(third.changed).toBe(false);
    expect(third.windows).toEqual([]);
    expect(third.coverage).toBe("complete");
  });

  it("leaves a partial trailing line for the next scan", () => {
    const fx = makeInstall();
    fx.append("server", win(91));
    const line = (encodeWindowLine(win(92)) as { ok: true; value: string }).value;
    fx.appendRaw("server", line.slice(0, 40));
    const first = readProducer("server", paths(fx), null, ctx(fx));
    expect(seqs(first.windows)).toEqual([91]);
    fx.appendRaw("server", line.slice(40));
    const second = readProducer("server", paths(fx), first.cursor, ctx(fx));
    expect(seqs(second.windows)).toEqual([92]);
  });

  it("counts windows with equal timestamps once each, deduplicating by (epoch, seq) only", () => {
    const fx = makeInstall();
    fx.append("server", [win(91, { seq: 1 }), win(91, { seq: 2 }), win(91, { seq: 2 })]);
    const read = readProducer("server", paths(fx), null, ctx(fx));
    expect(seqs(read.windows)).toEqual([1, 2]);
  });

  it("skips an oversize or malformed line, counts it, and marks coverage partial", () => {
    const fx = makeInstall();
    fx.append("server", win(91));
    fx.appendRaw("server", `${"x".repeat(HEALTH_LIMITS.recordBytes + 10)}\n{"not":"a window"}\n`);
    fx.append("server", win(92));
    const read = readProducer("server", paths(fx), null, ctx(fx));
    expect(seqs(read.windows)).toEqual([91, 92]);
    expect(read.invalidLines).toBe(2);
    expect(read.coverage).toBe("partial");
  });

  it("refuses windows from another installation or producer", () => {
    const fx = makeInstall();
    fx.append("server", [win(91, { producer: "desktop" }), win(92)]);
    const read = readProducer("server", paths(fx), null, ctx(fx));
    expect(seqs(read.windows)).toEqual([92]);
    expect(read.invalidLines).toBe(1);
  });

  it("follows a rotation by identity: finishes the previous segment, then reads the new current from its start", () => {
    const fx = makeInstall();
    fx.append("server", win(91));
    const first = readProducer("server", paths(fx), null, ctx(fx));
    fx.append("server", win(92));
    fx.rotate("server");
    fx.append("server", win(93));
    const second = readProducer("server", paths(fx), first.cursor, ctx(fx));
    expect(seqs(second.windows)).toEqual([92, 93]);
    expect(second.discontinuity).toBe(false);
    expect(second.coverage).toBe("complete");
  });

  it("treats a missed rotation as a discontinuity and takes only the bounded baseline", () => {
    const fx = makeInstall();
    fx.append("server", win(91));
    const first = readProducer("server", paths(fx), null, ctx(fx));
    fx.rotate("server");
    fx.append("server", win(92));
    fx.rotate("server");
    fx.append("server", win(93));
    const second = readProducer("server", paths(fx), first.cursor, ctx(fx));
    expect(second.discontinuity).toBe(true);
    expect(second.coverage).toBe("partial");
    expect(seqs(second.windows)).toEqual([92, 93]); // the baseline takes the previous segment's tail too
  });

  it("treats truncation as a discontinuity without rereading history", () => {
    const fx = makeInstall();
    fx.append("server", [win(91), win(92), win(93)]);
    const first = readProducer("server", paths(fx), null, ctx(fx));
    truncateSync(fx.file("serverCurrent"), 0);
    fx.append("server", win(94));
    const second = readProducer("server", paths(fx), first.cursor, ctx(fx));
    expect(second.discontinuity).toBe(true);
    expect(seqs(second.windows)).toEqual([94]);
  });

  it("detects an in-place rewrite at the cursor boundary", () => {
    const fx = makeInstall();
    fx.append("server", [win(91), win(92)]);
    const first = readProducer("server", paths(fx), null, ctx(fx));
    const text = readFileSync(fx.file("serverCurrent"), "utf8");
    writeFileSync(fx.file("serverCurrent"), `${text.slice(0, -1)} `); // same size, the last newline replaced
    appendFileSync(fx.file("serverCurrent"), "\n");
    fx.append("server", win(93));
    const second = readProducer("server", paths(fx), first.cursor, ctx(fx));
    expect(second.discontinuity).toBe(true);
    expect(seqs(second.windows)).toEqual([93]);
  });

  it("does not take a different file under the same inode (inode reuse) for the segment it was reading", () => {
    const fx = makeInstall();
    fx.append("server", [win(91), win(92)]);
    const first = readProducer("server", paths(fx), null, ctx(fx));
    const replacement = [win(95, { seq: 300 }), win(96, { seq: 301 }), win(97, { seq: 302 })].map(w => (encodeWindowLine(w) as { ok: true; value: string }).value).join("");
    writeFileSync(fx.file("serverCurrent"), replacement); // same inode, new content
    const second = readProducer("server", paths(fx), first.cursor, ctx(fx));
    expect(second.discontinuity).toBe(true);
    expect(seqs(second.windows)).toEqual([300, 301, 302]);
  });

  it("marks a new producer epoch as a discontinuity and accepts its lower sequence numbers", () => {
    const fx = makeInstall();
    fx.append("server", [win(91, { epoch: 5, seq: 40 })]);
    const first = readProducer("server", paths(fx), null, ctx(fx));
    expect(first.discontinuity).toBe(false);
    fx.append("server", [win(92, { epoch: 6, seq: 0 }), win(93, { epoch: 6, seq: 1 })]);
    const second = readProducer("server", paths(fx), first.cursor, ctx(fx));
    expect(second.discontinuity).toBe(true);
    expect(second.windows.map(w => [w.epoch, w.seq])).toEqual([[6, 0], [6, 1]]);
    expect(second.cursor).toMatchObject({ epoch: 6, lastSeq: 1 });
    fx.append("server", win(94, { epoch: 5, seq: 41 }));
    const third = readProducer("server", paths(fx), second.cursor, ctx(fx));
    expect(third.windows).toEqual([]);
  });

  it("first scan reads the previous segment's tail before the current one: recent evidence just before a rotation counts", () => {
    const fx = makeInstall();
    fx.append("server", [win(10, { seq: 10 }), win(95, { seq: 95 }), win(96, { seq: 96 }), win(97, { seq: 97 }), win(98, { seq: 98 }), win(99, { seq: 99 })]);
    fx.rotate("server");
    fx.append("server", win(100, { seq: 100 }));
    const read = readProducer("server", paths(fx), null, ctx(fx, at(100)));
    expect(seqs(read.windows)).toEqual([95, 96, 97, 98, 99, 100]); // minute 10 is older than the 60 min baseline
    expect(read.coverage).toBe("complete");
    // the cursor sits at the end of current: the next scan reads only what is new
    fx.append("server", win(101, { seq: 101 }));
    expect(seqs(readProducer("server", paths(fx), read.cursor, ctx(fx, at(101))).windows)).toEqual([101]);
  });

  it("first scan takes only the last 64 KiB and the last 60 minutes", () => {
    const fx = makeInstall();
    const windows = Array.from({ length: 600 }, (_, i) => win(i + 1, { seq: i + 1, counters: [{ detector: "coverage", engineKind: "none", code: "gap", value: 1 }] }));
    fx.append("server", windows);
    const read = readProducer("server", paths(fx), null, ctx(fx, at(600)));
    expect(read.windows.length).toBeGreaterThan(0);
    expect(read.windows.every(w => w.endAt >= at(600) - HEALTH_LIMITS.baselineWindowMs)).toBe(true);
    expect(read.coverage).toBe("partial");
  });

  it("stops at the record budget, keeps its place, and resumes next scan without skipping or recounting", () => {
    const fx = makeInstall();
    fx.append("server", Array.from({ length: 10 }, (_, i) => win(91 + i, { seq: i + 1 })));
    const first = readProducer("server", paths(fx), null, ctx(fx, at(100), quiet({ limits: { records: 4 } })));
    expect(seqs(first.windows)).toEqual([1, 2, 3, 4]);
    expect(first.coverage).toBe("partial");
    const second = readProducer("server", paths(fx), first.cursor, ctx(fx));
    expect(seqs(second.windows)).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it("keeps per-scan read cost constant with 10,000 historical windows on disk", () => {
    const fx = makeInstall();
    const history = Array.from({ length: 10_000 }, (_, i) => (encodeWindowLine(win(i + 1, { seq: i + 1 })) as { ok: true; value: string }).value).join("");
    fx.appendRaw("server", history);
    const firstBudget = quiet();
    const first = readProducer("server", paths(fx), null, ctx(fx, at(10_000), firstBudget));
    expect(firstBudget.used.bytes).toBeLessThanOrEqual(HEALTH_LIMITS.baselineTailBytes + HEAD_BYTES + 1);
    fx.append("server", win(10_001, { seq: 10_001 }));
    const nextBudget = quiet();
    const next = readProducer("server", paths(fx), first.cursor, ctx(fx, at(10_001), nextBudget));
    expect(seqs(next.windows)).toEqual([10_001]);
    expect(nextBudget.used.bytes).toBeLessThan(HEALTH_LIMITS.recordBytes + 2);
    expect(nextBudget.used.stats).toBe(2);
  });

  posixOnly("refuses a symlinked or hard-linked segment as unavailable", () => {
    const fx = makeInstall();
    writeFileSync(join(fx.base, "other.ndjson"), (encodeWindowLine(win(91)) as { ok: true; value: string }).value, { mode: 0o600 });
    symlinkSync(join(fx.base, "other.ndjson"), fx.file("serverCurrent"));
    expect(readProducer("server", paths(fx), null, ctx(fx)).coverage).toBe("unavailable");
    linkSync(join(fx.base, "other.ndjson"), fx.file("desktopCurrent"));
    expect(readProducer("desktop", { current: fx.file("desktopCurrent"), previous: fx.file("desktopPrevious") }, null, ctx(fx)).coverage).toBe("unavailable");
  });

  it("returns the same cursor shape it was given (round-trips through JSON)", () => {
    const fx = makeInstall();
    fx.append("server", win(91));
    const first = readProducer("server", paths(fx), null, ctx(fx));
    const cursor = JSON.parse(JSON.stringify(first.cursor)) as ProducerCursor;
    expect(cursor).toEqual(first.cursor);
    expect(cursor.bucket).toBe(0);
  });
});

describe("backup status manifest", () => {
  it("is unavailable when missing and observed when valid; reuses the value while the identity is unchanged", () => {
    const fx = makeInstall();
    expect(readBackupStatus(fx.file("backupStatus"), null, ctx(fx))).toMatchObject({ status: null, coverage: "unavailable" });
    fx.writeBackup();
    const first = readBackupStatus(fx.file("backupStatus"), null, ctx(fx));
    expect(first.status?.enabled).toBe(true);
    expect(first.coverage).toBe("complete");
    const budget = quiet();
    const again = readBackupStatus(fx.file("backupStatus"), first.cache, ctx(fx, at(100), budget));
    expect(again.changed).toBe(false);
    expect(budget.used.bytes).toBe(0);
  });

  it("refuses a manifest for another installation, with extra keys, or free text", () => {
    const fx = makeInstall();
    writeFileSync(fx.file("backupStatus"), JSON.stringify({ ...JSON.parse(JSON.stringify(fx.writeBackup())), installationId: "f".repeat(32) }), { mode: 0o600 });
    expect(readBackupStatus(fx.file("backupStatus"), null, ctx(fx)).coverage).toBe("unavailable");
    writeFileSync(fx.file("backupStatus"), JSON.stringify({ ...JSON.parse(JSON.stringify(fx.writeBackup())), note: "my secret folder" }), { mode: 0o600 });
    expect(readBackupStatus(fx.file("backupStatus"), null, ctx(fx)).reason).toBe("invalid");
  });
});

describe("sealed database statistics", () => {
  it("reads a valid generation through the immutable read-only URI and leaves no sidecar", () => {
    const fx = makeInstall();
    const { file } = fx.writeStats();
    const read = readDbStats(fx.file("dbStatsManifest"), null, ctx(fx));
    expect(read.reason).toBeNull();
    expect(read.snapshot?.rows[0]).toMatchObject({ role: "messages", page_count: 2500, pending_revocations: null });
    for (const suffix of ["-wal", "-shm", "-journal"]) expect(() => readFileSync(file + suffix)).toThrow();
  });

  it("reads a generation published by the real stats publisher", async () => {
    const fx = makeInstall();
    const publisher = new HealthPublisher({ dataDir: fx.descriptor.installationRoot, now: () => T0 });
    expect(publisher.initialize()).toBe("ready");
    const stats = new StatsPublisher({ publisher, installationId: INST, now: () => T0 });
    const manifest = await stats.publishStatsGeneration({ at: T0, rows: [{ role: "messages", page_size: 4096, page_count: 10, wal_bytes: 0 }] });
    expect(manifest).not.toBeNull();
    const read = readDbStats(fx.file("dbStatsManifest"), null, ctx(fx));
    expect(read.reason).toBeNull();
    expect(read.snapshot?.manifest.generation).toBe(manifest!.generation);
  });

  it("keeps the query count and rows within the fixed caps", () => {
    const fx = makeInstall();
    fx.writeStats();
    const budget = quiet();
    readDbStats(fx.file("dbStatsManifest"), null, ctx(fx, at(100), budget));
    expect(budget.used.queries).toBeLessThanOrEqual(HEALTH_LIMITS.statsQueriesPerScan);
    expect(budget.used.rows).toBeLessThanOrEqual(HEALTH_LIMITS.statsRowsPerScan);
  });

  it("refuses a generation with a sidecar present", () => {
    const fx = makeInstall();
    const { file } = fx.writeStats();
    writeFileSync(`${file}-wal`, "", { mode: 0o600 });
    expect(readDbStats(fx.file("dbStatsManifest"), null, ctx(fx))).toMatchObject({ snapshot: null, coverage: "unavailable", reason: "sidecar" });
  });

  it("refuses a digest or size mismatch (a changed or replaced file)", () => {
    const fx = makeInstall();
    fx.writeStats({ manifest: { sha256: "0".repeat(64) } });
    expect(readDbStats(fx.file("dbStatsManifest"), null, ctx(fx)).reason).toBe("digest");
    fx.writeStats({ generation: 2, manifest: { bytes: 100 } });
    expect(readDbStats(fx.file("dbStatsManifest"), null, ctx(fx)).reason).toBe("size");
  });

  it.each([
    ["a view", "CREATE VIEW leak AS SELECT * FROM db_stats"],
    ["a trigger", "CREATE TRIGGER t AFTER INSERT ON db_stats BEGIN SELECT 1; END"],
    ["an extra table", "CREATE TABLE messages(body TEXT)"],
    ["an index", "CREATE INDEX i ON db_stats(sampled_at)"],
  ])("refuses a generation holding %s", (_label, sql) => {
    const fx = makeInstall();
    fx.writeStats({ extraSql: sql });
    expect(readDbStats(fx.file("dbStatsManifest"), null, ctx(fx))).toMatchObject({ snapshot: null, coverage: "unavailable", reason: "schema" });
  });

  it("refuses a snapshot for another installation or generation", () => {
    const fx = makeInstall();
    fx.writeStats({ installationId: "f".repeat(32), manifest: { installationId: INST } });
    expect(readDbStats(fx.file("dbStatsManifest"), null, ctx(fx)).reason).toBe("snapshot");
  });

  it("refuses more rows than the role cap", () => {
    const fx = makeInstall();
    const roles = ["messages", "memory", "memory-index", "skill-index", "connected-app-ledger", "engine-history", "backup-work", "other"];
    fx.writeStats({ rows: [...roles.map(role => ({ role: role as never })), { role: "extra" as never }] });
    expect(readDbStats(fx.file("dbStatsManifest"), null, ctx(fx)).reason).toBe("rows");
  });

  it("encodes URI-special and Unicode characters so a path can never add URI parameters", () => {
    expect(sealedUri("/tmp/a b/ü?x#y%z&mode=rw", "linux")).toBe("file:/tmp/a%20b/%C3%BC%3Fx%23y%25z%26mode%3Drw?mode=ro&immutable=1");
    expect(sealedUri("C:\\Users\\Ow ner\\health\\db-stats-1.sqlite", "win32")).toBe("file:/C:/Users/Ow%20ner/health/db-stats-1.sqlite?mode=ro&immutable=1");
    expect(() => sealedUri("relative.sqlite", "linux")).toThrow();
  });

  it("opens a sealed file under a path with spaces, Unicode and URI characters", () => {
    const fx = makeInstall(process.platform === "win32" ? "murage sentinel ü#%&=-" : "murage sentinel ü?#%&=-");
    fx.writeStats();
    expect(readDbStats(fx.file("dbStatsManifest"), null, ctx(fx)).reason).toBeNull();
  });

  it("never creates a file when the sealed path does not exist (no live fallback)", () => {
    const fx = makeInstall();
    const missing = join(fx.health, "db-stats-9.sqlite");
    expect(querySealedStats(missing, { installationId: INST, generation: 9 }, quiet())).toEqual({ ok: false, reason: "open" });
    expect(() => readFileSync(missing)).toThrow();
  });
});
