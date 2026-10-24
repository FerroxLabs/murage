// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-I I1/I4/I5: what happens when a direct turn meets its engine's
// limit before the engine did anything. The host (index.ts) owns the side
// effects; this file holds the per-turn record, the decision and the words.
//
//   routine run              -> the routine waits (routines.ts limitWait)
//   not the owner's own turn -> fails as before
//   the owner's own turn:
//     sent by a failover resend, or the chat is already on a backup -> the plain line (one hop)
//     a backup chosen, allowed and able to run -> fail over (row, chat patch, resend)
//     otherwise                -> the plain line and the offer card

import type { ModelSelection } from "./contracts.ts";
import type { EngineBilling } from "./limit-backup.ts";
import { billingLabel } from "./limit-backup.ts";

export interface LimitTurn {
  botId: string;
  threadId: string;
  selection: ModelSelection;
  engineName: string;
  driverKind: string;
  viaGateway: boolean;
  /** every send id the turn's words came under (a drained batch has several) */
  sendIds: string[];
  sourceMessageId: string;
  sourceText: string;
  replyToId?: string;
  ownerDirect: boolean;
  routine: boolean;
  onFailover: boolean;
  /** the provider turn, once it started */
  providerTurnId?: string;
  /** the engine produced something besides plain text (reasoning, a tool, an image) in this turn */
  activity: boolean;
  /** the engine produced assistant text; a CLI that relays its refusal as text (Claude Code's api-error frame) lands here */
  textActivity?: boolean;
  /** that text, capped: a failed turn whose only text is a limit refusal is the refusal, not model activity */
  text?: string;
  /** the last runtime error the engine reported in this turn */
  errorText?: string;
  /** structured facts of that error (ACP engines relay only sanitised prose): Fuigo's error_kind, the engine's own code, a reset time */
  errorKind?: string;
  engineCode?: string;
  errorResetsAt?: number;
}

const TEXT_CAP = 1001;

/** The text a failed turn relayed counts as its refusal only when it is short and is itself a limit refusal. */
export function relayedRefusalText(turn: Pick<LimitTurn, "textActivity" | "text">, isLimit: (text: string) => boolean): string | null {
  if (!turn.textActivity) return "";
  const text = (turn.text ?? "").trim();
  return text && text.length < TEXT_CAP && isLimit(text) ? text : null;
}

/** One record per thread for the direct turn in flight. */
export class LimitTurns {
  private readonly turns = new Map<string, LimitTurn>();
  begin(turn: LimitTurn): void { this.turns.set(turn.threadId, turn); }
  get(threadId: string): LimitTurn | undefined { return this.turns.get(threadId); }
  end(threadId: string): void { this.turns.delete(threadId); }
  /** The turn settled: end its record and hand it back. Another provider turn's event leaves the record alone.
   * A routine run's record is read by the routine's own handler during the same event (synchronously), so
   * the caller settles after that: a routine turn that never hit a limit does not linger. */
  settle(threadId: string, turnId?: string): LimitTurn | undefined {
    const turn = this.turns.get(threadId);
    if (!turn || (turn.providerTurnId && turnId && turnId !== turn.providerTurnId)) return undefined;
    this.turns.delete(threadId);
    return turn;
  }
  /** Fold one engine event into the thread's record. */
  observe(event: { type: string; threadId: string; turnId?: string; streamKind?: string; itemType?: string; origin?: string; message?: string; errorKind?: unknown; engineCode?: unknown; limitResetsAt?: unknown; delta?: unknown; text?: unknown }): void {
    const turn = this.turns.get(event.threadId);
    if (!turn) return;
    if (event.type === "turn.started") { if (event.turnId && !turn.providerTurnId) turn.providerTurnId = event.turnId; return; }
    if (turn.providerTurnId && event.turnId && event.turnId !== turn.providerTurnId) return;
    if (event.type === "content.delta" && event.streamKind === "assistant_text") {
      turn.textActivity = true;
      if (typeof event.delta === "string") turn.text = `${turn.text ?? ""}${event.delta}`.slice(0, TEXT_CAP);
    } else if (event.type === "item.completed" && event.itemType === "assistant_text" && event.origin !== "murage") {
      turn.textActivity = true;
      if (typeof event.text === "string") turn.text = event.text.slice(0, TEXT_CAP);
    } else if (event.type === "content.delta" || (event.type === "item.started" && (event.itemType === "tool" || event.itemType === "reasoning") && event.origin !== "murage")
      || (event.type === "item.completed" && (event.itemType === "assistant_image" || event.itemType === "tool") && event.origin !== "murage")) turn.activity = true;
    if (event.type === "runtime.error" && typeof event.message === "string") {
      turn.errorText = event.message.slice(0, 2000);
      turn.errorKind = typeof event.errorKind === "string" ? event.errorKind : undefined;
      turn.engineCode = typeof event.engineCode === "string" ? event.engineCode : undefined;
      turn.errorResetsAt = typeof event.limitResetsAt === "number" && Number.isFinite(event.limitResetsAt) ? event.limitResetsAt : undefined;
    }
  }
}

