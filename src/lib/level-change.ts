// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Changing a bot's default level (UX-TRUST-L1B-1013, UX-TRUST-MOMENTS-1012
// 3.3 and 2.5): the preview, the PATCH that carries it, the conversation
// apply, Undo, and every line the owner reads about them. The server answers
// are the source of each line; nothing here reads a level from memory after a
// refusal. These calls go to `api` directly, after flushBotPatches: the
// optimistic queue gives its caller no answer, and the revision in the answer
// is what the apply and Undo bind to.
import { t } from "@/lib/i18n";
import { levelName } from "@/lib/fold-words";
import { fullAccessRefusalMessage, levelRank, needsLevelConfirm, type PermissionMode } from "@/lib/permission-mode";

export type WireLevel = "ask" | "auto" | "full" | "no-limits";

export const toWire = (mode: PermissionMode): WireLevel => (mode === "unlimited" ? "no-limits" : mode);
export const fromWire = (level: string): PermissionMode =>
  level === "no-limits" || level === "unlimited" ? "unlimited" : level === "full" ? "full" : level === "auto" ? "auto" : "ask";

export interface LevelRoutine { id: string; name: string; ceiling: string; from: string; to: string }
export interface ChangedThread { threadId: string; from: string; to: string; rev: number }
export interface LevelPreview {
  previewId: string;
  rosterId: string;
  targetLevel: WireLevel;
  botLevel: WireLevel;
  botRev: number;
  eligible: ChangedThread[];
  skipped: Array<{ threadId: string; reason: string; from: string; rev: number }>;
  routines: LevelRoutine[];
}

export interface LevelDeps {
  api: (path: string, init?: RequestInit) => Promise<any>;
  /** settles this bot's queued optimistic saves, so the calls read saved state */
  flush: (botId: string) => Promise<void>;
  /** hands the answer's bot record to the store */
  onBot: (bot: unknown) => void;
}

/** The first-time acknowledgements a save carries. */
export interface LevelAcks { acknowledgeFullAccess?: true; acknowledgeNoLimits?: true; acknowledgeLocalAuto?: true }

/** All three flags, so a save never leaves one behind. */
export function levelFlags(mode: PermissionMode): { autoApprove: boolean; fullAccess: boolean; noLimits: boolean } {
  return { autoApprove: mode !== "ask", fullAccess: mode === "full" || mode === "unlimited", noLimits: mode === "unlimited" };
}

/** Auto reaching this computer needs the owner's yes only when Auto is being
 * switched on: repeating it on a bot already there would rewrite the bot's
 * one-time answer about this computer (server/host-computer-consent.ts). */
export function needsLocalAck(from: PermissionMode, to: PermissionMode, drivesComputer: boolean): boolean {
  return drivesComputer && from === "ask" && to !== "ask";
}

export function levelAcks(
  bot: { fullAccessAcknowledgedAt?: number; noLimitsAcknowledgedAt?: number },
  from: PermissionMode,
  to: PermissionMode,
  drivesComputer: boolean,
): LevelAcks {
  return {
    ...(to === "full" && bot.fullAccessAcknowledgedAt === undefined ? { acknowledgeFullAccess: true as const } : {}),
    ...(to === "unlimited" && bot.noLimitsAcknowledgedAt === undefined ? { acknowledgeNoLimits: true as const } : {}),
    ...(needsLocalAck(from, to, drivesComputer) ? { acknowledgeLocalAuto: true as const } : {}),
  };
}

const botPath = (botId: string) => `/api/bots/${encodeURIComponent(botId)}`;
const refreshPath = (botId: string) => `${botPath(botId)}/permissions/refresh`;
const post = (body: object): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body: object): RequestInit => ({ method: "PATCH", body: JSON.stringify(body) });

interface StaleBody { level: string; permissionRev: number }

/** The 409 the level routes answer, or null for any other failure. */
export function staleBody(error: unknown): StaleBody | null {
  const failure = error as { status?: number; body?: { code?: string; level?: string; permissionRev?: number } } | null | undefined;
  if (failure?.status !== 409 || failure.body?.code !== "preview_stale") return null;
  return { level: String(failure.body.level), permissionRev: Number(failure.body.permissionRev) };
}

