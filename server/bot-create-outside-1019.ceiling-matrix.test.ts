import { readFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { DATA_DIR } from './config.ts';
import { closeDatabase, database } from './database.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import * as permissions from './routine-permissions.ts';
import * as shared from './shared-work.ts';
import { restoreHeldPeerAuthority } from './held-peer-authority.ts';
import { insertRoomRequest, roomRequest } from './room-requests.ts';
import { _resetPending, queueDelegation } from './delegations.ts';
import { _resetOwnerMigration } from './pending-delegations-schema.ts';
import { ownerWorld, LINEAGE } from './testing/handoff-worlds.ts';
import { fakeHost } from './testing/handoff-turn.ts';
import { configureHandoffDispatch, dispatchHandoff } from './handoff-dispatch.ts';
const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const boundary = readFileSync(new URL('./handoff-boundary.ts', import.meta.url), 'utf8');
const functions = new Map<string, string>();
function productionFunction(source: string, name: string): string {
  const cached = functions.get(name); if (cached) return cached;
  const tree = ts.createSourceFile('production.ts', source, ts.ScriptTarget.Latest, true);
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node; ts.forEachChild(node, visit); };
  visit(tree); expect(found, name).toBeDefined(); const code = found!.getText(tree).replace(/^export /, ''); functions.set(name, code); return code;
}
function evaluate(code: string, ports: Record<string, unknown>, result: string): any {
  return new Function(...Object.keys(ports), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + `; return ${result};`)(...Object.values(ports));
}
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); shared._resetDrainDiagnostics(); shared._reloadSharedRoutineAuthority(); });
afterEach(() => { _resetPending(); _resetOwnerMigration(); closeDatabase(); });
const sources = ['owner', 'manual', 'schedule', 'peer', 'cardContinuation', 'memoryRedispatch', 'askerWake', 'unattendedWake', 'webhook', 'channel'] as const;
function admitted(mode: permissions.RoutinePermissionMode, source: typeof sources[number], threadId: string, botId: string, override?: any) {
  const authority = { permissionMode: mode, triggerSource: source === 'schedule' ? 'schedule' as const : 'manual' as const };
  const unattended = ['unattendedWake', 'webhook', 'channel'].includes(source);
  const opts: any = override ?? (source === 'owner' ? {} : source === 'manual' || source === 'schedule' ? { automationSource: source }
    : source === 'cardContinuation' || source === 'memoryRedispatch' ? { [source]: true }
    : source === 'peer' ? { routineAuthority: authority }
    : source === 'webhook' || source === 'channel' ? { automationSource: source, unattended: true, routineAuthority: authority }
    : { askerWake: true, unattended, routineAuthority: authority, askerWakeCeiling: mode });
  const maps = { routinePeerSources: new Map(), conversationCeilings: new Map(), admittedRoutineCeilings: new Map() };
  if (source === 'cardContinuation' || source === 'memoryRedispatch') maps.routinePeerSources.set(threadId, authority);
  const ports: Record<string, any> = { ...permissions, ...maps, threadId, botId, opts, humanIsOwner: true, surfacesForOwner: true,
    bot: permissions.applyRoutinePermissionMode({}, 'unlimited'), profile: permissions.applyRoutinePermissionMode({}, 'unlimited'),
    isUnattended: () => unattended, routineRunLevel: () => ['manual', 'schedule'].includes(source) ? { mode } : null,
    routines: { activeRunOrigin: () => ['manual', 'schedule'].includes(source) ? { triggerSource: source } : null },
    routineConversationMode: () => source === 'peer' ? null : mode, routineWakeCeiling: () => undefined, draftOnlyClamp: () => {} };
  const start = index.indexOf('  const routineLevel = humanIsOwner');
  const end = index.indexOf('  // A draft-only teammate', start);
  const code = productionFunction(index, 'routinePeerSource') + '\n' + index.slice(start, end);
  const result = evaluate(code, ports, '({ applied: botPermissionMode(bot), ceiling: routinePeerSource(threadId, botId), routinePeerSource })');
  return { ...result, unattended, maps };
}
function capture(routinePeerSource: any, botId: string, threadId: string, unattended: boolean, drop = false) {
  const code = productionFunction(boundary, 'captureHeldPeerAuthority');
  const original = 'routineAuthority: bx.routinePeerSource(claim.threadId, claim.botId) ?? null';
  if (drop) expect(code.split(original)).toHaveLength(2);
  const fn = evaluate(drop ? code.replace(original, 'routineAuthority: null') : code, { restoreHeldPeerAuthority, randomUUID }, 'captureHeldPeerAuthority');
  return fn({ internalClaim: { threadId, botId, generation: 'original', depth: 0 }, isUnattended: () => unattended,
    ownerSurfacesByThread: new Map(), routinePeerSource, sourceExecutionAudience: () => null, roomAskParent: () => null,
    coordinationBudget: { advance: () => ({ rootId: randomUUID(), path: [botId, 'B'] }) }, internalOwner: {},
    internalCapabilities: { providerTurnOf: () => 'original-provider' } }, 'B');
}
async function releasedCeiling(kind: 'delegate' | 'ask' | 'assign', mode: permissions.RoutinePermissionMode, source: typeof sources[number], drop = false) {
  const w = ownerWorld(), threadId = w.from.threadId, botId = w.from.id;
  const admission = admitted(mode, source, threadId, botId);
  const peerOptions = evaluate(productionFunction(index, 'peerRoutineTurnOptions'), { ...permissions, routineRunLevel: () => null,
    routinePeerSource: () => undefined, isUnattended: () => false }, 'peerRoutineTurnOptions');
  w.store.patchBot(w.target.id, { autoApprove: true, fullAccess: true, noLimits: true });
  let released: any;
  const base: Record<string, any> = { store: w.store, connectorThread: () => true, authorizeWork: () => ({ ok: true }),
    restoreHeldPeerAuthority, MAX_COMMS_DEPTH: 4, scheduleCoordinationDrain: () => {}, database,
    roomRequest, routinePeerSource: admission.routinePeerSource, recordHeldAssignmentRoutineAuthority: (shared as any).recordHeldAssignmentRoutineAuthority,
    pumpRoomDispatcher: () => {}, botOutsideWrites: { hold: (_id: string, work: any) => { released = work; } },
    boundaryCommsPort: { queueDelegation: (...args: any[]) => (queueDelegation as any)(w.bus, ...args) } };
  const hooks = evaluate(['dispatchHeldBotWork', 'holdStagedAssignment', 'releaseHeldAssignment'].map(name => productionFunction(index, name)).join('\n'), base,
    '({ dispatchHeldBotWork, holdStagedAssignment, releaseHeldAssignment })');
  if (kind === 'assign') {
    const request = insertRoomRequest(database(), { groupId: 'group', verb: 'assign', fromKind: 'bot', fromBotId: botId, toBotId: w.target.id,
      targetThreadId: w.target.threadId, admissionKey: randomUUID(), lineage: LINEAGE(threadId), now: Date.now() }).request;
    w.target.staged = {} as any;
    expect(hooks.holdStagedAssignment(request)).toBe(true);
    delete w.target.staged;
    // The durable request, including its ceiling, survives a changed caller turn.
    for (const map of Object.values(admission.maps) as Map<string, unknown>[]) map.clear();
    shared.recordHeldAssignmentRoutineAuthority(request.id, { permissionMode: 'unlimited', triggerSource: 'manual' });
    shared._reloadSharedRoutineAuthority();
    hooks.dispatchHeldBotWork(w.target, released);
    const options = evaluate(productionFunction(index, 'sharedQueuedCeiling') + '\n' + productionFunction(index, 'sharedTurnOptions'), {
      ...shared, store: w.store, requestSourceThread: () => threadId, peerRoutineTurnOptions: peerOptions,
      requestRunCoordination: () => undefined, routinePeerSources: new Map(), routines: undefined }, 'sharedTurnOptions')(request);
    expect(admitted(mode, 'peer', w.target.threadId, w.target.id, options).applied).toBe(options.routineAuthority?.permissionMode ?? 'unlimited');
    return { applied: admission.applied, ceiling: options.routineAuthority?.permissionMode ?? 'unlimited' };
  }
  const peer = capture(admission.routinePeerSource, botId, threadId, admission.unattended, drop);
  const queued: string[] = [];
  base.boundaryCommsPort.queueDelegation = (...args: any[]) => { const row = (queueDelegation as any)(w.bus, ...args); queued.push(row.id); return row; };
  configureHandoffDispatch({ ...fakeHost(w.bus, () => {}, { stamp: false }), peerOptions,
    startTurn: async (_id, _text, options) => { released = options; } }, { bus: w.bus, approvalBus: w.approvalBus });
  for (const map of Object.values(admission.maps) as Map<string, unknown>[]) map.clear();
  hooks.dispatchHeldBotWork(w.target, { kind, fromBotId: botId, fromThreadId: threadId, text: 'Run task', peer });
  await dispatchHandoff(queued[0], { bus: w.bus, approvalBus: w.approvalBus });
  expect(released, `${kind}/${mode}/${source} dispatched`).toBeDefined();
  expect(admitted(mode, 'peer', w.target.threadId, w.target.id, released).applied).toBe(released.routineAuthority?.permissionMode ?? 'unlimited');
  return { applied: admission.applied, ceiling: released.routineAuthority?.permissionMode ?? 'unlimited' };
}
it('structural: every held kind releases the admitted ceiling across all conversation modes × wake sources', async () => {
  let cases = 0;
  for (const kind of ['delegate', 'ask', 'assign'] as const) for (const mode of permissions.ROUTINE_PERMISSION_MODES) for (const source of sources) {
    const result = await releasedCeiling(kind, mode, source);
    expect(result.ceiling, `${kind}/${mode}/${source}`).toBe(result.applied); cases++;
  }
  const tree = ts.createSourceFile('index.ts', index, ts.ScriptTarget.Latest, true);
  let cardOptions: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'startTurn') {
    const options = node.arguments[2];
    if (options && ts.isObjectLiteralExpression(options) && options.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText(tree) === 'projectCardRun')) cardOptions = options;
  } ts.forEachChild(node, visit); };
  visit(tree);
  expect(cardOptions?.properties.some(p => ts.isSpreadAssignment(p) && ts.isCallExpression(p.expression) && p.expression.expression.getText(tree) === 'sharedTurnOptions')).toBe(true);
  expect(cases).toBe(120);
  console.info('HELD_CEILING_MATRIX 120/120');
}, 90_000);
it('mutant dropping the hold-time routine ceiling goes RED for the reviewer Ask conversation', async () => {
  const result = await releasedCeiling('delegate', 'ask', 'owner', true);
  expect(() => expect(result.ceiling).toBe(result.applied)).toThrow();
  console.info('KILLED drop-hold-time-routine-ceiling');
});

