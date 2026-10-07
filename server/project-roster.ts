import { executionStore, threadPartition, isHomePartition } from "./execution-audience.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Roster and capabilities (0.1.61 lane M, plan 3.10; SPEC-P 13.3).
//
// A project member's turn names who else is in the room, what each can do and
// what each is doing now, one line per member:
//   Dax (member, Sales closer) · tools: files, shell, browser · apps: gmail · now: card 12 "Payments reconciler" (8 min)
// The lead assigns with it, members recommend with project_suggest, and an
// assignment of a card that needs something the bot lacks is refused with the
// reason (F9 at assign time). The tags are the SPEC-P 13.3 vocabulary
// (project-capabilities.ts). Connected app names are the owner's material:
// they ride only an owner-audience turn (`project-roster-apps`).
import type { DatabaseSync } from "node:sqlite";
import { ownerOnly } from "./owner-audience.ts";
import { isProjectCapabilityTag } from "./project-capabilities.ts";

// (not project-turn-engine.ts: project-cards.ts imports this module)
function projectTableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
}

export interface ProjectBotFacts {
  id: string;
  name: string;
  title?: string;
  /** Tags from the fixed vocabulary it has now (files, shell, browser, ...). */
  tags: readonly string[];
  /** Connected app slugs it can use (app:<slug> tags carry the same). */
  apps: readonly string[];
  /** What it cannot do that a card might assume ("no images"). */
  limits: readonly string[];
  /** What Murage cannot tell from here, so never refuses on (Astra r1 #10):
   *  the model's image reading when unknown, and any connected app when the
   *  bot may use every app the workspace has connected. */
  unknown?: { vision?: boolean; apps?: boolean };
}

/** The tags a bot has, from its settings and what the workspace provides. */
export function botCapabilityTags(bot: {
  browser?: boolean; computer?: string; composio?: boolean;
  connectedAppAccess?: { mode: "unrestricted" | "restricted"; grants: ReadonlyArray<{ toolkit: string }> };
}, env: { worksInWorkspace: boolean; builtInBrowser: boolean; imageGeneration: boolean; webSearch: boolean; vision?: boolean; connectedApps: readonly string[] | null }): { tags: string[]; apps: string[]; limits: string[]; unknown: { vision: boolean; apps: boolean } } {
  const tags: string[] = [];
  if (env.worksInWorkspace) tags.push("files", "shell");
  if (env.builtInBrowser && bot.browser !== false) tags.push("browser");
  if (bot.computer && bot.computer !== "off" && bot.computer !== "browser") tags.push("computer");
  if (env.imageGeneration) tags.push("images");
  if (env.vision === true) tags.push("vision");
  if (env.webSearch) tags.push("web");
  const restricted = bot.connectedAppAccess?.mode === "restricted";
  const granted = restricted ? bot.connectedAppAccess!.grants.map(grant => grant.toolkit) : env.connectedApps ?? [];
  const apps = bot.composio === false ? [] : [...new Set(granted.map(slug => slug.toLowerCase()).filter(slug => isProjectCapabilityTag(`app:${slug}`)))].sort();
  const limits = env.vision === false ? ["no images in"] : [];
  // unrestricted access with the workspace's app list unknown here: any app may be there
  const unknown = { vision: env.vision === undefined, apps: bot.composio !== false && !restricted && env.connectedApps === null };
  return { tags: [...tags, ...apps.map(slug => `app:${slug}`)], apps, limits, unknown };
}

/** The tags a card needs that the bot does not have, in the card's order.
 *  What cannot be told from here is never counted missing. */
export function missingCapabilities(needs: readonly string[], tags: readonly string[], unknown: { vision?: boolean; apps?: boolean } = {}): string[] {
  const have = new Set(tags);
  return needs.filter(tag => !have.has(tag) && !(unknown.vision && tag === "vision") && !(unknown.apps && tag.startsWith("app:")));
}

const WORDS: Record<string, string> = { files: "file tools", shell: "a shell", browser: "a browser", computer: "a computer", images: "image making", vision: "image reading", web: "web search" };
/** The refusal sentence, or null when the bot can do the card. */
export function capabilityRefusal(botName: string, needs: readonly string[], tags: readonly string[], unknown: { vision?: boolean; apps?: boolean } = {}): string | null {
  const missing = missingCapabilities(needs, tags, unknown);
  if (!missing.length) return null;
  const words = missing.map(tag => tag.startsWith("app:") ? `the connected app ${tag.slice(4)}` : WORDS[tag] ?? tag);
  return `${botName} cannot do this card: it has no ${words.join(", no ")}.`;
}

// The live facts come from the server (index.ts registers them): the card
// transitions in project-cards.ts ask here before an assignment.
let factsProvider: ((botId: string) => ProjectBotFacts | null) | null = null;
export function setProjectBotFacts(provider: ((botId: string) => ProjectBotFacts | null) | null): void { factsProvider = provider; }
export function projectBotFacts(botId: string): ProjectBotFacts | null { return factsProvider?.(botId) ?? null; }

/** Refuse assigning a card to a bot that lacks what it needs. Without a
 * registered provider (tools, tests of other modules) nothing is refused. */
export function assignmentCapabilityRefusal(botId: string, needs: readonly string[]): string | null {
  if (!needs.length) return null;
  const facts = projectBotFacts(botId);
  return facts ? capabilityRefusal(facts.name, needs, facts.tags, facts.unknown) : null;
}

