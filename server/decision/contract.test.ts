// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ProviderAdapter, RequestDelivery, RequestOutcome, RequestAnswerOptions } from '../contracts.ts';
import type {
  ProducerAuthority, ProducerQueuePort, ProducerBindings, ProducerQueueFactory, ProducerQueue,
  RequestExecutionView, PermissionCard, InfoCard, RequestSource, RequestHandle, BaseVerdictFn, Outcome,
  ApprovalRef, ApprovalView, ApprovalAnswer, ApprovalState, QueueAttachment,
  ProvenanceReader, DenySources, RequestIngress, ClaimVerifier, RequestSnapshot,
  ServiceCall, ActionEvidence, ExecutionClaim, Initiator, ServiceId, TurnProvenance,
} from './types.ts';
import type { ApprovalRecordView, DecisionEngineTarget, DecisionTransport, DecisionHost,
  ServiceApprovalSpec, ServiceApprovalAction, PendingQueueApproval, QueueRenewal,
  QueueCancellationReason, QueueRecoverySource, TurnIdentity, TurnPolicy,
  RequestCancellation, QuestionReplyResult, ReplayFixtureRequest, ReplayRequestOpener,
  ServiceExecution, Evidence, Registration, RequestOpenedEvent, ContinuationKey, ContinuationPage, ContinuationProvenance, DecisionObservation, DecisionObserver, AppAccessDenial, OwnerRoutineLevelFn,
} from './index.ts';
import type { Store } from '../store.ts';
import type { SendTurnInput, RuntimeEvent, ProviderInstance, DecisionProviderAdapter, GateTapEvent } from '../contracts.ts';
import type * as api from './api.ts';
import type * as implementation from './implementation.ts';
import type * as publicDecision from './index.ts';

const source = (path: string) => ts.createSourceFile(path, readFileSync(resolve(path), 'utf8'), ts.ScriptTarget.Latest, true);
function exportsOf(path: string): string[] {
  return source(path).statements.flatMap(node => {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause))
      return node.exportClause.elements.map(item => item.name.text);
    if (!ts.canHaveModifiers(node) || !ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return [];
    if (ts.isVariableStatement(node)) return node.declarationList.declarations.map(d => d.name.getText());
    if (ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return node.name ? [node.name.text] : [];
    return [];
  }).sort();
}
const publicFunctions = [
  "readRequestExecution", "readApprovalExecution",
  "installProducerBindings", "producerAuthorityFor", "registerProducerQueue", "installProducerQueueFactory", "producerQueue", "listContinuations",
  "installEngineApprovalBuilder", "executeServiceSync", "presentApprovalSync", "installSynchronousQueueDeliveries", "answerApprovalSync", "isAllowedAnswer",
  "openRequest",
  "decide",
  "presentApproval",
  "attachQueue",
  "answerApproval",
  "onLevelChange",
  "installProvenanceReader",
  "installDenySources",
  "installRequestIngress",
  "installClaimVerifier",
  "describeAction",
  "recover",
  "settle",
  "readApproval",
  "openApprovals",
  "lookupApproval",
  "installDecisionTransport",
  "installDecisionHost",
  "installQueueSources",
  "deliverRequest",
  "readTurnPolicy",
  "cancelRequests",
  "answerQuestionReply",
  "relistQuestions",
  "saveContinuation", "readContinuation", "deleteContinuation", "executeService", "installDecisionObserver"
].sort();
const publicTypes = [
  "RequestExecutionView", "ContinuationPage",
  "ProducerAuthority", "ProducerQueuePort", "ProducerBindings", "ProducerRequest", "ProducerOpenRequest", "ProducerQueue", "ProducerQueueFactory",
  "EngineApprovalBuilder", "EngineApprovalAction", "SynchronousQueueDelivery",
  "RequestHandle",
  "ApprovalRef",
  "ExecutionClaim",
  "DeliveryState",
  "ServiceId",
  "ServiceApprovalSpec",
  "ServiceApprovalAction",
  "ServiceCall",
  "RequestSource",
  "RequestSnapshot",
  "Initiator",
  "TurnProvenance",
  "DenyTarget",
  "ActionEvidence",
  "Evidence",
  "Registration",
  "BaseVerdictFn",
  "Outcome",
  "PermissionCard",
  "InfoCard",
  "ApprovalView",
  "ApprovalAnswer",
  "ApprovalState",
  "ApprovalRecordView",
  "QueueAttachment",
  "ProvenanceReader",
  "DenySources",
  "RequestIngress",
  "ClaimVerifier",
  "RequestOpenedEvent",
  "DecisionEngineTarget",
  "DecisionTransport",
  "DecisionHost",
  "PendingQueueApproval",
  "QueueRenewal",
  "QueueCancellationReason",
  "QueueRecoverySource",
  "TurnIdentity",
  "TurnPolicy",
  "RequestCancellation",
  "QuestionReplyResult",
  "ReplayFixtureRequest",
  "ReplayRequestOpener",
  "ContinuationKey", "ContinuationProvenance", "ServiceExecution",
  "DecisionObservation", "DecisionObserver", "AppAccessDenial", "OwnerRoutineLevelFn"
].sort();
const publicApi = [...publicFunctions, ...publicTypes].sort();

