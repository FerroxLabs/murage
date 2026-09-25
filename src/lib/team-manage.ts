// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Managing a team that already exists: rename it, change who is on it and
// who leads it, delete it. A team is a sidebar section (see lib/new-team.ts
// and server/team-sections.ts); the harness owns the rules, and this module
// holds the words, the diff the dialog sends, and the client calls.
import { botRole, type RoleBot } from "./bot-role";
import { RESERVED_TEAM_NAMES, TEAM_NAME_MAX } from "./new-team";
import { userSectionId } from "./sidebar-layout";

export interface TeamView {
  name: string;
  revision: string;
  leadId: string | null;
  members: Array<{ id: string; name: string; lead: boolean; chief: boolean; archived: boolean }>;
  channels: Array<{ id: string; name: string; archived: boolean }>;
  hasInstructions: boolean;
}

/** What a change touched, every field spelled out (null = none). */
export interface TeamChanges {
  bots: Array<{ id: string; section: string | null; chiefOfStaff: boolean; chiefScope: "workspace" | null; individual: boolean | null; hidden: boolean | null }>;
  groups: Array<{ id: string; name: string; section: string | null; hidden: boolean | null }>;
}

/** Patches to fold into the store. Frames from the harness merge field by
 * field, so a team that was cleared has to be cleared here as `undefined`
 * or the old heading would stay on screen until the next reload. */
export function teamChangePatches(changed: TeamChanges) {
  const none = <T>(value: T | null) => (value === null ? undefined : value);
  return {
    bots: changed.bots.map(({ id, section, chiefOfStaff, chiefScope, individual, hidden }) => ({
      id,
      patch: { section: none(section), chiefOfStaff, chiefScope: none(chiefScope), individual: none(individual), hidden: none(hidden) },
    })),
    groups: changed.groups.map(({ id, name, section, hidden }) => ({ id, patch: { name, section: none(section), hidden: none(hidden) } })),
  };
}

/** Where the dialog opens: the field the person asked for. */
export type TeamSettingsFocus = "rename" | "members" | "delete";
export type TeamDeleteChoice = "keep" | "archive";

/** The window event that opens team settings from anywhere (the sidebar's
 * team menu, a channel's details). The sidebar hosts the dialog. */
export const OPEN_TEAM_SETTINGS_EVENT = "murage:manage-team";
export interface OpenTeamSettingsDetail {
  section: string;
  focus: TeamSettingsFocus;
}
export function openTeamSettings(section: string, focus: TeamSettingsFocus = "members"): void {
  window.dispatchEvent(new CustomEvent<OpenTeamSettingsDetail>(OPEN_TEAM_SETTINGS_EVENT, { detail: { section, focus } }));
}

const fold = (value: string) => value.trim().toLocaleLowerCase();

/** Why this new name cannot be saved, in words for the person, or null. The
 * harness checks again, including names only archived bots still carry. */
export function teamRenameProblem(name: string, current: string, existing: readonly string[]): string | null {
  const next = name.trim();
  if (!next) return "Give the team a name.";
  if (next === current.trim()) return "That is already its name.";
  if (next.length > TEAM_NAME_MAX) return `Team names can be up to ${TEAM_NAME_MAX} characters.`;
  const reserved = RESERVED_TEAM_NAMES.find((candidate) => fold(candidate) === fold(next));
  if (reserved) return `"${reserved}" is already a heading in the sidebar. Choose another name.`;
  const taken = existing.find((candidate) => fold(candidate) === fold(next) && fold(candidate) !== fold(current));
  if (taken) return `There is already a team called ${taken.trim()}. Choose another name.`;
  return null;
}

export interface TeamMembersChange {
  add?: string[];
  remove?: string[];
  leadId?: string | null;
}

/** The change the members list asks for, or null when it asks for nothing.
 * `picked` holds the visible bots the person ticked; archived members are
 * not in the list, so they are never removed by it. `lead` is "" for none. */
