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
  let descriptor: ReturnType<typeof registerConsumingDescriptor>;
  try { descriptor = registerConsumingDescriptor(`native:${sink}`, "native"); }
  catch { binding.onLedgerRefused({ state: "checking", reason: "not-built" }); throw new EngineInputRevoked({ state: "checking", reason: "not-built" }); }
  preflightConsumingResponse(binding, descriptor, Buffer.byteLength(serialized));
}
/** Connected HTTP writes may split a UTF-8 sequence. Charge the original
 * bytes rather than decoding and re-encoding a partial frame. */
export function releaseNativeWire<T>(binding: ConsumingTurnBinding | null | undefined, sink: string, serialized: string | Uint8Array, write: () => T): T {
  // null is an explicit non-consuming admission, captured by the caller.
  // undefined remains an unproven/missing authority, never an exemption.
  if (binding === null) return write();
  if (!binding) throw new EngineInputRevoked({ state: "checking", reason: "not-built" });
  let descriptor: ReturnType<typeof registerConsumingDescriptor>;
  try { descriptor = registerConsumingDescriptor(`native:${sink}`, "native"); }
  catch { binding.onLedgerRefused({ state: "checking", reason: "not-built" }); throw new EngineInputRevoked({ state: "checking", reason: "not-built" }); }
  return emitConsumingTurnResponse(binding, descriptor, {
    bytes: Buffer.byteLength(serialized), refs: [], write,
  });
}

import { assertReleaseContext, releaseTransaction, ReleaseCommitFailed, type ReleaseContext } from "../memory/release-transaction.ts";

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

function checkEngineInput(fence: EngineFence, prompt: BuiltPrompt, serializedBytes?: number,
  scope: "prompt" | "prompt-and-retained" = "prompt-and-retained"): void {
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
  }
}

/** The adapter's text for a built prompt (the one place the brand is unwrapped for a driver). */
export const engineText = (prompt: BuiltPrompt): string => prompt.text;

/** The final writer captures the original prompt and generation. Caller hooks
 * and Stop run before acquiring its owner; all authority is checked inside. */
function engineWriter(fence: EngineFence, prompt: BuiltPrompt, prior?: SendTurnInput["fencedWrite"], binding?: ConsumingTurnBinding): NonNullable<SendTurnInput["fencedWrite"]> {
  return <R>(write: () => R, extra?: (context: ReleaseContext) => void, bytes?: number): R => {
    let entered = false;
    let ownerFailure = false;
    if (!fence.retained) throw new EngineInputRevoked({ state: "checking", reason: "not-built" });
    const members = checkedOpenTurns(fence.retained);
    const budgets = [...new Set(members.map(member => member.budget!))];
    const db = retainedTurnDatabase(fence.retained);
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
      if (!Number.isSafeInteger(bytes) || bytes! < 0 || write.constructor.name === "AsyncFunction") throw new EngineInputRevoked({ state: "checking", reason: "not-built" });
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
