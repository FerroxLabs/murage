// Pending approval, ported from the upstream pattern: an approval does
// not sit in the transcript waiting to be noticed — it takes over the
// composer. The prompt is disabled, a strip above it says exactly what
// is being asked, and the send row is replaced by the decisions.
//
// Faithful details worth keeping: one at a time with an "n of N" counter,
// the detail in plain words with every argument visible (a command stays
// whole, in monospace; Show details reveals the original text), and the buttons ordered least-destructive-last so
// the primary action sits under your thumb.
//
// The panel and its buttons load with the first card that waits (the
// composer imports PendingApprovalQueue lazily). The words, titles and grant
// rules the chat card and the call screens need live in
// src/lib/pending-approval.ts and are re-exported here.
import { LayerSurface } from "@/components/LayerSurface";
import { memo, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useStore, useStoreIfAny, type Bot, type GrantHolders } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";
import { ApprovalDetailBody } from "@/components/ApprovalDetailBody";
import { CollapsibleText } from "@/components/CollapsibleText";
import { reviewedSkillSha256 } from "../../shared/skill-request";
import { usePlainApprovalReady } from "@/lib/plain-approval";
import { useDesktopSurface } from "@/lib/use-surface";
import { computerHere } from "@/lib/computer-surface";
import { inNativeShell } from "@/lib/native-shell";
import { allowNeedsComputer, approvalSurface, useComputerOnlyRefusal } from "@/lib/approval-surface";
import { ComputerOnlyNotice } from "@/components/ComputerOnlyNotice";
import { useDecisionFeedback, type DecisionHooks } from "@/lib/approval-feedback";
import { ApprovalBusyLabel, ApprovalConfirmLine, PRESSED, approvalButton } from "@/components/ApprovalFeedback";
import { type QueueStatus } from "@/lib/approval-queue";
import { GrantRequestRows, RoutineGrantChoice } from "@/components/RoutineGrantParts";
import { noteRoutineSaved } from "@/lib/routine-grant-saved";
import { routineChoiceElsewhereWords } from "@/lib/routine-grant-words";
import { ChevronDown } from "lucide-react";
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
import {
  approvalFoldKey,
  approvalReason,
  approvalTitle,
  isEventLimitApproval,
  isHostConsentApproval,
  isRoutineApproval,
  isSkillApproval,
  isSpecialApproval,
  needsRoutineReview,
  type Pending,
} from "@/lib/pending-approval";

export * from "@/lib/pending-approval";

// Opens from the caret beside the verb, so it stays off the first paint.
const GrantFoldChunk = retryableLazy(() => import("@/components/approval/GrantFold").then((module) => ({ default: module.GrantFold })));


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
  const layer = useFocusTrap(dialog, true, { name: "approval-sheet", kind: "dialog", initialFocus: "[data-sheet-close]", onEscape: onClose, skipReturnFocus: true });
  return <LayerSurface handle={layer}><div ref={backdrop} className="msg-sheet-backdrop fixed inset-0 flex items-end bg-black/30" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
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
    </div></LayerSurface>;
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
