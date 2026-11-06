// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// VENUE-POST-1017 r3 cut-down: a bot posts into a project or channel it belongs to, when the owner picked that room with Post in… in the
// bot's own chat. The only thing that mounts venue_post is the structured `postTo` the owner's own app wrote on the owner's own proven line
// (store.ts dropUnprovenPostTo); no text the bot read and no text the owner typed is parsed for intent. Every call is decided from the
// generation's record and current state (Q1 to Q5); the write carries the 1:1's lineage as the post's provenance (Q7), so a forget in the
// 1:1 reaches the post through the existing marker and the door withholds it from every bot audience.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isWorkspaceOwner, threadHumanPrincipal } from "./human-principals.ts";
import { denyLookup, refsLookup } from "./memory/deny-read.ts";
import { heldVenuePost, moveVenuePost, type VenuePostHeldRow, type VenuePostState } from "./venue-post-held.ts";
export * from "./venue-post-held.ts";
import type { LineageRef } from "./memory/lineage-types.ts";
import { runningTurnFor } from "./memory/lineage-write.ts";
import { turnAudienceIsOwner } from "./owner-audience.ts";
import { roomPeople } from "./room-people.ts";
import { venueAccess, venueReadMounts } from "./venue-read.ts";
import type { BotRecord, GroupRecord, Message } from "./store.ts";

/** P1: the turn may not post (no record, wrong audience). */
export const VENUE_POST_UNAVAILABLE = "Posting in projects or channels is not available in this turn.";
/** P2: the venue is not postable from here (one line for every reason). */
export const VENUE_POST_NOT_AVAILABLE = "That project or channel is not available for posting from here.";
/** P3: the call does not match the owner's pick, or the request line changed or was forgotten. */
export const VENUE_POST_NOT_PICKED = "Post only where the owner picked with Post in…. Tell the owner, in this chat, to use Post in… and pick the project or channel.";
/** Q2: posts per turn. */
export const VENUE_POST_ATTEMPTS = 3;
/** Section 6: the picker list is the owner's (the Murage app or the paired phone). */
export const VENUE_POST_PICKER_OWNER_ONLY = "Post in… is picked in the Murage app or on your paired phone.";
export const VENUE_POST_TEXT_MAX = 4000;
/** The room note and the bots' context line (section 7). */
export const VENUE_POST_NOTE = (botName: string) => `Sent from your chat with ${botName}`;
export const VENUE_POST_NOTE_GONE = "Sent from a chat you have since deleted";
export const VENUE_POST_CONTEXT = "(posted from its own chat with the owner)";
/** Q6 until the held card lands: Ask and Auto never post. */
export const VENUE_POST_NEEDS_FULL = "Posting in a project or channel from this chat needs Full access for now. Tell the owner, in this chat, what you would post.";
/** The activity line in the 1:1 after a post. */
export const venuePostedLine = (venueName: string | undefined) => `Posted in ${venueName?.trim() || "the project or channel"}.`;

import { venuePostTurns, type VenuePostRecord } from "./venue-post-turns.ts";
export { forgetAllVenuePostTurns, forgetVenuePostTurn, recordVenuePostTurn, venuePostTurns, type VenuePostRecord } from "./venue-post-turns.ts";

export const textHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The live index state read at the call, handed in once at boot (index.ts), the same facts venue_read reads. */
export type VenuePostLive = {
  ownerSurface(threadId: string): boolean | undefined;
  notOwnerAudience(threadId: string): boolean;
  roster(): { bots: BotRecord[]; groups: GroupRecord[] };
  /** The stored request line, by id, in the bot's direct thread (null: gone). */
  message(threadId: string, messageId: string): Message | null;
};
let live: VenuePostLive | null = null;
export function setVenuePostLive(next: VenuePostLive | null): void { live = next; }

type MountInput = Parameters<typeof venueReadMounts>[0] & { botId: string; message?: Pick<Message, "id" | "role" | "kind" | "text" | "postTo" | "origin">; draftOnly?: boolean };

/** The mount (section 1): listed only when the line this turn was dispatched for carries `postTo` and the r2 13.1 direct-turn predicate
 * holds (the same predicate venue_read mounts on, plus not draft-only). Returns the record to keep for the generation, or null. */
export function venuePostMounts(input: MountInput): Omit<VenuePostRecord, "attempts"> | null {
  const message = input.message;
  if (!message?.postTo || message.role !== "user" || message.kind !== "text" || input.draftOnly === true) return null;
  if (message.origin !== input.origin) return null;
  if (!venueReadMounts(input)) return null;
  return {
    botId: input.botId, threadId: input.threadId, origin: input.origin,
    ...(input.chainRootThreadId ? { rootThreadId: input.chainRootThreadId } : {}),
    request: { messageId: message.id, textHash: textHash(message.text ?? ""), postTo: { ...message.postTo } },
  };
}

