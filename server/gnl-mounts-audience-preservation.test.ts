// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from 'vitest';
import { Store } from './store.ts';
import { audienceTask, authorizeWork, issueWorkAudience, setExecutionStore } from './execution-audience.ts';
import { bindHumanThread, humanTask, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding, OWNER } from './human-principals.ts';
import { bindServiceTurn } from './service-no-limits.ts';
import { database } from './database.ts';
import { insertRoomRequest } from './room-requests.ts';
import { parsePendingItem, queueDelegation, handoffItem, handoffRow, unreachableVerdict } from './delegations.ts';
import { teamIdFor } from './team-identities.ts';
import { ownerMemoryTicket } from './memory/authority.ts';

function peers() {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'fixture' }));
  const from = store.createBot({ name: 'Audience source', section: 'Audience A' });
  const target = store.createBot({ name: 'Audience target', section: 'Audience B' });
  store.patchBot(from.id, { autoApprove: true, fullAccess: true, noLimits: true, permissionExplicit: true });
  setExecutionStore(store);
  const ask = (threadId = from.threadId) => authorizeWork({ edge: 'peer', requesterBotId: from.id, requesterThreadId: threadId, targetBotId: target.id, verb: 'ask', tag: null, ownerAudience: true });
  return { store, from, ask };
}
const stopTurns: Array<() => void> = [];
afterEach(() => { for (const stop of stopTurns.splice(0)) stop(); setExecutionStore(undefined as unknown as Store); });
it('R2 durable owner-channel reach retains the channel No limits opt-out', () => {
  const { store, from, ask } = peers();
  const id = observeVerifiedHuman({ platform: 'telegram', authorityId: 'fixture-channel', userId: 'fixture-owner', connectionId: 'fixture-connection' });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: id, expectedRevision: 1, as: 'owner' });
  const task = humanTask(store, from.id, resolveHumanBinding(id))!;
  store.patchBot(from.id, { fullAccessChannelMessages: false });
  expect(ask(task.threadId).ok).toBe(false);
  store.patchBot(from.id, { fullAccessChannelMessages: true });
  expect(ask(task.threadId).ok).toBe(true);
});
it('R2 durable reach gives neither guests nor a legacy fullAccess flag No limits', () => {
  const { store, from, ask } = peers();
  store.patchBot(from.id, { noLimits: false });
  expect(ask().ok).toBe(false);
  store.patchBot(from.id, { noLimits: true });
  const id = observeVerifiedHuman({ platform: 'telegram', authorityId: 'fixture-channel', userId: 'fixture-guest', connectionId: 'fixture-connection' });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: id, expectedRevision: 1, as: 'person' });
  const task = humanTask(store, from.id, resolveHumanBinding(id))!;
  expect(ask(task.threadId).ok).toBe(false);
});

