// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today's Detailed view (Today slice 1.0.18, designs/TODAY-SLICE-1104.md section 2b): pure models, no reads, no
// timers, no model call. Every block reads data the store already holds.
//   spendCard     D3: reported routine cost by local day, from `state.routineRuns[].cost` (no per-day spend record
//                 exists). Coverage follows the store's trim (2,000 runs, terminal runs trimmed oldest first).
//   botLines      D4: one line per visible bot: state, last run (or last active), next run.
//   doneMeta      D2: "{bot} · {time} · took {dur} · {cost} · runs on {engine}", unknown parts dropped.
//   routinesLine  D5: ran, failed and the next run.
// One clock for the whole page: the viewer's (days are local calendar days, right on 23 and 25 hour days).
import type { Routine, RoutineRun } from "@/lib/routines";
import type { TodayText } from "@/lib/today-model";
import { formatUsd } from "@/lib/usage";
import { workingNow } from "@/lib/working-now";
import { formatElapsed } from "@/lib/working-time";
import type { Bot } from "@/state/store";

/** The store keeps this many routine runs (`MAX_ROUTINE_RUNS`, store.tsx); at the cap the oldest terminal runs are gone. */
export const TODAY_RUNS_HELD = 2_000;
/** Bars on the spend card: 6 days and today. */
export const SPEND_BAR_DAYS = 7;
/** Days before today the usual is taken from, and how many of them must report a cost. */
const USUAL_DAYS = 7;
const USUAL_MIN = 3;