/** "now": the card a member is running in this project, with its age. */
export function projectMemberNow(db: DatabaseSync, groupId: string, botId: string, now: number): string {
  const bot = executionStore()?.bot(botId);
  if (bot?.partitionedAt !== undefined && db.prepare("SELECT target_thread_id FROM room_requests WHERE to_bot_id=? AND state IN ('running','waiting_owner','waiting_bot')").all(botId).some(row => typeof row.target_thread_id === "string" && !isHomePartition(threadPartition(bot, row.target_thread_id)))) return "busy (shared work)";
  if (!projectTableExists(db, "room_requests") || !projectTableExists(db, "project_work_items")) return "";
  const row = db.prepare(`SELECT w.number, w.title, w.stale, r.dispatched_at FROM room_requests r JOIN project_work_items w ON w.id=r.work_item_id
    WHERE r.group_id=? AND r.to_bot_id=? AND r.state='running' ORDER BY r.dispatched_at DESC LIMIT 1`).get(groupId, botId) as { number: number; title: string; stale: number; dispatched_at: number | null } | undefined;
  if (!row) return "";
  const minutes = row.dispatched_at ? Math.max(0, Math.round((now - Number(row.dispatched_at)) / 60000)) : null;
  const title = row.stale ? "" : ` ${JSON.stringify(row.title.replace(/\s+/g, " ").slice(0, 60)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")}`;
  return `card ${row.number}${title}${minutes !== null ? ` (${minutes} min)` : ""}`;
}

/** "now" for the Chief's roster: the project card a bot is running
 * anywhere, with the project's name (L1a: "Dax (Sales closer), now: ..."). */
export function projectBotNowAnywhere(db: DatabaseSync, botId: string, groupName: (groupId: string) => string | undefined, now: number): string {
  const bot = executionStore()?.bot(botId);
  if (bot?.partitionedAt !== undefined && db.prepare("SELECT target_thread_id FROM room_requests WHERE to_bot_id=? AND state IN ('running','waiting_owner','waiting_bot')").all(botId).some(row => typeof row.target_thread_id === "string" && !isHomePartition(threadPartition(bot, row.target_thread_id)))) return "busy (shared work)";
  if (!projectTableExists(db, "room_requests") || !projectTableExists(db, "project_work_items")) return "";
  const row = db.prepare(`SELECT r.group_id, r.dispatched_at, w.number, w.title, w.stale FROM room_requests r JOIN project_work_items w ON w.id=r.work_item_id
    WHERE r.to_bot_id=? AND r.state='running' ORDER BY r.dispatched_at DESC LIMIT 1`).get(botId) as { group_id: string; dispatched_at: number | null; number: number; title: string; stale: number } | undefined;
  if (!row) return "";
  const name = groupName(row.group_id);
  const minutes = row.dispatched_at ? Math.max(0, Math.round((now - Number(row.dispatched_at)) / 60000)) : null;
  const quote = (text: string) => JSON.stringify(clip(text, 60)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return `card ${row.number}${row.stale ? "" : ` ${quote(row.title)}`}${name ? ` in ${quote(name)}` : ""}${minutes !== null ? ` (${minutes} min)` : ""}`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").replace(/[<>]/g, "").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** One line per member; app names only on an owner-audience turn. */
export function projectRosterLine(member: ProjectBotFacts & { role: "lead" | "member"; now?: string }, ownerAudience: boolean): string {
  const tools = member.tags.filter(tag => !tag.startsWith("app:"));
  const apps = ownerOnly("project-roster-apps", ownerAudience, () => member.apps.length ? `apps: ${member.apps.join(", ")}` : member.unknown?.apps ? "apps: the workspace's connected apps" : "");
  return [
    `${clip(member.name, 60)} (${member.role}${member.title?.trim() ? `, ${clip(member.title, 60)}` : ""})`,
    tools.length ? `tools: ${tools.join(", ")}` : "tools: none",
    apps,
    member.limits.length ? `limits: ${member.limits.join(", ")}` : "",
    `now: ${member.now || "free"}`,
  ].filter(Boolean).join(" · ");
}

/** The roster layer, within its cap (plan 3.8: 400 tokens). */
export function projectRosterBlock(members: ReadonlyArray<ProjectBotFacts & { role: "lead" | "member"; now?: string }>, ownerAudience: boolean, capTokens: number = 400): string {
  if (!members.length) return "";
  const header = "Who is on the project, what each can do and what each is doing now:";
  const lines: string[] = [];
  for (const member of members) {
    const line = `- ${projectRosterLine(member, ownerAudience)}`;
    if (Buffer.byteLength([header, ...lines, line].join("\n")) > capTokens * 4 - 60) {
      lines.push(`- ...and ${members.length - lines.length} more.`);
      break;
    }
    lines.push(line);
  }
  return [header, ...lines].join("\n");
}

/** The Chief's roster with "now" for each bot running a project card, on an
 * owner-audience turn only: project names and card titles are the owner's
 * material (Astra r1 #1). Any other turn gets the roster as it was. */
export function withProjectNow<T extends { id: string }>(bots: readonly T[], ownerAudience: boolean, nowFor: (botId: string) => string): Array<T & { now?: string }> {
  if (!ownerAudience) return [...bots];
  return bots.map(bot => { const now = nowFor(bot.id); return now ? { ...bot, now } : bot; });
}
