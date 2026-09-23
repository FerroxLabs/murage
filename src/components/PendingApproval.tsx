// Pending approval, ported from the upstream pattern: an approval does
// not sit in the transcript waiting to be noticed — it takes over the
// composer. The prompt is disabled, a strip above it says exactly what
// is being asked, and the send row is replaced by the decisions.
//
// Faithful details worth keeping: one at a time with an "n of N" counter,
// the detail printed raw in a monospace block that is NEVER truncated
// (it scrolls instead), and the buttons ordered least-destructive-last so
// the primary action sits under your thumb.
import { memo } from "react";
import { useStore, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";
import { reviewedSkillSha256 } from "../../shared/skill-request";
import { useDesktopSurface } from "@/lib/use-surface";

interface ApprovalLabels {
  [tool: string]: string;
}

export interface Pending {
  message: Message;
  requestId: string;
  tool: string;
  /** the narrow grant "always allow" writes, computed server-side */
  allowKey?: string;
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

function needsRoutineReview(pending: Pending): boolean {
  const card = pending.message.card;
  return isRoutineApproval(pending) && !card?.answered && !/^[a-f0-9]{64}$/.test(card?.routineProposalDigest ?? "");
}

/** Open approvals on a thread, oldest first — answered/dismissed drop out. */
export function pendingApprovals(messages: Message[]): Pending[] {
  return messages
    .filter((m) => m.kind === "options" && m.card?.requestId && m.card.tool && !m.card.answered && !m.card.dismissed)
    .map((m) => ({
      message: m,
      requestId: m.card!.requestId!,
      tool: m.card!.tool!,
      allowKey: m.card!.allowKey,
      detail: m.card!.subtitle,
      held: m.card!.held,
    }));
}

/** Routine cards can carry every instruction the user asked for (up to
 * 20,000 characters). Calls should announce the concise, visible title and
 * let the user review those details on screen instead of reading them all. */
/** What a tool approval asks for, as a person would say it. Engines name
 *  the same action many ways (Grok's web search arrives as tool "other",
 *  detail "Agents_web_search"); none of those names is ever read aloud. */
export function spokenToolAction(tool: string, detail: string): string {
  const words = (text: string) => text.replace(/^mcp__[^_]+__/, "").replace(/^agents?_/i, "").replace(/[_-]+/g, " ").trim();
  const both = `${words(tool)} ${words(detail)}`.toLowerCase();
  const url = detail.match(/https?:\/\/([^/\s]+)/i)?.[1]?.replace(/^www\./, "");
  const file = detail.match(/(?:^|[\s/])([\w.-]+\.\w{1,6})\b/)?.[1];
  // connected apps (Composio) and its tool search: heard live as
  // "composio multi execute tool"
  if (/send voice note/.test(both)) return "send you a voice note";
  if (/composio.*(search tools|tool search)/.test(both)) return "look up which app tools to use";
  if (/composio/.test(both)) return "use your connected apps";
  if (/^\s*(python3?|node|ruby|perl)\s+-[ce]\b|\bscript\b/.test(`${words(detail)}`.toLowerCase()) || /\b(python3?|node) -[ce]\b/.test(detail)) {
    return "run a small script on your computer";
  }
  if (/web ?search|search tool|search the web|google/.test(both)) return "search the web";
  if (/fetch|browse|open url|web page|read url/.test(both)) return url ? `open a page on ${url}` : "open a web page";
  if (/\b(bash|shell|terminal|command|exec)\b/.test(both)) return "run a command on your computer";
  if (/\b(write|edit|patch|create file|apply)\b/.test(both)) return file ? `change ${file}` : "change a file";
  if (/\b(read|view|open file)\b/.test(both)) return file ? `read ${file}` : "read a file";
  const name = words(tool.toLowerCase() === "other" ? detail : tool).toLowerCase();
  return name && name.length <= 40 && /^[\w .]+$/.test(name) ? `use ${name}` : "use a tool";
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
    const action = spokenToolAction(pending.tool, pending.detail);
    return firstPerson ? `Can I ${action}? Yes or no.` : `${requester} would like to ${action}. Yes or no?`;
  }
  const title = pending.message.card?.title.trim() || "Confirm this routine?";
  return `${requester} asks: ${title}${/[.!?]$/.test(title) ? "" : "."} Review the schedule and instructions on screen. Should I confirm it?`;
}

function label(pending: Pending): string {
  if (isSkillApproval(pending)) {
    return pending.message.card?.skillRequest?.action === "update"
      ? "Update this learned skill"
      : "Enable this learned skill";
  }
  if (isRoutineApproval(pending)) {
    return pending.message.card?.routineRequest?.operation.action === "create"
      ? "Confirm this routine"
      : "Confirm this routine change";
  }
  if (isHostConsentApproval(pending)) return pending.message.card?.title || "Use this computer?";
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
  return (
    <div
      role="region"
      aria-label={isSkillApproval(pending) ? "Pending skill confirmation" : isRoutineApproval(pending) ? "Pending routine confirmation" : "Pending approval"}
      className="rounded-t-2xl border-b border-hairline/50 bg-control/40 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <span className="text-[11px] uppercase tracking-[0.18em] text-ink-secondary">Pending approval</span>
        {count > 1 && (
          <span className="rounded-full bg-control px-1.5 py-0.5 text-[11px] tabular-nums text-ink-secondary">
            {index + 1} of {count}
          </span>
        )}
        <span className="text-[13px] text-ink">{label(pending)}</span>
        <span className="font-mono text-[11px] text-ink-secondary">
          {isSkillApproval(pending)
            ? pending.message.card?.skillRequest?.action === "update" ? "update_skill" : "stage_skill"
            : isRoutineApproval(pending)
            ? pending.message.card?.routineRequest?.operation.action === "create"
              ? "schedule_routine"
              : "manage_routine"
            : pending.tool}
        </span>
      </div>
      {/* never truncated — long commands wrap and scroll */}
      <pre
        tabIndex={0}
        aria-label={isSkillApproval(pending) ? "Skill details to review" : isRoutineApproval(pending) ? "Routine details to review" : "Approval details to review"}
        className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink"
      >
        {pending.detail}
      </pre>
      {pending.message.card?.skillRequest && (
        <SkillRequestPreview request={pending.message.card.skillRequest} />
      )}
      {pending.held && <div className="mt-2 text-[12px] text-warning">{pending.held}</div>}
      {!pending.held && needsRoutineReview(pending) && <p className="mt-2 text-[12px] text-warning">This older routine request needs a fresh review. Cancel it and ask the bot to propose it again.</p>}
    </div>
  );
});

