// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the connected-app relay saw the app complete, for the reply check.
//
// Every engine's connected-app calls pass one relay (server/connector-proxy.ts
// to /api/internal/connectors/mcp to composio.relayConnectedAppCall). The relay
// holds the call as it was sent and the app's own answer, so it knows a Gmail
// send went through however the engine reports its tools: an ACP engine that
// starts a tool before its arguments arrive, one that keeps a long result in a
// file, a status check that collected a slow action's outcome. The reply check
// (server/reply-action-guard.ts) counts these receipts as records of the turn
// that made the call. Only an answer that says the action succeeded is a
// receipt: an error, a refusal, a failed action, or no answer at all is not.
//
// In memory and bounded: the check runs as the turn settles, moments after the
// calls it needs.
import type { ActionClass } from "../shared/reply-action-claims.ts";
import { toolAction } from "./reply-action-guard.ts";

/** The classes of action the app reported done in one relayed answer. `message`
 * is the JSON-RPC frame that answers the call, or null when none was read. */
export function answeredActionClasses(name: string, args: unknown, message: Record<string, unknown> | null | undefined): ActionClass[] {
  if (!message || message.error !== undefined || !("result" in message)) return [];
  const result = message.result;
  if (!result || typeof result !== "object" || (result as { isError?: unknown }).isError === true) return [];
  const action = toolAction(name, true, args, result);
  const operations = action.operations?.length ? action.operations : [action];
  return [...new Set(operations.filter(operation => operation.outcome === "completed").flatMap(operation => operation.classes))];
}

export interface ConnectedAppReceipt {
  threadId: string;
  botId: string;
  /** The internal turn generation whose bridge made the call. */
  generation: string;
  classes: ActionClass[];
  at: number;
}

const MAX_RECEIPTS = 4_000;
const MAX_AGE_MS = 6 * 60 * 60_000;

export class ConnectedAppReceipts {
  readonly #receipts: ConnectedAppReceipt[] = [];
  readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  record(receipt: Omit<ConnectedAppReceipt, "at">): void {
    if (!receipt.classes.length) return;
    this.#receipts.push({ ...receipt, classes: [...receipt.classes], at: this.now() });
    const cutoff = this.now() - MAX_AGE_MS;
    while (this.#receipts.length > MAX_RECEIPTS || (this.#receipts[0] && this.#receipts[0].at < cutoff)) this.#receipts.shift();
  }

  /** The classes completed for one turn: by the generation that dispatched it, or,
   * when that is not known, by the same bot in the same thread since the turn began. */
  forTurn(turn: { threadId: string; generation?: string; botId?: string; since?: number }): Set<ActionClass> {
    const out = new Set<ActionClass>();
    for (const receipt of this.#receipts) {
      const mine = turn.generation
        ? receipt.generation === turn.generation
        : turn.since !== undefined && receipt.threadId === turn.threadId && receipt.botId === turn.botId && receipt.at >= turn.since;
      if (mine) for (const cls of receipt.classes) out.add(cls);
    }
    return out;
  }
}
