// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export interface LearningSettings {
  version: 2; automaticFacts: boolean; automaticProcedures: boolean; reviewMode: boolean;
  perCallOutputTokens: { extraction: number; grounding: number; reflection: number };
  dailyInputTokens: number; dailyOutputTokens: number; callsPerMinute: number;
  learnFrom: { chats: boolean; channels: boolean }; botsPaused: string[];
}
export interface MemoryLearning {
  revision: number; settings: LearningSettings; defaultOn: boolean;
  connection: { instanceId: string | null; label: string; source: "chosen" | "default" | "none"; reason?: string; suggestion?: { instanceId: string; label: string } };
  allowance: { day: string; inputUsed: number; outputUsed: number; usedPercent: number; callsThisMinute?: number };
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
}
export interface LearningPage { events: LearningEvent[]; nextCursor: string | null }
export type LearningAction = { action: "configure"; learning?: Partial<Omit<LearningSettings, "version">>; learningRevision?: number; extractorInstanceId?: string | null }
  | { action: "learning-bot"; botId: string; enabled: boolean; learningRevision: number }
  | { action: "learning-keep" | "learning-undo"; eventId: string }
  | { action: "learning-history"; botId?: string; cursor?: string; limit?: number };
export function requestLearningAction(request: (path: string, init: RequestInit) => Promise<unknown>, action: LearningAction) {
  return request("/api/memory/action", { method: "POST", body: JSON.stringify(action) });
}
export const learningConnectionLabel = (label: string) => label.replace("Flux Router · ", "Flux ");
export function learningStatusLine(mode: string, learning: MemoryLearning): string {
  const { settings, connection } = learning;
  if (mode === "off") return "Learning is paused: memory is off.";
  if (mode === "paused") return "Learning is paused with memory processing.";
  if (!settings.automaticFacts && !settings.automaticProcedures) return "Learning is paused. Turn on facts or procedures below.";
  if (connection.source === "none") return connection.reason === "Add your Flux key or choose a connection." ? "Learning is paused: add your Flux key or choose a connection." : connection.reason?.startsWith("Learning is paused:") ? connection.reason : connection.reason ? `Learning is paused: ${connection.reason}` : "Learning is paused: add your Flux key or choose a connection.";
  if (settings.reviewMode || connection.source === "default" && !learning.defaultOn) return "Learning is on. Open Needs review below to approve new memories.";
  return `Learning is on. Uses ${learningConnectionLabel(connection.label)}.`;
}
export function learningEventLabel(kind: string): string {
  return ({ activated: "Learned", superseded: "Updated", merged: "Combined", "retired-stale": "Archived", "retired-time": "Archived", "archived-contradicted": "Archived", "procedure-proposed": "Procedure suggested", "procedure-published": "Procedure updated", "pruned-batch": "Older sources removed", "connection-defaulted": "Learning connection set", "settings-migrated": "Learning settings updated", "owner-undo": "Undone", "owner-keep": "Kept", "feedback-detected": "Feedback noticed", "outcome-marked": "Result marked", "lesson-learned": "Lesson learned", "lesson-edited": "Lesson edited", "lesson-undone": "Lesson undone", "guide-suggested": "Working guide change suggested", "guide-applied": "Working guide updated", "guide-undone": "Working guide change undone", "run-completed": "Learning run finished" } as Record<string, string>)[kind] ?? "Memory updated";
}
export function learningRequestError(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  if (text.includes("MEMORY_LEARNING_REVISION_CONFLICT")) return "Learning settings changed elsewhere. Refresh settings and review the latest choices.";
  if (text.includes("MEMORY_EXTRACTOR_UNAVAILABLE")) return "This connection is unavailable. Refresh settings and choose a connection.";
  if (text.startsWith("This memory changed since it was learned.") || text === "This learning item cannot be changed.") return text;
  return "Could not update memory. Refresh settings and try again.";
}
