// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-K K3 (122): copy a bot's permissions onto one chat, only through
// the owner's own desktop action and only after the owner saw what changes.
// The first call is a preview; the second applies it only while nothing
// changed in between (the preview id is a hash of everything it read).
// Full access is copied only when the bot itself is on Full access.

import { createHash } from "node:crypto";

export interface PermissionHolder { autoApprove?: boolean; fullAccess?: boolean; noLimits?: boolean; alwaysAllow?: string[] }
export type PermissionLevel = "ask" | "auto" | "full" | "no-limits";

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
export interface OpenRefreshPreview {
  previewId: string;
  targetLevel: PermissionLevel;
  eligible: Array<{ threadId: string; from: PermissionLevel; to: PermissionLevel }>;
  skipped: Array<{ threadId: string; reason: string }>;
}
export function permissionLevelPatch(level: PermissionLevel) {
  return { autoApprove: level !== "ask", fullAccess: level === "full" || level === "no-limits", noLimits: level === "no-limits" };
}
export function openRefreshPreview(bot: PermissionHolder, candidates: readonly OpenPermissionCandidate[]): OpenRefreshPreview {
  const targetLevel = permissionLevel(bot), eligible: OpenRefreshPreview["eligible"] = [], skipped: OpenRefreshPreview["skipped"] = [];
  const roster = [...candidates].sort((a, b) => a.threadId.localeCompare(b.threadId));
  for (const task of roster) {
    const from = permissionLevel(task);
    const reason = task.reason ?? (PERMISSION_LEVELS.indexOf(from) >= PERMISSION_LEVELS.indexOf(targetLevel) ? "already-at-level" : undefined);
    if (reason) skipped.push({ threadId: task.threadId, reason });
    else eligible.push({ threadId: task.threadId, from, to: targetLevel });
  }
  const previewId = createHash("sha256").update(JSON.stringify({ scope: "open", targetLevel, roster })).digest("hex");
  return { previewId, targetLevel, eligible, skipped };
}

/** One server-derived eligibility decision shared by preview and apply. */
export function openPermissionExclusion(facts: { owner: boolean; automation: boolean; closed: boolean; roomOwner: boolean; busy: boolean }): string | undefined {
  return !facts.owner ? "other-owner" : facts.automation ? "automation" : facts.closed ? "closed" : !facts.roomOwner ? "room-owner" : facts.busy ? "busy" : undefined;
}