export type LimitOutcome =
  | { kind: "none" }
  | { kind: "plain" }
  | { kind: "failover"; to: ModelSelection }
  | { kind: "card" };

export function limitOutcome(turn: LimitTurn, facts: {
  resentByFailover: boolean;
  backup?: ModelSelection;
  backupUsable: boolean;
}): LimitOutcome {
  if (turn.routine || !turn.ownerDirect) return { kind: "none" };
  if (turn.onFailover || facts.resentByFailover) return { kind: "plain" };
  if (facts.backup && facts.backupUsable) return { kind: "failover", to: facts.backup };
  return { kind: "card" };
}

export function aboutTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** The plain line: no backup, a second hop, or a refusal the owner has to wait out. */
export function plainLimitLine(engine: string, until: number): string {
  return `${engine} is at its limit until about ${aboutTime(until)}.`;
}
export function failoverLine(from: string, to: string): string {
  return `${from} hit its limit; ${to} took over until it resets`;
}
export function routineLimitLine(engine: string, until: number): string {
  return `${engine} is at its limit; this run continues after it resets (about ${aboutTime(until)})`;
}
/** The one plain line a channel sender gets when their message waits on an engine's limit: no offer, no owner data. */
export function channelLimitLine(engine: string, resetsAt: number | null): string {
  return resetsAt === null ? `${engine} is at its limit, so I will try your message again later.`
    : `${engine} is at its limit. I will pick up your message after it resets (about ${aboutTime(resetsAt)}).`;
}
export function routineLimitFailedLine(engine: string): string {
  return `${engine} is still at its limit, so this run stopped. Run it again after the limit resets.`;
}
export function waitingForLimitLabel(engine: string): string {
  return `waiting for a limit on ${engine}`;
}

// ---- the offer card (I5) -------------------------------------------------

export const LIMIT_CARD_TOOL = "murage_limit_offer";
export const LIMIT_WAIT_OPTION = "Wait";
export const LIMIT_NEXT_TIME_LABEL = "Also use it next time";
export const LIMIT_ROUTINES_LABEL = "Also for routines";

export interface LimitChoice { label: string; selection: ModelSelection; billing: EngineBilling }
export interface LimitOffer {
  sourceMessageId: string;
  /** the engine that hit its limit */
  from: ModelSelection;
  resetsAt: number | null;
  choices: LimitChoice[];
  nextTimeLabel: string;
  routinesLabel: string;
}

export function limitChoiceLabel(engine: string, billing: EngineBilling): string {
  return `${engine} (${billingLabel(billing)})`;
}

export function limitOfferCard(input: { requestId: string; engine: string; until: number; sourceMessageId: string; from: ModelSelection; resetsAt: number | null; choices: Array<{ engine: string; selection: ModelSelection; billing: EngineBilling }> }) {
  const choices: LimitChoice[] = input.choices.map(choice => ({ label: limitChoiceLabel(choice.engine, choice.billing), selection: structuredClone(choice.selection), billing: choice.billing }));
  return {
    title: `${input.engine} is at its limit until ${aboutTime(input.until)}.`,
    subtitle: choices.length
      ? "Pick an engine to answer your message now, or wait for the limit to reset."
      : "No other engine can answer right now. Your message is kept; send it again after the limit resets.",
    options: [...choices.map(choice => choice.label), LIMIT_WAIT_OPTION],
    requestId: input.requestId,
    tool: LIMIT_CARD_TOOL,
    limitOffer: { sourceMessageId: input.sourceMessageId, from: structuredClone(input.from), resetsAt: input.resetsAt, choices, nextTimeLabel: LIMIT_NEXT_TIME_LABEL, routinesLabel: LIMIT_ROUTINES_LABEL } satisfies LimitOffer,
  };
}

export type LimitCardAnswer =
  | { kind: "wait" }
  | { kind: "engine"; choice: LimitChoice; nextTime: boolean; routines: boolean };

/** Only an answer that names one of the card's engines switches; a decline, free text or a dismiss is Wait. */
export function limitCardAnswer(offer: LimitOffer, behavior: string | undefined, message: unknown, flags: { nextTime?: unknown; routines?: unknown }): LimitCardAnswer {
  if (behavior !== "answer" || typeof message !== "string") return { kind: "wait" };
  const choice = offer.choices.find(item => item.label === message);
  if (!choice) return { kind: "wait" };
  const nextTime = flags.nextTime === true;
  return { kind: "engine", choice, nextTime, routines: nextTime && flags.routines === true };
}
