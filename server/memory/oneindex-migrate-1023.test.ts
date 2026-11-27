// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: the 13 -> 14 view-copy drop = q1023-oneindex (recall-view-schema.ts dropRecallViewsAtSchema14); the shared bump 14, its one
// transaction and the deny-rule rows = q1023-denyrule (MAIN 2026-11-26: denyrule owns bump 14, oneindex adds its step to the same migration).
// ONEINDEX migration (designs/ONEINDEX-DESIGN.md "Migration"; ASTRA 7aa6386983 schema.ts:2677): recall reads the one shared index through
// the computed scope set, so the per-view copies leave in the 13 -> 14 transaction, forget work owed or not. The 1.0.22 leftover drop
// (dropLeftoverRecallViews) waits while a walk is owed, and the owner's real copy carries a stuck revoke queue, so its views never left.
// Entry point: the store's own open (database.ts database() -> migrateMemorySchema), on a file stepped back to 13 by the memory-downgrade
// command's function (downgradeMemorySchema) and given what a 1.0.22 build leaves: built views with word copies and an owed revoke walk.
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { stopMemoryRevocation } from "./memory-revocation.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { ensureRecallViewSchema } from "./recall-view-schema.ts";
import { setMemoryMode } from "./repository.ts";
import { downgradeMemorySchema, validateMemorySchema } from "./schema.ts";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {});
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(() => { stopMemoryRevocation(); closeDatabase(); vi.restoreAllMocks(); });

const WORD = "quokkazebrafjord", TERMS = 1500;
/** Every committed page into the main file and an empty WAL, then close: the byte scan reads what the file holds. */
const settleAndClose = () => { database().exec("PRAGMA wal_checkpoint(TRUNCATE)"); closeDatabase(); };
const n = (sql: string) => Number((database().prepare(sql).get() as { n: number }).n);
const version = () => n("SELECT schema_version AS n FROM memory_meta WHERE id=1");
const copies = () => ({
  views: n("SELECT count(*) AS n FROM memory_recall_views"), contexts: n("SELECT count(*) AS n FROM memory_recall_contexts"),
  scopes: n("SELECT count(*) AS n FROM memory_recall_view_scopes"), records: n("SELECT count(*) AS n FROM memory_recall_view_records"),
  terms: n("SELECT count(*) AS n FROM memory_recall_view_terms"), bytes: n("SELECT bytes AS n FROM memory_recall_storage WHERE id=1"),
});

/** What a 1.0.22 build leaves in the file: `views` built views (each with a scope, records and word copies) and an owed revoke walk. */
function leave1022(views: number): void {
  const scope = ensureScope("bot", "bot");
  const db = database();
  ensureRecallViewSchema(db); // what a 1.0.22 open of a schema-13 file does first (schema.ts same-version path)
  db.exec("BEGIN IMMEDIATE");
  for (let v = 0; v < views; v++) {
    db.prepare("INSERT INTO memory_recall_view_scopes VALUES(?,?,?,0,0)").run(`view-${v}`, "g1", scope);
    db.prepare("INSERT INTO memory_recall_contexts VALUES(?,?,?)").run(`ctx-${v}`, `view-${v}`, "g1");
    for (let r = 0; r < 40; r++) db.prepare("INSERT INTO memory_recall_view_records VALUES(?,?,?,1,?,'fact',0,'active',?)").run(`view-${v}`, "g1", `rec-${v}-${r}`, r, scope);
    // enough word copies that their freed pages outnumber the pages the recreated empty tables take back (else reuse hides a residue)
    for (let t = 0; t < TERMS; t++) db.prepare("INSERT INTO memory_recall_view_terms VALUES(?,?,?,?,?,1)").run(`view-${v}`, "g1", `${WORD}${t}`, t, `rec-${v}-${t % 40}`);
    db.prepare("INSERT INTO memory_recall_views VALUES(?,?,1,1,'ready',1,'d',0,0)").run(`view-${v}`, "g1");
  }
  // the owner's copy: 4,474 revoke jobs never finished (MAIN-RULING 2026-11-26T18:44:07Z (B)); one is enough to make a walk owed
  db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(900001,'line','T',1,1,'walk','','active')").run();
  db.exec("COMMIT");
}

describe("W-MIG14-VIEWS: the 13 -> 14 open drops every per-view recall copy in the shared migration, forget work owed or not", () => {
  for (const views of [1, 10]) it(`${views} built view(s) + an owed revoke walk`, { timeout: 120_000 }, () => {
    reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "private", section: "team-a" }], groups: [] });
    setMemoryMode("active");
    expect(version()).toBe(14);
    expect(downgradeMemorySchema(database(), 13).status).toBe("downgraded");
    expect(version()).toBe(13);
    leave1022(views);
    const before = copies();
    expect(before.views).toBe(views);
    expect(before.terms).toBe(TERMS * views);
    settleAndClose();
    // the 1.0.22 file on disk holds the word copies (a fixture check: the scan below can see them)
    expect(readFileSync(join(DATA_DIR, "messages.db")).includes(Buffer.from(WORD))).toBe(true);

    database(); // the store's own open: migrateMemorySchema 13 -> 14 (deny-rule rows + the view-copy drop, one transaction)
    expect(version()).toBe(14);
    expect(copies()).toEqual({ views: 0, contexts: 0, scopes: 0, records: 0, terms: 0, bytes: 0 });
    // the upgrade mark says a drop ran on this file (warm-active-only: a view is built only for a reader that asks)
    expect(n("SELECT skipped AS n FROM transcript_index_state WHERE name='recall_views_1022'")).toBe(1);
    // the store's own secure_delete=ON (database.ts:338) is back after the step
    expect(Number((database().prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete)).toBe(1);
    validateMemorySchema(database());
    settleAndClose();
    // PRIVACY: the owed walk's words cannot be told apart, so no word copy survives in a freed page of the file (secure_delete ON)
    expect(readFileSync(join(DATA_DIR, "messages.db")).includes(Buffer.from(WORD))).toBe(false);
  });
});
