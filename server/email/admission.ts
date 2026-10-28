// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// When the email tools mount, and whether a call may run (BOT-EMAIL-MURAGE-109 3.1, 3.2, F17). Shaped like venue-read.ts: the mount
// predicate decides the listing and writes the generation-bound record (email-turns.ts); every call is checked again against that record
// and current state. A call that fails gets EMAIL_UNAVAILABLE and Murage never calls Flux.
import type { BindingState } from "./email-store.ts";
import { emailTurns, type EmailToolMode, type EmailTurnKind, type EmailTurnRecord } from "./email-turns.ts";
import { EMAIL_SEND_TOOL_NAMES, type EmailToolName } from "../drivers/email-tool-schemas.ts";

/** A direct call that fails the predicate (3.1). */
export const EMAIL_UNAVAILABLE = "Email is not available in this conversation.";
/** Primer lines for an owner turn where the tools are absent (3.2 engine matrix). */
export const EMAIL_ENGINE_ABSENT = "This bot's engine cannot use Murage's email tools.";
export const EMAIL_DRAFT_ONLY_ABSENT = "Email is not available while this bot only drafts.";
export const EMAIL_READ_ONLY_ENGINE = "This engine can read email but not send it.";

/** Bindings whose tools mount: paused and billing_hold still read, and the send handler refuses with the state's own line. */
export const EMAIL_MOUNT_STATES: ReadonlySet<BindingState> = new Set(["active", "paused", "billing_hold", "grace"]);

/** Engines whose permission path proves an email send tool by its exact name on the turn's own agents mount (3.2 adapter admission):
 *  Claude pre-allows OWN_UNASKED, Codex's hook and Pi's gate read the mount record, Fuigo and Grok stamp the MCP identity, Hermes allows
 *  the exact OWN_UNASKED names, Cursor gets the three names on its exact-tool allow list (acp/cursor.ts), and Antigravity mounts agents
 *  only in full-auto, where nothing asks. Every other agents engine (Kimi, Qwen, Gemini, Droid, OpenCode Go, Cline, custom ACP) asks with
 *  an unstamped "other" request Murage cannot prove, so it reads email and does not send it. */
export const EMAIL_SEND_ENGINES: ReadonlySet<string> = new Set(["claudeAgent", "codex", "piAgent", "fuigoAgent", "grokAgent", "hermesAgent", "cursorAgent", "antigravityAgent"]);

type BotShape = { id: string; threadId: string; draftOnly?: boolean; tasks?: ReadonlyArray<{ threadId: string; channelProjectDesk?: unknown; sharedWork?: unknown }> };

export interface EmailMountInput {
  /** the capability probe said enabled: true */
  enabled: boolean;
  binding: BindingState | null | undefined;
  driverKind: string;
  /** the engine mounts the agents server on this turn */
  agentsMcp: boolean;
  surfacesForOwner: boolean;
  directOwnerAudience: boolean;
  origin?: string;
  notOwnerAudience?: boolean;
  chainNotOwner?: boolean;
  chainRootThreadId?: string;
  commsDepth?: number;
  automationSource?: string;
  projectCardRun?: unknown;
  sharedWorkRun?: unknown;
  /** the turn is a hand-off's run (index.ts passes whether its options carry one; the run itself never leaves the dispatch's start) */
  handoffTurn?: boolean;
  askerWake?: boolean;
  cardContinuation?: boolean;
  automationThread: boolean;
  bot: BotShape;
  threadId: string;
}

export type EmailMountVerdict =
  | { mounted: true; turn: EmailTurnKind; mode: EmailToolMode }
  /** `line`: what the owner-only primer says on this turn (null: nothing, email is not this turn's business) */
  | { mounted: false; line: string | null };

/** The bot's main chat or one of its own tasks that is neither a project desk nor shared work. */
function ownThread(bot: BotShape, threadId: string): boolean {
  return threadId === bot.threadId || (bot.tasks ?? []).some(task => task.threadId === threadId && !task.channelProjectDesk && !task.sharedWork);
}

