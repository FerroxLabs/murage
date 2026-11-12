// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OwnerNlAuthority, OwnerNlDecision } from '../no-limits-authority.ts';
import type { AutoVerdict } from '../auto-approve.ts';
import type { RuntimeEvent, RuntimeEventListener, ProviderAdapter, RequestDelivery, RequestAnswerOptions, SendTurnInput } from '../contracts.ts';
import type { OptionCardData, Store } from '../store.ts';
import type { QUEUE_REF_PATHS } from '../../shared/permission-card.ts';

declare const RequestHandleBrand: unique symbol;
declare const ApprovalRefBrand: unique symbol;
declare const ExecutionClaimBrand: unique symbol;
export interface RequestHandle { readonly [RequestHandleBrand]: true }
export interface ApprovalRef { readonly approvalId: string; readonly [ApprovalRefBrand]: true }
/** Runtime membership in the verifier's WeakSet is also required. */
export interface ExecutionClaim { readonly [ExecutionClaimBrand]: true }
export type DeliveryState = 'none' | 'pending' | 'accepted' | 'failed' | 'unconfirmed';
export type ServiceId = keyof typeof QUEUE_REF_PATHS;
/** S2 supplies this BEFORE openRequest for every permission-producing service.
 * S1 freezes raw input and this spec together; inputHash covers BOTH. Only raw
 * input feeds describeAction: prose/options never become executable evidence.
 * request_key = service:queueRef:epoch, request_id = queueRef. Claims alone
 * supply bot/thread/generation. No durable record is committed by decide:
 * S2 persists the queue item with ref.approvalId, attaches it, then presents.
 */
export interface ServiceApprovalSpec {
  readonly queueRef: string;
  readonly epoch: string;
  readonly action: ServiceApprovalAction;
}
/** Reject reserved fields at runtime too (including values hidden in unknown).
 * Unknown non-reserved keys remain action-bearing. requestId, when supplied,
 * must agree with queueRef and QUEUE_REF_PATHS; S1 generates its own identities.
 */
export type ServiceApprovalAction = Readonly<Record<string, unknown>> & {
  readonly approvalId?: never; readonly requestRef?: never; readonly actionHash?: never;
  readonly title?: never; readonly subtitle?: never; readonly detail?: never;
  readonly answered?: never; readonly answeredAt?: never; readonly dismissed?: never; readonly orphaned?: never;
};
export interface ServiceCall {
  readonly tool: string; readonly input: unknown; readonly approval?: ServiceApprovalSpec;
}
export type RequestSource =
  | { readonly kind: 'engine'; readonly threadId: string; readonly requestId: string }
  | { readonly kind: 'service'; readonly service: ServiceId; readonly claim: ExecutionClaim; readonly call: ServiceCall };
export interface RequestSnapshot {
  readonly threadId: string; readonly requestId: string; readonly turnId: string;
  readonly providerInstanceId: string; readonly generation: string; readonly tool: string;
  readonly input: unknown; readonly inputHash: string;
  /** Bounded, deep-frozen ingress event, captured before other subscribers.
   * Preserves choices/questions, grant metadata and native identity for BASE
   * and card construction. Never reread an event supplied by a later caller.
   * toolCall.input uses the same bounded projection as input, not a raw clone.
   */
  readonly event: Readonly<RequestOpenedEvent>;
}
export type Initiator =
  | { readonly k: 'owner-typed' }
  | { readonly k: 'owner-channel-dm'; readonly channel: string }
  | { readonly k: 'routine-run' | 'routine-wake' | 'project-room-routine' | 'routine-peer';
      readonly form: 'run' | 'wake' | 'project-room' | 'peer'; readonly sourceRunId: string;
      readonly sourceBotId: string; readonly recipientGeneration: string; readonly trigger: 'manual' | 'schedule' }
  | { readonly k: 'webhook' | 'other-human' | 'guest' | 'delegation' }
  | { readonly k: 'peer'; readonly fromBotId: string };
export interface TurnProvenance {
  /** Captured permission of a durable continuation, independent of later bot edits. */
  readonly recoveredLevel?: Registration['level'];
  readonly generation: string; readonly botId: string; readonly threadId: string;
  readonly principal: string; readonly initiator: Initiator; readonly roomOwnerOnly: boolean; readonly at: number;
}
export type DenyTarget =
  | { readonly kind: 'path'; readonly path: string; readonly op: 'read' | 'write' | 'delete' }
  | { readonly kind: 'host-computer'; readonly scope: 'local-computer' }
  | { readonly kind: 'browser-site'; readonly origin: string; readonly op: 'navigate' | 'read' | 'act' }
  | { readonly kind: 'connected-app'; readonly toolkit: string; readonly accountId?: string; readonly tool: string; readonly op: 'read' | 'write' };
