// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { join } from "node:path";
import { DATA_DIR, loadConfig } from "./config.ts";
import { database } from "./database.ts";
import { type BotRecord, type GroupRecord, type Store, type TaskRecord, sectionKey, isWorkspaceChief, isIndividualAssistant } from "./store.ts";
import { OWNER, assertHumanPrincipal, bindHumanThread, humanTask, isLocalOwner, threadHumanPrincipal, type HumanPrincipal } from "./human-principals.ts";
import { teamIdFor, teamMemoryKey } from "./team-identities.ts";
import { outOfReachLine } from "./coordination-target.ts";
import { isAutomationThread, mayMessage } from "./message-allow.ts";
import type { ExecutionAudience } from "./work-admission.ts";
import { turnRequestByGeneration } from "./project-tool-routing.ts";
import { threadCaptureScope } from "./memory/capture-scope.ts";
import { ensureScope } from "./memory/policy.ts";
import { isCloseTurnRequest } from "./project-close.ts";
import { roomRequest } from "./room-requests.ts";
import { scopeRow } from "./memory/scope-id.ts";

export type PartitionRef = { kind: "home" } | { kind: "team"; teamId: string } | { kind: "project"; groupId: string } | { kind: "room"; groupId: string } | { kind: "general" };
export type Partition = PartitionRef | { kind: "isolated"; threadId: string } | { kind: "project"; groupId: string; homeMember: boolean };
let currentStore: Store | undefined;
let turnLookup: (generation: string) => { botId: string; threadId: string } | undefined = () => undefined;
export function setExecutionTurnLookup(lookup: typeof turnLookup): void { turnLookup = lookup; }
export function setExecutionStore(store: Store): void { currentStore = store; }
export function executionStore(): Store | undefined { return currentStore; }
const home = (): PartitionRef => ({ kind: "home" });
export const isHomePartition = (p: Partition) => p.kind === "home" || p.kind === "project" && "homeMember" in p && p.homeMember;
function identity(label: string) { return label ? database().prepare("SELECT * FROM team_identities WHERE label=? AND retired_at IS NULL").get(label) : undefined; }
function liveTeam(id: string) { return database().prepare("SELECT * FROM team_identities WHERE team_id=? AND retired_at IS NULL").get(id); }
function isHomeTeam(bot: BotRecord, id: string) { return liveTeam(id)?.label === sectionKey(bot.section); }
export function sharedWithTeam(bot: BotRecord, id: string): boolean {
  const team = liveTeam(id);
  if (!team || team.label === sectionKey(bot.section) || isIndividualAssistant(bot) || isWorkspaceChief(bot)) return false;
  const members = currentStore?.bots.filter(member => sectionKey(member.section) === team.label) ?? [];
  if (members.length && members.every(isIndividualAssistant)) return false;
  return bot.sharedWith?.mode === "all" || bot.sharedWith?.mode === "list" && bot.sharedWith.teams.some(team => team.id === id);
}
function projectExists(id: string) { return !!database().prepare("SELECT 1 FROM project_settings WHERE group_id=?").get(id); }
function homeSpace(bot: BotRecord, group: GroupRecord, roster: Pick<Store, "bots">): boolean {
  return !group.dm && group.memberIds.includes(bot.id) && sectionKey(group.section) === sectionKey(bot.section)
    && group.memberIds.every(id => { const member = roster.bots.find(b => b.id === id); return member && sectionKey(member.section) === sectionKey(bot.section); });
}
function marker(bot: BotRecord, group: GroupRecord, roster: Pick<Store, "bots">): NonNullable<GroupRecord["partitionedFor"]>[string] {
  const label = sectionKey(group.section), team = identity(label);
  if (team && label !== sectionKey(bot.section) && sharedWithTeam(bot, String(team.team_id))
    && group.memberIds.every(id => { const b = roster.bots.find(b => b.id === id); return b && (sectionKey(b.section) === label || sharedWithTeam(b, String(team.team_id))); })) return { kind: "team", teamId: String(team.team_id) };
  return { kind: "room" };
}
/** Mutates only markers; the caller saves these with the post-mutation roster. */
export function markPartitions(store: Pick<Store, "bots" | "groups">): boolean {
  let changed = false;
  for (const group of store.groups) {
    if (group.dm || projectExists(group.id)) continue;
    for (const bot of store.bots) {
      if (bot.partitionedAt === undefined || !group.memberIds.includes(bot.id) || group.partitionedFor?.[bot.id] || homeSpace(bot, group, store)) continue;
      // A legacy label over 60 characters cannot hold an identity: no mint, the room marker stands (N2).
      if (sectionKey(group.section) && sectionKey(group.section).length <= 60 && !identity(sectionKey(group.section)) && !database().prepare("SELECT 1 FROM team_identities WHERE op IS NOT NULL").get()) teamIdFor(sectionKey(group.section));
      (group.partitionedFor ??= {})[bot.id] = marker(bot, group, store); changed = true;
    }
  }
  return changed;
}
export function threadPartition(bot: BotRecord, threadId: string): Partition {
  const store = currentStore;
  const task = bot.tasks?.find(t => t.threadId === threadId);
  const group = store?.groups.find(g => g.threadId === threadId || g.tasks?.some(t => t.threadId === threadId));
  const desk = task?.channelProjectDesk ?? store?.bots.flatMap(member => member.tasks ?? []).find(t => t.threadId === threadId)?.channelProjectDesk;
  const project = desk && store?.groups.find(g => g.id === desk.groupId && g.memberIds.includes(bot.id));
  const projectGroup = project || (group && projectExists(group.id) ? group : undefined);
  if (projectGroup && store) return { kind: "project", groupId: projectGroup.id, homeMember: homeSpace(bot, projectGroup, store) && !projectGroup.partitionedFor?.[bot.id] };
  if (bot.partitionedAt === undefined) return home();
  if (task?.sharedWork) return task.sharedWork.quarantined ? { kind: "isolated", threadId } : { kind: "team", teamId: task.sharedWork.teamId };
  if (group?.dm) {
    const audience = group.dmAudience;
    return audience?.kind === "isolated" ? { kind: "isolated", threadId } : audience ?? home();
  }
  if (desk && !project) return { kind: "project", groupId: desk.groupId, homeMember: false };
  const room = group;
  if (room && store) {
    const marked = room.partitionedFor?.[bot.id];
    if (marked) return marked.kind === "isolated" ? { kind: "isolated", threadId } : marked.kind === "team" && !isHomeTeam(bot, marked.teamId) ? marked : { kind: "room", groupId: room.id };
    if (homeSpace(bot, room, store)) return home();
    const value = marker(bot, room, store);
    return value.kind === "team" ? value : { kind: "room", groupId: room.id };
  }
  return task || bot.threadId === threadId ? home() : { kind: "isolated", threadId };
}
function bindingFits(bot: BotRecord, threadId: string, tag: ExecutionAudience | null): boolean {
  const partition = threadPartition(bot, threadId), room = currentStore?.groups.find(g => !g.dm && (g.threadId === threadId || g.tasks?.some(t => t.threadId === threadId)));
  if (partition.kind === "isolated" || partition.kind === "general") return false;
  if (room && !tag) return true;
  if (room && tag?.kind === "project") return room.id === tag.projectId && projectExists(room.id);
  if (!tag || tag.kind === "home") return isHomePartition(partition) || partition.kind === "room";
  if (tag.kind === "project") return partition.kind === "project" && partition.groupId === tag.projectId;
  return partition.kind === "team" && partition.teamId === tag.team && (room !== undefined || sharedWithTeam(bot, tag.team)) || isHomePartition(partition) && isHomeTeam(bot, tag.team);
}
export function effectiveAudience(bot: BotRecord, threadId: string, tag: ExecutionAudience | null): Partition {
  if (!bindingFits(bot, threadId, tag)) throw new Error("This request no longer fits this conversation. Ask again.");
  return threadPartition(bot, threadId);
}
export function homeThread(bot: BotRecord): TaskRecord {
  const store = currentStore; if (!store) throw new Error("Execution store is unavailable");
  const active = bot.tasks?.find(t => t.threadId === bot.threadId);
  if (bot.partitionedAt === undefined && active && isLocalOwner(threadHumanPrincipal(active.threadId))) return active;
  const owner = OWNER;
  const eligible = (task: TaskRecord) => !task.sharedWork && isHomePartition(threadPartition(bot, task.threadId))
    && JSON.stringify(threadHumanPrincipal(task.threadId)) === JSON.stringify(owner)
    && !database().prepare("SELECT 1 FROM messages WHERE thread_id=? AND json_extract(json, '$.routineRunPrompt') IS NOT NULL LIMIT 1").get(task.threadId);
  const task = bot.tasks?.find(t => t.threadId === bot.threadId && eligible(t)) ?? bot.tasks?.filter(eligible).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (task) return task;
  const created = store.createTask(bot.id, "Direct chat", false); if (!created) throw new Error("Unknown bot");
  bindHumanThread(created.threadId, owner); return created;
}
/** Defaults do not create tasks when an existing home thread is selected. */
export function defaultThreadId(bot: BotRecord): string {
  return bot.partitionedAt === undefined || isHomePartition(threadPartition(bot, bot.threadId)) ? bot.threadId : homeThread(bot).threadId;
}
export function sourceExecutionAudience(botId: string | undefined, threadId: string, parentRequestId?: string, boundOnly = false): ExecutionAudience | null {
  return boundOnly && !parentRequestId ? null : requestExecutionAudience(botId, threadId, parentRequestId);
}
export function audienceTask(store: Store, botOrId: BotRecord | string, principal: HumanPrincipal, tag: ExecutionAudience | null = null): TaskRecord | null {
  assertHumanPrincipal(principal);
  const bot = typeof botOrId === "string" ? store.bot(botOrId) : botOrId; if (!bot) return null;
  if (!isLocalOwner(principal)) return humanTask(store, bot.id, principal);
  if (tag?.kind === "team" && !isHomeTeam(bot, tag.team)) return sharedWithTeam(bot, tag.team) ? store.createSharedWorkTask(bot.id, tag.team) : null;
  if (tag?.kind === "project") { const group = store.groups.find(g => g.id === tag.projectId && g.memberIds.includes(bot.id)); return group ? store.ensureProjectDesk(bot.id, group.id, group.name) : null; }
  return homeThread(bot);
}
export function partitionRoots(bot: BotRecord, partition: Partition, dataDir = DATA_DIR): string[] {
  const id = bot.id;
  if (!/^[\w-]+$/.test(id)) throw new Error("Invalid bot workspace");
  if (partition.kind === "home") return [join(dataDir, "workspaces", id)];
  if (partition.kind === "general") return [join(dataDir, "workspaces", id + ".general")];
  const key = partition.kind === "team" ? partition.teamId : partition.kind === "isolated" ? partition.threadId : partition.groupId;
  if (!/^[\w-]+$/.test(key)) throw new Error("Invalid partition workspace");
  const suffix = partition.kind === "team" ? "teams" : partition.kind === "project" ? "projects" : "rooms";
  return [join(dataDir, "workspaces", id + "." + suffix, key)];
}
/** The managed output namespace follows the same partition as files and notebooks. */
export function managedOutputWorkspace(dataDir: string, botId: string, threadId: string): string {
  const bot = currentStore?.bot(botId);
  const partition = bot?.partitionedAt === undefined ? home() : threadPartition(bot, threadId);
  return partitionRoots(bot ?? { id: botId } as BotRecord, isHomePartition(partition) ? home() : partition, dataDir)[0];
}
export function issueExecutionAudience(botId: string | undefined, threadId: string, rootRequestId: string): ExecutionAudience | null {
  const bot = botId ? currentStore?.bot(botId) : currentStore?.bots.find(b => b.tasks?.some(t => t.threadId === threadId));
  const partition = bot ? threadPartition(bot, threadId) : undefined;
  if (partition?.kind === "team") return { v: 1, kind: "team", human: "owner", team: partition.teamId, rootRequestId };
  const group = currentStore?.groups.find(g => g.threadId === threadId || g.tasks?.some(t => t.threadId === threadId));
  if (partition?.kind === "project" || !bot && group && projectExists(group.id)) return { v: 1, kind: "project", human: "owner", projectId: partition?.kind === "project" ? partition.groupId : group!.id, rootRequestId };
  return null;
}
export function requestExecutionAudience(botId: string | undefined, threadId: string, parentRequestId?: string, rootRequestId = threadId): ExecutionAudience | null {
  if (parentRequestId) {
    const row = database().prepare("SELECT execution_audience FROM room_requests WHERE id=?").get(parentRequestId);
    if (!row) throw new Error("Unknown request parent");
    return row.execution_audience ? JSON.parse(String(row.execution_audience)) as ExecutionAudience : null;
  }
  return issueExecutionAudience(botId, threadId, rootRequestId);
}
/** Admission assigns the new shared root's actual row id, never a model value. */
export function issueWorkAudience(fromBotId: string | undefined, toBotId: string | undefined, threadId: string, tag: ExecutionAudience | null, requestId: string, ownerAudience: boolean): ExecutionAudience | null {
  if (tag || !fromBotId || !toBotId || !currentStore?.bot(fromBotId)) return tag;
  const allowed = authorizeWork({ edge: "peer", requesterBotId: fromBotId, requesterThreadId: threadId, targetBotId: toBotId, tag: null, ownerAudience, verb: "ask" });
  return allowed.ok && allowed.issue ? { ...allowed.issue, rootRequestId: requestId } : null;
}
export function validExecutionAudience(value: unknown): value is ExecutionAudience {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>, id = (x: unknown) => typeof x === "string" && /^[\w-]+$/.test(x);
  return v.v === 1 && v.human === "owner" && id(v.rootRequestId) && (v.kind === "home" || v.kind === "team" && id(v.team) || v.kind === "project" && id(v.projectId));
}

