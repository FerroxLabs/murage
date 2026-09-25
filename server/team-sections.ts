// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner team management: rename a team, change who is on it and who leads
// it, and delete it.
//
// What a team is in Murage: a named sidebar section. It is not a stored
// record. It exists while a bot or channel carries its label (`section`),
// the bot in it with `chiefOfStaff` (and no workspace tier) is its lead, and
// there is at most one lead per team. The workspace Chief of Staff sits above
// every team, so it is never added, removed, led or archived here. Channels
// filed under the label are the team's channels; one whose name is the
// team's own name is the team channel and follows a rename.
//
// Three things are keyed by the label and have to move with it: team
// instructions (section-context.ts), team memory (a `team` memory scope),
// and the sidebar layout the renderer keeps (handled client side).
//
// Membership decides reachability (canReach in store.ts), so every change
// that moves a bot between teams or changes a lead calls
// `reachabilityChanged`, which re-checks queued handoffs at once.
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { renameMemoryTeam } from "./memory/authority.ts";
import { readSectionContext, writeSectionContext } from "./section-context.ts";
import { isWorkspaceChief, sectionKey, type BotRecord, type GroupRecord, type Store } from "./store.ts";

/** Sidebar headings that are not teams (src/lib/new-team.ts, plus the
 * Projects heading the sidebar adds). */
export const RESERVED_TEAM_NAMES = ["General", "Bots", "Channels", "Bot Chats", "Pinned", "Projects"] as const;
export const TEAM_NAME_MAX = 60;

export interface TeamDeps {
  /** The owner's memory authority, for moving team memory with its team. */
  memoryTicket: object;
  /** A sentence when this bot's engine cannot lead a team, else null. */
  leadershipError: (bot: BotRecord) => string | null;
  groupWorking: (group: GroupRecord) => boolean;
  /** A channel was archived: pause its schedules, as channel archive does. */
  channelArchived: (group: GroupRecord) => void;
  /** Who can reach whom changed: re-check queued handoffs now. */
  reachabilityChanged: () => void;
}

export interface TeamView {
  name: string;
  revision: string;
  leadId: string | null;
  members: Array<{ id: string; name: string; lead: boolean; chief: boolean; archived: boolean }>;
  channels: Array<{ id: string; name: string; archived: boolean }>;
  hasInstructions: boolean;
}

export class TeamChangeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
const fail = (message: string, status = 409): never => {
  throw new TeamChangeError(message, status);
};

const fold = (label: string) => label.trim().toLocaleLowerCase();
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sectionSchema = z.string().max(200);
const idList = z.array(z.string().min(1).max(180)).max(100);

/** A digest of the organization: every field a team change reads or writes.
 * Names, busy state and anything else are left out, so an unrelated edit
 * does not make the owner start over. */
