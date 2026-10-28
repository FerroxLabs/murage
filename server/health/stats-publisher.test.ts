// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DB_STATS_TABLES, HEALTH_FILES, HEALTH_LIMITS, dbStatsFileName, parseDbStatsManifest, parseDbStatsRow } from "../../shared/health-protocol.mjs";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { HealthPublisher } from "./publisher.ts";
import { StatsPublisher, observationRows, type StatsBuilder } from "./stats-publisher.ts";

const INSTALL = "c".repeat(32);
const T0 = Date.parse("2026-10-27T10:00:00Z");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
function setup(build?: StatsBuilder) {
  const data = mkdtempSync(join(tmpdir(), "murage-health-stats-"));
  dirs.push(data);
  let now = T0;
  const publisher = new HealthPublisher({ dataDir: data, now: () => now });
  publisher.initialize();
  const stats = new StatsPublisher({ publisher, installationId: INSTALL, now: () => now, ...(build ? { build } : {}) });
  return { data, health: join(data, "health"), publisher, stats, advance: (ms: number) => { now += ms; return now; } };
}
const observation = (at: number) => ({ at, rows: [{ role: "messages" as const, page_size: 4096, page_count: 2_500, freelist_pages: 12, db_bytes: 10_240_000, wal_bytes: 0 }] });

describe("sealed stats generations", () => {
  it("publishes a sealed metadata database with the two fixed tables, no sidecar, and a manifest that matches it", async () => {
    const { health, stats } = setup();
    const manifest = await stats.publishStatsGeneration(observation(T0));
    expect(manifest).not.toBeNull();
    expect(parseDbStatsManifest(manifest).ok).toBe(true);
    const file = join(health, manifest!.file);
    const bytes = readFileSync(file);
    expect(bytes.length).toBe(manifest!.bytes);
    expect(bytes.length).toBeLessThanOrEqual(HEALTH_LIMITS.statsSnapshotBytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest!.sha256);
    expect(readdirSync(health).sort()).toEqual([HEALTH_FILES.dbStatsManifest, manifest!.file].sort());
    expect(JSON.parse(readFileSync(join(health, HEALTH_FILES.dbStatsManifest), "utf8"))).toEqual(manifest);
    // Read-only with fixed SELECTs, as the scanner reads it. Reading writes no sidecar.
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name);
      expect(tables).toEqual(["db_stats", "snapshot"]);
      for (const [table, columns] of Object.entries(DB_STATS_TABLES)) expect(db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(row => row.name)).toEqual([...columns]);
      expect(db.prepare("SELECT * FROM snapshot").all()).toEqual([{ version: 1, installation_id: INSTALL, generation: manifest!.generation, at: T0, coverage: "complete" }]);
      const rows = db.prepare("SELECT * FROM db_stats").all();
      expect(rows).toHaveLength(1);
      expect(parseDbStatsRow({ ...rows[0] }).ok).toBe(true);
      expect(rows[0]).toMatchObject({ role: "messages", page_size: 4096, page_count: 2500, freelist_pages: 12, pending_revocations: null, oldest_pending_at: null });
    } finally { db.close(); }
    expect(readdirSync(health).some(name => /-(journal|wal|shm)$/.test(name))).toBe(false);
  });

  it("keeps current and previous generations only; generations always increase, even within one second", async () => {
    const { health, stats, advance } = setup();
    const first = (await stats.publishStatsGeneration(observation(T0)))!;
    const second = (await stats.publishStatsGeneration(observation(T0)))!;
    expect(second.generation).toBe(first.generation + 1);
    const third = (await stats.publishStatsGeneration(observation(advance(15 * 60_000))))!;
    expect(third.generation).toBe(Math.floor((T0 + 15 * 60_000) / 1000));
    expect(readdirSync(health).filter(name => name.startsWith("db-stats-") && name.endsWith(".sqlite")).sort()).toEqual([dbStatsFileName(second.generation), dbStatsFileName(third.generation)].sort());
  });

  it("a restarted publisher continues above the published generation and never reuses a name", async () => {
    const first = setup();
    const published = (await first.stats.publishStatsGeneration(observation(T0)))!;
    const restarted = new StatsPublisher({ publisher: first.publisher, installationId: INSTALL });
    const next = (await restarted.publishStatsGeneration(observation(T0 - 60_000)))!;
    expect(next.generation).toBe(published.generation + 1);
  });

  it("unknown values stay NULL, never zero; rows beyond eight roles or with bad values are dropped and coverage is partial", () => {
    const { rows, dropped } = observationRows({ at: T0, rows: [
      { role: "messages", page_size: 4096 },
      { role: "messages", page_size: 1 },
      { role: "memory", page_count: -1 },
      ...["memory-index", "skill-index", "connected-app-ledger", "engine-history", "backup-work", "other"].map(role => ({ role: role as "other" })),
      { role: "messages" },
    ] });
    expect(rows[0]).toEqual({ role: "messages", sampled_at: T0, page_size: 4096, page_count: null, freelist_pages: null, db_bytes: null, wal_bytes: null, pending_revocations: null, oldest_pending_at: null });
    expect(rows).toHaveLength(7);
    expect(dropped).toBe(3);
  });

  it("an oversized, sidecar-leaving or failed build publishes nothing and leaves the previous manifest authoritative", async () => {
    let result: Awaited<ReturnType<StatsBuilder>> = { ok: true, sha256: "0".repeat(64), bytes: HEALTH_LIMITS.statsSnapshotBytes + 1, sidecar: false };
    const fake: StatsBuilder = async input => { writeFileSync(input.file, "x"); return result; };
    const { health, stats, publisher } = setup(fake);
    publisher.replaceManifest(HEALTH_FILES.dbStatsManifest, '{"previous":true}');
    expect(await stats.publishStatsGeneration(observation(T0))).toBeNull();
    result = { ok: true, sha256: "0".repeat(64), bytes: 10, sidecar: true };
    expect(await stats.publishStatsGeneration(observation(T0))).toBeNull();
    result = { ok: false, code: "build-failed" };
    expect(await stats.publishStatsGeneration(observation(T0))).toBeNull();
    expect(readdirSync(health)).toEqual([HEALTH_FILES.dbStatsManifest]);
    expect(publisher.readManifest(HEALTH_FILES.dbStatsManifest)).toEqual({ previous: true });
  });

  it("publishes nothing while the root is deferred (a capture began without it)", async () => {
    const data = mkdtempSync(join(tmpdir(), "murage-health-stats-"));
    dirs.push(data);
    const publisher = new HealthPublisher({ dataDir: data, deferWhileCaptureActive: () => true });
    publisher.initialize();
    const stats = new StatsPublisher({ publisher, installationId: INSTALL });
    expect(await stats.publishStatsGeneration(observation(T0))).toBeNull();
    expect(existsSync(join(data, "health"))).toBe(false);
    expect(readdirSync(data)).toEqual([]);
  });
});
