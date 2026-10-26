// SPDX-License-Identifier: AGPL-3.0-or-later
// "Where I belong" (BOT-VENUE-AWARENESS-106.md, Part 1): the projects and
// channels a bot is a member of, as one plain-text block on every
// owner-audience direct turn. Built from store state only (the groups, the
// bots, one project_settings row per member project); nothing here reads
// `messages`. The block rides the turn's message on every such turn, never
// the system prompt and never through a delivered cache (design D2).
import type { DatabaseSync } from "node:sqlite";
import { sameThreadPartition, threadPartition, isHomePartition } from "./execution-audience.ts";
import { ownerOnly } from "./owner-audience.ts";
import { projectSettingsFor } from "./project-records.ts";
import { projectTableExists } from "./project-turn-engine.ts";
import { liveTeamLabel } from "./team-identities.ts";
import { name } from "./working-context.ts";
import { projectThreads } from "./project-memory-tools.ts";
import type { MemoryRoster } from "./memory/policy.ts";
import type { BotRecord, GroupRecord } from "./store.ts";

export const MAX_VENUES = 12;
export const VENUE_BLOCK_BYTES = 2_400;
const MAX_OTHERS = 6;

export const VENUE_EMPTY_LINE = "You are not in any project or channel right now.";
export const VENUE_UNAVAILABLE_LINE = "Your list of projects and channels is not available this turn.";
export const VENUE_READ_LINE = "Read any of these with venue_read_messages (venue_id). Each page is in order, oldest to newest; the first page is the newest; pass its before value to go further back.";
export const VENUE_BRING_LINE = "The owner can bring lines from any of these into this chat.";

type VenueBot = Pick<BotRecord, "id" | "name" | "threadId"> & Partial<Pick<BotRecord, "section" | "partitionedAt" | "tasks">>;
type VenueGroup = Pick<GroupRecord, "id" | "name" | "threadId" | "memberIds"> & Partial<Pick<GroupRecord, "dm" | "hidden" | "section" | "channelProject" | "tasks">>;
export interface VenueInput {
  botId: string;
  currentThreadId: string;
  bots: ReadonlyArray<VenueBot>;
  groups: ReadonlyArray<VenueGroup>;
  /** venue_read_messages is mounted on this turn (design 4.2) */
  toolMounted: boolean;
}

export type VenueStatus = "active" | "paused" | "done" | "closed";
export type VenueFact =
  | { kind: "project"; id: string; name: string; goal: string; status: VenueStatus; lead: string; others: string; filedUnder?: string }
  | { kind: "channel"; id: string; name: string; others: string; filedUnder?: string };
export type VenueKind = "project" | "channel";

const STATUS_ORDER: Record<VenueStatus, number> = { active: 0, paused: 1, done: 2, closed: 3 };
const cut = (text: string, chars: number) => name(text, chars).trim();

/** V3: a project only with its channelProject block AND a project_settings row that has not ended. */
function kindWithSettings(db: DatabaseSync, group: { id: string; channelProject?: unknown }, tableExists: boolean) {
  if (!group.channelProject || !tableExists) return { kind: "channel" as const };
  const settings = projectSettingsFor(db, group.id);
  return settings && settings.endedAt === null ? { kind: "project" as const, settings } : { kind: "channel" as const };
}

/** The lifecycle class of every group the bot is a member of (design 3.4): read once per build, bounded by membership. */
export function venueKinds(db: DatabaseSync, groups: ReadonlyArray<{ id: string; memberIds: readonly string[]; channelProject?: unknown }>, botId: string): Map<string, VenueKind> {
  const kinds = new Map<string, VenueKind>();
  const members = groups.filter(group => group.memberIds.includes(botId));
  const tableExists = members.some(group => group.channelProject) && projectTableExists(db, "project_settings");
  for (const group of members) kinds.set(group.id, kindWithSettings(db, group, tableExists).kind);
  return kinds;
}

function othersOf(group: VenueGroup, botId: string, botsById: ReadonlyMap<string, VenueBot>): string {
  const others = group.memberIds.filter(id => id !== botId);
  if (!others.length) return "none, just you";
  const names = others.slice(0, MAX_OTHERS).map(id => { const bot = botsById.get(id); return bot ? cut(bot.name, 40) || "a member" : "a member"; });
  return others.length > MAX_OTHERS ? `${names.join(", ")} and ${others.length - MAX_OTHERS} more` : names.join(", ");
}

/** V5: the team label as standing-context.ts picks it. */
function teamLabel(bot: VenueBot | undefined, currentThreadId: string): string | undefined {
  if (!bot) return undefined;
  const partition = bot.partitionedAt === undefined ? { kind: "home" as const } : threadPartition(bot as BotRecord, currentThreadId);
  const label = isHomePartition(partition) ? bot.section : partition.kind === "team" ? liveTeamLabel(partition.teamId) : undefined;
  return label ? cut(label, 40) || undefined : undefined;
}