export type WorkEdge =
  | { edge: "peer"; requesterBotId: string; requesterThreadId: string; targetBotId: string; verb: "ask" | "delegate" | "message" | "assign" | "review"; tag: ExecutionAudience | null; ownerAudience: boolean; parentRequestId?: string; unattended?: boolean }
  | { edge: "dispatch"; requestId: string; targetBotId: string; targetThreadId: string; tag: ExecutionAudience | null; kind: "room" | "shared" | "card" | "delegation" | "wake"; ownerOrigin?: boolean }
  | { edge: "resume"; requestId?: string; generation: string; botId: string; threadId: string; ownerOrigin?: boolean }
  | { edge: "deliver"; requestId?: string; generation?: string; fromBotId: string; destinationThreadId: string; ownerOrigin?: boolean };
export type WorkRefusal = "not_reachable" | "shared_paused" | "sharing_removed" | "team_deleted" | "binding_mismatch" | "archived";
type WorkResult = { ok: true; clause: 1 | 2 | 3 | 4 | 5 | "owner" | "finishing"; issue?: ExecutionAudience } | { ok: false; code: WorkRefusal; line: string; retry: "queue" | "never" };
export function requestSourceThread(requestId: string, db = database()): string | undefined {
  const row = db.prepare("SELECT parent_id,return_thread_id,root_thread_id,work_item_id FROM room_requests WHERE id=?").get(requestId);
  if (!row) return undefined;
  // A card run or review names its return bot and no return thread: it returns to the project thread its lineage
  // started in, never to the desk of the card run that came before it.
  if (row.work_item_id && row.return_thread_id === null) return String(row.root_thread_id);
  const parent = row.parent_id ? db.prepare("SELECT target_thread_id FROM room_requests WHERE id=?").get(row.parent_id) : undefined;
  return String(parent?.target_thread_id ?? row.return_thread_id ?? row.root_thread_id);
}
/** A Murage wake about an owner card's run (an `assign` of a card nobody returns to) in its own project: the
 * lead's `wake:review:<run>`, readdressed `wake:review:<run>:<wake>` or re-queued `wake:review:<run>:held:<n>`,
 * to the project's current lead; or `wake:kept:<wake>[:<n>]` to the old lead of that review wake, still a member. */
