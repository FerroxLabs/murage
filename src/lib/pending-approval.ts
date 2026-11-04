// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a waiting approval is and how it is said: the words, the titles, the
// spoken prompts and the grant rules, without any of the panel itself.
// The chat card, the composer and the call screens read these at first
// paint; the composer's answer panel (PendingApproval.tsx) loads with the
// first card that waits.
import type { Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { plainApproval, plainApprovalReady } from "@/lib/plain-approval";
import { delegationAction, delegationToolKind } from "../../shared/delegation-tool";
import { canonicalConnectedAppToolName } from "../../shared/connected-app-names";
import { actionGrantWords } from "../../shared/app-action-words";
import type { ApprovalSurface } from "@/lib/approval-surface";
import { requestsWaiting } from "@/lib/approval-queue";
import { spokenGrantRows } from "@/lib/routine-grant-words";
import type { LocaleKey } from "@/locales";
import { cardFoldRows } from "@/lib/fold-words";

interface ApprovalLabels {
  [tool: string]: string;
}

export interface Pending {
  message: Message;
  requestId: string;
  tool: string;
  /** the narrow grant "always allow" writes, computed server-side */
  allowKey?: string;
  /** "Always allow this exact command here", computed server-side */
  exactAllowKey?: string;
  detail: string;
  held?: string;
}

/** The persisted payload is the authoritative marker. Tool names are
 * provider-authored display strings and can collide with ours. */
export function isRoutineApproval(pending: Pending): boolean {
  return Boolean(pending.message.card?.routineRequest);
}

export function isSkillApproval(pending: Pending): boolean {
  return Boolean(pending.message.card?.skillRequest);
}

/** The one-time "may this bot on Auto use this computer?" card
 * (server/host-computer-consent.ts). Its answer is remembered for the bot. */
export function isHostConsentApproval(pending: Pending): boolean {
  return pending.message.card?.tool === "local_computer_consent";
}

/** The card a bot raises when an event-started run has used up the hand-offs
 * or new bots it may do on its own (server/peer-approval.ts). It offers only
 * Allow and Not now: nothing about it can be remembered. */
export function isEventLimitApproval(pending: Pending): boolean {
  return pending.tool === "more_handoffs" || pending.tool === "more_new_bots";
}

export function needsRoutineReview(pending: Pending): boolean {
  const card = pending.message.card;
  return isRoutineApproval(pending) && !card?.answered && !/^[a-f0-9]{64}$/.test(card?.routineProposalDigest ?? "");
}

/** True for a card the composer panel answers: the same test the panel's
 * list uses, so the chat never points at a panel that is not there. */
export function isPendingApprovalMessage(m: Message): boolean {
  // a publish card carries its own Publish / Not now buttons and is never answered by voice or from the composer
  // a limit offer card is a choice of engine, never a permission (1.0.4 SL-I I5)
  return m.kind === "options" && m.card?.kind !== "publish" && m.card?.kind !== "email-send" && m.card?.kind !== "email-trust-offer" && m.card?.tool !== "murage_limit_offer" && Boolean(m.card?.requestId && m.card.tool && !m.card.answered && !m.card.dismissed);
}

/** A waiting card as the panel reads it. */
export function pendingOf(m: Message): Pending {
  return {
    message: m,
    requestId: m.card!.requestId!,
    tool: m.card!.tool!,
    allowKey: m.card!.allowKey,
    exactAllowKey: m.card!.exactAllowKey,
    detail: m.card!.subtitle,
    held: m.card!.held,
  };
}

/** Open approvals on a thread, oldest first — answered/dismissed drop out. */
export function pendingApprovals(messages: Message[]): Pending[] {
  return messages.filter(isPendingApprovalMessage).map(pendingOf);
}

/** Open questions a provider is waiting on (a request card that is not a
 * permission), oldest first. A call asks these aloud like an approval. */
export function openQuestions(messages: Message[]): Message[] {
  return messages.filter((m) => m.kind === "options" && m.card?.requestId && !m.card.tool && !m.card.answered && !m.card.dismissed);
}

/** Routine cards can carry every instruction the user asked for (up to
 * 20,000 characters). Calls should announce the concise, visible title and
 * let the user review those details on screen instead of reading them all. */
/** What a tool approval asks for, as a person would say it. Engines name
 *  the same action many ways (Grok's web search arrives as tool "other",
 *  detail "Agents_web_search"); none of those names is ever read aloud. */
export function spokenToolAction(tool: string, detail: string): string {
  if (tool === "more_handoffs") return "hand more work to other bots";
  if (tool === "more_new_bots") return "add more bots";
  const plain = plainApproval(tool, detail);
  if (plain) return plain.action;
  // Before the plain words load, only a hand-off is named from its words;
  // any other guess could sound safer than the request is.
  const known = plainApprovalReady() ? knownToolAction(tool, detail) : delegationAction(tool, detail);
  if (known) return known;
  const words = (text: string) => text.replace(/^mcp__[^_]+__/, "").replace(/^agents?_/i, "").replace(/[_-]+/g, " ").trim();
  const name = words(tool.toLowerCase() === "other" ? detail : tool).toLowerCase();
  return name && name.length <= 40 && /^[\w .]+$/.test(name) ? `use ${name}` : "use a tool";
}

/** The action in plain words when it is one Murage recognises, else null
 *  (the approval card then keeps its own generic wording). */
export function knownToolAction(tool: string, detail: string, hint?: { who?: string }): string | null {
  // A hand-off to another bot is named as one on every engine, before any
  // word of its task ("write the intro") can read as a file change.
  const delegation = delegationAction(tool, detail, hint);
  if (delegation) return delegation;
  const words = (text: string) => text.replace(/^mcp__[^_]+__/, "").replace(/^agents?_/i, "").replace(/[_-]+/g, " ").trim();
  const both = `${words(canonicalConnectedAppToolName(tool))} ${words(detail)}`.toLowerCase();
  const url = detail.match(/https?:\/\/([^/\s]+)/i)?.[1]?.replace(/^www\./, "");
  const file = detail.match(/(?:^|[\s/])([\w.-]+\.\w{1,6})\b/)?.[1];
  // connected apps and their tool search, by their internal id (any name
  // the engine was shown reads as it): heard live as "composio multi execute tool"
  if (/send voice note/.test(both)) return "send you a voice note";
  if (/composio.*(search tools|tool search)/.test(both)) return "look up which app tools to use";
  if (/composio/.test(both)) return "use your connected apps";
  // the same tools once the server has said them in plain words
  // (shared/connected-app-tools.ts)
  if (/look up which app tools to use/.test(both)) return "look up which app tools to use";
  if (/connected app/.test(both)) return "use your connected apps";
  if (/^\s*(python3?|node|ruby|perl)\s+-[ce]\b|\bscript\b/.test(`${words(detail)}`.toLowerCase()) || /\b(python3?|node) -[ce]\b/.test(detail)) {
    return "run a small script on your computer";
  }
  if (/web ?search|search tool|search the web|google/.test(both)) return "search the web";
  if (/fetch|browse|open url|web page|read url/.test(both)) return url ? `open a page on ${url}` : "open a web page";
  if (/\b(bash|shell|terminal|command|exec)\b/.test(both)) return "run a command on your computer";
  if (/\b(write|edit|patch|create file|apply)\b/.test(both)) return file ? `change ${file}` : "change a file";
  if (/\b(read|view|open file)\b/.test(both)) return file ? `read ${file}` : "read a file";
  return null;
}

/**
 * An approval, spoken on a call. On a one-to-one call the bot is the one
 * talking, so it asks in its own voice ("Can I search the web?"); in a
 * group the listener needs to know which bot is asking.
 */
export function spokenApprovalPrompt(pending: Pending, requester: string, firstPerson = false): string {
  const isRoutineRequest = isRoutineApproval(pending);
  const isSkillRequest = isSkillApproval(pending);
  if (isSkillRequest) {
    const updating = pending.message.card?.skillRequest?.action === "update";
    const title = pending.message.card?.title.trim() || (updating ? "Update this skill?" : "Enable this skill?");
    return `${requester} asks: ${title}${/[.!?]$/.test(title) ? "" : "."} Review the skill on screen. Should I ${updating ? "update" : "enable"} it?`;
  }
  if (isHostConsentApproval(pending)) {
    return `${requester} wants to use this computer: your screen, mouse and keyboard. Should I allow it for this bot from now on?`;
  }
  if (!isRoutineRequest) {
    // A13-FIX-DESIGN C5: a request whose card lists its operations is read
    // from those same words, every operation and recipient in call order
    const rows = spokenGrantRows(pending.message.card?.grantRequest?.rows ?? []);
    if (rows) return firstPerson ? `Can I do this? ${rows} Yes or no.` : `${requester} would like to do this. ${rows} Yes or no?`;
    const action = spokenToolAction(pending.tool, pending.detail);
    return firstPerson ? `Can I ${action}? Yes or no.` : `${requester} would like to ${action}. Yes or no?`;
  }
  const title = pending.message.card?.title.trim() || "Confirm this routine?";
  return `${requester} asks: ${title}${/[.!?]$/.test(title) ? "" : "."} Review the schedule and instructions on screen. Should I confirm it?`;
}

/** Said with a presented request while more than one waits (Rule 83c): the
 * owner can hear every request, or pick one, before answering any. */
export const QUEUE_OFFER = "Say next for the next request, read them to hear every request, or say a number to pick one.";
/** Said for a yes or no that does not name ONE presented request. */
export const QUEUE_WHICH = "Which request? Say its number, or say next.";
/** Said for a yes that would reach past the presented request ("yes to all"). */
export const QUEUE_ONE_AT_A_TIME = "I answer one request at a time. Say yes or no to this one, or say next.";

/** One request as a call reads it in the list (Rule 83c): who asks, for which
 * routine, and what. It asks nothing, so no yes can answer it. */
export function spokenQueueItem(pending: Pending, requester: string, routine?: string): string {
  const forRoutine = routine ? ` for the routine ${routine}` : "";
  if (isSkillApproval(pending)) {
    return `${requester} wants to ${pending.message.card?.skillRequest?.action === "update" ? "update" : "enable"} a learned skill`;
  }
  if (isHostConsentApproval(pending)) return `${requester} wants to use this computer`;
  if (isRoutineApproval(pending)) {
    const title = (pending.message.card?.title.trim() || "Confirm this routine").replace(/[.!?]+$/, "");
    return `${requester} asks: ${title}`;
  }
  const rows = spokenGrantRows(pending.message.card?.grantRequest?.rows ?? []);
  if (rows) return `${requester} would like to do this${forRoutine}. ${rows.replace(/[.]$/, "")}`;
  return `${requester} would like to ${spokenToolAction(pending.tool, pending.detail)}${forRoutine}`;
}

/** Every waiting request read aloud, numbered in the listed order, ending by
 * asking which one: reading the list answers none of them. */
export function spokenQueueList(list: readonly Pending[], nameFor: (pending: Pending) => string, routineFor?: (pending: Pending) => string | undefined): string {
  const items = list.map((pending, index) => `${index + 1}: ${spokenQueueItem(pending, nameFor(pending), routineFor?.(pending))}.`);
  return `${requestsWaiting(list.length)}. ${items.join(" ")} ${QUEUE_WHICH}`;
}

/** An ACP engine — Fuigo, the one the included Chief of Staff runs on —
 * does not send a tool NAME with `session/request_permission`. It sends the
 * permission KIND, and the driver forwards that kind in place of a tool name
 * (server/drivers/acp/core.ts, `kind === "execute" ? "shell" : …`). These are
 * the ACP kinds, spelled as the sentence they belong to; without them the
 * first approval a new person ever sees read "Business Planner wants to
 * other". The raw name the engine asked about is still in the card body. */
const ACP_KIND_LABEL: ApprovalLabels = {
  read: "read a file",
  edit: "edit a file",
  delete: "delete a file",
  move: "move a file",
  search: "search",
  fetch: "fetch a web page",
  execute: "run a command",
  shell: "run a command",
  think: "think it through",
  switch_mode: "change its mode",
  other: "use a tool",
};

/** True for a bare ACP permission kind. A kind is not a tool name, so it is
 * never shown in the monospace badge beside the sentence. */
export function isAcpPermissionKind(tool?: string): boolean {
  return Boolean(tool) && Object.hasOwn(ACP_KIND_LABEL, tool!);
}

/** The tool's own name is noise to a human: mcp__muragebox__computer_batch is
 * "computer batch", Bash is "run a command". */
export function toolLabel(tool?: string): string {
  if (!tool) return "an action";
  const bare = tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
  const nice: ApprovalLabels = {
    Bash: "run a command",
    Read: "read a file",
    Write: "write a file",
    Edit: "edit a file",
    WebFetch: "fetch a web page",
    WebSearch: "search the web",
    schedule_routine: "schedule a routine",
    manage_routine: "change a routine",
    create_webhook: "create a webhook",
    manage_webhook: "change a webhook",
    stage_skill: "enable a learned skill",
    update_skill: "update a learned skill",
  };
  return nice[tool] ?? ACP_KIND_LABEL[tool] ?? bare;
}

/** A routine, skill, computer-use or limit card: its own words and buttons, no fold, no why-line. */
export function isSpecialApproval(pending: Pending): boolean {
  return isRoutineApproval(pending) || isSkillApproval(pending) || isHostConsentApproval(pending) || isEventLimitApproval(pending);
}

/** The action an engine request asks for, in the words the chat card uses. */
export function approvalAction(pending: Pending): string {
  const card = pending.message.card;
  const tool = pending.tool;
  const detail = pending.detail ?? "";
  // A hand-off reads as one ("ask Draft Partner to draft the intro") on every
  // engine; a peer card's own title names the teammate ("... @Draft Partner").
  const delegation = Boolean(tool) && delegationToolKind(tool, detail) !== null;
  const peer = delegation ? card?.title?.match(/ @([^@]{1,40})$/)?.[1] : undefined;
  const plain = tool !== "browser_extension_action" ? plainApproval(tool, detail) : undefined;
  return (delegation && knownToolAction(tool || "other", detail, peer ? { who: peer } : undefined))
    || plain?.action
    || (plainApprovalReady() && tool === "other" && knownToolAction("other", detail))
    || toolLabel(tool);
}

/** APPROVAL-ONE-CARD: the card's one title, said once. The panel shows it and
 * the chat row's Answer button names it. Routine, skill, computer-use and
 * limit cards keep their own titles. */
export function approvalTitle(pending: Pending, who?: string): string {
  if (isSpecialApproval(pending)) return approvalLabel(pending);
  const card = pending.message.card;
  if (card?.tool === "browser_extension_action" && card.title) return card.title;
  const action = approvalAction(pending);
  return who ? `${who} wants to ${action}` : `Wants to ${action}`;
}

/** The one reason sentence: the why-line when the card has one, else the
 * held note. Never both (APPROVAL-ONE-CARD 1.2). */
export function approvalReason(pending: Pending): { why?: string; held?: string } {
  const why = isSpecialApproval(pending) ? undefined : whyLine(pending.message.card);
  if (why) return { why };
  return pending.held ? { held: pending.held } : {};
}

const COMMAND_TOOLS = /^(?:bash|shell|execute|exec_command|run_command|computer_exec|terminal|powershell|pwsh)$/i;

/** "Show command" for a command, "Show details" for anything else. */
export function approvalFoldKey(pending: Pending): LocaleKey {
  return !isSpecialApproval(pending) && COMMAND_TOOLS.test(pending.tool) ? "ux.l1.card.showCommand" : "approval.showDetails";
}

/** What a card asks, in the panel's own words; the queue lists it by these. */
export function approvalLabel(pending: Pending): string {
  if (isSkillApproval(pending)) {
    return pending.message.card?.skillRequest?.action === "update"
      ? "Update this learned skill"
      : "Enable this learned skill";
  }
  if (isRoutineApproval(pending)) {
    const request = pending.message.card?.routineRequest;
    if (request?.kind === "webhook") return t(request.operation.action === "create" ? "automations.confirmWebhook" : "automations.confirmWebhookChange");
    return request?.operation.action === "create"
      ? "Confirm this routine"
      : "Confirm this routine change";
  }
  if (isHostConsentApproval(pending)) return pending.message.card?.title || "Use this computer?";
  if (isEventLimitApproval(pending)) return pending.tool === "more_new_bots" ? "More new bots?" : "More hand-offs?";
  const plain = plainApproval(pending.tool, pending.detail);
  if (plain) return `Wants to ${plain.action}`;
  const nice: ApprovalLabels = {
    Bash: "Command approval requested",
    shell: "Command approval requested",
    Read: "File-read approval requested",
    Write: "File-change approval requested",
    Edit: "File-change approval requested",
    edit: "File-change approval requested",
  };
  return nice[pending.tool] ?? "Approval requested";
}

/** Which grants a card offers besides the verb and Deny, decided from the
 * fold rows `foldScopes` returns for what the SERVER put on the card (its
 * class and keys), so a client can never offer a wider grant than the one
 * the save route would record (UX-TRUST-MOMENTS-1012 1.2). */
export function approvalGrants(pending: Pending, opts: { desktop: boolean | undefined; hasBot: boolean; surface?: ApprovalSurface }): { always: boolean; exact: boolean; forTask: boolean; forRoutine: boolean } {
  const durable = isRoutineApproval(pending) || isSkillApproval(pending);
  if (durable || isHostConsentApproval(pending) || isEventLimitApproval(pending)) return { always: false, exact: false, forTask: false, forRoutine: false };
  const card = pending.message.card;
  const rows = cardFoldRows(card);
  // Rule 81d: the owner's computer or the paired phone app; the server runs
  // the same checks for both, and a browser pairing writes no grant.
  const owner = opts.desktop === true || opts.surface === "app";
  return {
    forRoutine: owner && Boolean(card?.routineId) && rows.some((row) => row.scope === "routine"),
    always: opts.desktop === true && opts.hasBot && rows.some((row) => row.id === "always" || row.id === "always-set"),
    exact: opts.desktop === true && opts.hasBot && rows.some((row) => row.id === "always-exact"),
    forTask: opts.hasBot && rows.some((row) => row.scope === "task"),
  };
}

const PROGRAM_GRANT = /^(?:bash|shell|execute|exec_command|run_command|computer_exec|terminal|powershell|pwsh):([^:\s]+)$/i;

/** The per-program grant, naming what it covers (the voice and older lists
 * read it; the card's fold words its rows with `foldRowWords`). */
export function alwaysAllowLabel(pending: Pending): string {
  // Rule 82a: a several-action card's remembered choice means ALL displayed actions
  const set = pending.message.card?.allowKeys;
  if (set && set.length > 1) return `Always allow these ${set.length} actions: ${set.map((key) => actionGrantWords(key) ?? key).join(", ")}`;
  const program = pending.allowKey?.startsWith(`${pending.tool}:`) ? PROGRAM_GRANT.exec(pending.allowKey)?.[1] : undefined;
  if (program) return `Always allow any ${program} command`;
  // a connected-app grant covers the one action shown: say which
  const action = pending.allowKey ? actionGrantWords(pending.allowKey) : undefined;
  return action ? `Always allow ${action}` : "Always allow";
}

/** 1.4: the server's why-line, in words; absent when the class has none. */
export function whyLine(card: Message["card"] | undefined): string | undefined {
  const why = card?.why;
  if (!why || typeof why.key !== "string" || !why.key.startsWith("ux.l1.why.")) return undefined;
  // a key this build does not know (a newer server) shows no line rather than a raw key
  let text: string | undefined;
  try { text = t(why.key as LocaleKey, why.params ?? {}); } catch { return undefined; }
  return typeof text === "string" && text !== why.key ? text : undefined;
}
