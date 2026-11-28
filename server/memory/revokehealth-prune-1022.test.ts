// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1022-revokehealth-opus (revoke-marker.ts pruneBotMarks, the deleted bot's tidy). Consumer owners: the readers of
// memory_deny_memory (deny-read.ts, readable.ts, import.ts KEEPABLE_CHUNK) and the forget tombstones (import, forget).
// 1.0.22 MUST-FIX item 7 (HIDDEN-COST-fable M27): a deleted bot's walk left one deny mark per record and source of its notebooks for good
// (about 230k rows a bot). Once its job is done they are gone where the notebook's permanent deny covers the whole target; a record id that
// spans into a live notebook keeps its mark, the tombstones stay, and every deleted item still reads withheld.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { captureBotDeletion } from "./capture.ts";
import { advanceRevocationJob, INLINE_REVOCATION, runRevocationJobsNow, stopMemoryRevocation } from "./memory-revocation.ts";
import { memoryLookup } from "./deny-read.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

beforeEach(async () => {
  closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
});
const inlineMs = INLINE_REVOCATION.ms;
afterEach(() => { INLINE_REVOCATION.ms = inlineMs; stopMemoryRevocation(); });

// Two sites prune (SITES.md): the scope job once it has tombstoned every record (memory-revocation.ts scopeStep, the small revoke that the
// commit finished inline before any tombstone existed), and the revoke's own tidy (revoke-marker.ts advance, a walk the runner finishes after
// the scope job: the third row runs the scope job to its end first, its binding then gone as its completion leaves it, then the runner walks).
it.each([["scope job after an inline walk", 8, false], ["runner, no inline walk", 0, false], ["revoke tidy after the scope job ended", 0, true]] as const)("W-BOT-MARKS-PRUNED (%s) a deleted bot's finished job leaves no deny mark its notebooks' deny covers; a spanning record keeps its mark", (_site, ms, scopeFirst) => {
  INLINE_REVOCATION.ms = ms;
  const roster: MemoryRoster = { bots: ["a", "gone"].map(id => ({ id, threadId: `t-${id}`, section: "team" })), groups: [] };
  reconcileMemoryRoster(roster);
  const db = database(), f = new WritetimeFixture(db).cert(true), gone = ensureScope("bot", "gone"), live = ensureScope("bot", "a");
  for (let i = 1; i <= 40; i++) f.source(`s${i}`, gone).record(`r${i}`, 1, gone, [`s${i}`]);
  f.record("moved", 1, gone).record("moved", 2, live);
  transaction(tx => captureBotDeletion(tx, "gone"));
  if (scopeFirst) transaction(tx => {
    const row = tx.prepare("SELECT id,intent FROM memory_scope_bindings WHERE id LIKE 'memory-revocation:%'").get()!;
    expect(advanceRevocationJob(tx, JSON.parse(String(row.intent)), Number.MAX_SAFE_INTEGER), "fixture: the scope job ran to its end").toBe(true);
    expect(tx.prepare("SELECT state FROM memory_revoke_jobs WHERE kind='bot'").get()!.state, "fixture: the revoke is still walking").not.toBe("done");
    tx.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run(row.id);
  });
  for (let i = 0; i < 50 && db.prepare("SELECT 1 FROM memory_revoke_jobs WHERE state IN ('active','undoing') UNION ALL SELECT 1 FROM memory_scope_bindings WHERE id LIKE 'memory-revocation:%' LIMIT 1").get(); i++) runRevocationJobsNow(db);
  const job = db.prepare("SELECT revoke_id,state FROM memory_revoke_jobs WHERE kind='bot'").get();
  const marks = (where: string) => Number(db.prepare(`SELECT count(*) AS n FROM memory_deny_memory WHERE ${where}`).get()!.n);
  console.log(`PROBE job=${JSON.stringify(job)} marks=${marks("1")} moved=${marks("id='moved'")} tombs=${Number(db.prepare("SELECT count(*) AS n FROM memory_tombstones WHERE target_type='record'").get()!.n)}`);
  // base 68ed0def17: the job is done and every one of its 80 marks (40 records, 40 sources) stays
  expect(marks("id IN (SELECT id FROM memory_records WHERE id LIKE 'r%' UNION SELECT id FROM memory_sources)"), "marks left on the deleted notebook's own records and sources").toBe(0);
  expect(marks("kind='record' AND id='moved'")).toBeGreaterThan(0);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_tombstones WHERE target_type='record' AND target_id LIKE 'r%'").get()!.n)).toBe(40);
  const verdicts = memoryLookup(db, [{ kind: "record", id: "r1", version: 1 }, { kind: "source", id: "s1", version: 1 }, { kind: "record", id: "moved", version: 2 }], CONTENT);
  expect([...verdicts.values()].map(v => v.state)).toEqual(["withheld", "withheld", "withheld"]);
});