function ownerCardReviewWake(row: Record<string, unknown>, botId: string): boolean {
  const db = database(), key = String(row.admission_key);
  const run = db.prepare("SELECT * FROM room_requests WHERE id=?").get(String(row.parent_id));
  if (!run || run.verb !== "assign" || !run.work_item_id || run.from_kind !== "owner" || run.return_bot_id !== null || run.group_id !== row.group_id) return false;
  if (!currentStore?.groups.find(group => group.id === row.group_id)?.memberIds.includes(botId)) return false;
  const review = (value: string) => value === `wake:review:${run.id}` || new RegExp(`^wake:review:${run.id}:(held:\\d+|[\\w-]+)$`).test(value);
  if (review(key)) return db.prepare("SELECT lead_bot_id FROM project_settings WHERE group_id=?").get(String(row.group_id))?.lead_bot_id === botId;
  const kept = /^wake:kept:([\w-]+)(?::\d+)?$/.exec(key);
  const split = kept ? db.prepare("SELECT * FROM room_requests WHERE id=?").get(kept[1]) : undefined;
  return !!split && split.verb === "wake" && split.parent_id === run.id && split.to_bot_id === botId && review(String(split.admission_key));
}
export function authorizeWork(input: WorkEdge, continuing = false): WorkResult {
  const store = currentStore;
  const refuse = (code: WorkRefusal, line = "This bot cannot be reached from here."): WorkResult => ({ ok: false, code, line, retry: code === "shared_paused" ? "queue" : "never" });
  const targetId = input.edge === "resume" ? input.botId : input.edge === "deliver" ? input.fromBotId : input.targetBotId;
  const target = store?.bot(targetId);
  if (!store || !target) return refuse("not_reachable");
  if (target.hidden) return refuse("archived", `${target.name} is archived.`);
  const requestId = input.edge === "peer" ? input.parentRequestId : input.requestId ?? ("generation" in input && input.generation ? turnRequestByGeneration.get(input.generation) : undefined);
  const row = requestId ? database().prepare("SELECT * FROM room_requests WHERE id=?").get(requestId) : undefined;
  // A live home turn with no bound row resumes as itself (Claude r3 #2): only non-home threads need a row.
  const homeTurn = input.edge === "resume" && !input.requestId && !row ? turnLookup(input.generation) : undefined;
  const homeResume = !!homeTurn && input.edge === "resume" && homeTurn.botId === target.id && homeTurn.threadId === input.threadId
    && !target.tasks?.find(t => t.threadId === input.threadId)?.sharedWork && isHomePartition(threadPartition(target, input.threadId));
  // A room turn with no request row (a mentionChain hop, a member the room summons) runs by the plain room
  // rule: the target is a member of that room; its partition comes from the thread (C2). A mentionChain hop
  // that waited for a busy member is queued as a room_turn row from the bot (queueRoomMemberTurn, no
  // from_bot_id): it is dispatched by the same rule as the hop that did not wait (0.1.61 lane queuedhop).
  const queuedMention = !!row && row.verb === "room_turn" && row.from_kind === "bot" && !row.from_bot_id;
  const roomMember = input.edge === "dispatch" && input.kind === "room" && (!row || queuedMention) && !!store.groups.find(g => !g.dm && (g.threadId === input.targetThreadId || g.tasks?.some(t => t.threadId === input.targetThreadId)))?.memberIds.includes(target.id);
  if (input.edge !== "peer" && !row && !input.ownerOrigin && !homeResume && !roomMember && !("generation" in input && input.generation && target.tasks?.some(t => t.sharedWork?.finishing?.generation === input.generation))) return refuse("not_reachable");
  // A stopped or finished request never starts or resumes again, whatever sharing says now (Astra r3 #1).
  if ((input.edge === "dispatch" || input.edge === "resume") && row && ["done", "failed", "cancelled", "expired", "unknown"].includes(String(row.state))) return refuse("not_reachable");
  const liveTurn = "generation" in input && input.generation ? turnLookup(input.generation) : undefined;
  if (liveTurn && (liveTurn.botId !== target.id || input.edge === "resume" && liveTurn.threadId !== input.threadId)) return refuse("binding_mismatch");
  const tag = input.edge === "peer" || input.edge === "dispatch" ? input.tag : row?.execution_audience ? JSON.parse(String(row.execution_audience)) as ExecutionAudience : input.edge === "resume" && liveTurn ? issueExecutionAudience(target.id, input.threadId, input.generation) : null;
  const sourceBot = input.edge === "peer" ? store.bot(input.requesterBotId) : undefined;
  const sourcePartition = sourceBot && input.edge === "peer" ? threadPartition(sourceBot, input.requesterThreadId) : undefined;
  const requestedTeam = tag?.kind === "team" ? tag.team : sourcePartition?.kind === "team" ? sourcePartition.teamId : sourceBot ? identity(sectionKey(sourceBot.section))?.team_id : undefined;
  const peerWork = input.edge === "peer" && requestedTeam ? target.tasks?.find(t => t.sharedWork?.teamId === requestedTeam && !t.sharedWork.quarantined) : undefined;
  const threadId = input.edge === "dispatch" ? input.targetThreadId : input.edge === "resume" ? input.threadId : row?.target_thread_id ? String(row.target_thread_id) : liveTurn?.threadId ?? peerWork?.threadId ?? (input.edge === "deliver" && input.generation ? target.tasks?.find(t => t.sharedWork?.finishing?.generation === input.generation)?.threadId : undefined);
  const task = target.tasks?.find(t => t.threadId === threadId);
  const work = task?.sharedWork;
  if ((work || tag?.kind === "team") && row?.not_owner_audience === 1) return refuse("not_reachable");
  if (task?.channelProjectDesk?.archivedAt !== undefined) return refuse("archived", "This project conversation is archived.");
  if (input.edge === "deliver" && target.partitionedAt !== undefined && !threadId) return refuse("binding_mismatch");
  if (input.edge !== "peer" && row) {
    if (row.to_bot_id && row.to_bot_id !== target.id || (input.edge === "dispatch" || input.edge === "resume") && row.target_thread_id && row.target_thread_id !== threadId) return refuse("binding_mismatch");
    if (input.edge === "dispatch" && JSON.stringify(tag) !== JSON.stringify(row.execution_audience ? JSON.parse(String(row.execution_audience)) : null)) return refuse("binding_mismatch");
    if (input.edge === "deliver" && input.destinationThreadId !== requestSourceThread(String(row.id))) return refuse("binding_mismatch");
  }
  const finishing = work?.finishing;
  const generation = input.edge === "resume" || input.edge === "deliver" ? input.generation : undefined;
  const matchesFinish = input.edge !== "peer" && !!finishing && (!!finishing.generation && generation === finishing.generation || !!finishing.requestId && (requestId === finishing.requestId || requestId === `wake:${finishing.requestId}` || row?.parent_id === finishing.requestId && row?.verb === "wake")
    || !!finishing.rootRequestId && tag?.rootRequestId === finishing.rootRequestId && !!row && Number(row.created_at) < (work!.closedAt ?? 0));
  if (work?.closedAt !== undefined && !matchesFinish) return refuse(work.closedReason === "team-deleted" ? "team_deleted" : "sharing_removed", `${target.name} is no longer shared with this team.`);
  if (matchesFinish) return { ok: true, clause: "finishing" };
  // A card or review row from before lane X carries no tag: it binds as its own project's (C4).
  const bindTag: ExecutionAudience | null = !tag && input.edge === "dispatch" && input.kind === "card" && row?.work_item_id && row.group_id && projectExists(String(row.group_id))
    ? { v: 1, kind: "project", human: "owner", projectId: String(row.group_id), rootRequestId: String(row.root_id ?? row.id) } : tag;
  if ((input.edge === "dispatch" || input.edge === "resume") && !bindingFits(target, threadId!, bindTag)) return refuse("binding_mismatch", "This request no longer fits this conversation. Ask again.");
  const flagOn = loadConfig().features?.botsSharedAcrossTeams !== false;
  const running = input.edge === "resume" || input.edge === "deliver" || row?.state === "running" || row?.state === "waiting_owner" || row?.state === "waiting_bot";
  if (input.edge !== "peer") {
    if (work && !flagOn && !running) return refuse("shared_paused", "Sharing is paused.");
    // A project system wake is a Murage wake parented on a finished project run only to ride that run's lineage:
    // a close lesson on its close summary, or a review wake (and the old lead's kept answers split from one) on
    // an owner card's run, which returns to no one. It continues no one's request, so its receipt (the recorded
    // close, project-close.ts; the owner card run and the addressee it is owed to) stands in for the rule below.
    const systemWake = row?.verb === "wake" && row.parent_id && row.from_kind === "murage"
      && (/^(goal-)?close-lesson:/.test(String(row.admission_key)) && isCloseTurnRequest(database(), roomRequest(database(), String(row.id))!)
        || ownerCardReviewWake(row, target.id));
    if (row?.verb === "wake" && row.parent_id && !systemWake) {
      const parent = database().prepare("SELECT * FROM room_requests WHERE id=?").get(row.parent_id);
      if (parent?.to_bot_id === target.id && parent.target_thread_id === threadId) return authorizeWork({ edge: "dispatch", requestId: String(parent.id), targetBotId: target.id, targetThreadId: threadId!, tag, kind: "shared" }, true);
      // A card or review row names its return bot but no return thread: its
      // wake was filed on the project's main thread, which the binding rule
      // above already matched against this dispatch.
      const cardReturn = parent && parent.return_thread_id === null && parent.work_item_id && parent.return_bot_id === target.id ? row.target_thread_id : undefined;
      if (parent && (parent.from_bot_id === target.id && parent.return_thread_id === threadId || cardReturn === threadId) && parent.not_owner_audience !== 1) return { ok: true, clause: tag?.kind === "project" ? 1 : tag?.kind === "team" ? 2 : 4 };
      return refuse("not_reachable");
    }
    if (input.edge === "dispatch" && input.kind === "card") return { ok: true, clause: 1 };
    if (row?.from_kind === "bot" && row.from_bot_id) {
      const parent = row.parent_id ? database().prepare("SELECT target_thread_id FROM room_requests WHERE id=?").get(row.parent_id) : undefined;
      const sourceThread = parent?.target_thread_id ?? row.return_thread_id ?? row.root_thread_id;
      return authorizeWork({ edge: "peer", requesterBotId: String(row.from_bot_id), requesterThreadId: String(sourceThread), targetBotId: target.id, verb: "ask", tag, ownerAudience: row.not_owner_audience !== 1, unattended: Number(row.unattended) === 1, parentRequestId: typeof row.parent_id === "string" ? row.parent_id : undefined }, running);
    }
    // Murage and routine rows are project system work, like cards: common checks and the binding rule only (Claude r3 #1).
    if (row?.from_kind === "murage" || row?.from_kind === "routine") return { ok: true, clause: 1 };
    if (homeResume) return { ok: true, clause: 4 };
    if (roomMember && !input.ownerOrigin) return { ok: true, clause: tag?.kind === "project" ? 1 : 3 };
    return row?.from_kind === "owner" || input.ownerOrigin ? { ok: true, clause: "owner" } : refuse("not_reachable");
  }
  // An archived sender reaches no shared bot; ordinary bots keep the roster rule they had.
  const from = store.bot(input.requesterBotId); if (!from || from.hidden && target.partitionedAt !== undefined) return refuse("not_reachable");
  const partition = threadPartition(from, input.requesterThreadId);
  if (tag?.kind === "team" && !(partition.kind === "team" && partition.teamId === tag.team || partition.kind === "home" && isHomeTeam(from, tag.team))) return refuse("binding_mismatch");
  if (tag?.kind === "project") {
    const project = store.groups.find(group => group.id === tag.projectId);
    if (!bindingFits(from, input.requesterThreadId, tag)) return refuse("binding_mismatch");
    if (!project?.memberIds.includes(target.id)) return refuse("not_reachable", `Add ${target.name} to this project to ask ${target.name} here.`);
  }
  // A team tag is retained when a chain reaches one of that team's home members.
  const effective = tag?.kind === "team" && isHomePartition(partition) && isHomeTeam(from, tag.team) ? { kind: "team" as const, teamId: tag.team } : partition;
  // Plain messaging reach at home: mayMessage, never into a partitioned bot of another team (A8).
  const plainReach = () => mayMessage(from, target, { ownerAudience: input.ownerAudience && input.unattended !== true && !isAutomationThread(from.id, input.requesterThreadId) }) && (target.partitionedAt === undefined || sectionKey(from.section) === sectionKey(target.section) || isWorkspaceChief(from) || isWorkspaceChief(target));
  if (effective.kind === "project") {
    const group = store.groups.find(g => g.id === effective.groupId);
    if (!group?.memberIds.includes(from.id) || !group.memberIds.includes(target.id)) return refuse("not_reachable", `Add ${target.name} to this project to ask ${target.name} here.`);
    // Only the owner's project turn reaches by membership (the old reachProjectRoom gate, C3).
    return input.ownerAudience || plainReach() ? { ok: true, clause: 1 } : refuse("not_reachable");
  }
  if (effective.kind === "team") {
    if (!input.ownerAudience) return refuse("not_reachable");
    const sourceWork = from.tasks?.find(t => t.threadId === input.requesterThreadId)?.sharedWork;
    if (sourceWork?.closedAt !== undefined) {
      const finish = sourceWork.finishing;
      const allowed = finish && input.verb === "ask" && isHomeTeam(target, effective.teamId) && (!!finish.requestId && finish.requestId === input.parentRequestId || !!finish.generation && !input.parentRequestId && turnLookup(finish.generation)?.threadId === input.requesterThreadId);
      if (!allowed) return refuse("sharing_removed");
    }
    const issue = tag ?? { v: 1 as const, kind: "team" as const, human: "owner" as const, team: effective.teamId, rootRequestId: input.requesterThreadId };
    if (isHomeTeam(target, effective.teamId)) return { ok: true, clause: 2, issue };
    if (!sharedWithTeam(target, effective.teamId)) return refuse("not_reachable");
    return !flagOn && !continuing ? refuse("shared_paused", "Sharing is paused.") : { ok: true, clause: 2, issue };
  }
  if (effective.kind === "room") return store.groups.find(g => g.id === effective.groupId)?.memberIds.includes(target.id) && target.partitionedAt === undefined ? { ok: true, clause: 3 } : refuse("not_reachable", `Ask ${target.name} in this room instead.`);
  if (!isHomePartition(effective)) return refuse("not_reachable");
  if (plainReach()) return { ok: true, clause: 4 };
  const label = sectionKey(from.section);
  if (label && label.length <= 60 && input.ownerAudience && from.chiefOfStaff && !identity(label) && !database().prepare("SELECT 1 FROM team_identities WHERE op IS NOT NULL").get()) teamIdFor(label);
  const team = identity(label);
  if (!input.ownerAudience || !from.chiefOfStaff || isWorkspaceChief(from) || !team || !sharedWithTeam(target, String(team.team_id))) return target.partitionedAt === undefined ? refuse("not_reachable", outOfReachLine(from.name, target.name)) : refuse("not_reachable");
  if (!flagOn && !continuing) return refuse("shared_paused", "Sharing is paused.");
  return { ok: true, clause: 5, issue: tag?.kind === "team" ? tag : { v: 1, kind: "team", team: String(team.team_id), human: "owner", rootRequestId: input.parentRequestId ?? input.requesterThreadId } };
}

