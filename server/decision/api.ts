import type * as T from './types.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
// Frozen public contract; S1 owns the delegated implementation.
import type {
  RequestSource, RequestHandle, BaseVerdictFn, Outcome, ApprovalRef, ApprovalView, ApprovalAnswer,
  ApprovalState, QueueAttachment, ProvenanceReader, DenySources, RequestIngress, ClaimVerifier,
  RequestSnapshot, ServiceCall, ActionEvidence, ExecutionClaim, ApprovalRecordView,
  DecisionTransport, DecisionHost, QueueRecoverySource, TurnIdentity, TurnPolicy, RequestCancellation, QuestionReplyResult, ServiceExecution, ContinuationKey, ContinuationProvenance, DecisionObserver,
} from './types.ts';
import * as implementation from './implementation.ts';
export function openRequest(_source: RequestSource): RequestHandle { return implementation.openRequest(_source); }
export function decide(_handle: RequestHandle, _base: BaseVerdictFn): Outcome { return implementation.decide(_handle, _base); }
export function presentApproval(_ref: ApprovalRef, _view: ApprovalView): Promise<void> { return implementation.presentApproval(_ref, _view); }
export function attachQueue(_ref: ApprovalRef, _queue: QueueAttachment): void { return implementation.attachQueue(_ref, _queue); }
export function answerApproval(_ref: ApprovalRef, _answer: ApprovalAnswer): Promise<void> { return implementation.answerApproval(_ref, _answer); }
export function onLevelChange(_botId: string): Promise<void> { return implementation.onLevelChange(_botId); }
export function installProvenanceReader(_reader: ProvenanceReader): void { return implementation.installProvenanceReader(_reader); }
export function installDenySources(_sources: DenySources): void { return implementation.installDenySources(_sources); }
export function installRequestIngress(_bus: RequestIngress): () => void { return implementation.installRequestIngress(_bus); }
export function installClaimVerifier(_verifier: ClaimVerifier): (proof: unknown) => ExecutionClaim | undefined { return implementation.installClaimVerifier(_verifier); }
export function describeAction(_input: RequestSnapshot | ServiceCall): ActionEvidence { return implementation.describeAction(_input); }
export function recover(): Promise<void> { return implementation.recover(); }
export function settle(_ref: ApprovalRef, _state: Exclude<ApprovalState, 'open'>, _answer?: ApprovalAnswer): Promise<void> { return implementation.settle(_ref, _state, _answer); }
/** Read only from authoritative durable records, including open and terminal records.
 * Missing records return undefined. Return a frozen view with a registry-issued
 * opaque ref; never mint a record or authority from a caller-supplied id.
 * Recover initiator from durable actor_via, which must encode the original
 * Initiator at record creation; never infer it from caller data, current audience,
 * or a released generation. Unknown legacy encodings never gain owner authority.
 * Consumers join the frozen identity to message rows, never re-decide row content.
 * This read does not replace answerApproval/settle state and identity checks.
 */
export function readApproval(approvalId: string): ApprovalRecordView | undefined { return implementation.readApproval(approvalId); }
/** Read only authoritative durable open records, optionally filtered by threadId.
 * Return a frozen list of frozen views with registry-issued opaque refs; never
 * mint a record or authority from a caller-supplied id. Consumers join the frozen
 * identity to message rows before presenting, never re-decide from row content.
 * Recover initiator from durable actor_via, which must encode the original
 * Initiator at record creation; never infer it from caller data, current audience,
 * or a released generation. Unknown legacy encodings never gain owner authority.
 * This read does not replace answerApproval/settle state and identity checks.
 */
export function openApprovals(threadId?: string): readonly ApprovalRecordView[] { return implementation.openApprovals(threadId); }
/** Read only the durable open or terminal record matching BOTH thread_id and
 * chat_message_id, and verify the persisted message row's approvalId matches it.
 * Missing, legacy-without-record, or mismatched rows return undefined. Return a
 * frozen view with a registry-issued opaque ref; never mint a record or authority
 * from caller-supplied ids. Recover initiator from durable actor_via, which must
 * encode the original Initiator at creation, never from caller data, current
 * audience, or a released generation. Unknown legacy encodings never gain owner
 * authority. S4 validates/rebinds routine authority to the recipient generation.
 * This read does not replace answerApproval/settle state and identity checks;
 * HTTP owner authentication still precedes answer handling.
 */
