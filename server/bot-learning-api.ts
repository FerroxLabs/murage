// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /api/bots/:id/learning and its siblings (outcomes, feedback, lessons).
// Desktop only; the caller (server/index.ts) checks the surface. This file
// owns the shared rules every route obeys: the bot must exist, a mutation
// names the revision it was based on and carries an idempotency key, and a
// retried mutation gets the first answer back instead of running twice.
// Settings are real in B0; every other route answers an empty read or
// "not available yet" until its batch registers a handler
// (bot-learning-routes.ts).
import { BOT_LEARNING_SWITCHES, cleanProspectThreadIds, nextBotLearning, readBotLearning, type BotLearning, type BotLearningChange } from "./bot-learning.ts";
import { LEARNING_ROUTES, learningRouteHandler, type LearningRouteAnswer, type LearningRouteContext } from "./bot-learning-routes.ts";

export interface BotLearningApiRequest {
  method: string;
  path: string;
  url: URL;
  /** Request headers, lower-cased by Node. */
  headers: Record<string, string | string[] | undefined>;
  readBody: () => Promise<unknown>;
  bot: (id: string) => { id: string; learning?: unknown } | null | undefined;
  /** Persist the bot's settings and tell the app. */
  saveLearning: (botId: string, learning: BotLearning) => void;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const REMEMBERED = 256;
const answers = new Map<string, { fingerprint: string; answer: LearningRouteAnswer }>();

export function resetBotLearningApiForTest(): void { answers.clear(); }

const settingsView = (learning: BotLearning) => ({
  settings: { enabled: learning.enabled, askFirst: learning.askFirst, prospectLearning: learning.prospectLearning, prospectThreadIds: [...(learning.prospectThreadIds ?? [])] },
  revision: learning.revision,
  // Counts and the ready line come from outcomes and examples (B1, B5).
  readiness: { ready: false, outcomes: 0, examples: 0 },
});
const bad = (error: string, extra: Record<string, unknown> = {}): LearningRouteAnswer => ({ status: 400, body: { error, ...extra } });

/** Returns undefined when the path is not a learning route at all. */
export async function handleBotLearningApi(request: BotLearningApiRequest): Promise<LearningRouteAnswer | undefined> {
  const matches = LEARNING_ROUTES.filter(route => route.pattern.test(request.path));
  if (!matches.length) return undefined;
  const route = matches.find(candidate => candidate.method === request.method);
  if (!route) return { status: 405, body: { error: "method not allowed" } };
  const parts = route.pattern.exec(request.path)!;
  const botId = parts[1]!;
  const bot = request.bot(botId);
  if (!bot) return { status: 404, body: { error: "no such bot" } };

  const mutation = request.method !== "GET";
  let body: Record<string, unknown> = {};
  let expectedRevision: number | undefined;
  let idempotencyKey: string | undefined;
  if (mutation) {
    const raw = await request.readBody().catch(() => null);
    if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) return bad("body must be a JSON object");
    body = (raw ?? {}) as Record<string, unknown>;
    expectedRevision = body.expectedRevision as number | undefined;
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) return bad("expectedRevision must be a whole number from the last read", { code: "EXPECTED_REVISION_REQUIRED" });
    const header = request.headers["idempotency-key"];
    idempotencyKey = typeof header === "string" ? header : typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) return bad("an idempotency key of 8 to 128 letters, digits and . _ : - is required", { code: "IDEMPOTENCY_KEY_REQUIRED" });
    const fingerprint = `${request.method} ${request.path} ${JSON.stringify(body, Object.keys(body).filter(key => key !== "idempotencyKey").sort())}`;
    const seen = answers.get(`${botId}|${idempotencyKey}`);
    if (seen) return seen.fingerprint === fingerprint ? seen.answer : { status: 422, body: { error: "that idempotency key was used for a different request", code: "IDEMPOTENCY_KEY_REUSED" } };
    const answer = await dispatch();
    // Only a settled answer is remembered; a server error should be retried for real.
    if (answer.status < 500) {
      answers.set(`${botId}|${idempotencyKey}`, { fingerprint, answer });
      if (answers.size > REMEMBERED) answers.delete(answers.keys().next().value!);
    }
    return answer;
  }
  return dispatch();

  async function dispatch(): Promise<LearningRouteAnswer> {
    const context: LearningRouteContext = { botId, itemId: parts[2], method: request.method, url: request.url, body, expectedRevision, idempotencyKey };
    const custom = learningRouteHandler(route!.id);
    if (custom) return custom(context);
    if (route!.id === "settings.read") return { status: 200, body: settingsView(readBotLearning(bot!)) };
    if (route!.id === "settings.update") return updateSettings(context);
    if (!mutation) return { status: 200, body: route!.empty ?? {} };
    return { status: 501, body: { error: "This is not available yet.", code: "LEARNING_NOT_AVAILABLE" } };
  }

  function updateSettings(context: LearningRouteContext): LearningRouteAnswer {
    const change: BotLearningChange = {};
    for (const key of BOT_LEARNING_SWITCHES) {
      const value = context.body[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean") return bad(`${key} must be true or false`);
      change[key] = value;
    }
    const scope = context.body.prospectThreadIds;
    if (scope !== undefined) {
      if (!Array.isArray(scope) || scope.some(id => typeof id !== "string")) return bad("prospectThreadIds must be a list of chat ids");
      change.prospectThreadIds = cleanProspectThreadIds(scope);
    }
    const unknown = Object.keys(context.body).filter(key => !["expectedRevision", "idempotencyKey", "prospectThreadIds", ...BOT_LEARNING_SWITCHES].includes(key));
    if (unknown.length) return bad(`unknown setting: ${unknown[0]}`);
    const result = nextBotLearning(readBotLearning(bot!), context.expectedRevision!, change);
    if (!result.ok) return { status: 409, body: { error: "Learning settings changed elsewhere. Refresh and review the latest choices.", code: "REVISION_CONFLICT", ...settingsView(result.learning) } };
    if (result.changed) request.saveLearning(botId, result.learning);
    return { status: 200, body: settingsView(result.learning) };
  }
}
