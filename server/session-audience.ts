// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sessions keyed on who is listening (SPEC-P 13.1, lane E1).
//
// No owner-only layer may ride a turn whose engine session was made under a
// different audience: a session's retained context (its earlier prompts, the
// owner's notes that rode them) is part of what the engine sees. So every
// engine session, resume cursor and pooled process is keyed on the turn's
// audience fingerprint (owner-audience.ts `audienceFingerprint`), and a turn
// for another audience starts a new session with the transcript replayed.
import { createHash } from "node:crypto";
import { database } from "./database.ts";
import { threadPartition } from "./execution-audience.ts";
import type { BotRecord } from "./store.ts";
import { audienceFingerprint, type TurnAudience } from "./owner-audience.ts";

/** The fingerprint a turn runs under. A turn asked for from a chain that was
 * not the owner's is never the owner's, whatever its own thread says. */
export function turnSessionAudience(threadId: string, audience: TurnAudience, chainNotOwner = false): string {
  const fingerprint = audienceFingerprint(threadId, audience);
  return chainNotOwner && fingerprint === "owner" ? "owner,chain-not-owner" : fingerprint;
}

/** Must this turn leave the session it would resume? A cursor from before
 * the fingerprint was recorded reads as the owner's. */
export function sessionAudienceChanged(recorded: string | undefined, hasCursor: boolean, current: string): boolean {
  if (!hasCursor) return false;
  const previous = recorded ?? "owner";
  if (!previous.includes("|x2:") && /\|x2:0:home:/.test(current)) return previous !== current.split("|x2:")[0];
  return previous !== current;
}

/** Pooled engine processes on room threads (no cursor, one process kept per
 * thread by some drivers): reset when the audience moves. In memory: a
 * restart starts every room turn on a fresh process anyway. */
export class PooledSessionAudiences {
  readonly #last = new Map<string, string>();
  /** Would a turn for this audience have to leave the pooled session? */
  changed(threadId: string, instanceId: string, current: string): boolean {
    const previous = this.#last.get(`${threadId}\n${instanceId}`);
    return previous !== undefined && previous !== current;
  }
  /** The engine accepted a turn for this audience: its pooled session now
   * serves it. Recorded only then, so an attempt that failed before
   * dispatch leaves the reset owed to the next one. */
  accepted(threadId: string, instanceId: string, current: string): void {
    this.#last.set(`${threadId}\n${instanceId}`, current);
  }
  forget(threadId: string): void {
    for (const key of this.#last.keys()) if (key.startsWith(`${threadId}\n`)) this.#last.delete(key);
  }
}

export function partitionSessionAudience(audience: string, bot: BotRecord, threadId: string, folder?: string | null): string {
  const p = threadPartition(bot, threadId);
  // An unpartitioned bot's home is keyed by its label, so minting its team id (GET sharing) never moves its session (C6).
  const label = bot.section?.trim();
  const homeKey = !label ? "general" : bot.partitionedAt === undefined ? label : database().prepare("SELECT team_id FROM team_identities WHERE label=? AND retired_at IS NULL").get(label)?.team_id ?? label;
  const key = p.kind === "home" ? `home:${homeKey}` : p.kind === "team" ? `team:${p.teamId}` : p.kind === "project" ? `project:${p.groupId}:${"homeMember" in p && p.homeMember ? "home" : "part"}` : p.kind === "room" ? `room:${p.groupId}` : p.kind === "isolated" ? `isolated:${p.threadId}` : "general";
  const revision = createHash("sha256").update(folder ?? "").digest("hex").slice(0, 12);
  return `${audience}|x2:${bot.partitionedAt ?? 0}:${key}:${revision}`;
}
