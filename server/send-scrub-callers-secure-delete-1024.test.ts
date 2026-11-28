// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.24 q1024-sweep1 (FABLE q1024-sweep1 ddd0e35edc H4, ASTRA q1023-sqlite-fix 239809febe test-evidence High; owner: q1024-sweep1). Invariant: when an
// unconfirmed send's words leave its row, the rewrite runs at secure_delete ON (server/send-store.ts scrub, :1025). sqlite-secure-delete-owner-text-1023
// drives scrub() itself; these rows drive each production CALLER of it on the real handle, one per way the words leave: a late answer arrives
// (releaseLateAnswer, wired at index.ts:7790), the turn ends and the queue drains (steer-queue.ts drainSteeredMessages -> releaseThreadLate), and
// a restart finishes a row whose line is already in the transcript (boot-recoveries.ts recoverOwnerSends -> completeUnresolved). Each reads
// PRAGMA secure_delete at the write through a TEMP-trigger probe and checks the words are gone.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { recoverOwnerSends } from "./boot-recoveries.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { sendFingerprint } from "./send-idempotency.ts";
import { sendStore } from "./send-store.ts";
import { drainSteeredMessages, type SteerStore } from "./steer-queue.ts";
import { stopSearchIndex } from "./message-search-index.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { probeSecureDelete } from "./testing/secure-delete-probe.ts";

const words = "ZQX-owner-words ".repeat(300);
const mode = () => Number((database().prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete);

beforeEach(async () => {
  closeDatabase(); await stopSearchIndex(); await stopWalMaintenance();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  initializeProjectTables(database());
  sendStore.use(() => database());
});
afterEach(async () => { sendStore.reset(); closeDatabase(); await stopSearchIndex(); await stopWalMaintenance(); });

/** An unconfirmed steer that has its line: the row scrub() rewrites. */
function unconfirmed(threadId: string) {
  const row = sendStore.accept({ kind: "bot", ownerId: "b1", threadId, text: words, status: "sending", fingerprint: sendFingerprint(threadId) }).row;
  database().prepare("UPDATE owner_sends SET status='unconfirmed', message_id='m-u', prompt=? WHERE seq=?").run(words, row.seq);
  return row;
}
const rowOf = (seq: number) => database().prepare("SELECT text AS t, prompt AS p FROM owner_sends WHERE seq=?").get(seq);

it("CALLER a late answer (send-store.ts releaseLateAnswer) removes the words at secure_delete ON", () => {
  const row = unconfirmed("tLate");
  sendStore.holdForLateAnswer(row.seq);
  expect(mode(), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(database(), "owner_sends", { update: "text" });
  try { sendStore.releaseLateAnswer(row.seq); } finally { probe.stop(); }
  expect(rowOf(row.seq), "releaseLateAnswer: the words are gone").toEqual({ t: "", p: null });
  expect(probe.modes.length, "releaseLateAnswer reached the rewrite").toBeGreaterThan(0);
  expect(probe.modes, "releaseLateAnswer: the rewrite ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(mode(), "the connection is back at FAST afterwards").toBe(2);
});

it("CALLER the turn ending (steer-queue.ts drainSteeredMessages -> send-store.ts releaseThreadLate) removes the words at secure_delete ON", () => {
  const late = unconfirmed("tEnd");
  sendStore.holdForLateAnswer(late.seq);
  // a line waiting behind it on the same idle bot: the drain reaches the turn-end release before it looks at the rows
  sendStore.accept({ kind: "bot", ownerId: "b1", threadId: "tEnd", text: "next line", status: "queued", fingerprint: sendFingerprint("tEnd-next") });
  const bot = { id: "b1", threadId: "tEnd", name: "b1", busy: false } as never;
  const store: SteerStore = {
    bot: () => bot,
    appendMessage: (_threadId, message) => ({ id: "m-next", at: 1, ...message }),
    patchMessage: () => null,
  };
  expect(mode(), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(database(), "owner_sends", { update: "text" });
  try { drainSteeredMessages(store, vi.fn()); } finally { probe.stop(); }
  expect(sendStore.hasLateOpen("tEnd"), "the turn end released the late hold").toBe(false);
  expect(rowOf(late.seq), "releaseThreadLate: the words are gone").toEqual({ t: "", p: null });
  expect(probe.modes.length, "releaseThreadLate reached the rewrite").toBeGreaterThan(0);
  expect(probe.modes, "releaseThreadLate: the rewrite ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(mode(), "the connection is back at FAST afterwards").toBe(2);
});

it("CALLER a restart finishing a row whose line landed (boot-recoveries.ts recoverOwnerSends -> send-store.ts completeUnresolved) removes the words at secure_delete ON", () => {
  const row = unconfirmed("tBoot");
  expect(mode(), "the connection's default is FAST").toBe(2);
  const probe = probeSecureDelete(database(), "owner_sends", { update: "text" });
  try {
    recoverOwnerSends({ database: () => database(), live: () => true, threadIsLive: () => true, broadcastSends: () => {}, io: { landed: () => ({ id: "m-u" }), appendReceipt: () => {} } });
  } finally { probe.stop(); }
  expect(rowOf(row.seq), "completeUnresolved: the words are gone").toEqual({ t: "", p: null });
  expect(probe.modes.length, "completeUnresolved reached the rewrite").toBeGreaterThan(0);
  expect(probe.modes, "completeUnresolved: the rewrite ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(mode(), "the connection is back at FAST afterwards").toBe(2);
});

it("CALLER a restart finishing a row whose line never landed (send-store.ts completeUnresolved receipt branch) records the receipt and removes the words at secure_delete ON", () => {
  const row = unconfirmed("tBootReceipt");
  expect(mode(), "the connection's default is FAST").toBe(2);
  const receipts: number[] = [];
  const probe = probeSecureDelete(database(), "owner_sends", { update: "text" });
  try {
    recoverOwnerSends({ database: () => database(), live: () => true, threadIsLive: () => true, broadcastSends: () => {}, io: { landed: () => undefined, appendReceipt: (r) => { receipts.push(r.seq); } } });
  } finally { probe.stop(); }
  expect(receipts, "completeUnresolved wrote the receipt line for the row with no line").toEqual([row.seq]);
  expect(rowOf(row.seq), "completeUnresolved receipt branch: the words are gone").toEqual({ t: "", p: null });
  expect(probe.modes.length, "the receipt branch reached the rewrite").toBeGreaterThan(0);
  expect(probe.modes, "the receipt branch: the rewrite ran at secure_delete ON (1), not FAST (2)").toEqual(probe.modes.map(() => 1));
  expect(mode(), "the connection is back at FAST afterwards").toBe(2);
});