const TERMINAL = new Set<RoutineRun["status"]>(["completed", "failed", "cancelled", "missed"]);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const runAt = (run: RoutineRun) => run.finishedAt ?? run.scheduledFor;
const dayStart = (at: number, offset = 0) => { const d = new Date(at); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime(); };
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** One local day on the spend card.
 *  cost        at least one run reported a finite cost: `total` is the sum of the finite costs
 *  unreported  runs ran, none reported a cost: a hollow bar, never $0
 *  empty       no run that day: a real $0
 *  uncovered   before the oldest held terminal run (the store's trim): not known, a hollow bar */
export interface SpendDay {
  start: number;
  kind: "cost" | "unreported" | "empty" | "uncovered";
  total: number;
  runs: number;
  /** runs that day with no finite cost */
  unreportedRuns: number;
}

export type SpendCard =
  | { state: "tooMany" }
  | { state: "none" }
  | { state: "ok"; days: SpendDay[]; today: SpendDay; usual: number | null };

/** D3. `runs` is the whole held list (`state.routineRuns`). */
export function spendCard(runs: readonly RoutineRun[], now: number): SpendCard {
  const todayStart = dayStart(now);
  // At the cap the store dropped the oldest terminal runs: days start covered the day after the oldest one still held.
  let coveredFrom = Number.NEGATIVE_INFINITY;
  if (runs.length >= TODAY_RUNS_HELD) {
    let oldest = Number.POSITIVE_INFINITY;
    for (const run of runs) if (TERMINAL.has(run.status) && finite(run.scheduledFor)) oldest = Math.min(oldest, run.scheduledFor);
    if (Number.isFinite(oldest)) coveredFrom = dayStart(oldest, 1);
    if (coveredFrom > todayStart) return { state: "tooMany" };
  }
  // Today and the USUAL_DAYS before it, oldest first.
  const starts = Array.from({ length: USUAL_DAYS + 1 }, (_, i) => dayStart(now, i - USUAL_DAYS));
  const index = new Map(starts.map((start, i) => [start, i]));
  const sums = starts.map(() => ({ total: 0, runs: 0, finite: 0 }));
  for (const run of runs) {
    if (!TERMINAL.has(run.status)) continue;
    const at = runAt(run);
    if (!finite(at) || at > now) continue;
    const i = index.get(dayStart(at));
    if (i === undefined) continue;
    const day = sums[i]!;
    day.runs += 1;
    if (finite(run.cost) && run.cost >= 0) { day.total += run.cost; day.finite += 1; }
  }
  const days: SpendDay[] = starts.map((start, i) => {
    const sum = sums[i]!;
    const kind: SpendDay["kind"] = start < coveredFrom ? "uncovered" : sum.finite > 0 ? "cost" : sum.runs > 0 ? "unreported" : "empty";
    return { start, kind, total: kind === "cost" ? sum.total : 0, runs: sum.runs, unreportedRuns: sum.runs - sum.finite };
  });
  if (!days.some((day) => day.kind === "cost")) return { state: "none" };
  const before = days.slice(0, USUAL_DAYS).filter((day) => day.kind === "cost").map((day) => day.total);
  return {
    state: "ok",
    days: days.slice(days.length - SPEND_BAR_DAYS),
    today: days[days.length - 1]!,
    usual: before.length >= USUAL_MIN ? median(before) : null,
  };
}

/** The spend card's words, as TodayText: the today line, the partial line, the usual line. */
export function spendLines(card: Extract<SpendCard, { state: "ok" }>): { today: TodayText; partial: TodayText | null; usual: TodayText } {
  const { today } = card;
  return {
    today: today.kind === "unreported" ? { key: "ux.l2a.today.runCost.todayNone" } : { key: "ux.l2a.today.runCost.today", params: { cost: formatUsd(today.total) } },
    partial: today.kind === "cost" && today.unreportedRuns > 0 ? { key: "ux.l2a.today.runCost.partial", params: { n: today.unreportedRuns } } : null,
    usual: card.usual === null ? { key: "ux.l2a.today.runCost.noHistory" } : { key: "ux.l2a.today.runCost.usual", params: { usual: formatUsd(card.usual) } },
  };
}

export type BotState = "working" | "waiting" | "ready" | "noSignal" | "stopped";

/** D4: one visible bot. `last` is its newest finished routine run, else its newest task activity ("Last active"). */
export interface BotLine {
  botId: string;
  name: string;
  state: BotState;
  last: { kind: "run" | "active"; at: number } | null;
  next: number | null;
}

type BotSource = Pick<Bot, "id" | "name" | "threadId" | "busy" | "activity" | "turnStartedAt" | "tasks" | "hidden">;
const STATE_ORDER: Record<BotState, number> = { working: 0, waiting: 1, ready: 2, noSignal: 2, stopped: 2 };

/** D4. Order: working, waiting for you, then by next run (soonest first, none last), then name. */
export function botLines(
  bots: readonly BotSource[],
  routines: readonly Pick<Routine, "botId" | "enabled" | "nextRunAt">[],
  runs: readonly Pick<RoutineRun, "botId" | "finishedAt">[],
  now: number,
): BotLine[] {
  const visible = bots.filter((bot) => !bot.hidden);
  const working = new Set(workingNow(visible).map((item) => item.botId));
  const lastRun = new Map<string, number>();
  for (const run of runs) if (finite(run.finishedAt) && run.finishedAt > (lastRun.get(run.botId) ?? Number.NEGATIVE_INFINITY)) lastRun.set(run.botId, run.finishedAt);
  const next = new Map<string, number>();
  for (const routine of routines) {
    if (!routine.enabled || !finite(routine.nextRunAt) || routine.nextRunAt < now) continue;
    if (routine.nextRunAt < (next.get(routine.botId) ?? Number.POSITIVE_INFINITY)) next.set(routine.botId, routine.nextRunAt);
  }
  const lines = visible.map((bot): BotLine => {
    const state: BotState = working.has(bot.id) ? "working"
      : bot.activity === "waiting-on-you" ? "waiting"
      : bot.activity === "no-signal" ? "noSignal"
      : bot.activity === "dead" ? "stopped"
      : "ready";
    const ran = lastRun.get(bot.id);
    const active = (bot.tasks ?? []).reduce<number | null>((best, task) => (finite(task.lastActivityAt) && task.lastActivityAt > 0 && (best === null || task.lastActivityAt > best) ? task.lastActivityAt : best), null);
    return {
      botId: bot.id, name: bot.name, state,
      last: ran !== undefined ? { kind: "run", at: ran } : active !== null ? { kind: "active", at: active } : null,
      next: next.get(bot.id) ?? null,
    };
  });
  return lines.sort((a, b) =>
    STATE_ORDER[a.state] - STATE_ORDER[b.state]
    || (a.next ?? Number.POSITIVE_INFINITY) - (b.next ?? Number.POSITIVE_INFINITY)
    || a.name.localeCompare(b.name));
}

type TaskSource = { threadId: string; modelSelection?: { instanceId: string }; followsBotModel?: boolean };
type EngineBot = { id: string; name: string; modelSelection?: { instanceId: string }; tasks?: readonly TaskSource[] };

/** The engine a run's bot uses NOW (RoutineRun records no engine): the run thread's task model unless it follows
 *  the bot, else the bot's, named by the instance's display name. Labelled "runs on", never as the run's engine. */
export function runEngine(
  run: Pick<RoutineRun, "botId" | "executionThreadId" | "threadId">,
  bots: readonly EngineBot[],
  instances: readonly { instanceId: string; displayName: string }[],
): string | null {
  const bot = bots.find((entry) => entry.id === run.botId);
  if (!bot) return null;
  const threadId = run.executionThreadId ?? run.threadId;
  const task = threadId ? bot.tasks?.find((entry) => entry.threadId === threadId) : undefined;
  const instanceId = (task && !task.followsBotModel ? task.modelSelection?.instanceId : undefined) ?? bot.modelSelection?.instanceId;
  if (!instanceId) return null;
  const name = instances.find((entry) => entry.instanceId === instanceId)?.displayName?.trim();
  return name || null;
}

/** D2: the second line of a Done today row in Detailed, unknown parts dropped; a null cost says "no cost reported". */
export function doneMeta(
  run: Pick<RoutineRun, "botId" | "startedAt" | "finishedAt" | "cost" | "executionThreadId" | "threadId">,
  row: { botName: string; time: string },
  bots: readonly EngineBot[],
  instances: readonly { instanceId: string; displayName: string }[],
): TodayText[] {
  const parts: TodayText[] = [];
  if (row.botName) parts.push({ raw: row.botName });
  if (row.time) parts.push({ raw: row.time });
  if (finite(run.startedAt) && finite(run.finishedAt) && run.finishedAt >= run.startedAt) {
    parts.push({ key: "ux.l2a.today.done.took", params: { dur: formatElapsed(run.finishedAt - run.startedAt) } });
  }
  parts.push(finite(run.cost) && run.cost >= 0 ? { raw: formatUsd(run.cost) } : { key: "ux.l2a.today.done.noCost" });
  const engine = runEngine(run, bots, instances);
  if (engine) parts.push({ key: "ux.l2a.today.done.engine", params: { engine } });
  return parts;
}

/** D5: ran = completed today, failed = failed + missed today, next = the earliest finite `nextRunAt >= now` over
 *  enabled routines (may be tomorrow). Null with no routines at all (the line is hidden). */
export function routinesLine(
  routines: readonly Pick<Routine, "name" | "enabled" | "nextRunAt">[],
  runs: readonly Pick<RoutineRun, "status" | "finishedAt" | "scheduledFor">[],
  now: number,
): { ran: number; failed: number; next: { name: string; at: number } | null } | null {
  if (!routines.length) return null;
  const today = dayStart(now);
  let ran = 0, failed = 0;
  for (const run of runs) {
    const at = run.finishedAt ?? run.scheduledFor;
    if (!finite(at) || dayStart(at) !== today) continue;
    if (run.status === "completed") ran += 1;
    else if (run.status === "failed" || run.status === "missed") failed += 1;
  }
  let next: { name: string; at: number } | null = null;
  for (const routine of routines) {
    if (!routine.enabled || !finite(routine.nextRunAt) || routine.nextRunAt < now) continue;
    if (!next || routine.nextRunAt < next.at) next = { name: routine.name, at: routine.nextRunAt };
  }
  return { ran, failed, next };
}
