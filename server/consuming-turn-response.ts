// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** AREA A contracts for B–E (LASTRESORT r3.3 §§9.1–9.5,12.6).
 * Binding: capture admitted bot/thread/generation/concrete member identities and
 * exact adapter lease before any await. isCurrent may reject, never retarget.
 * onLedgerRefused is mandatory, synchronous and generation-owned (area C).
 * Descriptor: exact inventory identity AND mode; an arbitrary id is not authority.
 * Provenance: refs describe newly revealed content; [] explicitly means no new
 * stored content, never an exemption from checking retained parents. Unknown
 * provenance must refuse. Attribution callbacks run only after all prospective
 * members and byte reservations pass. They must be synchronous and must not add
 * parents or release bytes. ToolText stays staged until this boundary.
 * Receipt preparation may write only inside the emitter's rollbackable DB
 * writer transaction; nested parent additions are captured and included in preflight.
 * It must not mutate source roots or send output. A failed preflight rolls the
 * receipt rows back. commitAttribution is reserved for already-validated roots.
 * Release: serialize/await first, acquire BEGIN IMMEDIATE, validate all live
 * members and enqueue synchronously, then commit conservative accounting. A queued transport must re-enter at final acceptance.
 * HTTP: only this module holds raw writers. The facade exposes an allowlist,
 * stages headers, and emits fixed BUILD-FIX 21 denial or terminates an open stream.
 * A valid empty ledger still needs a registered live turn and frozen reader.
 * Proxy/native/upgrade callers must enforce their final transport contract too;
 * an HTTP release does not authorize subsequent engine delivery (areas B–D).
 */
