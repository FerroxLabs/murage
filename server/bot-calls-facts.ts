// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot calls (design BOT-CALLS-109 rev 4.2, 4.1): the event sources that are not channel or turn facts. Each producer hands
// one server fact here; it is matched against the bot's enabled, un-held rules of the fact's kind and admitted (T1,
// INSERT OR IGNORE on the fact key). The tier is the rule's, derived from its kind (bot-calls-schema.ts): timed, watch and
// webhook are Tier A server facts no model can steer; routine problems and needs_owner_now are Tier B, which the schema
// fixes at message first. So nothing a model writes can ring as Tier A: the only model text, needs_owner_now's line, is
// fenced and only ever reaches a Tier B rule.
import type { DatabaseSync } from "node:sqlite";
import { admitIntent, type Admission, type FactKind } from "./bot-calls-machine.ts";
import { inTransaction, type CallRuleKind } from "./bot-calls-schema.ts";

/** One server fact. `at` is when it happened (fact_at); keys follow the table of 4.1. A watch rule's `watchId` is the
 * run's `watch.watchId` (shared/routine-watch.ts); a webhook rule's `routineId` is the webhook's id. */
export type ServerFact = (
  | { kind: "timed"; botId: string; threadId: string; routineId: string; runId: string; at: number }
  | { kind: "watch"; botId: string; threadId: string; watchId: string; runId: string; at: number }
  | { kind: "webhook"; botId: string; threadId: string; routineId: string; eventType: string; eventId: string; at: number }
  | { kind: "routine_problem"; problem: "failed" | "needs_you"; botId: string; threadId: string; routineId: string; runId: string; at: number }
  | { kind: "needs_owner_now"; botId: string; threadId: string; runId: string; line: string; at: number }
) & {
  /** Read back from a saved run by the boot re-scan, not seen live: a rule then admits it only when it was neither made nor
   * changed since (updated_at <= at), so a rule switched on after the fact never rings for it (Astra p5 r1 item 2). */
  replay?: true;
};

const ruleKind: Record<ServerFact["kind"], CallRuleKind> = { timed: "timed", watch: "watch", webhook: "webhook", routine_problem: "routine_problem", needs_owner_now: "needs_owner_now" };

/** needs_owner_now's run (4.1): the routine run the turn belongs to, so its fact and that run's failed / needs-you fact share
 * run:<runId> and count as ONE intent; a turn outside any routine run keys on its own generation. */
export function needsOwnerNowRunId(generation: string, routineRunId: string | undefined): string {
  return routineRunId ?? `turn:${generation}`;
}

/** The fact key (unique per bot) and the fact kind of 4.1. A run's Tier B facts share `run:<runId>`. */
export function factIdentity(f: ServerFact): { factKey: string; factKind: FactKind; fields: Record<string, unknown> } {
  switch (f.kind) {
    case "timed": return { factKey: `timed:${f.runId}`, factKind: "timed", fields: { routineId: f.routineId, runId: f.runId } };
    case "watch": return { factKey: `watch:${f.watchId}:${f.runId}`, factKind: "watch.changed", fields: { watchId: f.watchId, runId: f.runId } };
    case "webhook": return { factKey: `webhook:${f.eventId}`, factKind: "webhook.event", fields: { routineId: f.routineId, eventType: f.eventType } };
    case "routine_problem": return { factKey: `run:${f.runId}`, factKind: f.problem === "failed" ? "routine.failed" : "routine.needs_you", fields: { routineId: f.routineId, runId: f.runId } };
    case "needs_owner_now": return { factKey: `run:${f.runId}`, factKind: "routine.needs_owner_now", fields: { runId: f.runId } };
  }
}

function paramsMatch(f: ServerFact, params: Record<string, unknown>): boolean {
  switch (f.kind) {
    case "timed": return params.routineId === f.routineId;
    case "watch": return params.watchId === f.watchId;
    case "webhook": return params.routineId === f.routineId && params.eventType === f.eventType;
    case "routine_problem": return params.routineId === undefined || params.routineId === f.routineId;
    case "needs_owner_now": return true;
  }
}

/** The bot has at least one enabled rule of this kind (cheap: lets a producer skip work when no rule could match). */
export function botWantsFact(db: DatabaseSync, botId: string, kind: ServerFact["kind"]): boolean {
  return db.prepare("SELECT 1 FROM bot_call_rules WHERE bot_id=? AND kind=? AND enabled=1 LIMIT 1").get(botId, ruleKind[kind]) !== undefined;
}

