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
// Bounded, and written to the ledger file beside the operation ledger: the check
// runs as the turn settles, moments after the calls it needs, and a restart in
// between must not lose the record of an action the app completed.
import type { ActionClass } from "../shared/reply-action-claims.ts";
import type { SqliteReceiptStore } from "./connected-app-journal.ts";
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

/** The receipt for one answered call. It belongs to the turn that dispatched the action (`call.origin`), not to the
 * turn that collected the answer through a status check or a repeated request; `claim` is the collecting call's own. */
export function receiptForAnswer(
  claim: { threadId: string; botId: string; generation: string; turnId?: string },
  call: { name: string; args: unknown; origin?: { threadId: string; botId: string; generation: string; turnId?: string }; key?: string; dispatchedAt?: number },
  message: Record<string, unknown> | null | undefined,
): Omit<ConnectedAppReceipt, "at"> {
  const owner = call.origin ?? claim;
  return {
    threadId: owner.threadId, botId: owner.botId, generation: owner.generation, classes: answeredActionClasses(call.name, call.args, message),
    ...(owner.turnId ? { turnId: owner.turnId } : {}), ...(call.key ? { key: call.key } : {}), ...(call.dispatchedAt !== undefined ? { dispatchedAt: call.dispatchedAt } : {}),
  };
}

export interface ConnectedAppReceipt {
  threadId: string;
  botId: string;
  /** The internal turn generation whose bridge made the call. Lives only in this process. */
  generation: string;
  /** The provider turn whose bridge dispatched the action: the key that survives a restart. */
  turnId?: string;
  classes: ActionClass[];
  at: number;
  /** The operation that made it: one receipt per operation, however many times its answer is read. */
  key?: string;
  /** When the action was dispatched. For logs and pruning only; no match ever compares it. */
  dispatchedAt?: number;
}

const MAX_RECEIPTS = 4_000;
const MAX_AGE_MS = 6 * 60 * 60_000;

/** The provider turn a generation dispatched (server/internal-capabilities.ts providerTurnOf). */
export type ProviderTurnOf = (threadId: string, generation: string) => string | undefined;

export class ConnectedAppReceipts {
  readonly #receipts: ConnectedAppReceipt[] = [];
  readonly now: () => number;
  readonly #store: SqliteReceiptStore | undefined;
  readonly #turnOf: ProviderTurnOf | undefined;
  #loaded = false;
  /** Receipts the store has not taken yet (a lock, a full disk); tried again on the next record or lookup. */
  readonly #unsaved: ConnectedAppReceipt[] = [];
  /** Turns learned for kept receipts that the store has not taken yet (operation key to turn id); tried again with #unsaved. */
  readonly #unbound = new Map<string, string>();
  /** Receipts read back from the store. Their generation belonged to an earlier process, so only their turn id can match. */
  readonly #fromStore = new WeakSet<ConnectedAppReceipt>();
  constructor(now: () => number = Date.now, store?: SqliteReceiptStore, turnOf?: ProviderTurnOf) {
    this.now = now;
    this.#store = store;
    this.#turnOf = turnOf;
    this.#sync();
  }

  /** Read what the store holds (once it can be read) and give it what it missed. Never throws. */
  #sync(): void {
    const store = this.#store;
    if (!store) return;
    try {
      if (!this.#loaded) {
        const held = store.load(this.now() - MAX_AGE_MS);
        const keys = new Set(this.#receipts.map(receipt => receipt.key).filter(Boolean));
        const before = this.#receipts.splice(0);
        for (const kept of held) {
          if (kept.key && keys.has(kept.key)) continue;
          const loaded: ConnectedAppReceipt = { ...kept, classes: kept.classes as ActionClass[] };
          this.#fromStore.add(loaded);
          this.#receipts.push(loaded);
        }
        this.#receipts.push(...before);
        this.#receipts.sort((a, b) => a.at - b.at);
        while (this.#receipts.length > MAX_RECEIPTS) this.#receipts.shift();
        this.#loaded = true;
      }
      while (this.#unsaved.length) {
        store.add(this.#unsaved[0]!, this.now() - MAX_AGE_MS, MAX_RECEIPTS);
        this.#unsaved.shift();
      }
      for (const [key, turnId] of this.#unbound) {
        store.bindTurn(key, turnId);
        this.#unbound.delete(key);
      }
    } catch (error) {
      console.warn("connected app receipts could not be synced:", error instanceof Error ? error.message : String(error));
    }
  }

  record(receipt: Omit<ConnectedAppReceipt, "at">): void {
    // Give the store what it missed first: a repeat of a kept receipt returns below, and must not leave an earlier one unwritten.
    if (this.#pending()) this.#sync();
    if (!receipt.classes.length) return;
    if (receipt.key && this.#receipts.some(held => held.key === receipt.key)) return;
    const turnId = receipt.turnId ?? this.#turnOf?.(receipt.threadId, receipt.generation);
    const kept: ConnectedAppReceipt = { ...receipt, classes: [...receipt.classes], at: this.now(), ...(turnId ? { turnId } : {}) };
    this.#receipts.push(kept);
    const cutoff = this.now() - MAX_AGE_MS;
    while (this.#receipts.length > MAX_RECEIPTS || (this.#receipts[0] && this.#receipts[0].at < cutoff)) this.#receipts.shift();
    if (!this.#store) return;
    this.#unsaved.push(kept);
    this.#sync();
  }

  /** Name the turn of receipts kept before their turn was bound (the bridge's call reached the relay first), and keep the
   * name in the store. A receipt read back from the store is never named here: its generation was another process's. */
  #learnTurns(): void {
    const turnOf = this.#turnOf;
    if (!turnOf) return;
    let learned = false;
    for (const receipt of this.#receipts) {
      if (receipt.turnId || this.#fromStore.has(receipt)) continue;
      const turnId = turnOf(receipt.threadId, receipt.generation);
      if (!turnId) continue;
      receipt.turnId = turnId;
      // a receipt still waiting in #unsaved is this same object, so it is written with its turn
      if (!this.#store || !receipt.key || this.#unsaved.includes(receipt)) continue;
      // queued and written by the same drain as #unsaved, so a failed write is tried again and a restart still finds the turn
      this.#unbound.set(receipt.key, turnId);
      learned = true;
    }
    if (learned) this.#sync();
  }

  /** Whether the store still misses something: never read yet, a receipt, or a learned turn. */
  #pending(): boolean {
    return Boolean(this.#store) && (!this.#loaded || this.#unsaved.length > 0 || this.#unbound.size > 0);
  }

  /** The classes completed for one turn. A receipt is the turn's when it is in the same thread and names the same
   * provider turn, or, for a receipt recorded in this process, the same generation. Nothing else: no time, no bot. */
  forTurn(turn: { threadId: string; turnId?: string; generation?: string }): Set<ActionClass> {
    const out = new Set<ActionClass>();
    if (this.#pending()) this.#sync();
    this.#learnTurns();
    for (const receipt of this.#receipts) {
      if (receipt.threadId !== turn.threadId) continue;
      const mine = (Boolean(turn.turnId) && receipt.turnId === turn.turnId)
        || (Boolean(turn.generation) && !this.#fromStore.has(receipt) && receipt.generation === turn.generation);
      if (mine) for (const cls of receipt.classes) out.add(cls);
    }
    return out;
  }
}