describe('A13a: frozen r3.1 contract', () => {
  it('pins the decision exports (M65)', () => {
    expect(exportsOf('server/decision/index.ts')).toEqual(publicApi);
  });
  it('pins every decision signature across the public and implementation modules', () => {
    type ExpectedApi = {
      installProducerQueueFactory: (factory: ProducerQueueFactory) => () => void;
      producerQueue: (kind: ServiceId) => ProducerQueue;
      installProducerBindings: (bindings: ProducerBindings) => () => void;
      producerAuthorityFor: (threadId: string, botId: string) => ProducerAuthority | undefined;
      registerProducerQueue: (source: ProducerQueuePort) => () => void;
      readApprovalExecution: (ref: ApprovalRef) => Readonly<RequestExecutionView>;
      readRequestExecution: (handle: RequestHandle) => Readonly<RequestExecutionView>;
      installEngineApprovalBuilder: (builder: import('./types.ts').EngineApprovalBuilder) => () => void;
      openRequest: (source: RequestSource) => RequestHandle;
      decide: (handle: RequestHandle, base: BaseVerdictFn) => Outcome;
      presentApproval: (ref: ApprovalRef, view: ApprovalView) => Promise<void>;
      attachQueue: (ref: ApprovalRef, queue: QueueAttachment) => void;
      answerApproval: (ref: ApprovalRef, answer: ApprovalAnswer) => Promise<void>;
      onLevelChange: (botId: string) => Promise<void>;
      installProvenanceReader: (reader: ProvenanceReader) => void;
      installDenySources: (sources: DenySources) => void;
      installRequestIngress: (bus: RequestIngress) => () => void;
      installClaimVerifier: (verifier: ClaimVerifier) => (proof: unknown) => ExecutionClaim | undefined;
      describeAction: (input: RequestSnapshot | ServiceCall) => ActionEvidence;
      recover: () => Promise<void>;
      settle: (ref: ApprovalRef, state: Exclude<ApprovalState, 'open'>, answer?: ApprovalAnswer) => Promise<void>;
      readApproval: (approvalId: string) => ApprovalRecordView | undefined;
      openApprovals: (threadId?: string) => readonly ApprovalRecordView[];
      lookupApproval: (threadId: string, chatMessageId: string) => ApprovalRecordView | undefined;
      installDecisionTransport: (transport: DecisionTransport) => void;
      installDecisionHost: (host: DecisionHost) => () => void;
      installQueueSources: (sources: readonly QueueRecoverySource[]) => () => void;
      deliverRequest: (handle: RequestHandle) => Promise<void>;
      readTurnPolicy: (identity: TurnIdentity) => TurnPolicy | undefined;
      cancelRequests: (scope: RequestCancellation, state: 'cancelled' | 'expired' | 'superseded') => Promise<void>;
      answerQuestionReply: (threadId: string, text: string) => Promise<QuestionReplyResult>;
      relistQuestions: (threadId: string) => Promise<void>;
      saveContinuation: (key: ContinuationKey, parent: TurnIdentity) => Promise<void>;
      readContinuation: (key: ContinuationKey) => ContinuationProvenance | undefined;
      deleteContinuation: (key: ContinuationKey) => Promise<void>;
      listContinuations: (filter: { kind: 'background-job'; namespace: 'shared-peer'; after?: string; limit: number }) => ContinuationPage;
      installDecisionObserver: (observer: DecisionObserver) => () => void;
      presentApprovalSync: (ref: ApprovalRef, view: ApprovalView) => void;
      installSynchronousQueueDeliveries: (deliveries: readonly import('./types.ts').SynchronousQueueDelivery[]) => () => void;
      answerApprovalSync: (ref: ApprovalRef, answer: ApprovalAnswer) => RequestDelivery;
      isAllowedAnswer: (answer: unknown) => boolean;
      executeServiceSync: <T>(handle: RequestHandle, execute: (call: ServiceCall) => T) => ServiceExecution<T>;
      executeService: <T>(handle: RequestHandle, execute: (call: ServiceCall) => Promise<T>) => Promise<ServiceExecution<T>>;
    };
    expectTypeOf<typeof api>().toEqualTypeOf<ExpectedApi>();
    expectTypeOf<typeof implementation>().toEqualTypeOf<ExpectedApi>();
    expectTypeOf<typeof publicDecision>().toEqualTypeOf<ExpectedApi>();
  });
  it('pins the shared read-only record view and queue call binding', () => {
    expectTypeOf<ApprovalRecordView>().toEqualTypeOf<{
      readonly ref: ApprovalRef;
      readonly threadId: string;
      readonly botId: string;
      readonly requestId: string;
      readonly chatMessageId: string;
      readonly state: ApprovalState;
      readonly delivery: import('./types.ts').DeliveryState;
      readonly why: 'deny' | 'wipe' | 'base' | 'question';
      readonly inputHash: string;
      readonly actionHash: string;
      readonly level: Registration['level'];
      readonly evidence: readonly Evidence[];
      readonly ownerAuthority?: import('../no-limits-authority.ts').OwnerNlAuthority;
      readonly action: Readonly<Record<string, unknown>>;
      readonly queue?: { readonly kind: ServiceId; readonly ref: string; readonly epoch: string };
      readonly actor: 'owner' | 'owner-routine' | 'other' | 'unproven';
      readonly initiator: Initiator;
    }>();
    expectTypeOf<QueueAttachment>().toEqualTypeOf<{
      readonly kind: ServiceId; readonly ref: string; readonly call: ServiceCall;
    }>();
  });
  it('pins the shared card exports', () => {
    expect(exportsOf('shared/permission-card.ts')).toEqual([
      'CARD_DISPLAY_FIELDS', 'CARD_TERMINAL_FIELDS', 'PERMISSION_CARD_KEYS', 'PERMISSION_CARD_KINDS',
      'QUEUE_REF_PATHS', 'actionProjection',
    ].sort());
  });
  it('pins the provider posture and gate tap hooks', () => {
    const adapter = source('server/contracts.ts').statements.find(n => ts.isInterfaceDeclaration(n) && n.name.text === 'ProviderAdapter');
    expect(adapter && ts.isInterfaceDeclaration(adapter)).toBe(true);
    if (!adapter || !ts.isInterfaceDeclaration(adapter)) return;
    const members = adapter.members.map(m => m.name?.getText());
    expect(members).toContain('onPostureChange');
    expect(members).toContain('gateTap');
  });
  it('pins the strict acknowledgement signature and BASE compatibility', () => {
    type Strict = ProviderAdapter<RequestDelivery>['respondToRequest'];
    expectTypeOf<ReturnType<Strict>>().toEqualTypeOf<Promise<RequestDelivery>>();
    expectTypeOf<Parameters<Strict>[3]>().toEqualTypeOf<RequestAnswerOptions>();
    expectTypeOf<Parameters<Strict>['length']>().toEqualTypeOf<4>();
    expectTypeOf<ReturnType<ProviderAdapter['respondToRequest']>>().toEqualTypeOf<Promise<RequestOutcome>>();
    expectTypeOf<ProviderAdapter['onPostureChange']>().toEqualTypeOf<((threadId: string) => Promise<void>) | undefined>();
    expectTypeOf<PermissionCard>().toExtend<{ approvalId: string; requestRef: string; actionHash: string }>();
    expectTypeOf<InfoCard['requestId']>().toEqualTypeOf<undefined>();
    expectTypeOf<Extract<RequestSource, { kind: 'engine' }>>().toEqualTypeOf<{
      readonly kind: 'engine'; readonly threadId: string; readonly requestId: string;
    }>();
  });
  it('pins constants and keeps unknown action fields in the projection', async () => {
    const cards = await import('../../shared/permission-card.ts');
    expect(cards.PERMISSION_CARD_KINDS).toEqual(['options']);
    expect(cards.PERMISSION_CARD_KEYS).toEqual(['requestId', 'publish', 'mcpEnable', 'emailSend', 'browserSetup',
      'routineRequest', 'skillRequest', 'folderTrust', 'approvalScope']);
    expect(cards.CARD_TERMINAL_FIELDS).toEqual(['answered', 'answeredAt', 'dismissed', 'orphaned']);
    expect(cards.CARD_DISPLAY_FIELDS).toEqual(['title', 'subtitle', 'detail']);
    expect(cards.QUEUE_REF_PATHS.email).toBe('$.card.emailSend.sendId');
    expect(cards.QUEUE_REF_PATHS.routine).toBe('$.card.routineRequest.id');
    expect(cards.QUEUE_REF_PATHS.publish).toBe('$.card.publish.opId');
    const action = { approvalId: 'a', requestRef: 'r', options: ['allow'], futurePayload: { target: 'fixture' } };
    expect(cards.actionProjection({ ...action, title: 'Display', subtitle: '', detail: '',
      answered: 'allow', answeredAt: 1, dismissed: true, orphaned: true, actionHash: 'self' })).toEqual(action);
  });
  it('pins input identity and opaque capabilities', () => {
    const text = readFileSync(resolve('server/decision/types.ts'), 'utf8');
    expect(text).not.toContain('self-continuation');
    for (const name of ['RequestHandle', 'ApprovalRef', 'ExecutionClaim']) expect(text).toContain(`readonly [${name}Brand]`);
    for (const field of ['approvalId', 'requestRef', 'actionHash']) expect(text).toContain(`${field}: string`);
    expect(text).toContain('requestId?: never');
  });
});