/** The admissions this fact makes now: every enabled, un-held rule of the bot, made before the fact, whose params match. */
export function matchFact(db: DatabaseSync, f: ServerFact): Admission[] {
  // a rule admits only facts that happened after it was made, so a boot re-scan never admits an older run (4.1 recovery)
  // a replayed fact also needs the rule unchanged since (updated_at): a rule switched on, or edited, after the fact never
  // admits it, so a fact a disabled rule skipped live does not ring after a restart
  const since = f.replay ? "updated_at" : "created_at";
  const rules = db.prepare(`SELECT id, params FROM bot_call_rules WHERE bot_id=? AND kind=? AND enabled=1 AND restore_held=0 AND ${since} <= ? ORDER BY position, id`)
    .all(f.botId, ruleKind[f.kind], Math.trunc(f.at)) as Array<{ id: string; params: string }>;
  const { factKey, factKind, fields } = factIdentity(f);
  const out: Admission[] = [];
  for (const rule of rules) {
    let params: unknown;
    try { params = JSON.parse(rule.params); } catch { continue; }
    if (!params || typeof params !== "object" || Array.isArray(params) || !paramsMatch(f, params as Record<string, unknown>)) continue;
    out.push({ botId: f.botId, ruleId: rule.id, threadId: f.threadId, factKind, factKey, factAt: f.at, factFields: fields,
      ...(f.kind === "needs_owner_now" ? { line: f.line } : {}) });
  }
  return out;
}

/** T1 for one fact, in ONE transaction. The unique key holds one intent per bot and fact, so the first matching rule wins
 * and a repeat (a crash re-admit, a second producer) writes nothing. Returns the new intents' ids. */
export function admitFact(db: DatabaseSync, f: ServerFact, now: number): string[] {
  return inTransaction(db, () => {
    const ids: string[] = [];
    for (const admission of matchFact(db, f)) {
      const id = admitIntent(db, admission, now);
      if (id) ids.push(id);
    }
    return ids;
  });
}

/** The run fields routineRunFacts reads (server/routines.ts RoutineRun). */
export interface CallFactRun {
  id: string; routineId: string; botId: string; status: string; manual: boolean; triggerSource?: string; webhookId?: string;
  deliveryId?: string; webhookEventType?: string; scheduledFor?: number;
  startedAt?: number; finishedAt?: number; needsYouAt?: number; watch?: { watchId?: string; outcome?: string; ownerBotId?: string } | null;
}
/** When a run last moved (finished, else started, else scheduled): the boot re-scan keeps runs that moved inside the window,
 * so a run scheduled long ago that finished just before a crash is not missed (Astra p5 r1 item 1). */
export function runMovedAt(run: Pick<CallFactRun, "scheduledFor" | "startedAt" | "finishedAt">): number {
  return Math.max(run.scheduledFor ?? 0, run.startedAt ?? 0, run.finishedAt ?? 0);
}

/** The server facts a routine run carries as it stands: a scheduled run that started (timed), a watch check that found a
 * change, a run that failed, a run waiting on the owner (needs-you). Pure: the harness calls it on every durable run change
 * and once at boot (boot = true) over the last day's runs; the fact key keeps each to one intent. */
export function routineRunFacts(run: CallFactRun, threadId: string, now: number, boot = false): ServerFact[] {
  const botId = run.watch?.ownerBotId ?? run.botId;
  const base = { botId, threadId, routineId: run.routineId, runId: run.id };
  const out: ServerFact[] = [];
  const source = run.triggerSource ?? (run.manual ? "manual" : "schedule");
  const plainSchedule = source === "schedule" && !run.watch && !run.webhookId;
  if (plainSchedule && typeof run.startedAt === "number") out.push({ kind: "timed", ...base, at: run.startedAt });
  // a scheduled run marked missed (Murage was offline more than 12 h past its time) never started: it is still the timed
  // fact at its scheduled time (late, so a card), and a failure at its finish time (Grok p5 r1 G2)
  else if (plainSchedule && run.status === "missed" && typeof run.scheduledFor === "number") out.push({ kind: "timed", ...base, at: run.scheduledFor });
  // a webhook delivery: the event type is written with the run, so this fact is as durable as the run itself (a crash after
  // the save is recovered by the boot re-scan). Rule params: routineId = the webhook's id, eventType = the event's name.
  if (run.triggerSource === "webhook" && run.webhookId && run.deliveryId && run.webhookEventType && typeof run.scheduledFor === "number")
    out.push({ kind: "webhook", botId, threadId, routineId: run.webhookId, eventType: run.webhookEventType, eventId: `${run.webhookId}:${run.deliveryId}`, at: run.scheduledFor });
  if (run.watch && run.watch.outcome === "changed" && run.status === "completed" && typeof run.watch.watchId === "string")
    out.push({ kind: "watch", botId, threadId, watchId: run.watch.watchId, runId: run.id, at: run.finishedAt ?? now });
  if (run.status === "failed" || run.status === "missed") out.push({ kind: "routine_problem", problem: "failed", ...base, at: run.finishedAt ?? now });
  // needs-you happens at the instant the run recorded (needsYouAt, Grok p5 r1 G1), live and at boot alike; a run saved before
  // that field existed falls back to now live, and at boot to its start (an old one is late, card only)
  else if (run.status === "needs-you")
    out.push({ kind: "routine_problem", problem: "needs_you", ...base, at: run.needsYouAt ?? (boot ? (run.startedAt ?? 0) : now) });
  return boot ? out.map((f) => ({ ...f, replay: true as const })) : out;
}
