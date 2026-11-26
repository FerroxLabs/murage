// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The driver send types of the write-time privacy lane (DESIGN-WRITETIME 2, Enforcement (a)): the engine input of a turn and of a steer
// is a BuiltPrompt (server/memory/prompt-parts.ts), never a bare string, and the send fence runs immediately before every write.
//
// contracts.ts holds the server side of the contract: BuiltSendTurnInput and BuiltEngineInput take a BuiltPrompt, never a bare string. The
// driver side (ProviderAdapter.sendTurn / .steer) keeps the engine's bytes (`text`). This file is the only place one becomes the other:
// fencedTurnInput / sendBuiltTurn / steerBuilt unwrap the prompt and chain the send fence (S4's assertSendFence) into the adapter's own
// submission fence (beforeSubmit / beforeWrite), which every adapter calls right before each engine write, a relaunch's write included. lineage-sinks.test.ts lists every direct `.sendTurn(` / `.steer(` call in server/ and fails on any that is
// not in its reviewed list; the reviewed ones move onto these two as their owner converts them.
//
// The fence refuses with MEMORY_CONTEXT_REVOKED when a part of the prompt became withheld, or is still being checked, after the prompt was
// built: the adapter writes nothing, and the caller rebuilds the prompt (or, for a steer, refuses the quote).
import type { DatabaseSync } from "node:sqlite";
import type { BuiltEngineInput, BuiltSendTurnInput, ProviderAdapter, SendTurnInput, SteerDelivery, TurnStartResult } from "../contracts.ts";
import type { BuiltPrompt, LineageReader, LineageVerdict, TurnLineage } from "../memory/lineage-types.ts";
import { assertSendFence, assertRetainedFence } from "../memory/send-fence.ts";
import { checkedOpenTurns, retainedTurnDatabase, refuseRetainedTurn } from "../memory/lineage-write.ts";
import { checkReleaseAvailable, reserveRelease, withReleaseBudgets } from "../memory/release-budget.ts";
import { bindEngineWireFence } from "./engine-wire.ts";
import { appendNative } from "./native.ts";
import { refuseConsumingTurn, assertConsumingBinding, emitConsumingTurnResponse, preflightConsumingResponse, registerConsumingDescriptor, type ConsumingTurnBinding } from "../consuming-turn-response.ts";

/** Native callbacks require the captured consuming ledger and a final prompt
 * writer. Each adapter then releases its fixed answers at concrete acceptance. */
export function assertNativeIngressAdmission(turn: SendTurnInput, _engine: string): void {
  if (!turn.releaseBinding) return;
  assertConsumingBinding(turn.releaseBinding);
  if (!turn.fencedWrite) refuseConsumingTurn(turn.releaseBinding);
}

/** Capture the admitted binding in the caller before queueing/awaiting. This
 * gate owns the final synchronous acceptance, including automatic answers. */
export function releaseNativeAnswer<T>(binding: ConsumingTurnBinding | null | undefined, sink: string, serialized: string, write: () => T): T {
  return releaseNativeWire(binding, sink, serialized, write);
}
/** A request may be prepared while its connection is opening. No cached grant
 * or released accounting survives this check; its socket must still re-enter. */
export function preflightNativeRequest(binding: ConsumingTurnBinding | null | undefined, sink: string, serialized: string): void {
  if (binding === null) return;
  if (!binding) throw new EngineInputRevoked({ state: "checking", reason: "not-built" });
  const release = enterNativeWire(binding);
  try {
    let descriptor: ReturnType<typeof registerConsumingDescriptor>;
    try { descriptor = registerConsumingDescriptor(`native:${sink}`, "native"); }
    catch { binding.onLedgerRefused({ state: "checking", reason: "not-built" }); throw new EngineInputRevoked({ state: "checking", reason: "not-built" }); }
    preflightConsumingResponse(binding, descriptor, Buffer.byteLength(serialized));
  } finally { release(); }
}
/** Depth, per dispatch generation, of the synchronous native-wire releases on the stack: the harness writing into an engine's own input. */
const nativeWireDepth = new Map<string, number>();
function enterNativeWire(binding: ConsumingTurnBinding): () => void {
  const generation = binding.identity.dispatchGeneration;
  nativeWireDepth.set(generation, (nativeWireDepth.get(generation) ?? 0) + 1);
  return () => { const left = (nativeWireDepth.get(generation) ?? 1) - 1; if (left > 0) nativeWireDepth.set(generation, left); else nativeWireDepth.delete(generation); };
}
/** True while a native-wire release of THIS dispatch generation runs: a ledger refusal raised now refused bytes the harness was submitting
 * to the engine, not a response to a request a running turn made over the internal API (that one stops the turn with the host status line).
 * A release of another lease never marks this one. */
