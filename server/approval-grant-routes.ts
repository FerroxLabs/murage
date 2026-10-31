// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 2.3.5 to 2.3.9 and 2.3.12: the grant routes' logic,
// out of server/index.ts so it can be tested on its own. index.ts keeps the
// path match and hands each route its facts (deps); everything a route
// decides is here.
//
//   POST /api/bots/:id/always-allow           botAlwaysAllowSave
//   POST /api/bots/:id/always-allow/undo      botAlwaysAllowUndo (the card's Undo, by holder)
//   POST /api/routines/:id/always-allow       routineGrantRefusal, routineSaveRefusal, routineRunLive (index.ts keeps the rest)
//   POST /api/threads/:id/respond (and the bot's) with allowForTask: taskGrantRefusal before delivery, TaskGrantReceipt after
//   POST /api/bots/:id/task-allow/remove      taskAllowRemove
//   POST /api/bots/:id/task-allow/clear       taskAllowClear
//   bot wire field taskAllowanceCount         taskAllowanceWire
//
// The rules: a bot-level "Always" is given on the computer only (404 before
// the body is read); a routine's card is answered with "Always, when it
// runs", never a bot-level key (409); every key must be one the card's fold
// offers (shared/fold-scopes.ts) and one durableGrantAllowed keeps, checked in
// plan(), before anything is staged or delivered; the response names what was
// actually added, so Undo takes back exactly that.
import type { ApprovalGrantRequest } from "../shared/approval-grant-request.ts";
import { durableGrantAllowed } from "../shared/durable-grant-allowed.ts";
import { botScopeOffered, foldScopes, taskScopeOffered, type CardClass, type CardKeys } from "../shared/fold-scopes.ts";
import { isQuestionGrant } from "../shared/grant-tool-names.ts";
import type { RememberInput, RememberResult } from "./grant-choke.ts";
import type { TaskAllowances } from "./stop-line-state.ts";

export interface RouteReply {
  status: number;
  body: Record<string, unknown>;
}

/** The fields of a stored card the bot route reads. */
export interface GrantCard {
  requestId?: string;
  answered?: unknown;
  dismissed?: boolean;
  allowKey?: string;
  allowKeys?: string[];
  exactAllowKey?: string;
  taskAllowKey?: string;
  routineAllowKey?: string;
  routineId?: string;
  grantRequest?: ApprovalGrantRequest;
  cardClass?: CardClass;
}

const ONCE_ONLY = "This approval can only be allowed once.";

/** The card's keys as shared/fold-scopes.ts reads them. */
export function cardKeysOf(card: GrantCard): CardKeys {
  return {
    ...(card.allowKey ? { allowKey: card.allowKey } : {}),
    ...(card.allowKeys ? { allowKeys: card.allowKeys } : {}),
    ...(card.exactAllowKey ? { exactAllowKey: card.exactAllowKey } : {}),
    ...(card.taskAllowKey ? { taskAllowKey: card.taskAllowKey } : {}),
    ...(card.routineAllowKey ? { routineAllowKey: card.routineAllowKey } : {}),
    ...(card.routineId ? { routineId: card.routineId } : {}),
    ...(card.grantRequest?.routine ? { routineOffer: card.grantRequest.routine } : {}),
  };
}

/** 2.3.5: the routine copy for a routine's card on the bot route. */
export function routineCardRefusal(routineName: string): string {
  return `This approval belongs to the routine ${routineName}. Choose Always, when it runs.`;
}

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** F12, H03: refuse a bot-level save the card does not offer, before anything
 * is staged or delivered. Throws with a status; returns when it may go on. */
export function assertBotGrantAllowed(card: GrantCard, keys: readonly string[], routineName: (routineId: string) => string | undefined): void {
  const routineId = card.routineId ?? card.grantRequest?.routine?.routineId;
  if (routineId) throw fail(409, routineCardRefusal(card.grantRequest?.routine?.routineName ?? routineName(routineId) ?? "this routine"));
  if (keys.some(isQuestionGrant)) throw fail(400, "questions cannot be always allowed");
  if (!keys.length || !keys.every(durableGrantAllowed)) throw fail(400, ONCE_ONLY);
  if (!botScopeOffered(card.cardClass, cardKeysOf(card), keys)) throw fail(400, ONCE_ONLY);
}

