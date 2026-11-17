/** L8 F4/F6 wire contract v1. Shapes only: these values confer no authority. */
export const TURN_STATE_CONTRACT = 1 as const;
export const SCOPED_TURN_STOP = 1 as const;
export const SEND_ACTION_CONTRACT = 1 as const;
export const TURN_STATES = ["queued", "sending", "running", "approval", "ended", "cancelled", "refused", "failed", "submitted_but_failed", "stopped", "unknown", "indexing"] as const;
export type TurnState = typeof TURN_STATES[number];
export const ATTEMPT_DELIVERIES = ["not_submitted", "uncertain", "submitted"] as const;
export type AttemptDelivery = typeof ATTEMPT_DELIVERIES[number];
export type TurnDelivery = AttemptDelivery | "unknown";
export const ATTEMPT_PHASES = ["queued", "starting", "running", "stopping", "held", "terminal"] as const;
export type AttemptPhase = typeof ATTEMPT_PHASES[number];
export const TERMINAL_OUTCOMES = ["completed", "failed", "refused", "removed", "stopped", "abandoned_uncertain"] as const;
export type TerminalOutcome = typeof TERMINAL_OUTCOMES[number];
export type ReplayPolicy = "exclude" | "allow";
export type SendActionKind = "resend" | "remove" | "stop";

/** Missing capabilities (including an unsupported version) mean no new mutation. */
export interface TurnStateCapabilities {
  turnStateContract?: typeof TURN_STATE_CONTRACT;
  scopedTurnStop?: typeof SCOPED_TURN_STOP;
  sendActionContract?: typeof SEND_ACTION_CONTRACT;
  queueRemovable?: boolean;
}
export interface TurnStateActions { remove: boolean; stop: boolean; resend: boolean; openChat: boolean }
export interface TurnStateEnvelope {
  contract: 1;
  botId: string;
  threadId: string;
  sendId: string;
  attemptId: string | null;
  receiptRevision: number | null;
  bindingEpoch: number | null;
  messageId: string | null;
  queueId: string | null;
  turnId: string | null;
  state: TurnState;
  delivery: TurnDelivery;
  terminalOutcome: TerminalOutcome | null;
  reason: string | null;
  stopGen: string | null;
  restoreGen: string | null;
  actions: TurnStateActions;
  retryAfterMs: number | null;
}
export interface SendActionTarget {
  contract: 1;
  actionId: string;
  threadId: string;
  sendId: string;
  attemptId: string;
  receiptRevision: number;
  bindingEpoch: number;
}
export interface ResendAction extends SendActionTarget {
  kind: "resend";
  replacementSendId: string;
  stopGen?: string;
  restoreGen?: string;
  confirmDuplicate: boolean;
}
export interface ScopedTurnStop extends SendActionTarget { turnId: string }
export type RemoveSendAction = SendActionTarget;
/** PROVISIONAL INTERFACE: §5.3 names receipt without a nested shape. Action
 * success uses the full §5.2 envelope; the ML3 retry receipt stays separate. */
export interface ResendActionResult {
  actionId: string;
  replacementSendId: string;
  replacementAttemptId: string;
  receipt: TurnStateEnvelope;
}
export interface RemoveSendActionResult { ok: true; state: "cancelled"; actionId: string; receipt: TurnStateEnvelope }
export interface ScopedTurnStopResult {
  ok: true;
  matched: boolean;
  stopped: boolean;
  unconfirmed: false;
  actionId: string;
  receipt: TurnStateEnvelope;
}
export type SendActionErrorCode = "stale_action" | "stop_required" | "duplicate_confirmation_required" | "retired_send_id" | "target_dismissed";
export interface SendActionError { code: SendActionErrorCode }
export interface ScopedTurnStopError {
  code: "provider_stop_unconfirmed" | "settlement_pending";
  matched: true;
  stopped: false;
  unconfirmed: true;
  actionId: string;
}
export interface TurnStateUnavailable { code: "turn_state_unavailable"; retryAfterMs: 5000 }
export interface TurnIndexNotReady { code: "turn_index_not_ready"; accepted: false; retryAfterMs: 5000 }
/** RULING R1/ML3 uses removed on the send receipt; the state endpoint retains cancelled. */
export type ExistingFailedReceiptState = "failed" | "refused" | "removed" | "stopped" | "unknown";
export interface ExistingFailedSendReceipt {
  ok: false;
  existing: true;
  threadId: string;
  receipt: { state: ExistingFailedReceiptState; attemptId: string; receiptRevision: number };
}
/** Legacy explicit resend is converted once to replacementSendId = `r-${actionId}`. */
export interface LegacyExplicitResend {
  sendId: string;
  resend: true;
  actionId?: string;
  stopGen?: string;
  restoreGen?: string;
}
/** Panel views are distinct from wire states; mapping cancelled -> removed belongs to A3. */
export type HelpTurnView = "draft" | "no_chief" | "sending" | "queued" | "running" | "approval" | "ended" | "removed" | "refused" | "failed_not_submitted" | "submitted_but_failed" | "stopped" | "unknown" | "indexing" | "removing" | "stopping" | "remove_error" | "stop_error" | "missing_transcript" | "duplicate_confirmation";