const failureWords = (mode: PermissionMode, error: unknown): string =>
  fullAccessRefusalMessage(levelFlags(mode), error) ?? (error instanceof Error ? error.message : String(error));

/** The preview against a proposed level, read after any queued save settled. */
export async function previewLevel(deps: LevelDeps, botId: string, target: PermissionMode): Promise<LevelPreview> {
  await deps.flush(botId);
  return await deps.api(refreshPath(botId), post({ scope: "open", targetLevel: toWire(target) })) as LevelPreview;
}

export type RaiseOutcome =
  | { kind: "saved"; level: PermissionMode; previous: PermissionMode; rev: number; changed: ChangedThread[] }
  /** The PATCH refused what the owner reviewed; nothing was written. */
  | { kind: "stale"; level: PermissionMode; permissionRev: number }
  | { kind: "failed"; message: string }
  /** F14: the default saved, the conversation update did not. */
  | { kind: "apply-refused"; level: PermissionMode; previous: PermissionMode; rev: number; current: { level: PermissionMode; permissionRev: number }; unconfirmed?: true };

/** An apply that failed any other way than the 409 may have written with only
 * its answer lost. The preview at the target tells which: a reviewed
 * conversation at the target on its next revision moved. Null when even that
 * cannot be read. */
async function settleApply(deps: LevelDeps, botId: string, preview: LevelPreview): Promise<{ changed: ChangedThread[]; current: { level: PermissionMode; permissionRev: number } } | null> {
  try {
    const fresh = await deps.api(refreshPath(botId), post({ scope: "open", targetLevel: preview.targetLevel })) as LevelPreview;
    const changed = preview.eligible.flatMap(thread => {
      const now = fresh.skipped.find(item => item.threadId === thread.threadId);
      return now?.from === preview.targetLevel && now.rev === thread.rev + 1 ? [{ ...thread, rev: now.rev }] : [];
    });
    return { changed, current: { level: fromWire(fresh.botLevel), permissionRev: fresh.botRev } };
  } catch {
    return null;
  }
}

/** [Use {level}] and "Only new conversations": the PATCH that carries the
 * preview, then, on [Use], the apply bound to the revision the PATCH returned.
 * A preview with nothing eligible has nothing to apply. */
export async function confirmRaise(deps: LevelDeps, input: { botId: string; target: PermissionMode; preview: LevelPreview; acks: LevelAcks; conversations: boolean }): Promise<RaiseOutcome> {
  const { botId, target, preview, acks, conversations } = input;
  const previous = fromWire(preview.botLevel);
  let saved: { bot?: unknown; permissionRev: number };
  try {
    await deps.flush(botId);
    saved = await deps.api(botPath(botId), patch({ ...levelFlags(target), ...acks, settingsScope: "defaults", previewId: preview.previewId, ifRev: preview.botRev }));
  } catch (error) {
    const stale = staleBody(error);
    return stale ? { kind: "stale", level: fromWire(stale.level), permissionRev: stale.permissionRev } : { kind: "failed", message: failureWords(target, error) };
  }
  if (saved.bot) deps.onBot(saved.bot);
  const rev = saved.permissionRev;
  if (!conversations || preview.eligible.length === 0) return { kind: "saved", level: target, previous, rev, changed: [] };
  try {
    const applied = await deps.api(refreshPath(botId), post({ scope: "open", rosterId: preview.rosterId, targetLevel: preview.targetLevel, afterRev: rev })) as { changed: ChangedThread[] };
    return { kind: "saved", level: target, previous, rev, changed: applied.changed };
  } catch (error) {
    const stale = staleBody(error);
    if (stale) return { kind: "apply-refused", level: target, previous, rev, current: { level: fromWire(stale.level), permissionRev: stale.permissionRev } };
    const settled = await settleApply(deps, botId, preview);
    if (!settled) return { kind: "apply-refused", level: target, previous, rev, current: { level: target, permissionRev: rev }, unconfirmed: true };
    if (settled.changed.length > 0) return { kind: "saved", level: target, previous, rev, changed: settled.changed };
    return { kind: "apply-refused", level: target, previous, rev, current: settled.current };
  }
}

