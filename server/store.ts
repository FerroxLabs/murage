import type { HeldContinuation } from "./external-context-delivery.ts";
import type { AskerWakeSnapshot } from "./asker-wake.ts";
import type { ApprovalGrantRequest } from "../shared/approval-grant-request.ts";
import { renderMurageTools, NEUTRAL_TOOL_SURFACE } from "./murage-tool-surface.ts";
import { assignMissingVoices, pickDefaultVoice } from "./bot-voice.ts";
import { captureBotDeletion } from "./memory/capture.ts";
import { markPartitions, setExecutionStore, partitionRoots } from "./execution-audience.ts";
import { teamLabel, TEAM_JOURNAL, teamChangeOpen, assertSectionUnlocked, assertHomeMove, workThreadTitle } from "./team-identities.ts";
import type { MessageEngine } from "../shared/engine-switch.ts";
import type { MessageActorKind } from "../shared/message-actor.ts";
import { BROWSER_CHECK_FAILED_REASON, browserUnavailableActivityName } from "../shared/browser-unavailable.ts";
import { isErrorActivity } from "../shared/message-visibility.ts";
import { bumpUsageMonth, type UsageMonth } from "../shared/usage-month.ts";
import type { RoutineRunMarkerTrigger } from "../shared/routine-run-marker.ts";
import type { ProcedurePin } from "./procedure-bundles.ts";
import { threadHumanPrincipal, isWorkspaceOwner, withBindingScope } from "./human-principals.ts";
import { observeOwnerMessage, recordWeakSignal } from "./memory/outcomes.ts";
// Bot + thread persistence. bots.json holds bot records (including the
// thread→instance binding and per-instance resume cursors — upstream's
// ProviderSessionDirectory, recipe step 6: persist the binding from day
// one). messages-<threadId>.json holds the folded transcript.
import { createHash } from "node:crypto";
import { accessRoleBinding, botAccessPolicy } from "./bot-access-role.ts";
import type { ConnectedAppAccess } from "../shared/bot-access.ts";
import { mentionedPeers, mentionsEveryone } from "../shared/mention-boundary.ts";
import type { LocalSetupFailure, ProviderErrorInfo } from "../shared/provider-error.ts";
import { parseRuntimeErrorDiagnostic, type RuntimeErrorDiagnostic } from "../shared/error-diagnostic.ts";
import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { cancelCoalesced, flushCoalesced, scheduleCoalesced, tightenOwnerOnlyFile, writeFileAtomic } from "./atomic.ts";
import { readPersistedRecords } from "./persisted-state.ts";
import { peerAllowKey, type PeerAction } from "./peer-approval-key.ts";
import { DATA_DIR, loadBrowserProfileIdAliases } from "./config.ts";
import * as mdb from "./message-db.ts";
import { murageLine } from "./murage-line.ts";
import { guardHandoffPrompt, isHandoffPromptId } from "./handoff-stamp.ts";
import type { ProviderReply } from "./provider-reply.ts";
import type { KeyedFamily } from "./transcript-backfill.ts";
import { imagePathsOf, tagImagePaths } from "./message-image-paths.ts";
import { lineClassesOf } from "./line-classes.ts";
import { LINE_BOT_EMPTY, LINE_REQUEST_CARD, LINE_TEXT } from "./branch-index.ts";
import { branchTester, isPrepared as isThreadPrepared, prepareThread as prepareThreadRows } from "./branch-store.ts";
import { grandfatheredHostComputerConsent, isHostComputerConsent, type HostComputerConsent } from "./host-computer-consent.ts";
import { persistMemoryRoster, reconcileMemoryRoster } from "./memory/policy.ts";
import { parseContinuityOptions, type ContinuityOptions } from "./memory/pip-types.ts";
import { setMemoryCaptureRoster } from "./memory/capture-scope.ts";
import { database, transaction } from "./database.ts";
import { afterCommit, inTxScope, onRollback } from "./tx-scope.ts";
import { deleteProjectRows } from "./project-tables.ts";
import { botDeletionKey, groupDeletionKey, recordOwnerDeletion, withdrawOwnerDeletion } from "./owner-deletions.ts";
import { recordMemorySettlement, type MemoryTurnOutcome } from "./memory/settlement.ts";
import { workspaceDir } from "./workspace.ts";
import { newId, type CloudBackend, type ModelSelection, type ThreadId } from "./contracts.ts";
import { pickBotName, DEFAULT_BOT_COLOR } from "./names.ts";
import { redactSecretsForCard, redactSecretsInText } from "./redact.ts";
import { queueExternalUpdate } from "./external-context-delivery.ts";
import { botAvatarProfile, type BotAvatarCrop } from "../shared/bot-avatar.ts";
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";
import type { MascotBodyId } from "../shared/mascot-bodies.ts";
import type { RoutineRequestCardData } from "../shared/routine-request.ts";
import type { RoutineRunCardData } from "../shared/routine-run.ts";
import type { SkillRequestCardData } from "../shared/skill-request.ts";
import type { GroupGoalRunCardData } from "../shared/group-goal-run.ts";
import type { ChannelProject } from "../shared/project.ts";
import type { IntakeCardData } from "../shared/intake-turn.ts";
import type { SetupCardData } from "../shared/setup-card.ts";
import type { InstalledPackageMetadata } from "../shared/installed-package.ts";
import { openingLine } from "../shared/bot-openers.ts";
import { readPublishedSites } from "../shared/published-sites.ts";
import { withoutBareCommandGrants, withoutQuestionGrants } from "./auto-approve.ts";
import { withoutPreSchemaGrants, withoutStaleGrants } from "../shared/app-action-words.ts";
import { parseAcpToolKey } from "../shared/mount-identity.ts";
import { imageApprovalOf, imageAskAfterOf } from "../shared/image-approval-setting.ts";
import { settledTurnHelpers, type TurnHelper } from "../shared/turn-helpers.ts";
import { LruMap } from "./thread-cache.ts";
import { onSeqNumbered } from "./transcript-seq.ts";
import { sliceSizer } from "./slice-budget.ts";

export type EmberColor =
  | "green"
  | "blue"
  | "red"
  | "orange"
  | "purple"
  | "cyan"
  | "pink"
  | "yellow"
  | "teal"
  | "coral";

/**
 * The face a bot rests on, as one of the engine's state names. Kept as a plain
 * string rather than a union: bots saved under the app's earlier ten-face
 * vocabulary still carry those names, and the client resolves both on read.
 */
export type EmberExpression = string;

export interface OptionCardData {
  /** Optional owner-approved browser connection with one explicit continuation. */
  browserSetup?: import("../shared/browser-setup-card.ts").BrowserSetupCardData;
  /** A publish approval card (server/publish): never auto-approved, in any access mode. */
  kind?: "publish";
  publish?: import("../shared/publish-card.ts").PublishCardData;
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** permission cards: the tool being requested, so the card can show what
   * is actually being asked and offer "always allow this tool". */
  tool?: string;
  /** why this stopped despite auto mode (destructive-looking command) */
  held?: string;
  /** Permission cards whose `subtitle` carries the full tool input or the
   * model's labelled reason: the engine's one-line summary of the action,
   * which audit, risk rating and push text read instead. */
  summary?: string;
  /** The tool input on this card was cut to fit; the card offers no
   * "always allow" and the owner must read the full card. */
  toolInputTruncated?: boolean;
  /** What a push notification for this card may say (no typed text or field values). */
  pushBody?: string;
  /** Murage for Chrome (D1): the step is one Murage asks about every time, in every mode. */
  browserCardKind?: "delete" | "newRecipient";
  /** the narrow grant "always allow" remembers, e.g. "Bash:git" */
  allowKey?: string;
  /** "Always allow this exact command here": command text, folder and
   * engine (shared/exact-command.ts). Command cards only, never stop-line. */
  exactAllowKey?: string;
  /** Stop-line cards (server/stop-line.ts): the grant "Allow for this task"
   * records, scoped to the folder, payee or recipient the action touches. */
  taskAllowKey?: string;
  /** "Always allow for this routine" on a card a routine run raised: the
   * scoped key (the stop-line place or this exact command here) and the
   * routine it is stored on. */
  routineAllowKey?: string;
  routineId?: string;
  /** AMEND-13 Rule 78c: "Always allow" on a call of several distinct actions
   * remembers this whole set (one exact key per action), never one key. */
  allowKeys?: string[];
  /** AMEND-13 Rules 78, 81, 82: every operation in call order and the
   * routine offer, written once by the server when the request opened. */
  grantRequest?: ApprovalGrantRequest;
  /** Local actions never share remembered grants with cloud/tool approvals. */
  approvalScope?: "local-computer";
  /** Advisory only, for the page: the engine path rated this permission card low when it raised it. A browser
   * pairing shows Allow only on these. The harness never reads it back (SEC-006, Decision 1). */
  lowRisk?: boolean;
  /** 0.1.52 ASK2: a provider question's structured questions, persisted
   * with the card in messages.db so it survives a reload and a restart. */
  questions?: import("../shared/questions.ts").QuestionSpec[];
  /** The owner's validated answers (a secret question's answer is never
   * kept). Present once answered, or once a late answer was sent. */
  answers?: import("../shared/questions.ts").QuestionAnswer[];
  /** The engine stopped waiting with no answer (timeout, turn end,
   * restart). The card stays visible and offers "Send as a message". */
  expired?: boolean;
  /** An expired question's answer went to the bot as an ordinary message. */
  sentAsMessage?: boolean;
  /** D7: an approval left open by a previous process, found at startup. The
   * request behind it died with that process, so it no longer counts as
   * waiting in the Inbox; the card itself stays and answering it says the
   * run ended (and offers Run again for a routine). */
  orphaned?: boolean;
  /** Raised during a run nobody was watching (routine, webhook, Telegram);
   * an expired one of these stays in the Inbox as needing the owner. */
  unattended?: boolean;
  /** 0.1.52 FUIGOTRUST1: this question decides trust for a folder (shared/
   * folder-trust.ts). Its answer is recorded for the folder's trust key.
   * `late` (FUIGOTRUST2): a card raised from the engine's own request after
   * it had started, closed by nobody — the turn `finished`, was `stopped`,
   * or the ask hit its `timeout` — and so ran untrusted. */
  folderTrust?: { key: string; folder: string; sources: string[]; late?: "finished" | "stopped" | "failed" | "timeout" };
  /** A durable chat-created routine proposal. The scheduler only applies it
   * after this card is explicitly confirmed by the user. */
  routineRequest?: RoutineRequestCardData;
  /** Hash of what this routine proposal SAID when it was rendered — the
   * operation together with the title and subtitle the person actually read.
   * Checked on confirmation so an approval cannot apply an operation other
   * than the one displayed. Absent on cards proposed before this existed;
   * those skip the check rather than becoming unconfirmable. */
  routineProposalDigest?: string;
  /** A durable learned-skill proposal. The skill stays staged until the
   * user confirms this card — it never rides the prompt before that. */
  skillRequest?: SkillRequestCardData;
  /** A turn of the new-bot setup conversation. Staged like the two above:
   * the card carries a proposal and nothing is installed until the person
   * confirms it on `POST /api/bots/:id/assistant-profile`, which is where
   * the desktop boundary already lives. Never set together with
   * `requestId`: an intake turn is not a live provider ask. */
  intake?: IntakeCardData;
  /** Present when this card is a step of the guided first run. Read
   * defensively through `readSetupCard` (shared/setup-card.ts); never both
   * set with `requestId` or with `intake`. */
  setup?: SetupCardData;
}

export interface ConnectorCardData {
  /** Composio toolkit slug. It is validated server-side before every action. */
  slug: string;
  alias?: string;
  label: string;
  description: string;
  status: "required" | "authorizing" | "connected" | "failed";
  /** Cards created by one agent request resume together after all connect. */
  resumeKey: string;
  error?: string;
  /** Why a failed card failed: the sign-in ran out, was refused, or ended
   * some other way. `error` carries the plain sentence for it. */
  failure?: "timed-out" | "denied" | "failed";
  /** When the sign-in began, so an old link reads as expired. */
  authorizedAt?: number;
  dismissed?: boolean;
  resumed?: boolean;
}

/** A link server whose sign-in ended while a bot was working (MCP-LINK 3.12).
 * Names and a host only: never a token. */
export interface McpSignInCardData {
  /** The saved server's name. */
  name: string;
  host: string;
  /** The bot the card was posted for, by its name. */
  bot: string;
  /** And by its id: the card is settled from the saved conversation after a restart. */
  botId?: string;
  reason: "sign-in-ended" | "needs-more-access";
  /** The origin of the server the card was posted for; a card never settles for another origin. */
  origin?: string;
  /** What a needs-more-access card asked for; the next sign-in adds it. */
  scope?: string;
  status: "required" | "signed-in";
  /** One card per server per turn; the resume waits on this key. */
  resumeKey: string;
  title: string;
  body: string;
  /** Where a phone or the browser door sends the owner instead of a button. */
  phone: string;
  error?: string;
  dismissed?: boolean;
  resumed?: boolean;
}

export interface SecretRequestCardData {
  /** Fixed allowlisted credential id; never an arbitrary config path. */
  target: import("../shared/credential-request.ts").CredentialTargetId;
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

/** Who put a user message into the transcript. The harness decides this when
 * it writes the message, from the surface the request proved (the desktop
 * app's secret, the phone companion's launch credential), never from the
 * request body. Absent means not proven: an older message, or a local caller
 * with neither proof. Only an owner origin counts as the owner's say-so. */
export type MessageOrigin = "desktop" | "companion" | "unproven";
export function isOwnerOrigin(origin: MessageOrigin | undefined): boolean {
  return origin === "desktop" || origin === "companion";
}

export interface Message {
  /** The row's number in its thread (messages.seq, transcript-seq.ts): 1..n in storage order, set from the column by the writer
   * (message-db.ts replaceRow, updateMessage) and the one decoder (rowToMessage), never stored in the JSON. Absent while the
   * thread is not numbered yet. The wire carries it only through wireThread (transcript-page.ts). */
  seq?: number;
  /** Set by insertMessageBefore: the row this message was saved in front of.
   * Storage (and so paging) order puts it after that row; a client holding
   * a page whose older rows are not loaded reads this to place it ahead of
   * the rows it precedes (src/lib/room-transcript.ts). */
  insertedBefore?: string;
  inboundKind?: "action" | "question";
  /** The phantom-action check of a turn's closing reply (server/reply-action-guard.ts).
   * Server-written only, on the terminal row. */
  actionCheck?: import("../shared/reply-action-claims.ts").ActionCheck;
  /** A fabricated next speaker was cut from this reply before publication. */
  removedSpeaker?: string;
  /** On the removal row only: what was cut, kept for the owner. Room
   * transcripts read text rows and memory reads a row's text, never this. */
  removedText?: string;
  /** On the user message a direct hand-off (an ask or a delegation with no room or card parent) starts in the target's conversation: the
   * conversation that handed the work over. A reply that follows it is proven to be that conversation's own answer (server/handoff-binding.ts),
   * with no inference from any other request. Stored in the row's JSON, so no schema change. */
  handoffFrom?: string;
  /** On a hand-off's prompt: the sender's "Messaged" row it was handed over by (LINEAGE-DESIGN-S6 rules 6 and 7). The prompt's lineage is that one
   * line; a prompt without it (written before 1.0.3) keeps the asking conversation's prefix. */
  handoffOf?: { threadId: string; messageId: string };
  automation?: { kind: "schedule"|"manual"|"webhook"|"channel"|"delegation"|"card"|"ask"|"message"|"room"; channel?: "telegram"|"slack"|"discord"|"whatsapp"; connectionId?: string; webhookId?: string; routineId?: string };
  id: string;
  /** Verified durable deliverable identities; raw paths never become download links. */
  artifactIds?: string[];
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "mcpSignIn" | "secret" | "routine.run" | "goal.run";
  text?: string;
  /** Durable provider output stored by the harness. Paths always point into
   * Murage's private attachment directory; renderers receive only the
   * existing allowlisted /api/attachments URL. */
  attachments?: Array<{ kind: "image"; path: string; mime: string }>;
  card?: OptionCardData;
  connector?: ConnectorCardData;
  mcpSignIn?: McpSignInCardData;
  secret?: SecretRequestCardData;
  /** One idempotently updated status card in the conversation that created a
   * routine. The actual provider turn remains in its isolated task. */
  routineRun?: RoutineRunCardData;
  /** Terminal receipt for a bounded multi-bot channel goal. */
  goalRun?: GroupGoalRunCardData;
  /** activity messages: tool name + outcome. `spoken` is the same chip as
   * a phrase a voice can read ("reading a file") — computed once here so
   * call mode never has to re-derive it from the raw tool name, and absent
   * for chips not worth interrupting the ear for. */
  /** `setup` marks an error the user fixes by installing or configuring
   * something — the UI offers setup instead of a retry that cannot work. */
  /** `summary` is a short read of what the call was for — the only thing that
   * tells two chips apart on engines that route every tool through a wrapper. */
  tool?: { name: string; action?: ReturnType<typeof import("./reply-action-guard.ts").toolAction>; ok?: boolean; /** An engine notice shown in the conversation; never an action or a tool outcome. */ notice?: boolean; spoken?: string; summary?: string; setup?: boolean; authRequired?: boolean; claudeUpdate?: boolean; errorDetails?: string; errorKind?: string; providerError?: ProviderErrorInfo; localFailure?: LocalSetupFailure; /** The engine a local failure is about (an engine-folder failure), for the localized line. */ localFailureEngine?: string; diagnostic?: RuntimeErrorDiagnostic; /** Full access approvals collapsed into one line: each step, newest last (bounded), and how many in all. */ steps?: string[]; stepCount?: number;
    /** An image made without an approval card (server/image-approval.ts): what was asked for and the whole prompt, shown folded like the card's. */
    imageRecord?: { summary: string; prompt: string } };
  /** user messages sent INTO a running turn (capabilities.queueing): the
   * model saw it mid-turn, so the transcript marks it — a reader should
   * know the reply above it may already account for this line */
  steered?: boolean;
  /** a steered message the engine had not confirmed when Murage recorded it
   * (steer() said "uncertain"); cleared by its late echo (`steer.confirmed`) */
  steerUnconfirmed?: boolean;
  /** the id the server sent the steer under; the engine's late echo names it */
  steerId?: string;
  /** a line the setup flow itself said, by the step it was said for: the flow
   * finds it by this tag (keyed_card) and never looks through the thread */
  setupEcho?: string;
  /** user messages: images named in this message that a turn left out
   * (per-turn count or bytes, shared/turn-image-note.ts). A later replay of
   * the message leaves them out too, so the bot is never handed their paths. */
  imagesNotSent?: string[];
  /** Provider turn that produced this message. Assistant output can arrive
   * in several pieces around tool calls; the UI uses this identity to keep
   * those pieces together without discarding them. */
  turnId?: string;
  /** User rows: the provider turn the server released these words to (its submission fence passed and acceptance named the turn;
   * a steer the engine took, the turn it went into). Server written, never on replayed history (server/turn-attribution.ts). */
  dispatchedIn?: string;
  /** The last assistant text item from a settled provider turn. Earlier text
   * with the same turnId is progress narration, not another final answer. */
  turnTerminal?: boolean;
  /** "provider": this row was written with a provider reply (server/provider-reply.ts), the engine's own text or tool start. For audit only: nothing reads it
   * as proof (the proof is the marker handed to the store as the row is written, handoff-evidence.ts). */
  provenance?: "provider";
  /** The engine, model and route that wrote this bot row, and the hash of the
   * capability profile the turn ran under (server/engine-profile.ts). Server
   * written on every row a provider turn produces; stored in the row's JSON,
   * so no schema change. Absent on older rows and on rows no provider turn
   * wrote (user, Murage, copies): readers treat absence as unlabelled. */
  engine?: MessageEngine;
  /** On a turn's closing message: its helpers (sub agents), summarised
   * (label, status, duration, tool count; never tool content). Owner threads
   * only. Source of the folded "Worked for" rows after a reload. */
  turnHelpers?: TurnHelper[];
  /** screen messages: a frame of the bot's computer (base64 image) */
  png?: string;
  mime?: string;
  at: number;
  /** the message this one follows; null = thread root. Edited messages
   * share a parentId with the version they replace — that's a fork. */
  parentId?: string | null;
  /** Optional flat reply reference. Unlike parentId this never changes the
   * conversation branch; it only quotes one earlier text message inline. */
  replyToId?: string;
  /** Stable client identity for at-most-once chat POST retries. */
  sendId?: string;
  /** Per-send channel behavior. Absent is legacy quick chat. */
  channelMode?: "chat" | "goal";
  /** Room owner messages: the one member this send is pinned to (a room-call
   *  hand-down). Server-written; recovery and retries honour it. */
  responderBotId?: string;
  /** group threads: which member said this (sender attribution). */
  from?: { botId: string; name: string; color: string };
  /** emoji reactions; by = "user" or a member botId. */
  reactions?: Array<{ emoji: string; by: string }>;
  /** comm chips: "Messaged @X" in the caller's chat, linking to the
   * bot⇄bot channel where the exchange is mirrored. */
  comm?: { groupId: string; withBotId: string; withName: string; withColor: string };
  /** user messages sent while the bot was mid-turn, waiting in the
   * steer-queue to auto-send on settle. Cleared when the drain consumes
   * them; a true stranded by a restart is inert because the client only
   * shows the affordance while the bot is busy. */
  queued?: boolean;
  /** steer-queue entry this drained user line came from. The client pending
   * chip matches on this id, not on equal text. Absent on ordinary sends. */
  queueId?: string;
  /** user messages: see MessageOrigin. Server-written only. */
  origin?: MessageOrigin;
  /** user messages: the standing instruction a scheduled or manual routine
   * run started with (shared/routine-run-marker.ts). A replayed history
   * labels it as that run. Server-written only. */
  routineRunPrompt?: { trigger: RoutineRunMarkerTrigger; routineName: string };
  /** rooms, bot replies: bots are no longer shown this reply because it
   * used something the owner forgot, deleted or changed (room-transcript.ts),
   * or "forgotten" when the owner forgot this reply itself, or "checking"
   * when it is left out only for now because earlier context is still being
   * checked (nothing was withdrawn). The owner still sees it. Server-written only. */
  withheldFromBots?: boolean | "forgotten" | "checking";
  /** A bot reply the harness copied here from another thread (a delegated
   * or asked teammate's answer, mirrored into the pair room or back into the
   * conversation that asked). The copy is withheld from bots whenever the
   * original is (server/memory/replay-lineage.ts). Server-written only. */
  copyOf?: { threadId: string; messageIds: string[] };
  /** activity messages: a card answered after its routine run had ended.
   * The row offers Run again for this routine. Server-written only. */
  routineRunAgain?: { routineId: string };
  /** activity messages: a delegation parked on a busy teammate. While it
   * waits, the line offers Stop for this queued handoff (server/delegations.ts).
   * Server-written only, and removed once the handoff leaves the queue. */
  delegationWait?: { id: string };
  /** activity messages: a hand-off a restart cut off after the provider may have taken it (server/delegations.ts reconcileStartedDelegations). The line offers
   * Send again (queued as a new hand-off) and Dismiss. Server-written only, and removed once the owner chose. */
  delegationHeld?: { id: string };
  /** Message envelope v2 (SPEC-P 10), server-written only. Who is speaking:
   * presentation and prompt labelling only, never an authorisation input. */
  actorKind?: MessageActorKind;
  /** The room request this message became or was produced by (lineage for
   * Retry, Reassign and the scorecard). */
  requestId?: string;
  /** Bot ids this line is addressed to (asks, results, assignments). */
  to?: string[];
  /** The card this line belongs to. */
  workItemId?: string;
  /** A line from Murage itself (no `from`): what it offers. */
  murage?: MessageMurage;
  /** Server-written (murage-line.ts murageLine): Murage wrote this row into a bot's conversation in its own voice (an error, retry, stop,
   * notice or status line), never the turn's engine. Write-time lineage only; presentation reads actorKind. */
  murageLine?: true;
}

export type { MessageActorKind };
export interface MessageMurage {
  digestDay?: string;
  desk?: { botId: string; threadId: string };
  kind: "failure" | "status" | "queue" | "budget" | "restore" | "milestone" | "result" | "progress" | "cap";
  /** The one row per task that says how many items wait for a tool-capable engine. */
  held?: { count: number; items?: Array<{ id: string; text: string; rowId?: string; error?: string; botId?: string; state?: HeldContinuation["state"]; restoreGen?: string }> };
  retry?: { requestId: string };
  reassign?: { workItemId: string };
  /** The Murage status this row was written from (LINEAGE-DESIGN-S6 rule 11): its key and kept parameters, never its words. A bot reads
   * such a row only as these rendered fresh (bot-read.ts fixedCopy); the owner reads the row as stored. */
  status?: { key: string; data?: Readonly<Record<string, string | number>> };
}

export type GroupDefaultResponder =
  | { kind: "member"; botId: string }
  | { kind: "everyone" }
  | { kind: "mentions" }
  /** The decision model picks the responder for a message nobody was addressed in; `fallbackBotId` (else the first member) answers whenever it cannot. */
  | { kind: "auto"; fallbackBotId?: string };

/** One independent conversation inside a user-created channel. Channel
 * membership and instructions stay on GroupRecord; transcript-bound state
 * lives here so switching tasks never moves a pin or working directory into
 * another provider context. */
export interface GroupTaskRecord {
  heldContinuations?: HeldContinuation[];
  heldQueueRowId?: string;
  unreadCount?: number;
  procedurePins?: Record<string, ProcedurePin>;
  threadId: ThreadId;
  title: string;
  createdAt: number;
  pinnedCwd?: string | null;
  /** Host-admitted local output desks, independently of the engine CWD. */
  localOutputBotIds?: string[];
  pinnedMessageId?: string;
}

/** A room: a shared thread where several bots + the user talk. Plain
 * messages follow `defaultResponder`; explicit @mentions always override it.
 * The bulletin is the room's shared instructions — every member's turn gets
 * it as part of its system prompt. */
export interface GroupRecord {
  heldContinuations?: HeldContinuation[];
  heldQueueRowId?: string;
  dmAudience?: { kind: "team"; teamId: string } | { kind: "project"; groupId: string } | { kind: "room"; groupId: string } | { kind: "isolated" };
  partitionedFor?: Record<string, { kind: "team"; teamId: string } | { kind: "room" } | { kind: "isolated" }>;
  procedurePins?: Record<string, ProcedurePin>;
  id: string;
  /** The active task's thread. Direct-message channels remain single-threaded. */
  threadId: ThreadId;
  /** User-created channels have independent tasks, newest first. */
  tasks?: GroupTaskRecord[];
  localOutputBotIds?: string[];
  name: string;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  bulletin: string;
  unread: boolean;
  createdAt: number;
  /** true for auto-created bot⇄bot channels (ask_bot exchanges live here;
   * the user can open the channel and chip in) */
  dm?: boolean;
  /** transient: the member currently running a turn (never persisted) */
  busyBotId?: string | null;
  /** transient: when the busy member's turn started (epoch ms), for the
   * room's elapsed readout. Stamped when a member claims the turn, cleared
   * when the room goes idle; never persisted. */
  turnStartedAt?: number;
  /** the room's shared desk: where member turns run their shell tools,
   * overriding each member's own folder. The room pins its own copy on its
   * first turn (pinnedCwd). Absent = each member's own default. */
  cwd?: string;
  /** Compatibility mirror of the active task's pinned folder. */
  pinnedCwd?: string | null;
  /** Compatibility mirror of the active task's pinned message. */
  pinnedMessageId?: string;
  /** sidebar section heading this room is filed under; shares the bots'
   * namespace so one heading can hold a project's room and its people */
  section?: string;
  /** New user-created rooms start with setup pending. Null timestamps are
   * intentional: records from before room setup has existed omit both keys
   * and remain immediately usable. */
  setupCompletedAt?: number | null;
  setupSkippedAt?: number | null;
  /** Filed away. Same word, same meaning and same shape as a bot's `hidden`
   * (see BotRecord): the channel keeps every member, every message, every
   * task and its folder, and simply leaves the main list. It is the end
   * state that is NOT delete, which until now was the only end state a
   * channel had. Absent on every record written before archiving existed,
   * which reads as "not archived" and needs no migration. */
  hidden?: boolean;
  /** Present = this channel is a project: it has a purpose, not just a
   * roster. Absent = an ordinary channel, which is the normal case and the
   * shape every existing record already has. A project HAS a channel; a
   * channel does not have to be a project.
   *
   * Named `channelProject`, never `project`: the bare word already means a
   * memory scope keyed by a FOLDER, an import mode, two folder leases, a
   * Composio account key and a GEPA split axis. shared/project.ts spells out
   * each clash. This block owns none of them, and in particular does not
   * touch `cwd`: making a channel a project does not give it a folder. */
  channelProject?: ChannelProject;
  /** SPEC-P 3.12 [AMB-8]: whether a teammate's @mention in a bot reply
   * summons that teammate (the old one-hop chain). `true` only on channels
   * from before the turn engine (set once at boot); `false` on every room
   * created since, where hand-offs go through the ask tool. */
  mentionChain?: boolean;
}

/** One task = one conversation with its own context.
 *
 * A bot used to be a single endless thread, which meant every job
 * contaminated the next and the only way to get a clean slate was to
 * clone the bot. A task is that clean slate: its own thread, its own
 * transcript, and — the part that actually matters — its own provider
 * session. Sharing resume cursors between tasks would resume the other
 * task's session and quietly undo the whole thing. */
/** Thread recall (design S1): recall output was released on this thread. */
export const threadSealed = (task: Pick<TaskRecord, "sealGeneration"> | undefined | null): boolean => (task?.sealGeneration ?? 0) > 0;

export interface TaskRecord {
  /** Server-owned: what this conversation's hand-offs still owe it (asker-wake.ts), kept so a restart still continues the work. */
  askerWakes?: AskerWakeSnapshot;
  sharedWork?: { teamId: string; createdAt: number; closedAt?: number; closedReason?: "revoked" | "team-deleted" | "restored"; finishing?: { requestId?: string; generation?: string; rootRequestId?: string }; quarantined?: true };
  procedurePin?: ProcedurePin;
  /** Host admission only; paths are always derived from current IDs. */
  localOutputs?: true;
  /** Server-owned automation root; retained for reviewed card resumptions. */
  automationEventId?: string;
  threadId: ThreadId;
  title: string;
  createdAt: number;
  /** provider-native continuation per instance, for THIS task only */
  resumeCursors: Record<string, unknown>;
  /** SPEC-P 13.1 (lane E1): the audience fingerprint each cursor was made
   * under (owner-audience.ts). A turn for another audience never resumes it.
   * Absent for a cursor from before, which reads as the owner's. */
  resumeAudiences?: Record<string, string>;
  /** The engine's session contract each cursor was made under (ProviderInstance.sessionContract).
   * Absent for a cursor from before, or from an engine with none. */
  resumeContracts?: Record<string, number>;
  /** The cursors made by a session that was shown the connected-app tools by
   * their plain names (shared/connected-app-names.ts). A cursor without this
   * mark came from an earlier release, whose history calls them by the older
   * names, so its session is mounted the older way. */
  resumePlainToolNames?: Record<string, true>;
  /** The incarnation each cursor's session was started under (lineage S6 rule 27, memory/session-incarnation.ts), from 2 on: the memory
   * session key is formed from the cursor and this. Absent for n = 1 and for a cursor from before. */
  resumeIncarnations?: Record<string, number>;
  /** Independent direct-thread settings; copied from the bot on creation. */
  modelSelection?: ModelSelection;
  autoApprove?: boolean;
  /** Full access for this task: above Auto, and only while autoApprove is on. */
  fullAccess?: boolean;
  /** No limits for this task: above Full access (no stop line), and only
   * while fullAccess is on. Absent on every older record, which stays at
   * guarded Full access. */
  noLimits?: boolean;
  alwaysAllow?: string[];
  unread?: boolean;
  rewound?: boolean;
  pinnedMessageId?: string;
  /** Listed first in the task switcher. Absent means not pinned; `false` is
   *  never written, so older builds read the same record unchanged. */
  pinned?: true;
  /** Runtime only. Never resume a running process after restart. */
  activity?: BotActivity;
  busy?: boolean;
  /** Runtime only: this busy task is waiting for another thread to release a
   * shared working folder, computer or browser profile, or (a queued routine)
   * for a free thread slot, before it starts. */
  waitingFor?: TaskResourceWait;
  /** Runtime only: when this task's current busy stretch began (epoch ms).
   * The chat's elapsed readout counts from here, so it survives a thread
   * switch. Stamped on an idle-to-busy transition, cleared when idle. */
  turnStartedAt?: number;
  /** which instance dispatched the most recent turn. A cursor alone can't
   * say whether an engine's session is current — another engine may have
   * taken turns since — so this is what decides an inline replay. Absent
   * on tasks from before the field existed. */
  lastInstanceId?: string;
  /** Thread recall (1.0.3, design S1): bumped, and saved at once, before the
   * first answer of a recall generation leaves. Above 0 means recall output
   * was released on this thread, so it never resumes an engine session
   * again. It never decreases and never goes over the wire. */
  sealGeneration?: number;
  /** ids of messages appended to this thread outside a provider turn — a
   * delegated teammate's reply — that no dispatch has carried to the engine
   * yet. Delivery accounting: see server/external-context-delivery.ts. */
  externalUpdates?: string[];
  /** answered approval cards whose continuation could not start because the
   * route had no tools; carried on the first dispatch that has them. */
  heldContinuations?: HeldContinuation[];
  /** the one thread row that says how many items are held (patched in place) */
  heldQueueRowId?: string;
  /** what this task has spent: banked once per turn from turn.completed */
  usage?: TaskUsage;
  /** the provider turns already banked into `usage` (most recent last, bounded): a redelivered terminal event adds nothing twice */
  usageTurnKeys?: string[];
  /** the folder this task's turns run in, pinned on its first turn from
   * the bot's `cwd` at that moment. Pinned, not read live: Claude keeps
   * sessions per project directory and Codex threads carry their cwd, so
   * a folder that moved under a live session would break resume. `null`
   * = pinned to the default (home); absent = not pinned yet. */
  cwd?: string | null;
  /** Marks a project desk thread: one per bot and project (SPEC-P 3.12).
   * Close and End project set `archivedAt` (hidden from the task list),
   * Reopen and "Make this a project" clear it; the task is NEVER removed,
   * because removing a task is a roster change that revokes every memory
   * disclosure in the install. Lane E2a creates and writes these; lane R
   * owns the archive stamp. */
  channelProjectDesk?: { groupId: string; archivedAt?: number };
}

export type TaskResourceWaitKind = "working-folder" | "computer" | "browser" | "shared" | "thread-slot";
export interface TaskResourceWait {
  resource: TaskResourceWaitKind;
  /** Title of the thread being waited for, only when the viewer may see it. */
  holderTitle?: string;
}

export interface TaskUsage {
  input: number;
  output: number;
  /** The part of `input` the provider served from its prompt cache — context
   * the model re-read rather than fresh text. Every turn resends the whole
   * conversation plus the system prompt and tool schemas, so on a chatty
   * thread this is most of `input`. Absent on records from older builds. */
  cachedInput?: number;
  /** null until any turn reports a cost — most engines never do. Records
   * written by builds before cost existed lack the field; read as null. */
  costUsd: number | null;
  turns: number;
}

/** Everything the BOT authored is scrubbed of content-shaped secrets before
 * it is stored: its reply text, a tool title (an ACP engine's title can be
 * the whole command line), a permission card's summary. What the user typed
 * is theirs and stays as typed. Stored, not just displayed: the transcript
 * is replayed into every rebuild, and a leaked key would otherwise be
 * permanent. */
function sanitizeMessageDiagnostic<T extends Omit<Message, "id" | "at">>(message: T): T {
  if (message.tool?.diagnostic === undefined) return message;
  const tool = { ...message.tool };
  delete tool.diagnostic;
  const diagnostic = parseRuntimeErrorDiagnostic(message.tool.diagnostic);
  if (message.role === "bot" && message.kind === "activity" && diagnostic?.turnId === message.turnId) tool.diagnostic = diagnostic;
  return { ...message, tool };
}

/** A removal row keeps what the guard cut from a bot's reply: bot-authored,
 * so it is redacted and bounded wherever it is written. */
function boundRemovedText<T extends Partial<Message>>(message: T): T {
  return typeof message.removedText === "string" ? { ...message, removedText: redactSecretsInText(message.removedText).slice(0, 4096) } : message;
}

function redactBotAuthored<T extends Omit<Message, "id" | "at"> & { at?: number }>(message: T): T {
  message = boundRemovedText(sanitizeMessageDiagnostic(message));
  if (typeof message.text === "string") message = { ...message, text: renderMurageTools(message.text, NEUTRAL_TOOL_SURFACE, { agents: "agents", memory: "murage-memory", phone: "phone", browser: "browser" }) };
  if (message.role !== "bot") return message;
  const out = { ...message };
  if (typeof out.text === "string") out.text = redactSecretsInText(out.text);
  // `summary` is a short read of the tool's arguments and `spoken` is narrated
  // from the raw title, so either can carry a credential into the transcript.
  if (out.tool) {
    out.tool = {
      ...out.tool,
      ...(out.tool.name ? { name: redactSecretsInText(out.tool.name) } : {}),
      ...(out.tool.summary ? { summary: redactSecretsInText(out.tool.summary) } : {}),
      ...(out.tool.spoken ? { spoken: redactSecretsInText(out.tool.spoken) } : {}),
      ...(out.tool.errorDetails ? { errorDetails: redactSecretsInText(out.tool.errorDetails).slice(0, 4096) } : {}),
    };
  }
  if (out.routineRun) {
    const routineRun = { ...out.routineRun };
    routineRun.routineName = redactSecretsInText(routineRun.routineName);
    if (routineRun.summary) routineRun.summary = redactSecretsInText(routineRun.summary);
    if (routineRun.error) routineRun.error = redactSecretsInText(routineRun.error);
    out.routineRun = routineRun;
  }
  if (out.goalRun) {
    out.goalRun = {
      ...out.goalRun,
      goal: redactSecretsInText(out.goalRun.goal),
      coordinatorName: redactSecretsInText(out.goalRun.coordinatorName),
      detail: out.goalRun.detail ? redactSecretsInText(out.goalRun.detail) : undefined,
    };
  }
  if (out.card) {
    const card = { ...out.card } as OptionCardData & { summary?: string };
    card.title = redactSecretsInText(card.title);
    if (typeof card.subtitle === "string") card.subtitle = redactSecretsInText(card.subtitle);
    if (typeof card.summary === "string") card.summary = redactSecretsInText(card.summary);
    if (typeof card.held === "string") card.held = redactSecretsInText(card.held);
    // A connected-app card's rows carry the arguments the bot proposed
    // (1.0.4, 09-3): kept with the card, so scrubbed like its summary.
    const grantCard = card as { grantRequest?: { rows?: unknown } };
    if (grantCard.grantRequest && Array.isArray(grantCard.grantRequest.rows)) {
      grantCard.grantRequest = {
        ...grantCard.grantRequest,
        rows: grantCard.grantRequest.rows.map((row) => row && typeof row === "object" && "arguments" in row ? { ...row, arguments: redactSecretsForCard((row as { arguments: unknown }).arguments) } : row),
      };
    }
    // The push text is built from the raw summary by whoever writes the card
    // and goes to the lock screen, APNs/FCM and desktop notifications.
    const pushCard = card as { pushBody?: unknown };
    if (typeof pushCard.pushBody === "string") pushCard.pushBody = redactSecretsInText(pushCard.pushBody);
    // Routine definitions are executable bot-authored text stored behind the
    // visible summary. Scrub the durable payload too so nesting it on a card
    // cannot bypass the transcript's secret-redaction boundary.
    if (card.routineRequest) {
      const operation = card.routineRequest.operation;
      card.routineRequest = {
        ...card.routineRequest,
        operation: operation.action === "create"
          ? {
              ...operation,
              routine: {
                ...operation.routine,
                name: redactSecretsInText(operation.routine.name),
                instructions: redactSecretsInText(operation.routine.instructions),
              },
            }
          : operation.action === "update"
            ? {
                ...operation,
                changes: {
                  ...operation.changes,
                  ...(typeof operation.changes.name === "string"
                    ? { name: redactSecretsInText(operation.changes.name) }
                    : {}),
                  ...(typeof operation.changes.instructions === "string"
                    ? { instructions: redactSecretsInText(operation.changes.instructions) }
                    : {}),
                },
              }
            : { ...operation },
      };
    }
    if (card.skillRequest) {
      const originalPreview = card.skillRequest.preview;
      const preview = originalPreview === undefined
        ? undefined
        : redactSecretsInText(originalPreview);
      // Current skill proposals are scrubbed before staging and their digest
      // binds the card to the exact SKILL.md bytes that apply will install.
      // Keep that binding only when this store-wide safety pass is a no-op and
      // the supplied digest already matches the persisted preview. A caller
      // that bypassed staging (or an older malformed card) is therefore
      // safely deny-only instead of showing one document and approving
      // another.
      const previewSha256 = preview !== undefined && preview === originalPreview
        ? createHash("sha256").update(preview).digest("hex")
        : undefined;
      const sha256 = card.skillRequest.sha256 !== undefined
        && card.skillRequest.sha256 === previewSha256
        ? card.skillRequest.sha256
        : undefined;
      card.skillRequest = {
        ...card.skillRequest,
        gist: redactSecretsInText(card.skillRequest.gist),
        source: card.skillRequest.source === undefined
          ? undefined
          : redactSecretsInText(card.skillRequest.source),
        preview,
        sha256,
        warnings: card.skillRequest.warnings.map((warning) => redactSecretsInText(warning)),
      };
    }
    out.card = card;
  }
  if (out.connector) {
    out.connector = {
      ...out.connector,
      label: redactSecretsInText(out.connector.label),
      description: redactSecretsInText(out.connector.description),
      error: out.connector.error ? redactSecretsInText(out.connector.error) : undefined,
    };
  }
  if (out.mcpSignIn) {
    out.mcpSignIn = {
      ...out.mcpSignIn,
      error: out.mcpSignIn.error ? redactSecretsInText(out.mcpSignIn.error) : undefined,
    };
  }
  if (out.secret) {
    out.secret = {
      ...out.secret,
      label: redactSecretsInText(out.secret.label),
      description: redactSecretsInText(out.secret.description),
      error: out.secret.error ? redactSecretsInText(out.secret.error) : undefined,
    };
  }
  return out;
}

/** What changed, emitted by the store itself right after each write. The
 * server maps these onto its SSE frames in ONE place, so no mutation path
 * can persist without the app hearing about it — the two-write-paths bug
 * (persist without emit → UI drifts; emit without persist → a restart
 * loses what the user just watched) is closed by construction. Bot and
 * group changes carry only the id: the wire shape (cursor stripping) is
 * the caller's business. */
export type BotActivity = "working" | "waiting-on-you" | "idle" | "no-signal" | "dead";
/** The states in which the bot cannot take a new message. */
export const ACTIVITY_BUSY: ReadonlySet<BotActivity> = new Set(["working", "waiting-on-you", "no-signal"]);

export type StoreChange =
  | { type: "message"; threadId: string; message: Message }
  | { type: "message.patch"; threadId: string; message: Message; /** patchMessage only: the message as it was. */ before?: Message }
  | { type: "thread"; threadId: string; activeLeafId: string }
  | { type: "thread.deleted"; threadId: string }
  | { type: "bot"; botId: string }
  | { type: "bot.deleted"; botId: string }
  | { type: "group"; groupId: string }
  | { type: "group.deleted"; groupId: string; /** The record just removed: the listener needs it to say who could see the room. */ group: GroupRecord };

/** What a task is called before its first message names it. */
export const UNTITLED_TASK = "New task";

/** A request card the person has not answered yet: the predicate the channel
 * switch guard and the client's approval strip both apply. */
export function isOpenRequestCard(message: Message): boolean {
  return message.kind === "options" && Boolean(message.card?.requestId) && !message.card?.answered && !message.card?.dismissed;
}

const PEER_PREAMBLE = /^\[(Message from|Delegated by) @([^,\]\n]+),[^\]\n]*\]/;