export function PendingApprovalActions({
  pending,
  threadId,
  bot,
  onCancelTurn,
}: {
  pending: Pending;
  threadId: string;
  /** who asked — "always allow" is remembered against them */
  bot?: Bot;
  onCancelTurn: () => void;
}) {
  const { dispatch } = useStore();
  const desktop = useDesktopSurface();
  const isRoutineRequest = isRoutineApproval(pending);
  const isSkillRequest = isSkillApproval(pending);
  const hostConsent = isHostConsentApproval(pending);
  const durableRequest = isRoutineRequest || isSkillRequest;
  const reviewedSha256 = pending.message.card?.skillRequest
    ? reviewedSkillSha256(pending.message.card.skillRequest)
    : undefined;
  const decide = (behavior: "allow" | "deny", always = false) =>
    dispatch({
      type: "decideRequest",
      threadId,
      requestId: pending.requestId,
      behavior,
      message: behavior === "deny" ? "Denied by the user." : undefined,
      reviewedSha256: behavior === "allow" ? reviewedSha256 : undefined,
      alwaysAllow: desktop === true && always && bot && pending.allowKey ? { botId: bot.id, key: pending.allowKey } : undefined,
    });

  const base = "rounded-full px-3.5 py-1.5 text-[13.5px] transition-colors";
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 px-2 py-2">
      {!durableRequest && (
        <button onClick={onCancelTurn} className={cn(base, "text-ink-secondary hover:bg-control hover:text-ink")}>
          Cancel turn
        </button>
      )}
      <button
        onClick={() => decide("deny")}
        className={cn(base, "border border-danger/40 text-danger hover:bg-danger/10")}
      >
        {isRoutineRequest ? "Cancel" : hostConsent ? "Don't allow" : "Deny"}
      </button>
      {desktop === true && !durableRequest && bot && pending.allowKey && (
        <button
          onClick={() => decide("allow", true)}
          title={`Stop asking ${bot.name} about ${pending.allowKey}`}
          className={cn(base, "border border-hairline/50 text-ink hover:bg-control")}
        >
          Always allow
        </button>
      )}
      <button
        onClick={() => decide("allow")}
        disabled={(isSkillRequest && !reviewedSha256) || needsRoutineReview(pending)}
        className={cn(
          base,
          "bg-accent font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40",
        )}
      >
        {isSkillRequest
          ? pending.message.card?.skillRequest?.action === "update" ? "Update" : "Enable"
          : isRoutineRequest ? "Confirm" : hostConsent ? "Allow for this bot" : "Allow once"}
      </button>
    </div>
  );
}
