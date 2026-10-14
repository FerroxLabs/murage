// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// rc4: after the root-set reclaim ran (complete or partial), "Prepare to reinstall Murage 1.0.1" cannot leave a retained provider session resumable.
// The case: a legacy native session with no receipts and an unprovable nonempty root-set id has no row after the reclaim; 1.0.1 reads "no row, no
// receipts" as valid and would resume it with context 1.0.2 withheld. Every retained cursor is cleared, so 1.0.1 starts a fresh session.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

/** Murage 1.0.1 (d950cbf67 server/memory/dispatch.ts retainedSessionInvalid): a session with a session-roots row on the unprovable set (or none provable) is
 * invalid; with NO row and no receipts it is valid and resumes. Reproduced over the file's own tables. */
function v101Resumes(dir: string, thread: string, instance: string, session: string): boolean {
  const bots = JSON.parse(readFileSync(join(dir, "bots.json"), "utf8")) as Array<{ tasks: Array<{ threadId: string; resumeCursors: Record<string, string> }> }>;
  const cursor = bots.flatMap(bot => bot.tasks).find(task => task.threadId === thread)?.resumeCursors?.[instance];
  if (cursor !== session) return false; // no retained cursor: 1.0.1 starts a fresh session
  const db = new DatabaseSync(join(dir, "messages.db"));
  try {
    const root = db.prepare("SELECT set_id FROM memory_session_roots WHERE thread_id=? AND driver_instance=? AND native_session=?").get(thread, instance, session) as { set_id?: string } | undefined;
    if (root && root.set_id === "") return false;
    const receipts = Number((db.prepare("SELECT COUNT(*) AS n FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?").get(thread, instance, session) as { n: number }).n);
    return receipts === 0 ? true : false;
  } finally { db.close(); }
}
function fixture(reclaimMarker: 0 | 1) {
  const dir = DATA_DIR;
  setMemoryMode("capture"); // the real current-version file: every application and memory table
  database().prepare("INSERT OR REPLACE INTO memory_lineage_lsn_meta(key,value) VALUES('root_sets_dropped',?)").run(reclaimMarker);
  closeDatabase();
  writeFileSync(join(dir, "bots.json"), JSON.stringify([{ id: "b1", threadId: "th", resumeCursors: { drv: "sess-1" }, tasks: [{ threadId: "th", resumeCursors: { drv: "sess-1" } }, { threadId: "th2", resumeCursors: {} }] }]));
  return dir;
}

it("after a completed reclaim the downgrade leaves no retained provider session that 1.0.1 would resume", () => {
  const dir = fixture(1);
  // the session row was deleted by the reclaim, and nothing else names the session: 1.0.1 would resume it
  expect(v101Resumes(dir, "th", "drv", "sess-1")).toBe(true);
  downgradeInstallationMemorySchema(dir, 6);
  expect(v101Resumes(dir, "th", "drv", "sess-1")).toBe(false);
  const bots = JSON.parse(readFileSync(join(dir, "bots.json"), "utf8"));
  expect(bots[0].resumeCursors).toEqual({});
  expect(bots[0].tasks.every((task: { resumeCursors: object }) => Object.keys(task.resumeCursors).length === 0)).toBe(true);
});

it("a file the reclaim never touched keeps its retained sessions", () => {
  const dir = fixture(0);
  downgradeInstallationMemorySchema(dir, 6);
  expect(v101Resumes(dir, "th", "drv", "sess-1")).toBe(true);
});
