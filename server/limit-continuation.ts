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
import { channelReply, channelReplyTime } from "./channels/reply-text.ts";
import { FLUX_REFUSAL_CODES, type FluxRefusalCode } from "./flux-refusal.ts";

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
  /** chips Murage itself wrote into this turn: a driver's item.completed may not repeat the origin of its item.started */
  murageItems?: Set<string>;
  /** the engine produced assistant text; a CLI that relays its refusal as text (Claude Code's api-error frame) lands here */
  textActivity?: boolean;
  /** that text, capped: a failed turn whose only text is a limit refusal is the refusal, not model activity */
  text?: string;
  /** the last runtime error the engine reported in this turn */
  errorText?: string;
  /** structured facts of that error (ACP engines relay only sanitised prose): Fuigo's error_kind, the engine's own code, a reset time */
  errorKind?: string;
  engineCode?: string;
  /** Flux's refusal code, carried structurally (server/flux-refusal.ts): the sanitised errorText may have lost it */
  gatewayCode?: FluxRefusalCode;
  /** FLUX-BURN-COPY-1018: when Flux's hourly spend gate lifts (epoch ms), only from the retry_after its body carried */
  gatewayResetsAt?: number;
  /** the HTTP status of that error, when the driver reported one structurally (providerError.httpStatus, Astra r4) */
  httpStatus?: number;
  errorResetsAt?: number;
  /** 1.0.9 X2: this turn minted a phone authority (set by markPhoneHeld right after the mint). */
  phoneHeld?: boolean;
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
  /** Marks the thread's current record as having minted a phone authority, only when it is the record of that source message. */
  markPhoneHeld(threadId: string, sourceMessageId: string): void {
    const turn = this.turns.get(threadId);
    if (turn && turn.sourceMessageId === sourceMessageId) turn.phoneHeld = true;
  }
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
  observe(event: { type: string; threadId: string; turnId?: string; streamKind?: string; itemType?: string; itemId?: string; origin?: string; message?: string; errorKind?: unknown; engineCode?: unknown; gatewayCode?: unknown; gatewayResetsAt?: unknown; providerError?: { httpStatus?: unknown } | null; limitResetsAt?: unknown; delta?: unknown; text?: unknown }): void {
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
      || (event.type === "item.completed" && (event.itemType === "assistant_image" || event.itemType === "tool") && event.origin !== "murage" && !(event.itemId && turn.murageItems?.has(event.itemId)))) turn.activity = true;
    else if (event.type === "item.started" && event.origin === "murage" && event.itemId) (turn.murageItems ??= new Set()).add(event.itemId);
    if (event.type === "runtime.error" && typeof event.message === "string") {
      turn.errorText = event.message.slice(0, 2000);
      turn.errorKind = typeof event.errorKind === "string" ? event.errorKind : undefined;
      turn.engineCode = typeof event.engineCode === "string" ? event.engineCode : undefined;
      turn.gatewayCode = typeof event.gatewayCode === "string" && FLUX_REFUSAL_CODES.has(event.gatewayCode) ? event.gatewayCode as FluxRefusalCode : undefined;
      turn.gatewayResetsAt = turn.gatewayCode === "hourly_burn_limit" && typeof event.gatewayResetsAt === "number" && Number.isFinite(event.gatewayResetsAt) ? event.gatewayResetsAt : undefined;
      const status = event.providerError?.httpStatus;
      turn.httpStatus = typeof status === "number" && Number.isInteger(status) && status >= 100 && status < 600 ? status : undefined;
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
  return channelReplyTime(at);
}

/** 1.0.18 (a Masterclass customer's card): Fuigo and Flux show a customer no usage limit. A refusal from them (Fuigo, a plan
 * sign-in through the gateway, a Flux key) is a busy moment unless the server itself sent a reset time: it records no limit
 * state, names no "until" time and shows one plain busy card. A payment refusal (402) is never busy: it keeps its own card. */
export function isGatewayEngine(turn: Pick<LimitTurn, "driverKind" | "viaGateway">, preset?: string): boolean {
  return turn.viaGateway || turn.driverKind === "fuigoAgent" || preset === "flux";
}
/** Why a gateway refusal is not a limit, read by Flux's own code words first (flux_credit_state): `credit` (402
 * credit_exhausted), `unresolved` (402 credit_unresolved), `hold` (429 while low credit is reserved by requests in flight),
 * `hourly` (429 hourly_burn_limit, Flux's hourly spend gate), `busy` (a 429 with no reset time). `null`: a limit or a payment card as before. */