export type DirectOutcome =
  | { kind: "saved"; level: PermissionMode; previous: PermissionMode; rev: number | undefined; routines: number }
  | { kind: "failed"; message: string };

/** A lowering, or a raise to Auto: no card, nothing reviewed. A phone sends no
 * settingsScope, which is desktop-only (the design's L1b-R2-M01). */
export async function changeDirect(deps: LevelDeps, input: { botId: string; target: PermissionMode; previous: PermissionMode; acks: LevelAcks; desktop: boolean }): Promise<DirectOutcome> {
  const { botId, target, previous, acks, desktop } = input;
  try {
    await deps.flush(botId);
    const saved = await deps.api(botPath(botId), patch({ ...levelFlags(target), ...acks, ...(desktop ? { settingsScope: "defaults" } : {}) })) as { bot?: unknown; permissionRev?: number; routines?: unknown[] };
    if (saved.bot) deps.onBot(saved.bot);
    return { kind: "saved", level: target, previous, rev: saved.permissionRev, routines: saved.routines?.length ?? 0 };
  } catch (error) {
    return { kind: "failed", message: failureWords(target, error) };
  }
}

/** What Undo still has to put back: the bot's previous level with the revision
 * its save returned, and each conversation the apply changed with its own. */
export interface UndoPlan {
  bot: { previous: PermissionMode; rev: number; from: PermissionMode; drivesComputer: boolean } | null;
  conversations: ChangedThread[];
}

export interface UndoResult {
  /** "restored", "refused" (the revision moved), "failed", or null when the plan had no bot */
  bot: "restored" | "refused" | "failed" | null;
  backTo?: { level: PermissionMode; routines: number };
  restored: number;
  refused: number;
  /** what a retry still has to do */
  remaining: UndoPlan;
  message?: string;
}

/** Each record succeeds or refuses on its own (F15). Undo of a raise is a
 * lowering; Undo of a lowering is a raise back, which sends `ifRev` and no
 * preview, and the server takes it only as the exact step back. */
export async function undoLevelChange(deps: LevelDeps, botId: string, plan: UndoPlan): Promise<UndoResult> {
  const result: UndoResult = { bot: null, restored: 0, refused: 0, remaining: { bot: null, conversations: [] } };
  const { bot } = plan;
  await deps.flush(botId).catch(() => undefined);
  if (bot) {
    try {
      const saved = await deps.api(botPath(botId), patch({
        ...levelFlags(bot.previous),
        settingsScope: "defaults",
        ifRev: bot.rev,
        ...(needsLocalAck(bot.from, bot.previous, bot.drivesComputer) ? { acknowledgeLocalAuto: true } : {}),
      })) as { bot?: unknown; routines?: unknown[] };
      if (saved.bot) deps.onBot(saved.bot);
      result.bot = "restored";
      if (levelRank(bot.previous) > levelRank(bot.from)) result.backTo = { level: bot.previous, routines: saved.routines?.length ?? 0 };
    } catch (error) {
      if (staleBody(error)) result.bot = "refused";
      else { result.bot = "failed"; result.remaining.bot = bot; result.message = failureWords(bot.previous, error); }
    }
  }
  for (const thread of plan.conversations) {
    try {
      await deps.api(`${botPath(botId)}/tasks/${encodeURIComponent(thread.threadId)}`, patch({ ...levelFlags(fromWire(thread.from)), ifRev: thread.rev }));
      result.restored += 1;
    } catch (error) {
      if (staleBody(error)) result.refused += 1;
      else { result.remaining.conversations.push(thread); result.message ??= failureWords(fromWire(thread.from), error); }
    }
  }
  return result;
}

const joinWords = (items: string[]): string =>
  items.length < 2 ? (items[0] ?? "") : t("ux.l1.confirm.listLast", { list: items.slice(0, -1).join(", "), last: items[items.length - 1] });

/** 3.3: what else rises with this change. The routine sentence is the owner's
 * only view of them, so every one is named, with the level it is set to. */
