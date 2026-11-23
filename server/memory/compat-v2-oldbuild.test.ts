// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: lane I (W-COMPAT (4), MEMORY-V2-DESIGN 3.5, ASTRA r3 H3). The OLDER BUILD itself, not this checkout's code, opens a file Memory
// V2 ran on: f6ae52c670's own database.ts, schema.ts, recall view, record judge and import (its own modules, its own module state) open
// the V2 file with its marker rows, recall a live record and refuse the forgotten notebook. Extended tier: it needs f6ae52c670's tree
// (MEMV2_COMPAT_OLD_BUILD, or the commit in this clone's git objects; a depth-1 clone has neither), and it FAILS without it, never skips.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { stopSearchIndex } from "../message-search-index.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { runRevocationJobsNow } from "./memory-revocation.ts";
import { migrationV2Progress, resetMigrationV2ForTests, runMigrationSlice } from "./migration-v2.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { captureTurn, FIXTURE_BOT, fixtureRoster, importNotebook, importTopicText } from "./testing/memv2-retention-fixture.ts";

const DAY = 24 * 60 * 60 * 1000, T0 = Date.parse("2026-09-01T00:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(fixtureRoster); database().exec("UPDATE memory_meta SET mode='active'");
  resetMigrationV2ForTests();
});
afterEach(() => { vi.useRealTimers(); resetMigrationV2ForTests(); });

/** The installation offline: workers joined, the log folded. */
async function offline() {
  database().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeDatabase(); resetMigrationV2ForTests();
  await stopSearchIndex(); await stopWalMaintenance();
}

/** The base build lane I branched from (no 1.0.19 tag exists in the hub; f6ae52c670 is the newest build without Memory V2). */
const OLDER_BUILD = "f6ae52c670";
/** Its source tree: MEMV2_COMPAT_OLD_BUILD (an extracted `git archive f6ae52c670 server shared src scripts electron testing package.json`
 * as a .memv2-compat-old* directory inside this checkout, so the same node_modules resolve; the lockfile is byte-identical), else
 * extracted here from git. Never a skip:
 * a run that cannot reach the older build fails. */
