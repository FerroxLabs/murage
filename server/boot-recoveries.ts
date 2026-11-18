// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Boot recoveries that swallow their own failures, as importable modules (boot tolerance, ACCEPTANCE.md D5). Each swallowing catch calls `bootCaught`, so a
// low-disk failure it caught turns the start read-only and names the step instead of passing as a log line. server/index.ts calls these inside `bootStep`.
import type { DatabaseSync } from "node:sqlite";
import { withBusyBudget } from "./database.ts";
import { bootCaught } from "./read-only-start.ts";
import { scrubOwnerSendsOfGoneThreads } from "./room-requests.ts";
import { sendStore, type RecoveryIo } from "./send-store.ts";
import { recoverAndSettleVenuePosts, type VenuePostHeldRow } from "./venue-post-held.ts";

export interface OwnerSendsRecovery {
  database: () => DatabaseSync;
  /** Whether the conversation and its owner still exist. */
  live: (threadId: string, ownerId: string, kind: "bot" | "group") => boolean;
  threadIsLive: (threadId: string) => boolean;
  broadcastSends: (threadId: string) => void;
  io: RecoveryIo;
}

/** Startup (every start): purge what the owner deleted, then finish the sends the last run left half done. See server/index.ts for the contract. */
export function recoverOwnerSends(deps: OwnerSendsRecovery): void {
  try {
    // The send store opens its own transactions (write-tx.ts), which carry no floor check: admit the step first, so a worker-published refusal is typed.
    const gone = withBusyBudget(1000, "boot-sends", () => { const touched = sendStore.purgeOrphans(deps.live); scrubOwnerSendsOfGoneThreads(deps.database(), deps.threadIsLive); return touched; });
    for (const threadId of gone) deps.broadcastSends(threadId);
  } catch (error) { bootCaught("sends.purge", error); console.error("orphan send purge failed", error); }
  try {
    const { unresolved } = withBusyBudget(1000, "boot-sends", () => sendStore.recover());
    sendStore.completeUnresolved(unresolved, deps.io);
    void sendStore.pruneResolved().catch((error) => console.error("send ledger prune failed", error));
  } catch (error) {
    bootCaught("sends.recover", error);
    console.error("send recovery failed", error);
  }
}

/** Startup: a venue post cut short between its claim and its write; its card is settled in the same transaction (recoverAndSettleVenuePosts). */
export function recoverVenuePostsAtBoot(
  db: DatabaseSync, transaction: <T>(work: (inner: DatabaseSync) => T) => T,
  lineExists: (targetThreadId: string, stableId: string) => boolean, settleCard: (row: VenuePostHeldRow) => void,
): void {
  try { recoverAndSettleVenuePosts(db, transaction, lineExists, settleCard); }
  catch (error) { bootCaught("venue.recoverPosts", error); console.warn("[venue-post] boot recovery:", error instanceof Error ? error.message : String(error)); }
}
