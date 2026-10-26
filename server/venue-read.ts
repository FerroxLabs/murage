// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot venue awareness, part 2 (BOT-VENUE-AWARENESS-106 4.2 and 4.3): venue_read_messages lets a bot, on a plain owner direct turn, read
// recent lines of a project or channel it is a member of. The listing is presentation; what decides every call is the generation-bound
// record below, written only by a plain owner direct turn with a proven origin (index.ts runTurn), and rules R1 to R10 read from current
// state at the call. Every refusal is a 403 with one fixed line and no lines, R10 budget refusals included (design 4.3 R10 amended); a
// malformed limit or cursor on an authorised venue is 400 with a neutral line (design 4.4); any throw is L1.
import type { DatabaseSync } from "node:sqlite";
import { isWorkspaceOwner, threadHumanPrincipal, WORKSPACE_OWNER } from "./human-principals.ts";
import { executionStore, sameThreadPartition, threadPartition } from "./execution-audience.ts";
import { turnAudienceIsOwner } from "./owner-audience.ts";
import { projectSettingsFor } from "./project-records.ts";
import { projectThreads, venueToolHandlers, type NamedRoster, type VenuePageOptions } from "./project-memory-tools.ts";
import { turnRequestByGeneration } from "./project-tool-routing.ts";
import { projectTableExists } from "./project-turn-engine.ts";
import type { BotRecord, GroupRecord } from "./store.ts";

/** L1: the turn may not read other conversations (audience, origin, record). */
export const VENUE_READ_UNAVAILABLE = "Reading other conversations is not available in this turn.";
/** L2: the venue or thread is not readable from here; one line for every reason, so it never confirms a venue exists. */
export const VENUE_NOT_AVAILABLE = "That conversation is not available from here.";
/** L3: the turn's read budget is spent. */
export const VENUE_READ_LIMIT = "This turn has read as much as it can from other conversations; answer with what you have.";
/** R10: reads per turn, and lines handed to one turn. */
export const VENUE_READ_ATTEMPTS = 6;
export const VENUE_READ_LINES = 150;

import { venueReadTurns, type VenueReadOrigin as Origin, type VenueReadRecord } from "./venue-read-turns.ts";
export { forgetAllVenueReadTurns, forgetVenueReadTurn, recordVenueReadTurn, venueReadTurns, type VenueReadRecord } from "./venue-read-turns.ts";

/** The live index state the rules read at the call, handed in once at boot (index.ts). */
export type VenueReadLive = {
  /** ownerSurfacesByThread.get(threadId) */
  ownerSurface(threadId: string): boolean | undefined;
  /** internalTurnOwners.get(threadId)?.notOwnerAudience === true */
  notOwnerAudience(threadId: string): boolean;
  /** store.bots and store.groups now */
  roster(): { bots: BotRecord[]; groups: GroupRecord[] };
};
let live: VenueReadLive | null = null;
export function setVenueReadLive(next: VenueReadLive | null): void { live = next; }

/** The mount predicate (4.2): the tool is listed, and the record written, only on a plain owner direct turn with a proven origin. */
export function venueReadMounts(input: {
  surfacesForOwner: boolean; directOwnerAudience: boolean; origin?: string; notOwnerAudience?: boolean; chainNotOwner?: boolean;
  chainRootThreadId?: string; rootOwnerSurface?: boolean; automationSource?: unknown; projectCardRun?: unknown; sharedWorkRun?: unknown;
  automationThread: boolean; bot: { threadId: string; tasks?: ReadonlyArray<{ threadId: string; channelProjectDesk?: unknown; sharedWork?: unknown }> };
  threadId: string; agentsMcp: boolean;
}): input is typeof input & { origin: Origin } {
  return input.surfacesForOwner && input.directOwnerAudience
    && (input.origin === "desktop" || input.origin === "companion")
    && input.notOwnerAudience !== true && !input.chainNotOwner
    && (!input.chainRootThreadId || input.rootOwnerSurface === true)
    && input.automationSource === undefined && !input.projectCardRun && !input.sharedWorkRun
    && !input.automationThread && ownDirectThread(input.bot, input.threadId) && input.agentsMcp === true;
}

/** The bot's main chat or one of its own tasks that is neither a project desk nor shared work. */
function ownDirectThread(bot: { threadId: string; tasks?: ReadonlyArray<{ threadId: string; channelProjectDesk?: unknown; sharedWork?: unknown }> }, threadId: string): boolean {
  return threadId === bot.threadId || (bot.tasks ?? []).some(task => task.threadId === threadId && !task.channelProjectDesk && !task.sharedWork);
}

/** A project is a channel group with a project_settings row that has not ended; anything else (an ended project, no row, no table) is a
 * channel (R5, R9). */
function isOpenProject(db: DatabaseSync, group: { id: string; channelProject?: unknown }): boolean {
  if (!group.channelProject) return false;
  if (!projectTableExists(db, "project_settings")) return false;
  const settings = projectSettingsFor(db, group.id);
  return Boolean(settings && settings.endedAt === null);
}

/** R5: the threads of a venue that may be read: a project's room, room tasks and member desks; a channel's room and room tasks. */
export function venueThreads(db: DatabaseSync, roster: NamedRoster, venueId: string): Set<string> {
  const group = roster.groups.find(entry => entry.id === venueId);
  if (!group) return new Set();
  if (isOpenProject(db, group)) return projectThreads(roster, venueId);
  return new Set([group.threadId, ...(group.tasks ?? []).map(task => task.threadId)]);
}

