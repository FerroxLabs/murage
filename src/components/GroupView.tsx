import { ProjectLifecycleBanner } from "./ProjectLifecycleBanner";
import { Suspense } from "react";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";
import { LazyFallback } from "./LazyFallback";
import { useDesktopSurface } from "@/lib/use-surface";
import { projectClient, refreshProject } from "@/lib/use-project";
const CloseProject = retryableLazy(() => import("./CloseProjectDialog"));
const EndProject = retryableLazy(() => import("./EndProjectDialog"));
// A room: several bots + you in one shared thread. The sidebar and call view
// carry the personality; avatars inside the room stay still so a busy group
// does not become a wall of competing motion. Plain messages go to the room's
// default responder; @mentions override that routing.
import { isErrorActivity } from "../../shared/message-visibility";
import { MurageMessageRow } from "./MurageMessageRow";
import { messageActor, sameThreadReply, channelReadOnlyReason } from "@/lib/project-presentation";
import { ProjectStrip } from "./ProjectStrip";
import { ProjectTabs } from "./ProjectTabs";
import { ProjectViewBody } from "./ProjectViewBody";
import { projectSurfaceEnabled, projectWriteReason } from "@/lib/project-client";
import { ProjectSinceYouLeftLazy } from "./ProjectSinceYouLeftLazy";
import { useProject } from "@/lib/use-project";
import { DeletionNoteBanner } from "./DeletionNoteBanner";
import { ApprovedStepsRow, isApprovedStepsLine } from "./ApprovedStepsRow";
import { ImageRecordRow, isImageRecordLine } from "./ImageRecordRow";
import { DelegationWaitRow } from "./DelegationWaitRow";
import { roomTranscript } from "@/lib/room-transcript";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowDown, Check, ChevronDown, Folder, FolderOpen, Info, Loader2, MessageSquareReply, MoreHorizontal, Pencil, Pin, PinOff, Plus, Search, Square, Target, Trash2, Volume2, X } from "lucide-react";
import { SpeakButton } from "./SpeakButton";
import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { canReadAloud, isReading, readAloudLabel, toggleReadAloud } from "@/lib/read-aloud";
import {
  api,
  useStore,
  useStreaming,
  formatTime,
  openNotificationTarget,
  type Bot,
  type Group,
  type GroupDefaultResponder,
  type Message,
} from "@/state/store";
import { BotAvatar } from "./Avatar";
import { roomAuthor } from "@/lib/room-author";
import { startsBotTurn } from "@/lib/room-speakers";
import { RoomCommChip, RoomSpeakerLabel } from "./RoomSpeakerLabel";
import { MessageOutcome, OutcomeRailButtons, OutcomesProvider, ProposedOutcomeCard, outcomeSheetActions, useOutcomes } from "./OutcomeMark";
import { useRoomOutcomes } from "@/lib/outcomes";
import { TurnPresence } from "./TurnPresence";
import { useReplyPop } from "./use-reply-pop";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { normalizeState } from "@/lib/mascot";
import { effectiveDefaultResponder, groupResponseHint } from "@/lib/group-routing";
import { instructionsPreview } from "@/lib/channel-instructions";
import { ChatMarkdown } from "./ChatMarkdown";
import { ErrorBanner, MessageActionSheet, type MessageAction } from "./ChatView";
import { Composer } from "./Composer";
import { ChatFindBar } from "./ChatFindBar";
import { GroupTaskPicker } from "./TaskPicker";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";
import { channelWaitingRun, waitingRunMessage } from "@/lib/channel-waiting-run";
import { GoalRunCard } from "./GoalRunCard";
import { AttachedFileChips, AttachedImageGallery } from "./AttachmentPreview";
import { GroupCallButton, CallBarStrip } from "./CallControls";
import { registerCallSlot } from "@/lib/call-slot";

import { ApprovalCard } from "./ApprovalCard";
import { McpSignInCard, PublishCard } from "./LazyChatCards";
import { QuestionCard } from "./QuestionCard";
import { isQuestionCard } from "../../shared/questions";
import { ManageMembersPanel } from "./ManageMembersPanel";
import { ChannelDetailsPanel, channelNoun, type ChannelDetailsSection } from "./ChannelDetailsPanel";
import { ProjectHome } from "./ProjectHome";
import { ConfirmDelete } from "./ConfirmDelete";
import { CHANNEL_PROJECT_GOAL_MAX } from "../../shared/project";
import { channelProjectStatusLabel } from "@/lib/channel-surface";
import { groupActivityRuns } from "@/lib/activity-runs";
import { ActivityRun } from "./ActivityRun";
import { HelpersLine, HelpersSummary } from "./HelpersLine";
import { pickSubtasks } from "@/lib/subtasks";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { OpenBotListButton } from "./OpenBotListButton";
import { t } from "@/lib/i18n";
import { StoppedByYouRow, StoppedMidActionRow, StoppedRow } from "./StoppedRow";
import { hostStoppedReason, isStoppedMidDesktopAction } from "../../shared/host-stop";
import { TURN_STOPPED_NOTE } from "../../server/turn-outcome";
import { folderTrustNotice } from "../../shared/folder-trust";
import { FolderTrustRow } from "./FolderTrustRow";
import { BrowserUnavailableRow } from "./BrowserUnavailableRow";
import { ImagesNotSentRow } from "./ImagesNotSentRow";
import { browserUnavailableReason } from "../../shared/browser-unavailable";
import { imagesLeftOutCount } from "../../shared/images-left-out";
import { plainEngineError } from "../../shared/plain-engine-error";
import { ImagesLeftOutRow } from "./ImagesLeftOutRow";
import { imagesNotSent } from "../../shared/turn-image-note";
import { FolderTrustNote } from "./FolderTrustNote";
import { useFocusMessage } from "@/lib/focus-message";
import { shortPath } from "@/lib/short-path";
import { BOTTOM_FOLLOW_THRESHOLD, shouldResumeBottomFollow, useBottomFollowResize } from "@/lib/bottom-follow";
import { useComposerDockPad } from "@/lib/composer-dock";
import {
  BUBBLE_INTERACTIVE,
  BUBBLE_TAPPABLE,
  CHIP,
  CHIP_NAME,
  bubbleTapOpensActions,
} from "@/lib/transcript-chrome";
import { useNarrowViewport } from "@/lib/media-query";
import { showWorkingDots } from "@/lib/turn-tail";
import { liveActivityLabel } from "@/lib/live-activity";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import {
  SCROLLBACK_TRIGGER_PX,
  TRANSCRIPT_WINDOW_SIZE,
  asLiveTail,
  capRevealedWindow,
  expandEarlier,
  expandLater,
  focusWindowRange,
  resolveTranscriptWindow,
  tailWindowStart,
  trimFollowedTail,
  windowAfterPrepend,
} from "@/lib/transcript-window";
import { captureRowAnchor, captureViewportAnchor, observeSeenRows, restoreRowAnchor, type ScrollAnchor } from "@/lib/transcript-rows";
import { useRoomChips } from "@/lib/learned-chips";
import { ChipsProvider, MessageChip } from "./LearnedChip";
import { useReplyDraft } from "@/lib/drafts";
import { modShortcut } from "@/lib/mod-shortcut";
import { useProjectVisit } from "@/lib/use-project-visit";
import { useMessageById } from "@/lib/held-message";
import { needsNewestPage } from "@/lib/scrollback";
import { loadProjectTab, projectViewTab, saveProjectTab, type ProjectTab } from "@/lib/project-tab";

function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/** One finished tool step in a room. Same pill the 1:1 chat uses, minus the
 * status glyph — a room reads as a conversation, not a build log. */
function RoomToolChip({ message, botName }: { message: Message; botName?: string }) {
  const tool = message.tool;
  if (!tool) return null;
  // A raw provider response reads as one plain sentence naming the bot
  // (G11); the provider's own words stay on hover.
  const plain = botName && tool.name.startsWith("error:") ? plainEngineError(tool.name.slice(6).trim(), botName, { details: false }) : undefined;
  if (plain) return (
    <div className="flex justify-start">
      <div data-testid="tool-chip" title={tool.name.slice(6).trim()} className={cn(CHIP, "text-danger")}>
        <span data-testid="tool-chip-name" className="min-w-0 [overflow-wrap:anywhere]">{plain}</span>
      </div>
    </div>
  );
  return (
    <div className="flex justify-start">
      {/* Same shape, and the same trap, as ChatView's ActivityChip: a nowrap
          `max-w-[480px]` span is the chip's min-content width, so the pill
          could not shrink below 480px and ran off a phone. See the note there
          and src/e2e/transcript-width.human.spec.ts. */}
      <div
        data-testid="tool-chip"
        className={cn(CHIP, tool.ok === false ? "text-danger" : "text-ink-secondary")}
      >
        <span data-testid="tool-chip-name" className={cn(CHIP_NAME, "font-mono")}>{tool.name}</span>
      </div>
    </div>
  );
}

/** Pin toggle for one room message — one pin per room, patchGroup path. */
function PinToggle({ group, message }: { group: Group; message: Message }) {
  const { dispatch } = useStore();
  const pinned = group.pinnedMessageId === message.id;
  return (
    <button
      onClick={() =>
        dispatch({
          type: "patchGroup",
          groupId: group.id,
          patch: { pinnedMessageId: pinned ? "" : message.id },
        })
      }
      aria-label={pinned ? "Unpin message" : "Pin message"}
      className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
      title={pinned ? "Unpin this message" : "Pin this message to the top of the channel"}
    >
      {pinned ? <PinOff size={14} /> : <Pin size={14} />}
    </button>
  );
}