export interface ActionEvidence {
  readonly tool: string; readonly codeIdentity: string;
  readonly ownerAuthority?: OwnerNlAuthority;
  /** Owner policy inputs remain separate from the bounded target presentation. */
  readonly ownerTargets?: readonly DenyTarget[];
  readonly executables: readonly { readonly lang: 'sh' | 'py' | 'js' | 'pwsh'; readonly text: string; readonly cwd?: string; readonly from: 'command' | 'code' | 'nested' }[];
  readonly deletes: readonly { readonly path: string; readonly op: 'delete' | 'truncate' | 'overwrite-device' }[];
  readonly targets: readonly DenyTarget[];
  readonly content: readonly { readonly field: string }[];
}
export interface Evidence { readonly kind: 'deny' | 'wipe'; readonly class: string; readonly ruleId: string; readonly span: string; readonly ownerDecision?: OwnerNlDecision }
export interface Registration {
  readonly key: string; readonly source: RequestSource; readonly snapshot?: RequestSnapshot;
  readonly actor: 'owner' | 'owner-routine' | 'other' | 'unproven';
  readonly level: 'ask' | 'auto' | 'full' | 'unlimited'; readonly action: ActionEvidence;
  readonly ownerAuthority?: OwnerNlAuthority;
  readonly deny: readonly Evidence[]; readonly denyRev: readonly string[];
  readonly inputHash: string; readonly registrationHash: string;
}
export type BaseVerdictFn = (registration: Readonly<Registration>) => AutoVerdict;
export type Outcome = { readonly kind: 'run' } | { readonly kind: 'card'; readonly ref: ApprovalRef }
  | { readonly kind: 'question'; readonly ref: ApprovalRef } | { readonly kind: 'refuse'; readonly message: string };
/** S1 adopts these types in the store when producers migrate in Wave A. */
export interface PermissionCard extends OptionCardData { approvalId: string; requestRef: string; actionHash: string }
export type InfoCard = Omit<OptionCardData, 'requestId'> & { requestId?: never };
export interface ApprovalView { readonly title: string; readonly subtitle: string; readonly detail?: string }
export type ApprovalAnswer = Parameters<ProviderAdapter['respondToRequest']>[2];
export type ApprovalState = 'open' | 'answered' | 'expired' | 'cancelled' | 'superseded';
/** Frozen, read-only projection of one authoritative durable approval record. */
export interface ApprovalRecordView {
  readonly ref: ApprovalRef;
  readonly threadId: string;
  readonly botId: string;
  readonly requestId: string;
  readonly chatMessageId: string;
  readonly state: ApprovalState;
  readonly delivery: DeliveryState;
  readonly why: 'deny' | 'wipe' | 'base' | 'question';
  readonly inputHash: string;
  readonly actionHash: string;
  readonly level: Registration['level'];
  readonly evidence: readonly Evidence[];
  readonly ownerAuthority?: OwnerNlAuthority;
  /** Frozen action, joined to the persisted row; sinks never re-run readers. */
  readonly action: Readonly<Record<string, unknown>>;
  readonly queue?: { readonly kind: ServiceId; readonly ref: string; readonly epoch: string };
  readonly actor: 'owner' | 'owner-routine' | 'other' | 'unproven';
  readonly initiator: Initiator;
}
/**
 * Supply the exact persisted queue call, including during recovery. S1 hashes it
 * with the same bounded projection as openRequest and rejects an input hash
 * mismatch against the registration before attaching; callers do not supply hashes.
 * kind matches the registered service, ref equals call.approval.queueRef and
 * the epoch matches. Validate the action's QUEUE_REF_PATHS value before commit.
 */
