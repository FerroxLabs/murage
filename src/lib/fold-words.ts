// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 1.1 and 1.3: the card's verb, and the fold's rows in
// words. The rows themselves come from `foldScopes` (shared/fold-scopes.ts),
// which the server's save routes call too; this only says them.
import { foldScopes, type CardClass, type FoldScope, type FoldTarget } from "../../shared/fold-scopes";
import { actionGrantWords } from "../../shared/app-action-words";
import { isCommandTool } from "../../shared/grant-tool-names";
import type { RoutineGrantOffer } from "../../shared/approval-grant-request";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export type CardVerb = "allow" | "send" | "reply" | "pay" | "delete" | "run" | "post" | "ask" | "open";

/** The card fields the fold and the verb read (a subset of the stored card). */
export interface FoldCard {
  tool?: string;
  cardClass?: CardClass;
  allowKey?: string;
  allowKeys?: string[];
  exactAllowKey?: string;
  taskAllowKey?: string;
  routineAllowKey?: string;
  routineId?: string;
  grantRequest?: { routine?: RoutineGrantOffer };
}

/** The rows this card's fold shows, read top down (empty: no caret, no link). */
export function cardFoldRows(card: FoldCard | undefined): FoldScope[] {
  if (!card) return [];
  return foldScopes(card.cardClass, {
    allowKey: card.allowKey,
    allowKeys: card.allowKeys,
    exactAllowKey: card.exactAllowKey,
    taskAllowKey: card.taskAllowKey,
    routineAllowKey: card.routineAllowKey,
    routineId: card.routineId,
    routineOffer: card.grantRequest?.routine,
  });
}

const SEND_ACTION = /^app-action:[A-Z0-9_]*_(?:SEND|SEND_EMAIL|SEND_MESSAGE|POST_MESSAGE)(?:_[A-Z0-9_]+)?$/;
const REPLY_ACTION = /^app-action:[A-Z0-9_]*REPLY/;
const OPEN_TOOL = /^(?:WebFetch|fetch|open_url|browse)$/i;
const ASK_TOOL = /^(?:ask_bot|delegate|handoff)$|__ask_bot$/i;

/** 1.1: the verb from the engine's call. Unknown is "allow" (Allow once). */
export function cardVerb(card: FoldCard | undefined): CardVerb {
  if (!card) return "allow";
  const stop = card.cardClass?.stop;
  if (stop) return stop.kind === "pay" ? "pay" : stop.kind === "delete" ? "delete" : stop.public ? "post" : "send";
  // a card from an older build: its stop key still names the kind
  const stopKey = [card.taskAllowKey, card.allowKey].find((key) => key?.startsWith("stop:"));
  if (stopKey) {
    if (stopKey.startsWith("stop:pay:")) return "pay";
    if (stopKey.startsWith("stop:delete:")) return "delete";
    if (stopKey.startsWith("stop:public:")) return "post";
    if (stopKey.startsWith("stop:message:")) return "send";
  }
  const keys = [...(card.allowKeys ?? []), card.allowKey].filter((key): key is string => Boolean(key));
  if (keys.some((key) => key.startsWith("ask_bot:"))) return "ask";
  if (keys.length === 1 && REPLY_ACTION.test(keys[0]!)) return "reply";
  if (keys.length === 1 && SEND_ACTION.test(keys[0]!)) return "send";
  const tool = card.tool ?? "";
  if (ASK_TOOL.test(tool)) return "ask";
  if (isCommandTool(tool) || tool === "execute" || card.exactAllowKey) return "run";
  if (OPEN_TOOL.test(tool)) return "open";
  return "allow";
}

export const verbWord = (verb: CardVerb) => t(`ux.l1.verb.${verb}` as LocaleKey);
export const dontWord = (verb: CardVerb) => t(`ux.l1.dont.${verb}` as LocaleKey);

/** A place a delete key names, in words. */
function placeWords(target: Extract<FoldTarget, { kind: "delete-place" }>): string {
  if (target.where === "sql") return t("ux.l1.place.database", { name: target.name });
  if (target.where === "app") return target.name === "github" ? "GitHub" : target.name.charAt(0).toUpperCase() + target.name.slice(1);
  return target.name;
}

const payeeWords = (payee: string) => payee.replace(/^[^:]+:/, "");

/** One fold row, in the words the card and Settings share (1.3). */
export function foldRowWords(row: FoldScope, ctx: { bot: string }): string {
  const target = row.target;
  if (row.scope === "task") {
    switch (target.kind) {
      case "delete-folder": return t("ux.l1.row.taskFolder", { folder: target.folder });
      case "delete-place": return t("ux.l1.row.taskPlace", { place: placeWords(target) });
      case "delete-command": return t("ux.l1.row.taskCommand");
      case "public": return t("ux.l1.row.taskPlace", { place: target.where });
      case "pay": return t("ux.l1.row.taskPayee", { payee: payeeWords(target.payee) });
      default: return t("ux.l1.row.taskCommand");
    }
  }
  switch (target.kind) {
    case "delete-folder": return t("ux.l1.row.alwaysFolder", { folder: target.folder });
    case "delete-place": return t("ux.l1.row.alwaysDeletePlace", { place: placeWords(target) });
    case "delete-command": return t("ux.l1.row.alwaysUnplaced");
    case "public": return t("ux.l1.row.alwaysPublic", { where: target.where });
    case "pay": return t("ux.l1.row.taskPayee", { payee: payeeWords(target.payee) });
    case "exact-command": return t("ux.l1.row.alwaysExact");
    case "program": return t("ux.l1.row.alwaysProgram", { program: target.program, bot: ctx.bot });
    case "native-tool": return t("ux.l1.row.alwaysTool", { tool: target.tool });
    case "app-action": return t("ux.l1.row.alwaysAction", { action: actionGrantWords(target.key) ?? target.key });
    case "action-set": return t("ux.l1.row.alwaysSet", { n: target.keys.length, list: target.keys.map((key) => actionGrantWords(key) ?? key).join(", ") });
    case "mount-tool": return t("ux.l1.row.alwaysMount", { tool: target.tool, server: target.mountId.replace(/^custom:/, "").replace(/^external:[^:]+:[0-9a-f]+:/, "") });
    case "ask-bot": return t("ux.l1.row.alwaysAskBot", { bot: target.bot });
    case "routine": return t("ux.l1.row.routine", { routine: target.routineName ?? t("ux.l1.row.thisRoutine") });
  }
}

/** The level's frozen name. */
export function levelName(mode: "ask" | "auto" | "full" | "unlimited"): string {
  return mode === "unlimited" ? "No limits" : mode === "full" ? "Full access" : mode === "auto" ? "Auto" : "Ask";
}
