// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One identity per connected-app action, so a slow action is never
// dispatched twice.
//
// The bot's wait for an action ends at the interactive bound
// (CONNECTED_APP_ACTION_TIMEOUT_MS); the action itself does not. It keeps
// running here for up to its lifetime, its outcome is kept, and the bot is
// handed a handle. The same request made again (same tool, same effect-bearing
// arguments, same bot and connected-app account) while the action runs, or
// before its outcome is collected, joins the existing operation instead of
// sending anything upstream. The connected-apps broker forwards no
// idempotency key upstream (FluxRouter composio_broker_route.py forwards only
// the body, content-type and mcp-session-id), so this ledger is the guard.
//
// Two things are kept apart:
//   the RECORD   a small identity entry that blocks a repeat. It is written to
//                a durable journal (server/connected-app-journal.ts) BEFORE the
//                action is sent, survives a restart, and is only released by
//                the bot (run_again), by a delivered result's short repeat
//                window, or because nothing reached the app.
//   the RESULT   the app's answer bytes. Memory-bounded and evictable. When a
//                result is evicted the record stays and says so; the bot is
//                told to check the app, and a repeat is still held.
//
// Outcomes:
//   answered  the broker answered (any JSON-RPC result, error or not)
//   not-sent  nothing reached the app (explicitly refused before dispatch);
//             never blocks a new request
//   unknown   the request may have left but no answer is held: no answer came
//             back, Murage restarted mid-send, or the result was evicted.
//             Blocks a repeat until the bot checks the app and clears it.
//
// Only protected calls get a durable record. A call the reviewed catalog
// verifies as read-only (shared/connected-app-readonly.ts) is `fresh`: every
// new invocation runs, nothing blocks it, nothing is journaled, and its kept
// answer is only a historical record for CHECK_CONNECTED_APP_ACTION. Writes,
// unknown tools and mixed batches are protected.
//
// Storage faults are never silent: a write or delete the journal refuses is
// retried with backoff (reconcile), counted, logged, and shown by health().
// A journal that cannot be read at start refuses protected dispatch and is
// retried with backoff; it never latches.
//
// Bounded: at most OPERATION_MAX_PENDING running actions, OPERATION_MAX_RECORDS
// records, and OPERATION_MAX_ENTRIES / OPERATION_MAX_BYTES of kept results.
// A new action beyond a record bound is refused, never admitted by releasing
// an unresolved one.
import { createHash, randomUUID } from "node:crypto";
import {
  CONNECTED_APP_REPEAT_WINDOW_MS,
  CONNECTED_APP_RESULT_TTL_MS,
  type ConnectedAppRequirement,
  type UnknownCause,
} from "../shared/connected-app-calls.ts";
import { scopeMatches, type JournalRecord, type OperationJournal } from "./connected-app-journal.ts";

export interface RelayReply {
  status: number;
  bytes: Uint8Array;
  contentType: string;
  transportSessionId?: string;
  /** Unset when the broker answered. */
  delivery?: "not-sent" | "unknown";
}

export type OperationOutcome =
  | { kind: "answered"; reply: RelayReply }
  | { kind: "not-sent"; reply?: RelayReply; error?: unknown }
  | { kind: "unknown"; reason: string; cause: UnknownCause };

export interface ConnectedAppOperation {
  readonly handle: string;
  readonly scope: string;
  readonly key: string;
  readonly label: string | undefined;
  readonly startedAt: number;
  /** The JSON-RPC id of the request that started it; a stored SSE answer is matched to it. */
  readonly requestId: unknown;
  /** What the action needed the bot to be allowed to do, rechecked on every later read. */
  readonly requirements: ConnectedAppRequirement[];
  /** Whether `requirements` names everything the action used; false is denied to a restricted bot. */
  readonly requirementsComplete: boolean;
  /** A verified read: runs every time, never blocks, never journaled. */
  readonly fresh: boolean;
  done: Promise<OperationOutcome>;
  outcome?: OperationOutcome;
  settledAt?: number;
  deliveredAt?: number;
  /** Bytes of the kept result (every retained buffer counts). */
  bytes: number;
}

/** Kept results (answer buffers), not records. */
export const OPERATION_MAX_ENTRIES = 200;
export const OPERATION_MAX_BYTES = 64 * 1024 * 1024;
/** Actions running at once. */
export const OPERATION_MAX_PENDING = 200;
/** Records of every kind; each is a few hundred bytes. */
export const OPERATION_MAX_RECORDS = 2_000;