export interface QueueAttachment { readonly kind: ServiceId; readonly ref: string; readonly call: ServiceCall }
export interface ProvenanceReader {
  /** Host-only persisted audience proof when a live provenance record was lost. */
  ownerThread?(threadId:string): {readonly botId:string;readonly principal:string;readonly level:Registration['level'];
    readonly origin: 'owner'|'owner-channel'|'routine'|'owner-routine'|'webhook'|'unattended';readonly fullAccessChannelMessages?:boolean}|undefined;
  turnGenerationFor(threadId: string): string | undefined;
  provenance(generation: string): TurnProvenance | undefined;
  live(threadId: string): { readonly botId: string; readonly turnId: string; readonly providerInstanceId: string;
    readonly principal: string; readonly owner: boolean; readonly permissionExplicit?: boolean; readonly fullAccessChannelMessages?: boolean; readonly level: Registration['level'];
    readonly routine?: { readonly sourceRunId: string; readonly sourceBotId: string; readonly recipientGeneration: string; readonly owner: boolean } } | undefined;
}
export interface DenySources {
  revision(botId: string): readonly string[];
  resolve(botId: string, targets: readonly DenyTarget[]): readonly Evidence[];
}
export interface RequestIngress { subscribe(listener: RuntimeEventListener): () => void }
export type ClaimVerifier = (proof: unknown) => {
  readonly threadId: string; readonly botId: string; readonly generation: string;
} | undefined;
export type RequestOpenedEvent = Extract<RuntimeEvent, { type: 'request.opened' }>;

/** One transport contract, replacing BOTH proposed deliveryFor and ad-hoc sends.
 * S4 binds its live registry; S1 supplies only the captured ingress target.
 * Every send/interrupt validates all five identity fields, never retargets a
 * current/sibling turn, and uses S3's strict acknowledgement (not RequestOutcome).
 * Missing/stale providers return failed; interrupt is a no-op for a stale target.
 * No authority is conferred by installation. Only S1 calls these callbacks.
 */
export interface DecisionEngineTarget {
  readonly providerInstanceId: string; readonly threadId: string;
  readonly generation: string; readonly turnId: string; readonly requestId: string;
}
export interface DecisionTransport {
  respond(target: DecisionEngineTarget, answer: ApprovalAnswer, options: Readonly<RequestAnswerOptions>): Promise<RequestDelivery>;
  interrupt(target: DecisionEngineTarget): Promise<void>;
}
/** S4 supplies the actual S1 Store instance before ingress/recovery. S1 owns
 * transactions, record/cache updates, row writes, text refusals and FIFO text.
 * view supplies display fields only, including the stale-deny RUN->CARD path;
 * S1 builds all action fields from the frozen snapshot/spec. No second writer.
 */
export interface DecisionHost {
  readonly store: Store;
  featureOff?(threadId: string, botId: string, tool: string): string | undefined;
  executionContext?(threadId:string,botId:string): {cwd?:string;project?:string;home?:string};
  view(registration: Readonly<Registration>): ApprovalView;
}
/** S2 durable queue metadata. proof is an opaque server-issued provenance
 * reference, NOT a serialized ExecutionClaim. Never store caller authority.
 * call.approval is required here and agrees with kind/ref/epoch; the queue row
 * carries approvalId before records.present commits record+chat atomically.
 */
export interface PendingQueueApproval {
  readonly approvalId: string; readonly kind: ServiceId; readonly ref: string; readonly epoch: string;
  readonly call: ServiceCall & { readonly approval: ServiceApprovalSpec };
  readonly view: ApprovalView;
  readonly proof: unknown;
}
export interface QueueRenewal { readonly approvalId: string; readonly epoch: string }
export type QueueCancellationReason = 'unverifiable' | 'conflict' | 'missing-record' | 'delivery-failed' | 'expired' | 'cancelled' | 'superseded';
/** S2 implements queue operations; S4 installs bound live instances plus its
 * reopen verifier before recover. Duplicate kinds are rejected; disposal only
 * removes this installation. No guessed private module or second queue instance.
 */
export interface QueueRecoverySource {
  readonly kind: ServiceId;
  pendingApprovals(): readonly PendingQueueApproval[];
  /** Fresh verifier-issued claim from server-validated durable proof. Undefined
   * means refuse/cancel, never silently grant owner authority. S1 verifies the
   * returned service, call, queueRef, epoch and claim against the pending item.
   */
  reopen(item: PendingQueueApproval): Extract<RequestSource, { kind: 'service' }> | undefined;
  /** Same producer BASE policy as live decide; invoked only on the BASE branch. */
  base: BaseVerdictFn;
  /** S1 persists answer/answerId/pending before calling. Exact item identity and
   * same-answerId pending/accepted/failed dedup match DecisionTransport/S3.
   * Acknowledges durable queue acceptance, not completion of the side effect.
   */
  respond(item: PendingQueueApproval, answer: ApprovalAnswer, options: Readonly<RequestAnswerOptions>): Promise<RequestDelivery>;
  /** Durably remove the item from awaiting_owner on failed authentication,
   * timeout or cancellation. Must be idempotent. Throw/reject is surfaced by
   * recover (never success); S1 retains retryable failure, no stranded success.
   */
  cancel(item: PendingQueueApproval, reason: QueueCancellationReason): Promise<void>;
  /** Cancelled/restored records are tombstones. S1 preallocates a new id/epoch;
   * S2 atomically replaces the exact old queue identity, including call.approval,
   * and returns its persisted replacement. Repeated same renewal is idempotent.
   * S1 reopens/verifies it before presentation; old approvalId is never reused.
   */
  renew(item: PendingQueueApproval, identity: QueueRenewal): Promise<PendingQueueApproval>;
}
export interface TurnIdentity { readonly threadId: string; readonly generation: string }
/** Read-only registry authority for S4's permissionNow callback into S3.
 * Missing/stale provenance returns undefined; S4 preserves BASE flags and never
 * infers noLimits from audience or a bot flag alone. No request/card is minted.
 */