describe('final S0 cross-slice amendment', () => {
  it('pins all exported types and forwarding bodies for the implemented decision API', async () => {
    expect(exportsOf('server/decision/types.ts')).toEqual(publicTypes);
    expect(exportsOf('server/decision/api.ts')).toEqual(publicFunctions);
    expect(exportsOf('server/decision/implementation.ts')).toEqual(publicFunctions);
    for (const node of source('server/decision/api.ts').statements) {
      if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue;
      const args = node.parameters.map(p => p.name.getText()).join(', ');
      expect(node.body.getText()).toBe(`{ return implementation.${node.name.text}(${args}); }`);
    }
    const implemented = await import('./index.ts');
    for(const fn of Object.values(implemented))expect(typeof fn).toBe('function');
    expect(readFileSync(resolve('server/decision/implementation.ts'),'utf8')).not.toContain("throw new Error('NotBuilt')");
  });
  it('pins the single strict transport and installation host', () => {
    expectTypeOf<DecisionEngineTarget>().toEqualTypeOf<{
      readonly providerInstanceId: string; readonly threadId: string;
      readonly generation: string; readonly turnId: string; readonly requestId: string;
    }>();
    expectTypeOf<DecisionTransport>().toEqualTypeOf<{
      respond: (target: DecisionEngineTarget, answer: ApprovalAnswer, options: Readonly<RequestAnswerOptions>) => Promise<RequestDelivery>;
      interrupt: (target: DecisionEngineTarget) => Promise<void>;
    }>();
    expectTypeOf<DecisionHost>().toEqualTypeOf<{
      readonly store: Store; view: (registration: Readonly<Registration>) => ApprovalView;
      featureOff?: (threadId:string,botId:string,tool:string) => string | undefined;
      executionContext?: (threadId:string,botId:string) => {cwd?:string;project?:string;home?:string};
    }>();
    expectTypeOf<ProviderInstance['decisionAdapter']>().toEqualTypeOf<DecisionProviderAdapter | undefined>();
    expectTypeOf<DecisionProviderAdapter>().toEqualTypeOf<Pick<ProviderAdapter<RequestDelivery>,
      'respondToRequest' | 'interruptTurn' | 'onPostureChange' | 'gateTap'>>();
    expectTypeOf<Extract<GateTapEvent, { type: 'posture' }>>().toEqualTypeOf<{
      type: 'posture'; threadId: string; generation: string;
      state: 'requested' | 'accepted' | 'failed' | 'interrupted'; level: 'ask' | 'auto' | 'full' | 'unlimited';
    }>();
    expectTypeOf<DecisionObserver>().toEqualTypeOf<(event: DecisionObservation) => void>();
    expectTypeOf<DecisionObservation>().toEqualTypeOf<
      { readonly type: 'registered'; readonly requestKey: string; readonly threadId: string;
        readonly inputHash: string; readonly actor: Registration['actor']; readonly level: Registration['level'] }
      | { readonly type: 'decided'; readonly requestKey: string; readonly kind: Outcome['kind']; readonly approvalId?: string; readonly ownerAuthority?: import('../no-limits-authority.ts').OwnerNlAuthority; readonly ownerTargets?: readonly import('./index.ts').DenyTarget[] }
      | { readonly type: 'delivery'; readonly requestKey: string; readonly answerId: string; readonly state: import('./index.ts').DeliveryState }
    >();
    expectTypeOf<keyof ProvenanceReader>().toEqualTypeOf<'turnGenerationFor' | 'provenance' | 'live' | 'ownerThread'>();
    expectTypeOf<ReturnType<DecisionTransport['respond']>>().not.toEqualTypeOf<Promise<RequestOutcome>>();
  });
  it('pins service registration, reserved action fields, and queue recovery operations', () => {
    expectTypeOf<ServiceApprovalSpec>().toEqualTypeOf<{
      readonly queueRef: string; readonly epoch: string; readonly action: ServiceApprovalAction;
    }>();
    expectTypeOf<ServiceCall>().toEqualTypeOf<{
      readonly tool: string; readonly input: unknown; readonly approval?: ServiceApprovalSpec;
    }>();
    expectTypeOf<ServiceApprovalAction['approvalId' | 'requestRef' | 'actionHash' | 'title' | 'subtitle' | 'detail'
      | 'answered' | 'answeredAt' | 'dismissed' | 'orphaned']>().toEqualTypeOf<undefined>();
    expectTypeOf<ServiceApprovalAction['futurePayload']>().toEqualTypeOf<unknown>();
    expectTypeOf<PendingQueueApproval>().toEqualTypeOf<{
      readonly approvalId: string; readonly kind: ServiceId; readonly ref: string; readonly epoch: string;
      readonly call: ServiceCall & { readonly approval: ServiceApprovalSpec };
      readonly view: ApprovalView; readonly proof: unknown;
    }>();
    expectTypeOf<QueueRenewal>().toEqualTypeOf<{ readonly approvalId: string; readonly epoch: string }>();
    expectTypeOf<QueueCancellationReason>().toEqualTypeOf<'unverifiable' | 'conflict' | 'missing-record' | 'delivery-failed' | 'expired' | 'cancelled' | 'superseded'>();
    expectTypeOf<QueueRecoverySource>().toEqualTypeOf<{
      readonly kind: ServiceId;
      pendingApprovals: () => readonly PendingQueueApproval[];
      reopen: (item: PendingQueueApproval) => Extract<RequestSource, { kind: 'service' }> | undefined;
      base: BaseVerdictFn;
      respond: (item: PendingQueueApproval, answer: ApprovalAnswer, options: Readonly<RequestAnswerOptions>) => Promise<RequestDelivery>;
      cancel: (item: PendingQueueApproval, reason: QueueCancellationReason) => Promise<void>;
      renew: (item: PendingQueueApproval, identity: QueueRenewal) => Promise<PendingQueueApproval>;
    }>();
    expectTypeOf<ServiceExecution<number>>().toEqualTypeOf<
      { readonly kind: 'executed'; readonly value: number } | Exclude<Outcome, { readonly kind: 'run' }>
    >();
  });
  it('pins ingress metadata, question routing, lifecycle retirement and turn policy', () => {
    expectTypeOf<RequestSnapshot>().toEqualTypeOf<{
      readonly threadId: string; readonly requestId: string; readonly turnId: string;
      readonly providerInstanceId: string; readonly generation: string; readonly tool: string;
      readonly input: unknown; readonly inputHash: string; readonly event: Readonly<RequestOpenedEvent>;
    }>();
    expectTypeOf<TurnIdentity>().toEqualTypeOf<{ readonly threadId: string; readonly generation: string }>();
    expectTypeOf<TurnPolicy>().toEqualTypeOf<{
      readonly actor: Registration['actor']; readonly level: Registration['level'];
      readonly permission: Readonly<Pick<SendTurnInput, 'routeAsks' | 'stopLine' | 'askLevel' | 'noLimits'>>;
    }>();
    expectTypeOf<ContinuationKey>().toEqualTypeOf<{
      readonly kind: 'asker-wake' | 'background-job'; readonly id: string;
      readonly botId: string; readonly threadId: string;
    }>();
    expectTypeOf<ContinuationProvenance>().toEqualTypeOf<{
      readonly actor: Registration['actor']; readonly initiator: Initiator;
      readonly principal: string; readonly roomOwnerOnly: boolean;
    }>();
    expectTypeOf<RequestCancellation>().toEqualTypeOf<
      { readonly kind: 'thread'; readonly threadId: string }
      | { readonly kind: 'generation'; readonly threadId: string; readonly generation: string }
    >();
    expectTypeOf<QuestionReplyResult>().toEqualTypeOf<
      { readonly kind: 'answered'; readonly ref: ApprovalRef }
      | { readonly kind: 'send'; readonly pending: readonly ApprovalRef[] }
    >();
    expectTypeOf<Extract<RuntimeEvent, { type: 'request.resolved' }>['settlement']>()
      .toEqualTypeOf<'cancelled' | 'expired' | 'superseded' | undefined>();
  });
  it('pins durable app denials and the browser-safe shared routine calculation', async () => {
    expectTypeOf<AppAccessDenial>().toEqualTypeOf<{
      readonly id: string; readonly toolkit: string; readonly accountId?: string;
      readonly tools: readonly string[]; readonly ops: readonly ('read' | 'write')[];
      readonly source: 'request-denied' | 'grant-revoked'; readonly at: number; readonly revision: number;
    }>();
    const routine = await import('../../shared/owner-routine-level.ts');
    expect(exportsOf('shared/owner-routine-level.ts')).toEqual(['ownerRoutineLevel']);
    expectTypeOf<typeof routine.ownerRoutineLevel>().toEqualTypeOf<OwnerRoutineLevelFn>();
    expectTypeOf<OwnerRoutineLevelFn>().toEqualTypeOf<(botLevel: Registration['level'], baseLevel: Registration['level'], draftOnly: boolean) => Registration['level']>();
    expect(routine.ownerRoutineLevel('unlimited','auto',false)).toBe('auto');
    expect(routine.ownerRoutineLevel('unlimited','unlimited',true)).toBe('ask');
    const imports = source('shared/owner-routine-level.ts').statements.filter(ts.isImportDeclaration);
    expect(imports.every(node => node.importClause?.isTypeOnly)).toBe(true);
  });
  it('declares the replay adapter outside production exports', async () => {
    const replay = await import('../testing/replay-source.ts');
    expect(exportsOf('server/testing/replay-source.ts')).toEqual(['openReplayRequest']);
    expectTypeOf<typeof replay.openReplayRequest>().toEqualTypeOf<ReplayRequestOpener>();
    expectTypeOf<ReplayRequestOpener>().toEqualTypeOf<(fixture: ReplayFixtureRequest) => RequestHandle>();
    // The former S0 stub is now an isolated ingress adapter. Exercise the real
    // decision API with inert calls; a visible wipe remains the positive control.
    const {Store}=await import('../store.ts'),decision=await import('./index.ts');
    const dispose=decision.installDecisionHost({store:new Store(),view:()=>({title:'Fixture',subtitle:'Replay'})});
    decision.installDenySources({revision:()=>[],resolve:()=>[]});
    const provenance:TurnProvenance={generation:'replay-g',botId:'replay-b',threadId:'replay-t',principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:'owner-typed'}};
    try{for(const [requestId,command,expected] of [['ordinary','printf fixture','run'],['wipe','rm -rf /','card']] as const){
      const handle=replay.openReplayRequest({provenance,level:'unlimited',event:{type:'request.opened',threadId:'replay-t',turnId:'replay-turn',providerInstanceId:'fixture',requestId,requestType:'permission',tool:'Bash',summary:command,toolCall:{name:'Bash',input:{command}}} as RequestOpenedEvent});
      expect(decision.decide(handle,()=>({approve:null,source:'no-grant'})).kind).toBe(expected);
    }}finally{dispose();}
    expect(publicFunctions).not.toContain('openReplayRequest');
  });
  it('pins the normative service/hash/recovery and transport ownership declarations (not runtime proof)', () => {
    const types = readFileSync(resolve('server/decision/types.ts'), 'utf8');
    const api = readFileSync(resolve('server/decision/api.ts'), 'utf8');
    for (const rule of ['inputHash covers BOTH', 'request_key = service:queueRef:epoch',
      'Claims alone', 'No durable record is committed by decide', 'Reject reserved fields at runtime',
      'options never become executable evidence', 'queue row', 'before records.present commits record+chat atomically',
      'Fresh verifier-issued claim', 'old approvalId is never reused', 'Throw/reject is surfaced',
      'Missing/stale providers return failed', 'all five identity fields', 'No second writer']) {
      expect(types.replace(/\s*\*\s*/g, ' ').replace(/\s+/g, ' ')).toContain(rule);
    }
    for (const rule of ['10 s retry, 20 s interrupt', 'old-posture owner BASE answers BEFORE',
      'stale RUN->CARD', 'Concurrent calls join', 'missing adapter', 'relistQuestions afterwards',
      'no implicit retry of a failed side effect']) expect(api.replace(/\s*\*\s*/g, ' ').replace(/\s+/g, ' ')).toContain(rule);
  });
});

