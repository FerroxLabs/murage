// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, finishBackgroundUpgradeWorkNow } from "../database.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { chainStore } from "./schema.ts";
import { ensureThreadNo } from "./thread-no.ts";
import { lineageBackfillSlice, lineageCertProgress, resetLineageBackfillForTest } from "./lineage-backfill.ts";
import { openBulkRevoke } from "./revoke-commit.ts";
import { enqueueNode, holdRevoke, markerSlice, upgradeMarkerWalked } from "./revoke-marker.ts";
import { backgroundStatus, BACKGROUND_DEFER_PROGRESS_MS, startBackgroundUpgradeWork, type BackgroundHandle } from "./upgrade-background.ts";
import { markUpgraded } from "./testing/legacy-history-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

let running: BackgroundHandle | undefined;
beforeEach(async () => {
  closeDatabase(); await stopWalMaintenance(); resetLineageBackfillForTest();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(() => { running?.stop(); running = undefined; vi.useRealTimers(); });

it("counts every committed member page inside one large message without rounding away the work", () => {
  const db = database(), members = 12_000;
  db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 'src','m'||i,i,'user','text','x','{}' FROM n`).run(members);
  const set = chainStore(db)(null, 0, Array.from({ length: members }, (_, i) => `src\u0000m${i + 1}`));
  db.exec("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('dest','big',20000,'bot','text','x','{}')");
  db.prepare("INSERT INTO memory_output_roots VALUES('dest','big',?)").run(set);
  const top = Number(db.prepare("SELECT max(rowid) AS n FROM messages").get()!.n), off = top + 2;
  // A valid resumed U1 prefix: every source row already has its lineage; only the last message remains.
  const no = ensureThreadNo(db, "src");
  db.prepare(`INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint)
    SELECT ?,rowid-?,id,NULL,NULL,NULL FROM messages WHERE thread_id='src'`).run(no, off);
  db.prepare("UPDATE memory_lineage_cert SET phase='u1',cursor=?,done=100,total=100000,ready=0 WHERE id=1")
    .run(JSON.stringify({ off, top, low: 1, rowid: top - 1 }));
  let last = 100, pages = 0;
  for (let guard = 0; guard < 100; guard++) {
    lineageBackfillSlice(db, { budgetMs: 0, now: () => 0 });
    const current = lineageCertProgress(db);
    expect(current.done).toBeGreaterThanOrEqual(last);
    const cursor = JSON.parse(String(db.prepare("SELECT cursor FROM memory_lineage_cert WHERE id=1").get()!.cursor));
    if (!cursor.line) {
      expect(current.done - last).toBe(members % 256 + 1);
      break;
    }
    expect(current.done - last).toBe(256);
    expect(current.done).toBeLessThan(current.total);
    last = current.done; pages++;
  }
  expect(pages).toBe(Math.floor(members / 256));
});

it("I/O deferral allows one real slice every 15 seconds, while owner activity allows no work and no invented count", async () => {
  const db = database();
  db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 'chat','m'||i,i,'user','text','x','{}' FROM n`).run();
  finishBackgroundUpgradeWorkNow(); markUpgraded(db);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  let ownerBusy = true;
  running = startBackgroundUpgradeWork(db, { sliceMs: 0, now: () => 0, busy: () => ownerBusy, defer: () => true, busyPauseMs: 1000 });
  expect(running.jobs).toEqual(["writetime"]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(running.slices).toBe(0);
  expect(lineageCertProgress(db).done).toBe(0);
  ownerBusy = false;
  let last = 0;
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(BACKGROUND_DEFER_PROGRESS_MS);
    const progress = backgroundStatus(db);
    expect(progress.phase).toBe("writetime");
    expect(progress.done).toBeGreaterThan(last);
    expect(progress.done - last).toBe(1);
    last = progress.done;
  }
  expect(running.slices).toBe(5);
});

it("health observes another runner's committed marker work while upgrade execution is paused, including pruning and rollback", async () => {
  const db = database();
  finishBackgroundUpgradeWorkNow();
  const revoke = openBulkRevoke(db, "upgrade-seed", false);
  db.prepare("UPDATE memory_revoke_jobs SET phase='mark',state='active' WHERE revoke_id=?").run(revoke);
  for (let i = 0; i < 80; i++) enqueueNode(db, revoke, { kind: "scope", scopeId: `absent-${i}` });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  running = startBackgroundUpgradeWork(db, { busy: () => true, defer: () => true });
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  let last = backgroundStatus(db).done;
  try {
    for (let i = 0; i < 8; i++) {
      other.exec("BEGIN IMMEDIATE"); markerSlice(other, 6); other.exec("COMMIT");
      await vi.advanceTimersByTimeAsync(10_000);
      const progress = backgroundStatus(db);
      expect(progress.phase).toBe("marker");
      expect(progress.done).toBeGreaterThan(last);
      expect(progress.done).toBe(upgradeMarkerWalked(other));
      last = progress.done;
    }
    other.exec("BEGIN IMMEDIATE"); markerSlice(other, 6); other.exec("ROLLBACK");
    expect(backgroundStatus(db).done).toBe(last);
    db.exec("BEGIN IMMEDIATE"); markerSlice(db, 6);
    expect(backgroundStatus(db).done).toBe(last);
    db.exec("ROLLBACK");
    expect(backgroundStatus(db).done).toBe(last);
    while (markerSlice(other, 6)) { /* finish the fixture's marker */ }
    const finished = backgroundStatus(db).progress!.phases.find(phase => phase.id === "marker")!;
    expect(finished.state).toBe("done");
    expect(finished.done).toBeGreaterThanOrEqual(last);
    other.exec("DELETE FROM memory_revoke_jobs WHERE state='done'");
    expect(upgradeMarkerWalked(db)).toBe(finished.done);
    expect(running.slices).toBe(0);
  } finally { other.close(); }
  const reopened = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try { expect(upgradeMarkerWalked(reopened)).toBe(upgradeMarkerWalked(db)); } finally { reopened.close(); }
});

it("a held upgrade job adds no completed work while another job runs or every job waits", () => {
  const db = database(), held = openBulkRevoke(db, "upgrade-seed", false);
  db.exec("INSERT INTO memory_scopes VALUES('hold-scope','workspace','fixture','[]',0)");
  db.exec("INSERT INTO memory_scope_bindings VALUES('memory-revocation:wait','hold-scope','system','memory-revocation',0,'granted','{}')");
  holdRevoke(db, held, "wait");
  db.prepare("UPDATE memory_revoke_jobs SET state='active',phase='hold' WHERE revoke_id=?").run(held);
  const other = openBulkRevoke(db, "owner-revoke", false);
  db.prepare("UPDATE memory_revoke_jobs SET state='active',phase='mark' WHERE revoke_id=?").run(other);
  for (let i = 0; i < 20; i++) enqueueNode(db, other, { kind: "scope", scopeId: `absent-${i}` });
  let moved = false;
  for (let i = 0; i < 30; i++) {
    moved = markerSlice(db, 6) === true || moved;
    expect(upgradeMarkerWalked(db)).toBe(0);
  }
  expect(moved).toBe(true);
  expect(markerSlice(db, 6)).toBe(false);
  expect(upgradeMarkerWalked(db)).toBe(0);
});
