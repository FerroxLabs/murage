/** L8 B1: read-only, send-keyed state and action preconditions. No route grants
 * authority by importing this module. I wires authorized requests and F1/F5. */

// PROVISIONAL INTERFACE: the required base has no F1/F4/F5 modules. These
// structural subsets match DESIGN-r2 §§3/5 and I0's AttemptSnapshot and wire
// types. Replace with type imports at integration; do not infer from messages.
export interface AttemptScope { ownerId: string; botId: string; threadId: string }
export interface AttemptSnapshot extends AttemptScope {
  sendId: string; attemptId: string; revision: number; bindingEpoch: number;
  phase: "queued" | "starting" | "running" | "stopping" | "held" | "terminal";
  delivery: "not_submitted" | "uncertain" | "submitted";
  terminalOutcome: "completed" | "failed" | "refused" | "removed" | "stopped" | "abandoned_uncertain" | null;
  terminalReason: string | null; messageId: string | null; queueId: string | null;
  stopGen: string | null; restoreGen: string | null;
}
export interface BindingSnapshot extends AttemptScope {
  sendId: string; attemptId: string; bindingEpoch: number;
  generation: string; providerInstanceId: string; providerTurnId?: string;
  active: boolean; ownsGeneration: boolean; approval: boolean;
  /** Positive provider closure evidence, never merely absence of a process. */
  closed?: boolean;
}
export type TurnState = "queued" | "sending" | "running" | "approval" | "ended" | "cancelled" | "refused" | "failed" | "submitted_but_failed" | "stopped" | "unknown" | "indexing";
export interface TurnStateEnvelope {
  contract: 1; botId: string; threadId: string; sendId: string;
  attemptId: string | null; receiptRevision: number | null; bindingEpoch: number | null;
  messageId: string | null; queueId: string | null; turnId: string | null;
  state: TurnState; delivery: AttemptSnapshot["delivery"] | "unknown";
  terminalOutcome: AttemptSnapshot["terminalOutcome"]; reason: string | null;
  stopGen: string | null; restoreGen: string | null;
  actions: { remove: boolean; stop: boolean; resend: boolean; openChat: boolean };
  retryAfterMs: number | null;
}
export interface TurnCapabilities {
  turnStateContract?: number; scopedTurnStop?: number; sendActionContract?: number; queueRemovable?: boolean;
}
export interface TurnPermissions { remove: boolean; stop: boolean; resend: boolean }
export type AttemptRead = AttemptSnapshot | { kind: "missing" | "retired" };
// PROVISIONAL INTERFACE: F1 names no live-binding/readiness read adapter. I must
// supply a same-snapshot F1 read (including the receipt's inactive terminal
// binding) plus the current generation's ownership and
// F5 readiness. authorize must prove caller AND exact bot/thread visibility
// before any receipt/action lookup. It returns null for hidden/foreign subjects.
export interface TurnStateDeps {
  authorize(scope: AttemptScope): TurnPermissions | null;
  withReadSnapshot<T>(read: () => T): T;
  readAttempt(scope: AttemptScope, sendId: string): AttemptRead;
  readBinding(attempt: AttemptSnapshot): BindingSnapshot | null;
  indexReady(): boolean;
  capabilities: TurnCapabilities;
}
export type TurnStateResult = { status: 200; body: TurnStateEnvelope }
  | { status: 404; body: { error: "no such conversation" } }
  | { status: 503; body: { code: "turn_state_unavailable"; retryAfterMs: 5000 } };
const denied = { status: 404, body: { error: "no such conversation" } } as const;
const unavailable = { status: 503, body: { code: "turn_state_unavailable", retryAfterMs: 5000 } } as const;
const sameScope = (a: AttemptScope, b: AttemptScope) => a.ownerId === b.ownerId && a.botId === b.botId && a.threadId === b.threadId;
const isAttempt = (read: AttemptRead): read is AttemptSnapshot => !("kind" in read);
function sameBinding(a: AttemptSnapshot, b: BindingSnapshot | null): b is BindingSnapshot {
  return !!b && sameScope(a, b) && a.sendId === b.sendId && a.attemptId === b.attemptId
    && a.bindingEpoch === b.bindingEpoch && !!b.generation && !!b.providerInstanceId;
}
function ownedBinding(a: AttemptSnapshot, b: BindingSnapshot | null): b is BindingSnapshot {
  return sameBinding(a, b) && b.ownsGeneration;
}
function matchedBinding(a: AttemptSnapshot, b: BindingSnapshot | null): b is BindingSnapshot {
  return ownedBinding(a, b) && b.active;
}
function replacementClosed(a: AttemptSnapshot, b: BindingSnapshot | null): boolean {
  // Uncertain recovery must mint its durable Stop/restore fence (§5.2).
  // A positively submitted provider failure can also carry proven closure.
  return !!(a.stopGen || a.restoreGen) || (a.delivery === "submitted" && sameBinding(a, b) && !b.ownsGeneration && b.closed === true);
}