export function partitionOfScopeKey(kind: string, ownerKey: string): { botId?: string; partition: PartitionRef } | null {
  if (kind === "bot") {
    const match = /^([\w-]+)#(team|project|room):([\w-]+)$/.exec(ownerKey);
    if (match) return { botId: match[1], partition: match[2] === "team" ? { kind: "team", teamId: match[3] } : { kind: match[2] as "project" | "room", groupId: match[3] } };
    if (/^[\w-]+#general$/.test(ownerKey)) return { botId: ownerKey.split("#")[0], partition: { kind: "general" } };
    return /^[\w-]+$/.test(ownerKey) ? { botId: ownerKey, partition: home() } : null;
  }
  if (kind === "project") return { partition: { kind: "project", groupId: ownerKey } };
  if (kind === "room") return { partition: { kind: "room", groupId: ownerKey } };
  if (kind === "conversation") return null;
  if (kind === "team") return { partition: { kind: "team", teamId: ownerKey } };
  return { partition: home() };
}
export function partitionOfScope(scopeId: string): { botId?: string; partition: PartitionRef } | null {
  const row = database().prepare("SELECT kind,owner_key FROM memory_scopes WHERE id=?").get(scopeId);
  if (!row) return null;
  const key = String(row.owner_key);
  if (row.kind === "team") {
    const team = database().prepare("SELECT team_id FROM team_identities WHERE memory_key=?").get(key);
    return { partition: { kind: "team", teamId: team ? String(team.team_id) : key } };
  }
  if (row.kind === "room" && projectExists(key)) return { partition: { kind: "project", groupId: key } };
  if (row.kind === "conversation") {
    const bot = currentStore?.bots.find(b => b.tasks?.some(t => t.threadId === key));
    if (bot) { const partition = threadPartition(bot, key); return partition.kind === "isolated" ? null : { botId: bot.id, partition: isHomePartition(partition) ? home() : partition.kind === "project" ? { kind: "project", groupId: partition.groupId } : partition }; }
  }
  return partitionOfScopeKey(String(row.kind), key);
}
export function learningDestination(input: {
  botId?: string;
  threadId?: string;
  evidenceScopeIds: readonly string[];
  target: "memory" | "skill" | "routine-instructions" | "persona" | "general" | "identity";
}): { ok: true; scopeId?: string; audienceKey: string; partition: PartitionRef }
  | { ok: false; reason: "cross-partition" | "needs-owner-approval" | "retired-partition" } {
  const fail = (reason: "cross-partition" | "needs-owner-approval" | "retired-partition") => ({ ok: false as const, reason });
  const bot = input.botId ? currentStore?.bot(input.botId) : undefined;
  const partitioned = bot?.partitionedAt !== undefined;
  // A skill or routine with no bot has no home to learn into: the owner decides (D's rule).
  if (!bot && input.target !== "memory") return fail("needs-owner-approval");
  if (partitioned && ["skill", "persona", "general"].includes(input.target)) return fail("needs-owner-approval");
  const ids = [...new Set(input.evidenceScopeIds)]; if (!ids.length) return fail("cross-partition");
  const rows = ids.map(id => database().prepare("SELECT kind,owner_key FROM memory_scopes WHERE id=?").get(id));
  const ownedThread = (threadId: string) => currentStore?.bots.some(b => b.tasks?.some(t => t.threadId === threadId));
  // A conversation no bot owns (a pair room) maps like today unless a partitioned bot learns from it: it is
  // resolved against that bot's own threads below (C1).
  const scopes = ids.map((id, index) => partitionOfScope(id) ?? (rows[index]?.kind === "conversation" && !ownedThread(String(rows[index]!.owner_key)) && !partitioned ? { partition: home() } : null));
  if (scopes.some((s, index) => !s && !(partitioned && rows[index]?.kind === "conversation") || s?.botId && (!bot || s.botId !== bot.id))) return fail("cross-partition");
  if (scopes.some(s => s?.partition.kind === "general")) return fail("needs-owner-approval");
  if (ids.some(id => database().prepare("SELECT 1 FROM memory_scopes s JOIN team_identities t ON t.memory_key=s.owner_key WHERE s.id=? AND s.kind='team' AND t.retired_at IS NOT NULL").get(id))) return fail("retired-partition");
  // PIP lived identity (I-4): the bot's own private scope, iff every evidence scope is a conversation of one of
  // this bot's own threads that maps to its home partition. Never a team, project or room partition.
  if (input.target === "identity") {
    const own = (threadId: string) => Boolean(bot && (bot.threadId === threadId || bot.tasks?.some(t => t.threadId === threadId)));
    if (!bot || rows.some(row => !row || row.kind !== "conversation" || !own(String(row.owner_key)))) return fail("cross-partition");
    if (partitioned && rows.some(row => !isHomePartition(threadPartition(bot, String(row!.owner_key))))) return fail("cross-partition");
    return { ok: true, scopeId: ensureScope("bot", bot.id), audienceKey: `bot:${bot.id}:owner`, partition: home() };
  }
  // An unpartitioned bot keeps today's behaviour: always home, one-scope memory keeps its scope (C1).
  if (bot && !partitioned) {
    const audienceKey = `bot:${bot.id}:owner`;
    if (input.target !== "memory") return { ok: true, audienceKey, partition: home() };
    if (ids.length === 1) return { ok: true, scopeId: ids[0], audienceKey, partition: home() };
    const capture = input.threadId ? threadCaptureScope(input.threadId) : undefined;
    const scope = capture?.owner ? scopeRow(database(), capture.kind, capture.owner) : undefined;
    return { ok: true, ...(scope ? { scopeId: String(scope.id) } : {}), audienceKey, partition: home() };
  }
  const normalize = (p: Partition): Partition => isHomePartition(p) || p.kind === "team" && bot && (p.teamId === sectionKey(bot.section) || isHomeTeam(bot, p.teamId)) ? home() : p.kind === "project" ? { kind: "project", groupId: p.groupId } : p;
  const partitions = scopes.map((scope, index) => {
    const row = rows[index]!;
    let partition: Partition = scope?.partition ?? { kind: "isolated", threadId: String(row.owner_key) };
    if (bot && row.kind === "conversation") {
      const thread = String(row.owner_key), group = currentStore?.groups.find(g => g.threadId === thread || g.tasks?.some(t => t.threadId === thread));
      // a partitioned bot never reads another pair's or room's conversation as its own
      partition = group && !group.memberIds.includes(bot.id) && !bot.tasks?.some(t => t.threadId === thread) ? { kind: "isolated", threadId: thread } : threadPartition(bot, thread);
    }
    if (bot?.partitionedAt !== undefined && row.kind === "room") {
      const group = currentStore?.groups.find(group => group.id === row.owner_key);
      const desk = input.threadId && bot.tasks?.find(task => task.threadId === input.threadId && task.channelProjectDesk?.groupId === row.owner_key);
      if (group) partition = threadPartition(bot, desk ? desk.threadId : group.threadId);
    }
    return normalize(partition);
  }), partition = partitions[0];
  if (partition.kind === "isolated" || partitions.some(p => p.kind === "isolated" || JSON.stringify(p) !== JSON.stringify(partition))) return fail("cross-partition");
  if (input.target === "routine-instructions" && partition.kind !== "home") return fail("needs-owner-approval");
  let scopeId: string | undefined = ids[0];
  if (input.target !== "memory") scopeId = undefined;
  else if (ids.length > 1) {
    if (!bot || !input.threadId || JSON.stringify(normalize(threadPartition(bot, input.threadId))) !== JSON.stringify(partition)) return fail("cross-partition");
    const capture = partition.kind === "team" && bot.tasks?.some(t => t.threadId === input.threadId && t.sharedWork) ? { kind: "team", owner: teamMemoryKey(partition.teamId) } : threadCaptureScope(input.threadId);
    if (!capture.owner) return fail("retired-partition");
    const scope = scopeRow(database(), capture.kind, capture.owner);
    if (!scope) return fail("cross-partition"); scopeId = String(scope.id);
  }
  const key = partition.kind === "team" ? partition.teamId : partition.kind === "project" || partition.kind === "room" ? partition.groupId : "";
  const audienceKey = bot ? partition.kind === "home" ? `bot:${bot.id}:owner` : `bot:${bot.id}:${partition.kind}:${key}:owner` : partition.kind === "room" || partition.kind === "project" ? `room:${key}` : `${partition.kind}:${key}:owner`;
  return { ok: true, ...(scopeId !== undefined ? { scopeId } : {}), audienceKey, partition };
}

/** Partition identity used by every bot-to-bot derived-text consumer. */
export function sameThreadPartition(bot: BotRecord, threadId: string, sourceThreadId: string): boolean {
  if (bot.partitionedAt === undefined) return true;
  const key = (p: Partition) => isHomePartition(p) ? "home" : p.kind === "project" ? `project:${p.groupId}` : JSON.stringify(p);
  return key(threadPartition(bot, threadId)) === key(threadPartition(bot, sourceThreadId));
}
export function partitionScopeKey(botId: string, partition: Partition): string | null {
  if (partition.kind === "home" || isHomePartition(partition)) return botId;
  if (partition.kind === "isolated") return null;
  if (partition.kind === "general") return `${botId}#general`;
  return `${botId}#${partition.kind}:${partition.kind === "team" ? partition.teamId : partition.groupId}`;
}

/** The saved image library (prompt blocks, reference packs) a bot's turn in
 * this thread reads and writes (I4). A partitioned bot keeps one per
 * partition, keyed like its memory scopes (`<botId>#team:<T>`): names,
 * versions and limits never cross, in either direction. Home, and every
 * turn of an unpartitioned bot, keep the bot's own id: today's library. */
export function imageLibraryKey(botId: string, threadId: string): string {
  const bot = currentStore?.bot(botId);
  if (!bot || bot.partitionedAt === undefined) return botId;
  const partition = threadPartition(bot, threadId);
  if (isHomePartition(partition)) return botId;
  const key = partition.kind === "team" ? partition.teamId : partition.kind === "isolated" ? partition.threadId
    : partition.kind === "project" || partition.kind === "room" ? partition.groupId : "";
  return `${botId}#${partition.kind}${key ? `:${key}` : ""}`;
}

/** The owner's words for a library key's partition, or "" for a bot's home. */
export function imageLibraryPartitionLabel(key: string): string {
  const match = /^[\w-]+#(team|project|room|isolated|general)(?::([\w-]+))?$/.exec(key);
  if (!match) return "";
  const [, kind, id = ""] = match;
  if (kind === "team") { const label = liveTeam(id)?.label; return label ? `work for ${String(label)}` : "work for a team"; }
  if (kind === "project" || kind === "room") { const group = currentStore?.groups.find(g => g.id === id); return group ? `in ${group.name}` : "in a room"; }
  return kind === "general" ? "every team" : "in a closed conversation";
}
