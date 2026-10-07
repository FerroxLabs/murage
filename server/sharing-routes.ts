// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner's sharing routes (SPEC-X 12.1): who can request a bot's work,
// the notes that ride every team, the learned skills the owner lets ride
// every team, a copy of the bot for one team, and the owner's work thread
// for a covered team. Every route but `work-threads` is desktop only
// (route-policy.ts); `work-threads` also answers the paired phone.
import { createHash } from "node:crypto";
import { database } from "./database.ts";
import { loadConfig } from "./config.ts";
import { type BotRecord, type Store, isIndividualAssistant, isWorkspaceChief, sectionKey } from "./store.ts";
import { sharedWithTeam } from "./execution-audience.ts";
import { teamChangeOpen, teamIdFor, teamLabel } from "./team-identities.ts";
import { changeSharing } from "./shared-work.ts";
import { sharingTeams, sharingTeamsRead } from "./shared-wire.ts";
import { sharedLoadPrompt } from "./shared-bots-roster.ts";
import { readMemoryFile, writeMemoryFile } from "./workspace.ts";
import { installSkill, learnedSkillsForSharing, setSkillEnabled, setSkillEveryTeam, skillsForBotCopy } from "./skills.ts";
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";

export const SHARING_LIMITS = { runningPerTeam: 1, runningTotal: 2, queuedPerTeam: 20, expiresHours: 24 } as const;
export const GENERAL_NOTES_MAX_CHARS = 16384;
const FLAG_OFF = "Sharing across teams is turned off.";
const JOURNAL_OPEN = "A team change is still finishing. Try again in a moment.";

export type SharingReply = { status: number; body: unknown };
export interface SharingRouteDeps {
  store: Store;
  /** The live turn generation running in a thread, for Let it finish. */
  generationFor?: (threadId: string) => string | undefined;
  interrupt?: (threadId: string, generation?: string) => void;
  now?: () => number;
}

const flagOn = () => loadConfig().features?.botsSharedAcrossTeams !== false;
const fail = (status: number, error: string): SharingReply => ({ status, body: { error } });
const revisionOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** What each work thread of this bot has on: running, waiting in line, and
 * waiting on the owner (an approval or a question). A turn the owner started
 * in the work thread has no request row and counts as running. */
export function sharingLoad(bot: BotRecord, generationFor?: (threadId: string) => string | undefined): Array<{ teamId: string; name: string; running: number; queued: number; waitingOnYou: number }> {
  const count = database().prepare("SELECT state, count(*) AS n FROM room_requests WHERE to_bot_id=? AND target_thread_id=? AND state IN ('queued','running','waiting_bot','waiting_owner') GROUP BY state");
  return (bot.tasks ?? []).filter(task => task.sharedWork && !task.sharedWork.quarantined).map(task => {
    const by = Object.fromEntries(count.all(bot.id, task.threadId).map(row => [String(row.state), Number(row.n)]));
    const rows = (by.running ?? 0) + (by.waiting_bot ?? 0);
    const ownerTurn = !rows && !by.waiting_owner && generationFor?.(task.threadId) ? 1 : 0;
    return { teamId: task.sharedWork!.teamId, name: teamLabel(task.sharedWork!.teamId) ?? "", running: rows + ownerTurn, queued: by.queued ?? 0, waitingOnYou: by.waiting_owner ?? 0 };
  });
}

/** The owner's one-line view of a shared bot's load, for the owner roster
 * and Team settings (SPEC-X 5.2): "Iris, shared from Design: working for
 * Sales, 2 waiting". Empty when nothing is on, or when the audience is not
 * the owner. */
export function sharedLoadLine(bot: BotRecord, ownerAudience: boolean, generationFor?: (threadId: string) => string | undefined): string {
  const load = sharingLoad(bot, generationFor).filter(item => item.running + item.queued + item.waitingOnYou > 0);
  if (!load.length) return "";
  const working = load.find(item => item.running + item.waitingOnYou > 0) ?? load[0];
  return sharedLoadPrompt(ownerAudience, { name: bot.name, home: sectionKey(bot.section) || "General", team: working.name, waiting: load.reduce((sum, item) => sum + item.queued, 0) });
}

