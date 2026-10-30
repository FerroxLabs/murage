// Pending approval, ported from the upstream pattern: an approval does
// not sit in the transcript waiting to be noticed — it takes over the
// composer. The prompt is disabled, a strip above it says exactly what
// is being asked, and the send row is replaced by the decisions.
//
// Faithful details worth keeping: one at a time with an "n of N" counter,
// the detail in plain words with every argument visible (a command stays
// whole, in monospace; Show details reveals the original text), and the buttons ordered least-destructive-last so
// the primary action sits under your thumb.
import { memo, useEffect, useState } from "react";
import { useStore, useStoreIfAny, type Bot, type GrantHolders, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";
import { ApprovalDetailBody } from "@/components/ApprovalDetailBody";
import { CollapsibleText } from "@/components/CollapsibleText";
import { reviewedSkillSha256 } from "../../shared/skill-request";
import { plainApproval, plainApprovalReady, usePlainApprovalReady } from "@/lib/plain-approval";
import { delegationAction } from "../../shared/delegation-tool";
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
import { GrantFold } from "@/components/approval/GrantFold";

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

/** Open approvals on a thread, oldest first — answered/dismissed drop out. */
export function pendingApprovals(messages: Message[]): Pending[] {
  return messages
    // a publish card carries its own Publish / Not now buttons and is never answered by voice or from the composer
    // a limit offer card is a choice of engine, never a permission (1.0.4 SL-I I5)
    .filter((m) => m.kind === "options" && m.card?.kind !== "publish" && m.card?.kind !== "email-send" && m.card?.kind !== "email-trust-offer" && m.card?.tool !== "murage_limit_offer" && m.card?.requestId && m.card.tool && !m.card.answered && !m.card.dismissed)
    .map((m) => ({
      message: m,
      requestId: m.card!.requestId!,
      tool: m.card!.tool!,
      allowKey: m.card!.allowKey,
      exactAllowKey: m.card!.exactAllowKey,
      detail: m.card!.subtitle,
      held: m.card!.held,
    }));
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
  count,
  index,
}: {
  pending: Pending;
  count: number;
  index: number;
}) {
  usePlainApprovalReady();
  return (
    <div
      role="region"
      aria-label={isSkillApproval(pending) ? "Pending skill confirmation" : isRoutineApproval(pending) ? "Pending routine confirmation" : "Pending approval"}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-1 pt-3"
    >
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <span className="text-[11px] uppercase tracking-[0.18em] text-ink-secondary">Pending approval</span>
        {count > 1 && (
          <span className="rounded-full bg-control px-1.5 py-0.5 text-[11px] tabular-nums text-ink-secondary">
            {index + 1} of {count}
          </span>
        )}
        <span className="text-[13px] text-ink">{approvalLabel(pending)}</span>
        {!(plainApproval(pending.tool, pending.detail) && !isSkillApproval(pending) && !isRoutineApproval(pending)) && <span className="font-mono text-[11px] text-ink-secondary">
          {isSkillApproval(pending)
            ? pending.message.card?.skillRequest?.action === "update" ? "update_skill" : "stage_skill"
            : isRoutineApproval(pending)
            ? pending.message.card?.routineRequest?.kind === "webhook"
              ? pending.message.card.routineRequest.operation.action === "create" ? "create_webhook" : "manage_webhook"
              : pending.message.card?.routineRequest?.operation.action === "create"
              ? "schedule_routine"
              : "manage_routine"
            : pending.tool}
        </span>}
      </div>
      {/* every argument stays visible; long commands wrap and scroll */}
      <ApprovalDetailBody
        tool={isSkillApproval(pending) || isRoutineApproval(pending) ? undefined : pending.tool}
        detail={pending.detail}
        label={isSkillApproval(pending) ? "Skill details to review" : isRoutineApproval(pending) ? "Routine details to review" : "Approval details to review"}
        preClassName="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink"
      />
      {pending.message.card?.skillRequest && (
        <SkillRequestPreview request={pending.message.card.skillRequest} />
      )}
      <PendingGrantRows pending={pending} />
      {pending.held && <CollapsibleText text={pending.held} className="mt-2 text-[12px] text-warning" />}
      {!pending.held && needsRoutineReview(pending) && <p className="mt-2 text-[12px] text-warning">This older routine request needs a fresh review. Cancel it and ask the bot to propose it again.</p>}
    </div>
  );
});

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
  const desktop = useDesktopSurface();
  // bot-level "Always" is the computer's alone (a Cloud home's phone is the desktop surface, not the computer)
  const computer = computerHere(desktop);
  const isRoutineRequest = isRoutineApproval(pending);
  const isSkillRequest = isSkillApproval(pending);
  const hostConsent = isHostConsentApproval(pending);
  const eventLimit = isEventLimitApproval(pending);
  const durableRequest = isRoutineRequest || isSkillRequest;
  const special = durableRequest || hostConsent || eventLimit;
  const card = pending.message.card;
  const reviewedSha256 = card?.skillRequest
    ? reviewedSkillSha256(card.skillRequest)
    : undefined;
  const surface = approvalSurface(desktop, inNativeShell());
  const refused = useComputerOnlyRefusal(threadId, pending.requestId);
  const computerOnly = allowNeedsComputer(surface, card, refused);
  const offer = card?.grantRequest?.routine;
  // 1.2: the rows the server would save; the desktop app and the paired phone
  // app give them (a browser pairing writes no grant), and bot rows need the bot
  const owner = desktop === true || surface === "app";
  const rows = special || !owner || !bot || computerOnly ? [] : cardFoldRows(card);
  const verb = special ? undefined : cardVerb(card);
  const verbLabel = verb ? verbWord(verb) : "";
  const why = special ? undefined : whyLine(card);
  // Rule 81c: each recipient is its own choice, unticked until the owner ticks it
  const [stopKeys, setStopKeys] = useState<string[]>([]);
  const [foldOpen, setFoldOpen] = useState(false);
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
  const phoneSheet = desktop !== true;
  const foldId = `grant-fold-${pending.requestId}`;
  const level = bot ? levelName(permissionModeOf(bot)) : "";
  const primaryLabel = isSkillRequest
    ? card?.skillRequest?.action === "update" ? "Update" : "Enable"
    : isRoutineRequest ? "Confirm" : hostConsent ? "Allow for this bot" : eventLimit ? "Allow" : verbLabel;
  const denyLabel = isRoutineRequest || isSkillRequest ? "Cancel" : hostConsent ? "Don't allow" : eventLimit ? "Not now" : dontWord(verb ?? "allow");
  return (
    <div role="group" aria-label="Approval" className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-4 pb-3 pt-1" aria-busy={feedback.busy !== null}>
      {!durableRequest && (
        <button onClick={onCancelTurn} className={cn(base, PRESSED, "mr-auto text-ink-secondary hover:bg-control hover:text-ink")}>
          Cancel turn
        </button>
      )}
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
      <button
        onClick={() => decide("deny", "deny")}
        {...btn("deny", cn(base, "border border-danger/40 text-danger hover:bg-danger/10"))}
      >
        <ApprovalBusyLabel busy={feedback.busy === "deny"}>{denyLabel}</ApprovalBusyLabel>
      </button>
      {!computerOnly && (
        <span className="inline-flex items-stretch" data-approval-primary>
          <button
            onClick={() => decide("allow", "allow")}
            disabled={(isSkillRequest && !reviewedSha256) || needsRoutineReview(pending)}
            {...btn("allow", cn(base, "bg-accent font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40", hasFold && !phoneSheet && "rounded-r-none"))}
          >
            <ApprovalBusyLabel busy={feedback.busy === "allow"}>{primaryLabel}</ApprovalBusyLabel>
          </button>
          {hasFold && !phoneSheet && (
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
      {hasFold && phoneSheet && (
        <button type="button" data-fold-link onClick={() => setFoldOpen(true)} className={cn(base, "w-full justify-end rounded-md px-1 text-[13px] text-accent underline-offset-2 hover:underline")}>
          {t("ux.l1.card.foldLink", { verb: verbLabel })}
        </button>
      )}
      {hasFold && foldOpen && (
        <GrantFold
          id={foldId}
          rows={rows}
          bot={bot?.name ?? ""}
          level={level}
          verb={verbLabel}
          desktop={computer === true}
          variant={phoneSheet ? "sheet" : "menu"}
          busy={feedback.busy}
          onClose={() => setFoldOpen(false)}
          onChoose={(row) => { decide(row.id, "allow", row); }}
          below={(row) => row.scope === "routine" && offer ? (
            <RoutineGrantChoice
              offer={offer}
              rows={card?.grantRequest?.rows ?? []}
              chosen={stopKeys}
              onToggle={(stop, on) => setStopKeys((prev) => (on ? [...new Set([...prev, stop])] : prev.filter((held) => held !== stop)))}
            />
          ) : null}
        />
      )}
      {why && (
        <p data-why-line className="w-full text-[12.5px] text-ink-secondary">
          {why}
          {hasFold && (
            <>
              {" "}
              <button type="button" data-stop-asking onClick={() => setFoldOpen(true)} className="inline-flex min-h-11 items-center text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                {t("ux.l1.card.stopAsking")}
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}
