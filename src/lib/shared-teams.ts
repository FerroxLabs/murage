// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bots shared across teams, as the window shows them (SPEC-X 13). The words
// live here, in one place, so the Teams section, the sidebar rows, the work
// thread and Team settings say the same thing, and every sentence uses the
// bot's own name rather than a pronoun.

/** One team a bot is shared with, as the harness derives it for the owner
 * (server/shared-wire.ts). `threadId` is null until the owner first opens
 * the work thread, and `teamId` is null for a team no one has named in
 * sharing yet (`all` mode): the row opens it by its name. */
export interface SharedRow {
  teamId: string | null;
  teamName: string;
  threadId: string | null;
  /** a job for this team is running or waiting on the owner */
  working?: boolean;
  /** requests from this team waiting in line */
  waiting?: number;
}

/** A work thread's marker on its task (never the finishing request's ids). */
export interface SharedWorkMarker {
  teamId: string;
  teamName: string;
  createdAt: number;
  closedAt?: number;
  closedReason?: "revoked" | "team-deleted" | "restored";
}

export interface SharingTeam { id: string; name: string; covered: boolean; selectable: boolean; reason?: "home" | "assistants" }
export interface SharingLoad { teamId: string; name: string; running: number; queued: number; waitingOnYou: number }
export interface SharingSkill { name: string; revision: string; byOwner: boolean; everyTeam: boolean }
export interface SharingView {
  home: { id: string | null; name: string };
  sharedWith: { mode: "none" | "list" | "all"; teams: Array<{ id: string; name: string }> };
  partitioned: boolean;
  enabled: boolean;
  shareable: boolean;
  teams: SharingTeam[];
  load: SharingLoad[];
  loadLine: string;
  skills: SharingSkill[];
  limits: { runningPerTeam: number; runningTotal: number; queuedPerTeam: number; expiresHours: number };
}

/** "Sales", "Sales and Support", "Ops, Sales and Support". */
export function joinTeamNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export const SHARING_COPY = {
  sectionIntro: "Other teams this bot works for, and what rides with it.",
  homeNote: "A bot that works for other teams keeps its home team. To work for another team full time, make a copy.",
  none: "No other team",
  list: "These teams",
  all: "All teams",
  limits: "1 job per team at a time, 2 in all. Up to 20 requests wait per team, for up to a day.",
  noTeams: "There are no other teams yet. Add a team in the sidebar first.",
  turnedOff: "Sharing across teams is turned off, so no team can ask for new work. Work threads stay readable.",
  makeCopy: "Make a copy for this team",
  letFinish: "Let it finish",
  stopNow: "Stop it now",
  useEveryTeam: "Use for every team",
  notesSaved: "Saved.",
  notesChanged: "These notes changed since you opened them. Your version is still in the box, and the newer notes are below it. Check both, then save again.",
  newerNotes: "The newer notes",
  teamWork: "Team work",
  sharedWithTeam: "Shared with this team",
  sharedMark: "shared",
  openTeams: "Teams settings",
} as const;

export const homeTeamLine = (name: string, home: string) => `${name}'s home team is ${home}.`;
export const allTeamsLine = (teams: readonly string[]) =>
  teams.length ? `Covers ${joinTeamNames(teams)}, and any team you add later.` : "Covers any team you add later.";
export const howItWorksLine = (name: string) =>
  `Leads of these teams can ask ${name} for work. ${name} follows that team's brief and keeps separate notes and a separate folder for each team. Murage does not show one team's work to another team's bots.`;
export const honestLimitLine = (name: string) =>
  `${name}'s shell, browser and connected apps can still reach things from ${name}'s other work. For separate clients, use a copy of this bot.`;
export const learnedSkillsHeading = (name: string) => `Skills ${name} learned on its own`;
export const noLearnedSkillsLine = (name: string) => `${name} has not learned a skill yet.`;
export const cannotShareLine = (name: string) => `An Individual Assistant or the Chief of Staff works for you alone, so ${name} is not shared with teams.`;
export const generalNotesHeading = "Notes that apply to every team";
export const generalNotesHint = (name: string) => `Only you can change these. ${name} reads them in every team's work.`;
export const runningChoiceLine = (name: string, team: string) => `${name} is working for ${team} now.`;
export const copyMadeLine = (name: string) => `${name} is ready in the sidebar.`;

/** "Working for Sales · 2 waiting from Support" (13.1 Load). */
export function sharingLoadLine(load: readonly SharingLoad[]): string {
  const working = load.filter(item => item.running + item.waitingOnYou > 0).map(item => `Working for ${item.name}`);
  const waiting = load.filter(item => item.queued > 0).map(item => `${item.queued} waiting from ${item.name}`);
  return [...working, ...waiting].join(" · ");
}

