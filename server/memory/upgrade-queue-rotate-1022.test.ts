// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1022-startup item 6 (HIDDEN-COST-fable H14): a background upgrade job whose slice answers "busy", "failed" or "retry later" kept the
// head of the queue, so every job behind it (the integrity pass here; search fill and summaries in the field) never ran. Driven through
// the production queue, startBackgroundUpgradeWork, on a real store with two jobs owed; the head's slice result is fixed by the
// withSource hook the database wires every slice through (only the head's answer is set, the queue under test is the real one).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { beginIntegrityPass, readIntegrityPass } from "./integrity-state.ts";
import { backgroundJobsPending, startBackgroundUpgradeWork, type BackgroundJob } from "./upgrade-background.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeDatabase(); });

/** A store with the message walker and the integrity pass both owed, walker first (backgroundJobsPending's order). */
function twoJobsOwed() {
  const db = database();
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES (?,?,?,?,?,?,?)").run("t", "m", 1, "user", "text", "hi", JSON.stringify({ id: "m", at: 1, role: "user", kind: "text", text: "hi" }));
  db.exec("DELETE FROM transcript_index_state");
  beginIntegrityPass(db);
  const jobs = backgroundJobsPending(db);
  expect(jobs.slice(0, 2), "setup: the walker heads the queue, the integrity pass is behind it").toEqual(["message-index", "integrity"]);
  return db;
}

const STUCK: Array<[string, unknown]> = [
  ["busy", "busy"],
  ["failed", "failed"],
  ["retryMs", { more: true, retryMs: 1, done: 0, total: 1000 }],
];

for (const [name, answer] of STUCK) {
  it(`W-ROTATE-${name}: a head job whose slice answers ${name} on every try hands the head on, and the integrity pass behind it finishes`, async () => {
    const db = twoJobsOwed();
    const ran: BackgroundJob[] = [];
    const handle = startBackgroundUpgradeWork(db, {
      withSource: (run, job) => { if (job === "message-index") return answer as ReturnType<typeof run>; ran.push(job); return run(); },
      pauseMs: 0, busyPauseMs: 1, lockedRetryMs: 1, failureRetryMs: 1,
    });
    try {
      for (let n = 0; n < 200 && readIntegrityPass(db)?.finishedAt == null; n++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(ran.includes("integrity"), `jobs that got a slice behind a ${name} head: ${JSON.stringify([...new Set(ran)])}`).toBe(true);
      expect(readIntegrityPass(db)?.finishedAt ?? null, "the integrity pass queued behind the stuck head reached its end").not.toBeNull();
    } finally { handle.stop(); await handle.done; }
  }, 30_000);
}
