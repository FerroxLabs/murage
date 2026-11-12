// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { heldOperationHooks } from './operation-hooks.ts';
import { createHash, randomUUID } from "node:crypto";
import type { Risk, OperationId } from "../../shared/highlevel.ts";
import type { Escalation } from "./escalation.ts";
import { HeldRequest } from './held-request.ts';
import { heldToolCallActions } from './tool-call-binding.ts';
import { HighLevelStopped } from "./client.ts";

const TERMINAL: ReadonlySet<ActionPhase> = new Set(["applied", "not_applied", "stale", "read_done", "read_withheld"]);

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const OPEN: ReadonlySet<ActionPhase> = new Set(["awaiting_approval", "approved", "dispatching"]);

const turnKey = (row: Pick<ActionIntent, "threadId" | "turnGeneration">) => `${row.threadId}\u0000${row.turnGeneration}`;

export type ApprovalBasis = "owner_exact_review" | "owner_no_limits" | "owner_no_limits_attended";

export interface ActionBinding {
  /** Digest only: server-derived review values never enter the journal. */
  approvalContextDigest?: string;
  completionKind?: 'private_generated_password_v1';
  kind: "read" | "change"; operation: OperationId; resource: string; risk: Risk; escalation: Escalation;
  basis: ApprovalBasis; requestDigest: string; bodySha256: string;
  upload: { name: string; size: number; sha256: string } | null;
}

export interface ProposeDetail {
  kind: "read" | "change"; risk: Risk; escalation: Escalation; basis: ApprovalBasis;
  recordRefs: string[]; fields: string[]; held: HeldRequest;
}

export type ActionPhase = "awaiting_approval" | "approved" | "dispatching" | "applied" | "not_applied" | "outcome_unknown" | "stale" | "read_done" | "read_withheld";

export interface ActionIntent extends ActionBinding {
  actionId: string;
  botId: string;
  threadId: string;
  turnGeneration: string;
  connectionId: string;
  connectionEpoch: number;
  locationId: string;
  companyId: string;
  grantRevision: number;
  accessRevision: number;
  policyRevision: number;
  roleBinding: string;
  tool: string;
  argumentsDigest: string;
  /** Record ids the change names (contact, opportunity, pipeline); never values. */
  recordRefs: string[];
  /** Field names the change touches; never values. */
  fields: string[];
  reviewDigest: string;
  phase: ActionPhase;
  approvalId?: string;
  dispatchAttempts: number;
  createdAt: number;
  expiresAt: number;
  outcomeCode?: string;
  receipt?: { recordId: string; fields: string[]; approvalBasis: ApprovalBasis };
}

export interface ActionContext {
  botId: string;
  threadId: string;
  turnGeneration: string;
  connectionId: string;
  connectionEpoch: number;
  locationId: string;
  companyId: string;
  /** The selected NativeGrant's own revision. */
  grantRevision: number;
  /** The bot's whole native grant record revision. */
  accessRevision: number;
  policyRevision: number;
  roleBinding: string;
}

export interface ActionJournal {
  put(intent: ActionIntent): void;
  delete(actionId: string): void;
  all(): ActionIntent[];
}

export class MemoryActionJournal implements ActionJournal {
  readonly rows = new Map<string, ActionIntent>();
  put(intent: ActionIntent): void { this.rows.set(intent.actionId, structuredClone(intent)); }
  delete(actionId: string): void { this.rows.delete(actionId); }
  all(): ActionIntent[] { return [...this.rows.values()].map((row) => structuredClone(row)); }
}

export const ACTION_MAX_IDENTITIES = 2_000;

export const ACTION_REVIEW_TTL_MS = 10 * 60_000;

export function normalizeArguments(args: Record<string, unknown>): unknown {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, sort(item)]));
    }
    return value;
  };
  const { connectionId: _selector, ...change } = args;
  return sort(change);
}

export const argumentsDigest = (tool: string, args: Record<string, unknown>) => sha(["highlevel-args", 1, tool, normalizeArguments(args)]);