/** The sorted facts (V1 to V6) and the class of every member group. `isolated` is true for an isolated thread (V2). */
export function venueFacts(db: DatabaseSync, input: VenueInput): { venues: VenueFact[]; kindOf: Map<string, VenueKind>; team?: string; isolated: boolean } {
  const kindOf = new Map<string, VenueKind>();
  const bot = input.bots.find(entry => entry.id === input.botId);
  const botsById = new Map(input.bots.map(entry => [entry.id, entry]));
  const members = input.groups.filter(group => group.memberIds.includes(input.botId));
  const tableExists = members.some(group => group.channelProject) && projectTableExists(db, "project_settings");
  const classified = members.map(group => { const known = kindWithSettings(db, group, tableExists); kindOf.set(group.id, known.kind); return { group, ...known }; });
  const team = teamLabel(bot, input.currentThreadId);
  const partitioned = bot?.partitionedAt !== undefined;
  if (bot && partitioned && threadPartition(bot as BotRecord, input.currentThreadId).kind === "isolated") return { venues: [], kindOf, team, isolated: true };
  const venues: VenueFact[] = [];
  for (const { group, kind, settings } of classified) {
    if (group.dm || group.hidden) continue;
    if (bot && partitioned && !sameThreadPartition(bot as BotRecord, input.currentThreadId, group.threadId)) continue;
    const filedUnder = group.section && cut(group.section, 40) !== team ? cut(group.section, 40) || undefined : undefined;
    const base = { id: name(group.id, group.id.length), name: cut(group.name, 60), others: othersOf(group, input.botId, botsById), ...(filedUnder ? { filedUnder } : {}) };
    if (kind === "project" && settings && group.channelProject) {
      const block = group.channelProject;
      const status: VenueStatus = settings.closedAt !== null ? "closed" : settings.runState === "paused" || block.status === "paused" ? "paused" : block.status;
      const leadId = settings.leadBotId;
      const lead = !leadId || !group.memberIds.includes(leadId) ? "none" : leadId === input.botId ? "you" : botsById.has(leadId) ? cut(botsById.get(leadId)!.name, 40) || "a member" : "a member";
      venues.push({ kind: "project", ...base, goal: cut(block.goal.split(/[\r\n]/)[0] ?? "", 160), status, lead });
    } else venues.push({ kind: "channel", ...base });
  }
  venues.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "project" ? -1 : 1;
    if (a.kind === "project" && b.kind === "project" && a.status !== b.status) return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    return a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  return { venues, kindOf, ...(team ? { team } : {}), isolated: false };
}

function venueLine(venue: VenueFact): string {
  const filed = venue.filedUnder ? ` filed under: ${venue.filedUnder}.` : "";
  if (venue.kind === "channel") return `- Channel "${venue.name}": other members: ${venue.others}.${filed} id: ${venue.id}`;
  return `- Project "${venue.name}": goal: ${venue.goal || "none"}. status: ${venue.status}. lead: ${venue.lead}. other members: ${venue.others}.${filed} id: ${venue.id}`;
}

const more = (n: number) => `...and ${n} more. Ask the owner which one matters now.`;

let warned = false;
export interface VenueContext {
  text: string;
  /** null on an unavailable build; the working context must not retry or guess its labels. */
  kindOf: ReadonlyMap<string, VenueKind> | null;
}

/** Build the text and lifecycle map together so a direct turn reads each settings row once. */
function venueContext(db: DatabaseSync, input: VenueInput): VenueContext {
  try {
    const { venues, kindOf, team, isolated } = venueFacts(db, input);
    if (isolated) return { text: VENUE_UNAVAILABLE_LINE, kindOf: null };
    if (!venues.length) return { text: VENUE_EMPTY_LINE, kindOf };
    const head = ["Where you belong, as of this turn.", ...(team ? [`Your team: ${team}`] : [])];
    const tail = input.toolMounted ? VENUE_READ_LINE : VENUE_BRING_LINE;
    const render = (count: number) => [...head, ...venues.slice(0, count).map(venueLine), ...(count < venues.length ? [more(venues.length - count)] : []), tail].join("\n");
    let count = Math.min(venues.length, MAX_VENUES);
    while (count > 0 && Buffer.byteLength(render(count)) > VENUE_BLOCK_BYTES) count -= 1;
    return { text: render(count), kindOf };
  } catch (error) {
    if (!warned) { warned = true; console.warn("[venue-awareness] the list of projects and channels could not be built:", error instanceof Error ? error.message : String(error)); }
    return { text: VENUE_UNAVAILABLE_LINE, kindOf: null };
  }
}

/** The block's text (V1 to V10). Never throws: a failure gives the V10 line, logged once per boot. */
export function venueBlock(db: DatabaseSync, input: VenueInput): string {
  return venueContext(db, input).text;
}

/** The owner gate runs before reading any facts. The map is shared only within this build, never cached. */
export function venueTurnContext(db: DatabaseSync, ownerAudience: boolean, input: VenueInput & { automationSource?: string }): VenueContext {
  let context: VenueContext = { text: "", kindOf: null };
  ownerOnly("where-i-belong", ownerAudience, () => {
    if (input.automationSource !== "webhook") context = venueContext(db, input);
    return context.text;
  });
  return context;
}

/** The block for a direct turn: owner audience only (owner-audience.ts), never on a webhook turn (D4, the About me rule). */
export function venueTurnBlock(db: DatabaseSync, ownerAudience: boolean, input: VenueInput & { automationSource?: string }): string {
  return venueTurnContext(db, ownerAudience, input).text;
}

/** The threads of a venue that may be read (design 4.3 R5): a live project's room, room tasks and member desks; a channel's
 *  (or an ended project's) room and room tasks only. */
export function venueThreads(db: DatabaseSync, roster: MemoryRoster, groupId: string): Set<string> {
  const group = roster.groups.find(entry => entry.id === groupId) as VenueGroup | undefined;
  if (!group) return new Set();
  const tableExists = Boolean(group.channelProject) && projectTableExists(db, "project_settings");
  if (kindWithSettings(db, group, tableExists).kind === "project") return projectThreads(roster, groupId);
  return new Set([group.threadId, ...(group.tasks ?? []).map(task => task.threadId)]);
}

/** Test hook: the once-per-boot warning fires again. */
export function resetVenueWarningForTest(): void { warned = false; }