const Transcript = memo(function Transcript({
  group,
  members,
  messages,
  transcript,
  emergingId,
  onReply,
}: {
  group: Group;
  members: Bot[];
  /** The windowed suffix of group.messages — the boundary lives in GroupView. */
  messages: Message[];
  /** Full room transcript, used to resolve quoted messages outside the mounted window. */
  transcript: Message[];
  emergingId?: string | null;
  onReply: (message: Message) => void;
}) {
  const { state, dispatch } = useStore();
  const speech = useSpeech();
  const showToolCalls = showToolCallsEnabled(state.config);
  const project = useProject(group.id, !!group.channelProject && projectSurfaceEnabled(state.config));
  // Below `md` the hover rail is `display: none` and each bubble becomes its
  // own trigger. One matchMedia subscription for the whole channel, and one
  // open sheet at a time — the sheet is modal, so a second would be a bug.
  const narrow = useNarrowViewport();
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  // Members first, then any bot: a delegated teammate's reply or a removed
  // member's message keeps its own avatar instead of the default mascot.
  const memberOf = (id?: string) => roomAuthor(id, members, state.bots);
  // The outcome mark, same as a direct chat (OutcomeMark.tsx). A room's reply
  // is its member's own, so the mark is that member's; a delegated teammate
  // who is not a member has no mark here.
  const outcomes = useOutcomes();
  const markOwner = (m: Message) => (m.from?.botId && members.some((member) => member.id === m.from!.botId) ? memberOf(m.from.botId) : undefined);
  // Several bots working at once turn a room into a wall of chips; fold the
  // finished ones the same way a 1:1 chat does.
  const helperRuns = useStreaming().helpers.runs[group.threadId];
  const items = useMemo(() => groupActivityRuns(messages, helperRuns), [messages, helperRuns]);
  // What each bot turn answers, read over the whole room so a target above
  // the mounted window still resolves.
  const replyTargets = useMemo(() => new Map(transcript.flatMap((message) => { const target = sameThreadReply(message, transcript); return target ? [[message.id, target] as const] : []; })), [transcript]);
  // The chip only says something new: a reply to the row right above it
  // reads as a reply already (evidence Q-e1).
  const shownReplyTo = (id: string, above: Message | undefined) => {
    const target = replyTargets.get(id);
    if (!target || target.id === above?.id) return undefined;
    return target;
  };
  const jumpTo = (target: Message) => dispatch({ type: "focusMessage", threadId: group.threadId, messageId: target.id });
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === group.threadId ? focus.messageId : null;
  // Read aloud, on a member's written reply, in that member's own voice. Hidden
  // with no voice endpoint, the same check the call button makes.
  const speaks = (m: Message) => {
    const member = m.from?.botId ? memberOf(m.from.botId) : undefined;
    return member && state.config?.tts?.configured && canReadAloud(m) && !isErrorActivity(m) ? member : undefined;
  };
  const roomActions = (m: Message): MessageAction[] => {
    const pinned = group.pinnedMessageId === m.id;
    const reader = speaks(m);
    const reading = isReading(speech, m.id);
    const ready = Boolean(reader?.voice || state.config?.tts?.voice);
    return [
      ...(reader && m.text
        ? [{
            id: "speak",
            label: readAloudLabel({ playing: reading, ready }),
            icon: reading ? <Square size={18} className="fill-current" /> : <Volume2 size={18} />,
            disabled: !ready && !reading,
            onSelect: () => toggleReadAloud(speaker, { text: m.text ?? "", botId: reader.id, messageId: m.id, voiceId: reader.voice }),
          }]
        : []),
      ...(markOwner(m) ? outcomeSheetActions(outcomes, markOwner(m)!, m, markOwner(m)!.id) : []),
      { id: "reply", label: "Reply", icon: <MessageSquareReply size={18} />, onSelect: () => onReply(m) },
      {
        id: "pin",
        label: pinned ? "Unpin message" : "Pin message",
        icon: pinned ? <PinOff size={18} /> : <Pin size={18} />,
        onSelect: () =>
          dispatch({
            type: "patchGroup",
            groupId: group.id,
            patch: { pinnedMessageId: pinned ? "" : m.id },
          }),
      },
    ];
  };
  // The last message actually drawn. A hidden row (a folded tool run with
  // tool calls off, a quiet step, the bubble still streaming) must not count
  // as the previous sender, or the next bot's reply loses its name label.
  let shownPrev: Message | undefined;
  return (
    <>
      {items.map((item) => {
        const prev = shownPrev;
        if (item.kind === "helpers") {
          return (
            <div key={item.id} data-row={item.id} className="transcript-row flex flex-col gap-3">
              <HelpersSummary label={item.label} helpers={item.helpers} />
            </div>
          );
        }
        const first = item.kind === "run" ? item.messages[0] : item.message;
        const newDay = !prev || new Date(prev.at).toDateString() !== new Date(first.at).toDateString();
        if (item.kind === "run") {
          if (!showToolCalls) return null;
          const turnOpens = startsBotTurn(prev, first) || newDay;
          const runReplyTo = turnOpens ? shownReplyTo(first.id, prev) : undefined;
          shownPrev = item.messages.at(-1);
          return (
            <div key={item.id} data-row={item.id} className="transcript-row flex flex-col gap-3">
              {newDay && (
                <div data-day-separator="" className="py-3 text-center text-[13px] text-ink-secondary">
                  {dayLabel(first.at)} {formatTime(first.at)}
                </div>
              )}
              {first.from && turnOpens && (
                <RoomSpeakerLabel
                  bot={memberOf(first.from.botId)}
                  name={first.from.name}
                  color={first.from.color}
                  replyTo={runReplyTo}
                  onJump={runReplyTo ? () => jumpTo(runReplyTo) : undefined}
                />
              )}
              <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
                {item.messages.map((step) => (
                  <div key={step.id} className="contents" data-mid={step.id}>
                    <RoomToolChip message={step} />
                  </div>
                ))}
              </ActivityRun>
            </div>
          );
        }
        const m = item.message;
        if (m.id === emergingId) return null;
        const actor = messageActor(m, group.humanPrincipalKind ?? (group.readOnlyReason ? "person" : "owner"));
        const user = actor === "owner" || actor === "person";
        const attachments = user && m.text ? splitTranscriptAttachments(m.text, { hidePasteWrappers: true }) : null;
        const newTurn = startsBotTurn(prev, m) || newDay;
        // An error always names the bot it belongs to, even mid-cluster: in a
        // room several bots can fail in a row, and "error: ..." alone does not
        // say whose turn stopped.
        const errorRow = isErrorActivity(m);
        const routineOwner = m.kind === "routine.run" ? memberOf(m.from?.botId) : undefined;
        const routineExecutionThreadId = m.routineRun?.executionThreadId;
        const routineTarget = routineOwner && hasRoutineExecutionTask(routineOwner.tasks, routineExecutionThreadId)
          ? { botId: routineOwner.id, threadId: routineExecutionThreadId }
          : undefined;
        const row =
          // a member can hit a permission ask mid-turn; without this the
          // card never rendered here and the bot waited out its timeout.
          // `tool` distinguishes a permission from a QUESTION — a question
          // only accepts an "answer", so routing it here would offer an
          // Allow the broker rejects
          actor === "murage" || errorRow ? (
            <MurageMessageRow message={m} group={group} members={members} disabledReason={group.channelProject ? projectWriteReason(project) : state.config?.features?.roomsQueue === true ? null : "Request controls are not available yet"} />
          ) : m.kind === "secret" && m.secret && m.from?.botId ? (
            <SecretRequestCard botId={m.from.botId} threadId={group.threadId} message={m} />
          ) : m.kind === "connector" && m.connector && m.from?.botId ? (
            <ConnectorCard botId={m.from.botId} threadId={group.threadId} message={m} />
          ) : m.kind === "mcpSignIn" && m.mcpSignIn && m.from?.botId ? (
            <McpSignInCard botId={m.from.botId} threadId={group.threadId} message={m} />
          ) : m.kind === "options" && m.card?.kind === "publish" ? (
            <div className="flex justify-start"><PublishCard threadId={group.threadId} message={m} /></div>
          ) : m.kind === "options" && isQuestionCard(m.card) ? (
            // a member's question: same card as a 1:1 chat, answered by
            // the room's thread; a late answer goes out as a room message
            <div className="flex justify-start">
              <QuestionCard message={m} threadId={group.threadId} groupId={group.id} botName={memberOf(m.from?.botId)?.name} />
            </div>
          ) : m.kind === "options" && m.card?.requestId && m.card.tool ? (
            <div className="flex justify-start">
              <ApprovalCard bot={memberOf(m.from?.botId)} message={m} />
            </div>
          ) : m.kind === "goal.run" ? (
            <div className="flex justify-start">
              <GoalRunCard message={m} />
            </div>
          ) : m.kind === "routine.run" ? (
            <div className="flex justify-start">
              <RoutineRunCard
                message={m}
                onOpen={routineTarget
                  ? () => openNotificationTarget(dispatch, routineTarget, state)
                  : undefined}
              />
            </div>
          ) : m.kind === "activity" && m.tool ? (
            isApprovedStepsLine(m) ? (
              <ApprovedStepsRow message={m} />
            ) : isImageRecordLine(m) ? (
              <ImageRecordRow message={m} />
            ) : m.delegationWait ? (
              <DelegationWaitRow text={m.tool.name} onStop={() => dispatch({ type: "stopDelegation", delegationId: m.delegationWait!.id })} />
            ) : hostStoppedReason(m.tool.name) ? (
              <StoppedRow reason={hostStoppedReason(m.tool.name)!} />
            ) : isStoppedMidDesktopAction(m.tool.name) ? (
              <StoppedMidActionRow />
            ) : m.tool.name === TURN_STOPPED_NOTE ? (
              <StoppedByYouRow />
            ) : folderTrustNotice(m.tool.name) ? (
              <FolderTrustRow kind={folderTrustNotice(m.tool.name)!.kind} sources={folderTrustNotice(m.tool.name)!.sources} />
            ) : browserUnavailableReason(m.tool.name) ? (
              <BrowserUnavailableRow reason={browserUnavailableReason(m.tool.name)!} />
            ) : m.comm ? (
              // Same as a direct chat: the bot⇄bot chip is navigation, not
              // work, so it stays with tool calls off and opens the pair room.
              <RoomCommChip
                label={m.tool.name}
                comm={m.comm}
                bots={state.bots}
                onOpen={() => dispatch({ type: "select", id: m.comm!.groupId })}
              />
            ) : imagesLeftOutCount(m.tool.name) ? (
              <ImagesLeftOutRow botName={memberOf(m.from?.botId)?.name ?? m.from?.name ?? "This bot"} count={imagesLeftOutCount(m.tool.name)!} />
            ) : imagesNotSent(m.tool.name) ? (
              <ImagesNotSentRow counts={imagesNotSent(m.tool.name)!} />
            ) : m.tool.ok === false || m.tool.name.startsWith("error:") || showToolCalls ? (
              <RoomToolChip message={m} botName={memberOf(m.from?.botId)?.name ?? m.from?.name} />
            ) : null
          ) : m.kind === "text" && (m.text || m.attachments?.length) ? (
            <div className={cn("group flex w-full flex-col", user ? "items-end" : "items-start")}>
              <div className={cn("flex w-full items-end gap-1.5", user ? "justify-end" : "justify-start")}>
                {/* HOVER-ONLY RAIL — `opacity-0` until a pointer hovers the
                    row, and a phone reports `hover: none`, so on a phone these
                    were invisible and still reserving row width. `md:contents`
                    keeps them flex items of this row on a pointer device. */}
                <div className="max-md:hidden md:contents">
                {user && (
                  <>
                    <button
                      type="button"
                      onClick={() => onReply(m)}
                      aria-label="Reply to message"
                      title="Reply"
                      className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <MessageSquareReply size={14} />
                    </button>
                    <PinToggle group={group} message={m} />
                  </>
                )}
                </div>
                <div
                  data-testid="msg-bubble"
                  onClick={(event) => {
                    if (
                      !bubbleTapOpensActions({
                        narrow,
                        onInteractive:
                          event.target instanceof Element
                          && Boolean(event.target.closest(BUBBLE_INTERACTIVE)),
                        selectedText: String(globalThis.getSelection?.() ?? ""),
                      })
                    ) return;
                    setSheetFor(m.id);
                  }}
                  onKeyDown={(event) => {
                    if (!narrow || (event.key !== "Enter" && event.key !== " ")) return;
                    if (event.target !== event.currentTarget) return;
                    event.preventDefault();
                    setSheetFor(m.id);
                  }}
                  tabIndex={narrow ? 0 : undefined}
                  aria-haspopup={narrow ? "dialog" : undefined}
                  className={cn(
                    "w-fit max-w-[min(42rem,78%)] max-md:max-w-full rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed",
                    BUBBLE_TAPPABLE,
                    user ? "whitespace-pre-wrap bg-bubble-user text-ink" : "bg-card text-ink",
                  )}
                  title={new Date(m.at).toLocaleString()}
                >
                  {m.replyToId && (() => {
                    const target = transcript.find((candidate) => candidate.id === m.replyToId);
                    return target ? (
                      <div className="mb-2">
                        <ReplyQuote
                          message={target}
                          fallbackName="Bot"
                          compact
                          onJump={() =>
                            dispatch({ type: "focusMessage", threadId: group.threadId, messageId: target.id })
                          }
                        />
                      </div>
                    ) : null;
                  })()}
                  {user ? (
                    <>
                      {attachments && attachments.images.length > 0 && (
                        <AttachedImageGallery paths={attachments.images} />
                      )}
                      {attachments && attachments.files.length > 0 && (
                        <AttachedFileChips
                          files={attachments.files}
                          className={!attachments.display ? "mb-0" : undefined}
                        />
                      )}
                      {attachments?.display ?? m.text}
                    </>
                  ) : (
                    <>
                      {m.attachments?.length ? (
                        <AttachedImageGallery
                          paths={m.attachments.map((attachment) => attachment.path)}
                          className={m.text ? "justify-start" : "mb-0 justify-start"}
                        />
                      ) : null}
                      {m.text ? (
                        // F5-T3: a member's file link is offered to the media
                        // resolver under that member's own room-task scope,
                        // so a take it rendered into the room's workspace gets
                        // a player. A message with no named sender keeps the
                        // plain Save a copy link.
                        <ChatMarkdown text={m.text} scope={m.from?.botId ? { botId: m.from.botId, threadId: group.threadId } : undefined} />
                      ) : null}
                      {m.withheldFromBots && (
                        <div className="mt-1 text-[11px] text-ink-secondary/70">{m.withheldFromBots === "forgotten" ? "Bots no longer see this reply: you chose to forget it." : "Bots no longer see this reply: it used something you deleted or changed."}</div>
                      )}
                    </>
                  )}
                </div>
                {/* the other side of the same hover-only rail */}
                <div className="max-md:hidden md:contents">
                {!user && (
                  <>
                    {m.text && speaks(m) && (
                      <SpeakButton text={m.text} botId={m.from?.botId} messageId={m.id} voiceId={speaks(m)?.voice} />
                    )}
                    {markOwner(m) && <OutcomeRailButtons bot={markOwner(m)!} botId={markOwner(m)!.id} messageId={m.id} message={m} />}
                    <button
                      type="button"
                      onClick={() => onReply(m)}
                      aria-label="Reply to message"
                      title="Reply"
                      className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <MessageSquareReply size={14} />
                    </button>
                    <PinToggle group={group} message={m} />
                  </>
                )}
                </div>
                <span className="self-end pb-1 text-[11px] tabular-nums text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100 max-md:hidden">
                  {formatTime(m.at)}
                </span>
              </div>
              {!user && markOwner(m) && <MessageOutcome messageId={m.id} />}
              {!user && markOwner(m) && <MessageChip messageId={m.id} botName={markOwner(m)!.name} />}
              {/* The hover rail's two controls, as words, in the thumb zone.
                  Same pair and same order as the rail above — a channel row
                  offers Reply and Pin, so the sheet offers exactly those. */}
              <MessageActionSheet
                open={sheetFor === m.id}
                onClose={() => setSheetFor(null)}
                heading={`${user ? "You" : (m.from?.name ?? "Bot")} \u00b7 ${formatTime(m.at)}`}
                actions={roomActions(m)}
              />
            </div>
          ) : null;
        if (!row) return null;
        shownPrev = m;
        const replyTo = actor === "bot" && m.from && newTurn ? shownReplyTo(m.id, prev) : undefined;
        return (
          <div key={m.id} data-row={m.id} className="transcript-row flex flex-col gap-3" data-mid={m.id}>
            {newDay && (
              <div data-day-separator="" className="py-3 text-center text-[13px] text-ink-secondary">
                {dayLabel(m.at)} {formatTime(m.at)}
              </div>
            )}
            {actor === "bot" && !errorRow && m.from && newTurn && (
              <RoomSpeakerLabel
                bot={memberOf(m.from.botId)}
                name={m.from.name}
                color={m.from.color}
                replyTo={replyTo}
                onJump={replyTo ? () => jumpTo(replyTo) : undefined}
              />
            )}
            {actor === "routine" && <span className="text-[12px] text-ink-secondary">Routine</span>}
            {actor === "person" && <span className="text-[12px] text-ink-secondary">Person</span>}
            {row}
          </div>
        );
      })}
    </>
  );
});

