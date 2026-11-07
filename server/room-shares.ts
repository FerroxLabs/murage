// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CROSS-CHAT-READ-1019 r3 (section 7 with 8a): in a room only the owner and bots can reach, a bot asks the owner to share lines from its own
// chats or its other rooms. A deterministic server-side picker (no model, adapter, tool dispatcher, embedding or external call) freezes the
// excerpts into a `room_shares` row the bot never reads; the owner sees them on a card served only to an owner session, and Share writes
// them into the room as ONE owner line (copyOf + refs), so a forget of a source line withholds the copy from every bot (lineage).
import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WORKSPACE_OWNER } from "./human-principals.ts";
import { denyLookup } from "./memory/deny-read.ts";
import type { LineageRef } from "./memory/lineage-types.ts";
import { scanTextLinesNewest } from "./message-db.ts";
import { roomPeople } from "./room-people.ts";
import { venueAccess } from "./venue-read.ts";
import { SHARE_CARD_COPY } from "../shared/room-share-copy.ts";
import type { BotRecord, GroupRecord, Message, MessageOrigin } from "./store.ts";

/** The fixed tool result (2.3): no excerpt text, thread title, room name or error detail. */
export const SHARE_ASKED_LINE = "I asked the owner to share what I found. If they share it, it will appear in this room.";
export const SHARE_NOTHING_LINE = "I found nothing to ask the owner to share.";
export const SHARE_UNAVAILABLE = "Asking the owner to share is not available in this room.";
export const SHARE_DECLINED_NOTE = "The owner kept that private.";
/** The room row: Murage's own words and the bot's name only (the bot's query is shown on the owner's card, never as room text). */
export const shareAskRowText = (botName: string) => `${botName} asked you to share something from its chats.`;
export { SHARE_CARD_COPY, sharedFromNote } from "../shared/room-share-copy.ts";

// 8a.2 bounds
export const SHARE_PAGES = 6, SHARE_PAGE_ROWS = 25, SHARE_PREVIEW_BYTES = 32 * 1024, SHARE_REFS = 25, SHARE_RELEASE_BYTES = 8 * 1024;
export const SHARE_DRAFTS = 4, SHARE_TTL_MS = 10 * 60_000, SHARE_EXCERPT_CHARS = 600, SHARE_QUERY_CHARS = 200;

export type ShareStatus = "pending" | "sharing" | "shared" | "declined" | "unavailable";
export type Excerpt = { threadId: string; messageId: string; textHash: string; text: string };
export type RoomShare = {
  id: string; botId: string; roomId: string; roomThreadId: string; originThreadId: string; query: string; excerpts: Excerpt[]; excerptsHash: string; nonce: string;
  status: ShareStatus; stableId: string; createdAt: number; expiresAt: number;
};
type Roster = { bots: BotRecord[]; groups: GroupRecord[] };

export { initializeRoomShares } from "./room-shares-schema.ts";

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const rowOf = (row: Record<string, unknown> | undefined): RoomShare | null => row ? {
  id: String(row.id), botId: String(row.bot_id), roomId: String(row.room_id), roomThreadId: String(row.room_thread_id), originThreadId: String(row.origin_thread_id), query: String(row.query),
  excerpts: JSON.parse(String(row.excerpts)) as Excerpt[], excerptsHash: String(row.excerpts_hash), nonce: String(row.nonce),
  status: String(row.status) as ShareStatus, stableId: String(row.stable_id), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
} : null;
export function roomShare(db: DatabaseSync, id: string): RoomShare | null {
  return rowOf(db.prepare("SELECT * FROM room_shares WHERE id=?").get(id) as Record<string, unknown> | undefined);
}
const excerptsHashOf = (excerpts: readonly Excerpt[]) => sha(JSON.stringify(excerpts.map(e => [e.threadId, e.messageId, e.textHash, e.text])));