export type GatewayBusyReason = "busy" | "credit" | "unresolved" | "hold" | "freeCap" | "hourly";
export const GATEWAY_HOLD = /because other requests have temporarily reserved it|x-flux-hold-reason/i;
export function gatewayBusy(turn: Pick<LimitTurn, "driverKind" | "viaGateway" | "errorText" | "gatewayCode">, facts: { preset?: string; resetsAt: number | null }): GatewayBusyReason | null {
  if (!isGatewayEngine(turn, facts.preset)) return null;
  // The structured code first: Flux puts it in error.state, a header or a Python repr the engine's sanitiser drops.
  const coded = { free_cap_reached: "freeCap", credit_exhausted: "credit", credit_unresolved: "unresolved", hourly_burn_limit: "hourly", hold: "hold" } as const;
  if (turn.gatewayCode && Object.hasOwn(coded, turn.gatewayCode)) return coded[turn.gatewayCode];
  const text = turn.errorText ?? "";
  // Flux rate_limiter.py: a free key past this month's allowance (429, state free_cap_reached). Never retried.
  if (/\bfree_cap_reached\b/i.test(text)) return "freeCap";
  if (/\bcredit_exhausted\b/i.test(text)) return "credit";
  if (/\bcredit_unresolved\b/i.test(text)) return "unresolved";
  // FLUX-BURN-COPY-1018: Flux's hourly spend gate (forge_hook.py, 429 hourly_burn_limit). Never retried.
  if (/\bhourly_burn_limit\b/i.test(text)) return "hourly";
  if (GATEWAY_HOLD.test(text)) return "hold";
  if (facts.resetsAt !== null) return null;
  return /\b402\b|payment|credits?\b|billing/i.test(text) ? null : "busy";
}
/** FLUX-BURN-COPY-1018: the one row a gateway refusal's card is put on: the turn's own error row. A person's message is
 * never that row, so it stays in the thread as sent ("Your message is kept") and Send again resends its text. */
export function isGatewayBusyRow(message: { role: string; turnId?: string; tool?: { name: string } }, providerTurnId?: string): boolean {
  return message.role === "bot" && message.tool?.name.startsWith("error:") === true && (!providerTurnId || message.turnId === providerTurnId);
}
export function gatewayBusyLine(engine: string, reason?: GatewayBusyReason): string {
  return reason === "hourly" ? "You've reached your Flux hourly limit. Your message is kept." : `${engine} is busy right now. Your message is kept.`;
}
/** The one card's facts on the turn's error row: the engine, the reason and, for the hourly gate only, the reset Flux sent. */
export interface GatewayBusyFacts { engine: string; reason: GatewayBusyReason; resetsAt?: number }
export function gatewayBusyFacts(turn: Pick<LimitTurn, "engineName" | "gatewayResetsAt">, reason: GatewayBusyReason): GatewayBusyFacts {
  const engine = turn.engineName.slice(0, 80);
  return reason === "hourly" && turn.gatewayResetsAt !== undefined ? { engine, reason, resetsAt: turn.gatewayResetsAt } : { engine, reason };
}

/** The plain line: no backup, a second hop, or a refusal the owner has to wait out. Only a reset time the engine sent names a time. */
export function plainLimitLine(engine: string, until: number, resetsAt: number | null = until): string {
  return resetsAt === null ? `${engine} is at its limit.` : `${engine} is at its limit until about ${aboutTime(until)}.`;
}
export function failoverLine(from: string, to: string): string {
  return `${from} hit its limit; ${to} took over until it resets`;
}
export function routineLimitLine(engine: string, until: number): string {
  return channelReply("channelReply.routineLimit", { engine, time: aboutTime(until) });
}
/** The one plain line a channel sender gets when their message waits on an engine's limit: no offer, no owner data. */
export function channelLimitLine(engine: string, resetsAt: number | null): string {
  return resetsAt === null ? channelReply("channelReply.limitLater", { engine })
    : channelReply("channelReply.limitUntil", { engine, time: aboutTime(resetsAt) });
}
export function routineLimitFailedLine(engine: string): string {
  return channelReply("channelReply.routineLimitStopped", { engine });
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
    title: input.resetsAt === null ? `${input.engine} is at its limit.` : `${input.engine} is at its limit until ${aboutTime(input.until)}.`,
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
