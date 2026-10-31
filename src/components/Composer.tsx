import { useSlashSkills } from "@/lib/use-slash-skills";
import { CallMeWhenDone } from "./CallMeWhenDone";
import { track } from "@/lib/analytics";
import { closedComposerLine } from "@/lib/shared-teams";
import { dictationDisabledNote, isDictationDisabled } from "@/lib/dictation-notes";
import { FOCUS_COMPOSER_EVENT } from "./useTrayIntents";
import { useDesktopSurface } from "@/lib/use-surface";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from "react";
import { ArrowUp, BookOpen, Clock, ListChecks, Mic, Paperclip, Sparkles, Square, Target, Terminal, Users, X } from "lucide-react";
import { useWarmIntent } from "@/hooks/use-warm-intent";
import { api, olderOpenCards, useStore, visibleMessages, type Bot, type Group, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { ComposerMenuRow } from "./ComposerMenuRow";
import { mentionRowDescription } from "@/lib/mentions";
import { compactPlaceholder } from "@/lib/composer-placeholder";
import { enterSends, imeComposing } from "@/lib/composer-enter";
import { currentSendKey, isMacPlatform, sendKeyName, subscribeSendKey } from "@/lib/send-key";
import { COARSE_POINTER_QUERY, useCoarsePointer, useNarrowViewport } from "@/lib/media-query";
import { newSendId } from "@/lib/send-id";
import { openIntakeCard, replyToIntake } from "@/lib/onboarding-intake";

/** Shown when a sent message could not also be recorded as the answer to the open setup question. */
export const INTAKE_NOT_RECORDED = "Your message was sent. It could not be added as your answer to the setup question. Answer it on the setup card if you want it counted.";
import {
  appendComposerDraftAttachments,
  beginDraftSend,
  forgetFailedComposerSend,
  isDraftHeld,
  readComposerDraft,
  rememberFailedComposerSend,
  releaseRecoveredSend,
  subscribeDraftHeld,
  useComposerDraft,
  useComposerChannelMode,
  useFailedComposerSends,
  watchDraftSend,
  type DraftOutboxEntry,
  type FailedComposerSend,
} from "@/lib/drafts";
import { registerComposerReferenceTarget } from "@/lib/image-reference";
import { BotAvatar } from "./Avatar";
import { ComposerAttachments, pathForFile } from "./ComposerAttachments";
import { QueuedComposerMessages } from "./ComposerQueuedMessages";
import { skillRecorderEnabled } from "@/lib/feature-flags";
import {
  composerSlashTrigger,
  goalTextFromComposer,
  replaceComposerSlashTrigger,
  type ComposerSlashCommand,
  type SlashSkill,
  skillSlashRows,
  slashSkillMatches,
} from "@/lib/composer-commands";
import { openFirstRun } from "@/lib/first-run";
import { engineCommandPick, engineCommandsNote, matchEngineCommands } from "@/lib/engine-commands-menu";
import type { EngineCommand, EngineCommandsView } from "../../shared/engine-commands";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { FullAccessWarning } from "./FullAccessWarning";
import { PERMISSION_MODES, PermissionModeIcon, PermissionModeMenu, engineCannotAsk } from "./PermissionModeMenu";
import { RefreshPermissionsButton } from "./ThreadFollowControls";
import { computerHere } from "@/lib/computer-surface";
import { fullAccessRefusalMessage, permissionModeOf, routineEffectiveMode, routineOfConversation, type PermissionMode } from "@/lib/permission-mode";
import {
  engineAcceptsImages,
  appendPastedText,
  clipboardHasImages,
  clipboardImageFiles,
  composeMessage,
  composerShouldRefocus,
  composerTakesFocusOnOpen,
  replyTargetTakesFocus,
  isLongPaste,
  noticeOffersStorage,
  pasteAttachment,
  type Attachment,
  type PasteAttachment,
} from "@/lib/composer-attachments";
import { imageAttachmentFromFile } from "@/lib/composer-image-upload";
import { ComposerImagesOverLimit } from "./ComposerImagesOverLimit";
import { composerFileIntake, composerPasteIntake } from "@/lib/composer-intake";
import { composerUploadsPending, subscribeComposerUploads } from "@/lib/composer-uploads";
import { composerSendGate } from "@/lib/composer-send-gate";
import { normalizeState } from "@/lib/mascot";
import { goalCoordinatorForComposer, groupComposerHint, roomRespondersForComposer } from "@/lib/group-routing";
import { pendingApprovals, type Pending } from "./PendingApproval";
import { PendingApprovalQueue } from "./PendingApprovalQueue";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { autoNeedsLocalComputerWarning, localAutoHostPlatform } from "@/lib/local-computer";
import { ComposerReplyStrip } from "./ReplyQuote";
import { escapeCancelsReply } from "@/lib/replies";
import { t } from "@/lib/i18n";
import { ComposerInjectNow, composerCanInjectNow } from "./ComposerInjectNow";
import { ComposerPlusMenu } from "./ComposerPlusMenu";
import { PushToTalk, browserPushToTalkFacts } from "./PushToTalk";
import {
  applyCleanupResult,
  cleanupEnabled,
  dictatedPortion,
  finishThenStop,
  requestCleanup,
  undoCleanup,
  undoOffered,
  type CleanupUndo,
} from "@/lib/dictation-cleanup";
import { AudioAttachmentIntake } from "./AudioAttachmentIntake";
import { ComposerSendNotice, type ComposerSendNoticeState } from "./ComposerSendNotice";
import { fluxBridge, readFluxStatus, saveFluxKey } from "@/lib/flux-key-paste";
import { isMessageSizeRefusal, messageIsTooLarge, messageTextBytes } from "../../shared/message-limits";
import { RoutineSavedNotice } from "./RoutineGrantParts";
import { clearRoutineSaved, useRoutineSaved } from "@/lib/routine-grant-saved";

/** The active @mention query at the caret: the text between an `@` that
 * starts a word and the caret. null = no mention being typed. */
function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null; // user@host, not a tag
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || query.includes("\n")) return null;
  return { start: at, query };
}

type MentionChoice = { id: string; name: string; bot?: Bot };

/** One row of the "/" menu: Murage's own commands first, then the addressed
 * bot's engine commands (shared/engine-commands.ts). */
type SlashEntry =
  | { kind: "murage"; command: ComposerSlashCommand }
  | { kind: "skill"; skill: SlashSkill }
  | { kind: "engine"; command: EngineCommand };

const GOAL_COMMAND: ComposerSlashCommand = {
  id: "goal",
  label: "/goal",
  description: "Keep a team working until the goal is complete",
};

const LEARN_COMMAND: ComposerSlashCommand = {
  id: "learn",
  label: "/learn",
  description: "Teach a reusable workflow from this conversation",
};

// The guided first run, reachable from every composer. It is always offered:
// on a finished workspace the same list comes back with its ticks already in
// place and every finished step offering Change, so there is no state in
// which typing it is a dead end.
const SETUP_COMMAND: ComposerSlashCommand = {
  id: "setup",
  label: "/setup",
  description: "Walk through setting up your bots, and pick up where you left off",
};

/** Composer chip for the approval level: Ask, Auto, Full access or No
 * limits. The same `autoApprove` bit as the profile switch, plus
 * `fullAccess` and `noLimits` above it. The
 * chip only changes its name, not its color. */
