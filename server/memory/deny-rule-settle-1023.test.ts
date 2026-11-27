// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 deny rule, MAIN-RULING 2026-11-26T22:27:29Z D2 (q1023-denyfable, single owner): "the 473 s settle must NEVER block start or an
// owner turn: start opens at once, settle runs in the background in bounded batches, owner turns read the durable deny rows directly".
// Owners: the open = database.ts (no walk); the background walk = memory-revocation.ts paced runner (unchanged 1.0.22 code); the owner
// turn's reads = deny-read.ts (LineageReader.settled); rulings = MAIN.
// REPLACES the settle-at-open witnesses W-S1..W-S5 and W-S4b of q1023-denyrace / q1023-denyfinal (MAIN-RULING 18:44Z B and 20:15Z, both
// superseded by D2): the settle at open, its retry, its owed row, its boot-step beat and its report are deleted, so those rows have
// nothing left to assert. Their fixture is kept.
// Entry point: the store's own open (database.ts database()), on a schema 13 file with unfinished revoke jobs and their pending windows
// (written by commitRevoke and deleteThread with the walk stopped, then stepped back with schema.ts downgradeMemorySchema).
// RED on d2c1083fbc at W-D2's first assertion after the reopen: that build walked every job inside the open.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import * as messages from "../message-db.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { memoryLookup } from "./deny-read.ts";
import { memoryRefKey, type LineageReader, type MemoryRef } from "./lineage-types.ts";
import { drainRevokeMarker, INLINE_REVOCATION, stopMemoryRevocation } from "./memory-revocation.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { downgradeMemorySchema } from "./schema.ts";
import { testThreadNo } from "./testing/writetime-fixture.ts";

/** The owner turn's reader (lineage-types.ts OWNER_TURN_READER, pinned by deny-owner-settled-1023.test.ts W-OT-C), written out so this file
 * loads on a tree without it and the owner-turn rows there fail at their own assertions. */
const OWNER_TURN_READER = { audience: null, settled: true } as LineageReader;
const inline = { ...INLINE_REVOCATION };
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {});
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(() => { stopMemoryRevocation(); Object.assign(INLINE_REVOCATION, inline); vi.restoreAllMocks(); });
const count = (sql: string, ...args: Array<string | number>) => Number(database().prepare(sql).get(...args)!.n);
const version = () => Number(database().prepare("SELECT schema_version AS v FROM memory_meta WHERE id=1").get()!.v);
const UNFINISHED = "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state NOT IN ('done','undone','folded')";
const WINDOWS = "SELECT (SELECT count(*) FROM memory_deny_pending)+(SELECT count(*) FROM memory_deny_pending_scope) AS n";
const QUEUE = "SELECT (SELECT count(*) FROM memory_revoke_frontier)+(SELECT count(*) FROM memory_revoke_reached WHERE revoke_id>0) AS n";
/** Rows of memory_revoke_reached under a reserved (negative) id other than the three the walk itself owns (-3 cover, -5 walker, -7 deletion done). */
const RESERVED = "SELECT count(*) AS n FROM memory_revoke_reached WHERE revoke_id<0 AND revoke_id NOT IN (-3,-5,-7)";

/** Conversation T (an earlier reply, the owner line "root", then `n` replies with one record each) and `threads` other conversations. */
function build(n: number, threads: number): { root: string[]; pre: string[]; other: string[] } {
  reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "private", section: "team-a" }], groups: [] });
  setMemoryMode("active");
  const scope = ensureScope("bot", "bot");
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  let lsn = Number(db.prepare("SELECT next FROM memory_lsn WHERE id=1").get()!.next);
  const message = db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,1,?,'text','',?)");
  const lineage = db.prepare("INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) VALUES(?,?,?,?,NULL,NULL)");
  const source = db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,?,'text','bot','recorded',NULL,'active')");
  const sourceVersion = db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)");
  const capture = db.prepare("INSERT INTO memory_line_capture VALUES(?,?,?)");
  const record = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','a remembered detail','assistant-inference','active',0,1,NULL,NULL,1)");
  const evidence = db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,5)");
  let turn = 0;
  const owner = (thread: string, id: string) => { message.run(thread, id, "user", JSON.stringify({ id, role: "user" })); lineage.run(testThreadNo(db, thread), lsn, id, null); turn = lsn++; };
  const reply = (thread: string, id: string, recordId: string): string[] => {
    message.run(thread, id, "bot", JSON.stringify({ id, role: "bot" }));
    lineage.run(testThreadNo(db, thread), lsn, id, turn);
    const sourceId = `message:${thread}:${id}`;
    source.run(sourceId, scope, thread, id, `h-${sourceId}`); sourceVersion.run(sourceId, `h-${sourceId}`, JSON.stringify({ text: "words" }));
    capture.run(testThreadNo(db, thread), lsn, sourceId);
    record.run(recordId, scope); evidence.run(recordId, sourceId);
    lsn++;
    return [sourceId, recordId];
  };
  owner("T", "o-pre");
  const pre = reply("T", "pre", "rec-pre");
  owner("T", "root");
  const root: string[] = [];
  for (let i = 0; i < n; i++) root.push(...reply("T", `g${i}`, `rec-${i}`));
  const other: string[] = [];
  for (let k = 0; k < threads; k++) { owner(`K${k}`, "k-o"); other.push(...reply(`K${k}`, "k-g", `rec-k${k}`)); }
  db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run(lsn);
  db.exec("COMMIT");
  return { root, pre, other };
}
/** The content verdict of each id (a source "message:..." or a record), through the production lookup. */
function verdicts(ids: string[], reader: LineageReader = { audience: null }): string[] {
  const refs: MemoryRef[] = ids.map(id => ({ kind: id.startsWith("message:") ? "source" as const : "record" as const, id, version: 1 }));
  const got = memoryLookup(database(), refs, reader);
  return refs.map(ref => String(got.get(memoryRefKey(ref))?.state));
}

