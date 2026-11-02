// Pending approval, ported from the upstream pattern: an approval does
// not sit in the transcript waiting to be noticed — it takes over the
// composer. The prompt is disabled, a strip above it says exactly what
// is being asked, and the send row is replaced by the decisions.
//
// Faithful details worth keeping: one at a time with an "n of N" counter,
// the detail in plain words with every argument visible (a command stays
// whole, in monospace; Show details reveals the original text), and the buttons ordered least-destructive-last so
// the primary action sits under your thumb.
import { memo, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useStore, useStoreIfAny, type Bot, type GrantHolders, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";
import { ApprovalDetailBody } from "@/components/ApprovalDetailBody";
import { CollapsibleText } from "@/components/CollapsibleText";
import { reviewedSkillSha256 } from "../../shared/skill-request";
import { plainApproval, plainApprovalReady, usePlainApprovalReady } from "@/lib/plain-approval";
import { delegationAction, delegationToolKind } from "../../shared/delegation-tool";
import { canonicalConnectedAppToolName } from "../../shared/connected-app-names";
import { actionGrantWords } from "../../shared/app-action-words";
import { useDesktopSurface } from "@/lib/use-surface";
import { computerHere } from "@/lib/computer-surface";
import { inNativeShell } from "@/lib/native-shell";
import { allowNeedsComputer, approvalSurface, useComputerOnlyRefusal, type ApprovalSurface } from "@/lib/approval-surface";
import { ComputerOnlyNotice } from "@/components/ComputerOnlyNotice";
import { useDecisionFeedback, type DecisionHooks } from "@/lib/approval-feedback";
import { ApprovalBusyLabel, ApprovalConfirmLine, PRESSED, approvalButton } from "@/components/ApprovalFeedback";
import { requestsWaiting, type QueueStatus } from "@/lib/approval-queue";
import { GrantRequestRows, RoutineGrantChoice } from "@/components/RoutineGrantParts";
import { noteRoutineSaved } from "@/lib/routine-grant-saved";
import { routineChoiceElsewhereWords, spokenGrantRows } from "@/lib/routine-grant-words";
import { ChevronDown } from "lucide-react";
import type { LocaleKey } from "@/locales";
import type { FoldScope } from "../../shared/fold-scopes";
import { cardFoldRows, cardVerb, dontWord, foldRowWords, levelName, verbWord } from "@/lib/fold-words";
import { noteGrantAdded, type AddedScope } from "@/lib/grant-added";
import { permissionModeOf } from "@/lib/permission-mode";
import { LazyBoundary, retryableLazy } from "@/components/LazyBoundary";
import { useNarrowViewport } from "@/lib/media-query";
import { APPROVAL_PANEL_ATTR, APPROVAL_PANEL_REQUEST_ATTR, inertOutside, onOpenGrantFold, openGrantFold, type InertNode } from "@/lib/approval-focus";
import { useFocusTrap } from "@/lib/focus-trap";
import { BOX_FRAME, BoxBody, BoxFoot, BoxHead } from "@/components/ui/BoxShell";
import { X } from "lucide-react";

// Opens from the caret beside the verb, so it stays off the first paint.
const GrantFoldChunk = retryableLazy(() => import("@/components/approval/GrantFold").then((module) => ({ default: module.GrantFold })));

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

function needsRoutineReview(pending: Pending): boolean {
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

/** The phone's bottom bar (and a narrow window): title, one line, Details, the
 * buttons. The command, the plain lines and the fold rows open in one sheet. */
export function useApprovalBar(): boolean {
  const narrow = useNarrowViewport();
  return narrow || inNativeShell();
}

/** The fold rows this surface may offer for a card, and what decided them. */
function useFoldRows(pending: Pending, threadId: string, bot: Bot | undefined) {
  const desktop = useDesktopSurface();
  const surface = approvalSurface(desktop, inNativeShell());
  const refused = useComputerOnlyRefusal(threadId, pending.requestId);
  const card = pending.message.card;
  const computerOnly = allowNeedsComputer(surface, card, refused);
  const special = isSpecialApproval(pending);
  // 1.2: the rows the server would save; the desktop app and the paired phone
  // app give them (a browser pairing writes no grant), and bot rows need the bot
  const owner = desktop === true || surface === "app";
  const rows = special || !owner || !bot || computerOnly ? [] : cardFoldRows(card);
  return { desktop, surface, computerOnly, owner, rows, special };
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

export const PendingApprovalPanel = memo(function PendingApprovalPanel({
  pending,
  who,
  bot,
  threadId,
}: {
  pending: Pending;
  /** the queue's list says "n of N"; kept so older callers still type */
  count?: number;
  index?: number;
  /** who asked, for the one title ("Sable wants to …") */
  who?: string;
  /** the asking bot: the why-line's "Stop asking for this" needs its rows */
  bot?: Bot;
  threadId?: string;
}) {
  usePlainApprovalReady();
  const bar = useApprovalBar();
  const { rows } = useFoldRows(pending, threadId ?? "", bot);
  const { why, held } = approvalReason(pending);
  const skill = isSkillApproval(pending);
  const routine = isRoutineApproval(pending);
  // The desktop's why-line ends with the way into the fold; on the phone bar
  // the fold rows sit in the Details sheet instead.
  const stopAsking = !bar && rows.length > 0;
  return (
    <div
      role="region"
      aria-label={skill ? "Pending skill confirmation" : routine ? "Pending routine confirmation" : "Pending approval"}
      tabIndex={-1}
      {...{ [APPROVAL_PANEL_ATTR]: bar ? "bar" : "panel", [APPROVAL_PANEL_REQUEST_ATTR]: pending.requestId }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-1 pt-3 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <h2 aria-live="polite" data-approval-title className={cn("break-words font-semibold text-ink", bar ? "text-[15px] leading-snug" : "text-[15px]")}>
        {approvalTitle(pending, who)}
      </h2>
      {why && (
        <p data-why-line className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
          {why}
          {stopAsking && (
            <>
              {" "}
              <button type="button" data-stop-asking onClick={() => openGrantFold(pending.requestId)} className="inline-flex min-h-11 items-center text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                {t("ux.l1.card.stopAsking")}
              </button>
            </>
          )}
        </p>
      )}
      {held && <CollapsibleText text={held} className="mt-1 text-[12.5px] text-warning" />}
      {!held && needsRoutineReview(pending) && <p className="mt-2 text-[12px] text-warning">This older routine request needs a fresh review. Cancel it and ask the bot to propose it again.</p>}
      {!bar && (
        <>
          {/* every argument is one tap away; long commands wrap and scroll */}
          {ownWordsBody(pending, why ? pending.held : undefined) ?? (
            <ApprovalDetailBody
              tool={skill || routine ? undefined : pending.tool}
              detail={pending.detail}
              label={skill ? "Skill details to review" : routine ? "Routine details to review" : "Approval details to review"}
              preClassName="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink"
              collapsed={!skill && !routine}
              summaryKey={approvalFoldKey(pending)}
              note={why ? pending.held : undefined}
            />
          )}
          {pending.message.card?.skillRequest && (
            <SkillRequestPreview request={pending.message.card.skillRequest} />
          )}
          <PendingGrantRows pending={pending} />
        </>
      )}
    </div>
  );
});

/** The cards whose request is read in their own words, as the chat card read
 * them before APPROVAL-ONE-CARD: the one-time "use this computer" question is
 * a sentence, never a code box; a reviewed browser action keeps its text
 * (a long email body) collapsed with a real toggle (Fable H4, M9). */
function ownWordsBody(pending: Pending, note?: string): ReactNode | undefined {
  const noteLine = note ? <p data-held-note className="mt-1 whitespace-pre-wrap break-words text-[12px] text-warning">{note}</p> : null;
  if (isHostConsentApproval(pending)) {
    return <p data-approval-own-words className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{pending.detail}</p>;
  }
  if (pending.tool === "browser_extension_action") {
    return (
      <div data-approval-own-words className="mt-2 rounded-lg bg-inset px-3 py-2">
        <CollapsibleText as="pre" ariaLabel="Approval details to review" text={pending.detail} className="font-mono text-[12.5px] leading-relaxed text-ink" />
        {noteLine}
      </div>
    );
  }
  return undefined;
}

/** AMEND-13 Rule 82: every operation the card would run, in call order. The
 * routine's (or bot's) remembered keys let a new recipient say why the
 * remembered action did not cover them. */
function PendingGrantRows({ pending }: { pending: Pending }) {
  const store = useStoreIfAny();
  const card = pending.message.card;
  const rows = card?.grantRequest?.rows ?? [];
  if (!rows.length) return null;
  const routine = card?.routineId ? store?.state.routines.find((candidate) => candidate.id === card.routineId) : undefined;
  const botId = pending.message.from?.botId;
  const remembered = routine?.alwaysAllow ?? (botId ? store?.state.bots.find((candidate) => candidate.id === botId)?.alwaysAllow : undefined);
  const routineName = card?.grantRequest?.routine?.routineName ?? routine?.name;
  return <GrantRequestRows rows={rows} remembered={remembered} routineName={routineName} />;
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

/** APPROVAL-ONE-CARD, phone: the one sheet Details opens. The plain lines,
 * the command as sent, and under "{Verb}, and stop asking" the fold rows. One
 * sheet, never a sheet that opens a sheet. */
export function ApprovalDetailsSheet({
  pending,
  bot,
  fold,
  foot,
  onClose,
}: {
  pending: Pending;
  /** the asking bot's name, for the sheet's title */
  bot: string;
  /** the fold rows (GrantFold, menu variant) when the card offers any */
  fold?: ReactNode;
  /** the sheet's own answer buttons */
  foot: ReactNode;
  onClose: () => void;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  // A modal sheet holds the keyboard: Tab and Shift+Tab cycle inside it,
  // Escape closes it, and the bar behind it (its own Run) is inert until it
  // closes. Closing hands focus back to Details (the opener does that).
  useFocusTrap(dialog, true, { initialFocus: "[data-sheet-close]", onEscape: onClose, skipReturnFocus: true });
  useEffect(() => {
    const node = backdrop.current;
    if (!node) return;
    return inertOutside(node as unknown as InertNode, node.closest("[data-approval-queue]") as unknown as InertNode | null);
  }, []);
  const skill = isSkillApproval(pending);
  const routine = isRoutineApproval(pending);
  // The reason is said inside the sheet too, always: the why-line when the
  // card has one, and the held note in full (never only behind a why-line).
  const { why } = approvalReason(pending);
  const title = t("ux.l1.card.sheetTitle", { bot: bot || t("ux.l1.outcome.botFallback") });
  return (
    <div ref={backdrop} className="msg-sheet-backdrop fixed inset-0 z-40 flex items-end bg-black/30" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} data-approval-sheet className={cn(BOX_FRAME, "msg-sheet max-h-[calc(var(--vvh,100dvh)-2rem)] w-full rounded-t-2xl border-t border-hairline/60 bg-card focus:outline-none")}>
        <BoxHead className="flex items-center gap-2 px-4 pt-3">
          <h2 className="min-w-0 flex-1 text-[16px] font-semibold text-ink">{title}</h2>
          <button type="button" data-sheet-close aria-label={t("ux.l1.fold.close")} onClick={onClose} className="flex size-11 items-center justify-center rounded-full text-ink-secondary hover:bg-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
            <X size={16} aria-hidden="true" />
          </button>
        </BoxHead>
        <BoxBody className="px-4 pb-2">
          {why && <p data-why-line className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{why}</p>}
          {pending.held && <p data-held-note className="mt-1 whitespace-pre-wrap break-words text-[12.5px] text-warning">{pending.held}</p>}
          {ownWordsBody(pending) ?? (
            <ApprovalDetailBody
              tool={skill || routine ? undefined : pending.tool}
              detail={pending.detail}
              label={skill ? "Skill details to review" : routine ? "Routine details to review" : "Approval details to review"}
              preClassName="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset px-3 py-2 font-mono text-[12px] leading-relaxed text-ink"
              bare
            />
          )}
          {pending.message.card?.skillRequest && <SkillRequestPreview request={pending.message.card.skillRequest} />}
          <PendingGrantRows pending={pending} />
          {fold && <div className="mt-3">{fold}</div>}
        </BoxBody>
        <BoxFoot className="flex flex-wrap items-center justify-end gap-2 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-2">{foot}</BoxFoot>
      </div>
    </div>
  );
}

export function PendingApprovalActions({
  pending,
  threadId,
  bot,
  onCancelTurn,
  onStatus,
}: {
  pending: Pending;
  threadId: string;
  /** who asked — "always allow" is remembered against them */
  bot?: Bot;
  onCancelTurn: () => void;
  /** Rule 83b: this card's own answer state, for the queue's list */
  onStatus?: (status: QueueStatus) => void;
}) {
  const { dispatch } = useStore();
  const { desktop, surface, computerOnly, owner, rows, special } = useFoldRows(pending, threadId, bot);
  // bot-level "Always" is the computer's alone (a Cloud home's phone is the desktop surface, not the computer)
  const computer = computerHere(desktop);
  const bar = useApprovalBar();
  const isRoutineRequest = isRoutineApproval(pending);
  const isSkillRequest = isSkillApproval(pending);
  const hostConsent = isHostConsentApproval(pending);
  const eventLimit = isEventLimitApproval(pending);
  const durableRequest = isRoutineRequest || isSkillRequest;
  const card = pending.message.card;
  const reviewedSha256 = card?.skillRequest
    ? reviewedSkillSha256(card.skillRequest)
    : undefined;
  const offer = card?.grantRequest?.routine;
  const verb = special ? undefined : cardVerb(card);
  const verbLabel = verb ? verbWord(verb) : "";
  // Rule 81c: each recipient is its own choice, unticked until the owner ticks it
  const [stopKeys, setStopKeys] = useState<string[]>([]);
  const [foldOpen, setFoldOpen] = useState(false);
  // APPROVAL-ONE-CARD: the phone's Details sheet; closing it hands focus back to Details
  const [sheetOpen, setSheetOpen] = useState(false);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const closeSheet = useCallback(() => {
    setSheetOpen(false);
    setTimeout(() => detailsButton.current?.focus(), 0);
  }, []);
  const closeFold = useCallback(() => setFoldOpen(false), []);
  // the panel's why-line ends with "Stop asking for this"; it opens this card's fold
  useEffect(() => onOpenGrantFold((requestId) => { if (requestId === pending.requestId) setFoldOpen(true); }), [pending.requestId]);
  // The tapped button works and the rest are held until the answer settles.
  const feedback = useDecisionFeedback();
  // Rule 83b: an answer that failed (not a cancelled device prompt) stays on
  // this card with its retry; the next press clears it.
  const [failed, setFailed] = useState<string | null>(null);
  const status: QueueStatus = feedback.busy !== null || feedback.sent ? "sending" : failed ? "failed" : "waiting";
  useEffect(() => onStatus?.(status), [onStatus, status]);
  // A Deny and Cancel turn are never held by an Allow in flight: a Deny goes out at once and takes over the card.
  const btn = (choice: string, classes: string) => approvalButton(feedback, choice, classes, choice === "deny");
  const decide = (choice: string, behavior: "allow" | "deny", row?: FoldScope) =>
    feedback.run(choice, (hooks) => {
      setFailed(null);
      return send(behavior, row, hooks);
    }, choice === "deny" ? { preempt: true } : undefined);
  const send = (behavior: "allow" | "deny", row: FoldScope | undefined, hooks: DecisionHooks) => {
    const words = row ? foldRowWords(row, { bot: bot?.name ?? "" }) : "";
    // 1.3: the card names, and Undo removes, exactly what the server added
    const note = (scope: AddedScope, keys: string[], extra: { routineId?: string; holders?: GrantHolders } = {}) => {
      if (bot) noteGrantAdded({ threadId, requestId: pending.requestId, botId: bot.id, scope, keys, words, ...extra });
    };
    const routineId = card?.routineId;
    const routineGrant = row?.scope === "routine" && routineId
      ? offer
        ? {
            routineId,
            stopKeys: stopKeys.filter((chosen) => offer.stopKeys.some((stop) => stop.key === chosen)),
            // the line names the whole set; Undo removes only what this save added
            onSaved: (saved: string[], added: string[]) => {
              noteRoutineSaved(threadId, offer.routineName, saved);
              note("routine", added, { routineId });
            },
          }
        : card?.routineAllowKey ? { routineId, key: card.routineAllowKey, onSaved: (_saved: string[], added: string[]) => note("routine", added, { routineId }) } : undefined
      : undefined;
    const botGrant = row?.scope === "bot" && computer === true && bot
      ? { botId: bot.id, ...(row.id === "always-set" ? { keys: row.keys } : { key: row.keys[0] }), onSaved: (holders: GrantHolders) => note("bot", [], { holders }) }
      : undefined;
    const forTask = behavior === "allow" && row?.scope === "task";
    dispatch({
      type: "decideRequest",
      threadId,
      requestId: pending.requestId,
      behavior,
      message: behavior === "deny" ? "Denied by the user." : undefined,
      card: pending.message.card,
      botName: bot?.name,
      reviewedSha256: behavior === "allow" ? reviewedSha256 : undefined,
      alwaysAllow: botGrant,
      ...(routineGrant ? { alwaysAllowRoutine: routineGrant } : {}),
      // the allowance the server says this answer added (none when it was already held)
      ...(forTask ? { allowForTask: true, onTaskAdded: (added: string[]) => note("task", added) } : {}),
      // Success keeps the buttons held until the card goes; refusal, a cancelled device prompt or an error returns them.
      onDevicePrompt: hooks.devicePrompt,
      onSuccess: () => hooks.succeed(),
      onError: (error: string, code?: string) => {
        if (hooks.live() && code !== "cancelled") setFailed(code === "delivery_pending" ? "Your earlier answer is still being delivered." : error || "This answer could not be delivered. Please try again.");
        hooks.settle();
      },
    });
  };

  const base = "inline-flex min-h-11 items-center justify-center rounded-full px-3.5 py-1.5 text-[13.5px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
  const hasFold = rows.length > 0;
  // A remote surface that is not on the bar (a wide browser pairing) keeps
  // today's link and sheet; the desktop app has the caret; the bar has Details.
  const phoneSheet = desktop !== true;
  const foldId = `grant-fold-${pending.requestId}`;
  const level = bot ? levelName(permissionModeOf(bot)) : "";
  const primaryLabel = isSkillRequest
    ? card?.skillRequest?.action === "update" ? "Update" : "Enable"
    : isRoutineRequest ? "Confirm" : hostConsent ? "Allow for this bot" : eventLimit ? "Allow" : verbLabel;
  const denyLabel = isRoutineRequest || isSkillRequest ? "Cancel" : hostConsent ? "Don't allow" : eventLimit ? "Not now" : dontWord(verb ?? "allow");
  const primaryDisabled = (isSkillRequest && !reviewedSha256) || needsRoutineReview(pending);
  const cancelTurn = !durableRequest && (
    <button onClick={onCancelTurn} className={cn(base, PRESSED, "text-ink-secondary hover:bg-control hover:text-ink", !bar && "mr-auto")}>
      Cancel turn
    </button>
  );
  const denyButton = (after?: () => void) => (
    <button
      onClick={() => { decide("deny", "deny"); after?.(); }}
      {...btn("deny", cn(base, "border border-danger/40 text-danger hover:bg-danger/10"))}
    >
      <ApprovalBusyLabel busy={feedback.busy === "deny"}>{denyLabel}</ApprovalBusyLabel>
    </button>
  );
  const runButton = (after?: () => void, caret = false) => (
    <button
      onClick={() => { decide("allow", "allow"); after?.(); }}
      disabled={primaryDisabled}
      {...btn("allow", cn(base, "bg-accent font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40", caret && "rounded-r-none"))}
    >
      <ApprovalBusyLabel busy={feedback.busy === "allow"}>{primaryLabel}</ApprovalBusyLabel>
    </button>
  );
  const foldChunk = (variant: "menu" | "sheet", onClose: () => void, autoFocus = true) => (
    <LazyBoundary inline onRetry={GrantFoldChunk.retry} onDismiss={onClose}>
      <Suspense fallback={null}>
        <GrantFoldChunk.Component
          id={foldId}
          rows={rows}
          bot={bot?.name ?? ""}
          level={level}
          verb={verbLabel}
          desktop={computer === true}
          variant={variant}
          busy={feedback.busy}
          autoFocus={autoFocus}
          onClose={onClose}
          onChoose={(row) => { decide(row.id, "allow", row); if (variant === "menu" && bar) closeSheet(); }}
          below={(row) => row.scope === "routine" && offer ? (
            <RoutineGrantChoice
              offer={offer}
              rows={card?.grantRequest?.rows ?? []}
              chosen={stopKeys}
              onToggle={(stop, on) => setStopKeys((prev) => (on ? [...new Set([...prev, stop])] : prev.filter((held) => held !== stop)))}
            />
          ) : null}
        />
      </Suspense>
    </LazyBoundary>
  );
  return (
    <div role="group" aria-label="Approval" data-approval-layout={bar ? "bar" : "panel"} className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-4 pb-3 pt-1" aria-busy={feedback.busy !== null}>
      {bar ? (
        <button ref={detailsButton} type="button" data-approval-details aria-haspopup="dialog" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)} className={cn(base, PRESSED, "mr-auto px-2 text-accent hover:bg-control")}>
          {t("ux.l1.card.details")}
        </button>
      ) : cancelTurn}
      {offer && !offer.eligible && !computerOnly && (
        <RoutineGrantChoice offer={offer} rows={card?.grantRequest?.rows ?? []} chosen={stopKeys} onToggle={() => undefined} />
      )}
      {/* Rule 82a: an eligible offer this pairing cannot choose says where it is chosen */}
      {offer && offer.eligible && !owner && !computerOnly && routineChoiceElsewhereWords(surface) && (
        <p data-routine-choice="elsewhere" className="w-full text-right text-[12.5px] text-ink-secondary">{routineChoiceElsewhereWords(surface)}</p>
      )}
      {computerOnly && <ComputerOnlyNotice className="w-full text-right text-[13px] text-ink-secondary" />}
      <ApprovalConfirmLine prompting={feedback.prompting} className="w-full text-right text-[13px] text-ink-secondary" />
      {failed && <div role="alert" className="w-full text-right text-[13px] text-danger">{failed}</div>}
      {denyButton()}
      {!computerOnly && (
        <span className="inline-flex items-stretch" data-approval-primary>
          {runButton(undefined, hasFold && !phoneSheet && !bar)}
          {hasFold && !phoneSheet && !bar && (
            <button
              type="button"
              data-fold-caret
              aria-haspopup="true"
              aria-expanded={foldOpen}
              aria-controls={foldOpen ? foldId : undefined}
              aria-label={t("ux.l1.card.caret", { verb: verbLabel, bot: bot?.name ?? "" })}
              onClick={() => setFoldOpen((open) => !open)}
              className={cn(base, PRESSED, "min-w-11 rounded-l-none border-l border-white/30 bg-accent px-2 text-white hover:brightness-110")}
            >
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          )}
        </span>
      )}
      {hasFold && phoneSheet && !bar && (
        <button type="button" data-fold-link onClick={() => setFoldOpen(true)} className={cn(base, "w-full justify-end rounded-md px-1 text-[13px] text-accent underline-offset-2 hover:underline")}>
          {t("ux.l1.card.foldLink", { verb: verbLabel })}
        </button>
      )}
      {hasFold && foldOpen && !bar && foldChunk(phoneSheet ? "sheet" : "menu", closeFold)}
      {bar && sheetOpen && (
        <ApprovalDetailsSheet
          pending={pending}
          bot={bot?.name ?? ""}
          onClose={closeSheet}
          fold={hasFold ? foldChunk("menu", closeSheet, false) : undefined}
          foot={
            <>
              {cancelTurn && <span className="mr-auto">{cancelTurn}</span>}
              {denyButton(closeSheet)}
              {!computerOnly && runButton(closeSheet)}
            </>
          }
        />
      )}
    </div>
  );
}