function DefaultResponderSelect({ group, members }: { group: Group; members: Bot[] }) {
  const { dispatch } = useStore();
  const responder = effectiveDefaultResponder(group, members);
  const value = responder.kind === "member" ? `member:${responder.botId}` : responder.kind;
  const lead = responder.kind === "member" ? members.find((member) => member.id === responder.botId) : undefined;
  const title =
    responder.kind === "everyone"
      ? "Plain messages go to every channel member; @mentions override this"
      : responder.kind === "mentions"
        ? "Only explicitly @mentioned bots respond"
        : `Plain messages go to ${lead?.name ?? "the lead bot"}; @mentions override this`;

  const change = (nextValue: string) => {
    let next: GroupDefaultResponder;
    if (nextValue === "everyone") next = { kind: "everyone" };
    else if (nextValue === "mentions") next = { kind: "mentions" };
    else next = { kind: "member", botId: nextValue.slice("member:".length) };
    dispatch({ type: "patchGroup", groupId: group.id, patch: { defaultResponder: next } });
  };

  return (
    <div className="relative shrink-0" title={title}>
      <select
        aria-label="Default responder"
        value={value}
        onChange={(event) => change(event.target.value)}
        className="h-8 max-w-[190px] appearance-none truncate rounded-full border border-hairline/40 bg-raised/60 py-1 pl-3 pr-7 text-[12.5px] font-medium text-ink outline-none hover:bg-raised focus:border-accent"
      >
        <optgroup label="Channel lead">
          {members.map((member) => (
            <option key={member.id} value={`member:${member.id}`}>
              Lead: {member.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="Channel behavior">
          <option value="everyone">Everyone responds</option>
          <option value="mentions">Only when mentioned</option>
        </optgroup>
      </select>
      <ChevronDown
        size={13}
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-secondary"
      />
    </div>
  );
}

/** The room's shared desk: where every member's shell and file tools run,
 * overriding each bot's own folder for room turns. The room pins its own
 * copy on its first turn (the server does the pinning — engines key their
 * sessions to the folder a thread starts in, so a folder must not move
 * under a room that already worked somewhere). The PATCH is made directly
 * rather than through patchGroup: the server validates the path and a
 * rejected folder must not stick in local state. */
function RoomWorkingFolder({ group }: { group: Group }) {
  const { capabilities } = useDesktopCapabilities();
  const { state } = useStore();
  const home = capabilities.host.homeDir;
  // FUIGOTRUST4 (3): the trust note describes the room's Fuigo members —
  // each member's turn reads its own instance's store and route — never the
  // first Fuigo instance's as if it were the room's
  const fuigoMembers = useMemo(
    () =>
      group.memberIds
        .map((id) => state.bots.find((b) => b.id === id))
        .filter((b): b is Bot => Boolean(b) && state.instances.some((i) => i.instanceId === b!.modelSelection.instanceId && i.driverKind === "fuigoAgent"))
        .map((b) => ({ id: b.id, name: b.name })),
    [group.memberIds, state.bots, state.instances],
  );
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.muragebox?.pickFolder);
  const pinned = group.pinnedCwd; // undefined = not yet, null = each bot's own, string = folder
  const locked = pinned !== undefined;
  const shownCwd = locked ? (pinned ?? undefined) : group.cwd;

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.muragebox?.pickFolder?.(group.cwd);
    if (chosen) void save(chosen);
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Working folder</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">Where every bot in this channel runs its shell and file tools.</div>
      {locked ? (
        <div className="mt-3">
          <div className="truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={shownCwd}>
            {shownCwd ? shortPath(shownCwd, home) : <span className="text-ink-secondary">Each bot's own folder</span>}
          </div>
          <div className="mt-2 text-[12px] text-ink-secondary">
            Fixed for this task after its first turn. Start a new task to work somewhere else.
          </div>
        </div>
      ) : canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={group.cwd}>
            {group.cwd ? shortPath(group.cwd, home) : <span className="text-ink-secondary">Each bot's own folder</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} /> Choose…
          </button>
          {group.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              Clear
            </button>
          )}
        </div>
      ) : (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            // an emptied field clears the folder — the server wants null
            void save((draft ?? group.cwd ?? "").trim() || null);
          }}
        >
          <input
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 font-mono text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
            placeholder="Each bot's own folder, or an absolute path"
            value={draft ?? group.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            Save
          </button>
        </form>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      <FolderTrustNote folder={shownCwd} members={fuigoMembers} />
    </div>
  );
}

/** The folder this room's turns run in — the pinned folder once a turn ran,
 * else the room folder a first turn would pin. Always present so the desk
 * is settable before any folder exists; quiet (icon only) until then. */
function RoomWorkingFolderChip({ group, onToggle }: { group: Group; onToggle: () => void }) {
  const folder = group.pinnedCwd === undefined ? group.cwd : (group.pinnedCwd ?? undefined);
  if (!folder) {
    return (
      <button
        onClick={onToggle}
        className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
        title="Channel working folder"
      >
        <Folder size={14} />
      </button>
    );
  }
  const name = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
  return (
    <button
      onClick={onToggle}
      className="flex max-w-[180px] items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
      title={`Working folder: ${folder}`}
    >
      <Folder size={12} />
      <span className="truncate font-mono">{name}</span>
    </button>
  );
}


type RoomSetupFields = {
  setupPending?: boolean;
  setupRequired?: boolean;
  setupState?: "required" | "completed" | "skipped";
  setupCompletedAt?: number | string | null;
  setupSkippedAt?: number | string | null;
};

type RoomResponderMode = "lead" | "everyone" | "mentions";

function setupResponderMode(responder: GroupDefaultResponder): RoomResponderMode {
  return responder.kind === "member" || responder.kind === "auto" ? "lead" : responder.kind;
}

function roomNeedsSetup(group: Group): boolean {
  if (group.dm || group.messages.length > 0) return false;
  // SAFETY: setup fields are additive server metadata; the existing Group shape remains valid when absent.
  const marker = group as Group & RoomSetupFields;
  const hasSetupMarker =
    Object.prototype.hasOwnProperty.call(marker, "setupCompletedAt") ||
    Object.prototype.hasOwnProperty.call(marker, "setupSkippedAt");
  // Legacy empty rooms omit both keys and remain immediately usable.
  if (!hasSetupMarker) return false;
  if (
    marker.setupPending === false ||
    marker.setupRequired === false ||
    marker.setupState === "completed" ||
    marker.setupState === "skipped" ||
    marker.setupCompletedAt != null ||
    marker.setupSkippedAt != null
  ) {
    return false;
  }
  return true;
}

function RoomSetup({ group, members }: { group: Group; members: Bot[] }) {
  const { dispatch } = useStore();
  const [folder, setFolder] = useState(group.cwd ?? "");
  const [behavior, setBehavior] = useState<RoomResponderMode>(setupResponderMode(group.defaultResponder));
  const [leadId, setLeadId] = useState(
    group.defaultResponder.kind === "member" ? group.defaultResponder.botId : members[0]?.id ?? "",
  );
  const [instructions, setInstructions] = useState(group.bulletin);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leadPickerOpen, setLeadPickerOpen] = useState(false);
  const leadPickerRef = useRef<HTMLDivElement>(null);
  const selectedLead = members.find((member) => member.id === leadId) ?? members[0];

  useEffect(() => {
    if (!leadPickerOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!leadPickerRef.current?.contains(event.target as Node)) setLeadPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLeadPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [leadPickerOpen]);

  const responder = (): GroupDefaultResponder => {
    if (behavior === "everyone") return { kind: "everyone" };
    if (behavior === "mentions") return { kind: "mentions" };
    return members.some((member) => member.id === leadId)
      ? { kind: "member", botId: leadId }
      : group.defaultResponder;
  };

  const finish = async (action: "complete" | "skip") => {
    setLeadPickerOpen(false);
    setSaving(true);
    setError(null);
    try {
      const payload =
        action === "skip"
          ? { action }
          : {
              action,
              cwd: folder.trim() || null,
              defaultResponder: responder(),
              bulletin: instructions,
            };
      const result = await api(`/api/groups/${group.id}/setup`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const now = Date.now();
      const nextGroup = {
        ...(result.group ?? group),
        id: group.id,
        setupPending: false,
        ...(action === "skip" ? { setupSkippedAt: now } : { setupCompletedAt: now }),
      };
      dispatch({ type: "groupPatched", group: nextGroup });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const pickFolder = async () => {
    const chosen = await window.muragebox?.pickFolder?.(folder || group.cwd);
    if (chosen) setFolder(chosen);
  };

  return (
    <section
      data-testid="room-setup"
      aria-labelledby="room-setup-title"
      className="relative z-20 w-full overflow-visible rounded-3xl border border-hairline/50 bg-card shadow-xl shadow-black/10"
    >
      <div className="rounded-t-3xl border-b border-hairline/40 bg-panel/70 px-5 py-5 sm:px-7">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-sm font-bold text-white">1</span>
          <div>
            <h1 id="room-setup-title" className="text-xl font-semibold tracking-tight text-ink">Set up {group.name}</h1>
            <p className="mt-1 max-w-[560px] text-[13.5px] leading-relaxed text-ink-secondary">
              Give this channel a shared workspace, response style, and a little context before the first conversation starts.
            </p>
          </div>
        </div>
      </div>
      <form
        className="space-y-5 px-5 py-5 sm:px-7 sm:py-6"
        onSubmit={(event) => {
          event.preventDefault();
          void finish("complete");
        }}
      >
        <label className="block">
          <span className="text-[13px] font-semibold text-ink">Working folder</span>
          <span className="mt-1 block text-[12px] text-ink-secondary">Where channel members run file and shell tools. {t("folderTrust.pickerNote")}</span>
          <div className="mt-2 flex gap-2">
            <input
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              placeholder="Each bot's own folder"
              className="min-w-0 flex-1 rounded-xl border border-hairline/50 bg-inset px-3 py-2.5 font-mono text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none"
            />
            {window.muragebox?.pickFolder && (
              <button
                type="button"
                onClick={() => void pickFolder()}
                disabled={saving}
                className="flex shrink-0 items-center gap-1.5 rounded-xl border border-hairline/50 bg-raised px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                <FolderOpen size={14} /> Choose
              </button>
            )}
          </div>
        </label>

        <fieldset className="block">
          <legend className="text-[13px] font-semibold text-ink">Default responder</legend>
          <p className="mt-1 text-[12px] text-ink-secondary">Choose who answers when nobody is mentioned.</p>
          <div role="radiogroup" aria-label="Default responder" className="mt-2 grid gap-2 sm:grid-cols-3">
            <div ref={leadPickerRef} className="relative min-w-0">
              <button
                type="button"
                role="radio"
                aria-checked={behavior === "lead"}
                aria-haspopup="listbox"
                aria-expanded={behavior === "lead" && leadPickerOpen}
                onClick={() => {
                  setBehavior("lead");
                  setLeadPickerOpen((open) => !open);
                }}
                disabled={saving}
                className={cn(
                  "flex min-h-[72px] w-full flex-col items-start justify-between rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
                  behavior === "lead"
                    ? "border-accent bg-accent/10 text-ink ring-1 ring-accent/30"
                    : "border-hairline/50 bg-inset text-ink-secondary hover:border-hairline hover:bg-raised",
                )}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-[13px] font-semibold">
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border",
                        behavior === "lead" ? "border-accent bg-accent" : "border-ink-secondary/60",
                      )}
                    >
                      {behavior === "lead" && <span className="size-1.5 rounded-full bg-white" />}
                    </span>
                    Specific lead
                  </span>
                  <ChevronDown
                    size={14}
                    aria-hidden="true"
                    className={cn("shrink-0 text-ink-secondary transition-transform", leadPickerOpen && "rotate-180")}
                  />
                </span>
                <span className="ml-6 mt-2 truncate text-[11.5px] text-ink-secondary">
                  {selectedLead?.name ?? "Choose a teammate"}
                </span>
              </button>
              {behavior === "lead" && leadPickerOpen && (
                <div
                  role="listbox"
                  aria-label="Choose a lead"
                  className="absolute left-0 top-full z-30 mt-2 w-72 max-w-[calc(100vw-3rem)] overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl shadow-black/20"
                >
                  <div className="border-b border-hairline/40 px-3 py-2.5">
                    <div className="text-[12.5px] font-semibold text-ink">Choose a lead</div>
                    <div className="mt-0.5 text-[11.5px] text-ink-secondary">Plain messages go to this teammate.</div>
                  </div>
                  <div className="max-h-48 overflow-y-auto p-1.5">
                    {members.map((member) => {
                      const selected = member.id === leadId;
                      return (
                        <button
                          key={member.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            setLeadId(member.id);
                            setLeadPickerOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition",
                            selected ? "bg-accent/10" : "hover:bg-raised",
                          )}
                        >
                          <BotAvatar
                            bot={member}
                            state={normalizeState(member.mascotExpression) ?? "happy"}
                            size={24}
                            animated={false}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-ink">{member.name}</span>
                            <span className="block truncate text-[11px] text-ink-secondary">{member.title}</span>
                          </span>
                          {selected && <Check size={15} className="shrink-0 text-accent" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              role="radio"
              aria-checked={behavior === "everyone"}
              onClick={() => {
                setBehavior("everyone");
                setLeadPickerOpen(false);
              }}
              disabled={saving}
              className={cn(
                "flex min-h-[72px] w-full flex-col items-start justify-between rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
                behavior === "everyone"
                  ? "border-accent bg-accent/10 text-ink ring-1 ring-accent/30"
                  : "border-hairline/50 bg-inset text-ink-secondary hover:border-hairline hover:bg-raised",
              )}
            >
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    behavior === "everyone" ? "border-accent bg-accent" : "border-ink-secondary/60",
                  )}
                >
                  {behavior === "everyone" && <span className="size-1.5 rounded-full bg-white" />}
                </span>
                Everyone responds
              </span>
              <span className="ml-6 mt-2 text-[11.5px] text-ink-secondary">All channel members</span>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={behavior === "mentions"}
              onClick={() => {
                setBehavior("mentions");
                setLeadPickerOpen(false);
              }}
              disabled={saving}
              className={cn(
                "flex min-h-[72px] w-full flex-col items-start justify-between rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
                behavior === "mentions"
                  ? "border-accent bg-accent/10 text-ink ring-1 ring-accent/30"
                  : "border-hairline/50 bg-inset text-ink-secondary hover:border-hairline hover:bg-raised",
              )}
            >
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    behavior === "mentions" ? "border-accent bg-accent" : "border-ink-secondary/60",
                  )}
                >
                  {behavior === "mentions" && <span className="size-1.5 rounded-full bg-white" />}
                </span>
                Only when mentioned
              </span>
              <span className="ml-6 mt-2 text-[11.5px] text-ink-secondary">Only @mentioned members</span>
            </button>
          </div>
        </fieldset>

        <label className="block">
          <span className="text-[13px] font-semibold text-ink">Channel instructions</span>
          <span className="mt-1 block text-[12px] text-ink-secondary">A shared brief every member sees on each turn. You can edit it later.</span>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={5}
            placeholder="Goals, tone, ownership, constraints…"
            className="mt-2 w-full resize-y rounded-xl border border-hairline/50 bg-inset px-3 py-2.5 text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none"
          />
        </label>

        {error && <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => void finish("skip")}
            disabled={saving}
            className="rounded-xl px-3 py-2 text-left text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
          >
            Skip for now
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            Save & continue
          </button>
        </div>
      </form>
    </section>
  );
}
/** The five things you can do to a channel from its own header. Everything
 * else in the header is a setting; these change what the channel IS, so they
 * sit together behind one control rather than spreading more icons across a
 * row that is already full. */
function ChannelHeaderMenu({
  group,
  onDetails,
  onMakeProject,
  onCloseProject,
  onEndProject,
  onRename,
  onArchive,
  onDelete,
  onClose,
}: {
  group: Group;
  onDetails: () => void;
  onMakeProject: () => void;
  onCloseProject?: () => void;
  onEndProject?: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onDown = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-channel-menu]")) onClose();
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const row = "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70";
  const act = (run: () => void) => () => {
    onClose();
    run();
  };
  const noun = channelNoun(group);
  return (
    <div
      data-channel-menu
      role="menu"
      aria-label={`More actions for ${group.name}`}
      className="absolute right-0 top-full z-40 mt-1 w-[232px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
      ref={menuRef}
    >
      <button type="button" role="menuitem" onClick={act(onDetails)} className={row}>
        <Info size={16} className="text-ink-secondary" />
        Channel details
      </button>
      {onCloseProject && <button type="button" role="menuitem" onClick={act(onCloseProject)} className={row}>Close project</button>}
      {onEndProject && <button type="button" role="menuitem" onClick={act(onEndProject)} className={row}>End project</button>}
      {!group.channelProject && (
        <button type="button" role="menuitem" onClick={act(onMakeProject)} className={row}>
          <Target size={16} className="text-ink-secondary" />
          Make this a project
        </button>
      )}
      <button type="button" role="menuitem" onClick={act(onRename)} className={row}>
        <Pencil size={16} className="text-ink-secondary" />
        Rename
      </button>
      <button type="button" role="menuitem" onClick={act(onArchive)} className={row}>
        <Archive size={16} className="text-ink-secondary" />
        Archive
      </button>
      <button type="button" role="menuitem" onClick={act(onDelete)} className={`${row} text-danger`}>
        <Trash2 size={16} />
        Delete {noun}
      </button>
    </div>
  );
}

/** Renaming in a dialog rather than in place: the header name is a truncated
 * strip that a long name cannot be read in, let alone edited. */
function RenameChannelDialog({ group, onClose }: { group: Group; onClose: () => void }) {
  const { dispatch } = useStore();
  const [draft, setDraft] = useState(group.name);
  const save = () => {
    const name = draft.trim();
    if (name && name !== group.name) dispatch({ type: "patchGroup", groupId: group.id, patch: { name } });
    onClose();
  };
  return (
    <div
      className="overlay-inset fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-3"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-channel-title"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
        className="w-[340px] max-w-[calc(100vw-1.5rem)] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl"
      >
        <div id="rename-channel-title" className="mb-3 text-[15px] font-semibold text-ink">
          Rename {channelNoun(group)}
        </div>
        <input
          autoFocus
          value={draft}
          maxLength={100}
          aria-label="Name"
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => event.key === "Escape" && onClose()}
          className="w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-lg bg-raised py-2 text-[14px] font-medium text-ink hover:brightness-110">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!draft.trim()}
            className="flex-1 rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

/** Making a channel a project asks for ONE thing, because everything else
 * already exists: the chat, the bots, the instructions and the folder all
 * stay exactly as they are. The only thing a channel never had is a goal. */
function MakeProjectDialog({ group, onClose, onMade }: { group: Group; onClose: () => void; onMade: () => void }) {
  const { dispatch } = useStore();
  const [goal, setGoal] = useState("");
  const save = () => {
    const trimmed = goal.trim();
    if (!trimmed) return;
    dispatch({ type: "patchGroup", groupId: group.id, patch: { channelProject: { goal: trimmed } } });
    onMade();
    onClose();
  };
  return (
    <div
      className="overlay-inset fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-3"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="make-project-title"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
        className="w-[420px] max-w-[calc(100vw-1.5rem)] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl"
      >
        <div id="make-project-title" className="text-[15px] font-semibold text-ink">
          Make {group.name} a project
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
          The chat, the bots, the instructions and the folder all stay. Say what the work is for and it gets a home page.
        </p>
        <label htmlFor="make-project-goal" className="mt-3 block text-[13px] font-semibold text-ink">
          What are you trying to get done?
        </label>
        <textarea
          id="make-project-goal"
          autoFocus
          value={goal}
          maxLength={CHANNEL_PROJECT_GOAL_MAX}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save();
          }}
          rows={4}
          placeholder="For example: Get the new website open in time for the spring."
          className="mt-2 w-full resize-y rounded-xl border border-hairline/40 bg-inset px-3 py-2.5 text-[14px] leading-relaxed text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none"
        />
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-lg bg-raised py-2 text-[14px] font-medium text-ink hover:brightness-110">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!goal.trim()}
            className="flex-1 rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            Make it a project
          </button>
        </div>
      </form>
    </div>
  );
}

export function GroupView({ group }: { group: Group }) {
  const { state, dispatch } = useStore();
  // Conversation order from parent links, not arrival order: hosted-tool
  // text saved in front of its row arrives after it (room-transcript.ts).
  // Everything below (window, focus, follow, replies) reads this order.
  const roomMessages = useMemo(() => roomTranscript(group.messages), [group.messages]);
  const stream = useStreaming();
  const roomHelpers = group.busyBotId
    ? pickSubtasks(stream.helpers.live[group.threadId], group.tasks?.find((task) => task.threadId === group.threadId)?.subtasks)
    : [];
  const streaming = stream.streaming[group.threadId];
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad();
  // Where an active call's full-screen view portals to (src/lib/call-slot.ts).
  const callSlotRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    registerCallSlot(callSlotRef.current);
    return () => registerCallSlot(null);
  }, []);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const previousScrollTop = useRef(0);
  const touchY = useRef(0);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [instructionsDraft, setInstructionsDraft] = useState(group.bulletin);
  const [folderOpen, setFolderOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [detailsSection, setDetailsSection] = useState<ChannelDetailsSection | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [makeProjectOpen, setMakeProjectOpen] = useState(false);
  const desktop = useDesktopSurface();
  const [lifecycleDialog, setLifecycleDialog] = useState<"close"|"end"|null>(null);
  const [lifecycleError, setLifecycleError] = useState("");
  const [reopening, setReopening] = useState(false);
  const [reopenedNotice, setReopenedNotice] = useState<{pausedRoutines:string[];resumeHint:string}|null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A project keeps its chat. The tab only decides which of the two the
  // person is looking at; nothing about the channel changes with it. A
  // project opens on its chat, or on whichever tab the owner last left it
  // on (src/lib/project-tab.ts); this view remounts per channel, so the
  // choice is read back rather than held here.
  const [projectTab, setProjectTab] = useState<ProjectTab>(() => loadProjectTab(group.id));
  const chooseProjectTab = useCallback((tab: ProjectTab) => {
    setProjectTab(tab);
    saveProjectTab(group.id, tab);
  }, [group.id]);
  const detailsTriggerRef = useRef<HTMLButtonElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const closeDetails = useCallback(() => setDetailsSection(null), []);
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useReplyDraft(
    group.threadId,
    `group:${group.id}:${group.threadId}`,
    roomMessages,
  );
  const membersTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMembers = useCallback(() => setMembersOpen(false), []);
  useEffect(() => setFindOpen(false), [group.threadId]);
  // Every panel and dialog belongs to the channel that was on screen when it
  // opened. Moving to another one closes them all rather than leaving a
  // dialog pointed at a channel the person has walked away from.
  useEffect(() => {
    setDetailsSection(null);
    setMenuOpen(false);
    setRenameOpen(false);
    setMakeProjectOpen(false);
    setLifecycleDialog(null);
    setLifecycleError("");
    setReopenedNotice(null);
    setConfirmDelete(false);
    setProjectTab(loadProjectTab(group.id));
  }, [group.id]);
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  const members = useMemo(
    () => group.memberIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b)),
    [group.memberIds, state.bots],
  );
  const speaker = members.find((b) => b.id === group.busyBotId);
  const outcomes = useRoomOutcomes(group.memberIds, group.threadId, Boolean(group.busyBotId));
  // A memory chip can arrive under an older reply while the reader is looking
  // elsewhere: hold the row they are on so the view does not move (as ChatView).
  const chipAnchor = useRef<ScrollAnchor | null>(null);
  const chips = useRoomChips(group.memberIds, group.threadId, Boolean(group.busyBotId), {
    before: () => {
      const el = scrollRef.current;
      chipAnchor.current = el && !followRef.current ? captureViewportAnchor(el, transcriptKey) : null;
    },
  });
  const proposalBot = members.find((member) => member.id === outcomes.proposal?.botId);
  const setupPending = roomNeedsSetup(group);
  // An ordinary channel is always its chat. A project has an overview in
  // front of the same chat, and everything that belongs to the transcript —
  // the instructions strip, the folder card, the pinned message, the
  // composer — belongs to the chat, not to the overview.
  const shownProjectTab = projectViewTab({ remembered: projectTab, setupPending });
  const projectSurface = projectSurfaceEnabled(state.config) && !group.dm;
  const project = useProject(group.id, projectSurface && !!group.channelProject);
  const activeTab = projectSurface ? ((!group.channelProject && ["board", "overview", "activity"].includes(shownProjectTab)) || (shownProjectTab === "board" && (state.config?.features?.projectsBoard === false || project?.settings.parts.board === false)) ? "chat" : shownProjectTab) : group.channelProject && shownProjectTab === "overview" ? "overview" : "chat";
  const showChat = activeTab === "chat";
  const visitCounts = useProjectVisit(group.id, projectSurface && !!group.channelProject);
  // The pinned message may be older than the held page (upstream #1527).
  const pinnedMessage = useMessageById(group.threadId, group.pinnedMessageId || undefined, roomMessages);

  // Mascot stays while a member works; the finished reply pops in above it.
  const lastGroupMessage = roomMessages.at(-1);
  const toolInFlight = lastGroupMessage?.kind === "activity" && lastGroupMessage.tool?.ok === undefined;
  const activityLabel = liveActivityLabel(lastGroupMessage);
  const waiting = Boolean(
    speaker && showWorkingDots(true, roomMessages.at(-1), speaker.id),
  );
  const popping = useReplyPop(`${group.id}:${group.threadId}`, lastGroupMessage, waiting);
  // A team-goal routine waiting on the person: its card, not "Thinking".
  const waitingRun = channelWaitingRun(state.routineRuns, group);
  const presenceVisible = (waiting && !(waitingRun && waitingRun.botId === speaker?.id)) || popping !== null;
  const poppingMessage = popping ? roomMessages.find((message) => message.id === popping.id) : undefined;
  // Unknown speaker: the neutral mascot below, never the first member's.
  const presenceSpeaker = speaker ?? members.find((member) => member.id === popping?.botId);
  // Name the live row only after its bot: the members[0] fallback is a
  // mascot, not a claim about who is speaking. A popped answer is named
  // after its own author, even once the next member has started working.
  const presenceName = popping
    ? poppingMessage?.from?.name ?? members.find((member) => member.id === popping.botId)?.name
    : speaker?.name;

  // Windowed transcript, mirroring ChatView: only a tail of the room mounts;
  // the anchored boundary re-tails on a render-phase reset when the room (or
  // its thread) changes. Working dots below stay on the FULL list's tail.
  const transcriptKey = `${group.id}:${group.threadId}`;
  // `firstId`: see ChatView — the boundary moves with the rows when a page of
  // older messages lands in front of them (upstream #1527).
  const firstMessageId = roomMessages[0]?.id;
  // Row anchor captured before a reader-initiated expand or page (see
  // showEarlier/loadOlder below). Declared here because a pending capture is
  // also how the window tells the page the reader asked for from the pages a
  // jump walks through.
  const preExpandAnchor = useRef<ScrollAnchor | null>(null);
  const [transcriptWindow, setTranscriptWindow] = useState<{
    key: string;
    start: number;
    end: number | null;
    firstId?: string;
  }>(() => ({
    key: transcriptKey,
    start: tailWindowStart(roomMessages.length),
    end: null,
    firstId: firstMessageId,
  }));
  if (transcriptWindow.key !== transcriptKey) {
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(roomMessages.length), end: null, firstId: firstMessageId });
  } else if (transcriptWindow.firstId !== firstMessageId) {
    const shift = transcriptWindow.firstId ? roomMessages.findIndex((message) => message.id === transcriptWindow.firstId) : -1;
    const reveal = preExpandAnchor.current?.key === transcriptKey;
    const moved = windowAfterPrepend(transcriptWindow, shift, reveal);
    setTranscriptWindow({ ...(reveal ? capRevealedWindow(moved, roomMessages.length) : moved), firstId: firstMessageId });
  }
  const {
    visible: windowedMessages,
    hiddenCount,
    laterCount,
    startIndex,
  } = useMemo(
    () => resolveTranscriptWindow(roomMessages, transcriptWindow.start, TRANSCRIPT_WINDOW_SIZE, transcriptWindow.end),
    [roomMessages, transcriptWindow.start, transcriptWindow.end],
  );

  const setBottomFollow = useCallback((next: boolean) => {
    followRef.current = next;
    setFollow(next);
  }, []);

  useEffect(() => setBottomFollow(true), [group.id, setBottomFollow]);
  // Observed only while the Chat tab's transcript is mounted: a project room
  // can open on Overview, and a key that did not change on the switch to Chat
  // left the new transcript unobserved, so a Thinking row or a streaming
  // reply grew in under the composer.
  useBottomFollowResize(scrollRef, transcriptRef, followRef, setupPending || !showChat ? null : transcriptKey);

  const appliedFocus = useRef<number | null>(null);
  const revealedFocus = useRef<number | null>(null);
  useEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== group.threadId || appliedFocus.current === focus.nonce) return;
    if (revealedFocus.current !== focus.nonce) {
      revealedFocus.current = focus.nonce;
      chooseProjectTab("chat");
    }
    const targetIndex = roomMessages.findIndex((message) => message.id === focus.messageId);
    if (targetIndex < 0) return;
    appliedFocus.current = focus.nonce;
    const range = focusWindowRange(roomMessages.length, targetIndex);
    setBottomFollow(false);
    setTranscriptWindow({ key: transcriptKey, ...asLiveTail(range, roomMessages.length) });
  }, [roomMessages, group.threadId, setBottomFollow, state.focusMessage, transcriptKey, chooseProjectTab]);
  useFocusMessage(group.threadId, roomMessages.length > 0);
  // A followed live tail stays within MAX_MOUNTED_ROWS (transcript-window.ts).
  useEffect(() => {
    setTranscriptWindow((w) => {
      const next = trimFollowedTail(w, roomMessages.length, followRef.current);
      return next === w ? w : { ...w, ...next };
    });
  }, [roomMessages.length, transcriptKey]);
  // Rows the reader has seen may skip layout off screen (styles.css).
  useEffect(() => {
    if (!transcriptRef.current || !scrollRef.current) return;
    return observeSeenRows(transcriptRef.current, scrollRef.current);
  }, [windowedMessages]);

  useEffect(() => setInstructionsDraft(group.bulletin), [group.id, group.bulletin]);
  // an open folder editor belongs to the room it was opened in
  useEffect(() => setFolderOpen(false), [group.id]);
  useEffect(() => setMembersOpen(false), [group.id]);
  // deps track the FULL messages.length, so expanding the window (which only
  // changes windowedMessages) can never re-trigger this bottom scrollTo.
  // `follow` is intentionally omitted — see ChatView.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
  }, [group.id, roomMessages.length, streaming, group.busyBotId, group.working, composerDock.pad, showChat]);

  // Rows move in and out around the reader; a surviving row is kept where it
  // was (transcript-rows.ts, and see ChatView). The capture belongs to the
  // thread it was taken in, and with no row mounted still records that the
  // reader asked.
  const captureAnchor = (edge: "first" | "last") => {
    const el = scrollRef.current;
    preExpandAnchor.current = el ? captureRowAnchor(el, transcriptKey, edge) ?? { key: transcriptKey, id: "", offset: 0 } : null;
  };
  const restoreAnchor = () => {
    const el = scrollRef.current;
    const captured = preExpandAnchor.current;
    if (!captured || !el) return;
    preExpandAnchor.current = null;
    if (captured.key !== transcriptKey) return;
    restoreRowAnchor(el, captured);
    // keep the resume-follow heuristic from reading the restore as a
    // downward user scroll
    previousScrollTop.current = el.scrollTop;
  };
  const showEarlier = () => {
    captureAnchor("first");
    // expanding means reading scrollback — never let a mid-expand stream
    // event pin the viewport back to the bottom
    setBottomFollow(false);
    setTranscriptWindow((w) => ({ ...w, ...expandEarlier({ start: startIndex, end: w.end }, roomMessages.length) }));
  };
  useLayoutEffect(restoreAnchor, [transcriptWindow.start, transcriptWindow.end, transcriptKey]);

  // Scrollback across the network, as in ChatView (upstream #1527).
  const olderPending = Boolean(state.loadingOlder[group.threadId]);
  const loadOlder = () => {
    if (olderPending) return;
    captureAnchor("first");
    setBottomFollow(false);
    dispatch({ type: "loadOlderMessages", threadId: group.threadId });
  };
  useLayoutEffect(restoreAnchor, [firstMessageId, transcriptKey]);
  // The chip that was just attached grows one row: put the reader's row back where it was.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const held = chipAnchor.current;
    chipAnchor.current = null;
    if (!el || !held || held.key !== transcriptKey || !restoreRowAnchor(el, held)) return;
    previousScrollTop.current = el.scrollTop;
  }, [chips.byReply]);
  // A phone's slim boot page is topped up by the store, not by a click here
  // (scrollback needsNewestPage). Capture for it too, so its newest page
  // mounts and the viewport holds still exactly as for "Load earlier".
  // transcriptKey: switching back to a room whose top-up is still in flight
  // captures for it again.
  useLayoutEffect(() => {
    if (olderPending && !preExpandAnchor.current && needsNewestPage(group)) captureAnchor("first");
    if (!olderPending) preExpandAnchor.current = null;
  }, [olderPending, transcriptKey]);
  const reachedTop = () => {
    const el = scrollRef.current;
    if (!el || followRef.current || el.scrollTop > SCROLLBACK_TRIGGER_PX) return;
    if (hiddenCount > 0) showEarlier();
    else if (group.hasMore) loadOlder();
  };

  const showLater = () => {
    captureAnchor("last");
    setBottomFollow(false);
    setTranscriptWindow((w) => ({ ...w, ...expandLater({ start: w.start, end: w.end }, roomMessages.length) }));
  };

  // The end of a window that stops short of the newest row is not the end of
  // the conversation (see ChatView).
  const atLiveTail = transcriptWindow.end === null && laterCount === 0;
  const atEnd = () => {
    const el = scrollRef.current;
    if (!atLiveTail) return false;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;
  };

  const saveInstructions = () => {
    setInstructionsOpen(false);
    if (instructionsDraft !== group.bulletin) {
      dispatch({ type: "patchGroup", groupId: group.id, patch: { bulletin: instructionsDraft } });
    }
  };

  // Static embers: one per member, a ring + dot on whoever is working.
  const memberEmbers = members.map((b) => (
    <span
      key={b.id}
      title={`${b.name}${group.busyBotId === b.id ? " , working now" : ""}`}
      className={cn(
        "relative inline-flex rounded-full",
        group.busyBotId === b.id && "ring-2 ring-accent/50 ring-offset-1 ring-offset-app",
      )}
    >
      <BotAvatar bot={b} state={normalizeState(b.mascotExpression) ?? "happy"} size={24} animated={false} />
      {group.busyBotId === b.id && (
        <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full border border-app bg-accent" />
      )}
    </span>
  ));

  return (
    <OutcomesProvider value={outcomes}>
    <ChipsProvider value={chips}>
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Call mode is mounted once at Shell level (App.tsx), keyed to the
          group on the call rather than the selected view. Its full-screen
          view portals into this slot (src/lib/call-slot.ts), so it covers
          this column only, never the sidebar or side panels. */}
      <div ref={callSlotRef} className="pointer-events-none absolute inset-0" />
      {membersOpen && !group.dm && (
        <ManageMembersPanel group={group} onClose={closeMembers} triggerRef={membersTriggerRef} />
      )}
      {detailsSection && !group.dm && (
        <ChannelDetailsPanel
          group={group}
          initialSection={detailsSection}
          onClose={closeDetails}
          triggerRef={detailsTriggerRef}
        />
      )}
      {renameOpen && <RenameChannelDialog group={group} onClose={() => setRenameOpen(false)} />}
      {makeProjectOpen && !group.dm && (
        <MakeProjectDialog group={group} onClose={() => setMakeProjectOpen(false)} onMade={() => chooseProjectTab("overview")} />
      )}
      {desktop === true && lifecycleDialog === "close" && <LazyBoundary onRetry={CloseProject.retry}><Suspense fallback={<LazyFallback />}><CloseProject.Component returnFocusRef={menuTriggerRef} groupId={group.id} goalState={project?.goal?.state} onClose={() => setLifecycleDialog(null)} /></Suspense></LazyBoundary>}
      {desktop === true && lifecycleDialog === "end" && <LazyBoundary onRetry={EndProject.retry}><Suspense fallback={<LazyFallback />}><EndProject.Component returnFocusRef={menuTriggerRef} groupId={group.id} onClose={() => setLifecycleDialog(null)} /></Suspense></LazyBoundary>}
      {confirmDelete && (
        <ConfirmDelete
          name={group.name}
          kind={channelNoun(group)}
          preview={{ groupId: group.id }}
          detail={`Every message in ${group.name} goes with it. The bots stay.`}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            dispatch({ type: "deleteGroup", groupId: group.id });
          }}
        />
      )}
      {/* Header: static member embers; a ring + dot marks the working bot. */}
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2 px-5 py-3",
          // Below md the drawer button is the title row's first item, so the
          // row starts nearer the edge; the desktop keeps its px-5.
          "pl-3 md:pl-5",
          // Same status-bar inset as ChatView's header; calc() so the desktop
          // keeps py-3 when the inset is 0px.
          "pt-[calc(0.75rem+env(safe-area-inset-top))]",
        )}
      >
        <div className="flex min-w-0 basis-full items-center gap-2 md:basis-auto md:flex-1 md:min-w-[12rem]">
          {/* Phones only, on the title's own row (OpenBotListButton.tsx). */}
          <OpenBotListButton />
          <span className="truncate text-[15px] font-semibold text-ink">{group.name}</span>
          {!setupPending && !group.dm && <div className="min-w-0 max-w-[45%] shrink-0"><GroupTaskPicker group={group} /></div>}
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setFindOpen((open) => !open)}
            aria-label="Find in conversation"
            aria-pressed={findOpen}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              findOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={`Find in conversation (${modShortcut("F")})`}
          >
            <Search size={18} />
          </button>
          <GroupCallButton group={group} members={members} />
          {!setupPending && !group.dm && <RoomWorkingFolderChip group={group} onToggle={() => setFolderOpen((open) => !open)} />}
          {!setupPending && !group.dm && <DefaultResponderSelect group={group} members={members} />}
          {group.dm ? (
            memberEmbers
          ) : (
            // The roster lives where you already look to see who is in the
            // room; a dashed + says the row is editable without shouting.
            <button
              ref={membersTriggerRef}
              type="button"
              onClick={() => setMembersOpen(true)}
              title="Manage members"
              aria-label={`Manage members: ${members.length} ${members.length === 1 ? "bot" : "bots"} in this channel`}
              className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5 rounded-full py-0.5 pl-1 pr-1.5 hover:bg-raised/60"
            >
              {memberEmbers}
              <span className="flex size-[18px] items-center justify-center rounded-full border border-dashed border-hairline/70 text-ink-secondary">
                <Plus size={11} />
              </span>
            </button>
          )}
          {/* Details and the overflow menu. Everything a channel is — its
              instructions, its members, its files, what it remembers — used
              to be spread across the strip below and the faces above, and
              there was no way at all to rename, archive or delete a channel
              from inside it. These two controls are that way. */}
          {!group.dm && (
            <>
              <button
                ref={detailsTriggerRef}
                type="button"
                onClick={() => setDetailsSection("about")}
                aria-label={`Details for ${group.name}`}
                title="Details"
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <Info size={16} />
                <span className="max-md:hidden">Details</span>
              </button>
              <div className="relative">
                <button
                  ref={menuTriggerRef}
                  type="button"
                  onClick={() => setMenuOpen((open) => !open)}
                  aria-label={`More actions for ${group.name}`}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  title="More actions"
                  className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  <MoreHorizontal size={18} />
                </button>
                {menuOpen && (
                  <ChannelHeaderMenu
                    group={group}
                    onClose={() => {
                      setMenuOpen(false);
                      menuTriggerRef.current?.focus();
                    }}
                    onDetails={() => setDetailsSection("about")}
                    onMakeProject={() => setMakeProjectOpen(true)}
                    onCloseProject={desktop === true && project?.lifecycle === "open" && !project.closing ? () => setLifecycleDialog("close") : undefined}
                    onEndProject={desktop === true && project?.lifecycle === "open" && !project.closing ? () => setLifecycleDialog("end") : undefined}
                    onRename={() => setRenameOpen(true)}
                    onArchive={() => {
                      // Filed away, and the screen moves on with it: leaving
                      // the person looking at a channel that is no longer in
                      // the list would read as the archive having failed.
                      dispatch({ type: "patchGroup", groupId: group.id, patch: { hidden: true } });
                      const next = state.bots.find((bot) => !bot.hidden);
                      if (next) dispatch({ type: "select", id: next.id });
                    }}
                    onDelete={() => setConfirmDelete(true)}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {/* A call running elsewhere: a strip in the layout, not a floating
          bar over the composer (callbar-review.md I5). */}
      <CallBarStrip ownId={group.id} ownThreadId={group.threadId} />

      {/* A project's two faces. The chat is the channel's own transcript,
          unchanged; the overview is the only thing a plain channel lacks. */}
      {!projectSurface && group.channelProject && !setupPending && (
        <div role="tablist" aria-label={`${group.name} views`} className="flex gap-1 px-5 pb-1">
          {(["overview", "chat"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={shownProjectTab === tab}
              onClick={() => chooseProjectTab(tab)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-[13px]",
                shownProjectTab === tab ? "bg-accent/15 font-medium text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink",
              )}
            >
              {tab === "overview" ? "Overview" : "Chat"}
            </button>
          ))}
          <span className="ml-auto self-center text-[12.5px] text-ink-secondary">
            {channelProjectStatusLabel(group.channelProject.status)}
          </span>
        </div>
      )}

      {projectSurface && !setupPending && <>
        {/* The project header never takes more than about half the window:
            an expanded strip plus "Since you left" scrolls here, so the view
            tabs, the chat composer and the board keep their room on a phone
            and in a short window. */}
        <div className="max-h-[45dvh] min-h-0 shrink overflow-y-auto">
        {group.channelProject && <ProjectStrip project={project} title={group.channelProject.goal} groupId={group.id} onBoard={() => chooseProjectTab("board")} />}
        {group.channelProject && visitCounts && (visitCounts.messages > 0 || visitCounts.cards > 0 || visitCounts.decisions > 0) && <ProjectSinceYouLeftLazy counts={visitCounts} onBoard={() => chooseProjectTab("board")} boardEnabled={state.config?.features?.projectsBoard !== false && project?.settings.parts.board !== false} />}
        </div>
        <ProjectTabs isProject={!!group.channelProject} board={state.config?.features?.projectsBoard !== false && project?.settings.parts.board !== false} value={activeTab} onChange={chooseProjectTab} settingsOpen={menuOpen} onSettings={(trigger) => { menuTriggerRef.current = trigger; setMenuOpen((open) => !open); }} />
      </>}

      <ProjectLifecycleBanner closing={project?.closing === true} closed={project?.lifecycle === "closed"} leadName={state.bots.find(bot=>bot.id===project?.settings.leadBotId)?.name} reopening={reopening} reopened={reopenedNotice} onReopen={desktop === true ? async () => { setReopening(true); const result=await projectClient.reopen(group.id); if(result.ok) { setReopenedNotice({pausedRoutines:result.data.pausedRoutines,resumeHint:result.data.resumeHint}); await refreshProject(group.id); } else setLifecycleError(result.reason); setReopening(false); } : undefined} />
      {lifecycleError && <p role="alert" className="p-3 text-sm text-ink">{lifecycleError}</p>}
      {findOpen && <ChatFindBar threadId={group.threadId} onClose={() => setFindOpen(false)} />}
      {/* A channel never showed an error: a refused delete or rename in the
          conversation picker just did nothing. Same banner as a bot chat. */}
      {state.error && <ErrorBanner message={state.error} onDismiss={() => dispatch({ type: "error", message: null })} />}
      {state.deletionNote && <DeletionNoteBanner note={state.deletionNote} onDismiss={() => dispatch({ type: "deletionNote", note: null })} />}

      {/* Instructions: one pinned line; click to edit */}
      {!setupPending && showChat && <div className="w-full px-5">
        {instructionsOpen ? (
          <div className="mb-1 rounded-lg border border-hairline/40 bg-panel p-2">
            <textarea
              autoFocus
              value={instructionsDraft}
              onChange={(e) => setInstructionsDraft(e.target.value)}
              onBlur={saveInstructions}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveInstructions();
                if (e.key === "Escape") {
                  setInstructionsDraft(group.bulletin);
                  setInstructionsOpen(false);
                }
              }}
              placeholder="Channel instructions. Every bot in this channel follows them: who does what, the tone, what good looks like."
              rows={4}
              className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
        ) : (
          <button
            onClick={() => setInstructionsOpen(true)}
            className="mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-raised/40"
            title="Channel instructions, shared with every bot here"
          >
            <Pin size={12} className="shrink-0 text-ink-secondary" />
            <span className={cn("truncate text-[12.5px]", group.bulletin ? "text-ink-secondary" : "text-ink-secondary/60")}>
              {instructionsPreview(group.bulletin) || "Add channel instructions…"}
            </span>
          </button>
        )}
      </div>}

      {/* Working folder card — the chip in the header toggles it */}
      {!setupPending && showChat && folderOpen && !group.dm && (
        <div className="w-full px-5">
          <div className="mb-1">
            <RoomWorkingFolder group={group} />
          </div>
        </div>
      )}

      {/* Pinned message banner — resolves against the room's transcript, or
          reads the one row when it is older than the held page */}
      {(() => {
        if (!showChat) return null;
        const pinned = pinnedMessage?.kind === "text" ? pinnedMessage : undefined;
        const text = pinned ? (pinned.text ?? "").replace(/\s+/g, " ").trim() : "";
        if (!pinned || !text) return null;
        const sender = pinned.role === "user" ? "You" : (pinned.from?.name ?? "A bot");
        return (
          <div className="w-full px-5">
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.07] px-3 py-1.5">
              <Pin size={12} className="shrink-0 text-accent" />
              <button
                onClick={() => dispatch({ type: "focusMessage", threadId: group.threadId, messageId: pinned.id })}
                className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                title="Jump to the pinned message"
              >
                <span className="shrink-0 text-[11.5px] font-medium text-accent">{sender}</span>
                <span className="truncate text-[12.5px] text-ink-secondary">{text}</span>
              </button>
              <button
                onClick={() => dispatch({ type: "patchGroup", groupId: group.id, patch: { pinnedMessageId: "" } })}
                aria-label="Unpin message"
                title="Unpin"
                className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <X size={13} />
              </button>
            </div>
          </div>
        );
      })()}

      {!projectSurface && !showChat && group.channelProject && (
        <div className="relative min-h-0 flex-1">
          <ProjectHome
            group={group}
            members={members}
            onOpenChat={() => chooseProjectTab("chat")}
            onOpenDetails={() => setDetailsSection("about")}
          />
        </div>
      )}

      {projectSurface && !showChat && <ProjectViewBody tab={activeTab} group={group} members={members} project={project} />}

      {/* At least the docked composer plus one row, so the composer never
          rides up over the tabs and the header above it. */}
      {showChat && <div className="relative min-h-0 flex-1" style={{ minHeight: composerDock.height + 48 }}>
      <div
        ref={scrollRef}
        data-testid="chat-scroll"
        /* `px-5` is a desktop gutter; a phone gets a trim. Same change and the
           same reason as ChatView — src/e2e/transcript-width.human.spec.ts. */
        className="h-full overflow-x-hidden overflow-y-auto px-5 max-md:px-3 [overflow-anchor:none]"
        onWheel={(e) => {
          if (e.deltaY < 0) setBottomFollow(false);
          else if (atEnd()) setBottomFollow(true);
        }}
        onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0;
          if (y > touchY.current + 4) setBottomFollow(false);
          else if (atEnd()) setBottomFollow(true);
        }}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const scrollTop = el.scrollTop;
          const resume = shouldResumeBottomFollow({
            following: followRef.current,
            previousScrollTop: previousScrollTop.current,
            scrollTop,
            distanceFromBottom: el.scrollHeight - scrollTop - el.clientHeight,
          });
          previousScrollTop.current = scrollTop;
          if (resume && atLiveTail) setBottomFollow(true);
          else reachedTop();
        }}
      >
        {setupPending ? (
          <div className="flex min-h-full w-full items-center py-8">
            <RoomSetup group={group} members={members} />
          </div>
        ) : (
        <div
          className="flex w-full flex-col gap-3"
          style={{ paddingBottom: composerDock.pad }}
          ref={transcriptRef}
          role="log"
          aria-live="polite"
          aria-label={`Channel ${group.name}`}
        >
          {roomMessages.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
              <div className="flex -space-x-2">
                {members.slice(0, 3).map((b) => (
                  <BotAvatar
                    key={b.id}
                    bot={b}
                    state="happy"
                    size={44}
                    motion="none"
                    motionKey={0}
                    animated={false}
                  />
                ))}
              </div>
              <div className="text-[17px] font-semibold text-ink">{group.name}</div>
              <div className="max-w-[380px] text-[14px] text-ink-secondary">
                {groupResponseHint(group, members)}
              </div>
            </div>
          )}
          {hiddenCount > 0 ? (
            <div className="flex justify-center pt-2">
              <button
                onClick={showEarlier}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                Show earlier messages ({hiddenCount} more)
              </button>
            </div>
          ) : group.hasMore ? (
            <div className="flex justify-center pt-2">
              <button
                onClick={loadOlder}
                disabled={olderPending}
                data-testid="load-earlier"
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-60"
              >
                {olderPending ? "Loading earlier messages…" : "Load earlier messages"}
              </button>
            </div>
          ) : null}
          <Transcript
            group={group}
            members={members}
            messages={windowedMessages}
            transcript={roomMessages}
            emergingId={popping?.id}
            onReply={selectReply}
          />
          {laterCount > 0 && (
            <div className="flex justify-center">
              <button
                onClick={showLater}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                Show later messages ({laterCount} more)
              </button>
            </div>
          )}
          {waitingRun && (
            <div className="flex justify-start" data-testid="channel-waiting-run">
              <RoutineRunCard
                message={waitingRunMessage(waitingRun)}
                onOpen={waitingRun.executionThreadId ?? waitingRun.threadId
                  ? () => openNotificationTarget(dispatch, { botId: waitingRun.botId, threadId: (waitingRun.executionThreadId ?? waitingRun.threadId)! }, state)
                  : undefined}
              />
            </div>
          )}
          {!group.busyBotId && proposalBot && <ProposedOutcomeCard bot={proposalBot} />}
          {(speaker || presenceVisible) && (
            <TurnPresence
              avatar={
                <BotAvatar
                  bot={presenceSpeaker ?? { color: "orange" }}
                  state={toolInFlight ? "working" : "thinking"}
                  size={36}
                  forward={false}
                  lookAround={1}
                  trackPointer={false}
                />
              }
              visible={presenceVisible}
              label={activityLabel}
              answering={popping !== null}
              since={speaker ? group.turnStartedAt ?? null : null}
              name={presenceName}
            >
              {popping ? (
                <div className="w-fit max-w-[min(42rem,78%)] max-md:max-w-full rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink">
                  {poppingMessage?.attachments?.length ? (
                    <AttachedImageGallery
                      paths={poppingMessage.attachments.map((attachment) => attachment.path)}
                      className={popping.text ? "justify-start" : "mb-0 justify-start"}
                    />
                  ) : null}
                  {popping.text ? (
                    <ChatMarkdown text={popping.text} scope={popping.botId ? { botId: popping.botId, threadId: group.threadId } : undefined} />
                  ) : null}
                </div>
              ) : null}
            </TurnPresence>
          )}
          <HelpersLine helpers={roomHelpers} />
        </div>
        )}
      </div>

      {!follow && (
        <button
          onClick={() => {
            setBottomFollow(true);
            setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(roomMessages.length), end: null });
            requestAnimationFrame(() => {
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
            });
          }}
          aria-label="Jump to latest messages"
          className="animate-pop-in absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
          style={{ bottom: composerDock.height }}
        >
          <ArrowDown size={13} /> Jump to latest
        </button>
      )}

      <div ref={composerDock.ref} className="dock-safe-bottom absolute inset-x-0 bottom-0 z-[2]">
      {channelReadOnlyReason(group) ? <div role="status" className="border-t border-hairline bg-app px-4 py-3 text-[13px] text-ink-secondary">{channelReadOnlyReason(group)}</div> : <Composer
        key={group.threadId}
        group={group}
        members={members}
        locked={setupPending}
        replyTo={replyTo}
        onClearReply={clearReply}
        onConsumeReply={consumeReply}
        onRestoreReply={restoreReply}
      />}
      </div>
      </div>}
    </main>
    </ChipsProvider>
    </OutcomesProvider>
  );
}