export function teamRevision(store: Store): string {
  const org = {
    bots: store.bots
      .map((bot) => [bot.id, sectionKey(bot.section), Boolean(bot.chiefOfStaff), bot.chiefScope ?? "", Boolean(bot.individual), Boolean(bot.hidden)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    groups: store.groups
      .map((group) => [group.id, sectionKey(group.section), group.name, Boolean(group.hidden)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  };
  return createHash("sha256").update(JSON.stringify(org)).digest("hex");
}

const teamBots = (store: Store, key: string) => store.bots.filter((bot) => sectionKey(bot.section) === key);
const teamGroups = (store: Store, key: string) => store.groups.filter((group) => sectionKey(group.section) === key);
const isLead = (bot: BotRecord) => bot.chiefOfStaff === true && !isWorkspaceChief(bot);

function existingKey(store: Store, section: unknown): string {
  const parsed = sectionSchema.safeParse(section);
  const key = parsed.success ? sectionKey(parsed.data) : "";
  if (!key || (!teamBots(store, key).length && !teamGroups(store, key).length)) fail("That team no longer exists.", 404);
  return key;
}

function checkRevision(store: Store, revision: unknown) {
  if (!revisionSchema.safeParse(revision).success) fail("Read the team again before changing it.", 400);
  if (revision !== teamRevision(store)) fail("The team changed since you opened it. Check it and try again.");
}

export function describeTeam(store: Store, section: unknown): TeamView {
  const key = existingKey(store, section);
  const bots = teamBots(store, key);
  const lead = bots.find(isLead);
  return {
    name: key,
    revision: teamRevision(store),
    leadId: lead?.id ?? null,
    members: [...bots]
      .sort((a, b) => Number(isLead(b)) - Number(isLead(a)) || Number(Boolean(a.hidden)) - Number(Boolean(b.hidden)))
      .map((bot) => ({ id: bot.id, name: bot.name, lead: isLead(bot), chief: isWorkspaceChief(bot), archived: Boolean(bot.hidden) })),
    channels: teamGroups(store, key)
      .filter((group) => !group.dm)
      .map((group) => ({ id: group.id, name: group.name, archived: Boolean(group.hidden) })),
    hasInstructions: Boolean(readSectionContext(key)?.text.trim()),
  };
}

// ── rename ─────────────────────────────────────────────────────────────

const renameSchema = z.object({ section: sectionSchema, name: z.string().max(200), revision: z.string() }).strict();

export function renameTeam(store: Store, input: unknown, deps: TeamDeps): TeamView {
  const parsed = renameSchema.safeParse(input);
  if (!parsed.success) return fail("Send the team, its new name and the revision you read.", 400);
  const from = existingKey(store, parsed.data.section);
  checkRevision(store, parsed.data.revision);
  const to = parsed.data.name.trim();
  if (!to) fail("Give the team a name.", 400);
  if (to.length > TEAM_NAME_MAX) fail(`Team names can be up to ${TEAM_NAME_MAX} characters.`, 400);
  if ([...to].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) fail("Team names cannot contain control characters.", 400);
  const reserved = RESERVED_TEAM_NAMES.find((name) => fold(name) === fold(to));
  if (reserved) fail(`"${reserved}" is already a heading in the sidebar. Choose another name.`, 400);
  if (to === from) return describeTeam(store, from);
  if (fold(to) !== fold(from)) {
    const visible =
      store.bots.find((bot) => !bot.hidden && fold(sectionKey(bot.section)) === fold(to))?.section ??
      store.groups.find((group) => !group.hidden && fold(sectionKey(group.section)) === fold(to))?.section;
    if (visible) fail(`There is already a team called ${sectionKey(visible)}. Choose another name.`);
    const archivedOnly = [...store.bots, ...store.groups].some((record) => fold(sectionKey(record.section)) === fold(to));
    if (archivedOnly) fail(`An archived bot or channel is still filed under ${to}. Choose another name, or restore it first.`);
  }

  // Team memory moves first: once the bots carry the new label, the roster
  // reconcile creates an empty scope under it and the move could not land.
  let memoryMoved = false;
  try {
    renameMemoryTeam(deps.memoryTicket, from, to);
    memoryMoved = true;
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "MEMORY_TEAM_EXISTS") fail(`Saved team memory already uses the name ${to}, from an earlier team. Choose another name.`);
    // No team memory yet: nothing to carry.
    if (code !== "MEMORY_TEAM_UNKNOWN") throw error;
  }

  const bots = new Map(teamBots(store, from).map((bot) => [bot.id, { section: to } as Partial<BotRecord>]));
  const groups = new Map(
    teamGroups(store, from).map((group) => [
      group.id,
      { section: to, ...(!group.dm && fold(group.name) === fold(from) ? { name: to } : {}) } as Partial<GroupRecord>,
    ]),
  );
  try {
    store.applyTeamChange(bots, groups);
  } catch (error) {
    if (memoryMoved) renameMemoryTeam(deps.memoryTicket, to, from);
    throw error;
  }
  const instructions = readSectionContext(from);
  if (instructions) {
    writeSectionContext(to, instructions.text, instructions.updatedAt);
    writeSectionContext(from, "");
  }
  return describeTeam(store, to);
}

// ── members and lead ───────────────────────────────────────────────────

const membersSchema = z
  .object({
    section: sectionSchema,
    revision: z.string(),
    add: idList.optional(),
    remove: idList.optional(),
    /** absent = unchanged, null = no lead */
    leadId: z.string().min(1).max(180).nullable().optional(),
  })
  .strict();

/** Returns the team after the change, or null when nothing is left in it. */
export function changeTeamMembers(store: Store, input: unknown, deps: TeamDeps): TeamView | null {
  const parsed = membersSchema.safeParse(input);
  if (!parsed.success) return fail("Send the team, the revision you read, and who to add, remove or lead.", 400);
  const key = existingKey(store, parsed.data.section);
  checkRevision(store, parsed.data.revision);
  const add = [...new Set(parsed.data.add ?? [])];
  const remove = new Set(parsed.data.remove ?? []);
  if (add.some((id) => remove.has(id))) fail("A bot cannot be added and removed in the same change.", 400);

  const current = teamBots(store, key);
  const adding = add
    .map((id) => store.bot(id) ?? fail("One of those bots no longer exists.", 404))
    .filter((bot) => sectionKey(bot.section) !== key);
  for (const bot of adding) {
    if (isWorkspaceChief(bot)) fail("The Chief of Staff sits above every team, so it cannot join one.");
    if (bot.hidden) fail(`${bot.name} is archived. Restore it before adding it to a team.`);
  }
  for (const id of remove) {
    const bot = current.find((candidate) => candidate.id === id) ?? fail("One of those bots is not on this team.", 404);
    if (isWorkspaceChief(bot)) fail("The Chief of Staff is not a team member, so it cannot be removed here.");
  }
  const after = [...current.filter((bot) => !remove.has(bot.id)), ...adding];
  const currentLead = current.find(isLead);
  let leadId: string | null =
    parsed.data.leadId !== undefined ? parsed.data.leadId : currentLead && !remove.has(currentLead.id) ? currentLead.id : null;
  if (parsed.data.leadId) {
    const lead = after.find((bot) => bot.id === parsed.data.leadId) ?? fail("Choose a lead who is on the team.");
    if (isWorkspaceChief(lead)) fail("The Chief of Staff cannot lead a single team.");
    if (lead.hidden) fail(`${lead.name} is archived. Restore it before making it the lead.`);
    if (!isLead(lead)) {
      const blocked = deps.leadershipError(lead);
      if (blocked) fail(blocked);
    }
  }
  if (!leadId) leadId = null;

  const patches = new Map<string, Partial<BotRecord>>();
  const patch = (bot: BotRecord, change: Partial<BotRecord>) => patches.set(bot.id, { ...patches.get(bot.id), ...change });
  for (const bot of adding) {
    // Joining a team is the explicit human act here, so an on-its-own mark
    // is cleared rather than refused (store.setChiefOfStaff does the same).
    patch(bot, { section: key, ...(bot.individual ? { individual: undefined } : {}) });
    // It led another team; that team is left without a lead.
    if (isLead(bot) && bot.id !== leadId) patch(bot, { chiefOfStaff: false });
  }
  for (const bot of current) {
    if (!remove.has(bot.id)) continue;
    patch(bot, { section: undefined, ...(isLead(bot) ? { chiefOfStaff: false } : {}) });
  }
  for (const bot of after) {
    if (isWorkspaceChief(bot)) continue;
    const leads = bot.id === leadId;
    if (leads !== isLead(bot) || (leads && patches.get(bot.id)?.chiefOfStaff === false)) {
      patch(bot, { chiefOfStaff: leads, ...(leads && bot.individual ? { individual: undefined } : {}) });
    }
  }
  if (!patches.size) return describeTeam(store, key);
  store.applyTeamChange(patches, new Map());
  deps.reachabilityChanged();
  return teamBots(store, key).length || teamGroups(store, key).length ? describeTeam(store, key) : null;
}

// ── delete ─────────────────────────────────────────────────────────────

const deleteSchema = z.object({ section: sectionSchema, revision: z.string(), bots: z.enum(["keep", "archive"]) }).strict();

/** Delete a team. Nothing is ever deleted with it: its bots and channels
 * stay, either ungrouped or archived (the owner's choice), with every
 * conversation. Its lead stops leading. Its instructions are removed. Its
 * team memory is kept but filed under a key no team label can carry (labels
 * are at most 60 characters), so a later team with the same name starts
 * clean. */
export function deleteTeam(store: Store, input: unknown, deps: TeamDeps): { bots: number; channels: number } {
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return fail("Choose whether to keep or archive the team's bots.", 400);
  const key = existingKey(store, parsed.data.section);
  checkRevision(store, parsed.data.revision);
  const archive = parsed.data.bots === "archive";
  const bots = teamBots(store, key);
  const groups = teamGroups(store, key);
  if (archive) {
    const busy = bots.find((bot) => bot.busy && !bot.hidden && !isWorkspaceChief(bot));
    if (busy) fail(`${busy.name} is working. Let it finish or stop it, then archive the team.`);
    const working = groups.find((group) => !group.hidden && !group.dm && deps.groupWorking(group));
    if (working) fail(`${working.name} is working. Let it finish or stop it, then archive the team.`);
  }
  const botPatches = new Map<string, Partial<BotRecord>>(
    bots.map((bot) => [
      bot.id,
      isWorkspaceChief(bot)
        ? { section: undefined }
        : { section: undefined, ...(isLead(bot) ? { chiefOfStaff: false } : {}), ...(archive ? { hidden: true } : {}) },
    ]),
  );
  const archived = archive ? groups.filter((group) => !group.dm && !group.hidden) : [];
  const groupPatches = new Map<string, Partial<GroupRecord>>(
    groups.map((group) => [group.id, { section: undefined, ...(archived.includes(group) ? { hidden: true } : {}) }]),
  );
  try {
    renameMemoryTeam(deps.memoryTicket, key, `deleted-team:${new Date().toISOString()}:${randomUUID()}:${key}`);
  } catch (error) {
    if (!(error instanceof Error && error.message === "MEMORY_TEAM_UNKNOWN")) throw error;
  }
  store.applyTeamChange(botPatches, groupPatches);
  for (const group of archived) deps.channelArchived(store.group(group.id) ?? group);
  writeSectionContext(key, "");
  deps.reachabilityChanged();
  return { bots: bots.length, channels: groups.filter((group) => !group.dm).length };
}
