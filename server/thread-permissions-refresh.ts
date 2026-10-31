// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-K K3 (122): copy a bot's permissions onto one chat, only through
// the owner's own desktop action and only after the owner saw what changes.
// The first call is a preview; the second applies it only while nothing
// changed in between (the preview id is a hash of everything it read).
// Full access is copied only when the bot itself is on Full access.
//
// 1.0.13 UX-TRUST-L1B: the open-conversations preview also covers a level the
// bot is not on yet (targetLevel) and everything that level would move: the
// conversations and every routine of the bot. It keeps no state: previewId
// binds the bot's state before the write (the default PATCH checks it), and
// rosterId binds the conversations alone, so the apply that follows that PATCH
// accepts the PATCH's own bump.

import { createHash } from "node:crypto";
import { botPermissionMode, effectiveRoutinePermissionMode, loadRoutinePermissionMode, type RoutinePermissionMode } from "./routine-permissions.ts";

export interface PermissionHolder { autoApprove?: boolean; fullAccess?: boolean; noLimits?: boolean; alwaysAllow?: string[]; permissionRev?: number }
export type PermissionLevel = "ask" | "auto" | "full" | "no-limits";
/** The record's level and revision before its last level write; on a bot, also its routines at that write (the proof an exact step back needs). */
export interface PermissionPrev { level: PermissionLevel; rev: number; routinesId?: string }

export function permissionLevel(holder: PermissionHolder): PermissionLevel {
  if (holder.autoApprove !== true) return "ask";
  if (holder.fullAccess !== true) return "auto";
  return holder.noLimits === true ? "no-limits" : "full";
}

function fields(holder: PermissionHolder) {
  return { autoApprove: holder.autoApprove === true, fullAccess: holder.fullAccess === true, noLimits: holder.noLimits === true, alwaysAllow: [...(holder.alwaysAllow ?? [])].sort() };
}

export interface RefreshPreview {
  previewId: string;
  level: { from: PermissionLevel; to: PermissionLevel };
  alwaysAllowAdd: string[];
  /** what applying writes onto the chat */
  patch: { autoApprove: boolean; fullAccess: boolean; noLimits: boolean; alwaysAllow: string[] };
}

export function refreshPreview(bot: PermissionHolder, task: PermissionHolder): RefreshPreview {
  const b = fields(bot), t = fields(task);
  const autoApprove = b.autoApprove;
  // Full (and no limits above it) only when the bot is on Full itself
  const fullAccess = autoApprove && b.fullAccess;
  const noLimits = fullAccess && b.noLimits;
  const held = new Set(t.alwaysAllow);
  const alwaysAllowAdd = b.alwaysAllow.filter(key => !held.has(key));
  const patch = { autoApprove, fullAccess, noLimits, alwaysAllow: [...(task.alwaysAllow ?? []), ...alwaysAllowAdd] };
  const previewId = createHash("sha256").update(JSON.stringify({ bot: b, task: t, add: [...alwaysAllowAdd].sort() })).digest("hex");
  return { previewId, level: { from: permissionLevel(task), to: permissionLevel(patch) }, alwaysAllowAdd, patch };
}

export const PERMISSION_LEVELS: readonly PermissionLevel[] = ["ask", "auto", "full", "no-limits"];
export interface OpenPermissionCandidate extends PermissionHolder {
  threadId: string;
  /** Server-derived identity/lineage binding and current eligibility. */
  binding: string;
  reason?: string;
}
/** What a preview reads of a routine. A routine awaiting migration has no ceiling yet and follows the bot. */
export interface PreviewRoutine { id: string; name: string; permissionMode?: RoutinePermissionMode; updatedAt: number }
export interface RoutineEffect { id: string; name: string; ceiling: PermissionLevel; from: PermissionLevel; to: PermissionLevel }
export interface OpenRefreshPreview {
  previewId: string;
  rosterId: string;
  routinesId: string;
  targetLevel: PermissionLevel;
  botLevel: PermissionLevel;
  botRev: number;
  eligible: Array<{ threadId: string; from: PermissionLevel; to: PermissionLevel; rev: number }>;
  skipped: Array<{ threadId: string; reason: string }>;
  routines: RoutineEffect[];
}
export function permissionLevelPatch(level: PermissionLevel) {
  return { autoApprove: level !== "ask", fullAccess: level === "full" || level === "no-limits", noLimits: level === "no-limits" };
}
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const wireLevel = (mode: RoutinePermissionMode): PermissionLevel => mode === "unlimited" ? "no-limits" : mode;
const byId = <T extends { id: string }>(routines: readonly T[]) => [...routines].sort((a, b) => a.id.localeCompare(b.id));

