// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A13-FIX-DESIGN C1 (amendment): the ONE way a remembered approval becomes
// durable. A card's "Always allow" is staged as a PENDING row, answered, and
// written to the bot, task or routine only once that answer has landed
// (`allowed-once`). No reader of a grant ever reads the pending file, so a
// grant that was never answered cannot be active, whatever fails: there is
// no rollback write to fail.
import { existsSync, readFileSync } from "node:fs";

import { writeFileAtomic } from "./atomic.ts";
import type { RequestOutcome } from "./contracts.ts";

export interface PendingGrantRow {
  threadId: string;
  requestId: string;
  kind: "bot" | "routine";
  /** the bot or routine the keys are for */
  ownerId: string;
  /** the bot's task the keys are also for, when one is named */
  taskThreadId?: string;
  /** the keys the active write would add */
  keys: string[];
  at: number;
}

/** Remembered choices that have not reached their answer yet, keyed by the
 * request's flight (`threadId:requestId`). One file, one durable write per
 * change, memory mirroring disk: a write that fails leaves both as they were. */
export class PendingGrants {
  private readonly rows = new Map<string, PendingGrantRow>();
  private readonly file: string;
  private readonly persist: (file: string, json: string) => void;

  // plain fields, not parameter properties: the server runs under Node's
  // strip-only TypeScript, which does not take them
  constructor(file: string, persist: (file: string, json: string) => void = (path, json) => writeFileAtomic(path, json, { mode: 0o600 })) {
    this.file = file;
    this.persist = persist;
    // A restart cancels every in-flight approval (engine and peer alike), so
    // every row found now is abandoned: its answer never landed, and it is
    // never promoted. Say how many, then clear them.
    let found = 0;
    try {
      if (existsSync(file)) {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        found = parsed && typeof parsed === "object" ? Object.keys(parsed).length : 0;
      }
    } catch { found = 0; }
    if (found) {
      console.warn(`[grants] ${found} remembered ${found === 1 ? "choice" : "choices"} never reached ${found === 1 ? "its" : "their"} answer before the last stop and ${found === 1 ? "was" : "were"} not saved`);
      try { this.save(); } catch (error) { console.warn(`[grants] could not clear the pending file: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  ids(): string[] { return [...this.rows.keys()]; }
  row(id: string): PendingGrantRow | undefined { return this.rows.get(id); }

  /** Record a choice before its answer. Throws when the write fails, and
   * then holds nothing for it. */
  stage(id: string, row: PendingGrantRow): void {
    const before = this.rows.get(id);
    this.rows.set(id, row);
    try { this.save(); } catch (error) {
      if (before) this.rows.set(id, before); else this.rows.delete(id);
      throw error;
    }
  }

  /** Forget a choice (its answer landed and was written, or did not land).
   * Throws when the write fails, and then still holds the row. */
  drop(id: string): void {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.delete(id);
    try { this.save(); } catch (error) {
      this.rows.set(id, row);
      throw error;
    }
  }

  /** Forget every row whose flight is not live any more: its call ended
   * without dropping it (the drop failed) or never came back. Returns the
   * flights it forgot. */
  sweep(live: (id: string) => boolean): string[] {
    const gone = this.ids().filter((id) => !live(id));
    if (!gone.length) return [];
    const kept = new Map(gone.map((id) => [id, this.rows.get(id)!]));
    for (const id of gone) this.rows.delete(id);
    try { this.save(); } catch (error) {
      for (const [id, row] of kept) this.rows.set(id, row);
      throw error;
    }
    return gone;
  }

  private save(): void {
    this.persist(this.file, JSON.stringify(Object.fromEntries(this.rows)));
  }
}

/** Who holds a card's request: the engine that raised it (answered through
 * the adapter) or the peer bus (a bot-to-bot contact card). */
export type GrantHolder =
  | { kind: "engine"; instanceId: string; decidedFor?: { id: string; name: string } }
  | { kind: "peer" };

export interface GrantChokeDeps {
  /** the card is still pending on its thread */
  cardOpen: (threadId: string, requestId: string) => boolean;
  /** who holds the request for this bot; nobody means nothing is saved */
  holder: (threadId: string, requestId: string, holderId: string) => GrantHolder | undefined;
  /** another answer to this flight is being delivered now */
  inFlight: (flight: string) => boolean;
  pending: PendingGrants;
  /** note which surface is answering (dropped again by a non-200 reply) */
  attempt: (flight: string, onComputer: boolean, res: unknown) => void;
  /** deliver Allow to the holder, marking the flight in flight meanwhile */
  answer: (holder: GrantHolder, threadId: string, requestId: string, onComputer: boolean) => Promise<RequestOutcome>;
  warn: (error: unknown) => void;
}

export interface RememberInput<T> {
  res: unknown;
  threadId: string;
  requestId: string;
  answer: unknown;
  onComputer: boolean;
  /** the bot the request must be held for; another holder saves nothing */
  holderId: string;
  /** a route's own live check after the reread (a routine's run is still
   * live), checked again after delivery, before the write (2.3.9) */
  live?: () => boolean;
  /** the bot by name, for the outcome line when it stopped waiting */
  botName?: string;
  row: { kind: "bot" | "routine"; ownerId: string; taskThreadId?: string };
  /** validates the choice and names the keys the active write would add;
   * throws (with a `status`) when it cannot be saved */
  plan: () => readonly string[];
  /** the ONE active write, run only after the answer landed */
  write: () => T;
}

export type RememberResult<T> =
  | { ok: true; value: T; outcome: RequestOutcome }
  | { ok: false; status: number; error: string; answered?: RequestOutcome };

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 2.3.9: the outcome line when the holder no longer waits for this answer. */
export function stoppedWaiting(botName: string | undefined): string {
  return `${botName?.trim() || "Your bot"} stopped waiting for this. Ask it again.`;
}
/** F9: the routine's run ended between delivery and the write. */
export const RUN_ENDED = "This run has ended. The next run will ask again.";

/**
 * Stage, answer, then write. The write runs only when the answer's outcome
 * is `allowed-once`; every other path leaves the active grants untouched.
 * A failed drop leaves a pending row, which no reader reads and the next
 * call sweeps.
 */
export async function rememberAndAnswer<T>(deps: GrantChokeDeps, input: RememberInput<T>): Promise<RememberResult<T>> {
  const gone = { ok: false as const, status: 409, error: "This request is no longer waiting." };
  if (input.answer !== true) return { ok: false, status: 400, error: "Always allow answers this request too: send answer true. Nothing was saved." };
  const flight = `${input.threadId}:${input.requestId}`;
  if (!deps.cardOpen(input.threadId, input.requestId)) return gone;
  const holder = deps.holder(input.threadId, input.requestId, input.holderId);
  if (!holder) return gone;
  if (input.live && !input.live()) return gone;
  if (deps.inFlight(flight)) return { ok: false, status: 409, error: "This request is being answered elsewhere, so nothing was saved." };
  let keys: string[];
  try {
    keys = [...input.plan()];
  } catch (error) {
    return { ok: false, status: (error as { status?: number }).status ?? 400, error: reason(error) };
  }
  // rows earlier calls left behind (their answer never landed, or their drop
  // failed) were never read; forget them now
  try { deps.pending.sweep((id) => id === flight || deps.inFlight(id)); } catch (error) { deps.warn(error); }
  try {
    deps.pending.stage(flight, { threadId: input.threadId, requestId: input.requestId, ...input.row, keys, at: Date.now() });
  } catch (error) {
    return { ok: false, status: 500, error: `Nothing was saved: ${reason(error)}` };
  }
  const discard = () => { try { deps.pending.drop(flight); } catch (error) { deps.warn(error); } };
  try { deps.attempt(flight, input.onComputer, input.res); } catch (error) { deps.warn(error); }
  let outcome: RequestOutcome;
  try {
    outcome = await deps.answer(holder, input.threadId, input.requestId, input.onComputer);
  } catch (error) {
    discard();
    throw error;
  }
  if (outcome !== "allowed-once") {
    discard();
    // UX-TRUST-MOMENTS-1012 2.3.9 (F1, H08): the holder stopped waiting
    if (outcome === "unavailable") return { ok: false, status: 409, error: stoppedWaiting(input.botName), answered: outcome };
    return { ok: false, status: 409, error: "This request was answered elsewhere, so nothing was saved.", answered: outcome };
  }
  // F9: the run that raised the card ended while the answer was delivered
  if (input.live && !input.live()) {
    discard();
    return { ok: false, status: 409, error: RUN_ENDED, answered: outcome };
  }
  let value: T;
  try {
    value = input.write();
  } catch (error) {
    discard();
    return { ok: false, status: 500, error: `Allowed once. Always allow was not saved: ${reason(error)}`, answered: outcome };
  }
  discard();
  return { ok: true, value, outcome };
}