export function releasingEngineInput(generation: string): boolean { return nativeWireDepth.has(generation); }
/** Connected HTTP writes may split a UTF-8 sequence. Charge the original
 * bytes rather than decoding and re-encoding a partial frame. */
export function releaseNativeWire<T>(binding: ConsumingTurnBinding | null | undefined, sink: string, serialized: string | Uint8Array, write: () => T): T {
  // null is an explicit non-consuming admission, captured by the caller.
  // undefined remains an unproven/missing authority, never an exemption.
  if (binding === null) return write();
  if (!binding) throw new EngineInputRevoked({ state: "checking", reason: "not-built" });
  const release = enterNativeWire(binding);
  try {
    let descriptor: ReturnType<typeof registerConsumingDescriptor>;
    try { descriptor = registerConsumingDescriptor(`native:${sink}`, "native"); }
    catch { binding.onLedgerRefused({ state: "checking", reason: "not-built" }); throw new EngineInputRevoked({ state: "checking", reason: "not-built" }); }
    return emitConsumingTurnResponse(binding, descriptor, {
      bytes: Buffer.byteLength(serialized), refs: [], write,
    });
  } finally { release(); }
}

import { assertReleaseContext, releaseTransaction, ReleaseCommitFailed, type ReleaseContext } from "../memory/release-transaction.ts";
import { afterCommit, inTxScope, onRollback } from "../tx-scope.ts";

export type { BuiltSendTurnInput };
export { accountEngineWire } from "./engine-wire.ts";

/** Who the fence judges for (the turn's reader), and against which file (the server's database when absent). */
export interface EngineFence {
  readonly reader: LineageReader; readonly db?: DatabaseSync;
  /** Required by the final writer; validation-only callers may omit it. */
  readonly retained?: TurnLineage;
  /** Told of a refusal before it is thrown. The submission boundary records
   * that no frame was accepted and decides whether rebuilding is permitted. */
  readonly onRefused?: (error: unknown) => void;
  /** Told right before the adapter is called (index.ts sendProjectUsageTurn): from here the engine may act before its first write, so the
   * turn's submission boundary marks the attempt started. A throw before this point, in Murage's own prompt build, sent nothing (1.0.10 C1). */
  readonly invoked?: () => void;
}

/** The error a refused fence throws (the adapter writes nothing). */
export class EngineInputRevoked extends Error {
  readonly code = "MEMORY_CONTEXT_REVOKED";
  // (no parameter property: the server runs with types stripped, which cannot express one)
  readonly verdict: LineageVerdict;
  constructor(verdict: LineageVerdict) { super("MEMORY_CONTEXT_REVOKED"); this.name = "EngineInputRevoked"; this.verdict = verdict; }
}
/** A fenced refusal: an error carrying code MEMORY_CONTEXT_REVOKED, raised before the write started. Never matches message text, class or
 * stack; write-started failures (ReleaseCommitFailed), busy/stream errors and anything unrelated are not refusals. */
export function isMemoryRefusal(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "MEMORY_CONTEXT_REVOKED";
}

export type FencedRefusalTermination = "T-FIX" | "T-CLOSE" | "in-process";
/** "in-process:target-rebound" (M12): the discharge target was rebound to another generation; no bytes were written and no close ran. */
export type FencedRefusalOutcome = "discharged" | "closed" | "termination-failed" | "waiter-settled" | "in-process:target-rebound";
export interface FencedRefusalRecord {
  readonly engine: string; readonly sink: string; readonly threadId: string; readonly turnId: string | null;
  readonly requestId: string | number | null; readonly method: string | null; readonly generation: number | null;
  readonly active: boolean; readonly termination: FencedRefusalTermination;
  /** Set once by settleRecord; undefined only while the termination is still running. */
  outcome?: FencedRefusalOutcome;
}
const FENCED_REFUSAL_RING = 256;
const fencedRefusalRing: FencedRefusalRecord[] = [];
/** Test getter over the bounded ring of refusals this process recorded (ids and names only). */
export function fencedRefusals(): readonly FencedRefusalRecord[] { return fencedRefusalRing; }

/** The positive local record of a fenced refusal: written before the termination starts, completed by settleRecord. Carries ids and names
 * only, never an answer, a reason or content. The ring is written even when the native log is omitted. */
