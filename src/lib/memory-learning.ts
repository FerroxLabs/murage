// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { semanticStatusPhrase, type LearningCeiling, type LearningCeilingStatus, type RetrySkippedRequest } from "../../shared/memory-learning-contract.ts";
export { semanticStatusPhrase };
export type { LearningCeiling, LearningCeilingStatus, RetrySkippedRequest, SemanticIndexStatus } from "../../shared/memory-learning-contract.ts";
/** Learning settings, schema v3 (memory schema 11): one monthly ceiling in place of the two daily caps. */
export interface LearningSettings {
  version: 3; automaticFacts: boolean; automaticProcedures: boolean; reviewMode: boolean;
  perCallOutputTokens: { extraction: number; grounding: number; reflection: number };
  ceiling: LearningCeiling; callsPerMinute: number;
  learnFrom: { chats: boolean; channels: boolean }; botsPaused: string[];
}
export interface MemoryLearning {
  revision: number; settings: LearningSettings; defaultOn: boolean;
  connection: { instanceId: string | null; label: string; source: "chosen" | "default" | "none"; reason?: string; suggestion?: { instanceId: string; label: string } };
  /** This month's learning against the monthly limit; `paused` is worked out by the server on every read. */
  ceiling: LearningCeilingStatus;
}
export interface LearningSource { threadId: string; messageId: string | null; botName: string | null; roomName: string | null }
export interface LearningEvent {
  id: string; kind: string; record_id: string | null; record_version: number | null;
  created_at: number; undone_at: number | null; kept_at: number | null;
  record: { id: string; version: number; state: string; text: string | null } | null;
  /** For a lesson event: the lesson itself (the text lives only there). */
  lesson?: { id: string; version: number; text: string; kind: string; state: string; origin: string } | null;
  /** For an automatic or suggested skill or routine change (B7c): what changed and how it landed. */
  procedure?: { kind: "skill" | "routine"; label: string; via: string; state: string } | null;
  scopeLabel: string; source: LearningSource | null;
  /** What the event recorded. Arrives as stored text or as an object; read it with `skippedSliceRetry`. */
  detail?: unknown;
}
export interface LearningPage { events: LearningEvent[]; nextCursor: string | null }
/** v3 patches only: the monthly limit travels in `ceiling`, never inside `learning` (the server refuses v2 patches). */
export type LearningAction = { action: "configure"; mode?: "off" | "capture" | "active" | "paused"; learning?: Partial<Omit<LearningSettings, "version" | "ceiling">>; learningRevision?: number; extractorInstanceId?: string | null; ceiling?: LearningCeiling }
  | RetrySkippedRequest
  | { action: "learning-bot"; botId: string; enabled: boolean; learningRevision: number }
  | { action: "learning-keep" | "learning-undo"; eventId: string }
  | { action: "learning-history"; botId?: string; cursor?: string; limit?: number };
export function requestLearningAction(request: (path: string, init: RequestInit) => Promise<unknown>, action: LearningAction) {
  return request("/api/memory/action", { method: "POST", body: JSON.stringify(action) });
}
export const learningConnectionLabel = (label: string) => label.replace("Flux Router · ", "Flux ");
/** Tokens as people read them: 2.1M, 0.3M, 100M, 850k, 640 (one decimal, no trailing zero; M from 100k up). */
export function formatTokens(count: number): string {
  const n = Math.max(0, Math.round(Number.isFinite(count) ? count : 0));
  const trim = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  if (n >= 100_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return String(n);
}
/** A ceiling of 0 on either side switches learning off; otherwise it is paused when the month has reached it. */
export function ceilingState(ceiling: Pick<LearningCeilingStatus, "input" | "output" | "paused">): "off" | "paused" | "open" {
  if (ceiling.input === 0 || ceiling.output === 0) return "off";
  return ceiling.paused ? "paused" : "open";
}
/** The raise offered when the month's limit is reached: double both sides (the stored maximum is a million million). */
export const raisedCeiling = (ceiling: LearningCeiling): LearningCeiling => ({ input: Math.min(1_000_000_000_000, Math.max(1, ceiling.input) * 2), output: Math.min(1_000_000_000_000, Math.max(1, ceiling.output) * 2) });
/** "Learn as we talk" is one switch over two settings: on when both are on, off when both are off, "Partly on" when they differ. */
export function learnAsWeTalk(settings: Pick<LearningSettings, "automaticFacts" | "automaticProcedures">): { on: boolean; partial: "facts" | "procedures" | null } {
  const { automaticFacts: facts, automaticProcedures: procedures } = settings;
  return { on: facts || procedures, partial: facts && !procedures ? "facts" : procedures && !facts ? "procedures" : null };
}
/** The one write the composite makes: both flags together, from what the switch shows now. */
export const learnAsWeTalkPatch = (settings: Pick<LearningSettings, "automaticFacts" | "automaticProcedures">) => {
  const next = !learnAsWeTalk(settings).on;
  return { automaticFacts: next, automaticProcedures: next };
};
/** The retry a skipped-slice event offers: a `run-completed` event whose detail says `slice-skipped`; null for every other event. */
export function skippedSliceRetry(event: Pick<LearningEvent, "kind" | "detail">): RetrySkippedRequest | null {
  if (event.kind !== "run-completed") return null;
  let detail: unknown = event.detail;
  if (typeof detail === "string") { try { detail = JSON.parse(detail); } catch { return null; } }
  if (!detail || typeof detail !== "object") return null;
  const value = detail as { outcome?: unknown; sourceId?: unknown; cursor?: unknown; retry?: { sourceId?: unknown; cursor?: unknown } };
  if (value.outcome !== "slice-skipped") return null;
  const sourceId = value.retry?.sourceId ?? value.sourceId, cursor = value.retry?.cursor ?? value.cursor;
  return typeof sourceId === "string" && sourceId && typeof cursor === "number" && Number.isInteger(cursor) && cursor >= 0 ? { action: "retry-skipped", sourceId, cursor } : null;
}