/** A task's name, taken from the first thing you asked it to do. */
export function titleFromMessage(text: string): string {
  // A turn another bot started opens with a fixed preamble naming the
  // sender. Every such task used to be called the first 48 characters of
  // that preamble; keep the sender, then name it after what was asked.
  const peer = PEER_PREAMBLE.exec(text.trim());
  if (peer) {
    const tag = `[${peer[1]} @${peer[2]!.trim()}]`;
    const rest = text.trim().slice(peer[0].length).trim();
    return rest ? `${tag} ${firstLineTitle(rest)}` : tag;
  }
  return firstLineTitle(text) || UNTITLED_TASK;
}

function firstLineTitle(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

export interface BotRecord {
  sharedWith?: { mode: "none" | "list" | "all"; teams: Array<{ id: string; name: string }> };
  partitionedAt?: number;
  /** What this bot used per local calendar month (Settings, Usage). Upserted with each settled turn; bounded to a year. Months before 1.0.3 have no bucket. */
  usageMonths?: Record<string, UsageMonth>;
  id: string;
  /** the ACTIVE task's thread — everything that runs a turn reads this */
  threadId: ThreadId;
  /** every task this bot has, newest first */
  tasks?: TaskRecord[];
  name: string;
  title: string;
  description: string;
  /** The bot's voice in a sentence or two — "direct, dry, skip the
   * pleasantries". Appended to the persona string on every turn and read by
   * NOTHING else: not the Chief's roster, not the avatar prompt, not the team
   * manifest or the project scout, all of which read `description` to decide
   * who does the work. Capped small on purpose (BOT_PROFILE_LIMITS.persona);
   * absent, never an empty string. */
  persona?: string;
  notifications: boolean;
  color: EmberColor;
  mascotExpression?: EmberExpression | null;
  /** Which mascot body this bot wears; absent means the default Ember flame. */
  mascotBody?: MascotBodyId | null;
  /** App-owned attachment served as this bot's custom profile image. */
  avatarUrl?: string;
  /** Mascot, or the crop applied to avatarUrl. */
  avatarCrop?: BotAvatarCrop;
  unread: boolean;
  modelSelection: ModelSelection;
  /** provider-native continuation per instance (e.g. claude session id) */
  resumeCursors: Record<string, unknown>;
  /** Presentation only; never excludes the bot from authority or routing. */
  sidebarHidden?: boolean;
  /** Durable replay refusal for the exact reviewed package import. */
  packageImportReceipt?: { reviewHash: string; archiveSha256: string; importId: string; selectionHash?: string;
    baseline?: ReturnType<typeof import("./package-import-comparison.ts").createPackageImportBaseline> };
  /** which computer the bot acts on: its cloud box, this Mac (local CUA),
   * or none. Unset = auto (box when it exists, else local when available). */
  computer?: "cloud" | "vm" | "local" | "browser" | "off";
  /** Auto on macOS reaches this computer: the owner's one-time answer for
   * this bot (server/host-computer-consent.ts). Absent = not yet evaluated;
   * set once at load from what the bot has already done. */
  hostComputerConsent?: HostComputerConsent;
  /** Which cloud computer backs `computer: "cloud"`; absent means Box. */
  cloudBackend?: CloudBackend;
  /** Auto mode may prepare/start this bot's managed VPS container. Off by
   * default because starting remote infrastructure is an external action. */
  autoStartVps?: boolean;
  /** where NEW tasks run their shell tools; each task pins its own copy
   * on its first turn (TaskRecord.cwd). Absent = the home folder. */
  cwd?: string;
  /** Auto mode: the bot approves its own tool permissions and keeps
   * working instead of stopping to ask. Questions it asks YOU still come
   * through, and a short list of destructive commands still stops it. */
  autoApprove?: boolean;
  /** Full access, the level above Auto: no approval card at all for turns
   * the owner starts (webhook turns are judged as Auto, a routine run at its
   * routine's level, and images are made without a card only in the owner's own turns:
   * server/image-approval.ts). Counts only while autoApprove is on. Set only
   * from the desktop app. */
  fullAccess?: boolean;
  /** When the owner confirmed this bot's one-time Full access warning, on
   * the desktop. Server-written only; never accepted in a patch body. */
  fullAccessAcknowledgedAt?: number;
  /** No limits, the level above Full access: no stop line (deleting outside
   * its folder, paying, messaging someone new all go ahead); the key guard
   * still asks. Counts only while fullAccess is on. Set only from the
   * desktop app, after its own one-time warning. Absent = guarded. */
  noLimits?: boolean;
  /** When the owner confirmed this bot's one-time No limits warning. */
  noLimitsAcknowledgedAt?: number;
  /** Full access also covers the owner's own Telegram, Slack and Discord
   * messages. Desktop-set; missing or anything but `true` is off. */
  fullAccessChannelMessages?: boolean;
  /** Full access also approves setup requests (learned skills, routine
   * proposals, a folder's own instructions). Desktop-set; missing or
   * anything but `true` is off. */
  fullAccessSetupRequests?: boolean;
  /** The "Images" setting: whether an image render asks first. Absent means
   * follow the permission level (Full access and No limits make images with
   * no card); `ask` always asks; `allow` never asks, for the owner's own
   * turns (server/image-approval.ts). Spend authority, so desktop-set only,
   * and a restore resets it. */
  imageApproval?: "ask" | "allow";
  /** "Ask again after N images in one turn": the card comes back for the image
   * that would pass N. Absent means the default of 50. Only ever stricter. */
  imageAskAfter?: number;
  /** Optional model review of otherwise undecided, attended approval cards.
   * Unknown persisted values are treated as off by the review boundary. */
  autoReview?: "off" | "shadow" | "enforce";
  /** Bot learning settings (bot-learning.ts). Absent means the defaults:
   * learning from the owner on, ask-first off, prospect learning off. Changed
   * only through /api/bots/:id/learning, never through PATCH /api/bots/:id. */
  learning?: import("./bot-learning.ts").BotLearning;
  /** Tools this bot may always use without asking, even outside auto mode
   * (set by "Always allow" on an approval card). */
  alwaysAllow?: string[];
  /** Rule 57b: 2 once the grant route has stored a key of the three app
   * shapes for this bot; without it those keys are dropped at load. */
  grantSchema?: 2;
  /** Speak this bot's replies aloud as they settle, without being asked.
   * Off by default: a hosted voice costs money per character, so speaking
   * is something you turn on, never something that happens to you. */
  speakReplies?: boolean;
  /** This bot's own voice id, so a room of bots doesn't sound like one
   * person. Falls back to the app-wide voice in config. */
  voice?: string;
  /** The voice service this bot speaks with (its `voice` is one of that
   *  service's voices). Unset: the workspace's voice service. */
  voiceProvider?: "flux" | "xai" | "elevenlabs" | "system";
  /** true while `voice` is the default the app gave this bot (server/bot-voice.ts)
   *  rather than the owner's pick. Dropped on any edit of the voice. */
  voiceAssigned?: boolean;
  /** true after an edit/branch-switch rewound the visible conversation:
   * provider sessions still hold the abandoned branch, so the next turn
   * must start fresh (drop cursors) and replay the surviving path. */
  rewound?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  /** Optional labeled divider used to organize this bot in the sidebar. */
  section?: string;
  /** the one message pinned to the top of this bot's active thread; a pin
   * that no longer resolves (branch switched away, deleted) renders nothing */
  pinnedMessageId?: string;
  /** The coordinator for this bot's sidebar section. The store enforces
   * at most one Chief per section (including the unsectioned area). */
  chiefOfStaff?: boolean;
  /** Which tier this Chief occupies. Absent = today's meaning, unchanged:
   * the bot leads its own section. "workspace" = the single Chief of Staff
   * standing above the section leads. Meaningful only while `chiefOfStaff`
   * is true — one flag with one modifier, never two booleans that can
   * disagree. Deliberately NOT part of the published package format
   * (package-export.ts writes `chiefOfStaff` only), so no downloaded
   * package can install a bot that outranks the user's own Chief. */
  chiefScope?: "workspace";
  /** The other branch down from the Chief: this bot works alone, in its own
   * group, with NO team leader above it, reporting straight to the workspace
   * Chief of Staff. Explicit rather than inferred from "alone in a section",
   * because inferring it would mean adding a second bot to that group
   * silently demotes this one from "reports to the Chief" to "unreachable
   * member of a leaderless team" — a semantic flip with no visible cause.
   * Mutually exclusive with `chiefOfStaff` (opposite ends of the same
   * chart), enforced at both setters and de-duped on load. Like `chiefScope`
   * it is deliberately NOT part of the published package format
   * (package-export.ts writes `chiefOfStaff` only), so no downloaded package
   * can install a bot that reports to the user's own Chief. */
  individual?: boolean;
  /** Pause for human approval before this bot talks to a peer (ask_bot,
   * delegate_bot). Off by default: a chief-of-staff-style bot is most
   * useful when it can coordinate without nagging. */
  approvePeerComms?: boolean;
  /** "Who this bot can message" (SPEC-P 3.12, contract 4.3). Absent or
   * `team` = its own team plus its lead (`canReach`); `list` also allows the
   * named bots. It only ever widens `canReach`. An owner-only reach field:
   * set on the desktop, reset by a restore, never carried by a template,
   * package or import. */
  messageAllow?: { mode: "team" | "all" | "list"; botIds?: string[]; /** Picks added by another bot's two-way control; only that control removes them. */ grantedBy?: string[] };
  /** Whether this bot may use the workspace's connected apps (Composio).
   * Unset/true = allowed (the user configured the key deliberately);
   * false = this bot never receives the connection. Imported team members
   * start false — a shared persona must not reach the user's Gmail on
   * turn one. */
  composio?: boolean;
  /** Built-in skills attached to this bot that the owner switched off or on.
   * Only the workspace Chief has one today ("chief-of-staff", the Chief of
   * Staff guide); absent means on (skill-library.ts attachedSkillOn). */
  builtinSkills?: { "chief-of-staff"?: boolean };
  /** Whether its team's brief reaches this bot's turns. Absent means on;
   * the owner switches it off in "What shapes <bot>" (standing-context.ts). */
  teamBrief?: false;
  /** Whether the owner's About me reaches this bot's owner turns. Absent
   * means on; switched off in "What shapes <bot>" (about-me.ts). */
  aboutMe?: false;
  /** Continuity (PIP P1): the owner switched "Keep a continuous self" on for
   * this bot. Opposite polarity to teamBrief/aboutMe: absent means OFF and
   * only an exact `true` is stored; read it with `=== true`. The words live in
   * the installation memory, not here (server/memory/identity.ts). */
  continuity?: true;
  /** Continuity P2 settings (reflection, inner view, shadow). Meaningful only while `continuity` is true;
   * a hand-edited or orphaned value is dropped at load (parseContinuityOptions). */
  continuityOptions?: ContinuityOptions;
  continuityGeneration?: number;
  /** Owner-reviewed connected-account/tool limits; absent preserves legacy behavior. */
  connectedAppAccess?: ConnectedAppAccess;
  /** Sites this bot put online (server/publish): the bot may update or take
   * down only these. Absent means none. */
  publishedSites?: import("../shared/published-sites.ts").PublishedSite[];
  /** Monotonic identity fence; returning to an old role never revives requests. */
  accessRoleEpoch?: number;
  /** Whether this bot gets the app's built-in browser (the Browser tab of
   * the computer panel). On unless switched off. */
  browser?: boolean;
  /** Id of a named browser profile from config.browserProfiles; absent = the
   * bot's own private session. */
  browserProfile?: string;
  /** Owner opt-in: this bot's browser attaches to the owner's own running
   * Chrome (signed in as them) instead of an isolated profile. Absent = off.
   * At most one bot holds the legacy inspect route; extension bindings are isolated. */
  useMyChrome?: true;
  /** Explicit extension selection. Absent preserves the legacy inspect route. */
  browserTransport?: "extension";
  /** Opaque extension profile identity, never a browser profile filesystem path. */
  browserExtensionProfileId?: string;
  /** How often this bot's browser actions ask the owner (Murage for Chrome, spec 2.2). Absent = "task".
   * "full" is set only by the owner, from the desktop app, with the bot's name typed (PATCH
   * /api/bots/:id/browser-extension/mode); a restore resets it to absent. */
  browserApproval?: "step" | "task" | "full";
  /** Who double-checks a browser action before it runs: Flux (absent) or this bot's own engine. */
  browserActionCheck?: "flux" | "bot";
  /** Which browser the owner connected Murage for Chrome in for this bot, so
   * the next connection check does not ask again. Only with the extension. */
  browserExtensionBrowser?: "chrome" | "edge" | "brave";
  /** Public, package-authored playbooks installed for this bot. They carry
   * process guidance only—never executable code, credentials, or grants. */
  playbooks?: InstalledPlaybook[];
  /** Listing provenance and connector intent retained for package details
   * and future re-export. It never means the apps are authorized. */
  installedPackage?: InstalledPackageMetadata;
  /** Derived from `activity` — kept so the 200+ readers across the app and
   * tests keep working unchanged. Write through setActivity(), never here. */
  busy?: boolean;
  /** What the bot is doing right now, as the harness sees it. `busy` alone
   * could not tell working from waiting-on-you from a stalled engine.
   * Transient like busy: reset to idle on load. */
  activity?: BotActivity;
  createdAt: number;
}

export interface InstalledPlaybook {
  key: string;
  name: string;
  summary: string;
  triggers: string[];
  instructions: string;
}

const BOTS_FILE = join(DATA_DIR, "bots.json");
const GROUPS_FILE = join(DATA_DIR, "groups.json");
const messagesFile = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);

const COLORS: EmberColor[] = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
];

import { sectionKey, isWorkspaceChief, isIndividualAssistant, canReach, type ReachableBot } from "../shared/reach.ts";
export { sectionKey, isWorkspaceChief, isIndividualAssistant, canReach };
export type { ReachableBot };

/** Resolve @mentions in a message against a bot roster: `@` must start a
 * mention (after whitespace, an opening bracket or a Markdown marker), the
 * name must end on a Unicode word boundary (so "@New Bottle" never matches
 * "New Bot"), names match case-insensitively, longest name wins (so
 * "@New Bot 2" never half-matches "New Bot"), hidden bots skipped, results
 * deduped. The rule lives in shared/mention-boundary.ts so the composer's
 * preview routes the same way. Callers pre-filter the sender out of `peers`. */
export function mentionedBots<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  return mentionedPeers(text, peers);
}

/** Normalize persisted or API-provided routing. Old rooms did not have this
 * field; giving them their first member as lead fixes the old silent-send
 * behavior without making every prompt fan out to every model. */
export function normalizeGroupDefaultResponder(
  value: unknown,
  memberIds: string[],
  dm = false,
): GroupDefaultResponder {
  if (dm) return { kind: "mentions" };
  if (value && typeof value === "object") {
    const candidate = value as { kind?: unknown; botId?: unknown };
    if (candidate.kind === "everyone") return { kind: "everyone" };
    if (candidate.kind === "mentions") return { kind: "mentions" };
    if (candidate.kind === "auto") {
      const fallback = (candidate as { fallbackBotId?: unknown }).fallbackBotId;
      return typeof fallback === "string" && memberIds.includes(fallback) ? { kind: "auto", fallbackBotId: fallback } : { kind: "auto" };
    }
    if (
      candidate.kind === "member" &&
      typeof candidate.botId === "string" &&
      memberIds.includes(candidate.botId)
    ) {
      return { kind: "member", botId: candidate.botId };
    }
  }
  if (memberIds.length === 0) return { kind: "mentions" };
  return { kind: "member", botId: memberIds[0] };
}

/** Members a person addresses by plain name, without an @. Deliberately
 * conservative — only vocative forms count:
 *  - leading: "Moss, …", "Moss: …", "Moss — …", "Moss?", "Moss can you …",
 *    "Moss please …", a greeting first ("Hey Moss …", "Thanks Moss …"), or a
 *    leading list ("Moss and Sable, …", "Moss, Sable: …");
 *  - trailing: "…, Moss?" / "…, Moss." at the very end.
 * A name inside a sentence ("ask Moss later", "Moss's report", "Moss grows")
 * is a reference, not an address. Names match whole words, case-insensitively,
 * longest first; a multi-word name's first word also works as a short name
 * when no other member shares it. Hidden members are never addressed. */
export function addressedMembers<T extends { name: string; hidden?: boolean }>(text: string, members: T[], onMatch?: (member: T, at: number) => void): T[] {
  // A message can carry a part for each bot: "Moss: check the sensor" on one
  // line and "Sable, write it up" in a later sentence. Each part uses the
  // same vocative rule; "Sable wrote it" stays a reference.
  const found: T[] = [];
  // Pasted code and quoted lines are content, not parts addressed to anyone.
  const lines: Array<{ text: string; at: number }> = [];
  let offset = 0;
  let fence: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const at = offset + raw.indexOf(line);
    offset += raw.length + 1;
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) { if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null; continue; }
    if (marker) { fence = marker; continue; }
    if (line && !line.startsWith(">")) lines.push({text: line, at});
  }
  for (const line of lines) {
    let offset = 0;
    for (const sentence of line.text.split(/(?<=[.!?])\s+/)) {
      const at = line.text.indexOf(sentence, offset);
      offset = at + sentence.length;
      for (const member of addressedInPart(sentence, members, { trailing: true })) {
        if (!found.includes(member)) {
          found.push(member);
          const lower = sentence.toLowerCase(), name = member.name.toLowerCase();
          const nameAt = lower.indexOf(name);
          onMatch?.(member, line.at + at + (nameAt >= 0 ? nameAt : lower.indexOf(name.split(" ")[0])));
        }
      }
    }
  }
  return found;
}

/** A short noun phrase ("my co-founder", "the designer"), not a clause with
 * a verb ("the build is failing"). */