/** A new action was not admitted; nothing was sent. */
export class OperationRefused extends Error {
  readonly reason: "busy" | "unrecorded";
  constructor(reason: "busy" | "unrecorded", detail?: string) {
    super(detail ?? (reason === "busy" ? "too many connected app actions are waiting on an outcome" : "the action's record could not be saved"));
    this.reason = reason;
  }
}

/** Stable JSON: object keys sorted, so argument order never changes identity. */
export function normalizedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalizedJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${normalizedJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function operationKey(tool: string, args: unknown): string {
  return createHash("sha256").update(tool).update("\0").update(normalizedJson(args ?? null)).digest("hex");
}

export interface StartMeta {
  requestId?: unknown;
  requirements?: ConnectedAppRequirement[];
  /** Defaults to false (unknown provenance). */
  requirementsComplete?: boolean;
  /** A verified read-only call: see the header. */
  fresh?: boolean;
}

/** Backoff for journal retries: 1 s, doubling, at most 30 s. */
const retryDelayMs = (failures: number): number => Math.min(30_000, 1_000 * 2 ** Math.max(0, failures - 1));

export interface OperationHealth {
  loaded: boolean;
  loadError?: string;
  /** Records whose latest state is not on disk yet. */
  unsaved: number;
  /** Deletions the journal has not taken yet. */
  unremoved: number;
  faults: number;
  lastFault?: string;
}

export class ConnectedAppOperations {
  private readonly ops = new Map<string, ConnectedAppOperation>();
  private readonly now: () => number;
  private readonly journal: OperationJournal | undefined;
  private loaded: boolean;
  private loadError: unknown;
  private loadFailures = 0;
  private nextLoadAt = 0;
  private readonly unsaved = new Map<string, ConnectedAppOperation>();
  private readonly unremoved = new Set<string>();
  private reconcileFailures = 0;
  private nextReconcileAt = 0;
  private faults = 0;
  private lastFault: string | undefined;

  constructor(now: () => number = Date.now, journal?: OperationJournal) {
    this.now = now;
    this.journal = journal;
    this.loaded = journal === undefined;
  }

  get health(): OperationHealth {
    return {
      loaded: this.loaded,
      ...(this.loadError !== undefined ? { loadError: this.loadError instanceof Error ? this.loadError.message : String(this.loadError) } : {}),
      unsaved: this.unsaved.size, unremoved: this.unremoved.size, faults: this.faults,
      ...(this.lastFault ? { lastFault: this.lastFault } : {}),
    };
  }

  get size(): number {
    return this.ops.size;
  }

  get pendingCount(): number {
    let n = 0;
    for (const op of this.ops.values()) if (!op.outcome) n++;
    return n;
  }

  /** Records still holding an answer buffer. */
  get keptResults(): number {
    let n = 0;
    for (const op of this.ops.values()) if (op.outcome?.kind === "answered") n++;
    return n;
  }

  get keptBytes(): number {
    let total = 0;
    for (const op of this.ops.values()) total += op.bytes;
    return total;
  }

  /** The operation a new identical request must join instead of running. */
  blocking(scope: string, key: string): ConnectedAppOperation | undefined {
    this.prepare();
    let found: ConnectedAppOperation | undefined;
    for (const op of this.ops.values()) {
      if (!scopeMatches(op.scope, scope) || op.key !== key || op.fresh) continue;
      if (!this.blocks(op)) continue;
      if (!found || op.startedAt > found.startedAt) found = op;
    }
    return found;
  }

  byHandle(scope: string, handle: string): ConnectedAppOperation | undefined {
    this.prepare();
    const op = this.ops.get(handle);
    return op && scopeMatches(op.scope, scope) ? op : undefined;
  }

  /**
   * Admit and start an action. Its intent is recorded durably first; if that
   * cannot be done, or the ledger is full of unresolved records, it is
   * refused (OperationRefused) and nothing is dispatched.
   */
  start(scope: string, key: string, label: string | undefined, dispatch: () => Promise<RelayReply>, sent: () => boolean, meta: StartMeta = {}): ConnectedAppOperation {
    this.prepare();
    const fresh = meta.fresh === true;
    // A protected action needs its record on disk first; until the journal has
    // been read (or while it cannot be) nothing protected is dispatched.
    if (!fresh && !this.loaded) throw new OperationRefused("unrecorded");
    if (this.pendingCount >= OPERATION_MAX_PENDING || (!fresh && this.protectedCount >= OPERATION_MAX_RECORDS)) throw new OperationRefused("busy");
    const handle = `op-${randomUUID().slice(0, 13)}`;
    const startedAt = this.now();
    const requirements = meta.requirements ?? [];
    const requirementsComplete = meta.requirementsComplete === true;
    // Before anything can be sent: the record, flushed.
    if (!fresh) {
      try {
        this.journal?.put({ handle, scope, key, label, startedAt, state: "pending", requirements, requirementsComplete });
      } catch (error) {
        throw new OperationRefused("unrecorded", error instanceof Error ? error.message : String(error));
      }
    }
    const op: ConnectedAppOperation = {
      handle, scope, key, label, startedAt, requestId: meta.requestId, requirements, requirementsComplete, fresh, bytes: 0,
      done: Promise.resolve().then(dispatch).then(
        (reply): OperationOutcome => reply.delivery === "not-sent" ? { kind: "not-sent", reply }
          : reply.delivery === "unknown" ? { kind: "unknown", reason: "no answer came back", cause: "no-answer" }
          : { kind: "answered", reply },
        // A failure after dispatch began is unknown; "not sent" needs explicit
        // evidence that nothing left (the dispatch reports it before it throws).
        (error: unknown): OperationOutcome => sent()
          ? { kind: "unknown", reason: error instanceof Error ? error.message : String(error), cause: "no-answer" }
          : { kind: "not-sent", error },
      ).then((outcome) => {
        this.settle(op, outcome);
        return outcome;
      }),
    };
    this.ops.set(handle, op);
    return op;
  }

  /** The bot has now seen this outcome; a repeat is joined only briefly after. */
  delivered(op: ConnectedAppOperation): void {
    if (op.deliveredAt !== undefined) return;
    op.deliveredAt = this.now();
    this.persist(op);
  }

  /**
   * Clear a settled operation so the same request may run again. The journal
   * is told first: if it refuses, this throws and the record stays, so a
   * restart cannot bring a cleared record back.
   */
  clear(op: ConnectedAppOperation): boolean {
    if (!op.outcome) return false;
    if (!op.fresh) this.journal?.remove(op.handle);
    this.ops.delete(op.handle);
    this.unsaved.delete(op.handle);
    this.unremoved.delete(op.handle);
    return true;
  }

  /** Tests only: forget everything, in memory and in the journal. */
  reset(): void {
    this.ops.clear();
    this.unsaved.clear();
    this.unremoved.clear();
    this.loaded = true;
    this.loadError = undefined;
    this.loadFailures = 0;
    this.nextLoadAt = 0;
    try { this.journal?.clear(); } catch { /* a journal that cannot open is reported by start() */ }
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Read the journal (retried with backoff until it succeeds), reconcile
   * what it refused earlier, then drop what has run its course. */
  private prepare(): void {
    if (!this.loaded && this.now() >= this.nextLoadAt) {
      try {
        this.recover();
        this.loaded = true;
        this.loadError = undefined;
        this.loadFailures = 0;
      } catch (error) {
        this.loadError = error;
        this.loadFailures += 1;
        this.nextLoadAt = this.now() + retryDelayMs(this.loadFailures);
        this.noteFault("read the connected app ledger", error);
      }
    }
    this.reconcile();
    this.sweep();
  }

  /** At start-up: what was on its way is unknown; an answer no longer held is
   * result-gone; a delivered record keeps guarding until its ORIGINAL repeat
   * deadline. All of it is one transaction, and unchanged rows are not
   * rewritten. Nothing is held in memory until the journal has taken it. */
  private recover(): void {
    if (!this.journal) return;
    const now = this.now();
    const put: JournalRecord[] = [];
    const remove: string[] = [];
    const recovered: ConnectedAppOperation[] = [];
    for (const record of this.journal.load()) {
      if (this.ops.has(record.handle)) continue;
      if (record.deliveredAt !== undefined && now - record.deliveredAt >= CONNECTED_APP_REPEAT_WINDOW_MS) { remove.push(record.handle); continue; }
      const cause: UnknownCause = record.state === "pending" ? "interrupted" : record.state === "answered" ? "result-gone" : record.cause ?? "no-answer";
      // Only a record that was still "pending" changes on disk.
      if (record.state === "pending") put.push({ ...record, state: "unknown", cause });
      const outcome: OperationOutcome = { kind: "unknown", reason: cause === "interrupted" ? "Murage stopped while it was being sent" : "no answer is held", cause };
      recovered.push({
        handle: record.handle, scope: record.scope, key: record.key, label: record.label, startedAt: record.startedAt,
        requestId: undefined, requirements: record.requirements, requirementsComplete: record.requirementsComplete, fresh: false, bytes: 0,
        done: Promise.resolve(outcome), outcome, settledAt: now,
        ...(record.deliveredAt !== undefined ? { deliveredAt: record.deliveredAt } : {}),
      });
    }
    this.journal.apply({ put, remove });
    for (const op of recovered) this.ops.set(op.handle, op);
  }

  private get protectedCount(): number {
    let n = 0;
    for (const op of this.ops.values()) if (!op.fresh) n++;
    return n;
  }

  private noteFault(what: string, error: unknown): void {
    this.faults += 1;
    this.lastFault = `${what}: ${error instanceof Error ? error.message : String(error)}`;
    console.warn(`[connected-app-ledger] could not ${this.lastFault}`);
  }

  /** Retry, in one transaction, what the journal refused before. */
  private reconcile(): void {
    if (!this.journal || (!this.unsaved.size && !this.unremoved.size) || this.now() < this.nextReconcileAt) return;
    const put: JournalRecord[] = [];
    for (const op of this.unsaved.values()) if (this.ops.get(op.handle) === op && op.outcome) put.push(this.recordOf(op));
    const remove = [...this.unremoved];
    try {
      this.journal.apply({ put, remove });
      this.unsaved.clear();
      this.unremoved.clear();
      this.reconcileFailures = 0;
    } catch (error) {
      this.reconcileFailures += 1;
      this.nextReconcileAt = this.now() + retryDelayMs(this.reconcileFailures);
      this.noteFault("retry saving the connected app ledger", error);
    }
  }

  private settle(op: ConnectedAppOperation, outcome: OperationOutcome): void {
    op.outcome = outcome;
    op.settledAt = this.now();
    const reply = outcome.kind === "answered" || outcome.kind === "not-sent" ? outcome.reply : undefined;
    op.bytes = reply?.bytes.byteLength ?? 0;
    if (outcome.kind === "not-sent") {
      // Nothing reached the app: the record has done its job.
      this.drop(op);
      return;
    }
    this.persist(op);
    this.trim();
  }

  private recordOf(op: ConnectedAppOperation): JournalRecord {
    const outcome = op.outcome!;
    return {
      handle: op.handle, scope: op.scope, key: op.key, label: op.label, startedAt: op.startedAt,
      state: outcome.kind === "answered" ? "answered" : "unknown",
      ...(outcome.kind === "unknown" ? { cause: outcome.cause } : {}),
      ...(op.deliveredAt !== undefined ? { deliveredAt: op.deliveredAt } : {}),
      requirements: op.requirements, requirementsComplete: op.requirementsComplete,
    };
  }

  private persist(op: ConnectedAppOperation): void {
    // A verified read leaves no durable record. An operation a reset or a
    // restart already replaced must not write a stale row.
    if (!this.journal || op.fresh || !op.outcome || this.ops.get(op.handle) !== op) return;
    // A row that cannot be rewritten still reads as it did on disk (pending
    // becomes unknown at restart: the conservative direction). It is not
    // forgotten: it is retried and counted.
    try {
      this.journal.put(this.recordOf(op));
      this.unsaved.delete(op.handle);
    } catch (error) {
      this.unsaved.set(op.handle, op);
      this.noteFault("save a connected app record", error);
    }
  }

  private drop(op: ConnectedAppOperation): void {
    this.ops.delete(op.handle);
    this.unsaved.delete(op.handle);
    if (op.fresh || !this.journal) return;
    try {
      this.journal.remove(op.handle);
    } catch (error) {
      // The row stays until the journal takes the deletion; it is retried.
      this.unremoved.add(op.handle);
      this.noteFault("remove a connected app record", error);
    }
  }

  /** Free a result's bytes; the record stays and says the result is gone. */
  private evictResult(op: ConnectedAppOperation): void {
    if (op.outcome?.kind !== "answered") return;
    if (op.fresh) { this.drop(op); return; }
    const outcome: OperationOutcome = { kind: "unknown", reason: "the result is no longer held", cause: "result-gone" };
    op.outcome = outcome;
    op.done = Promise.resolve(outcome);
    op.bytes = 0;
    this.persist(op);
  }

  private blocks(op: ConnectedAppOperation): boolean {
    if (op.fresh) return false;
    if (!op.outcome) return true;
    if (op.outcome.kind === "not-sent") return false;
    if (op.deliveredAt !== undefined) return this.now() - op.deliveredAt < CONNECTED_APP_REPEAT_WINDOW_MS;
    // unknown (including a result no longer held) and an uncollected answer hold until the bot resolves them
    return true;
  }

  private sweep(): void {
    const now = this.now();
    for (const op of [...this.ops.values()]) {
      if (!op.outcome) continue;
      // The bot saw the answer and the repeat window is over: nothing left to guard.
      if (op.deliveredAt !== undefined && now - op.deliveredAt >= CONNECTED_APP_REPEAT_WINDOW_MS) { this.drop(op); continue; }
      // A verified read blocks nothing: its record is only history for CHECK.
      if (op.fresh) { if (op.settledAt !== undefined && now - op.settledAt >= CONNECTED_APP_RESULT_TTL_MS) this.drop(op); continue; }
      // An uncollected answer's bytes age out; its record keeps holding repeats.
      if (op.outcome.kind === "answered" && op.settledAt !== undefined && now - op.settledAt >= CONNECTED_APP_RESULT_TTL_MS) this.evictResult(op);
    }
  }

  private trim(): void {
    this.sweep();
    // Settled verified reads are history only: never more than the kept-result bound.
    const history = [...this.ops.values()].filter((op) => op.fresh && op.outcome).sort((a, b) => a.settledAt! - b.settledAt!);
    for (const op of history.slice(0, Math.max(0, history.length - OPERATION_MAX_ENTRIES))) this.drop(op);
    let bytes = this.keptBytes;
    const kept = [...this.ops.values()].filter((op) => op.outcome?.kind === "answered");
    if (kept.length <= OPERATION_MAX_ENTRIES && bytes <= OPERATION_MAX_BYTES) return;
    // Results the bot already saw go first, then the oldest unseen ones.
    kept.sort((a, b) => Number(a.deliveredAt === undefined) - Number(b.deliveredAt === undefined) || a.settledAt! - b.settledAt!);
    let count = kept.length;
    for (const op of kept) {
      if (count <= OPERATION_MAX_ENTRIES && bytes <= OPERATION_MAX_BYTES) break;
      bytes -= op.bytes;
      count -= 1;
      this.evictResult(op);
    }
  }
}

/** Wait for an operation up to `ms`; undefined when it is still running. */
export async function waitForOperation(op: ConnectedAppOperation, ms: number): Promise<OperationOutcome | undefined> {
  if (op.outcome) return op.outcome;
  if (ms <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op.done,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const sameId = (a: unknown, b: unknown): boolean => normalizedJson(a) === normalizedJson(b);

/** The JSON-RPC answer inside a kept reply (plain JSON or an SSE stream). With
 * `requestId`, only the frame that answers that request: a stream may carry
 * answers to other requests, and none of them is this one's. */
export function replyMessage(reply: RelayReply, requestId?: unknown): Record<string, unknown> | null {
  const text = new TextDecoder().decode(reply.bytes).trim();
  if (!text) return null;
  const parse = (value: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };
  const wanted = (frame: Record<string, unknown>) => requestId === undefined || ("id" in frame && sameId(frame.id, requestId));
  if (text.startsWith("{")) {
    const single = parse(text);
    return single && wanted(single) ? single : null;
  }
  const frames = text.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => parse(line.slice(5).trim()))
    .filter((frame): frame is Record<string, unknown> => frame !== null && ("result" in frame || "error" in frame) && wanted(frame));
  return frames.at(-1) ?? null;
}

/** Whether the reply carries a result or error frame whose id is THIS
 * request's. Anything else (no such frame, only other requests' ids, an empty
 * or malformed body) is not an answer: the outcome stays unknown. */
export function answersRequest(reply: RelayReply, requestId: unknown): boolean {
  if (requestId === undefined || requestId === null) return false;
  const text = new TextDecoder().decode(reply.bytes).trim();
  if (!text) return false;
  const frames: unknown[] = [];
  const parse = (value: string) => { try { frames.push(JSON.parse(value)); } catch { /* not a frame */ } };
  if (text.startsWith("{") || text.startsWith("[")) parse(text);
  else for (const line of text.split(/\r?\n/)) if (line.startsWith("data:")) parse(line.slice(5).trim());
  return frames.flatMap((frame) => Array.isArray(frame) ? frame : [frame]).some((frame) =>
    !!frame && typeof frame === "object" && "id" in frame && sameId((frame as { id: unknown }).id, requestId)
    && ("result" in frame || ("error" in frame && !!(frame as { error: unknown }).error)));
}

/** Whether a kept body is a stream of events rather than one JSON value. */
export function isEventStream(reply: RelayReply): boolean {
  return /^data:/m.test(new TextDecoder().decode(reply.bytes));
}