/** The room a room-member turn runs in: the room's main thread, one of its tasks, or the bot's own desk task of a channel project. */
export function shareRoomOf(roster: Roster, bot: BotRecord, threadId: string): GroupRecord | null {
  for (const group of roster.groups) {
    if (!group.memberIds.includes(bot.id)) continue;
    if (group.threadId === threadId || (group.tasks ?? []).some(task => task.threadId === threadId)) return group;
  }
  const desk = (bot.tasks ?? []).find(task => task.threadId === threadId && task.channelProjectDesk);
  if (!desk?.channelProjectDesk || desk.channelProjectDesk.archivedAt !== undefined) return null;
  const deskRoom = desk.channelProjectDesk.groupId;
  return roster.groups.find(group => group.id === deskRoom && group.memberIds.includes(bot.id)) ?? null;
}

const memoryOff = (db: DatabaseSync): Set<string> => new Set(db.prepare(
  "SELECT e.value FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings'").all().map(row => String(row.value)));

/** 2.1: mounted on a member's room turn only when no person but the owner can reach the room (`unknown` fails closed), the room is not
 * archived, not a pair room and not memory-off. Read at the mount and again at every call and at Share. */
export function shareMounts(db: DatabaseSync, roster: Roster, botId: string, threadId: string): GroupRecord | null {
  try {
    const bot = roster.bots.find(entry => entry.id === botId);
    if (!bot || bot.draftOnly === true) return null;
    const group = shareRoomOf(roster, bot, threadId);
    if (!group || group.dm || group.hidden || !group.memberIds.includes(bot.id)) return null;
    const off = memoryOff(db);
    if (off.has(threadId) || off.has(group.threadId)) return null;
    if (roomPeople(db, group, group.threadId, roster).length) return null;
    if (threadId !== group.threadId && roomPeople(db, group, threadId, roster).length) return null;
    return group;
  } catch { return null; }
}

/** A line's verdict for the owner reader now (`shown` only; a forget, a tombstone or the owner's flag revoke). */
function shownForOwner(db: DatabaseSync, threadId: string, message: Pick<Message, "id" | "role" | "withheldFromBots">): boolean {
  const verdict = denyLookup(db, { threadId, lines: [{ messageId: message.id, author: message.role === "user" ? "owner" : "generated",
    ...(message.withheldFromBots ? { withheldFromBots: true } : {}) }] }, { audience: { owner: true, scopeIds: [] } }).get(message.id);
  return verdict?.state === "shown";
}

/** The bot's direct source threads (its 1:1 and own non-desk, non-shared tasks; the recallThreads rules: no foreign, memory-off or
 * channel-person thread), or its OTHER rooms by the venue reader rules R4-R10, never the current room. */
export function shareSources(db: DatabaseSync, roster: Roster, bot: BotRecord, room: GroupRecord, from: "my-chats" | "my-rooms" | "both"): string[] {
  const out: string[] = [];
  if (from !== "my-rooms") {
    const foreign = new Set([...roster.bots.filter(other => other.id !== bot.id).flatMap(other => [other.threadId, ...(other.tasks ?? []).map(task => task.threadId)]),
      ...roster.groups.flatMap(group => [group.threadId, ...(group.tasks ?? []).map(task => task.threadId)])]);
    const off = memoryOff(db);
    const bound = new Set<string>();
    for (const row of db.prepare("SELECT subject_id, json_extract(intent,'$.personId') AS person FROM memory_scope_bindings WHERE subject_type='human-thread'").all())
      if (row.person !== WORKSPACE_OWNER) bound.add(String(row.subject_id));
    // the active task may be bot.threadId: every candidate passes the same task-type rule (no desk, no shared work)
    const special = new Set((bot.tasks ?? []).filter(task => task.channelProjectDesk || task.sharedWork).map(task => task.threadId));
    const own = [bot.threadId, ...(bot.tasks ?? []).map(task => task.threadId)];
    for (const thread of own) if (!special.has(thread) && !foreign.has(thread) && !off.has(thread) && !bound.has(thread)) out.push(thread);
  }
  if (from !== "my-chats") {
    for (const group of roster.groups) {
      if (group.id === room.id || !group.memberIds.includes(bot.id)) continue;
      try { const access = venueAccess(db, roster, bot, bot.threadId, group.id, undefined); if (access) out.push(access.target); } catch { /* not a source */ }
    }
  }
  return [...new Set(out)].filter(thread => thread !== room.threadId && !(room.tasks ?? []).some(task => task.threadId === thread));
}