export function lookupApproval(threadId: string, chatMessageId: string): ApprovalRecordView | undefined { return implementation.lookupApproval(threadId, chatMessageId); }
/** Install once before delivery. S1 owns persisted answerId/answer/pending,
 * acceptance, deadlines (10 s retry, 20 s interrupt), cancellation and dedup.
 * answerApproval and onLevelChange use this same transport. onLevelChange awaits
 * old-posture owner BASE answers BEFORE S4 invokes S3 onPostureChange. */
export function installDecisionTransport(transport: DecisionTransport): void { return implementation.installDecisionTransport(transport); }
/** Bind the actual store and display builder before ingress and recover; disposer is installation-scoped. */
export function installDecisionHost(host: DecisionHost): () => void { return implementation.installDecisionHost(host); }
/** Bind all actual queue instances before recover. Queue-without-record is
 * reverified/re-registered under its preallocated id. Record-without-row is
 * re-presented only for an authenticated queue; engines expire. Cancelled queue
 * tombstones require renew, fresh claim and a new id/epoch. A missing adapter or
 * rejected cancel/renew fails recover explicitly; it never reports success. */
export function installQueueSources(sources: readonly QueueRecoverySource[]): () => void { return implementation.installQueueSources(sources); }
/** Deliver an already-decided RUN/REFUSE via the installed engine transport.
 * Recheck deny revision immediately before send; stale RUN->CARD is presented
 * using DecisionHost.view, never allowed. Concurrent calls join one operation.
 * Service handles use executeService (never an engine send); a queue-backed
 * answer uses QueueRecoverySource.respond. No caller sends a second engine answer. */
export function deliverRequest(handle: RequestHandle): Promise<void> { return implementation.deliverRequest(handle); }
/** Read registered live turn authority; S4 binds this exact generation in permissionNow. */
export function readTurnPolicy(identity: TurnIdentity): TurnPolicy | undefined { return implementation.readTurnPolicy(identity); }
/** Terminalize matching requests including unpresented handles; late completions cannot reopen them. */
export function cancelRequests(scope: RequestCancellation, state: 'cancelled' | 'expired' | 'superseded'): Promise<void> { return implementation.cancelRequests(scope, state); }
/** Called only after S4 authenticates the owner. Route to the oldest durable
 * open question (FIFO <=8), parse digits/labels and only permitted free text,
 * and use answerApproval for delivery. Otherwise return send with FIFO refs:
 * S4 dispatches the instruction normally and calls relistQuestions afterwards. */
export function answerQuestionReply(threadId: string, text: string): Promise<QuestionReplyResult> { return implementation.answerQuestionReply(threadId, text); }
/** Re-emit the pending FIFO text after an ordinary send; never create a new record or permission card. */
export function relistQuestions(threadId: string): Promise<void> { return implementation.relistQuestions(threadId); }
/** Recheck deny revision at the service execution boundary using the registered
 * call, never caller input. Execute at most once for this handle and join
 * concurrent calls; no implicit retry of a failed side effect. A changed verdict
 * returns its card/question ref or refusal to the producer BEFORE execution;
 * S2 persists the queue before attaching/presenting. Engine handles are rejected.
 */