export function teamMembersChange(team: TeamView, picked: ReadonlySet<string>, lead: string): TeamMembersChange | null {
  const current = team.members.filter((bot) => !bot.archived && !bot.chief).map((bot) => bot.id);
  const add = [...picked].filter((id) => !current.includes(id));
  const remove = current.filter((id) => !picked.has(id));
  const wantedLead = lead && picked.has(lead) ? lead : null;
  const change: TeamMembersChange = {};
  if (add.length) change.add = add;
  if (remove.length) change.remove = remove;
  if (wantedLead !== team.leadId) change.leadId = wantedLead;
  return Object.keys(change).length ? change : null;
}

/** A bot's second line in the members list. */
export function teamCandidateDetail(
  bot: RoleBot,
  team: string,
  picked: boolean,
): string | undefined {
  const current = bot.section?.trim() ?? "";
  if (current === team.trim()) return picked ? undefined : "Leaves this team when you save";
  if (!current) return undefined;
  if (botRole(bot) === "leader") return picked ? `Leads ${current}. Moves here and stops leading ${current}.` : `Leads ${current}`;
  return picked ? `In ${current} now. Moves to this team.` : `In ${current} now`;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What deleting the team does, one line per thing, for the confirm panel. */
export function teamDeleteSummary(team: TeamView, choice: TeamDeleteChoice): string[] {
  // Archived members stay archived either way, so they are not counted.
  const bots = team.members.filter((bot) => !bot.chief && !bot.archived);
  const channels = team.channels.filter((channel) => !channel.archived);
  const lead = team.members.find((bot) => bot.id === team.leadId);
  const lines: string[] = [];
  if (bots.length) {
    if (choice === "keep") {
      lines.push(
        `${count(bots.length, "bot", "bots")} ${bots.length === 1 ? "stays" : "stay"}, as ${bots.length === 1 ? "a bot" : "bots"} without a team.` +
          (lead ? ` ${lead.name} stops leading.` : ""),
      );
    } else {
      lines.push(
        `${count(bots.length, "bot", "bots")} ${bots.length === 1 ? "is" : "are"} archived. You can restore ${bots.length === 1 ? "it" : "them"} from Archived bots.`,
      );
    }
  }
  if (channels.length) {
    lines.push(
      choice === "keep"
        ? `${count(channels.length, "channel", "channels")} ${channels.length === 1 ? "stays" : "stay"}, without a team.`
        : `${count(channels.length, "channel", "channels")} ${channels.length === 1 ? "is" : "are"} archived.`,
    );
  }
  lines.push("Every conversation is kept.");
  if (team.hasInstructions) lines.push("The team instructions are removed.");
  return lines;
}

/** The sidebar remembers each heading's place and whether it is closed, by
 * name. A renamed team keeps both. */
export function renameSidebarLayout(
  order: readonly string[],
  collapsed: readonly string[],
  from: string,
  to: string,
): { order: string[]; collapsed: string[] } {
  const swap = (id: string) => (id === userSectionId(from) ? userSectionId(to) : id);
  return { order: order.map(swap), collapsed: collapsed.map(swap) };
}

type Request = (path: string, init?: { method: string; body: string }) => Promise<unknown>;

export async function loadTeam(section: string, request: Request): Promise<TeamView> {
  return ((await request(`/api/team-sections?section=${encodeURIComponent(section)}`)) as { team: TeamView }).team;
}

export async function saveTeamName(team: TeamView, name: string, request: Request): Promise<{ team: TeamView; changed: TeamChanges }> {
  const body = JSON.stringify({ section: team.name, name: name.trim(), revision: team.revision });
  return (await request("/api/team-sections/rename", { method: "POST", body })) as { team: TeamView; changed: TeamChanges };
}

/** `team` is null when the change left nothing on the team. */
export async function saveTeamMembers(
  team: TeamView,
  change: TeamMembersChange,
  request: Request,
): Promise<{ team: TeamView | null; changed: TeamChanges }> {
  const body = JSON.stringify({ section: team.name, revision: team.revision, ...change });
  return (await request("/api/team-sections/members", { method: "POST", body })) as { team: TeamView | null; changed: TeamChanges };
}

export async function removeTeam(team: TeamView, choice: TeamDeleteChoice, request: Request): Promise<{ changed: TeamChanges }> {
  const body = JSON.stringify({ section: team.name, revision: team.revision, bots: choice });
  return (await request("/api/team-sections/delete", { method: "POST", body })) as { changed: TeamChanges };
}