export function confirmEffectLine(conversations: number, routines: readonly LevelRoutine[]): string {
  const open = conversations === 1 ? t("ux.l1.confirm.openConversation") : t("ux.l1.confirm.openConversations", { n: conversations });
  const named = joinWords(routines.map((routine) => t("ux.l1.confirm.routine", { name: routine.name, level: levelName(fromWire(routine.ceiling)) })));
  if (conversations > 0 && routines.length > 0) return t("ux.l1.confirm.alsoBoth", { conversations: open, routines: named });
  if (conversations > 0) return `${t("ux.l1.confirm.alsoOne", { what: open })} ${t("ux.l1.confirm.routinesKeep")}`;
  if (routines.length > 0) return t("ux.l1.confirm.alsoOne", { what: named });
  return t("ux.l1.confirm.routinesKeep");
}

/** The status line under the level menu in Settings › Level. `undo` is offered
 * from `at` for UNDO_WINDOW_MS; `retry` keeps it until the owner tries again. */
export interface LevelLine {
  kind: "saved" | "apply-refused" | "undone" | "note";
  text: string;
  at: number;
  undo: UndoPlan | null;
  retry?: boolean;
  review?: boolean;
  restoreOnComputer?: boolean;
}

const onLevel = (bot: string, level: PermissionMode) => t("ux.l1.levelLine.on", { bot, level: levelName(level) });

export const noteLine = (text: string, now: number): LevelLine => ({ kind: "note", text, at: now, undo: null });

/** "Nova is on Full access. 3 conversations follow it. [Undo]" */
export function raisedLine(bot: string, saved: Extract<RaiseOutcome, { kind: "saved" }>, drivesComputer: boolean, now: number): LevelLine {
  const count = saved.changed.length;
  const follow = count === 1 ? t("ux.l1.levelLine.followOne") : count > 1 ? t("ux.l1.levelLine.followMany", { n: count }) : "";
  return {
    kind: "saved",
    text: [onLevel(bot, saved.level), follow].filter(Boolean).join(" "),
    at: now,
    undo: { bot: { previous: saved.previous, rev: saved.rev, from: saved.level, drivesComputer }, conversations: saved.changed },
  };
}

/** "Nova is on Auto. 2 routines now run at Auto. [Undo]"; a phone cannot send
 * the conditional write, so it says where this level comes back instead. */
export function directLine(bot: string, saved: Extract<DirectOutcome, { kind: "saved" }>, desktop: boolean, drivesComputer: boolean, now: number): LevelLine {
  const level = levelName(saved.level);
  const routines = saved.routines === 1 ? t("ux.l1.levelLine.routineOne", { level }) : saved.routines > 1 ? t("ux.l1.levelLine.routineMany", { n: saved.routines, level }) : "";
  const text = [onLevel(bot, saved.level), routines].filter(Boolean).join(" ");
  if (!desktop) return { kind: "saved", text, at: now, undo: null, restoreOnComputer: true };
  return {
    kind: "saved",
    text,
    at: now,
    undo: saved.rev === undefined ? null : { bot: { previous: saved.previous, rev: saved.rev, from: saved.level, drivesComputer }, conversations: [] },
  };
}

/** F14, from the refusal's own body. Undo stands only while that body's
 * revision is the one the PATCH returned. */
export function applyRefusedLine(bot: string, refused: Extract<RaiseOutcome, { kind: "apply-refused" }>, drivesComputer: boolean, now: number): LevelLine {
  const untouched = refused.current.permissionRev === refused.rev;
  const text = t(refused.unconfirmed ? "ux.l1.levelLine.applyUnconfirmed" : "ux.l1.levelLine.applyRefused", { bot, level: levelName(refused.current.level) });
  return {
    kind: "apply-refused",
    text: untouched ? text : `${text} ${t("ux.l1.levelLine.changedSince", { bot })}`,
    at: now,
    review: true,
    // Undo would leave any conversation the apply did move, so an unconfirmed apply offers none
    undo: untouched && !refused.unconfirmed ? { bot: { previous: refused.previous, rev: refused.rev, from: refused.level, drivesComputer }, conversations: [] } : null,
  };
}

