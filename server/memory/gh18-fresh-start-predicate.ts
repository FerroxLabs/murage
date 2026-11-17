// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ownerAudienceSessions, sessionSlot, type RepairBot } from "./keepall-unwedge.ts";

export interface FreshStartSessionRow {
  readonly thread_id: string;
  readonly driver_instance: string;
  readonly native_session: string;
  readonly revoke_id: number;
}
export interface FreshStartPredicateDeps {
  readonly audienceRevokeIds: ReadonlySet<number>;
  ownerDirectThread(id: string): boolean;
  readonly liveThreads: ReadonlySet<string>;
}
/**
 * P1 (gh18-fresh-start-v2), over an authenticated selected bot and an immutable
 * snapshot. The caller supplies ONLY memory_deny_session rows (no version
 * dimension) and the revoke IDs actually present in memory_revoke_audience.
 * This function reads no database, writes nothing and does not authorize confirm.
 * S1/S2 must still enforce pending-deletion/readiness/bounds and recheck under
 * the bot admission gate and writer transaction before any deletion.
 *
 * Proof that deleting selected rows gives no reader additional information:
 * 1. Content sessionLookup already excludes audience-only revokes (deny-read.ts).
 * 2. Non-owner turns resume their own audience sessions, never an owner-audience
 *    cursor. ownerAudienceSessions reuses ownerSessionAudience and sessionKeyOf,
 *    including historical owner defaults, partition suffixes and incarnations.
 * 3. Restricting that exact key to this bot's idle owner-direct tasks excludes
 *    other bots, rooms, member audiences, instances and incarnations. Content
 *    marks and every other table are outside P1, regardless of root provenance.
 * No reason/cause heuristic or owner confirmation can expand this predicate.
 */
export function isFreshStartSessionRow(row: FreshStartSessionRow, bot: RepairBot, deps: FreshStartPredicateDeps): boolean {
  if (!deps.audienceRevokeIds.has(row.revoke_id) || deps.liveThreads.has(row.thread_id)) return false;
  const tasks = bot.tasks?.filter(task => task.threadId === row.thread_id) ?? [];
  // Fail closed if duplicate task entries disagree about whether this thread is live.
  if (tasks.length === 0 || tasks.some(task => task.busy)) return false;
  const sessions = ownerAudienceSessions([{ id: bot.id, tasks }], deps.ownerDirectThread);
  return sessions.get(row.thread_id)?.has(sessionSlot(row.driver_instance, row.native_session)) ?? false;
}