export type ReviewDigestInput = Pick<ActionIntent, "actionId" | "tool" | "argumentsDigest" | "expiresAt"> & ActionContext & ActionBinding;

export function reviewDigestFor(intent: ReviewDigestInput): string {
  // F0's public input type predates these existing persisted metadata fields.
  // Production always passes the complete proposal/intent; bind both arrays.
  const metadata = intent as ReviewDigestInput & Partial<Pick<ActionIntent, "recordRefs" | "fields">>;
  return sha(["highlevel-review", 3, intent.actionId, intent.botId, intent.threadId, intent.turnGeneration, intent.tool, intent.argumentsDigest,
    intent.connectionId, intent.locationId, intent.companyId, intent.connectionEpoch, intent.grantRevision, intent.accessRevision, intent.policyRevision,
    intent.roleBinding, intent.expiresAt, intent.basis, intent.kind, intent.operation, intent.risk, intent.escalation, intent.requestDigest, intent.resource, intent.bodySha256,
    intent.upload ? [intent.upload.name, intent.upload.size, intent.upload.sha256] : null, metadata.recordRefs, metadata.fields,
    ...(intent.approvalContextDigest ? [intent.approvalContextDigest] : []), ...(intent.completionKind ? [intent.completionKind] : [])]);
}

export class ActionRefused extends Error {
  readonly code: "busy" | "unrecorded" | "review_open" | "not_found" | "not_awaiting" | "digest_mismatch" | "expired" | "stale" | "not_approved" | "one_send" | "request_shape";
  constructor(code: ActionRefused["code"], message: string) { super(message); this.code = code; this.name = "ActionRefused"; }
}

export interface ActionReview extends ActionBinding {
  actionId: string;
  reviewDigest: string;
  tool: string;
  connectionId: string;
  locationId: string;
  recordRefs: string[];
  fields: string[];
  values: Record<string, unknown>;
  expiresAt: number;
  copy: string;
}

export const HIGHLEVEL_REVIEW_COPY = "Changes may run automations already set up in this CRM.";

export type Decision = "approved" | "denied" | "expired";

