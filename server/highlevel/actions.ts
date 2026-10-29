// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One identity per HighLevel change (GAP-HIGHLEVEL-109 sections 5, 7 and 9.3):
//   proposed -> awaiting_approval -> approved -> dispatching -> applied | not_applied | outcome_unknown
// with `stale` when the approval no longer matches (expired, or the arguments, role, grant or policy revision or
// connection epoch changed). Ask before changes is fixed: only approve() with the exact review digest moves a change
// on, and nothing here can be satisfied by a generic Full access or auto-approval.
//
// The identity model follows server/connected-app-operations.ts: the record is written to a journal BEFORE anything is
// sent, and each send is recorded immediately before it leaves (recordAttempt). After a restart, approved but unsent
// work goes back to review, and a change that was dispatching becomes outcome_unknown: it is never sent again
// automatically, across turns, restarts or transcript replay. A deliberate new attempt is a new action and a new review.
//
// Review values (the arguments shown to the owner) are held apart from the record and expire with it; the record
// keeps only digests, ids and field names. Encrypting those values at rest is phase-3 work (actions/approvals).
import { createHash, randomUUID } from "node:crypto";
import type { HighLevelToolName } from "../../shared/highlevel.ts";
import { HighLevelStopped } from "./client.ts";

export type ActionPhase = "awaiting_approval" | "approved" | "dispatching" | "applied" | "not_applied" | "outcome_unknown" | "stale";

export interface ActionIntent {
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
  tool: HighLevelToolName;
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
  receipt?: { recordId: string; fields: string[]; approvalBasis: "owner_exact_review" };
}

/** The authority a change was proposed under, and is checked against again at dispatch. */
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

/** Where records live. Writes are synchronous so a refused write stops the send that depends on it. */
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
const TERMINAL: ReadonlySet<ActionPhase> = new Set(["applied", "not_applied", "stale"]);

/** Key order and the top-level connection choice carry no meaning; everything else in the arguments is the change,
 * nested fields of any name included. */
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

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const argumentsDigest = (tool: string, args: Record<string, unknown>) => sha(["highlevel-args", 1, tool, normalizeArguments(args)]);

/** The digest the owner approves: the exact change, where, under which authority, until when. */
export function reviewDigestFor(intent: Pick<ActionIntent, "actionId" | "tool" | "argumentsDigest" | "expiresAt"> & ActionContext): string {
  return sha(["highlevel-review", 1, intent.actionId, intent.botId, intent.threadId, intent.turnGeneration, intent.tool, intent.argumentsDigest,
    intent.connectionId, intent.locationId, intent.companyId, intent.connectionEpoch, intent.grantRevision, intent.accessRevision, intent.policyRevision,
    intent.roleBinding, intent.expiresAt]);
}

export class ActionRefused extends Error {
  readonly code: "busy" | "unrecorded" | "review_open" | "not_found" | "not_awaiting" | "digest_mismatch" | "expired" | "stale" | "not_approved";
  constructor(code: ActionRefused["code"], message: string) { super(message); this.code = code; this.name = "ActionRefused"; }
}

export interface ActionReview {
  actionId: string;
  reviewDigest: string;
  tool: HighLevelToolName;
  connectionId: string;
  locationId: string;
  recordRefs: string[];
  fields: string[];
  values: Record<string, unknown>;
  expiresAt: number;
  copy: string;
}

export const HIGHLEVEL_REVIEW_COPY = "Changes may run automations already set up in this CRM.";

type Decision = "approved" | "denied" | "expired";
const OPEN: ReadonlySet<ActionPhase> = new Set(["awaiting_approval", "approved", "dispatching"]);
const turnKey = (row: Pick<ActionIntent, "threadId" | "turnGeneration">) => `${row.threadId}\u0000${row.turnGeneration}`;

export class HighLevelActions {
  readonly #journal: ActionJournal;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #rows = new Map<string, ActionIntent>();
  readonly #values = new Map<string, Record<string, unknown>>();
  readonly #waiters = new Map<string, Set<(decision: Decision) => void>>();
  /** Open changes by turn and in proposal order, so per-call work never walks settled history. */
  readonly #openByTurn = new Map<string, string>();
  readonly #open = new Set<string>();
  /** Settled ids, oldest first, for bounded eviction. */
  readonly #settled = new Set<string>();