import type { DatabaseSync } from "node:sqlite";
import type { ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import type { LineageRef, LineageVerdict, StagedResultProvenance, TurnLineage } from "./memory/lineage-types.ts";
import { captureTurnParentAdditions, checkedOpenTurns, commitTurnParents, proposeTurnParents, retainedTurnDatabase } from "./memory/lineage-write.ts";
import { releaseTransaction, ReleaseCommitFailed } from "./memory/release-transaction.ts";
import { assertRetainedFence, isPendingFenceDeferral } from "./memory/send-fence.ts";
import type { ConsumingIdentity } from "./ledger-refusal.ts";
import { ledgerRefusalCause, refusalLineFor, REFUSAL_KIND_HEADER } from "./ledger-refusal.ts";
import { consumingSinkEntry, type SinkInventoryEntry } from "./consuming-sink-inventory.ts";
import { checkReleaseAvailable, reserveRelease, withReleaseBudgets, RELEASE_CHUNK_MAX } from "./memory/release-budget.ts";
import { logSwallowedConsumingError } from "./consuming-error-log.ts";
import { isDatabaseBusy, setBusy, DEFAULT_BUSY_MS, BACKGROUND_BUSY_MS } from "./db-busy.ts";

export interface ConsumingTurnBinding {
  readonly identity: ConsumingIdentity;
  readonly turn: TurnLineage;
  readonly db?: DatabaseSync;
  readonly isCurrent: () => boolean;
  readonly onLedgerRefused: (verdict: LineageVerdict) => void;
}
export interface ConsumingDescriptor {
  readonly id: string;
  readonly mode: "body" | "chunk" | "headers" | "native" | "request";
  readonly isRegistered?: () => boolean;
}
// Object identity, not a matching string or an adjacent handler, grants registration.
const registered = new WeakSet<ConsumingDescriptor>();
const reportedRefusals = new WeakSet<object>();
const terminalAllowances = new WeakMap<object, readonly import("./memory/release-budget.ts").ReleaseBudget[]>();
export function registerConsumingDescriptor(id: string, mode: ConsumingDescriptor["mode"]): ConsumingDescriptor & SinkInventoryEntry {
  const entry = consumingSinkEntry(id, mode);
  if (!entry || entry.provenanceContract !== "explicit-per-response") throw new Error("UNREGISTERED_CONSUMING_DESCRIPTOR");
  const descriptor = Object.freeze({ ...entry });
  registered.add(descriptor);
  return descriptor;
}
export function assertConsumingDescriptor(binding: ConsumingTurnBinding, descriptor: ConsumingDescriptor): void {
  if (!registered.has(descriptor) || descriptor.isRegistered?.() === false) refuseConsumingTurn(binding);
}
export function refuseConsumingTurn(binding: ConsumingTurnBinding, verdict: LineageVerdict = { state: "checking", reason: "not-built" }): never {
  try { binding.onLedgerRefused(verdict); } finally {
    const error = Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED", fence: verdict });
    reportedRefusals.add(error);
    throw error;
  }
}
export function bindConsumingTurn(binding: ConsumingTurnBinding): ConsumingTurnBinding {
  const identity = Object.freeze({ ...binding.identity, lineageTurnIds: Object.freeze([...binding.identity.lineageTurnIds]) });
  const result = Object.freeze({ ...binding, identity });
  assertConsumingBinding(result);
  terminalAllowances.set(result, checkedOpenTurns(result.turn).map(member => member.budget!));
  return result;
}
export function assertConsumingBinding(binding: ConsumingTurnBinding): void {
  try {
    if (typeof binding.onLedgerRefused !== "function") {
      // Missing lifecycle cannot acquire release authority, even for [] refs.
      for (const member of checkedOpenTurns(binding.turn)) {
        member.sealed = true;
        try { member.onLedgerRefused!({ state: "checking", reason: "not-built" }); }
        catch { /* every member must be sealed even when another cleanup fails */ }
      }
      throw new Error("MEMORY_CONTEXT_REVOKED");
    }
    const members = checkedOpenTurns(binding.turn);
    if (!binding.db || binding.db !== retainedTurnDatabase(binding.turn) || !binding.isCurrent() || !binding.identity.adapterLeaseId || !binding.identity.dispatchGeneration
      || members.length !== binding.identity.lineageTurnIds.length
      || members.some((member, i) => member.threadId !== binding.identity.threadId || member.turnId !== binding.identity.lineageTurnIds[i])) {
      refuseConsumingTurn(binding);
    }
    if (!terminalAllowances.has(binding)) terminalAllowances.set(binding, members.map(member => member.budget!));
  } catch (error) {
    if (error instanceof Object && reportedRefusals.has(error)) throw error;
    logSwallowedConsumingError("binding.assert", error);
    refuseConsumingTurn(binding, (error as { fence?: LineageVerdict }).fence);
  }
}
/** Serialization and asynchronous work belong before this call. The writer must accept
 * synchronously; a backpressure queue calls this again when it can accept the bytes. */
export function preflightConsumingResponse(binding: ConsumingTurnBinding, descriptor: ConsumingDescriptor, bytes: number): void {
  assertConsumingBinding(binding);
  assertConsumingDescriptor(binding, descriptor);
  if (!Number.isSafeInteger(bytes) || bytes < 0) refuseConsumingTurn(binding);
  const budgets = checkedOpenTurns(binding.turn).map(member => member.budget!);
  withReleaseBudgets(budgets, () => {
    checkReleaseAvailable(budgets, { attempts: 1, bytes });
    // Preparation is validation, never a released attempt or bytes. The
    // connected writer independently rechecks and charges its actual frame.
    assertRetainedFence(binding.turn, binding.db);
  });
}

class ConsumingPreparationFailed {
  readonly error: unknown;
  constructor(error: unknown) { this.error = error; }
}

interface ConsumingEmission<T> {
  bytes: number;
  refs: readonly LineageRef[];
  prepareAttribution?: () => void;
  commitAttribution?: () => void;
  /** `confirm` is for a destination that learns later whether it took the frame (see `confirms`). */
  write: (confirm: () => void) => T;
  /** The destination reports failure after write() has returned (a socket: Node never throws for a dead one). write() then calls
   * `confirm` once the destination itself reported the frame taken; a write() that merely returned accepted nothing. */
  confirms?: boolean;
}
export function emitConsumingTurnResponse<T>(binding: ConsumingTurnBinding, descriptor: ConsumingDescriptor,
  emission: ConsumingEmission<T>): T {
  return emitPreparedConsumingResponse(binding, descriptor, () => emission);
}
/** Private HTTP preparation seam: construct and serialize under the same writer
 * owner that validates and accepts the resulting bytes. Never join an unrelated
 * transaction or let a preparation callback acquire transport authority. */
function emitPreparedConsumingResponse<T>(binding: ConsumingTurnBinding, descriptor: ConsumingDescriptor,
  prepare: () => ConsumingEmission<T>): T {
  let emission: ConsumingEmission<T>;
  assertConsumingBinding(binding);
  const db = binding.db!;
  const budgets = [...new Set(checkedOpenTurns(binding.turn).map(member => member.budget!))];
  let entered = false;
  try {
    return withReleaseBudgets(budgets, () => {
      // Reserve the timeout pragmas, BEGIN and both possible exits. Cleanup
      // must remain possible after a failed validation exhausts the budget.
      reserveRelease(budgets, { statements: 5, work: 5 });
      // A serving-thread release never waits out a foreground lock budget.
      // Busy is retryable and says nothing about the retained context.
      setBusy(db, BACKGROUND_BUSY_MS);
      try { return releaseTransaction(db, {
      validate: () => {
        assertConsumingBinding(binding);
        assertConsumingDescriptor(binding, descriptor);
        checkReleaseAvailable(budgets, { attempts: 1 });
        const preparedParents = captureTurnParentAdditions(binding.turn, () => { emission = prepare(); });
        assertConsumingBinding(binding);
        if (!Array.isArray(emission.refs)
          || !Number.isSafeInteger(emission.bytes) || emission.bytes < 0) refuseConsumingTurn(binding);
        if ([emission.write, emission.prepareAttribution, emission.commitAttribution].some(fn => fn?.constructor.name === "AsyncFunction")) refuseConsumingTurn(binding);
        checkReleaseAvailable(budgets, { attempts: 1, bytes: emission.bytes });
        const attribution = (work: () => void) => {
          const value: unknown = work();
          if (value && typeof (value as { then?: unknown }).then === "function") refuseConsumingTurn(binding);
          assertConsumingBinding(binding);
          assertRetainedFence(binding.turn, db);
        };
        const captured = emission.prepareAttribution
          ? captureTurnParentAdditions(binding.turn, () => attribution(emission.prepareAttribution!)) : [];
        const refs = [...emission.refs, ...preparedParents, ...captured];
        const proposal = proposeTurnParents(binding.turn, refs);
        for (const entry of proposal.entries) assertRetainedFence(entry.open, db, 0, entry.parents, "check-only");
        // Rollback hooks stay under the writer owner until final acceptance.
        if (refs.length) commitTurnParents(proposal);
        if (emission.commitAttribution) {
          const late = captureTurnParentAdditions(binding.turn, () => attribution(emission.commitAttribution!));
          if (late.length) refuseConsumingTurn(binding);
        }
        assertConsumingBinding(binding);
        assertRetainedFence(binding.turn, db);
      },
      onRelease: () => reserveRelease(budgets, { attempts: 1, bytes: emission.bytes, work: 1 }),
      // 1.0.21 cause4: the fence passed and the destination took the frame, so this window of the turn's budget may be followed by
      // another (release-budget.ts). A write that throws accepted nothing, and neither did a frame with no bytes (headers alone).
      // Round 2: a socket's write returns normally even when the socket is gone and reports the failure later, so a destination that
      // `confirms` is believed only when it says so itself (at most once per frame); until then the frame renews nothing.
      emit: () => {
        entered = true;
        let confirmed = false;
        // A late report counts only for the window its frame was written in: it never renews a window that released nothing itself.
        const written = budgets.map(budget => budget.windows);
        const confirm = () => {
          if (confirmed) return;
          confirmed = true;
          if (emission.bytes > 0) budgets.forEach((budget, index) => { if (budget.windows === written[index]) budget.accepted(); });
        };
        const taken = emission.write(confirm);
        if (!emission.confirms) confirm();
        return taken;
      },
      }); } finally { try { setBusy(db, DEFAULT_BUSY_MS); } catch { /* closed handle remains a fence failure */ } }
    });
  } catch (error) {
    if (error instanceof ConsumingPreparationFailed) throw error;
    // 1.0.20 revkill: nothing was released and nothing is refused; the deferring caller waits for the check (send-fence.ts).
    if (!entered && isPendingFenceDeferral(error)) throw error;
    if (error instanceof ReleaseCommitFailed || entered && error instanceof Error && error.message === "ASYNC_RELEASE_TRANSACTION") {
      // The transport may own bytes even though durable commit or the writer
      // contract failed. Keep its charge and seal; never retry the frame.
      try { binding.onLedgerRefused({ state: "checking", reason: "lookup-error" }); } catch { /* retain the release error */ }
      throw error;
    }
    if (entered) throw error; // Native transport errors retain identity.
    if (error instanceof Object && reportedRefusals.has(error)) throw error;
    logSwallowedConsumingError(isDatabaseBusy(error) ? "response.emit:busy" : "response.emit", error);
    if (isDatabaseBusy(error)) {
      // A committed revoke still wins over contention. Read the retained
      // ledger without trying to acquire the already-held writer again.
      assertConsumingBinding(binding);
      assertRetainedFence(binding.turn, db);
      throw error;
    }
    refuseConsumingTurn(binding, (error as { fence?: LineageVerdict })?.fence ?? { state: "checking", reason: "lookup-error" });
  }
}

/** A restricted destination facade: raw writes remain private to this module.
 * Header, data and final data (including SSE DONE) each cross the same gate. */
export function consumingHttpWriter(raw: ServerResponse, binding: ConsumingTurnBinding,
  descriptors: Readonly<{ headers: ConsumingDescriptor; body: ConsumingDescriptor; chunk: ConsumingDescriptor }>): ServerResponse {
  let status = 200, sealed = false, declared = false;
  const headers = new Map<string, string | number | string[]>();
  const staged: { refs: LineageRef[]; prepares: Array<() => void>; commits: Array<() => void> } = { refs: [], prepares: [], commits: [] };
  const terminate = () => {
    if (sealed) return;
    sealed = true;
    denyConsumingHttp(raw, binding);
  };
  type Body = { data?: string | Uint8Array; encoding?: BufferEncoding; callback?: () => void };
  let capture: { body?: Body } | undefined;
  const release = (mode: "body" | "chunk" | "headers", data?: string | Uint8Array, encoding?: BufferEncoding, callback?: () => void,
    preparation?: () => Body): boolean => {
    if (sealed) return false;
    if (capture) {
      if (mode !== "body" || capture.body || preparation) refuseConsumingTurn(binding);
      capture.body = { data, encoding, callback };
      return true;
    }
    let entered = false;
    const bytes = typeof data === "string" ? Buffer.byteLength(data, encoding) : data?.byteLength ?? 0;
    if (mode === "chunk" && bytes > RELEASE_CHUNK_MAX) {
      const buffer = typeof data === "string" ? Buffer.from(data, encoding) : data!;
      let accepted = true;
      for (let offset = 0; offset < buffer.byteLength; offset += RELEASE_CHUNK_MAX) {
        accepted = release("chunk", buffer.subarray(offset, offset + RELEASE_CHUNK_MAX), undefined,
          offset + RELEASE_CHUNK_MAX >= buffer.byteLength ? callback : undefined) && accepted;
      }
      return accepted;
    }
    const before = preparation ? { status, headers: new Map(headers), declared, refs: [...staged.refs], prepares: [...staged.prepares], commits: [...staged.commits] } : undefined;
    try {
      return emitPreparedConsumingResponse(binding, descriptors[mode], () => {
        if (preparation) {
          try { ({ data, encoding, callback } = preparation()); }
          catch (error) {
            if (error instanceof Object && (reportedRefusals.has(error) || (error as { code?: string }).code === "MEMORY_CONTEXT_REVOKED")) throw error;
            throw new ConsumingPreparationFailed(error);
          }
          if (raw.headersSent || raw.writableEnded || raw.destroyed) refuseConsumingTurn(binding);
        }
        if (sealed || !declared) refuseConsumingTurn(binding);
        const finalBytes = typeof data === "string" ? Buffer.byteLength(data, encoding) : data?.byteLength ?? 0;
        return { bytes: finalBytes, refs: mode === "headers" ? [] : staged.refs,
        ...(mode !== "headers" && staged.prepares.length ? { prepareAttribution: () => { for (const prepare of staged.prepares) synchronousAttribution(prepare); } } : {}),
        commitAttribution: () => { if (mode !== "headers") for (const commit of staged.commits) synchronousAttribution(commit); },
        confirms: true,
        write: (confirm: () => void) => {
          entered = true;
          if (!raw.headersSent) raw.writeHead(status, Object.fromEntries(headers));
          if (mode === "headers") return true;
          const onDone = callback;
          // Node calls this with the error when the write failed (ERR_STREAM_DESTROYED and the like) and, for end(), only on
          // 'finish': a response whose socket is gone never finishes. Only an error-free report is an accepted release.
          const done = (error?: Error | null) => { if (!error) confirm(); onDone?.call(facade); };
          const accepted = mode === "body" ? raw.end(data, encoding ?? "utf8", done) : raw.write(data!, encoding ?? "utf8", done);
          if (accepted && typeof (accepted as { then?: unknown }).then === "function") refuseConsumingTurn(binding);
          staged.refs = []; staged.prepares = []; staged.commits = [];
          return mode === "body" ? true : accepted !== false;
        },
      }; });
    } catch (error) {
      if (error instanceof ConsumingPreparationFailed && before) {
        status = before.status; declared = before.declared;
        headers.clear(); for (const [name, value] of before.headers) headers.set(name, value);
        staged.refs = before.refs; staged.prepares = before.prepares; staged.commits = before.commits;
        throw error.error;
      }
      if (!entered && isDatabaseBusy(error)) throw error;
      if (entered && (error as { code?: unknown })?.code !== "MEMORY_CONTEXT_REVOKED") {
        // Native failure may follow accepted bytes. Close without trying a
        // second denial write, and preserve the original transport error.
        sealed = true;
        try { raw.destroy(); } catch { /* retain the original failure */ }
      } else terminate();
      throw error;
    }
  };
  const synchronousAttribution = (work: () => void) => {
    if (work.constructor.name === "AsyncFunction") refuseConsumingTurn(binding);
    const result: unknown = work();
    if (result && typeof (result as { then?: unknown }).then === "function") refuseConsumingTurn(binding);
    // Stop the callback chain as soon as one callback changes authorization.
    assertConsumingBinding(binding);
    assertRetainedFence(binding.turn, binding.db);
  };
  // Object.create(null) deliberately has no inherited raw transport methods.
  // The ServerResponse type is a compatibility seam for existing desktop/shared
  // handlers, not a runtime forwarding proxy. Only these methods exist.
  const facade = Object.create(null) as ServerResponse;
  const listeners = new Map<(...args: any[]) => void, (...args: any[]) => void>();
  const listen = (once: boolean, event: string, callback: (...args: any[]) => void) => {
    if (!["close", "drain", "error", "finish", "unpipe"].includes(event)) throw new Error("UNSUPPORTED_CONSUMING_EVENT");
    const wrapped = () => callback.call(facade);
    listeners.set(callback, wrapped);
    if (once) raw.once(event, wrapped); else raw.on(event, wrapped);
    return facade;
  };
  Object.assign(facade, {
    setHeader: (name: string, value: string | number | readonly string[]) => { headers.set(name.toLowerCase(), typeof value === "object" ? [...value] : value); return facade; },
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    hasHeader: (name: string) => headers.has(name.toLowerCase()),
    removeHeader: (name: string) => { headers.delete(name.toLowerCase()); },
    writeHead: (code: number, values?: Record<string, string | number | readonly string[]>) => {
      status = code;
      for (const [name, value] of Object.entries(values ?? {})) headers.set(name.toLowerCase(), typeof value === "object" ? [...value] : value);
      return facade;
    },
    flushHeaders: () => { release("headers"); },
    write: (data: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void) =>
      release("chunk", data, typeof encoding === "string" ? encoding : undefined, typeof encoding === "function" ? encoding : callback),
    end: (data?: string | Uint8Array | (() => void), encoding?: BufferEncoding | (() => void), callback?: () => void) => {
      release("body", typeof data === "function" ? undefined : data, typeof encoding === "string" ? encoding : undefined,
        typeof data === "function" ? data : typeof encoding === "function" ? encoding : callback);
      return facade;
    },
    destroy: () => {
      if (!sealed) { sealed = true; try { binding.onLedgerRefused({ state: "checking", reason: "lookup-error" }); } finally { raw.destroy(); } }
      return facade;
    },
    on: (event: string, callback: (...args: any[]) => void) => listen(false, event, callback),
    once: (event: string, callback: (...args: any[]) => void) => listen(true, event, callback),
    off: (event: string, callback: (...args: any[]) => void) => { const wrapped = listeners.get(callback); if (wrapped) raw.off(event, wrapped); return facade; },
  });
  for (const key of ["headersSent", "writableEnded", "destroyed", "writableNeedDrain"] as const) Object.defineProperty(facade, key, { get: () => raw[key] });
  Object.defineProperty(facade, "statusCode", { get: () => status, set: (value: number) => { status = value; } });
  httpStages.set(facade, { binding, terminate, prepare: (prepare, accept) => {
    if (capture || sealed || raw.headersSent || raw.writableEnded || raw.destroyed) {
      try { refuseConsumingTurn(binding); } finally { terminate(); }
    }
    const synchronous = <T>(work: () => T): T => {
      if (work.constructor.name === "AsyncFunction") refuseConsumingTurn(binding);
      const value = work();
      if (value && typeof (value as { then?: unknown }).then === "function") refuseConsumingTurn(binding);
      return value;
    };
    // The recursive writer call only stages one body. The outer release owns
    // validation, the byte charge and the sole raw write after callbacks return.
    release("body", undefined, undefined, undefined, () => {
      assertRetainedFence(binding.turn, binding.db);
      const pending: { body?: Body } = {};
      capture = pending;
      try {
        if ([prepare, accept].some(work => work.constructor.name === "AsyncFunction")) refuseConsumingTurn(binding);
        const value = synchronous(prepare);
        synchronous(() => accept(value));
        if (!pending.body) refuseConsumingTurn(binding);
        return pending.body;
      } finally { capture = undefined; }
    });
  }, busy: () => {
    if (capture) refuseConsumingTurn(binding);
    // This fixed protocol control has no caller-controlled body, headers,
    // provenance or attribution. It conveys no stored context and does not
    // grant permission to repeat a failed side effect. Every retained member
    // must still be live; a revoked ledger takes the ordinary terminal path.
    if (sealed || raw.destroyed || raw.writableEnded) return;
    if (raw.headersSent) { sealed = true; raw.destroy(); return; }
    const data = JSON.stringify({ error: "Busy for a moment, try again", code: "DATABASE_BUSY", retryable: true, retryAfterSeconds: 1 });
    try {
      assertConsumingBinding(binding);
      assertConsumingDescriptor(binding, descriptors.body);
      const budgets = checkedOpenTurns(binding.turn).map(member => member.budget!);
      withReleaseBudgets(budgets, () => {
        assertRetainedFence(binding.turn, binding.db);
        reserveRelease(budgets, { attempts: 1, bytes: Buffer.byteLength(data), work: 1 });
        assertConsumingBinding(binding);
        raw.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", "retry-after": "1" });
        raw.end(data);
      });
      sealed = true;
    } catch (error) { terminate(); throw error; }
  }, storedContentProducer: consumingSinkEntry(descriptors.body.id, "body")!.storedContentProducer, stage: (refs, commit, prepare) => {
    if (!Array.isArray(refs)) refuseConsumingTurn(binding);
    declared = true;
    staged.refs.push(...refs); if (commit) staged.commits.push(commit); if (prepare) staged.prepares.push(prepare);
  } });
  Object.freeze(facade);
  return facade;
}

const httpStages = new WeakMap<object, { binding: ConsumingTurnBinding; storedContentProducer: boolean; terminate(): void; busy(): void; prepare<T>(prepare: () => T, accept: (value: T) => void): void; stage(refs: readonly LineageRef[], commit?: () => void, prepare?: () => void): void }>();
/** Only an already-captured writer may emit this fixed contention control. */
export function consumingBusyResponse(writer: object): boolean {
  const state = httpStages.get(writer);
  if (!state) return false;
  state.busy();
  return true;
}
/** Local/external producers cannot relabel a successful stored-content route
 * as an empty-provenance result. Its actual reader must declare the refs. */
export function declareNoStoredResponse(writer: object, status: number): void {
  const state = httpStages.get(writer);
  if (!state) return;
  if (state.storedContentProducer && status < 400) {
    try { refuseConsumingTurn(state.binding); } finally { state.terminate(); }
  }
  state.stage([]);
}
export function refuseConsumingHttp(writer: object): void {
  const state = httpStages.get(writer);
  if (!state) throw new Error("UNBOUND_CONSUMING_WRITER");
  try { state.binding.onLedgerRefused({ state: "checking", reason: "not-built" }); }
  finally { state.terminate(); }
}
export function consumingResponseBinding(writer: object): ConsumingTurnBinding | undefined { return httpStages.get(writer)?.binding; }

/** Preparation that needs generated attachment names belongs to the same
 * rollback owner as serialization and final HTTP acceptance. */
export function prepareConsumingHttp<T>(writer: object, prepare: () => T, accept: (value: T) => void): void {
  const state = httpStages.get(writer);
  if (!state) { refuseConsumingHttp(writer); return; }
  state.prepare(prepare, accept);
}
export function stageConsumingResponse(writer: object, refs: readonly LineageRef[], commit?: () => void, prepare?: () => void): boolean {
  const stage = httpStages.get(writer);
  if (!stage) return false;
  stage.stage(refs, commit, prepare);
  return true;
}
// Preserve attribution across adapters that intentionally project the transport
// envelope to {status,body}. Metadata is never serialized into a tool result.
const resultStages = new WeakMap<object, StagedResultProvenance>();
export function attachResultProvenance(body: object, provenance: StagedResultProvenance): void {
  resultStages.set(body, Object.freeze({ ...provenance, refs: Object.freeze([...provenance.refs]) }));
}
export function stageResultProvenance(writer: object, body: unknown): void {
  if (!body || typeof body !== "object") return;
  const provenance = resultStages.get(body);
  if (provenance) stageProvenance(writer, provenance);
}
export function stageProvenance(writer: object, provenance: StagedResultProvenance): void {
  const binding = consumingResponseBinding(writer);
  if (binding && provenance.consumingTurn) {
    const bound = checkedOpenTurns(binding.turn), expected = checkedOpenTurns(provenance.consumingTurn);
    if (bound.length !== expected.length || bound.some((member, i) => member !== expected[i])) refuseConsumingTurn(binding);
  }
  stageConsumingResponse(writer, provenance.refs, provenance.commit, provenance.prepare);
}
/** Only context-free denial is available without a consuming binding. */
export function denyConsumingHttp(raw: ServerResponse, binding?: ConsumingTurnBinding, cause?: unknown): void {
  if (raw.destroyed || raw.writableEnded) return;
  if (binding) {
    const budgets = terminalAllowances.get(binding);
    // No resolver or ledger scan is permitted on exhausted terminal control.
    if (!budgets?.length || budgets.map(budget => budget.terminal()).some(allowed => !allowed)) { raw.destroy(); return; }
  }
  if (raw.headersSent) { raw.destroy(); return; }
  for (const name of raw.getHeaderNames()) raw.removeHeader(name);
  // 1.0.21 cause22: the refusing check's own verdict when the caller holds it (fixed vocabulary only, ledgerRefusalCause); the door
  // name alone hid a real budget stop behind a label.
  const fence = (cause as { fence?: LineageVerdict } | null | undefined)?.fence;
  const word = fence && typeof fence === "object" ? ledgerRefusalCause(fence) : "invalid-verdict";
  console.warn(word === "invalid-verdict" ? "[memory] ledger refusal cause=consuming-http-denied" : `[memory] ledger refusal cause=${word} door=consuming-http-denied`);
  // cause22 r2: the engine-facing body is the same truthful line the owner is shown. A budget stop (the verdict the caller holds, or the
  // bound turn's own budget having refused) lost no context, so it is never told "context is no longer available". The header is the
  // fixed word a spawned proxy reads to give its own terminal JSON-RPC error the same line (proxy-turn-release.ts); no other value exists.
  const budgetStop = word === "checking:retained-budget" || (binding ? terminalAllowances.get(binding)?.some(budget => budget.refused) === true : false);
  raw.writeHead(409, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...(budgetStop ? { [REFUSAL_KIND_HEADER]: "retained-budget" } : {}) });
  raw.end(refusalLineFor(budgetStop ? { state: "checking", reason: "retained-budget" } : undefined));
}

/** A consuming source never receives the destination. Every bounded piece is
 * gated on drain, and a failed gate destroys the upstream before returning. */
export async function pipeConsumingStream(source: Readable, writer: ServerResponse): Promise<void> {
  const abort = () => source.destroy();
  writer.once("close", abort);
  try {
    for await (const value of source) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      for (let at = 0; at < bytes.length; at += 65536) {
        if (writer.destroyed || writer.writableEnded) return;
        if (!writer.write(bytes.subarray(at, at + 65536))) await new Promise<void>(resolve => {
          const ready = () => { writer.off("close", ready); writer.off("drain", ready); resolve(); };
          writer.once("drain", ready); writer.once("close", ready);
        });
      }
    }
    if (!writer.destroyed && !writer.writableEnded) writer.end();
  } catch { source.destroy(); writer.destroy(); }
  finally { writer.off("close", abort); source.destroy(); }
}