function PermissionModeSelector({ bot, onSetMode, routine }: {
  bot: Bot;
  onSetMode: (mode: PermissionMode) => void;
  /** This is a routine's own conversation: the chip shows, and sets, the
   * level that routine's runs are judged at. */
  routine?: { name: string; mode: PermissionMode };
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const current = routine?.mode ?? permissionModeOf(bot);
  const currentEntry = PERMISSION_MODES.find((entry) => entry.mode === current)!;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <div className="relative flex items-center" ref={wrapperRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${current === "ask" ? "Ask for approval" : currentEntry.label}${routine ? ` for the routine ${routine.name}` : ""}`}
        title={routine ? `Every run of the routine ${routine.name} works here at this level. Choosing one here sets it for the routine.` : undefined}
        data-routine-level={routine ? "" : undefined}
        data-coach="level-chip"
        disabled={bot.busy}
        onClick={() => setOpen((value) => !value)}
        className="relative flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-hairline/20 bg-transparent px-3 text-[13px] text-ink-secondary after:absolute after:-inset-1.5 after:content-[''] hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <PermissionModeIcon mode={current} size={14} className="opacity-70" />
        {currentEntry.chip}
      </button>

      {open && (
        <PermissionLevelMenu
          bot={bot}
          routine={routine}
          onPick={(mode) => {
            onSetMode(mode);
            setOpen(false);
          }}
          onDone={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** The approval-level menu for one conversation: the composer chip opens it
 * below Auto on a desktop, and the phone composer's + menu opens the very
 * same one, so the engine notes, the desktop-only levels and Refresh
 * permissions read the same on both. */
function PermissionLevelMenu({ bot, routine, onPick, onDone }: {
  bot: Bot;
  routine?: { name: string; mode: PermissionMode };
  onPick: (mode: PermissionMode) => void;
  onDone: () => void;
}) {
  const current = routine?.mode ?? permissionModeOf(bot);
  const desktop = useDesktopSurface();
  const { state } = useStore();
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  // 3.1: the bot's own record holds the default for new conversations
  const profile = state.bots.find((candidate) => candidate.id === bot.id);
  return (
    <PermissionModeMenu
      botName={bot.name}
      current={current}
      desktop={desktop}
      engineCannotAsk={engineCannotAsk(engine?.driverKind) ? engine!.displayName : undefined}
      engineOwnApprovals={engine?.capabilities?.runsOnOwnTools === true ? engine.displayName : undefined}
      scope={routine ? { routine: routine.name } : {}}
      botDefault={profile ? permissionModeOf(profile) : undefined}
      footer={!routine && computerHere(desktop) === true ? <RefreshPermissionsButton botId={bot.id} threadId={bot.threadId} onDone={onDone} /> : undefined}
      onPick={onPick}
    />
  );
}

/** Renders the editable message composer and its pending attachments. */
export function Composer({
  bot,
  group,
  members,
  onEditLast,
  replyTo,
  onClearReply,
  onConsumeReply,
  locked: setupLocked = false,
}: {
  bot?: Bot;
  group?: Group;
  members?: Bot[];
  onEditLast?: () => void;
  replyTo?: Message | null;
  onClearReply?: () => void;
  onConsumeReply?: () => void;
  onRestoreReply?: (message: Message, threadId: string) => void;
  /** New rooms keep the composer inert until their setup is saved or skipped. */
  locked?: boolean;
}) {
  // A closed work thread is kept for reading (SPEC-X 10.1): nothing to send.
  const closedWork = !group && bot ? closedComposerLine(bot) : null;
  const locked = setupLocked || Boolean(bot?.awaitingThreadSnapshot) || closedWork !== null;
  const { state, dispatch, refreshAfterKey } = useStore();
  // The words stay in the box until the server acknowledges the send (they are the
  // person's, and a failed admission must never erase them). While one is out, the box is
  // read-only and a second press cannot start another.
  const [sendingId, setSendingId] = useState<string | null>(null);
  const sendingRef = useRef<string | null>(null);
  // A send out of this draft holds it in its record (lib/drafts.ts), so every tab, a composer mounted
  // mid-send (a thread switch and back) and a reload are read-only too, until the send settles.
  const draftId0 = group
    ? `group:${group.id}:${group.threadId}`
    : `bot:${bot?.id ?? ""}:${bot?.threadId ?? ""}`;
  // Held also covers this tab's press from the click until it is refused or its journal is written (lib/drafts.ts
  // reservation): typing, attachments, reply and mode are blocked, so what is sent is what was shown.
  const draftHeld = useSyncExternalStore(subscribeDraftHeld, () => isDraftHeld(draftId0), () => false);
  const sendPending = sendingId !== null || draftHeld;
  const { capabilities } = useDesktopCapabilities();
  // Unified target: a 1:1 bot thread or a room. In a room the @ picker
  // offers members plus @everyone; explicit mentions override the room's
  // configured default responder.
  const busy = group ? Boolean(group.working || group.busyBotId) : Boolean(bot?.busy);
  // an engine with a live session takes a message INTO the running turn;
  // for those the composer never locks — the server steers instead of 409
  const canSteer =
    !group && Boolean(bot) && state.instances.find((i) => i.instanceId === bot!.modelSelection.instanceId)?.capabilities?.queueing === true;
  // a pending approval blocks the prompt until it is answered
  const threadId = group?.threadId ?? bot?.threadId ?? "";
  // AMEND-13 Rule 82d: "Saved for [Routine name]" after the server saved it
  const routineSaved = useRoutineSaved(threadId);
  // the VISIBLE branch only — an approval left on a branch you edited away
  // from must not keep blocking the composer. Cards older than the held page
  // ride beside it (openCards) and count while that branch reaches them.
  const approvals = pendingApprovals(group ? olderOpenCards(group, group.messages) : bot ? olderOpenCards(bot, visibleMessages(bot)) : []);
  // Rule 83: every one of them is listed and answerable, not only the oldest.
  const approval = approvals[0];
  // Rule 83b: who asked comes from the card's own sender, never the member that happens to be busy.
  const approvalBotFor = (pending: Pending): Bot | undefined =>
    group ? members?.find((member) => member.id === pending.message.from?.botId) : bot;
  const approvalWhoFor = (pending: Pending): string =>
    approvalBotFor(pending)?.name ?? pending.message.from?.name ?? (group ? "A channel member" : "The bot");
  const approvalRoutineFor = (pending: Pending): string | undefined => {
    const routineId = pending.message.card?.routineId;
    return routineId ? state.routines.find((routine) => routine.id === routineId)?.name : undefined;
  };
  const busyName = group
    ? (members?.find((b) => b.id === group.busyBotId)?.name ?? (group.working ? "The team" : "A bot"))
    : (bot?.name ?? "The bot");
  const narrowPlaceholder = useNarrowViewport();
  // A phone: a round + beside one pill holding the field and the mic. Attach, Finish together and the approval level are entries of the + menu. Call stays in the header, its one home.
  const phoneComposer = narrowPlaceholder;
  const coarsePointer = useCoarsePointer();
  const sendKey = useSyncExternalStore(subscribeSendKey, currentSendKey, currentSendKey);
  const sendKeyLabel = sendKeyName(sendKey, isMacPlatform());
  // Per-thread draft: switching bots unmounts this component, so both the
  // text and its attachment chips have to outlive it (see lib/drafts).
  const draftId = draftId0;
  const [text, setText, attachments, setAttachments] = useComposerDraft(
    draftId,
    !group && bot ? `bot:${bot.id}` : undefined,
  );
  // F5-T4: while this conversation's composer is open, "Use as reference"
  // on one of its images adds the image to this draft (never another's).
  const referenceBotId = group ? undefined : bot?.id;
  useEffect(
    () => (threadId ? registerComposerReferenceTarget({ threadId, draftId, ...(referenceBotId ? { botId: referenceBotId } : {}) }) : undefined),
    [threadId, draftId, referenceBotId],
  );
  const failedSends = useFailedComposerSends(draftId);
  // Goal mode is opt-in and one-shot so the next ordinary channel message
  // cannot accidentally start another multi-turn team run.
  const [channelMode, setChannelMode] = useComposerChannelMode(draftId);
  // Why the last send stayed in the box. Any edit clears it: the person is
  // acting on it, and the next Enter checks again. It belongs to one draft,
  // so switching conversations drops it.
  const [sendNotice, setSendNotice] = useState<ComposerSendNoticeState | null>(null);
  // Needed by the pasted-key guard in send(): saving a key prefers the
  // desktop bridge and only falls back to the request path on the web.
  const desktopSurface = useDesktopSurface();
  const sendNoticeId = useId();
  useEffect(() => setSendNotice(null), [draftId]);
  // An image intake still running for this thread. send() re-reads the live
  // value rather than trusting this one, so it can never act on a stale
  // render; this subscription exists to take the notice back down the moment
  // the chip lands, instead of leaving a stale "still uploading" on screen.
  const uploadsPending = useSyncExternalStore(
    subscribeComposerUploads,
    () => composerUploadsPending(threadId),
    () => false,
  );
  useEffect(() => {
    if (uploadsPending) return;
    setSendNotice((prev) => (prev?.kind === "upload-pending" ? null : prev));
  }, [uploadsPending]);
  useWarmIntent(bot?.id, threadId, text);
  const editText = useCallback(
    (next: string) => {
      if (isDraftHeld(draftId)) return;
      setSendNotice(null);
      setText(next);
    },
    [draftId, setText],
  );
  const editAttachments = useCallback(
    (next: SetStateAction<Attachment[]>) => {
      if (isDraftHeld(draftId)) return;
      setSendNotice(null);
      setAttachments(next);
    },
    [draftId, setAttachments],
  );
  const addAttachments = useCallback(
    (next: Attachment[]) => editAttachments((prev) => [...prev, ...next]),
    [editAttachments],
  );
  // Captured draft identity also handles uploads finishing after navigation.
  const addUploadedAttachments = useCallback((next: Attachment[]) => {
    // While a send is out these join the next draft (the record's `later`); true only once they are stored.
    // keepInTab: storage refusing the write keeps the chips in this tab's draft, as typed words are (1.0.4 kept them too).
    void appendComposerDraftAttachments(draftId, next, { keepInTab: true }).then((stored) => {
      if (!stored) dispatch({ type: "error", message: t("imageReference.notSaved") });
    });
  }, [draftId, dispatch]);
  const removeAttachment = useCallback(
    (id: string) => editAttachments((prev) => prev.filter((a) => a.id !== id)),
    [editAttachments],
  );
  const displayPasteInChatBox = useCallback(
    /** Moves one pasted attachment into the editable draft and restores focus. */
    function displayPasteInChatBox(attachment: PasteAttachment) {
      const nextText = appendPastedText(text, attachment.text);
      editText(nextText);
      editAttachments((prev) => prev.filter((a) => a.id !== attachment.id));
      setCaret(nextText.length);
      setDismissedAt(null);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(nextText.length, nextText.length);
      });
    },
    [text, editText, editAttachments],
  );
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  // The send went through but the setup question did not hear it. Said quietly beside the composer, never as a failed send.
  const [intakeNotice, setIntakeNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!intakeNotice) return;
    const timer = window.setTimeout(() => setIntakeNotice(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [intakeNotice]);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // Esc'd this @
  const [dismissedSlashAt, setDismissedSlashAt] = useState<number | null>(null); // Esc'd this /
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // the latest caret, readable from callbacks without re-creating them
  const caretRef = useRef(0);
  caretRef.current = caret;
  // "New message to…" in the menu bar / tray menu opens this chat ready to type.
  // What's new's "Engine commands" asks for the "/" menu too (`slash`): an
  // empty draft becomes "/", which is exactly what typing it would do. A
  // draft with words in it is left alone and only focused.
  useEffect(() => {
    const focus = (event: Event) => {
      const detail = (event as CustomEvent<{ botId?: string; slash?: boolean }>).detail;
      const wanted = detail?.botId;
      const input = inputRef.current;
      if (!input || input.disabled || (wanted && bot && bot.id !== wanted)) return;
      input.focus();
      if (detail?.slash && input.value.trim() === "") {
        editText("/");
        setCaret(1);
        setDismissedSlashAt(null);
        requestAnimationFrame(() => inputRef.current?.setSelectionRange(1, 1));
        return;
      }
      input.setSelectionRange(input.value.length, input.value.length);
    };
    window.addEventListener(FOCUS_COMPOSER_EVENT, focus);
    return () => window.removeEventListener(FOCUS_COMPOSER_EVENT, focus);
  }, [bot, editText]);
  /** Returns keyboard focus to the draft, keeping the caret where it was. */
  const refocusInput = useCallback(() => {
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.disabled || !composerShouldRefocus(document.activeElement, input)) return;
      const at = Math.min(caretRef.current, input.value.length);
      input.focus();
      input.setSelectionRange(at, at);
    });
  }, []);
  // The composer is keyed by thread, so mounting means a thread was just
  // opened: put the caret at the end of its draft so the person can type
  // without clicking the box first. Touch screens are skipped, because
  // focusing there opens the keyboard over the conversation.
  useEffect(() => {
    if (globalThis.matchMedia?.(COARSE_POINTER_QUERY).matches) return;
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.disabled || !composerTakesFocusOnOpen(document.activeElement, input)) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  // Choosing a message to reply to means typing the reply comes next, so the
  // caret follows the new target the same way it does when a thread opens
  // (same touch and dialog guards). A reply restored with the thread is the
  // open effect's; the ref starts on it so the two never both run.
  // Announced to screen readers when Escape drops the reply; cleared with the next reply.
  const [replyCancelled, setReplyCancelled] = useState(false);
  const replyToId = replyTo?.id ?? null;
  const focusedReplyRef = useRef(replyToId);
  useEffect(() => {
    const previous = focusedReplyRef.current;
    focusedReplyRef.current = replyToId;
    if (replyToId) setReplyCancelled(false);
    if (!replyTargetTakesFocus(previous, replyToId)) return;
    if (globalThis.matchMedia?.(COARSE_POINTER_QUERY).matches) return;
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.disabled || !composerTakesFocusOnOpen(document.activeElement, input)) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [replyToId]);
  const mentionListRef = useRef<HTMLDivElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);
  // what was typed before the mic went on — partials append after it
  const baseText = useRef("");
  // Clean up dictation: the box as it was before clean-up replaced it, so one
  // tap puts the raw words back. Offered only while the box still holds what
  // clean-up wrote (undoOffered), so it never overwrites later typing.
  const [cleanupUndo, setCleanupUndo] = useState<CleanupUndo | null>(null);
  const textRef = useRef("");
  textRef.current = text;
  const wasRecording = useRef(false);

  // image paste is offered only when every bot that will actually answer
  // can open one. sendGroup routes to mentions, else the room default —
  // `members.some` would let a mixed room send <attached-image> to Grok.
  // An empty engine list is "not loaded yet", not "no image support"
  // (engineAcceptsImages); otherwise the bot's own engine decides.
  const botSupportsImages = (candidate?: Bot) =>
    Boolean(candidate && engineAcceptsImages(state.instances, candidate.modelSelection.instanceId));
  const imageTargetsSupport = (message: string, mode: "chat" | "goal") => {
    if (!group) return botSupportsImages(bot);
    if (mode === "goal") {
      return botSupportsImages(goalCoordinatorForComposer(message, members ?? [], group) ?? undefined);
    }
    const responders = roomRespondersForComposer(message, members ?? [], group, replyTo?.from?.botId);
    return responders.length > 0 && responders.every(botSupportsImages);
  };
  // A typed "/goal …" IS Goal mode — the same send, reached by keyboard. The
  // draft keeps the literal text (so the chip can un-type it), and everything
  // downstream reads the effective pair instead.
  const typedGoalText = group && !group.dm ? goalTextFromComposer(text) : null;
  const effectiveText = typedGoalText ?? text;
  const effectiveChannelMode = typedGoalText !== null ? "goal" : channelMode;
  const engineSupportsImages = imageTargetsSupport(effectiveText, effectiveChannelMode);

  // ── slash command menu (configure the whole send) ────────────────────
  const slash = composerSlashTrigger(text, caret);
  const commandCandidates = useMemo(() => {
    if (!slash || slash.start === dismissedSlashAt) return [];
    const supportsAgents = (candidate?: Bot) =>
      Boolean(
        candidate &&
          state.instances.find(
            (instance) => instance.instanceId === candidate.modelSelection.instanceId,
          )?.capabilities?.agentsMcp,
      );
    const available: ComposerSlashCommand[] = [];
    if (group && !group.dm) available.push(GOAL_COMMAND);
    if (
      skillRecorderEnabled(state.config) &&
      (group ? (members ?? []).some(supportsAgents) : supportsAgents(bot))
    ) {
      available.push(LEARN_COMMAND);
    }
    available.push(SETUP_COMMAND);
    const query = slash.query.toLowerCase();
    return available.filter(
      (command) =>
        !query ||
        command.id.startsWith(query) ||
        command.description.toLowerCase().includes(query),
    );
  }, [slash, dismissedSlashAt, group, members, bot, state.config, state.instances]);
  // The addressed bot's engine commands, read from the harness each time the
  // menu opens (it caches what the engine last reported). One-to-one chats
  // only: in a room the message can go to several bots on different engines.
  const slashActive = Boolean(slash && slash.start !== dismissedSlashAt);
  const engineBotId = group ? undefined : bot?.id;
  const engineInstanceId = group ? undefined : bot?.modelSelection.instanceId;
  const [engineCommands, setEngineCommands] = useState<{ key: string; view: EngineCommandsView } | null>(null);
  useEffect(() => {
    if (!slashActive || !engineBotId) return;
    const key = `${engineBotId}:${engineInstanceId ?? ""}`;
    let cancelled = false;
    api(`/api/bots/${engineBotId}/engine-commands`)
      .then((view: EngineCommandsView) => { if (!cancelled) setEngineCommands({ key, view }); })
      .catch(() => { /* no engine group: Murage's own commands still work */ });
    return () => { cancelled = true; };
  }, [slashActive, engineBotId, engineInstanceId]);
  const engineView = engineBotId && engineCommands?.key === `${engineBotId}:${engineInstanceId ?? ""}` ? engineCommands.view : null;
  const engineCandidates = useMemo(
    () => (slashActive && slash && engineView?.status === "ready" ? matchEngineCommands(engineView.commands, slash.query) : []),
    [slashActive, slash, engineView],
  );
  const engineNote = slashActive ? engineCommandsNote(engineView) : null;
  // A one-to-one chat also lists the bot's enabled skills; a room's members each have their own, so a room keeps to the commands above.
  const botSkills = useSlashSkills(group ? undefined : bot?.id, slashActive);
  const skillCandidates = useMemo(
    () => (slash ? skillSlashRows(botSkills, new Set((engineView?.status === "ready" ? engineView.commands : []).map((command) => command.name))).filter((skill) => slashSkillMatches(skill, slash.query)) : []),
    [slash, botSkills, engineView],
  );
  const slashEntries: SlashEntry[] = [
    ...commandCandidates.map((command) => ({ kind: "murage" as const, command })),
    ...skillCandidates.map((skill) => ({ kind: "skill" as const, skill })),
    ...engineCandidates.map((command) => ({ kind: "engine" as const, command })),
  ];
  const commandPickerOpen = slashEntries.length > 0 || engineNote !== null;

  // ── @mention picker (tag another bot; the agent reaches it via ask_bot) ──
  const mention = mentionQueryAt(text, caret);
  const candidates = useMemo(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const pool: MentionChoice[] = group
      ? [
          { id: "__everyone__", name: "everyone" },
          ...(members ?? []).map((member) => ({ id: member.id, name: member.name, bot: member })),
        ]
      : state.bots
          .filter((member) => member.id !== bot?.id && !member.hidden)
          .map((member) => ({ id: member.id, name: member.name, bot: member }));
    const q = mention.query.trim().toLowerCase();
    // "@Scout " — the full name plus a space — is a COMPLETED tag, not a
    // search: keep the picker closed so Enter sends instead of re-picking
    if (mention.query.endsWith(" ") && pool.some((b) => b.name.toLowerCase() === q)) return [];
    return pool.filter((b) => !q || b.name.toLowerCase().includes(q));
  }, [mention, dismissedAt, state.bots, bot?.id, group, members]);
  const mentionPickerOpen = candidates.length > 0;

  useEffect(
    () => setHighlight(0),
    [mention?.start, mention?.query, slash?.start, slash?.query],
  );

  useEffect(() => {
    if (!commandPickerOpen) return;
    commandListRef.current
      ?.querySelector<HTMLElement>(`[data-command-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, commandPickerOpen]);

  useEffect(() => {
    if (!mentionPickerOpen) return;
    mentionListRef.current
      ?.querySelector<HTMLElement>(`[data-mention-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, mentionPickerOpen]);

  // one line at rest, then grow with the draft — hard cap at six lines
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
    const cap = line * 6;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  }, [text]);

  const pickMention = (peer: MentionChoice) => {
    if (!mention) return;
    const after = text.slice(caret);
    const next = `${text.slice(0, mention.start)}@${peer.name} ${after}`;
    editText(next);
    const newCaret = mention.start + peer.name.length + 2;
    setCaret(newCaret);
    // picking completes this tag — close the popup so the next Enter sends
    setDismissedAt(mention.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
    });
  };

  const pickCommand = (command: ComposerSlashCommand) => {
    if (!slash) return;
    // /goal leaves NO text behind: the mode is the chip, and the draft is
    // just the goal. /learn stays literal because the harness reads it.
    // /setup is not a message at all. It takes them to their chief of staff,
    // where the first run lives, and shows the progress rail beside it. The
    // draft is left empty, so nothing is ever sent to a bot.
    const replacement = command.id === "learn" ? "/learn " : "";
    if (command.id === "setup") openFirstRun();
    const next = replaceComposerSlashTrigger(text, slash, replacement);
    editText(next.text);
    setCaret(next.caret);
    setDismissedSlashAt(slash.start);
    setChannelMode(command.id === "goal" ? "goal" : "chat");
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  // An engine command goes to the bot's engine as typed. One that takes
  // input is left in the draft for the owner to finish; one that takes none
  // is sent now, unless the draft already holds more after it.
  const pickEngineCommand = (command: EngineCommand) => {
    if (!slash || !bot) return;
    const pick = engineCommandPick(command);
    if (pick.kind === "send" && !text.slice(slash.end).trim() && !locked) {
      const sent = pick.text;
      dispatch({
        type: "send",
        botId: bot.id,
        text: sent,
        sendId: newSendId(),
        threadId,
        onError: () => {
          editText(sent);
          return false;
        },
      });
      track("message_sent", { driver: bot.modelSelection?.instanceId, queued: busy && !canSteer, engineCommand: true });
      editText("");
      setCaret(0);
      setDismissedSlashAt(null);
      return;
    }
    const next = replaceComposerSlashTrigger(text, slash, pick.text.trimEnd() + " ");
    editText(next.text);
    setCaret(next.caret);
    setDismissedSlashAt(slash.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  // A skill stays literal in the draft ("/name "), like /learn: the harness reads it and runs the skill for that turn.
  const pickSkill = (skill: SlashSkill) => {
    if (!slash) return;
    const next = replaceComposerSlashTrigger(text, slash, `/${skill.name} `);
    editText(next.text);
    setCaret(next.caret);
    setDismissedSlashAt(slash.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  const pickSlashEntry = (entry: SlashEntry) =>
    entry.kind === "murage" ? pickCommand(entry.command) : entry.kind === "skill" ? pickSkill(entry.skill) : pickEngineCommand(entry.command);

  // Busy sends are owned by the harness immediately for both channels and
  // 1:1 chats. Keeping a channel follow-up in this component used to lose its
  // auto-send intent whenever navigation unmounted the composer.
  const shownQueued = state.pendingQueued[threadId] ?? [];
  // A line still being sent is shown but is not yet something Inject can name.
  // (a refused one is waiting for the person, not for a turn)
  const queuedMessages = shownQueued.filter((entry) => !entry.sending && !entry.refused);
  const pendingCount = queuedMessages.length;
  const canInject = composerCanInjectNow(busy, locked, pendingCount);
  const interruptTurn = () => {
    if (group) dispatch({ type: "interruptGroup", groupId: group.id });
    else if (bot) dispatch({ type: "interrupt", botId: bot.id,threadId });
  };
  // Inject names the queued sends it is for, so a repeated click that lands
  // after they started cannot stop the turn now answering them.
  const injectQueued = () => {
    if (group) dispatch({ type: "interruptGroup", groupId: group.id, queueIds: queuedMessages.map((entry) => entry.queueId) });
    else interruptTurn();
  };
  const fileInput = useRef<HTMLInputElement>(null);
  // which level the Auto-on-this-computer warning is confirming, if open
  const [autoWarn, setAutoWarn] = useState<false | "auto" | "full" | "unlimited">(false);
  // the one-time Full access warning, and whether it also covers this computer
  const [fullWarn, setFullWarn] = useState<false | { onThisComputer: boolean; level: "full" | "unlimited" }>(false);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const audioFileRef = useRef<File | null>(null);
  const queueAudioFile = useCallback((file: File) => {
    if (audioFileRef.current) throw new Error("Transcribe or remove the selected audio before choosing another recording.");
    audioFileRef.current = file; setAudioFile(file);
  }, []);
  const removeAudioFile = () => { audioFileRef.current = null; setAudioFile(null); };
  // Auto mode belongs to one bot; a room has several, each with its own.
  const autoBot = group ? undefined : bot;
  const conversationRoutine = autoBot ? routineOfConversation(state.routines, autoBot.id, threadId) : undefined;
  const routineProfile = conversationRoutine ? state.bots.find((candidate) => candidate.id === conversationRoutine.botId) : undefined;
  // Tracked for its whole length, append included: an Enter that lands while
  // this is running must be held, or the image it is fetching is attached to
  // the draft AFTER this one.
  const pickFiles = (picked: FileList | null) => composerFileIntake({
    threadId,
    files: picked ? Array.from(picked) : [],
    allowImages: engineSupportsImages,
    getPath: pathForFile,
    uploadImage: file => imageAttachmentFromFile(file, threadId),
    queueAudio: queueAudioFile,
    onAdd: addUploadedAttachments,
    // Keep file-specific failures beside the attachments. A successful
    // overlapping intake must not erase an earlier failure before it is read.
    onNotice: setAttachmentNotice,
  });
  const setMode = (mode: PermissionMode) => {
    if (!autoBot) return;
    // In a routine's own conversation the level is the routine's: every run
    // works here at it (server/routines.ts). The server asks for the bot's
    // one-time Full access or No limits warning first, and says so.
    if (conversationRoutine) {
      void api(`/api/routines/${encodeURIComponent(conversationRoutine.id)}`, { method: "PATCH", body: JSON.stringify({ permissionMode: mode }) })
        .then((response) => { if (response?.routine) dispatch({ type: "routinePatched", routine: response.routine }); })
        .catch((error) => dispatch({ type: "error", message: fullAccessRefusalMessage({ [mode === "unlimited" ? "noLimits" : "fullAccess"]: mode === "full" || mode === "unlimited" }, error) ?? (error instanceof Error ? error.message : String(error)) }));
      return;
    }
    // Turning Auto (or Full access, which includes it) on for a bot that
    // drives THIS computer has to be acknowledged first. The flag the dialog
    // sends is stripped by the reducer rather than stored, so — exactly like
    // the settings panel — that warning is shown on every switch-on, not just
    // the first. The platform is the harness's own (announced on
    // /api/config), not this browser's UA (FOLLOW5).
    const platform = localAutoHostPlatform(capabilities, { harness: state.config?.harness });
    const needsLocal = mode !== "ask" && autoNeedsLocalComputerWarning({ platform, computer: autoBot.computer, autoApprove: autoBot.autoApprove });
    if (mode === "full" || mode === "unlimited") {
      // Full access and No limits each have their own warning, once per bot;
      // the server refuses the switch without it (server/full-access.ts).
      // When it is shown it also covers this computer, so the owner is never
      // asked twice in a row.
      const acknowledged = mode === "unlimited" ? autoBot.noLimitsAcknowledgedAt : autoBot.fullAccessAcknowledgedAt;
      if (acknowledged === undefined) {
        setFullWarn({ onThisComputer: needsLocal, level: mode });
        return;
      }
      if (needsLocal) {
        setAutoWarn(mode);
        return;
      }
      dispatch({ type: "updateTask", botId: autoBot.id, threadId, patch: mode === "unlimited" ? { noLimits: true } : { fullAccess: true } });
      return;
    }
    if (needsLocal) {
      setAutoWarn("auto");
      return;
    }
    dispatch({ type: "updateTask", botId: autoBot.id,threadId, patch: { autoApprove: mode === "auto", fullAccess: false } });
  };

  const hasContent = Boolean(effectiveText.trim()) || attachments.length > 0;
  const retryFailedSend = (failed: FailedComposerSend) => {
    const failedMode = failed.channelMode ?? "chat";
    if (failed.requestText.includes("<attached-image ") && !imageTargetsSupport(failed.requestText, failedMode)) {
      dispatch({ type: "error", message: "The selected responder does not support image attachments." });
      return;
    }
    forgetFailedComposerSend(draftId, failed.id);
    const retry = {
      sendId: failed.sendId,
      text: failed.requestText,
      replyToId: failed.replyToId,
      threadId: failed.threadId,
      onError: () => {
        rememberFailedComposerSend(draftId, {
          sendId: failed.sendId,
          text: failed.text,
          requestText: failed.requestText,
          replyToId: failed.replyToId,
          threadId: failed.threadId,
          channelMode: failed.channelMode,
        });
      },
    };
    if (group) {
      dispatch({ type: "sendGroup", groupId: group.id, mode: failedMode, ...retry });
    } else if (bot) {
      dispatch({ type: "send", botId: bot.id, ...retry });
    }
  };
  const send = () => {
    if (locked || sendingRef.current || isDraftHeld(draftId)) return;
    // WHAT HAS TO BE SETTLED BEFORE A DRAFT IS COMPOSED.
    //
    // A pasted Flux Router key must never reach the transcript, and an image
    // still uploading belongs to THIS message rather than the next one. Both
    // are orderings, both have to run ahead of composeMessage, and both used
    // to be written out here — where the only test that can reach them is a
    // regex over this file. They are one function now
    // (src/lib/composer-send-gate.ts), which a test can execute; the effects
    // below stay here, because they are React's.
    const gate = composerSendGate({ text: effectiveText, threadId });
    if (gate.kind === "flux-key") {
      // The sentence around the key is theirs and is kept: only the key
      // itself is lifted out, and the composer says where it went.
      setText(gate.rest);
      setSendNotice({ kind: "flux-key-saved" });
      void (async () => {
        try {
          await saveFluxKey(gate.key, {
            status: await readFluxStatus(api),
            bridge: fluxBridge(),
            request: api,
            desktop: desktopSurface === true,
            refresh: refreshAfterKey,
          });
        } catch {
          // The key is still out of the transcript, which was the urgent
          // part. What failed is the saving, and the person is told that
          // rather than left believing they are connected.
          setSendNotice({ kind: "flux-key-failed" });
        }
      })();
      return;
    }
    if (gate.kind === "upload-pending") {
      setSendNotice({ kind: "upload-pending" });
      return;
    }
    if (
      attachments.some((attachment) => attachment.kind === "image") &&
      !imageTargetsSupport(effectiveText, effectiveChannelMode)
    ) {
      dispatch({ type: "error", message: "The selected responder does not support image attachments." });
      return;
    }
    const t = composeMessage(effectiveText, attachments);
    if (!t) return;
    // Checked here, before any request and before the draft is cleared. An
    // over-limit message used to leave the renderer, come back as a 413 the
    // store showed for six seconds, and land in the box again with nothing
    // on screen to say why.
    if (messageIsTooLarge(t)) {
      setSendNotice({ kind: "too-large", sizeBytes: messageTextBytes(t) });
      return;
    }
    // The harness can still answer 413 (a different bound, or a body JSON
    // escaping pushed past it). That failure is shown here, beside the text
    // it kept, instead of as a passing toast.
    const refusedForSize = (error: unknown) => {
      if (!isMessageSizeRefusal(error)) return false;
      setSendNotice({ kind: "refused", sizeBytes: messageTextBytes(t) });
      return true;
    };
    // Nothing is cleared here, and nothing ever needs restoring: the words stay in the box (its record) until the
    // server acknowledges THIS send. W1 writes the journal before any POST; if it cannot be written, nothing is sent.
    const shown = { text, att: [...attachments], mode: channelMode };
    const requestText = t;
    const groupMode = effectiveChannelMode;
    const dispatchSend = (sendId: string, attemptId: string, replyToId: string | undefined) => {
    sendingRef.current = sendId;
    setSendingId(sendId);
    // UI only: the record is the state. Settled once, however the attempt ends (here, another tab, a reload).
    watchDraftSend(draftId, sendId, attemptId, (outcome) => {
      if (sendingRef.current === sendId) { sendingRef.current = null; setSendingId(null); }
      if (outcome === "acked" || outcome === "refused") {
        if (!readComposerDraft(draftId).text) {
          setSendNotice(null);
          onConsumeReply?.();
          refocusInput();
        }
      }
    });
    const failedSend = (error: unknown) => refusedForSize(error);
    const outboxDraft = {
      draftId,
      attemptId,
      text,
      requestText,
      attachments: [...attachments],
      ...(group ? { channelMode } : {}),
      ...(replyToId ? { replyToId } : {}),
    };
    if (group) {
      dispatch({
        type: "sendGroup",
        groupId: group.id,
        text: requestText,
        sendId,
        outboxDraft,
        replyToId,
        threadId,
        mode: groupMode,
        onError: failedSend,
      });
      track("message_sent", { room: true, mode: effectiveChannelMode, queued: busy });
    } else if (bot) {
      // A SETUP QUESTION ON THE TABLE HEARS THE ANSWER. IT DOES NOT TAKE IT.
      //
      // This is invariant I7 — every question the new-bot conversation asks
      // accepts free text, because the composer is on screen at every turn and
      // this is where it goes — and it is now stated without the part that
      // broke it.
      //
      // WHAT BROKE. This used to `return` here, so a send while a question was
      // open went to the intake route INSTEAD of to the bot. The first thing a
      // new person typed was therefore read as an answer to "What do you
      // actually want me for?" whatever it was. Verbatim from the 0.1.56 Mac
      // customer test (M1): typing `Save a file named notes/prices.md
      // containing the line "Croissant 3.50". Then say done.` was answered
      // with "I'd set myself up as 3D Star Adventure", the request was never
      // run, and the person had to type it again.
      //
      // WHY NOT A TEST ON THE SENTENCE. Because there isn't one. "Is this a
      // task or an answer?" cannot be decided from the words — a heuristic
      // over the person's own sentence is exactly how the bug was born — and
      // the cost of the two mistakes is not symmetric. Answering a question
      // that was not asked costs a card nobody reads; losing a request costs
      // the request.
      //
      // So BOTH, always, in this order: the bot gets the message, and the
      // setup conversation is told what was said. The turn is dispatched
      // FIRST so the person's own words are in the transcript before anything
      // the intake route appends after them. The intake call is fire and
      // forget and swallows its own failure: the send is the thing that
      // matters, and a setup card that did not appear must never surface as
      // an error on a message that did.
      const question = openIntakeCard(visibleMessages(bot));
      dispatch({
        type: "send",
        botId: bot.id,
        text: requestText,
        sendId,
        outboxDraft,
        replyToId,
        threadId,
        onError: failedSend,
      });
      if (question) replyToIntake(bot.id, question.id, requestText, api, { alongside: true }).then(() => setIntakeNotice(null), () => setIntakeNotice(INTAKE_NOT_RECORDED));
      track("message_sent", { driver: bot.modelSelection?.instanceId, queued: busy && !canSteer });
    }
    };
    void beginDraftSend(draftId, shown, (sendId, content): DraftOutboxEntry => ({
      sendId,
      ...(group ? { kind: "group" as const, groupId: group.id, mode: groupMode } : { kind: "bot" as const, botId: bot?.id ?? "" }),
      threadId,
      text: requestText,
      ...(content.reply ? { replyToId: content.reply } : {}),
      at: Date.now(),
      attempts: 0,
    })).then((begun) => {
      if (!begun.ok) {
        if (begun.reason === "notSaved") setSendNotice({ kind: "not-saved" });
        else if (begun.reason === "earlierArrived") setSendNotice({ kind: "earlier-arrived" });
        else if (begun.reason === "checkFailed") setSendNotice({ kind: "check-failed" });
        // held (another tab's send) or changed (the draft moved under the press): the box shows the stored words; focus goes back to it
        else if (begun.reason === "held" || begun.reason === "changed") refocusInput();
        return;
      }
      dispatchSend(begun.sendId, begun.attemptId, begun.content.reply);
    }, () => {
      // Nothing was posted: the words stay in the box and the composer takes the next press.
      setSendNotice({ kind: "not-saved" });
    });
  };

  // native dictation: partials stream into the input while the Swift
  // helper runs; the final transcript stays in the box, ready to edit/send
  useEffect(() => {
    if (!recording) return;
    const bridge = window.muragebox;
    if (!bridge) {
      setRecording(false);
      return;
    }
    setSpeechError(null);
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (typeof line.text === "string") {
        const base = baseText.current;
        editText(base ? `${base} ${line.text}` : line.text);
      }
    });
    const offEnd = bridge.onSpeechEnd(({ code, reason }) => {
      setRecording(false);
      if (code === 2) {
        setSpeechError("Dictation is only available on macOS for now.");
      } else if (code === 1) {
        setSpeechError(
          reason === "helper-stop-pending"
            ? "The previous dictation session is still closing. Try again in a moment."
            : isDictationDisabled(reason)
              ? dictationDisabledNote()
              : "Dictation needs Microphone + Speech Recognition access. Turn it on in System Settings → Privacy & Security.",
        );
      }
    });
    void bridge.speechStart();
    return () => {
      offTranscript();
      offEnd();
      void bridge.speechStop();
    };
  }, [recording, editText]);

  // When native dictation stops, tidy what it added and replace the box with
  // the result. Any failure leaves the raw words where they are. Skipped if the
  // person typed, sent or switched draft while the request was out.
  useEffect(() => {
    const was = wasRecording.current;
    wasRecording.current = recording;
    if (!was || recording || !cleanupEnabled()) return;
    const atStop = textRef.current;
    const base = baseText.current;
    const said = dictatedPortion(base, atStop);
    if (!said) return;
    void requestCleanup(said, { botId: bot?.id, groupId: group?.id }).then((result) => {
      // read at the moment the answer lands: typing, sending or switching
      // draft meanwhile keeps what the person did
      const applied = applyCleanupResult({ atStop, base, current: textRef.current, result });
      if (!applied) return;
      setCleanupUndo(applied.undo);
      editText(applied.next);
    });
  }, [recording, bot?.id, group?.id, editText]);

  // Stop dictating without dropping the last words: ask the helper to finish,
  // keep the transcript listener attached until it reports the end (or 1.5 s),
  // and only then flip `recording`, which runs the clean-up on the full text.
  const finishing = useRef<(() => void) | null>(null);
  const stopDictation = useCallback(() => {
    const bridge = window.muragebox;
    if (finishing.current) return;
    if (!bridge?.speechFinish) return setRecording(false);
    finishing.current = finishThenStop({
      finish: () => bridge.speechFinish!(),
      onEnd: (cb) => bridge.onSpeechEnd(() => cb()),
      done: () => {
        finishing.current = null;
        setRecording(false);
      },
    });
  }, []);
  useEffect(() => {
    if (!recording && finishing.current) {
      finishing.current();
      finishing.current = null;
    }
  }, [recording]);

  // Typed "/goal …" and pressed the lit chip: that reads as "no, not a goal", so un-type the command rather than
  // leaving a lit chip the draft still contradicts. The chip and the phone + menu share it.
  const toggleGoal = () => {
    if (typedGoalText !== null) {
      const nextCaret = Math.max(0, caret - (text.length - typedGoalText.length));
      editText(typedGoalText);
      setCaret(nextCaret);
      setChannelMode("chat");
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(nextCaret, nextCaret);
      });
      return;
    }
    setChannelMode((current) => current === "goal" ? "chat" : "goal");
  };

  // The routine level the chip shows and sets, when this conversation is a routine's own.
  const routineLevel = conversationRoutine && routineProfile
    ? { name: conversationRoutine.name, mode: routineEffectiveMode(conversationRoutine, routineProfile) }
    : undefined;
  const phoneApproval = autoBot
    ? {
        current: PERMISSION_MODES.find((entry) => entry.mode === (routineLevel?.mode ?? permissionModeOf(autoBot)))!.chip,
        icon: <PermissionModeIcon mode={routineLevel?.mode ?? permissionModeOf(autoBot)} size={16} className="" />,
        disabled: Boolean(autoBot.busy),
        renderMenu: (done: () => void) => (
          <PermissionLevelMenu
            bot={autoBot}
            routine={routineLevel}
            onPick={(mode) => {
              setMode(mode);
              done();
            }}
            onDone={done}
          />
        ),
      }
    : undefined;

  const toggleMic = () => {
    if (!capabilities.dictation.available || !window.muragebox) {
      setSpeechError("Dictation isn't available in this build.");
      return;
    }
    if (recording) return stopDictation();
    baseText.current = text.trim();
    setRecording(true);
  };

  return (
    <div data-composer className="pointer-events-none relative px-5 pb-3">
      {/* No fill or hairline on this wrapper — those were the black frame
          in the pill's top corners. The dock overlays the transcript. */}
      {cleanupUndo && undoOffered(cleanupUndo, text) && (
        <div className="pointer-events-auto mb-2 flex w-full items-center gap-2 rounded-lg border border-hairline/60 bg-raised px-3 py-2 text-[12px] text-ink-secondary">
          <span className="min-w-0 flex-1">Dictation cleaned up.</span>
          <button
            type="button"
            onClick={() => {
              editText(undoCleanup(cleanupUndo));
              setCleanupUndo(null);
            }}
            className="shrink-0 rounded px-2 py-1 font-medium text-ink hover:bg-raised-hover"
          >
            Undo clean-up
          </button>
        </div>
      )}
      {intakeNotice && (
        <div role="status" data-testid="intake-reply-notice" className="pointer-events-auto mb-2 w-full rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          {intakeNotice}
        </div>
      )}
      {speechError && (
        <div className="pointer-events-auto mb-2 w-full rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          {speechError}
        </div>
      )}
      <div className="pointer-events-auto relative w-full">
        {failedSends.map((failed) => (
          <div
            key={failed.id}
            className="mb-2 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger"
          >
            <span className="min-w-0 flex-1 truncate">
              Not sent: “{failed.text.trim() || "attachment"}”
            </span>
            <button
              type="button"
              onClick={() => retryFailedSend(failed)}
              className="shrink-0 rounded px-2 py-1 font-medium hover:bg-danger/10"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => forgetFailedComposerSend(draftId, failed.id)}
              aria-label="Dismiss failed message"
              title="Dismiss"
              className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-danger/10"
            >
              <X size={13} strokeWidth={2.5} />
            </button>
          </div>
        ))}
        <ComposerSendNotice id={sendNoticeId} notice={sendNotice} onDismiss={() => setSendNotice(null)} />
        <ComposerImagesOverLimit attachments={attachments} />
        {commandPickerOpen && (
          <div
            ref={commandListRef}
            role="listbox"
            aria-label="Composer commands"
            className="absolute bottom-full left-2 z-20 mb-2 max-h-96 w-80 overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border border-hairline/40 bg-raised shadow-lg"
          >
            {[
              { name: "Murage", entries: slashEntries.filter((entry) => entry.kind === "murage"), note: null },
              { name: "Skills", entries: slashEntries.filter((entry) => entry.kind === "skill"), note: null },
              { name: engineView?.engine ?? "", entries: slashEntries.filter((entry) => entry.kind === "engine"), note: engineNote },
            ]
              .filter((section) => section.entries.length > 0 || section.note)
              .map((section) => (
                <div key={section.name} role="group" aria-label={section.name}>
                  <div aria-hidden="true" className="border-b border-hairline/20 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                    {section.name}
                  </div>
                  {section.note && <div className="px-3 py-2.5 text-xs text-ink-secondary">{section.note}</div>}
                  {section.entries.map((entry) => {
                    const index = slashEntries.indexOf(entry);
                    const label = entry.kind === "murage" ? entry.command.label : entry.kind === "skill" ? `/${entry.skill.name}` : `/${entry.command.name}`;
                    const description = entry.kind === "murage" ? entry.command.description : entry.kind === "skill" ? entry.skill.description : entry.command.description ?? entry.command.hint;
                    const rowId = entry.kind === "murage" ? entry.command.id : entry.kind === "skill" ? entry.skill.name : entry.command.name;
                    return (
                      <button
                        key={`${entry.kind}:${rowId}`}
                        type="button"
                        role="option"
                        aria-selected={index === highlight}
                        data-command-index={index}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => pickSlashEntry(entry)}
                        onMouseEnter={() => setHighlight(index)}
                        className={cn(
                          "flex w-full items-center gap-3 px-3 py-2.5 text-left",
                          index === highlight ? "bg-raised-hover" : "",
                        )}
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                          {entry.kind === "engine" ? (
                            <Terminal size={15} aria-hidden="true" />
                          ) : entry.kind === "skill" ? (
                            <Sparkles size={15} aria-hidden="true" />
                          ) : entry.command.id === "goal" ? (
                            <Target size={15} aria-hidden="true" />
                          ) : entry.command.id === "setup" ? (
                            <ListChecks size={15} aria-hidden="true" />
                          ) : (
                            <BookOpen size={15} aria-hidden="true" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px] font-medium text-accent">{label}</span>
                          {description && (
                            <span className="block truncate text-xs text-ink-secondary">{description}</span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
          </div>
        )}
        {mentionPickerOpen && (
          <div
            ref={mentionListRef}
            role="listbox"
            aria-label="Tag a bot"
            className="absolute bottom-full left-2 z-20 mb-2 max-h-72 w-72 overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border border-hairline/40 bg-raised shadow-lg"
          >
            {candidates.map((peer, i) => (
              <ComposerMenuRow
                key={peer.id}
                index={i}
                highlighted={i === highlight}
                onPick={() => pickMention(peer)}
                onHover={() => setHighlight(i)}
                leading={peer.bot ? (
                  <BotAvatar
                    bot={peer.bot}
                    state={normalizeState(peer.bot.mascotExpression) ?? "happy"}
                    size={24}
                  />
                ) : (
                  <span className="flex size-6 items-center justify-center rounded-full bg-raised text-ink-secondary">
                    <Users size={14} aria-hidden="true" />
                  </span>
                )}
                name={peer.name}
                tag={peer.bot ? "Bot" : "Channel"}
                description={mentionRowDescription(peer, members?.length ?? 0)}
              />
            ))}
          </div>
        )}
        {routineSaved && (
          <RoutineSavedNotice title={routineSaved.title} items={routineSaved.items} onDismiss={() => clearRoutineSaved(threadId)} />
        )}
        {/* An approval takes over the composer: you answer it before you
            can type again, so a waiting bot is impossible to miss. */}
        {approval && (
          <PendingApprovalQueue
            key={threadId}
            approvals={approvals}
            threadId={threadId}
            botFor={approvalBotFor}
            whoFor={approvalWhoFor}
            routineFor={approvalRoutineFor}
            onCancelTurn={interruptTurn}
          />
        )}
        {replyTo && (
          <div className="mb-2 px-1">
            <ComposerReplyStrip
              message={replyTo}
              fallbackName={bot?.name}
              onClear={() => { if (!sendPending) onClearReply?.(); }}
            />
          </div>
        )}
        <span role="status" aria-live="polite" className="sr-only">{replyCancelled ? t("composer.replyCancelled") : ""}</span>
        <ComposerAttachments
          items={attachments}
          onAdd={addUploadedAttachments}
          threadId={threadId}
          onRemove={removeAttachment}
          onDisplayInChatBox={displayPasteInChatBox}
          allowImages={engineSupportsImages}
          notice={attachmentNotice}
          onNotice={setAttachmentNotice}
          onManageStorage={() => dispatch({ type: "toggleAppSettings", open: true, section: "storage" })}
          onAudioFile={queueAudioFile}
          frozen={sendPending}
        />
        {audioFile && <AudioAttachmentIntake file={audioFile} configured={Boolean(state.config?.flux?.configured)}
          onAddTranscript={transcript => addAttachments([pasteAttachment(transcript)])} onRemove={removeAudioFile}
          onSettings={() => dispatch({ type: "toggleAppSettings", open: true, section: "engines" })} />}
        <div className="relative">
          {/* App-ground from the pill midline down, full-bleed. Bubbles may
              tuck into the top half of the radius; they must not show below
              center — including the corner pockets around the paperclip. */}
          <div
            aria-hidden
            className="absolute -left-5 -right-5 top-1/2 h-[50vh] bg-app"
          />
        {/* A COLUMN, not a row. As a row this was `items-end`, so the chip
            cluster sat at the bottom of a container whose height is set by the
            textarea -- and the textarea grows to 9rem. Long dictation therefore
            left ~112px of empty column above Auto, while the send cluster,
            being `items-center`, floated at a different height again. Stacking
            them removes the dead space at every height and gives both clusters
            one baseline. */}
        <div className={phoneComposer ? "flex items-end gap-2" : "contents"}>
        {phoneComposer && !locked && (
          <ComposerPlusMenu
            onAttach={() => fileInput.current?.click()}
            attachDisabled={sendPending}
            goal={group && !group.dm ? { on: effectiveChannelMode === "goal", disabled: sendPending, onToggle: toggleGoal } : undefined}
            approval={phoneApproval}
          />
        )}
        <div className={cn("relative z-[1] flex gap-1.5 bg-raised py-1.5", phoneComposer ? "min-w-0 flex-1 flex-row flex-wrap items-end gap-x-1 rounded-[26px] px-3" : "flex-col rounded-3xl px-2")}>
          {/* First child of the column, so a queued line sits directly above
              the textarea it came out of and above the controls row — not
              inside that row, and not at the far end of a transcript the
              user has scrolled away from. */}
          <div className={phoneComposer ? "w-full" : "contents"}>
          <QueuedComposerMessages
            items={shownQueued}
            onCancel={(queueId) => {
              if (group) dispatch({ type: "cancelGroupQueued", groupId: group.id, threadId, queueId });
              else if (bot) dispatch({ type: "cancelQueued", botId: bot.id, queueId });
            }}
            onResend={(item) => {
              // The same send id, words, reply, mode and responder: the server treats it as the new attempt.
              const again = state.pendingQueued[threadId]?.find((entry) => entry.queueId === item.queueId);
              const sendId = again?.sendId;
              if (!again?.refused || !sendId) return;
              // the chip is the one recovery surface for these words: no restored draft or retry item keeps a second copy
              releaseRecoveredSend(sendId, { includeFrozen: true });
              // Each press mints its own action token, and presents the stop token the chip carries now: a retry of an earlier press cannot.
              const press = { resend: true as const, actionId: crypto.randomUUID(), ...(again.refused.restoreGen ? { restoreGen: again.refused.restoreGen } : {}), ...(again.refused.stopGen ? { stopGen: again.refused.stopGen } : {}) };
              if (group) dispatch({ type: "sendGroup", groupId: group.id, text: again.text, sendId, ...press, threadId, mode: again.refused.mode ?? "chat", ...(again.refused.replyToId ? { replyToId: again.refused.replyToId } : {}), ...(again.refused.responderId ? { responderId: again.refused.responderId } : {}) });
              else if (bot) dispatch({ type: "send", botId: bot.id, text: again.text, sendId, ...press, threadId, ...(again.refused.replyToId ? { replyToId: again.refused.replyToId } : {}) });
            }}
          />
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              // The picker leaves focus on the attach button; hand it back
              // to the draft once the files land (upstream #1599).
              void pickFiles(e.target.files).finally(refocusInput);
              // same file twice in a row still fires onChange
              e.target.value = "";
            }}
          />
          <textarea dir="auto"
          ref={inputRef}
          rows={1}
          enterKeyHint={coarsePointer ? "enter" : "send"}
          value={text}
          onChange={(e) => {
            editText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedAt(null);
            setDismissedSlashAt(null);
          }}
          onPaste={(e) => {
            // an image from the clipboard becomes an uploaded attachment —
            // but only for engines that can open one; a grok bot politely
            // refuses instead of receiving a path it cannot read
            const imageFiles = clipboardImageFiles(e.clipboardData);
            if (imageFiles.length || clipboardHasImages(e.clipboardData)) {
              e.preventDefault();
              if (!engineSupportsImages || !imageFiles.length) {
                dispatch({
                  type: "error",
                  message: !engineSupportsImages
                    ? "The selected responder cannot receive images. Choose an image-capable responder."
                    : "Clipboard image could not be read or uses an unsupported format. Attach PNG, JPEG, GIF or WebP instead.",
                });
                return;
              }
              void composerPasteIntake({
                threadId,
                files: imageFiles,
                uploadImage: file => imageAttachmentFromFile(file, threadId),
                onAdd: addUploadedAttachments,
                // A full disk goes to the attachment notice, which offers Manage storage.
                onError: (message) => noticeOffersStorage(message) ? setAttachmentNotice(message) : dispatch({ type: "error", message }),
              });
              return;
            }
            // a wall of text becomes a chip instead of burying the input
            const pasted = e.clipboardData.getData("text/plain");
            if (!isLongPaste(pasted)) return;
            e.preventDefault();
            // Preserve native paste replacement semantics: if text was
            // selected, the attachment replaces that selection.
            const start = e.currentTarget.selectionStart;
            const end = e.currentTarget.selectionEnd;
            if (start !== end) {
              editText(`${text.slice(0, start)}${text.slice(end)}`);
              setCaret(start);
            }
            editAttachments((prev) => [...prev, pasteAttachment(pasted)]);
          }}
          onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            // An input method confirming a candidate is not a menu pick or a send.
            if (imeComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) return;
            if (commandPickerOpen) {
              if (slashEntries.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((current) =>
                  (current + delta + slashEntries.length) % slashEntries.length,
                );
                return;
              }
              if (slashEntries.length && (e.key === "Enter" || e.key === "Tab")) {
                e.preventDefault();
                pickSlashEntry(slashEntries[Math.min(highlight, slashEntries.length - 1)]!);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedSlashAt(slash?.start ?? null);
                return;
              }
            }
            if (mentionPickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => (h + delta + candidates.length) % candidates.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickMention(candidates[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedAt(mention?.start ?? null);
                return;
              }
            }
            // Escape drops a pending reply and keeps the draft; an open menu closed first, above
            if (escapeCancelsReply({ key: e.key, isComposing: e.nativeEvent.isComposing }, { replying: Boolean(replyTo), recording })) {
              e.preventDefault();
              onClearReply?.();
              setReplyCancelled(true);
              return;
            }
            // an empty composer + ArrowUp = edit your last message (like a chat app)
            if (e.key === "ArrowUp" && !hasContent && onEditLast) {
              e.preventDefault();
              onEditLast();
              return;
            }
            // Mouse and keyboard: the chosen send key sends (Enter by default).
            // Touch: Return is a newline and the arrow button sends.
            if (enterSends({ key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode }, coarsePointer, sendKey)) {
              e.preventDefault();
              send();
            }
            if (e.key === "Escape" && recording) stopDictation();
          }}
          disabled={Boolean(approval) || locked}
          readOnly={sendPending}
          aria-busy={bot?.awaitingThreadSnapshot || sendPending || undefined}
          placeholder={((placeholder: { lead: string; hint?: string }) => compactPlaceholder(placeholder.lead, placeholder.hint, narrowPlaceholder))(
            closedWork
              ? { lead: closedWork }
              : bot?.awaitingThreadSnapshot
              ? { lead: "Loading replacement conversation…" }
              : setupLocked
              ? { lead: "Finish channel setup to start chatting" }
              : approval
              ? { lead: approvals.length > 1 ? "Answer the requests above to continue" : "Answer the approval above to continue" }
              : recording
              ? { lead: "Listening…" }
              : canInject
                ? { lead: `${busyName} is working`, hint: "inject now to interrupt with the queued message" }
              : busy && canSteer
                ? { lead: `${busyName} is working`, hint: `${sendKeyLabel} sends this into the running turn` }
              : busy
                ? group
                  ? { lead: `${busyName} is working`, hint: `${sendKeyLabel} queues your message` }
                  : { lead: `${busyName} is working`, hint: "sends when this turn finishes" }
                : group
                  ? channelMode === "goal"
                    ? { lead: `Describe what ${group.name} should finish together` }
                    : { lead: `Message ${group.name}`, hint: groupComposerHint(group, members ?? []) }
                  : { lead: `Message ${bot?.name ?? ""}` },
          )}
          aria-label={`Message ${group ? group.name : (bot?.name ?? "")}`}
          aria-invalid={sendNotice ? true : undefined}
          aria-describedby={sendNotice ? sendNoticeId : undefined}
            className={cn("max-h-[9rem] min-h-6 w-full resize-none overflow-y-auto bg-transparent px-2 pb-0.5 pt-1 text-[15px] leading-6 text-ink placeholder:text-ink-secondary focus:outline-none", phoneComposer && "w-auto min-w-0 flex-1 basis-[8rem]")}
          />
          {/* One controls row: chips on the left, send and dictation on the
              right, sharing a baseline at every composer height. */}
          <div className={cn("flex items-center gap-1", phoneComposer && "contents")}>
          {!locked && !phoneComposer && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={sendPending}
                aria-label="Attach a file"
                title="Attach a file"
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink"
              >
                <Paperclip size={17} />
              </button>
              {group && !group.dm && (
                <button
                  type="button"
                  aria-pressed={effectiveChannelMode === "goal"}
                  disabled={sendPending}
                  aria-label="Finish together"
                  title="Finish together: the team keeps working until the goal is complete"
                  onClick={toggleGoal}
                  className={cn(
                    "flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] transition-colors",
                    effectiveChannelMode === "goal"
                      ? "border-accent/35 bg-accent/10 text-accent"
                      : "border-hairline/20 bg-transparent text-ink-secondary hover:bg-raised hover:text-ink",
                  )}
                >
                  <Target size={14} aria-hidden="true" />
                  {effectiveChannelMode === "goal" ? "/goal" : "Goal"}
                </button>
              )}
              {autoBot && <PermissionModeSelector bot={autoBot} onSetMode={setMode} routine={routineLevel} />}
            </div>
          )}
          <div className="ml-auto flex items-center gap-1">
          {/* Inject is stop-then-steer made visible. The square stop would
              drain the same queue, so it yields while a send is waiting.
              Cancelling the queued composer card brings Stop back. */}
          {canInject && <ComposerInjectNow onInject={injectQueued} />}
          {/* Bot calls 1.0.9: "Call me when this finishes" on a running turn in a direct conversation (turn-end) */}
          {busy && !locked && !canInject && bot && !group && threadId && <CallMeWhenDone threadId={threadId} botName={bot.name} />}
          {busy && !locked && !canInject && (
          <button
            onClick={interruptTurn}
            aria-label="Stop this turn"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
            title="Stop"
          >
            <Square size={14} className="fill-current" />
          </button>
        )}
        {!locked && !busy && !hasContent && capabilities.dictation.available && (
          <button
            onClick={toggleMic}
            aria-label={recording ? "Stop dictation" : "Start dictation"}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full",
              recording
                ? "animate-pulse bg-danger/20 text-danger"
                : "text-ink-secondary hover:bg-raised hover:text-ink",
            )}
            title={recording ? "Stop dictation (Esc)" : "Dictate"}
          >
            <Mic size={18} />
          </button>
        )}
        {/* The else-branch of the SAME flag the native mic is gated on, so no
            surface can end up with two microphones or none. On macOS the
            helper above is faster and streams partials; everywhere else — a
            phone through the browser door, a Windows or Linux desktop — this
            is the only microphone there is. */}
        {/* NOT gated on `hasContent` or `busy`, unlike the native mic above.
            The native helper streams partials into the composer as the person
            speaks, so unmounting it loses at most the last word. This path is
            a batch round trip: one character typed while a clip is in flight
            would unmount the button and throw away up to two minutes of
            speech, and so would the bot going busy from another surface. The
            button stays, the spinner stays visible, and dictation appends to
            whatever is already in the draft. */}
        {!locked && !capabilities.dictation.available && (
          <PushToTalk
            facts={browserPushToTalkFacts({
              nativeDictation: capabilities.dictation.available,
              fluxConfigured: Boolean(state.config?.flux?.configured),
            })}
            cleanup={cleanupEnabled() ? { botId: bot?.id, groupId: group?.id } : undefined}
            onTranscript={(said, raw) => {
              // trimEnd, not trim: the utterance joins the draft with one
              // space, and nothing the person typed is discarded.
              const before = text.trimEnd();
              const next = before ? `${before} ${said}` : said;
              // The server tidied it: remember the spoken words for one-step undo.
              setCleanupUndo(raw ? { raw: before ? `${before} ${raw}` : raw, cleaned: next } : null);
              editText(next);
            }}
            onNote={setSpeechError}
          />
        )}
        {hasContent && !locked && (
          <button
            onClick={send}
            disabled={sendPending}
            aria-label={
              busy && canSteer
                  ? "Send into the running turn"
                  : busy
                    ? "Queue message"
                    : "Send message"
            }
            title={
              busy && canSteer
                  ? "Send into the running turn"
                  : busy
                    ? "Sends when the current turn finishes"
                    : "Send"
            }
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full text-white",
              busy && !canSteer
                  ? "bg-raised text-ink-secondary hover:bg-raised-hover"
                  : "bg-accent hover:brightness-110",
            )}
          >
            {busy && !canSteer ? <Clock size={15} /> : <ArrowUp size={17} />}
          </button>
          )}
          </div>
          </div>
        </div>
        </div>
        </div>
      </div>
      <div className="pointer-events-auto">
      <LocalComputerAutoWarning
        open={autoWarn !== false}
        mode={autoWarn === false ? "auto" : autoWarn}
        onCancel={() => setAutoWarn(false)}
        onConfirm={() => {
          if (autoBot) {
            dispatch({
              type: "updateTask",
              botId: autoBot.id,
              threadId,
              patch: autoWarn === "unlimited" ? { noLimits: true, acknowledgeLocalAuto: true } : autoWarn === "full" ? { fullAccess: true, acknowledgeLocalAuto: true } : { autoApprove: true, fullAccess: false, acknowledgeLocalAuto: true },
            });
          }
          setAutoWarn(false);
        }}
      />
      <FullAccessWarning
        open={fullWarn !== false}
        botName={autoBot?.name ?? ""}
        level={fullWarn === false ? "full" : fullWarn.level}
        scope="conversation"
        onThisComputer={fullWarn !== false && fullWarn.onThisComputer}
        onCancel={() => setFullWarn(false)}
        onConfirm={() => {
          if (autoBot && fullWarn !== false) {
            dispatch({
              type: "updateTask",
              botId: autoBot.id,
              threadId,
              patch: { ...(fullWarn.level === "unlimited" ? { noLimits: true, acknowledgeNoLimits: true } : { fullAccess: true, acknowledgeFullAccess: true }), ...(fullWarn.onThisComputer ? { acknowledgeLocalAuto: true } : {}) },
            });
          }
          setFullWarn(false);
        }}
      />
      </div>
    </div>
  );
}