function empty(scope: AttemptScope, sendId: string): TurnStateEnvelope {
  return { contract: 1, botId: scope.botId, threadId: scope.threadId, sendId,
    attemptId: null, receiptRevision: null, bindingEpoch: null, messageId: null, queueId: null, turnId: null,
    state: "unknown", delivery: "unknown", terminalOutcome: null, reason: null, stopGen: null, restoreGen: null,
    actions: { remove: false, stop: false, resend: false, openChat: true }, retryAfterMs: null };
}
function stateOf(a: AttemptSnapshot, bound: boolean, approval: boolean): TurnState {
  // F7-ML4: removed receipts are authoritative even without a transcript line.
  // Do not put a missing-message check (or an index read) ahead of this branch.
  if (a.phase === "terminal") {
    if (a.terminalOutcome === "removed") return "cancelled";
    if (a.terminalOutcome === "stopped") return "stopped";
    if (a.terminalOutcome === "abandoned_uncertain" || a.delivery === "uncertain") return "unknown";
    if (a.terminalOutcome === "completed") return a.delivery === "submitted" ? "ended" : "unknown";
    if (a.terminalOutcome === "failed") return a.delivery === "submitted" ? "submitted_but_failed" : "failed";
    if (a.terminalOutcome === "refused" && a.delivery === "not_submitted") return "refused";
    return "unknown";
  }
  if (a.phase === "stopping") return "unknown";
  // Allocating a provider ID during setup proves linkage, not submission or
  // progress. The durable running phase must agree with the live binding.
  if (bound && a.phase === "running") return approval ? "approval" : "running";
  if (a.phase === "queued" && a.delivery === "not_submitted") return "queued";
  if (a.phase === "starting") return "sending";
  return "unknown";
}
function project(scope: AttemptScope, sendId: string, deps: TurnStateDeps, permissions: TurnPermissions): TurnStateEnvelope {
  const result = empty(scope, sendId);
  const a = deps.readAttempt(scope, sendId);
  if (!isAttempt(a) || !sameScope(scope, a) || a.sendId !== sendId) return result;
  // Terminal facts need neither transcript readiness nor a loaded transcript.
  const binding = deps.readBinding(a);
  const matched = matchedBinding(a, binding);
  const live = matched && !!binding.providerTurnId;
  Object.assign(result, { attemptId: a.attemptId, receiptRevision: a.revision, bindingEpoch: a.bindingEpoch,
    messageId: a.messageId, queueId: a.queueId,
    // Linkage survives closure; only Stop and running/approval require liveness.
    turnId: sameBinding(a, binding) && binding.providerTurnId ? binding.providerTurnId : null,
    delivery: a.delivery, terminalOutcome: a.terminalOutcome, reason: a.terminalReason,
    stopGen: a.stopGen, restoreGen: a.restoreGen, state: stateOf(a, live, matched && binding.approval) });
  if (a.phase !== "terminal" && !deps.indexReady()) {
    result.state = "indexing"; result.retryAfterMs = 5000;
  }
  const cap = deps.capabilities;
  const v1 = cap.turnStateContract === 1;
  result.actions.remove = v1 && cap.queueRemovable === true && permissions.remove && a.phase === "queued"
    && a.delivery === "not_submitted" && !!a.queueId && !ownedBinding(a, binding);
  result.actions.stop = v1 && cap.scopedTurnStop === 1 && permissions.stop && live && a.phase !== "terminal";
  // A held uncertain attempt is actionable only after recovery/restore closed
  // its writer and supplied a fence. Never turn lack of a process into proof.
  const replaceable = (a.phase === "terminal" && a.terminalOutcome !== "removed" && a.terminalOutcome !== "completed")
    || (a.phase === "held" && !!(a.stopGen || a.restoreGen));
  result.actions.resend = v1 && cap.sendActionContract === 1 && permissions.resend && replaceable && !ownedBinding(a, binding)
    && (a.delivery === "not_submitted" || replacementClosed(a, binding));
  return result;
}
/** The hint is never used for lookup or correlation; a restamp follows F1. */
export function askTurnState(scope: AttemptScope, sendId: string, _hintTurnId: string | undefined, deps: TurnStateDeps): TurnStateResult {
  try {
    const permissions = deps.authorize(scope);
    if (!permissions) return denied;
    return { status: 200, body: deps.withReadSnapshot(() => project(scope, sendId, deps, permissions)) };
  } catch { return unavailable; }
}

/** Used by I's authorized DELETE 404 response; this is not a removal action.
 * Client timeout/5xx/legacy-no-state handling belongs to A3. */
export function queuedCancelState(receipt: TurnStateEnvelope): { state: "started" | "sending" | "cancelled" | "failed" | "refused" | "missing"; messageId?: string } {
  const line = receipt.messageId ? { messageId: receipt.messageId } : {};
  if (receipt.state === "cancelled") return { state: "cancelled", ...line };
  if (receipt.state === "failed" || receipt.state === "refused") return { state: receipt.state, ...line };
  if (receipt.state === "sending" || receipt.state === "indexing" || receipt.state === "queued") return { state: "sending", ...line };
  if (receipt.state === "running" || receipt.state === "approval" || receipt.state === "ended" || receipt.state === "submitted_but_failed" || receipt.state === "stopped") return { state: "started", ...line };
  return { state: "missing", ...line };
}

