// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: store-patchbot (execution roster). Consumer owner: recall-scope-c (cooperative partition construction).
import type { DatabaseSync } from 'node:sqlite';
import { executionStore, isHomePartition, partitionScopeKey, type Partition } from '../execution-audience.ts';
import { isIndividualAssistant, isWorkspaceChief, sectionKey, type BotRecord, type GroupRecord, type TaskRecord } from '../store.ts';
import { ensureScope } from './policy.ts';
import { ConstructionBudget } from './recall-construction.ts';
import { teamMemoryKey } from '../team-identities.ts';

/** Same rules as filterPartitionScopes/threadPartition. All inherited roster walks are explicit resumable steps.
 * Indexes are private to this fenced build, never a cache that outlives a structural revision. */
export function* recallPartitionSteps(db: DatabaseSync, botId: string, threadId: string, owner: boolean, personId: string,
  budget: ConstructionBudget, ensure: typeof ensureScope = ensureScope): Generator<void, { base: string[]; allows(scope: string): boolean }> {
  const store = executionStore();
  let bot: BotRecord | undefined;
  for (const item of store?.bots ?? []) { if (!bot && item.id === botId) bot = item; yield; }
  if (!bot || bot.partitionedAt === undefined) return {base: [], allows: () => true};
  const bots = new Map<string, BotRecord>(), tasks = new Map<string, TaskRecord>(), firstTasks = new Map<string, TaskRecord>();
  const rooms = new Map<string, GroupRecord>(), threads = new Map<string, GroupRecord>(), members = new Map<GroupRecord, Set<string>>(), roomThreads = new Map<GroupRecord, Set<string>>();
  const allIndividual = new Map<string, boolean>();
  for (const item of store!.bots) {
    budget.add(item.id, item.section ?? ''); if (!bots.has(item.id)) bots.set(item.id, item);
    const section = sectionKey(item.section); allIndividual.set(section, (allIndividual.get(section) ?? true) && isIndividualAssistant(item)); yield;
    for (const task of item.tasks ?? []) {
      budget.add(task.threadId);
      if (item === bot && !tasks.has(task.threadId)) tasks.set(task.threadId, task);
      if (!firstTasks.has(task.threadId)) firstTasks.set(task.threadId, task); yield;
    }
  }
  const homeSections = new Map<GroupRecord, string | null>();
  for (const room of store!.groups) {
    budget.add(room.id, room.threadId); if (!rooms.has(room.id)) rooms.set(room.id, room);
    const heldThreads=new Set<string>([room.threadId]);roomThreads.set(room,heldThreads);
    if (!threads.has(room.threadId)) threads.set(room.threadId, room); yield;
    for (const task of room.tasks ?? []) { budget.add(task.threadId);heldThreads.add(task.threadId); if (!threads.has(task.threadId)) threads.set(task.threadId, room); yield; }
    const ids = new Set<string>(); let same = true;
    for (const id of room.memberIds) {
      budget.add(id); ids.add(id); const member = bots.get(id);
      if (!member || sectionKey(member.section) !== sectionKey(room.section)) same = false; yield;
    }
    members.set(room, ids); homeSections.set(room, same ? sectionKey(room.section) : null);
  }
  const homeSpace = (room: GroupRecord) => !room.dm && members.get(room)!.has(bot!.id) && homeSections.get(room) === sectionKey(bot!.section);
  // Resolve list membership once as resumable facts, including arbitrarily long sharing lists.
  const sharing = new Map<BotRecord, Set<string>>();
  for (const member of store!.bots) {
    const ids = new Set<string>();
    if (member.sharedWith?.mode === 'list') for (const team of member.sharedWith.teams) { budget.add(team.id); ids.add(team.id); yield; }
    sharing.set(member, ids); yield;
  }
  const sharedWith = (member: BotRecord, id: string, label: string) => label !== sectionKey(member.section) && !isIndividualAssistant(member) && !isWorkspaceChief(member)
    && allIndividual.get(label) !== true && (member.sharedWith?.mode === 'all' || member.sharedWith?.mode === 'list' && sharing.get(member)!.has(id));
  const roomMarks = new Map<GroupRecord, Partition>();
  for (const room of store!.groups) {
    const label = sectionKey(room.section), team = label ? db.prepare('SELECT team_id FROM team_identities WHERE label=? AND retired_at IS NULL').get(label) : undefined;
    let teamRoom = !!team && label !== sectionKey(bot.section) && sharedWith(bot, String(team.team_id), label);
    for (const id of room.memberIds) { const member = bots.get(id); if (!member || sectionKey(member.section) !== label && !(team && sharedWith(member, String(team.team_id), label))) teamRoom = false; yield; }
    roomMarks.set(room, teamRoom ? {kind:'team',teamId:String(team!.team_id)} : {kind:'room',groupId:room.id}); yield;
  }
  const partition = (thread: string): Partition => {
    const task = tasks.get(thread), group = threads.get(thread), desk = task?.channelProjectDesk ?? firstTasks.get(thread)?.channelProjectDesk;
    const held = desk ? rooms.get(desk.groupId) : undefined, project = held && members.get(held)!.has(bot!.id) ? held : undefined;
    const projectGroup = project || (group && db.prepare('SELECT 1 FROM project_settings WHERE group_id=?').get(group.id) ? group : undefined);
    if (projectGroup) return {kind:'project',groupId:projectGroup.id,homeMember:homeSpace(projectGroup) && !projectGroup.partitionedFor?.[bot!.id]};
    if (task?.sharedWork) return task.sharedWork.quarantined ? {kind:'isolated',threadId:thread} : {kind:'team',teamId:task.sharedWork.teamId};
    if (group?.dm) return group.dmAudience?.kind === 'isolated' ? {kind:'isolated',threadId:thread} : group.dmAudience ?? {kind:'home'};
    if (desk && !project) return {kind:'project',groupId:desk.groupId,homeMember:false};
    if (group) {
      const mark = group.partitionedFor?.[bot!.id];
      if (mark) return mark.kind === 'isolated' ? {kind:'isolated',threadId:thread} : mark.kind === 'team'
        && db.prepare('SELECT label FROM team_identities WHERE team_id=? AND retired_at IS NULL').get(mark.teamId)?.label !== sectionKey(bot!.section)
        ? mark : {kind:'room',groupId:group.id};
      return homeSpace(group) ? {kind:'home'} : roomMarks.get(group)!;
    }
    return task || bot!.threadId === thread ? {kind:'home'} : {kind:'isolated',threadId:thread};
  };
  const current = partition(threadId), base: string[] = [];
  const add = (kind: Parameters<typeof ensureScope>[0], key: string) => { base.push(ensure(kind,key)); };
  add('conversation',threadId); yield;
  if (current.kind === 'isolated') return {base, allows: () => false};
  if (owner) {
    add('bot',botId+'#general'); yield;
    const key = partitionScopeKey(botId,current); if (key) add('bot',key); yield;
    if (current.kind === 'team') { const team = teamMemoryKey(current.teamId,db); if (team) add('team',team); yield; }
    if (current.kind === 'project' && !isHomePartition(current) || current.kind === 'room') { add('room',current.groupId); yield; }
    const group = threads.get(threadId); if (current.kind === 'team' && group && !group.dm) { add('room',group.id); yield; }
  }
  const key = (p: Partition) => isHomePartition(p) ? 'home' : p.kind === 'project' ? `project:${p.groupId}` : JSON.stringify(p);
  const currentKey = key(current);
  return {base, allows(id: string) {
    const row = db.prepare('SELECT kind,owner_key FROM memory_scopes WHERE id=?').get(id); if (!row) return false;
    const value = String(row.owner_key);
    if (row.kind === 'preferences') return owner || value === 'person:'+personId;
    if (row.kind === 'conversation') return owner && key(partition(value)) === currentKey;
    if (row.kind === 'room') { const room = rooms.get(value); return !!room && (owner ? key(partition(room.threadId)) === currentKey : roomThreads.get(room)!.has(threadId)); }
    return owner && isHomePartition(current) && (row.kind === 'bot' && value === botId || row.kind === 'team' && value === sectionKey(bot!.section));
  }};
}
