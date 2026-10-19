// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The hold settle (REPLY-WITHHELD-CONTRACT C4, R4, R5, R11). A delegated reply the result gate read as checking is HELD: the source conversation
// keeps the words as the worker's row flagged "checking" (the owner reads them, bots read the checking line) and the receipt keeps the hold
// (server/delegations.ts `held`). Each hold is judged again here, through the same gate, at the worker's originals (`receipt.copyOf`) for the
// recorded request, worker, source conversation and audience; the held row itself is never on that walk.
//
//   shown     the flag clears, the receipt's hold ends, the request (if any) completes, the delegating bot is told as a reply arrival tells it
//   withheld  the flag becomes true, the receipt's result becomes the withheld line (gone: result_unavailable; refused: the refusal line)
//   checking  it stays held, judged again after the cooldown; past HELD_MAX_AGE_MS it ends as checking (`stale`): the row keeps its flag, no words
//             reach a bot, the request completes, and the owner's note says the check did not finish
//   dropped   the source conversation or the held row is gone: the hold ends with nothing written
//
// The owner keeps the words in every outcome (they are the owner's own data). Each row is judged at most once per cooldown and at most `limit` per
// pass, least recently judged first, so a hold that stays checking never takes a pass ahead of a newer one. A settle writes the row's flag first
// and then the receipt: a crash between them leaves the receipt held, the next pass judges again (the same answer) and tells then.
import { heldReceipts, HELD_MAX_AGE_MS, settleHeldReceipt, type DelegationReceipt } from "./delegations.ts";
import { status, type MurageStatus } from "./murage-status.ts";
import type { ReleasedResult } from "./result-egress.ts";
import type { Store } from "./store.ts";

/** What the settle asks of the server (index.ts installs them with configureHeldReplies; tests pass their own). */
export interface HeldReplyPorts {
  store: Pick<Store, "patchMessage" | "messageById" | "botByThread" | "groupByThread" | "bot">;
  /** The gate at the receipt's originals for its recorded request, worker, source conversation and audience (index.ts: releaseStoredResult). */
  release: (receipt: DelegationReceipt) => ReleasedResult;
  /** A hold settled as shown: the delegating side learns a reply arrived (index.ts: markTaskContextExternallyUpdated / the room's unread mark). */
  delivered: (receipt: DelegationReceipt, messageId: string) => void;
  /** A hold ended: the request it answers (when there is one) completes (index.ts: completeRoomAsk + afterRoomCompletion when receipt.requestId). */
  complete: (receipt: DelegationReceipt, outcome: "shown" | "withheld" | "stale") => void;
  /** A held receipt whose row never reached the conversation (the receipt was written first, R3) and that still carries its owed reply: writes the
   * held row under its stable id now (index.ts: replayOwedReply), so the hold is judged rather than dropped. */
  replay?: (receipt: DelegationReceipt) => { id: string } | null;
}

/** At most this many holds are judged in one pass. */
export const HELD_SETTLE_LIMIT = 256;
/** A hold is judged again no sooner than this after its last judgement. */
export const HELD_JUDGE_COOLDOWN_MS = 30_000;

/** The line a hold that ended as checking leaves on its receipt (the words are not handed to a bot from it). */
const checkingLine = (): MurageStatus => status("checking");

export type HeldSettleCounts = { judged: number; shown: number; withheld: number; checking: number; stale: number; dropped: number };

/** One pass over the held receipts. Never throws: a hold whose judgement fails stays held for the next pass. */
export function settleHeldReplies(ports: HeldReplyPorts, options: { limit?: number; now?: number; cooldownMs?: number } = {}): HeldSettleCounts {
  const limit = options.limit ?? HELD_SETTLE_LIMIT, now = options.now ?? Date.now(), cooldown = options.cooldownMs ?? HELD_JUDGE_COOLDOWN_MS;
  const counts: HeldSettleCounts = { judged: 0, shown: 0, withheld: 0, checking: 0, stale: 0, dropped: 0 };
  for (const receipt of heldReceipts()) {
    if (counts.judged >= limit) break;
    const hold = receipt.held;
    if (!hold) continue;
    if (hold.judgedAt !== undefined && now - hold.judgedAt < cooldown) continue;
    counts.judged++;
    try { settleOne(ports, receipt, hold, now, counts); }
    catch (error) {
      // the hold stays; its judgement is recorded so it waits its turn behind the others
      console.error("held-replies: a held reply could not be judged again; it stays held", error);
      try { settleHeldReceipt(receipt.id, { judgedAt: now }); } catch { /* the receipts file is unwritable: the next pass tries again */ }
    }
  }
  return counts;
}