// The admitted turn can be lower than the stored task even for an owner.
it.each(permissions.ROUTINE_PERMISSION_MODES)('seat inheritance and approval digest honor admitted %s over stored No limits', mode => {
  const threadId = 'idle-routine-owner', botId = 'chief';
  const admission = admitted(mode, 'owner', threadId, botId);
  const stored = { id: botId, ...permissions.applyRoutinePermissionMode({ autoApprove: false, fullAccess: false, noLimits: false }, 'unlimited') };
  const store = { bot: (id: string) => id === botId ? stored : null, botByThread: () => stored, projectBotForTask: () => stored, birthSelection: () => ({ instanceId: 'fake' }) };
  const projected = evaluate(productionFunction(index, 'inheritedBotPermissionLevel') + '\n' + productionFunction(index, 'botEffectiveState'), {
    ...permissions, store, connectorThread: () => ({ group: null }), isUnattendedOrRoutine: () => false,
    routinePeerSource: admission.routinePeerSource,
  }, '({ inheritedBotPermissionLevel, botEffectiveState })');
  const { autoApprove, fullAccess, noLimits } = permissions.applyRoutinePermissionMode({ autoApprove: false, fullAccess: false, noLimits: false }, mode);
  const expected = { autoApprove, fullAccess, noLimits };
  expect(stored.noLimits).toBe(true);
  expect(admission.applied).toBe(mode);
  expect(projected.inheritedBotPermissionLevel(stored, threadId)).toEqual(expected);
  expect(projected.botEffectiveState(threadId, {}, botId)).toEqual({ ...expected, modelSelection: { instanceId: 'fake' }, target: null });
});