export interface BotGrantDeps {
  /** the request came from the desktop app (requestSurface === "desktop") */
  desktop: boolean;
  readBody: () => Promise<Record<string, unknown> | null | undefined>;
  botName: (botId: string) => string | undefined;
  /** the thread is one of this bot's own tasks */
  isTask: (botId: string, threadId: string) => boolean;
  /** the thread is a room this bot is a member of */
  roomHas: (threadId: string, botId: string) => boolean;
  /** the bot's direct thread a request names (throws with a status, as requestedDirectBot does) */
  directThread: (botId: string, requested: unknown) => string;
  /** the open card for this request on this thread; in a room, only one this bot raised */
  pendingCard: (threadId: string, requestId: string, roomBotId?: string) => GrantCard | undefined;
  routineName: (routineId: string) => string | undefined;
  remember: <T>(input: RememberInput<T>) => Promise<RememberResult<T>>;
  /** store.planBotGrants(...).added */
  plan: (botId: string, taskThreadId: string | undefined, keys: readonly string[]) => { bot: string[]; task: string[] };
  /** store.rememberBotGrants (with its grantSchema rule), run after the answer landed */
  write: (botId: string, taskThreadId: string | undefined, keys: readonly string[]) => { added: { bot: string[]; task: string[] } };
  /** the bot as the wire carries it, broadcast to every surface */
  publish: (botId: string) => unknown;
}

/** POST /api/bots/:id/always-allow: answer the card with Allow and save the
 * bot-level key (or action set) it offers, through the choke point. */
export async function botAlwaysAllowSave(deps: BotGrantDeps, botId: string, requestRes: unknown): Promise<RouteReply> {
  // 2.3.6: the computer only, decided before the body is read
  if (!deps.desktop) return { status: 404, body: { error: "no such route" } };
  const body = (await deps.readBody()) ?? {};
  const allowKey = typeof body.allowKey === "string" ? body.allowKey : "";
  // Rule 78c: the set a several-action card offered, echoed whole
  const allowKeys = Array.isArray(body.allowKeys) && body.allowKeys.length && body.allowKeys.every((key: unknown) => typeof key === "string") ? body.allowKeys as string[] : undefined;
  const name = deps.botName(botId);
  if (name === undefined) return { status: 404, body: { error: "no such bot" } };
  if (!allowKey && !allowKeys) return { status: 400, body: { error: "allowKey required" } };
  // A question is answered by the owner every time; no grant speaks for them,
  // even over a card an older build rendered with this key.
  if (allowKey && isQuestionGrant(allowKey)) return { status: 400, body: { error: "questions cannot be always allowed" } };
  // a stale connected-app shape, a command tool's bare name, a payment: never kept for good
  if (allowKey && !durableGrantAllowed(allowKey)) return { status: 400, body: { error: ONCE_ONLY } };
  // A card raised while this bot answered in a ROOM sits on the room's
  // thread, not one of its own tasks; a room turn reads the bot's own
  // defaults, which is where such a grant belongs.
  const requested = body.threadId;
  const roomThread = typeof requested === "string" && !deps.isTask(botId, requested) && deps.roomHas(requested, botId) ? requested : undefined;
  let cardThread: string;
  try {
    cardThread = roomThread ?? deps.directThread(botId, requested);
  } catch (error) {
    return { status: (error as { status?: number }).status ?? 400, body: { error: error instanceof Error ? error.message : String(error) } };
  }
  // AMEND-13 Rule 81: the decision names its pending request; the server
  // rereads THAT card and never searches for some card holding the key.
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  if (!requestId) return { status: 400, body: { error: "requestId required" } };
  const pending = deps.pendingCard(cardThread, requestId, roomThread ? botId : undefined);
  // Rule 78c: a card's whole action set, or the one key it offered
  const grantKeys = !pending ? undefined
    : allowKeys ? (pending.allowKeys?.length === new Set(allowKeys).size && allowKeys.every((key) => pending.allowKeys!.includes(key)) ? [...pending.allowKeys] : undefined)
    : allowKey && (pending.allowKey === allowKey || pending.exactAllowKey === allowKey) ? [allowKey] : undefined;
  if (!pending || !grantKeys) return { status: 409, body: { error: "that grant is not on a pending approval for this bot" } };
  // A13-FIX-DESIGN C1 through the one choke point: saved on the bot's
  // defaults and this task in one durable write, only after the approving
  // answer of the same call landed with the request's holder.
  const taskThread = roomThread ? undefined : cardThread;
  const decided = await deps.remember({
    res: requestRes, threadId: cardThread, requestId, answer: body.answer, onComputer: true, holderId: botId, botName: name,
    row: { kind: "bot", ownerId: botId, ...(taskThread ? { taskThreadId: taskThread } : {}) },
    plan: () => {
      assertBotGrantAllowed(pending, grantKeys, deps.routineName);
      const planned = deps.plan(botId, taskThread, grantKeys);
      return [...new Set([...planned.bot, ...planned.task])];
    },
    write: () => deps.write(botId, taskThread, grantKeys),
  });
  if (!decided.ok) return { status: decided.status, body: { error: decided.error, ...(decided.answered ? { outcome: decided.answered } : {}) } };
  // 1.3, M06: what this save actually added, BY HOLDER (the bot's defaults,
  // this task), so Undo takes back exactly that from each and nothing a
  // holder already had
  const added = { bot: [...new Set(decided.value.added.bot)], task: [...new Set(decided.value.added.task)] };
  return { status: 200, body: { bot: deps.publish(botId), saved: grantKeys, added, ...(taskThread ? { taskThreadId: taskThread } : {}), outcome: decided.outcome } };
}