/** A 409 on the notes: the owner's draft stays in the box, the newer notes
 * are shown beside it, and the next save is against the newer revision. */
export function notesAfterConflict(draft: string, newer: { text: string; revision: string }): { text: string; saved: string; revision: string; newer: string } {
  return { text: draft, saved: newer.text, revision: newer.revision, newer: newer.text };
}

/** The body that opens a row's work thread: by id, or by name before the
 * team has one. */
export const workThreadRequest = (row: Pick<SharedRow, "teamId" | "teamName">) => row.teamId ? { teamId: row.teamId } : { teamName: row.teamName };

/** The sidebar row under a covered team: "Iris · shared from Design". */
export const sharedRowLabel = (name: string, home: string) => `${name} · shared from ${home || "General"}`;
/** "working", "2 waiting", or nothing. */
export function sharedRowStatus(row: Pick<SharedRow, "working" | "waiting">): string {
  if (row.working) return "working";
  return row.waiting ? `${row.waiting} waiting` : "";
}

/** 13.2: the work thread's header, and the line that replaces its composer
 * once the thread is closed (10.1). */
export const workThreadHeader = (name: string, team: string) =>
  `Work for ${team}. ${name} follows the ${team} brief and ${name}'s ${team} notes here.`;
export function closedWorkThreadLine(name: string, work: Pick<SharedWorkMarker, "teamName" | "closedReason">): string {
  if (work.closedReason === "team-deleted") return `${work.teamName || "This team"} was deleted. This conversation is kept for reading.`;
  if (work.closedReason === "restored") return "This conversation came back from a backup and is kept for reading.";
  return `${name} is no longer shared with ${work.teamName || "this team"}. This conversation is kept for reading.`;
}

type TaskLike = { threadId: string; sharedWork?: SharedWorkMarker };
type BotLike = { id: string; name: string; threadId: string; section?: string; hidden?: boolean; sharedRows?: SharedRow[]; tasks?: TaskLike[] };

/** The work thread the bot has open, if the open thread is one. */
export function activeWorkThread(bot: Pick<BotLike, "threadId" | "tasks">): SharedWorkMarker | undefined {
  return bot.tasks?.find(task => task.threadId === bot.threadId)?.sharedWork;
}

/** The closed-thread line when the open thread is a closed work thread. */
export function closedComposerLine(bot: Pick<BotLike, "name" | "threadId" | "tasks">): string | null {
  const work = activeWorkThread(bot);
  return work?.closedAt !== undefined ? closedWorkThreadLine(bot.name, work) : null;
}

/** The light rows under one named team: each other team's bot shared with
 * it, in name order. General and a bot's own home team never get one. */
export function sharedRowsForSection<B extends BotLike>(bots: readonly B[], section: string): Array<{ bot: B; row: SharedRow }> {
  const key = section.trim();
  if (!key) return [];
  return bots
    .filter(bot => !bot.hidden && (bot.section?.trim() ?? "") !== key)
    .flatMap(bot => (bot.sharedRows ?? []).filter(row => row.teamName === key).map(row => ({ bot, row })))
    .sort((a, b) => a.bot.name.localeCompare(b.bot.name));
}

/** Team map: every bot shared into a team, with the team it comes from. */
export function sharedIntoTeam<B extends BotLike>(bots: readonly B[], team: string): Array<{ bot: B; from: string }> {
  return sharedRowsForSection(bots, team).map(({ bot }) => ({ bot, from: bot.section?.trim() || "General" }));
}

/** The Teams section's choice, as the radio group shows it. */
export function sharingChoice(view: Pick<SharingView, "sharedWith">): "none" | "list" | "all" {
  return view.sharedWith.mode;
}

/** Teams that a change would stop covering while a job for them is on: the
 * owner chooses Let it finish or Stop it now for these. */
export function teamsLosingRunningWork(view: Pick<SharingView, "teams" | "load">, next: { mode: "none" | "list" | "all"; teamIds: readonly string[] }): string[] {
  const kept = (team: SharingTeam) => next.mode === "all" ? team.selectable : next.mode === "list" && next.teamIds.includes(team.id);
  return view.load
    .filter(item => item.running + item.waitingOnYou > 0)
    .filter(item => { const team = view.teams.find(entry => entry.id === item.teamId); return !team || !kept(team); })
    .map(item => item.name);
}