type Refusal = { ok: false; status: number; body: { error: string } };
export type VenuePostVerdict = { ok: true; record: VenuePostRecord; group: GroupRecord; target: string; text: string } | Refusal;
const refuse = (status: number, error: string): Refusal => ({ ok: false, status, body: { error } });
const P1 = () => refuse(403, VENUE_POST_UNAVAILABLE);
const P2 = () => refuse(403, VENUE_POST_NOT_AVAILABLE);
const P3 = () => refuse(403, VENUE_POST_NOT_PICKED);
const BODY_KEYS = new Set(["venueId", "venueThreadId", "text"]);

/** Q5a: the request line still exists, hashes to the record, and the bot reader's verdict on it is `shown` now (an edit, a forget, a
 * tombstone or the owner's flag each revoke). Read at the mount, at the call, and when a held card is answered. */
export function requestStillShown(db: DatabaseSync, record: Pick<VenuePostRecord, "threadId" | "request">, message: Message | null): boolean {
  if (!message || message.id !== record.request.messageId || message.role !== "user") return false;
  if (textHash(message.text ?? "") !== record.request.textHash) return false;
  const verdict = denyLookup(db, { threadId: record.threadId, lines: [{ messageId: message.id, author: "owner", ...(message.withheldFromBots ? { withheldFromBots: true } : {}) }] },
    { audience: { owner: true, scopeIds: [] } }).get(message.id);
  return verdict?.state === "shown";
}

/** Q4: venueAccess (shared with the reader) plus roomPeople empty on BOTH the room thread and the target thread. */
export function venuePostable(db: DatabaseSync, roster: { bots: BotRecord[]; groups: GroupRecord[] }, bot: BotRecord, threadId: string,
  venueId: unknown, venueThreadId: unknown): { group: GroupRecord; target: string } | null {
  const access = venueAccess(db, roster, bot, threadId, venueId, venueThreadId);
  if (!access) return null;
  if (roomPeople(db, access.group, access.group.threadId, roster).length) return null;
  if (access.target !== access.group.threadId && roomPeople(db, access.group, access.target, roster).length) return null;
  return { group: access.group, target: access.target };
}

/** The picker's list (presentation; the server re-checks every call): the venues the bot could post into now. */
export function postableVenues(db: DatabaseSync, roster: { bots: BotRecord[]; groups: GroupRecord[] }, bot: BotRecord, threadId: string): Array<{ venueId: string; name: string }> {
  const out: Array<{ venueId: string; name: string }> = [];
  for (const group of roster.groups) {
    if (!group.memberIds.includes(bot.id)) continue;
    try { if (venuePostable(db, roster, bot, threadId, group.id, undefined)) out.push({ venueId: group.id, name: group.name }); } catch { /* not listed */ }
  }
  return out;
}

/** Q1 to Q5, from the record and current state at the call. `claim` is the live capability; `body` has the identity fields stripped. */
export function authorizeVenuePost(db: DatabaseSync, claim: { botId: string; threadId: string; generation: string }, body: Record<string, unknown>): VenuePostVerdict {
  try {
    if (!live) return P1();
    // Q1: the generation's record, written only from a proven owner line that carried postTo
    const record = venuePostTurns.get(claim.generation);
    if (!record || record.botId !== claim.botId || record.threadId !== claim.threadId) return P1();
    // Q2: every attempt counts, before anything else is read
    record.attempts++;
    if (record.attempts > VENUE_POST_ATTEMPTS) return P1();
    const { botId, threadId } = record;
    // Q3: the audience now
    if (record.origin !== "desktop" && record.origin !== "companion") return P1();
    if (live.ownerSurface(threadId) !== true || live.notOwnerAudience(threadId)) return P1();
    if (!turnAudienceIsOwner(threadId, { origin: record.origin, ...(record.rootThreadId ? { rootThreadId: record.rootThreadId } : {}) }, db)) return P1();
    if (!isWorkspaceOwner(threadHumanPrincipal(threadId, db))) return P1();
    const roster = live.roster();
    const bot = roster.bots.find(entry => entry.id === botId);
    if (!bot || bot.draftOnly === true) return P1();
    if (Object.keys(body).some(key => !BODY_KEYS.has(key))) return P2();
    const text = body.text;
    if (typeof text !== "string" || !text.trim() || text.length > VENUE_POST_TEXT_MAX) return refuse(400, "Give the post's words as text, 1 to 4,000 characters.");
    // Q5a: the request line, unchanged and shown
    if (!requestStillShown(db, record, live.message(threadId, record.request.messageId))) return P3();
    // Q5b: equality with the owner's pick, nothing else
    const picked = record.request.postTo;
    if (body.venueId !== picked.venueId) return P3();
    if ((body.venueThreadId ?? undefined) !== (picked.venueThreadId ?? undefined)) return P3();
    // Q4: postable now
    const postable = venuePostable(db, roster, bot, threadId, picked.venueId, picked.venueThreadId);
    if (!postable) return P2();
    return { ok: true, record, group: postable.group, target: postable.target, text };
  } catch {
    return P1();
  }
}