type Refusal = { ok: false; status: number; body: { error: string } };
export type VenueReadVerdict = { ok: true; record: VenueReadRecord; venueId: string; input: { threadId: string; before?: unknown; limit?: unknown }; options: VenuePageOptions } | Refusal;
const refuse = (status: number, error: string): Refusal => ({ ok: false, status, body: { error } });
const L1 = () => refuse(403, VENUE_READ_UNAVAILABLE);
const L2 = () => refuse(403, VENUE_NOT_AVAILABLE);
const BODY_KEYS = new Set(["venueId", "venueThreadId", "before", "limit"]);

/** R1 to R10 (4.3), read from current state at the call. `claim` is the live capability (the 401s of the internal boundary already ran);
 * `body` has the identity fields stripped. */
export function authorizeVenueRead(db: DatabaseSync, claim: { botId: string; threadId: string; generation: string }, body: Record<string, unknown>): VenueReadVerdict {
  try {
    if (!live) return L1();
    // R1: an affirmative record for this generation, written by a plain owner direct turn; a card run or room turn has a bound request
    const record = venueReadTurns.get(claim.generation);
    if (!record || record.botId !== claim.botId || record.threadId !== claim.threadId || turnRequestByGeneration.has(claim.generation)) return L1();
    // R10, first half: every attempt counts, before any read
    record.attempts++;
    if (record.attempts > VENUE_READ_ATTEMPTS) return refuse(403, VENUE_READ_LIMIT);
    const { botId, threadId } = record;
    // R2: the audience now
    if (record.origin !== "desktop" && record.origin !== "companion") return L1();
    if (live.ownerSurface(threadId) !== true) return L1();
    if (live.notOwnerAudience(threadId)) return L1();
    if (!turnAudienceIsOwner(threadId, { origin: record.origin, ...(record.rootThreadId ? { rootThreadId: record.rootThreadId } : {}) }, db)) return L1();
    if (record.rootThreadId && live.ownerSurface(record.rootThreadId) !== true) return L1();
    if (!isWorkspaceOwner(threadHumanPrincipal(threadId, db))) return L1();
    // R3: the bot's own direct thread, held by no room and no other bot
    const roster = live.roster();
    const bot = roster.bots.find(entry => entry.id === botId);
    if (!bot || !ownDirectThread(bot, threadId)) return L1();
    const foreign = roster.bots.some(other => other.id !== botId && (other.threadId === threadId || (other.tasks ?? []).some(task => task.threadId === threadId)))
      || roster.groups.some(room => room.threadId === threadId || (room.tasks ?? []).some(task => task.threadId === threadId));
    if (foreign) return L1();
    const unknown = Object.keys(body).find(key => !BODY_KEYS.has(key));
    if (unknown) return L2();
    // R4: a venue the bot is a member of now (pair rooms and archived rooms are not venues)
    const group = typeof body.venueId === "string" ? roster.groups.find(entry => entry.id === body.venueId) : undefined;
    if (!group || group.dm || group.hidden || !group.memberIds.includes(botId)) return L2();
    // R5 and R9: the readable threads (an ended project reads as a channel: no desks)
    const threads = venueThreads(db, roster, group.id);
    const target = body.venueThreadId === undefined ? group.threadId : body.venueThreadId;
    if (typeof target !== "string" || !threads.has(target)) return L2();
    // R6: memory-off threads, the exact query of policy.ts recallThreads (never excludedThreads(), which fails open)
    const excluded = new Set(db.prepare("SELECT e.value FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings'").all().map(row => String(row.value)));
    if (excluded.has(target)) return L2();
    // R7: channel-person threads (a binding whose person is not exactly the workspace owner, null included); desks always close the room
    const bound = new Set<string>();
    for (const row of db.prepare("SELECT subject_id, json_extract(intent,'$.personId') AS person FROM memory_scope_bindings WHERE subject_type='human-thread'").all())
      if (row.person !== WORKSPACE_OWNER) bound.add(String(row.subject_id));
    for (const thread of new Set([...projectThreads(roster, group.id), ...threads])) if (bound.has(thread)) return L2();
    // R8: partitions
    const stored = executionStore()?.bot(botId) ?? bot;
    if (threadPartition(stored, threadId).kind === "isolated") return L2();
    if (!sameThreadPartition(stored, threadId, target)) return L2();
    return { ok: true, record, venueId: group.id, input: { threadId: target, before: body.before, limit: body.limit }, options: { venue: true, threads, members: new Set(group.memberIds) } };
  } catch {
    return L1();
  }
}

/** The route's whole answer (index.ts /api/internal/venue/read-messages): authorise, read the page, and map every refusal to its line. */
export function serveVenueRead(db: DatabaseSync, claim: { botId: string; threadId: string; generation: string }, body: Record<string, unknown>): { status: number; body: unknown } {
  const verdict = authorizeVenueRead(db, claim, body);
  if (!verdict.ok) return { status: verdict.status, body: verdict.body };
  const handler = venueToolHandlers.get("read-messages");
  if (!handler) return { status: 403, body: { error: VENUE_READ_UNAVAILABLE } };
  const { record } = verdict;
  let result: { status: number; body: unknown };
  try {
    result = handler({ db, venueId: verdict.venueId, botId: record.botId, consumingThreadId: record.threadId, input: verdict.input, options: verdict.options,
      // R10, second half: past the line budget the page returns nothing
      charge: lines => { if (record.lines + lines > VENUE_READ_LINES) return false; record.lines += lines; return true; } });
  } catch {
    return { status: 403, body: { error: VENUE_READ_UNAVAILABLE } };
  }
  if (result.status === 200) return result;
  // the page validates limit and before only after R1 to R10 and the reader door passed: a neutral 400 line, never a venue fact
  if (result.status === 400) return { status: 400, body: { error: String((result.body as { error?: unknown }).error) } };
  if (result.status === 409) return { status: 403, body: { error: VENUE_READ_LIMIT } };
  return { status: 403, body: { error: VENUE_NOT_AVAILABLE } };
}
