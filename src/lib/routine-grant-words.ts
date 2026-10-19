// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AMEND-13 Rule 82: a pending card, its "Always allow for this routine" choice
// and the routine's remembered permissions speak in actions and places, never
// grant keys. One place for the words, so the card, the "Saved for" line and
// the routine's permission list name the same action the same way.
//
// Reading is said only for an operation on the verified read list; a draft is
// "save ... drafts", never sending; a calendar event made is "create calendar
// events". Anything else keeps the app's own action words, so a name never
// sounds lighter than the operation is.
import type { ApprovalActionRow, ApprovalGrantRequest, RoutineGrantOffer, RoutineStopOffer } from "../../shared/approval-grant-request";
import { APP_ACTION_PREFIX, APP_LOOKUPS, appAction, ownAppTool } from "../../shared/app-action-words";
import { connectedAppActionClasses } from "../../shared/connected-app-action-table";
import { isVerifiedReadTool } from "../../shared/connected-app-readonly";
import { parseExactCommandKey } from "../../shared/exact-command";

/** The app as a person says it on these cards ("read Calendar"). */
const SHORT_APP: Readonly<Record<string, string>> = {
  GOOGLECALENDAR: "Calendar", GOOGLEDRIVE: "Drive", GOOGLEDOCS: "Docs", GOOGLESHEETS: "Sheets",
};

const capitalize = (text: string) => (text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text);

/** "a, b and c": the list the card's choice names. */
export function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** One operation in plain words, lower case for use inside a sentence:
 * "read Gmail", "read Calendar", "create calendar events", "save Gmail
 * drafts", "send messages with Gmail", "find app tools". */
export function operationWords(operation: string): string {
  const slug = operation.trim().toUpperCase();
  const lookup = APP_LOOKUPS[slug];
  if (lookup) return lookup;
  const named = appAction(slug);
  if (!named) return operation;
  const toolkit = slug.split("_")[0]!;
  const app = SHORT_APP[toolkit] ?? named.app;
  if (isVerifiedReadTool(slug)) return `read ${app}`;
  const classes = connectedAppActionClasses(slug);
  const calendar = toolkit === "GOOGLECALENDAR";
  if (classes.includes("send")) return `send messages with ${named.app}`;
  if (classes.includes("delete")) return `${named.action} in ${named.app}`;
  if (classes.includes("schedule")) {
    const verb = classes.includes("change") ? "change" : "create";
    return calendar ? `${verb} calendar events` : `${verb} events in ${named.app}`;
  }
  if (classes.includes("save") && /DRAFT/.test(slug)) return classes.includes("change") ? `change ${named.app} drafts` : `save ${named.app} drafts`;
  return `${named.action} in ${named.app}`;
}

/** A row's title on the card: "Read Gmail". */
export function rowTitle(row: Pick<ApprovalActionRow, "operation" | "kind" | "action">): string {
  return capitalize(row.kind === "lookup" ? APP_LOOKUPS[row.operation.toUpperCase()] ?? row.action : operationWords(row.operation));
}

/** One operation as the card shows it AND a call reads it (A13-FIX-DESIGN
 * C5): its title, its app and account, and every recipient it names. The
 * card and the voice take these words from here, so they never differ. */
export function grantRowWords(row: Pick<ApprovalActionRow, "operation" | "kind" | "action" | "app" | "account" | "destinations">): { title: string; place: string; to: string | undefined; spoken: string } {
  const title = rowTitle(row);
  const place = `${row.app}${row.account ? `, account ${row.account}` : ""}`;
  return {
    title,
    place,
    to: row.destinations.length ? `To: ${row.destinations.join(", ")}` : undefined,
    // the row as a call reads it (C5a): the title, the place line whenever it
    // carries the account the card shows, and every recipient
    spoken: `${title}${row.account ? `, ${place}` : ""}${row.destinations.length ? `, to ${joinWords(row.destinations)}` : ""}`,
  };
}

/** Every operation of a request in call order, said aloud from the same words
 * the card shows (Rules 82, 83c): "2 actions: 1, Read Gmail. 2, Send messages
 * with Gmail, Gmail, account sean@example.com, to bob@example.com and
 * amy@example.com." Empty for no rows. */
export function spokenGrantRows(rows: readonly ApprovalActionRow[]): string {
  if (!rows.length) return "";
  const items = rows.map((row, index) => `${index + 1}, ${grantRowWords(row).spoken}.`);
  return `${rows.length === 1 ? "1 action" : `${rows.length} actions`}: ${items.join(" ")}`;
}

/** The recipient a message finding names, when it names one person. */
export function findingRecipient(finding: { kind: string; key?: string }): string | undefined {
  if (finding.kind !== "message" || !finding.key?.startsWith("stop:message:")) return undefined;
  const place = finding.key.slice("stop:message:".length);
  return place && !place.startsWith("public:") && !place.includes(",") ? place : undefined;
}

/** The plain name of one remembered key, for "Saved for" and the routine's
 * permission list (Rule 82d). */