it.each(['team', 'project'])('H1 only the authenticated owner No limits source resolves a target outside its %s partition', (kind) => {
  const { store, from } = peers();
  const target = store.createBot({ name: 'H1 unshared target', section: 'H1 other team' });
  target.partitionedAt = 1;
  target.sharedWith = { mode: 'none', teams: [] };
  from.partitionedAt = 1;
  let tag: import('./work-admission.ts').ExecutionAudience;
  if (kind === 'team') {
    const team = teamIdFor('H1 source team');
    from.tasks!.find(t => t.threadId === from.threadId)!.sharedWork = { teamId: team, createdAt: 1 };
    tag = { v: 1, kind: 'team', team, human: 'owner', rootRequestId: from.threadId };
  } else {
    const other = store.createGroup('H1 other project', [target.id]);
    database().prepare('INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)').run(other.id);
    store.ensureProjectDesk(target.id, other.id, other.name);
    const group = store.createGroup('H1 source project', [from.id]);
    database().prepare('INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)').run(group.id);
    from.tasks!.find(t => t.threadId === from.threadId)!.channelProjectDesk = { groupId: group.id };
    tag = { v: 1, kind: 'project', projectId: group.id, human: 'owner', rootRequestId: from.threadId };
  }
  expect(audienceTask(store, target, OWNER, tag)).toBeNull();
  expect(audienceTask(store, target, OWNER, tag, from.threadId, from.id)?.threadId).toBe(target.threadId);
  store.patchBot(from.id, { noLimits: false });
  expect(audienceTask(store, target, OWNER, tag, from.threadId, from.id)).toBeNull();
  store.patchBot(from.id, { noLimits: true });
  for (const name of ['guest', 'contact']) {
    const binding = observeVerifiedHuman({ platform: 'telegram', authorityId: 'h1', userId: name+'-'+kind, connectionId: 'h1' });
    linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: 'person' });
    const principal = resolveHumanBinding(binding);
    const personTask = store.createTask(from.id, name+' source', false)!;
    bindHumanThread(personTask.threadId, principal);
    const source = from.tasks!.find(t => t.threadId === from.threadId)!;
    personTask.sharedWork = source.sharedWork;
    personTask.channelProjectDesk = source.channelProjectDesk;
    // Even owner-looking service facts cannot lift somebody else's bound thread.
    let active = true; stopTurns.push(() => { active = false; });
    bindServiceTurn('h1-'+kind+'-'+name, personTask.threadId, from.id, () => active, () => ({ ownerAudience: true, origin: 'owner', noLimits: true }));
    expect(authorizeWork({ edge: 'peer', requesterBotId: from.id, requesterThreadId: personTask.threadId, targetBotId: target.id, verb: 'ask', tag, ownerAudience: true }).ok).toBe(false);
    const before = audienceTask(store, target, principal, tag);
    expect(audienceTask(store, target, principal, tag, personTask.threadId, from.id)?.threadId).toBe(before?.threadId);
    // Supplying an owner principal alongside somebody else's source cannot borrow the exception.
    expect(audienceTask(store, target, OWNER, tag, personTask.threadId, from.id)).toBeNull();
  }
});


it('H1 room destination reads live authority for the authenticated member rather than a task lookup', () => {
  const { store, from } = peers();
  const target = store.createBot({ name: 'Live room target', section: 'Live target team' });
  const room = store.createGroup('Live source room', [from.id]);
  database().prepare('INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)').run(room.id);
  const tag = { v: 1 as const, kind: 'project' as const, projectId: room.id, human: 'owner' as const, rootRequestId: room.threadId };
  expect(store.botByThread(room.threadId)).toBeNull();
  expect(store.projectBotForTask(from.id, room.threadId)).toBeNull();
  let active = true; stopTurns.push(() => { active = false; });
  bindServiceTurn('live-room-source', room.threadId, from.id, () => active, () => ({ ownerAudience: true, origin: 'owner', noLimits: true }));
  expect(audienceTask(store, target, OWNER, tag, room.threadId, from.id)?.threadId).toBe(target.threadId);
  expect(audienceTask(store, target, OWNER, tag, room.threadId, target.id)).toBeNull();
  expect(issueWorkAudience(from.id, target.id, room.threadId, tag, 'new-request', true)).toEqual({ v: 1, kind: 'home', human: 'owner', rootRequestId: room.threadId, admission: { kind: 'owner-no-limits-admitted', level: 'no-limits', admittedAt: expect.any(Number), principal: OWNER, requestId: 'new-request', fromBotId: from.id, sourceThreadId: room.threadId, toBotId: target.id } });
  expect(issueWorkAudience(from.id, target.id, room.threadId, tag, 'new-request', false)).toEqual(tag);
  active = false;
  expect(audienceTask(store, target, OWNER, tag, room.threadId, from.id)).toBeNull();
  expect(issueWorkAudience(from.id, target.id, room.threadId, tag, 'new-request', true)).toEqual(tag);
});


