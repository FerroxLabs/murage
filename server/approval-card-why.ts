// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 1.4: the card's why-line, one sentence the server
// writes when the request opens, from the card's class, the stop finding and
// the level the card is on. The server returns a locale key and its params;
// the English lives in src/locales/en-ux/l1.json (`ux.l1.why.*`). No why-line
// names a level higher than the card's own as the way out, and none links to
// the level menu.
import type { CardClass } from "../shared/fold-scopes.ts";
import type { StopHit } from "./stop-line.ts";
import { engineSeenInFull } from "./email/external-marks.ts";
import { localEngineLabel } from "../shared/local-models.ts";

export type CardLevel = "ask" | "auto" | "full" | "unlimited";

export type WhyKey =
  | "ux.l1.why.messageNew"
  | "ux.l1.why.messageNewAsk"
  | "ux.l1.why.messageSeveral"
  | "ux.l1.why.messagePublic"
  | "ux.l1.why.deleteOutside"
  | "ux.l1.why.deleteOn"
  | "ux.l1.why.pay"
  | "ux.l1.why.payRoutine"
  | "ux.l1.why.askOwner"
  | "ux.l1.why.askRoutine"
  | "ux.l1.why.webhook"
  | "ux.l1.why.channel"
  | "ux.l1.why.channelUnnamed"
  | "ux.l1.why.unattended"
  | "ux.l1.why.alwaysAsk"
  | "ux.l1.why.unreadable"
  | "ux.l1.why.sensitiveGuard"
  | "ux.l1.why.unreadCall"
  | "ux.l1.why.destructiveGuard"
  | "ux.l1.why.promptGuard"
  | "ux.l1.why.outsideContent";

export interface CardWhy {
  key: WhyKey;
  params: Record<string, string | number>;
}

export interface WhyInput {
  cardClass: CardClass;
  stopHit?: StopHit | null;
  level: CardLevel;
  botName: string;
  /** the routine whose run raised the card, by name */
  routineName?: string;
  /** where an unattended turn came from */
  origin?: "webhook" | "channel";
  /** the channel by name (Telegram, Slack, Discord), when known */
  channel?: string;
  /** the verdict's rule (an always-ask card's reader rule: `unreadable` when the reader could not follow the text) */
  rule?: string;
}

/** The level a bot's (or a run's) flags mean. */
export function cardLevelOf(flags: { autoApprove?: boolean; fullAccess?: boolean; noLimits?: boolean } | null | undefined): CardLevel {
  if (!flags?.autoApprove) return "ask";
  if (flags.noLimits && flags.fullAccess) return "unlimited";
  return flags.fullAccess ? "full" : "auto";
}

/** The one recipient a single-person message names. */
const recipientOf = (hit: StopHit): string => hit.recipients?.[0] ?? hit.place ?? "";

/** 1.4: the why-line for this card, or undefined when the class has none. */
export function cardWhy(input: WhyInput): CardWhy | undefined {
  const { cardClass, stopHit, level } = input;
  const bot = input.botName;
  switch (cardClass.reason) {
    // NOLIMITS-WIPE-WORD B: a text the reader could not follow is not said to wipe anything; it says what is true
    case "always-ask": return { key: input.rule === "unreadable" ? "ux.l1.why.unreadable" : "ux.l1.why.alwaysAsk", params: {} };
    case "sensitive-guard": return { key: "ux.l1.why.sensitiveGuard", params: {} };
    case "unread-call": return { key: "ux.l1.why.unreadCall", params: {} };
    case "destructive-guard": return { key: "ux.l1.why.destructiveGuard", params: {} };
    case "prompt-guard": return { key: "ux.l1.why.promptGuard", params: {} };
    case "outside-turn": return { key: "ux.l1.why.outsideContent", params: {} };
    default: break;
  }
  if (cardClass.unattended || cardClass.reason === "unattended-block") {
    if (input.origin === "webhook") return { key: "ux.l1.why.webhook", params: { bot } };
    if (input.origin === "channel") return input.channel ? { key: "ux.l1.why.channel", params: { bot, channel: input.channel } } : { key: "ux.l1.why.channelUnnamed", params: { bot } };
    return { key: "ux.l1.why.unattended", params: { bot } };
  }
  if (cardClass.reason === "stop-line" && stopHit) {
    if (stopHit.kind === "pay") return cardClass.routine || cardClass.automated ? { key: "ux.l1.why.payRoutine", params: {} } : { key: "ux.l1.why.pay", params: { bot } };
    if (stopHit.kind === "delete") {
      const named = /^(?:app|sql|git):(.+)$/.exec(stopHit.place ?? "");
      return named ? { key: "ux.l1.why.deleteOn", params: { bot, place: named[1]! } } : { key: "ux.l1.why.deleteOutside", params: { bot } };
    }
    if (cardClass.stop?.public) return { key: "ux.l1.why.messagePublic", params: { bot, where: (stopHit.place ?? "").replace(/^public:/, "") } };
    if ((cardClass.stop?.places ?? 1) > 1) return { key: "ux.l1.why.messageSeveral", params: { bot, n: cardClass.stop!.places } };
    const name = recipientOf(stopHit);
    return { key: level === "ask" ? "ux.l1.why.messageNewAsk" : "ux.l1.why.messageNew", params: { bot, name } };
  }
  if (cardClass.reason === "no-grant" && level === "ask") {
    return cardClass.routine && input.routineName ? { key: "ux.l1.why.askRoutine", params: { bot, routine: input.routineName } } : { key: "ux.l1.why.askOwner", params: { bot } };
  }
  return undefined;
}

/** The engine a No limits card names: its driver and the name the owner sees for it. */
export interface OutsideEngine { driver: string; name: string }

/** NOLIMITS v1 (1.0.18, MurageMain ruling): the card No limits raises on a turn whose first mark is the V7 blanket
 *  `outside tool` of an engine Murage does not see in full carries that engine, so the page says why it still asks and
 *  offers Switch to Fuigo. Nothing on any other card: another first source, a covered engine's `outside tool` (an
 *  unseen item, an unknown tool) or another verdict. */
export function outsideEngineCard(
  verdictSource: string | undefined,
  firstMark: string | null,
  instance: { driverKind: string; displayName?: string | undefined } | null | undefined,
): { outsideEngine?: OutsideEngine } {
  if (verdictSource !== "outside-turn" || firstMark !== "outside tool" || !instance || engineSeenInFull(instance.driverKind)) return {};
  const name = instance.displayName?.trim() || localEngineLabel(instance.driverKind);
  return { outsideEngine: { driver: instance.driverKind, name } };
}