const terms = (query: string) => [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 2))].slice(0, 12);

/** 8a.2: ONE source thread per release. Each source is scanned at most SHARE_PAGES pages of SHARE_PAGE_ROWS text lines, newest first;
 * the thread with the most `shown` matches wins; its excerpts fit SHARE_REFS refs, SHARE_PREVIEW_BYTES of preview. */
export function pickExcerpts(db: DatabaseSync, sources: readonly string[], query: string): Excerpt[] {
  const words = terms(query);
  if (!words.length) return [];
  let best: Excerpt[] = [];
  for (const threadId of sources) {
    const found: Excerpt[] = [];
    let seen = 0, bytes = 0;
    scanTextLinesNewest(threadId, message => {
      if (++seen > SHARE_PAGES * SHARE_PAGE_ROWS) return true;
      if (message.kind !== "text" || typeof message.text !== "string" || !message.text.trim() || message.copyOf || message.sharedFrom) return false;
      const lower = message.text.toLowerCase();
      if (!words.every(word => lower.includes(word))) return false;
      if (!shownForOwner(db, threadId, message)) return false;
      const text = message.text.slice(0, SHARE_EXCERPT_CHARS);
      const size = Buffer.byteLength(text, "utf8");
      if (bytes + size > SHARE_PREVIEW_BYTES) return true;
      bytes += size;
      found.push({ threadId, messageId: message.id, textHash: sha(message.text), text });
      return found.length >= SHARE_REFS;
    });
    if (found.length > best.length) best = found;
  }
  return best.reverse();
}

/** Expired drafts are discarded (8a.2); a restart discards every live draft and settles an interrupted Share (3.2 boot recovery). */
export function expireRoomShares(db: DatabaseSync, now = Date.now()): void {
  db.prepare("UPDATE room_shares SET status='unavailable', excerpts='[]' WHERE status='pending' AND expires_at<=?").run(now);
}
export function recoverRoomShares(db: DatabaseSync, hasLine: (roomThreadId: string, stableId: string) => boolean): void {
  for (const row of db.prepare("SELECT * FROM room_shares WHERE status='sharing'").all() as Record<string, unknown>[]) {
    const share = rowOf(row)!;
    if (hasLine(share.roomThreadId, share.stableId)) db.prepare("UPDATE room_shares SET status='shared', excerpts='[]' WHERE id=?").run(share.id);
    else db.prepare("UPDATE room_shares SET status='pending' WHERE id=?").run(share.id);
  }
  db.prepare("UPDATE room_shares SET status='unavailable', excerpts='[]' WHERE status='pending'").run();
}