export interface SendActionTarget {
  contract: 1; actionId: string; threadId: string; sendId: string; attemptId: string;
  receiptRevision: number; bindingEpoch: number;
}
export interface ResendAction extends SendActionTarget {
  kind: "resend"; replacementSendId: string; stopGen?: string; restoreGen?: string; confirmDuplicate: boolean;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function target(value: unknown): SendActionTarget | null {
  if (!object(value) || value.contract !== 1 || !id(value.actionId) || !id(value.threadId) || !id(value.sendId)
    || !id(value.attemptId) || !revision(value.receiptRevision) || !revision(value.bindingEpoch)) return null;
  return { contract: 1, actionId: value.actionId, threadId: value.threadId, sendId: value.sendId,
    attemptId: value.attemptId, receiptRevision: value.receiptRevision, bindingEpoch: value.bindingEpoch };
}
export function parseResendAction(value: unknown): ResendAction | null {
  const t = target(value);
  if (!t || !object(value) || value.kind !== "resend" || !id(value.replacementSendId) || value.replacementSendId === t.sendId
    || typeof value.confirmDuplicate !== "boolean" || (value.stopGen !== undefined && !id(value.stopGen))
    || (value.restoreGen !== undefined && !id(value.restoreGen))) return null;
  return { ...t, kind: "resend", replacementSendId: value.replacementSendId, confirmDuplicate: value.confirmDuplicate,
    ...(value.stopGen === undefined ? {} : { stopGen: value.stopGen as string }),
    ...(value.restoreGen === undefined ? {} : { restoreGen: value.restoreGen as string }) };
}
// PROVISIONAL INTERFACE: F1 does not specify an action-read export. I calls this
// preflight INSIDE the same acceptance transaction as the action insert/CAS.
// It never mints a replacement, stores a payload, executes Stop or redispatches.
export interface SendActionDeps extends TurnStateDeps {
  readAction(scope: AttemptScope, actionId: string): { request: ResendAction; status: "pending" | "done"; result: unknown } | null;
}
export type ActionCheck = { kind: "ready"; request: ResendAction; receipt: TurnStateEnvelope }
  | { kind: "existing"; result: unknown }
  | { kind: "error"; status: 400 | 404 | 409 | 410 | 503; code: string };
export function checkResendAction(scope: AttemptScope, body: unknown, deps: SendActionDeps): ActionCheck {
  const error = (status: 400 | 404 | 409 | 410 | 503, code: string): ActionCheck => ({ kind: "error", status, code });
  try {
    const permission = deps.authorize(scope);
    if (!permission || !permission.resend) return error(404, "no_such_conversation");
    const action = parseResendAction(body);
    if (!action || action.threadId !== scope.threadId) return error(400, "bad_scope");
    if (deps.capabilities.turnStateContract !== 1 || deps.capabilities.sendActionContract !== 1) return error(409, "unsupported_contract");
    return deps.withReadSnapshot(() => {
      const saved = deps.readAction(scope, action.actionId);
      if (saved) {
        const original = parseResendAction(saved.request);
        if (!original || JSON.stringify(original) !== JSON.stringify(action)) return error(409, "stale_action");
        if (saved.status === "done") return { kind: "existing", result: saved.result };
      }
      const a = deps.readAttempt(scope, action.sendId);
      if (!isAttempt(a)) return error(a.kind === "retired" ? 410 : 409, a.kind === "retired" ? "retired_send_id" : "stale_action");
      if (!sameScope(scope, a) || a.sendId !== action.sendId) return error(409, "stale_action");
      if (a.terminalOutcome === "removed") return error(409, "target_dismissed");
      if (a.attemptId !== action.attemptId || a.revision !== action.receiptRevision || a.bindingEpoch !== action.bindingEpoch
        || (a.stopGen ?? undefined) !== action.stopGen || (a.restoreGen ?? undefined) !== action.restoreGen) return error(409, "stale_action");
      const b = deps.readBinding(a);
      if (ownedBinding(a, b) || (a.phase !== "terminal" && !(a.phase === "held" && (a.stopGen || a.restoreGen)))) return error(409, "stop_required");
      if (a.terminalOutcome === "completed") return error(409, "stale_action");
      if (a.delivery !== "not_submitted") {
        if (!replacementClosed(a, b)) return error(409, "stop_required");
        if (!action.confirmDuplicate) return error(409, "duplicate_confirmation_required");
      }
      // Reuse this transaction's exact receipt rather than reading a different
      // snapshot between the fence check and the returned action target.
      const receipt = project(scope, action.sendId, { ...deps, readAttempt: () => a, readBinding: () => b }, permission);
      return { kind: "ready", request: action, receipt };
    });
  } catch { return error(503, "turn_state_unavailable"); }
}
