// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.3 Astra pre-audit (memory, High): an inference that ends before usage is reported, while another writer (a VACUUM, an
// index build) holds messages.db, met DATABASE_BUSY in settlement. In a lease that ran inside a detached transport.then(...)
// and became an unhandled rejection (which ends the server); in extraction and grounding it skipped the slot release, so
// learning stayed busy until restart. Settlement now lands later, once the lock is free, and the slots are always released.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { holdWritersForIndexBuild } from "../db-busy.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { extractCandidates, groundMemoryClaim, withMemoryInferenceLease } from "./extract.ts";
import { learningSpendLedgerId, learningSpendMonth } from "../../shared/memory-learning-contract.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
let other: DatabaseSync | null = null;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "thread" }], groups: [] });
  unhandled.length = 0; process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  holdWritersForIndexBuild(false);
  try { other?.exec("ROLLBACK"); } catch { /* not held */ }
  other?.close(); other = null;
});
const signal = () => new AbortController().signal;
/** Another connection takes the writer lock, as a VACUUM or CREATE INDEX does, with the process's writer hold in force. */
function lockMessagesDb() {
  other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  other.exec("BEGIN IMMEDIATE");
  holdWritersForIndexBuild(true);
}
function unlockMessagesDb() {
  other!.exec("ROLLBACK");
  holdWritersForIndexBuild(false);
}
const openReservations = () => {
  const row = database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(learningSpendLedgerId(learningSpendMonth(Date.now())));
  return row ? JSON.parse(String(row.intent)).open ?? {} : {};
};
const tick = () => new Promise(resolve => setTimeout(resolve, 50));

it("a lease transport that fails before usage while the writer lock is held raises no unhandled rejection and settles later", async () => {
  const transport = async () => { lockMessagesDb(); throw new Error("transport-failed-before-usage"); };
  await withMemoryInferenceLease(async lease => {
    await expect(lease.request(transport, "Source", 100, signal(), [{ role: "user", content: "Source text" }])).rejects.toThrow("transport-failed-before-usage");
  });
  await tick();
  expect(unhandled).toEqual([]);
  expect(Object.keys(openReservations()).length).toBe(1);
  unlockMessagesDb();
  await vi.waitFor(() => expect(openReservations()).toEqual({}), { timeout: 5000, interval: 50 });
  // the slot is free for the next cycle
  expect((await withMemoryInferenceLease(async () => "next")).status).toBe("complete");
  expect(unhandled).toEqual([]);
});

it("extraction that fails while the writer lock is held still releases the learning slot", async () => {
  const extractor = async () => { lockMessagesDb(); throw new Error("transport-failed-before-usage"); };
  expect(await extractCandidates("source", extractor, signal())).toMatchObject({ status: "deferred", reason: "extraction-incomplete" });
  unlockMessagesDb();
  expect((await extractCandidates("source", async () => "[]", signal())).status).toBe("complete");
  await vi.waitFor(() => expect(openReservations()).toEqual({}), { timeout: 5000, interval: 50 });
  expect(unhandled).toEqual([]);
});

it("grounding that fails while the writer lock is held still releases the learning slot", async () => {
  const input = { text: "a", quote: "a", claimType: "owner-statement", speaker: "owner", outcome: "recorded" };
  const failing = Object.assign(async () => "[]", { ground: async () => { lockMessagesDb(); throw new Error("transport-failed-before-usage"); } });
  expect(await groundMemoryClaim(input, failing, signal())).toEqual({ supported: false, reason: "grounding-incomplete" });
  unlockMessagesDb();
  const working = Object.assign(async () => "[]", { ground: async () => '{"supported":true}' });
  expect(await groundMemoryClaim(input, working, signal())).toEqual({ supported: true, reason: "source-entailment" });
  await vi.waitFor(() => expect(openReservations()).toEqual({}), { timeout: 5000, interval: 50 });
  expect(unhandled).toEqual([]);
});
