import { raiseTransientError, useChatErrorClear } from "./chat-error";
import { requestMemoryWake } from "@/lib/memory-integrity-wake";
import { probeInstances } from "@/lib/instances-probe";
import { projectEvents, type ProjectFrame } from "@/lib/project-events";
import { emitInboxChanged } from "@/lib/inbox-changed";
import { decideWithFreshAuth } from "@/lib/fresh-auth";
import { formerChiefOutcome } from "../../shared/chief-handover";
import { REMEMBERED_EVENT } from "../../shared/learned-chip";
import { MEMORY_WAITING_EVENT } from "@/lib/memory-waiting-event";
// Server-backed store. The React app holds no transports of its own:
// it dispatches typed commands over HTTP and folds the one SSE event
// stream from the harness server into local state. The reducer stays
// pure; everything async lives in the wrapped dispatch + SSE fold.
import type { SharedRow, SharedWorkMarker } from "@/lib/shared-teams";
import { requestFailedSentence } from "@/lib/request-failed";
import type { TaskResourceWait } from "@/lib/resource-wait";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CloudBackend, EffortLevel, Subtask } from "../../server/contracts.ts";
import type { LocalSetupFailure, ProviderErrorInfo } from "../../shared/provider-error";
import type { RuntimeErrorDiagnostic } from "../../shared/error-diagnostic";
import type { UsageMonth } from "../../shared/usage-month";
import { hostStoppedReason } from "../../shared/host-stop";
import { sendNoticeCode, type SendNoticeCode } from "../../shared/send-notice";
import { sendNoticeFromBody } from "@/lib/send-notice";
import { parseSidebarOrder } from "../../shared/sidebar-order";
import type { TurnHelper } from "../../shared/turn-helpers";
import { EMPTY_HELPERS, helpersAfterEvent, type HelperState } from "@/lib/subtasks";
import { normalizeAgentPlan, type AgentPlanEntry } from "../../shared/agent-plan";
import type { EmberColor, EmberMotion } from "@/lib/mascot";
import { botRole } from "@/lib/bot-role";
import { SETUP_VIEW_EVENT } from "@/lib/app-events";
import { idToSaveOnSetupView, landingId, readLastConversation, shouldRemember, workspaceKey, writeLastConversation } from "@/lib/last-conversation";
import { homeMeta } from "@/lib/cloud-home-meta";
import { extraTasksPatch, findTask, mayHoldTask, viewedThreadGone, windowCovers, withExtraTasks } from "@/lib/task-window";
import { forgetProjectTab } from "@/lib/project-tab";
import { createIndexedDbDraftBackend, forgetMarkdownDrafts } from "@/lib/markdown-drafts";
import { initialWorkspacePaneState, workspacePaneReducer, type WorkspacePaneAction, type WorkspacePaneState } from "@/lib/workspace-pane";
import { normalizeSettingsSection, type AppSettingsSection } from "@/lib/settings-sections";
import { resolveSettingsSection } from "@/lib/settings-pages";
import type { BotAvatarCrop } from "../../shared/bot-avatar";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import type { AutomationRequestCardData } from "../../shared/routine-request";
import type { RoutineRunCardData } from "../../shared/routine-run";
import type { GroupGoalRunCardData } from "../../shared/group-goal-run";
import type { ChannelProject, ChannelProjectInput } from "../../shared/project";
// The `.js` specifier, and not a bare one, for the reason spelled out in
// src/lib/onboarding-intake.ts: `shared/intake-turn.ts` is reached by BOTH
// toolchains, the server under NodeNext (which requires an extension) and
// this renderer under `bundler` (which forbids a bare `.ts` one). Type-only,
// so nothing survives to runtime either way.
import type { IntakeCardData } from "../../shared/intake-turn.js";
import type { SetupCardData } from "../../shared/setup-card.js";
import type { InstalledPackageMetadata } from "../../shared/installed-package.js";
import {
  reviewedSkillSha256,
  skillRequestBehavior,
  type SkillRequestCardData,
} from "../../shared/skill-request";
import type { Routine, RoutineInput, RoutineRun } from "@/lib/routines";
import type { WebhookAttempt, WebhookIngressStatus, WebhookTrigger } from "@/lib/webhooks";
import { currentCall } from "@/lib/call";
import { showNotification } from "@/lib/notify";
import { speaker } from "@/lib/tts";
import { refreshAfterFluxKey } from "@/lib/flux-key-paste";
import { createBotPatchQueue, type BotUpdatePatch } from "./bot-patch-queue";
import type { ImageApprovalSetting } from "../../shared/image-approval-setting";
import { fullAccessRefusalMessage } from "@/lib/permission-mode";
import { createFirstPageTopUp, createScrollback, MESSAGE_PAGE_SIZE, needsFirstPage, type FirstPageAnswer } from "@/lib/scrollback";
import { sameSidebarLine, sidebarLineOf, type SidebarLine } from "../../shared/sidebar-line";
import { ThreadSettingsWrites } from "./thread-settings-writes";
import { persistCardPatch } from "./card-persist";
import { noteTurnEvent } from "./turn-status";
import { applyTranscriptInput, hydrateTranscript, legacyTranscriptInput, transcriptState, vouches, type InputKind, type SeqTranscript } from "./transcript-seq";
import { skillRecorderEnabled } from "@/lib/feature-flags";
import { desktopSurfaceHeaders, ensureDesktopSurfaceSecret, openLiveEvents } from "@/lib/live-events";
import { newSendId } from "@/lib/send-id";
import { busyRetriesFor, busyRetryDelayMs, createOutbox, createSendDelivery, deliverEdit, isDatabaseBusyAnswer, retryWhileBusy, type OutboxDraft } from "./send-delivery";
import { checkPinnedDrafts, draftJournal, forgetDeletedDrafts, migrateLegacyDrafts, noteRefusedChips, releaseRecoveredSend, setDraftOwnerCheck, setDraftSendLookup, settleDraftSend, type DraftSendLookupResult } from "@/lib/drafts";
import { checkSession, onSignedOut, sessionSignedOut } from "@/lib/session-check";
import { onSaveFailed } from "@/lib/save-file";
import { callNative, nativeAvailable } from "@/lib/native-shell";
import { isPhoneClient } from "@/lib/phone-client";
import { isCloudOrigin, notificationBridge } from "@/lib/cloud-workspace";
import { applyThreadDelta, conversationCache, loadConversationCache } from "@/lib/conversation-cache-host";
import type { CachedConversation } from "@/lib/conversation-cache";
import { deletionErrorSentence, deletionNote, owedNote } from "@/lib/deletion-notes";
import { ANSWER_TTL_MS, answerClock, carryAnswerTag, fromAnswer, sentAtOf, tagAnswer, type HttpOrigin, type RoomOrigin } from "./answer-tag";
export { asAnswer, freshAnswer, fromAnswer } from "./answer-tag";
import { hiddenPatchFrom } from "@/lib/record-numbers";
import { requestPage } from "./page-intent";
export { newDeleteAttempt, requestPage } from "./page-intent";

const MAX_ROUTINE_RUNS = 2_000;
const ACTIVE_ROUTINE_RUN_STATUSES = new Set<RoutineRun["status"]>(["queued", "running", "waiting", "needs-you"]);

function trimRoutineRuns(runs: readonly RoutineRun[]): RoutineRun[] {
  const sorted = [...runs].sort((a, b) => b.scheduledFor - a.scheduledFor);
  if (sorted.length <= MAX_ROUTINE_RUNS) return sorted;
  const activeCount = sorted.reduce(
    (count, run) => count + (ACTIVE_ROUTINE_RUN_STATUSES.has(run.status) ? 1 : 0),
    0,
  );
  let terminalSlots = Math.max(0, MAX_ROUTINE_RUNS - activeCount);
  return sorted.filter((run) => {
    if (ACTIVE_ROUTINE_RUN_STATUSES.has(run.status)) return true;
    if (terminalSlots === 0) return false;
    terminalSlots -= 1;
    return true;
  });
}

export type { EmberColor } from "@/lib/mascot";
export type { RoutineRunCardData } from "../../shared/routine-run";
import { isQuestionCard, type QuestionAnswer, type QuestionSpec } from "../../shared/questions";

export interface OptionCardData {
  /** A publish approval card (server/publish): never auto-approved, never "always allow". */
  kind?: "publish" | "mcpEnable";
  publish?: import("../../shared/publish-card").PublishCardData;
  /** A "Turn on <name>?" card for a server a bot filed switched off (item 118). */
  mcpEnable?: { name: string; rev: string; botId: string; bot: string; kind: "stdio" | "remote"; command?: string; args?: string[]; url?: string; transport?: "http" | "sse"; pendingKeys: string[]; enabled?: boolean; error?: string };
  /** Optional owner-approved browser connection with one explicit continuation. */
  browserSetup?: import("../../shared/browser-setup-card").BrowserSetupCardData;
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** 1.0.4 SL-I I5: the engine hit its limit; the engines that can answer now (server/limit-continuation.ts) */
  limitOffer?: { sourceMessageId: string; from: ModelSelection; resetsAt: number | null; choices: Array<{ label: string; selection: ModelSelection; billing: string }>; nextTimeLabel: string; routinesLabel: string };
  /** permission asks: the tool being requested (drives the approval box) */
  tool?: string;
  /** what the tool will do, in one line; the approval digest reads it */
  summary?: string;
  /** the tool input was cut short for display; the approval digest reads it */
  toolInputTruncated?: boolean;
  /** the push body the server sent for this ask */
  pushBody?: string;
  /** why auto mode stopped to ask anyway */
  held?: string;
  /** the narrow grant "always allow" remembers, e.g. "Bash:git" */
  allowKey?: string;
  /** "Always allow this exact command here": command, folder and engine
   * (shared/exact-command.ts); the server decides it, never the client */
  exactAllowKey?: string;
  /** "Always allow for this routine" on a card a routine run raised */
  routineAllowKey?: string;
  routineId?: string;
  /** AMEND-13 Rule 78c: "Always allow" on a call of several distinct actions
   * remembers this whole set; the server checks it against the card. */
  allowKeys?: string[];
  /** AMEND-13 Rule 82: every operation in call order and the routine offer,
   * written by the server when the request opened (server/store.ts). */
  grantRequest?: import("../../shared/approval-grant-request").ApprovalGrantRequest;
  /** Stop-line cards (server/stop-line.ts): the grant "Allow for this task"
   * records, scoped to the folder, payee or recipient the action touches. */
  taskAllowKey?: string;
  approvalScope?: "local-computer";
  /** Advisory only, for the page: the engine path rated this permission card low when it raised it. A browser
   * pairing shows Allow only on these. The harness never reads it back (SEC-006, Decision 1). */
  lowRisk?: boolean;
  /** A provider question's structured questions (server/store.ts). */
  questions?: QuestionSpec[];
  /** What the owner chose; a secret answer is never kept. */
  answers?: QuestionAnswer[];
  /** The bot stopped waiting with no answer; "Send as a message" still works. */
  expired?: boolean;
  sentAsMessage?: boolean;
  /** QW Q1: a question from the agents `ask_user` tool, a murage-question fence or Codex's async ask. Its answer is an
   * ordinary owner send (the person's next message), never an engine reply. Server-written only. */
  answerAsSend?: boolean;
  /** QW Q1: the provider turn the question was asked in, the only turn its answer may be steered into. */
  turnId?: string;
  /** QW Q1, Q1b: the owner send an answer became ("ask-" + the card's id). */
  sendId?: string;
  /** QW Q2: the fence of a bot message this card was made from: that message and the fence's place among its fences. */
  fenceOf?: { messageId: string; index: number };
  unattended?: boolean;
  /** A folder-trust question (shared/folder-trust.ts): the answer is a
   * decision about the folder, remembered by the server. */
  folderTrust?: { key: string; folder: string; sources: string[]; late?: "finished" | "stopped" | "failed" | "timeout" };
  /** Persisted proposal used by the server when the user confirms it. */
  routineRequest?: AutomationRequestCardData;
  /** SL-J J2: Undo put back what this applied routine or webhook change replaced. */
  undone?: boolean;
  routineProposalDigest?: string;
  /** Staged learned-skill change; applied only after the user confirms this card. */
  skillRequest?: SkillRequestCardData;
  /** Present when this card is a turn of the new-bot setup conversation.
   * Mirrors `server/store.ts`'s field exactly by importing the one shared
   * definition — a second local declaration of a wire shape is how the two
   * ends of this seam drift. Read defensively through `readIntakeCard`
   * (src/lib/onboarding-intake.ts); never both set with `requestId`. */
  intake?: IntakeCardData;
  /** Present when this card is a step of the guided first run. Mirrors
   * `server/store.ts` by importing the one shared definition. Read
   * defensively through `readSetupCard` (shared/setup-card.ts). */
  setup?: SetupCardData;
}

/** A link server whose sign-in ended while a bot was working (MCP-LINK 3.12). */
export interface McpSignInCardData {
  name: string;
  host: string;
  bot: string;
  reason: "sign-in-ended" | "needs-more-access";
  status: "required" | "signed-in";
  resumeKey: string;
  title: string;
  body: string;
  phone: string;
  error?: string;
  dismissed?: boolean;
  resumed?: boolean;
}

export interface ConnectorCardData {
  slug: string;
  alias?: string;
  label: string;
  description: string;
  status: "required" | "authorizing" | "connected" | "failed";
  resumeKey: string;
  error?: string;
  dismissed?: boolean;
  resumed?: boolean;
}

export interface SecretRequestCardData {
  target: import("../../shared/credential-request").AnyCredentialTargetId;
  label: string;
  description: string;
  placeholder: string;
  helpUrl: string;
  requestKey: string;
  provided?: boolean;
  dismissed?: boolean;
  resumed?: boolean;
  error?: string;
}

export interface Message {
  /** User rows: the server left this message out of memory as notes exported from another assistant (memory/capture.ts); the chat shows a line under it. */
  memoryNote?: "export-paste";
  /** The row the server saved this message in front of (Store
   * insertMessageBefore). It arrives after that row, live and in pages. */
  insertedBefore?: string;
  /** ROOM-ORDER-DESIGN r6: the row's storage position in its thread (1, 2, 3 ...), on every row of a numbered thread. The transcript
   * orders, merges, finds gaps and pages by it alone (transcript-seq.ts). Absent on a legacy thread's rows. */
  seq?: number;
  /** Client only (r7 R4): a numbered row held across a stream gap, not yet re-read; the walk replaces it with a vouched copy. */
  unvouched?: true;
  actorKind?: "owner" | "person" | "bot" | "murage" | "routine";
  origin?: "desktop" | "companion" | "unproven";
  routineRunPrompt?: { routineName: string; trigger?: string };
  requestId?: string;
  workItemId?: string;
  to?: string[];
  murage?: { desk?: { botId: string; threadId: string }; digestDay?: string; kind: "failure" | "status" | "queue" | "budget" | "restore" | "milestone" | "result" | "progress" | "cap"; held?: { count: number; items?: Array<{ id: string; text: string; rowId?: string; error?: string; botId?: string; state?: "ready" | "retry" | "authority" | "recovery"; restoreGen?: string }> }; retry?: { requestId: string }; reassign?: { workItemId: string } };
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "mcpSignIn" | "secret" | "routine.run" | "goal.run";
  text?: string;
  /** QW Q4: a bot-authored widget, canonical (shared/widget.ts), on a bot `kind: "text"` row; drawn wherever it is present. */
  widget?: import("../../shared/widget").WidgetPayload;
  /** Verified registry identities, never inferred from message prose. */
  artifactIds?: string[];
  /** Provider-generated files attached to this assistant response. */
  attachments?: Array<{ kind: "image"; path: string; mime: string }>;
  card?: OptionCardData;
  connector?: ConnectorCardData;
  mcpSignIn?: McpSignInCardData;
  secret?: SecretRequestCardData;
  /** Lifecycle mirror for a routine whose real work lives in a fresh task. */
  routineRun?: RoutineRunCardData;
  /** Durable lifecycle receipt for a goal-driven channel run. */
  goalRun?: GroupGoalRunCardData;
  /** How a channel user message should be handled. Absent means ordinary chat. */
  channelMode?: "chat" | "goal";
  /** activity messages: tool name + outcome. `spoken` is the server's
   * narration of the same chip ("reading a file"), used by call mode. */
  /** `setup` marks an error fixed by installing something, not by retrying. */
  tool?: { name: string; ok?: boolean; spoken?: string; summary?: string; setup?: boolean; authRequired?: boolean; claudeUpdate?: boolean; errorDetails?: string; errorKind?: string; providerError?: ProviderErrorInfo; localFailure?: LocalSetupFailure; localFailureEngine?: string; diagnostic?: RuntimeErrorDiagnostic; /** Full access approvals collapsed into one line: each step, newest last (bounded), and how many in all. */ steps?: string[]; stepCount?: number; /** An image made without an approval card: what was asked for and the whole prompt. */ imageRecord?: { summary: string; prompt: string } };
  /** user messages sent into a running turn — the model saw it mid-turn */
  steered?: boolean;
  /** a steered message the bot has not confirmed yet; cleared when it does */
  steerUnconfirmed?: boolean;
  steerId?: string;
  /** Provider turn that produced this message. */
  turnId?: string;
  /** Last assistant text item from a settled provider turn. */
  turnTerminal?: boolean;
  /** On a closing reply: whether the actions it describes have a record (server-written). */
  actionCheck?: import("../../shared/reply-action-claims").ActionCheck;
  /** Which engine wrote this reply, when the server stamped it. */
  engine?: import("../../shared/engine-switch").MessageEngine;
  /** On a closing message: the turn's helpers (sub agents), summarised by the server. Owner threads only. */
  turnHelpers?: TurnHelper[];
  /** screen messages: a frame of the bot's computer (base64) */
  png?: string;
  mime?: string;
  /** screen messages from a bounded page: the server left the pixels out and
   * serves them from /api/threads/:threadId/messages/:id/image */
  hasImage?: boolean;
  at: number;
  /** the message this one follows; null = thread root. Edited messages
   * share a parentId with the version they replace — that's a fork. */
  parentId?: string | null;
  /** Flat reply reference for an inline quote; unrelated to branch ancestry. */
  replyToId?: string;
  /** Stable client identity for at-most-once chat POST retries. */
  sendId?: string;
  /** rooms: which member said this (sender attribution). */
  from?: { botId: string; name: string; color: EmberColor };
  /** emoji reactions; by = "user" or a member botId. */
  reactions?: Array<{ emoji: string; by: string }>;
  /** comm chips: "Messaged @X" linking to the bot⇄bot channel. */
  comm?: { groupId: string; withBotId: string; withName: string; withColor: EmberColor };
  /** sent while the bot was mid-turn; auto-sends when the turn settles.
   * Rendered only while the bot is busy, so a flag stranded by a server
   * restart never shows a promise nothing will keep. */
  queued?: boolean;
  /** steer-queue entry this drained user line came from. Pending chips
   * match on this id, not on equal text. Absent on ordinary sends. */
  queueId?: string;
  /** activity: a card answered after its routine run ended; offers Run again. */
  routineRunAgain?: { routineId: string };
  /** activity: a delegation waiting on a busy teammate; offers Stop. */
  delegationWait?: { id: string };
  /** activity: a hand-off a restart cut off after the provider may have taken it; offers Send again and Dismiss. */
  delegationHeld?: { id: string };
  /** rooms: bots no longer see this reply; it used something the owner
   * forgot, deleted or changed. The owner still does. */
  withheldFromBots?: boolean | "forgotten" | "checking";
}

export type GroupDefaultResponder =
  | { kind: "member"; botId: string }
  | { kind: "everyone" }
  | { kind: "mentions" }
  /** Murage picks who answers each plain message; `fallbackBotId` answers
   * when it cannot decide (first member when absent). */
  | { kind: "auto"; fallbackBotId?: string };

/** A room: several bots + you in one shared thread. */
/** A deleted conversation's unsaved document edits go with it. Best-effort:
 * without IndexedDB there is nothing stored to remove. */
let documentDraftBackend: ReturnType<typeof createIndexedDbDraftBackend> | undefined;
function forgetDocumentDrafts(owner: { botId: string } | { threadIds: readonly string[] }): void {
  if (typeof indexedDB === "undefined") return;
  documentDraftBackend ??= createIndexedDbDraftBackend();
  void forgetMarkdownDrafts(documentDraftBackend, owner).catch(() => {});
}

export interface Group {
  /** Server projection for the active thread; never inferred from message attribution. */
  readOnlyReason?: string;
  humanPrincipalKind?: "owner" | "person";
  id: string;
  threadId: string;
  name: string;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  bulletin: string;
  unread: boolean;
  createdAt: number;
  /** auto-created bot⇄bot channel (ask_bot exchanges mirror here) */
  dm?: boolean;
  busyBotId?: string | null;
  /** when the busy member's turn started (server epoch ms), for the elapsed
   * readout; absent while the room is idle */
  turnStartedAt?: number | null;
  /** True for the whole orchestrated run, including hand-offs between members. */
  working?: boolean;
  /** the room's shared desk — where member turns run their shell tools,
   * overriding each member's own folder; absent = each member's own */
  cwd?: string;
  /** folder the room's turns actually run in, pinned on the first turn;
   * null = each member's own default; absent = not pinned yet */
  pinnedCwd?: string | null;
  /** the one message pinned to the top of this room's transcript */
  pinnedMessageId?: string;
  /** sidebar section heading this room is filed under (shared with bots) */
  section?: string;
  /** Filed away. The channel and its whole transcript stay on disk; it just
   * leaves the main list, exactly as an archived bot does. Never set on a
   * bot-to-bot chat — the server refuses those. */
  hidden?: boolean;
  /** Present = this channel has been given a purpose, which is the only
   * thing that makes it a project. Absent = an ordinary channel, which is
   * the normal case. The server owns every timestamp in here. */
  channelProject?: ChannelProject;
  /** New user-created rooms remain in setup until Save or Skip. */
  setupCompletedAt?: number | null;
  setupSkippedAt?: number | null;
  /** Separate conversations in this channel. DMs deliberately stay on one
   * thread and omit this collection. */
  tasks?: GroupTask[];
  /** How many tasks the channel has. `tasks` is a window of them (the open one,
   * unread, newest); the rest page in on request (src/lib/task-window.ts). */
  tasksTotal?: number;
  tasksOlder?: string | null;
  /** Rows outside the window this client asked for by thread id. Never sent. */
  extraTasks?: GroupTask[];
  messages: Message[];
  /** Open request cards older than the held messages (see Bot.openCards). */
  openCards?: Message[];
  openCardsLeaf?: string;
  /** As on a bot: the server has not indexed this room's older open cards yet, so the ones held may be incomplete; and the revision of card patches. */
  openCardsPending?: boolean;
  cardsRev?: number;
  olderFrom?: string;
  /** The server answered a bounded page and older messages remain in storage
   * (upstream #1527). Absent on an unpaged response, which is the whole thread. */
  hasMore?: boolean;
  /** What the sidebar row shows (see Bot.sidebarLine). */
  sidebarLine?: SidebarLine;
  /** How many messages the room's open conversation holds (the boot roster's count; the archived-channels list reads it). */
  messagesTotal?: number;
  /** The room's number (CI-OVERLAY-DESIGN I-H2): the server numbers every group frame per room, and every answer carrying the
   * room carries the number of the last frame built for it. `groupPatched` drops a numbered input older than the held copy. */
  recordSeq?: number;
  recordEpoch?: string;
  /** This client's own mark that the room's setup card was answered (GroupView). Local: a statement never sets or clears it; only a `groupEdited` does. */
  setupPending?: boolean;
  /** Order this room reached this client (`admitTick`), as on a bot: a room admitted after a roster was asked for survives that roster (ROOM-ORDER-DESIGN §2.4). */
  admittedAt?: number;
  /** See Bot.messagesUnloaded. */
  messagesUnloaded?: true;
  /** See Bot.firstPageEvents. */
  firstPageEvents?: FirstPageEvent[];
  /** ROOM-ORDER-DESIGN r6-r8, client only: the transcript was promoted by a numbered input this run (rows sorted by `seq`); absent, it is
   * legacy (arrival order, never complete). */
  numbered?: true;
  /** r7 R4, client only: the highest `newestSeq` a vouching input carried (the server's newest number); undefined until one did and after a hydrate. */
  tail?: number;
  /** Astra build r5 H2, client only: a legacy transcript's held rows each just above a run it may lack (transcript-seq.ts `legacyGaps`). */
  legacyGaps?: string[];
}

/** The keys of a room only this client writes (`groupEdited`); every server statement keeps the held values (ROOM-ORDER-DESIGN r2 M2, r3 R6). */
export type RoomLocalKey = "unread" | "setupPending";
/** The per-task keys only this client writes. */
export type RoomTaskLocalKey = "unread" | "unreadCount" | "unreadMessageIds" | "sending";
/** Every server-owned key of a room: one statement sets every one of them, absent meaning cleared (ROOM-ORDER-DESIGN r2 upstream rule). */
export const ROOM_SERVER_KEYS: ReadonlyArray<keyof Group> = [
  "name", "memberIds", "defaultResponder", "bulletin", "section", "hidden", "cwd", "pinnedCwd", "pinnedMessageId", "readOnlyReason",
  "humanPrincipalKind", "channelProject", "setupCompletedAt", "setupSkippedAt", "busyBotId", "turnStartedAt", "tasksTotal", "tasksOlder", "tasks",
];

/** One of a channel's independent conversations. The channel's threadId
 * points at the active one; folder and pin state belong to the task. */
export interface GroupTask {
  /** the running turn's helpers (server snapshot, owner only) */
  subtasks?: Subtask[];
  unread?: boolean;
  unreadCount?: number;
  /** Renderer deduplication of live unread events until a server count arrives. */
  unreadMessageIds?: string[];
  /** Local marker a send to a non-open thread stamps; no statement sets or clears it. */
  sending?: true;
  threadId: string;
  title: string;
  createdAt: number;
  /** when the thread last had a message (server-derived); absent = none yet */
  lastActivityAt?: number;
  pinnedCwd?: string | null;
  pinnedMessageId?: string;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  connectionId?: string;
  effort?: EffortLevel;
}

/** One of a bot's separate contexts: its own thread, transcript and
 * provider session. The bot's threadId points at the active one. */
export interface Task {
  threadId: string;
  title: string;
  createdAt: number;
  /** when the thread last had a message (server-derived); absent = none yet */
  lastActivityAt?: number;
  modelSelection?: ModelSelection;
  /** 1.0.4 SL-K K1: the chat has no model of its own and uses its bot's */
  followsBotModel?: boolean;
  autoApprove?: boolean;
  /** Full access for this task (only while autoApprove is on) */
  fullAccess?: boolean;
  /** No limits for this task (only while fullAccess is on) */
  noLimits?: boolean;
  alwaysAllow?: string[];
  unread?: boolean;
  busy?: boolean;
  activity?: Bot["activity"];
  /** runtime only: waiting for another thread's folder, computer or browser */
  waitingFor?: TaskResourceWait;
  /** runtime only: when this thread's current turn became busy (server epoch
   * ms); the elapsed readout counts from here so it survives thread switches */
  turnStartedAt?: number;
  /** runtime only: this thread's running turn has the browser mounted */
  browserMounted?: boolean;
  pinnedMessageId?: string;
  /** Listed first in the task switcher; absent means not pinned. */
  pinned?: boolean;
  /** An address attached to this conversation, shown as a chip in the task list. */
  link?: string;
  /** what this task has spent, banked once per settled turn */
  usage?: TaskUsage;
  /** folder this task's turns run in, pinned on its first turn; null =
   * legacy home-folder session; absent = not pinned yet */
  cwd?: string | null;
  /** The owner's work thread for a team this bot is shared with (SPEC-X
   *  3.3); closed once sharing with that team stops. */
  sharedWork?: SharedWorkMarker;
  /** runtime only, owner threads: the running turn's helpers, as the server
   * last saw them. A client that opens or reconnects mid-turn renders from it. */
  subtasks?: Subtask[];
}

export interface TaskUsage {
  input: number;
  output: number;
  /** cached share of `input` (context the model re-read); absent on records
   * from builds before it was tracked */
  cachedInput?: number;
  /** null until any turn reported a cost — most engines never do; records
   * from builds before cost existed lack the field entirely */
  costUsd: number | null;
  turns: number;
}

export interface Bot {
  id: string;
  threadId: string;
  /** Who can request this bot's work (desktop only; SPEC-X 3.2). */
  sharedWith?: { mode: "none" | "list" | "all"; teams: Array<{ id: string; name: string }> };
  /** Set the first time sharing was turned on (desktop only). */
  partitionedAt?: number;
  /** Shared with other teams right now. */
  shared?: boolean;
  /** One row per team it is shared with, for the owner (SPEC-X 12.3). */
  sharedRows?: SharedRow[];
  /** every context this bot has, newest first */
  tasks?: Task[];
  /** How many tasks the bot has. `tasks` is a window of them (pinned, unread,
   * busy, the open one, the newest); the rest page in on request
   * (src/lib/task-window.ts). Absent from a server that sends every task. */
  tasksTotal?: number;
  /** Where the older tasks begin: the `before` of the first older page. null = none are left out. */
  tasksOlder?: string | null;
  /** What every task of the bot has spent, summed by the server. */
  usageTotal?: TaskUsage;
  /** What the bot used per local calendar month ("YYYY-MM"); the Usage page reads this month's. */
  usageMonths?: Record<string, UsageMonth>;
  /** The "Always allow" keys across every task, each once. */
  grantsAll?: string[];
  /** Rows outside the window this client asked for by thread id. Never sent. */
  extraTasks?: Task[];
  name: string;
  title: string;
  description: string;
  /** The roster (GET /api/bots) carries the first lines of a long description. Settings fetch the whole text (`ensureBotDetail`) before editing it;
   * a bot frame or GET /api/bots/:id carries the full text and clears this. */
  descriptionCut?: true;
  notifications: boolean;
  color: EmberColor;
  mascotExpression?: string | null;
  /** Which mascot body this bot wears; absent means the Ember flame. */
  mascotBody?: MascotBodyId | null;
  /** App-owned image attachment used for this bot's profile. */
  avatarUrl?: string | null;
  /** Mascot, or the crop applied to avatarUrl. */
  avatarCrop?: BotAvatarCrop;
  unread: boolean;
  busy?: boolean;
  /** what the bot is doing, as the harness sees it; busy is derived from it */
  activity?: "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
  /** the viewed thread's turn start (server epoch ms) while busy, else null */
  turnStartedAt?: number | null;
  /** the viewed thread's running turn has the browser mounted */
  browserMounted?: boolean;
  /** the viewed thread's helpers while its turn runs (server snapshot, owner only) */
  subtasks?: Subtask[];
  modelSelection: ModelSelection;
  /** 1.0.4 SL-I I4: the engine that takes over when this bot's engine hits its limit (desktop sets it) */
  limitBackup?: { selection: ModelSelection; routines: boolean; at: number };
  /** Where this bot's computer runs; unset = auto (cloud box if one exists, else local). */
  computer?: "cloud" | "vm" | "local" | "browser" | "off";
  /** Which cloud computer backs `computer: "cloud"`; absent means Box. */
  cloudBackend?: CloudBackend;
  /** Allow Auto to prepare/start the managed VPS container. Off by default. */
  autoStartVps?: boolean;
  /** Auto on macOS reaches this computer: the owner's one-time answer for
   * this bot. "ask" (or absent) asks before the bot first acts on it. */
  hostComputerConsent?: "ask" | "allowed" | "declined";
  /** where new tasks run their shell tools; absent = the private bot workspace */
  cwd?: string;
  /** auto mode: the bot approves its own tool permissions */
  autoApprove?: boolean;
  /** Full access, above Auto: no approval cards for turns the owner starts */
  fullAccess?: boolean;
  /** set by the server once the owner confirmed the one-time Full access warning */
  fullAccessAcknowledgedAt?: number;
  /** No limits, above Full access: no stop line; the key guard still asks */
  noLimits?: boolean;
  /** set by the server once the owner confirmed the one-time No limits warning */
  noLimitsAcknowledgedAt?: number;
  /** Full access also covers the owner's own Telegram, Slack and Discord messages */
  fullAccessChannelMessages?: boolean;
  /** Full access also approves setup requests (skills, routines, folder trust) */
  fullAccessSetupRequests?: boolean;
  /** The Images setting. The server stores only `ask` or `allow`; `follow`
   * (the default) is an absent field, and is only ever sent, never read back. */
  imageApproval?: ImageApprovalSetting;
  /** Ask again after this many images in one turn. Absent is the default of 50; `null`
   * is only ever sent, to clear it. */
  imageAskAfter?: number | null;
  /** optional model review for otherwise undecided, attended approvals */
  autoReview?: "off" | "shadow" | "enforce";
  /** tools this bot may always use without asking */
  alwaysAllow?: string[];
  /** speak this bot's replies aloud as they settle */
  speakReplies?: boolean;
  /** this bot's own voice id (falls back to the app-wide one) */
  voice?: string;
  /** This agent's voice service; unset uses the workspace's. */
  voiceProvider?: "flux" | "xai" | "elevenlabs" | "system";
  /** `voice` is the default the app assigned, not the owner's pick. */
  voiceAssigned?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  sidebarHidden?: boolean;
  /** Sidebar section this bot renders under; absent = unsectioned. */
  section?: string;
  /** the one message pinned to the top of this bot's active thread */
  pinnedMessageId?: string;
  /** This sidebar section's primary coordinator. */
  chiefOfStaff?: boolean;
  /** Set only on the ONE bot that coordinates the whole workspace, above the
   * team leaders. Meaningful only while `chiefOfStaff` is true. */
  chiefScope?: "workspace";
  /** The Chief's other branch: this bot works alone in its own group, with
   * no team leader above it, reporting to the Chief directly. Never true at
   * the same time as `chiefOfStaff`. */
  individual?: boolean;
  /** When this bot wants to talk to another bot (ask_bot/delegate_bot),
   * pause and ask the user first. Off by default. */
  approvePeerComms?: boolean;
  /** Who this bot may start a conversation with beyond its team. Owner-set on the desktop. */
  messageAllow?: { mode: "team" | "all" | "list"; botIds?: string[]; grantedBy?: string[] };
  /** Whether this bot may use the workspace's connected apps. Unset means
   * allowed for existing bots; imported bots start with this disabled. */
  composio?: boolean;
  /** false when the owner switched its team's brief off for this bot. */
  teamBrief?: false;
  /** false when the owner switched About me off for this bot. */
  aboutMe?: false;
  /** PIP P1 "Keep a continuous self": true when on, absent when off. */
  continuity?: boolean;
  /** PIP P2 settings while Continuity is on; `null` in a patch clears them. */
  continuityOptions?: { reflect?: true; inner?: true; between?: true; innerState?: true; selfCutover?: true; reflectModel?: string } | null;
  /** Set on bots that arrived from a bot package. `wireBot` (server/index.ts)
   * spreads the whole record, so this reaches the renderer on GET /api/bots,
   * on the import response and on every SSE bot frame; without it declared
   * here no UI can render which connected services an assistant needs. */
  installedPackage?: InstalledPackageMetadata;
  /** Whether this bot gets the app's built-in browser (Browser tab). On unless switched off. */
  browser?: boolean;
  /** Named browser profile id (config.browserProfiles); absent/null = the
   * bot's own session (null is how a clear travels over PATCH). */
  browserProfile?: string | null;
  /** The owner opted this bot into their own running Chrome (one bot at most). */
  useMyChrome?: boolean;
  browserTransport?: "extension";
  browserExtensionProfileId?: string;
  /** The browser the owner connected the extension in for this bot. */
  browserExtensionBrowser?: "chrome" | "edge" | "brave";
  messages: Message[];
  /** Open request cards older than the held messages, on the branch the
   * server's page was cut from. Held beside `messages`, never inside it: the
   * rows linking them to the page are not held, so the visible-branch walk
   * cannot reach them. The composer answers them (olderOpenCards); scrollback
   * that reaches one moves it into `messages`. Replaced with each transcript a
   * frame carries, kept when a frame leaves the transcript alone. */
  openCards?: Message[];
  /** The branch head `openCards` was worked out for. The cards belong to that
   * branch: once the visible branch no longer passes through this row (an edit,
   * a switch to a sibling) they are not shown, and are fetched again. */
  openCardsLeaf?: string;
  /** Moves each time a request card on this transcript is patched (answered,
   * denied, dismissed). A card refresh asked for at one revision is dropped if
   * it lands at another: an older REST answer must never put back a card a
   * newer patch had already settled. */
  cardsRev?: number;
  /** The server has not indexed this thread's older open cards yet (the upgrade is still preparing it), so the ones held may be incomplete.
   * Held cards are never cleared while it is set; the server says when they are exact (`open-cards.ready`). */
  openCardsPending?: boolean;
  /** The next ancestor to page back to, when the page held is a branch page
   * (parent links, not storage order): the cursor `branchFrom` takes. */
  olderFrom?: string;
  /** Task rows that changed since frame `base`, with the task count; laid over
   * the held rows inside the reducer (withTaskDelta), never kept. `read` marks
   * the row this client is reading. */
  tasksDelta?: { upsert: Task[]; count: number; base?: number; read?: string };
  /** The server's number for the task list held (server/task-delta.ts), and the
   * server run that numbered it: a number is only comparable within its run. */
  tasksSeq?: number;
  tasksEpoch?: string;
  /** A delta could not be laid over the held task list; it is being refetched. */
  tasksStale?: boolean;
  /** The server answered a bounded page and older messages remain in storage
   * (upstream #1527). Absent on an unpaged response, which is the whole thread. */
  hasMore?: boolean;
  /** The one line the sidebar row shows (shared/sidebar-line.ts): the boot roster sends it, the reducer keeps it current. Never a transcript row. */
  sidebarLine?: SidebarLine;
  /** No rows of this conversation are held yet: the boot roster sends none. `messages` stays empty and nothing renders it as a transcript until
   * the first page lands (scrollback loadFirstPage); live rows meanwhile move only `sidebarLine`. */
  messagesUnloaded?: true;
  /** The held rows predate a rehydrate (the conversation on screen keeps them so it does not blank); its first page is fetched again and replaces them. */
  pageStale?: true;
  /** Live events for this conversation while its first page is on the wire, replayed over the page in arrival order. Present only then. Unlike
   * `awaitingThreadSnapshot`, it never blocks a send. */
  firstPageEvents?: FirstPageEvent[];
  /** Renderer-only deletion transition; never expose the removed transcript. */
  awaitingThreadSnapshot?: boolean;
  deletedThreadId?: string;
  pendingThreadEvents?: Array<Extract<Action, { type: "messageAdded" | "messagePatched" | "threadActive" }>>;
  /** Message ids a live patch changed since this page was painted from the cache;
   * the server's delta may have been read before those writes, so it skips them. */
  patchedSinceOpen?: string[];
  /** leaf of the visible conversation branch (see visibleMessages) */
  activeLeafId?: string | null;
  /** The server's version of this thread as of the page held (a switch back
   * asks for only what changed since). */
  threadVersion?: string;
  /** The server's number of the record fields held (BOTADDED-DESIGN-V3 r6 §2.1); `tasksSeq` stays the task-list base. Client only. */
  recordSeq?: number;
  /** The client-side order (AppState.admitTick) of the input that inserted this record, or last moved it forward from outside a
   * roster (§2.8 r6, with the restore order of Astra r5 #1). A hydrate drops an unlisted bot only when this is not after its send. */
  admittedAt?: number;
}

/** Derived views of a held transcript, remembered per `messages` array. The
 * reducer replaces that array on every message event and keeps it otherwise,
 * so a view is recomputed only when the transcript changed, not on each of the
 * dispatches (busy, unread, stream frames) that leave it alone. */
const visibleCache = new WeakMap<Message[], { leafId: string | null | undefined; path: Message[] | null }>();
const versionCache = new WeakMap<Message[], Map<string | null, Message[]>>();

/** The visible conversation: walk parentId links from the active leaf back
 * to the root. Falls back to the flat list for pre-branching payloads. A leaf
 * this client does not hold yet (older than its page) shows nothing rather
 * than another branch's rows; the provider fetches back to it. */
export function visibleMessages(bot: Bot): Message[] {
  const leafId = bot.activeLeafId;
  if (!leafId) return bot.messages;
  const cached = visibleCache.get(bot.messages);
  let path = cached && cached.leafId === leafId ? cached.path : undefined;
  if (path === undefined) {
    const byId = new Map(bot.messages.map((m) => [m.id, m]));
    path = byId.has(leafId) ? [] : null;
    for (let cur = byId.get(leafId); cur && path; cur = cur.parentId ? byId.get(cur.parentId) : undefined) path.push(cur);
    path?.reverse();
    visibleCache.set(bot.messages, { leafId, path });
  }
  return path ?? (bot.hasMore ? EMPTY_MESSAGES : bot.messages);
}
const EMPTY_MESSAGES: Message[] = [];

/** True while the selected branch head is older than every held row. */
export const branchHeadMissing = (bot: Bot): boolean => Boolean(bot.activeLeafId && bot.hasMore) && visibleMessages(bot) === EMPTY_MESSAGES;

/** What the composer and a call answer: the open cards on the visible branch,
 * and in front of them the ones older than the held rows (`openCards`) while
 * that branch still reaches back past the held rows. A branch whose root is
 * held (an edit made inside the page) does not pass through them. */
/** How many readiness notices the server has given for this conversation (its own and the global ones). */
export function readyRevOf(state: Pick<AppState, "cardsReady" | "cardsReadyAll">, threadId: string): number {
  return (state.cardsReady[threadId] ?? 0) + state.cardsReadyAll;
}
/** Whether a conversation's open cards must be asked for again: the snapshot it holds is partial (pending) and a readiness notice has come that no accepted
 * answer for THIS transcript generation has covered yet. A notice that came before the snapshot counts; the previous conversation's answers do not. */
export function cardsFetchNeeded(state: AppState, owner: { threadId: string; openCardsPending?: boolean } | null | undefined): boolean {
  if (!owner?.threadId || !owner.openCardsPending) return false;
  const ready = readyRevOf(state, owner.threadId);
  if (!ready) return false;
  const gen = state.transcriptGeneration[owner.threadId] ?? 0, done = state.cardsFulfilled[owner.threadId];
  return (done && done.gen === gen ? done.rev : 0) < ready;
}
/** An answer to /open-cards. While the server says it is still pending, the answer can be missing cards, so it only adds to what is held (the
 * answer wins for a card in both) and never clears or re-binds a held list; once exact, it replaces the list. */
export function withRefreshedCards<T extends { openCards?: Message[]; openCardsLeaf?: string; openCardsPending?: boolean }>(b: T, action: { leafId: string; cards: Message[]; pending?: boolean }): T {
  if (!action.pending) return { ...b, openCards: action.cards.length ? action.cards : undefined, openCardsLeaf: action.leafId, openCardsPending: undefined };
  const held = b.openCards ?? [];
  const fresh = new Set(action.cards.map((card) => card.id));
  const merged = [...held.filter((card) => !fresh.has(card.id)), ...action.cards].sort((x, y) => x.at - y.at);
  return { ...b, openCards: merged.length ? merged : undefined, openCardsLeaf: action.cards.length || !held.length ? action.leafId : b.openCardsLeaf, openCardsPending: true };
}
export function olderOpenCards(owner: { openCards?: Message[]; openCardsLeaf?: string }, visible: Message[]): Message[] {
  const older = owner.openCards;
  if (!older?.length || visible[0]?.parentId === null) return visible;
  // The cards were worked out for one branch head. A branch that no longer
  // passes through it (an edit, a switch to a sibling) is not theirs.
  if (owner.openCardsLeaf && !visible.some((m) => m.id === owner.openCardsLeaf)) return visible;
  const held = new Set(visible.map((m) => m.id));
  return [...older.filter((card) => !held.has(card.id)), ...visible];
}

/** All versions of a user message (itself + the forks that replaced it),
 * oldest first. Length 1 = never edited. Indexed by parent once per held
 * transcript, so a row asks in O(versions), not O(held messages). */
export function messageVersions(bot: Bot, message: Message): Message[] {
  if (message.role !== "user" || message.kind !== "text") return [message];
  let index = versionCache.get(bot.messages);
  if (!index) {
    index = new Map();
    for (const m of bot.messages) if (m.role === "user" && m.kind === "text") index.set(m.parentId ?? null, [...(index.get(m.parentId ?? null) ?? []), m]);
    for (const list of index.values()) list.sort((x, y) => x.at - y.at);
    versionCache.set(bot.messages, index);
  }
  return index.get(message.parentId ?? null) ?? [];
}

/** GET /api/config — configured flags only; secrets are never echoed. */
export interface ConfigStatus {
  xai?: { configured: boolean };
  composio: { configured: boolean; mode?: "managed" | "unavailable"; migration?: { state?: string }; broker?: "flux" | "legacy" | null; ownKeyRetired?: boolean };
  box: { configured: boolean };
  vps: { configured: boolean; sshAlias: string };
  rooms: { turnTimeoutMinutes: number };
  /** Effort every new bot starts with where its engine offers it; absent = none sent. */
  newBots?: { effort?: EffortLevel };
  localVm: { mode: "shared" | "per-bot"; maxInstances: number };
  opencodeGo?: { configured: boolean };
  /** Voice (ElevenLabs). `configured` = a key is saved; `ready` = a key AND
   * a voice, which is what it takes to actually speak. The key itself is
   * never echoed back. */
  tts?: {
    configured: boolean;
    ready: boolean;
    voice: string;
    provider?: "flux" | "xai" | "elevenlabs" | "system";
    /** Which provider serves each part of a call (Flux, or an own key); never a key. */
    routes?: { host: string | null; lookup: string | null; speech: string | null; transcribe: string | null } | null;
    /** The harness offers streaming transcription (flag on, Flux key present). */
    streamTranscribe?: boolean;
    /** Which voice services an agent can pick from on this computer. */
    available?: { flux: boolean; xai: boolean; elevenlabs: boolean; system: boolean };
    /** an xAI key of the owner's own (not only Flux's xAI alias) */
    xaiKey?: boolean;
  };
  /** Shared write-only credential for on-demand GPT Image avatars. */
  imageGen?: { configured: boolean };
  /** Flux Router key. Presence only — the key itself is never sent to the
   * renderer. Write it with PATCH /api/config `{ flux: { apiKey } }`. */
  flux?: { configured: boolean; keyState?: FluxKeyState };
  /** Decision model switches (never a key). Absent from an older harness. */
  decider?: { enabled: boolean; /** false while this key's plan cannot use it */ available?: boolean; byoKeyConfigured?: boolean; jobs?: { roomRouting?: boolean } };
  webSearch?: { provider: "engine" | "auto" | "flux" | "tavily" | "exa" | "firecrawl" | "off"; tavilyConfigured: boolean; exaConfigured: boolean; firecrawlConfigured: boolean; fluxConfigured?: boolean };
  notifications?: import("../../shared/notification-preferences").NotificationPreferences;
  /** who's using the app — collected in onboarding, shown in the sidebar */
  profile?: { name: string; email: string };
  /** UI language override; "" (or absent) follows the system language. */
  language?: string;
  /** Opt-in flags. Absent means off. */
  features?: { skillRecorder: boolean; fluxDesktopSignin?: boolean; showToolCalls?: boolean; browser?: boolean; projectsLead?: boolean; projectsGoals?: boolean; projectsBoard?: boolean; projectsDigest?: boolean; projectsAutonomy?: boolean; projectsParallelCards?: boolean; roomsQueue?: boolean };
  /** Named browser sessions any bot can be pointed at. */
  browserProfiles?: BrowserProfile[];
  /** The harness announcing itself: `platform` is its `process.platform`,
   * the platform the server's local-Auto consent rule runs on
   * (`autoMountsLocalComputer`, server/local-routing.ts). The renderer's copy
   * of that rule reads it (`localAutoHostPlatform`) rather than guessing from
   * the browser UA, which is the browser's machine, not the harness's.
   * Absent until `/api/config` has answered, or from an older harness. */
  harness?: { platform: string };
}

export interface BrowserProfile {
  id: string;
  name: string;
  /** Read-only durable Electron routing inherited from legacy profiles.
   * Config PATCH payloads must omit it. */
  partitionId?: string;
}

/** What the server says about the saved Flux slot (server/flux-config.ts). */
export type FluxKeyState = "ok" | "missing" | "not-flux" | "refused";

export type ConfigStatusFrame = Pick<
  ConfigStatus,
  "xai" | "composio" | "box" | "vps" | "rooms" | "newBots" | "localVm" | "opencodeGo" | "tts" | "imageGen" | "flux" | "decider" | "webSearch" | "notifications" | "profile" | "language" | "features" | "browserProfiles" | "harness"
>;

export function configStatusFromFrame(frame: ConfigStatusFrame): ConfigStatus {
  return {
    xai: frame.xai,
    composio: frame.composio,
    box: frame.box,
    vps: frame.vps,
    rooms: frame.rooms,
    // The server sends both on every config frame (configStatus, server/index.ts).
    // Dropping them here made the auto-routing switch read off after any live
    // config change, and its next click saved it back on (U35).
    newBots: frame.newBots,
    localVm: frame.localVm,
    opencodeGo: frame.opencodeGo,
    tts: frame.tts,
    imageGen: frame.imageGen,
    flux: frame.flux,
    decider: frame.decider,
    webSearch: frame.webSearch,
    notifications: frame.notifications,
    profile: frame.profile,
    language: frame.language,
    features: frame.features,
    browserProfiles: frame.browserProfiles,
    harness: frame.harness,
  };
}

/** How an engine gets installed — declared by its driver, mirrors
 * EngineInstall in server/contracts.ts. Absent for engines that need no
 * local binary. `command` omits platforms that have no one-liner. */
export interface EngineInstall {
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  /** The OS of the computer running the server; the setup card shows that OS's command. */
  platform?: "darwin" | "win32" | "linux";
  docsUrl?: string;
  signInCommand?: string;
  needsNode?: boolean;
}

/** One row of GET /api/instances — the model picker's data. */
export interface InstanceInfo {
  enabled?: boolean;
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: {
    state: "available" | "unavailable";
    setupAction?: "repair";
    reason?: string;
    authenticated?: boolean;
    version?: string | null;
    /** a line shown beside the detected version (OpenClaw below its Ask floor) */
    versionNote?: string;
    /** a reported cost on a subscription is notional; the UI says so */
    billing?: "metered" | "subscription";
    /** Cloud home: offer this engine's sign-in again (Claude's token is near expiry or no longer accepted) */
    renewSignIn?: boolean;
  };
  models: { default: string; options: Array<{ id: string; label: string; custom?: boolean; loaded?: boolean; provider?: string }> };
  capabilities?: {
    computerMcp?: boolean;
    agentsMcp?: boolean;
    composioMcp?: boolean;
    browserMcp?: boolean;
    images?: boolean;
    effortLevels?: readonly EffortLevel[];
    /** the engine keeps a live session and takes a message mid-turn */
    queueing?: boolean;
    localComputerMcp?: boolean;
    /** The engine runs on its own tools and approvals (OpenClaw): Murage
     * mounts nothing into it and its approval levels do not reach it. */
    runsOnOwnTools?: boolean;
    /** This engine can answer a bounded review prompt without changing the
     * bot's active conversation. */
    approvalReview?: boolean;
  };
  /** `custom` agents sit below the rail divider — no subscription catalog. */
  access?: "subscription" | "custom";
  install?: EngineInstall;
  /** Configured CLI path override — set ONLY when the user overrode it;
   * absent means the driver default is in effect. */
  cli?: string;
  /** Driver's default binary name (e.g. "claude"). */
  cliDefault?: string;
  /** Absolute paths of every default binary found on PATH, PATH order. */
  cliCandidates?: string[];
}

// The sections, their groups and the one door a section id goes through live
// in lib/settings-sections.ts, which the command palette reads as well.
export type { AppSettingsSection };

/** Where the bot window opens: Skills with or without its picker open, or
 *  another section an Edit link in "What shapes <bot>" points at. */
export type BotSettingsIntent =
  | { section: "skills"; addSkill: boolean }
  | { section: "shapes" | "identity" | "memory" | "permissions" | "teams" | "learning"; addSkill?: undefined };

/** GET /api/instances `shellEnvironment` (Rule 74a): whether engines run with the owner's shell environment read this session,
 *  a kept one (with when and why it could not be re-read), or the app's own. */
export interface ShellEnvironment {
  capture: "session" | "kept" | "fallback";
  capturedAt?: number;
  cause?: string;
  /** One line per owner ssh setting engines do not use, or no OpenSSH found (the displaced-settings rule). */
  sshNotes?: string[];
}

export interface AppState {
  bots: Bot[];
  groups: Group[];
  instances: InstanceInfo[];
  /** One plain line the engine list shows on a Cloud home (GET /api/instances engineNote); empty on the desktop. */
  engineNote: string;
  /** Rule 74a, from GET /api/instances; null until the server has said */
  shellEnvironment?: ShellEnvironment | null;
  config: ConfigStatus | null;
  /** selected chat — a bot id OR a group id */
  selectedId: string;
  /** Bumped when the person here opens a conversation: select, a new bot,
   * switch or new task in a bot or a room. The selection and thread id also
   * move on their own (hydration, another surface); the phone drawer closes
   * on this instead (drawer-close.ts). */
  conversationPicks?: number;
  activeView: "chat" | "team-map" | "routines" | "skill-recorder" | "all-chats";
  /** All chats opened from a bot's or a channel's chat list: the Bot or Project/channel filter it starts with. */
  allChatsScope?: { botId?: string; groupId?: string };
  teamMapMemoryOpen?: boolean;
  routines: Routine[];
  routineRuns: RoutineRun[];
  webhooks: WebhookTrigger[];
  webhookAttempts: WebhookAttempt[];
  webhookIngress: WebhookIngressStatus | null;
  settingsOpen: boolean;
  /** Where the bot window opens next: a section, and for Skills whether the
   *  picker starts open ("Add a skill" from the sidebar). Read once. */
  botSettingsIntent?: BotSettingsIntent | null;
  pluginsOpen: boolean;
  /** Which half the Connected apps panel opens on (Settings > Connected
   *  apps has a button for each). Read when the panel mounts. */
  pluginsSurface?: "apps" | "mcp";
  computerOpen: boolean;
  /** the per-thread event inspector (runtime stream + native protocol tee) */
  inspectorOpen: boolean;
  /** The workspace rail beside the chat and its preview/editor tabs
   * (F4-T3). Tabs carry their own conversation, so browsing another bot's
   * file never changes `selectedId`; the reducer lives in
   * src/lib/workspace-pane.ts and only `workspacePane` actions touch it. */
  workspacePane: WorkspacePaneState;
  appSettingsOpen: boolean;
  appSettingsSection: AppSettingsSection;
  /** The card the open Settings should scroll to once its page renders (an alias, or a search result); null otherwise. */
  appSettingsAnchor: string | null;
  /** latest live frame of a bot's computer, per botId */
  screens: Record<string, { png: string; mime: string }>;
  /** A bounded preview warning; the last good pixels remain available. */
  screenNotices?: Record<string, string>;
  /** bots whose cloud computer is being provisioned */
  provisioning: Record<string, boolean>;
  /** who is driving each bot's computer: held = the person has the wheel
   * (the bot's hands are refused server-side); helpReason = the bot's open
   * plea for the person to take over */
  computerControl: Record<string, { held: boolean; helpReason: string | null }>;
  /** The sidebar's section order, kept on the computer so every device shows
   * the same one (server/sidebar-order.ts). undefined = not answered yet or a
   * harness without one; null = none saved yet. */
  sidebarSectionOrder?: string[] | null;
  /** a search hit to scroll to once its thread is on screen; nonce lets the
   * same message be focused twice in a row */
  focusMessage: { threadId: string; messageId: string; nonce: number; consumed: boolean; sentence?: string } | null;
  /** The library is a modal, not a view, so it does not belong in
   *  `activeView`. It lives here rather than inside Sidebar because the
   *  Skills panel has to be able to open it with an agent already chosen —
   *  "add a skill to Bruce" is the same action as assigning from the library,
   *  entered from the other end. `botId` is that pre-fill. */
  teamLibrary: { open: boolean; botId?: string; view?: TeamLibraryView; tab?: "import" };
  connected: boolean;
  /** The door said this browser's session is gone (GET /session → 401).
   * Final for this page: the only way back is pairing again. */
  signedOut?: boolean;
  /** The first REST snapshot has been applied. A deep link waits for it:
   * before then no thread can be placed. */
  hydrated?: boolean;
  error: string | null;
  /** After a Delete: what could not be removed, in plain words (deletion-notes.ts). */
  deletionNote: { title: string; items: string[]; retry?: boolean; owed?: boolean; retryBotId?: string; ids?: string[]; covers?: string[] } | null;
  /** the newest revision of the owed-deletion list seen (server/conversation-deletion.ts); older answers are dropped */
  owedRev: number;
  mascotMotion: {
    botId: string;
    nonce: number;
    kind: Exclude<EmberMotion, "none">;
  } | null;
  /** Queued follow-up lines waiting for drain; keyed by threadId.
   * Each entry is identified by the server queueId, not by text. */
  pendingQueued: Record<string, Array<{ queueId: string; text: string; sending?: true; sendId?: string; local?: true; refused?: PendingRefusal }>>;
  /** queueIds whose drain frame beat the POST continuation. One-shot and
   * bounded to a short event window so other clients cannot grow it forever. */
  consumedQueueIds: Record<string, true>;
  // ── Bot admission (BOTADDED-DESIGN-V3 r6 §2.1). Optional so a state built by hand reads as empty. ──
  /** Deletes this client sent and the server has not answered: nothing for the id is admitted meanwhile (§0.3). */
  pendingDeletes?: Record<string, { attempt: string; archived: boolean }>;
  /** Confirmed removals, numbered by the server: they order every later input for the id (§0.2). */
  tombstones?: Record<string, Tombstone>;
  /** The last number applied for an id, kept after its removal (§9.2); retired with its tombstone or after ANSWER_TTL_MS. */
  lastSeen?: Record<string, { epoch: string; seq: number; at: number }>;
  /** Ids to fetch once more (GET /api/bots/:id); the provider drains it. */
  verifyBots?: Record<string, true>;
  /** Ids asked for again while their fetch was outstanding: that fetch's outcome leaves them in `verifyBots` for one more. */
  verifyAgain?: Record<string, true>;
  /** Per bot: the fields still owed a settlement (a settling answer was stale, or a team change asked for them, `ensureBotDetail`);
   * the next settling answer at the held number or past it settles them, and forgets only the keys it wrote (I-H1). */
  settleOnVerify?: Record<string, ReadonlyArray<keyof Bot>>;
  /** Per bot: the latest page request this client made (§2.6). */
  pageIntent?: Record<string, number>;
  /** The server run the stream belongs to; undefined = an older server (legacy mode, today's merges). */
  streamEpoch?: string;
  /** `sentTick` of the roster that named `streamEpoch`: `admitTick` when that roster was asked for. Server runs succeed one another in
   * one line, and a roster asked for after an input of run X was received is answered by a run at or after X, so a tombstone of another
   * run written at or before this tick belongs to a run this client has moved past (left, or skipped). One written after it may belong
   * to a run the client has not reached yet (seed 524), or to one it has, and local arrival order cannot tell those apart: it waits
   * for a roster asked for after it (Astra r7 H1: the moment of adoption says nothing about run succession, a delayed roster of an
   * earlier run can be adopted after a later run's answer). */
  streamEpochTick?: number;
  /** Runs held before, each with when it was last current; bounded by ANSWER_TTL_MS (§9.4). */
  pastEpochs?: Array<{ epoch: string; seenAt: number }>;
  /** Counts every insert into `bots`; a hydrate carries the value read when its request was sent (`sentTick`). */
  admitTick?: number;
  /** A phone or browser (scoped surface): hidden records never show and a hide fences the id. */
  scopedClient?: boolean;
  /** Confirmed removals of rooms, numbered by the server: they order every later input for the id (ROOM-ORDER-DESIGN §2.2 step 3). */
  roomTombstones?: Record<string, Tombstone>;
  /** The newest statement number the last roster of the current run reflected (`roomClock`, r3 R5): a whole record of the run for a room
   * this client does not hold, numbered at or below it, is dropped. */
  roomHorizon?: { epoch: string; seq: number };
  /** The `sentAt` of the last numbered roster applied (ROOM-ORDER-DESIGN r4 T4): an answer's page closes a room's gap (unloaded or stale ->
   * live) only when its request was sent at or after it, since only then is every later row sure to follow as a frame on this connection. */
  transcriptFloor?: number;
  /** Bumped when an input says the roster must be read again (an expired answer, an unfamiliar run). The provider hydrates. */
  reconcileRequested?: number;
  /** Threads with a scrollback page in flight, so one scroll or click cannot
   * ask the server for the same page twice. */
  loadingOlder: Record<string, true>;
  /** Bumped whenever a thread's transcript is replaced or its visible branch
   * moves. A scrollback page carries the value it was asked under, so a page
   * that was in flight across a thread switch, an edit or a rewind is dropped
   * instead of prepending rows from a transcript this client left behind.
   * Ordinary appends do not bump it: a page must still land over messages
   * that arrived while it was on the wire (upstream #1527). */
  transcriptGeneration: Record<string, number>;
  /** Per conversation (bot task or room thread, held or not): how many times the server said its open cards became exact. A notice is kept whether or not
   * the conversation is the one on screen, so a snapshot that lands later (a task switched to, a room opened) still finds it. */
  cardsReady: Record<string, number>;
  /** How many times the server said every waiting conversation became exact (open-cards.ready with no thread). Counts for each conversation. */
  cardsReadyAll: number;
  /** Per conversation: the readiness revision its last accepted open-cards answer fulfilled, and the transcript generation that answer was for. Set only
   * by the reducer; a fulfilment of an earlier generation (another task's transcript, a replaced snapshot) counts for nothing. */
  cardsFulfilled: Record<string, { gen: number; rev: number }>;
}

const MAX_CONSUMED_QUEUE_IDS = 64;

/** A confirmed removal of a bot (§0.2). `seq` Infinity: a removal from an older server, which carried no number. */
export interface Tombstone {
  epoch: string;
  seq: number;
  kind: "deleted" | "hidden";
  confirmedAt: number;
  streamAcked: boolean;
  /** Written by a roster's `removed[]`: acked once the frames buffered behind that roster were drained (§9 builder row). */
  ackOnDrain?: true;
  /** `admitTick` when written: a roster asked for after it, once its connection's buffer is drained, proves the stream passed it. */
  tick?: number;
}

/** The payload of `groupEdited`: the room's local keys, and local keys of its task rows, by thread id. */
export type RoomEdit = { id: string; tasks?: Array<{ threadId: string } & Partial<Pick<GroupTask, RoomTaskLocalKey>>> } & Partial<Pick<Group, RoomLocalKey>>;

/** One entry of the roster's `removedGroups[]`: a room removed (or hidden from a scoped audience), at the removal's own number. */
export interface RemovedRoomEntry { id: string; recordSeq: number; recordEpoch: string; kind: "deleted" | "hidden" }

/** One of the roster's `removed[]` (server/bot-deletion-ledger.ts RemovedEntry). */
export interface RemovedEntry { id: string; tasksSeq: number; tasksEpoch: string; kind: "deleted" | "hidden" }

function rememberConsumedQueueId(
  consumed: AppState["consumedQueueIds"],
  queueId: string,
): AppState["consumedQueueIds"] {
  const next = { ...consumed, [queueId]: true as const };
  const overflow = Object.keys(next).length - MAX_CONSUMED_QUEUE_IDS;
  if (overflow > 0) {
    for (const id of Object.keys(next).slice(0, overflow)) delete next[id];
  }
  return next;
}

interface QueueReceiptSnapshot {
  messages?: Array<Pick<Message, "queueId" | "at">>;
}

/** A live event queued while a conversation's first page is on the wire. */
export type FirstPageEvent = Extract<Action, { type: "messageAdded" | "messagePatched" | "threadActive" }>;

/** A replacement snapshot can contain the canonical user line after this
 * window missed its queue-drain frame. Remove any matching chip and retain a
 * short tombstone so a slower POST continuation cannot add the chip back. */
/** The queue id of a send that has not been answered yet (never a server id). */
export const sendingQueueId = (sendId: string): string => `sending:${sendId}`;

/** A send the server is holding for a thread: still being handed to the engine
 * ("sending") or waiting for the bot or room ("queued"). Authoritative: every
 * client shows this list, whichever device the words were typed on. */
export interface ServerPendingSend {
  queueId: string;
  sendId?: string;
  text: string;
  /** "refused": the bot or room could not start it; the words wait for "Send again" or "Dismiss". */
  state: "sending" | "queued" | "refused";
  notice?: SendNoticeCode;
  replyToId?: string;
  mode?: "chat" | "goal";
  responderId?: string;
  /** Present on a chip held by a restore: Send again must present it. */
  restoreGen?: string;
  /** Present on a chip held because the owner pressed Stop: only a Send again pressed after that Stop can present it. */
  stopGen?: string;
}

/** What "Send again" repeats for a refused send: the same id, reply, mode and responder. */
export interface PendingRefusal {
  notice: SendNoticeCode;
  replyToId?: string;
  mode?: "chat" | "goal";
  responderId?: string;
  restoreGen?: string;
  stopGen?: string;
}

/** The server's list replaces what a thread shows as waiting. A line this client
 * is still delivering (no server record yet) stays; once the server knows the
 * send, the server's entry stands in for it. */
function mergeServerPending(
  prev: AppState["pendingQueued"][string] | undefined,
  server: ServerPendingSend[],
): AppState["pendingQueued"][string] {
  const serverSendIds = new Set(server.flatMap((entry) => (entry.sendId ? [entry.sendId] : [])));
  const serverQueueIds = new Set(server.map((entry) => entry.queueId));
  const local = (prev ?? []).filter((entry) => {
    // only a line THIS device is still delivering; the server's own entries are replaced wholesale
    if (!entry.local || serverQueueIds.has(entry.queueId)) return false;
    const sendId = entry.sendId ?? entry.queueId.replace(/^sending:/, "");
    return !serverSendIds.has(sendId);
  });
  const fromServer = server.map((entry) => ({
    queueId: entry.queueId,
    text: entry.text,
    ...(entry.sendId ? { sendId: entry.sendId } : {}),
    ...(entry.state === "sending" ? { sending: true as const } : {}),
    ...(entry.state === "refused" ? { refused: {
      notice: entry.notice ?? "refused",
      ...(entry.replyToId ? { replyToId: entry.replyToId } : {}),
      ...(entry.mode ? { mode: entry.mode } : {}),
      ...(entry.responderId ? { responderId: entry.responderId } : {}),
      ...(entry.restoreGen ? { restoreGen: entry.restoreGen } : {}),
      ...(entry.stopGen ? { stopGen: entry.stopGen } : {}),
    } } : {}),
  }));
  return [...fromServer, ...local];
}

/** The send id behind a waiting or refused line, wherever it is listed. */
function queuedSendId(pending: AppState["pendingQueued"], queueId: string): string | undefined {
  for (const entries of Object.values(pending)) {
    const found = entries.find((entry) => entry.queueId === queueId);
    if (found) return found.sendId;
  }
  return undefined;
}

function applyServerPending(
  state: AppState,
  pendingSends: Record<string, ServerPendingSend[]>,
): AppState {
  const pendingQueued: AppState["pendingQueued"] = {};
  const threads = new Set([...Object.keys(state.pendingQueued), ...Object.keys(pendingSends)]);
  for (const threadId of threads) {
    const merged = mergeServerPending(state.pendingQueued[threadId], pendingSends[threadId] ?? []);
    if (merged.length) pendingQueued[threadId] = merged;
  }
  return { ...state, pendingQueued };
}

function reconcileSnapshotQueues(
  state: AppState,
  conversations: QueueReceiptSnapshot[],
): AppState {
  const landed: Array<{ queueId: string; at: number }> = [];
  for (const conversation of conversations) {
    for (const message of conversation.messages ?? []) {
      if (message.queueId) landed.push({ queueId: message.queueId, at: message.at });
    }
  }
  if (landed.length === 0) return state;

  const landedIds = new Set(landed.map((entry) => entry.queueId));
  const pendingQueued: AppState["pendingQueued"] = {};
  for (const [threadId, entries] of Object.entries(state.pendingQueued)) {
    const waiting = entries.filter((entry) => !landedIds.has(entry.queueId));
    if (waiting.length > 0) pendingQueued[threadId] = waiting;
  }

  let consumedQueueIds = state.consumedQueueIds;
  // Preserve the newest receipts when a large historical snapshot contains
  // more than the bounded tombstone window.
  landed.sort((left, right) => left.at - right.at);
  for (const entry of landed) {
    consumedQueueIds = rememberConsumedQueueId(consumedQueueIds, entry.queueId);
  }
  return { ...state, pendingQueued, consumedQueueIds };
}

export type BotAnnouncement = Omit<Bot, "messages"> & { messages?: Message[] };

/** Which half of the library modal opens first.
 *
 *  "Add a skill to Bruce" is a different question from "browse teams", and
 *  landing a person on the team grid after they asked for a skill is how the
 *  intake's one escape hatch stopped being an escape hatch. Absent means the
 *  panel's own default. */
export type TeamLibraryView = "bots" | "teams" | "skills";

/** How a held hand-off's Send again / Dismiss ended: the row awaits it, so a refused action puts its buttons back. */
export interface DelegationActionSettled { resolve(): void; reject(error: unknown): void }
/** Where a bot-record action came from (BOTADDED-DESIGN-V3 r6 §2.2, I8). Nothing built from an `api()` answer is `local`. */
export type StreamOrigin = { source: "stream" };
export type LocalOrigin = { source: "local" };
export type BotOrigin = HttpOrigin | StreamOrigin | LocalOrigin;
export type { HttpOrigin };
/** How a Delete the person asked for ended (the archived list waits for it). */
export type DeleteOutcome = { outcome: "deleted" | "refused" | "gaveUp"; error?: string };

export type Action =
  | ({
      type: "hydrate";
      bots: Bot[];
      groups: Group[];
      computerControl: Record<string, { held: boolean; helpReason: string | null }>;
      sidebarSectionOrder?: string[] | null;
      /** The server's pending sends per thread (absent from an older server). */
      pendingSends?: Record<string, ServerPendingSend[]>;
      /** The server run this roster was read in; absent from an older server or a non-owner caller (legacy membership). */
      tasksEpoch?: string;
      /** This run's removals younger than ANSWER_TTL_MS (§2.8): each becomes a tombstone. */
      removed?: RemovedEntry[];
      /** The roster's rooms removed within ANSWER_TTL_MS (owner audiences), numbered: each becomes a room tombstone (ROOM-ORDER-DESIGN §2.4). */
      removedGroups?: RemovedRoomEntry[];
      /** The server's room clock when the roster was built: every statement numbered at or below it is reflected in the rows (r3 R5). */
      roomClock?: number;
      /** `admitTick` read when the request was sent (§2.8 r6): an unlisted held bot inserted at or before it is gone. Absent = every
       * unlisted bot is gone (today's behaviour). */
      sentTick?: number;
      /** The live-events generation the roster was requested under (§9.4); the provider ignores an older one. */
      liveGen?: number;
      /** The conversation this device left open last time, passed only when setup is finished; a landing preference ahead of the Chief. */
      resumeId?: string;
    } & HttpOrigin)
  | { type: "serverSends"; threadId: string; pending: ServerPendingSend[] }
  | { type: "showRoutines" }
  | { type: "showTeamMap"; memory?: boolean }
  | { type: "showTeamLibrary"; botId?: string; view?: TeamLibraryView; tab?: "import" }
  | { type: "hideTeamLibrary" }
  | { type: "showSkillRecorder" }
  /** All chats (CHATS-FINDABILITY-DESIGN 3): every chat across bots and channels; a scope pre-sets its filter. */
  | { type: "showAllChats"; botId?: string; groupId?: string }
  /** Back from All chats to the chat that was open. */
  | { type: "closeAllChats" }
  | { type: "routinesHydrated"; routines: Routine[]; runs: RoutineRun[] }
  | { type: "routinePatched"; routine: Routine }
  | { type: "routineDeleted"; routineId: string }
  | { type: "routineRunDeleted"; runId: string }
  | { type: "routineRunPatched"; run: RoutineRun }
  | { type: "webhooksHydrated"; webhooks: WebhookTrigger[]; attempts: WebhookAttempt[]; ingress: WebhookIngressStatus }
  | { type: "webhookPatched"; webhook: WebhookTrigger }
  | { type: "webhookAttempted"; attempt: WebhookAttempt }
  | { type: "webhookDeleted"; webhookId: string }
  | { type: "createRoutine"; input: RoutineInput }
  | { type: "updateRoutine"; routineId: string; patch: Partial<RoutineInput> }
  | { type: "deleteRoutine"; routineId: string }
  | { type: "runRoutine"; routineId: string }
  | { type: "stopDelegation"; delegationId: string }
  | { type: "resendDelegation"; delegationId: string; threadId?: string; settled?: DelegationActionSettled }
  | { type: "dismissDelegation"; delegationId: string; threadId?: string; settled?: DelegationActionSettled }
  | { type: "cancelRoutineRun"; runId: string }
  | { type: "markRoutineRunSeen"; runId: string }
  | { type: "markAllRoutineRunsSeen" }
  /** The server's statement about a room: an answer or a frame, never the client's own change (ROOM-ORDER-DESIGN §2.1). */
  | { type: "groupPatched"; origin: RoomOrigin; group: Partial<Group> & { id: string }; removedTaskIds?: string[] }
  /** This client's own change to the keys only it writes. Applies to a held room; never inserts, never numbers, never touches a tombstone. */
  | { type: "groupEdited"; group: RoomEdit }
  /** A channel edit the server refused: puts the fields the optimistic patch changed back, so the control does not show a value that was never saved. */
  | { type: "groupPatchReverted"; groupId: string; fields: Partial<Group> }
  | { type: "groupDeleted"; origin: RoomOrigin; groupId: string; recordSeq?: number; recordEpoch?: string; hidden?: true }
  | {
      type: "createGroup";
      memberIds: string[];
      name?: string;
      section?: string;
      /** Shared instructions for everyone in the channel, saved with the
       * channel so a person who already knows what the work is never has to
       * create it and then go and tell it. */
      bulletin?: string;
      /** A goal, given at creation: this channel is a project from its first
       * moment rather than a channel someone converts later. */
      channelProject?: ChannelProjectInput;
    }
  | {
      type: "sendGroup";
      groupId: string;
      text: string;
      /** What the composer held, so a reload cannot lose it (the send outbox). */
      outboxDraft?: OutboxDraft;
      sendId?: string;
      /** The owner pressed Send again on a refused chip: the only action that may run a restore-held send. */
      resend?: true;
      /** The restore generation the refused chip carried (PendingRefusal.restoreGen). */
      restoreGen?: string;
      /** The stop token the refused chip carried (PendingRefusal.stopGen). */
      stopGen?: string;
      /** Minted fresh by each Send again press; an automatic retry of the press replays it. */
      actionId?: string;
      replyToId?: string;
      threadId?: string;
      mode?: "chat" | "goal";
      /** Pins the send to one member (a room-call hand-down): the server
       * routes to that member alone, whatever the text names. */
      responderId?: string;
      /** Runs when the harness accepts the send: the id it got and, when the
       * send waits for the room, the queue row it became. */
      onReceipt?: (receipt: { sendId: string; requestId?: string; queued: boolean }) => void;
      /** Runs after a failed send. Returning true means the caller has shown
       * the failure where it happened, so the store adds no toast of its own. */
      onError?: (error: unknown) => boolean | void;
    }
  | {
      type: "patchGroup";
      groupId: string;
      patch: Partial<Pick<Group, "name" | "bulletin" | "memberIds" | "defaultResponder" | "pinnedMessageId" | "section">> & {
        /** true files the channel away, false brings it back. */
        hidden?: boolean;
        /** A goal, a status, or both. `null` clears the purpose and the
         * channel goes back to being an ordinary channel, keeping its chat,
         * its bots, its instructions and its folder. */
        channelProject?: ChannelProjectInput | null;
      };
    }
  | { type: "deleteGroup"; groupId: string }
  | { type: "newGroupTask"; groupId: string }
  | { type: "switchGroupTask"; groupId: string; threadId: string }
  | { type: "renameGroupTask"; groupId: string; threadId: string; title: string }
  | { type: "deleteGroupTask"; groupId: string; threadId: string }
  /** queueIds: an inject for these queued sends; a no-op once they started. */
  | { type: "interruptGroup"; groupId: string; queueIds?: string[] }
  | { type: "instances"; instances: InstanceInfo[]; shellEnvironment?: ShellEnvironment | null; engineNote?: string }
  | { type: "configStatus"; config: ConfigStatus }
  | { type: "select"; id: string; threadId?: string }
  | {
      type: "send";
      botId: string;
      text: string;
      /** What the composer held, so a reload cannot lose it (the send outbox). */
      outboxDraft?: OutboxDraft;
      sendId?: string;
      /** The owner pressed Send again on a refused chip: the only action that may run a restore-held send. */
      resend?: true;
      /** The restore generation the refused chip carried (PendingRefusal.restoreGen). */
      restoreGen?: string;
      /** The stop token the refused chip carried (PendingRefusal.stopGen). */
      stopGen?: string;
      /** Minted fresh by each Send again press; an automatic retry of the press replays it. */
      actionId?: string;
      replyToId?: string;
      threadId?: string;
      /**
       * Runs once the server has ACCEPTED the message, queued or delivered.
       *
       * The only confirmation a caller gets that anything happened. `dispatch`
       * returns nothing, so without this a caller cannot tell a message that
       * landed from one the route refused, and the first run settled its last
       * step on a send it had never heard back from.
       */
      onSent?: () => void;
      /** Runs after a failed send. Returning true means the caller has shown
       * the failure where it happened, so the store adds no toast of its own. */
      onError?: (error: unknown) => boolean | void;
    }
  | { type: "pendingQueued"; threadId: string; queueId: string; text: string }
  /** A send is in flight while the bot is busy: its words show at once, as a
   * "Sending" line above the composer, until the server answers (steered,
   * queued or refused). Never silently gone. */
  | { type: "sendingStarted"; threadId: string; sendId: string; text: string }
  | { type: "sendingSettled"; threadId: string; sendId: string }
  | { type: "consumePendingQueued"; threadId: string; queueId: string }
  | { type: "cancelQueued"; botId: string; queueId: string }
  | {
      type: "cancelGroupQueued";
      groupId: string;
      threadId: string;
      queueId: string;
      /** Runs when the cancel succeeded. */
      onDone?: () => void;
      /** Runs when it failed; returning true means the caller handled it, so no toast. */
      onError?: (error: unknown) => boolean | void;
    }
  | { type: "editMessage"; botId: string; threadId?: string; messageId: string; text: string; sendId?: string; signal?: AbortSignal; onSent?: () => void; onError?: (error: unknown) => boolean | void }
  | { type: "switchBranch"; botId: string; threadId?: string; messageId: string }
  | { type: "threadActive"; threadId: string; activeLeafId: string; sidebarLine?: SidebarLine }
  | { type: "answerCard"; botId: string; messageId: string; answer: string }
  | { type: "dismissCard"; botId: string; messageId: string }
  /** Undo of dismissCard for the first-run question: the only way back to a
   * card the X removed. Onboarding cards only — a live ask that was denied is
   * settled with the provider and cannot be un-denied from here. */
  | { type: "restoreCard"; botId: string; messageId: string }
  // permission cards answer by THREAD, so a request raised inside a room
  // can be answered the same way as one in a 1:1 chat
  | {
      type: "decideRequest";
      threadId: string;
      requestId: string;
      behavior: "allow" | "deny" | "answer";
      message?: string;
      /** Exact proposal hash displayed by a current learned-skill client. */
      reviewedSha256?: string;
      /** remember this exact grant (the server's allowKey) for the bot, or a
       * several-action card's whole set (its allowKeys, Rule 78c) */
      alwaysAllow?: { botId: string; key?: string; keys?: string[] };
      /** "Always allow for this routine" (AMEND-13 Rules 81, 82): the server
       * rereads the card's own offer and saves its whole action set, plus each
       * offered stop the owner also ticked (`stopKeys`); an older card names
       * its one routineAllowKey (`key`). `onSaved` gets what the server saved. */
      alwaysAllowRoutine?: { routineId: string; key?: string; stopKeys?: string[]; onSaved?: (keys: string[]) => void };
      /** a stop-line card's "Allow for this task": the server records the
       * card's own scoped grant (taskAllowKey) for this task */
      allowForTask?: boolean;
      /** The card the owner is looking at: the phone checks it against the
       * server's challenge before it asks for Face ID. */
      card?: import("../../shared/approval-digest").DigestCard;
      /** The bot's name, for the words under the Face ID prompt. */
      botName?: string;
      /** Local UI recovery hook for voice flows. Never sent to the server.
       * A Face ID cancel arrives as ("", "cancelled"). */
      onError?: (message: string, code?: import("../lib/fresh-auth").FreshAuthCode) => void;
      /** Local UI hook: the answer was accepted by the server. Never sent. */
      onSuccess?: () => void;
      /** Local UI hook: the phone's device prompt opened (true) or closed (false). Never sent. */
      onDevicePrompt?: (up: boolean) => void;
    }
  /** QW Q4: a press on a widget. The server writes the owner's message, settles the widget and queues the words. */
  | {
      type: "respondWidget";
      threadId: string;
      widgetId: string;
      ref: string;
      rev?: number;
      values?: Record<string, string | boolean>;
      other?: Record<string, string>;
      /** Local hooks for the widget. Never sent to the server. */
      onSuccess?: () => void;
      onError?: (message: string, code?: string) => void;
    }
  /** QW 208: a settled widget's answers reopened in a new widget. */
  | { type: "reopenWidget"; threadId: string; widgetId: string; onError?: (message: string) => void }
  /** A question card's answer or explicit skip, by THREAD (works in rooms). */
  | {
      type: "answerQuestion";
      threadId: string;
      requestId: string;
      behavior: "answer" | "skip";
      answers?: QuestionAnswer[];
      /** Local recovery hook for the card. Never sent to the server. */
      onError?: (message: string) => void;
    }
  /** An expired question's answer as an ordinary message. A 1:1 chat (`botId`) sends one request that records the card
   * and the message together (QW Q1b); a room (`groupId`) posts the message, then records it on the card. */
  | {
      type: "sendQuestionAsMessage";
      botId?: string;
      groupId?: string;
      threadId: string;
      requestId: string;
      text: string;
      answers: QuestionAnswer[];
      /** QW: a bot's ask_user card (also in a room): its late answer is ONE claim on the server, like a 1:1 chat's. */
      answerAsSend?: boolean;
      onError?: (message: string) => void;
    }
  | { type: "newTask"; botId: string; cwd?: string }
  | { type: "switchTask"; botId: string; threadId: string }
  /** http: a page this client asked for, applied only under its latest `intent` (§2.6). stream: the 2323 composite. */
  | ({ type: "taskSwitched"; bot: Bot } & ((HttpOrigin & { intent: number }) | StreamOrigin | LocalOrigin))
  /** Switching to a recently opened task: its cached page, at once. */
  | { type: "conversationFromCache"; botId: string; entry: CachedConversation }
  /** The reconcile of a page opened from the cache: what changed since. */
  | ({ type: "threadDeltaApplied"; bot: BotAnnouncement & { threadDelta: { messages: Message[]; activeLeafId?: string | null } }; intent: number } & HttpOrigin)
  | { type: "renameTask"; botId: string; threadId: string; title: string }
  | { type: "pinTask"; botId: string; threadId: string; pinned: boolean }
  | { type: "deleteTask"; botId: string; threadId: string }
  | { type: "newBot" }
  | ({ type: "botAdded"; bot: Bot } & HttpOrigin)
  /** The person deleted a bot (the sidebar, or the archived list with `archived`): removed at once, pending until the DELETE's own
   * answer or the deletion frame (§2.7). `attempt` is a client nonce (newDeleteAttempt); `onSettled` is a local hook, never sent. */
  | { type: "deleteBot"; source: "local"; botId: string; attempt: string; archived?: boolean; onSettled?: (result: DeleteOutcome) => void }
  /** The stream's `bot.deleted`: `hidden` is a hide sent to a scoped stream (`audience: "remote"`), else a real deletion. */
  | { type: "botDeleted"; source: "stream"; botId: string; hidden: boolean; tasksSeq?: number; tasksEpoch?: string }
  /** The DELETE effect's outcome, matched to the pending delete by `attempt` (§2.7 r6). */
  | { type: "deletionSettled"; source: "http"; botId: string; attempt: string; outcome: "deleted" | "refused" | "gaveUp"; tasksSeq?: number; tasksEpoch?: string; error?: string }
  /** A page of this bot is about to be asked for: answers carrying an older intent leave the page alone (§2.6). */
  | { type: "pageRequested"; botId: string; intent: number }
  /** The provider's one-minute timer: retire tombstones, `lastSeen` and past runs older than ANSWER_TTL_MS (§2.7). */
  | { type: "tombstonesSweep"; now: number }
  /** The server's answer to a "Can talk to" save: the stored value, My team being absent. */
  | { type: "messageAllowSet"; botId: string; messageAllow: Bot["messageAllow"] }
  /** The provider drained the frames buffered behind a hydrate: that roster's tombstones are now stream-acked (§9 builder row). */
  | { type: "streamDrained" }
  /** A verification fetch (verifyBots) ended without a record: `gone` (404) removes a held bot and settles it. Otherwise (no answer)
   * the id stays asked for and is fetched again (order P17), unless `giveUp` (the provider's bound on repeated failures).
   * `sentTick`: `admitTick` when the fetch was sent. A 404 to a fetch sent before the held bot was admitted (a restore frame that
   * outran it) answers an older question: the bot is kept and verified again, as a hydrate keeps a bot admitted after its send (§2.8). */
  | { type: "verifySettled"; botId: string; gone: boolean; giveUp?: true; sentTick?: number }
  /** Whether this client is a scoped surface (phone, browser): set once the desktop proof is known. */
  | { type: "clientScope"; scoped: boolean }
  | { type: "duplicateBot"; botId: string }
  | { type: "markUnread"; botId: string }
  /** `overlay`: edits still in flight (bot-patch-queue), laid over after admission. http `intent`: the deleteTask answer (page by
   * thread, see reducer). http `verified`: a verification or detail fetch, the authoritative current state (§9.3). http `settled`:
   * the record fields this answer states completely (a refused edit's fields, a team change's): at the held number or past it the
   * held copy takes the record's value for each, absent included; an answer a frame outran is asked again (CI-OVERLAY-DESIGN). */
  | ({ type: "botPatched"; bot: BotAnnouncement; overlay?: Partial<BotAnnouncement> } & ((HttpOrigin & { intent?: number; verified?: boolean; settled?: ReadonlyArray<keyof Bot> }) | StreamOrigin | LocalOrigin))
  /** `newestSeq`: the envelope's newest number (r8 wire contract), on a numbered thread's frame or POST answer. `origin`: a POST answer's
   * (absent: the stream's frame), which decides whether the row is vouched for (r6 Q3). */
  | { type: "messageAdded"; threadId: string; message: Message; newestSeq?: number; origin?: RoomOrigin }
  | { type: "messagePatched"; threadId: string; message: Message; newestSeq?: number; origin?: RoomOrigin }
  | { type: "screenFrame"; botId: string; png: string; mime: string }
  | { type: "screenUnavailable"; botId: string; message: string }
  | { type: "provisioning"; botId: string; on: boolean }
  | { type: "computerControl"; botId: string; held: boolean; helpReason: string | null }
  | { type: "sidebarSectionOrder"; order: string[] }
  | { type: "setModel"; botId: string; threadId?: string; selection: ModelSelection }
  | { type: "updateTask"; botId: string; threadId: string; patch: Partial<Pick<Task,"modelSelection"|"autoApprove"|"fullAccess"|"noLimits"|"cwd"|"unread"|"title">> & {link?:string|null;acknowledgeLocalAuto?:boolean;acknowledgeFullAccess?:boolean;acknowledgeNoLimits?:boolean} }
  | { type: "interrupt"; botId: string; threadId?: string }
  | { type: "connected"; value: boolean }
  | { type: "signedOut" }
  | { type: "error"; message: string | null }
  /** `retryBotId`: a bot Delete that got no answer; "Try again" sends it again. */
  | { type: "deletionNote"; note: { title: string; items: string[]; retry?: boolean; owed?: boolean; retryBotId?: string; ids?: string[]; covers?: string[] } | null }
  /** What the server says is still owed for deleted conversations (the whole list, possibly empty). A list shows the notice; an
   * empty one clears a notice of this kind and leaves any other note alone. Anything that is not a list is ignored. */
  | { type: "deletionOwed"; notices: unknown; /** the server's revision of the list: an answer older than the newest one seen is dropped */ rev?: unknown;
      /** the answer to the owner's own dismiss: the list as the server has it after the dismiss, applied even under the revision its own
       * broadcast already carried (that broadcast may have been seen first), so only the lines it covered go and any other owed line stays */
      answer?: boolean }
  | { type: "toggleSettings"; open?: boolean; intent?: BotSettingsIntent }
  | { type: "clearBotSettingsIntent" }
  | { type: "togglePlugins"; open?: boolean; surface?: "apps" | "mcp" }
  | { type: "toggleComputer"; open?: boolean }
  | { type: "toggleInspector"; open?: boolean }
  | { type: "workspacePane"; action: WorkspacePaneAction }
  // maxPages: how far back to walk for it (a deep link walks less far)
  | { type: "focusMessage"; threadId: string; messageId: string; maxPages?: number; sentence?: string }
  // scrollback: ask the server for the page before the oldest message held
  | { type: "loadOlderMessages"; threadId: string }
  | { type: "olderMessages"; threadId: string; generation: number; messages: Message[]; hasMore: boolean; olderFrom?: string | null; before?: string; newestSeq?: number }
  // a conversation's first page (scrollback loadFirstPage): asked for, landed, failed
  | { type: "loadFirstPage"; threadId: string }
  | { type: "firstPageStarted"; threadId: string }
  | { type: "firstPage"; threadId: string; generation: number; page: FirstPageAnswer }
  | { type: "firstPageFailed"; threadId: string }
  // a task list fetched to repair a delta that did not fit; applied only if no newer frame has landed
  | ({ type: "tasksResynced"; botId: string; tasks: Task[]; tasksSeq?: number; tasksEpoch?: string; tasksTotal?: number; tasksOlder?: string | null; usageTotal?: TaskUsage; grantsAll?: string[] } & HttpOrigin)
  // tasks outside the window, asked for by thread id or as an older page; held beside the window, never in it
  | { type: "tasksFetched"; owner: "bot" | "group"; id: string; tasks: Task[] }
  | { type: "threadSettingsSaved"; botId: string; threadId: string; keys: string[]; task: Partial<Task>; sentSeq: number | undefined }
  // the open cards of the branch a conversation now shows
  | { type: "openCardsRefreshed"; threadId: string; leafId: string; cards: Message[]; rev: number; pending?: boolean; readyRev?: number; gen?: number; requestLeaf?: string }
  | { type: "openCardsReady"; threadId: string | null }
  | { type: "focusMessageConsumed"; nonce: number }
  /** Page back until the selected branch head is held (branchHeadMissing). */
  | { type: "loadBranchHead"; threadId: string; messageId: string }
  /** Fetch one bot's whole record (its full description) when the roster sent a cut copy; `settled`: the fields that record settles
   * (a team change's), see `botPatched`. */
  | { type: "ensureBotDetail"; botId: string; settled?: ReadonlyArray<keyof Bot> }
  /** `anchor`: a DOM id on the page to scroll to and highlight (a search result); without it an alias supplies its own. */
  | { type: "toggleAppSettings"; open?: boolean; section?: AppSettingsSection; anchor?: string }
  /** The modal has scrolled to the anchor (or gave up): forget it. */
  | { type: "appSettingsAnchorDone" }
  | {
      type: "updateBot";
      botId: string;
      patch: BotUpdatePatch;
    };

/** Project for conversation controls only. Profile editors keep bot defaults. */
/** A cached page opens only into the bot it was taken from, and only while
 * that task is still one of its own. */
/** True once the stream has proved itself since the last drop: a resumed hello,
 * or a snapshot loaded after a failed resume. Until then a cached page may be stale. */
const streamProof = { live: false };

/** The cached page a switch may paint at once. While the stream is not known
 * to be live (after a wake or a drop, before the reconnect's hello), the page
 * could be about to be cleared as stale, so it is not painted. */
export function cachedPaintFor(
  cache: { get(threadId: string): CachedConversation | undefined } | null | undefined,
  leaving: Bot | undefined,
  threadId: string,
  streamLive: boolean,
): CachedConversation | undefined {
  if (!streamLive) return undefined;
  const cached = cache?.get(threadId);
  return cached && opensFromCache(leaving, cached) ? cached : undefined;
}

export function opensFromCache(bot: Bot | undefined, entry: CachedConversation): boolean {
  return Boolean(bot && entry.ownerId === bot.id && mayHoldTask(bot, entry.threadId));
}

/** What the conversation cache keeps of the page a bot is leaving. */
export function cachedPage(bot: Bot): CachedConversation {
  return {
    ownerId: bot.id,
    threadId: bot.threadId,
    messages: bot.messages,
    hasMore: bot.hasMore,
    olderFrom: bot.olderFrom,
    activeLeafId: bot.activeLeafId,
    openCards: bot.openCards,
    openCardsLeaf: bot.openCardsLeaf,
    version: bot.threadVersion,
  };
}

/** The held row fields a thread settings PATCH key decides (the server's answer row says what they are now). */
const SAVED_THREAD_FIELDS: Record<string, readonly (keyof Task)[]> = {
  modelSelection: ["modelSelection", "followsBotModel"],
  autoApprove: ["autoApprove", "fullAccess", "noLimits"],
  fullAccess: ["autoApprove", "fullAccess", "noLimits"],
  noLimits: ["autoApprove", "fullAccess", "noLimits"],
};
/** A thread settings save the server confirmed, laid over the held task row: only the fields the PATCH decided, taken from the
 * answer's own row (a field the answer leaves out is cleared: a chat back on following its bot has no modelSelection). The live
 * frame carries the same row; this keeps the header right when no frame comes (no stream yet, or a reconnect). The answer is
 * not numbered, so the reducer lays it only while the held record is still at the number it had when the save was sent: once a
 * frame has spoken, that frame (or the next) is the answer, and a late reply never undoes another window's newer save. */
/** The number of the record a client holds for a bot (the same one admission orders frames by). */
export const heldRecordSeq = (bot: Pick<Bot, "recordSeq" | "tasksSeq">): number | undefined => bot.recordSeq ?? bot.tasksSeq;
export function withSavedThreadSettings(bot: Bot, threadId: string, keys: readonly string[], answer: Partial<Task>): Bot {
  const fields = [...new Set(keys.flatMap((key) => SAVED_THREAD_FIELDS[key] ?? []))];
  if (!fields.length || answer.threadId !== threadId || !bot.tasks?.some((task) => task.threadId === threadId)) return bot;
  const tasks = bot.tasks.map((task) => {
    if (task.threadId !== threadId) return task;
    const next: Record<string, unknown> = { ...task };
    for (const field of fields) {
      if (answer[field] === undefined) delete next[field];
      else next[field] = structuredClone(answer[field]);
    }
    return next as unknown as Task;
  });
  return { ...bot, tasks };
}

export function viewedTaskBot(bot: Bot): Bot {
  const task=findTask(bot,bot.threadId);
  if(!task)return bot;
  return {...bot,modelSelection:task.modelSelection??bot.modelSelection,autoApprove:task.autoApprove??bot.autoApprove,fullAccess:(task.autoApprove??bot.autoApprove)===true&&task.fullAccess===true,noLimits:(task.autoApprove??bot.autoApprove)===true&&task.fullAccess===true&&task.noLimits===true,alwaysAllow:task.alwaysAllow??bot.alwaysAllow,busy:task.busy??bot.busy,activity:task.activity??bot.activity,unread:task.unread??bot.unread,pinnedMessageId:task.pinnedMessageId,turnStartedAt:task.turnStartedAt??null,browserMounted:task.browserMounted===true,subtasks:task.subtasks};
}
export function withThreadUnread(bot:Bot,threadId:string,unread:boolean):Bot {
  if(!bot.tasks?.length)return {...bot,unread};
  const tasks=bot.tasks.map(task=>task.threadId===threadId?{...task,unread}:task);
  return {...bot,tasks,unread:tasks.some(task=>task.unread)};
}

interface NotificationThreadOwner {
  id: string;
  threadId: string;
  tasks?: Array<{ threadId: string }>;
  tasksTotal?: number;
  extraTasks?: Array<{ threadId: string }>;
}

interface NotificationRoutingState {
  bots: NotificationThreadOwner[];
  groups: NotificationThreadOwner[];
}

/** The exact conversation currently on screen. A focused window is not
 * enough to suppress an alert when its actionable card is in another task. */
export function visibleNotificationThread(
  state: NotificationRoutingState & Pick<AppState, "activeView" | "selectedId">,
): string | null {
  if (state.activeView !== "chat") return null;
  return (
    state.bots.find((candidate) => candidate.id === state.selectedId)?.threadId ??
    state.groups.find((candidate) => candidate.id === state.selectedId)?.threadId ??
    null
  );
}

export function openNotificationTarget(
  dispatch: (action: Action) => void,
  target: { botId?: string; threadId: string },
  state: NotificationRoutingState,
): boolean {
  // A room's approval/question notification carries the asker bot with the
  // GROUP's thread id; asking the bot to switch to that thread would 404.
  // Open the room itself. A thread that is neither a room nor one of the
  // bot's own lands on a plain bot select instead of an error banner.
  const group = state.groups.find(
    (candidate) =>
      candidate.threadId === target.threadId ||
      findTask(candidate, target.threadId) !== undefined,
  );
  if (group) {
    dispatch({ type: "select", id: group.id });
    if (group.threadId !== target.threadId) {
      dispatch({ type: "switchGroupTask", groupId: group.id, threadId: target.threadId });
    }
    return true;
  }
  // A phone notification and a #open= link carry only the thread (spec
  // §3.5 step 2). Its bot is whoever owns it in the snapshot just loaded;
  // nobody owning it means this device cannot see it, and nothing opens.
  const botId =
    target.botId ??
    state.bots.find(
      (candidate) =>
        candidate.threadId === target.threadId ||
        findTask(candidate, target.threadId) !== undefined,
    )?.id;
  if (!botId) return false;
  dispatch({ type: "select", id: botId });
  const bot = state.bots.find((candidate) => candidate.id === botId);
  if (!bot) return true;
  // A bot whose window leaves tasks out may own this one: the server says if not.
  const known =
    bot.threadId === target.threadId ||
    mayHoldTask(bot, target.threadId);
  if (known) dispatch({ type: "switchTask", botId, threadId: target.threadId });
  return true;
}

/** Retire the scrollback pages a thread has in flight: whatever they return
 * describes a transcript this client no longer holds (upstream #1527). */
function bumpTranscriptGeneration(state: AppState, ...threadIds: Array<string | undefined | null>): AppState {
  const ids = threadIds.filter((threadId): threadId is string => Boolean(threadId));
  if (!ids.length) return state;
  const transcriptGeneration = { ...state.transcriptGeneration };
  for (const threadId of ids) transcriptGeneration[threadId] = (transcriptGeneration[threadId] ?? 0) + 1;
  return { ...state, transcriptGeneration };
}

/** Put an older page in front of what a conversation holds. A page that
 * overlaps (it raced an edit, or a jump already fetched some of it) keeps the
 * held copy, which is the newer one. That includes an open card held beside
 * the page (`openCards`): the page now reaches it, so it moves into page
 * order with the held contents (an answer may have landed while the page was
 * on the wire) and leaves `openCards`. A room's page is held by number
 * (transcript-seq.ts, `older`); a bot's, and a legacy room's, prepends. */
function prependOlder<T extends Bot | Group>(owner: T, older: Message[], hasMore: boolean, olderFrom?: string | null, newestSeq?: number, asked?: string): T {
  const beside = new Map(owner.openCards?.map((card) => [card.id, card]));
  const rows = older.map((message) => beside.get(message.id) ?? message);
  const before = owner.messages;
  const laid = isGroupOwner(owner)
    ? roomTranscriptInput(owner, { kind: "older", rows, newestSeq, vouched: true, hasMore, olderFrom, before: asked })
    : { ...owner, ...legacyTranscriptInput(transcriptOf(owner), { kind: "older", rows, vouched: true, hasMore, olderFrom }) };
  const reached = new Set(laid.messages.filter((message) => !before.includes(message)).map((message) => message.id));
  const openCards = owner.openCards?.filter((card) => !reached.has(card.id));
  return { ...laid, openCards: openCards?.length ? openCards : undefined } as T;
}

/** GET /api/sends/:threadId/:sendId's status, as a draft record reads it (lib/drafts.ts section 5). `failed` may be
 * retried under the same id, so it is "none" (the pin stays). */
export function sendLookupResult(status: unknown): DraftSendLookupResult {
  if (status === "refused") return "refused";
  if (status === "cancelled") return "cancelled";
  // "stopped": a typed stop (designs/TYPED-STOP-107.md), acknowledged and finished; its words are not kept as a draft
  if (status === "sending" || status === "queued" || status === "dispatched" || status === "started" || status === "delivered" || status === "unconfirmed" || status === "stopped") return "ack";
  return "none";
}

/** Whether a composer draft's conversation (`bot:<bot>[:<thread>]` or `group:<channel>:<thread>`) is still listed. */
export function draftOwnerLive(state: { bots: Bot[]; groups: Group[] }, draftId: string): boolean {
  const [kind, ownerId, ...rest] = draftId.split(":");
  const thread = rest.join(":");
  const owner = kind === "bot" ? state.bots.find((bot) => bot.id === ownerId) : kind === "group" ? state.groups.find((group) => group.id === ownerId) : undefined;
  if (!owner) return false;
  if (!thread) return true;
  const tasks = (owner as { tasks?: Array<{ threadId: string }> }).tasks;
  return owner.threadId === thread || Boolean(tasks?.some((task) => task.threadId === thread));
}

/** The r8 wire contract: an envelope carrying a numbered thread's rows carries `newestSeq` (page bodies, frames, POST answers). */
function seqEnvelope(body: unknown): { newestSeq?: number } {
  const newestSeq = body && typeof body === "object" ? (body as { newestSeq?: unknown }).newestSeq : undefined;
  return typeof newestSeq === "number" && Number.isFinite(newestSeq) ? { newestSeq } : {};
}

/** A POST answer's origin for its row: when its request was sent (an untagged body vouches for nothing). */
function answerOrigin(body: unknown): RoomOrigin {
  const sentAt = sentAtOf(body);
  return { source: "http", sentAt: sentAt ?? Number.NEGATIVE_INFINITY, expired: false };
}

/** The transcript keys of a conversation, as transcript-seq.ts reads them. */
function transcriptOf(owner: Bot | Group): SeqTranscript {
  const room = isGroupOwner(owner) ? owner : undefined;
  return { messages: owner.messages, numbered: room?.numbered, tail: room?.tail, legacyGaps: room?.legacyGaps, hasMore: owner.hasMore, olderFrom: owner.olderFrom, messagesUnloaded: owner.messagesUnloaded };
}

/** One input laid into a room's transcript (transcript-seq.ts `applyTranscriptInput`), with the count kept: the newest number once the
 * transcript is complete, else no less than the server's count a page carried. The same room object when nothing changed. */
function roomTranscriptInput(group: Group, input: { kind: InputKind; rows: Message[]; newestSeq?: number; vouched: boolean; hasMore?: boolean; olderFrom?: string | null; before?: string }, messagesTotal?: number): Group {
  const before = transcriptOf(group);
  const after = applyTranscriptInput(before, input);
  if (after === before && messagesTotal === undefined) return group;
  const complete = transcriptState(after) === "complete";
  const counted = messagesTotal !== undefined || group.messagesTotal !== undefined;
  const total = complete ? after.tail : counted ? Math.max(group.messagesTotal ?? 0, messagesTotal ?? 0) : undefined;
  const next: Group = { ...group, ...after, messagesTotal: total };
  if (next.numbered === undefined) delete next.numbered;
  if (next.tail === undefined) delete next.tail;
  if (next.legacyGaps === undefined) delete next.legacyGaps;
  return next;
}

/** The line a held transcript's head makes: a bot's visible branch head, a room's newest row. `undefined` when nothing is held; `null` when the
 * head is not held (the selected branch head is older than the page), and the line held stays. */
function headLineOf(owner: Bot | Group): SidebarLine | undefined | null {
  const head = isGroupOwner(owner) ? owner.messages.at(-1) : visibleMessages(owner).at(-1);
  if (head) return sidebarLineOf(head);
  return owner.messages.length || owner.hasMore ? null : undefined;
}

/** Keep each loaded conversation's `sidebarLine` on the head of what it holds, after any action that changed its rows or its branch head. An
 * unloaded one keeps the line its frames set (the reducer moves it on live rows). A recompute that says the same keeps the held object. */
function withSidebarLines(before: AppState, after: AppState): AppState {
  const sync = <T extends Bot | Group>(list: T[], previous: T[]): T[] => {
    let changed = false;
    const next = list.map((owner, index) => {
      if (owner.messagesUnloaded) return owner;
      const prior = previous[index]?.id === owner.id ? previous[index] : previous.find((candidate) => candidate.id === owner.id);
      if (prior && prior.messages === owner.messages && prior.sidebarLine === owner.sidebarLine && (prior as Bot).activeLeafId === (owner as Bot).activeLeafId && !prior.messagesUnloaded) return owner;
      const line = headLineOf(owner);
      if (line === null || sameSidebarLine(line, owner.sidebarLine)) {
        // the held line already says it (or the head is not held): a frame's copy over a loaded transcript never replaces the held one
        if (prior && prior.sidebarLine !== owner.sidebarLine && line !== null && sameSidebarLine(line, prior.sidebarLine)) { changed = true; return { ...owner, sidebarLine: prior.sidebarLine }; }
        return owner;
      }
      if (line === undefined && owner.sidebarLine === undefined) return owner;
      changed = true;
      return { ...owner, sidebarLine: line };
    });
    return changed ? next : list;
  };
  const bots = after.bots === before.bots ? after.bots : sync(after.bots, before.bots);
  const groups = after.groups === before.groups ? after.groups : sync(after.groups, before.groups);
  return bots === after.bots && groups === after.groups ? after : { ...after, bots, groups };
}

const isGroupOwner = (owner: Bot | Group): owner is Group => Array.isArray((owner as Group).memberIds);

/** Where a live event for a conversation goes while its first page is on the wire: the owner whose open thread it is and that has a queue. */
function firstPageOwner(state: AppState, threadId: string): { kind: "bot"; owner: Bot } | { kind: "group"; owner: Group } | undefined {
  const bot = state.bots.find((candidate) => candidate.threadId === threadId && candidate.firstPageEvents);
  if (bot) return { kind: "bot", owner: bot };
  const group = state.groups.find((candidate) => candidate.threadId === threadId && candidate.firstPageEvents);
  return group ? { kind: "group", owner: group } : undefined;
}

/** Apply `fn` to the bot or room whose open conversation is `threadId`. */
function updateOwnerByThread(state: AppState, threadId: string, fn: <T extends Bot | Group>(owner: T) => T): AppState {
  if (state.bots.some((bot) => bot.threadId === threadId)) return { ...state, bots: state.bots.map((bot) => (bot.threadId === threadId ? fn(bot) : bot)) };
  if (state.groups.some((group) => group.threadId === threadId)) return { ...state, groups: state.groups.map((group) => (group.threadId === threadId ? fn(group) : group)) };
  return state;
}

/** Events queued for a conversation's first page, replayed in arrival order once the queue is gone (over the page, or over the unloaded owner). */
function replayFirstPageEvents(state: AppState, events: readonly FirstPageEvent[] | undefined): AppState {
  return events?.length ? events.reduce<AppState>(reducer, state) : state;
}

/** Apply a message update to the open cards held beside the page too. */
const patchOpenCards = (cards: Message[] | undefined, id: string, patch: (m: Message) => Message): Message[] | undefined =>
  cards?.some((m) => m.id === id) ? cards.map((m) => (m.id === id ? patch(m) : m)) : cards;

function updateBot(state: AppState, botId: string, fn: (b: Bot) => Bot): AppState {
  return { ...state, bots: state.bots.map((b) => (b.id === botId ? fn(b) : b)) };
}

/** The avatar's reaction to an activity row. A settled tool run plays
 * success or failure; a still-running one plays working. A host-stop notice
 * (shared/host-stop.ts) is ok:false but is a neutral stop, not a failure —
 * the transcript shows a StoppedRow, never a red card — so the avatar plays
 * nothing for it (STOP2). */
function activityMotion(message: Message): Exclude<EmberMotion, "none"> | null {
  if (message.tool?.ok === false) return hostStoppedReason(message.tool.name) === undefined && sendNoticeCode(message.tool.name) === undefined ? "failure" : null;
  return message.tool?.ok === true ? "success" : "working";
}

function withMascotMotion(
  state: AppState,
  botId: string,
  kind: Exclude<EmberMotion, "none">,
): AppState {
  return {
    ...state,
    mascotMotion: {
      botId,
      nonce: (state.mascotMotion?.nonce ?? 0) + 1,
      kind,
    },
  };
}

function patchCard(state: AppState, botId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  const apply = (m: Message) => (m.id === messageId && m.card ? { ...m, card: { ...m.card, ...patch } } : m);
  return updateBot(state, botId, (b) => ({
    ...b,
    messages: b.messages.map(apply),
    openCards: patchOpenCards(b.openCards, messageId, apply),
    cardsRev: (b.cardsRev ?? 0) + 1,
  }));
}

/** First-run quiz still sitting on this bot's thread.
 *
 *  NOT AN INTAKE TURN, and this is the fourth place that has to say so —
 *  `OptionCard.isOnboardingCard`, `ChatView`'s branch to `IntakeTurn` and the
 *  `answerCard` guard are the other three, each for the same reason: a card
 *  the setup conversation is asking through is a turn, not a quiz, and it is
 *  answered on its own route.
 *
 *  What it costs to get wrong is a 409, silently. Talking past the quiz
 *  dismisses it (`dismissOnboardingCard` on every send, plus a PATCH so an
 *  older server agrees), and this used to be unreachable with an intake card
 *  open because the composer never sent while one was — which is M1. Now that
 *  it always sends, a send would dismiss the question a beat before the same
 *  keystroke answered it, and the intake route refuses a dismissed card. */
function openOnboardingCard(bot: Bot): Message | undefined {
  return bot.messages.find(
    (message) =>
      message.kind === "options"
      && message.card
      && !message.card.requestId
      && !message.card.intake
      // ...and a first-run card is the fifth. The guided first run happens
      // IN this thread: its cards are what the person is answering, so a
      // typed reply must not dismiss the step they are standing on. The
      // server's own `dismissOnboardingCard` carries the same exemption.
      && !message.card.setup
      && !message.card.dismissed,
  );
}

function dismissOnboardingCard(state: AppState, botId: string): AppState {
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const quiz = bot ? openOnboardingCard(bot) : undefined;
  return quiz ? patchCard(state, botId, quiz.id, { dismissed: true }) : state;
}

/** Guard stale callbacks while a removed conversation awaits its replacement. */
export function pendingThreadActionBlocked(state: AppState, action: Action): boolean {
  switch (action.type) {
    case "send":
    case "editMessage":
    case "switchBranch":
    case "answerCard":
    case "dismissCard":
      return state.bots.some(bot => bot.id === action.botId && bot.awaitingThreadSnapshot);
    case "decideRequest":
    case "answerQuestion":
    case "sendQuestionAsMessage":
    case "respondWidget":
    case "reopenWidget":
      return state.bots.some(bot => bot.awaitingThreadSnapshot && (bot.threadId === action.threadId || bot.deletedThreadId === action.threadId));
    default:
      return false;
  }
}

/** A create response's transcript folded with the rows its stream already
 * delivered: one row per id, the response's order, each row as the stream last
 * patched it (a patch the response reflects also arrives as a frame, so the held
 * copy is never older), then any row the stream added after the response was
 * written. The held array itself when that is what it already says. */
function foldAddedMessages(response: Message[], held: Message[] | undefined): Message[] {
  if (!held?.length) return response;
  const heldById = new Map(held.map((message) => [message.id, message]));
  const seen = new Set(response.map((message) => message.id));
  const folded = [...response.map((message) => heldById.get(message.id) ?? message), ...held.filter((message) => !seen.has(message.id))];
  return folded.length === held.length && folded.every((message, index) => message === held[index]) ? held : folded;
}

/** The record half of a create or duplicate response: everything but the transcript and the page machinery riding beside it. */
function recordOnly(bot: BotAnnouncement): BotAnnouncement {
  const { messages: _messages, activeLeafId: _leaf, openCards: _cards, openCardsLeaf: _cardsLeaf, openCardsPending: _cardsPending, olderFrom: _olderFrom, hasMore: _hasMore, ...record } = bot;
  return record;
}

/** Whether `ancestorId` is on the parent chain of `fromId` (itself included), over the rows given. */
function reachesAncestor(byId: ReadonlyMap<string, Message>, fromId: string, ancestorId: string): boolean {
  const seen = new Set<string>();
  for (let cur = byId.get(fromId); cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    if (cur.id === ancestorId) return true;
    seen.add(cur.id);
  }
  return false;
}

/** The branch head after a create response is folded in. One side missing: the other. The response's head a
 * descendant of the held one: the response's (the head only moves forward along parent links). Otherwise the
 * held one: either it is already further along, or the two are on different branches, and every branch move
 * arrives as a `thread` frame, so a snapshot older than a fork must not move the head back. */
function headOf(rows: Message[], held: string | null | undefined, response: string | null | undefined): string | null | undefined {
  if (!held) return response ?? held;
  if (!response || response === held) return held;
  return reachesAncestor(new Map(rows.map((message) => [message.id, message])), response, held) ? response : held;
}

/** A bot frame's `tasksDelta` laid over the task rows held when the reducer
 * runs (never a copy read earlier: frames drained in one batch would restore
 * each other's rows). Changed rows replace their rows in place. A held list
 * that is not the one the delta builds on (another `tasksSeq`, or a size other
 * than `count`) cannot be completed by it: the frame carries no `tasks`, the
 * held list stays, and the bot is marked `tasksStale` so the provider
 * refetches the list. */
export function withTaskDelta(bot: BotAnnouncement, held: Pick<Bot, "tasks" | "tasksSeq"> | undefined): BotAnnouncement {
  const { tasksDelta: d, ...rest } = bot;
  if (!d) return bot;
  const tasks = held?.tasks;
  if (!tasks || tasks.length !== d.count || (d.base !== undefined && held?.tasksSeq !== d.base)) return { ...rest, tasksSeq: held?.tasksSeq, tasksStale: true };
  const changed = new Map(d.upsert.map((task) => [task.threadId, task]));
  const merged = tasks.map((task) => {
    const next = changed.get(task.threadId) ?? task;
    return next.threadId === d.read && next.unread ? { ...next, unread: false } : next;
  });
  return { ...rest, tasks: merged, ...(d.read ? { unread: merged.some((task) => task.unread) } : {}) };
}

// ── Bot admission (BOTADDED-DESIGN-V3 r6 §2.3-2.8) ─────────────────────
// One server number (`tasksEpoch`, `tasksSeq`) orders every record-shaped input against the held copy: stream frames, roster rows and
// every HTTP answer carrying a bot. Record admission, page adoption, same-version completion and selection are separate decisions.

/** The outcome of admission for one record (§2.3): apply as a newer version, complete the same version, change nothing, insert, or
 * (no server run known yet: an older server) today's merge. `drop` = not admitted at all (pending, tombstoned, expired, unordered). */
type Verdict = "newer" | "same" | "stale" | "insert" | "legacy" | "drop";

const numberedRecord = (record: { tasksSeq?: unknown; tasksEpoch?: unknown }): record is { tasksSeq: number; tasksEpoch: string } =>
  typeof record.tasksSeq === "number" && typeof record.tasksEpoch === "string";

function isPastEpoch(state: AppState, epoch: string | undefined): boolean {
  return epoch !== undefined && (state.pastEpochs ?? []).some((entry) => entry.epoch === epoch);
}

function requestReconcile(state: AppState): AppState {
  return { ...state, reconcileRequested: (state.reconcileRequested ?? 0) + 1 };
}

/** Ask for a verification fetch. Asked again while one is outstanding: one more fetch follows it (`verifyAgain`), so an older
 * fetch's outcome never settles a newer question (order P17). */
function markVerify(state: AppState, botId: string): AppState {
  if (!state.verifyBots?.[botId]) return { ...state, verifyBots: { ...state.verifyBots, [botId]: true } };
  return state.verifyAgain?.[botId] ? state : { ...state, verifyAgain: { ...state.verifyAgain, [botId]: true } };
}

/** One verification fetch ended: the id stays asked for when it was asked again meanwhile. */
function clearVerify(state: AppState, botId: string): AppState {
  if (state.verifyAgain?.[botId]) {
    const { [botId]: _again, ...verifyAgain } = state.verifyAgain;
    return { ...state, verifyAgain };
  }
  if (!state.verifyBots?.[botId]) return state;
  const { [botId]: _done, ...verifyBots } = state.verifyBots;
  return { ...state, verifyBots };
}

function bumpPageIntent(state: AppState, botId: string): AppState {
  return { ...state, pageIntent: { ...state.pageIntent, [botId]: (state.pageIntent?.[botId] ?? 0) + 1 } };
}

/** Retire what has outlived every answer that could still be applied (§2.7): a tombstone once the stream passed it (or its run is
 * over), `lastSeen` with its tombstone or on its own after the TTL, and past runs not seen within the TTL. Same state when nothing goes. */
/** A tombstone's run is over when it carries no run (an unnumbered fence), or it is of another run than the current one and was
 * written before the roster that named the current run was asked for (`streamEpochTick`): that roster was answered by a run at or
 * after the tombstone's, so a different run is a run behind. A tombstone written after that roster was asked for is of a run this
 * client cannot place (ahead of it, as a roster stalled across a restart leaves it, seed 524; or behind a run adopted from a delayed
 * roster, Astra r7 H1) and is not over: retiring it would let a buffered frame of the older run bring the id back. It retires once a
 * roster asked for after it has drained (`ackOnDrain`) or its run is adopted and left. */
function tombstoneRunOver(state: AppState, t: Tombstone): boolean {
  if (t.epoch === "" || state.streamEpoch === undefined) return true;
  if (t.epoch === state.streamEpoch) return false;
  return isPastEpoch(state, t.epoch) || (t.tick ?? 0) <= (state.streamEpochTick ?? 0);
}

function retireAdmission(state: AppState, now: number): AppState {
  let tombstones = state.tombstones;
  for (const [id, t] of Object.entries(tombstones ?? {})) {
    if (now - t.confirmedAt > ANSWER_TTL_MS && (t.streamAcked || tombstoneRunOver(state, t))) {
      if (tombstones === state.tombstones) tombstones = { ...tombstones };
      delete tombstones![id];
    }
  }
  // Rooms retire by the same rule (ROOM-ORDER-DESIGN §2.5): older than the TTL and passed by the stream or from a run that is over.
  let roomTombstones = state.roomTombstones;
  for (const [id, t] of Object.entries(roomTombstones ?? {})) {
    if (now - t.confirmedAt > ANSWER_TTL_MS && (t.streamAcked || tombstoneRunOver(state, t))) {
      if (roomTombstones === state.roomTombstones) roomTombstones = { ...roomTombstones };
      delete roomTombstones![id];
    }
  }
  let lastSeen = state.lastSeen;
  for (const [id, seen] of Object.entries(lastSeen ?? {})) {
    // kept for the current run: a resumed stream can replay a frame older than the TTL (order P17 of 1149); one entry per bot
    if (now - seen.at > ANSWER_TTL_MS && !tombstones?.[id] && seen.epoch !== state.streamEpoch) {
      if (lastSeen === state.lastSeen) lastSeen = { ...lastSeen };
      delete lastSeen![id];
    }
  }
  const pastEpochs = (state.pastEpochs ?? []).filter((entry) => now - entry.seenAt <= ANSWER_TTL_MS);
  const epochsChanged = pastEpochs.length !== (state.pastEpochs ?? []).length;
  if (tombstones === state.tombstones && roomTombstones === state.roomTombstones && lastSeen === state.lastSeen && !epochsChanged) return state;
  return { ...state, tombstones, roomTombstones, lastSeen, ...(epochsChanged ? { pastEpochs } : {}) };
}

/** Write a tombstone; an existing one of the same run keeps the higher number. Every write re-evaluates retirement (§2.7). */
function writeTombstone(state: AppState, botId: string, entry: Omit<Tombstone, "confirmedAt"> & { confirmedAt?: number }, table: "tombstones" | "roomTombstones" = "tombstones"): AppState {
  const now = answerClock.now();
  const held = state[table]?.[botId];
  const sameRun = held && held.epoch === entry.epoch;
  const next: Tombstone = {
    epoch: entry.epoch,
    seq: sameRun ? Math.max(held.seq, entry.seq) : entry.seq,
    // a real deletion outranks a hide of the same id
    kind: sameRun && held.kind === "deleted" ? "deleted" : entry.kind,
    confirmedAt: Math.max(held?.confirmedAt ?? 0, entry.confirmedAt ?? now),
    streamAcked: entry.streamAcked || Boolean(sameRun && held.streamAcked && held.seq >= entry.seq),
    ...(entry.ackOnDrain && !entry.streamAcked ? { ackOnDrain: true as const } : {}),
  };
  const tick = (state.admitTick ?? 0) + 1;
  return retireAdmission({ ...state, admitTick: tick, [table]: { ...state[table], [botId]: { ...next, tick } } }, now);
}

function dropTombstone(state: AppState, botId: string): AppState {
  if (!state.tombstones?.[botId]) return state;
  const { [botId]: _gone, ...tombstones } = state.tombstones;
  return { ...state, tombstones };
}

/** Remember the last number applied for an id (§9.2), so a removal does not forget how new the copy it removed was. */
function noteSeen(state: AppState, botId: string, record: { tasksSeq?: unknown; tasksEpoch?: unknown }): AppState {
  if (!numberedRecord(record)) return state;
  const held = state.lastSeen?.[botId];
  if (held && held.epoch === record.tasksEpoch && held.seq >= record.tasksSeq) return state;
  return { ...state, lastSeen: { ...state.lastSeen, [botId]: { epoch: record.tasksEpoch, seq: record.tasksSeq, at: answerClock.now() } } };
}

/** Remove a held bot (a removal, a scoped hide, an unlisted roster row); the selection moves off it. */
function removeHeldBot(state: AppState, botId: string): AppState {
  if (!state.bots.some((bot) => bot.id === botId)) return state;
  const bots = state.bots.filter((bot) => bot.id !== botId);
  const selectedId = state.selectedId === botId ? (bots.find((bot) => !bot.hidden)?.id ?? bots[0]?.id ?? "") : state.selectedId;
  // a bot no longer held owes no settlement (I-H1)
  return forgetSettle({ ...state, bots, selectedId }, botId);
}

/**
 * §2.3 steps 0-5 for one record-shaped input. The returned state carries the side effects (verify, reconcile, a scoped hide's
 * tombstone, the tombstone cleared by a record numbered past it); the caller applies the verdict (§2.5-2.7).
 */
export function admitRecord(state: AppState, record: BotAnnouncement, origin: BotOrigin, verified = false): { state: AppState; verdict: Verdict } {
  const id = record.id;
  // 0. Life: an HTTP answer older than the TTL is never applied; the roster is read again.
  if (origin.source === "http" && origin.expired) return { state: requestReconcile(state), verdict: "drop" };
  // 1. Pending: nothing for an id whose deletion is on the wire.
  if (state.pendingDeletes?.[id]) return { state, verdict: "drop" };
  const numbered = numberedRecord(record);
  const held = state.bots.find((bot) => bot.id === id);
  let next = state;
  let clearTomb = false;
  // 2. Tombstone.
  const tomb = state.tombstones?.[id];
  if (tomb) {
    if (verified) {
      // The authoritative current state (§9.3) clears a hide, never a deletion: ids are never reused, so a record of a deleted id is
      // only ever one read before the deletion (an answer sent before a restart, order P21), unless numbered past it in its own run.
      if (tomb.kind === "deleted" && !(numbered && record.tasksEpoch === tomb.epoch && record.tasksSeq > tomb.seq)) return { state, verdict: "drop" };
      // within the hide's own run the number decides (a detail read before the hide is older than it); across runs it is the answer
      if (numbered && record.tasksEpoch === tomb.epoch && record.tasksSeq <= tomb.seq) return { state, verdict: "drop" };
      clearTomb = true;
    } else if (!numbered || tomb.seq === Number.POSITIVE_INFINITY) return { state: markVerify(state, id), verdict: "drop" };
    else if (record.tasksEpoch === tomb.epoch) {
      if (record.tasksSeq <= tomb.seq) return { state, verdict: "drop" };
      clearTomb = true;
    } else if (tomb.kind === "deleted") return { state, verdict: "drop" };
    else return { state: markVerify(state, id), verdict: "drop" };
  }
  // 3-4. Epoch, then version.
  let verdict: Verdict;
  const streamEpoch = state.streamEpoch;
  if (streamEpoch === undefined) verdict = "legacy";
  else if (!numbered) verdict = held ? "same" : "drop";
  else if (held) {
    if (record.tasksEpoch === held.tasksEpoch) {
      const heldSeq = held.recordSeq ?? held.tasksSeq ?? -1;
      verdict = record.tasksSeq > heldSeq ? "newer" : record.tasksSeq === heldSeq ? "same" : "stale";
    } else if (record.tasksEpoch === streamEpoch) verdict = "newer";
    else if (isPastEpoch(state, record.tasksEpoch)) verdict = "stale";
    else {
      next = requestReconcile(next);
      verdict = "stale";
    }
  } else if (record.tasksEpoch === streamEpoch) {
    const seen = state.lastSeen?.[id];
    // lower than the last number applied in its run is older, verified or not (order P20); equal re-inserts (a refused Delete, M3)
    verdict = seen && seen.epoch === record.tasksEpoch && record.tasksSeq < seen.seq ? "drop" : "insert";
  } else if (isPastEpoch(state, record.tasksEpoch)) verdict = "drop";
  else {
    next = markVerify(requestReconcile(next), id);
    verdict = "drop";
  }
  if (verdict === "drop" || verdict === "stale") return { state: next, verdict };
  // 5. Visibility: a scoped client never shows a hidden record; a hide that is not stale removes the held copy and fences the id.
  if (state.scopedClient && record.hidden === true) {
    if (numbered) next = writeTombstone(next, id, { epoch: record.tasksEpoch, seq: record.tasksSeq, kind: "hidden", streamAcked: origin.source === "stream" });
    return { state: noteSeen(removeHeldBot(next, id), id, record), verdict: "drop" };
  }
  if (clearTomb) next = dropTombstone(next, id);
  return { state: next, verdict };
}

/** Same-version completion (§2.5 same): record fields only. Keys the held copy lacks are filled; a cut description is replaced by the
 * whole one; a stale task list is replaced (and its base moves to this number). Never the transcript or the page machinery. */
function completeSameVersion(held: Bot, record: BotAnnouncement): Bot {
  const { tasksDelta: _delta, threadId: _thread, ...fields } = recordOnly(record);
  let out: Bot | undefined;
  const set = <K extends keyof Bot>(key: K, value: Bot[K]) => { (out ??= { ...held })[key] = value; };
  for (const [key, value] of Object.entries(fields) as Array<[keyof Bot, unknown]>) {
    if (value !== undefined && held[key] === undefined) set(key, value as never);
  }
  if (held.descriptionCut === true && record.descriptionCut !== true && typeof record.description === "string") {
    set("description", record.description);
    set("descriptionCut", undefined);
  }
  if (held.tasksStale && Array.isArray(record.tasks)) {
    set("tasks", record.tasks);
    set("tasksStale", undefined);
    if (typeof record.tasksSeq === "number") set("tasksSeq", record.tasksSeq);
  }
  return out ?? held;
}

/** The record fields of an admitted record stamped on the held copy: its number and, for an input from outside a roster, the order it
 * reached this client (§2.8 r6; a restore of an already-held bot counts, Astra r5 #1). */
function stampAdmitted(state: AppState, botId: string, record: BotAnnouncement, verdict: Verdict, bumpOrder: boolean): AppState {
  const numbered = numberedRecord(record);
  if (!numbered && !bumpOrder) return state;
  const admitTick = (state.admitTick ?? 0) + (bumpOrder ? 1 : 0);
  const stamped = updateBot(bumpOrder ? { ...state, admitTick } : state, botId, (bot) => ({
    ...bot,
    ...(numbered && verdict !== "same" ? { recordSeq: record.tasksSeq } : {}),
    ...(bumpOrder ? { admittedAt: admitTick } : {}),
  }));
  return noteSeen(stamped, botId, record);
}

/** The fields an answer states completely, settled from it at the held number or past it: each takes the record's value, absent
 * included (a cleared team, a Full access the bot never had). Never a cut description: the roster's preview must not reach an
 * editable field, so that key stays owed until a whole record. Exactly the keys written are forgotten (I-H1): a partial settle
 * never drops what another answer still owes. */
function settleFields(state: AppState, botId: string, record: BotAnnouncement, owed: ReadonlyArray<keyof Bot>): AppState {
  const values: Partial<Bot> = {};
  const written: Array<keyof Bot> = [];
  for (const key of owed) {
    if (key === "description" && record.descriptionCut === true) continue;
    (values as Record<string, unknown>)[key] = (record as unknown as Record<string, unknown>)[key];
    written.push(key);
  }
  return forgetSettled(updateBot(state, botId, (bot) => ({ ...bot, ...values })), botId, written);
}

/** Every key a bot is still owed: the answer's own settled keys and the ones accumulated by earlier stale answers (I-H1). */
function owedKeys(state: AppState, botId: string, own: ReadonlyArray<keyof Bot> | undefined): ReadonlyArray<keyof Bot> {
  return [...new Set([...(own ?? []), ...(state.settleOnVerify?.[botId] ?? [])])];
}

/** Keys owed a settlement from the next settling answer. */
function owing(state: AppState, botId: string, keys: ReadonlyArray<keyof Bot>): AppState {
  const all = owedKeys(state, botId, keys);
  return all.length ? { ...state, settleOnVerify: { ...state.settleOnVerify, [botId]: all } } : state;
}

/** The keys an answer settled are no longer owed; the entry goes once nothing is. */
function forgetSettled(state: AppState, botId: string, keys: ReadonlyArray<keyof Bot>): AppState {
  const pending = state.settleOnVerify?.[botId];
  if (!pending) return state;
  const left = pending.filter((key) => !keys.includes(key));
  if (left.length === pending.length) return state;
  if (!left.length) return forgetSettle(state, botId);
  return { ...state, settleOnVerify: { ...state.settleOnVerify, [botId]: left } };
}

/** Everything the bot was owed is forgotten: it is gone, or its verification was given up on. */
function forgetSettle(state: AppState, botId: string): AppState {
  if (!state.settleOnVerify?.[botId]) return state;
  const { [botId]: _done, ...settleOnVerify } = state.settleOnVerify;
  return { ...state, settleOnVerify };
}

// ── Room admission (ROOM-ORDER-DESIGN §2, r2, r3) ───────────────────────
// One room version is `(recordEpoch, recordSeq)`, drawn from the server's run-wide clock: every statement about any room takes the next
// number. `admitRoom` is the only judge of a room record, `admitRoomRemoval` of a room removal. This client never makes or borrows a number.

const numberedRoom = (record: { recordSeq?: unknown; recordEpoch?: unknown }): record is { recordSeq: number; recordEpoch: string } =>
  typeof record.recordSeq === "number" && typeof record.recordEpoch === "string";

/** A whole statement carries the room's open thread; a partial row (a hidden flag, a team row) does not. */
const wholeRoom = (record: { threadId?: unknown }): boolean => typeof record.threadId === "string";

/** Remove a held room; the selection moves off it. */
function removeHeldRoom(state: AppState, groupId: string): AppState {
  if (!state.groups.some((group) => group.id === groupId)) return state;
  const groups = state.groups.filter((group) => group.id !== groupId);
  return { ...state, groups, selectedId: state.selectedId === groupId ? (state.bots[0]?.id ?? "") : state.selectedId };
}

function dropRoomTombstone(state: AppState, groupId: string): AppState {
  if (!state.roomTombstones?.[groupId]) return state;
  const { [groupId]: _gone, ...roomTombstones } = state.roomTombstones;
  return { ...state, roomTombstones };
}

/**
 * §2.2 steps 0-6 for one room statement. The returned state carries the side effects (a reconcile request, a scoped hide's tombstone,
 * a tombstone cleared by a number past it). `roster`: the input is a row of the roster itself, which is the verdict on membership at its
 * horizon and asks for no further roster (r3 R5).
 */
export function admitRoom(state: AppState, record: Partial<Group> & { id: string }, origin: RoomOrigin, roster = false): { state: AppState; verdict: Verdict } {
  const id = record.id;
  const reconcile = (next: AppState): AppState => (roster ? next : requestReconcile(next));
  // 0. Life: an HTTP answer older than the TTL is never applied. Frames have no life: the stream orders them.
  if (origin.source === "http" && origin.expired) return { state: requestReconcile(state), verdict: "drop" };
  // 1. Legacy: an older server numbers nothing.
  if (state.streamEpoch === undefined) return { state, verdict: "legacy" };
  // 2. Unnumbered in a numbered run: a wire or dispatch defect, repaired by the roster; never merged, held or not (r2 M2).
  if (!numberedRoom(record)) return { state: reconcile(state), verdict: "drop" };
  const { recordSeq, recordEpoch } = record;
  const held = state.groups.find((group) => group.id === id);
  let next = state;
  let clearTomb = false;
  // 3. Tombstone.
  const tomb = state.roomTombstones?.[id];
  if (tomb) {
    if (recordEpoch === tomb.epoch) {
      if (recordSeq <= tomb.seq) return { state, verdict: "drop" };
      clearTomb = true;
    } else if (isPastEpoch(state, recordEpoch)) return { state, verdict: "drop" };
    else if (recordEpoch === state.streamEpoch) clearTomb = true; // the tombstone is from an earlier run: the roster that named this run is the truth
    else return { state: reconcile(state), verdict: "drop" };
  }
  // 4. Run.
  if (recordEpoch !== state.streamEpoch) {
    if (isPastEpoch(state, recordEpoch)) return { state: next, verdict: "stale" };
    return { state: reconcile(next), verdict: "drop" };
  }
  // 5. Version against the held copy (r3 R5: the horizon decides a room this client does not hold).
  let verdict: Verdict;
  if (!held) {
    if (!wholeRoom(record)) return { state: reconcile(next), verdict: "drop" };
    const horizon = state.roomHorizon;
    if (!roster && horizon && horizon.epoch === recordEpoch && recordSeq <= horizon.seq) return { state: next, verdict: "drop" };
    verdict = "insert";
  } else if (held.recordEpoch === recordEpoch) {
    const heldSeq = held.recordSeq ?? -1;
    verdict = recordSeq > heldSeq ? "newer" : recordSeq === heldSeq ? "same" : "stale";
  } else verdict = "newer";
  if (verdict === "stale") return { state: next, verdict };
  // 6. Visibility: a scoped client never shows a hidden room; the hide removes the held copy and fences the id at its number.
  if (state.scopedClient && record.hidden === true) {
    next = writeTombstone(removeHeldRoom(next, id), id, { epoch: recordEpoch, seq: recordSeq, kind: "hidden", streamAcked: origin.source === "stream" }, "roomTombstones");
    return { state: next, verdict: "drop" };
  }
  if (clearTomb) next = dropRoomTombstone(next, id);
  return { state: next, verdict };
}

/** §2.3 steps 0-4 for one room removal (a `group.deleted` frame, a DELETE answer): the only judge, returns the next state. */
export function admitRoomRemoval(state: AppState, input: { groupId: string; recordSeq?: number; recordEpoch?: string; hidden?: true }, origin: RoomOrigin): AppState {
  const id = input.groupId;
  if (origin.source === "http" && origin.expired) return requestReconcile(state);
  if (state.streamEpoch === undefined) return removeHeldRoom(state, id);
  // The client never borrows the held copy's numbers: an unnumbered removal against a numbered server removes nothing.
  if (typeof input.recordSeq !== "number" || typeof input.recordEpoch !== "string") return requestReconcile(state);
  const { recordSeq: seq, recordEpoch: epoch } = input;
  if (epoch !== state.streamEpoch) return isPastEpoch(state, epoch) ? state : requestReconcile(state);
  const held = state.groups.find((group) => group.id === id);
  // r2 M1: a removal older than the held copy (a restore that already landed) changes nothing.
  if (held && held.recordEpoch === epoch && seq < (held.recordSeq ?? -1)) return state;
  return writeTombstone(removeHeldRoom(state, id), id, { epoch, seq, kind: input.hidden ? "hidden" : "deleted", streamAcked: origin.source === "stream" }, "roomTombstones");
}

/**
 * The room as a statement leaves it: server keys from the statement, local keys from the held copy. A whole numbered statement sets every
 * server-owned key, absent meaning cleared; a partial one sets only the keys it carries (r2). Transcript and card handling stay with the caller.
 */
function mergeRoomRecord(state: AppState, held: Group, incoming: Partial<Group> & { id: string }, whole: boolean, removedTaskIds: ReadonlySet<string>): Group {
  const next: Group = { ...held, ...incoming };
  // local keys no statement writes
  if (held.setupPending === undefined) delete next.setupPending;
  else next.setupPending = held.setupPending;
  if (whole) {
    for (const key of ROOM_SERVER_KEYS) if (!(key in incoming)) delete next[key];
  } else if (incoming.threadId !== undefined && incoming.threadId !== held.threadId) {
    // an unnumbered switch of the open task: the server omits an unset task pin, so the previous task's folder lock must not stay
    if (!("pinnedCwd" in incoming)) delete next.pinnedCwd;
    if (!("pinnedMessageId" in incoming)) delete next.pinnedMessageId;
    if (!("readOnlyReason" in incoming)) delete next.readOnlyReason;
    if (!("humanPrincipalKind" in incoming)) delete next.humanPrincipalKind;
  }
  // tasks[] merge by threadId (r3 R6)
  const heldRows = [...(held.tasks ?? []), ...(held.extraTasks ?? [])];
  const heldRow = (threadId: string) => heldRows.find((task) => task.threadId === threadId);
  if (Array.isArray(incoming.tasks)) {
    const rows = incoming.tasks.filter((task) => !removedTaskIds.has(task.threadId));
    next.tasks = rows.map((task) => {
      const old = heldRow(task.threadId);
      const read = state.selectedId === held.id && state.activeView === "chat" && task.threadId === next.threadId;
      return {
        ...task,
        unreadCount: read ? 0 : task.unreadCount ?? 0,
        unread: read ? false : task.unreadCount !== undefined ? task.unreadCount > 0 : task.unread ?? old?.unread,
        unreadMessageIds: read ? [] : old?.unreadMessageIds,
        ...(task.sending === undefined && old?.sending ? { sending: old.sending } : {}),
      };
    });
    const listed = new Set(rows.map((task) => task.threadId));
    const covers = windowCovers({ tasks: incoming.tasks, tasksTotal: incoming.tasksTotal, tasksOlder: incoming.tasksOlder });
    const kept = new Map<string, GroupTask>();
    for (const task of heldRows) if (!listed.has(task.threadId) && !removedTaskIds.has(task.threadId) && !covers(task)) kept.set(task.threadId, task);
    if (kept.size) next.extraTasks = [...kept.values()];
    else delete next.extraTasks;
  } else if (whole) {
    delete next.extraTasks;
  } else if (removedTaskIds.size) {
    if (held.tasks) next.tasks = held.tasks.filter((task) => !removedTaskIds.has(task.threadId));
    if (held.extraTasks) next.extraTasks = held.extraTasks.filter((task) => !removedTaskIds.has(task.threadId));
  }
  return next;
}

/** A room statement's page (ROOM-ORDER-DESIGN r4 T3): the rows and the keys that describe them; `newestSeq` rides the statement (r8 R8). */
interface RoomStatementPage {
  messages: Message[];
  hasMore?: boolean;
  olderFrom?: string | null;
  openCards?: Message[];
  openCardsLeaf?: string;
  openCardsPending?: boolean;
  messagesTotal?: number;
  newestSeq?: number;
}

/** The page a room statement carries, if any. */
function roomPageOf(record: Partial<Group>): RoomStatementPage | undefined {
  if (!Array.isArray(record.messages)) return undefined;
  const { messages, hasMore, olderFrom, openCards, openCardsLeaf, openCardsPending, messagesTotal } = record;
  const newestSeq = (record as { newestSeq?: unknown }).newestSeq;
  return { messages, hasMore, olderFrom, openCards, openCardsLeaf, openCardsPending, messagesTotal, newestSeq: typeof newestSeq === "number" ? newestSeq : undefined };
}

/** r4 T4 / r6 Q3: whether an input vouches for its rows (and may load an unloaded room, and set the tail): a frame always, the stream orders
 * every later row behind it; an answer only when its request was sent at or after this connection's roster was asked for (`transcriptFloor`).
 * A legacy run has no floor. */
function pageClosesGap(state: AppState, origin: RoomOrigin): boolean {
  if (state.streamEpoch === undefined) return true;
  return vouches(origin, state.transcriptFloor);
}

/** r4 T2: the transcript of a room inserted without a page, or whose open conversation moved without one (a new thread starts legacy). */
const UNLOADED_TRANSCRIPT = {
  messages: [] as Message[], hasMore: undefined, olderFrom: undefined, openCards: undefined, openCardsLeaf: undefined, openCardsPending: undefined,
  messagesTotal: undefined, messagesUnloaded: true as const, firstPageEvents: undefined, numbered: undefined, tail: undefined, legacyGaps: undefined,
};

/** A statement's page laid into a room (transcript-seq.ts `statement`): rows by number (or the legacy union), the open cards beside them
 * from a page that vouches, else the held ones; a card whose row is held is dropped (r4). */
function roomWithPage(group: Group, page: RoomStatementPage, vouched: boolean): Group {
  const next = roomTranscriptInput(group, { kind: "statement", rows: page.messages, newestSeq: page.newestSeq, vouched, hasMore: page.hasMore, olderFrom: page.olderFrom }, page.messagesTotal);
  if (next === group) return group;
  const loaded = group.messagesUnloaded && !next.messagesUnloaded;
  const fresh = vouched && (loaded || page.openCards !== undefined);
  const ids = new Set(next.messages.map((row) => row.id));
  const cards = (fresh ? page.openCards : group.openCards)?.filter((card) => !ids.has(card.id));
  return {
    ...next,
    openCards: cards?.length ? cards : undefined,
    openCardsLeaf: fresh ? page.openCardsLeaf : group.openCardsLeaf,
    openCardsPending: (fresh ? page.openCardsPending : group.openCardsPending) || undefined,
  };
}

/**
 * r4 T1-T4 with r6: the transcript of a held room after a statement, written onto `next` (the record `mergeRoomRecord` built, whose spread
 * took the statement's transcript keys as they came). The open conversation moved: the held rows belong to another task, and the page is
 * the new thread's base when it vouches, else the thread starts unloaded. Same thread: the page is held into what is held; one that does not
 * vouch leaves an unloaded room as it was, flags and queue intact, so the first-page GET loads it.
 */
function applyRoomTranscript(next: Group, held: Group, page: RoomStatementPage | undefined, closesGap: boolean, threadMoved: boolean): void {
  delete (next as { newestSeq?: unknown }).newestSeq;
  const base: Group = threadMoved ? { ...held, ...UNLOADED_TRANSCRIPT } : held;
  const laid = page ? roomWithPage(base, page, closesGap) : base;
  const transcript = {
    messages: laid.messages, hasMore: laid.hasMore, olderFrom: laid.olderFrom, openCards: laid.openCards, openCardsLeaf: laid.openCardsLeaf,
    openCardsPending: laid.openCardsPending, messagesTotal: page?.messagesTotal !== undefined && laid.messagesUnloaded ? page.messagesTotal : laid.messagesTotal,
    messagesUnloaded: laid.messagesUnloaded, firstPageEvents: closesGap ? undefined : laid.firstPageEvents, numbered: laid.numbered, tail: laid.tail,
    legacyGaps: laid.legacyGaps,
  };
  Object.assign(next, transcript);
  for (const key of ["numbered", "tail", "legacyGaps", "hasMore", "olderFrom", "openCards", "openCardsLeaf", "openCardsPending", "messagesTotal", "messagesUnloaded", "firstPageEvents"] as const) {
    if (next[key] === undefined) delete next[key];
  }
}

/** r4 T5: a stale statement's rows join a live transcript of the same thread; its record, flags and queue are untouched. It vouches nothing. */
function unionStaleRoomPage(state: AppState, record: Partial<Group> & { id: string }): AppState {
  const page = roomPageOf(record);
  const held = state.groups.find((group) => group.id === record.id);
  if (!page || !held || (record.threadId !== undefined && record.threadId !== held.threadId)) return state;
  const merged = roomWithPage(held, page, false);
  if (merged === held) return state;
  return { ...state, groups: state.groups.map((group) => (group.id === held.id ? merged : group)) };
}

/** A `groupEdited`: the room's local keys, and the local keys of the task rows it names. Nothing else is read from the edit. */
function applyRoomEdit(group: Group, edit: RoomEdit): Group {
  const next: Group = { ...group };
  if ("unread" in edit && typeof edit.unread === "boolean") next.unread = edit.unread;
  if ("setupPending" in edit) next.setupPending = edit.setupPending;
  if (edit.tasks?.length) {
    const patch = (rows: GroupTask[] | undefined) => rows?.map((row) => {
      const change = edit.tasks!.find((entry) => entry.threadId === row.threadId);
      if (!change) return row;
      const out: GroupTask = { ...row };
      if ("unread" in change) out.unread = change.unread;
      if ("unreadCount" in change) out.unreadCount = change.unreadCount;
      if ("unreadMessageIds" in change) out.unreadMessageIds = change.unreadMessageIds;
      if ("sending" in change) out.sending = change.sending;
      return out;
    });
    if (next.tasks) next.tasks = patch(next.tasks);
    if (next.extraTasks) next.extraTasks = patch(next.extraTasks);
  }
  return next;
}
// ── end of admission ──────────────────────────────────────────────────────

/** The overlay of edits still in flight, laid over whatever record is held after admission. */
function withOverlay(state: AppState, botId: string, overlay: Partial<BotAnnouncement> | undefined): AppState {
  if (!overlay || !Object.keys(overlay).length || !state.bots.some((bot) => bot.id === botId)) return state;
  return updateBot(state, botId, (bot) => ({ ...bot, ...overlay }) as Bot);
}

/** The page fields of a switch answer: what it changes about the conversation on screen (§2.6). */
function pageFieldsOf(bot: BotAnnouncement): Partial<Bot> {
  return {
    threadId: bot.threadId,
    messages: bot.messages,
    activeLeafId: bot.activeLeafId,
    hasMore: bot.hasMore,
    openCards: bot.openCards,
    openCardsLeaf: bot.openCardsLeaf,
    openCardsPending: bot.openCardsPending,
    olderFrom: bot.olderFrom,
    threadVersion: bot.threadVersion,
  };
}

/** The record a page applies over: the answer itself when it is the newer version, else the held copy (completed when equal). */
function recordUnderPage(held: Bot, record: BotAnnouncement, verdict: Verdict): BotAnnouncement {
  if (verdict === "newer" || verdict === "legacy" || verdict === "insert") return record;
  const base = verdict === "same" ? completeSameVersion(held, record) : held;
  const { messages: _messages, ...rest } = base;
  return rest;
}

/** The record half of an HTTP answer merged as a frame, without moving the viewed thread (only a page under its intent does that).
 * `ownIntent`: the answer to a page change of this client that is still the latest (the deleteTask answer), merged whole as a frame. */
function applyHttpRecord(state: AppState, record: BotAnnouncement, ownIntent = false): AppState {
  const held = state.bots.find((bot) => bot.id === record.id);
  if (!held || ownIntent) return applyBotFrame(state, record);
  const { messages: _messages, ...fields } = record;
  // a deleteTask answer for the thread the record already moved to (awaitingThreadSnapshot) is that thread's page (V1 §2.3)
  const ownPage = Array.isArray(record.messages) && held.awaitingThreadSnapshot && record.threadId === held.threadId && record.threadId !== held.deletedThreadId;
  if (ownPage) return applyBotFrame(state, record);
  return applyBotFrame(state, { ...recordOnly(fields as BotAnnouncement), threadId: held.threadId });
}

function reduceBotPatched(state: AppState, action: Extract<Action, { type: "botPatched" }>): AppState {
  const verified = action.source === "http" && action.verified === true;
  const id = action.bot.id;
  const admitted = admitRecord(state, action.bot, action, verified);
  let next = verified ? clearVerify(admitted.state, id) : admitted.state;
  const { verdict } = admitted;
  const settled = action.source === "http" ? action.settled : undefined;
  if (verdict === "drop") return withOverlay(next, id, action.overlay);
  const held = next.bots.find((bot) => bot.id === id);
  // Record half (§2.5).
  if (verdict === "stale") {
    // A settling answer a frame outran: the frame may omit a field this answer cleared (the store omits unset fields), so the
    // fields are settled by one more verification, at a number past that frame.
    if (settled?.length && held) next = markVerify(owing(next, id, settled), id);
  } else if (verdict === "same") {
    if (held) {
      const completed = completeSameVersion(held, action.bot);
      if (completed !== held) next = updateBot(next, id, () => completed);
    }
  } else if (action.source === "http") {
    // A record nobody holds, from an answer: inserted unloaded (its first page is fetched on open, §2.5 insert); legacy as today.
    const record = !held && verdict === "insert" ? { ...recordOnly(action.bot), messages: [], messagesUnloaded: true as const } : action.bot;
    const ownIntent = action.intent !== undefined && action.intent === (next.pageIntent?.[id] ?? 0) && record.threadId !== held?.deletedThreadId;
    next = applyHttpRecord(next, record as BotAnnouncement, ownIntent);
  } else next = applyBotFrame(next, action.bot);
  const after = next.bots.find((bot) => bot.id === id);
  if (!after) return next;
  if (verdict !== "stale") next = stampAdmitted(next, id, action.bot, verdict, verdict === "insert" || verdict === "newer" || (verdict === "legacy" && !held));
  // A settling answer (its own keys, or a verification) at the held number or past it is the whole record: it settles every key
  // the bot is still owed, not only its own (I-H1).
  if ((settled?.length || verified) && (verdict === "same" || verdict === "newer" || verdict === "insert")) {
    const owed = owedKeys(next, id, settled);
    if (owed.length) next = settleFields(next, id, action.bot, owed);
  }
  // Page half for an answer that carries the page of the very thread the record moved to and waits for (the deleteTask answer, V1
  // §2.3): adopted whatever its record verdict, since the server's own frame may have numbered the record first. A stream page at
  // the SAME number is that same page (another window deleted the viewed task: the server sends the record, then its page with
  // the one number), so it completes the wait too; a newer stream page already went through applyBotFrame above.
  if ((action.source === "http" || verdict === "same") && Array.isArray(action.bot.messages) && after.awaitingThreadSnapshot &&
      action.bot.threadId === after.threadId && action.bot.threadId !== after.deletedThreadId) {
    const current = next.bots.find((bot) => bot.id === id)!;
    next = reducer(next, { type: "taskSwitched", source: "local", bot: { ...current, ...pageFieldsOf(action.bot), id } as Bot });
  }
  return withOverlay(next, id, action.overlay);
}

/** A bot record merged over the held one as every frame is (the record half of an admitted input, §2.5 newer): task deltas over the
 * rows held now, an unknown bot added, and the server's own move of the viewed thread (switchedThread) taken as its page. */
function applyBotFrame(state: AppState, incoming: BotAnnouncement): AppState {
  const before = state.bots.find((b) => b.id === incoming.id);
  // Task deltas are laid over the rows held NOW, inside the reducer.
  const bot: BotAnnouncement = incoming.tasksDelta
    ? withTaskDelta(incoming, before)
    : before?.tasksStale && Array.isArray(incoming.tasks) ? { ...incoming, tasksStale: false } : incoming;
  // Bot frames are complete except for their transcript. An unknown one
  // was created by another client (the phone, another app window, or a
  // team import), so add it now; the following message frames will fill
  // its greeting without waiting for a full-page hydration.
  if (!before) {
    const added = {
      ...state,
      bots: [{ ...bot, messages: bot.messages ?? [] }, ...state.bots],
    };
    return reconcileSnapshotQueues(added, [bot]);
  }
  const kind =
    bot.unread && !before?.unread
      ? "surprise"
      : bot.busy === true && !before?.busy
        ? "working"
        : bot.busy === false && before?.busy
          ? "celebrate"
          : null;
  const animated = kind ? withMascotMotion(state, bot.id, kind) : state;
  // The workspace Chief is exempt, exactly as she is on the server.
  //
  // `chiefOfStaff` is true for the Chief AND for every team leader, and
  // this walks by section — so in the DEFAULT workspace, where nobody
  // created a section and every bot shares sectionKey "", electing any
  // team leader cleared the Chief's flag here. She kept `chiefScope:
  // "workspace"` with no flag, which is a shape that cannot exist: it
  // classifies as `member`, so she loses her badge, her row and her top
  // slot in the sidebar.
  //
  // And the renderer never recovers on its own. The server refuses this
  // demotion (server/store.ts:1557), so nothing about her actually
  // changed, so no frame is ever emitted to correct the client. The wrong
  // state is sticky until a full hydration. This is the Chief-vanishes
  // report, and only its server half was fixed.
  const next = bot.chiefOfStaff
    ? {
        ...animated,
        bots: animated.bots.map((b) =>
          b.id === bot.id ||
          b.chiefScope === "workspace" ||
          (b.section?.trim() || "") !== (bot.section?.trim() || "")
            ? b
            : { ...b, chiefOfStaff: false },
        ),
      }
    : animated;
  const switchedThread =
    typeof bot.threadId === "string" && bot.threadId !== before.threadId &&
    viewedThreadGone(before, bot);
  const deletedSelection = switchedThread && Array.isArray(bot.tasks);
  if (Array.isArray(bot.messages) &&
      (switchedThread || (before.awaitingThreadSnapshot && bot.threadId === before.threadId))) {
    // hasMore spelled out: `before`'s answer belongs to the thread being left. The record was admitted already (C1: stream).
    return reducer(switchedThread ? bumpPageIntent(next, bot.id) : next, { type: "taskSwitched", source: "stream", bot: { ...before, ...bot, messages: bot.messages, hasMore: bot.hasMore } });
  }
  // Only the server's own move of the viewed thread (it was deleted) is its page intent (§2.6 r6): an own switch's echo, or
  // another window's switch, leaves the intent standing and the answer that follows applies its page.
  const patched = updateBot(deletedSelection ? bumpPageIntent(bumpTranscriptGeneration(next, before.threadId), bot.id) : next, bot.id, (b) => ({
    ...b,
    ...bot,
    // A frame with the whole description (every frame but the roster's) replaces the roster's cut copy and its marker.
    ...(typeof bot.description === "string" && bot.descriptionCut !== true ? { descriptionCut: undefined } : {}),
    // Messages are ignored on a same-thread frame, so its page marker is
    // too: this client may already have paged further back than it says.
    hasMore: deletedSelection ? false : b.hasMore,
    threadId: deletedSelection ? bot.threadId : b.threadId,
    activeLeafId: deletedSelection ? null : b.activeLeafId,
    awaitingThreadSnapshot: deletedSelection || b.awaitingThreadSnapshot,
    deletedThreadId: deletedSelection ? b.threadId : b.deletedThreadId,
    pendingThreadEvents: deletedSelection ? [] : b.pendingThreadEvents,
    ...extraTasksPatch(b, bot, { keepViewed: !deletedSelection }),
    // The store omits an unset messageAllow (My team is the default), so a frame without it means it was cleared: spreading `bot` alone would keep "Everyone" for ever.
    ...(typeof bot.name === "string" && !("messageAllow" in bot) ? { messageAllow: undefined } : {}),
    // Like the transcript they ride beside: another window's switch frame
    // carries its own thread's cards, not this one's.
    openCards: deletedSelection ? undefined : b.openCards,
    openCardsLeaf: deletedSelection ? undefined : b.openCardsLeaf,
    olderFrom: deletedSelection ? undefined : b.olderFrom,
    // The version belongs to the page held, which this frame did not replace.
    threadVersion: deletedSelection ? undefined : b.threadVersion,
    // Ordinary bot patches omit messages and must preserve the current
    // transcript. A task switch is different: its full bot event carries
    // the new transcript, which must replace the previous task before the
    // webhook's streamed messages begin arriving.
    messages: deletedSelection ? [] : b.messages,
  }));
  return patched;
}

export function reducer(state: AppState, action: Action): AppState {
  const next = reduceState(state, action);
  return next === state ? next : withSidebarLines(state, next);
}

function reduceState(state: AppState, action: Action): AppState {
  if (action.type === "messageAdded" || action.type === "messagePatched" || action.type === "threadActive") {
    const waiting = state.bots.find(bot => bot.awaitingThreadSnapshot && bot.threadId === action.threadId);
    if (waiting) return updateBot(state, waiting.id, bot => ({ ...bot, pendingThreadEvents: [...(bot.pendingThreadEvents ?? []), action] }));
    // A first page is on the wire for this conversation: queue the event, replayed over the page in the reducer (`firstPage`).
    const loading = firstPageOwner(state, action.threadId);
    if (loading) return updateOwnerByThread(state, action.threadId, (owner) => ({ ...owner, firstPageEvents: [...(owner.firstPageEvents ?? []), action] }));
  }
  switch (action.type) {
    case "hydrate": {
      // a roster older than every answer still applied: read it again
      if (action.expired) return requestReconcile(state);
      const known = (id: string) => action.bots.some((b) => b.id === id) || action.groups.some((g) => g.id === id);
      // Where you land when nothing else says otherwise: the Chief of Staff.
      //
      // This used to be `bots[0]` — whichever record the harness happened to
      // list first, which is creation order. On the desktop that barely shows,
      // because `selectedId` persists and only a first run ever hits it. On a
      // phone it is the whole first impression: a device signs in with no
      // stored selection and lands on an arbitrary teammate.
      //
      // The Chief is the one bot that is meant to be the way in — it runs the
      // workspace and hands work to everyone else — so it is the honest
      // default. A workspace with no Chief falls back to first, exactly as
      // before.
      const visible = action.bots.filter((candidate) => !candidate.hidden);
      const chief = visible.find((candidate) => botRole(candidate) === "chief");
      // The fallback skips hidden bots too. `bots[0]` did not, so a workspace
      // whose first record happens to be archived opened on a bot the sidebar
      // does not even list.
      // A returning person lands on the conversation they left (`resumeId`, only ever passed once setup is finished, see
      // lib/last-conversation.ts); a hidden or deleted one falls through to the Chief exactly as before.
      const selectedId = landingId({
        selectedId: state.selectedId,
        known,
        resumeId: action.resumeId,
        resumable: (id) => visible.some((candidate) => candidate.id === id) || action.groups.some((g) => g.id === id && !g.hidden),
        fallback: chief?.id ?? visible[0]?.id ?? action.bots[0]?.id ?? "",
      });
      // Every transcript in the snapshot replaces the one held before it.
      const fenced = bumpTranscriptGeneration(state, ...action.bots.map((b) => b.threadId), ...action.groups.map((g) => g.threadId));
      // The boot roster (`view=sidebar`) carries no rows: every conversation arrives unloaded, with its sidebar line. A room of the same thread
      // in the same run keeps the rows it holds by number, each unvouched and its tail forgotten (ROOM-ORDER-DESIGN r7 R4): the walk re-reads
      // them; a legacy room, and every room of a new run (a restore may have renumbered), arrives unloaded. The bot on screen keeps its rows
      // (no blank), marked stale so its first page is fetched again when it is opened; every other bot drops its rows (its branch head may
      // have moved, and its page replaces the rows). An entry that does carry rows (an older listing) is held as it came.
      const onScreenId = state.activeView === "chat" ? state.selectedId : "";
      const sameRun = action.tasksEpoch !== undefined && state.streamEpoch === action.tasksEpoch;
      const arrive = <T extends Bot | Group>(entry: T, held: T | undefined): T => {
        if (isGroupOwner(entry)) {
          const { firstPageEvents: _queue, newestSeq: _newest, ...rest } = entry as Group & { newestSeq?: unknown };
          const sameThread = held !== undefined && isGroupOwner(held) && held.threadId === entry.threadId;
          const base = hydrateTranscript(sameThread ? transcriptOf(held) : { messages: [] }, sameRun && sameThread);
          const kept = sameThread && !base.messagesUnloaded;
          let room = {
            ...rest, ...base,
            openCards: kept ? held.openCards : undefined, openCardsLeaf: kept ? held.openCardsLeaf : undefined, openCardsPending: kept ? held.openCardsPending : undefined,
          } as Group;
          const page = roomPageOf(entry);
          // r4 T3: a listing that carries rows is a page, vouched by its origin (the roster's own answer)
          if (page) room = roomWithPage(room, page, true);
          for (const key of ["numbered", "tail", "legacyGaps", "hasMore", "olderFrom", "openCards", "openCardsLeaf", "openCardsPending", "messagesUnloaded"] as const) if (room[key] === undefined) delete room[key];
          return room as unknown as T;
        }
        if (Array.isArray((entry as { messages?: unknown }).messages)) return entry;
        const { firstPageEvents: _queue, pageStale: _stale, ...rest } = entry as Bot;
        // a transcript with no rows holds nothing to keep: it arrives unloaded (its first page, a window, is then what it holds)
        const keepsRows = held !== undefined && held.threadId === entry.threadId && !held.messagesUnloaded && held.messages.length > 0 && held.id === onScreenId;
        if (held && keepsRows) {
          return { ...rest, messages: held.messages, hasMore: held.hasMore, olderFrom: held.olderFrom, openCards: held.openCards, openCardsLeaf: held.openCardsLeaf, openCardsPending: held.openCardsPending, messagesUnloaded: undefined, pageStale: true } as unknown as T;
        }
        return { ...rest, messages: [], messagesUnloaded: true } as unknown as T;
      };
      // §2.8: the roster's own removals become tombstones first, then each row is admitted by number, then membership of an unlisted
      // held bot is decided by when it reached this client against when the roster was asked for. Never a wholesale replacement.
      let admission: AppState = fenced;
      if (action.tasksEpoch !== undefined && admission.streamEpoch !== action.tasksEpoch) {
        // a run this client already left: the roster is dropped whole (§9.4)
        if (isPastEpoch(admission, action.tasksEpoch)) return state;
        const now = answerClock.now();
        admission = {
          ...admission,
          streamEpoch: action.tasksEpoch,
          // when this roster was asked for, not when it landed (Astra r7 H1); a caller without `sentTick` asks and applies at once
          streamEpochTick: action.sentTick ?? admission.admitTick ?? 0,
          pastEpochs: admission.streamEpoch === undefined ? admission.pastEpochs ?? [] : [...(admission.pastEpochs ?? []).filter((entry) => entry.epoch !== admission.streamEpoch), { epoch: admission.streamEpoch, seenAt: now }],
        };
      }
      // r4 T4: the roster's request time is the floor under which no answer's page may close a room's gap; never lowered by a late roster.
      if (action.tasksEpoch !== undefined && typeof action.sentAt === "number") {
        admission = { ...admission, transcriptFloor: Math.max(admission.transcriptFloor ?? Number.NEGATIVE_INFINITY, action.sentAt) };
      }
      // r3 R5: the roster's clock is the horizon; a delivered-out-of-order roster never lowers it, and a new run resets it.
      if (action.tasksEpoch !== undefined && typeof action.roomClock === "number") {
        const before = admission.roomHorizon?.epoch === action.tasksEpoch ? admission.roomHorizon.seq : -1;
        admission = { ...admission, roomHorizon: { epoch: action.tasksEpoch, seq: Math.max(before, action.roomClock) } };
      }
      if (action.tasksEpoch !== undefined && action.sentTick !== undefined) {
        // A tombstone written before this roster was asked for: the new connection behind it carries only later frames, so once its
        // buffer is drained the stream has passed the removal (an unacked hide or deletion whose frame went with the old connection).
        const ackable = (table: Record<string, Tombstone> | undefined): Record<string, Tombstone> | undefined => {
          let out = table;
          for (const [id, t] of Object.entries(table ?? {})) {
            if (t.streamAcked || t.ackOnDrain || (t.tick ?? 0) > action.sentTick!) continue;
            if (out === table) out = { ...out };
            out![id] = { ...t, ackOnDrain: true };
          }
          return out;
        };
        const tombstones = ackable(admission.tombstones);
        const roomTombstones = ackable(admission.roomTombstones);
        if (tombstones !== admission.tombstones || roomTombstones !== admission.roomTombstones) admission = { ...admission, tombstones, roomTombstones };
      }
      if (action.tasksEpoch !== undefined) {
        for (const entry of action.removed ?? []) {
          // hides fence only a scoped client: the desktop holds archived bots as hidden records (Opus H-r6-1)
          if (entry.kind === "hidden" && !admission.scopedClient) continue;
          const held = admission.bots.find((bot) => bot.id === entry.id);
          if (held && held.tasksEpoch === entry.tasksEpoch && (held.recordSeq ?? held.tasksSeq ?? -1) > entry.tasksSeq) continue;
          admission = writeTombstone(removeHeldBot(admission, entry.id), entry.id, { epoch: entry.tasksEpoch, seq: entry.tasksSeq, kind: entry.kind, streamAcked: false, ackOnDrain: true });
        }
      }
      // Rooms (ROOM-ORDER-DESIGN §2.4, r3 R5): the roster's room removals become tombstones first (a hydrate never clears one), then each
      // row is admitted by number, then membership of an unlisted held room is decided by when it reached this client.
      const removedRoomIds = new Set<string>();
      if (action.tasksEpoch !== undefined) {
        for (const entry of action.removedGroups ?? []) {
          if (typeof entry?.id !== "string" || typeof entry.recordSeq !== "number" || typeof entry.recordEpoch !== "string") continue;
          removedRoomIds.add(entry.id);
          // hides fence only a scoped client: the desktop holds archived rooms as hidden records
          if (entry.kind === "hidden" && !admission.scopedClient) continue;
          const heldRoom = admission.groups.find((group) => group.id === entry.id);
          if (heldRoom && heldRoom.recordEpoch === entry.recordEpoch && (heldRoom.recordSeq ?? -1) > entry.recordSeq) continue;
          admission = writeTombstone(removeHeldRoom(admission, entry.id), entry.id, { epoch: entry.recordEpoch, seq: entry.recordSeq, kind: entry.kind, streamAcked: false, ackOnDrain: true }, "roomTombstones");
        }
      }
      const listedRooms = new Set(action.groups.map((group) => group.id));
      const groups: Group[] = [];
      for (const row of action.groups) {
        const heldRoom = admission.groups.find((group) => group.id === row.id);
        if (action.tasksEpoch === undefined) {
          // an older server, or a caller the server gives no numbers: the roster is the truth, as before
          groups.push(arrive(row, heldRoom));
          continue;
        }
        const admitted = admitRoom(admission, row, action, true);
        admission = admitted.state;
        const nowRoom = admission.groups.find((group) => group.id === row.id);
        switch (admitted.verdict) {
          case "drop":
          case "stale": {
            // a dropped or stale row keeps the copy this client holds (§2.4); a scoped hide or a tombstone already removed it
            if (!nowRoom) break;
            const { messages: _messages, ...record } = nowRoom;
            groups.push(arrive(record as Group, nowRoom));
            break;
          }
          default: {
            if (nowRoom) {
              const merged = mergeRoomRecord(admission, nowRoom, row, wholeRoom(row), new Set());
              const { messages: _messages, ...record } = merged;
              groups.push(arrive(Array.isArray(row.messages) ? { ...record, messages: row.messages } as Group : record as Group, nowRoom));
            } else {
              const admittedAt = (admission.admitTick ?? 0) + 1;
              admission = { ...admission, admitTick: admittedAt };
              groups.push(arrive({ ...row, admittedAt }, undefined));
            }
          }
        }
      }
      // Membership: an unlisted held room admitted at or before the roster's request is gone, and is fenced at the roster's clock unless
      // its removal is named; one admitted after it (a create during the hydrate) is kept, its own buffered frames settle it.
      for (const heldRoom of admission.groups) {
        if (listedRooms.has(heldRoom.id) || groups.some((group) => group.id === heldRoom.id)) continue;
        if (action.sentTick !== undefined && (heldRoom.admittedAt ?? 0) > action.sentTick) {
          groups.push(heldRoom);
          continue;
        }
        if (action.tasksEpoch !== undefined && typeof action.roomClock === "number" && heldRoom.recordEpoch === action.tasksEpoch && !removedRoomIds.has(heldRoom.id)) {
          admission = writeTombstone(admission, heldRoom.id, { epoch: action.tasksEpoch, seq: action.roomClock, kind: admission.scopedClient ? "hidden" : "deleted", streamAcked: false, ackOnDrain: true }, "roomTombstones");
        }
      }
      const roomOrder = new Map(action.groups.map((group, index) => [group.id, index]));
      groups.sort((a, b) => (roomOrder.get(a.id) ?? -1) - (roomOrder.get(b.id) ?? -1));
      const listed = new Set(action.bots.map((bot) => bot.id));
      const bots: Bot[] = [];
      for (const row of action.bots) {
        if (admission.pendingDeletes?.[row.id]) continue;
        const held = admission.bots.find((bot) => bot.id === row.id);
        if (action.tasksEpoch === undefined) {
          // an older server, or a caller the server gives no numbers: the roster is the truth, as before
          if (admission.tombstones?.[row.id]?.kind === "deleted") continue;
          admission = dropTombstone(admission, row.id);
          bots.push(arrive({ ...row, admittedAt: held?.admittedAt ?? 0 }, held));
          continue;
        }
        const admitted = admitRecord(admission, row, action);
        admission = admitted.state;
        const now = admission.bots.find((bot) => bot.id === row.id);
        const numbered = numberedRecord(row);
        switch (admitted.verdict) {
          case "drop":
            break;
          case "stale": {
            if (!now) break;
            const { messages: _messages, ...record } = now;
            bots.push(arrive(record as Bot, now));
            break;
          }
          case "same": {
            if (!now) break;
            const { messages: _messages, ...record } = completeSameVersion(now, row);
            bots.push(arrive(record as Bot, now));
            break;
          }
          default: {
            const admitTick = now ? admission.admitTick ?? 0 : (admission.admitTick ?? 0) + 1;
            if (!now) admission = { ...admission, admitTick };
            bots.push(arrive({ ...row, admittedAt: now?.admittedAt ?? admitTick, ...(numbered ? { recordSeq: row.tasksSeq } : {}) }, now));
            admission = noteSeen(admission, row.id, row);
          }
        }
      }
      // Membership (§2.8 r6, I15): an unlisted held bot inserted at or before the roster's request is gone; one inserted after it
      // (a create or restore during the hydrate) is kept and verified.
      for (const held of admission.bots) {
        if (listed.has(held.id) || bots.some((bot) => bot.id === held.id)) continue;
        if (action.sentTick !== undefined && (held.admittedAt ?? 0) > action.sentTick) {
          bots.push(held);
          admission = markVerify(admission, held.id);
        }
      }
      const order = new Map(action.bots.map((bot, index) => [bot.id, index]));
      bots.sort((a, b) => (order.get(a.id) ?? -1) - (order.get(b.id) ?? -1));
      const heldIds = new Set(bots.map((bot) => bot.id));
      const knownHeld = (id: string) => heldIds.has(id) || groups.some((g) => g.id === id);
      const visibleHeld = bots.filter((candidate) => !candidate.hidden);
      const chiefHeld = visibleHeld.find((candidate) => botRole(candidate) === "chief");
      const settledSelection =
        selectedId && knownHeld(selectedId) ? selectedId : (chiefHeld?.id ?? visibleHeld[0]?.id ?? bots[0]?.id ?? "");
      const reconciled = reconcileSnapshotQueues(
        {
          ...admission,
          bots,
          groups,
          computerControl: action.computerControl,
          sidebarSectionOrder: action.sidebarSectionOrder,
          selectedId: settledSelection,
          hydrated: true,
        },
        [...bots, ...groups].map((owner) => ({ messages: owner.messages.length ? owner.messages : owner.sidebarLine?.queueId ? [{ queueId: owner.sidebarLine.queueId, at: owner.sidebarLine.at }] : [] })),
      );
      return action.pendingSends ? applyServerPending(reconciled, action.pendingSends) : reconciled;
    }
    case "serverSends": {
      const merged = mergeServerPending(state.pendingQueued[action.threadId], action.pending);
      const pendingQueued = { ...state.pendingQueued };
      if (merged.length) pendingQueued[action.threadId] = merged;
      else delete pendingQueued[action.threadId];
      return { ...state, pendingQueued };
    }
    case "loadOlderMessages":
      return state.loadingOlder[action.threadId]
        ? state
        : { ...state, loadingOlder: { ...state.loadingOlder, [action.threadId]: true } };
    case "tasksResynced": {
      const held = state.bots.find((b) => b.id === action.botId);
      if (!held) return state;
      if (action.expired) return requestReconcile(state);
      // One run table for every input (§2.4): another run's list is applied only when it is the current run's.
      if (state.streamEpoch !== undefined && action.tasksEpoch !== held.tasksEpoch && action.tasksEpoch !== state.streamEpoch) return state;
      // The snapshot was read before a newer frame of the same run landed: it
      // would put back a task list that frame had already moved past.
      if (held.tasksEpoch && held.tasksEpoch === action.tasksEpoch && (held.tasksSeq ?? 0) > (action.tasksSeq ?? 0)) return state;
      return updateBot(state, action.botId, (b) => ({
        ...b,
        tasks: action.tasks,
        tasksSeq: action.tasksSeq,
        tasksEpoch: action.tasksEpoch,
        tasksStale: false,
        ...(action.tasksTotal !== undefined ? { tasksTotal: action.tasksTotal } : {}),
        ...(action.tasksOlder !== undefined ? { tasksOlder: action.tasksOlder } : {}),
        ...(action.usageTotal ? { usageTotal: action.usageTotal } : {}),
        ...(action.grantsAll ? { grantsAll: action.grantsAll } : {}),
        ...extraTasksPatch(b, { tasks: action.tasks, tasksTotal: action.tasksTotal }),
      }));
    }
    case "threadSettingsSaved":
      return updateBot(state, action.botId, (b) => heldRecordSeq(b) === action.sentSeq ? withSavedThreadSettings(b, action.threadId, action.keys, action.task) : b);
    case "tasksFetched": {
      if (action.owner === "bot") return updateBot(state, action.id, (b) => ({ ...b, extraTasks: withExtraTasks(b.extraTasks, action.tasks) }));
      return { ...state, groups: state.groups.map((g) => (g.id === action.id ? { ...g, extraTasks: withExtraTasks(g.extraTasks, action.tasks as GroupTask[]) } : g)) };
    }
    case "openCardsRefreshed": {
      // accepted only if the response still describes this transcript: the generation and the leaf the request was made for are the ones held now,
      // the leaf the server answered for is the held one, and no card was patched meanwhile
      if (action.gen !== undefined && (state.transcriptGeneration[action.threadId] ?? 0) !== action.gen) return state;
      const heldBot = state.bots.find((b) => b.threadId === action.threadId);
      const fulfil = (next: AppState): AppState => {
        if (action.readyRev === undefined) return next;
        const gen = next.transcriptGeneration[action.threadId] ?? 0, held = next.cardsFulfilled[action.threadId];
        const rev = held && held.gen === gen ? Math.max(held.rev, action.readyRev) : action.readyRev;
        return { ...next, cardsFulfilled: { ...next.cardsFulfilled, [action.threadId]: { gen, rev } } };
      };
      if (heldBot) {
        if (action.requestLeaf !== undefined && heldBot.activeLeafId !== action.requestLeaf) return state;
        if (heldBot.activeLeafId !== action.leafId || (heldBot.cardsRev ?? 0) !== action.rev) return state;
        return fulfil(updateBot(state, heldBot.id, (b) => withRefreshedCards(b, action)));
      }
      // a room: its transcript has no client-held branch head, so the generation and the card revision are what fence the answer
      const room = state.groups.find((g) => g.threadId === action.threadId);
      if (!room || (room.cardsRev ?? 0) !== action.rev) return state;
      return fulfil({ ...state, groups: state.groups.map((g) => (g.id === room.id ? withRefreshedCards(g, action) : g)) });
    }
    case "openCardsReady":
      // kept for the conversation named, held or not; the global notice counts for every conversation
      if (action.threadId === null) return { ...state, cardsReadyAll: state.cardsReadyAll + 1 };
      return { ...state, cardsReady: { ...state.cardsReady, [action.threadId]: (state.cardsReady[action.threadId] ?? 0) + 1 } };
    case "olderMessages": {
      const { [action.threadId]: _done, ...loadingOlder } = state.loadingOlder;
      // The page describes the transcript as it stood when it was asked for.
      // If that transcript has since been replaced or rewound, its rows may
      // belong to a thread or branch this client left — drop them, but never
      // leave the loading state stuck on.
      if ((state.transcriptGeneration[action.threadId] ?? 0) !== action.generation) {
        return { ...state, loadingOlder };
      }
      return {
        ...state,
        loadingOlder,
        bots: state.bots.map((bot) => (bot.threadId === action.threadId ? prependOlder(bot, action.messages, action.hasMore, action.olderFrom) : bot)),
        groups: state.groups.map((group) => (group.threadId === action.threadId ? prependOlder(group, action.messages, action.hasMore, action.olderFrom, action.newestSeq, action.before) : group)),
      };
    }
    case "loadFirstPage":
      return state; // the async wrapper asks (scrollback loadFirstPage)
    case "firstPageStarted":
      return updateOwnerByThread(state, action.threadId, (owner) => (owner.firstPageEvents ? owner : { ...owner, firstPageEvents: [] }));
    case "firstPage": {
      const loading = state.bots.find((bot) => bot.threadId === action.threadId) ?? state.groups.find((group) => group.threadId === action.threadId);
      if (!loading) return state;
      const queued = loading.firstPageEvents;
      // The transcript moved while the page was on the wire (a rehydrate, a switch): the page describes one this client left. The owner stays
      // as it is (unloaded, or holding its rows), and what was queued is applied to it as it would have been without a page in flight.
      if ((state.transcriptGeneration[action.threadId] ?? 0) !== action.generation || !queued) {
        return replayFirstPageEvents(updateOwnerByThread(state, action.threadId, (owner) => ({ ...owner, firstPageEvents: undefined })), queued);
      }
      const page = action.page;
      const messages = page.messages ?? [];
      // r6 Q3: a room's newest page is held by number and vouched (its GET was sent after the roster: the generation fences any older one),
      // its `newestSeq` the tail; a legacy room's unions. A bot keeps its branch-aware replace.
      const opened = updateOwnerByThread(bumpTranscriptGeneration(state, action.threadId), action.threadId, (owner) => (isGroupOwner(owner) ? {
        ...roomWithPage({ ...owner, firstPageEvents: undefined }, { ...page, messages }, true),
        firstPageEvents: undefined,
      } as typeof owner : {
        ...owner,
        messages,
        openCards: page.openCards?.length ? page.openCards : undefined,
        openCardsLeaf: page.openCardsLeaf,
        openCardsPending: page.openCardsPending || undefined,
        olderFrom: page.hasMore && page.olderFrom ? page.olderFrom : undefined,
        hasMore: Boolean(page.hasMore),
        ...(isGroupOwner(owner) ? {} : { activeLeafId: page.activeLeafId === undefined ? (owner as Bot).activeLeafId : page.activeLeafId, threadVersion: page.version }),
        messagesUnloaded: undefined,
        pageStale: undefined,
        firstPageEvents: undefined,
      }));
      // Replayed in the reducer, in arrival order, over the page: a row the page already holds is folded once, a newer patch lands over the
      // page's copy, a branch move moves the head.
      return replayFirstPageEvents(reconcileSnapshotQueues(opened, [{ messages }]), queued);
    }
    case "firstPageFailed": {
      const loading = state.bots.find((bot) => bot.threadId === action.threadId) ?? state.groups.find((group) => group.threadId === action.threadId);
      if (!loading?.firstPageEvents) return state;
      return replayFirstPageEvents(updateOwnerByThread(state, action.threadId, (owner) => ({ ...owner, firstPageEvents: undefined })), loading.firstPageEvents);
    }
    case "showRoutines":
      return {
        ...state,
        activeView: "routines",
        settingsOpen: false,
        computerOpen: false,
        inspectorOpen: false,
        appSettingsOpen: false,
        pluginsOpen: false,
      };
    case "showTeamLibrary":
      // Absent, never `undefined`, so a later open without an agent cannot
      // inherit the previous one's pre-fill.
      return {
        ...state,
        teamLibrary: {
          open: true,
          // Absent, never `undefined` — a later open without an agent must not
          // inherit the previous one's pre-fill, and the same goes for the view.
          ...(action.botId ? { botId: action.botId } : {}),
          ...(action.view ? { view: action.view } : {}),
          ...(action.tab ? { tab: action.tab } : {}),
        },
      };
    case "hideTeamLibrary":
      return { ...state, teamLibrary: { open: false } };
    case "showTeamMap":
      return {
        ...state,
        activeView: "team-map",
        teamMapMemoryOpen: Boolean(action.memory),
        settingsOpen: false,
        computerOpen: false,
        inspectorOpen: false,
        appSettingsOpen: false,
        pluginsOpen: false,
      };
    case "showAllChats":
      return {
        ...state,
        activeView: "all-chats",
        allChatsScope: action.botId ? { botId: action.botId } : action.groupId ? { groupId: action.groupId } : undefined,
        settingsOpen: false,
        computerOpen: false,
        inspectorOpen: false,
        appSettingsOpen: false,
        pluginsOpen: false,
      };
    case "closeAllChats":
      return state.activeView === "all-chats" ? { ...state, activeView: "chat", allChatsScope: undefined } : state;
    case "showSkillRecorder":
      if (!skillRecorderEnabled(state.config)) return state;
      return {
        ...state,
        activeView: "skill-recorder",
        settingsOpen: false,
        computerOpen: false,
        inspectorOpen: false,
        appSettingsOpen: false,
        pluginsOpen: false,
      };
    case "routinesHydrated":
      return { ...state, routines: action.routines, routineRuns: trimRoutineRuns(action.runs) };
    case "routinePatched": {
      const exists = state.routines.some((routine) => routine.id === action.routine.id);
      return {
        ...state,
        routines: exists
          ? state.routines.map((routine) => (routine.id === action.routine.id ? action.routine : routine))
          : [action.routine, ...state.routines],
      };
    }
    case "routineDeleted":
      return { ...state, routines: state.routines.filter((routine) => routine.id !== action.routineId) };
    case "routineRunDeleted":
      return { ...state, routineRuns: state.routineRuns.filter((run) => run.id !== action.runId) };
    case "routineRunPatched": {
      const exists = state.routineRuns.some((run) => run.id === action.run.id);
      const runs = exists
        ? state.routineRuns.map((run) => (run.id === action.run.id ? action.run : run))
        : [action.run, ...state.routineRuns];
      return {
        ...state,
        routineRuns: trimRoutineRuns(runs),
      };
    }
    case "webhooksHydrated":
      return { ...state, webhooks: action.webhooks, webhookAttempts: action.attempts, webhookIngress: action.ingress };
    case "webhookPatched": {
      const exists = state.webhooks.some((webhook) => webhook.id === action.webhook.id);
      return {
        ...state,
        webhooks: exists
          ? state.webhooks.map((webhook) => (webhook.id === action.webhook.id ? action.webhook : webhook))
          : [action.webhook, ...state.webhooks],
      };
    }
    case "webhookDeleted":
      return {
        ...state,
        webhooks: state.webhooks.filter((webhook) => webhook.id !== action.webhookId),
        webhookAttempts: state.webhookAttempts.filter((attempt) => attempt.webhookId !== action.webhookId),
      };
    case "webhookAttempted": {
      const attempts = state.webhookAttempts.some((attempt) => attempt.id === action.attempt.id)
        ? state.webhookAttempts.map((attempt) => attempt.id === action.attempt.id ? action.attempt : attempt)
        : [...state.webhookAttempts, action.attempt];
      return { ...state, webhookAttempts: attempts.slice(-2_000) };
    }
    case "groupPatched": {
      // ROOM-ORDER-DESIGN §2.2: one judge decides whether this statement lands (pending nothing, tombstone, life, run, number, hide).
      const admitted = admitRoom(state, action.group, action.origin);
      if (admitted.verdict === "drop") return admitted.state;
      // r4 T5: versions decide metadata, not membership. A stale statement's record is dropped; its page's rows are the thread's rows all
      // the same and join a live transcript of the same thread. It closes no gap and inserts nothing.
      if (admitted.verdict === "stale") return unionStaleRoomPage(admitted.state, action.group);
      state = admitted.state;
      const incoming = action.group;
      const heldGroup = state.groups.find((g) => g.id === incoming.id);
      // A partial row for a room this client does not hold applies to nothing: it is not a record.
      if (!heldGroup && incoming.threadId === undefined) return state;
      // A whole numbered statement sets every server-owned key, absent meaning cleared (r2); anything else sets the keys it carries.
      const whole = admitted.verdict !== "legacy" && wholeRoom(incoming);
      const removedTaskIds = new Set(action.removedTaskIds ?? []);
      // r4 T1-T4: the page unions into the held transcript (never replaces it); whether it may close a gap is decided by its origin.
      const page = roomPageOf(incoming);
      const closesGap = page !== undefined && pageClosesGap(state, action.origin);
      const threadMoved = heldGroup !== undefined && incoming.threadId !== undefined && incoming.threadId !== heldGroup.threadId;
      if (!heldGroup) {
        // r4 T2: a record inserted without a page is unloaded (its first page is fetched on open); one with a page it may hold holds it.
        const tick = (state.admitTick ?? 0) + 1;
        const { messages: _rows, ...record } = incoming as Group;
        const { newestSeq: _newest, ...bare } = record as Group & { newestSeq?: unknown };
        const unloaded = { ...bare, ...UNLOADED_TRANSCRIPT, admittedAt: tick } as Group;
        const inserted = page && closesGap ? roomWithPage(unloaded, page, true) : unloaded;
        const fenced = inserted !== unloaded ? bumpTranscriptGeneration(state, inserted.threadId) : state;
        return { ...fenced, admitTick: tick, groups: [inserted, ...fenced.groups] };
      }
      const groups = state.groups.map((g) => {
        if (g.id !== incoming.id) return g;
        const next = mergeRoomRecord(state, g, incoming, whole, removedTaskIds);
        applyRoomTranscript(next, g, page, closesGap, threadMoved);
        return next;
      });
      // In-flight scrollback pages describe the transcript this client holds, unless the page became its base (a gap closed, the thread moved).
      const fenced = threadMoved || closesGap ? bumpTranscriptGeneration(state, heldGroup.threadId, threadMoved ? incoming.threadId : undefined) : state;
      // A page that closed the gap replays what queued for the first page over it, in arrival order; a moved thread drops the old thread's queue.
      const queued = closesGap && !threadMoved ? heldGroup.firstPageEvents : undefined;
      return replayFirstPageEvents({ ...fenced, groups }, queued);
    }
    case "groupEdited":
      return state.groups.some((g) => g.id === action.group.id)
        ? { ...state, groups: state.groups.map((g) => (g.id === action.group.id ? applyRoomEdit(g, action.group) : g)) }
        : state;
    case "groupDeleted":
      return admitRoomRemoval(state, action, action.origin);
    case "instances":
      return { ...state, instances: action.instances, engineNote: action.engineNote ?? "", ...(action.shellEnvironment !== undefined ? { shellEnvironment: action.shellEnvironment } : {}) };
    case "configStatus":
      return {
        ...state,
        config: action.config,
        activeView:
          state.activeView === "skill-recorder" && !skillRecorderEnabled(action.config)
            ? "chat"
            : state.activeView,
      };
    case "select": {
      // An id this client has neither a bot nor a group for (E1, 2026-09-28:
      // a companion selecting a bot⇄bot group the server never sent it) used
      // to set `selectedId` to it anyway; App.tsx's lookup found nothing and
      // fell back to `state.bots[0]`, silently opening a different bot.
      // Keep the current selection instead: the select is inert, the same
      // state back, and not a pick, so it closes no drawer either.
      if (!state.groups.some((g) => g.id === action.id) && !state.bots.some((b) => b.id === action.id)) return state;
      // Every select is the person navigating (a row, a shortcut, the Inbox
      // after it switched the task itself), so it counts as a pick.
      state = { ...state, conversationPicks: (state.conversationPicks ?? 0) + 1 };
      if (state.groups.some((g) => g.id === action.id)) {
        return {
          ...state,
          activeView: "chat",
          selectedId: action.id,
          groups: state.groups.map((g) => (g.id === action.id ? { ...g, unread: false, tasks: g.tasks?.map((task) => task.threadId === g.threadId ? { ...task, unreadCount: 0, unread: false, unreadMessageIds: [] } : task) } : g)),
        };
      }
      return updateBot(
        withMascotMotion({ ...state, activeView: "chat", selectedId: action.id }, action.id, "switch"),
        action.id,
        (b) => withThreadUnread(b,action.threadId??b.threadId,false),
      );
    }
    // optimistic card settle; the server's message.patch confirms it later
    case "answerCard": {
      const bot = state.bots.find((candidate) => candidate.id === action.botId);
      const card = (bot?.messages.find((message) => message.id === action.messageId) ?? bot?.openCards?.find((message) => message.id === action.messageId))?.card;
      return withMascotMotion(
        patchCard(state, action.botId, action.messageId, {
          answered: action.answer,
          // talking past the first-run quiz hides it; live asks stay until resolved
          ...(card?.requestId ? {} : { dismissed: true }),
        }),
        action.botId,
        "working",
      );
    }
    case "dismissCard": {
      // A live question never vanishes on dismiss: it is skipped (the
      // engine is told at once) and the server's patch shows it as skipped.
      const owner = state.bots.find((bot) => bot.id === action.botId);
      const card = (owner?.messages.find((message) => message.id === action.messageId) ?? owner?.openCards?.find((message) => message.id === action.messageId))?.card;
      if (isQuestionCard(card)) return state;
      return patchCard(state, action.botId, action.messageId, { dismissed: true });
    }
    // Explicitly false, never a delete: `undefined` means "nobody decided" and
    // lets the transcript hide the card again on its own.
    case "restoreCard":
      return patchCard(state, action.botId, action.messageId, { dismissed: false });
    case "decideRequest":
    case "answerQuestion":
    case "sendQuestionAsMessage":
    case "respondWidget":
    case "reopenWidget":
      return state; // the server's message patch settles the card
    case "botAdded": {
      // Package and starter imports answer with the bot record alone, and
      // every sidebar row reads its last message on the next render.
      const response = Array.isArray(action.bot.messages) ? action.bot : { ...action.bot, messages: [] };
      const held = state.bots.find((bot) => bot.id === response.id);
      // Record admission (§2.3): pending, tombstone, life, run and number decide whether this answer is applied at all.
      const admitted = admitRecord(state, response, action);
      const { verdict } = admitted;
      let merged = admitted.state;
      // Selection (§2.7): selects and arrives iff the bot is held after admission.
      const select = (next: AppState): AppState => withMascotMotion({
        ...next,
        activeView: "chat",
        selectedId: response.id,
        conversationPicks: (next.conversationPicks ?? 0) + 1,
      }, response.id, "arrive");
      if (verdict === "drop" && !merged.bots.some((bot) => bot.id === response.id)) return merged;
      if (!held) {
        if (verdict === "drop" || verdict === "stale") return merged;
        // insert as served (§2.5 insert: botAdded keeps its transcript)
        const admitTick = (merged.admitTick ?? 0) + 1;
        const inserted = { ...response, admittedAt: admitTick, ...(numberedRecord(response) ? { recordSeq: response.tasksSeq } : {}) };
        return select(noteSeen({ ...merged, admitTick, bots: [inserted, ...merged.bots] }, response.id, response));
      }
      // An HTTP create (or duplicate) response raced the stream, which already holds this bot. Each half has
      // its own ordering source (BOTADDED-DESIGN §2).
      // Record half: one winner for the whole record. Numbered (§2.4): newer merges as a frame, equal completes, lower changes
      // nothing. Legacy (no server run known): the response wins only when it is numbered past the held frame in the same run; no
      // number means held, since a create's frame is sent before its response is written.
      if (verdict === "newer" || (verdict === "legacy" && response.tasksEpoch !== undefined && response.tasksEpoch === held.tasksEpoch &&
          typeof response.tasksSeq === "number" && typeof held.tasksSeq === "number" && response.tasksSeq > held.tasksSeq)) {
        merged = stampAdmitted(applyHttpRecord(merged, recordOnly(response)), response.id, response, "newer", true);
      } else if (verdict === "same") {
        const completed = completeSameVersion(held, response);
        if (completed !== held) merged = updateBot(merged, held.id, () => completed);
      }
      const bot = merged.bots.find((candidate) => candidate.id === response.id);
      if (!bot) return merged;
      // Transcript half. Adopted only for the conversation the record points at (a task switched to before
      // the response landed holds its own rows), and never under the page machinery: a first page in
      // flight, a stale page or a removed conversation's snapshot supersedes a creation-time copy.
      const adopt =
        response.threadId === bot.threadId &&
        !(bot.messagesUnloaded || bot.pageStale || bot.firstPageEvents || bot.awaitingThreadSnapshot);
      if (!adopt) return select(merged);
      const messages = foldAddedMessages(response.messages, bot.messages);
      const heldIds = new Set(bot.messages.map((message) => message.id));
      const newCard = response.messages.some((message) => message.kind === "options" && !heldIds.has(message.id));
      const activeLeafId = headOf(messages, bot.activeLeafId, response.activeLeafId);
      const folded = updateBot(merged, bot.id, (b) => ({
        ...b,
        messages,
        activeLeafId,
        hasMore: b.messages.length ? b.hasMore : Boolean(response.hasMore),
        ...(newCard ? { cardsRev: (b.cardsRev ?? 0) + 1 } : {}),
      }));
      return select(reconcileSnapshotQueues(folded, [response]));
    }
    case "deleteBot": {
      // §2.7: removed at once; nothing for the id is admitted until the DELETE's own answer or the deletion frame.
      const removed = removeHeldBot(state, action.botId);
      return { ...removed, pendingDeletes: { ...state.pendingDeletes, [action.botId]: { attempt: action.attempt, archived: action.archived === true } } };
    }
    case "botDeleted": {
      const id = action.botId;
      const held = state.bots.find((bot) => bot.id === id);
      const numbered = typeof action.tasksSeq === "number" && typeof action.tasksEpoch === "string";
      // A real deletion (no audience) ends a pending delete of the id; a hide never does (§9.2).
      const endPending = (next: AppState): AppState => {
        if (action.hidden || !next.pendingDeletes?.[id]) return next;
        const { [id]: _done, ...pendingDeletes } = next.pendingDeletes;
        return { ...next, pendingDeletes };
      };
      if (!numbered) {
        // An older server: removed, and any later input for the id is verified first.
        const removed = endPending(removeHeldBot(state, id));
        return writeTombstone(removed, id, { epoch: "", seq: Number.POSITIVE_INFINITY, kind: action.hidden ? "hidden" : "deleted", streamAcked: true });
      }
      const epoch = action.tasksEpoch!;
      const seq = action.tasksSeq!;
      if (state.streamEpoch !== undefined && epoch !== state.streamEpoch) {
        // a past run's removal changes nothing; an unfamiliar run is verified, never removed (§9.4). A real deletion still ends a
        // pending delete of the id (the provider stopped its retry on this frame, orders P18/P19); the verify settles what is held.
        if (isPastEpoch(state, epoch)) return action.hidden ? state : markVerify(endPending(state), id);
        return markVerify(requestReconcile(endPending(state)), id);
      }
      // a removal older than the held record (a restore that already landed) changes nothing
      if (held && held.tasksEpoch === epoch && seq < (held.recordSeq ?? held.tasksSeq ?? -1)) return endPending(state);
      const removed = endPending(removeHeldBot(state, id));
      return noteSeen(writeTombstone(removed, id, { epoch, seq, kind: action.hidden ? "hidden" : "deleted", streamAcked: true }), id, { tasksSeq: seq, tasksEpoch: epoch });
    }
    case "deletionSettled": {
      const pending = state.pendingDeletes?.[action.botId];
      if (!pending || pending.attempt !== action.attempt) return state;
      const { [action.botId]: _done, ...pendingDeletes } = state.pendingDeletes!;
      const next = { ...state, pendingDeletes };
      if (action.outcome === "deleted") {
        const numbered = typeof action.tasksSeq === "number" && typeof action.tasksEpoch === "string";
        const written = writeTombstone(next, action.botId, numbered
          ? { epoch: action.tasksEpoch!, seq: action.tasksSeq!, kind: "deleted", streamAcked: false }
          : { epoch: "", seq: Number.POSITIVE_INFINITY, kind: "deleted", streamAcked: false });
        // A deletion numbered in a run this client neither holds nor left: the server restarted under it. The roster names the run;
        // asked for after this tombstone, it also acks it on drain, so the tombstone retires by the TTL rule (seed 666), while until
        // then it outlives any frame of the client's older run still buffered (seed 524, tombstoneRunOver).
        const unknownRun = numbered && state.streamEpoch !== undefined && action.tasksEpoch !== state.streamEpoch && !isPastEpoch(state, action.tasksEpoch);
        return unknownRun ? requestReconcile(written) : written;
      }
      if (action.outcome === "gaveUp") {
        // No answer after every retry: the DELETE may have committed whose answer and frame were both lost, with a pre-delete answer
        // still within its life (Astra r5 #5, M-r6-4). Until an authoritative read says otherwise the id is fenced by an unnumbered,
        // unacked entry: any unverified input for it is verified first and dropped. A verified 200 clears it (the bot is alive, and is
        // inserted unloaded); a 404 never does, so the fence outlives the verification and retires ANSWER_TTL_MS after this settlement
        // (the epoch "" run is never the current one), which is past the life of every answer sent before the last attempt.
        return markVerify(writeTombstone(next, action.botId, { epoch: "", seq: Number.POSITIVE_INFINITY, kind: "hidden", streamAcked: false }), action.botId);
      }
      // refused: no tombstone; the bot is fetched again (a 200 re-inserts it unloaded)
      return markVerify(next, action.botId);
    }
    case "pageRequested":
      return (state.pageIntent?.[action.botId] ?? 0) >= action.intent ? state : { ...state, pageIntent: { ...state.pageIntent, [action.botId]: action.intent } };
    case "tombstonesSweep":
      return retireAdmission(state, action.now);
    case "messageAllowSet":
      return updateBot(state, action.botId, (bot) => ({ ...bot, messageAllow: action.messageAllow }));
    case "streamDrained": {
      // Every frame buffered behind the snapshot has been applied (each older than a tombstone was dropped by it), and the new
      // connection carries only later frames: the stream has passed every removal held now, including one written by an answer
      // while the hydrate ran (a DELETE answered alreadyDeleted whose frame went with the abandoned connection, R10's common case).
      const acked = (table: Record<string, Tombstone> | undefined): Record<string, Tombstone> | undefined => {
        let out = table;
        for (const [id, t] of Object.entries(table ?? {})) {
          if (t.streamAcked) continue;
          if (out === table) out = { ...out };
          const { ackOnDrain: _ack, ...rest } = t;
          out![id] = { ...rest, streamAcked: true };
        }
        return out;
      };
      const tombstones = acked(state.tombstones);
      const roomTombstones = acked(state.roomTombstones);
      return tombstones === state.tombstones && roomTombstones === state.roomTombstones ? state : retireAdmission({ ...state, tombstones, roomTombstones }, answerClock.now());
    }
    case "verifySettled": {
      if (action.gone) {
        const kept = state.bots.find((bot) => bot.id === action.botId);
        if (kept && action.sentTick !== undefined && (kept.admittedAt ?? 0) > action.sentTick) {
          // admitted after this fetch was sent: its 404 is older than the admitting input; one more fetch answers for the bot held now
          const done = clearVerify(state, action.botId);
          return done.verifyBots?.[action.botId] ? done : markVerify(done, action.botId);
        }
        return removeHeldBot(clearVerify(forgetSettle(state, action.botId), action.botId), action.botId);
      }
      if (action.giveUp) return clearVerify(clearVerify(forgetSettle(state, action.botId), action.botId), action.botId);
      // no answer: still unknown, so it is asked again (a refused Delete's bot must come back once the server answers)
      return state;
    }
    case "clientScope":
      return state.scopedClient === action.scoped ? state : { ...state, scopedClient: action.scoped };
    case "markUnread":
      return updateBot(withMascotMotion(state, action.botId, "surprise"), action.botId, (b) => withThreadUnread(b,b.threadId,true));
    case "botPatched":
      return reduceBotPatched(state, action);
    case "messageAdded": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) {
        const group = state.groups.find((g) => g.threadId === action.threadId || g.tasks?.some((task) => task.threadId === action.threadId));
        if (!group) return state;
        const active = group.threadId === action.threadId;
        const task = group.tasks?.find((entry) => entry.threadId === action.threadId);
        const already = active && group.messages.some((m) => m.id === action.message.id);
        // r6 Q3: a row a numbered room holds may still be laid again (a vouched copy replaces an unvouched one, the tail moves); a legacy room folds it once
        if ((already && !group.numbered) || task?.unreadMessageIds?.includes(action.message.id)) return state;
        // A room that holds no rows yet: the row moves its sidebar line only (its page, read when it opens, holds it).
        const unloaded = active && group.messagesUnloaded;
        // r6 Q5: a loaded room holds the row at its number (a numbered room) or behind what it holds (a legacy one); its frame vouches for it,
        // a POST answer when it was sent at or after the roster (r4 T4).
        const vouched = action.origin ? pageClosesGap(state, action.origin) : true;
        const placed = active && !unloaded ? roomTranscriptInput(group, { kind: "live", rows: [action.message], newestSeq: action.newestSeq, vouched }) : group;
        if (already) return placed === group ? state : { ...state, groups: state.groups.map((g) => (g.id === group.id ? placed : g)) };
        const visible = active && state.selectedId === group.id && state.activeView === "chat";
        const unseen = !visible && action.message.role === "bot" && ["text", "options"].includes(action.message.kind);
        const counted = placed.messagesTotal !== group.messagesTotal;
        return {
          ...state,
          groups: state.groups.map((g) => g.id === group.id ? {
            ...placed,
            ...(unloaded ? { sidebarLine: sidebarLineOf(action.message) } : {}),
            ...(active && !counted && g.messagesTotal !== undefined ? { messagesTotal: g.messagesTotal + 1 } : {}),
            unread: g.unread || unseen,
            tasks: g.tasks?.map((entry) => entry.threadId === action.threadId && unseen ? {
              ...entry, unread: true, unreadCount: entry.unreadCount ?? 0,
              unreadMessageIds: [...(entry.unreadMessageIds ?? []), action.message.id].slice(-2000),
            } : entry),
          } : g),
        };
      }
      // The POST response and the canonical SSE frame may arrive in either
      // order. A repeated message is already folded, and never moves the head
      // back: a newer reply that won the race is past it. It does move the head
      // forward when it chains onto it (a create response folded the row in
      // while the head was still its parent): a child of the head is never older.
      if (bot.messages.some((message) => message.id === action.message.id)) {
        const forward = (action.message.parentId ?? null) === (bot.activeLeafId ?? null) && action.message.id !== bot.activeLeafId;
        return forward ? updateBot(state, bot.id, (b) => ({ ...b, activeLeafId: action.message.id })) : state;
      }
      if (bot.messagesUnloaded) {
        // No rows held yet: never append (that would be a transcript that exists before its page, growing without bound for a busy thread
        // nobody opened). A row that becomes the branch head moves the line and the head; the page read when the thread opens holds it.
        if (bot.sidebarLine?.messageId === action.message.id) return state;
        const adopts = (action.message.parentId ?? null) === (bot.activeLeafId ?? null);
        const lined = adopts ? updateBot(state, bot.id, (b) => ({ ...b, activeLeafId: action.message.id, sidebarLine: sidebarLineOf(action.message) })) : state;
        const motion = action.message.kind === "options" ? "thinking" : action.message.kind === "activity" ? activityMotion(action.message) : action.message.role === "bot" && action.message.kind === "text" ? "blink" : null;
        return motion ? withMascotMotion(lined, bot.id, motion) : lined;
      }
      // every server-side append chains onto (and becomes) the active leaf
      const next = updateBot(state, bot.id, (b) => {
        // A message chains onto the leaf → it becomes the leaf (the normal
        // append). A message parented elsewhere is a chain-insert of a late
        // turn artifact (settle-time screenshot) — the leaf must stay put,
        // or the follow-up send it raced would fall off the active branch.
        const adoptsLeaf = (action.message.parentId ?? null) === (b.activeLeafId ?? null);
        let messages = [...b.messages, action.message];
        // base64 screen frames are big; a long computer-use session would
        // grow memory without bound. Keep the newest few frames' pixels and
        // strip the rest (the message row survives as a placeholder).
        if (action.message.kind === "screen") {
          const withPng = messages.filter((m) => m.kind === "screen" && m.png);
          const excess = withPng.length - MAX_KEPT_SCREEN_FRAMES;
          if (excess > 0) {
            const dropIds = new Set(withPng.slice(0, excess).map((m) => m.id));
            messages = messages.map((m) => (dropIds.has(m.id) ? { ...m, png: undefined } : m));
          }
        }
        return { ...b, messages, activeLeafId: adoptsLeaf ? action.message.id : b.activeLeafId };
      });
      const motion =
        action.message.kind === "options"
          ? "thinking"
          : action.message.kind === "activity"
            ? activityMotion(action.message)
            : action.message.role === "bot" && action.message.kind === "text"
              ? "blink"
              : null;
      const animated = motion ? withMascotMotion(next, bot.id, motion) : next;
      return animated;
    }
    case "messagePatched": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) {
        const group = state.groups.find((g) => g.threadId === action.threadId);
        if (!group) return state;
        if (group.messagesUnloaded) {
          if (group.sidebarLine?.messageId !== action.message.id) return state;
          return { ...state, groups: state.groups.map((g) => (g.id === group.id ? { ...g, sidebarLine: sidebarLineOf(action.message) } : g)) };
        }
        // r6 Q3 / r8 R8: a patch replaces the row by id; in a numbered room it is held at its number (it may promote a legacy room)
        const vouched = action.origin ? pageClosesGap(state, action.origin) : true;
        const patched = roomTranscriptInput(group, { kind: "patch", rows: [action.message], newestSeq: action.newestSeq, vouched });
        return {
          ...state,
          groups: state.groups.map((g) =>
            g.id === group.id
              ? { ...patched, openCards: patchOpenCards(g.openCards, action.message.id, () => action.message), ...(action.message.kind === "options" ? { cardsRev: (g.cardsRev ?? 0) + 1 } : {}) }
              : g,
          ),
        };
      }
      const motion = action.message.kind === "activity" ? activityMotion(action.message) : null;
      const next = motion ? withMascotMotion(state, bot.id, motion) : state;
      if (bot.messagesUnloaded) {
        return bot.sidebarLine?.messageId === action.message.id ? updateBot(next, bot.id, (b) => ({ ...b, sidebarLine: sidebarLineOf(action.message) })) : next;
      }
      return updateBot(next, bot.id, (b) => ({
        ...b,
        messages: b.messages.map((m) => (m.id === action.message.id ? action.message : m)),
        openCards: patchOpenCards(b.openCards, action.message.id, () => action.message),
        ...(b.patchedSinceOpen ? { patchedSinceOpen: [...b.patchedSinceOpen, action.message.id] } : {}),
        ...(action.message.kind === "options" ? { cardsRev: (b.cardsRev ?? 0) + 1 } : {}),
      }));
    }
    case "screenUnavailable":
      return { ...state, screenNotices: { ...state.screenNotices, [action.botId]: action.message } };
    case "screenFrame": {
      const notices = { ...state.screenNotices };
      delete notices[action.botId];
      return {
        ...withMascotMotion(state, action.botId, "success"),
        screens: { ...state.screens, [action.botId]: { png: action.png, mime: action.mime } },
        screenNotices: notices,
        provisioning: { ...state.provisioning, [action.botId]: false },
      };
    }
    case "provisioning":
      return {
        ...(action.on ? withMascotMotion(state, action.botId, "launch") : state),
        provisioning: { ...state.provisioning, [action.botId]: action.on },
      };
    case "sidebarSectionOrder":
      return { ...state, sidebarSectionOrder: action.order };
    case "computerControl":
      return {
        ...state,
        computerControl: {
          ...state.computerControl,
          [action.botId]: { held: action.held, helpReason: action.helpReason },
        },
      };
    case "setModel":
      if(action.threadId)return state; // publish only the server-confirmed thread selection
      return updateBot(state, action.botId, (b) => ({ ...b, modelSelection: action.selection }));
    case "updateTask": return state;
    case "connected":
      return { ...state, connected: action.value };
    case "signedOut":
      return { ...state, signedOut: true, connected: false };
    case "deletionNote":
      return { ...state, deletionNote: action.note };
    case "deletionOwed": {
      if (!Array.isArray(action.notices)) return state;
      // A slow answer to an old question must not undo a newer event: anything not newer than what is already shown is dropped.
      const rev = typeof action.rev === "number" && Number.isFinite(action.rev) ? action.rev : undefined;
      if (rev !== undefined && (action.answer ? rev < state.owedRev : rev <= state.owedRev)) return state;
      const owedRev = rev ?? state.owedRev;
      const note = owedNote(action.notices);
      if (note) return { ...state, owedRev, deletionNote: note };
      // The note that came from the server's owed list goes when that list is empty, whether or not it still offers "Try again" (a
      // finished line has none). A note a Delete just showed is not one of them and stays.
      if (state.deletionNote?.owed) return { ...state, owedRev, deletionNote: null };
      return owedRev === state.owedRev ? state : { ...state, owedRev };
    }
    case "error":
      return {
        ...(action.message && state.selectedId
          ? withMascotMotion(state, state.selectedId, "alert")
          : state),
        error: action.message,
      };
    // bot settings, the computer panel, and app settings share the right slot
    case "clearBotSettingsIntent":
      return state.botSettingsIntent ? { ...state, botSettingsIntent: null } : state;
    case "toggleSettings": {
      const open = action.open ?? !state.settingsOpen;
      return {
        ...state,
        settingsOpen: open,
        botSettingsIntent: open ? action.intent ?? null : null,
        computerOpen: open ? false : state.computerOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "togglePlugins": {
      const open = action.open ?? !state.pluginsOpen;
      return { ...state, pluginsOpen: open, pluginsSurface: open ? action.surface ?? "apps" : state.pluginsSurface };
    }
    case "focusMessage":
      return {
        ...state,
        focusMessage: {
          threadId: action.threadId,
          messageId: action.messageId,
          nonce: (state.focusMessage?.nonce ?? 0) + 1,
          consumed: false,
          ...(action.sentence ? { sentence: action.sentence } : {}),
        },
      };
    case "focusMessageConsumed":
      if (!state.focusMessage || state.focusMessage.nonce !== action.nonce) return state;
      return { ...state, focusMessage: { ...state.focusMessage, consumed: true } };
    case "toggleComputer": {
      const open = action.open ?? !state.computerOpen;
      return {
        ...state,
        computerOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "workspacePane": {
      const workspacePane = workspacePaneReducer(state.workspacePane, action.action);
      return workspacePane === state.workspacePane ? state : { ...state, workspacePane };
    }
    case "toggleInspector": {
      const open = action.open ?? !state.inspectorOpen;
      return {
        ...state,
        inspectorOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "toggleAppSettings": {
      const open = action.open ?? !state.appSettingsOpen;
      return {
        ...state,
        appSettingsOpen: open,
        // Every caller's id goes through one door, so a stale or unknown
        // value can never open Settings on nothing (lib/settings-sections.ts).
        appSettingsSection: action.section === undefined ? state.appSettingsSection : normalizeSettingsSection(action.section),
        // An alias lands on a card of its page (lib/settings-pages.ts); closing, or opening without a section, leaves none.
        appSettingsAnchor: !open || action.section === undefined ? null : action.anchor ?? resolveSettingsSection(action.section).anchor,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        inspectorOpen: open ? false : state.inspectorOpen,
        pluginsOpen: open ? false : state.pluginsOpen,
      };
    }
    case "appSettingsAnchorDone":
      return state.appSettingsAnchor === null ? state : { ...state, appSettingsAnchor: null };
    case "updateBot": {
      const mascotChanged =
        Object.prototype.hasOwnProperty.call(action.patch, "color") ||
        Object.prototype.hasOwnProperty.call(action.patch, "mascotExpression") ||
        Object.prototype.hasOwnProperty.call(action.patch, "mascotBody");
      const animated = mascotChanged
        ? withMascotMotion(state, action.botId, "customize")
        : state;
      const target = animated.bots.find((bot) => bot.id === action.botId);
      const chiefSection = (action.patch.section ?? target?.section)?.trim() || "";
      // Same exemption, and this is the copy the user actually sees: the
      // optimistic update paints before the PATCH is even sent, so without
      // this the Chief disappeared the instant the button was pressed.
      const next = action.patch.chiefOfStaff
        ? {
            ...animated,
            bots: animated.bots.map((b) =>
              b.id === action.botId ||
              b.chiefScope === "workspace" ||
              (b.section?.trim() || "") !== chiefSection
                ? b
                : { ...b, chiefOfStaff: false },
            ),
          }
        : animated;
      // `chiefScope` rides the wire body only ("section" is not a stored
      // value, it means "drop the workspace tier"), so the optimistic tier is
      // mirrored here instead of folded through. Promoting one bot demotes
      // the previous holder to leader of its own team — never fires it —
      // which is exactly what the harness's setChiefOfStaff does.
      const tier = action.patch.chiefTier;
      const scoped =
        tier === undefined
          ? next
          : {
              ...next,
              bots: next.bots.map((b) =>
                b.id === action.botId
                  ? { ...b, chiefScope: tier === "workspace" ? ("workspace" as const) : undefined }
                  : tier === "workspace" && b.chiefScope === "workspace"
                    ? { ...b, chiefScope: undefined }
                    : b,
              ),
            };
      const { acknowledgeLocalAuto: _ack, acknowledgeFullAccess: _fullAck, chiefTier: _tier, settingsScope:_scope, ...botPatch } = action.patch;
      // A handover is one change: the former Chief keeps its own team when it
      // can lead there, and otherwise joins it as a member (the harness rule).
      const formerChief = tier === "workspace"
        ? state.bots.find((b) => b.id !== action.botId && b.chiefOfStaff === true && b.chiefScope === "workspace")
        : undefined;
      const handedOver = formerChief
        ? {
            ...scoped,
            bots: scoped.bots.map((b) => {
              if (b.id !== formerChief.id || b.chiefOfStaff !== true) return b;
              const engine = scoped.instances.find((instance) => instance.instanceId === b.modelSelection.instanceId);
              // An engine the renderer has not loaded yet is given the benefit of the
              // doubt; the server's frame settles it either way.
              const canLead = engine ? engine.capabilities?.agentsMcp === true : true;
              return formerChiefOutcome(b, scoped.bots, canLead) === "member" ? { ...b, chiefOfStaff: false } : b;
            }),
          }
        : scoped;
      return updateBot(handedOver, action.botId, (b) => ({
        ...b,
        ...botPatch,
        computer: Object.hasOwn(botPatch, "computer") ? botPatch.computer ?? undefined : b.computer,
        // Absent, never false — one shape for "no", the same as on disk.
        ...(botPatch.individual === false ? { individual: undefined } : {}),
      }));
    }
    case "threadActive": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      // The visible branch moved (an edit, a rewind, another client's switch). The frame's line is the new head's: an unloaded bot takes it; a
      // loaded one recomputes from its rows (withSidebarLines) and keeps the frame's only when the head is not held.
      return updateBot(bumpTranscriptGeneration(state, action.threadId), bot.id, (b) => ({
        ...b,
        activeLeafId: action.activeLeafId,
        ...(action.sidebarLine ? { sidebarLine: action.sidebarLine } : {}),
      }));
    }
    // optimistic leaf move; the server's thread frame confirms it later
    case "switchBranch": {
      const bot = state.bots.find((b) => b.id === action.botId);
      if (!bot) return state;
      let cur = action.messageId;
      for (;;) {
        const children = bot.messages.filter((m) => m.parentId === cur);
        if (!children.length) break;
        cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
      }
      return updateBot(bumpTranscriptGeneration(state, bot.threadId), action.botId, (b) => ({ ...b, activeLeafId: cur }));
    }
    // optimistic room edits; the server's group frame confirms them later
    case "patchGroup": {
      // Every other field is sent in the shape it is stored in, so the merge
      // is the final value. `channelProject` is not: the wire carries a goal
      // and a status, and the server builds the stored block, with its
      // timestamps, from them. Merging the input here would put a block with
      // no status on screen for a moment. The PATCH reply carries the real
      // one, so this one field waits for it.
      const { channelProject: _serverOwned, ...optimistic } = action.patch;
      return {
        ...state,
        groups: state.groups.map((g) => (g.id === action.groupId ? { ...g, ...optimistic } : g)),
      };
    }
    case "groupPatchReverted":
      return { ...state, groups: state.groups.map((g) => (g.id === action.groupId ? { ...g, ...action.fields } : g)) };
    // handled entirely by the async wrapper
    case "pendingQueued": {
      if (state.consumedQueueIds[action.queueId]) {
        const consumedQueueIds = { ...state.consumedQueueIds };
        delete consumedQueueIds[action.queueId];
        return { ...state, consumedQueueIds };
      }
      const prev = state.pendingQueued[action.threadId] ?? [];
      if (prev.some((entry) => entry.queueId === action.queueId)) return state;
      return {
        ...state,
        pendingQueued: {
          ...state.pendingQueued,
          [action.threadId]: [...prev, { queueId: action.queueId, text: action.text }],
        },
      };
    }
    case "sendingStarted": {
      const queueId = sendingQueueId(action.sendId);
      const prev = state.pendingQueued[action.threadId] ?? [];
      if (prev.some((entry) => entry.queueId === queueId)) return state;
      return {
        ...state,
        pendingQueued: { ...state.pendingQueued, [action.threadId]: [...prev, { queueId, text: action.text, sending: true, sendId: action.sendId, local: true }] },
      };
    }
    case "sendingSettled": {
      const queueId = sendingQueueId(action.sendId);
      const prev = state.pendingQueued[action.threadId] ?? [];
      const rest = prev.filter((entry) => entry.queueId !== queueId);
      if (rest.length === prev.length) return state;
      const pendingQueued = { ...state.pendingQueued };
      if (rest.length) pendingQueued[action.threadId] = rest;
      else delete pendingQueued[action.threadId];
      return { ...state, pendingQueued };
    }
    case "consumePendingQueued": {
      const prev = state.pendingQueued[action.threadId] ?? [];
      const at = prev.findIndex((entry) => entry.queueId === action.queueId);
      if (at < 0) {
        return {
          ...state,
          consumedQueueIds: rememberConsumedQueueId(state.consumedQueueIds, action.queueId),
        };
      }
      const rest = prev.filter((_, i) => i !== at);
      const pendingQueued = { ...state.pendingQueued };
      if (rest.length) pendingQueued[action.threadId] = rest;
      else delete pendingQueued[action.threadId];
      return { ...state, pendingQueued };
    }
    case "cancelQueued": {
      const bot = state.bots.find((candidate) => candidate.id === action.botId);
      if (!bot) return state;
      const prev = state.pendingQueued[bot.threadId] ?? [];
      const rest = prev.filter((entry) => entry.queueId !== action.queueId);
      if (rest.length === prev.length) return state;
      const pendingQueued = { ...state.pendingQueued };
      if (rest.length) pendingQueued[bot.threadId] = rest;
      else delete pendingQueued[bot.threadId];
      return { ...state, pendingQueued };
    }
    case "cancelGroupQueued": {
      const prev = state.pendingQueued[action.threadId] ?? [];
      const rest = prev.filter((entry) => entry.queueId !== action.queueId);
      if (rest.length === prev.length) return state;
      const pendingQueued = { ...state.pendingQueued };
      if (rest.length) pendingQueued[action.threadId] = rest;
      else delete pendingQueued[action.threadId];
      return { ...state, pendingQueued };
    }
    case "send":
      return withMascotMotion(dismissOnboardingCard(state, action.botId), action.botId, "working");
    case "editMessage":
      return withMascotMotion(state, action.botId, "working");
    case "newTask":
    case "switchTask":
    case "newGroupTask":
    case "switchGroupTask":
      return { ...state, conversationPicks: (state.conversationPicks ?? 0) + 1 };
    case "deleteTask":
    case "deleteGroupTask":
      return state;
    case "pinTask":
      return updateBot(state, action.botId, (bot) => ({
        ...bot,
        tasks: (bot.tasks ?? []).map((task) =>
          task.threadId === action.threadId ? { ...task, pinned: action.pinned || undefined } : task,
        ),
        ...(bot.extraTasks ? { extraTasks: bot.extraTasks.map((task) => task.threadId === action.threadId ? { ...task, pinned: action.pinned || undefined } : task) } : {}),
      }));
    case "renameTask":
      return updateBot(state, action.botId, (bot) => ({
        ...bot,
        tasks: (bot.tasks ?? []).map((task) =>
          task.threadId === action.threadId ? { ...task, title: action.title } : task,
        ),
        ...(bot.extraTasks ? { extraTasks: bot.extraTasks.map((task) => task.threadId === action.threadId ? { ...task, title: action.title } : task) } : {}),
      }));
    case "renameGroupTask":
      return {
        ...state,
        groups: state.groups.map((group) =>
          group.id === action.groupId
            ? {
                ...group,
                tasks: (group.tasks ?? []).map((task) =>
                  task.threadId === action.threadId ? { ...task, title: action.title } : task,
                ),
                ...(group.extraTasks ? { extraTasks: group.extraTasks.map((task) => task.threadId === action.threadId ? { ...task, title: action.title } : task) } : {}),
              }
            : group,
        ),
      };
    case "taskSwitched": {
      if (action.source === "http") {
        // §2.6: the record half is admitted like any answer; the page applies only under this bot's latest page intent, and never
        // for the thread the server deleted (deletedThreadId). An explicit switch answer replaces the viewed thread.
        const id = action.bot.id;
        const admitted = admitRecord(state, action.bot, action);
        const held = admitted.state.bots.find((bot) => bot.id === id);
        if (admitted.verdict === "drop" || !held) return admitted.state;
        const pageOk = (admitted.state.pageIntent?.[id] ?? 0) === action.intent && action.bot.threadId !== held.deletedThreadId;
        if (!pageOk) {
          if (admitted.verdict === "stale") return admitted.state;
          if (admitted.verdict === "same") {
            const completed = completeSameVersion(held, action.bot);
            return completed === held ? admitted.state : updateBot(admitted.state, id, () => completed);
          }
          return stampAdmitted(applyHttpRecord(admitted.state, recordOnly(action.bot)), id, action.bot, admitted.verdict, admitted.verdict === "newer");
        }
        const record = recordUnderPage(held, action.bot, admitted.verdict);
        const paged = reduceState(admitted.state, { type: "taskSwitched", source: "local", bot: { ...record, ...pageFieldsOf(action.bot), id } as Bot });
        return admitted.verdict === "stale" ? paged : stampAdmitted(paged, id, action.bot, admitted.verdict, admitted.verdict === "newer");
      }
      const before = state.bots.find(bot => bot.id === action.bot.id);
      const pending = [
        ...(before?.awaitingThreadSnapshot && before.threadId === action.bot.threadId ? before.pendingThreadEvents ?? [] : []),
        // a first page of the same thread that was on the wire: this snapshot answers it, and what was queued for it lands over this one
        ...(before?.firstPageEvents && before.threadId === action.bot.threadId ? before.firstPageEvents : []),
      ];
      const switched = updateBot(bumpTranscriptGeneration(state, action.bot.threadId), action.bot.id, (bot) => ({
        ...bot,
        ...action.bot,
        messages: action.bot.messages ?? [],
        openCards: action.bot.openCards,
        openCardsLeaf: action.bot.openCardsLeaf,
        openCardsPending: action.bot.openCardsPending,
        olderFrom: action.bot.olderFrom,
        // The snapshot decides whether this thread has scrollback; merging
        // would carry the previous thread's answer onto this one.
        hasMore: action.bot.hasMore,
        awaitingThreadSnapshot: false,
        deletedThreadId: undefined,
        pendingThreadEvents: undefined,
        messagesUnloaded: undefined,
        pageStale: undefined,
        firstPageEvents: undefined,
        ...extraTasksPatch(bot, action.bot, { keepViewed: false }),
      }));
      return pending.reduce(reducer, reconcileSnapshotQueues(switched, [action.bot]));
    }
    case "conversationFromCache": {
      const entry = action.entry;
      const held = state.bots.find((bot) => bot.id === action.botId);
      if (!held || !opensFromCache(held, entry)) return state;
      const opened = updateBot(bumpTranscriptGeneration(state, entry.threadId), held.id, (bot) => ({
        ...bot,
        threadId: entry.threadId,
        messages: entry.messages,
        hasMore: entry.hasMore,
        olderFrom: entry.olderFrom,
        activeLeafId: entry.activeLeafId,
        openCards: entry.openCards,
        openCardsLeaf: entry.openCardsLeaf,
        threadVersion: entry.version,
        awaitingThreadSnapshot: false,
        deletedThreadId: undefined,
        pendingThreadEvents: undefined,
        messagesUnloaded: undefined,
        pageStale: undefined,
        firstPageEvents: undefined,
        patchedSinceOpen: [],
      }));
      return reconcileSnapshotQueues(opened, [{ messages: entry.messages }]);
    }
    case "threadDeltaApplied": {
      const { threadDelta, messages: _messages, hasMore: _hasMore, ...answered } = action.bot;
      const admitted = admitRecord(state, action.bot, action);
      if (admitted.verdict === "drop") return admitted.state;
      state = admitted.state;
      const held = state.bots.find((bot) => bot.id === answered.id);
      // A later switch moved on: this answer describes a page no longer on screen. The same for a page asked for under an older
      // intent, or for the thread the server deleted (§2.6).
      if (!held || held.threadId !== answered.threadId || (state.pageIntent?.[held.id] ?? 0) !== action.intent || answered.threadId === held.deletedThreadId) {
        if (!held || admitted.verdict === "stale" || admitted.verdict === "same" || admitted.verdict === "legacy") return state;
        return stampAdmitted(applyHttpRecord(state, recordOnly(answered as BotAnnouncement)), held.id, answered as BotAnnouncement, admitted.verdict, admitted.verdict === "newer");
      }
      const incoming = recordUnderPage(held, answered as BotAnnouncement, admitted.verdict);
      // A live patch that landed since the cached paint is newer than a delta read before it.
      const patched = new Set(held.patchedSinceOpen ?? []);
      const deltaMessages = patched.size ? threadDelta.messages.filter((message) => !patched.has(message.id)) : threadDelta.messages;
      const merged = applyThreadDelta(held, deltaMessages);
      const reconciled = updateBot(state, held.id, (bot) => ({
        ...bot,
        ...incoming,
        patchedSinceOpen: undefined,
        messages: merged.messages,
        openCards: merged.openCards,
        activeLeafId: threadDelta.activeLeafId === undefined ? bot.activeLeafId : threadDelta.activeLeafId,
        hasMore: bot.hasMore,
        olderFrom: bot.olderFrom,
        openCardsLeaf: bot.openCardsLeaf,
        threadVersion: answered.threadVersion ?? bot.threadVersion,
        ...(threadDelta.messages.some((message) => message.kind === "options") ? { cardsRev: (bot.cardsRev ?? 0) + 1 } : {}),
      }));
      const stamped = admitted.verdict === "stale" ? reconciled : stampAdmitted(reconciled, held.id, answered as BotAnnouncement, admitted.verdict, admitted.verdict === "newer");
      return reconcileSnapshotQueues(stamped, [{ messages: deltaMessages }]);
    }
    case "newBot":
    case "duplicateBot":
    case "interrupt":
    case "createGroup":
    case "sendGroup":
    case "deleteGroup":
    case "interruptGroup":
    case "createRoutine":
    case "updateRoutine":
    case "deleteRoutine":
    case "runRoutine":
    case "stopDelegation":
    case "resendDelegation":
    case "dismissDelegation":
    case "cancelRoutineRun":
    case "markRoutineRunSeen":
    case "markAllRoutineRunsSeen":
    case "loadBranchHead":
      return state;
    case "ensureBotDetail":
      // A settling read is a verification (I-M): the keys are owed and the verification fetch, which reads the whole record,
      // settles them; a read that fails keeps them and is asked again. A plain detail read (no keys) is the provider's own fetch.
      if (!action.settled?.length || !state.bots.some((bot) => bot.id === action.botId)) return state;
      return markVerify(owing(state, action.botId, action.settled), action.botId);
  }
}

/** Newest screen frames whose pixels stay in memory per thread. */
const MAX_KEPT_SCREEN_FRAMES = 8;

export const initialState: AppState = {
  bots: [],
  groups: [],
  instances: [],
  engineNote: "",
  config: null,
  selectedId: "",
  activeView: "chat",
  routines: [],
  routineRuns: [],
  webhooks: [],
  webhookAttempts: [],
  webhookIngress: null,
  settingsOpen: false,
  pluginsOpen: false,
  computerOpen: false,
  inspectorOpen: false,
  workspacePane: initialWorkspacePaneState,
  appSettingsOpen: false,
  appSettingsSection: "general",
  appSettingsAnchor: null,
  screens: {},
  provisioning: {},
  computerControl: {},
  focusMessage: null,
  teamLibrary: { open: false },
  connected: false,
  signedOut: false,
  hydrated: false,
  error: null,
  deletionNote: null,
  owedRev: 0,
  mascotMotion: null,
  pendingQueued: {},
  consumedQueueIds: {},
  pendingDeletes: {},
  tombstones: {},
  lastSeen: {},
  verifyBots: {},
  pageIntent: {},
  pastEpochs: [],
  admitTick: 0,
  reconcileRequested: 0,
  loadingOlder: {},
  transcriptGeneration: {},
  cardsReady: {},
  cardsReadyAll: 0,
  cardsFulfilled: {},
};

// ── API client ─────────────────────────────────────────────────────────
export async function api(path: string, init?: RequestInit, busyTries: number = busyRetriesFor(init?.method)): Promise<any> {
  // Resolve the desktop proof before the first call rather than racing it.
  // Already known in the packaged app (the preload answered synchronously),
  // so this costs a microtask; in dev it is one loopback fetch, memoized.
  // It never rejects — a harness that withholds one leaves this renderer on
  // the scoped surface, which is a smaller app rather than a broken one.
  await ensureDesktopSurfaceSecret();
  // The send time every bot inside the answer carries (BOTADDED-DESIGN-V3 r6 §2.1): an answer is applied only within its life.
  const sentAt = answerClock.now();
  const res = await fetch(path, {
    ...init,
    cache: "no-store",
    // `init` is spread FIRST on purpose: spreading it last let any caller
    // that passed headers of its own silently drop both of these.
    headers: {
      "content-type": "application/json",
      // Transcript routes are scoped to a phone's view by default. This is
      // the desktop app talking to its own harness over loopback, so it says
      // so — without this the sidebar loses every hidden bot and every
      // bot-to-bot room on hydration.
      "x-murage-surface": "desktop",
      // This renderer holds open request cards beside a page it was sent
      // (server/task-delta.ts CARDS_BESIDE_*); an older one says nothing and is
      // sent every card inside its page.
      "x-murage-cards": "beside",
      // Saying it is not proving it. The harness believes the marker only
      // when this launch's secret rides along; without it every call above
      // is answered as though it came from a paired phone. Spread before
      // `init?.headers` for the same reason the marker is: a caller with
      // headers of its own must not be able to drop the proof.
      ...desktopSurfaceHeaders(),
      ...init?.headers,
    },
    // After the spreads, so a caller's `redirect: "follow"` cannot undo it: a followed
    // redirect would hand the launch secret to whatever it points at.
    redirect: "error",
  });
  const body = await res.json().catch(() => ({}));
  // Not proof on its own: a harness route answers 401 for a provider it
  // could not sign in to. The door's /session decides (lib/session-check.ts).
  if (res.status === 401) void checkSession();
  // The status rides along, the way `composer-attachments.ts` already does it.
  // Without it every failure looks alike to a caller, and the peripheral
  // retry loop cannot tell "the harness hiccuped" from "this surface is never
  // going to be allowed" — so it retried a deliberate 403 every 30 seconds
  // for as long as the phone had the tab open.
  // The body rides along too, for refusals that carry more than a sentence
  // (Skill Guard's 409 names its findings and the content they cover).
  // the Retry-After header, when the body does not say it (busyRetryDelayMs reads the body)
  if (res.status === 503 && body && typeof body === "object" && body.retryAfterSeconds === undefined) {
    const retryAfter = Number(res.headers?.get?.("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) body.retryAfterSeconds = retryAfter;
  }
  if (!res.ok) {
    const error = Object.assign(new Error(sendNoticeFromBody(body) ?? body.error ?? requestFailedSentence(res.status)), { status: res.status, body });
    // A delete or a settings write (PUT, PATCH: repeating one changes nothing a first run did not) that met the server's busy answer (503
    // DATABASE_BUSY) is repeated after its Retry-After, a few times, before the failure reaches the caller (send-delivery.ts busyRetriesFor).
    // Only that answer: any other 503 is a real failure and reaches the caller on the first try.
    if (busyTries > 1 && isDatabaseBusyAnswer(error)) {
      await new Promise<void>((resolve) => setTimeout(resolve, busyRetryDelayMs(error)));
      return api(path, init, busyTries - 1);
    }
    throw error;
  }
  tagAnswer(body, sentAt);
  return body;
}

export { requestFailedSentence };

export interface PeripheralSnapshotLoad<Key extends string = string> {
  key: Key;
  load: () => Promise<void>;
}

function normalizeSnapshotFailure(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** Statuses that mean "not on this surface", as opposed to "not right now".
 *
 * 403 is the surface gate refusing a phone a desktop-only route; 404 is the
 * same decision expressed by not mounting the route at all (see the
 * `requestSurface(...) !== "desktop"` pattern in `server/index.ts`). Both are
 * stable for the life of the session, so a retry is pure battery. */
const PERMANENTLY_REFUSED = new Set([403, 404]);

export function isPermanentlyRefused(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status;
  return typeof status === "number" && PERMANENTLY_REFUSED.has(status);
}

/** A refused SSE resume needs the chat transcript snapshot before its cursor
 * can be acknowledged. The other panels should refresh at the same boundary,
 * but a broken optional endpoint must not hold every chat frame hostage. */
export async function loadSnapshotBoundary<Key extends string>(
  loadChat: () => Promise<void>,
  peripherals: readonly PeripheralSnapshotLoad<Key>[],
  onPeripheralFailure: (part: PeripheralSnapshotLoad<Key>, error: Error) => void,
): Promise<boolean> {
  const [chat, ...settledPeripherals] = await Promise.allSettled([
    loadChat(),
    ...peripherals.map((part) => part.load()),
  ]);
  settledPeripherals.forEach((result, index) => {
    if (result.status === "rejected") {
      onPeripheralFailure(peripherals[index]!, normalizeSnapshotFailure(result.reason));
    }
  });
  return chat.status === "fulfilled";
}

/** Per-frame stream state lives in its OWN context: token frames update only
 * the components that read this hook (the chat's streaming tail), while every
 * useStore consumer — sidebar, mascots, pickers, the settled transcript —
 * keeps its render tree untouched during a stream. */
interface StreamState {
  /** in-flight assistant text per threadId */
  streaming: Record<string, string>;
  /** in-flight extended thinking per threadId (ephemeral) */
  reasoning: Record<string, string>;
  /** the running turn's agent plan per threadId (ephemeral, whole list) */
  plan: Record<string, AgentPlanEntry[]>;
  /** helpers (sub agents) of the running turn, and of settled turns (ephemeral) */
  helpers: HelperState;
}
const EMPTY_STREAM: StreamState = { streaming: {}, reasoning: {}, plan: {}, helpers: EMPTY_HELPERS };

/** The live plan cards after one runtime event. A plan update replaces the
 * thread's whole list, and an emptied plan removes the card; the end of the
 * turn removes it too. Any other event, or an update whose entries are not a
 * list, returns the same object so the caller can skip the re-render. */
export function agentPlansAfterEvent(
  plans: Record<string, AgentPlanEntry[]>,
  event: { type?: unknown; threadId?: unknown; entries?: unknown },
): Record<string, AgentPlanEntry[]> {
  if (typeof event.threadId !== "string") return plans;
  const threadId = event.threadId;
  if (event.type === "plan.updated") {
    const entries = normalizeAgentPlan(event.entries);
    if (!entries) return plans;
    if (entries.length) return { ...plans, [threadId]: entries };
  } else if (event.type !== "turn.completed") {
    return plans;
  }
  if (!(threadId in plans)) return plans;
  const { [threadId]: _dropped, ...rest } = plans;
  return rest;
}
const StreamContext = createContext<StreamState>(EMPTY_STREAM);
/** Just the helpers of the stream. Its identity does not change on a text or
 * reasoning frame, so the settled transcript, which only needs the helper runs,
 * is not re-rendered at the stream's frame rate. */
const HelpersContext = createContext<HelperState>(EMPTY_HELPERS);
export function useStreamHelpers(): HelperState {
  return useContext(HelpersContext);
}

export type PendingStreamDelta = { text: string; reasoning: string };

/**
 * Paint once per frame, but keep draining when a hidden renderer pauses rAF.
 * The 64 Ki UTF-16 limit applies only to pending deltas: accumulated output is
 * deliberately neither capped nor truncated.
 *
 * Adapted narrowly from OpenMausBot 31777c6c1e417d487e314fad3c1353f16c5264bd.
 */
/** About 30 flushes a second: each one re-renders every stream consumer. */
const STREAM_FLUSH_MS = 33;
export function createStreamDeltaBuffer(
  onFlush: (entries: Array<[string, PendingStreamDelta]>) => void,
) {
  const buffer = new Map<string, PendingStreamDelta>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let characters = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    cancel();
    if (!buffer.size) return;
    const entries = [...buffer];
    buffer.clear();
    characters = 0;
    onFlush(entries);
  };
  return {
    push(threadId: string, kind: string, delta: string) {
      if (kind !== "assistant_text" && kind !== "reasoning_text") return;
      const entry = buffer.get(threadId) ?? { text: "", reasoning: "" };
      if (kind === "assistant_text") entry.text += delta;
      else entry.reasoning += delta;
      buffer.set(threadId, entry);
      characters += delta.length;
      if (characters >= 64 * 1024) flush();
      else if (timer === undefined) timer = setTimeout(flush, STREAM_FLUSH_MS);
    },
    clear(threadId: string) {
      const entry = buffer.get(threadId);
      if (entry) characters -= entry.text.length + entry.reasoning.length;
      buffer.delete(threadId);
      if (!buffer.size) cancel();
    },
    /** Drop only the pending assistant text (a retried attempt's words);
     * reasoning stays. */
    clearText(threadId: string) {
      const entry = buffer.get(threadId);
      if (!entry) return;
      characters -= entry.text.length;
      entry.text = "";
      if (!entry.reasoning) buffer.delete(threadId);
      if (!buffer.size) cancel();
    },
    /** Drop only the pending reasoning (a discarded attempt's thoughts). */
    clearReasoning(threadId: string) {
      const entry = buffer.get(threadId);
      if (!entry) return;
      characters -= entry.reasoning.length;
      entry.reasoning = "";
      if (!entry.text) buffer.delete(threadId);
      if (!buffer.size) cancel();
    },
    flush,
    dispose() {
      cancel();
      buffer.clear();
      characters = 0;
    },
  };
}

export function useStreaming() {
  return useContext(StreamContext);
}

const StoreContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
  /** Commit any debounced profile edits before an operation reads the bot. */
  flushBotPatches: (botId: string) => Promise<void>;
  /** Re-fetch engine availability — after an install, without a restart. */
  refreshInstances: () => Promise<void>;
  /** Re-read the settings and the engines after a Flux key is saved, so the
   *  window does not keep its pre-key reading until a reload. */
  refreshAfterKey: () => Promise<void>;
} | null>(null);

/** The parts of the store that never change identity with the state: a
 * component that only dispatches reads these and is not re-rendered by every
 * dispatch (useStore() re-renders its caller on each state change). */
type StoreActions = Omit<NonNullable<React.ContextType<typeof StoreContext>>, "state">;
const ActionsContext = createContext<StoreActions | null>(null);


/** A verification fetch that got no answer is asked again after this pause, at most VERIFY_FAILURES_MAX times in a row. */
const VERIFY_RETRY_MS = 5_000;
const VERIFY_FAILURES_MAX = 12;

/** Ambiguous DELETE failures (no answer) tried before the Delete is given up and shown (§2.7 r6). */
export const DELETE_RETRY_MAX = 20;

function browserStorage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

/** Has setup finished on this machine (the server's `view.firstRun` is false)? Once true it stays true for this page.
 *  A non-owner device, a refusal or a failed read answers false: the Chief stays the landing, as before. */
let setupFinishedAnswer = false;
let setupAskedAt = 0;
const SETUP_ASK_GAP_MS = 60_000;
async function setupFinished(): Promise<boolean> {
  if (setupFinishedAnswer) return true;
  // Before setup is finished the question is asked at most once a minute, not on every selection change.
  if (Date.now() - setupAskedAt < SETUP_ASK_GAP_MS) return false;
  setupAskedAt = Date.now();
  try {
    // peek: only the question. The full read seats a Chief and drives setup.
    const view = await api("/api/setup?peek=1");
    setupFinishedAnswer = shouldRemember(typeof view?.firstRun === "boolean" ? view.firstRun : null);
  } catch { /* unknown: remember nothing */ }
  return setupFinishedAnswer;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  // One six-second clock for the error banner (state/chat-error.ts).
  useChatErrorClear(state.error, () => rawDispatch({ type: "error", message: null }));
  // Remember the open conversation, per workspace, once setup is finished (read back by the hydrate above).
  useEffect(() => {
    if (!state.hydrated || !state.selectedId) return;
    const id = state.selectedId;
    void setupFinished().then((finished) => {
      if (finished) writeLastConversation(browserStorage(), workspaceKey(homeMeta(document).homeId), id);
    });
  }, [state.hydrated, state.selectedId]);
  // The moment setup finishes, save the open conversation, so someone who never changes selection still resumes next launch.
  useEffect(() => {
    const onSetupView = (event: Event) => {
      const id = idToSaveOnSetupView((event as CustomEvent<{ firstRun?: unknown } | undefined>).detail, stateRef.current.hydrated === true, stateRef.current.selectedId);
      if (id === null) return;
      setupFinishedAnswer = true;
      writeLastConversation(browserStorage(), workspaceKey(homeMeta(document).homeId), id);
    };
    window.addEventListener(SETUP_VIEW_EVENT, onSetupView);
    return () => window.removeEventListener(SETUP_VIEW_EVENT, onSetupView);
  }, []);
  // The Delete runs live inside the dispatch closure; the stream handler reaches them through this.
  const deleteControl = useRef<{ kick: () => void; stop: (botId: string) => void }>({ kick: () => {}, stop: () => {} });
  // The live effect's hydrate, for a reducer that asks for the roster again (reconcileRequested).
  const reconcileRef = useRef<() => void>(() => {});
  const verifying = useRef(new Set<string>());
  const verifyFailures = useRef(new Map<string, number>());
  // The conversation cache loads after the first paint, in its own chunk.
  useEffect(() => { void loadConversationCache(); }, []);
  // Every owner send goes through one delivery: written to a persisted outbox
  // before the composer clears, shown as "Sending" until the server has a
  // receipt, retried with the same sendId, and given back to the person only
  // after a definitive refusal (see send-delivery.ts).
  const delivery = useMemo(
    () =>
      createSendDelivery({
        // Undrafted sends live in the outbox key; a composer draft's send lives in its draft record (lib/drafts.ts).
        outbox: createOutbox(
          (() => { try { return window.localStorage; } catch { return undefined; } })(),
          draftJournal,
        ),
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        post: (entry, signal) =>
          entry.kind === "group"
            ? api(`/api/groups/${entry.groupId}/messages`, {
                method: "POST",
                signal,
                body: JSON.stringify({
                  text: entry.text,
                  replyToId: entry.replyToId,
                  threadId: entry.threadId,
                  sendId: entry.sendId,
                  ...(entry.resend ? { resend: true, ...(entry.restoreGen ? { restoreGen: entry.restoreGen } : {}), ...(entry.stopGen ? { stopGen: entry.stopGen } : {}), ...(entry.actionId ? { actionId: entry.actionId } : {}) } : {}),
                  mode: entry.mode ?? "chat",
                  ...(entry.responderId ? { responderId: entry.responderId } : {}),
                }),
              })
            : threadWrites.ready(entry.threadId ?? "").then(() =>
                api(`/api/bots/${entry.botId}/messages`, {
                  method: "POST",
                  signal,
                  body: JSON.stringify({ text: entry.text, replyToId: entry.replyToId, threadId: entry.threadId, sendId: entry.sendId, ...(entry.resend ? { resend: true, ...(entry.restoreGen ? { restoreGen: entry.restoreGen } : {}), ...(entry.stopGen ? { stopGen: entry.stopGen } : {}), ...(entry.actionId ? { actionId: entry.actionId } : {}) } : {}) }),
                }),
              ),
        releaseRefused: (sendId) => {
          releaseRecoveredSend(sendId);
        },
        showSending: (entry) => rawDispatch({ type: "sendingStarted", threadId: entry.threadId, sendId: entry.sendId, text: entry.text }),
        settleSending: (entry) => rawDispatch({ type: "sendingSettled", threadId: entry.threadId, sendId: entry.sendId }),
        receipt: (entry, body) => {
          if (body?.message && typeof body.threadId === "string") {
            rawDispatch({ type: "messageAdded", threadId: body.threadId, message: body.message, ...seqEnvelope(body), origin: answerOrigin(body) });
          }
          if (body?.queued && typeof body.threadId === "string" && typeof body.queueId === "string") {
            rawDispatch({ type: "pendingQueued", threadId: body.threadId, queueId: body.queueId, text: entry.text });
          }
        },
        // A refusal the server meant for an undrafted send, with nobody waiting on it. A drafted send's words
        // never left its box (the record), so there is nothing to put back.
        recover: (_entry, error) => {
          raiseTransientError(rawDispatch, error instanceof Error ? error.message : requestFailedSentence(0));
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const deliveryRef = useRef(delivery);
  deliveryRef.current = delivery;
  // GET /api/sends/:threadId/:sendId: whether a pinned send arrived (lib/drafts.ts section 4a). Read only.
  useEffect(() => {
    setDraftSendLookup(async (threadId, sendId, signal) => {
      try {
        const body = await api(`/api/sends/${encodeURIComponent(threadId)}/${encodeURIComponent(sendId)}`, { signal }) as { status?: unknown };
        return sendLookupResult(body?.status);
      } catch (error) {
        if ((error as { status?: unknown } | null)?.status === 404) return "none";
        throw error;
      }
    });
    // A draft another tab deleted is written again only while its conversation is still listed here (lib/drafts.ts A2).
    setDraftOwnerCheck((draftId) => draftOwnerLive(stateRef.current, draftId));
    return () => { setDraftSendLookup(null); setDraftOwnerCheck(null); };
  }, []);
  // One recovery surface per send id: a refused chip (the server's durable copy) owns its words; the
  // restored draft, the retry list and the outbox entry for the same id give theirs up.
  const forgetSend = useCallback((sendId: string) => {
    deliveryRef.current.resolveRefused(sendId);
  }, []);
  useEffect(() => {
    const refused = new Set<string>();
    for (const entries of Object.values(state.pendingQueued)) for (const entry of entries) if (entry.refused && entry.sendId) refused.add(entry.sendId);
    noteRefusedChips(refused);
    for (const sendId of refused) deliveryRef.current.resolveRefused(sendId);
  }, [state.pendingQueued]);
  // A save the person asked for and did not get (lib/save-file.ts): the same
  // six-second error toast every other failed action shows.
  useEffect(() => onSaveFailed((message) => {
    raiseTransientError(rawDispatch, message);
  }), []);
  // per-frame stream-delta batching (see the "runtime" SSE case); stream
  // state is intentionally OUTSIDE the reducer so token frames re-render
  // only StreamContext consumers
  const [stream, setStream] = useState<StreamState>(EMPTY_STREAM);
  const deltaBuffer = useMemo(
    () =>
      createStreamDeltaBuffer((entries) => {
        setStream((prev) => {
          const streaming = { ...prev.streaming };
          const reasoning = { ...prev.reasoning };
          for (const [threadId, delta] of entries) {
            if (delta.text) streaming[threadId] = (streaming[threadId] ?? "") + delta.text;
            if (delta.reasoning) reasoning[threadId] = (reasoning[threadId] ?? "") + delta.reasoning;
          }
          return { ...prev, streaming, reasoning };
        });
      }),
    [],
  );
  const flushDeltas = deltaBuffer.flush;
  /** A retried attempt's streamed words go; reasoning and tool rows stay. */
  const resetStreamText = (threadId: string, kind: "assistant_text" | "reasoning_text" = "assistant_text") => {
    if (kind === "reasoning_text") {
      deltaBuffer.clearReasoning(threadId);
      setStream((prev) => {
        if (!(threadId in prev.reasoning)) return prev;
        const { [threadId]: _r, ...reasoning } = prev.reasoning;
        return { ...prev, reasoning };
      });
      return;
    }
    deltaBuffer.clearText(threadId);
    setStream((prev) => {
      if (!(threadId in prev.streaming)) return prev;
      const { [threadId]: _s, ...streaming } = prev.streaming;
      return { ...prev, streaming };
    });
  };
  const clearStream = (threadId: string) => {
    // Drop the thread's un-flushed deltas too: the settled message that
    // triggered this clear already contains them. Without this, the pending
    // rAF re-creates a "ghost" stream bubble holding the tail fragment —
    // it renders below any card/chip that settled next (so a permission
    // card looks glued to the top), keeps the caret blinking while the bot
    // is actually waiting, and the next block's deltas append onto the
    // duplicated tail instead of starting a fresh bubble.
    deltaBuffer.clear(threadId);
    setStream((prev) => {
      if (!(threadId in prev.streaming) && !(threadId in prev.reasoning)) return prev;
      const { [threadId]: _s, ...streaming } = prev.streaming;
      const { [threadId]: _r, ...reasoning } = prev.reasoning;
      return { ...prev, streaming, reasoning };
    });
  };
  /** Plans outlive the settled messages of their turn (clearStream runs on
   * each one), so they are updated and cleared on their own. */
  const updatePlans = (event: { type?: unknown; threadId?: unknown; entries?: unknown }) => {
    setStream((prev) => {
      const plan = agentPlansAfterEvent(prev.plan, event);
      return plan === prev.plan ? prev : { ...prev, plan };
    });
  };
  const updateHelpers = (event: { type?: unknown; threadId?: unknown; subtasks?: unknown }) => {
    setStream((prev) => {
      const helpers = helpersAfterEvent(prev.helpers, event);
      return helpers === prev.helpers ? prev : { ...prev, helpers };
    });
  };
  const botPatchQueue = useMemo(
    () =>
      createBotPatchQueue({
        // Cloud window: no retry queue. A failed write is rolled back and dropped, never re-sent after the home returns.
        failFast: isCloudOrigin(),
        send: async (botId, patch, signal) => {
          // `chiefTier` is the queue's name for a value the harness reads as
          // `chiefScope`; it is renamed here rather than shared, because the
          // wire accepts "section"/null to mean "drop the tier" and the bot
          // field only ever holds "workspace" or nothing.
          const { chiefTier, ...fields } = patch;
          const result: { bot: BotAnnouncement } = await api(`/api/bots/${botId}`, {
            method: "PATCH",
            body: JSON.stringify(chiefTier === undefined ? fields : { ...fields, chiefScope: chiefTier }),
            signal,
          });
          return result.bot;
        },
        reconcile: async (botId, signal) => {
          // The whole record (the detail route, numbered): its instructions are whole, where the roster's preview is cut, and a cut
          // copy must never settle an editable field. A 404 (deleted meanwhile) leaves the pre-edit copy.
          const result: { bot?: BotAnnouncement } = await api(`/api/bots/${encodeURIComponent(botId)}`, { signal });
          return result?.bot ?? null;
        },
        onAuthoritative: (bot, optimisticOverlay, settled) => {
          rawDispatch({ type: "botPatched", ...fromAnswer(bot), ...(settled ? { settled } : {}), bot, overlay: optimisticOverlay as Partial<BotAnnouncement> });
        },
        onError: (error, rejected) => {
          raiseTransientError(rawDispatch, fullAccessRefusalMessage(rejected, error) ?? error.message);
        },
      }),
    [],
  );

  useEffect(() => {
    // StrictMode's dev probe runs this cleanup once against the same memoized
    // queue; revive undoes it so profile saves survive development mounts.
    botPatchQueue.revive();
    return () => botPatchQueue.dispose();
  }, [botPatchQueue]);

  const threadWrites=useMemo(()=>new ThreadSettingsWrites(),[]);
  const dispatch = useMemo(() => {
    const showDeletionNote = (response: unknown) => {
      rawDispatch({ type: "deletionNote", note: deletionNote(response as Parameters<typeof deletionNote>[0]) });
    };
    const showError = (e: unknown) => {
      raiseTransientError(rawDispatch, e instanceof Error ? e.message : String(e));
    };
    // The save is still not awaited (the card updates at once), but a refusal
    // or a dropped connection is shown instead of swallowed.
    const persistCard = (botId: string, messageId: string, patch: Partial<OptionCardData>) => {
      persistCardPatch(botId, messageId, patch, desktopSurfaceHeaders()).catch(showError);
    };
    const saveThread=(botId:string,threadId:string,patch:object)=>threadWrites.write(threadId,async()=>{
      const sending=stateRef.current.bots.find(bot=>bot.id===botId);const sentSeq=sending?heldRecordSeq(sending):undefined;
      const result=await api(`/api/bots/${botId}/tasks/${threadId}`,{method:"PATCH",body:JSON.stringify(patch)});
      const bot=stateRef.current.bots.find(bot=>bot.id===botId);
      // The route's own bot (numbered) when it sends one; the task row's frame carries the change otherwise, and the answer's own row settles the saved fields below.
      if(result.bot)rawDispatch({type:"botPatched",...fromAnswer(result.bot),bot:result.bot});
      if(bot&&result.task){const outside=bot.extraTasks?.find(task=>task.threadId===threadId);if(outside)rawDispatch({type:"tasksFetched",owner:"bot",id:botId,tasks:[{...outside,...result.task}]});}
      // The settings this save decided, from the server's answer row, on the held row (an effort picked on a chat that follows its bot shows at once).
      if(bot&&result.task)rawDispatch({type:"threadSettingsSaved",botId,threadId,keys:Object.keys(patch),task:result.task,sentSeq});
    },async()=>{
      const result=await api("/api/bots?messages=0");
      const bot=result.bots?.find((bot:Bot)=>bot.id===botId);
      if(!bot)throw new Error("Thread settings could not be reconciled. Refresh before sending.");
      rawDispatch({type:"botPatched",...fromAnswer(bot),bot});
    });

    const scrollback = createScrollback({
      getState: () => stateRef.current,
      dispatch: rawDispatch,
      request: (path) => api(path),
      onError: showError,
    });

    // The latest task switch per bot: an answer to an earlier one is not applied.
    const switchSeq: Record<string, number> = {};

    // ── A bot Delete the person asked for (BOTADDED-DESIGN-V3 r6 §2.7) ──
    // Sent with its attempt id; an answer carrying the server's own JSON error is a refusal (shown, the bot fetched again); no answer
    // (network, abort, a body that is not the server's) is retried with the same attempt, said out loud after the third try and given
    // up after DELETE_RETRY_MAX. The stream's deletion frame for the id ends it at any point.
    type DeleteRun = { botId: string; attempt: string; name: string; archived: boolean; tries: number; inFlight: boolean; timer?: ReturnType<typeof setTimeout>; onSettled?: (result: DeleteOutcome) => void };
    const deleteRuns = new Map<string, DeleteRun>();
    const forgetBotDrafts = (botId: string) => {
      forgetDeletedDrafts({ botId });
      forgetDocumentDrafts({ botId });
    };
    const settleDelete = (run: DeleteRun, outcome: DeleteOutcome["outcome"], extra: { tasksSeq?: number; tasksEpoch?: string; error?: string } = {}) => {
      deleteRuns.delete(run.botId);
      if (run.timer) clearTimeout(run.timer);
      if (outcome === "deleted") forgetBotDrafts(run.botId);
      rawDispatch({ type: "deletionSettled", source: "http", botId: run.botId, attempt: run.attempt, outcome, ...extra });
      run.onSettled?.({ outcome, ...(extra.error ? { error: extra.error } : {}) });
    };
    const retryDelete = (run: DeleteRun) => {
      run.tries += 1;
      if (run.tries >= DELETE_RETRY_MAX) {
        const error = `${run.name} may not be deleted. Murage got no answer after ${run.tries} tries.`;
        settleDelete(run, "gaveUp", { error });
        if (!run.onSettled) rawDispatch({ type: "deletionNote", note: { title: error, items: ["Check that Murage is running, then try again."], retry: true, retryBotId: run.botId } });
        return;
      }
      if (run.tries === 3 && !run.onSettled) rawDispatch({ type: "deletionNote", note: { title: `Still deleting ${run.name}.`, items: ["Murage has not answered yet. It keeps trying."] } });
      run.timer = setTimeout(() => sendDelete(run), Math.min(30_000, 1_000 * 2 ** (run.tries - 1)));
    };
    const sendDelete = (run: DeleteRun) => {
      if (deleteRuns.get(run.botId) !== run || run.inFlight) return;
      if (run.timer) clearTimeout(run.timer);
      run.timer = undefined;
      run.inFlight = true;
      api(`/api/bots/${encodeURIComponent(run.botId)}${run.archived ? "?ifArchived=1" : ""}`, { method: "DELETE", headers: { "x-murage-attempt": run.attempt } })
        .then((body: { ok?: unknown; tasksSeq?: unknown; tasksEpoch?: unknown; warning?: unknown } | null) => {
          run.inFlight = false;
          if (deleteRuns.get(run.botId) !== run) return;
          if (body?.ok !== true) return retryDelete(run);
          settleDelete(run, "deleted", {
            ...(typeof body.tasksSeq === "number" ? { tasksSeq: body.tasksSeq } : {}),
            ...(typeof body.tasksEpoch === "string" ? { tasksEpoch: body.tasksEpoch } : {}),
          });
          // the deletion happened; something after it did not finish
          if (typeof body.warning === "string" && body.warning) rawDispatch({ type: "deletionNote", note: { title: `${run.name} was deleted. Some cleanup did not finish:`, items: [body.warning] } });
          else showDeletionNote(body);
        }, (error: unknown) => {
          run.inFlight = false;
          if (deleteRuns.get(run.botId) !== run) return;
          const answered = error as { status?: unknown; body?: { error?: unknown; retryable?: unknown } } | null;
          // the server's own refusal; a busy database says it is worth another try
          if (typeof answered?.status === "number" && typeof answered.body?.error === "string" && answered.body.retryable !== true) {
            const text = error instanceof Error ? error.message : String(answered.body.error);
            settleDelete(run, "refused", { error: text });
            if (!run.onSettled) showError(error);
            return;
          }
          retryDelete(run);
        });
    };
    deleteControl.current = {
      kick: () => { for (const run of deleteRuns.values()) if (run.timer) sendDelete(run); },
      stop: (botId) => {
        const run = deleteRuns.get(botId);
        if (!run) return;
        deleteRuns.delete(botId);
        if (run.timer) clearTimeout(run.timer);
        forgetBotDrafts(botId);
        run.onSettled?.({ outcome: "deleted" });
      },
    };

    const wrapped: React.Dispatch<Action> = (action) => {
      if (pendingThreadActionBlocked(stateRef.current, action)) {
        const error = new Error("The replacement conversation is still loading. Wait for its transcript before sending or responding.");
        showError(error);
        if (action.type === "send") action.onError?.(error);
        else if (action.type === "decideRequest" || action.type === "answerQuestion" || action.type === "sendQuestionAsMessage") action.onError?.(error.message);
        return;
      }
      const botBeforeUpdate =
        action.type === "updateBot"
          ? stateRef.current.bots.find((candidate) => candidate.id === action.botId)
          : undefined;
      const quizBeforeSend = (() => {
        if (action.type !== "send") return undefined;
        const bot = stateRef.current.bots.find((candidate) => candidate.id === action.botId);
        return bot ? openOnboardingCard(bot) : undefined;
      })();
      if (action.type === "deleteBot") botPatchQueue.cancel(action.botId);
      const botBeforeDelete = action.type === "deleteBot" ? stateRef.current.bots.find((candidate) => candidate.id === action.botId) : undefined;
      // A queued message is still real until the server confirms deletion.
      // All other actions keep their existing optimistic behavior.
      // Read before the reducer drops the channel: its conversations are
      // what its document drafts are keyed by.
      const groupBeforeDelete =
        action.type === "deleteGroup" ? stateRef.current.groups.find((group) => group.id === action.groupId) : undefined;
      // Read before the optimistic patch lands: what a refused edit goes back to.
      const groupBeforePatch =
        action.type === "patchGroup" ? stateRef.current.groups.find((group) => group.id === action.groupId) : undefined;
      if (action.type !== "cancelQueued" && action.type !== "cancelGroupQueued") rawDispatch(action);
      switch (action.type) {
        case "createRoutine":
          api("/api/routines", { method: "POST", body: JSON.stringify(action.input) }).catch(showError);
          break;
        case "updateRoutine":
          api(`/api/routines/${action.routineId}`, {
            method: "PATCH",
            body: JSON.stringify(action.patch),
          }).catch(showError);
          break;
        case "deleteRoutine":
          api(`/api/routines/${action.routineId}`, { method: "DELETE" }).catch(showError);
          break;
        case "runRoutine":
          api(`/api/routines/${action.routineId}/run`, { method: "POST" }).catch(showError);
          break;
        case "stopDelegation":
          api(`/api/delegations/${action.delegationId}/stop`, { method: "POST" }).catch(showError);
          break;
        case "resendDelegation":
        case "dismissDelegation": {
          const verb = action.type === "resendDelegation" ? "send-again" : "dismiss";
          api(`/api/delegations/${action.delegationId}/${verb}`, { method: "POST", ...(action.threadId ? { body: JSON.stringify({ threadId: action.threadId }) } : {}) })
            .then(() => action.settled?.resolve())
            .catch((error) => { showError(error); action.settled?.reject(error); });
          break;
        }
        case "cancelRoutineRun":
          api(`/api/routine-runs/${action.runId}/cancel`, { method: "POST" }).catch(showError);
          break;
        case "markRoutineRunSeen":
          api(`/api/routine-runs/${action.runId}/seen`, { method: "POST" }).catch(showError);
          break;
        case "markAllRoutineRunsSeen":
          // The server re-emits every stamped run, which clears the dots here.
          api("/api/routine-runs/seen-all", { method: "POST" }).catch(showError);
          break;
        case "cancelQueued": {
          const dismissedSendId = queuedSendId(stateRef.current.pendingQueued, action.queueId);
          void api(`/api/bots/${action.botId}/queue/${action.queueId}`, { method: "DELETE" })
            .then(() => { rawDispatch(action); if (dismissedSendId) forgetSend(dismissedSendId); })
            .catch(showError);
          break;
        }
        case "cancelGroupQueued": {
          const dismissedSendId = queuedSendId(stateRef.current.pendingQueued, action.queueId);
          void api(`/api/groups/${action.groupId}/queue/${action.queueId}`, { method: "DELETE" })
            .then(() => {
              rawDispatch(action);
              if (dismissedSendId) forgetSend(dismissedSendId);
              action.onDone?.();
            })
            .catch((error) => {
              if (action.onError?.(error) !== true) showError(error);
            });
          break;
        }
        case "send": {
          // persist through the existing card route so an older server that
          // does not auto-dismiss still hides the quiz on this client
          if (quizBeforeSend) persistCard(action.botId, quizBeforeSend.id, { dismissed: true });
          const threadId =
            action.threadId ?? stateRef.current.bots.find((bot) => bot.id === action.botId)?.threadId;
          const sendId = action.sendId ?? newSendId();
          // The words are in the persisted outbox and on screen as a "Sending"
          // line before this handler returns (the composer clears right after),
          // whatever the busy flags say. They leave only on a receipt or a
          // refusal the server meant; a dropped connection keeps them and tries
          // again with the same sendId.
          if (threadId) {
            void deliveryRef.current.submit(
              {
                sendId,
                kind: "bot",
                botId: action.botId,
                threadId,
                text: action.text,
                ...(action.replyToId ? { replyToId: action.replyToId } : {}),
                ...(action.outboxDraft ? { draft: action.outboxDraft } : {}),
                ...(action.resend ? { resend: true as const, ...(action.restoreGen ? { restoreGen: action.restoreGen } : {}), ...(action.stopGen ? { stopGen: action.stopGen } : {}), ...(action.actionId ? { actionId: action.actionId } : {}) } : {}),
                at: Date.now(),
                attempts: 0,
              },
              {
                // The route answered, so the message is the server's problem
                // now. Said last, after the state it implies has been applied.
                onReceipt: () => action.onSent?.(),
                onFailed: (_entry, error) => {
                  if (action.onError?.(error) !== true) showError(error);
                  return true;
                },
              },
            );
          } else {
            // the same sendId on every repeat: a busy answer means the send did not run, and a repeat that did is deduplicated
            retryWhileBusy(() => api(`/api/bots/${action.botId}/messages`, {
              method: "POST",
              body: JSON.stringify({ text: action.text, replyToId: action.replyToId, threadId, sendId }),
            })).then(() => action.onSent?.()).catch((error) => {
              if (action.onError?.(error) !== true) showError(error);
            });
          }
          break;
        }
        case "editMessage": {
          const threadId = action.threadId ?? stateRef.current.bots.find((bot) => bot.id === action.botId)?.threadId;
          // one sendId for every repeat: the server answers a repeat of an edit it already forked with that fork, so a busy answer is repeated safely
          // within a deadline (EDIT_DEADLINE_MS); `signal` is the editor's Cancel while it saves
          void deliverEdit((sendId, signal) => api(`/api/bots/${action.botId}/messages/${action.messageId}/edit`, {
            method: "POST",
            body: JSON.stringify({ text: action.text, threadId, sendId }),
            signal,
          }), { sendId: action.sendId ?? newSendId(), onSent: action.onSent, onFailed: (error) => { action.onError?.(error); showError(error); } }, { signal: action.signal });
          break;
        }
        case "switchBranch":
          api(`/api/bots/${action.botId}/active-branch`, {
            method: "POST",
            body: JSON.stringify({ messageId: action.messageId,threadId:action.threadId??stateRef.current.bots.find(bot=>bot.id===action.botId)?.threadId }),
          }).catch(showError);
          break;
        case "respondWidget": {
          api(`/api/threads/${action.threadId}/widgets/${action.widgetId}/respond`, {
            method: "POST",
            body: JSON.stringify({ ref: action.ref, rev: action.rev ?? 0, values: action.values ?? {}, ...(action.other ? { other: action.other } : {}) }),
          }).then((body) => {
            // the owner's message the press became: its line or its place in line, as a send's receipt
            if (body?.message && typeof body.threadId === "string") {
              rawDispatch({ type: "messageAdded", threadId: body.threadId, message: body.message, ...seqEnvelope(body), origin: answerOrigin(body) });
            }
            if (body?.queued && typeof body.threadId === "string" && typeof body.queueId === "string" && typeof body.text === "string") {
              rawDispatch({ type: "pendingQueued", threadId: body.threadId, queueId: body.queueId, text: body.text });
            }
            action.onSuccess?.();
          }).catch((error) => {
            const reply = error && typeof error === "object" ? (error as { body?: { code?: unknown } }).body : undefined;
            const code = typeof reply?.code === "string" ? reply.code : undefined;
            action.onError?.(error instanceof Error ? error.message : String(error), code);
          });
          break;
        }
        case "reopenWidget": {
          api(`/api/threads/${action.threadId}/widgets/${action.widgetId}/reopen`, { method: "POST", body: "{}" }).then((body) => {
            if (body?.message) rawDispatch({ type: "messageAdded", threadId: action.threadId, message: body.message });
          }).catch((error) => {
            showError(error);
            action.onError?.(error instanceof Error ? error.message : String(error));
          });
          break;
        }
        case "decideRequest": {
          const answer = {
            requestId: action.requestId,
            behavior: action.behavior,
            message: action.message,
            reviewedSha256: action.reviewedSha256,
            ...(action.allowForTask ? { allowForTask: true } : {}),
          };
          // SEC-006: an Allow from the phone may be met by a challenge; the
          // helper asks for Face ID and re-posts once. A deny or an answer is
          // never signed.
          const respond = () =>
            decideWithFreshAuth(
              (extra) => api(`/api/threads/${action.threadId}/respond`, { method: "POST", body: JSON.stringify({ ...answer, ...extra }) }),
              {
                threadId: action.threadId,
                requestId: action.requestId,
                decision: action.behavior === "allow" ? (action.allowForTask ? "allow-task" : "allow") : undefined,
                card: action.card,
                botName: action.botName,
                onDevicePrompt: action.onDevicePrompt,
              },
              { onError: action.onError, onSuccess: action.onSuccess, showError },
            );
          // AMEND-13 Rule 81b (A13 C1 amendment): a remembered choice is
          // checked and staged BEFORE the answer releases the bot (it may ask
          // again within milliseconds), by the server, in the same request,
          // and written once that answer has landed. A choice that cannot be
          // saved releases nothing: the card stays pending with the error,
          // never quietly Allow once. The one write after the answer reports
          // its own failure as such ("Allowed once. Always allow was not saved").
          if (action.alwaysAllowRoutine) {
            // Rules 81b, 81d: ONE request saves the whole set and answers this
            // card, from the desktop or the paired phone, through the same
            // fresh check an Allow gets. A refusal saves nothing and the card
            // stays pending with the error.
            const grant = action.alwaysAllowRoutine;
            void decideWithFreshAuth(
              async (extra) => {
                const body = await api(`/api/routines/${encodeURIComponent(grant.routineId)}/always-allow`, {
                  method: "POST",
                  body: JSON.stringify({
                    threadId: action.threadId, requestId: action.requestId, answer: true,
                    ...(grant.key ? { allowKey: grant.key } : {}),
                    ...(grant.stopKeys ? { stopKeys: grant.stopKeys } : {}),
                    ...extra,
                  }),
                });
                if (Array.isArray(body?.saved)) grant.onSaved?.(body.saved.filter((key: unknown): key is string => typeof key === "string"));
                return body;
              },
              { threadId: action.threadId, requestId: action.requestId, decision: "allow", card: action.card, botName: action.botName, onDevicePrompt: action.onDevicePrompt },
              { onError: action.onError, onSuccess: action.onSuccess, showError },
            );
            break;
          }
          if (action.alwaysAllow) {
            // Rule 81b (Astra a13 r1 item 5): ONE request saves the set and
            // answers this card, so another device cannot settle it in between
            // and leave the grant behind. Desktop only (the route's policy).
            const grant = action.alwaysAllow;
            void decideWithFreshAuth(
              (extra) => api(`/api/bots/${grant.botId}/always-allow`, {
                method: "POST",
                body: JSON.stringify({ ...(grant.keys ? { allowKeys: grant.keys } : { allowKey: grant.key }), threadId: action.threadId, requestId: action.requestId, answer: true, ...extra }),
              }),
              { threadId: action.threadId, requestId: action.requestId, decision: "allow", card: action.card, botName: action.botName, onDevicePrompt: action.onDevicePrompt },
              { onError: action.onError, onSuccess: action.onSuccess, showError },
            );
            break;
          }
          void respond();
          break;
        }
        case "answerQuestion": {
          api(`/api/threads/${action.threadId}/respond`, {
            method: "POST",
            body: JSON.stringify({
              requestId: action.requestId,
              behavior: action.behavior,
              ...(action.answers ? { answers: action.answers } : {}),
            }),
          }).then((body) => {
            // a question answered by the owner's next message (QW Q1): its line or its place in line, as a send's receipt
            if (body?.message && typeof body.threadId === "string") {
              rawDispatch({ type: "messageAdded", threadId: body.threadId, message: body.message, ...seqEnvelope(body), origin: answerOrigin(body) });
            }
            if (body?.queued && typeof body.threadId === "string" && typeof body.queueId === "string" && typeof body.text === "string") {
              rawDispatch({ type: "pendingQueued", threadId: body.threadId, queueId: body.queueId, text: body.text });
            }
          }).catch((error) => {
            showError(error);
            action.onError?.(error instanceof Error ? error.message : String(error));
          });
          break;
        }
        case "sendQuestionAsMessage": {
          // A room: send first, record second. A card is marked "sent" only once the
          // message really went out through the room's composer route.
          const fail = (error: unknown) => {
            showError(error);
            action.onError?.(error instanceof Error ? error.message : String(error));
          };
          if (!action.groupId && !action.botId) {
            fail(new Error("This conversation can no longer take a message."));
            break;
          }
          if (!action.groupId || action.answerAsSend) {
            // A direct conversation (QW Q1b), or a room's ask_user card: ONE request. The server records the card and the owner's message in one
            // transaction and queues the words; a second press or another device gets "already settled".
            void api(`/api/threads/${action.threadId}/respond`, {
              method: "POST",
              body: JSON.stringify({ requestId: action.requestId, behavior: "answer", answers: action.answers, sentAsMessage: true }),
            })
              .then((body) => {
                if (body?.message && typeof body.threadId === "string") {
                  rawDispatch({ type: "messageAdded", threadId: body.threadId, message: body.message, ...seqEnvelope(body), origin: answerOrigin(body) });
                }
                if (body?.queued && typeof body.threadId === "string" && typeof body.queueId === "string") {
                  rawDispatch({ type: "pendingQueued", threadId: body.threadId, queueId: body.queueId, text: typeof body.text === "string" ? body.text : action.text });
                }
              })
              .catch(fail);
            break;
          }
          const sendId = newSendId();
          const post = action.groupId
            ? () => api(`/api/groups/${action.groupId}/messages`, {
                method: "POST",
                body: JSON.stringify({ text: action.text, threadId: action.threadId, sendId, mode: "chat" }),
              })
            : () => threadWrites.ready(action.threadId).then(() => api(`/api/bots/${action.botId}/messages`, {
                method: "POST",
                body: JSON.stringify({ text: action.text, threadId: action.threadId, sendId }),
              }));
          void retryWhileBusy(post)
            .then((body) => {
              if (body?.message && typeof body.threadId === "string") {
                rawDispatch({ type: "messageAdded", threadId: body.threadId, message: body.message, ...seqEnvelope(body), origin: answerOrigin(body) });
              }
              if (body?.queued && typeof body.threadId === "string" && typeof body.queueId === "string") {
                rawDispatch({ type: "pendingQueued", threadId: body.threadId, queueId: body.queueId, text: action.text });
              }
              return api(`/api/threads/${action.threadId}/respond`, {
                method: "POST",
                body: JSON.stringify({ requestId: action.requestId, behavior: "answer", answers: action.answers, sentAsMessage: true }),
              });
            })
            .catch(fail);
          break;
        }
        case "answerCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            const behavior = card.skillRequest
              ? skillRequestBehavior(action.answer)
              : action.answer === "Allow" ? "allow" : action.answer === "Deny" ? "deny" : "answer";
            const requestId = card.requestId;
            const reviewedSha256 = behavior === "allow" && card.skillRequest ? reviewedSkillSha256(card.skillRequest) : undefined;
            // An Allow goes through fresh authentication like every other
            // phone Allow; a deny or an answer is posted as it always was.
            void decideWithFreshAuth(
              (extra) => api(`/api/bots/${action.botId}/respond`, {
                method: "POST",
                body: JSON.stringify({
                  requestId,
                  threadId: bot?.threadId,
                  behavior,
                  message: behavior === "answer" ? action.answer : undefined,
                  reviewedSha256,
                  ...extra,
                }),
              }),
              { threadId: bot?.threadId ?? "", requestId, decision: behavior === "allow" ? "allow" : undefined, card, botName: bot?.name },
              { showError },
            );
          } else {
            // Intake turns are answered BY INDEX on their own route
            // (IntakeTurn -> intakeChipAction), never by posting the chip's
            // label as chat. Two other places already keep an intake card
            // away from here — ChatView branches to IntakeTurn before
            // OptionCard renders, and `isOnboardingCard` narrows it out —
            // so this is the third. It is worth the two lines because the
            // failure it prevents is silent: a chip label posted to
            // /messages settles the conversation as "general" and discards
            // the answer, with no error on either side of the seam.
            if (card?.intake) break;
            persistCard(action.botId, action.messageId, { answered: action.answer, dismissed: true });
            api(`/api/bots/${action.botId}/messages`, {
              method: "POST",
              body: JSON.stringify({ text: action.answer }),
            }).catch(showError);
          }
          break;
        }
        case "dismissCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            // A question's X is an explicit skip the engine hears at once.
            // Sending "deny" to a question used to be refused, and the bot
            // then waited out its whole timeout (0.1.52 ASK2).
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify(
                isQuestionCard(card)
                  ? { requestId: card.requestId, threadId: bot?.threadId, behavior: "skip" }
                  : { requestId: card.requestId, threadId: bot?.threadId, behavior: "deny", message: "Dismissed by user." },
              ),
            }).catch(showError);
          } else {
            persistCard(action.botId, action.messageId, { dismissed: true });
          }
          break;
        }
        case "restoreCard":
          // Same route the dismissal wrote through, so the card is still there
          // after a reload rather than only until this window closes.
          persistCard(action.botId, action.messageId, { dismissed: false });
          break;
        case "newBot":
          api("/api/bots", { method: "POST" })
            .then(({ bot }) => rawDispatch({ type: "botAdded", ...fromAnswer(bot), bot }))
            .catch(showError);
          break;
        case "duplicateBot": {
          const source = stateRef.current.bots.find((b) => b.id === action.botId);
          if (!source) break;
          const duplicateProfile = {
            name: `${source.name} copy`,
            title: source.title,
            description: source.description,
            notifications: source.notifications,
            modelSelection: source.modelSelection,
            computer: source.computer,
            cloudBackend: source.cloudBackend,
            autoStartVps: source.autoStartVps,
            avatarUrl: source.avatarUrl,
            avatarCrop: source.avatarCrop,
            mascotBody: source.mascotBody ?? undefined,
          };
          // Two gated answers (V2 §2.3): the POST answer as served (record, transcript, head; selected), then the PATCH answer as a
          // record (no transcript, no selection). Each is admitted by its own number.
          api("/api/bots", { method: "POST" })
            .then(({ bot }) => {
              rawDispatch({ type: "botAdded", ...fromAnswer(bot), bot });
              return api(`/api/bots/${bot.id}`, {
                method: "PATCH",
                // JSON.stringify omits undefined optional fields while preserving
                // an explicit null avatar clear, so duplication mirrors the source.
                body: JSON.stringify(duplicateProfile),
              }).then(({ bot: patched }) => rawDispatch({ type: "botPatched", ...fromAnswer(patched), bot: carryAnswerTag(patched, recordOnly(patched)) }));
            })
            .catch(showError);
          break;
        }
        case "deleteBot": {
          conversationCache()?.dropOwner(action.botId);
          // drafts go at the click, as before (Linux re-test 3): a refused Delete keeps the bot, never its unsent words on disk.
          // An archived bot's Delete (the archive list) is conditional (`ifArchived`): another client may have restored it, and a
          // 409 then hands the bot back, so its drafts go only once the deletion is confirmed (settleDelete "deleted", or the
          // stream's deletion frame), never on refused or gaveUp (astra-botint H3).
          if (action.archived !== true) forgetBotDrafts(action.botId);
          const previous = deleteRuns.get(action.botId);
          if (previous?.timer) clearTimeout(previous.timer);
          const run: DeleteRun = { botId: action.botId, attempt: action.attempt, name: botBeforeDelete?.name || "This bot", archived: action.archived === true, tries: 0, inFlight: false, onSettled: action.onSettled };
          deleteRuns.set(action.botId, run);
          sendDelete(run);
          break;
        }
        case "markUnread":
          api(`/api/bots/${action.botId}/read`, { method: "POST", body: JSON.stringify({ unread: true,threadId:stateRef.current.bots.find(bot=>bot.id===action.botId)?.threadId }) }).catch(showError);
          break;
        case "select": {
          const bot = stateRef.current.bots.find((b) => b.id === action.id);
          const group = stateRef.current.groups.find((g) => g.id === action.id);
          if (bot?.unread) {
            api(`/api/bots/${action.id}/read`, { method: "POST",body:JSON.stringify({threadId:action.threadId??bot.threadId}) }).catch(() => {});
          } else if (group?.unread) {
            api(`/api/groups/${action.id}/read`, { method: "POST" }).catch(() => {});
          }
          break;
        }
        case "createGroup":
          api(`/api/groups`, {
            method: "POST",
            body: JSON.stringify({
              memberIds: action.memberIds,
              name: action.name,
              section: action.section,
              // Instructions given at creation also finish setup: the person
              // has just said what this channel is for, so asking them again
              // on the first screen would be asking twice. Without them the
              // channel opens on its setup card exactly as before.
              ...(action.bulletin?.trim()
                ? {
                    setup: {
                      bulletin: action.bulletin,
                      defaultResponder: { kind: "member", botId: action.memberIds[0] },
                    },
                  }
                : {}),
              ...(action.channelProject ? { channelProject: action.channelProject } : {}),
            }),
          })
            .then(({ group }) => {
              rawDispatch({ type: "groupPatched", origin: fromAnswer(group), group });
              rawDispatch({ type: "select", id: group.id });
            })
            .catch(showError);
          break;
        case "sendGroup": {
          const threadId =
            action.threadId ?? stateRef.current.groups.find((group) => group.id === action.groupId)?.threadId;
          const sendId = action.sendId ?? newSendId();
          // Same promise as a 1:1 send: outbox first, "Sending" line at once,
          // a receipt or a meant refusal to leave.
          if (threadId) {
            void deliveryRef.current.submit(
              {
                sendId,
                kind: "group",
                groupId: action.groupId,
                threadId,
                text: action.text,
                ...(action.replyToId ? { replyToId: action.replyToId } : {}),
                mode: action.mode ?? "chat",
                ...(action.responderId ? { responderId: action.responderId } : {}),
                ...(action.outboxDraft ? { draft: action.outboxDraft } : {}),
                ...(action.resend ? { resend: true as const, ...(action.restoreGen ? { restoreGen: action.restoreGen } : {}), ...(action.stopGen ? { stopGen: action.stopGen } : {}), ...(action.actionId ? { actionId: action.actionId } : {}) } : {}),
                at: Date.now(),
                attempts: 0,
              },
              {
                onReceipt: (_entry, body) => {
                  action.onReceipt?.({
                    sendId,
                    queued: body?.queued === true,
                    ...(typeof body?.queueId === "string" ? { requestId: body.queueId } : typeof body?.message?.requestId === "string" ? { requestId: body.message.requestId } : {}),
                  });
                },
                onFailed: (_entry, error) => {
                  if (action.onError?.(error) !== true) showError(error);
                  return true;
                },
              },
            );
          }
          break;
        }
        case "patchGroup":
          api(`/api/groups/${action.groupId}`, {
            method: "PATCH",
            body: JSON.stringify(action.patch),
          })
            .then((result: any) => {
              // Only the two fields the reducer cannot compute for itself are
              // taken from the reply. The rest of the record is left alone on
              // purpose — a group frame carries a `messages` key, and folding
              // a whole one in here would replace the transcript on screen
              // with whatever the PATCH reply happened to hold.
              if (!result?.group) return;
              rawDispatch({
                type: "groupPatched",
                origin: fromAnswer(result.group),
                group: {
                  ...hiddenPatchFrom(action.groupId, result.group),
                  channelProject: result.group.channelProject ?? undefined,
                },
              });
            })
            .catch((error: unknown) => {
              if (groupBeforePatch) {
                const { channelProject: _serverOwned, ...sent } = action.patch;
                const fields: Record<string, unknown> = {};
                for (const key of Object.keys(sent).filter((name) => name !== "hidden")) fields[key] = (groupBeforePatch as unknown as Record<string, unknown>)[key];
                rawDispatch({ type: "groupPatchReverted", groupId: action.groupId, fields: fields as Partial<Group> });
              }
              showError(error);
            });
          break;
        case "deleteGroup":
          forgetDeletedDrafts({ groupId: action.groupId });
          forgetProjectTab(action.groupId);
          if (groupBeforeDelete) forgetDocumentDrafts({ threadIds: [groupBeforeDelete.threadId, ...(groupBeforeDelete.tasks ?? []).map((task) => task.threadId)] });
          api(`/api/groups/${action.groupId}`, { method: "DELETE" })
            .then((answer: any) => {
              showDeletionNote(answer);
              // the answer carries the deletion's own number (ROOM-ORDER-DESIGN §1): it orders against the frames and answers about this room
              rawDispatch({ type: "groupDeleted", origin: fromAnswer(answer), groupId: action.groupId, recordSeq: answer?.recordSeq, recordEpoch: answer?.recordEpoch });
            })
            // the room is not in the server's registry or ledger: the roster says what is left (r2 §2.3, DELETE 404)
            .catch((error: unknown) => { if ((error as { status?: unknown } | null)?.status === 404) reconcileRef.current(); else showError(error); });
          break;
        case "setModel":
          if(action.threadId){void saveThread(action.botId,action.threadId,{modelSelection:action.selection}).catch(showError);break;}
          api(`/api/bots/${action.botId}`, {
            method: "PATCH",
            body: JSON.stringify({ modelSelection: action.selection,settingsScope:"defaults" }),
          }).catch(showError);
          break;
        case "interrupt":
          api(`/api/bots/${action.botId}/interrupt`, { method: "POST",body:JSON.stringify({threadId:action.threadId??stateRef.current.bots.find(bot=>bot.id===action.botId)?.threadId}) }).catch(showError);
          break;
        // tasks: the server answers with the bot AND the live transcript,
        // because switching changes which conversation is on screen
        case "newTask": {
          const leaving = stateRef.current.bots.find((candidate) => candidate.id === action.botId);
          // never an unloaded thread, nor rows that predate a rehydrate: the cache holds only pages this client fetched and kept current
          if (leaving && !leaving.awaitingThreadSnapshot && !leaving.messagesUnloaded && !leaving.pageStale && !leaving.firstPageEvents) conversationCache()?.put(cachedPage(leaving));
          const intent = requestPage(rawDispatch, stateRef.current, action.botId);
          api(`/api/bots/${action.botId}/tasks`, { method: "POST", body: action.cwd ? JSON.stringify({ cwd: action.cwd }) : "{}" })
            .then((r: any) => r?.bot && dispatch({ type: "taskSwitched", ...fromAnswer(r.bot), bot: r.bot, intent }))
            .catch(showError);
          break;
        }
        // A switch answers with the newest page and `hasMore` (upstream
        // #1527); older messages page back through /api/threads/:id/messages.
        // A task opened recently paints from the conversation cache at once,
        // and the same request then asks only for what changed since that
        // page (`since=`) and lays it over; with no cached page, or when the
        // server cannot say what changed, the answer is the whole page.
        case "switchTask": {
          const cache = conversationCache();
          const leaving = stateRef.current.bots.find((candidate) => candidate.id === action.botId);
          if (cache && leaving && leaving.threadId !== action.threadId && !leaving.awaitingThreadSnapshot && !leaving.messagesUnloaded && !leaving.pageStale && !leaving.firstPageEvents) cache.put(cachedPage(leaving));
          // Only a page the reducer will open is sent as `since=`; a delta for
          // a page that is not on screen would have nothing to lay over.
          const opened = cachedPaintFor(cache, leaving, action.threadId, streamProof.live);
          const seq = (switchSeq[action.botId] ?? 0) + 1;
          switchSeq[action.botId] = seq;
          const intent = requestPage(rawDispatch, stateRef.current, action.botId);
          if (opened) rawDispatch({ type: "conversationFromCache", botId: action.botId, entry: opened });
          const since = opened?.version ? `&since=${encodeURIComponent(opened.version)}` : "";
          api(`/api/bots/${action.botId}/tasks/${action.threadId}?messages=${MESSAGE_PAGE_SIZE}${since}`, { method: "POST" })
            .then((r: any) => {
              if (!r?.bot) return;
              // A later switch owns the screen; this answer is for a page it left.
              if (switchSeq[action.botId] === seq) {
                if (r.bot.threadDelta) rawDispatch({ type: "threadDeltaApplied", ...fromAnswer(r.bot), bot: r.bot, intent });
                else dispatch({ type: "taskSwitched", ...fromAnswer(r.bot), bot: r.bot, intent });
              }
              void api(`/api/bots/${action.botId}/read`,{method:"POST",body:JSON.stringify({threadId:action.threadId})}).catch(showError);
            })
            .catch((error: unknown) => {
              // The switch did not happen: the conversation that was on screen comes back.
              const back = leaving && cache?.peek(leaving.threadId);
              if (opened && back && switchSeq[action.botId] === seq) rawDispatch({ type: "conversationFromCache", botId: action.botId, entry: back });
              showError(error);
            });
          break;
        }
        case "pinTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ pinned: action.pinned }),
          }).catch(showError);
          break;
        case "renameTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: action.title }),
          }).catch(showError);
          break;
        case "deleteTask":
          forgetDeletedDrafts({ threadId: action.threadId });
          conversationCache()?.drop(action.threadId);
          forgetDocumentDrafts({ threadIds: [action.threadId] });
          {
            // A page change of its own: an earlier switch's answer no longer lands. Its own answer is adopted by the thread rule (the
            // record already moved to it and waits for its snapshot), not by intent: the server's deletion frame, which precedes this
            // answer, is the server's own intent and moves it.
            const intent = requestPage(rawDispatch, stateRef.current, action.botId);
            api(`/api/bots/${action.botId}/tasks/${action.threadId}`, { method: "DELETE" })
              .then((r: any) => {
                showDeletionNote(r);
                const current = stateRef.current.bots.find(bot => bot.id === action.botId);
                if (r?.bot && current && (current.threadId === action.threadId || current.awaitingThreadSnapshot)) {
                  dispatch({ type: "botPatched", ...fromAnswer(r.bot), bot: r.bot, intent });
                }
              })
              .catch((e: unknown) => showError(new Error(deletionErrorSentence(e))));
          }
          break;
        // Channel tasks mirror bot tasks, but hydrate the whole channel so
        // switching atomically replaces its transcript, folder and pin.
        case "newGroupTask":
          api(`/api/groups/${action.groupId}/tasks`, { method: "POST", body: "{}" })
            .then((r: any) => r?.group && dispatch({ type: "groupPatched", origin: fromAnswer(r.group), group: r.group }))
            .catch(showError);
          break;
        case "switchGroupTask":
          api(`/api/groups/${action.groupId}/tasks/${action.threadId}?messages=${MESSAGE_PAGE_SIZE}`, { method: "POST" })
            .then((r: any) => r?.group && dispatch({ type: "groupPatched", origin: fromAnswer(r.group), group: r.group }))
            .catch(showError);
          break;
        case "renameGroupTask":
          api(`/api/groups/${action.groupId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: action.title }),
          }).catch(showError);
          break;
        case "deleteGroupTask":
          forgetDeletedDrafts({ threadId: action.threadId });
          forgetDocumentDrafts({ threadIds: [action.threadId] });
          api(`/api/groups/${action.groupId}/tasks/${action.threadId}`, { method: "DELETE" })
            .then((r: any) => {
              showDeletionNote(r);
              // the answer states the deletion with the room (numbered); the thread leaves whatever the window, extras included (r3 R6)
              if (r?.group) dispatch({ type: "groupPatched", origin: fromAnswer(r.group), group: r.group, removedTaskIds: Array.isArray(r.removedTaskIds) ? r.removedTaskIds : [action.threadId] });
            })
            .catch((e: unknown) => showError(new Error(deletionErrorSentence(e))));
          break;
        case "interruptGroup":
          api(`/api/groups/${action.groupId}/interrupt`, action.queueIds?.length
            ? { method: "POST", body: JSON.stringify({ queueIds: action.queueIds }) }
            : { method: "POST" }).catch(showError);
          break;
        case "updateTask":
          void saveThread(action.botId,action.threadId,action.patch).catch((error: unknown) => showError(fullAccessRefusalMessage(action.patch, error) ?? error));
          break;
        case "updateBot": {
          if (botBeforeUpdate) {
            botPatchQueue.enqueue(action.botId, action.patch, botBeforeUpdate);
          }
          break;
        }
        case "loadOlderMessages":
          void scrollback.loadOlder(action.threadId);
          break;
        case "loadFirstPage":
          void scrollback.loadFirstPage(action.threadId);
          break;
        case "loadBranchHead":
          void scrollback.loadThrough(action.threadId, action.messageId);
          break;
        // The roster carries a cut description; the whole record arrives as a bot frame would, with any edit still in flight laid over it.
        // A read with keys to settle is the verification fetch's (reducer, I-M): it retries, and settles every key the bot is owed.
        case "ensureBotDetail":
          if (action.settled?.length) break;
          void api(`/api/bots/${action.botId}`).then((result: { bot?: BotAnnouncement }) => {
            // the authoritative current record (§9.3)
            if (result?.bot) rawDispatch({ type: "botPatched", ...fromAnswer(result.bot), verified: true, bot: result.bot, overlay: botPatchQueue.overlayFor(result.bot.id) as Partial<BotAnnouncement> });
          }).catch(() => {});
          break;
        // A jump to a message older than the held page: walk back until it is
        // held, then focus again, so the views that ignored a target they
        // could not find open a window around it now.
        case "focusMessage": {
          const { threadId, messageId, maxPages } = action;
          void scrollback.loadThrough(threadId, messageId, maxPages).then((outcome) => {
            if (outcome === "fetched") rawDispatch({ type: "focusMessage", threadId, messageId });
          });
          break;
        }
        default:
          break;
      }
    };
    return wrapped;
  }, [botPatchQueue,threadWrites]);

  // The boot roster holds no rows (view=sidebar): the conversation on screen fetches its first page right away, whenever it is selected or
  // switched to (needsFirstPage). The fetch runs once per (thread, transcript generation) so a dead link does not loop; a failed fetch
  // leaves the conversation unloaded and is asked again after a growing wait (createFirstPageTopUp, r5), the failure itself shown by
  // scrollback's onError; opening the thread again, or the window coming back into view or online, asks at once.
  const onScreen =
    state.bots.find((candidate) => candidate.id === state.selectedId) ??
    state.groups.find((candidate) => candidate.id === state.selectedId);
  const topUpThread = onScreen && needsFirstPage(onScreen) ? onScreen.threadId : null;
  const topUpGeneration = topUpThread ? state.transcriptGeneration[topUpThread] ?? 0 : 0;
  const topUpBusy = Boolean(onScreen?.firstPageEvents);
  const screenThread = onScreen?.threadId ?? "";
  const [freshRetry, setFreshRetry] = useState(0);
  // the newest wrapped dispatch, so the one planner made on the first render never asks through a stale one
  const topUpDispatch = useRef(dispatch);
  topUpDispatch.current = dispatch;
  const topUp = useRef(createFirstPageTopUp({
    ask: (threadId) => topUpDispatch.current({ type: "loadFirstPage", threadId }),
    later: (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); },
  }));
  useEffect(() => {
    topUp.current.forget();
  }, [screenThread]);
  useEffect(() => () => topUp.current.forget(), []);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const again = () => {
      if (document.visibilityState === "hidden") return;
      topUp.current.forget();
      setFreshRetry((n) => n + 1);
    };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("online", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("online", again);
    };
  }, []);
  useEffect(() => {
    topUp.current.review(topUpThread, topUpGeneration, topUpBusy, () => setFreshRetry((n) => n + 1));
  }, [topUpThread, topUpGeneration, topUpBusy, freshRetry, screenThread, dispatch]);

  // The selected branch head is older than every held row (another window
  // moved it, or a fork outgrew it): fetch back to it, once per head and
  // transcript generation, instead of showing another branch's rows.
  const headBot = onScreen && "activeLeafId" in onScreen && branchHeadMissing(onScreen as Bot) ? (onScreen as Bot) : null;
  const headThread = headBot?.threadId ?? "", headLeaf = headBot?.activeLeafId ?? "";
  const headGeneration = headThread ? state.transcriptGeneration[headThread] ?? 0 : 0;
  const fetchedHead = useRef("");
  useEffect(() => {
    const key = `${headThread}:${headGeneration}:${headLeaf}`;
    if (!headLeaf || fetchedHead.current === key) return;
    fetchedHead.current = key;
    dispatch({ type: "loadBranchHead", threadId: headThread, messageId: headLeaf });
  }, [headThread, headGeneration, headLeaf, dispatch]);

  // The branch on screen moved off the head the held open cards were worked
  // out for (an edit, a switch to a sibling): they belong to the branch it
  // left, so the ones on this branch are fetched, once per head.
  const cardsBot = onScreen && "activeLeafId" in onScreen ? (onScreen as Bot) : null;
  const cardsLeaf = cardsBot?.activeLeafId && cardsBot.openCardsLeaf && cardsBot.openCardsLeaf !== cardsBot.activeLeafId && !visibleMessages(cardsBot).some((m) => m.id === cardsBot.openCardsLeaf) ? cardsBot.activeLeafId : "";
  const cardsThread = cardsBot?.threadId ?? "";
  const cardsRev = cardsBot?.cardsRev ?? 0;
  const fetchedCards = useRef("");
  useEffect(() => {
    const key = `${cardsThread}:${cardsLeaf}:${cardsRev}`;
    if (!cardsLeaf || fetchedCards.current === key) return;
    fetchedCards.current = key;
    void api(`/api/threads/${encodeURIComponent(cardsThread)}/open-cards`)
      .then((result: { activeLeafId?: string; openCards?: Message[]; pending?: boolean }) => dispatch({ type: "openCardsRefreshed", threadId: cardsThread, leafId: result.activeLeafId ?? cardsLeaf, cards: result.openCards ?? [], rev: cardsRev, pending: result.pending === true }))
      .catch(() => {});
  }, [cardsThread, cardsLeaf, cardsRev, dispatch]);

  // The server said this conversation's open cards became exact (open-cards.ready): ask again, once per frame, for a bot task or a room alike. The notice
  // is kept per conversation (a task opened later still finds it), and an answer fulfils it only for the transcript generation it was asked under.
  // A branch that moved meanwhile makes the answer stale, and the reducer drops it by head and revision like any other refresh.
  const readyOwner = onScreen ?? null;
  const readyThread = readyOwner?.threadId ?? "";
  const readyRev = readyThread ? readyRevOf(state, readyThread) : 0;
  const readyBot = state.bots.find((candidate) => candidate.threadId === readyThread);
  const readyIsBot = Boolean(readyBot);
  const readyLeaf = readyBot?.activeLeafId ?? "";
  const readyCardsRev = (readyOwner as { cardsRev?: number } | null)?.cardsRev ?? 0;
  const fetchedReady = useRef("");
  const readyNeeded = cardsFetchNeeded(state, readyOwner);
  const readyGeneration = readyThread ? state.transcriptGeneration[readyThread] ?? 0 : 0;
  // A readiness fetch that failed (or was answered for another branch head) is asked again after a growing wait (1 s, 2 s, 4 s ... at most 30 s, eight times), never in a tight loop.
  const [readyRetry, setReadyRetry] = useState(0);
  const readyFailures = useRef(0);
  const readyBase = useRef("");
  const readyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (readyTimer.current) clearTimeout(readyTimer.current); }, []);
  useEffect(() => {
    // one request per (thread, transcript generation, leaf, readiness revision, card revision, retry): a head that moved asks again for its own leaf
    const base = `${readyThread}:${readyGeneration}:${readyLeaf}:${readyRev}:${readyCardsRev}`;
    // a new thread, generation, head or revision starts its own count of retries: the eight are per question, not per session
    if (readyBase.current !== base) { readyBase.current = base; readyFailures.current = 0; }
    const key = `${base}:${readyRetry}`;
    if (!readyNeeded || !readyThread || (readyIsBot && !readyLeaf) || fetchedReady.current === key) return;
    fetchedReady.current = key;
    const askAgain = () => {
      const attempt = ++readyFailures.current;
      if (attempt > 8) return;
      if (readyTimer.current) clearTimeout(readyTimer.current);
      readyTimer.current = setTimeout(() => setReadyRetry((n) => n + 1), Math.min(30_000, 1000 * 2 ** (attempt - 1)));
    };
    void api(`/api/threads/${encodeURIComponent(readyThread)}/open-cards`)
      .then((result: { activeLeafId?: string; openCards?: Message[]; pending?: boolean }) => {
        dispatch({ type: "openCardsRefreshed", threadId: readyThread, leafId: result.activeLeafId ?? readyLeaf, cards: result.openCards ?? [], rev: readyCardsRev, pending: result.pending === true, readyRev, gen: readyGeneration, ...(readyIsBot ? { requestLeaf: readyLeaf } : {}) });
        // answered for a branch head other than the one held: the reducer discards it, so it is asked for again (bounded), not forgotten
        if (readyIsBot && result.activeLeafId !== undefined && result.activeLeafId !== readyLeaf) askAgain(); else readyFailures.current = 0;
      })
      .catch(askAgain);
  }, [readyThread, readyGeneration, readyRev, readyLeaf, readyNeeded, readyCardsRev, readyRetry, readyIsBot, dispatch]);

  // A task delta that did not fit the held list (tasksStale): refetch the
  // bots' task lists once, a moment later, so a burst of frames is one read.
  const staleTasks = state.bots.filter((bot) => bot.tasksStale).map((bot) => bot.id).join(",");
  useEffect(() => {
    if (!staleTasks) return;
    const timer = setTimeout(() => {
      void api("/api/bots?messages=0").then((result: { bots?: Bot[] }) => {
        for (const id of staleTasks.split(",")) {
          const fresh = result.bots?.find((bot) => bot.id === id);
          if (fresh?.tasks) dispatch({ type: "tasksResynced", ...fromAnswer(fresh), botId: id, tasks: fresh.tasks, tasksSeq: fresh.tasksSeq, tasksEpoch: fresh.tasksEpoch, tasksTotal: fresh.tasksTotal, tasksOlder: fresh.tasksOlder, usageTotal: fresh.usageTotal, grantsAll: fresh.grantsAll });
        }
      }).catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [staleTasks, dispatch]);

  // ── Bot admission upkeep (BOTADDED-DESIGN-V3 r6 §2.3 step 6, §2.7) ──
  // An input asked for the roster again (an expired answer, an unfamiliar server run): one hydrate, deduplicated by hydrate() itself.
  const reconcileAsked = state.reconcileRequested ?? 0;
  useEffect(() => { if (reconcileAsked) reconcileRef.current(); }, [reconcileAsked]);
  // Tombstones, last-seen numbers and past runs retire on a one-minute sweep.
  useEffect(() => {
    const timer = setInterval(() => rawDispatch({ type: "tombstonesSweep", now: answerClock.now() }), 60_000);
    return () => clearInterval(timer);
  }, []);
  // Each id to verify is fetched once: its record is the authoritative current state; a 404 means it is gone.
  const verifyIds = Object.keys(state.verifyBots ?? {}).join(",");
  const verifyAgainIds = Object.keys(state.verifyAgain ?? {}).join(",");
  const [verifyRound, setVerifyRound] = useState(0);
  useEffect(() => {
    for (const id of verifyIds ? verifyIds.split(",") : []) {
      if (verifying.current.has(id)) continue;
      verifying.current.add(id);
      const sentTick = stateRef.current.admitTick ?? 0;
      void api(`/api/bots/${encodeURIComponent(id)}`)
        .then((result: { bot?: BotAnnouncement }) => {
          const settled = stateRef.current.settleOnVerify?.[id];
          if (result?.bot) rawDispatch({ type: "botPatched", ...fromAnswer(result.bot), verified: true, ...(settled ? { settled } : {}), bot: result.bot, overlay: botPatchQueue.overlayFor(result.bot.id) as Partial<BotAnnouncement> });
          rawDispatch({ type: "verifySettled", botId: id, gone: false });
          verifyFailures.current.delete(id);
          return 0;
        }, (error: unknown) => {
          const gone = (error as { status?: unknown } | null)?.status === 404;
          const failures = (verifyFailures.current.get(id) ?? 0) + 1;
          verifyFailures.current.set(id, failures);
          const giveUp = !gone && failures >= VERIFY_FAILURES_MAX;
          if (gone || giveUp) verifyFailures.current.delete(id);
          rawDispatch({ type: "verifySettled", botId: id, gone, sentTick, ...(giveUp ? { giveUp: true as const } : {}) });
          // asked again after a pause, never in a tight loop while the server is unreachable
          return gone || giveUp ? 0 : VERIFY_RETRY_MS;
        })
        .then((pause) => setTimeout(() => { verifying.current.delete(id); setVerifyRound((round) => round + 1); }, pause));
    }
  }, [verifyIds, verifyAgainIds, verifyRound, botPatchQueue]);

  // ── initial load + SSE fold ──────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    // Asked once for the life of this effect: the stream and the hydrate
    // below must agree about what kind of client this is.
    const phone = isPhoneClient();
    type PeripheralKey = "instances" | "config" | "routines" | "webhooks";
    type PeripheralPart = {
      key: PeripheralKey;
      request: () => Promise<() => void>;
    };
    type PeripheralRefresh = {
      attempt: number;
      generation: number;
      timer: ReturnType<typeof setTimeout> | null;
      version: number;
    };
    const peripheralRefresh = new Map<PeripheralKey, PeripheralRefresh>();
    const refreshState = (key: PeripheralKey) => {
      let current = peripheralRefresh.get(key);
      if (!current) {
        current = { attempt: 0, generation: 0, timer: null, version: 0 };
        peripheralRefresh.set(key, current);
      }
      return current;
    };
    const peripheralParts: PeripheralPart[] = [
      {
        key: "instances",
        request: async () => {
          const { instances, shellEnvironment, engineNote } = await api("/api/instances");
          return () => rawDispatch({ type: "instances", instances, shellEnvironment: shellEnvironment ?? null, engineNote });
        },
      },
      {
        key: "config",
        request: async () => {
          const config = await api("/api/config");
          return () => rawDispatch({ type: "configStatus", config });
        },
      },
      {
        key: "routines",
        request: async () => {
          const { routines, runs } = await api("/api/routines");
          return () => rawDispatch({ type: "routinesHydrated", routines, runs });
        },
      },
      {
        key: "webhooks",
        request: async () => {
          const { webhooks, attempts, ingress } = await api("/api/webhooks");
          return () =>
            rawDispatch({ type: "webhooksHydrated", webhooks, attempts: attempts ?? [], ingress });
        },
      },
    ];
    const partByKey = new Map(peripheralParts.map((part) => [part.key, part]));
    const schedulePeripheralRetry = (part: PeripheralPart, error?: Error) => {
      if (!alive) return;
      const refresh = refreshState(part.key);
      if (refresh.timer) return;
      // A surface gate is a decision, not an outage. Routes the harness keeps
      // for the desktop answer 403 (or 404, when the route is not mounted on
      // this surface at all) and will answer the same way forever — retrying
      // cannot change the reply, it just wakes a phone's radio every 30
      // seconds until the tab closes. Give up on this panel and say so once.
      //
      // 401 is deliberately NOT in this set: a browser session can be renewed,
      // so that one really is worth another attempt.
      if (isPermanentlyRefused(error)) {
        console.warn(`snapshot: ${part.key} is not available on this surface; not retrying`, error);
        return;
      }
      if (sessionSignedOut()) return; // as permanent as a surface gate for this page
      if (error !== undefined) {
        console.warn(`snapshot: ${part.key} refresh failed; retrying`, error);
      }
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(refresh.attempt, 5));
      refresh.attempt += 1;
      refresh.timer = setTimeout(() => {
        refresh.timer = null;
        void loadPeripheral(part, true).catch((nextError) => schedulePeripheralRetry(part, nextError));
      }, delay);
    };
    const loadPeripheral = async (part: PeripheralPart, protectLiveFrames: boolean): Promise<void> => {
      const refresh = refreshState(part.key);
      if (refresh.timer) {
        clearTimeout(refresh.timer);
        refresh.timer = null;
      }
      const generation = ++refresh.generation;
      const version = refresh.version;
      try {
        const apply = await part.request();
        if (!alive || refresh.generation !== generation) return;
        // A background retry must never replace a live patch that arrived
        // after its request began. Discard that stale response and try again
        // from the newer event boundary instead.
        if (protectLiveFrames && refresh.version !== version) {
          schedulePeripheralRetry(part);
          return;
        }
        apply();
        refresh.attempt = 0;
      } catch (error) {
        // A newer refresh owns this lane now; its result will decide whether
        // another retry is needed.
        if (!alive || refresh.generation !== generation) return;
        throw normalizeSnapshotFailure(error);
      }
    };
    const bumpPeripheralVersion = (...keys: PeripheralKey[]) => {
      for (const key of keys) refreshState(key).version += 1;
    };
    const loadAll = async (): Promise<boolean> => {
      // §2.8 r6: membership is decided against the order of admission read when the roster is asked for, and a roster asked for
      // under an older live-events generation is ignored (another hydrate follows).
      const sentTick = stateRef.current.admitTick ?? 0;
      const askedUnder = liveGen;
      const chat = () =>
        // The fleet with one sidebar line per conversation and no transcript rows (1.0.2, desktop and phone alike): the boot page does not grow
        // with history, and the conversation on screen fetches its first page at once (scrollback loadFirstPage).
        api(`/api/bots?view=sidebar`).then((answer) => {
          const { bots, groups, computerControl, sidebarSectionOrder, pendingSends, tasksEpoch, removed, removedGroups, roomClock } = answer;
          if (!alive) return;
          if (askedUnder !== liveGen) { rehydrateRequested = true; return; }
          // A saved id means setup was finished when it was saved (it is only ever written then), so the read does not wait on the
          // server: launch is no slower. A person who quit mid first run has no saved id and lands on the Chief.
          const resumeId = readLastConversation(browserStorage(), workspaceKey(homeMeta(document).homeId));
          // A fresh snapshot: frames may have been missed, so nothing cached is trusted.
          conversationCache()?.clear();
          rawDispatch({ type: "clientScope", scoped: phone || !Object.keys(desktopSurfaceHeaders()).length });
          rawDispatch({
            type: "hydrate",
            ...fromAnswer(answer),
            ...(typeof tasksEpoch === "string" ? { tasksEpoch, removed: Array.isArray(removed) ? removed : [], removedGroups: Array.isArray(removedGroups) ? removedGroups : [], ...(typeof roomClock === "number" ? { roomClock } : {}) } : {}),
            sentTick,
            liveGen: askedUnder,
            ...(resumeId ? { resumeId } : {}),
            bots,
            groups: groups ?? [],
            computerControl: computerControl ?? {},
            // null = the computer has none yet; absent = an older harness.
            sidebarSectionOrder: sidebarSectionOrder === null ? null : (parseSidebarOrder(sidebarSectionOrder) ?? undefined),
            ...(pendingSends && typeof pendingSends === "object" ? { pendingSends } : {}),
          });
          // Sends still in this device's outbox (a reload or a restart in the
          // middle of one): the server's receipt settles them, the rest go again
          // under the same sendId.
          // The send that was the newest line of its conversation (the "sent, then reloaded" case) is on the line; anything older relies on
          // the server's at-most-once receipt by sendId, as it did with the old three-row page.
          const messageSendIds = new Set<string>();
          for (const conversation of [...(bots ?? []), ...(groups ?? [])] as Array<{ sidebarLine?: SidebarLine; messages?: Message[] }>) {
            if (typeof conversation.sidebarLine?.sendId === "string") messageSendIds.add(conversation.sidebarLine.sendId);
            for (const message of conversation.messages ?? []) if (typeof message.sendId === "string") messageSendIds.add(message.sendId);
          }
          const pendingSendIds = new Set<string>();
          for (const list of Object.values((pendingSends ?? {}) as Record<string, ServerPendingSend[]>)) {
            for (const entry of list) if ((entry.state === "queued" || entry.state === "refused") && entry.sendId) pendingSendIds.add(entry.sendId);
          }
          // The draft records first: a 1.0.4 draft becomes its record, and every failed send whose words are still
          // in the box is looked up (the late-ack check after a reload); then the outbox and the records reconcile.
          void migrateLegacyDrafts().catch(() => undefined).then(() => {
            void checkPinnedDrafts().catch(() => undefined);
            deliveryRef.current.reconcile({ messageSendIds, pendingSendIds });
          });
        });
      const peripherals = peripheralParts.map((part) => ({
        key: part.key,
        load: () => loadPeripheral(part, false),
      }));
      const chatReady = await loadSnapshotBoundary(chat, peripherals, (failed, error) => {
        const part = partByKey.get(failed.key);
        if (part) schedulePeripheralRetry(part, error);
      });
      return alive && chatReady;
    };

    // A snapshot and the live fold have to meet at a defined boundary. Start
    // hydration only after the stream says hello, queue frames that arrive
    // while the REST snapshot is in flight, then apply them on top. Otherwise
    // a late hydrate can overwrite a newer event, or an event can land between
    // an eager request and the stream opening and disappear entirely.
    let hydrated = false;
    let hydrationPromise: Promise<boolean> | null = null;
    let rehydrateRequested = false;
    // Bumped by every non-resumable hello (§9.4 r6 L1): a frame buffered under an older generation is never drained over a newer snapshot.
    let liveGen = 0;
    const pendingFrames: Array<{ frame: any; replayed: boolean; liveGen: number }> = [];
    let handleFrame: (frame: any, replayed?: boolean) => void;
    // What is still owed for deleted conversations is asked for on every connect and reconnect: a notice raised while this
    // window was closed or disconnected is never broadcast again, and one that was settled meanwhile must go.
    const refreshOwed = () => {
      void api("/api/deletions/owed").then((response) => { if (alive) rawDispatch({ type: "deletionOwed", notices: response?.notices, rev: response?.rev }); }).catch(() => {});
    };
    const hydrate = (): Promise<boolean> => {
      if (hydrationPromise) {
        // A second non-resumable hello means this snapshot may have started
        // before another connection gap. Run one more after it settles.
        rehydrateRequested = true;
        return hydrationPromise;
      }
      hydrated = false;
      hydrationPromise = (async () => {
        let loaded = false;
        do {
          rehydrateRequested = false;
          loaded = await loadAll();
        } while (alive && rehydrateRequested);
        if (!alive || !loaded) return false;
        hydrated = true;
        refreshOwed();
        for (const pending of pendingFrames.splice(0)) if (pending.liveGen === liveGen) handleFrame(pending.frame, pending.replayed);
        rawDispatch({ type: "streamDrained" });
        return true;
      })().finally(() => {
        hydrationPromise = null;
      });
      return hydrationPromise;
    };
    // If SSE is unavailable, the app should still show its saved state. A
    // later first hello hydrates again because it cannot prove there was no
    // gap before that connection opened.
    const hydrationFallback = setTimeout(hydrate, 1_000);
    reconcileRef.current = () => { void hydrate(); };

    // The hydrate decision belongs to the hello frame, not to onopen: the
    // server replays what we missed when it can, and re-downloading every
    // transcript on a reconnect it already covered is pure waste.
    handleFrame = (frame, replayed = false) => {
      if (frame.kind === "inbox.changed") { emitInboxChanged(frame.pollScale); return; }
      // A memory the bot just kept (B5m): the open chat attaches its chip under the reply it came from.
      if (frame.kind === "learning.remembered" || frame.kind === "learning.improved") { window.dispatchEvent(new CustomEvent(REMEMBERED_EVENT, { detail: frame })); return; }
      // How many memories wait for the owner (counts only): the shared counts, the badge and the Memory screen move at once.
      if (frame.kind === "memory.waiting") { window.dispatchEvent(new CustomEvent(MEMORY_WAITING_EVENT, { detail: frame })); return; }
      if (frame.kind === "project.strip" || frame.kind === "project.board" || frame.kind === "room.requests") {
        projectEvents.frame(frame as ProjectFrame);
        return;
      }
      if (frame.kind === "config") bumpPeripheralVersion("config", "instances");
      else if (frame.kind === "routine" || frame.kind === "routine.deleted" || frame.kind === "routine.run" || frame.kind === "routine.run.deleted") {
        bumpPeripheralVersion("routines");
      } else if (
        frame.kind === "webhook" ||
        frame.kind === "webhook.attempt" ||
        frame.kind === "webhook.deleted"
      ) {
        bumpPeripheralVersion("webhooks");
      }
      switch (frame.kind) {
        case "open-cards.ready": {
          // threadId null is the global completion: every thread still waiting for its older cards asks again
          if (typeof frame.threadId === "string") rawDispatch({ type: "openCardsReady", threadId: frame.threadId });
          else if (frame.threadId === null || frame.threadId === undefined) rawDispatch({ type: "openCardsReady", threadId: null });
          break;
        }
        case "sends": {
          if (typeof frame.threadId === "string" && Array.isArray(frame.pending)) {
            rawDispatch({ type: "serverSends", threadId: frame.threadId, pending: frame.pending });
          }
          break;
        }
        case "message": {
          conversationCache()?.applyFrame(frame);
          rawDispatch({ type: "messageAdded", threadId: frame.threadId, message: frame.message, ...seqEnvelope(frame) });
          if (frame.message?.role === "user" && typeof frame.message.sendId === "string") {
            rawDispatch({ type: "sendingSettled", threadId: frame.threadId, sendId: frame.message.sendId });
            // The server committed this send: ack(s) on whichever draft record still holds it.
            void settleDraftSend(undefined, frame.message.sendId, undefined, "acked").catch(() => undefined);
          }
          if (frame.message?.role === "user" && typeof frame.message.queueId === "string") {
            rawDispatch({
              type: "consumePendingQueued",
              threadId: frame.threadId,
              queueId: frame.message.queueId,
            });
          }
          // a settled assistant bubble replaces the in-flight stream
          if (frame.message?.role === "bot" && frame.message?.kind === "text") {
            clearStream(frame.threadId);
            // Auto-speak lives HERE rather than in the chat view so a bot
            // you switched away from still reads its answer out — which is
            // the whole point of listening while you do something else. A
            // Auto-speak is disabled during any call. Call mode owns both the
            // singleton speaker and microphone ordering for its whole lifetime.
            const owner = stateRef.current.bots.find((b) => b.threadId === frame.threadId);
            if (owner?.speakReplies && currentCall() === null && frame.message.text?.trim()) {
              void speaker.speak(frame.message.text, {
                botId: owner.id,
                messageId: frame.message.id,
                voiceId: owner.voice,
              });
            }
          }
          break;
        }
        case "message.patch":
          conversationCache()?.applyFrame(frame);
          rawDispatch({ type: "messagePatched", threadId: frame.threadId, message: frame.message, ...seqEnvelope(frame) });
          break;
        case "thread":
          conversationCache()?.applyFrame(frame);
          rawDispatch({ type: "threadActive", threadId: frame.threadId, activeLeafId: frame.activeLeafId, ...(frame.sidebarLine && typeof frame.sidebarLine === "object" ? { sidebarLine: frame.sidebarLine as SidebarLine } : {}) });
          // a rewind also invalidates any half-streamed text from the old branch
          clearStream(frame.threadId);
          updatePlans({ type: "turn.completed", threadId: frame.threadId });
          break;
        case "bot": {
          let bot = frame.bot as BotAnnouncement;
          // reading the selected chat clears its badge immediately
          const viewed=stateRef.current.bots.find(current=>current.id===bot.id);
          const viewedThread=viewed?.threadId;
          // A frame that flips busy or unread carries only the task rows that
          // changed. The reducer lays them over the rows it holds then; this
          // reads the changed rows only, to decide about the badge.
          const rows=bot.tasks??bot.tasksDelta?.upsert;
          const selectedUnread=rows?.find(task=>task.threadId===viewedThread)?.unread??(bot.threadId===viewedThread&&bot.unread);
          if (selectedUnread && viewedThread && bot.id === stateRef.current.selectedId && stateRef.current.activeView==="chat") {
            if (bot.tasksDelta) bot={...bot,tasksDelta:{...bot.tasksDelta,read:viewedThread}};
            else {
              const tasks=bot.tasks?.map(task=>task.threadId===viewedThread?{...task,unread:false}:task);
              bot={...bot,tasks,unread:tasks?.some(task=>task.unread)??false};
            }
            void api(`/api/bots/${bot.id}/read`, { method: "POST",body:JSON.stringify({threadId:viewedThread}) }).catch(() => {});
          }
          rawDispatch({
            type: "botPatched",
            source: "stream",
            bot,
            overlay: botPatchQueue.overlayFor(bot.id) as Partial<BotAnnouncement>,
          });
          break;
        }
        case "group": {
          const group = frame.group as Partial<Group> & { id: string };
          // reading the selected room clears its badge immediately
          if (group.unread && group.id === stateRef.current.selectedId) {
            group.unread = false;
            void api(`/api/groups/${group.id}/read`, { method: "POST" }).catch(() => {});
          }
          rawDispatch({ type: "groupPatched", origin: { source: "stream" }, group });
          break;
        }
        // engine copies of deleted conversations that are still owed (fixed sentences from the server, no paths): shown in the
        // same note a Delete uses, with "Try again now"
        case "deletion-owed": {
          rawDispatch({ type: "deletionOwed", notices: frame.notices, rev: frame.rev });
          break;
        }
        // the harness decided this was worth interrupting for; the toggle
        // in each bot's settings is what gates it, server-side
        case "notify":
          if (frame.notification?.kind === "approval" && replayed) break;
          // the wrapped dispatch, not rawDispatch: `select` clears the badge
          // in local state either way, but only the wrapper PATCHes
          // unread:false back. Opening a bot from its own notification and
          // watching the badge return on the next hydration is exactly the
          // bug that makes notifications feel broken.
          showNotification(
            frame.notification,
            (target) => openNotificationTarget(dispatch, target, stateRef.current),
            stateRef.current.bots.find((bot) => bot.id === frame.notification.botId)?.avatarUrl,
            visibleNotificationThread(stateRef.current),
          );
          break;
        case "group.deleted":
          rawDispatch({
            type: "groupDeleted",
            origin: { source: "stream" },
            groupId: frame.groupId,
            recordSeq: frame.recordSeq,
            recordEpoch: frame.recordEpoch,
            // a hide sent to a scoped stream (`audience: "remote"`), else a real deletion
            ...(frame.audience === "remote" ? { hidden: true as const } : {}),
          });
          break;
        case "routine":
          rawDispatch({ type: "routinePatched", routine: frame.routine });
          break;
        case "routine.deleted":
          rawDispatch({ type: "routineDeleted", routineId: frame.routineId });
          break;
        case "routine.run":
          rawDispatch({ type: "routineRunPatched", run: frame.run });
          break;
        case "routine.run.deleted":
          rawDispatch({ type: "routineRunDeleted", runId: frame.runId });
          break;
        case "webhook":
          rawDispatch({ type: "webhookPatched", webhook: frame.webhook });
          break;
        case "webhook.attempt":
          rawDispatch({ type: "webhookAttempted", attempt: frame.attempt });
          break;
        case "webhook.deleted":
          rawDispatch({ type: "webhookDeleted", webhookId: frame.webhookId });
          break;
        case "runtime": {
          const event = frame.event;
          // Whether the thread's turn has ended keeps the mascot for the whole turn (turn-status.ts).
          noteTurnEvent(event);
          if (event.type === "content.delta") {
            // Batch token deltas per animation frame (t3code-style): a fast
            // stream dispatches once per frame instead of once per token, so
            // the app tree re-renders at most ~60x/s while streaming.
            deltaBuffer.push(event.threadId, event.streamKind, event.delta);
          } else if (event.type === "content.reset") {
            resetStreamText(event.threadId, event.streamKind);
          } else if (event.type === "plan.updated") {
            updatePlans(event);
          } else if (event.type === "turn.subtask" || event.type === "turn.started" || event.type === "session.exited") {
            updateHelpers(event);
          } else if (event.type === "turn.completed") {
            // flush any buffered tail before clearing so no tokens are lost
            flushDeltas();
            clearStream(event.threadId);
            updatePlans(event);
            updateHelpers(event);
            // a turn that met an unproven large set has asked for its check: the memory strip looks again (it says "Checking earlier memory" while it runs)
            requestMemoryWake("TURN");
          }
          break;
        }
        case "screen":
          rawDispatch({ type: "screenFrame", botId: frame.botId, png: frame.png, mime: frame.mime ?? "image/png" });
          break;
        case "screen.unavailable":
          if (typeof frame.botId === "string" && typeof frame.message === "string") {
            rawDispatch({ type: "screenUnavailable", botId: frame.botId, message: frame.message.slice(0, 512) });
          }
          break;
        case "computer":
          rawDispatch({ type: "provisioning", botId: frame.botId, on: frame.state === "provisioning" });
          break;
        case "sidebar.order": {
          const order = parseSidebarOrder(frame.order);
          if (order) rawDispatch({ type: "sidebarSectionOrder", order });
          break;
        }
        case "computer-control":
          rawDispatch({
            type: "computerControl",
            botId: frame.botId,
            held: frame.held === true,
            helpReason: typeof frame.helpReason === "string" ? frame.helpReason : null,
          });
          break;
        case "bot.deleted": {
          conversationCache()?.dropOwner(frame.botId);
          botPatchQueue.cancel(frame.botId);
          // `audience: "remote"` is a hide (archived elsewhere), sent only to scoped streams: the bot can be restored. A real deletion
          // ends a Delete of this client still being retried.
          const hidden = frame.audience === "remote";
          if (!hidden) deleteControl.current.stop(frame.botId);
          rawDispatch({
            type: "botDeleted",
            source: "stream",
            botId: frame.botId,
            hidden,
            ...(typeof frame.tasksSeq === "number" && typeof frame.tasksEpoch === "string" ? { tasksSeq: frame.tasksSeq, tasksEpoch: frame.tasksEpoch } : {}),
          });
          break;
        }
        // a key changed and the fleet hot-reloaded — refresh the picker so
        // newly available providers un-dim immediately
        case "config":
          rawDispatch({
            type: "configStatus",
            config: configStatusFromFrame(frame),
          });
          {
            const instances = partByKey.get("instances");
            if (instances) {
              void loadPeripheral(instances, true).catch((error) =>
                schedulePeripheralRetry(instances, error),
              );
            }
          }
          break;
      }
    };
    // The stream opens only once this renderer can prove it is the desktop.
    // EventSource cannot set a header, so the proof has to be in the URL at
    // construction time — an EventSource opened a moment early would hold a
    // scoped stream for its whole life and quietly miss every hidden bot.
    // In the packaged app the preload already answered and this resolves on
    // the first microtask; in dev it is one loopback fetch.
    let stopLive: (() => void) | null = null;
    let liveClosed = false;
    void ensureDesktopSurfaceSecret().then(() => {
      if (!alive || liveClosed) return;
      rawDispatch({ type: "clientScope", scoped: phone || !Object.keys(desktopSurfaceHeaders()).length });
      // A phone never receives live computer frames: a base64 capture every
      // few seconds while a bot works is the heaviest thing on the stream.
      // Its computer panel polls instead (ComputerPanel, sseFlowing).
      stopLive = openLiveEvents({
        screens: phone ? false : undefined,
        taskDelta: true,
        cardsBeside: true,
        onOpen: () => { rawDispatch({ type: "connected", value: true }); requestMemoryWake("RECONNECT"); refreshOwed(); deleteControl.current.kick(); },
        onError: () => { streamProof.live = false; rawDispatch({ type: "connected", value: false }); },
        onHello: (resumed) => { streamProof.live = resumed; },
        onSnapshotRequired: () => {
          projectEvents.replayGap();
          clearTimeout(hydrationFallback);
          // Frames buffered before this non-resumable stream belong to an
          // abandoned generation. Keep the new generation behind hydrate().
          liveGen += 1;
          pendingFrames.splice(0);
          // a hydrate in flight was asked for under the old generation: it is ignored and run again (loadAll)
          return hydrate().then((loaded) => { if (loaded) streamProof.live = true; return loaded; });
        },
        onFrame: (frame, delivery) => {
          if (hydrated) handleFrame(frame, delivery?.replayed);
          else pendingFrames.push({ frame, replayed: delivery?.replayed === true, liveGen });
        },
        stillSignedIn: async () => (await checkSession()) !== "signed-out",
      });
    });
    const stopApprovalClicks = notificationBridge()?.approvalNotifications?.onOpen(target => {
      openNotificationTarget(dispatch, target, stateRef.current);
      // land on the card itself, not just its conversation
      if (typeof target.messageId === "string" && target.messageId) dispatch({ type: "focusMessage", threadId: target.threadId, messageId: target.messageId });
    });
    // Signed out: stop every loop that would keep knocking, and let the phone
    // app show its own re-pair screen. A browser gets SignedOutCard.
    const stopSignedOut = onSignedOut(() => {
      rawDispatch({ type: "signedOut" });
      liveClosed = true;
      stopLive?.();
      for (const refresh of peripheralRefresh.values()) {
        if (refresh.timer) clearTimeout(refresh.timer);
        refresh.timer = null;
      }
      void nativeAvailable("rePair")
        .then((available) => (available ? callNative("rePair") : undefined))
        .catch(() => {});
    });
    return () => {
      alive = false;
      liveClosed = true;
      deltaBuffer.dispose();
      clearTimeout(hydrationFallback);
      for (const refresh of peripheralRefresh.values()) {
        if (refresh.timer) clearTimeout(refresh.timer);
      }
      stopLive?.();
      stopApprovalClicks?.();
      stopSignedOut();
    };
  }, []);

  // Re-probe the engines on demand. A CLI installed while the app is running
  // is invisible until something asks again — the setup screens expose this
  // as "Check again" so the user isn't told to restart when a refresh will do.
  // Rejects when the probe fails (offline, server down): the existing list
  // stays, and a caller that just saved something can say the list may not
  // show it yet (EnginesSettings' Enable, ClaudeAccountsSettings' changes);
  // it used to swallow the failure, which left those messages unreachable
  // (FOLLOW4). Callers with nothing to tell the user catch it themselves.
  const refreshInstances = useCallback(async () => {
    // An explicit refresh (Enable, Check again, a saved change) rechecks every CLI version.
    const { instances, shellEnvironment, engineNote } = await probeInstances("/api/instances?fresh=1", api);
    rawDispatch({ type: "instances", instances, shellEnvironment: shellEnvironment ?? null, engineNote });
  }, []);
  const refreshAfterKey = useCallback(
    () => refreshAfterFluxKey({ request: api, applyConfig: (config) => rawDispatch({ type: "configStatus", config }), refreshInstances }),
    [refreshInstances],
  );

  // Installing a CLI or signing one in happens in a terminal, outside this
  // window — so the moment the user comes back is exactly when our engine
  // snapshot is most likely stale. Re-probe on focus, throttled so that
  // ordinary alt-tabbing doesn't spawn a `--version` call per switch.
  const lastFocusProbe = useRef(0);
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusProbe.current < 3000) return;
      lastFocusProbe.current = now;
      // Offline or server down: the existing list stays, nothing to say.
      void refreshInstances().catch(() => {});
    };
    // A phone or a browser tab coming back to the front fires visibilitychange, not focus.
    const onVisible = () => { if (document.visibilityState === "visible") onFocus(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshInstances]);

  const flushBotPatches = useCallback(
    (botId: string) => botPatchQueue.flush(botId),
    [botPatchQueue],
  );
  const value = useMemo(
    () => ({ state, dispatch, flushBotPatches, refreshInstances, refreshAfterKey }),
    [state, dispatch, flushBotPatches, refreshInstances, refreshAfterKey],
  );
  const actions = useMemo(
    () => ({ dispatch, flushBotPatches, refreshInstances, refreshAfterKey }),
    [dispatch, flushBotPatches, refreshInstances, refreshAfterKey],
  );
  return (
    <StoreContext.Provider value={value}>
      <ActionsContext.Provider value={actions}>
        <StreamContext.Provider value={stream}>
          <HelpersContext.Provider value={stream.helpers}>{children}</HelpersContext.Provider>
        </StreamContext.Provider>
      </ActionsContext.Provider>
    </StoreContext.Provider>
  );
}

/** dispatch and friends without the state: does not re-render on state changes. */
export function useStoreActions() {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error("useStoreActions outside provider");
  return ctx;
}

/** The store when there is one: a component that only improves on what it was
 * handed (a lookup that fetches a missing row) renders without a provider. */
export function useStoreIfAny() {
  return useContext(StoreContext);
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

export function formatTime(at: number) {
  return new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
