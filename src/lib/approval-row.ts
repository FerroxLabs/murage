// SPDX-License-Identifier: AGPL-3.0-or-later
// APPROVALS-SIMPLE-1018 sections 1 and 3: what one approval row says on Needs you, Approvals and Today. The line is
// the bot's own words ("Petra wants to append today's Trustpilot check to the ops log"); the grey line is Murage's
// fact ("Runs a command · Petra · waiting since 06:39"), plus "one at a time: {reason}" for a row Approve all leaves
// out. Never the raw command: that is behind Show details.
import type { OptionCardData } from "@/state/store";
import type { InboxItem } from "../../shared/inbox";
import { bulkKindKey, type BulkKind } from "../../shared/bulk-kind";
import { isQuestionCard, questionsForCard } from "../../shared/questions";

/** A question card's whole first question, its lines joined into one wrapping line; nothing is cut. */
export function wholeQuestion(card: OptionCardData): string {
  return (questionsForCard(card)[0]?.question ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
}
import type { LocaleKey } from "../locales";
import { t } from "./i18n";

// Light on purpose: Today's rows and the rail read this file, so it pulls in no digest or device code (first paint).
export const BULK_REASON_KEYS = ["always-ask", "pay", "message", "delete", "needs-look", "held", "unattended", "truncated", "local-computer", "routine", "origin", "not-approval", "not-open", "sensitive"] as const;
export type BulkReasonKey = typeof BULK_REASON_KEYS[number];

/** The short words for each reason the server can send. An unknown key reads as "needs its own look", never as nothing. */
export function reasonLine(key: string): string {
  return (BULK_REASON_KEYS as readonly string[]).includes(key) ? t(`approveAll.reason.${key}` as LocaleKey) : t("approveAll.reason.needs-look");
}

const KINDS: readonly BulkKind[] = ["command", "edit", "app", "other"];
const kindOf = (value: unknown): BulkKind => (KINDS as readonly unknown[]).includes(value) ? value as BulkKind : "other";

/** A model-written line starts lower case after "wants to", unless its second letter is a capital (an acronym, "URL"). */
export function lowerFirst(text: string): string {
  const chars = [...text];
  if (chars.length === 0) return text;
  if (chars.length > 1 && /\p{Lu}/u.test(chars[1]!)) return text;
  return chars[0]!.toLocaleLowerCase() + chars.slice(1).join("");
}

/** One line, no full stop, at most 140 characters: the card's `wants` as the row shows it, or "" when there is none. */
export function wantsOf(card: OptionCardData | undefined | null): string {
  const raw = typeof card?.wants === "string" ? card.wants : "";
  const line = raw.split(/\r?\n/).map((part) => part.trim()).find(Boolean)?.replace(/\s+/g, " ").replace(/[.\s]+$/, "") ?? "";
  return line.length <= 140 ? line : `${line.slice(0, 139).trimEnd()}…`;
}

/** The approval's plain kind: the server's stamp on the Inbox row when there is one, else from the card's tool. */
export function rowKind(item: Pick<InboxItem, "toolKind"> | undefined, card?: OptionCardData | null): BulkKind {
  if (item?.toolKind) return kindOf(item.toolKind);
  return bulkKindKey(typeof card?.tool === "string" ? card.tool : "");
}

/** The row's line for a waiting request: "{bot} wants to {wants}" for an approval (the bot's words, else the plain
 *  kind, "run a command"), the bot's own question for a question card, "" for anything else. */
export function rowLine(card: OptionCardData | undefined | null, bot: string | undefined, question: (card: OptionCardData) => string): string {
  if (!card) return "";
  // Astra r2 High: a question row is answered beside its Yes / No, so its line is the WHOLE question (every line, never
  // cut; the row wraps), not the one-line summary: "Apply this change?\nThis deletes all archived records." must show
  // both sentences. The summary is only the fallback when the card carries no question text.
  if (isQuestionCard(card)) return wholeQuestion(card) || question(card);
  if (!card.tool) return "";
  const said = wantsOf(card);
  const wants = said ? lowerFirst(said) : t(`ux.l2b.door.wantsKind.${bulkKindKey(card.tool)}` as LocaleKey);
  return t("ux.l2b.door.wants", { bot: bot?.trim() || t("approveAll.botFallback"), wants });
}

/** Reasons a row gets no note for: it is answered, gone or not an approval, so "one at a time" would say nothing. */
const NO_NOTE = new Set(["ok", "not-open", "not-approval"]);

/** The grey line under an approval row: "{kind} · {bot} · waiting since {time}", and when Approve all is on screen
 *  and leaves this row out, " · one at a time: {reason}". */
export function rowMeta(input: { kind: BulkKind; bot?: string; time: string; bulk?: string; note: boolean }): string {
  const kind = t(`ux.l2b.door.kind.${input.kind}` as LocaleKey);
  const head = input.bot ? t("ux.l2b.door.metaKind", { kind, bot: input.bot, time: input.time }) : t("ux.l2b.door.metaKindNoBot", { kind, time: input.time });
  if (!input.note || !input.bulk || NO_NOTE.has(input.bulk)) return head;
  return `${head} · ${t("ux.l2b.door.oneAtATime", { reason: reasonLine(input.bulk) })}`;
}

/** The displayed rows Approve all would answer now: request rows the server stamped "ok", in screen order. */
export function bulkReadyRows<T extends Pick<InboxItem, "kind" | "bulk" | "link">>(items: readonly T[]): T[] {
  return items.filter((item) => item.kind === "request" && item.bulk === "ok");
}

/** A row's key for binding a press to what is on screen: its thread and message. */
export const rowKey = (link: { threadId: string; messageId: string }): string => `${link.threadId}\u0000${link.messageId}`;