export interface TurnPolicy {
  readonly actor: Registration['actor']; readonly level: Registration['level'];
  readonly permission: Readonly<Pick<SendTurnInput, 'routeAsks' | 'stopLine' | 'askLevel' | 'noLimits'>>;
}
/** Explicit lifecycle input for thread deletion and driver posture retirement;
 * request.resolved and turn lifecycle events also enter via RequestIngress.
 * A generation scope never cancels a replacement generation. S4 calls before
 * discarding provenance; S1 terminalizes records+rows and cancels queue waits.
 */
export type RequestCancellation =
  | { readonly kind: 'thread'; readonly threadId: string }
  | { readonly kind: 'generation'; readonly threadId: string; readonly generation: string };
export type QuestionReplyResult =
  | { readonly kind: 'answered'; readonly ref: ApprovalRef }
  | { readonly kind: 'send'; readonly pending: readonly ApprovalRef[] };
/** Test-only S1 adapter contract consumed by S3 replay tooling; not RequestSource
 * and never an HTTP/production mint. Label provenance is independent of cardClass.
 * The isolated fixture supplies the store/readers; bounded capture and decisions
 * use production S1 code. Import inventory permits tests and replay tooling only.
 */
export interface ReplayFixtureRequest {
  readonly event: RequestOpenedEvent;
  readonly provenance: TurnProvenance;
  readonly level: Registration['level'];
}
export type ReplayRequestOpener = (fixture: ReplayFixtureRequest) => RequestHandle;

/** Delivery boundary for a service RUN. Non-run outcomes must follow the normal
 * queue-first CARD/question path; no side effect has run in those branches. */
export type ServiceExecution<T> = { readonly kind: 'executed'; readonly value: T }
  | Exclude<Outcome, { readonly kind: 'run' }>;

/** Durable continuation provenance for A3 paths without an approval record.
 * S4 keys the original wake intent/job; S1 stores the captured authority with
 * that intent/job in its Store before S4 may dispatch or release the parent.
 * No serialized claim and no caller-supplied actor. Reads survive generation
 * release/restart, but confer no live ExecutionClaim or permission to dispatch.
 */
export interface ContinuationKey {
  readonly kind: 'asker-wake' | 'background-job'; readonly id: string;
  readonly botId: string; readonly threadId: string;
}
export interface ContinuationProvenance {
  readonly level?: Registration['level'];
  readonly actor: Registration['actor']; readonly initiator: Initiator;
  readonly principal: string; readonly roomOwnerOnly: boolean;
}

/** Redacted, bounded accounting for J3: one registered event per first capture,
 * decisions (including RUN/refusal), and actual delivery acknowledgement. No raw
 * input, secrets, prose or caller authority. S4 installs the S3 fixture/tap sink
 * only when requested by gate configuration; observers cannot alter decisions.
 */
export type DecisionObservation =
  | { readonly type: 'registered'; readonly requestKey: string; readonly threadId: string;
      readonly inputHash: string; readonly actor: Registration['actor']; readonly level: Registration['level'] }
  | { readonly type: 'decided'; readonly requestKey: string; readonly kind: Outcome['kind']; readonly approvalId?: string; readonly ownerAuthority?: OwnerNlAuthority; readonly ownerTargets?: readonly DenyTarget[] }
  | { readonly type: 'delivery'; readonly requestKey: string; readonly answerId: string; readonly state: DeliveryState };
export type DecisionObserver = (event: DecisionObservation) => void;

/** S2 persists in connectedAppAccess.denials (default [], max 64); S4 resolves
 * via DenySources. Operations come from CONNECTED_APP_TOOLS.writes, one tool
 * per denial, retaining account identity. Later matching grants remove denials.
 */