describe('CONTRACT-ADD: frozen engine approval action builder', () => {
  it('pins the additive installer and action contract without changing existing signatures', () => {
    type Builder = import('./types.ts').EngineApprovalBuilder;
    type Action = import('./types.ts').EngineApprovalAction;
    expectTypeOf<Builder>().toEqualTypeOf<(registration: Readonly<Registration>, why: ApprovalRecordView['why'], base: Readonly<ReturnType<BaseVerdictFn>> | undefined) => Action>();
    expectTypeOf<Action['approvalId']>().toEqualTypeOf<undefined>();
    expectTypeOf<Action['title']>().toEqualTypeOf<undefined>();
    expectTypeOf<Action['options']>().toEqualTypeOf<readonly string[]>();
  });
});

it('CA contract pins durable delivery and the synchronous queue ack',()=>{
 expectTypeOf<ApprovalRecordView['delivery']>().toEqualTypeOf<import('./types.ts').DeliveryState>();
 expectTypeOf<import('./types.ts').SynchronousQueueDelivery['respondNow']>().toEqualTypeOf<(item:PendingQueueApproval,answer:ApprovalAnswer,options:Readonly<RequestAnswerOptions>)=>RequestDelivery>();
});

it('CONTRACT-ADD: producer authority and queue binding preserve the verifier/recovery boundary', () => {
  expectTypeOf<ProducerAuthority>().toEqualTypeOf<{ readonly claim: ExecutionClaim; readonly proof: unknown }>();
  expectTypeOf<ProducerQueuePort>().toEqualTypeOf<Omit<QueueRecoverySource, 'reopen'>>();
  expectTypeOf<ProducerBindings['authorityFor']>().toEqualTypeOf<(threadId: string, botId: string) => ProducerAuthority | undefined>();
  expectTypeOf<ProducerBindings['registerQueue']>().toEqualTypeOf<(source: ProducerQueuePort) => () => void>();
});