export type AskResult = { ok: true; share: RoomShare | null; toolText: string } | { ok: false; error: string };
/** The bot's call (2.2/2.3), or the owner's composer entry (8a.1, `byOwner`): mount re-checked, draft cap, picker, frozen row. */
export function askOwnerToShare(db: DatabaseSync, roster: Roster, input: { botId: string; threadId: string; query: unknown; from: unknown }, now = Date.now()): AskResult {
  const room = shareMounts(db, roster, input.botId, input.threadId);
  if (!room) return { ok: false, error: SHARE_UNAVAILABLE };
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query || query.length > SHARE_QUERY_CHARS) return { ok: false, error: "Give what you are looking for in 1 to 200 characters." };
  const from = input.from === "my-chats" || input.from === "my-rooms" || input.from === "both" ? input.from : "both";
  expireRoomShares(db, now);
  const live = Number((db.prepare("SELECT COUNT(*) AS n FROM room_shares WHERE status='pending'").get() as { n: number }).n);
  if (live >= SHARE_DRAFTS) return { ok: false, error: "The owner already has several share requests open. Try again after they answer." };
  const bot = roster.bots.find(entry => entry.id === input.botId)!;
  // the bot learns nothing from the search: a row and the same fixed line whether or not anything matched (the owner's card says so)
  const excerpts = pickExcerpts(db, shareSources(db, roster, bot, room, from), query);
  const id = `rshare-${randomUUID()}`;
  const share: RoomShare = { id, botId: bot.id, roomId: room.id, roomThreadId: room.threadId, originThreadId: input.threadId, query, excerpts, excerptsHash: excerptsHashOf(excerpts),
    nonce: randomBytes(18).toString("base64url"), status: "pending", stableId: `rshare-line-${id.slice(7)}`, createdAt: now, expiresAt: now + SHARE_TTL_MS };
  db.prepare("INSERT INTO room_shares(id,bot_id,room_id,room_thread_id,origin_thread_id,query,excerpts,excerpts_hash,nonce,status,stable_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(share.id, share.botId, share.roomId, share.roomThreadId, share.originThreadId, share.query, JSON.stringify(share.excerpts), share.excerptsHash, share.nonce, share.status,
      share.stableId, share.createdAt, share.expiresAt);
  return { ok: true, share, toolText: SHARE_ASKED_LINE };
}

/** 8a.3: the release proof binds the draft nonce, the room thread, the bot, the source ids and versions and the exact displayed bytes. */
export function shareDigest(share: Pick<RoomShare, "nonce" | "roomThreadId" | "botId" | "excerpts">): string {
  return sha(JSON.stringify([share.nonce, share.roomThreadId, share.botId, share.excerpts.map(e => [e.threadId, e.messageId, e.textHash, e.text])]));
}
/** The card body, for an owner session only (the route checks isOwnerOrigin). */
export function shareCard(share: RoomShare, botName: string, sourceName: (threadId: string) => string) {
  return { id: share.id, botId: share.botId, botName, roomId: share.roomId, query: share.query, status: share.status, expiresAt: share.expiresAt,
    copy: SHARE_CARD_COPY, nonce: share.nonce, digest: shareDigest(share),
    excerpts: share.excerpts.map(e => ({ messageId: e.messageId, source: sourceName(e.threadId), text: e.text })) };
}

export type ShareDeps = {
  /** The live source line (null: gone). */
  message(threadId: string, messageId: string): Message | null;
  /** store.appendMessage(threadId, line, stableId, within, undefined, lineage) */
  append(threadId: string, line: Omit<Message, "id" | "at">, stableId: string, within: () => void, lineage: readonly LineageRef[]): Message;
};
export type ShareOutcome = { ok: true; status: "shared" | "unavailable"; line?: Message } | { ok: false; status: number; error: string };

/** 3.2 + 8a.3/8a.4: the owner's Share. `origin` must be an owner desktop/companion session (the route proves it). The kept ids must be a
 * subset of the frozen row; every kept excerpt is revalidated synchronously against the live line (still there, same text, `shown`). */