/** Q7: the post's lineage. The prefix of the 1:1 at its head now with the shown request line, then the parents of the bot's running turn
 * in the 1:1. No turnId, no provider turn: the post is never a turn of the venue. */
export function venuePostLineage(threadId: string, botId: string, headLsn: number | undefined, shown: readonly string[]): LineageRef[] {
  const running = runningTurnFor(threadId, botId);
  return [{ kind: "prefix", threadId, ...(headLsn !== undefined ? { headLsn } : {}), shown: [...shown] }, ...(running?.parents ?? [])];
}

export type HeldAnswerHost = {
  transaction<T>(operation: (db: DatabaseSync) => T): T;
  roster(): { bots: BotRecord[]; groups: GroupRecord[] };
  message(threadId: string, messageId: string): Message | null;
  lineExists(threadId: string, stableId: string): boolean;
  /** store.appendMessage(target, row, stableId, within, undefined, lineage); `within` runs inside the append's transaction. */
  append(target: string, row: Omit<Message, "id" | "at">, stableId: string, within: () => void, lineage: LineageRef[]): Message;
};
export type HeldAnswer = { state: VenuePostState; row: VenuePostHeldRow; group?: GroupRecord; messageId?: string };

/** The owner's answer on a held card (step 4). "Post it" is ONE transaction: claim held -> posting, re-check from the row (bot, draft-only,
 * owner thread, Q5 incl. the shown verdict now, Q4 + roomPeople now, the post's lineage refs), append with the stableId, and the terminal
 * state inside the append's transaction. A failed re-check ends `unavailable`; a throw rolls the claim back to `held`. "Don't post" ends
 * `declined`. A second answer returns the row's final state. */
export function answerHeldVenuePost(host: HeldAnswerHost, id: string, choice: "post" | "skip"): HeldAnswer | null {
  return host.transaction((db) => {
    const row = heldVenuePost(db, id);
    if (!row) return null;
    if (row.state !== "held") return { state: row.state, row };
    if (choice === "skip") { moveVenuePost(db, id, "held", "declined"); return { state: "declined", row: { ...row, state: "declined" } }; }
    if (!moveVenuePost(db, id, "held", "posting")) return { state: heldVenuePost(db, id)?.state ?? "unavailable", row };
    const unavailable = (): HeldAnswer => { moveVenuePost(db, id, "posting", "unavailable"); return { state: "unavailable", row: { ...row, state: "unavailable" } }; };
    const roster = host.roster();
    const bot = roster.bots.find(entry => entry.id === row.botId);
    if (!bot || bot.draftOnly === true) return unavailable();
    if (!isWorkspaceOwner(threadHumanPrincipal(row.threadId, db))) return unavailable();
    const record = { threadId: row.threadId, request: { messageId: row.requestMessageId, textHash: row.requestHash, postTo: { venueId: row.venueId } } };
    if (!requestStillShown(db, record, host.message(row.threadId, row.requestMessageId))) return unavailable();
    const postable = venuePostable(db, roster, bot, row.threadId, row.venueId, row.venueThreadId);
    if (!postable || postable.target !== row.targetThreadId) return unavailable();
    let lineage: LineageRef[];
    try { lineage = JSON.parse(row.lineage) as LineageRef[]; } catch { return unavailable(); }
    if (refsLookup(db, lineage, { audience: { owner: true, scopeIds: [] } }).state !== "shown") return unavailable();
    if (host.lineExists(row.targetThreadId, row.stableId)) { moveVenuePost(db, id, "posting", "posted"); return { state: "posted", row: { ...row, state: "posted" }, group: postable.group, messageId: row.stableId }; }
    const line = host.append(row.targetThreadId, venuePostRow(bot, row.threadId, row.text), row.stableId, () => { moveVenuePost(db, id, "posting", "posted"); }, lineage);
    return { state: "posted", row: { ...row, state: "posted" }, group: postable.group, messageId: line.id };
  });
}

/** The posted row (written by the caller with store.appendMessage(target, row, stableId, within, undefined, lineage)). */
export function venuePostRow(bot: Pick<BotRecord, "id" | "name" | "color">, threadId: string, text: string): Omit<Message, "id" | "at"> {
  return { role: "bot", kind: "text", text, from: { botId: bot.id, name: bot.name, color: bot.color }, postedFrom: { botId: bot.id, threadId } };
}