describe("W-D2 a 1.0.22 store with unfinished revoke jobs: the open migrates it and walks NOTHING; the walk is background work", () => {
  for (const [n, threads] of [[10, 3], [1000, 12]] as const) it(`${n} dependent objects, ${threads + 1} unfinished jobs`, { timeout: 240_000 }, () => {
    const f = build(n, threads);
    // the walk is stopped: each revoke commits its root rows and its pending windows and leaves the rest to the paced runner
    INLINE_REVOCATION.rows = 1; INLINE_REVOCATION.ms = 0; stopMemoryRevocation();
    transaction(tx => commitRevoke(tx, { kind: "line", threadId: "T", messageIds: ["root"], cause: "forget" }));
    for (let k = 0; k < threads; k++) messages.deleteThread(`K${k}`);
    if (version() > 13) downgradeMemorySchema(database(), 13);
    // the fixture is the shape of the real store: schema 13, unfinished jobs, open pending windows, a queued walk
    expect(version()).toBe(13);
    expect(count(UNFINISHED)).toBe(threads + 1);
    const windows = count(WINDOWS), queue = count(QUEUE);
    expect(windows).toBeGreaterThan(threads);
    expect(queue).toBeGreaterThan(0);
    closeDatabase();
    database();
    // the open migrated the file and returned: not one job was walked, not one window closed, nothing queued was consumed
    expect(version()).toBe(14);
    expect(count(UNFINISHED)).toBe(threads + 1);
    expect(count(WINDOWS)).toBe(windows);
    expect(count(QUEUE)).toBe(queue);
    // and the step left no bookkeeping of its own behind (no "settle owed" row)
    expect(count(RESERVED)).toBe(0);
    // the owner's own turn meanwhile reads the durable rows the revokes COMMITTED (the deny rule, read at read): what was revoked is
    // withheld, what was not is shown, with every walk still unfinished
    expect(new Set(verdicts(f.root, OWNER_TURN_READER))).toEqual(new Set(["withheld"]));
    expect(new Set(verdicts(f.other, OWNER_TURN_READER))).toEqual(new Set(["withheld"]));
    expect(verdicts(f.pre, OWNER_TURN_READER)).toEqual(["shown", "shown"]);
    // the background work is the marker's own slices (here run to their end at once; the paced runner runs the same slices in bounded
    // batches): every job ends, every window closes, and every reader gets the same verdicts
    expect(drainRevokeMarker(database()).pending).toBe(false);
    expect(count(UNFINISHED)).toBe(0);
    expect(count(WINDOWS)).toBe(0);
    expect(count(QUEUE)).toBe(0);
    expect(new Set(verdicts(f.root))).toEqual(new Set(["withheld"]));
    expect(new Set(verdicts(f.other))).toEqual(new Set(["withheld"]));
    expect(verdicts(f.pre)).toEqual(["shown", "shown"]);
  });
  it("a store whose jobs had all ended: the open leaves nothing behind either", { timeout: 120_000 }, () => {
    build(10, 1);
    if (version() > 13) downgradeMemorySchema(database(), 13);
    expect(count(UNFINISHED)).toBe(0);
    closeDatabase();
    database();
    expect(version()).toBe(14);
    expect(count(RESERVED)).toBe(0);
    expect(count(UNFINISHED)).toBe(0);
  });
});