export interface BotUndoDeps {
  /** the request came from the desktop app (requestSurface === "desktop") */
  desktop: boolean;
  readBody: () => Promise<Record<string, unknown> | null | undefined>;
  botName: (botId: string) => string | undefined;
  /** the thread is one of this bot's own tasks */
  isTask: (botId: string, threadId: string) => boolean;
  /** store.removeBotGrants: one durable write, returns what it removed */
  remove: (botId: string, taskThreadId: string | undefined, keys: { bot: string[]; task: string[] }) => { removed: { bot: string[]; task: string[] } };
  publish: (botId: string) => unknown;
}

const keyList = (value: unknown): string[] | undefined =>
  value === undefined ? [] : Array.isArray(value) && value.length <= 200 && value.every((key) => typeof key === "string" && key.length > 0) ? [...new Set(value as string[])] : undefined;

/** POST /api/bots/:id/always-allow/undo {threadId?, bot, task}: the card's
 * Undo (and its Take back) of one "Always" save. It removes the keys that
 * save reported as added, each from its own holder: `bot` from the bot's
 * defaults, `task` from the one task the save named, and never the copies
 * other tasks hold (the global remove route in Settings stays as it is).
 * The computer only, as the save; it only narrows what the bot may do. */
export async function botAlwaysAllowUndo(deps: BotUndoDeps, botId: string): Promise<RouteReply> {
  if (!deps.desktop) return { status: 404, body: { error: "no such route" } };
  if (deps.botName(botId) === undefined) return { status: 404, body: { error: "no such bot" } };
  const body = (await deps.readBody()) ?? {};
  const bot = keyList(body.bot);
  const task = keyList(body.task);
  if (!bot || !task) return { status: 400, body: { error: "bot and task must be lists of keys" } };
  if (!bot.length && !task.length) return { status: 400, body: { error: "nothing to take back" } };
  const threadId = typeof body.threadId === "string" && body.threadId ? body.threadId : undefined;
  if (task.length && (!threadId || !deps.isTask(botId, threadId))) return { status: 404, body: { error: "No such thread for this bot." } };
  let removed: { bot: string[]; task: string[] };
  try {
    removed = deps.remove(botId, task.length ? threadId : undefined, { bot, task }).removed;
  } catch (error) {
    return { status: (error as { status?: number }).status ?? 500, body: { error: error instanceof Error ? error.message : String(error) } };
  }
  return { status: 200, body: { bot: deps.publish(botId), removed } };
}

/** 2.3.4, Astra r1 item 2: the routine route saves only from a routine row
 * the card's own fold shows (shared/fold-scopes.ts), and only keys that row
 * offers. A guard, unattended or host card of a routine's run shows no row,
 * so a direct request saves nothing from it. Checked before staging or
 * delivery; undefined when it may go on. */
export function routineSaveRefusal(card: GrantCard, routineId: string, keys: readonly string[]): { status: number; error: string } | undefined {
  const row = foldScopes(card.cardClass, cardKeysOf(card)).find((candidate) => candidate.scope === "routine" && candidate.target.kind === "routine" && candidate.target.routineId === routineId);
  if (!row) return { status: 400, error: ONCE_ONLY };
  if (!keys.length || !keys.every((key) => row.keys.includes(key))) return { status: 409, error: "that grant is not on a pending approval for this routine" };
  return undefined;
}

/** Astra r1 item 7: "For 12 hours in this conversation" is checked before
 * the answer is delivered: a card whose fold shows no task row is refused
 * (400), never quietly answered Allow once. Undefined when it may go on. */
export function taskGrantRefusal(card: GrantCard | undefined): string | undefined {
  if (!card?.taskAllowKey) return ONCE_ONLY;
  return taskScopeOffered(card.cardClass, cardKeysOf(card), card.taskAllowKey) ? undefined : ONCE_ONLY;
}

/** What a task-row answer actually added, filled in by the delivery
 * (TaskAllowances.grant reports whether the allowance was new): the respond
 * route replies `taskAdded` from it, and the card's Undo removes only that. */