export function sharingView(store: Store, bot: BotRecord, generationFor?: (threadId: string) => string | undefined) {
  const home = sectionKey(bot.section);
  const homeRow = home ? database().prepare("SELECT team_id FROM team_identities WHERE label=? AND retired_at IS NULL").get(home) : undefined;
  return {
    home: { id: homeRow ? String(homeRow.team_id) : null, name: home || "General" },
    sharedWith: bot.sharedWith ?? { mode: "none", teams: [] },
    partitioned: bot.partitionedAt !== undefined,
    enabled: flagOn(),
    shareable: !isIndividualAssistant(bot) && !isWorkspaceChief(bot) && !bot.hidden,
    teams: sharingTeams(store, bot),
    load: sharingLoad(bot, generationFor),
    loadLine: sharedLoadLine(bot, true, generationFor),
    skills: learnedSkillsForSharing(bot.id),
    limits: SHARING_LIMITS,
  };
}

function patchSharing(deps: SharingRouteDeps, bot: BotRecord, body: unknown): SharingReply {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!input || Object.keys(input).some(key => !["mode", "teamIds", "running"].includes(key))) return fail(400, "mode, teamIds and running are the only fields");
  const mode = input.mode;
  if (mode !== "none" && mode !== "list" && mode !== "all") return fail(400, "mode must be none, list or all");
  const running = input.running ?? "finish";
  if (running !== "finish" && running !== "stop") return fail(400, "running must be finish or stop");
  if (mode !== "none" && !flagOn()) return fail(409, FLAG_OFF);
  if (mode !== "none" && isIndividualAssistant(bot)) return fail(400, `${bot.name} is an Individual Assistant and works only for you, so ${bot.name} cannot be shared with a team.`);
  if (mode !== "none" && isWorkspaceChief(bot)) return fail(400, `${bot.name} is the Chief of Staff and already works across every team.`);
  if (mode !== "none" && bot.hidden) return fail(400, `${bot.name} is archived. Bring ${bot.name} back before sharing ${bot.name} with a team.`);
  if (teamChangeOpen()) return fail(409, JOURNAL_OPEN);
  // Read only: a listed team was named by the id GET sharing gave it, and
  // `all` names no team, so nothing here mints (3.1).
  const teams = sharingTeamsRead(deps.store, bot);
  let chosen: Array<{ id: string; name: string }> = [];
  if (mode === "list") {
    const ids = input.teamIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) return fail(400, "teamIds must list 1 to 50 teams");
    for (const id of ids as string[]) {
      const team = teams.find(item => item.id === id);
      if (!team) return fail(400, "One of those teams no longer exists.");
      if (team.reason === "home") return fail(400, `${team.name} is ${bot.name}'s home team.`);
      if (!team.selectable) return fail(400, `${team.name} has only Individual Assistants, so it cannot request work.`);
      chosen.push({ id, name: team.name });
    }
  } else if (input.teamIds !== undefined && !(Array.isArray(input.teamIds) && input.teamIds.length === 0)) return fail(400, "teamIds is only for a list of teams");
  if (mode === "all") chosen = [];
  const now = deps.now?.() ?? Date.now();
  const before = new Set(database().prepare("SELECT id FROM room_requests WHERE to_bot_id=? AND state IN ('queued','running','waiting_owner','waiting_bot')").all(bot.id).map(row => String(row.id)));
  const next = { mode, teams: chosen } as NonNullable<BotRecord["sharedWith"]>;
  const closing = (bot.tasks ?? []).filter(task => task.sharedWork && !task.sharedWork.quarantined && task.sharedWork.closedAt === undefined && !sharedWithTeam({ ...bot, sharedWith: next }, task.sharedWork.teamId));
  const active = (threadId: string) => !!database().prepare("SELECT 1 FROM room_requests WHERE to_bot_id=? AND target_thread_id=? AND state IN ('running','waiting_owner','waiting_bot') LIMIT 1").get(bot.id, threadId) || !!deps.generationFor?.(threadId);
  const stopping = running === "stop" ? closing.filter(task => active(task.threadId)).map(task => task.sharedWork!.teamId) : [];
  changeSharing(deps.store, bot.id, next, running, { now, ...(deps.generationFor ? { generationFor: deps.generationFor } : {}), ...(deps.interrupt ? { interrupt: deps.interrupt } : {}) });
  const after = database().prepare("SELECT id FROM room_requests WHERE to_bot_id=? AND state='cancelled'").all(bot.id).map(row => String(row.id));
  const fresh = deps.store.bot(bot.id)!;
  return { status: 200, body: { sharedWith: fresh.sharedWith, partitioned: fresh.partitionedAt !== undefined, cancelled: after.filter(id => before.has(id)).length, stopping } };
}