function settleOne(ports: HeldReplyPorts, receipt: DelegationReceipt, hold: NonNullable<DelegationReceipt["held"]>, now: number, counts: HeldSettleCounts): void {
  const { store } = ports;
  const threadId = receipt.sourceThreadId;
  const conversation = Boolean(store.botByThread(threadId) || store.groupByThread(threadId));
  // the receipt reached disk but its row did not (R3): the owed reply it still carries is written as the held row now, under the stable id
  if (conversation && !store.messageById(threadId, hold.messageId) && receipt.reply && "held" in receipt.reply && ports.replay) {
    if (ports.replay(receipt)) settleHeldReceipt(receipt.id, { reply: null });
  }
  // the source conversation, or the held row in it, is gone: nothing to settle and nowhere to write (S19)
  if (!conversation || !store.messageById(threadId, hold.messageId) || !receipt.copyOf?.messageIds.length) {
    settleHeldReceipt(receipt.id, { held: null });
    counts.dropped++;
    return;
  }
  let released: ReleasedResult;
  try { released = ports.release(receipt); } catch { released = { kind: "checking", line: checkingLine() }; }
  switch (released.kind) {
    case "text": {
      store.patchMessage(threadId, hold.messageId, { withheldFromBots: undefined });
      settleHeldReceipt(receipt.id, { held: null, judgedAt: now });
      counts.shown++;
      // the receipt as it was held: the settle above ended the hold on the receipt itself, and the completion needs the row it named (R5)
      ports.complete({ ...receipt, held: hold }, "shown");
      ports.delivered({ ...receipt, held: hold }, hold.messageId);
      return;
    }
    case "withheld": case "gone": case "refused": {
      // the owner keeps the words; every bot reads the withheld line from the row's own flag
      store.patchMessage(threadId, hold.messageId, { withheldFromBots: true });
      const line: MurageStatus = released.kind === "gone" ? status("result_unavailable") : released.line;
      settleHeldReceipt(receipt.id, { held: null, judgedAt: now, result: line });
      counts.withheld++;
      ports.complete({ ...receipt, held: hold }, "withheld");
      return;
    }
    default: {
      // checking (or a status-only answer, which has no words to show): it stays held until HELD_MAX_AGE_MS, then ends as checking
      if (now - hold.since > HELD_MAX_AGE_MS) {
        settleHeldReceipt(receipt.id, { held: null, judgedAt: now, result: checkingLine() });
        counts.stale++;
        ports.complete({ ...receipt, held: hold }, "stale");
        return;
      }
      settleHeldReceipt(receipt.id, { judgedAt: now });
      counts.checking++;
    }
  }
}

// ---- the process's sweep: kicked by the events that can settle a hold (index.ts), and every HELD_JUDGE_COOLDOWN_MS while any hold exists
let installed: HeldReplyPorts | undefined;
let kickTimer: ReturnType<typeof setTimeout> | null = null;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

/** index.ts installs the ports once; undefined uninstalls them (tests, shutdown) and stops the sweep. */
export function configureHeldReplies(ports: HeldReplyPorts | undefined): void {
  installed = ports;
  if (!ports) {
    if (kickTimer) { clearTimeout(kickTimer); kickTimer = null; }
    if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
  }
}

/** Asks for a pass soon (debounced: many kicks in one tick are one pass). With holds left after it, the next pass runs after the cooldown. */
export function kickHeldReplies(): void {
  if (!installed || kickTimer) return;
  kickTimer = setTimeout(runPass, 0);
  kickTimer.unref?.();
}

function runPass(): void {
  kickTimer = null;
  const ports = installed;
  if (!ports) return;
  try { settleHeldReplies(ports); } catch (error) { console.error("held-replies: the settle pass failed", error); }
  if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
  if (heldReceipts().length) {
    sweepTimer = setTimeout(() => { sweepTimer = null; kickHeldReplies(); }, HELD_JUDGE_COOLDOWN_MS);
    sweepTimer.unref?.();
  }
}