  constructor(options: { journal?: ActionJournal; now?: () => number; reviewTtlMs?: number } = {}) {
    this.#journal = options.journal ?? new MemoryActionJournal();
    this.#now = options.now ?? Date.now;
    this.#ttl = options.reviewTtlMs ?? ACTION_REVIEW_TTL_MS;
    for (const row of this.#journal.all().sort((a, b) => a.createdAt - b.createdAt)) this.#index(row);
  }

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

  /** Restart recovery. Approved but unsent work returns to review (or goes stale when its review values are gone);
   * a change that may have been sent becomes outcome_unknown and is never resent. */
  recover(values?: ReadonlyMap<string, Record<string, unknown>>): void {
    for (const actionId of this.#open) {
      const row = this.#rows.get(actionId)!;
      if (row.phase === "dispatching") this.#save({ ...row, phase: row.dispatchAttempts > 0 ? "outcome_unknown" : "awaiting_approval", approvalId: undefined, outcomeCode: row.dispatchAttempts > 0 ? "interrupted_after_send" : undefined });
      else if (row.phase === "approved") this.#save({ ...row, phase: "awaiting_approval", approvalId: undefined });
    }
    for (const actionId of this.#open) {
      const row = this.#rows.get(actionId)!;
      const kept = values?.get(row.actionId);
      if (kept && argumentsDigest(row.tool, kept) === row.argumentsDigest && row.expiresAt > this.#now()) this.#values.set(row.actionId, kept);
      else this.#settle(row, "stale", "review_values_gone");
    }
  }

  /** A new change for owner review. One open change per turn; bounded identities, never admitted by dropping an
   * unresolved one. */
  propose(context: ActionContext, tool: HighLevelToolName, args: Record<string, unknown>, detail: { recordRefs: string[]; fields: string[] }): ActionReview {
    this.#expireOpen();
    if (this.#openByTurn.has(turnKey(context))) throw new ActionRefused("review_open", "This turn already has a HighLevel change waiting for the owner. Wait for that decision first.");
    this.#evict();
    if (this.#rows.size >= ACTION_MAX_IDENTITIES) throw new ActionRefused("busy", "Too many HighLevel changes are waiting on an outcome. Ask the owner to review the CRM and clear them first.");
    const now = this.#now();
    const values = structuredClone(normalizeArguments(args)) as Record<string, unknown>;
    const base = { ...context, actionId: `hla_${randomUUID()}`, tool, argumentsDigest: argumentsDigest(tool, values), expiresAt: now + this.#ttl };
    const intent: ActionIntent = {
      ...base, recordRefs: [...detail.recordRefs], fields: [...detail.fields].sort(), reviewDigest: reviewDigestFor(base),
      phase: "awaiting_approval", dispatchAttempts: 0, createdAt: now,
    };
    try {
      this.#save(intent);
    } catch {
      throw new ActionRefused("unrecorded", "The change could not be recorded, so it was not proposed. Nothing was sent.");
    }
    this.#values.set(intent.actionId, values);
    return this.review(intent.actionId)!;
  }

  /** What the owner sees: the exact values, where, and the digest an approval must name. */
  review(actionId: string): ActionReview | undefined {
    const row = this.#rows.get(actionId);
    const values = this.#values.get(actionId);
    if (!row || !values || row.phase !== "awaiting_approval") return undefined;
    return { actionId, reviewDigest: row.reviewDigest, tool: row.tool, connectionId: row.connectionId, locationId: row.locationId,
      recordRefs: [...row.recordRefs], fields: [...row.fields], values: structuredClone(values), expiresAt: row.expiresAt, copy: HIGHLEVEL_REVIEW_COPY };
  }

  /** The owner's approval of one exact review. The owner route (credential guard) is phase-3 work; tests call this. */
  approve(actionId: string, reviewDigest: string, approvalId: string = randomUUID()): ActionIntent {
    const row = this.#rows.get(actionId);
    if (!row) throw new ActionRefused("not_found", "No HighLevel change has that id.");
    if (row.phase !== "awaiting_approval") throw new ActionRefused("not_awaiting", "This HighLevel change is not waiting for review.");
    if (row.expiresAt <= this.#now()) { this.#stale(row, "review_expired"); throw new ActionRefused("expired", "This review expired. The bot can propose the change again."); }
    if (reviewDigest !== row.reviewDigest) throw new ActionRefused("digest_mismatch", "This approval is for a different change. Review the current one.");
    const next: ActionIntent = { ...row, phase: "approved", approvalId };
    this.#save(next);
    this.#wake(actionId, "approved");
    return next;
  }

  deny(actionId: string): void {
    const row = this.#rows.get(actionId);
    if (!row || row.phase !== "awaiting_approval") return;
    this.#settle(row, "not_applied", "owner_declined");
    this.#wake(actionId, "denied");
  }

  /** Waits for the owner's decision, ending at once on Stop (HighLevelStopped) or at review expiry (then stale). */
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
        if (current?.phase === "awaiting_approval") this.#stale(current, "review_expired");
        else finish(current?.phase === "approved" ? "approved" : "expired");
      }, Math.max(0, row.expiresAt - this.#now()));
      waiters.add(finish);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  #matches(row: ActionIntent, current: ActionContext): boolean {
    return reviewDigestFor({ ...current, actionId: row.actionId, tool: row.tool, argumentsDigest: row.argumentsDigest, expiresAt: row.expiresAt }) === row.reviewDigest;
  }

  /** Before the send: the approval must still match the authority as it is now, or the change goes stale. Returns the
   * reviewed values, the only arguments that may be sent. */
  beginDispatch(actionId: string, current: ActionContext): { intent: ActionIntent; values: Record<string, unknown> } {
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
    const next: ActionIntent = { ...row, phase: "dispatching" };
    this.#save(next);
    return { intent: structuredClone(next), values: structuredClone(values) };
  }

  /** Immediately before the send: the approval is checked once more against the authority as it is now, then the
   * send is recorded. Any refusal (expired, changed, unrecordable) means nothing is sent. */
  recordAttempt(actionId: string, attempt: number, current: ActionContext): void {
    const row = this.#rows.get(actionId);
    if (!row || row.phase !== "dispatching" || row.dispatchAttempts > 0) throw new ActionRefused("not_approved", "This HighLevel change is not being sent.");
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
    if (row) this.#settle(row, "applied", undefined, { recordId: receipt.recordId, fields: [...receipt.fields].sort(), approvalBasis: "owner_exact_review" });
  }

  /** Nothing reached HighLevel, or HighLevel refused it. Never used once a send may have succeeded. */
  notApplied(actionId: string, code: string): void {
    const row = this.#rows.get(actionId);
    if (row && OPEN.has(row.phase)) this.#settle(row, "not_applied", code);
  }

  /** The approval no longer matches the authority as it is now; nothing was sent. */
  markStale(actionId: string, code: string): void {
    const row = this.#rows.get(actionId);
    if (row && (row.phase === "awaiting_approval" || row.phase === "approved" || (row.phase === "dispatching" && row.dispatchAttempts === 0))) this.#stale(row, code);
  }

  outcomeUnknown(actionId: string, code: string): void {
    const row = this.#rows.get(actionId);
    if (row && OPEN.has(row.phase)) this.#settle(row, "outcome_unknown", code);
  }

  /** This bot's own action, and nobody else's. */
  statusFor(botId: string, actionId: string): Pick<ActionIntent, "actionId" | "tool" | "phase" | "outcomeCode" | "fields" | "recordRefs" | "receipt" | "connectionId"> | undefined {
    const row = this.#rows.get(actionId);
    if (!row || row.botId !== botId) return undefined;
    return { actionId: row.actionId, tool: row.tool, phase: row.phase, outcomeCode: row.outcomeCode, fields: [...row.fields], recordRefs: [...row.recordRefs], receipt: row.receipt, connectionId: row.connectionId };
  }

  get(actionId: string): ActionIntent | undefined {
    const row = this.#rows.get(actionId);
    return row ? structuredClone(row) : undefined;
  }

  #stale(row: ActionIntent, code: string): void {
    this.#settle(row, "stale", code);
    this.#wake(row.actionId, "expired");
  }

  #settle(row: ActionIntent, phase: ActionPhase, outcomeCode?: string, receipt?: ActionIntent["receipt"]): void {
    this.#values.delete(row.actionId);
    this.#save({ ...row, phase, ...(outcomeCode ? { outcomeCode } : {}), ...(receipt ? { receipt } : {}) });
  }

  #wake(actionId: string, decision: Decision): void {
    for (const finish of this.#waiters.get(actionId) ?? []) finish(decision);
    this.#waiters.delete(actionId);
  }

  /** Expired reviews go stale. Walks open changes only (at most one per live turn). */
  #expireOpen(): void {
    const now = this.#now();
    for (const actionId of this.#open) {
      const row = this.#rows.get(actionId)!;
      if (row.phase === "awaiting_approval" && row.expiresAt <= now) this.#stale(row, "review_expired");
    }
  }

  /** Settled records beyond the bound are forgotten oldest first. Unresolved ones (open or outcome_unknown) stay. */
  #evict(): void {
    for (const actionId of this.#settled) {
      if (this.#rows.size < ACTION_MAX_IDENTITIES) return;
      try { this.#journal.delete(actionId); } catch { return; }
      this.#rows.delete(actionId);
      this.#settled.delete(actionId);
    }
  }
}