export function recordFencedRefusal(r: Omit<FencedRefusalRecord, "outcome">): FencedRefusalRecord {
  const rec: FencedRefusalRecord = { ...r };
  fencedRefusalRing.push(rec);
  if (fencedRefusalRing.length > FENCED_REFUSAL_RING) fencedRefusalRing.shift();
  appendNative(rec.threadId, { dir: "lifecycle", source: "murage.fence-refusal", msg: { ...rec } });
  console.warn(`native fence refusal engine=${rec.engine} sink=${rec.sink} termination=${rec.termination}`);
  return rec;
}
export function settleRecord(rec: FencedRefusalRecord, outcome: FencedRefusalOutcome): void { rec.outcome ??= outcome; }

// ---- G0-R (nativecrash stage 2): the ONE join object of a fenced refusal. refusalFor CLAIMS + REGISTERS only; the CAS winner runs R.close.
export type CloseResult = { readonly confirmed: true } | { readonly confirmed: false; readonly reason: "timeout" | "stop-failed" };
export type ConfirmedClose = () => Promise<CloseResult>;
export type RefusalKind = "turn" | "submission" | "notice";
export type RefusalCloser = "driver" | "lease";
/** The R.write sink: the owner-row transaction. R.written latches only after it returns (the commit), so a rolled-back write is retried. */
export type RefusalSink = (R: FencedRefusal) => void | Promise<void>;
export interface RefusalLease { late?: Promise<void> }
export interface RefusalOwner { fenced?: FencedRefusal; teardowns?: Promise<unknown>[] }
/** Captured at the request's arrival, never re-read at claim time. */
export interface RefusalCtx {
  readonly engine: string; readonly threadId: string; readonly binding?: ConsumingTurnBinding | null; readonly owner?: RefusalOwner | null;
  readonly generation?: number | null; readonly target?: unknown; readonly kind?: RefusalKind; readonly lease?: RefusalLease;
  readonly requestId?: string | number | null; readonly method?: string | null;
}
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