it('persisted unbound-room admission survives the ended source and rejects altered bindings', () => {
  const { store, from } = peers();
  const target = store.createBot({ name: 'Persisted target', section: 'Persisted other team' });
  target.partitionedAt = 1;
  const room = store.createGroup('Unbound admission room', [from.id]);
  let active = true; stopTurns.push(() => { active = false; });
  bindServiceTurn('unbound-admission', room.threadId, from.id, () => active, () => ({ ownerAudience: true, origin: 'owner', noLimits: true }));
  const parent = insertRoomRequest(database(), { groupId: room.id, targetThreadId: room.threadId, toBotId: from.id, verb: 'room_turn', fromKind: 'owner', admissionKey: 'unbound-parent', now: 1,
    lineage: { rootThreadId: room.threadId, origin: 'desktop', audienceFingerprint: 'owner', notOwnerAudience: false, unattended: false } }).request;
  expect(parent.executionAudience).toBeNull();
  const child = insertRoomRequest(database(), { parentId: parent.id, groupId: room.id, targetThreadId: target.threadId, fromBotId: from.id, toBotId: target.id, returnThreadId: room.threadId, verb: 'ask', fromKind: 'bot', admissionKey: 'unbound-child', now: 2 }).request;
  const admitted = child.executionAudience as import('./work-admission.ts').ExecutionAudience;
  expect(admitted.admission).toMatchObject({ kind: 'owner-no-limits-admitted', principal: OWNER });
  active = false;
  store.patchBot(from.id, { noLimits: false });
  const dispatch = (tag = admitted) => authorizeWork({ edge: 'dispatch', requestId: child.id, targetBotId: target.id, targetThreadId: target.threadId, tag, kind: 'delegation' });
  expect(dispatch()).toEqual({ ok: true, clause: 4 });
  for (const field of ['requestId', 'fromBotId', 'sourceThreadId', 'toBotId'] as const) {
    const tag = { ...admitted, admission: { ...admitted.admission!, [field]: 'wrong-binding' } };
    database().prepare('UPDATE room_requests SET execution_audience=? WHERE id=?').run(JSON.stringify(tag), child.id);
    expect(dispatch(tag)).toMatchObject({ ok: false, code: 'binding_mismatch' });
  }
  // The dispatch destination remains bound once execution records it.
  database().prepare('UPDATE room_requests SET execution_audience=?, target_thread_id=? WHERE id=?').run(JSON.stringify(admitted), 'wrong-binding', child.id);
  expect(dispatch()).toMatchObject({ ok: false, code: 'binding_mismatch' });
  database().prepare('UPDATE room_requests SET target_thread_id=? WHERE id=?').run(target.threadId, child.id);
  const guest = { ...admitted, admission: { ...admitted.admission!, principal: { personId: 'guest', bindingId: 'local', revision: 1 } } };
  database().prepare('UPDATE room_requests SET execution_audience=? WHERE id=?').run(JSON.stringify(guest), child.id);
  expect(dispatch(guest)).toMatchObject({ ok: false, code: 'binding_mismatch' });
  expect(parsePendingItem({ toBotId: target.id, message: 'fixture', depth: 0, executionAudience: { ...admitted, admission: null } })).toBeNull();
});

it('bot-bound admission follows owner chat switches and refuses guest, shared and foreign chats', () => {
  const { store, from } = peers();
  const target = store.createBot({ name: 'Switch target', section: 'Switch other team' });
  const room = store.createGroup('Switch source room', [from.id]);
  let active = true; stopTurns.push(() => { active = false; });
  bindServiceTurn('switch-admission', room.threadId, from.id, () => active, () => ({ ownerAudience: true, origin: 'owner', noLimits: true }));
  const parent = insertRoomRequest(database(), { groupId: room.id, targetThreadId: room.threadId, toBotId: from.id, verb: 'room_turn', fromKind: 'owner', admissionKey: 'switch-parent', now: 1,
    lineage: { rootThreadId: room.threadId, origin: 'desktop', audienceFingerprint: 'owner', notOwnerAudience: false, unattended: false } }).request;
  const child = insertRoomRequest(database(), { parentId: parent.id, groupId: room.id, fromBotId: from.id, toBotId: target.id, returnThreadId: room.threadId, verb: 'ask', fromKind: 'bot', admissionKey: 'switch-child', now: 2 }).request;
  const tag = child.executionAudience as import('./work-admission.ts').ExecutionAudience;
  expect(tag.admission).not.toHaveProperty('targetThreadId');
  expect(child.targetThreadId).toBeNull();
  active = false;
  store.patchBot(from.id, { noLimits: false });
  const switched = store.createTask(target.id, 'Another owner chat')!;
  const dispatch = (threadId: string, targetBotId = target.id) => authorizeWork({ edge: 'dispatch', requestId: child.id, targetBotId, targetThreadId: threadId, tag, kind: 'delegation' });
  expect(audienceTask(store, target, OWNER, tag)?.threadId).toBe(switched.threadId);
  expect(dispatch(switched.threadId)).toEqual({ ok: true, clause: 4 });
  database().prepare('UPDATE room_requests SET target_thread_id=? WHERE id=?').run(target.tasks!.at(-1)!.threadId, child.id);
  expect(dispatch(switched.threadId)).toMatchObject({ ok: false, code: 'binding_mismatch' });
  database().prepare('UPDATE room_requests SET target_thread_id=NULL WHERE id=?').run(child.id);
  const guestBinding = observeVerifiedHuman({ platform: 'telegram', authorityId: 'switch', userId: 'guest', connectionId: 'switch' });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: guestBinding, expectedRevision: 1, as: 'person' });
  const guest = store.createTask(target.id, 'Guest chat')!;
  bindHumanThread(guest.threadId, resolveHumanBinding(guestBinding));
  expect(dispatch(guest.threadId)).toMatchObject({ ok: false });
  expect(audienceTask(store, target, OWNER, tag)?.threadId).not.toBe(guest.threadId);
  const shared = store.createTask(target.id, 'Shared chat')!;
  shared.sharedWork = { teamId: teamIdFor('Switch shared team'), createdAt: 1 };
  expect(dispatch(shared.threadId)).toMatchObject({ ok: false });
  expect(audienceTask(store, target, OWNER, tag)?.threadId).not.toBe(shared.threadId);
  expect(dispatch(from.threadId)).toMatchObject({ ok: false });
  expect(dispatch(from.threadId, from.id)).toMatchObject({ ok: false });
});