let extracted: string | undefined;
function olderBuildTree(): string {
  const given = process.env.MEMV2_COMPAT_OLD_BUILD;
  if (given) {
    // inside this checkout (its node_modules resolve) and named .memv2-compat-old* (the WAL test transform leaves that tree as it shipped)
    const dir = resolve(given);
    if (!dir.startsWith(resolve(".") + "/") || !/\/\.memv2-compat-old[^/]*$/.test(dir)) throw new Error(`W-COMPAT: ${dir} must be a .memv2-compat-old* directory inside this checkout`);
    if (!existsSync(join(dir, "server", "database.ts"))) throw new Error(`W-COMPAT: ${dir} holds no ${OLDER_BUILD} server tree`);
    return dir;
  }
  const dir = resolve(".memv2-compat-old-" + process.pid);
  mkdirSync(dir, { recursive: true }); extracted = dir;
  const tar = execFileSync("git", ["archive", OLDER_BUILD, "server", "shared", "src", "scripts", "electron", "testing", "package.json"], { maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
  return dir;
}
afterAll(() => { if (extracted) rmSync(extracted, { recursive: true, force: true }); });

it("W-COMPAT (4): the f6ae52c670 build opens the V2 file, recalls a live record and refuses the forgotten one", async () => {
  const db = database(), sourceIds = () => db.prepare("SELECT id FROM memory_sources WHERE id LIKE 'legacy:%' ORDER BY id").all().map(row => String(row.id));
  importNotebook(6); const [forgotten] = sourceIds();
  importTopicText("control.md", ["A control note the owner keeps, from a second notebook file."]);
  const control = sourceIds().filter(id => id !== forgotten);
  expect([forgotten !== undefined, control.length]).toEqual([true, 1]);
  for (let i = 0; i < 3; i++) captureTurn(i);
  const records = (sourceId: string) => db.prepare(`SELECT DISTINCT r.id,r.version FROM memory_records r JOIN memory_evidence e
    ON e.record_id=r.id AND e.record_version=r.version WHERE r.state='active' AND e.source_id=? ORDER BY r.rowid`).all(sourceId)
    .map(row => ({ id: String(row.id), version: Number(row.version) }));
  const gone = records(forgotten!), kept = records(control[0]!);
  expect([gone.length > 0, kept.length > 0]).toEqual([true, true]);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: forgotten! }); runRevocationJobsNow(db);
  // V2 runs to the end on this build and leaves its marker rows (retention deleted the settled turns' draft jobs)
  vi.setSystemTime(T0 + 8 * DAY);
  for (let n = 0; runMigrationSlice().more; n++) if (n > 1000) throw new Error("no end");
  expect(migrationV2Progress().M5).toBe("done");
  const markers = Number(db.prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE id LIKE 'memory-v2:%'").get()!.n);
  expect(markers).toBeGreaterThan(0);
  await offline();

  const tree = olderBuildTree(), at = (path: string) => import(pathToFileURL(join(tree, "server", path)).href);
  const old = {
    db: await at("database.ts"), schema: await at("memory/schema.ts"), policy: await at("memory/policy.ts"), view: await at("memory/recall-view.ts"),
    readable: await at("memory/readable.ts"), caps: await at("internal-capabilities.ts"), allowance: await at("memory/lineage-allowance.ts"),
    importer: await at("memory/import.ts"), authority: await at("memory/authority.ts"),
    wal: await at("wal-maintenance.ts"), search: await at("message-search-index.ts"),
  };
  // the older build's own modules, not this checkout's (a different file: its own module state, its own open path)
  expect(old.db.database).not.toBe(database);
  try {
    // the older build's own open path takes the file (it refuses one it does not know: MEMORY_SCHEMA_UNSUPPORTED)
    let oldDb: { prepare(sql: string): { get(...args: unknown[]): Record<string, unknown> } } | undefined;
    expect(() => { oldDb = old.db.database(); }).not.toThrow();
    expect(() => old.schema.validateMemorySchema(oldDb)).not.toThrow();
    expect(Number(oldDb!.prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE id LIKE 'memory-v2:%'").get().n)).toBe(markers);
    const roster = { ...fixtureRoster, memoryRosterRevision: 1 };
    old.policy.reconcileMemoryRoster(roster);
    old.view.prepareRecallContextSync(FIXTURE_BOT, "thread-a", roster); // the older build's recall view over the V2 file
    const judge = (ref: { id: string; version: number }) => {
      const registry = new old.caps.InternalCapabilities(); registry.begin(FIXTURE_BOT, "thread-a", "generation");
      const token = registry.mint({ botId: FIXTURE_BOT, threadId: "thread-a", generation: "generation", depth: 99, kind: "memory", skillAuthoring: false });
      const access = old.policy.memoryAccess(registry, registry.resolve(`Bearer ${token}`), () => roster);
      const out = old.readable.readableMemoryRecord(ref.id, ref.version, access, { allowance: old.allowance.LineageAllowance.tool() });
      return typeof out === "string" ? out : "served";
    };
    // recall: every live record of the control file is served; refusal: every record of the forgotten notebook is refused
    expect([...new Set(kept.map(judge))]).toEqual(["served"]);
    expect(gone.map(judge).filter(out => out === "served")).toEqual([]);
    // and the older build's import of the forgotten notebook is refused (its tombstone survived V2 and retention)
    const ticket = old.authority.ownerMemoryTicket();
    expect(() => old.importer.commitMemoryImport(ticket, old.importer.previewMemoryImport(ticket, [{ kind: "bot", botId: FIXTURE_BOT }], fixtureRoster).previewId, fixtureRoster, true))
      .toThrow(/MEMORY_IMPORT_FOR/);
  } finally {
    old.db.closeDatabase(); await old.search.stopSearchIndex(); await old.wal.stopWalMaintenance();
  }
}, 120_000);