function generalNotes(bot: BotRecord) {
  const notes = readMemoryFile(bot.id, { kind: "general" });
  return { text: notes.text, revision: revisionOf(notes.text), lastWrittenAt: notes.lastWrittenAt };
}

function putGeneralNotes(bot: BotRecord, body: unknown): SharingReply {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (typeof input.text !== "string" || typeof input.expectedRevision !== "string") return fail(400, "text and expectedRevision are required");
  if (input.text.length > GENERAL_NOTES_MAX_CHARS) return fail(400, `Notes for every team can hold up to ${GENERAL_NOTES_MAX_CHARS} characters.`);
  const current = generalNotes(bot);
  if (current.revision !== input.expectedRevision) return { status: 409, body: { error: "changed", ...current } };
  writeMemoryFile(bot.id, input.text, { kind: "general" });
  return { status: 200, body: generalNotes(bot) };
}

/** A new bot for one team: the copy per client (SPEC-X 13.1). It takes the
 * bot's profile, engine, look, notifications and the skills the owner put
 * there or approved for every team; never notebooks, notes, memory,
 * folders, sharing, routines, tasks, computer, cloud, browser or apps. */
function copyForTeam(store: Store, bot: BotRecord, body: unknown): SharingReply {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (typeof input.teamId !== "string" || Object.keys(input).length !== 1) return fail(400, "teamId is required");
  const team = sharingTeams(store, bot).find(item => item.id === input.teamId);
  if (!team) return fail(400, "That team no longer exists.");
  if (team.reason === "home") return fail(400, `${team.name} is ${bot.name}'s home team already.`);
  if (!team.selectable) return fail(400, `${team.name} has only Individual Assistants.`);
  const copy = store.createBot({
    name: `${bot.name} for ${team.name}`.slice(0, BOT_PROFILE_LIMITS.name), title: bot.title, description: bot.description, color: bot.color,
    ...(bot.mascotExpression ? { mascotExpression: bot.mascotExpression } : {}), ...(bot.mascotBody ? { mascotBody: bot.mascotBody } : {}),
    modelSelection: structuredClone(bot.modelSelection), section: team.name,
  }, { seedMessages: false });
  store.patchBot(copy.id, {
    notifications: bot.notifications,
    ...(bot.persona ? { persona: bot.persona } : {}), ...(bot.avatarUrl ? { avatarUrl: bot.avatarUrl } : {}), ...(bot.avatarCrop ? { avatarCrop: structuredClone(bot.avatarCrop) } : {}),
  });
  for (const skill of skillsForBotCopy(bot.id)) {
    const installed = installSkill(copy.id, skill.source, [{ path: "SKILL.md", content: skill.content }]);
    if (!("error" in installed) && skill.enabled) setSkillEnabled(copy.id, installed.name, true);
  }
  return { status: 201, body: { bot: store.bot(copy.id) } };
}

/** Open the owner's work thread for a team, creating it on first use. A
 * closed thread stays readable, so it opens even when the team is no longer
 * covered; a thread that never existed needs a covered team. The team is
 * named by its id, or by its name when it has no id yet (an `all`-mode row
 * before anything minted it): creating the thread is where it gets one. */
export function openWorkThread(store: Store, bot: BotRecord, body: unknown): SharingReply {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const keys = Object.keys(input);
  const byName = keys.length === 1 && typeof input.teamName === "string";
  if (!byName && (keys.length !== 1 || typeof input.teamId !== "string" || !/^[\w-]+$/.test(input.teamId))) return fail(400, "teamId or teamName is required");
  let teamId: string;
  if (byName) {
    const team = sharingTeamsRead(store, bot).find(item => item.name === input.teamName);
    if (!team?.covered) return fail(404, `${bot.name} is not shared with that team.`);
    if (!team.id) {
      if (bot.hidden) return fail(409, `${bot.name} is archived. Bring ${bot.name} back before opening new work.`);
      if (teamChangeOpen()) return fail(409, JOURNAL_OPEN);
      if (team.name.length > 60) return fail(400, `The name ${team.name} is longer than 60 characters. Rename the team to 60 characters or fewer, then open this work.`);
      team.id = teamIdFor(team.name);
    }
    teamId = team.id;
  } else teamId = input.teamId as string;
  const existing = bot.tasks?.find(task => task.sharedWork?.teamId === teamId && !task.sharedWork.quarantined);
  if (existing) return { status: 200, body: { threadId: existing.threadId } };
  if (!sharedWithTeam(bot, teamId)) return fail(404, `${bot.name} is not shared with that team.`);
  if (bot.hidden) return fail(409, `${bot.name} is archived. Bring ${bot.name} back before opening new work.`);
  const task = store.openSharedWork(bot.id, teamId);
  if (task && "refused" in task) return fail(409, task.refused);
  return task ? { status: 200, body: { threadId: task.threadId } } : fail(404, "no such bot");
}

