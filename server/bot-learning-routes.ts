// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Route table for /api/bots/:id/{learning,outcomes,feedback,lessons}.
// Batch B0 ships the skeleton: every route exists, is desktop-only, validates
// the shape of a mutation (expected revision and idempotency key) and answers
// a plain "not available yet" until its own batch registers a handler.
// Later batches add routes by calling registerLearningRoute from their own
// module (listed in bot-learning-modules.ts); nobody edits this table or
// server/index.ts to do it. See lanes/bot-evolution/INTEGRATOR.md.

export type LearningRouteId =
  | "settings.read" | "settings.update"
  | "outcomes.list" | "outcomes.add" | "outcomes.change"
  | "feedback.list" | "feedback.add" | "feedback.answer"
  | "lessons.list" | "lessons.add" | "lessons.edit" | "lessons.undo" | "lessons.share" | "lessons.widen"
  | "examples.list"
  | "runs.list" | "runs.preview" | "runs.start" | "runs.cancel"
  | "suggestions.list" | "suggestions.apply" | "suggestions.edit" | "suggestions.not-now"
  | "history.list" | "history.undo" | "counts.read"
  | "backfill.start"
  | "data.forget";

export interface LearningRouteDef { id: LearningRouteId; method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; pattern: RegExp; /** The empty answer a read gives while its batch is not built. */ empty?: Record<string, unknown> }

const base = "/api/bots/([\\w-]+)";
const item = "([\\w-]{1,64})";
export const LEARNING_ROUTES: readonly LearningRouteDef[] = Object.freeze([
  { id: "settings.read", method: "GET", pattern: new RegExp(`^${base}/learning$`) },
  { id: "settings.update", method: "PATCH", pattern: new RegExp(`^${base}/learning$`) },
  { id: "outcomes.list", method: "GET", pattern: new RegExp(`^${base}/outcomes$`), empty: { outcomes: [] } },
  { id: "outcomes.add", method: "POST", pattern: new RegExp(`^${base}/outcomes$`) },
  { id: "outcomes.change", method: "PATCH", pattern: new RegExp(`^${base}/outcomes/${item}$`) },
  { id: "feedback.list", method: "GET", pattern: new RegExp(`^${base}/feedback$`), empty: { feedback: [] } },
  { id: "feedback.add", method: "POST", pattern: new RegExp(`^${base}/feedback$`) },
  { id: "feedback.answer", method: "PATCH", pattern: new RegExp(`^${base}/feedback/${item}$`) },
  { id: "lessons.list", method: "GET", pattern: new RegExp(`^${base}/lessons$`), empty: { lessons: [] } },
  { id: "lessons.add", method: "POST", pattern: new RegExp(`^${base}/lessons$`) },
  { id: "lessons.edit", method: "PATCH", pattern: new RegExp(`^${base}/lessons/${item}$`) },
  { id: "lessons.undo", method: "DELETE", pattern: new RegExp(`^${base}/lessons/${item}$`) },
  { id: "lessons.share", method: "POST", pattern: new RegExp(`^${base}/lessons/${item}/share$`) },
  { id: "lessons.widen", method: "POST", pattern: new RegExp(`^${base}/lessons/${item}/widen$`) },
  { id: "examples.list", method: "GET", pattern: new RegExp(`^${base}/learning/examples$`), empty: { examples: [] } },
  { id: "runs.list", method: "GET", pattern: new RegExp(`^${base}/learning/runs$`), empty: { runs: [] } },
  { id: "runs.preview", method: "POST", pattern: new RegExp(`^${base}/learning/runs/preview$`) },
  { id: "runs.start", method: "POST", pattern: new RegExp(`^${base}/learning/runs$`) },
  { id: "runs.cancel", method: "POST", pattern: new RegExp(`^${base}/learning/runs/${item}/cancel$`) },
  { id: "suggestions.list", method: "GET", pattern: new RegExp(`^${base}/learning/suggestions$`), empty: { suggestions: [] } },
  { id: "suggestions.apply", method: "POST", pattern: new RegExp(`^${base}/learning/suggestions/${item}/apply$`) },
  { id: "suggestions.edit", method: "POST", pattern: new RegExp(`^${base}/learning/suggestions/${item}/edit$`) },
  { id: "suggestions.not-now", method: "POST", pattern: new RegExp(`^${base}/learning/suggestions/${item}/not-now$`) },
  { id: "history.list", method: "GET", pattern: new RegExp(`^${base}/learning/history$`), empty: { events: [] } },
  { id: "history.undo", method: "POST", pattern: new RegExp(`^${base}/learning/history/${item}/undo$`) },
  { id: "counts.read", method: "GET", pattern: new RegExp(`^${base}/learning/counts$`), empty: { counts: { lessons: 0, memories: 0, wins: 0, undone: 0 }, unseen: 0 } },
  { id: "data.forget", method: "DELETE", pattern: new RegExp(`^${base}/learning/data$`) },
  { id: "backfill.start", method: "POST", pattern: new RegExp(`^${base}/learning/backfill$`) },
]);

export interface LearningRouteContext {
  botId: string;
  /** Captured path parts after the bot id (an item id, when the route has one). */
  itemId?: string;
  method: string;
  url: URL;
  /** Parsed JSON body; `{}` for a read. */
  body: Record<string, unknown>;
  /** Every mutation carries both; the dispatcher has checked their shape. */
  expectedRevision?: number;
  idempotencyKey?: string;
}
export interface LearningRouteAnswer { status: number; body: unknown }
export type LearningRouteHandler = (context: LearningRouteContext) => LearningRouteAnswer | Promise<LearningRouteAnswer>;

const handlers = new Map<LearningRouteId, LearningRouteHandler>();
/** Claim a route. A second claim for the same route is a programming error. */
export function registerLearningRoute(id: LearningRouteId, handler: LearningRouteHandler): void {
  if (handlers.has(id)) throw new Error(`LEARNING_ROUTE_ALREADY_REGISTERED: ${id}`);
  handlers.set(id, handler);
}
export const learningRouteHandler = (id: LearningRouteId) => handlers.get(id);
/** Tests only: forget every claim. */
export function resetLearningRoutesForTest(): void { handlers.clear(); }