function appositionNounPhrase(phrase: string): boolean {
  return phrase.trim().split(" ").length <= 5
    && !/\b(?:is|are|was|were|be|been|being|am|has|have|had|do|does|did|isn't|aren't|wasn't|weren't|hasn't|haven't|don't|doesn't|didn't|will|would|can|could|should|shall|may|might|must|won't|can't|failing|failed|broken|broke|keeps?|needs?|seems?|looks?)\b/.test(phrase);
}

/** Whether what follows an apposition reads as a statement about the named
 * member ("wrote it", "is out today", "runs the review") rather than a
 * request of them ("fix it", "can you check it?"). A question is a request
 * ("the build, is it green?"; "Juno, who ran the deploy, did the migration
 * finish?") unless its subject is the member as he or she, or as they after
 * a relative clause ("Juno, who wrote it, is she around?"), and so is an
 * auxiliary before a pronoun even without the mark ("the deploy, did it
 * work", "is it sorted"), except before a reflexive ("did it all himself")
 * or, after has/have/had, a finished state ("has this covered"). A word
 * ending in -ed or -s reads as a verb about the member only when it is not
 * an imperative of that shape ("embed it", "focus on the flaky one", "shred
 * them"). */
function statementAboutMember(after: string, relative = false): boolean {
  if (/^(?:can|could|would|will|won't)\s+you\b|^(?:please|pls)\b/.test(after)) return false;
  const member = relative ? /^(?:[\p{L}'’]+\s+)?(?:he|she|him|her|they)\b/u : /^(?:[\p{L}'’]+\s+)?(?:he|she|him|her)\b/u;
  if (/\?\s*$/.test(after) && !member.test(after)) return false;
  const pronoun = relative ? "it|this|that|these|those|you|we|i" : "it|they|this|that|these|those|you|we|i";
  if (new RegExp(`^(?:is|was|are|were|has|have|had|do|does|did|will|would|can|could|should|isn't|wasn't|aren't|weren't|hasn't|haven't|doesn't|don't|didn't|won't|can't)\\s+(?:${pronoun})\\b`).test(after)
    && !/^\S+\s+\S+\s+(?:all\s+)?(?:by\s+)?(?:himself|herself|themselves|themself)\b/.test(after)
    && !/^(?:has|have|had)\s+\S+\s+(?:covered|handled|sorted)\b/.test(after)) return false;
  const word = /^[\p{L}'’-]+/u.exec(after)?.[0] ?? "";
  return /^(?:is|was|are|were|has|had|will|would|can|could|should|shall|may|might|must|does|did|isn't|wasn't|aren't|weren't|hasn't|hadn't|doesn't|didn't|won't|can't|couldn't|wouldn't|shouldn't|also|already|just|never|always|still|often|once|really|and|wrote|made|built|said|told|found|took|gave|ran|sent|left|went|came|got|knew|thought|saw|began|kept|brought|bought|drew|led|met|paid|sold|spent|won|lost|chose|forgot|held)$/.test(word)
    || (/[^e]ed$/.test(word) && !IMPERATIVE_ED.test(word))
    || (/^[\p{L}'’-]{2,}[^s'’]s$/u.test(word) && !/(?:us|is)$/.test(word));
}

/** Imperatives that end in -ed, not past tenses ("embed it", "shred them"). */
const IMPERATIVE_ED = /^(?:embed|imbed|shed|shred|wed|bed|sled)$/;

function addressedInPart<T extends { name: string; hidden?: boolean }>(text: string, members: T[], options: { trailing: boolean }): T[] {
  const available = members.filter((member) => !member.hidden && member.name.trim());
  const spoken = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");
  const firstWord = (member: T) => spoken(member.name).split(" ")[0];
  const aliases: Array<{ alias: string; member: T }> = available.map((member) => ({ alias: spoken(member.name), member }));
  for (const member of available) {
    const short = firstWord(member);
    if (short.length < 2 || short === spoken(member.name)) continue;
    const shared = available.some((other) => other !== member && (firstWord(other) === short || spoken(other.name) === short));
    if (!shared) aliases.push({ alias: short, member });
  }
  aliases.sort((a, b) => b.alias.length - a.alias.length);
  const lower = text.trim().replace(/\s+/g, " ").toLowerCase();
  const nameAt = (at: number) => aliases.find(({ alias }) =>
    lower.startsWith(alias, at) && !/[\p{L}\p{N}'’_-]/u.test(lower[at + alias.length] ?? "")) ?? null;

  // Leading vocative, optionally after a greeting and as a short list.
  const greeting = /^(?:hey|hi|hello|yo|ok|okay|thanks|thank you)\b[\s,!]*/.exec(lower);
  let at = greeting ? greeting[0].length : 0;
  const found: T[] = [];
  for (;;) {
    const hit = nameAt(at);
    if (!hit) break;
    if (!found.includes(hit.member)) found.push(hit.member);
    at += hit.alias.length;
    const joiner = /^\s*(?:,|and\b|&)\s*/.exec(lower.slice(at));
    if (joiner && nameAt(at + joiner[0].length)) { at += joiner[0].length; continue; }
    const rest = lower.slice(at);
    // An apposition or relative clause describes the name ("Pax, my
    // co-founder, wrote it"; "Juno, who wrote it, is out today") when a
    // statement about the member follows. A determiner clause is an
    // apposition only as a short noun phrase: "Pax, the build is failing,
    // fix it" and "Pax, the release notes, check them" are requests.
    const clause = /^\s*,\s*(the|a|an|my|our|his|her|their|who|whom|whose|which)\s+([^,]+),\s*([\s\S]*)$/.exec(rest);
    const relative = Boolean(clause && /^(?:who|whom|whose|which)$/.test(clause[1]));
    if (clause && (relative || appositionNounPhrase(clause[2])) && statementAboutMember(clause[3], relative)) return [];
    const vocative = /^\s*(?:[,:;!?]|—|–|\s-\s|\.?\s*$)/.test(rest)
      || /^\s+(?:can you|could you|would you|will you|please|pls)\b/.test(rest)
      || (Boolean(greeting) && /^(?:\s|$)/.test(rest));
    return vocative ? found : [];
  }
  if (found.length || !options.trailing) return [];
  // Trailing vocative: "…, Moss?" at the very end of the message.
  const trailing = /,\s*([^,]+?)\s*[.!?]*$/.exec(lower);
  if (trailing) {
    const start = lower.length - trailing[0].length + trailing[0].indexOf(trailing[1]);
    const hit = nameAt(start);
    if (hit && start + hit.alias.length === start + trailing[1].length) return [hit.member];
  }
  return [];
}

/** Resolve the bots invoked by a human room message. Explicit targets win;
 * then (for a person's message) a member addressed by plain name; then a
 * reply to an active member's message addresses that member; otherwise the
 * room policy chooses one member, everyone, or nobody. A bot's reply never
 * routes by plain name: bots are told to use their teammates' plain names to
 * refer to them and @Name only to summon them. */
export function roomResponders<T extends { id: string; name: string; hidden?: boolean }>(
  text: string,
  members: T[],
  defaultResponder: GroupDefaultResponder,
  replyToBotId?: string,
  options: { byName?: boolean; leadFirstBotId?: string } = {},
): T[] {
  const available = members.filter((member) => !member.hidden);
  const ordered = (list: T[]) => options.leadFirstBotId
    ? [...list.filter(m => m.id === options.leadFirstBotId), ...list.filter(m => m.id !== options.leadFirstBotId)] : list;
  if (mentionsEveryone(text)) return ordered(available);
  const positions = new Map<T, number>();
  const remember = (member: T, at: number) => positions.set(member, Math.min(positions.get(member) ?? Infinity, at));
  const mentioned = mentionedPeers(text, available, remember);
  const addressed = options.byName ? addressedMembers(text, available, remember) : [];
  if (mentioned.length || addressed.length) {
    return ordered([...new Set([...mentioned, ...addressed])].sort((a, b) => positions.get(a)! - positions.get(b)!));
  }
  const repliedTo = replyToBotId ? available.find((member) => member.id === replyToBotId) : undefined;
  if (repliedTo) return [repliedTo];
  if (defaultResponder.kind === "everyone") return available;
  if (defaultResponder.kind === "member") {
    const lead = available.find((member) => member.id === defaultResponder.botId);
    return lead ? [lead] : [];
  }
  if (defaultResponder.kind === "auto") {
    // Synchronous fallback = what a lead-mode room does today. The decision
    // model may override it afterwards (index.ts startGroupTurn).
    const lead = available.find((member) => member.id === defaultResponder.fallbackBotId) ?? available[0];
    return lead ? [lead] : [];
  }
  return [];
}

/** The one question a new bot opens with, as the bot asking it rather than
 * a four-button quiz. No chips: a chip row here is the old quiz wearing a
 * different coat, and the composer is already on screen as the free-text
 * answer. Every later turn of the conversation is appended by the intake
 * route, never seeded here. */
const intakeOpeningQuestion = (): OptionCardData => ({
  title: "What do you actually want me for?",
  subtitle: "Plain words are fine. One line will do.",
  options: [],
  intake: { step: "open", asked: 1 },
});

/** Messages form a tree (forks appear when a message is edited); the
 * visible conversation is the path from the root to activeLeafId. */
/** A bot's task array by thread (Store.taskIndex). */
interface TaskThreadIndex { length: number; byThread: Map<string, { task: TaskRecord; index: number }>; desks: Map<string, TaskRecord[]> }
/** One place a thread has in a room: the room's own thread (pos -1, the room is the holder) or its task at `pos` (that task holds). */
interface RoomThreadPlace { group: GroupRecord; groupIndex: number; pos: number; task?: GroupTaskRecord }
/** The rooms by thread (Store.groupThreadIndex): `byThread` the first room holding the thread, as a walk of every room found it;
 * `tasks` each room's first task per thread, as groupTaskByThread's walk found it; `places` every place of a thread, in walk order. */
interface GroupThreadIndex { byThread: Map<string, GroupRecord>; tasks: Map<GroupRecord, Map<string, GroupTaskRecord>>; places: Map<string, RoomThreadPlace[]> }

interface ThreadState {
  messages: Message[];
  activeLeafId: string | null;
}

/** Open request cards a thread frame carries beside its page. */
export const OPEN_CARDS_BESIDE_PAGE = 50;
/** Unanswered cards looked at when choosing the ones beside a page. */
const OPEN_CARD_CANDIDATES = 200;

/** About 20 threads or 200 MB of parsed transcript, whichever comes first. */
export const THREAD_CACHE_ENTRIES = 20;
export const THREAD_CACHE_BYTES = 200 * 1024 * 1024;

/** A cheap size estimate taken when a thread is cached: text, screen pixels
 * and a flat allowance per row for the parsed object. */
function threadStateBytes(state: ThreadState): number {
  let bytes = 0;
  for (const m of state.messages) bytes += messageBytes(m);
  return bytes;
}

/** One held message's share of threadStateBytes. */
const messageBytes = (m: Message): number => 512 + (m.text?.length ?? 0) * 2 + (m.png?.length ?? 0);

/** bots.json never carries runtime activity: `busy`/`activity` are transient
 * per bot and per task, so every writer (ordinary saves and the package
 * transaction) serializes the same durable shape. */
function persistedBotsJson(bots: readonly BotRecord[]): string {
  return JSON.stringify(bots.map(({ busy: _busy, activity: _activity, ...bot }) => ({
    ...bot,
    tasks: bot.tasks?.map(({ busy: _taskBusy, activity: _taskActivity, waitingFor: _taskWaitingFor, turnStartedAt: _taskTurnStartedAt, ...task }) => task),
  })));
}

/** What Store.appendMessage accepts, and what a rewrite returns (or null). */
export type NewMessage = Omit<Message, "id" | "at"> & { at?: number };
export type MessageRewrite = (threadId: string, message: NewMessage) => NewMessage | null;

/** An id index over a loaded thread's rows, kept beside the array and extended as rows are appended, so a lookup by id costs the same at any
 * length. Rows are replaced in place or appended; a removal changes the length or the last row, and either makes the index start again. */
const messageIndexes = new WeakMap<Message[], { ids: Map<string, number>; covered: number; lastId: string | undefined }>();
function indexedMessage(messages: Message[], id: string): Message | undefined {
  let index = messageIndexes.get(messages);
  const stale = !index || index.covered > messages.length || (index.covered > 0 && messages[index.covered - 1]?.id !== index.lastId);
  if (stale) { index = { ids: new Map(), covered: 0, lastId: undefined }; messageIndexes.set(messages, index); }
  const kept = index!;
  for (; kept.covered < messages.length; kept.covered += 1) kept.ids.set(messages[kept.covered].id, kept.covered);
  kept.lastId = messages[kept.covered - 1]?.id;
  const at = kept.ids.get(id);
  if (at === undefined) return undefined;
  if (messages[at]?.id === id) return messages[at];
  // moved under the index: look once more from scratch
  messageIndexes.delete(messages);
  return messages.find((message) => message.id === id);
}

/** How many of the newest rows an append to a thread that is not loaded
 * reads: the owner-message follow-up needs the last 40. An onboarding card still
 * open is found by index (mdb.openOnboardingCards), however old. */
const APPEND_TAIL_ROWS = 40;
/** Most rows a bounded backward look (Store.scanNewest, Store.onActiveBranchNear)
 * reads: far more than one turn writes, and the same for any thread length. */
export const TURN_SCAN_ROWS = 5_000;
/** Rows a backward look reads per statement. */
const SCAN_PAGE_ROWS = 200;
const LOADED_SLICE_ROWS = 2_000;
/** Rows of the branch an export holds at once. */
const EXPORT_PAGE_ROWS = 200;
/** Rows of a thread counted per keyed read when an export takes its row cap. */
const EXPORT_COUNT_PAGE_ROWS = 5_000;
/** Newest screen frames read to prune an unloaded thread's (4 keep pixels). */
const SCREEN_FRAMES_READ = 8;
/** Rows of other turns a look for a turn's closing reply steps over before it
 * takes the turn to be behind it (a queued line, a note between its rows). */
const TURN_TERMINAL_GAP = 64;
/** Most open request cards one sweep of a thread reads (boot settles them). */
const OPEN_CARD_SWEEP_LIMIT = 10_000;
/** Threads or records a pending-work walk looks at before it hands the loop back (pendingThreadsForSliced, reconcilePendingWork). */
const PENDING_SLICE = 256;
/** How many of a thread's newest rows a duplicate-send check looks through for the line a retried send already made: a
 * send is retried within moments, so its line is among the newest rows; the same work for a thread of a thousand rows
 * as for one of two hundred thousand. (Not a bound on anything a bot sees.) */
export const RECENT_SEND_ROWS = 1000;

/** A legacy onboarding suggestion card the person has not yet typed past. */
function isOnboardingSuggestion(message: Message): boolean {
  return message.kind === "options" &&
    !!message.card &&
    !message.card.requestId &&
    !message.card.intake &&
    // A first-run card is not an onboarding suggestion the person has
    // moved past by typing; it IS the conversation they are typing into.
    // Dismissing it here would delete the step they are standing on the
    // first time they answer their Chief in words.
    !message.card.setup &&
    !message.card.dismissed;
}

export class Store {
  bots: BotRecord[] = [];
  groups: GroupRecord[] = [];
  /** Threads whose holder has pending held work: held continuations, owed external updates, or a queue row still to settle. The
   * 30 s held drain visits only these, so an idle installation costs nothing per thread. Every write that changes pending work
   * updates it (notePendingHolder); it is rebuilt from the records at load and reconciled hourly (reconcilePendingWork). */
  private pendingWork: Set<string> | null = null;
  /** Per task array (an array is replaced on every add or remove; the length catches an in-place change): threadId -> first task with
   * that thread and its position, and a project's desk tasks by project (channelProjectDesk is set only when a task is created). */
  private taskThreadIndexes = new WeakMap<TaskRecord[], TaskThreadIndex>();
  /** The rooms by thread, valid while the groups and their task arrays keep their shape (groupThreadIndex). */
  private groupThreadCache: { groups: GroupRecord[]; shape: unknown[]; index: GroupThreadIndex } | null = null;
  /** Loaded threads, least recently used first out (THREAD_CACHE_*). */
  /** Unsubscribes this store from the numbering walk (a test that builds many stores). */
  readonly stopSeqStamps: () => void;
  /** Where each id sits in a held thread's array, for the walk's stamps: rebuilt when a position no longer names the id. */
  private seqPlaces = new WeakMap<ThreadState, Map<string, number>>();
  private stampSeq(threadId: string, stamps: ReadonlyArray<readonly [string, number]>, flipped: () => boolean): void {
    const t = this.threads.peek(threadId);
    if (!t) return;
    let places = this.seqPlaces.get(t);
    for (const [id, seq] of stamps) {
      let at = places?.get(id);
      if (at === undefined || t.messages[at]?.id !== id) {
        places = new Map(t.messages.map((message, index) => [message.id, index]));
        this.seqPlaces.set(t, places);
        at = places.get(id);
      }
      if (at !== undefined) t.messages[at]!.seq = seq;
    }
    if (flipped()) {
      // never evicted: a turn in flight holds references to these objects; only their order changes, once
      t.messages.sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));
      this.seqPlaces.delete(t);
    }
  }

  /** Whether the thread is numbered (every row carries `seq`): its deliveries are numbered ones (transcript-page.ts wireThread). */
  threadNumbered(threadId: string): boolean { return mdb.threadIsNumbered(threadId); }
  /** The thread's MAX(seq) at this moment (0 when empty), undefined while it is not numbered: what `newestSeq` on the wire says. */
  newestSeq(threadId: string): number | undefined { return mdb.newestSeq(threadId); }
  /** One row's number, or null (no such row, or not numbered yet). */
  messageSeq(threadId: string, messageId: string): number | null { return mdb.messageSeq(threadId, messageId); }

  private threads = new LruMap<ThreadState>(THREAD_CACHE_ENTRIES, THREAD_CACHE_BYTES, threadStateBytes, (threadId) => this.threadInFlight(threadId));
  /** Threads with a write under way (Store.writing), by nesting depth. */
  private writes = new Map<string, number>();
  private defaultSelection: () => ModelSelection;
  private listeners = new Set<(change: StoreChange) => void>();
  private accessRoles = new Map<string, string>();
  private legacyActivities = new Map<string, BotActivity>();

  /** Workspace new-bot defaults (config newBots), applied by createBot. */
  private completeNewBotSelection: (selection: ModelSelection) => ModelSelection;

  private memoryReady = true;
  finishSharingBoot(): void { this.memoryReady = true; reconcileMemoryRoster(this, { unlessUnchanged: true }); }

  constructor(defaultSelection: () => ModelSelection, completeNewBotSelection: (selection: ModelSelection) => ModelSelection = (selection) => selection, deferMemoryReconcile = false) {
    // A load reads the files: any deferred write from an earlier instance lands first.
    flushCoalesced();
    this.memoryReady = !deferMemoryReconcile;
    // the numbering walk stamps the threads held in memory in place, and sorts one by number once when it flips (r7 R1)
    this.stopSeqStamps = onSeqNumbered((threadId, stamps, flipped) => this.stampSeq(threadId, stamps, flipped));
    this.completeNewBotSelection = completeNewBotSelection;
    this.defaultSelection = defaultSelection;
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    // The registries carry souls, project paths and per-bot settings: owner
    // only like routines and webhooks (upstream #1620). Older releases wrote
    // them 0644.
    for (const file of [BOTS_FILE, GROUPS_FILE]) tightenOwnerOnlyFile(file);
    // Validate both inputs before any migration can save either collection.
    // Only an absent file is a fresh install; damaged state needs recovery.
    this.bots = readPersistedRecords<BotRecord>(BOTS_FILE);
    this.groups = readPersistedRecords<GroupRecord>(GROUPS_FILE);
    for (const bot of this.bots) this.accessRoles.set(bot.id, accessRoleBinding({ ...bot, accessRoleEpoch: 0 }));
    // busy never survives a restart — no turn does either. Rooms saved
    // before default responders existed adopt their first member as lead.
    let botsMigrated = false;
    const browserProfileAliases = loadBrowserProfileIdAliases();
    const chiefSectionsSeen = new Set<string>();
    let userChromeSeen = false;
    let groupsMigrated = false;
    for (const b of this.bots) {
      // transient state never survives a restart — and if a previous
      // process died mid-turn, bots.json still says busy/working; persist
      // the reset so the next load does not read it again
      if (b.busy || (b.activity !== undefined && b.activity !== "idle")) botsMigrated = true;
      b.busy = false;
      b.activity = "idle";
      if (b.browserProfile) {
        const browserProfile = browserProfileAliases.get(b.browserProfile);
        if (browserProfile && browserProfile !== b.browserProfile) {
          b.browserProfile = browserProfile;
          botsMigrated = true;
        }
      }
      // Malformed extension state must never become a legacy inspect opt-in.
      if (b.browserTransport !== undefined && b.browserTransport !== "extension") {
        delete b.browserTransport;
        delete b.useMyChrome;
        botsMigrated = true;
      }
      if (b.browserExtensionBrowser !== undefined && (b.browserTransport !== "extension" || !["chrome", "edge", "brave"].includes(b.browserExtensionBrowser))) {
        delete b.browserExtensionBrowser;
        botsMigrated = true;
      }
      if (b.browserExtensionProfileId !== undefined && (b.browserTransport !== "extension" || typeof b.browserExtensionProfileId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(b.browserExtensionProfileId))) {
        delete b.browserExtensionProfileId;
        delete b.useMyChrome;
        botsMigrated = true;
      }
      // Only legacy inspect shares one browser-wide connection. Extension bots
      // retain separate explicit tab grants across restart.
      if (b.useMyChrome !== undefined && (b.useMyChrome !== true || (b.browserTransport !== "extension" && userChromeSeen))) {
        delete b.useMyChrome;
        botsMigrated = true;
      }
      if (b.useMyChrome && b.browserTransport !== "extension") userChromeSeen = true;
      // "task" is the default and is stored as absent; anything unknown is dropped, never read as "full".
      if (b.browserApproval !== undefined && b.browserApproval !== "step" && b.browserApproval !== "full") {
        delete b.browserApproval;
        botsMigrated = true;
      }
      if (b.browserActionCheck !== undefined && b.browserActionCheck !== "flux" && b.browserActionCheck !== "bot") {
        delete b.browserActionCheck;
        botsMigrated = true;
      }
      if (b.cloudBackend !== undefined && b.cloudBackend !== "box" && b.cloudBackend !== "vps") {
        delete b.cloudBackend;
        botsMigrated = true;
      }
      if (b.autoStartVps !== undefined && b.autoStartVps !== true && b.autoStartVps !== false) {
        delete b.autoStartVps;
        botsMigrated = true;
      }
      // The Images setting keeps only an exact non-default value, and its
      // guard only a whole number from 1 to 50; anything else reads as the
      // default (follow the permission level, no limit).
      if (b.imageApproval !== undefined && imageApprovalOf(b.imageApproval) === undefined) {
        delete b.imageApproval;
        botsMigrated = true;
      }
      if (b.imageAskAfter !== undefined && imageAskAfterOf(b.imageAskAfter) === undefined) {
        delete b.imageAskAfter;
        botsMigrated = true;
      }
      // Keep the well-formed site records only.
      if (b.publishedSites !== undefined) {
        const sites = readPublishedSites(b.publishedSites);
        if (JSON.stringify(sites) !== JSON.stringify(b.publishedSites)) {
          if (sites.length === 0) delete b.publishedSites; else b.publishedSites = sites;
          botsMigrated = true;
        }
      }
      // Only an exact false is stored; anything else reads as on.
      if (b.teamBrief !== undefined && b.teamBrief !== false) {
        delete b.teamBrief;
        botsMigrated = true;
      }
      if (b.aboutMe !== undefined && b.aboutMe !== false) {
        delete b.aboutMe;
        botsMigrated = true;
      }
      // Continuity is off unless exactly true; a hand-edited value never turns it on.
      if (b.continuity !== undefined && b.continuity !== true) {
        delete b.continuity;
        botsMigrated = true;
      }
      // Its options are kept only when Continuity is on and the stored value still validates.
      if (b.continuityOptions !== undefined) {
        const parsed = b.continuity === true ? parseContinuityOptions(b.continuityOptions) : undefined;
        if (!parsed || !parsed.ok) {
          delete b.continuityOptions;
          botsMigrated = true;
        } else if (JSON.stringify(parsed.value) !== JSON.stringify(b.continuityOptions)) {
          if (parsed.value) b.continuityOptions = parsed.value; else delete b.continuityOptions;
          botsMigrated = true;
        }
      }
      // One shape for "no voice note": absent. A blank or whitespace-only
      // persona would otherwise put an empty `Personality:` line in front of
      // the model, and a hand-edited bots.json must not smuggle a second
      // brief past the cap the UI enforces.
      if (b.persona !== undefined) {
        const persona =
          typeof b.persona === "string" ? b.persona.trim().slice(0, BOT_PROFILE_LIMITS.persona) : "";
        if (!persona) {
          delete b.persona;
          botsMigrated = true;
        } else if (persona !== b.persona) {
          b.persona = persona;
          botsMigrated = true;
        }
      }
      const avatar = botAvatarProfile(b);
      if (b.avatarUrl !== undefined && avatar.avatarUrl !== b.avatarUrl) {
        delete b.avatarUrl;
        botsMigrated = true;
      }
      if (b.avatarCrop !== undefined && avatar.avatarCrop !== b.avatarCrop) {
        delete b.avatarCrop;
        botsMigrated = true;
      }
    }
    // One workspace Chief, the same way there is one Chief per section. A
    // hand-edited or merged bots.json naming two keeps the first; a
    // `chiefScope` on a bot that is not a Chief at all has no meaning and is
    // dropped, so the flag and its modifier can never disagree on disk.
    //
    // Runs BEFORE the per-section pass, not after: an extra workspace tier is
    // dropped here, which leaves that bot an ordinary section-tier Chief, and
    // the section pass below is then the thing that decides whether its
    // section already has one. In the other order the demotion happened after
    // the only pass that could have caught the collision.
    let workspaceChiefSeen = false;
    for (const b of this.bots) {
      if (b.chiefScope !== "workspace") continue;
      if (b.chiefOfStaff && !workspaceChiefSeen) {
        workspaceChiefSeen = true;
        continue;
      }
      delete b.chiefScope;
      botsMigrated = true;
    }
    for (const b of this.bots) {
      if (!b.chiefOfStaff) continue;
      // The workspace Chief is not any section's lead — it sits above all of
      // them — so it never occupies the one slot this pass rations, and it is
      // de-duped globally by the pass above instead. Without this, a workspace
      // that never created a section (every bot on sectionKey "") could not
      // hold a Chief of Staff and a team leader at the same time: whichever
      // record came second lost its role on the next load.
      const workspaceChief = b.chiefScope === "workspace";
      const key = sectionKey(b.section);
      if (workspaceChief || !chiefSectionsSeen.has(key)) {
        if (!workspaceChief) chiefSectionsSeen.add(key);
        // A section's main contact must stay reachable in the sidebar.
        if (b.hidden) {
          b.hidden = false;
          botsMigrated = true;
        }
        continue;
      }
      b.chiefOfStaff = false;
      botsMigrated = true;
    }
    // The two branches under the Chief are exclusive: a bot either leads a
    // team (or the workspace) or works alone beneath the Chief. A record
    // claiming both is meaningless, so the role that carries a team wins and
    // the lone-worker flag is dropped — the same way a `chiefScope` with no
    // role above is dropped. A persisted `individual: false` is normalised
    // away too, so absent is the only way "no" is ever spelled on disk.
    for (const b of this.bots) {
      if (b.individual === undefined) continue;
      if (b.individual === true && !b.chiefOfStaff) continue;
      delete b.individual;
      botsMigrated = true;
    }
    // Peer grants originally used mutable display names (ask_bot:@Helper).
    // Convert only when exactly one bot has that name; ambiguous legacy
    // entries remain inert rather than granting access to the wrong bot.
    for (const b of this.bots) {
      if (!b.alwaysAllow?.length) continue;
      let changed = false;
      const migrated = b.alwaysAllow.map((key) => {
        const match = key.match(/^(ask_bot|delegate_bot):@(.+)$/);
        if (!match) return key;
        const candidates = this.bots.filter((candidate) => candidate.name === match[2]);
        if (candidates.length !== 1) return key;
        changed = true;
        return peerAllowKey(match[1] as PeerAction, candidates[0]!.id);
      });
      if (changed) {
        b.alwaysAllow = [...new Set(migrated)];
        botsMigrated = true;
      }
    }
    // Every bot has a voice: one with none is given a default, once.
    if (assignMissingVoices(this.bots)) botsMigrated = true;
    for (const g of this.groups) {
      g.busyBotId = null;
      delete g.turnStartedAt;
      const normalized = normalizeGroupDefaultResponder(g.defaultResponder, g.memberIds, Boolean(g.dm));
      if (JSON.stringify(normalized) !== JSON.stringify(g.defaultResponder)) groupsMigrated = true;
      g.defaultResponder = normalized;
      // Bot-to-bot channels intentionally remain one canonical thread.
      if (g.dm) {
        if (g.tasks !== undefined) {
          delete g.tasks;
          groupsMigrated = true;
        }
        continue;
      }
      if (!g.tasks?.length) {
        const initialTask: GroupTaskRecord = {
          threadId: g.threadId,
          title: this.firstUserLine(g.threadId) ?? UNTITLED_TASK,
          createdAt: g.createdAt,
        };
        if (g.pinnedCwd !== undefined) initialTask.pinnedCwd = g.pinnedCwd;
        if (g.pinnedMessageId) initialTask.pinnedMessageId = g.pinnedMessageId;
        g.tasks = [initialTask];
        groupsMigrated = true;
      }
      // Repair a malformed/stale active pointer conservatively. Every task
      // transcript is retained; the newest known task becomes active.
      let active = g.tasks.find((task) => task.threadId === g.threadId);
      if (!active) {
        active = g.tasks[0]!;
        g.threadId = active.threadId;
        groupsMigrated = true;
      }
      g.pinnedCwd = active.pinnedCwd;
      g.pinnedMessageId = active.pinnedMessageId;
    }
    for (const group of this.groups) for (const holder of [group, ...(group.tasks ?? [])]) {
      for (const item of holder.heldContinuations ?? []) if (!item.botId || !item.dispatcher || !item.principal) {
        item.state = "recovery"; item.error = "Authorize this saved continuation before it can run."; groupsMigrated = true;
      } else if (item.error && !item.state) { item.state = "authority"; groupsMigrated = true; }
    }
    if (groupsMigrated) this.saveGroups();
    // bots saved before tasks existed have one endless thread; adopt it as
    // their first task so nothing is lost and nothing special-cases it
    for (const b of this.bots) {
      if (!b.tasks?.length) b.tasks = [
        {
          threadId: b.threadId,
          title: this.firstUserLine(b.threadId) ?? UNTITLED_TASK,
          createdAt: b.createdAt,
          resumeCursors: b.resumeCursors ?? {},
        },
      ];
      if (!b.tasks.some(task=>task.threadId===b.threadId)) b.tasks.unshift({threadId:b.threadId,title:this.firstUserLine(b.threadId)??UNTITLED_TASK,createdAt:b.createdAt,resumeCursors:b.resumeCursors??{}});
      for (const task of b.tasks) {
        for (const item of task.heldContinuations ?? []) if (!item.botId || !item.dispatcher || !item.principal) {
          item.botId = b.id; item.state = "recovery"; item.error = "Authorize this saved continuation before it can run."; botsMigrated = true;
        } else if (item.error && !item.state) { item.state = "authority"; botsMigrated = true; }
        if (task.modelSelection === undefined) { task.modelSelection=structuredClone(b.modelSelection); botsMigrated=true; }
        if (task.autoApprove === undefined) { task.autoApprove=b.autoApprove===true; botsMigrated=true; }
        if (task.alwaysAllow === undefined) { task.alwaysAllow=structuredClone(b.alwaysAllow??[]); botsMigrated=true; }
        if (task.unread === undefined) { task.unread=task.threadId===b.threadId&&b.unread; botsMigrated=true; }
        task.resumeCursors ??= task.threadId===b.threadId?structuredClone(b.resumeCursors??{}):{};
        if (task.threadId===b.threadId) { task.rewound??=b.rewound; task.pinnedMessageId??=b.pinnedMessageId; }
        task.busy=false;task.activity="idle";delete task.waitingFor;delete task.turnStartedAt;
      }
      b.unread=b.tasks.some(task=>task.unread);
    }
    // A question is answered by its owner every time. Older builds offered
    // "Always allow" on a question tool (Claude's AskUserQuestion reached the
    // permission card), so strip any such remembered grant — from the bot
    // and from every task that inherited or recorded one. Runs after task
    // adoption above so a freshly inherited copy is cleaned too.
    for (const b of this.bots) {
      for (const holder of [b, ...(b.tasks ?? [])] as { alwaysAllow?: string[] }[]) {
        if (!holder.alwaysAllow?.length) continue;
        // ...and any connected-app grant not in a shape the current key
        // builder writes: every action at once, every "other" tool, Pi's label
        // (shared/app-action-grant.ts). The owner is asked again, per action.
        // ...and a command tool's bare name (an older PowerShell grant): its
        // next command asks again and is remembered by program (1.0.4 G09-3)
        const kept = withoutBareCommandGrants(withoutPreSchemaGrants(withoutStaleGrants(withoutQuestionGrants(holder.alwaysAllow)), b.grantSchema));
        if (kept.length === holder.alwaysAllow.length) continue;
        holder.alwaysAllow = kept;
        botsMigrated = true;
      }
    }
    if (botsMigrated) this.saveBots();
    // Search reads SQLite directly, so migrate every known legacy transcript
    // at startup rather than waiting until the user happens to open it. Only
    // pending JSON files are touched; already-migrated threads stay lazy.
    const knownThreads = new Set([
      ...this.bots.flatMap((b) => [b.threadId, ...(b.tasks ?? []).map((task) => task.threadId)]),
      ...this.groups.flatMap((group) => [group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]),
    ]);
    for (const threadId of knownThreads) {
      const legacyFile = messagesFile(threadId);
      // A thread that already has rows is not read: readThread would load all of them (one whole-thread read per conversation, 29 s for 12,000 on
      // a heavy install) only to return, because the import below it runs only for a thread with no rows.
      if (existsSync(legacyFile) && !mdb.threadHasRows(threadId)) mdb.readThread(threadId, legacyFile);
    }
    // The one-time Auto confirmation starts from what each bot has already
    // done, once per record: a bot that already used this computer keeps
    // using it without a surprise prompt. After this every bot has a value,
    // so evidence created later can never grant it silently.
    const unevaluated = this.bots.filter((b) => !isHostComputerConsent(b.hostComputerConsent));
    if (unevaluated.length) {
      const evidence = mdb.threadsWithAllowedHostActions();
      for (const b of unevaluated) b.hostComputerConsent = grandfatheredHostComputerConsent(b, evidence);
      this.saveBots();
    }
    if (this.memoryReady && !teamChangeOpen()) reconcileMemoryRoster(this);
    // Capture reads the live roster: a room's threads and project desk
    // threads capture into the room's memory (memory/capture-scope.ts).
    setMemoryCaptureRoster(() => this);
    setExecutionStore(this);
    if (!teamChangeOpen() && markPartitions(this)) this.saveGroups();
    // pending held work is found once from the records, so nothing saved before a restart waits on a write that never comes again
    this.pendingWork = this.scanPendingWork();
  }

  /** Persist bots.json. Immediate by default: the write is durable when this
   * returns and a failure throws, which the security, owner, consent, delivery
   * and delete call sites rely on. `defer` is only for cosmetic, high-rate state
   * (unread badges, which task is open): the write is coalesced to once per
   * 250 ms, always carries the newest in-memory state, and is flushed on exit,
   * SIGTERM and before any backup. A hard crash may lose about 250 ms of it.
   * Also used for the three per-turn writes (setResumeCursor, markTaskDispatched,
   * addTaskUsage): a crash inside the window can lose only the newest resume
   * cursor (the engine resumes from the one before, or replays the transcript),
   * the last-engine marker, or one turn's usage tally and its idempotency key
   * (banked in the same write, so they stay consistent). Messages live in
   * SQLite and are never in this file. */
  private saveBots(bots: BotRecord[] = this.bots, options: { defer?: boolean } = {}) {
    this.recordRevision++;
    if (options.defer && bots === this.bots) { scheduleCoalesced(BOTS_FILE, () => this.saveBotsNow()); return; }
    this.saveBotsNow(bots);
    if (bots === this.bots) cancelCoalesced(BOTS_FILE);
  }

  private saveBotsNow(bots: BotRecord[] = this.bots) {
    // Role/config changes permanently revoke scoped grants. Write the revoked
    // candidate before publishing it so changing a role back cannot resurrect access.
    const normalized = bots.map(bot => {
      const identity = accessRoleBinding({ ...bot, accessRoleEpoch: 0 });
      const prior = this.accessRoles.get(bot.id);
      const next = prior !== undefined && prior !== identity ? { ...bot, accessRoleEpoch: (bot.accessRoleEpoch ?? 0) + 1 } : bot;
      return next.connectedAppAccess === undefined ? next : { ...next, connectedAppAccess: botAccessPolicy(next) };
    });
    // Busy and activity never reach disk, so most saves (a turn starting or
    // ending, a badge) leave the persisted roster byte for byte as it was. Then
    // there is nothing to write and no memory roster to re-persist.
    const json = persistedBotsJson(normalized);
    const mode = !this.memoryReady || teamChangeOpen() ? "plain" : "memory";
    const key = `${mode}\0${json}\0${this.groups.length ? JSON.stringify(this.groups.map(({ busyBotId: _b, turnStartedAt: _t, ...g }) => g)) : ""}`;
    if (key === this.lastRosterKey && existsSync(BOTS_FILE)) { this.afterRosterSave(bots, normalized); return; }
    const write = () => writeFileAtomic(BOTS_FILE, json, { mode: 0o600 });
    if (mode === "plain") write(); else persistMemoryRoster({ bots: normalized, groups: this.groups }, write);
    this.lastRosterKey = key;
    this.afterRosterSave(bots, normalized);
  }

  /** What the last roster save wrote (mode, bots.json, groups). */
  private lastRosterKey: string | undefined;

  private afterRosterSave(bots: BotRecord[], normalized: BotRecord[]) {
    // The channels save against the roster being written, not the live one it replaces:
    // a stale label there would give a moved team's old name a fresh memory scope.
    if (!teamChangeOpen() && markPartitions({ bots: normalized, groups: this.groups })) this.saveGroupsNow(normalized);
    for (const next of normalized) {
      this.accessRoles.set(next.id, accessRoleBinding({ ...next, accessRoleEpoch: 0 }));
      const supplied = bots.find(bot => bot.id === next.id);
      const live = this.bots.find(bot => bot.id === next.id);
      for (const target of [supplied, live]) {
        if (!target) continue;
        if (next.accessRoleEpoch !== undefined) target.accessRoleEpoch = next.accessRoleEpoch;
        if (next.connectedAppAccess !== undefined) target.connectedAppAccess = next.connectedAppAccess;
      }
    }
  }

  /** Prepare an additive import without changing memory or emitting events.
   * The caller durably commits all returned files before calling publish. */
  preparePackageAddition(bots: BotRecord[], groups: GroupRecord[]) {
    const ids = new Set(this.bots.map(bot => bot.id));
    const threads = new Set(this.bots.flatMap(bot => [bot.threadId, ...(bot.tasks ?? []).map(task => task.threadId)]));
    for (const bot of bots) {
      if (ids.has(bot.id) || threads.has(bot.threadId) || bot.chiefOfStaff || bot.chiefScope || bot.autoApprove
        || bot.alwaysAllow?.length || Object.keys(bot.resumeCursors).length || bot.tasks?.some(task => task.threadId !== bot.threadId || Object.keys(task.resumeCursors).length)
        || bot.composio !== false || bot.browser !== false || bot.computer !== "off") throw new Error("A package bot must be new and start with no access");
      ids.add(bot.id); threads.add(bot.threadId);
    }
    const groupIds = new Set(this.groups.map(group => group.id));
    const newBotIds = new Set(bots.map(bot => bot.id));
    for (const group of groups) {
      if (groupIds.has(group.id) || threads.has(group.threadId) || group.memberIds.some(id => !newBotIds.has(id))) throw new Error("A package team must be new and hold only its own new bots");
      groupIds.add(group.id); threads.add(group.threadId);
    }
    const nextBots = [...this.bots, ...bots];
    const nextGroups = [...this.groups, ...groups];
    return {
      files: new Map([
        ["bots.json", Buffer.from(persistedBotsJson(nextBots))],
        ["groups.json", Buffer.from(JSON.stringify(nextGroups.map(({ busyBotId: _busy, turnStartedAt: _turnStartedAt, ...group }) => group), null, 2))],
      ]),
      publish: () => {
        this.bots = nextBots; this.groups = nextGroups;
        // a package's records come with whatever they hold: the pending set looks at their threads once
        this.refreshPendingThreads([...bots.flatMap(bot => [bot.threadId, ...(bot.tasks ?? []).map(task => task.threadId)]), ...groups.flatMap(group => [group.threadId, ...(group.tasks ?? []).map(task => task.threadId)])]);
        if (this.memoryReady && !teamChangeOpen()) reconcileMemoryRoster(this);
        for (const bot of bots) this.emit({ type: "bot", botId: bot.id });
        for (const group of groups) this.emit({ type: "group", groupId: group.id });
      },
    };
  }

  markPartitions(): void { if (!teamChangeOpen() && markPartitions(this)) this.saveGroups(); }

  /** Persist groups.json; same contract as saveBots (immediate unless `defer`). */
  private saveGroups(bots: BotRecord[] = this.bots, options: { defer?: boolean } = {}) {
    this.recordRevision++; // a channel's tasks and members are records too (task-window.ts, shared-wire.ts)
    if (options.defer && bots === this.bots) { scheduleCoalesced(GROUPS_FILE, () => this.saveGroupsNow()); return; }
    this.saveGroupsNow(bots);
    if (bots === this.bots) cancelCoalesced(GROUPS_FILE);
  }

  private saveGroupsNow(bots: BotRecord[] = this.bots) {
    if (!teamChangeOpen()) markPartitions({ bots, groups: this.groups });
    const write = () => writeFileAtomic(GROUPS_FILE, JSON.stringify(this.groups.map(({ busyBotId: _busyBotId, turnStartedAt: _turnStartedAt, ...g }) => g), null, 2), { mode: 0o600 });
    if (!this.memoryReady || teamChangeOpen()) write(); else persistMemoryRoster({ bots, groups: this.groups }, write);
  }

  // ── groups ────────────────────────────────────────────────────────────
  /** Subscribe to every write. Listeners run after the write and after
   * save; a throwing listener never breaks the write. */
  onChange(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private recordRevision = 0;
  /** Changes on any bot, task, usage or grant write (every one saves the roster or announces a change), so something built from the
   * records can be kept until it moves instead of rebuilt per broadcast (task-window.ts). */
  get revision(): number { return this.recordRevision; }

  private emit(change: StoreChange) {
    // A transcript message is not a record: it changes no bot, channel or task field (the unread count and activity those messages
    // cause emit their own bot or group change), so it leaves the revision, and anything kept by it, alone.
    if (change.type !== "message" && change.type !== "message.patch") this.recordRevision++;
    // Inside an open transaction nothing is announced until the outermost one commits; a rolled-back
    // write must never reach a listener or a client (see tx-scope.ts).
    if (inTxScope()) { afterCommit(() => this.emit(change)); return; }
    // every message write passes here (append, insert before or after, resend): the thread's last activity moves with it
    if (change.type === "message") { const was = this.lastActivity.get(change.threadId); if (was === undefined || was === null || change.message.at > was) this.lastActivity.set(change.threadId, change.message.at); }
    // A bot, task or room going idle releases its thread's pin (threadInFlight):
    // the cache is trimmed then, not at the next write, which may never come.
    if (change.type === "bot" || change.type === "group") this.threads.evict();
    if (change.type === "message" && change.message.kind !== "screen" && (change.message.kind !== "activity" || isErrorActivity(change.message) || ("actorKind" in change.message && change.message.actorKind === "murage"))) {
      const group = this.groupByThread(change.threadId);
      const task = group?.threadId !== change.threadId && group?.tasks?.find(task => task.threadId === change.threadId);
      if (group && task) {
        task.unreadCount = (task.unreadCount ?? 0) + 1;
        this.saveGroups(this.bots, { defer: true });
        this.emit({ type: "group", groupId: group.id });
      }
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        console.error("store: change listener threw", error);
      }
    }
  }

  group(id: string): GroupRecord | undefined {
    return this.groups.find((g) => g.id === id);
  }

  groupByThread(threadId: string): GroupRecord | undefined {
    return this.groupThreadIndex().byThread.get(threadId);
  }

  /** The same answers as walks of every group and its tasks (first group wins), from maps rebuilt only when a group, its thread or its
   * task array changes. The check is one look per room, never per task. */
  private groupThreadIndex(): GroupThreadIndex {
    const groups = this.groups, cached = this.groupThreadCache;
    const shape = cached?.shape;
    let same = Boolean(cached && cached.groups === groups && shape!.length === groups.length * 4);
    for (let i = 0; same && i < groups.length; i++) {
      const group = groups[i]!;
      same = shape![i * 4] === group && shape![i * 4 + 1] === group.threadId && shape![i * 4 + 2] === group.tasks && shape![i * 4 + 3] === group.tasks?.length;
    }
    if (same) return cached!.index;
    const index: GroupThreadIndex = { byThread: new Map(), tasks: new Map(), places: new Map() }, next: unknown[] = [];
    const place = (threadId: string, entry: RoomThreadPlace) => {
      const places = index.places.get(threadId);
      if (places) places.push(entry); else index.places.set(threadId, [entry]);
    };
    groups.forEach((group, groupIndex) => {
      next.push(group, group.threadId, group.tasks, group.tasks?.length);
      if (!index.byThread.has(group.threadId)) index.byThread.set(group.threadId, group);
      place(group.threadId, { group, groupIndex, pos: -1 });
      const tasks = new Map<string, GroupTaskRecord>();
      (group.tasks ?? []).forEach((task, pos) => {
        if (!index.byThread.has(task.threadId)) index.byThread.set(task.threadId, group);
        if (!tasks.has(task.threadId)) tasks.set(task.threadId, task);
        place(task.threadId, { group, groupIndex, pos, task });
      });
      index.tasks.set(group, tasks);
    });
    this.groupThreadCache = { groups, shape: next, index };
    return index;
  }

  /** A bot's task array by thread, built once per array (see taskThreadIndexes). */
  private taskIndex(tasks: TaskRecord[] | undefined): TaskThreadIndex | undefined {
    if (!tasks) return undefined;
    let index = this.taskThreadIndexes.get(tasks);
    if (!index || index.length !== tasks.length) {
      const byThread = new Map<string, { task: TaskRecord; index: number }>(), desks = new Map<string, TaskRecord[]>();
      tasks.forEach((task, i) => {
        if (!byThread.has(task.threadId)) byThread.set(task.threadId, { task, index: i });
        const desk = task.channelProjectDesk?.groupId;
        if (desk) { const list = desks.get(desk); if (list) list.push(task); else desks.set(desk, [task]); }
      });
      index = { length: tasks.length, byThread, desks };
      this.taskThreadIndexes.set(tasks, index);
    }
    return index;
  }

  /** Every thread a remote client may read or search.
   *
   * The same answer `sse-visibility.ts` gives one frame at a time, in the
   * shape a SQL `WHERE` can take: routes that page or grep have to state the
   * set up front, because a post-filter runs after `LIMIT` and would return
   * fewer rows than asked for — or none at all while matches exist.
   *
   * Two exclusions, each for its own reason:
   *  - hidden bots, and their task threads: the filter the sidebar and
   *    `/api/team-map` already apply;
   *  - `dm` rooms: the bot⇄bot channels the harness auto-creates for
   *    `ask_bot` exchanges. Machine chatter, and the highest-volume thing in
   *    the database — leaving them in makes a search useless as well as leaky.
   *
   * `plan-security.md` §5 proposed a third — rooms every one of whose members
   * is hidden — and it is deliberately not here. The sidebar shows those
   * rooms (`src/lib/sidebar-layout.ts` filters rooms on `dm` alone), so
   * excluding them would put a conversation in the user's sidebar that the
   * search cannot find. It would also make this function disagree with
   * `visibleToCompanion`, which answers the same question one frame at a
   * time; two definitions of "visible" is how a stream and a page end up
   * telling a client different things about the same room.
   *
   * A surface filter, not an authorization model. It decides what a remote
   * door is shown, not what exists; anything that has to be a boundary needs
   * a boundary, not this. */
  visibleThreadIds(): string[] {
    const ids = new Set<string>();
    for (const bot of this.bots) {
      if (bot.hidden) continue;
      ids.add(bot.threadId);
      for (const task of bot.tasks ?? []) ids.add(task.threadId);
    }
    for (const group of this.groups) {
      // An archived channel is filed away for the same reason a hidden bot
      // is, so it answers the same way: it still exists and the desktop can
      // still open it, but a remote door is not shown it.
      if (group.dm || group.hidden) continue;
      ids.add(group.threadId);
      for (const task of group.tasks ?? []) ids.add(task.threadId);
    }
    return [...ids];
  }

  createGroup(
    name: string,
    memberIds: string[],
    dm = false,
    section?: string,
    setup?: {
      bulletin?: string;
      defaultResponder?: GroupDefaultResponder;
      completed?: boolean;
    },
    dmAudience?: GroupRecord["dmAudience"],
  ): GroupRecord {
    assertSectionUnlocked();
    const threadId = newId();
    const createdAt = Date.now();
    const group: GroupRecord = {
      id: newId(),
      threadId,
      name,
      memberIds,
      defaultResponder: dm
        ? { kind: "mentions" }
        : normalizeGroupDefaultResponder(setup?.defaultResponder, memberIds, false),
      bulletin: setup?.bulletin ?? "",
      unread: false,
      createdAt,
      dm: dm || undefined,
      ...(dmAudience ? { dmAudience } : {}),
      busyBotId: null,
      section,
      // hand-offs in rooms made by this release go through the ask tool
      ...(dm ? {} : { mentionChain: false }),
    };
    if (!dm) {
      group.tasks = [{ threadId, title: UNTITLED_TASK, createdAt }];
      group.setupCompletedAt = setup?.completed ? createdAt : null;
      group.setupSkippedAt = null;
    }
    this.groups.unshift(group);
    this.saveGroups();
    this.emit({ type: "group", groupId: group.id });
    return group;
  }

  /** Materialise the already committed desktop project creation record. */
  materializeProjectGroup(group: GroupRecord): GroupRecord {
    const existing = this.group(group.id);
    if (existing) return existing;
    this.groups.unshift(group);
    try { this.saveGroups(); }
    catch (error) { this.groups = this.groups.filter(entry => entry !== group); throw error; }
    this.emit({ type: "group", groupId: group.id });
    return group;
  }

  /** SPEC-P 4 [AMB-8]: a channel from before the turn engine keeps the
   * one-hop @mention chain it always had. Every non-pair, non-project room
   * with no `mentionChain` field is from before (rooms made since carry
   * `false`), so it gets `true` once. Idempotent; a restore keeps the field. */
  markPreUpgradeMentionChains(): number {
    let marked = 0;
    for (const group of this.groups) {
      if (group.dm || group.channelProject || group.mentionChain !== undefined) continue;
      group.mentionChain = true;
      marked += 1;
    }
    if (marked) this.saveGroups();
    return marked;
  }

  /** The bot⇄bot channel for a pair, if it exists (order-insensitive). */
  dmGroup(a: string, b: string): GroupRecord | undefined {
    return this.groups.find(
      (g) => g.dm && g.memberIds.length === 2 && g.memberIds.includes(a) && g.memberIds.includes(b),
    );
  }

  patchGroup(id: string, patch: Partial<Pick<GroupRecord, "name" | "memberIds" | "defaultResponder" | "bulletin" | "unread" | "busyBotId" | "cwd" | "pinnedMessageId" | "section" | "setupCompletedAt" | "setupSkippedAt" | "hidden" | "channelProject">>): GroupRecord | null {
    if (Object.hasOwn(patch, "section") || Object.hasOwn(patch, "memberIds")) assertSectionUnlocked();
    const group = this.group(id);
    if (!group) return null;
    const previousBusyBotId = group.busyBotId;
    Object.assign(group, patch);
    // The room's elapsed readout counts the speaker's turn from its claim:
    // stamped on every change to a busy speaker, cleared when the room idles.
    if (Object.prototype.hasOwnProperty.call(patch, "busyBotId")) {
      if (patch.busyBotId && patch.busyBotId !== previousBusyBotId) group.turnStartedAt = Date.now();
      else if (!patch.busyBotId) delete group.turnStartedAt;
    }
    if (!group.dm && Object.prototype.hasOwnProperty.call(patch, "pinnedMessageId")) {
      const active = this.activeGroupTask(group.id);
      if (active) active.pinnedMessageId = patch.pinnedMessageId;
    }
    group.defaultResponder = normalizeGroupDefaultResponder(
      group.defaultResponder,
      group.memberIds,
      Boolean(group.dm),
    );
    this.saveGroups();
    this.emit({ type: "group", groupId: group.id });
    return group;
  }

  /** A thread's durable record: DB rows plus any legacy JSON leftovers. */
  private deleteThreadRecord(threadId: string) {
    this.threads.delete(threadId);
    this.lastActivity.delete(threadId);
    mdb.deleteThread(threadId);
    for (const file of [messagesFile(threadId), `${messagesFile(threadId)}.imported`]) {
      try {
        unlinkSync(file);
      } catch {}
    }
    this.emit({ type: "thread.deleted", threadId });
  }

  deleteGroup(id: string): boolean {
    const group = this.group(id);
    if (!group) return false;
    // The owner's deletion is recorded durably BEFORE the registry forgets the channel: boot repair deletes a missing
    // channel's project rows (and the words in them) only against this record, never on mere absence from groups.json.
    // ...together with every conversation of it, so a crash before the per-thread cleanup below leaves proof for each
    // thread's rows (sends, room requests), not only for the channel.
    const groupThreadIds = [...new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)])];
    transaction((db) => {
      recordOwnerDeletion(db, groupDeletionKey(id));
      for (const threadId of groupThreadIds) recordOwnerDeletion(db, threadId);
    });
    this.groups = this.groups.filter((g) => g.id !== id);
    this.refreshPendingThreads(groupThreadIds);
    this.saveGroups();
    // Cross-store order (SPEC-P section 2): the JSON save above first, the
    // messages.db rows second, one transaction. A crash between them leaves
    // orphan rows the boot reconciler (reconcileProjectRecords) deletes.
    // Lane E1 will route the open-request cancellation through
    // completeRequest once it owns dispatch.
    transaction((db) => deleteProjectRows(db, id, Date.now()));
    for (const threadId of new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)])) {
      this.deleteThreadRecord(threadId);
    }
    this.emit({ type: "group.deleted", groupId: id, group });
    return true;
  }

  /** Set or clear the archive stamp on every desk task of a project
   * (SPEC-P 3.12): Close and End project set it, Reopen and "Make this a
   * project" clear it. The task record itself is never removed. */
  setChannelProjectDeskArchived(groupId: string, archivedAt?: number): void {
    let touched = false;
    // the project's desks by the task index: a closed project's 30 s sync looks at its desks, never every task of every bot
    for (const bot of this.bots) {
      for (const task of this.taskIndex(bot.tasks)?.desks.get(groupId) ?? []) {
        if (task.channelProjectDesk?.groupId !== groupId || task.channelProjectDesk.archivedAt === archivedAt) continue;
        if (archivedAt === undefined) delete task.channelProjectDesk.archivedAt;
        else task.channelProjectDesk = { ...task.channelProjectDesk, archivedAt };
        touched = true;
        this.emit({ type: "bot", botId: bot.id });
      }
    }
    if (touched) this.saveBots();
  }

  /** A process restart cannot preserve an in-flight room orchestrator. Close
   * every durable working receipt before clients load it, including manual
   * goals that do not have a RoutineRun record to reconcile separately. */
  reconcileInterruptedGroupGoals(
    resolve?: (
      runId: string,
      threadId: string,
    ) => {
      status: Exclude<GroupGoalRunCardData["status"], "working">;
      detail: string;
      finishedAt: number;
    } | null,
    fallbackDetail = "Murage restarted before this goal finished.",
    fallbackFinishedAt = Date.now(),
  ): number {
    const ownedThreadIds = new Set<string>();
    for (const group of this.groups) {
      ownedThreadIds.add(group.threadId);
      for (const task of group.tasks ?? []) ownedThreadIds.add(task.threadId);
    }
    // load() already migrated every legacy transcript file into SQLite, so
    // this recovery query is proportional to unfinished goals, not history.
    let recovered = 0;
    for (const hit of mdb.workingGoalRunMessages()) {
      if (!ownedThreadIds.has(hit.threadId) || !hit.message.goalRun) continue;
      const resolution = resolve?.(hit.message.goalRun.runId, hit.threadId) ?? {
        status: "failed" as const,
        detail: fallbackDetail,
        finishedAt: fallbackFinishedAt,
      };
      const state = resolution.status === "needs-input"
        ? "needs your input"
        : resolution.status === "limit-reached"
          ? "reached its turn limit"
          : resolution.status;
      this.patchMessage(hit.threadId, hit.message.id, {
        text: `Goal ${state}: ${resolution.detail}`,
        goalRun: {
          ...hit.message.goalRun,
          status: resolution.status,
          detail: resolution.detail,
          finishedAt: resolution.finishedAt,
        },
      });
      recovered += 1;
    }
    return recovered;
  }

  /** A process restart cannot resume a 1:1 turn either. Every thread whose
   * visible end is the person's own message had a turn in flight (or a send
   * that never got one), and no answer is coming: append the same kind of
   * restart marker routines, memory turns and team goals already get, so the
   * transcript never shows two user messages in a row with nothing between
   * them (F7). Appending makes the marker the new branch head, so a second
   * boot does not repeat it. */
  reconcileInterruptedDirectTurns(note: string): number {
    const ownedThreadIds = new Set<string>();
    for (const bot of this.bots) {
      ownedThreadIds.add(bot.threadId);
      for (const task of bot.tasks ?? []) ownedThreadIds.add(task.threadId);
    }
    let recovered = 0;
    for (const hit of mdb.threadsEndingOnUserMessage()) {
      if (!ownedThreadIds.has(hit.threadId)) continue;
      this.appendMessage(hit.threadId, murageLine({
        role: "bot",
        kind: "activity",
        tool: { name: note, ok: false },
      }));
      recovered += 1;
    }
    return recovered;
  }

  /** reconcileInterruptedDirectTurns for a heavy history: the same marker for the same threads, found in slices of thread_state with the loop
   * handed back between them, after the server already listens. A thread whose last message is the person's own is only marked when that message was
   * written before `bootAt` (a send made since the start is a live turn or a queued send, never an interrupted one). */
  async reconcileInterruptedDirectTurnsInBackground(note: string, bootAt: number, options: { rows?: number; budgetMs?: number; now?: () => number; pause?: () => Promise<void>; hasLiveTurn?: (threadId: string) => boolean } = {}): Promise<number> {
    const pause = options.pause ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
    // a slice is bounded by time (about SWEEP_SLICE_MS of loop), not by a row count; `rows` only caps it
    const sizer = sliceSizer({ max: options.rows ?? 400, budgetMs: options.budgetMs });
    const clock = options.now ?? (() => performance.now());
    // built once (a heavy install has many bots and tasks; the roster does not change while the sweep runs)
    const ownedThreadIds = new Set<string>();
    for (const bot of this.bots) {
      ownedThreadIds.add(bot.threadId);
      for (const task of bot.tasks ?? []) ownedThreadIds.add(task.threadId);
    }
    let recovered = 0;
    const mark = (hit: { threadId: string; message: Message }) => {
      if (!ownedThreadIds.has(hit.threadId) || !(Number(hit.message.at) < bootAt) || options.hasLiveTurn?.(hit.threadId)) return;
      // the thread may have moved on since the row was read (a send made after the start): a point read of its branch head, never its transcript
      if (this.appendAfterHead(hit.threadId, hit.message.id, murageLine({ role: "bot", kind: "activity", tool: { name: note, ok: false } }))) recovered += 1;
    };
    // An ordinary start reads only the turns the writers kept as in flight (direct_turn_inflight), never the history.
    if (mdb.directTurnsWalked()) {
      for (const hit of mdb.inflightDirectTurns()) mark(hit);
      return recovered;
    }
    // The first start of a file that predates that table: one walk over thread_state, in slices, then the walk is marked done.
    const high = mdb.threadStateHighWater();
    for (let after = 0; after < high;) {
      const rows = sizer.next(), t0 = clock();
      for (const hit of mdb.threadsEndingOnUserMessageSlice(after, after + rows)) mark(hit);
      sizer.took(rows, clock() - t0);
      after += rows;
      await pause();
    }
    mdb.markDirectTurnsWalked();
    return recovered;
  }

  /** A crash mid-"Checking the browser" leaves that note on screen as the
   * conversation's leaf, a check that can never finish (boot recovery only
   * looks for a trailing user message). Every pending checking note is
   * abandoned: the one that ends its thread becomes the restart marker, any
   * other settles to the "try again" wording. The pending notes come from a
   * partial index, and each is patched as its own row: no history is scanned
   * and no transcript is loaded. Idempotent (a settled note leaves the index). */
  reconcileAbandonedBrowserChecks(interruptedNote: string, notAfter?: number): number {
    let settled = 0;
    // Index not built yet: skip, never fall back to a history scan; the background walker builds it and runs this again when it is complete
    // (with `notAfter`: only notes written before this launch began, so a check running now is never taken for an abandoned one).
    for (const hit of mdb.pendingBrowserCheckRows() ?? []) {
      if (notAfter !== undefined && !(Number(hit.message.at) < notAfter)) continue;
      const tool = hit.isLeaf
        ? { name: interruptedNote, ok: false }
        : { name: browserUnavailableActivityName(BROWSER_CHECK_FAILED_REASON), ok: true };
      if (this.patchMessageRow(hit.threadId, hit.message, { tool })) settled += 1;
    }
    return settled;
  }

  /** Patch one message by id without loading its thread. A thread already in memory goes through patchMessage (its cache stays right); otherwise one
   * row is read, merged and rewritten, and the same message.patch event goes out. Never hydrates a transcript, so a 20,000-row thread costs one row. */
  patchMessagePoint(threadId: string, messageId: string, patch: Partial<Message>): Message | null {
    if (this.threads.has(threadId)) return this.patchMessage(threadId, messageId, patch);
    const current = mdb.readMessage(threadId, messageId);
    return current ? this.patchMessageRow(threadId, current, patch) : null;
  }

  /** Patch one message whose row is already in hand. A thread already in memory goes through patchMessage (its cache stays right); otherwise only that row is rewritten, so the transcript is never loaded. */
  private patchMessageRow(threadId: string, current: Message, patch: Partial<Message>): Message | null {
    if (this.threads.has(threadId)) return this.patchMessage(threadId, current.id, patch);
    const next = sanitizeMessageDiagnostic({ ...current, ...boundRemovedText(patch), card: patch.card ?? current.card });
    mdb.updateMessage(threadId, next);
    this.emit({ type: "message.patch", threadId, message: next, before: current });
    return next;
  }

  // ── channel tasks ────────────────────────────────────────────────────
  groupTasks(groupId: string): GroupTaskRecord[] {
    const group = this.group(groupId);
    return group?.dm ? [] : (group?.tasks ?? []);
  }

  activeGroupTask(groupId: string): GroupTaskRecord | undefined {
    const group = this.group(groupId);
    return group?.tasks?.find((task) => task.threadId === group.threadId);
  }

  groupTaskByThread(groupId: string, threadId: string): GroupTaskRecord | undefined {
    const group = this.group(groupId);
    if (!group || group.dm) return undefined;
    return this.groupThreadIndex().tasks.get(group)?.get(threadId);
  }

  createGroupTask(groupId: string, title?: string, activate = true): GroupTaskRecord | null {
    const group = this.group(groupId);
    if (!group || group.dm) return null;
    const task: GroupTaskRecord = {
      threadId: newId(),
      title: title?.trim().slice(0, 80) || UNTITLED_TASK,
      createdAt: Date.now(),
    };
    group.tasks = [task, ...(group.tasks ?? [])];
    if (activate) {
      group.threadId = task.threadId;
      group.pinnedCwd = undefined;
      group.pinnedMessageId = undefined;
    }
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return task;
  }

  switchGroupTask(groupId: string, threadId: string): GroupRecord | null {
    const group = this.group(groupId);
    const task = group?.tasks?.find((candidate) => candidate.threadId === threadId);
    if (!group || group.dm || !task) return null;
    group.threadId = task.threadId;
    task.unreadCount = 0;
    group.pinnedCwd = task.pinnedCwd;
    group.pinnedMessageId = task.pinnedMessageId;
    this.saveGroups(this.bots, { defer: true });
    this.emit({ type: "group", groupId });
    return group;
  }

  renameGroupTask(groupId: string, threadId: string, title: string): GroupTaskRecord | null {
    const task = this.groupTaskByThread(groupId, threadId);
    if (!task) return null;
    task.title = title.trim().slice(0, 80) || UNTITLED_TASK;
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return task;
  }

  titleGroupTaskFromFirstMessage(groupId: string, text: string, threadId?: string) {
    const task = threadId ? this.groupTaskByThread(groupId, threadId) : this.activeGroupTask(groupId);
    if (!task || task.title !== UNTITLED_TASK) return;
    task.title = titleFromMessage(text);
    this.saveGroups();
    this.emit({ type: "group", groupId });
  }

  deleteGroupTask(groupId: string, threadId: string): GroupRecord | null {
    const group = this.group(groupId);
    if (!group || group.dm || !group.tasks?.some((task) => task.threadId === threadId)) return null;
    // A channel always has a conversation. Deleting the last one used to be
    // refused, silently in the channel view; it now leaves a fresh one.
    if (group.tasks.length < 2) this.createGroupTask(groupId, undefined, false);
    group.tasks = group.tasks.filter((task) => task.threadId !== threadId);
    this.refreshPendingThreads([threadId]);
    this.deleteThreadRecord(threadId);
    if (group.threadId === threadId) {
      const next = group.tasks[0]!;
      group.threadId = next.threadId;
      group.pinnedCwd = next.pinnedCwd;
      group.pinnedMessageId = next.pinnedMessageId;
    }
    this.saveGroups();
    this.emit({ type: "group", groupId });
    return group;
  }

  /** Toggle an emoji reaction on a message ("user" or a member botId). */
  toggleReaction(threadId: string, messageId: string, emoji: string, by: string): Message | null {
    const existing = this.messageById(threadId, messageId);
    if (!existing) return null;
    const reactions = existing.reactions ?? [];
    const at = reactions.findIndex((r) => r.emoji === emoji && r.by === by);
    const next = at >= 0 ? reactions.filter((_, i) => i !== at) : [...reactions, { emoji, by }];
    return this.patchMessage(threadId, messageId, { reactions: next.length ? next : undefined });
  }

  /** A thread the cache must keep: a write to it is under way, or a turn or
   * stream is running on it (a busy bot or task on that thread, a room whose
   * member is speaking). Evicting it would only reload it on the next row. */
  private threadInFlight(threadId: string): boolean {
    if (this.writes.has(threadId)) return true;
    return this.bots.some((bot) => (bot.busy && bot.threadId === threadId) || Boolean(bot.tasks?.some((task) => task.busy && task.threadId === threadId)))
      || this.groups.some((group) => Boolean(group.busyBotId) && group.threadId === threadId);
  }

  /** Run a write to one thread: the thread is never evicted while it runs,
   * and the cache re-checks its caps once the outermost write ends. */
  private writing<T>(threadId: string, run: () => T): T {
    // The cache is updated as the write happens so later reads in the same transaction see it; if an
    // enclosing transaction rolls back, the thread is dropped and reloads from the committed rows.
    if (inTxScope()) onRollback(() => this.threads.delete(threadId));
    this.writes.set(threadId, (this.writes.get(threadId) ?? 0) + 1);
    try {
      return run();
    } finally {
      const left = (this.writes.get(threadId) ?? 1) - 1;
      if (left) this.writes.set(threadId, left);
      else { this.writes.delete(threadId); this.threads.evict(); }
    }
  }

  /** A held thread's rows grew (or shrank) by `delta` bytes in place. Only
   * the cached state is counted: a write to a state already evicted is in
   * SQLite and nowhere else. */
  private grew(threadId: string, t: ThreadState, delta: number): void {
    if (this.threads.peek(threadId) === t) this.threads.adjust(threadId, delta);
  }

  /** Bytes of parsed transcript the loaded-thread cache holds (its estimate). */
  cachedThreadBytes(): number { return this.threads.bytes; }

  /** Resize the loaded-thread cache (tests, and a host that wants a tighter cap). */
  setThreadCacheLimits(entries: number, bytes: number): void { this.threads.limits(entries, bytes); }
  /** Thread ids currently held in memory, least recently used first. */
  cachedThreadIds(): string[] { return this.threads.keys(); }

  private thread(threadId: string): ThreadState {
    const t = this.threads.get(threadId);
    if (t) return t;
    // SQLite is the source of truth; a thread with no rows imports its
    // legacy messages-<threadId>.json once, inside readThread
    return this.cacheThread(threadId, mdb.readThread(threadId, messagesFile(threadId)));
  }

  /** The read-side transform every loaded row receives: diagnostic
   * sanitization, and legacy rows (no parentId) chained to the row before
   * them in stored order. `previous` seeds that chain for a bounded slice. */
  private loadedMessages(stored: Message[], previous: Message | null = null): Message[] {
    const messages = stored.map(sanitizeMessageDiagnostic);
    let prev: string | null = previous?.id ?? null;
    for (const m of messages) {
      if (m.parentId === undefined) m.parentId = prev;
      prev = m.id;
    }
    return messages;
  }

  /** Cache a COMPLETE thread. Never call this with a bounded page that may
   * omit older rows: every later messagesFor() would treat it as the whole
   * transcript. */
  private cacheThread(threadId: string, rows: mdb.ThreadRows): ThreadState {
    const messages = this.loadedMessages(rows.messages);
    const activeLeafId = rows.activeLeafId || (messages.at(-1)?.id ?? null);
    const t = { messages, activeLeafId };
    this.threads.set(threadId, t);
    return t;
  }

  /** A display page of `limit` messages ending at the newest message, or
   * just before `before`. Same order, hasMore and active leaf as slicing the
   * full history, but an uncached thread reads only the page from SQLite
   * instead of materializing its whole transcript. A bounded result is never
   * cached; a newest page that turns out to be the entire thread is cached as
   * a full load. Null only when a non-empty `before` is not in this thread. */
  messagePage(
    threadId: string,
    limit: number,
    before?: string | null,
  ): { messages: Message[]; hasMore: boolean; activeLeafId: string | null } | null {
    // `newestSeq` is not part of a page here: the delivery gate (transcript-page.ts wireThread) adds it in the same synchronous step
    // as the read, so a page is wholly legacy or wholly numbered (r8 R8)
    if (!this.threads.has(threadId)) {
      const slice = before ? mdb.readThreadBefore(threadId, before, limit) : mdb.readThreadNewest(threadId, limit);
      if (slice && (before || slice.hasMore || limit === 0)) {
        return {
          messages: this.loadedMessages(slice.messages, slice.previous),
          hasMore: slice.hasMore,
          activeLeafId: mdb.readActiveLeafOrNewest(threadId),
        };
      }
      if (slice) this.cacheThread(threadId, { messages: slice.messages, activeLeafId: mdb.readActiveLeafOrNewest(threadId) });
      else if (before && mdb.threadHasRows(threadId)) return null;
      // No rows yet: the full path performs any one-time legacy import.
    }
    const t = this.thread(threadId);
    const end = before ? t.messages.findIndex((message) => message.id === before) : -1;
    if (before && end === -1) return null;
    const stop = end === -1 ? t.messages.length : end;
    const start = Math.max(0, stop - limit);
    return { messages: t.messages.slice(start, stop), hasMore: start > 0, activeLeafId: t.activeLeafId };
  }

  /** How many of the newest messages a newest page must hold so that every
   * open request card and the active branch head are in it (0 for an empty
   * thread). A client that hydrates by page renders approvals and the visible
   * branch from what it holds, so those rows may not fall off the front of
   * the page (upstream #1527). An uncached thread answers from SQLite without
   * materializing its transcript. */
  newestPageSpan(threadId: string): number {
    const t = this.threads.get(threadId);
    if (!t) return mdb.newestPageSpan(threadId, mdb.readActiveLeafOrNewest(threadId));
    const first = t.messages.findIndex((message) => message.id === t.activeLeafId || isOpenRequestCard(message));
    return first === -1 ? 0 : t.messages.length - first;
  }

  /** How many of the newest messages reach back to the active branch head
   * (0 for an empty thread). Open request cards are not counted: a page must
   * not stretch to an old unanswered card (see openCardsOutside). */
  branchHeadSpan(threadId: string): number {
    const t = this.threads.get(threadId);
    if (!t) return mdb.branchHeadSpan(threadId, mdb.readActiveLeafOrNewest(threadId));
    const first = t.messages.findIndex((message) => message.id === t.activeLeafId);
    return first === -1 ? 0 : t.messages.length - first;
  }

  /** The open request cards that are not in a page and sit on the active
   * branch: at most `limit`, the newest ones, oldest first. They ride beside
   * the page so the approval strip still sees them while a thread switch reads
   * only the page, however old the unanswered card is. A card left on a branch
   * the person edited away from is not sent: it no longer blocks the composer
   * (the client cannot tell, since the rows linking it to the page are not
   * held). Answered from the card index and the per-card branch answers kept
   * in SQLite, loaded thread or not: the work is the cards, never the rows
   * stored since them. */
  openCardsOutside(threadId: string, page: readonly { id?: unknown }[], limit = OPEN_CARDS_BESIDE_PAGE): Message[] {
    return this.openCardsOutsideStatus(threadId, page, limit).cards;
  }

  /** openCardsOutside, with whether the answer is known to be complete. While the card index cannot answer for the thread (an upgrade is still
   * indexing the history), the cards come from a bounded look at its newest rows and `pending` is true when older rows were not looked at: the
   * caller says so, and a client keeps the cards it already holds until the thread is prepared and it asks again (onThreadCardsReady). */
  openCardsOutsideStatus(threadId: string, page: readonly { id?: unknown }[], limit = OPEN_CARDS_BESIDE_PAGE): { cards: Message[]; pending: boolean } {
    if (!page.length) return { cards: [], pending: false };
    const held = new Set(page.map((message) => message.id));
    const status = mdb.openRequestCardsStatus(threadId, OPEN_CARD_CANDIDATES);
    const candidates = status.cards.filter((card) => !held.has(card.message.id));
    if (!candidates.length) return { cards: [], pending: status.incomplete };
    const placed = mdb.cardsOnBranchStatus(threadId, mdb.readActiveLeafOrNewest(threadId), candidates.map((card) => ({ id: card.message.id, rowid: card.rowid })));
    const cards = candidates.filter((card) => placed.on.has(card.message.id)).slice(0, limit).reverse();
    return { cards: this.loadedMessages(cards.map((card) => card.message)), pending: status.incomplete || placed.unknown };
  }

  /** The stored branch head of a thread (its newest row when none is stored). */
  activeLeafOf(threadId: string): string | null {
    return mdb.readActiveLeafOrNewest(threadId);
  }

  /** A page of the branch that ends at `fromId` (the active head when omitted):
   * up to `limit` rows reached by real parent links, oldest stored first, with
   * `olderFrom`, the next ancestor, when the branch goes further back. This is
   * the page a client opens on when another fork has grown far past the
   * selected one, and the one it pages back with: storage order says nothing
   * about ancestry once a thread has forked or had a row spliced in. Read from
   * SQLite whether or not the thread is loaded, so both answer alike. Null when
   * `fromId` is not a row of the thread. */
  branchPage(threadId: string, limit: number, fromId?: string | null): { messages: Message[]; hasMore: boolean; activeLeafId: string | null; olderFrom: string | null } | null {
    const leafId = mdb.readActiveLeafOrNewest(threadId);
    const start = fromId ?? leafId;
    if (!start) return { messages: [], hasMore: false, activeLeafId: leafId, olderFrom: null };
    const chain = mdb.branchChain(threadId, start, limit);
    return chain && { ...chain, messages: this.loadedMessages(chain.messages), activeLeafId: leafId };
  }

  /** A `limit`-message window containing `messageId`, positioned like the
   * whole-history formula, read from SQLite without hydrating an uncached
   * thread. Null when the message is not in this thread. Never cached. */
  messageWindow(threadId: string, messageId: string, limit: number): { messages: Message[]; hasMore: boolean } | null {
    if (!this.threads.has(threadId)) {
      const slice = mdb.readThreadAround(threadId, messageId, limit);
      if (slice) return { messages: this.loadedMessages(slice.messages, slice.previous), hasMore: slice.hasMore };
      if (mdb.threadHasRows(threadId)) return null;
    }
    const all = this.thread(threadId).messages;
    const index = all.findIndex((message) => message.id === messageId);
    if (index < 0) return null;
    const leading = Math.floor((limit - 1) / 2);
    const start = Math.max(0, Math.min(index - leading, all.length - limit));
    const stop = Math.min(all.length, start + limit);
    return { messages: all.slice(start, stop), hasMore: start > 0 };
  }

  /** One message of a thread by id: from memory when the thread is loaded,
   * otherwise a single indexed row. Never materializes the transcript. */
  messageById(threadId: string, messageId: string): Message | undefined {
    const loaded = this.threads.get(threadId);
    if (loaded) return indexedMessage(loaded.messages, messageId);
    const row = mdb.readMessage(threadId, messageId);
    return row ? this.loadedMessages([row])[0] : undefined;
  }

  /** Messages of a thread by id (thread order when loaded, else the order
   * asked), skipping ids it does not
   * hold: one pass over a loaded thread, else one indexed row each. Never
   * materializes the transcript (a switch's `since=` answer). */
  messagesByIds(threadId: string, ids: readonly string[]): Message[] {
    if (!ids.length) return [];
    const loaded = this.threads.get(threadId);
    if (loaded) {
      const wanted = new Set(ids);
      return loaded.messages.filter((message) => wanted.has(message.id));
    }
    return ids.flatMap((id) => {
      const row = mdb.readMessage(threadId, id);
      return row ? this.loadedMessages([row]) : [];
    });
  }

  /** The branch head: from memory when the thread is loaded, else one read. */
  leafOf(threadId: string): string | null {
    const loaded = this.threads.get(threadId);
    return loaded ? loaded.activeLeafId : mdb.readActiveLeafOrNewest(threadId);
  }

  /** The first message written at or after `at`, else the newest one: a run's
   * anchor in its thread. Answered from memory when the thread is loaded,
   * otherwise from two indexed reads; a routine's transcript is not loaded to
   * find one row. */
  firstMessageSince(threadId: string, at: number): Message | undefined {
    const loaded = this.threads.get(threadId);
    if (loaded) return loaded.messages.find((message) => message.at >= at) ?? loaded.messages.at(-1);
    const row = mdb.firstMessageSince(threadId, at);
    return row ? this.loadedMessages([row])[0] : undefined;
  }

  messagesFor(threadId: string): Message[] {
    return this.thread(threadId).messages;
  }

  /** The newest `limit` rows of a thread in stored order, and whether older
   * ones exist. From memory when the thread is loaded; otherwise one bounded
   * indexed read that is neither cached nor grows with the thread. A thread
   * with no rows takes the full path (its one-time legacy import). */
  newestMessages(threadId: string, limit: number): { messages: Message[]; hasMore: boolean } {
    const loaded = this.threads.get(threadId);
    if (!loaded) {
      const slice = mdb.readThreadNewest(threadId, limit);
      if (slice) return { messages: this.loadedMessages(slice.messages, slice.previous), hasMore: slice.hasMore };
    }
    const all = (loaded ?? this.thread(threadId)).messages;
    return { messages: all.slice(Math.max(0, all.length - limit)), hasMore: all.length > limit };
  }

  /** When this thread last had a message: the task switcher's "last
   * activity". Undefined for a thread with no messages. A loaded thread
   * answers from memory; any other reads one indexed row, never the whole
   * transcript, because this runs for every task on every broadcast. */
  lastActivityAt(threadId: string): number | undefined {
    const cached = this.lastActivity.get(threadId);
    if (cached !== undefined) return cached ?? undefined;
    const loaded = this.threads.get(threadId);
    const at = loaded ? loaded.messages.at(-1)?.at : mdb.newestMessageAt(threadId) ?? undefined;
    this.lastActivity.set(threadId, at ?? null);
    return at;
  }
  /** The newest message's time per thread, kept by every message write (emit) and read by every task row of every bot frame: the
   * frame does no database read per task (1.0.3 engine-switch: a bot frame per task per event read the newest row of every task's
   * thread, three million SELECTs a minute on a busy box). Null caches "no messages yet"; a thread not yet asked about is read once. */
  private lastActivity = new Map<string, number | null>();

  /** Messages a thread holds, for a Delete confirmation. A loaded thread
   * answers from memory; any other counts through the thread index. */
  messageCount(threadId: string): number {
    const loaded = this.threads.get(threadId);
    return loaded ? loaded.messages.length : mdb.threadRowCount(threadId);
  }

  activeLeaf(threadId: string): string | null {
    const loaded = this.threads.get(threadId);
    return loaded ? loaded.activeLeafId : mdb.readActiveLeafOrNewest(threadId);
  }

  /** Visit rows newest first (stored order) until `visit` returns true or
   * `limit` rows were seen; returns whether `visit` stopped it. The work is
   * the rows written since what is sought, never the thread's history: a
   * loaded thread is read from memory, any other a page at a time. */
  scanNewest(threadId: string, visit: (message: Message) => boolean, limit = TURN_SCAN_ROWS): boolean {
    const loaded = this.threads.get(threadId);
    if (loaded) {
      for (let i = loaded.messages.length - 1, seen = 0; i >= 0 && seen < limit; i--, seen++) if (visit(loaded.messages[i]!)) return true;
      return false;
    }
    let seen = 0;
    let page = mdb.readThreadNewest(threadId, Math.min(SCAN_PAGE_ROWS, limit));
    while (page && page.messages.length) {
      const rows = this.loadedMessages(page.messages, page.previous);
      for (let i = rows.length - 1; i >= 0; i--) {
        if (seen++ >= limit) return false;
        if (visit(rows[i]!)) return true;
      }
      if (!page.hasMore || seen >= limit) return false;
      page = mdb.readThreadBefore(threadId, page.messages[0]!.id, Math.min(SCAN_PAGE_ROWS, limit - seen));
    }
    return false;
  }

  /** Visit the rows stored before `messageId`, nearest first, until `visit`
   * returns true or `limit` rows were seen; returns whether `visit` stopped
   * it. The work is the rows between, never the thread. False when
   * `messageId` is not a row of this thread. */
  scanBefore(threadId: string, messageId: string, visit: (message: Message) => boolean, limit = TURN_SCAN_ROWS): boolean {
    const loaded = this.threads.get(threadId);
    if (loaded) {
      const at = loaded.messages.findIndex((message) => message.id === messageId);
      for (let i = at - 1, seen = 0; i >= 0 && seen < limit; i--, seen++) if (visit(loaded.messages[i]!)) return true;
      return false;
    }
    let seen = 0;
    let anchor = messageId;
    for (;;) {
      const page = mdb.readThreadBefore(threadId, anchor, Math.min(SCAN_PAGE_ROWS, limit - seen));
      if (!page || !page.messages.length) return false;
      const rows = this.loadedMessages(page.messages, page.previous);
      for (let i = rows.length - 1; i >= 0; i--) {
        if (seen++ >= limit) return false;
        if (visit(rows[i]!)) return true;
      }
      if (!page.hasMore || seen >= limit) return false;
      anchor = page.messages[0]!.id;
    }
  }

  /** The newest row `test` accepts, among the newest `limit` rows (stored
   * order): the rows since it, never the thread's history. */
  newestMatching(threadId: string, test: (message: Message) => boolean, limit = TURN_SCAN_ROWS): Message | undefined {
    let found: Message | undefined;
    this.scanNewest(threadId, (message) => (test(message) ? ((found = message), true) : false), limit);
    return found;
  }

  /** Every row `test` accepts among the newest `limit` rows, oldest first. */
  allMatching(threadId: string, test: (message: Message) => boolean, limit = TURN_SCAN_ROWS): Message[] {
    const found: Message[] = [];
    this.scanNewest(threadId, (message) => { if (test(message)) found.push(message); return false; }, limit);
    return found.reverse();
  }

  /** The card row carrying `requestId` that `test` accepts: a card still open
   * through the card index (found however far back it is), else among the
   * newest `limit` rows (one answered or settled since). Never the thread. */
  cardForRequest(threadId: string, requestId: string, test: (message: Message) => boolean = () => true, limit = TURN_SCAN_ROWS): Message | undefined {
    const accepts = (message: Message) => message.card?.requestId === requestId && test(message);
    return this.openRequestCardRows(threadId).reverse().find(accepts) ?? this.newestMatching(threadId, accepts, limit);
  }

  /** Rows stored after `messageId`, oldest first, at most `limit`: what was
   * written since it. Null when it is not a row of this thread. */
  rowsAfter(threadId: string, messageId: string, limit = TURN_SCAN_ROWS): Message[] | null {
    const loaded = this.threads.get(threadId);
    if (loaded) {
      const at = loaded.messages.findIndex((message) => message.id === messageId);
      return at === -1 ? null : loaded.messages.slice(at + 1, at + 1 + limit);
    }
    const rows = mdb.readThreadAfter(threadId, messageId, limit);
    return rows && rows.map(sanitizeMessageDiagnostic);
  }

  /** Walk the active branch from its head toward the root, at most `limit`
   * rows, stopping when `visit` returns true; returns whether it did. A
   * loaded thread walks memory, any other follows parent links by key: the
   * work is the rows walked, never the thread. */
  walkActiveBranch(threadId: string, visit: (message: Message) => boolean, limit = TURN_SCAN_ROWS): boolean {
    if (this.threads.has(threadId)) {
      let seen = 0;
      return this.walkActivePath(threadId, (message) => seen++ >= limit || visit(message)) && seen <= limit;
    }
    let next = mdb.readActiveLeafOrNewest(threadId);
    const seen = new Set<string>();
    while (next && seen.size < limit && !seen.has(next)) {
      seen.add(next);
      const step = mdb.branchStep(threadId, next);
      if (!step) return false;
      if (visit(sanitizeMessageDiagnostic(step.message))) return true;
      next = step.parent;
    }
    return false;
  }

  /** The attachments of this thread's rows that name each of `paths`, by
   * path: the rows are found through the message_image index, never by reading
   * the thread. Until that index has read the rows stored before it existed
   * (its one background pass), a loaded thread answers from memory and any
   * other from its newest rows: an older image is then not
   * bound, which leaves it out of the turn rather than letting it in. */
  boundAttachments(threadId: string, paths: readonly string[]): Map<string, NonNullable<Message["attachments"]>[number]> {
    const found = new Map<string, NonNullable<Message["attachments"]>[number]>();
    const loaded = this.threads.get(threadId);
    const wanted = new Set(paths);
    if (!wanted.size) return found;
    for (const path of wanted) {
      const rows = loaded ? loaded.messages.filter((row) => row.attachments?.some((item) => item.path === path)) : mdb.rowsNamingImage(threadId, path);
      for (const row of rows) for (const item of row.attachments ?? []) if (item.path === path && !found.has(path)) found.set(path, item);
    }
    return found;
  }

  /** The image paths the thread's newest picture-bearing rows name, newest first: the candidates a request is checked against for
   * a duplicate. Found by the message_image index, never by reading the thread. */
  recentImagePaths(threadId: string, limit: number): string[] {
    const loaded = this.threads.get(threadId);
    if (!loaded) return mdb.recentImagePaths(threadId, limit);
    const out: string[] = [];
    for (let i = loaded.messages.length - 1; i >= 0 && out.length < limit; i--) {
      const m = loaded.messages[i]!;
      for (const item of m.attachments ?? []) if (item.kind === "image" && !out.includes(item.path)) out.push(item.path);
      for (const path of tagImagePaths(m)) if (!out.includes(path)) out.push(path);
    }
    return out;
  }

  /** The paths among `paths` that a row of this thread names as an image: an attachment, or the `<attached-image>` tag of
   * an older user row. By the message_image index, however far back the row is. */
  imagePathsNamed(threadId: string, paths: readonly string[]): Set<string> {
    const named = new Set<string>();
    const loaded = this.threads.get(threadId);
    for (const path of new Set(paths)) {
      const rows = loaded ? loaded.messages.filter((row) => imagePathsOf(row).includes(path)) : mdb.rowsNamingImage(threadId, path);
      if (rows.length) named.add(path);
    }
    return named;
  }

  /** The rows one turn wrote, oldest first, every one: from the turn's first row on (mdb.turnRows), never the thread. */
  turnRows(threadId: string, turnId: string): Message[] {
    const loaded = this.threads.get(threadId);
    if (loaded) return loaded.messages.filter((m) => m.turnId === turnId);
    return mdb.turnRows(threadId, turnId).map(sanitizeMessageDiagnostic);
  }

  /** The ids of the replies a turn wrote on its own (bot text that is not a copy), oldest first: the originals a copy of the
   * turn's answer links, found through the line index so a turn that wrote thousands of tool rows between its replies
   * still gives every one. */
  turnReplyOriginals(threadId: string, turnId: string): string[] {
    const isOriginal = (m: Message) => m.role === "bot" && m.kind === "text" && !m.copyOf;
    const loaded = this.threads.get(threadId);
    const rows = loaded ? loaded.messages.filter((m) => m.turnId === turnId) : mdb.turnTextRows(threadId, turnId, [LINE_TEXT, LINE_BOT_EMPTY]).map(sanitizeMessageDiagnostic);
    return rows.filter(isOriginal).map((m) => m.id);
  }

  /** Visit text lines newest first until `visit` returns true (true when it did): the lines written since what is sought. */
  scanNewestLines(threadId: string, visit: (message: Message) => boolean, classes: readonly number[] = [LINE_TEXT]): boolean {
    const loaded = this.threads.get(threadId);
    if (loaded) {
      for (let i = loaded.messages.length - 1; i >= 0; i--) { const m = loaded.messages[i]!; if (lineClassesOf(m).some((cls) => classes.includes(cls)) && visit(m)) return true; }
      return false;
    }
    return mdb.scanTextLinesNewest(threadId, (m) => visit(sanitizeMessageDiagnostic(m)), classes);
  }

  /** The rows of this thread that carry saved files (artifactIds), by index. */
  artifactRows(threadId: string): Message[] {
    return mdb.artifactRows(threadId).map(sanitizeMessageDiagnostic);
  }

  /** The first row of this thread that attaches `path`, by the message_image
   * index (boundAttachments' rule while that index is still being filled). */
  rowAttaching(threadId: string, path: string): Message | undefined {
    const loaded = this.threads.get(threadId);
    if (loaded) return loaded.messages.find((message) => message.attachments?.some((item) => item.path === path));
    const row = mdb.rowsNamingImage(threadId, path).find((message) => message.attachments?.some((item) => item.path === path));
    return row && sanitizeMessageDiagnostic(row);
  }

  /** The thread's open request cards, read through the card index (never the
   * thread's rows), with the answerable cards of a run that died (orphaned). A loaded thread's copies are returned for those it holds. */
  openRequestCardRows(threadId: string): Message[] {
    const loaded = this.threads.get(threadId);
    const open = mdb.openRequestCards(threadId, OPEN_CARD_SWEEP_LIMIT).reverse()
      .map(({ message }) => loaded?.messages.find((row) => row.id === message.id) ?? sanitizeMessageDiagnostic(message));
    // a card the start retired (its run died) is out of the open-card list but still answerable: it counts as open here (keyed family "orphaned")
    const seen = new Set(open.map((row) => row.id));
    const orphaned = (loaded ? loaded.messages.filter((row) => row.card?.orphaned && row.card.requestId && !row.card.answered && !row.card.dismissed) : mdb.keyedCardRows(threadId, "orphaned").map(sanitizeMessageDiagnostic))
      .filter((row) => !seen.has(row.id));
    return orphaned.length ? [...orphaned, ...open].sort((a, b) => a.at - b.at) : open;
  }

  /** The threads that hold an open request card or an answerable orphaned card (mdb.threadsWithOpenCards), or null while the card
   * lists are still being filled after an upgrade. */
  threadsWithOpenCards(): string[] | null {
    return mdb.threadsWithOpenCards();
  }

  /** Of `threadIds`, those of the project room `group` (its thread, its tasks, and every bot's desk task for it), in the order a walk
   * of the room's thread, then its tasks, then each bot's desk tasks meets them. Each thread costs a map look per bot, never a walk of
   * tasks: the reminder asks this of the threads with open cards only. */
  projectThreadsAmong(group: GroupRecord, threadIds: Iterable<string>): string[] {
    const rooms = this.groupThreadIndex(), keyed: Array<{ threadId: string; key: [number, number, number] }> = [];
    const indexes = this.bots.map(bot => this.taskIndex(bot.tasks));
    for (const threadId of new Set(threadIds)) {
      const place = rooms.places.get(threadId)?.find(entry => entry.group === group);
      if (place) { keyed.push({ threadId, key: [0, place.pos + 1, 0] }); continue; }
      for (let i = 0; i < indexes.length; i++) {
        const entry = indexes[i]?.byThread.get(threadId);
        if (entry?.task.channelProjectDesk?.groupId === group.id) { keyed.push({ threadId, key: [1, i, entry.index] }); break; }
      }
    }
    keyed.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
    return keyed.map(entry => entry.threadId);
  }

  /** The thread's open request cards that sit on its visible branch, oldest
   * first: what a filter over `activePath` for open cards answered, read from
   * the card index and the branch by key. A card left on a branch the person
   * edited away from is not returned. */
  openCardsOnBranch(threadId: string): Message[] {
    const cards = this.openRequestCardRows(threadId);
    if (!cards.length) return [];
    const onBranch = this.branchMembership(threadId);
    return cards.filter((card) => onBranch(card.id));
  }

  /** The rows of a thread filed under `family` (and `key`), oldest first: a
   * setup card by its key, the intake questions still open, a browser-setup
   * offer still open, a learned-skill proposal by its staged id, a line the
   * setup flow said, an unconfirmed steer. Read through keyed_card, so the
   * work is those rows and never the thread, loaded or not. */
  keyedCards(threadId: string, family: KeyedFamily, key?: string): Message[] {
    return mdb.keyedCardRows(threadId, family, key).map(sanitizeMessageDiagnostic);
  }

  /** A thread's rows of one kind, oldest first, by the (kind, thread) index:
   * only for a kind that is rare by nature ("secret", "connector"). */
  rowsOfKind(threadId: string, kind: string): Message[] {
    return mdb.rowsOfKind(threadId, kind).map(sanitizeMessageDiagnostic);
  }

  /** Every thread's rows filed under `family` (a family that is small by
   * nature: open browser-setup offers), by thread then position. */
  keyedCardsEverywhere(family: KeyedFamily): Array<{ threadId: string; message: Message }> {
    return mdb.keyedCardRowsAll(family).map((row) => ({ threadId: row.threadId, message: sanitizeMessageDiagnostic(row.message) }));
  }

  /** The newest screen frame of a thread that still carries its pixels. Pruning
   * keeps pixels on the newest few frames only (pruneScreenFrames), so it is one
   * of the newest few frames, found through the (kind, thread) index; a loaded thread answers from memory. */
  newestScreenWithPixels(threadId: string): Message | undefined {
    const loaded = this.threads.get(threadId);
    if (loaded) return loaded.messages.findLast((m) => m.kind === "screen" && Boolean(m.png));
    const found = mdb.newestScreenWithPixels(threadId);
    return found ? sanitizeMessageDiagnostic(found) : undefined;
  }

  /** Whether the thread has a row with this id: one keyed read, loaded or not. */
  hasRow(threadId: string, messageId: string): boolean {
    return mdb.messagePosition(threadId, messageId) !== null;
  }

  /** Whether the thread has any message at all, without counting them. */
  hasRows(threadId: string): boolean {
    const loaded = this.threads.get(threadId);
    return loaded ? loaded.messages.length > 0 : mdb.threadHasRows(threadId);
  }

  /** The first row of a thread (storage order), or undefined when it has none. */
  firstRow(threadId: string): Message | undefined {
    const loaded = this.threads.get(threadId);
    if (loaded) return loaded.messages[0];
    const row = mdb.firstMessageSince(threadId, 0);
    return row ? this.loadedMessages([row])[0] : undefined;
  }

  /** The id of the newest row (storage order): the mark a caller keeps to read
   * what was written after it (rowsAfter). Undefined for a thread with none. */
  newestRowId(threadId: string): string | undefined {
    const loaded = this.threads.get(threadId);
    if (loaded) return loaded.messages.at(-1)?.id;
    return this.newestMessages(threadId, 1).messages[0]?.id;
  }

  /** Visit rows newest first while they were written at or after `at`, until
   * `visit` returns true; returns whether it did. For a row that cannot be
   * older than something whose time is known (a reply to a request cannot be
   * older than the request), the work is the rows written since then and
   * never the thread: rows are stored in the order they were written. */
  scanSince(threadId: string, at: number, visit: (message: Message) => boolean): boolean {
    let found = false;
    this.scanNewest(threadId, (message) => {
      if (message.at < at) return true;
      if (visit(message)) { found = true; return true; }
      return false;
    }, Number.POSITIVE_INFINITY);
    return found;
  }

  /** The active branch read in slices, newest first, for a caller that needs
   * the whole of it (an export) without holding the event loop: each `next`
   * call reads for about `budgetMs`, then hands back what it has so the caller
   * can yield. A thread already in memory hands its branch back in slices of
   * `LOADED_SLICE_ROWS`. The rows and their order are those of `activePath`
   * (read newest first). */
  branchReader(threadId: string): { next(budgetMs?: number): { messages: Message[]; done: boolean } } {
    if (this.threads.has(threadId)) {
      const rows = this.activePath(threadId).reverse();
      let at = 0;
      return { next: () => { const messages = rows.slice(at, at + LOADED_SLICE_ROWS); at += messages.length; return { messages, done: at >= rows.length }; } };
    }
    let cursor: string | null = mdb.readActiveLeafOrNewest(threadId);
    const seen = new Set<string>();
    return {
      next: (budgetMs = 20) => {
        const messages: Message[] = [];
        const end = performance.now() + budgetMs;
        while (cursor && !seen.has(cursor)) {
          seen.add(cursor);
          const step = mdb.branchStep(threadId, cursor);
          if (!step) { cursor = null; break; }
          messages.push(sanitizeMessageDiagnostic(step.message));
          cursor = step.parent;
          if ((messages.length & 31) === 0 && performance.now() >= end) break;
        }
        return { messages, done: !cursor || seen.has(cursor) };
      },
    };
  }

  /** The active branch read for an export, OLDEST first, a page at a time, so
   * the writer holds one page and never the whole thread (and a thread that is
   * not in memory is not pulled into the LRU). Same rows and order as
   * `branchReader` reversed. A thread in memory hands back slices of its own
   * path. Otherwise a first pass walks the branch newest first, keeping only
   * the id each page starts at (a row cap stops a corrupt parent cycle), then
   * each `next` reads one page from its start id, oldest page first. */
  branchExportReader(threadId: string, pageRows = EXPORT_PAGE_ROWS): { next(budgetMs?: number): { messages: Message[]; done: boolean } } {
    if (this.threads.has(threadId)) {
      const rows = this.activePath(threadId);
      let at = 0;
      return { next: () => { const messages = rows.slice(at, at + pageRows); at += messages.length; return { messages, done: at >= rows.length }; } };
    }
    let cursor: string | null = mdb.readActiveLeafOrNewest(threadId);
    const starts: string[] = [];
    let steps = 0;
    // the row cap, counted a keyed page at a time inside the slices (one COUNT of a thread grows with it: 18 ms at 200,000 rows)
    let cap = 0, countedTo = 0, counted = false;
    return {
      next: (budgetMs = 20) => {
        const end = performance.now() + budgetMs;
        while (!counted) {
          const page = mdb.threadRowCountPage(threadId, countedTo, EXPORT_COUNT_PAGE_ROWS);
          cap += page.n; countedTo = page.last;
          if (page.n < EXPORT_COUNT_PAGE_ROWS) counted = true;
          else if (performance.now() >= end) return { messages: [], done: false };
        }
        // pass 1: page start ids only (the slice may end early; the caller calls again)
        while (cursor && steps < cap) {
          if (steps % pageRows === 0) starts.push(cursor);
          const step = mdb.branchStepAt(threadId, cursor);
          steps++;
          cursor = step ? step.parent : null;
          if ((steps & 255) === 0 && performance.now() >= end) return { messages: [], done: false };
        }
        cursor = null;
        // pass 2: the oldest page not yet written
        const from = starts.pop();
        if (!from) return { messages: [], done: true };
        const page: Message[] = [];
        let id: string | null = from;
        while (id && page.length < pageRows) {
          const step = mdb.branchStep(threadId, id);
          if (!step) break;
          page.push(sanitizeMessageDiagnostic(step.message));
          id = step.parent;
        }
        return { messages: page.reverse(), done: starts.length === 0 };
      },
    };
  }

  /** Whether a message is on the active branch, found by key in the branch index (branch-index.ts): a few keyed reads however far
   * back the row is and however the thread has been forked or spliced, never a walk. A thread that is not prepared is never filled
   * here (a request must not hold the loop for a whole thread): a loaded one answers from its path, any other is queued at the front
   * of the background fill and answers from a bounded walk from its leaf, `undefined` when that could not tell. Nothing is read
   * until the first question. */
  branchMembershipKnown(threadId: string): (messageId: string) => boolean | undefined {
    const loaded = this.threads.get(threadId);
    if (loaded && !isThreadPrepared(threadId)) {
      let ids: Set<string> | undefined;
      return (messageId) => (ids ??= new Set(this.activePath(threadId).map((message) => message.id))).has(messageId);
    }
    let test: ((messageId: string) => boolean | undefined) | undefined;
    return (messageId) => (test ??= branchTester(threadId, loaded ? loaded.activeLeafId : mdb.readActiveLeafOrNewest(threadId)))(messageId);
  }

  /** branchMembershipKnown for a caller that must not hide anything: a row that could not be placed yet counts as on the branch. */
  branchMembership(threadId: string): (messageId: string) => boolean {
    const known = this.branchMembershipKnown(threadId);
    return (messageId) => known(messageId) !== false;
  }

  /** Make the thread's branch and line indexes complete before it is read: a fill in short slices with the event loop free
   * between them, shared by every caller (branch-store.ts). A turn on a thread stored before the indexes existed waits
   * here once; every later read is exact and keyed. Resolves at once for a prepared thread. */
  prepareThread(threadId: string): Promise<void> {
    return prepareThreadRows(threadId);
  }

  /** The leaf the branch index reads from: a loaded thread's own head, else the stored head or newest row. */
  private branchLeaf(threadId: string): string | null {
    const loaded = this.threads.get(threadId);
    return loaded ? loaded.activeLeafId : mdb.readActiveLeafOrNewest(threadId);
  }

  /** The newest card on the active branch that carries a request id (answered or not), found through the line index. */
  newestRequestCard(threadId: string): Message | undefined {
    const loaded = this.threads.get(threadId);
    if (loaded && !isThreadPrepared(threadId)) { const path = this.activePath(threadId); return path.findLast((m) => Boolean(m.card?.requestId)); }
    const found = mdb.topRowsOnBranch(threadId, this.branchLeaf(threadId), LINE_REQUEST_CARD, 1).rows[0];
    return found && sanitizeMessageDiagnostic(found.message);
  }

  /** The newest text line of the active branch that `test` accepts (the room's last owner message, for one). */
  newestLineOnBranch(threadId: string, test: (message: Message) => boolean): Message | undefined {
    const loaded = this.threads.get(threadId);
    if (loaded && !isThreadPrepared(threadId)) return this.activePath(threadId).findLast((m) => m.kind === "text" && Boolean(m.text) && test(m));
    const found = mdb.topRowsOnBranch(threadId, this.branchLeaf(threadId), LINE_TEXT, 1, test).rows[0];
    return found && sanitizeMessageDiagnostic(found.message);
  }

  /** The newest row of a class (branch-index LINE_*) on the active branch, with its place for ordering against other rows. */
  newestRowOfClass(threadId: string, cls: number, accept?: (message: Message) => boolean): { message: Message; position: number; after: (other: number) => boolean } | undefined {
    const loaded = this.threads.get(threadId);
    if (loaded && !isThreadPrepared(threadId)) {
      const path = this.activePath(threadId);
      for (let i = path.length - 1; i >= 0; i--) if (lineClassesOf(path[i]!).includes(cls) && (!accept || accept(path[i]!))) return { message: path[i]!, position: i, after: (other) => i > other };
      return undefined;
    }
    const found = mdb.topRowsOnBranch(threadId, this.branchLeaf(threadId), cls, 1, accept).rows[0];
    return found && mdb.rowPlace(threadId, this.branchLeaf(threadId), found.mrow, sanitizeMessageDiagnostic(found.message));
  }

  /** The newest `limit` text lines of the active branch, oldest first, and whether the branch has older ones: the lines a
   * replay is built from, found through the line index and the branch index however many tool rows lie between them. */
  activeTextLines(threadId: string, limit: number): { messages: Message[]; hasMore: boolean } {
    const loaded = this.threads.get(threadId);
    if (loaded && !isThreadPrepared(threadId)) {
      const out: Message[] = [];
      let more = false;
      this.walkActivePath(threadId, (m) => {
        if (m.kind !== "text" || !m.text) return false;
        if (out.length >= limit) { more = true; return true; }
        out.push(m);
        return false;
      });
      return { messages: out.reverse(), hasMore: more };
    }
    const found = mdb.activeTextLines(threadId, loaded ? loaded.activeLeafId : mdb.readActiveLeafOrNewest(threadId), limit);
    return { messages: found.messages.map(sanitizeMessageDiagnostic), hasMore: found.hasMore };
  }

  /** Rows of one class of the line index (branch-index.ts LINE_*) that are on the active branch, newest first. `after(other)`
   * says whether the row is later on the branch than the row `other` (a position from `.position` of another row). */
  *branchLinesNewest(threadId: string, cls: number): Generator<{ message: Message; position: number; after: (other: number) => boolean }> {
    const loaded = this.threads.get(threadId);
    if (loaded && !isThreadPrepared(threadId)) {
      const path = this.activePath(threadId);
      for (let i = path.length - 1; i >= 0; i--) if (lineClassesOf(path[i]!).includes(cls)) yield { message: path[i]!, position: i, after: (other) => i > other };
      return;
    }
    for (const row of mdb.branchLinesNewest(threadId, loaded ? loaded.activeLeafId : mdb.readActiveLeafOrNewest(threadId), cls)) {
      yield { message: sanitizeMessageDiagnostic(row.message), position: row.mrow, after: row.after };
    }
  }

  /** The newest `limit` text lines of a thread (rows of kind "text" with words), oldest first, from the line index: the
   * work is `limit`, however many other rows (tool activity, cards) lie between them. */
  newestTextLines(threadId: string, limit: number): Message[] {
    const loaded = this.threads.get(threadId);
    if (loaded) {
      const out: Message[] = [];
      for (let i = loaded.messages.length - 1; i >= 0 && out.length < limit; i--) { const m = loaded.messages[i]!; if (m.kind === "text" && m.text) out.push(m); }
      return out.reverse();
    }
    return mdb.newestTextLines(threadId, limit).map(sanitizeMessageDiagnostic);
  }

  /** The visible conversation: root → activeLeafId. */
  activePath(threadId: string): Message[] {
    const path: Message[] = [];
    this.walkActivePath(threadId, (message) => { path.push(message); return false; });
    return path.reverse();
  }

  /** Walk the active branch from its leaf toward the root, stopping when
   * `visit` returns true. A parent is always stored before its child, so each
   * step scans downward from where the last one stopped: no id map of the
   * whole thread is built, and a caller that stops early touches only the
   * newest rows. Returns whether `visit` stopped the walk. A parent that is
   * not found below its child (an out-of-order store) is looked up in an id
   * map instead, so the result is the same as a map walk. */
  walkActivePath(threadId: string, visit: (message: Message) => boolean): boolean {
    const t = this.thread(threadId);
    const rows = t.messages;
    let index = t.activeLeafId ? rows.findLastIndex((m) => m.id === t.activeLeafId) : -1;
    let byId: Map<string, number> | undefined;
    while (index >= 0) {
      const cur = rows[index]!;
      if (visit(cur)) return true;
      const parentId = cur.parentId;
      if (!parentId) return false;
      let next = -1;
      for (let j = index - 1; j >= 0; j--) if (rows[j]!.id === parentId) { next = j; break; }
      if (next < 0) {
        byId ??= new Map(rows.map((m, i) => [m.id, i]));
        next = byId.get(parentId) ?? -1;
      }
      index = next;
    }
    return false;
  }

  /** Mark the last assistant text on the active branch as this turn's final
   * visible answer. If a provider ends after commentary without emitting a
   * separate answer, that commentary remains visible as the safe fallback. */
  markTerminalAssistantMessage(threadId: string, turnId: string, outcome: MemoryTurnOutcome = "completed", helpers?: unknown): Message | null {
    return this.writing(threadId, () => {
      const t = this.threads.get(threadId);
      let message = undefined as Message | undefined;
      // The turn's rows are the newest of the branch: a walk past more rows of
      // other turns than one turn interleaves (TURN_TERMINAL_GAP) has left it.
      let gap = 0;
      this.walkActiveBranch(threadId, (m) => {
        if (m.role === "bot" && m.kind === "text" && m.turnId === turnId) { message = m; return true; }
        if (m.turnId === turnId) gap = 0; else if (++gap > TURN_TERMINAL_GAP) return true;
        return false;
      });
      const kept = settledTurnHelpers(helpers);
      const next = message ? { ...message, turnTerminal: true, ...(kept.length ? { turnHelpers: kept } : {}) } : null;
      transaction(() => {
        if (next) mdb.updateMessage(threadId,next);
        recordMemorySettlement(threadId,turnId,outcome);
      });
      if (next) {
        const at = t ? t.messages.findIndex(m => m.id === next.id) : -1;
        if (t && at !== -1) { t.messages[at] = next; this.grew(threadId, t, messageBytes(next) - messageBytes(message!)); }
        this.emit({type:"message.patch",threadId,message:next});
      }
      return next;
    });
  }

  /** A last look at a message before it is written (see setMessageRewrite). */
  private messageRewrite?: MessageRewrite;

  /** Install (or clear) the one rewrite every appended message passes. The
   * server uses it while Murage is closing: a turn killed by the shutdown
   * must read "Murage closed while this was running", not the engine's own
   * exit text ("fuigoAgent exited 143 …") under a Provider settings hint.
   * A null result keeps the message out of the transcript; the returned
   * message is then not recorded anywhere. */
  setMessageRewrite(rewrite: MessageRewrite | undefined): void {
    this.messageRewrite = rewrite;
  }

  /** Close output is deduped against durable rows, not a possibly stale cache. */
  appendProjectCloseMessage(threadId: string, key: string, text: string): void {
    const id = `project-${createHash('sha256').update(JSON.stringify([threadId,key])).digest('hex')}`;
    if (database().prepare('SELECT 1 FROM messages WHERE thread_id=? AND id=?').get(threadId,id)) return;
    this.appendMessage(threadId,{role:'bot',kind:'text',actorKind:'murage',murage:{kind:'status'},text,sendId:key},id);
  }

  /** Appends `input` after `headId` only while that is still the thread's branch head; null when it is not. A thread that is not in memory is not
   * loaded for it: the head is one point read and the append writes its own row and the head, so the cost is the same in a conversation of 200,000
   * messages as in one of 20 (the restart marker of an interrupted direct turn). */
  appendAfterHead(threadId: string, headId: string, input: Omit<Message, "id" | "at">): Message | null {
    if (this.threads.has(threadId)) return this.thread(threadId).activeLeafId === headId ? this.appendMessage(threadId, input) : null;
    return this.writing(threadId, () => {
      if (mdb.readActiveLeafOrNewest(threadId) !== headId) return null;
      const message = this.messageRewrite ? this.messageRewrite(threadId, input) : input;
      if (message === null) return null;
      const full: Message = { id: newId(), at: Date.now(), parentId: headId, ...redactBotAuthored(message) };
      mdb.appendMessage(threadId, full);
      this.emit({ type: "message", threadId, message: full });
      return full;
    });
  }

  /** `within` runs in the same transaction as the insert (links the message must not exist without); if it throws, nothing
   * is written, cached or announced. A `stableId` that already names a stored row returns that row (a redelivered event). */
  appendMessage(threadId: string, input: Omit<Message, "id" | "at"> & { at?: number }, stableId?: string, within?: (message: Message) => void, reply?: ProviderReply): Message {
    return this.writing(threadId, () => {
      // A thread that is not loaded is not loaded to add one row (a screen
      // frame prunes the newest frames, read by index).
      if (!this.threads.has(threadId)) {
        const appended = this.appendUnloaded(threadId, input, stableId, within);
        if (appended) return appended;
      }
      const t = this.thread(threadId);
      if (stableId) { const held = t.messages.find(m => m.id === stableId) ?? mdb.storedMessage(threadId, stableId); if (held) return held; }
      const message = this.messageRewrite ? this.messageRewrite(threadId, input) : input;
      if (message === null) return { id: newId(), at: Date.now(), parentId: t.activeLeafId, ...redactBotAuthored(input) };
      const full: Message = { id: stableId ?? newId(), at: Date.now(), parentId: t.activeLeafId, ...redactBotAuthored(message) };
      // Runtime proof of the one dispatch path: a hand-off's prompt id is written only in the transaction that moves its row to started (handoff-stamp.ts).
      const inside = within ? () => within(full) : undefined;
      mdb.appendMessage(threadId, full, isHandoffPromptId(full.id) ? guardHandoffPrompt(database, full.id, inside) : inside, reply);
      t.messages.push(full);
      t.activeLeafId = full.id;
      this.grew(threadId, t, messageBytes(full));
      if (full.kind === "screen") {
        for (const pruned of this.pruneScreenFrames(t, 4, (freed) => this.grew(threadId, t, -freed))) {
          mdb.updateMessage(threadId, pruned);
          this.emit({ type: "message.patch", threadId, message: pruned });
        }
      }
      this.emit({ type: "message", threadId, message: full });
      // A legacy onboarding card is not a live ask. Talking past it hides it so
      // the transcript is just the greeting plus what they said. Cards with a
      // requestId are permission/question prompts and stay until answered, and
      // intake cards own their own lifecycle (see dismissOnboardingCard).
      if (full.role === "user" && full.kind === "text") {
        this.dismissOnboardingCard(threadId);
        this.observeOwnerSignals(threadId, full, t.messages.slice(-41, -1));
      }
      return full;
    });
  }

  /** appendMessage for a thread that is not loaded: the same row, leaf, events
   * and owner-message follow-up, from the stored branch head and the newest
   * APPEND_TAIL_ROWS rows, never the transcript. Null for a thread with no
   * rows, which takes the full path (its one-time legacy import). */
  private appendUnloaded(threadId: string, input: Omit<Message, "id" | "at"> & { at?: number }, stableId?: string, within?: (message: Message) => void): Message | null {
    const leaf = mdb.readActiveLeafOrNewest(threadId);
    if (leaf === null) return null;
    if (stableId) { const held = mdb.storedMessage(threadId, stableId); if (held) return held; }
    const message = this.messageRewrite ? this.messageRewrite(threadId, input) : input;
    if (message === null) return { id: newId(), at: Date.now(), parentId: leaf, ...redactBotAuthored(input) };
    const owner = message.role === "user" && message.kind === "text";
    const recent = owner ? this.newestMessages(threadId, APPEND_TAIL_ROWS).messages : [];
    const full: Message = { id: stableId ?? newId(), at: Date.now(), parentId: leaf, ...redactBotAuthored(message) };
    mdb.appendMessage(threadId, full, within ? () => within(full) : undefined);
    if (full.kind === "screen") {
      for (const pruned of this.pruneScreenFrames({ messages: this.newestFrames(threadId) }, 4)) {
        mdb.updateMessage(threadId, pruned);
        this.emit({ type: "message.patch", threadId, message: pruned });
      }
    }
    this.emit({ type: "message", threadId, message: full });
    if (owner) {
      // An onboarding card still open, however far back: found by index.
      const dismissed = this.dismissOnboardingCard(threadId);
      if (dismissed) { const at = recent.findIndex((row) => row.id === dismissed.id); if (at !== -1) recent[at] = dismissed; }
      this.observeOwnerSignals(threadId, full, recent.slice(-40));
    }
    return full;
  }

  /** Bot learning (B1): a re-ask, or the owner's edit of a bot draft, noticed
   * from the owner's own new message. Never allowed to fail the append. */
  private observeOwnerSignals(threadId: string, message: Message, before: Message[]): void {
    try {
      const bot = this.botByThread(threadId);
      if (!bot || !isWorkspaceOwner(threadHumanPrincipal(threadId))) return;
      observeOwnerMessage(database(), bot, threadId, message, before);
    } catch { /* a signal is optional; the message is already saved */ }
  }

  /** The rows whose parent is `anchorId`, from the branch index (its continuation and the heads of the forks hung from
   * it), never from a look through the rows stored since. A legacy row with no parentId is the child of the row stored
   * before it, as a load reads it. */
  private childrenStoredAfter(threadId: string, anchorId: string): Message[] {
    return mdb.childrenOfRow(threadId, anchorId).map(sanitizeMessageDiagnostic);
  }

  /** The newest screen frames of a thread that is not loaded, oldest first:
   * pruning keeps pixels on the newest few only (pruneScreenFrames), so those
   * are the only ones that can still carry them. */
  private newestFrames(threadId: string): Message[] {
    return mdb.newestScreenFrames(threadId, SCREEN_FRAMES_READ).reverse();
  }

  /** Insert a message into the active chain directly after `anchorId` — the
   * home for turn artifacts that finish AFTER the world moved on (the
   * settle-time screen capture races a fast follow-up send, which used to
   * leave the user's message stranded above the screenshot). When the anchor
   * is still the leaf this is a plain append; otherwise the anchor's
   * children are re-parented onto the inserted message, so the transcript
   * reads turn → artifact → follow-up and the leaf stays where it was. */
  insertMessageAfter(threadId: string, anchorId: string | undefined, message: Omit<Message, "id" | "at">): Message {
    return this.writing(threadId, () => {
      // A thread that is not loaded is not loaded for this: the anchor is read
      // by key, its children are among the rows stored since it, and the frames
      // that can still carry pixels are the newest few (mdb.newestScreenFrames).
      const t = this.threads.get(threadId);
      const anchorExists = anchorId !== undefined && (t ? t.messages.some((m) => m.id === anchorId) : mdb.readMessage(threadId, anchorId) !== null);
      if (!anchorExists || this.activeLeaf(threadId) === anchorId) return this.appendMessage(threadId, message);
      const full: Message = { id: newId(), at: Date.now(), ...redactBotAuthored(message), parentId: anchorId };
      const children = t ? t.messages.filter((m) => m.parentId === anchorId) : this.childrenStoredAfter(threadId, anchorId!);
      // A splice, not an append: the leaf stays where it is, in memory and on
      // disk. mdb.appendMessage would move the stored leaf to this message,
      // which reads as a branch change (memory retires the follow-up and revokes
      // every receipt of the thread), and the next ordinary append, parented on
      // the real leaf, would read as a second one: a warm engine was dropped
      // with reason=memory-changed after every settle-time screenshot that
      // landed behind a follow-up (continuation-churn.test.ts).
      // One transaction for the insert, the screen-frame pruning and the
      // reparenting, so a crash or a failure part-way leaves neither a stranded
      // screenshot nor half-reparented siblings. Memory and every emit wait for
      // the commit; if anything throws the cache is untouched and nothing is
      // published. The work is computed on copies and applied afterwards.
      const prunedCopies: Message[] = [];
      if (full.kind === "screen") {
        const screens = [...(t ? t.messages : this.newestFrames(threadId)), full].filter((m) => m.kind === "screen" && m.png);
        for (const m of screens.slice(0, Math.max(0, screens.length - 4))) prunedCopies.push({ ...m, png: undefined });
      }
      const reparented = children.map((child) => sanitizeMessageDiagnostic({ ...child, parentId: full.id }));
      transaction(() => { mdb.insertMessageAfter(threadId, full, anchorId!, prunedCopies, reparented); });
      if (!t) {
        for (const pruned of prunedCopies) this.emit({ type: "message.patch", threadId, message: pruned });
        this.emit({ type: "message", threadId, message: full });
        for (const next of reparented) this.emit({ type: "message.patch", threadId, message: next, before: children.find((child) => child.id === next.id) });
        return full;
      }
      t.messages.push(full);
      this.grew(threadId, t, messageBytes(full));
      for (const pruned of prunedCopies) {
        const idx = t.messages.findIndex((m) => m.id === pruned.id);
        if (idx === -1) continue;
        this.grew(threadId, t, -(t.messages[idx].png?.length ?? 0));
        t.messages[idx].png = undefined;
        this.emit({ type: "message.patch", threadId, message: t.messages[idx] });
      }
      this.emit({ type: "message", threadId, message: full });
      // announced after the insert so no client ever sees two siblings
      // claiming the same parent
      for (const next of reparented) {
        const idx = t.messages.findIndex((m) => m.id === next.id);
        if (idx === -1) continue;
        const before = t.messages[idx];
        t.messages[idx] = next;
        this.grew(threadId, t, messageBytes(next) - messageBytes(before));
        this.emit({ type: "message.patch", threadId, message: next, before });
      }
      return full;
    });
  }

  /** Insert a message into the chain directly before `beforeId`: it takes
   * that message's parent, and only that message is re-parented onto it
   * (its siblings on other branches stay where they are). Text a Fuigo
   * hosted tool row interrupted is saved this way, after the row it was
   * written before: the transcript reads text → row → following text. The
   * leaf never moves, in memory or on disk. A missing target is a plain
   * append. */
  insertMessageBefore(threadId: string, beforeId: string, input: Omit<Message, "id" | "at">, stableId?: string, within?: (message: Message) => void, reply?: ProviderReply): Message {
    return this.writing(threadId, () => {
      // Not loaded for this either: the target is read by key, with its parent as a load reads it.
      const t = this.threads.get(threadId);
      if (stableId) { const held = t?.messages.find(m => m.id === stableId) ?? mdb.storedMessage(threadId, stableId); if (held) return held; }
      const step = t ? undefined : mdb.branchStep(threadId, beforeId);
      const target = t ? t.messages.find((m) => m.id === beforeId) : step ? sanitizeMessageDiagnostic({ ...step.message, parentId: step.parent }) : undefined;
      if (!target) return this.appendMessage(threadId, input, stableId, within, reply);
      const message = this.messageRewrite ? this.messageRewrite(threadId, input) : input;
      if (message === null) return { id: newId(), at: Date.now(), parentId: target.parentId, ...redactBotAuthored(input) };
      // No backfill for unmarked rows: insertion before a row first ships with
      // this marker, so no saved database holds an unmarked inserted row.
      const full: Message = { id: stableId ?? newId(), at: Date.now(), ...redactBotAuthored(message), parentId: target.parentId, insertedBefore: target.id };
      const moved = sanitizeMessageDiagnostic({ ...target, parentId: full.id });
      transaction(() => {
        mdb.insertMessageBefore(threadId, full, moved, reply);
        const inside = within ? () => within(full) : undefined;
        if (isHandoffPromptId(full.id)) guardHandoffPrompt(database, full.id, inside)(); else inside?.();
      });
      if (!t) {
        this.emit({ type: "message", threadId, message: full });
        this.emit({ type: "message.patch", threadId, message: moved, before: target });
        return full;
      }
      t.messages.push(full);
      this.grew(threadId, t, messageBytes(full));
      const idx = t.messages.findIndex((m) => m.id === target.id);
      if (idx !== -1) {
        this.grew(threadId, t, messageBytes(moved) - messageBytes(t.messages[idx]));
        t.messages[idx] = moved;
      }
      this.emit({ type: "message", threadId, message: full });
      this.emit({ type: "message.patch", threadId, message: moved, before: target });
      return full;
    });
  }

  /** Hide a legacy first-run quiz on this thread, if it is still open.
   *
   * Intake cards are deliberately excluded. This runs as a side effect of
   * every user text message, and the intake route appends exactly such a
   * message on every turn, so without the guard the card would be
   * dismissed by its own answer, one message before the reply to it lands.
   * Settling an intake by talking past it is a real behavior, but it belongs
   * to the ordinary `/messages` route, where it is a decision, not here,
   * where it would be an accident. */
  dismissOnboardingCard(threadId: string): Message | null {
    // Found by index, loaded thread or not: the work is the thread's open
    // cards, never its history. A loaded thread's copy is the one patched.
    const stored = mdb.openOnboardingCards(threadId).find(isOnboardingSuggestion);
    if (!stored) return null;
    const card = this.threads.get(threadId)?.messages.find((row) => row.id === stored.id) ?? stored;
    if (!card.card || !isOnboardingSuggestion(card)) return null;
    return this.patchMessage(threadId, card.id, { card: { ...card.card, dismissed: true } });
  }

  /** Screen frames are ~100-500KB of base64 each; keeping every frame of a
   * long computer session bloats the transcript for nothing the client
   * would ever show. The newest few keep their pixels; older ones stay in
   * the transcript as placeholders. Mirrors the client's own frame cap.
   * Returns the messages whose pixels were dropped so the caller can
   * persist exactly those. */
  private pruneScreenFrames(t: { messages: Message[] }, keep = 4, freed?: (bytes: number) => void): Message[] {
    const pruned: Message[] = [];
    let seen = 0;
    for (let i = t.messages.length - 1; i >= 0 && seen < t.messages.length; i--) {
      const m = t.messages[i];
      if (m.kind !== "screen" || !m.png) continue;
      seen += 1;
      if (seen > keep) {
        freed?.(m.png.length);
        m.png = undefined;
        pruned.push(m);
      }
    }
    return pruned;
  }

  /** Fork the conversation: a new user message that replaces `sourceId`
   * (same parent, new text) and becomes the active leaf. `sendId` is the
   * client's identity for this edit, so a network retry answers with this
   * fork instead of forking and rerunning again (upstream #1387). */
  branchMessage(threadId: string, sourceId: string, text: string, origin?: MessageOrigin, sendId?: string): Message | null {
    if (!this.threads.has(threadId)) {
      const forked = this.branchUnloaded(threadId, sourceId, text, origin, sendId);
      if (forked !== undefined) return forked;
    }
    return this.writing(threadId, () => {
      const t = this.thread(threadId);
      const source = t.messages.find((m) => m.id === sourceId);
      if (!source) return null;
      const full: Message = {
        id: newId(),
        at: Date.now(),
        role: "user",
        kind: "text",
        text,
        parentId: source.parentId ?? null,
        replyToId: source.replyToId,
        ...(origin ? { origin } : {}),
        ...(sendId ? { sendId } : {}),
      };
      mdb.appendMessage(threadId, full);
      t.messages.push(full);
      t.activeLeafId = full.id;
      this.grew(threadId, t, messageBytes(full));
      this.emit({ type: "message", threadId, message: full });
      // A fork is not a child of the old leaf; publish the durable selection
      // after its message so clients can display the server's active branch.
      this.emit({ type: "thread", threadId, activeLeafId: full.id });
      return full;
    });
  }

  /** branchMessage for a thread that is not loaded: the source by key, the new
   * row written beside it with the branch head moved to it (the same row, events
   * and head as the loaded path), never the transcript. Undefined for a thread
   * with no rows, which takes the full path (its one-time legacy import). */
  private branchUnloaded(threadId: string, sourceId: string, text: string, origin?: MessageOrigin, sendId?: string): Message | null | undefined {
    if (!mdb.threadHasRows(threadId)) return undefined;
    return this.writing(threadId, () => {
      const stored = mdb.readMessage(threadId, sourceId);
      if (!stored) return null;
      const source = this.loadedMessages([stored], stored.parentId === undefined ? mdb.readThreadBefore(threadId, sourceId, 1)?.messages[0] ?? null : null)[0]!;
      const full: Message = {
        id: newId(),
        at: Date.now(),
        role: "user",
        kind: "text",
        text,
        parentId: source.parentId ?? null,
        replyToId: source.replyToId,
        ...(origin ? { origin } : {}),
        ...(sendId ? { sendId } : {}),
      };
      mdb.appendMessage(threadId, full);
      this.emit({ type: "message", threadId, message: full });
      this.emit({ type: "thread", threadId, activeLeafId: full.id });
      return full;
    });
  }

  /** Point the visible conversation at the branch containing `messageId`,
   * descending to that branch's most recently active leaf. */
  setActiveLeaf(threadId: string, messageId: string): string | null {
    const t = this.thread(threadId);
    if (!t.messages.some((m) => m.id === messageId)) return null;
    let cur = messageId;
    for (;;) {
      const children = t.messages.filter((m) => m.parentId === cur);
      if (!children.length) break;
      cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
    }
    mdb.setActiveLeaf(threadId, cur);
    t.activeLeafId = cur;
    this.emit({ type: "thread", threadId, activeLeafId: cur });
    return cur;
  }

  /** `within` runs in the same transaction as the patch (another row that must change with this message, or not at all); it runs even when the message is
   * gone (the other change is still owed), and if it throws nothing is written, cached or announced. */
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>, within?: () => void): Message | null {
    return this.writing(threadId, () => {
      // A thread that is not loaded is not loaded to change one row: the row
      // is read by its key and written back, as a loaded patch writes it.
      if (!this.threads.has(threadId)) {
        // read as a load reads it: a legacy row is chained to the row stored before it
        const step = mdb.branchStep(threadId, messageId);
        if (!step) return null;
        const before = sanitizeMessageDiagnostic({ ...step.message, parentId: step.parent });
        const next = sanitizeMessageDiagnostic({ ...before, ...boundRemovedText(patch), card: patch.card ?? before.card });
        mdb.updateMessage(threadId, next);
        this.emit({ type: "message.patch", threadId, message: next, before });
        return next;
      }
      const t = this.thread(threadId);
      const idx = t.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) { if (within) transaction(() => within()); return null; }
      const next = sanitizeMessageDiagnostic({ ...t.messages[idx], ...boundRemovedText(patch), card: patch.card ?? t.messages[idx].card });
      // SQLite is the durable source of truth. Persist before changing memory so
      // a failed write cannot make this process believe a card was answered
      // while a restart would still show it as pending.
      mdb.updateMessage(threadId, next, within);
      const before = t.messages[idx];
      t.messages[idx] = next;
      this.grew(threadId, t, messageBytes(next) - messageBytes(before));
      this.emit({ type: "message.patch", threadId, message: next, before });
      return next;
    });
  }

  bot(id: string) {
    return this.bots.find((b) => b.id === id) ?? null;
  }

  botByThread(threadId: string) {
    // one map look per bot, never a walk of its tasks
    for (const bot of this.bots) if (bot.threadId === threadId || this.taskIndex(bot.tasks)?.byThread.has(threadId)) return bot;
    return null;
  }

  createBot(
    profile: Partial<
      Pick<BotRecord, "name" | "title" | "description" | "color" | "mascotExpression" | "mascotBody" | "modelSelection" | "section">
    > = {},
    opts: {
      /** false = no greeting/onboarding seed. Imported bots must not open
       * with a first-person greeting the user never asked for. */
      seedMessages?: boolean;
      /** A bot made by a caller that proved nothing (route-policy.ts): no
       *  computer, browser or connected apps until the owner turns them on. */
      noAccess?: boolean;
    } = {},
  ): BotRecord {
    // Control characters never reach a name (imports included; Kimi audit #1).
    const name = profile.name?.replace(/[\x00-\x1f\x7f]/g, "").trim() || pickBotName(this.bots.map((b) => b.name));
    const section = sectionKey(profile.section);
    // A fresh id is checked before anything uses it: on a Cloud home a tombstoned id (a deleted
    // bot's released state) must never come back, so the guard may throw and nothing is created.
    const id = newId();
    this.botIdGuard?.(id);
    const bot: BotRecord = {
      id,
      threadId: newId(),
      name,
      title: profile.title ?? "",
      description: profile.description ?? "",
      notifications: true,
      color: profile.color ?? (this.bots.length === 0 ? DEFAULT_BOT_COLOR : COLORS[this.bots.length % COLORS.length]),
      ...(profile.mascotExpression ? { mascotExpression: profile.mascotExpression } : {}),
      ...(profile.mascotBody ? { mascotBody: profile.mascotBody } : {}),
      unread: false,
      modelSelection: this.completeNewBotSelection(profile.modelSelection ?? this.defaultSelection()),
      resumeCursors: {},
      createdAt: Date.now(),
      // a new bot has done nothing yet: Auto asks before it first uses this computer
      hostComputerConsent: "ask",
    };
    if (section) bot.section = section;
    bot.voice = pickDefaultVoice(this.bots);
    bot.voiceAssigned = true;
    if (opts.noAccess) { bot.computer = "off"; bot.browser = false; bot.composio = false; }
    bot.tasks = [{ threadId: bot.threadId, title: UNTITLED_TASK, createdAt: bot.createdAt, resumeCursors: {},modelSelection:structuredClone(bot.modelSelection),autoApprove:false,alwaysAllow:[],unread:false }];
    this.bots.unshift(bot);
    this.saveBots();
    // Announce the owner before its onboarding transcript. SSE clients need
    // the bot/thread mapping before they can place either message.
    this.emit({ type: "bot", botId: bot.id });
    if (opts.seedMessages !== false) {
      this.appendMessage(bot.threadId, murageLine({ role: "bot", kind: "text", text: openingLine(name) }));
      this.appendMessage(bot.threadId, murageLine({ role: "bot", kind: "options", card: intakeOpeningQuestion() }));
    }
    return bot;
  }

  /** Remove a bot for good: its record, every task transcript, its
   * workspace and its approval state. Nothing else.
   *
   * What stays, deliberately: every channel the bot sat in, with its whole
   * history. Only the bot's seat is dropped from the roster — the messages
   * it said keep the name and colour they were said with (`Message.from`),
   * which is the tombstone the renderer already draws for an unknown
   * member. A channel whose lead responder was the deleted bot is handed
   * to its first remaining member; one left with nobody stays standing,
   * empty, for the user to delete or repopulate. Cascading into channels
   * would take other bots' conversations with them.
   *
   * Ordering is the atomicity: the roster (bots.json + groups.json) is
   * written FIRST and is the commit point. A failed write throws with the
   * record, transcripts and workspace all untouched, so the delete can be
   * retried. Everything after the commit is cleanup of data nothing can
   * reach any more and is best-effort — a failure there is logged, never
   * thrown, so a half-finished cleanup can never resurrect a half-bot. */
  /** Rules 57b..c, r3 "Rename": every grant on the mount `mountId` is deleted from every bot record and every task of
   *  it, in one roster write that lands before any live record changes. A failed write throws with nothing changed.
   *  Returns how many records lost a grant. */
  dropMountGrants(mountId: string): number {
    const onMount = (key: string) => parseAcpToolKey(key.replace(/^local-computer:/, ""))?.mountId === mountId;
    const without = (keys: string[] | undefined) => keys?.some(onMount) ? keys.filter((key) => !onMount(key)) : undefined;
    const changedIds = new Set<string>();
    let records = 0;
    const nextBots = this.bots.map((bot) => {
      const own = without(bot.alwaysAllow);
      const tasks = bot.tasks?.map((task) => { const kept = without(task.alwaysAllow); if (!kept) return task; records++; return { ...task, alwaysAllow: kept }; });
      const tasksChanged = tasks?.some((task, index) => task !== bot.tasks![index]) ?? false;
      if (!own && !tasksChanged) return bot;
      if (own) records++;
      changedIds.add(bot.id);
      return { ...bot, ...(own ? { alwaysAllow: own } : {}), ...(tasksChanged ? { tasks } : {}) };
    });
    if (!changedIds.size) return 0;
    this.saveBots(nextBots);
    for (const bot of this.bots) if (changedIds.has(bot.id)) Object.assign(bot, nextBots.find((next) => next.id === bot.id));
    for (const botId of changedIds) this.emit({ type: "bot", botId });
    return records;
  }

  /** A deleted bot leaves every other bot's Can talk to picks. */
  pruneMessageAllow(deletedId: string): void {
    let changed = false;
    for (const other of this.bots) {
      const allow = other.messageAllow;
      if (!allow || allow.mode !== "list") continue;
      if (!(allow.botIds ?? []).includes(deletedId) && !(allow.grantedBy ?? []).includes(deletedId)) continue;
      const botIds = (allow.botIds ?? []).filter((x) => x !== deletedId);
      const grantedBy = (allow.grantedBy ?? []).filter((x) => x !== deletedId);
      other.messageAllow = botIds.length ? { mode: "list", botIds, ...(grantedBy.length ? { grantedBy } : {}) } : undefined;
      if (!other.messageAllow) delete other.messageAllow;
      changed = true;
    }
    if (changed) { try { this.saveBots(this.bots); } catch (error) { console.error("store: could not prune Can talk to picks", error); } }
  }

  /** Cloud home hooks (server/cloud-home/bot-state.ts), unset on a desktop. `botIdGuard` throws for an
   * id the launcher has tombstoned; `releaseBotState` throws unless the bot's launcher-side state has
   * been released, and runs BEFORE the durable deletion so a refusal leaves the bot exactly as it was. */
  botIdGuard?: (id: string) => void;
  releaseBotState?: (id: string) => void;

  deleteBot(id: string): boolean {
    const bot = this.bot(id);
    if (!bot) return false;
    // Before any change: if the launcher still holds this bot's state the error propagates and the bot stays.
    this.releaseBotState?.(id);
    const nextBots = this.bots.filter((b) => b.id !== id);
    const seated = this.groups.filter((g) => g.memberIds.includes(id));
    const priorSeats = new Map(seated.map((g) => [g.id, { memberIds: g.memberIds, defaultResponder: g.defaultResponder }]));
    for (const group of seated) {
      group.memberIds = group.memberIds.filter((memberId) => memberId !== id);
      group.defaultResponder = normalizeGroupDefaultResponder(group.defaultResponder, group.memberIds, Boolean(group.dm));
    }
    // The owner's deletion of every conversation of this bot is recorded durably BEFORE the registry forgets the bot:
    // a crash between the two leaves proof for each thread's sends and room requests instead of orphans nobody can purge.
    const botThreadIds = [...new Set([bot.threadId, ...(bot.tasks ?? []).map((t) => t.threadId)])];
    transaction((db) => { for (const threadId of botThreadIds) recordOwnerDeletion(db, threadId); recordOwnerDeletion(db, botDeletionKey(id)); });
    try {
      this.saveBots(nextBots);
    } catch (error) {
      for (const group of seated) Object.assign(group, priorSeats.get(group.id));
      // the bot is still there: its conversations were not deleted, so the proof written above is withdrawn
      try { transaction((db) => { for (const threadId of botThreadIds) withdrawOwnerDeletion(db, threadId); withdrawOwnerDeletion(db, botDeletionKey(id)); }); } catch (e) { console.error("store: could not withdraw deletion record", e); }
      throw error;
    }
    this.bots = nextBots;
    this.refreshPendingThreads(botThreadIds);
    this.pruneMessageAllow(id);
    transaction(db => captureBotDeletion(db, id));
    if (seated.length) {
      try {
        this.saveGroups();
      } catch (error) {
        // the bot is already gone durably; a seat that could not be written
        // is filtered on every read and pruned again by the next group save
        console.error("store: deleteBot could not persist channel seats", error);
      }
    }
    // every task's transcript goes with the bot, not just the open one
    for (const threadId of new Set([bot.threadId, ...(bot.tasks ?? []).map((t) => t.threadId)])) {
      try {
        this.deleteThreadRecord(threadId);
      } catch (error) {
        console.error(`store: deleteBot could not remove thread ${threadId}`, error);
      }
    }
    // the bot's workspace (files + memory) goes with it — same rule as its
    // transcripts: deleting a bot deletes what it knew
    try {
      rmSync(workspaceDir(id), { recursive: true, force: true });
      for (const suffix of ["general", "teams", "projects", "rooms"]) rmSync(workspaceDir(id) + "." + suffix, { recursive: true, force: true });
    } catch {}
    // Approval state deliberately lives outside the bot-writable workspace.
    // It still belongs to the bot, so deleting the bot must remove staged
    // proposals, manifests, and native-link ownership records with it.
    try {
      rmSync(join(DATA_DIR, "skill-state", id), { recursive: true, force: true });
    } catch {}
    // Checkpoint shadow repos (checkpoints.ts shadowDir) are snapshots the
    // bot's own threads offered to roll back to. With the threads gone
    // nothing can reach them, and a full-folder snapshot per working
    // directory is the largest thing a bot leaves behind.
    try {
      rmSync(join(DATA_DIR, "checkpoints", id), { recursive: true, force: true });
    } catch {}
    for (const group of seated) this.emit({ type: "group", groupId: group.id });
    this.emit({ type: "bot.deleted", botId: id });
    return true;
  }

  patchBot(id: string, patch: Partial<BotRecord>, options: {preserveTaskSettings?:boolean} = {}): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    if (Object.hasOwn(patch, "section")) { assertSectionUnlocked(); assertHomeMove(bot, patch.section); }
    if (!options.preserveTaskSettings && patch.modelSelection && patch.modelSelection.connectionId !== bot.modelSelection.connectionId) {
      const tasks = patch.tasks ?? bot.tasks;
      patch = { ...patch, ...(tasks?.length===1 ? {resumeCursors:{},tasks:tasks.map(task=>({...task,resumeCursors:{},modelSelection:structuredClone(patch.modelSelection!)}))} : {}) };
    }
    const partitionedAt = bot.partitionedAt ?? patch.partitionedAt ?? (patch.sharedWith && patch.sharedWith.mode !== "none" ? Date.now() : undefined);
    const formerName = bot.name;
    const continuityChanged = (bot.continuity === true || patch.continuity === true) && ["continuity", "continuityOptions", "modelSelection"].some(key => Object.hasOwn(patch, key) && JSON.stringify(bot[key as keyof BotRecord]) !== JSON.stringify(patch[key as keyof BotRecord]));
    const continuityGeneration = bot.continuityGeneration ?? 0;
    Object.assign(bot, patch);
    if (continuityChanged) bot.continuityGeneration = continuityGeneration + 1;
    // an owner's edit of the voice makes it theirs
    if ((Object.hasOwn(patch, "voice") || Object.hasOwn(patch, "voiceProvider"))) delete bot.voiceAssigned;
    if (bot.name !== formerName) for (const task of bot.tasks ?? []) {
      const team = task.sharedWork ? teamLabel(task.sharedWork.teamId) : null;
      if (team && task.title === workThreadTitle(formerName, team)) task.title = workThreadTitle(bot.name, team);
    }
    if (partitionedAt !== undefined) bot.partitionedAt = partitionedAt;
    if(bot.tasks?.length===1){
      const task=bot.tasks[0];
      for(const key of ["modelSelection","autoApprove","fullAccess","noLimits","alwaysAllow","unread","rewound","pinnedMessageId","resumeCursors"] as const)if(Object.hasOwn(patch,key)&&(!options.preserveTaskSettings||!["modelSelection","autoApprove","fullAccess","noLimits","alwaysAllow"].includes(key)))Object.assign(task,{[key]:structuredClone(patch[key])});
    }
    this.saveBots();
    this.emit({ type: "bot", botId: id });
    return bot;
  }

  /** A13-FIX-DESIGN C1 (Rule 81b): remember an approved set on the bot's
   * defaults AND, when named, one task, in ONE durable write. The next bots
   * file is staged and written before any live record changes, so a failed
   * write leaves memory and disk exactly as they were. Keys already held are
   * not added twice; past the cap nothing is saved. Returns the keys it
   * added to each, so the caller can take back exactly those. Called only by
   * the approval choke point (server/index.ts rememberAndAnswer). */
  rememberBotGrants(botId: string, taskThreadId: string | undefined, keys: readonly string[], options: { grantSchema?: 2 } = {}): { bot: BotRecord; added: { bot: string[]; task: string[] } } {
    const { bot, task, added } = this.planBotGrants(botId, taskThreadId, keys);
    return this.stageBotGrants(bot, task, [...(bot.alwaysAllow ?? []), ...added.bot], task ? [...(task.alwaysAllow ?? []), ...added.task] : undefined, options.grantSchema, added);
  }

  /** What rememberBotGrants would add, and the records it would add to,
   * without writing anything: the choke point validates a choice with this
   * BEFORE its answer is delivered, and writes only after. Throws (with a
   * status) for a missing bot or task and past the cap. */
  planBotGrants(botId: string, taskThreadId: string | undefined, keys: readonly string[]): { bot: BotRecord; task: TaskRecord | undefined; added: { bot: string[]; task: string[] } } {
    const bot = this.bot(botId);
    if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
    const task = taskThreadId === undefined ? undefined : bot.tasks?.find((item) => item.threadId === taskThreadId);
    if (taskThreadId !== undefined && !task) throw Object.assign(new Error("No such thread for this bot."), { status: 404 });
    const unique = [...new Set(keys)];
    const addBot = unique.filter((key) => !(bot.alwaysAllow ?? []).includes(key));
    const addTask = task ? unique.filter((key) => !(task.alwaysAllow ?? []).includes(key)) : [];
    if ((bot.alwaysAllow?.length ?? 0) + addBot.length > 200 || (task && (task.alwaysAllow?.length ?? 0) + addTask.length > 200)) {
      throw Object.assign(new Error("This bot already remembers 200 approvals. Remove some in Settings, Permissions, then try again."), { status: 409 });
    }
    return { bot, task, added: { bot: addBot, task: addTask } };
  }

  private stageBotGrants<T>(bot: BotRecord, task: TaskRecord | undefined, botKeys: string[], taskKeys: string[] | undefined, grantSchema: 2 | undefined, result: T): { bot: BotRecord; added: T } {
    const nextTask = task && taskKeys ? { ...task, alwaysAllow: taskKeys } : undefined;
    const nextBot: BotRecord = {
      ...bot,
      alwaysAllow: botKeys,
      ...(grantSchema ? { grantSchema } : {}),
      ...(nextTask ? { tasks: bot.tasks!.map((item) => (item === task ? nextTask : item)) } : {}),
    };
    this.saveBots(this.bots.map((item) => (item === bot ? nextBot : item)));
    bot.alwaysAllow = botKeys;
    if (grantSchema) bot.grantSchema = grantSchema;
    if (task && taskKeys) task.alwaysAllow = taskKeys;
    this.emit({ type: "bot", botId: bot.id });
    return { bot, added: result };
  }

  /** File visible bots into one sidebar section as a single durable write.
   *
   * This deliberately stages the complete next file before touching the
   * live records. A missing/hidden target therefore changes nothing, and a
   * failed atomic write cannot leave memory ahead of disk. A Chief collision
   * is refused rather than silently removing somebody's coordinator role. */
  setBotsSection(
    botIds: string[],
    section: string,
  ): { ok: true; bots: BotRecord[] } | { ok: false; reason: "unavailable" | "chief-conflict" } {
    const ids = [...new Set(botIds)];
    const targets = ids.map((id) => this.bot(id));
    if (targets.some((bot) => !bot || bot.hidden)) return { ok: false, reason: "unavailable" };

    assertSectionUnlocked();
    for (const bot of targets) if (bot) assertHomeMove(bot, section);
    const targetSection = sectionKey(section);
    const selected = targets as BotRecord[];
    const destinationChiefIds = new Set([
      ...selected.filter((bot) => bot.chiefOfStaff).map((bot) => bot.id),
      ...this.bots
        .filter((bot) => bot.chiefOfStaff && sectionKey(bot.section) === targetSection)
        .map((bot) => bot.id),
    ]);
    if (destinationChiefIds.size > 1) return { ok: false, reason: "chief-conflict" };

    const patches = new Map<string, Partial<BotRecord>>();
    for (const bot of selected) {
      patches.set(bot.id, { section: targetSection || undefined });
    }

    const changedIds = new Set<string>();
    const nextBots = this.bots.map((bot) => {
      const patch = patches.get(bot.id);
      if (!patch) return bot;
      const next = { ...bot, ...patch };
      if (JSON.stringify(next) !== JSON.stringify(bot)) changedIds.add(bot.id);
      return next;
    });
    if (changedIds.size) {
      this.saveBots(nextBots);
      for (const bot of this.bots) {
        const patch = patches.get(bot.id);
        if (patch) Object.assign(bot, patch);
      }
      for (const botId of changedIds) this.emit({ type: "bot", botId });
    }
    return { ok: true, bots: ids.map((id) => this.bot(id)!) };
  }

  /** Apply one owner team change (rename, members, delete) to bots and
   * channels together. Like setBotsSection, the next bots file is written
   * before any live record changes; the channels follow, and a failed
   * channel write puts the bots file back. A patch value of `undefined`
   * removes that field, so "no team" is stored as an absent section. The
   * caller (team-sections.ts) owns the one-lead-per-team rule. */
  applyTeamChange(
    botPatches: ReadonlyMap<string, Partial<BotRecord>>,
    groupPatches: ReadonlyMap<string, Partial<GroupRecord>>,
    journal?: typeof TEAM_JOURNAL,
  ): void {
    if (journal !== TEAM_JOURNAL) {
      assertSectionUnlocked();
      for (const [id, patch] of botPatches) if (Object.hasOwn(patch, "section")) { const bot = this.bot(id); if (bot) assertHomeMove(bot, patch.section); }
    }
    const merge = <T extends object>(record: T, patch: Partial<T>): T => {
      const next = { ...record, ...patch };
      for (const [key, value] of Object.entries(patch)) if (value === undefined) delete (next as Record<string, unknown>)[key];
      return next;
    };
    const previousBots = this.bots;
    const nextBots = this.bots.map((bot) => (botPatches.has(bot.id) ? merge(bot, botPatches.get(bot.id)!) : bot));
    const previousGroups = this.groups.map((group) => ({ ...group }));
    const replace = <T extends object>(live: T, next: T) => {
      for (const key of Object.keys(live)) if (!(key in next)) delete (live as Record<string, unknown>)[key];
      Object.assign(live, next);
    };
    if (botPatches.size) {
      this.saveBots(nextBots);
      // Live before the channels are saved: that save reconciles memory
      // scopes from the live roster, and must see the new labels.
      for (const bot of this.bots) if (botPatches.has(bot.id)) replace(bot, nextBots.find((next) => next.id === bot.id)!);
    }
    if (groupPatches.size) {
      try {
        for (const group of this.groups) if (groupPatches.has(group.id)) replace(group, merge(group, groupPatches.get(group.id)!));
        this.saveGroups();
      } catch (error) {
        this.groups.forEach((group, index) => replace(group, previousGroups[index]));
        if (botPatches.size) {
          this.saveBots(previousBots);
          for (const bot of this.bots) if (botPatches.has(bot.id)) replace(bot, previousBots.find((prior) => prior.id === bot.id)!);
        }
        throw error;
      }
    }
    for (const id of botPatches.keys()) this.emit({ type: "bot", botId: id });
    for (const id of groupPatches.keys()) this.emit({ type: "group", groupId: id });
  }

  /** The one way runtime state changes. Sets `activity` and derives `busy`
   * from it, so a reader that only knows busy sees the same truth. */
  setActivity(botId: string, activity: BotActivity): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    if ((this.legacyActivities.get(botId)??"idle")===activity) return bot;
    this.legacyActivities.set(botId,activity);
    this.refreshBotActivity(bot);
    this.emit({ type: "bot", botId });
    return bot;
  }

  setTaskActivity(botId:string,threadId:string,activity:BotActivity):BotRecord|null {
    const bot=this.bot(botId),task=this.taskByThread(botId,threadId);
    if(!bot||!task)return null;
    const wasBusy=Boolean(task.busy);
    task.activity=activity;task.busy=ACTIVITY_BUSY.has(activity);if(activity!=="working")delete task.waitingFor;
    // The turn's start is its first busy transition: an approval parked on
    // waiting-on-you keeps the anchor, and only idle clears it.
    if(task.busy&&!wasBusy)task.turnStartedAt=Date.now();else if(!task.busy)delete task.turnStartedAt;
    this.refreshBotActivity(bot);
    this.emit({type:"bot",botId});return bot;
  }

  /** Runtime-only waiting marker for a busy task; cleared by any non-working
   * activity, so a stopped or failed turn can never keep showing it. */
  setTaskWaiting(botId:string,threadId:string,waitingFor?:TaskResourceWait):void {
    const task=this.taskByThread(botId,threadId);
    if(!task)return;
    const next=waitingFor&&task.activity==="working"?{...waitingFor}:undefined;
    if(JSON.stringify(task.waitingFor)===JSON.stringify(next))return;
    if(next)task.waitingFor=next;else delete task.waitingFor;
    this.emit({type:"bot",botId});
  }
  private refreshBotActivity(bot:BotRecord){
    const values=[this.legacyActivities.get(bot.id),...(bot.tasks??[]).map(task=>task.activity)];
    bot.activity=(["waiting-on-you","no-signal","working","dead"] as const).find(value=>values.includes(value))??"idle";
    bot.busy=ACTIVITY_BUSY.has(bot.activity);
  }

  /** Elect one Chief of Staff in its section (or clear one section) as one persisted change.
   * The changed records are returned so the server can update every open
   * window, including the bot that just handed the role over.
   *
   * `scope` decides the elected bot's TIER and is deliberately tri-state:
   * omitted leaves the tier exactly as it was (what every pre-existing
   * caller wants — re-asserting a section election must not silently demote
   * the workspace Chief), `"section"` demotes this bot to its section's
   * lead, `"workspace"` promotes it and demotes the previous holder to lead
   * of its own section rather than stripping its Chief role. */
  /** The Chief of Staff, if this workspace has one.
   *
   * The role is single-holder and, unlike a team lead, it is NOT a handover:
   * electing a second one is refused and the incumbent has to be stood down
   * first. That is a deliberate asymmetry. A team's lead changing is ordinary
   * and reversible; the Chief is the one bot the whole workspace routes
   * through, and replacing her by accident — a mis-click on a role control,
   * a package import naming a coordinator — silently rewires everything and
   * looks like nothing happened. Refusing costs one extra step and makes the
   * change something a person decided rather than something that occurred. */
  workspaceChief(): BotRecord | null {
    return this.bots.find((bot) => !bot.hidden && isWorkspaceChief(bot)) ?? null;
  }

  setChiefOfStaff(
    id: string | null,
    section?: string | null,
    scope?: "section" | "workspace",
  ): BotRecord[] | null {
    const selected = id ? this.bot(id) : null;
    if (id && !selected) return null;
    const targetSection = sectionKey(selected?.section ?? section);
    const changed: BotRecord[] = [];
    const touch = (bot: BotRecord) => {
      if (!changed.includes(bot)) changed.push(bot);
    };
    for (const bot of this.bots) {
      if (sectionKey(bot.section) !== targetSection) continue;
      const next = bot.id === id;
      if (Boolean(bot.chiefOfStaff) === next && !(next && bot.hidden)) continue;
      if (next) {
        bot.chiefOfStaff = true;
        // A section's main contact must stay reachable in the sidebar.
        bot.hidden = false;
        // Opposite ends of the same chart: a bot that leads cannot also be
        // one that works alone underneath the Chief. Electing is an explicit
        // human act with a visible result, so this resolves rather than
        // refuses; the reverse direction (setIndividual) refuses instead,
        // because there the role being discarded is the bigger one.
        if (bot.individual) delete bot.individual;
      } else {
        // The workspace Chief is not this section's lead. It sits ABOVE every
        // section and hands each team's work to that team's leader, so it is
        // not a competitor for the slot being filled here — and this loop
        // walks by section, which means it meets the Chief whenever the Chief
        // happens to sit in the section being elected.
        //
        // That is not an edge case, it is the default: a workspace where
        // nobody created a section has every bot on sectionKey "", so the
        // Chief shares a section with everyone. Clearing the flag here fired
        // the Chief of Staff every time a human pressed "Team leader" on any
        // teammate — and took `chiefScope` with it, which the sidebar's
        // "Make Chief of Staff" (a re-election with no scope) cannot give
        // back. One click, and the workspace had no Chief and no way to say so.
        //
        // Handing the WORKSPACE tier over is the one case that may move this
        // bot, and it is handled below by dropping the tier alone — leaving
        // the old holder leading its own section, which is exactly what the
        // role control's copy promises.
        //
        // Only while somebody is actually being ELECTED. `setChiefOfStaff(null,
        // section)` is a human explicitly clearing that section's role, which
        // is allowed to reach the Chief sitting in it — there is no incoming
        // lead for it to be displaced by.
        if (id !== null && bot.chiefScope === "workspace") continue;
        bot.chiefOfStaff = false;
        // The tier is a modifier on the flag; losing the flag loses it too.
        if (bot.chiefScope) delete bot.chiefScope;
      }
      touch(bot);
    }
    if (scope === "workspace") {
      for (const bot of this.bots) {
        const wants = bot.id === id && bot.chiefOfStaff === true;
        if (Boolean(bot.chiefScope) === wants) continue;
        if (wants) bot.chiefScope = "workspace";
        else delete bot.chiefScope;
        touch(bot);
      }
    } else if (scope === "section" && selected?.chiefScope) {
      delete selected.chiefScope;
      touch(selected);
    }
    if (changed.length) this.saveBots();
    for (const bot of changed) this.emit({ type: "bot", botId: bot.id });
    return changed;
  }

  /** Mark a bot as an Individual Assistant, or clear the mark: one that
   * works alone in its own group, reporting straight to the workspace Chief
   * of Staff with no team leader in between.
   *
   * Refused rather than silently resolved while the bot leads something.
   * The reverse (setChiefOfStaff) resolves, because there the human just
   * asked for the larger role; here, quietly stripping a Chief or a team
   * leader of the team it runs would throw away the role they did choose,
   * and there is nowhere on this call to tell them it happened. The caller
   * gets `chief-conflict` and a sentence to show. */
  setIndividual(
    id: string,
    individual: boolean,
  ): { ok: true; bot: BotRecord } | { ok: false; reason: "unavailable" | "chief-conflict" } {
    const bot = this.bot(id);
    if (!bot) return { ok: false, reason: "unavailable" };
    if (individual && bot.chiefOfStaff) return { ok: false, reason: "chief-conflict" };
    if (Boolean(bot.individual) === individual) return { ok: true, bot };
    // Absent, never `false` — the load-time pass normalises the same way, so
    // one shape means "no" both in memory and on disk.
    if (individual) bot.individual = true;
    else delete bot.individual;
    this.saveBots();
    this.emit({ type: "bot", botId: id });
    return { ok: true, bot };
  }

  setResumeCursor(botId: string, instanceId: string, cursor: unknown, threadId?: string, audience?: string, contract?: number, plainToolNames = false, incarnation?: number) {
    const bot = this.bot(botId);
    if (!bot) return;
    // the cursor belongs to the task that produced it, not to the bot
    const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
    if (task) {
      task.resumeCursors[instanceId] = cursor;
      // and to the audience it was made for (SPEC-P 13.1)
      if (audience !== undefined) task.resumeAudiences = { ...task.resumeAudiences, [instanceId]: audience };
      // and to the session contract it was made under (claude.ts CLAUDE_ISOLATION_CONTRACT)
      if (contract !== undefined) task.resumeContracts = { ...task.resumeContracts, [instanceId]: contract };
      else if (task.resumeContracts && Object.hasOwn(task.resumeContracts, instanceId)) {
        const { [instanceId]: _dropped, ...rest } = task.resumeContracts;
        task.resumeContracts = rest;
      }
      // and to the connected-app names its session was shown: a cursor an earlier release made keeps its older names
      if (plainToolNames && cursor !== undefined) task.resumePlainToolNames = { ...task.resumePlainToolNames, [instanceId]: true };
      else if (task.resumePlainToolNames && Object.hasOwn(task.resumePlainToolNames, instanceId)) {
        const { [instanceId]: _dropped, ...rest } = task.resumePlainToolNames;
        task.resumePlainToolNames = rest;
      }
      // and to the incarnation its session was started under (S6 rule 27): a resume forms the same memory key
      if (cursor !== undefined && incarnation !== undefined && incarnation >= 2) task.resumeIncarnations = { ...task.resumeIncarnations, [instanceId]: incarnation };
      else if (task.resumeIncarnations && Object.hasOwn(task.resumeIncarnations, instanceId)) {
        const { [instanceId]: _dropped, ...rest } = task.resumeIncarnations;
        task.resumeIncarnations = rest;
      }
    }
    // The legacy mirror follows the task visible in chat, never a detached
    // routine task working in the background.
    if (!threadId || bot.threadId === threadId) bot.resumeCursors[instanceId] = cursor;
    this.saveBots(this.bots, { defer: true });
    this.emit({ type: "bot", botId });
  }

  /** Record which instance just took a turn on this task. Called at
   * dispatch, not at cursor time — transcript-replay engines never
   * produce a cursor, and they still count as having run last. */
  markTaskDispatched(botId: string, threadId: string, instanceId: string) {
    const task = this.taskByThread(botId, threadId);
    if (!task || task.lastInstanceId === instanceId) return;
    task.lastInstanceId = instanceId;
    this.saveBots(this.bots, { defer: true });
  }

  /** Thread recall seal (design S1, r11 23b): bump this task's
   * `sealGeneration` and save the roster with the immediate save, which
   * throws when the write fails. The caller releases nothing on a throw. The
   * in-memory bump stays either way: the seal never decreases. */
  sealThread(botId: string, threadId: string): number {
    const task = this.taskByThread(botId, threadId);
    if (!task) throw new Error("thread recall: no task for this thread");
    task.sealGeneration = (task.sealGeneration ?? 0) + 1;
    this.saveBots();
    return task.sealGeneration;
  }

  /** Queue a message this thread owes the engine: appended outside any
   * provider turn, so no session can contain it. */
  recordTaskExternalUpdate(botId: string, threadId: string, messageId: string) {
    const task = this.taskByThread(botId, threadId);
    if (!task) return;
    task.externalUpdates = queueExternalUpdate(task.externalUpdates, messageId);
    this.notePendingHolder(threadId, task);
    this.saveBots();
  }

  /** Drop exactly the owed messages a dispatch carried. Anything queued
   * while that turn was being set up is not in `ids`, stays pending, and is
   * delivered by the next turn instead of being lost to this one. */
  consumeTaskExternalUpdates(botId: string, threadId: string, ids: readonly string[]) {
    const task = this.taskByThread(botId, threadId);
    if (!task?.externalUpdates?.length || ids.length === 0) return;
    const carried = new Set(ids);
    const remaining = task.externalUpdates.filter((id) => !carried.has(id));
    if (remaining.length === task.externalUpdates.length) return;
    if (remaining.length) task.externalUpdates = remaining;
    else delete task.externalUpdates;
    this.notePendingHolder(threadId, task);
    this.saveBots();
  }

  continuationHolder(botId: string, threadId: string): TaskRecord | GroupTaskRecord | GroupRecord | undefined {
    const task = this.taskByThread(botId, threadId);
    if (task) return task;
    const group = this.groupByThread(threadId);
    return group?.dm ? group : group ? this.groupTaskByThread(group.id, threadId) : undefined;
  }

  /** Whether a holder has work the held drain must look at: an item held, a message owed the engine, or a queue row still to settle. */
  private static holdsPendingWork(holder: { heldContinuations?: unknown[]; heldQueueRowId?: string; externalUpdates?: string[] } | undefined): boolean {
    return Boolean(holder && (holder.heldQueueRowId || holder.heldContinuations?.length || holder.externalUpdates?.length));
  }

  /** Every write that changes a holder's held work calls this with the holder it changed. */
  private notePendingHolder(threadId: string, holder: Parameters<typeof Store.holdsPendingWork>[0]): void {
    const pending = this.pendingWork ??= this.scanPendingWork();
    if (Store.holdsPendingWork(holder)) pending.add(threadId);
    else pending.delete(threadId);
  }

  /** The pending set as the records say it is: one walk of every bot task and every room holder. */
  private scanPendingWork(): Set<string> {
    const pending = new Set<string>();
    for (const bot of this.bots) for (const task of bot.tasks ?? []) if (Store.holdsPendingWork(task)) pending.add(task.threadId);
    for (const group of this.groups) {
      if (Store.holdsPendingWork(group)) pending.add(group.threadId);
      for (const task of group.tasks ?? []) if (Store.holdsPendingWork(task)) pending.add(task.threadId);
    }
    return pending;
  }

  /** Whether any thread has pending held work (the 30 s drain skips every bot when none does). */
  hasPendingWork(): boolean {
    return (this.pendingWork ??= this.scanPendingWork()).size > 0;
  }

  /** The threads the held drain of this bot must visit: the pending ones only, in the order the full walk visited them (its own task
   * threads in task order, then each of its rooms in room order, the room's thread then its tasks). A thread of this bot that no
   * longer holds anything leaves the set here. Each thread costs a few map looks, never a walk of tasks or rooms. */
  pendingThreadsFor(botId: string): string[] {
    const walk = this.selectPending(botId, Infinity);
    for (let step = walk.next(); ; step = walk.next()) if (step.done) return step.value;
  }

  /** pendingThreadsFor, handing the loop back (`pause`) after every `every` threads: thousands of held threads never hold the loop. */
  async pendingThreadsForSliced(botId: string, pause: () => Promise<unknown>, every = PENDING_SLICE): Promise<string[]> {
    const walk = this.selectPending(botId, every);
    for (let step = walk.next(); ; step = walk.next()) {
      if (step.done) return step.value;
      await pause();
    }
  }

  private *selectPending(botId: string, every: number): Generator<void, string[], void> {
    const pending = this.pendingWork ??= this.scanPendingWork();
    let bot = this.bot(botId);
    if (!pending.size || !bot) return [];
    let own = this.taskIndex(bot.tasks), rooms = this.groupThreadIndex(), seen = 0;
    const keyed: Array<{ threadId: string; key: [number, number, number] }> = [];
    for (const threadId of [...pending]) {
      if (++seen % every === 0) {
        yield;
        // the records may have changed while the loop was handed back: look again
        bot = this.bot(botId);
        if (!bot) return [];
        own = this.taskIndex(bot.tasks); rooms = this.groupThreadIndex();
      }
      if (!pending.has(threadId)) continue;
      const mine = own?.byThread.get(threadId);
      if (mine) {
        if (Store.holdsPendingWork(mine.task)) keyed.push({ threadId, key: [0, mine.index, 0] });
        else pending.delete(threadId);
        continue;
      }
      // the first place of the thread in a room of this bot, as the full walk met it; the holder is continuationHolder's
      const place = rooms.places.get(threadId)?.find(entry => entry.group.memberIds.includes(botId));
      if (!place) continue;
      const group = rooms.byThread.get(threadId)!;
      const holder = group.dm ? group : rooms.tasks.get(group)?.get(threadId);
      if (Store.holdsPendingWork(holder)) keyed.push({ threadId, key: [1, place.groupIndex, place.pos + 1] });
      else pending.delete(threadId);
    }
    keyed.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
    return keyed.map(entry => entry.threadId);
  }

  /** Whether any record holding this thread has pending work: a bot's task, a room's own thread or a room's task (scanPendingWork's
   * holders), by map look. */
  private threadHoldsPendingWork(threadId: string): boolean {
    for (const bot of this.bots) if (Store.holdsPendingWork(this.taskIndex(bot.tasks)?.byThread.get(threadId)?.task)) return true;
    return (this.groupThreadIndex().places.get(threadId) ?? []).some(place => Store.holdsPendingWork(place.pos < 0 ? place.group : place.task));
  }

  /** Threads whose records were removed or replaced (a deleted task, room or bot, an import): each leaves the set unless something
   * still holding it has work, so a deletion leaves no stale entry for the drain to look at. */
  private refreshPendingThreads(threadIds: Iterable<string>): void {
    const pending = this.pendingWork;
    if (!pending) return;
    for (const threadId of threadIds) {
      if (this.threadHoldsPendingWork(threadId)) pending.add(threadId);
      else pending.delete(threadId);
    }
  }

  /** Puts the pending set back to what the records say, and names what had drifted: `missed` holds threads whose pending work no
   * write recorded (the drain would never have visited them), `stale` threads recorded as pending that hold nothing now. The walk of
   * every record hands the loop back (`pause`) after every `every` records, so the hourly check never holds the server; a record a
   * writer changes meanwhile is kept by that writer. Without `pause` it runs in one go. */
  async reconcilePendingWork(pause?: () => Promise<unknown>, every = PENDING_SLICE): Promise<{ missed: string[]; stale: string[] }> {
    const missed: string[] = [];
    let seen = 0;
    const due = () => pause !== undefined && ++seen % every === 0;
    const check = (threadId: string, holder: Parameters<typeof Store.holdsPendingWork>[0]) => {
      const pending = this.pendingWork ??= this.scanPendingWork();
      if (Store.holdsPendingWork(holder) && !pending.has(threadId)) { pending.add(threadId); missed.push(threadId); }
    };
    // the arrays walked are the ones current when the walk reached them: a task added or removed meanwhile replaces its array, and its writer keeps the set
    for (const bot of this.bots) for (const task of bot.tasks ?? []) { if (due()) await pause!(); check(task.threadId, task); }
    for (const group of this.groups) {
      if (due()) await pause!();
      check(group.threadId, group);
      for (const task of group.tasks ?? []) { if (due()) await pause!(); check(task.threadId, task); }
    }
    // the set itself is pending work, never history: each entry is checked by map look
    const pending = this.pendingWork ??= this.scanPendingWork(), stale: string[] = [];
    for (const threadId of [...pending]) if (!this.threadHoldsPendingWork(threadId)) { pending.delete(threadId); stale.push(threadId); }
    return { missed, stale };
  }

  /** Stable identity deduplicates retries. Entries remain visible until accepted. */
  holdTaskContinuation(botId: string, threadId: string, text: string, context: Omit<HeldContinuation, "id" | "text" | "at"> & { id?: string } = {}): number {
    const task = this.continuationHolder(botId, threadId);
    if (!task) throw new Error("The conversation for this card is unavailable.");
    const id = context.id ?? createHash("sha256").update(JSON.stringify([botId,threadId,context.cardId ?? text,context.runId])).digest("hex");
    const existing = task.heldContinuations?.find(item => item.id === id);
    if (existing) { Object.assign(existing, context, { id, botId, text }); this.notePendingHolder(threadId, task); this.saveBots(); this.saveGroups(); return task.heldContinuations!.length; }
    // No silent overflow: the durable queue retains every accepted request.
    task.heldContinuations = [...(task.heldContinuations ?? []), { ...context, id, botId, text, at: Date.now() }];
    this.notePendingHolder(threadId, task);
    this.saveBots(); this.saveGroups();
    const card = context.cardId ? this.messageById(threadId, context.cardId) : undefined;
    if (card?.card) this.patchMessage(threadId, card.id, { card: { ...card.card, held: "Waiting for an engine with tools." } });
    return task.heldContinuations.length;
  }

  consumeTaskHeldContinuations(botId: string, threadId: string, ids: readonly string[]) {
    const task = this.continuationHolder(botId, threadId);
    if (!task?.heldContinuations?.length || ids.length === 0) return;
    const carried = new Set(ids);
    const delivered = task.heldContinuations.filter(item => carried.has(item.id));
    task.heldContinuations = task.heldContinuations.filter(item => !carried.has(item.id));
    this.notePendingHolder(threadId, task);
    for (const item of delivered) {
      const card = item.cardId ? this.messageById(threadId, item.cardId) : undefined;
      if (card?.card) this.patchMessage(threadId, card.id, { card: { ...card.card, held: undefined } });
    }
    this.saveBots(); this.saveGroups();
  }

  heldItemCount(botId: string, threadId: string): number {
    const task = this.taskByThread(botId, threadId);
    return (task?.externalUpdates?.length ?? 0) + (this.continuationHolder(botId, threadId)?.heldContinuations?.length ?? 0);
  }

  setTaskHeldQueueRow(botId: string, threadId: string, rowId: string | undefined) {
    const task = this.continuationHolder(botId, threadId);
    if (!task || task.heldQueueRowId === rowId) return;
    task.heldQueueRowId = rowId;
    this.notePendingHolder(threadId, task);
    this.saveBots(); this.saveGroups();
  }

  /** Keep (or clear) what a conversation's hand-offs owe it (asker-wake.ts). A conversation that is gone keeps nothing. */
  setTaskAskerWakes(botId: string, threadId: string, snapshot: AskerWakeSnapshot | undefined): void {
    const task = this.taskByThread(botId, threadId);
    if (!task) return;
    if (!snapshot && !task.askerWakes) return;
    const previous = task.askerWakes;
    if (snapshot) task.askerWakes = JSON.parse(JSON.stringify(snapshot)) as AskerWakeSnapshot; else delete task.askerWakes;
    try { this.saveBots(); }
    catch (error) {
      // the disk refused: the record keeps saying what the disk says, so the caller's retry (asker-wake.ts retryWrites) finds something to
      // write instead of returning early on a field already cleared in memory
      if (previous === undefined) delete task.askerWakes; else task.askerWakes = previous;
      throw error;
    }
  }

  setTaskAutomationEvent(botId: string, threadId: string, eventId?: string): void {
    const task = this.taskByThread(botId, threadId);
    if (!task) throw new Error("Automation task is unavailable");
    if (task.automationEventId === eventId) return;
    const previous = task.automationEventId;
    if (eventId === undefined) delete task.automationEventId;
    else task.automationEventId = eventId;
    try { this.saveBots(); }
    catch (error) {
      if (previous === undefined) delete task.automationEventId;
      else task.automationEventId = previous;
      throw error;
    }
  }

  /** Bank one settled turn onto its task. Called once per turn.completed;
   * the running per-driver token indicator is deliberately not used here
   * because its meaning differs by driver. */
  addTaskUsage(
    botId: string,
    threadId: string,
    turn: { input?: number; output?: number; cachedInput?: number; costUsd: number | null },
    /** idempotency key of the provider turn: banked in the same write as the totals, so a redelivery changes nothing */
    turnKey?: string,
  ): TaskUsage | null {
    const task = this.taskByThread(botId, threadId);
    if (!task) return null;
    if (turnKey && task.usageTurnKeys?.includes(turnKey)) return task.usage ?? null;
    const prev: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0, ...task.usage };
    const cost = typeof turn.costUsd === "number" && Number.isFinite(turn.costUsd) ? turn.costUsd : null;
    const prevCost = typeof prev.costUsd === "number" ? prev.costUsd : null;
    // providers occasionally report NaN or a negative on a partial turn —
    // never let that poison a running tally
    const clean = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
    // the cached share exists on a record only once a driver has reported
    // it — a driver that never does leaves the record shaped as before
    const cachedKnown = typeof prev.cachedInput === "number" || typeof turn.cachedInput === "number";
    const prevInput = clean(prev.input);
    const turnInput = clean(turn.input);
    const nextCachedInput = Math.min(clean(prev.cachedInput), prevInput)
      + Math.min(clean(turn.cachedInput), turnInput);
    task.usage = {
      input: prevInput + turnInput,
      output: prev.output + clean(turn.output),
      ...(cachedKnown ? { cachedInput: nextCachedInput } : {}),
      costUsd: cost === null ? prevCost : (prevCost ?? 0) + cost,
      turns: prev.turns + 1,
    };
    if (turnKey) task.usageTurnKeys = [...(task.usageTurnKeys ?? []), turnKey].slice(-64);
    // The month's bucket: one small upsert in the same deferred write, nothing that grows with history.
    const owner = this.bots.find(candidate => candidate.id === botId);
    if (owner) { owner.usageMonths ??= {}; bumpUsageMonth(owner.usageMonths, turn); }
    this.saveBots(this.bots, { defer: true });
    this.emit({ type: "bot", botId });
    return task.usage;
  }

  /** The folder a task's turn runs in. Pins on first call from the bot's
   * current folder — unless the task already has a session (a thread from
   * before folders existed), which pins to the default so the folder can't
   * move under it. Returns the pinned value: a path, or null for default. */
  pinTaskCwd(botId: string, threadId: string, fallbackCwd?: string, opts: { none?: boolean } = {}): string | null {
    const bot = this.bot(botId);
    const task = bot ? this.taskByThread(botId, threadId) : undefined;
    if (!bot || !task) return null;
    if (opts.none) {
      if (task.cwd !== null) {
        task.cwd = null;
        this.saveBots();
        this.emit({ type: "bot", botId });
      }
      return null;
    }
    if (task.cwd === undefined) {
      task.cwd = Object.keys(task.resumeCursors).length === 0 ? (bot.cwd ?? fallbackCwd ?? null) : null;
      this.saveBots();
      this.emit({ type: "bot", botId });
    }
    return task.cwd;
  }

  /** Called only after host-local output lease admission, never from PATCH
   * or package data. Neither provider CWD nor resume cursors move. */
  admitLocalOutputs(botId: string, threadId: string): void {
    const task = this.taskByThread(botId, threadId);
    if (task) {
      if (task.localOutputs === true) return;
      task.localOutputs = true;
      try { this.saveBots(); } catch (error) { delete task.localOutputs; throw error; }
      this.emit({ type: "bot", botId });
      return;
    }
    const group = this.groups.find(item => item.memberIds.includes(botId) && (item.tasks ?? [{ threadId: item.threadId }]).some(task => task.threadId === threadId));
    if (!group || !this.bot(botId)) throw new Error("Output conversation is unavailable");
    const holder = group.tasks?.find(item => item.threadId === threadId) ?? group;
    const prior = holder.localOutputBotIds;
    if (prior?.includes(botId)) return;
    holder.localOutputBotIds = [...(prior ?? []), botId];
    try { this.saveGroups(); } catch (error) { holder.localOutputBotIds = prior; throw error; }
    this.emit({ type: "group", groupId: group.id });
  }

  /** The folder a room's member turns run in. Pins on the first turn that
   * dispatches, from the room's `cwd` at that moment. Pinned, not read
   * live, for the same reason tasks pin (see pinTaskCwd): engines key
   * their sessions and files to the folder a thread starts in, and a room
   * lives on ONE thread forever — so changing the room's folder applies to
   * future rooms, never under a room that already started working
   * somewhere. Returns the pinned value: a path, or null = each member's
   * own default. */
  pinGroupCwd(groupId: string, threadId?: string): string | null {
    const group = this.group(groupId);
    if (!group) return null;
    const task = threadId ? this.groupTaskByThread(groupId, threadId) : this.activeGroupTask(groupId);
    // Direct-message channels retain the original single-thread contract.
    if (!task) {
      if (!group.dm) return null;
      if (group.pinnedCwd === undefined) {
        group.pinnedCwd = group.cwd ?? null;
        this.saveGroups();
        this.emit({ type: "group", groupId: group.id });
      }
      return group.pinnedCwd;
    }
    if (task.pinnedCwd === undefined) {
      task.pinnedCwd = group.cwd ?? null;
      if (group.threadId === task.threadId) group.pinnedCwd = task.pinnedCwd;
      this.saveGroups();
      this.emit({ type: "group", groupId: group.id });
    }
    return task.pinnedCwd;
  }

  // ── tasks ─────────────────────────────────────────────────────────────
  /** The first thing the human asked in a thread — a task's natural name. */
  private firstUserLine(threadId: string): string | null {
    const first = this.messagesFor(threadId).find((m) => m.role === "user" && m.kind === "text" && m.text?.trim());
    return first?.text ? titleFromMessage(first.text) : null;
  }

  tasks(botId: string): TaskRecord[] {
    return this.bot(botId)?.tasks ?? [];
  }

  activeTask(botId: string): TaskRecord | undefined {
    const bot = this.bot(botId);
    return bot?.tasks?.find((t) => t.threadId === bot.threadId);
  }

  taskByThread(botId: string, threadId: string): TaskRecord | undefined {
    return this.taskIndex(this.bot(botId)?.tasks)?.byThread.get(threadId)?.task;
  }

  projectBotForTask(botId:string,threadId:string):BotRecord|null {
    const bot=this.bot(botId),task=this.taskByThread(botId,threadId);if(!bot||!task)return null;
    // the thread's human, read once for the whole projection (it was asked five times)
    const owner=withBindingScope(()=>isWorkspaceOwner(threadHumanPrincipal(threadId)));
    return {...bot,...(!owner?{computer:"off" as const,browser:false,composio:false}:{}),threadId,modelSelection:structuredClone(task.modelSelection??bot.modelSelection),resumeCursors:structuredClone(task.resumeCursors),autoApprove:owner&&(task.autoApprove??false),fullAccess:owner&&task.autoApprove===true&&task.fullAccess===true,noLimits:owner&&task.autoApprove===true&&task.fullAccess===true&&task.noLimits===true,alwaysAllow:owner?structuredClone(task.alwaysAllow??[]):[],unread:task.unread??false,rewound:task.rewound,pinnedMessageId:task.pinnedMessageId,busy:task.busy??false,activity:task.activity??"idle"};
  }
  /** Host-only, write-once procedural admission. Never accepted in API patches. */
  pinTaskProcedures(botId:string, threadId:string, pin:ProcedurePin):ProcedurePin {
    const task=this.bot(botId)?.tasks?.find(item=>item.threadId===threadId);
    if(!task)throw new Error("PROCEDURE_TASK_UNAVAILABLE");
    if(task.procedurePin)return task.procedurePin;
    task.procedurePin=structuredClone(pin);
    try{this.saveBots();}catch(error){delete task.procedurePin;throw error;}
    return task.procedurePin;
  }

  /** A new routine run in the routine's own conversation is a fresh start:
   *  its first turn pins the skills and routine instruction current then,
   *  not the ones an earlier run pinned. Earlier bundles stay on disk. */
  releaseTaskProcedures(botId:string, threadId:string):void {
    const task=this.bot(botId)?.tasks?.find(item=>item.threadId===threadId);
    if(!task?.procedurePin)return;
    const prior=task.procedurePin;
    delete task.procedurePin;
    try{this.saveBots();}catch(error){task.procedurePin=prior;throw error;}
  }

  pinGroupProcedures(groupId:string, threadId:string, botId:string, pin:ProcedurePin):ProcedurePin {
    const group=this.group(groupId);
    const holder=group?.dm&&group.threadId===threadId?group:this.groupTaskByThread(groupId,threadId);
    if(!group?.memberIds.includes(botId)||!holder)throw new Error("PROCEDURE_TASK_UNAVAILABLE");
    if(holder.procedurePins?.[botId])return holder.procedurePins[botId];
    const prior=holder.procedurePins;
    holder.procedurePins={...prior,[botId]:structuredClone(pin)};
    try{this.saveGroups();}catch(error){holder.procedurePins=prior;throw error;}
    return holder.procedurePins[botId]!;
  }

  releaseGroupProcedures(groupId:string, threadId:string, botId:string):void {
    const group=this.group(groupId),holder=group?.dm&&group.threadId===threadId?group:this.groupTaskByThread(groupId,threadId);
    if(!holder?.procedurePins?.[botId])return;
    const prior=holder.procedurePins;
    holder.procedurePins={...prior};delete holder.procedurePins[botId];
    try{this.saveGroups();}catch(error){holder.procedurePins=prior;throw error;}
  }

  patchTask(botId:string,threadId:string,patch:Partial<Pick<TaskRecord,"title"|"modelSelection"|"autoApprove"|"fullAccess"|"noLimits"|"alwaysAllow"|"unread"|"rewound"|"pinnedMessageId"|"resumeCursors"|"cwd">>&{pinned?:boolean}):TaskRecord|null {
    const bot=this.bot(botId),task=this.taskByThread(botId,threadId);if(!bot||!task)return null;
    const {pinned,...rest}=patch;
    const next:TaskRecord={...task,...structuredClone(rest)};
    if(pinned===true)next.pinned=true;else if(pinned===false)delete next.pinned;
    if(patch.title!==undefined)next.title=patch.title.trim().slice(0,80)||UNTITLED_TASK;
    if(patch.modelSelection&&patch.modelSelection.connectionId!==task.modelSelection?.connectionId)next.resumeCursors={};
    // The first pick adopts.
    //
    // A bot made before any engine could answer carries the honest-empty
    // selection `{instanceId:"",model:""}`, and the chat header only ever
    // writes the OPEN TASK. So picking a model there left the BOT with
    // nothing, and everything that reads the bot rather than the task broke:
    // the bot answered in its own chat and then failed in every channel
    // ("<name>'s model is unavailable") and could not be made a team lead.
    //
    // With no engine or no model chosen at bot level, the task's choice
    // therefore becomes the bot's own as well, in this same staged write. A
    // bot that ALREADY has a bot-level selection keeps it: a pick on one of
    // its tasks is then a deliberate per-task override, which is what
    // independent threads are for.
    const adopts=Boolean(patch.modelSelection)&&(!bot.modelSelection?.instanceId||!bot.modelSelection?.model);
    const adopted=adopts?{modelSelection:structuredClone(patch.modelSelection!)}:{};
    // Bot learning (B1): an edit or branch switch rewound the conversation, a weak negative.
    if(patch.rewound===true&&task.rewound!==true){try{recordWeakSignal(database(),{botId:bot.id,threadId,action:"rewind",targetMessageId:this.activeLeaf(threadId)},bot);}catch{/* optional */}}
    const tasks=bot.tasks!.map(candidate=>candidate===task?next:candidate);
    const mirrors=bot.threadId===threadId?{resumeCursors:{...next.resumeCursors},rewound:next.rewound,pinnedMessageId:next.pinnedMessageId}:{};
    const candidate={...bot,...mirrors,...adopted,tasks,unread:tasks.some(task=>task.unread)};
    // Only cosmetic keys may be deferred. Approval, access and model keys are
    // security or routing state and keep their immediate, throwing write, and
    // so does `rewound`: lost on a crash, the next turn would resume a provider
    // session that still holds the abandoned branch.
    const cosmetic=Object.keys(patch).every(key=>["unread","pinnedMessageId","pinned","title"].includes(key))&&!adopts;
    if(cosmetic){
      Object.assign(task,next);if(!next.pinned)delete task.pinned;Object.assign(bot,mirrors,{unread:candidate.unread});
      this.saveBots(this.bots,{defer:true});
    }else{
    this.saveBots(this.bots.map(current=>current===bot?candidate:current));
    Object.assign(task,next);if(!next.pinned)delete task.pinned;Object.assign(bot,mirrors,adopted,{unread:candidate.unread});
    }
    this.emit({type:"bot",botId});return task;
  }

  /** A fresh context on the same bot: new thread, new session, same
   * persona/tools/computer. Active creation retains the visible model;
   * detached routine tasks use the owner's defaults. */
  createTask(botId: string, title?: string, activate = true, channelProjectDesk?: TaskRecord["channelProjectDesk"], preparedThreadId?: string, sharedWork?: TaskRecord["sharedWork"]): TaskRecord | null {
    const bot = this.bot(botId);
    if (!bot) return null;
    const task: TaskRecord = {
      threadId: preparedThreadId ?? newId(),
      title: title?.trim().slice(0,80) || UNTITLED_TASK,
      ...(channelProjectDesk ? { channelProjectDesk } : {}),
      ...(sharedWork ? { sharedWork, cwd: partitionRoots(bot, { kind: "team", teamId: sharedWork.teamId })[0] } : {}),
      createdAt: Date.now(),
      resumeCursors: {},
      modelSelection:structuredClone((activate ? this.activeTask(botId)?.modelSelection : undefined) ?? bot.modelSelection),autoApprove:bot.autoApprove===true,fullAccess:bot.autoApprove===true&&bot.fullAccess===true,noLimits:bot.autoApprove===true&&bot.fullAccess===true&&bot.noLimits===true,alwaysAllow:structuredClone(bot.alwaysAllow??[]),unread:false,activity:"idle",busy:false,
    };
    bot.tasks = [task, ...(bot.tasks ?? [])];
    if (activate) {
      bot.threadId = task.threadId;
      bot.resumeCursors = {}; // legacy mirror follows the active task
    }
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  /** The work thread, or null for an unknown bot or while a team change is finishing. */
  createSharedWorkTask(botId: string, teamId: string): TaskRecord | null {
    const task = this.openSharedWork(botId, teamId);
    return task && "refused" in task ? null : task;
  }

  /** The work thread for a team, created on first use. Read only on team
   * identities: while any team change is finishing it answers a plain line
   * instead of starting one (C5). */
  openSharedWork(botId: string, teamId: string): TaskRecord | { refused: string } | null {
    const bot = this.bot(botId); if (!bot) return null;
    const existing = bot.tasks?.find(task => task.sharedWork?.teamId === teamId && !task.sharedWork.quarantined);
    if (existing) return existing;
    const team = /^[\w-]+$/.test(teamId) ? database().prepare("SELECT label FROM team_identities WHERE team_id=? AND retired_at IS NULL").get(teamId) : undefined;
    if (!team) throw new Error("Unknown team");
    if (teamChangeOpen()) return { refused: `${bot.name} can take work for ${String(team.label)} once the team change finishes. Try again in a moment.` };
    const root = partitionRoots(bot, { kind: "team", teamId })[0];
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return this.createTask(botId, workThreadTitle(bot.name, teamLabel(teamId)!), false, undefined, undefined, { teamId, createdAt: Date.now() });
  }

  ensureProjectDesk(botId: string, groupId: string, projectName: string, preparedThreadId?: string): TaskRecord | null {
    const existing = this.taskIndex(this.bot(botId)?.tasks)?.desks.get(groupId)?.[0];
    return existing ?? this.createTask(botId, `${projectName.slice(0, 75)} work`, false, { groupId }, preparedThreadId);
  }

  switchTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    const task = bot?.tasks?.find((t) => t.threadId === threadId);
    if (!bot || !task) return null;
    bot.threadId = task.threadId;
    bot.resumeCursors = { ...task.resumeCursors };
    bot.rewound=task.rewound;bot.pinnedMessageId=task.pinnedMessageId;
    this.saveBots(this.bots, { defer: true });
    this.emit({ type: "bot", botId });
    return bot;
  }

  renameTask(botId: string, threadId: string, title: string): TaskRecord | null {
    const task = this.bot(botId)?.tasks?.find((t) => t.threadId === threadId);
    if (!task) return null;
    task.title = title.trim().slice(0, 80) || UNTITLED_TASK;
    this.saveBots();
    this.emit({ type: "bot", botId });
    return task;
  }

  /** Name a task after its first message, once. */
  titleTaskFromFirstMessage(botId: string, text: string, threadId?: string) {
    const task = threadId ? this.taskByThread(botId, threadId) : this.activeTask(botId);
    if (!task || task.title !== UNTITLED_TASK) return;
    task.title = titleFromMessage(text);
    this.saveBots();
    this.emit({ type: "bot", botId });
  }

  /** Delete a task and its transcript. A bot always keeps one: deleting the
   * last one leaves a fresh, empty "New task" in its place, the same as a
   * channel's last conversation (deleteGroupTask). It used to be refused
   * after the owner had confirmed it, with "a bot keeps at least one task". */
  deleteTask(botId: string, threadId: string): BotRecord | null {
    const bot = this.bot(botId);
    if (!bot || !bot.tasks?.some((t) => t.threadId === threadId)) return null;
    if (bot.tasks.length < 2) this.createTask(botId, undefined, false);
    bot.tasks = bot.tasks!.filter((t) => t.threadId !== threadId);
    // the deleted task's thread leaves the pending set now, not at the next hourly reconcile
    this.refreshPendingThreads([threadId]);
    this.deleteThreadRecord(threadId);
    if (bot.threadId === threadId) {
      const next = bot.tasks[0]!;
      bot.threadId = next.threadId;
      bot.resumeCursors = { ...next.resumeCursors };
      bot.rewound = next.rewound;
      bot.pinnedMessageId = next.pinnedMessageId;
    }
    this.saveBots();
    this.emit({ type: "bot", botId });
    return bot;
  }

  /** First-run seed: one bot so the app never opens empty — it gets a
   * random friendly name like every other bot. */
  /**
   * The first bot on an empty workspace, and NOTHING SAID YET.
   *
   * It used to open with a greeting and a card asking what you wanted it for.
   * Both were written for a bot you create later, when you already know what
   * Murage is and are adding somebody to your team. On the very first bot on
   * the very first launch they are the wrong thing twice over: the guided
   * first run introduces this bot properly and asks better questions in a
   * better order, and its opening card is the introduction. Seeding here left
   * a second hello and an unanswerable question sitting ABOVE it, because
   * they were written at bot creation and the flow's card arrives after.
   *
   * So this one bot starts silent. Every other bot still gets its greeting:
   * `createBot` is unchanged, and only this caller opts out.
   */
  seedIfEmpty() {
    if (this.bots.length) return;
    this.createBot({}, { seedMessages: false });
  }
}
