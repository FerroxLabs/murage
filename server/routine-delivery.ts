// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ROUTINE-DELIVER-1010: a bot routine run's result lands in the chat the routine was made in.
//
// The run's one lifecycle card (kind "routine.run") is the result message: its final reply, the files and images it saved
// (Files ids, drawn with the same cards a normal turn uses), a link to the full run, and on a failure one line with the next
// step. It goes to the run's source chat; with none (a routine made on the calendar) or a deleted one, the run's outcome goes
// to the bot's main chat instead. The run itself stays in the routine's own conversation.
//
// Exactly once, by construction: the card has a stable id per run (`rrun-<runId>`), so a second write of it finds the first and
// patches it; the chosen chat is recorded on the run before the card is first written there, so a retry never picks another chat
// (only a recorded chat that was deleted, and its card with it, gives way to the main chat); and
// the run's durable `delivery` marker stays "pending" until the final write has landed, so a crash in between is written at the
// next start-up (index.ts). Runs from before 1.0.10 and webhook, channel and room runs carry no marker and keep their own path.
//
// Cost per run: one indexed lookup of the card, one bounded Files query (LIMIT, the run's own window). Never a scan of a chat,
// the routine's conversation or the Files history.
import type { RoutineRunCardData } from "../shared/routine-run.ts";
import type { Message } from "./store.ts";
import { routineRunCard, type RoutineRun } from "./routines.ts";

export const ROUTINE_RESULT_PREFIX = "rrun-";
export function routineResultId(runId: string): string { return `${ROUTINE_RESULT_PREFIX}${runId}`; }

/** The most saved files one result card carries; the rest are in Files. */
export const ROUTINE_RESULT_FILES_MAX = 12;
/** Workspace outputs are saved to Files just after the run's turn ends: the run's files window reaches this far past its end. */
export const ROUTINE_RESULT_FILES_AFTER_MS = 5 * 60_000;

const SETTLED: ReadonlySet<RoutineRun["status"]> = new Set(["completed", "failed", "missed", "cancelled"]);
/** The outcomes the bot's main chat hears about when the routine has no chat of its own. */
const MAIN_CHAT_OUTCOMES: ReadonlySet<RoutineRun["status"]> = new Set(["completed", "failed", "missed"]);
const UNREAD: ReadonlySet<RoutineRun["status"]> = new Set(["waiting", "needs-you", "completed", "failed", "missed"]);

export interface DeliveryBot { id: string; name: string; color: string }
export interface DeliveryOwner { bot: DeliveryBot; group?: { id: string } }
export interface DeliveryTarget extends DeliveryOwner { threadId: string; main: boolean }

export interface RoutineDeliveryDeps {
  /** The owner check `routineSourceOwner` makes for the run's source chat: the bot's own task, or a room it is in. */
  owner(run: RoutineRun, threadId: string): DeliveryOwner | null;
  /** The bot's main chat (its owner's own unshared home chat, never a routine's own conversation), or null. */
  mainChat(run: RoutineRun): (DeliveryOwner & { threadId: string }) | null;
  /** That chat is still the bot's main-chat kind (owner's own, unshared): re-checked before every write. */
  isMainChat(run: RoutineRun, threadId: string): DeliveryOwner | null;
  /** The chat still exists anywhere (a bot's task or a room). A recorded chat that exists but fails its check is never replaced. */
  threadExists(threadId: string): boolean;
  messageById(threadId: string, messageId: string): Message | undefined;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">, stableId: string): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): void;
  markUnread(target: DeliveryTarget): void;
  /** Files ids the run saved in its own conversation in [from, to], oldest first, at most `limit` (saved-file rows, then images). */
  runFiles(input: { botId: string; threadId: string; from: number; to: number; limit: number }): string[];
  /** Writes the chosen chat on the run (routines.ts recordRunDelivery) before the card is first written there. */
  recordDelivery(runId: string, threadId: string): void;
}

/** The plain line the card's text falls back to (a client that cannot draw the card, a bot reading the chat). */
export function routineRunFallbackText(card: RoutineRunCardData): string {
  const goalState = card.goalStatus === "needs-input"
    ? "needs your input"
    : card.goalStatus === "blocked"
      ? "was blocked"
      : card.goalStatus === "limit-reached"
        ? "reached its limit"
        : card.goalStatus === "stopped"
          ? "was stopped"
          : card.goalStatus === "failed"
            ? "failed"
            : undefined;
  const state = goalState ?? (
    card.status === "waiting"
      ? "needs your attention"
      : card.status === "needs-you"
        ? "is waiting on you"
      : card.status === "completed"
        ? "completed"
        : card.status === "failed"
          ? "failed"
          : card.status === "cancelled"
            ? "was cancelled"
            : card.status === "missed"
              ? "was missed"
              : card.status
  );
  return `Routine “${card.routineName}” ${state}`;
}