export class HighLevelActions {
  readonly #journal: ActionJournal;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #rows = new Map<string, ActionIntent>();
  readonly #held = new Map<string, HeldRequest>();
  readonly #values = new Map<string, Record<string, unknown>>();
  readonly #waiters = new Map<string, Set<(decision: Decision) => void>>();
  readonly #openByTurn = new Map<string, string>();
  readonly #open = new Set<string>();
  readonly #settled = new Set<string>();
  #index(row: ActionIntent): void {
    this.#rows.set(row.actionId, row);
    const key = turnKey(row);
    if (OPEN.has(row.phase)) {
      this.#open.add(row.actionId);
      this.#openByTurn.set(key, row.actionId);
      this.#settled.delete(row.actionId);
    } else {
      this.#open.delete(row.actionId);
      if (this.#openByTurn.get(key) === row.actionId) this.#openByTurn.delete(key);
      if (TERMINAL.has(row.phase)) this.#settled.add(row.actionId);
      else this.#settled.delete(row.actionId);
    }
  }
  #save(intent: ActionIntent): void {
    this.#journal.put(intent);
    this.#index(intent);
  }
  #matches(row: ActionIntent, current: ActionContext): boolean {
    return reviewDigestFor({ ...row, ...current }) === row.reviewDigest;
  }
  #stale(row: ActionIntent, code: string): void {
    this.#settle(row, "stale", code);
    this.#wake(row.actionId, "expired");
  }
  #settle(row: ActionIntent, phase: ActionPhase, outcomeCode?: string, receipt?: ActionIntent["receipt"]): void {
    this.#values.delete(row.actionId); this.#held.delete(row.actionId);
    this.#save({ ...row, phase, ...(outcomeCode ? { outcomeCode } : {}), ...(receipt ? { receipt } : {}) });
  }
  #wake(actionId: string, decision: Decision): void {
    for (const finish of this.#waiters.get(actionId) ?? []) finish(decision);
    this.#waiters.delete(actionId);
  }
  #expireOpen(): void {
    const now = this.#now();
    for (const actionId of this.#open) {
      const row = this.#rows.get(actionId)!;
      if (row.phase === "awaiting_approval" && row.expiresAt <= now) this.#stale(row, "review_expired");
    }
  }
  #evict(): void {
    for (const actionId of this.#settled) {
      if (this.#rows.size < ACTION_MAX_IDENTITIES) return;
      try { this.#journal.delete(actionId); } catch { return; }
      this.#rows.delete(actionId);
      this.#settled.delete(actionId);
    }
  }
  constructor(options: { journal?: ActionJournal; now?: () => number; reviewTtlMs?: number } = {}) {
    this.#journal = options.journal ?? new MemoryActionJournal();
    this.#now = options.now ?? Date.now;
    this.#ttl = options.reviewTtlMs ?? ACTION_REVIEW_TTL_MS;
    for (const row of this.#journal.all().sort((a, b) => a.createdAt - b.createdAt)) this.#index(row);
  }
  propose(context: ActionContext, tool: string, args: Record<string, unknown>, detail: ProposeDetail): ActionReview {
    this.#expireOpen();
    if (this.#openByTurn.has(turnKey(context))) throw new ActionRefused("review_open", "This turn already has a HighLevel change waiting for the owner. Wait for that decision first.");
    this.#evict();
    if (this.#rows.size >= ACTION_MAX_IDENTITIES) throw new ActionRefused("busy", "Too many HighLevel changes are waiting on an outcome. Ask the owner to review the CRM and clear them first.");
    const now = this.#now();
    const values = structuredClone(normalizeArguments(args)) as Record<string, unknown>;
    if (!(detail.held instanceof HeldRequest) || !['read', 'change'].includes(detail.kind)
      || !['R', 'C', 'D'].includes(detail.risk) || (detail.kind === 'read') !== (detail.risk === 'R')
      || !['none', 'send_count', 'targets', 'identical_loop'].includes(detail.escalation)
      || !['owner_exact_review', 'owner_no_limits', 'owner_no_limits_attended'].includes(detail.basis))
      throw new ActionRefused('request_shape', 'A complete frozen request and authority are required.');
    const held = detail.held, frozen = held.frozen;
    if (frozen.operation === 'users.create' && (frozen.completionKind !== 'private_generated_password_v1'))
      throw new ActionRefused('not_approved', 'Only you can add users, from the desktop app.');
    const upload = frozen.upload ? { name: frozen.upload.name, size: frozen.upload.size, sha256: frozen.upload.sha256 } : null;
    const actionId = heldToolCallActions.get(held) ?? `hla_${randomUUID()}`;
    if (this.#rows.has(actionId)) throw new ActionRefused('one_send', 'This tool call already has a recorded action.');
    const base = {
      ...context, kind: detail.kind, operation: frozen.operation, risk: detail.risk,
      escalation: detail.escalation, basis: detail.basis, requestDigest: frozen.requestDigest,
      ...(held.approvalContextDigest ? { approvalContextDigest: held.approvalContextDigest } : {}),
      ...(frozen.completionKind ? { completionKind: frozen.completionKind } : {}),
      resource: frozen.resource, bodySha256: frozen.bodySha256, upload,
      recordRefs: [...detail.recordRefs], fields: [...detail.fields].sort(),
      actionId, tool, argumentsDigest: argumentsDigest(tool, values), expiresAt: now + this.#ttl
    };
    const intent: ActionIntent = {
      ...base, reviewDigest: reviewDigestFor(base),
      phase: "awaiting_approval", dispatchAttempts: 0, createdAt: now,
    };
    try {
      this.#save(intent);
    } catch {
      throw new ActionRefused("unrecorded", "The change could not be recorded, so it was not proposed. Nothing was sent.");
    }
    this.#values.set(intent.actionId, values);
    if (held) this.#held.set(intent.actionId, held);
    return this.review(intent.actionId)!;
  }
  /** F0.1: verify approval/current authority and retain this exact held request
   * through send, recordId(value, held.frozen), project(value, held.frozen),
   * and release before settling applied. See ./F0.1.md. */
  beginDispatch(actionId: string, current: ActionContext): { intent: ActionIntent; held: HeldRequest } {
    const row = this.#rows.get(actionId);
    if (!row) throw new ActionRefused("not_found", "No HighLevel change has that id.");
    if (row.phase !== "approved") throw new ActionRefused("not_approved", "This HighLevel change has not been approved.");
    if (row.expiresAt <= this.#now()) { this.#stale(row, "review_expired"); throw new ActionRefused("expired", "The approval expired before the change was sent. Nothing was sent."); }
    const values = this.#values.get(actionId);
    if (!values || argumentsDigest(row.tool, values) !== row.argumentsDigest) { this.#stale(row, "review_values_gone"); throw new ActionRefused("stale", "The reviewed change is no longer held, so it was not sent. The bot can propose it again."); }
    if (!this.#matches(row, current)) {
      this.#stale(row, "authority_changed");
      throw new ActionRefused("stale", "The bot's access or the connection changed after approval, so the change was not sent. The bot can propose it again.");
    }
    const held = this.#held.get(actionId);
    if (!held || held.frozen.requestDigest !== row.requestDigest) { this.#stale(row, "request_changed"); throw new ActionRefused("stale", "The reviewed request is no longer held."); }
    if (held.approvalContextDigest !== row.approvalContextDigest
      || held.frozen.bodySha256 !== row.bodySha256 || held.frozen.operation !== row.operation || held.frozen.resource !== row.resource
      || JSON.stringify(held.frozen.upload ? { name: held.frozen.upload.name, size: held.frozen.upload.size, sha256: held.frozen.upload.sha256 } : null) !== JSON.stringify(row.upload)) {
      this.#stale(row, 'request_changed'); throw new ActionRefused('stale', 'The reviewed request changed.');
    }
    const next: ActionIntent = { ...row, phase: "dispatching" };
    this.#save(next);
    this.#values.delete(actionId); this.#held.delete(actionId);
    return { intent: structuredClone(next), held };
  }
  settleRead(actionId: string, result: "read_done" | "read_withheld" | "failed" | "stopped", code?: string): void {
    const row = this.#rows.get(actionId);
    if (!row || row.risk !== 'R' || !OPEN.has(row.phase)) return;
    this.#settle(row, result === 'failed' || result === 'stopped' ? 'not_applied' : result, result === 'failed' ? 'read_failed' : result === 'stopped' ? 'stopped' : code);
  }
  recover(): void {
    // Approved writes retain their identity even before the first attempt. Lost
    // bytes permit only durable read recovery, never a new review or send.
    for (const actionId of this.#open) {
      const row = this.#rows.get(actionId)!;
      if (row.risk !== "R" && (row.phase === "approved" || row.phase === "dispatching"))
        this.#save({ ...row, phase: "outcome_unknown", outcomeCode: row.dispatchAttempts > 0 ? "interrupted_after_send" : "interrupted_after_approval" });
      else if (row.phase === "dispatching") this.#save({ ...row, phase: "not_applied", outcomeCode: "read_failed" });
    }
    for (const actionId of this.#open) {
      const row = this.#rows.get(actionId)!;
      this.#settle(row, "stale", "review_values_gone");
    }
  }
  review(actionId: string): ActionReview | undefined {
    const row = this.#rows.get(actionId);
    if (row?.phase === "awaiting_approval" && row.expiresAt <= this.#now()) {
      try { this.#stale(row, "review_expired"); } catch { this.#values.delete(actionId); this.#held.delete(actionId); }
      return undefined;
    }
    const values = this.#values.get(actionId);
    if (!row || !values || row.phase !== "awaiting_approval") return undefined;
    const prepared = this.#held.get(actionId)?.frozen.upload;
    const held = this.#held.get(actionId);
    const metadata = held ? heldOperationHooks.get(held.frozen)?.reviewValues?.(held) : undefined;
    return {
      actionId, kind: row.kind, ...(row.completionKind ? { completionKind: row.completionKind } : {}), escalation: row.escalation, upload: row.upload ? { ...row.upload } : null, requestDigest: row.requestDigest, resource: row.resource, bodySha256: row.bodySha256, reviewDigest: row.reviewDigest, tool: row.tool, operation: row.operation, risk: row.risk, basis: row.basis, connectionId: row.connectionId, locationId: row.locationId,
      recordRefs: [...row.recordRefs], fields: [...row.fields], values: { ...structuredClone(values), ...this.#held.get(actionId)?.approvalContextCopy()?.values, ...(metadata ?? {}), ...(prepared ? { upload: { name: prepared.name, size: prepared.size, sha256: prepared.sha256 } } : {}) }, expiresAt: row.expiresAt, copy: HIGHLEVEL_REVIEW_COPY
    };
  }
  approve(actionId: string, reviewDigest: string, approvalId?: string): ActionIntent {
    return this.#approve(actionId, reviewDigest, approvalId);
  }
  #approve(actionId: string, reviewDigest: string, approvalId?: string): ActionIntent {
    const row = this.#rows.get(actionId);
    if (!row) throw new ActionRefused("not_found", "No HighLevel change has that id.");
    if (row.phase !== "awaiting_approval") throw new ActionRefused("not_awaiting", "This HighLevel change is not waiting for review.");
    if (row.expiresAt <= this.#now()) { this.#stale(row, "review_expired"); throw new ActionRefused("expired", "This review expired. The bot can propose the change again."); }
    if (reviewDigest !== row.reviewDigest) throw new ActionRefused("digest_mismatch", "This approval is for a different change. Review the current one.");
    // The action identity also survives transport replay and action cleanup in the approval subjournal.
    const next: ActionIntent = { ...row, phase: "approved", approvalId: approvalId ?? row.actionId };
    this.#save(next);
    this.#wake(actionId, "approved");
    return structuredClone(next);
  }
  approveByPolicy(actionId: string, basis: Exclude<ApprovalBasis, "owner_exact_review">): ActionIntent {
    const row = this.#rows.get(actionId);
    if (!row || row.basis !== basis || (basis !== "owner_no_limits" && basis !== "owner_no_limits_attended"))
      throw new ActionRefused("not_approved", "This change needs the owner's exact review.");
    if (row.risk === "D" && basis !== "owner_no_limits_attended") throw new ActionRefused("not_approved", "This change needs the owner at their computer.");
    return this.approve(actionId, row.reviewDigest);
  }
  staleConnection(connectionId: string, code: string): void {
    for (const id of [...this.#open]) if (this.#rows.get(id)?.connectionId === connectionId) this.markStale(id, code);
  }
  deny(actionId: string): void {
    const row = this.#rows.get(actionId);
    if (!row || row.phase !== "awaiting_approval") return;
    this.#settle(row, "not_applied", "owner_declined");
    this.#wake(actionId, "denied");
  }
  awaitDecision(actionId: string, signal: AbortSignal): Promise<Decision> {
    const row = this.#rows.get(actionId);
    if (!row) return Promise.reject(new ActionRefused("not_found", "No HighLevel change has that id."));
    if (row.phase === "approved") return Promise.resolve("approved");
    if (row.phase !== "awaiting_approval") return Promise.resolve(row.outcomeCode === "owner_declined" ? "denied" : "expired");
    if (signal.aborted) return Promise.reject(new HighLevelStopped());
    return new Promise<Decision>((resolve, reject) => {
      const waiters = this.#waiters.get(actionId) ?? new Set();
      this.#waiters.set(actionId, waiters);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        waiters.delete(finish);
        if (waiters.size === 0 && this.#waiters.get(actionId) === waiters) this.#waiters.delete(actionId);
      };
      const finish = (decision: Decision) => { cleanup(); resolve(decision); };
      const onAbort = () => { cleanup(); reject(new HighLevelStopped()); };
      const timer = setTimeout(() => {
        const current = this.#rows.get(actionId);
        if (current?.phase !== "awaiting_approval") { finish(current?.phase === "approved" ? "approved" : "expired"); return; }
        try {
          this.#stale(current, "review_expired");
        } catch {
          // The expiry could not be recorded. The review values are already gone, so nothing can be dispatched from it.
          this.#values.delete(actionId); this.#held.delete(actionId);
          cleanup();
          reject(new ActionRefused("unrecorded", "The review expired and that could not be recorded. Nothing was sent."));
        }
      }, Math.max(0, row.expiresAt - this.#now()));
      waiters.add(finish);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  recordAttempt(actionId: string, attempt: number, current: ActionContext): void {
    const row = this.#rows.get(actionId);
    if (!row || row.phase !== "dispatching" || (row.risk === "R" ? attempt !== row.dispatchAttempts + 1 || attempt > 2 : row.dispatchAttempts > 0)) throw new ActionRefused("not_approved", "This HighLevel change is not being sent.");
    if (row.expiresAt <= this.#now()) { this.#settle(row, "stale", "review_expired"); throw new ActionRefused("expired", "The approval expired before the change was sent. Nothing was sent."); }
    if (!this.#matches(row, current)) { this.#settle(row, "stale", "authority_changed"); throw new ActionRefused("stale", "The bot's access or the connection changed after approval, so the change was not sent."); }
    try {
      this.#save({ ...row, dispatchAttempts: attempt });
    } catch {
      throw new ActionRefused("unrecorded", "The send could not be recorded, so it was not sent.");
    }
  }
  applied(actionId: string, receipt: { recordId: string; fields: string[] }): void {
    const row = this.#rows.get(actionId);
    // The host supplies a journaled, validated receipt when completing interrupted publication.
    if (row?.phase === "dispatching" || row?.phase === "outcome_unknown") this.#settle({ ...row, outcomeCode: undefined }, "applied", undefined, { recordId: receipt.recordId, fields: [...receipt.fields].sort(), approvalBasis: row.basis ?? "owner_exact_review" });
  }
  notApplied(actionId: string, code: string): void {
    const row = this.#rows.get(actionId);
    if (row && (OPEN.has(row.phase) || (row.phase === "outcome_unknown" && code === "negative_confirmation"))) this.#settle(row, "not_applied", code);
  }
  markStale(actionId: string, code: string): void {
    const row = this.#rows.get(actionId);
    if (row && (row.phase === "awaiting_approval" || row.phase === "approved" || (row.phase === "dispatching" && (row.dispatchAttempts === 0 || row.risk === "R" || code === "request_changed")))) this.#stale(row, code);
  }
  outcomeUnknown(actionId: string, code: string): void {
    const row = this.#rows.get(actionId);
    if (row && OPEN.has(row.phase)) this.#settle(row, "outcome_unknown", code);
  }
  statusFor(botId: string, actionId: string): Pick<ActionIntent, "actionId" | "tool" | "phase" | "outcomeCode" | "fields" | "recordRefs" | "receipt" | "connectionId"> | undefined {
    const row = this.#rows.get(actionId);
    if (!row || row.botId !== botId) return undefined;
    return { actionId: row.actionId, tool: row.tool, phase: row.phase, outcomeCode: row.outcomeCode, fields: [...row.fields], recordRefs: [...row.recordRefs], receipt: row.receipt ? structuredClone(row.receipt) : undefined, connectionId: row.connectionId };
  }
  get(actionId: string): ActionIntent | undefined {
    const row = this.#rows.get(actionId);
    return row ? structuredClone(row) : undefined;
  }

}