/** The owner's own turn: never a contact, a channel or webhook trigger, a project card run, shared work, or an asked or delegated turn at
 *  any depth. A direct turn needs a proven owner origin; a routine run needs the schedule or manual trigger. */
function ownerTurn(input: EmailMountInput): EmailTurnKind | null {
  if (!input.surfacesForOwner || !input.directOwnerAudience || input.notOwnerAudience === true || input.chainNotOwner) return null;
  if (input.chainRootThreadId || (input.commsDepth ?? 0) !== 0 || input.handoffTurn || input.askerWake || input.cardContinuation) return null;
  if (input.projectCardRun || input.sharedWorkRun || !ownThread(input.bot, input.threadId)) return null;
  if (input.automationSource === undefined) {
    if (input.automationThread || (input.origin !== "desktop" && input.origin !== "companion")) return null;
    return { kind: "direct", origin: input.origin };
  }
  if (input.automationSource === "schedule" || input.automationSource === "manual") return { kind: "routine", trigger: input.automationSource };
  return null;
}

/** The mount predicate (3.1, 3.2). */
export function emailMounts(input: EmailMountInput): EmailMountVerdict {
  if (!input.enabled || !input.binding || !EMAIL_MOUNT_STATES.has(input.binding)) return { mounted: false, line: null };
  const turn = ownerTurn(input);
  if (input.bot.draftOnly) return { mounted: false, line: turn ? EMAIL_DRAFT_ONLY_ABSENT : null };
  if (!input.agentsMcp) return { mounted: false, line: turn ? EMAIL_ENGINE_ABSENT : null };
  if (!turn) return { mounted: false, line: null };
  return { mounted: true, turn, mode: EMAIL_SEND_ENGINES.has(input.driverKind) ? "send" : "read" };
}

/** Current state the call check reads, handed in by the wiring (index.ts) or a test. */
export interface EmailCallLive {
  enabled(): boolean;
  binding(botId: string): BindingState | null | undefined;
  bot(botId: string): BotShape | undefined;
  /** ownerSurfacesByThread.get(threadId) */
  ownerSurface(threadId: string): boolean | undefined;
  /** internalTurnOwners.get(threadId)?.notOwnerAudience === true */
  notOwnerAudience(threadId: string): boolean;
  /** turnAudienceIsOwner(threadId, { origin }) and the thread's human principal is the workspace owner */
  ownerThread(threadId: string, origin?: "desktop" | "companion"): boolean;
  /** a room or project card request is bound to this generation (turnRequestByGeneration) */
  boundRequest(generation: string): boolean;
}

export type EmailCallVerdict = { ok: true; record: EmailTurnRecord } | { ok: false; line: string };

/** Every call, again: the generation's record, the tool within its mode, and the conditions of 3.1 read from current state. */
export function authorizeEmailCall(claim: { botId: string; threadId: string; generation: string }, tool: EmailToolName, live: EmailCallLive): EmailCallVerdict {
  const no: EmailCallVerdict = { ok: false, line: EMAIL_UNAVAILABLE };
  try {
    if (!live.enabled()) return no;
    const record = emailTurns.get(claim.generation);
    if (!record || record.botId !== claim.botId || record.threadId !== claim.threadId) return no;
    if ((EMAIL_SEND_TOOL_NAMES as readonly string[]).includes(tool) && record.mode !== "send") return no;
    if (live.boundRequest(claim.generation)) return no;
    const binding = live.binding(record.botId);
    if (!binding || !EMAIL_MOUNT_STATES.has(binding)) return no;
    const bot = live.bot(record.botId);
    if (!bot || bot.draftOnly || !ownThread(bot, record.threadId)) return no;
    if (live.notOwnerAudience(record.threadId)) return no;
    if (record.kind === "direct") {
      if (live.ownerSurface(record.threadId) !== true || !live.ownerThread(record.threadId, record.origin)) return no;
    } else if (!live.ownerThread(record.threadId)) return no;
    return { ok: true, record };
  } catch {
    return no;
  }
}