export function shareRoomExcerpts(db: DatabaseSync, roster: Roster, deps: ShareDeps, input: { id: string; origin: MessageOrigin; nonce: unknown; digest: unknown; keep: unknown },
  run: <T>(operation: () => T) => T, now = Date.now()): ShareOutcome {
  if (input.origin !== "desktop" && input.origin !== "companion") return { ok: false, status: 403, error: "Only you can share this, from Murage on your computer or phone." };
  expireRoomShares(db, now);
  const share = roomShare(db, input.id);
  if (!share || share.status !== "pending") return { ok: false, status: 409, error: "This share request is no longer open." };
  const digest = shareDigest(share);
  if (typeof input.nonce !== "string" || typeof input.digest !== "string" || input.digest.length !== digest.length
    || input.nonce !== share.nonce || !timingSafeEqual(Buffer.from(input.digest), Buffer.from(digest))) return { ok: false, status: 409, error: "This preview changed. Open it again to share." };
  if (!Array.isArray(input.keep) || !input.keep.length || input.keep.some(id => typeof id !== "string")) return { ok: false, status: 400, error: "Pick at least one excerpt." };
  const frozen = new Map(share.excerpts.map(e => [e.messageId, e]));
  if ((input.keep as string[]).some(id => !frozen.has(id))) return { ok: false, status: 400, error: "Only the excerpts on the card can be shared." };
  const keep = new Set(input.keep as string[]);
  return run(() => {
    // claim pending→sharing (a second answer finds it claimed and leaves)
    if (db.prepare("UPDATE room_shares SET status='sharing' WHERE id=? AND status='pending' AND nonce=?").run(share.id, share.nonce).changes !== 1)
      return { ok: false, status: 409, error: "This share request is no longer open." } as ShareOutcome;
    const unavailable = (): ShareOutcome => { db.prepare("UPDATE room_shares SET status='unavailable', excerpts='[]' WHERE id=?").run(share.id); return { ok: true, status: "unavailable" }; };
    // revalidate after the last await, synchronously: membership, room open, owner-only, each kept excerpt still shown and unchanged
    const room = shareMounts(db, roster, share.botId, share.roomThreadId);
    if (room?.id !== share.roomId || shareMounts(db, roster, share.botId, share.originThreadId)?.id !== share.roomId) return unavailable();
    const bot = roster.bots.find(entry => entry.id === share.botId);
    // every source is still one this bot may draw from now (membership, memory-off, person-bound, task type, venue rules)
    const eligible = new Set(bot ? shareSources(db, roster, bot, room, "both") : []);
    const kept = share.excerpts.filter(e => keep.has(e.messageId) && eligible.has(e.threadId)).filter(e => {
      const line = deps.message(e.threadId, e.messageId);
      return !!line && typeof line.text === "string" && sha(line.text) === e.textHash && shownForOwner(db, e.threadId, line);
    });
    if (!kept.length) return unavailable();
    const text = kept.map(e => e.text.split("\n").map(row => `> ${row}`).join("\n")).join("\n\n");
    // an exhausted budget withholds, never truncates (8a.5): the owner unticks to fit
    if (kept.reduce((sum, e) => sum + Buffer.byteLength(e.text, "utf8"), 0) > SHARE_RELEASE_BYTES) {
      db.prepare("UPDATE room_shares SET status='pending' WHERE id=?").run(share.id);
      return { ok: false, status: 413, error: "That is more than one share can carry. Untick some excerpts." } as ShareOutcome;
    }
    if (new Set(kept.map(e => e.threadId)).size !== 1) return unavailable();
    const source = kept[0]!.threadId;
    const line: Omit<Message, "id" | "at"> = { role: "user", kind: "text", text, origin: input.origin,
      copyOf: { threadId: source, messageIds: kept.map(e => e.messageId) }, sharedFrom: { botId: share.botId, shareId: share.id } };
    const refs: LineageRef[] = [{ kind: "prefix", threadId: source, shown: kept.map(e => e.messageId) }];
    const written = deps.append(share.roomThreadId, line, share.stableId, () => {
      db.prepare("UPDATE room_shares SET status='shared', excerpts='[]' WHERE id=?").run(share.id);
    }, refs);
    return { ok: true, status: "shared", line: written } as ShareOutcome;
  });
}

/** 3.3: Don't share. Returns true when the row moved (the caller writes the room note once). */
export function declineRoomShare(db: DatabaseSync, id: string, origin: MessageOrigin): boolean {
  if (origin !== "desktop" && origin !== "companion") return false;
  return db.prepare("UPDATE room_shares SET status='declined', excerpts='[]' WHERE id=? AND status='pending'").run(id).changes === 1;
}
/** Stop/delete of the bot or the room. */
export function dropRoomShares(db: DatabaseSync, match: { botId?: string; roomId?: string }): void {
  if (match.botId) db.prepare("UPDATE room_shares SET status='unavailable', excerpts='[]' WHERE bot_id=? AND status='pending'").run(match.botId);
  if (match.roomId) db.prepare("UPDATE room_shares SET status='unavailable', excerpts='[]' WHERE room_id=? AND status='pending'").run(match.roomId);
}