export interface AppAccessDenial {
  readonly id: string; readonly toolkit: string; readonly accountId?: string;
  readonly tools: readonly string[]; readonly ops: readonly ('read' | 'write')[];
  readonly source: 'request-denied' | 'grant-revoked'; readonly at: number; readonly revision: number;
}
/** Pure shared UI/server calculation only; grants no actor authority. S1 calls
 * only after proving owner-routine, otherwise uses BASE unchanged. Draft-only
 * stays Ask; owner bot at unlimited overrides the stored ceiling; otherwise BASE.
 */
export type OwnerRoutineLevelFn = (botLevel: Registration['level'], baseLevel: Registration['level'], draftOnly: boolean) => Registration['level'];

/** CONTRACT-ADD: BASE engine cards require the server-derived grant keys and
 * task/routine options, which cannot enter through display-only ApprovalView.
 * S4 installs its bound builder before ingress/recovery. S1 invokes it ONCE
 * over the frozen registration, before record creation; sinks never call it.
 * Returned identities/display/terminal fields are rejected. requestId, if set,
 * must equal the captured request. All returned action fields are projected,
 * deep-frozen and bound by actionHash. No actor, level, deny or evidence mint.
 * base is the frozen BASE callback result, never a second policy evaluation;
 * undefined on owner No-limits deny/wipe/question branches.
 */
export type EngineApprovalAction = ServiceApprovalAction & { readonly options: readonly string[] };
export type EngineApprovalBuilder = (registration: Readonly<Registration>, why: ApprovalRecordView['why'], base: Readonly<ReturnType<BaseVerdictFn>> | undefined) => EngineApprovalAction;

export interface SynchronousQueueDelivery {
  readonly kind: ServiceId;
  respondNow(item: PendingQueueApproval, answer: ApprovalAnswer, options: Readonly<RequestAnswerOptions>): RequestDelivery;
}
/** S4 supplies authenticated live authority; S2 never serializes a claim.
 * Durable proof names a server-owned continuation/job, not caller bot/thread ids.
 * Queue ports come from S2's actual singleton before recover; the binder adds
 * S4's fresh reopen verifier. Register every kind, including empty queues.
 */

export interface ProducerAuthority { readonly claim: ExecutionClaim; readonly proof: unknown }

export type ProducerQueuePort = Omit<QueueRecoverySource, 'reopen'>;

export interface ProducerBindings {
  authorityFor(threadId: string, botId: string): ProducerAuthority | undefined;
  registerQueue(source: ProducerQueuePort): () => void;
}

/** S2's singleton queue also serves the in-index skill/MCP/venue producers.
 * S4 executes only the registered call. present writes queue BEFORE attach
 * and presentApproval; accepted callbacks belong to the actual service.
 */

export interface ProducerRequest {
  readonly authority: ProducerAuthority | undefined;
  readonly ref?: string; readonly epoch?: string;
  readonly tool: string; readonly input: unknown; readonly action: ServiceApprovalAction;
  readonly view: ApprovalView; readonly base: AutoVerdict;
}

export interface ProducerOpenRequest {
  readonly handle: RequestHandle; readonly outcome: Outcome;
  readonly item: Omit<PendingQueueApproval, 'approvalId'>; readonly base: AutoVerdict;
}

export interface ProducerQueue extends ProducerQueuePort {
  /** Bind the actual acceptor for live and recovered items before recover. */
  bindAcceptance(tool: string, accept: (item: PendingQueueApproval, answer: ApprovalAnswer) => void | Promise<void>): () => void;
  open(input: ProducerRequest): ProducerOpenRequest;
  execute<T>(request: ProducerOpenRequest, operation: (call: ServiceCall) => Promise<T>): Promise<ServiceExecution<T>>;
  present(request: ProducerOpenRequest, ref: ApprovalRef,
    accept?: (item: PendingQueueApproval, answer: ApprovalAnswer) => void | Promise<void>): Promise<PendingQueueApproval>;
}

export type ProducerQueueFactory = (kind: ServiceId) => ProducerQueue;

/** Read-only execution receipt for S4's post-ack BASE activity/audit lines.
 * No second delivery or re-decision. The actual stored answer is exposed so a
 * stale RUN -> CARD/refusal cannot be logged as an executed allow. Requires a
 * registry-issued handle; preserves terminal state until its caller releases it.
 */

export interface RequestExecutionView {
  readonly outcome: Outcome['kind']; readonly delivery: DeliveryState;
  /** Complete provenance remains available on an auto-approved handle. */
  readonly ownerAuthority?: OwnerNlAuthority; readonly evidence?: readonly Evidence[];
  readonly answer?: ApprovalAnswer;
}

export interface ContinuationPage { readonly keys: readonly ContinuationKey[]; readonly next?: string }