export interface TaskGrantReceipt {
  taskAdded?: string[];
}

/** POST /api/routines/:id/always-allow, before the offer is read (test 4):
 * a payment is never remembered for a routine, as the legacy single key, in
 * the chosen stop keys or anywhere in the set. */
export function routineGrantRefusal(allowKey: string | undefined, chosen: readonly string[] | undefined): string | undefined {
  if (allowKey !== undefined && !durableGrantAllowed(allowKey)) return ONCE_ONLY;
  if (chosen?.some((key) => !durableGrantAllowed(key))) return ONCE_ONLY;
  return undefined;
}

/** The routine's set, checked once more against the same rule (the offer
 * never carries a payment, so this only refuses an older card). */
export function routineKeysRefusal(keys: readonly string[]): string | undefined {
  return keys.every(durableGrantAllowed) ? undefined : ONCE_ONLY;
}

/** 2.3.9 (F9, H08): the routine card's live check compares the exact run
 * that raised the card, read once now; a later run of the same routine on
 * the same thread is not this one. */
export function routineRunLive(
  runFor: (threadId: string) => { runId: string; routineId: string } | null | undefined,
  threadId: string,
  routineId: string,
): () => boolean {
  const run = runFor(threadId);
  const runId = run && run.routineId === routineId ? run.runId : undefined;
  return () => {
    if (runId === undefined) return false;
    const now = runFor(threadId);
    return now?.routineId === routineId && now.runId === runId;
  };
}

export interface TaskAllowDeps {
  /** the desktop app, or the owner's paired phone (mayApprove) */
  mayApprove: boolean;
  readBody: () => Promise<Record<string, unknown> | null | undefined>;
  botExists: (botId: string) => boolean;
  /** the thread is this bot's own task or a room it is in */
  botThread: (botId: string, threadId: string) => boolean;
  /** the thread's human is the workspace owner */
  ownerThread: (threadId: string) => boolean;
  allowances: Pick<TaskAllowances, "revoke" | "clearBot" | "countForBot">;
}

const APPROVAL_NEEDS_OWNER = "Approving or answering happens in the Murage app or on your paired phone. From here you can only decline.";

/** POST /api/bots/:id/task-allow/remove {threadId, key}: Undo of a task row
 * (2.3.8). The desktop and the owner's paired app, as the grant; taking an
 * allowance back narrows what the bot may do, so it needs no fresh proof of
 * its own beyond the paired owner's. */
export async function taskAllowRemove(deps: TaskAllowDeps, botId: string): Promise<RouteReply> {
  if (!deps.mayApprove) return { status: 403, body: { error: APPROVAL_NEEDS_OWNER } };
  if (!deps.botExists(botId)) return { status: 404, body: { error: "no such bot" } };
  const body = (await deps.readBody()) ?? {};
  const threadId = typeof body.threadId === "string" ? body.threadId : "";
  const key = typeof body.key === "string" ? body.key : "";
  if (!threadId || !key) return { status: 400, body: { error: "threadId and key required" } };
  if (!deps.botThread(botId, threadId)) return { status: 404, body: { error: "no such conversation for this bot" } };
  if (!deps.ownerThread(threadId)) return { status: 403, body: { error: APPROVAL_NEEDS_OWNER } };
  const removed = deps.allowances.revoke(botId, threadId, key);
  return { status: 200, body: { removed, taskAllowanceCount: deps.allowances.countForBot(botId) } };
}

/** POST /api/bots/:id/task-allow/clear: the Settings "Clear" under
 * "Allowed for the next 12 hours in open conversations" (2.5). */
export async function taskAllowClear(deps: Omit<TaskAllowDeps, "readBody" | "botThread" | "ownerThread">, botId: string): Promise<RouteReply> {
  if (!deps.mayApprove) return { status: 403, body: { error: APPROVAL_NEEDS_OWNER } };
  if (!deps.botExists(botId)) return { status: 404, body: { error: "no such bot" } };
  const cleared = deps.allowances.clearBot(botId);
  return { status: 200, body: { cleared, taskAllowanceCount: 0 } };
}

/** 2.3.12: the one integer the bot's wire carries (no keys). index.ts
 * registers its TaskAllowances once it exists; before that the field is 0. */
let registered: Pick<TaskAllowances, "countForBot"> | undefined;
export function registerTaskAllowances(allowances: Pick<TaskAllowances, "countForBot">): void {
  registered = allowances;
}
export function taskAllowanceWire(botId: string): { taskAllowanceCount: number } {
  return { taskAllowanceCount: registered?.countForBot(botId) ?? 0 };
}
