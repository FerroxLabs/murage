import { restoreHeldPeerAuthority } from './held-peer-authority.ts';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

// Execute the production dispatcher with isolated ports: no server bootstrap or provider.
function dispatcher(mutate: (source: string) => string = source => source) {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function dispatchHeldBotWork(');
  const code = source.slice(start, source.indexOf('function releaseHeldAssignment(', start));
  const js = ts.transpileModule(mutate(code), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const from = { id: 'lead', threadId: 'caller' }, target = { id: 'worker' };
  const pump = vi.fn(), authorize = vi.fn(() => ({ ok: true })), queued = vi.fn((..._args: unknown[]) => ({ result: 'ok', id: 'queued' }));
  const dispatch = new Function('store', 'connectorThread', 'authorizeWork', 'sourceExecutionAudience', 'boundaryCommsPort', 'MAX_COMMS_DEPTH', 'pumpRoomDispatcher', 'releaseHeldAssignment', 'restoreHeldPeerAuthority', 'scheduleCoordinationDrain', js + '; return dispatchHeldBotWork;')(
    { activeBot: () => from }, () => true, authorize, () => null, { queueDelegation: queued }, 4, pump, pump, restoreHeldPeerAuthority, pump,
  );
  return { dispatch, from, target, pump, queued, authorize };
}
it('T12: a held project assignment reaches its normal dispatch path after activation', () => {
  const { dispatch, target, pump } = dispatcher();
  expect(() => dispatch(target, { kind: 'assign', fromBotId: 'lead', fromThreadId: 'caller', ref: 'admitted-assignment', text: 'Review the onboarding flow.' })).not.toThrow();
  expect(pump).toHaveBeenCalledTimes(1);
});
it('T12: deferred peer work preserves the admitted depth and audience ceilings', () => {
  const { dispatch, target, queued } = dispatcher();
  const peer = snapshot();
  dispatch(target, { kind: 'delegate', fromBotId: 'lead', fromThreadId: 'caller', text: 'Review the onboarding flow.', peer });
  expect(queued.mock.calls[0]?.[1]).toMatchObject({ depth: peer.depth, notOwnerAudience: peer.notOwnerAudience, unattended: peer.unattended, eventId: peer.eventId, routineAuthority: peer.routineAuthority, executionAudience: peer.executionAudience, coordination: peer.coordination });
  expect(queued.mock.calls[0]?.[5]).toEqual(peer);
});

function snapshot() {
  return { version: 1 as const, handoffId: 'held-original', depth: 3, notOwnerAudience: true, unattended: true, eventId: 'event-fixture',
    routineAuthority: { permissionMode: 'ask' as const, triggerSource: 'schedule' as const },
    executionAudience: { v: 1 as const, kind: 'team' as const, human: 'owner' as const, team: 'team-original', rootRequestId: 'root-original' },
    parentRequestId: 'parent-original', coordination: { rootId: 'coord-original', path: ['lead', 'worker'] },
    source: { botId: 'lead', threadId: 'caller', generation: 'generation-original', providerTurnId: 'provider-original' } };
}
it('release reauthorizes using only the original audience and parent', () => {
  const { dispatch, target, authorize } = dispatcher();
  dispatch(target, { kind: 'ask', fromBotId: 'lead', fromThreadId: 'caller', text: 'Work', peer: snapshot() });
  expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ ownerAudience: false, unattended: true, tag: snapshot().executionAudience, parentRequestId: 'parent-original' }));
});
it.each(['depth', 'notOwnerAudience', 'unattended', 'eventId', 'routineAuthority', 'executionAudience', 'source', 'coordination'])('a lost %s refuses without dispatch', key => {
  const { dispatch, target, queued } = dispatcher();
  const peer: any = snapshot(); delete peer[key];
  expect(() => dispatch(target, { kind: 'delegate', fromBotId: 'lead', fromThreadId: 'caller', text: 'Work', peer })).toThrow('original permissions');
  expect(queued).not.toHaveBeenCalled();
});
it.each([
  ['reset-depth', 'depth: peer.depth', 'depth: 0'],
  ['drop-audience-ceiling', 'notOwnerAudience: peer.notOwnerAudience', 'notOwnerAudience: false'],
  ['drop-event-ceiling', 'eventId: peer.eventId ?? undefined', 'eventId: undefined'],
  ['drop-routine-ceiling', 'routineAuthority: peer.routineAuthority ?? undefined', 'routineAuthority: undefined'],
])('mutant %s is killed by the deferred authority contract', (name, before, after) => {
  const { dispatch, target, queued } = dispatcher(source => { expect(source.split(before)).toHaveLength(2); return source.replace(before, after); });
  dispatch(target, { kind: 'delegate', fromBotId: 'lead', fromThreadId: 'caller', text: 'Work', peer: snapshot() });
  expect(() => expect(queued.mock.calls[0]?.[1]).toMatchObject({ depth: 3, notOwnerAudience: true, eventId: 'event-fixture', routineAuthority: snapshot().routineAuthority })).toThrow();
  console.info(`KILLED ${name} by deferred authority contract`);
});
it('production project/team hooks persist the held request and release it through the normal dispatcher', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function releaseHeldAssignment('), end = source.indexOf('function validateReviewedBot(', start);
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const bot = { id: 'worker', staged: {} };
  const request = { id: 'original-request', verb: 'assign', toBotId: bot.id, fromBotId: 'lead', rootThreadId: 'room', state: 'queued', payloadText: 'Work' };
  const hold = vi.fn(), pump = vi.fn();
  const hooks = new Function('store', 'botOutsideWrites', 'roomRequest', 'database', 'pumpRoomDispatcher', 'recordHeldAssignmentRoutineAuthority', 'routinePeerSource', js + '; return { holdStagedAssignment, releaseHeldAssignment };')(
    { bot: () => bot }, { hold }, () => request, () => ({}), pump, vi.fn(), () => undefined,
  );
  expect(hooks.holdStagedAssignment(request)).toBe(true);
  expect(hold).toHaveBeenCalledWith(bot.id, { kind: 'assign', fromBotId: 'lead', fromThreadId: 'room', ref: request.id, text: 'Work' });
  delete (bot as { staged?: unknown }).staged;
  hooks.releaseHeldAssignment(bot, hold.mock.calls[0][1]);
  expect(pump).toHaveBeenCalledTimes(1);
  request.toBotId = 'someone-else';
  expect(() => hooks.releaseHeldAssignment(bot, hold.mock.calls[0][1])).toThrow('no longer available');
  expect(pump).toHaveBeenCalledTimes(1);
  expect(source).toContain('ready: request => !holdStagedAssignment(request)');
  expect(source).toContain('if (holdStagedAssignment(request)) return false;');
});