/** F15: what came back and what did not, per record. */
export function undoneLine(bot: string, result: UndoResult, now: number): LevelLine {
  const botBack = result.bot === "restored";
  const { restored, refused } = result;
  const back = result.backTo;
  const backWords = back && [
    t("ux.l1.levelLine.backOn", { bot, level: levelName(back.level) }),
    back.routines === 1 ? t("ux.l1.levelLine.backRoutineOne", { level: levelName(back.level) })
      : back.routines > 1 ? t("ux.l1.levelLine.backRoutineMany", { n: back.routines, level: levelName(back.level) }) : "",
  ].filter(Boolean).join(" ");
  const partly = result.bot === "refused" || refused > 0;
  const failed = result.message !== undefined;
  if (!partly && !failed) return { kind: "undone", text: [backWords, t("ux.l1.added.takenBack")].filter(Boolean).join(" "), at: now, undo: null };
  if (!botBack && restored === 0 && !failed) return { kind: "undone", text: t("ux.l1.levelLine.nothingUndone", { bot }), at: now, undo: null };
  const done = botBack && restored === 1 ? t("ux.l1.levelLine.undoneBothOne", { bot })
    : botBack && restored > 1 ? t("ux.l1.levelLine.undoneBothMany", { bot, n: restored })
    : botBack ? t("ux.l1.levelLine.undoneBot", { bot })
    : restored === 1 ? t("ux.l1.levelLine.undoneOne")
    : restored > 1 ? t("ux.l1.levelLine.undoneMany", { n: restored }) : "";
  const kept = [
    result.bot === "refused" ? t("ux.l1.levelLine.botKept", { bot }) : "",
    refused === 1 ? t("ux.l1.levelLine.keptOne") : refused > 1 ? t("ux.l1.levelLine.keptMany", { n: refused }) : "",
  ];
  const text = [done, ...kept, result.message ?? ""].filter(Boolean).join(" ");
  return failed ? { kind: "undone", text, at: now, undo: result.remaining, retry: true } : { kind: "undone", text, at: now, undo: null };
}

/** The confirm card as Settings › Level holds it. */
export interface LevelCard {
  target: "full" | "unlimited";
  preview: LevelPreview;
  notice?: string;
  error?: string;
}

/** What the level menu shows next. */
export interface LevelView { card: LevelCard | null; line: LevelLine | null }

/** A fresh card from a fresh preview. When the level has moved past the pick
 * nothing is left to confirm, so only the line remains. */
export async function openLevelCard(deps: LevelDeps, input: { botId: string; target: "full" | "unlimited"; notice?: string; now?: number }): Promise<LevelView> {
  const { botId, target, notice, now = Date.now() } = input;
  try {
    const preview = await previewLevel(deps, botId, target);
    if (!needsLevelConfirm(fromWire(preview.botLevel), target)) return { card: null, line: notice ? noteLine(notice, now) : null };
    return { card: { target, preview, ...(notice ? { notice } : {}) }, line: null };
  } catch (error) {
    return { card: null, line: noteLine(failureWords(target, error), now) };
  }
}

/** [Use {level}] or "Only new conversations", and every owner line of the
 * design's section 1 table: stale comes back as a fresh card, a refused save
 * keeps the card open with its line, F14 is a line of its own. */
export async function pressUse(deps: LevelDeps, input: { botId: string; bot: string; card: LevelCard; acks: LevelAcks; conversations: boolean; drivesComputer: boolean; now?: number }): Promise<LevelView> {
  const { botId, bot, card, acks, conversations, drivesComputer, now = Date.now() } = input;
  const outcome = await confirmRaise(deps, { botId, target: card.target, preview: card.preview, conversations, acks });
  if (outcome.kind === "stale") return openLevelCard(deps, { botId, target: card.target, notice: t("ux.l1.confirm.stale", { bot }), now });
  if (outcome.kind === "failed") return { card: { target: card.target, preview: card.preview, error: outcome.message }, line: null };
  return { card: null, line: outcome.kind === "saved" ? raisedLine(bot, outcome, drivesComputer, now) : applyRefusedLine(bot, outcome, drivesComputer, now) };
}