it('CONTRACT-ADD: execution receipt is read-only and distinguishes delivery from policy', () => {
  expectTypeOf<RequestExecutionView>().toEqualTypeOf<{ readonly outcome: Outcome['kind']; readonly delivery: import('./index.ts').DeliveryState; readonly answer?: ApprovalAnswer }>();
});

it('CONTRACT-ADD: indexed shared-peer pages and synchronous delete commit (S1 behaviour obligation)', () => {
  expectTypeOf<ContinuationPage>().toEqualTypeOf<{ readonly keys: readonly ContinuationKey[]; readonly next?: string }>();
  const declaration = readFileSync(resolve('server/decision/api.ts'), 'utf8');
  for (const rule of ['partial index', 'no JSON functions', 'limit+1 rows', 'commits synchronously', 'missing key is a no-op']) expect(declaration).toContain(rule);
});

// CONTRACT-ADD: sync routes retain their public return shapes and one decision seam.
it('pins additive synchronous service/queue contracts without changing async signatures',()=>{
  expectTypeOf<typeof publicDecision.executeServiceSync>().toEqualTypeOf<typeof api.executeServiceSync>();
  expectTypeOf<typeof publicDecision.executeServiceSync>().toEqualTypeOf<typeof implementation.executeServiceSync>();
  expectTypeOf<typeof publicDecision.presentApprovalSync>().toEqualTypeOf<(ref:ApprovalRef,view:ApprovalView)=>void>();
  expectTypeOf<typeof publicDecision.answerApprovalSync>().toEqualTypeOf<(ref:ApprovalRef,answer:ApprovalAnswer)=>RequestDelivery>();
  expectTypeOf<import('./types.ts').SynchronousQueueDelivery['respondNow']>().toEqualTypeOf<(item:PendingQueueApproval,answer:ApprovalAnswer,options:Readonly<RequestAnswerOptions>)=>RequestDelivery>();
});