/** Every routine of the bot, not only the ones a level moves: a ceiling edit that would newly raise one changes this too. */
export function routinesId(routines: readonly PreviewRoutine[]): string {
  return sha256(byId(routines).map(routine => [routine.id, routine.permissionMode ?? null, routine.updatedAt]));
}
/** The routines whose effective level differs at `targetLevel`. Through the one rule a run uses, so a draft-only bot's stay at Ask. */
export function routineEffects(bot: PermissionHolder, routines: readonly PreviewRoutine[], targetLevel: PermissionLevel): RoutineEffect[] {
  const after = { ...bot, ...permissionLevelPatch(targetLevel) };
  return byId(routines).flatMap(routine => {
    const from = effectiveRoutinePermissionMode(routine, bot), to = effectiveRoutinePermissionMode(routine, after);
    if (from === to) return [];
    const ceiling = loadRoutinePermissionMode(routine.permissionMode) ?? botPermissionMode(after);
    return [{ id: routine.id, name: routine.name, ceiling: wireLevel(ceiling), from: wireLevel(from), to: wireLevel(to) }];
  });
}
export function openRefreshPreview(bot: PermissionHolder, candidates: readonly OpenPermissionCandidate[], options: { targetLevel?: PermissionLevel; routines?: readonly PreviewRoutine[] } = {}): OpenRefreshPreview {
  const botLevel = permissionLevel(bot), botRev = bot.permissionRev ?? 0, targetLevel = options.targetLevel ?? botLevel, routines = options.routines ?? [];
  const eligible: OpenRefreshPreview["eligible"] = [], skipped: OpenRefreshPreview["skipped"] = [], bound: unknown[] = [];
  const roster = [...candidates].sort((a, b) => a.threadId.localeCompare(b.threadId));
  for (const task of roster) {
    const from = permissionLevel(task), rev = task.permissionRev ?? 0;
    const reason = task.reason ?? (PERMISSION_LEVELS.indexOf(from) >= PERMISSION_LEVELS.indexOf(targetLevel) ? "already-at-level" : undefined);
    if (reason) skipped.push({ threadId: task.threadId, reason });
    else eligible.push({ threadId: task.threadId, from, to: targetLevel, rev });
    bound.push([task.threadId, from, rev, task.binding, reason ?? null]);
  }
  const rosterId = sha256({ targetLevel, roster: bound }), routinesHash = routinesId(routines);
  const previewId = sha256(["open", targetLevel, botLevel, botRev, rosterId, routinesHash]);
  return { previewId, rosterId, routinesId: routinesHash, targetLevel, botLevel, botRev, eligible, skipped, routines: routineEffects(bot, routines, targetLevel) };
}

/** A body of POST /api/bots/:id/permissions/refresh. The apply binds to the revision the default PATCH returned (design section 2). */
export type OpenRefreshRequest =
  | { apply: false; targetLevel?: PermissionLevel }
  | { apply: true; targetLevel: PermissionLevel; rosterId: string; afterRev: number };
export const isPermissionRev = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function openRefreshRequest(body: unknown): OpenRefreshRequest | null {
  const { scope, targetLevel, rosterId, afterRev, previewId } = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (scope !== "open" || previewId !== undefined) return null;
  if (targetLevel !== undefined && !PERMISSION_LEVELS.includes(targetLevel as PermissionLevel)) return null;
  if (rosterId === undefined && afterRev === undefined) return { apply: false, ...(targetLevel !== undefined ? { targetLevel: targetLevel as PermissionLevel } : {}) };
  if (typeof rosterId !== "string" || !isPermissionRev(afterRev) || targetLevel === undefined) return null;
  return { apply: true, rosterId, afterRev, targetLevel: targetLevel as PermissionLevel };
}
/** The apply's three checks; true when it may write. */
export function openApplyCurrent(bot: PermissionHolder, request: { targetLevel: PermissionLevel; rosterId: string; afterRev: number }, preview: OpenRefreshPreview): boolean {
  return permissionLevel(bot) === request.targetLevel && (bot.permissionRev ?? 0) === request.afterRev && preview.rosterId === request.rosterId;
}

/** One server-derived eligibility decision shared by preview and apply. */
export function openPermissionExclusion(facts: { owner: boolean; automation: boolean; closed: boolean; roomOwner: boolean; busy: boolean }): string | undefined {
  return !facts.owner ? "other-owner" : facts.automation ? "automation" : facts.closed ? "closed" : !facts.roomOwner ? "room-owner" : facts.busy ? "busy" : undefined;
}
