// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 THREAD-REVOKE-DRAIN r3, kept item: a conversation deletion commits ONE thread revoke. captureThreadDeletion commits it (in
// deleteThread's transaction); deleteThread used to commit a second, identical one, so every deletion's mark walk ran twice (Sean's
// store: 13 stuck thread jobs, 6 consecutive-id pairs plus 1). Every deletion entry point goes through Store.deleteThreadRecord or the
// boot reconcile, both into message-db deleteThread: each must commit exactly one, never zero, and leave no content of the conversation.

import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { ConversationDeletions } from "../conversation-deletion.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import * as messages from "../message-db.ts";
import { Store } from "../store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { INLINE_REVOCATION, runRevocationJobsNow, stopMemoryRevocation } from "./memory-revocation.ts";
import { setMemoryMode } from "./repository.ts";

const SECRET = "vault code 6614";
const inline = { ...INLINE_REVOCATION };
const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {});
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("capture");
});
afterEach(() => { stopMemoryRevocation(); Object.assign(INLINE_REVOCATION, inline); vi.restoreAllMocks(); });

/** No bookkeeping step inside the commit, no runner: the jobs stay as committed until a test drains them. */
const stopJobs = () => { INLINE_REVOCATION.rows = 1; INLINE_REVOCATION.ms = 0; stopMemoryRevocation(); };
const drain = () => transaction(db => runRevocationJobsNow(db));
const threadJobs = (threadId: string) => database().prepare("SELECT revoke_id,state FROM memory_revoke_jobs WHERE kind='thread' AND json_extract(root,'$.threadId')=? ORDER BY revoke_id").all(threadId) as Array<{ revoke_id: number; state: string }>;
const allThreadJobs = () => Number(database().prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE kind='thread'").get()!.n);
const payloads = (threadId: string) => (database().prepare("SELECT v.payload FROM memory_source_versions v JOIN memory_sources s ON s.id=v.source_id WHERE s.thread_id=?").all(threadId) as Array<{ payload: string }>).map(row => String(row.payload ?? ""));
const message = (id: string, text: string) => ({ id, text, parentId: null, at: 1, role: "user" as const, kind: "text" as const });

/** Right after a deletion: exactly one thread revoke committed for the conversation (never zero, never the base's two). */
function oneRevoke(threadId: string): number {
  const jobs = threadJobs(threadId);
  expect(jobs).toHaveLength(1);
  return jobs[0]!.revoke_id;
}
/** After the drain: the revoke finished (a done job row may be pruned by a later commit) and nothing of the conversation is shown or kept. */
function drainedAndGone(...threadIds: string[]) {
  drain();
  for (const threadId of threadIds) {
    expect(threadJobs(threadId).filter(job => job.state !== "done")).toEqual([]);
    expect(Number(database().prepare("SELECT count(*) AS n FROM messages WHERE thread_id=?").get(threadId)!.n)).toBe(0);
    expect(database().prepare("SELECT 1 AS x FROM memory_deny WHERE kind='thread' AND id=?").get(threadId)).toBeTruthy();
    expect(payloads(threadId).join("")).not.toContain(SECRET);
    expect(messages.searchMessages("6614").filter(hit => hit.threadId === threadId)).toEqual([]);
  }
}
const gone = (threadId: string) => { oneRevoke(threadId); drainedAndGone(threadId); };

describe("one conversation deletion commits exactly one thread revoke", () => {
  it("deleteThread: one memory_revoke_jobs row for the conversation (base committed two)", () => {
    stopJobs();
    messages.appendMessage("gone", message("m1", `my ${SECRET}`));
    messages.appendMessage("kept", message("m2", "another conversation"));
    expect(payloads("gone").join("")).toContain(SECRET); // captured, so the deletion has something to revoke
    const before = allThreadJobs();
    messages.deleteThread("gone");
    expect(allThreadJobs() - before).toBe(1);
    expect(threadJobs("gone").map(job => job.state)).toEqual(["active"]);
    gone("gone");
    expect(payloads("kept").join("")).toContain("another conversation");
  });

  it("a conversation nothing was captured from still commits its one revoke (never zero)", () => {
    stopJobs();
    setMemoryMode("off");
    messages.appendMessage("quiet", message("m1", `uncaptured ${SECRET}`));
    messages.deleteThread("quiet");
    gone("quiet");
  });
});

describe("every deletion entry point: one revoke, no content left", () => {
  it("a bot's task (UI and API delete, bulk delete loops it)", () => {
    stopJobs();
    const store = new Store(selection);
    const bot = store.createBot({ name: "Iris" });
    const task = store.createTask(bot.id, "Second", false)!;
    store.appendMessage(task.threadId, { role: "user", kind: "text", text: `my ${SECRET}` });
    expect(store.deleteTask(bot.id, task.threadId)).toBeTruthy();
    gone(task.threadId);
  });

  it("a room conversation", () => {
    stopJobs();
    const store = new Store(selection);
    const a = store.createBot({ name: "Ada" }), b = store.createBot({ name: "Bo" });
    const room = store.createGroup("Room", [a.id, b.id], false, "Room");
    const task = store.createGroupTask(room.id, "Side", false)!;
    store.appendMessage(task.threadId, { role: "user", kind: "text", text: `room ${SECRET}` });
    expect(store.deleteGroupTask(room.id, task.threadId)).toBeTruthy();
    gone(task.threadId);
  });

  it("a whole room (and import rollback, which calls it)", () => {
    stopJobs();
    const store = new Store(selection);
    const a = store.createBot({ name: "Cy" });
    const room = store.createGroup("Doomed", [a.id], false, "Doomed");
    store.appendMessage(room.threadId, { role: "user", kind: "text", text: `room ${SECRET}` });
    expect(store.deleteGroup(room.id)).toBe(true);
    gone(room.threadId);
  });

  it("a whole bot (and import rollback, which calls it): one revoke per conversation beside the bot's own", () => {
    stopJobs();
    const store = new Store(selection);
    const bot = store.createBot({ name: "Dee" });
    const task = store.createTask(bot.id, "Second", false)!;
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `first ${SECRET}` });
    store.appendMessage(task.threadId, { role: "user", kind: "text", text: `second ${SECRET}` });
    expect(store.deleteBot(bot.id)).toBe(true);
    oneRevoke(bot.threadId); oneRevoke(task.threadId);
    drainedAndGone(bot.threadId, task.threadId);
  });
});

describe("restart mid-deletion still resumes", () => {
  it("a revoke committed before a restart finishes after it, and the deletion is not committed twice", () => {
    stopJobs();
    messages.appendMessage("gone", message("m1", `my ${SECRET}`));
    messages.deleteThread("gone");
    expect(threadJobs("gone").map(job => job.state)).toEqual(["active"]);
    // the process dies with the job open
    closeDatabase();
    stopJobs();
    expect(threadJobs("gone").map(job => job.state)).toEqual(["active"]);
    gone("gone");
  });

  it("a delete the crash cut before its rows went is finished by the boot reconcile with one revoke", async () => {
    stopJobs();
    messages.appendMessage("gone", message("m1", `my ${SECRET}`));
    // the crash: the deletion record is written, the rows are not
    new ConversationDeletions({ dataDir: DATA_DIR, database }).begin({ threadIds: ["gone"] });
    expect(threadJobs("gone")).toEqual([]);
    closeDatabase();
    const restarted = new ConversationDeletions({ dataDir: DATA_DIR, database });
    expect(await restarted.reconcile(() => false, messages.deleteThread)).toBe(1);
    expect(restarted.pending()).toEqual([]);
    gone("gone");
  });
});