/** What to do after a run that did not finish: one plain line, never silence. */
export function routineNextStep(run: Pick<RoutineRun, "status" | "threadId">): string | undefined {
  if (run.status === "missed") return "Murage was not running when this was due. It runs again at its next time, or run it now from Routines.";
  if (run.status === "failed") return run.threadId
    ? "Open the run to see what happened, or run it again from Routines."
    : "Run it again from Routines, or ask your bot what went wrong.";
  return undefined;
}

/** Where this run's card goes now. The chat is fixed by the first write (recorded on the run): a recorded chat that still exists but
 * no longer passes its check gets nothing new (its card stays where it is); only a recorded chat that is gone (deleted, and its card
 * with it) gives way to the bot's main chat. Before any write: the source chat, else, for a settled outcome, the main chat. */
export function routineDeliveryTarget(run: RoutineRun, deps: RoutineDeliveryDeps, final: boolean): DeliveryTarget | null {
  const recorded = run.delivery?.threadId?.trim();
  const source = run.sourceThreadId?.trim();
  const toMain = () => {
    if (!final || run.target !== "bot" || !MAIN_CHAT_OUTCOMES.has(run.status)) return null;
    const main = deps.mainChat(run);
    return main && main.threadId !== run.threadId ? { ...main, main: true } : null;
  };
  if (recorded) {
    const owner = recorded === source ? deps.owner(run, recorded) : deps.isMainChat(run, recorded);
    if (owner) return { ...owner, threadId: recorded, main: recorded !== source };
    return deps.threadExists(recorded) ? null : toMain();
  }
  if (source) {
    const owner = deps.owner(run, source);
    if (owner) return { ...owner, threadId: source, main: false };
    if (deps.threadExists(source)) return null;
  }
  return toMain();
}

/** Writes (or patches) the run's one card where it belongs. `final`: the run has settled and its files are saved. `filesUntil`: the end
 * of the run's files window (its end plus a margin, and never past the next run's start). Returns the chat, or null. */
export function deliverRoutineRun(run: RoutineRun, deps: RoutineDeliveryDeps, final: boolean, filesUntil?: number): string | null {
  if (!run.delivery || run.delivery.state === "off") return null;
  const target = routineDeliveryTarget(run, deps, final);
  if (!target) return null;
  if (run.delivery.threadId?.trim() !== target.threadId) deps.recordDelivery(run.id, target.threadId);
  const card: RoutineRunCardData = routineRunCard(run);
  const nextStep = final ? routineNextStep(run) : undefined;
  if (nextStep) card.nextStep = nextStep;
  const end = (run.finishedAt ?? run.startedAt ?? 0) + ROUTINE_RESULT_FILES_AFTER_MS;
  const files = final && run.status === "completed" && run.threadId && run.startedAt !== undefined
    ? deps.runFiles({ botId: run.botId, threadId: run.threadId, from: run.startedAt, to: Math.min(end, filesUntil ?? end), limit: ROUTINE_RESULT_FILES_MAX + 1 })
    : [];
  if (files.length > ROUTINE_RESULT_FILES_MAX) card.moreFiles = true;
  const artifactIds = files.slice(0, ROUTINE_RESULT_FILES_MAX);
  const text = routineRunFallbackText(card);
  const id = routineResultId(run.id);
  const existing = deps.messageById(target.threadId, id);
  if (existing) {
    deps.patchMessage(target.threadId, id, { text, routineRun: card, ...(artifactIds.length ? { artifactIds } : {}) });
  } else {
    const message: Omit<Message, "id" | "at"> = { role: "bot", kind: "routine.run", text, routineRun: card, ...(artifactIds.length ? { artifactIds } : {}) };
    // in a room the card says which bot it is from
    if (target.group) message.from = { botId: target.bot.id, name: target.bot.name, color: target.bot.color };
    deps.appendMessage(target.threadId, message, id);
  }
  if (existing?.routineRun?.status !== run.status && UNREAD.has(run.status)) deps.markUnread(target);
  return target.threadId;
}

/** True when the run has settled: its result is final. */
export function routineRunSettled(run: Pick<RoutineRun, "status">): boolean { return SETTLED.has(run.status); }
