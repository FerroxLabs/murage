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
import type { BuiltPrompt, LineageReader, LineageVerdict } from "../memory/lineage-types.ts";
import { assertSendFence } from "../memory/send-fence.ts";

export type { BuiltSendTurnInput };

/** Who the fence judges for (the turn's reader), and against which file (the server's database when absent). */
export interface EngineFence {
  readonly reader: LineageReader; readonly db?: DatabaseSync;
  /** Told of a refusal before it is thrown: the fence runs ahead of the caller's own beforeSubmit, so the turn's submission boundary (which
   * proves "nothing was written, safe to rebuild once") would otherwise never hear that this write was refused. */
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

/** Runs the send fence once (memory/send-fence.ts assertSendFence, S4): throws EngineInputRevoked unless every part still reads shown. */
export function assertEngineInput(fence: EngineFence, prompt: BuiltPrompt): void {
  try { assertSendFence(prompt, fence.reader, fence.db); }
  catch (error) {
    const refused = new EngineInputRevoked((error as { fence?: LineageVerdict }).fence ?? { state: "checking", reason: "lookup-error" });
    try { fence.onRefused?.(refused); } catch { /* the refusal itself still stands */ }
    throw refused;
  }
}

/** The adapter's text for a built prompt (the one place the brand is unwrapped for a driver). */
export const engineText = (prompt: BuiltPrompt): string => prompt.text;

/** The adapter's input for a built turn: the text unwrapped, the fence chained before the caller's own beforeSubmit (every adapter calls it
 * right before each engine write, a relaunch's write included). Server plumbing that routes a turn to one adapter.sendTurn (project usage,
 * shared owner usage) takes this; sendBuiltTurn is this plus the send. */
export function fencedTurnInput(input: BuiltSendTurnInput, fence: EngineFence): SendTurnInput {
  const { prompt, beforeSubmit, ...rest } = input;
  return { ...rest, text: engineText(prompt), beforeSubmit: () => { assertEngineInput(fence, prompt); beforeSubmit?.(); } };
}

/** Send a turn: the fence runs before the caller's own beforeSubmit, before every engine write of the turn. */
export function sendBuiltTurn(adapter: Pick<ProviderAdapter, "sendTurn">, input: BuiltSendTurnInput, fence: EngineFence): Promise<TurnStartResult> {
  return adapter.sendTurn(fencedTurnInput(input, fence));
}

/** Steer into a running turn: the fence runs before the caller's beforeWrite, immediately before the write. A steer adds parents to the
 * running turn (buildPrompt did that when the steer's prompt was built) and never moves its turnLsn. */
export function steerBuilt(adapter: Pick<ProviderAdapter, "steer">, threadId: string, prompt: BuiltPrompt, fence: EngineFence,
  beforeWrite?: () => void, interjectionId?: string): Promise<boolean | SteerDelivery> {
  if (!adapter.steer) return Promise.resolve(false);
  return adapter.steer(threadId, engineText(prompt), () => { assertEngineInput(fence, prompt); beforeWrite?.(); }, interjectionId);
}

/** contracts.ts BuiltEngineInput over an adapter: its turn and steer take a BuiltPrompt, with the send fence before every write. */
export function builtEngineInput(adapter: Pick<ProviderAdapter, "sendTurn" | "steer">, fence: EngineFence): BuiltEngineInput {
  return {
    sendTurn: input => sendBuiltTurn(adapter, input, fence),
    steer: (threadId, prompt, beforeWrite, interjectionId) => steerBuilt(adapter, threadId, prompt, fence, beforeWrite, interjectionId),
  };
}