export function executeService<T>(handle: RequestHandle, execute: (call: ServiceCall) => Promise<T>): Promise<ServiceExecution<T>> { return implementation.executeService(handle, execute); }
/** Capture the exact live parent via ProvenanceReader and persist before releasing it. Reject mismatched bot/thread or unproven parent; never overwrite a conflicting key. */
export function saveContinuation(key: ContinuationKey, parent: TurnIdentity): Promise<void> { return implementation.saveContinuation(key, parent); }
/** Read only durable wake/job provenance. Missing/unknown data stays non-owner; S4 revalidates audience and routine source and rebinds recipientGeneration before dispatch. */
export function readContinuation(key: ContinuationKey): ContinuationProvenance | undefined { return implementation.readContinuation(key); }
/** Delete the durable intent provenance when its wake/job is consumed or cancelled; repeated deletion is harmless. */
export function deleteContinuation(key: ContinuationKey): Promise<void> { return implementation.deleteContinuation(key); }
/** Install a read-only accounting sink; disposer removes only this subscription.
 * S1 isolates observer failures from policy, storage and transport. This is
 * evidence of registration/delivery, never the independent expected-class oracle.
 */
export function installDecisionObserver(observer: DecisionObserver): () => void { return implementation.installDecisionObserver(observer); }

/** CONTRACT-ADD: bind the server's engine grant/option construction before
 * request handling. The returned disposer removes only this installation. */
import type { EngineApprovalBuilder } from './types.ts';
export function installEngineApprovalBuilder(_builder: EngineApprovalBuilder): () => void { return implementation.installEngineApprovalBuilder(_builder); }

/** Synchronous counterpart: captured call, final deny check, one execution shared with executeService. Reject thenables and pending async execution. */
export function executeServiceSync<T>(handle: RequestHandle, execute: (call: ServiceCall) => T): ServiceExecution<T> { return implementation.executeServiceSync(handle, execute); }

/** Queue-first presentation through the same atomic record and chat seam. */
export function presentApprovalSync(ref: ApprovalRef, view: ApprovalView): void { return implementation.presentApprovalSync(ref, view); }
/** Additional synchronous capability on the installed live queue instances. */
export function installSynchronousQueueDeliveries(deliveries: readonly import('./types.ts').SynchronousQueueDelivery[]): () => void { return implementation.installSynchronousQueueDeliveries(deliveries); }
/** Persist answerId and pending before synchronous transport; never accept a Promise. */
export function answerApprovalSync(ref: ApprovalRef, answer: ApprovalAnswer): import('../contracts.ts').RequestDelivery { return implementation.answerApprovalSync(ref, answer); }
/** Canonical and legacy successful answer labels only; failed/restart labels are excluded. */
export function isAllowedAnswer(answer: unknown): boolean { return implementation.isAllowedAnswer(answer); }

/** Public S2/S4 binding bridge; no alternate queue instance or serialized claim. */
export function installProducerBindings(_bindings: T.ProducerBindings): () => void { return implementation.installProducerBindings(_bindings); }

export function producerAuthorityFor(_threadId: string, _botId: string): T.ProducerAuthority | undefined { return implementation.producerAuthorityFor(_threadId, _botId); }

export function registerProducerQueue(_source: T.ProducerQueuePort): () => void { return implementation.registerProducerQueue(_source); }

export function installProducerQueueFactory(_factory: T.ProducerQueueFactory): () => void { return implementation.installProducerQueueFactory(_factory); }

export function producerQueue(_kind: T.ServiceId): T.ProducerQueue { return implementation.producerQueue(_kind); }

/** Post-ack display/audit receipt; grants no authority and never sends. */
export function readRequestExecution(_handle: T.RequestHandle): Readonly<T.RequestExecutionView> { return implementation.readRequestExecution(_handle); }

/** Read the durable answer/ack receipt after answerApproval; never re-send. */
export function readApprovalExecution(_ref: T.ApprovalRef): Readonly<T.RequestExecutionView> { return implementation.readApprovalExecution(_ref); }

/** Shared-peer keys in canonical key order, using an exact namespace partial index.
 * Repeats the literal GLOB predicate (no JSON functions): at most limit+1 rows
 * examined, including the next-page probe. next is the last returned key.
 * deleteContinuation commits synchronously before returning its promise; a
 * missing key is a no-op. Consumers check and delete in one synchronous block. */
export function listContinuations(filter: { kind: 'background-job'; namespace: 'shared-peer'; after?: string; limit: number }): T.ContinuationPage { return implementation.listContinuations(filter); }