export function grantKeyWords(key: string): string {
  if (key.startsWith(APP_ACTION_PREFIX)) return capitalize(operationWords(key.slice(APP_ACTION_PREFIX.length)));
  const lookup = ownAppTool(key);
  if (lookup !== undefined && APP_LOOKUPS[lookup] !== undefined) return capitalize(APP_LOOKUPS[lookup]!);
  const exact = parseExactCommandKey(key);
  if (exact) return `Run ${exact.command}`;
  const stop = /^stop:(delete|pay|message|public):(.+)$/.exec(key);
  if (stop) {
    const [, kind, place] = stop;
    if (kind === "message") return place!.startsWith("public:") ? `Post publicly on ${place!.slice("public:".length)}` : `Send to ${place}`;
    if (kind === "delete") return `Delete in ${place}`;
    if (kind === "pay") return `Pay ${place}`;
    return `Post publicly on ${place}`;
  }
  return key;
}

/** The lookups of 82c, said on their own line before the scope line. */
export const LOOKUP_SCOPE = "For this routine only. This does not allow the tools it finds to run.";

/** What "Always allow for this routine" remembers on this card, naming only
 * this card's own operations (Rules 82a, 82b, 82c). Undefined when the
 * choice is not offered. */
export function routineChoiceWords(offer: RoutineGrantOffer, rows: readonly ApprovalActionRow[]): { lines: string[] } | undefined {
  if (!offer.eligible) return undefined;
  const name = offer.routineName;
  if (offer.actionKeys.length && rows.length && rows.every((row) => row.kind === "lookup")) {
    return { lines: [...new Set(rows.map((row) => rowTitle(row)))].map((title) => `${title}. ${LOOKUP_SCOPE}`) };
  }
  if (offer.actionKeys.length && rows.length) {
    const actions = [...new Set(rows.map((row) => operationWords(row.operation)))];
    const lead = actions.length === 1 ? "allow this action" : "allow these actions";
    return { lines: [`On future runs of ${name}, ${lead}: ${joinWords(actions)}. Details such as dates and draft text can change. Murage checks each request and still asks before sending to anyone new.`] };
  }
  if (offer.actionKeys.length) {
    // a command card: its one exact command, in the same folder
    return { lines: [`On future runs of ${name}, allow this exact command in the same folder without asking.`] };
  }
  // a card whose choice is its findings alone
  return { lines: offer.stopKeys.map((stop) => `On future runs of ${name}, allow this again: ${stopWords(stop)}.`) };
}

function stopWords(stop: RoutineStopOffer): string {
  return stop.recipient ? `send to ${stop.recipient}` : stop.what.replace(/[.]+$/, "");
}

/** The separately named recipient (or place) part of the choice (Rules 80b,
 * 81c, 82c). */
export function alsoRememberWords(stop: RoutineStopOffer): string {
  return stop.recipient
    ? `Also remember permission to send to ${stop.recipient} for this routine.`
    : `Also remember permission for this routine: ${stop.what.replace(/[.]+$/, "")}.`;
}

/** Findings the choice can never remember: said, so the choice never reads
 * as covering the whole call on future runs (Rule 81c). */
export function notRememberedWords(items: readonly string[]): string | undefined {
  if (!items.length) return undefined;
  return `Murage still asks about this every time: ${items.map((item) => item.replace(/[.]+$/, "")).join("; ")}.`;
}

/** Whether the choice also offers its stop findings as a separate part. A
 * card whose choice IS its findings offers no separate part. */
export function separateStopChoices(offer: RoutineGrantOffer): readonly RoutineStopOffer[] {
  return offer.eligible && offer.actionKeys.length ? offer.stopKeys : [];
}

/** "Saved for [Routine name]" and what was saved (Rule 82d). */
export function savedForWords(routineName: string, keys: readonly string[]): { title: string; items: string[] } {
  return { title: `Saved for ${routineName}`, items: keys.map(grantKeyWords) };
}

/** A fresh-recipient row: who is new, and why the remembered action did not
 * cover them (Rule 82d). Undefined when the row has no new recipient, or its
 * action was not remembered. */
export function freshRecipientWords(row: ApprovalActionRow, remembered: readonly string[] | undefined, who: string): string | undefined {
  const fresh = row.findings.map(findingRecipient).filter((recipient): recipient is string => Boolean(recipient));
  if (!fresh.length || row.kind !== "action" || !remembered?.includes(`${APP_ACTION_PREFIX}${row.operation}`)) return undefined;
  const people = joinWords([...new Set(fresh)]);
  return `${people} ${fresh.length === 1 ? "is" : "are"} new. ${who} remembers permission to ${operationWords(row.operation)}, but that never covers sending to someone new, so Murage asks first.`;
}

/** The rows a card shows, or none when it carries no connected-app call. */
export function cardRows(request: ApprovalGrantRequest | undefined): readonly ApprovalActionRow[] {
  return request?.rows ?? [];
}

/** A row's arguments as text to inspect. */
export function argumentsText(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2) ?? "{}";
  } catch {
    return String(value);
  }
}

/** Rule 82a: where the routine choice is not offered, say why in plain words.
 * A browser pairing writes no grant (Rule 81d), so it is told where the
 * choice is made. Nothing where the choice is offered or the surface is not
 * known yet. */
export function routineChoiceElsewhereWords(surface: "desktop" | "app" | "browser" | "unknown"): string | undefined {
  return surface === "browser" ? "Always allow for this routine is chosen on your computer or in the Murage phone app." : undefined;
}