it('direct queue admission is durable without a room row and fails closed on altered identity', () => {
  const { store, from } = peers();
  const target = store.createBot({ name: 'Direct persisted target', section: 'Direct other team' });
  const bus = { store, broadcast: () => {} };
  const before = Date.now();
  const queued = queueDelegation(bus, from, { toBotId: target.id, message: 'accepted direct work', depth: 0 }, 4, from.threadId);
  expect(queued.result).toBe('ok');
  expect(database().prepare('SELECT id FROM room_requests WHERE id=?').get(queued.id!)).toBeUndefined();
  const item = handoffItem(handoffRow(queued.id!)!)!;
  expect(item.executionAudience?.admission).toMatchObject({ principal: OWNER, level: 'no-limits', toBotId: target.id, requestId: queued.id });
  expect(item.executionAudience!.admission!.admittedAt).toBeGreaterThanOrEqual(before);
  store.patchBot(from.id, { noLimits: false, fullAccess: false, autoApprove: false });
  const switched = store.createTask(target.id, 'New owner destination')!;
  expect(audienceTask(store, target, OWNER, item.executionAudience)?.threadId).toBe(switched.threadId);
  expect(unreachableVerdict(bus, from, target, from.threadId, item)).toBeNull();
  for (const field of ['requestId', 'fromBotId', 'sourceThreadId', 'toBotId'] as const) {
    const changed = { ...item, executionAudience: { ...item.executionAudience!, admission: { ...item.executionAudience!.admission!, [field]: 'wrong-binding' } } };
    expect(unreachableVerdict(bus, from, target, from.threadId, changed)).not.toBeNull();
  }
  const legacy = { ...item }; delete legacy.executionAudience;
  expect(unreachableVerdict(bus, from, target, from.threadId, legacy)).not.toBeNull();
  for (const change of [{ level: 'full' }, { admittedAt: 0 }, { admittedAt: null }]) {
    expect(parsePendingItem({ ...item, executionAudience: { ...item.executionAudience, admission: { ...item.executionAudience!.admission, ...change } } })).toBeNull();
  }
});

it('guest direct queue on a No limits bot receives no owner admission', () => {
  const { store, from } = peers();
  const target = store.createBot({ name: 'Guest direct target', section: 'Guest other team' });
  const binding = observeVerifiedHuman({ platform: 'telegram', authorityId: 'direct-guest', userId: 'guest', connectionId: 'direct-guest' });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: 'person' });
  const task = humanTask(store, from.id, resolveHumanBinding(binding))!;
  const bus = { store, broadcast: () => {} };
  const queued = queueDelegation(bus, from, { toBotId: target.id, message: 'guest work', depth: 0, notOwnerAudience: true }, 4, task.threadId);
  expect(queued.result).toBe('ok');
  const item = handoffItem(handoffRow(queued.id!)!)!;
  expect(item.executionAudience?.admission).toBeUndefined();
  expect(unreachableVerdict(bus, from, target, task.threadId, item)).not.toBeNull();
});