/** One entry point for every sharing route. Null when the request is not
 * one of them. `desktop` is the caller's proof; `visible` says whether a
 * caller that is not the desktop may see this bot. Everything but
 * `work-threads` is the owner's desk only: route-policy.ts already refused
 * any other caller, and the check here is the second layer. */
export async function sharingRoute(input: {
  method: string; path: string; desktop: boolean; visible: (botId: string) => boolean;
  readBody: () => Promise<unknown>; deps: SharingRouteDeps;
}): Promise<SharingReply | null> {
  const { store } = input.deps;
  const owned = (id: string): BotRecord | SharingReply => {
    if (!input.desktop) return fail(404, "no such route");
    return store.bot(id) ?? fail(404, "no such bot");
  };
  const isBot = (value: BotRecord | SharingReply): value is BotRecord => "threadId" in value;
  let m = /^\/api\/bots\/([\w-]+)\/work-threads$/.exec(input.path);
  if (m && input.method === "POST") {
    const bot = store.bot(m[1]);
    if (!bot || !input.desktop && !input.visible(m[1])) return fail(404, "no such bot");
    return openWorkThread(store, bot, await input.readBody());
  }
  m = /^\/api\/bots\/([\w-]+)\/sharing$/.exec(input.path);
  if (m && input.method === "GET") { const bot = owned(m[1]); return isBot(bot) ? { status: 200, body: sharingView(store, bot, input.deps.generationFor) } : bot; }
  if (m && input.method === "PATCH") { const bot = owned(m[1]); return isBot(bot) ? patchSharing(input.deps, bot, await input.readBody()) : bot; }
  m = /^\/api\/bots\/([\w-]+)\/sharing\/skills$/.exec(input.path);
  if (m && input.method === "POST") {
    const bot = owned(m[1]); if (!isBot(bot)) return bot;
    const body = await input.readBody() as Record<string, unknown> | null;
    if (!body || typeof body.name !== "string" || typeof body.revision !== "string" || typeof body.everyTeam !== "boolean") return fail(400, "name, revision and everyTeam are required");
    const result = setSkillEveryTeam(bot.id, body.name, body.revision, body.everyTeam);
    return "error" in result ? fail(result.status, result.error) : { status: 200, body: { skill: result } };
  }
  m = /^\/api\/bots\/([\w-]+)\/sharing\/copy$/.exec(input.path);
  if (m && input.method === "POST") { const bot = owned(m[1]); return isBot(bot) ? copyForTeam(store, bot, await input.readBody()) : bot; }
  m = /^\/api\/bots\/([\w-]+)\/general-notes$/.exec(input.path);
  if (m && input.method === "GET") { const bot = owned(m[1]); return isBot(bot) ? { status: 200, body: generalNotes(bot) } : bot; }
  if (m && input.method === "PUT") { const bot = owned(m[1]); return isBot(bot) ? putGeneralNotes(bot, await input.readBody()) : bot; }
  return null;
}

/** GET /api/team-sections additions (SPEC-X 12.2): the team's id, and the
 * bots from other teams shared with it, each with the owner's load line. A
 * read: a team with no identity yet has a null id and nothing is minted. */
export function teamSharing(store: Store, label: string, generationFor?: (threadId: string) => string | undefined): { id: string | null; sharedIn: Array<{ botId: string; name: string; from: string; load: string }> } {
  const key = sectionKey(label);
  const row = key ? database().prepare("SELECT team_id FROM team_identities WHERE label=? AND retired_at IS NULL").get(key) : undefined;
  return {
    id: row ? String(row.team_id) : null,
    sharedIn: key ? store.bots.filter(bot => !bot.hidden && sectionKey(bot.section) !== key && bot.sharedWith && bot.sharedWith.mode !== "none"
      && sharingTeamsRead(store, bot).some(team => team.name === key && team.covered))
      .map(bot => ({ botId: bot.id, name: bot.name, from: sectionKey(bot.section) || "General", load: sharedLoadLine(bot, true, generationFor) })) : [],
  };
}