export class FencedRefusal implements FencedRefusalRecord {
  readonly engine: string; readonly threadId: string; turnId: string | null = null;
  readonly requestId: string | number | null; readonly method: string | null; readonly generation: number | null;
  readonly dispatchGeneration: string | null; readonly kind: RefusalKind; readonly active: boolean = true;
  readonly termination: FencedRefusalTermination;
  site: string; readonly joins: string[] = []; lease: RefusalLease | undefined; target: unknown;
  closer: RefusalCloser | null = null; written = false; lateConfirmedAt: number | null = null;
  outcome?: FencedRefusalOutcome;
  readonly closeOwner: Promise<RefusalCloser>;
  readonly late: Promise<void>;
  #ownerResolve: (o: RefusalCloser) => void; #teardown = deferred<CloseResult>(); #lateD = deferred<void>(); #writeDone = deferred<void>();
  #closing: Promise<CloseResult> | null = null; #awaited = false; #writing = false;
  constructor(ctx: RefusalCtx, site: string, kind: RefusalKind) {
    this.engine = ctx.engine; this.threadId = ctx.threadId; this.requestId = ctx.requestId ?? null; this.method = ctx.method ?? null;
    this.generation = ctx.generation ?? null; this.dispatchGeneration = dispatchGenerationOf(ctx.binding); this.kind = kind; this.site = site;
    this.lease = ctx.lease; this.target = ctx.target; this.termination = ctx.target == null ? "in-process" : "T-CLOSE";
    const o = deferred<RefusalCloser>(); this.closeOwner = o.promise; this.#ownerResolve = o.resolve;
    this.late = this.#lateD.promise;
  }
  get sink(): string { return this.site; }
  /** Resolves once, from the one close. Reading it marks it awaited (unawaitedTeardowns). */
  get teardown(): Promise<CloseResult> { this.#awaited = true; return this.#teardown.promise; }
  get teardownAwaited(): boolean { return this.#awaited; }
  get teardownSettled(): boolean { return this.#closing !== null; }
  /** Sync CAS: the first caller owns the close. */
  takeClose(who: RefusalCloser): boolean {
    if (this.closer) return false;
    this.closer = who; this.#ownerResolve(who); return true;
  }
  /** No driver will claim (Tl revoke outside a fence call, admission not launched): the lease closes at once. */
  noClaim(): boolean { return this.takeClose("lease"); }
  /** Runs the ONE close part (composite); never rejects; the second call returns the first's result. */
  close(c: ConfirmedClose): Promise<CloseResult> {
    if (this.#closing) return this.#closing;
    this.#closing = (async (): Promise<CloseResult> => {
      let result: CloseResult;
      try { result = await c(); } catch { result = { confirmed: false, reason: "stop-failed" }; }
      settleRecord(this, result.confirmed ? "closed" : "termination-failed");
      this.#teardown.resolve(result);
      return result;
    })();
    return this.#closing;
  }
  /** The unconfirmed close was confirmed later (A5): never false -> true on the teardown itself, only here. */
  confirmedLate(now: number = Date.now()): void { this.lateConfirmedAt ??= now; this.#lateD.resolve(); }
  /** For the lease's pendingWrites: resolves when write commits. */
  reserveWrite(): Promise<void> { return this.#writeDone.promise; }
  get writeDone(): Promise<void> { return this.#writeDone.promise; }
  /** The ONLY caller of the note/roomNote/owner row. The latch is set after the sink returns (commit), never before. */
  async write(sink: RefusalSink): Promise<void> {
    if (this.written) return;
    if (this.#writing) { await this.#writeDone.promise; return; }
    this.#writing = true;
    try { await sink(this); this.written = true; this.#writeDone.resolve(); }
    finally { this.#writing = false; }
  }
}

/** G0-W: a once-flag of a refusal note is set only when the enclosing transaction commits, so a rolled-back write is retried and lands its row. */
export const latchAfterCommit = (set: () => void): void => { if (inTxScope()) afterCommit(set); else set(); };
/** G0-W: the ONLY caller of a refused turn's note/room note. With the turn's FencedRefusal the write is R.write: one row, and R.written latches
 * only at the commit of the enclosing transaction (a rollback rejects, the next call retries). Without R it is the plain c11 call. */
export function writeRefusalNote(R: FencedRefusal | undefined, work: () => void): void {
  if (!R) { work(); return; }
  if (R.written) return;
  // joined through R.writeDone (the lease's pendingWrites reads R.reserveWrite()); a rollback is told here and the next call retries
  R.write(() => new Promise<void>((resolve, reject) => {
    work();
    if (inTxScope()) { afterCommit(resolve); onRollback(() => reject(new Error("REFUSAL_NOTE_ROLLED_BACK"))); } else resolve();
  })).catch(error => { console.warn("[memory] refusal note not committed; the next write retries", error); });
}

/** G0-W W2 (late handback): the note of a turn refused before the engine handed its id back. The sink is a persisted write (a busy database
 * is retried by `persist`, never dropped), told through R.write when the turn has its FencedRefusal, so it stays one row with the generic
 * fallback. The owner's note is never silently lost: `settled(true)` runs only after the row committed (the caller releases the cause, its
 * per-turn entry and the fallback there); a write that failed for good reports `settled(false)` and leaves all three in place. */
export function writeHandbackRefusalNote(R: FencedRefusal | undefined, persist: (work: () => void) => Promise<void>, work: () => void,
  settled: (written: boolean) => void): Promise<void> {
  const write = R ? R.write(() => persist(work)) : persist(work);
  return write.then(() => settled(true), error => { console.error("[memory] refusal note persistence failed", error); settled(false); });
}

const dispatchGenerationOf = (binding: ConsumingTurnBinding | null | undefined): string | null => {
  const g = (binding as { identity?: { dispatchGeneration?: unknown } } | null | undefined)?.identity?.dispatchGeneration;
  return typeof g === "string" || typeof g === "number" ? String(g) : null;
};
const refusalByGeneration = new Map<string, FencedRefusal>();
const refusalByTurn = new Map<string, FencedRefusal>();
const refusalByError = new WeakMap<object, FencedRefusal>();
/** Dev assertion (M8): a turn whose kind cannot be computed. K2 helper fails any run where the count is > 0. */
export const kindUnjoined = { count: 0 };

export const fencedRefusalRegistry = {
  byGeneration(generation: string | number | null | undefined): FencedRefusal | undefined { return generation == null ? undefined : refusalByGeneration.get(String(generation)); },
  /** G0-W: the refusal of a provider turn id (the key turnRefusalNotes and the late handback use). Bound by bindRefusalTurn. */
  /** MLH: the R a site already classified for this exact error object (lookup only: never classifies, never creates). */
  byError(error: unknown): FencedRefusal | undefined { return typeof error === "object" && error !== null ? refusalByError.get(error) : undefined; },
  byTurn(turnId: string | null | undefined): FencedRefusal | undefined { return turnId == null || turnId === "" ? undefined : refusalByTurn.get(turnId); },
};
/** Binds R to its provider turn id once the id is known (lease attach, or J0 with an already handed-back id). First binding wins. */
export function bindRefusalTurn(R: FencedRefusal, turnId: string): void {
  if (!turnId || R.turnId !== null && R.turnId !== turnId) return;
  R.turnId = turnId; refusalByTurn.set(turnId, R);
}
/** A new turn is admitted under dispatch generation g (a rebuild keeps g): the previous turn's R leaves the generation index, so the new
 * turn's lease verdict, driver claim, fencedOf attach and Stop never join a refusal that is not theirs. R stays in the ring, byTurn and byError. */
export function beginRefusalTurn(generation: string | number | null | undefined): void {
  if (generation != null) refusalByGeneration.delete(String(generation));
}
export function unawaitedTeardowns(): readonly FencedRefusal[] {
  return fencedRefusalRing.filter((r): r is FencedRefusal => r instanceof FencedRefusal && !r.teardownAwaited && !r.teardownSettled);
}

function publish(R: FencedRefusal): void {
  fencedRefusalRing.push(R);
  if (R.dispatchGeneration) refusalByGeneration.set(R.dispatchGeneration, R);
  if (fencedRefusalRing.length > FENCED_REFUSAL_RING) {
    const old = fencedRefusalRing.shift();
    if (old instanceof FencedRefusal && old.dispatchGeneration && refusalByGeneration.get(old.dispatchGeneration) === old) refusalByGeneration.delete(old.dispatchGeneration);
    if (old instanceof FencedRefusal && old.turnId && refusalByTurn.get(old.turnId) === old) refusalByTurn.delete(old.turnId);
  }
  appendNative(R.threadId, { dir: "lifecycle", source: "murage.fence-refusal", msg: { engine: R.engine, site: R.site, kind: R.kind, generation: R.generation, dispatchGeneration: R.dispatchGeneration, lease: R.lease !== undefined } });
  console.warn(`native fence refusal engine=${R.engine} site=${R.site} kind=${R.kind}`);
}
function join(R: FencedRefusal, site: string): void {
  if (site !== R.site && !R.joins.includes(site)) R.joins.push(site);
}
/** Classifies once (R3 1.1) and returns the ONE R for this refusal: same error, or same dispatch generation, joins. A non-refusal is
 * undefined. Claims the owner (first wins) and registers the teardown; never closes (the CAS winner runs R.close). HELPERS NEVER CLASSIFY. */
export function refusalFor(error: unknown, site: string, ctx: RefusalCtx): FencedRefusal | undefined {
  if (!isMemoryRefusal(error)) return undefined;
  const key = typeof error === "object" && error !== null ? error : null;
  let R = (key && refusalByError.get(key)) || fencedRefusalRegistry.byGeneration(dispatchGenerationOf(ctx.binding));
  if (R) join(R, site);
  else {
    const kind: RefusalKind = ctx.kind ?? (ctx.owner ? "turn" : "notice");
    if (kind === "turn" && !ctx.lease && !ctx.binding) { kindUnjoined.count++; console.error(`nativecrash: turn refusal with no lease and no binding site=${site}`); }
    R = new FencedRefusal(ctx, site, kind);
    publish(R);
  }
  if (key) refusalByError.set(key, R);
  if (ctx.lease && !R.lease) R.lease = ctx.lease;
  if (ctx.owner && R.kind !== "notice") {
    if (!ctx.owner.fenced) { ctx.owner.fenced = R; ctx.owner.teardowns?.push(R.teardown); }
  }
  // target null = no driver (LLD/LLM): the lease closes at once; undefined = a lease verdict that only registers (J0); an object = a driver claim.
  if (ctx.target === null) R.takeClose("lease"); else if (ctx.target !== undefined) R.takeClose("driver");
  return R;
}
/** A lease's verdict refusal (ledger revoke) with no driver request: the lease is the one that will close it. */
export function refusalForVerdict(verdict: LineageVerdict, site: string, ctx: Omit<RefusalCtx, "kind"> & { lease: RefusalLease }): FencedRefusal | undefined {
  const error = new EngineInputRevoked(verdict);
  const R = refusalFor(error, site, { ...ctx, kind: "turn", target: undefined });
  return R;
}
/** G0-ORD (r4 item 1, J0-5): the composite close. The owner's settle runs FIRST (inside the closer's composite, never after the close), then
 * every part concurrently; results merge to one CloseResult (any unconfirmed part -> unconfirmed). Never rejects. */
export function composeClose(owner: { settleFenced?: () => Promise<unknown> } | null | undefined, ...parts: ConfirmedClose[]): ConfirmedClose {
  return async () => {
    try { await owner?.settleFenced?.(); } catch { return { confirmed: false, reason: "stop-failed" }; }
    const results = await Promise.all(parts.map(async (part): Promise<CloseResult> => { try { return await part(); } catch { return { confirmed: false, reason: "stop-failed" }; } }));
    return results.find((r): r is Extract<CloseResult, { confirmed: false }> => !r.confirmed) ?? { confirmed: true };
  };
}
/** M4 P1 ATTACH: the turn's R, found by its captured dispatch generation when no driver claimed it; attaches idempotently. */
export function fencedOf(turn: { fenced?: FencedRefusal; releaseBinding?: ConsumingTurnBinding | null }): FencedRefusal | undefined {
  const R = turn.fenced ?? fencedRefusalRegistry.byGeneration(dispatchGenerationOf(turn.releaseBinding));
  if (R && !turn.fenced) turn.fenced = R;
  return R;
}

/** M12/M18 structural guard: every discharge that writes bytes (cancel?.(), a T-FIX frame, a notice reply) tests this FIRST. A target now
 * bound to another generation than R's gets no bytes and no close (never a frame into turn N+1's process): the record settles
 * "in-process:target-rebound" and the caller returns. A target that does not track its generation (undefined) is not rebound. */
export function targetRebound(rec: FencedRefusalRecord, target: { readonly boundGeneration?: number | null } | null | undefined): boolean {
  if (!target || target.boundGeneration === undefined || target.boundGeneration === rec.generation) return false;
  settleRecord(rec, "in-process:target-rebound");
  return true;
}

/** Routes a classified fenced refusal into the caller's termination; the returned promise is the caller's to return or await (never
 * float it) and never rejects. An unrelated error is rethrown unchanged (same identity, synchronously). A failing terminate falls back
 * to the engine's bounded close; a failing fallback records termination-failed. */
export function refuseFencedNative(error: unknown, rec: FencedRefusalRecord, terminate: () => Promise<"discharged" | "closed">, fallback: () => Promise<void>): Promise<void> {
  if (!isMemoryRefusal(error)) throw error;
  return (async () => {
    try { settleRecord(rec, await terminate()); }
    catch {
      try { await fallback(); settleRecord(rec, "closed"); }
      catch { settleRecord(rec, "termination-failed"); }
    }
  })();
}

const reportedInputRefusals = new WeakSet<EngineInputRevoked>();
function reportInputRefusal(fence: EngineFence, error: EngineInputRevoked): void {
  if (reportedInputRefusals.has(error)) return;
  reportedInputRefusals.add(error);
  try { fence.onRefused?.(error); } catch { /* the refusal itself still stands */ }
}

/** Runs the send fence once (memory/send-fence.ts assertSendFence, S4): throws EngineInputRevoked unless every part still reads shown. */
export function assertEngineInput(fence: EngineFence, prompt: BuiltPrompt, serializedBytes = 0): void {
  checkEngineInput(fence, prompt, serializedBytes);
}

/** Sync depth of the send fence. A lease refusal raised while it is > 0 is thrown through a driver stack that will claim it (refusalFor);
 * raised outside it (a Tl revoke) no driver is coming: R.noClaim() at J0 (item 2). */
let fenceCallDepth = 0;
export const inFenceCall = (): boolean => fenceCallDepth > 0;
/** Runs fn as if inside a send-fence call (the K2 helper and unit witnesses use it to model a refusal a driver will claim). */
export function withinFenceCall<T>(fn: () => T): T { fenceCallDepth++; try { return fn(); } finally { fenceCallDepth--; } }
function checkEngineInput(fence: EngineFence, prompt: BuiltPrompt, serializedBytes?: number,
  scope: "prompt" | "prompt-and-retained" = "prompt-and-retained"): void {
  fenceCallDepth++;
  try {
    const budgets = fence.retained ? checkedOpenTurns(fence.retained).map(member => member.budget!) : [];
    // Refuse a crossing serialization before prompt checking can drain markers.
    if (serializedBytes !== undefined) checkReleaseAvailable(budgets, { attempts: 1, bytes: serializedBytes });
    withReleaseBudgets(budgets, () => assertSendFence(prompt, fence.reader, fence.db));
    if (fence.retained && scope === "prompt-and-retained") assertRetainedFence(fence.retained, fence.db, 0, undefined, "check-only");
  }
  catch (error) {
    // A prepared-prompt refusal must also seal an already revoked live ledger.
    // A quote-only refusal leaves the still-valid consuming ledger alone.
    if (fence.retained) {
      try { assertRetainedFence(fence.retained, fence.db, 0, undefined, "check-only"); } catch { /* its bound handler ran before the throw */ }
    }
    const refused = new EngineInputRevoked((error as { fence?: LineageVerdict }).fence ?? { state: "checking", reason: "lookup-error" });
    reportInputRefusal(fence, refused);
    throw refused;
  } finally { fenceCallDepth--; }
}

/** The adapter's text for a built prompt (the one place the brand is unwrapped for a driver). */
export const engineText = (prompt: BuiltPrompt): string => prompt.text;

/** The final writer captures the original prompt and generation. Caller hooks
 * and Stop run before acquiring its owner; all authority is checked inside. */
function engineWriter(fence: EngineFence, prompt: BuiltPrompt, prior?: SendTurnInput["fencedWrite"], binding?: ConsumingTurnBinding): NonNullable<SendTurnInput["fencedWrite"]> {
  return <R>(release: () => R, extra?: (context: ReleaseContext) => void, bytes?: number): R => {
    let entered = false;
    let ownerFailure = false;
    if (!fence.retained) throw new EngineInputRevoked({ state: "checking", reason: "not-built" });
    const members = checkedOpenTurns(fence.retained);
    const budgets = [...new Set(members.map(member => member.budget!))];
    const db = retainedTurnDatabase(fence.retained);
    // 1.0.21 cause4: a frame the engine took is an accepted fenced release (release-budget.ts accepted). Counted here, after the
    // caller's write returned, so emit below stays the reviewed final-write node (learning-send-boundary.test.ts lintWriterContracts).
    const write = (): R => {
      const taken = release();
      for (const budget of budgets) budget.accepted();
      return taken;
    };
    let activeContext: ReleaseContext | undefined;
    const validate = (context: ReleaseContext) => {
      assertReleaseContext(context, db);
      activeContext = context;
      let result: unknown;
      try { result = extra?.(context); }
      catch (error) { ownerFailure = true; throw error; }
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("ASYNC_RELEASE_TRANSACTION");
      if (binding) assertConsumingBinding(binding);
      checkEngineInput(fence, prompt, bytes);
    };
    const emit = () => {
      if (!activeContext) throw new EngineInputRevoked({ state: "checking", reason: "not-built" });
      assertReleaseContext(activeContext, db);
      if (binding) assertConsumingBinding(binding);
      checkEngineInput(fence, prompt, bytes);
      reserveRelease(budgets, { attempts: 1, bytes: bytes!, work: 1 });
      entered = true;
      return write();
    };
    try {
      if (!Number.isSafeInteger(bytes) || bytes! < 0 || release.constructor.name === "AsyncFunction") throw new EngineInputRevoked({ state: "checking", reason: "not-built" });
      if (fence.db && fence.db !== db) throw new EngineInputRevoked({ state: "checking", reason: "not-built" });
      return withReleaseBudgets(budgets, () => {
        checkReleaseAvailable(budgets, { attempts: 1, bytes: bytes! });
        reserveRelease(budgets, { statements: 3, work: 3 });
        // C already joins its validator to the owner. A asserts that context;
        // it never opens another BEGIN or recursively joins the same context.
        if (!prior) return releaseTransaction(db, { validate, emit });
        try { return prior(emit, validate, bytes); }
        catch (error) { ownerFailure = true; throw error; }
      });
    } catch (error) {
      if (error instanceof ReleaseCommitFailed || entered && error instanceof Error && error.message === "ASYNC_RELEASE_TRANSACTION") {
        for (const member of members) refuseRetainedTurn(member, { state: "checking", reason: "lookup-error" });
        throw error;
      }
      if (entered) throw error;
      // C owns its busy/learning classification; a Stop validator owns Stop.
      // Neither is a retained-context refusal merely because A composed it.
      if (ownerFailure) throw error;
      const refused = error instanceof EngineInputRevoked ? error
        : new EngineInputRevoked((error as { fence?: LineageVerdict })?.fence ?? { state: "checking", reason: "lookup-error" });
      reportInputRefusal(fence, refused);
      throw refused;
    }
  };
}

export function fencedTurnInput(input: BuiltSendTurnInput, fence: EngineFence): SendTurnInput {
  const { prompt, beforeSubmit, beforePrepare, fencedWrite: prior, ...rest } = input;
  const fencedWrite = engineWriter(fence, prompt, prior, input.releaseBinding);
  // Like steer, reject a revoked prompt before attribution/submission hooks.
  // Full live-ledger validation still follows caller hooks and runs again
  // inside the final wire writer; no prompt-only check authorizes engine bytes.
  const callback = () => { checkEngineInput(fence, prompt, 0, "prompt"); const attempt = beforeSubmit?.(); assertEngineInput(fence, prompt); return attempt; };
  bindEngineWireFence(callback, bytes => assertEngineInput(fence, prompt, bytes),
    (wire, write, validate) => fencedWrite(write, validate, Buffer.byteLength(wire)));
  return { ...rest, text: engineText(prompt), beforePrepare: () => { checkEngineInput(fence, prompt, 0, "prompt"); if (beforePrepare) beforePrepare(); else beforeSubmit?.(); assertEngineInput(fence, prompt); }, beforeSubmit: callback, fencedWrite };
}

/** Send a turn with its captured final writer, including every later relaunch. */
export function sendBuiltTurn(adapter: Pick<ProviderAdapter, "sendTurn">, input: BuiltSendTurnInput, fence: EngineFence): Promise<TurnStartResult> {
  fence.invoked?.();
  return adapter.sendTurn(fencedTurnInput(input, fence));
}

/** Steer into a running turn: the final wire writer validates after the caller's beforeWrite. A steer adds parents to the
 * running turn (buildPrompt did that when the steer's prompt was built) and never moves its turnLsn. */
export function steerBuilt(adapter: Pick<ProviderAdapter, "steer">, threadId: string, prompt: BuiltPrompt, fence: EngineFence,
  beforeWrite?: () => void, interjectionId?: string): Promise<boolean | SteerDelivery> {
  if (!adapter.steer) return Promise.resolve(false);
  const callback = () => {
    // Reject a withheld quote before attribution hooks. A quote-only refusal
    // queues a fresh turn; a revoked retained ledger still seals immediately.
    const budgets = fence.retained ? checkedOpenTurns(fence.retained).map(member => member.budget!) : [];
    try { withReleaseBudgets(budgets, () => assertSendFence(prompt, fence.reader, fence.db)); }
    catch (error) {
      if (fence.retained) {
        assertRetainedFence(fence.retained, fence.db, 0, undefined, "check-only");
        // The retained context still holds: queue this rejected quote for a
        // fresh turn, preserving the quote-only refusal's recoverable shape.
        throw error;
      }
      throw new EngineInputRevoked((error as { fence?: LineageVerdict }).fence ?? { state: "checking", reason: "lookup-error" });
    }
    beforeWrite?.(); assertEngineInput(fence, prompt);
  };
  const release = engineWriter(fence, prompt);
  bindEngineWireFence(callback, bytes => assertEngineInput(fence, prompt, bytes),
    (wire, write, validate) => release(write, validate, Buffer.byteLength(wire)));
  return adapter.steer(threadId, engineText(prompt), callback, interjectionId);
}

/** contracts.ts BuiltEngineInput over an adapter: its turn and steer take a BuiltPrompt, with the send fence before every write. */
export function builtEngineInput(adapter: Pick<ProviderAdapter, "sendTurn" | "steer">, fence: EngineFence): BuiltEngineInput {
  return {
    sendTurn: input => sendBuiltTurn(adapter, input, fence),
    steer: (threadId, prompt, beforeWrite, interjectionId) => steerBuilt(adapter, threadId, prompt, fence, beforeWrite, interjectionId),
  };
}

/** The adapter's prompt write for a learning call (H1-SENDLOCK): inside `turn.fencedWrite` when the turn carries one, so the gate's
 * visibility check and the bytes leaving hold one write lock; otherwise the write itself. Call it after `beforeSubmit` and the halt
 * check, with no await before the write. */
export function fencedSubmit<R>(turn: Pick<SendTurnInput, "fencedWrite" | "releaseBinding">, write: () => R, serialized?: string, validate?: () => void): R {
  if (turn.fencedWrite) return turn.fencedWrite(write, validate, serialized === undefined ? undefined : Buffer.byteLength(serialized));
  if (turn.releaseBinding) throw new EngineInputRevoked({ state: "checking", reason: "not-built" });
  validate?.();
  return write();
}
