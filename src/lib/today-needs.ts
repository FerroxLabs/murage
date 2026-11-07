// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today's Needs you block (Today slice 1.0.18, designs/TODAY-SLICE-1104.md section 2): two levels, Decide and Worth
// a look, three lines in all. Pure: the view hands in what it already holds (the one Inbox read through
// useNeedsSummary, the needs-reconnect and busy team-map reads through useWorthALook, and the store), and this
// decides every row. Nothing here reads, writes or calls a model.
//
// Exported:
//   needsLines(input: NeedsLinesInput): NeedsLines
//   withoutAnswered(rows, count, answered): the rows and count once a row answered from Today has left
//   TODAY_QUIET_MS (30 min), SPEND_JUMP_RATIO (3), SPEND_JUMP_FLOOR_USD (0.5), NEEDS_LINE_CAP (3)
//   types NeedsLinesInput, NeedsLines, NeedsLine, NeedsLineKind, NeedsTarget, ReconnectAppRow, BusyHandoffRow
//
// Order: Decide (approvals and questions, oldest first), then Worth a look: reconnect, failed routine, quiet bot,
// waiting hand-off, spend jump. The first `cap` lines show; `hidden` more expand in place.
// Badge rule: `count` (the badge total) is the truth. Owed items Today cannot name (snoozed, beyond the 25 read,
// backup, health, learning, memory, engine) are `unnamed`: they add to "and {n} more" and end the list with
// "Open Needs you for the rest" (`rest`). `nothing` ("Nothing needs you") only when count is 0 and no line exists.
// Reconnect, one source only, never matched by name: the Inbox's connection items; else its restore rows (the
// server raises those only when no connection is owed); else GET /api/connectors/needs-reconnect.
// Text is a TodayText: a design section 4 key (`ux.l2a.today.*`) plus params, or the owner's own words.
import { formatUsd } from "@/lib/usage";
import type { Routine, RoutineRun } from "@/lib/routines";
import { workingNow } from "@/lib/working-now";
import type { Bot } from "@/state/store";
import type { NeedsSummaryRow } from "@/components/shell/shell-contract";
import type { ConnectionToRestore } from "../../shared/inbox";
import type { TodayText } from "./today-model";

/** A working bot quiet this long gets a Worth a look row. Never "stuck": the server's stall stop is 60 min. */
export const TODAY_QUIET_MS = 30 * 60_000;
export const SPEND_JUMP_RATIO = 3;
export const SPEND_JUMP_FLOOR_USD = 0.5;
export const NEEDS_LINE_CAP = 3;
/** Earlier runs a spend jump is measured against, and how many of them must report a cost. */
const SPEND_HISTORY = 5;
const SPEND_HISTORY_MIN = 3;

/** One app from GET /api/connectors/needs-reconnect. */
export interface ReconnectAppRow { slug: string; label: string }
/** One row of GET /api/team-map?phase=busy `queued`. */
export interface BusyHandoffRow { sourceBotId: string; targetBotId: string; sourceThreadId?: string; reason?: string }

export type NeedsLineKind = "approval" | "question" | "connection" | "restore" | "reconnect" | "failed" | "quiet" | "handoff" | "spendJump";

/** What pressing the row does. */
export type NeedsTarget =
  /** the Needs you door (the summary row's own `open`) */
  | { type: "needs"; open: () => void }
  /** Connected apps */
  | { type: "apps" }
  /** a message in a conversation */
  | { type: "link"; threadId: string; messageId: string }
  /** a bot's conversation */
  | { type: "chat"; botId: string; threadId?: string }
  /** the routine run's result */
  | { type: "run"; botId: string; routineId: string; runId: string; threadId?: string }
  /** the Usage page */
  | { type: "usage" };

export interface NeedsLine {
  /** stable per source: the Inbox item id, `restore:<id>`, `reconnect:<slug>`, `failed:<routineId>`, ... */
  id: string;
  level: "decide" | "look";
  kind: NeedsLineKind;
  text: TodayText;
  meta: TodayText | null;
  /** a second line: a failed run's error, or the generic line */
  detail: TodayText | null;
  /** the button's words */
  act: TodayText;
  target: NeedsTarget;
  /** Decide only: the waiting request this row is, so it may answer in one click (NEEDSYOU-INLINE-APPROVE) */
  request?: NeedsRequest;
}

/** Where a Decide row's card lives, and the bot asking (the fresh-auth prompt names it). */
export interface NeedsRequest { threadId: string; messageId: string; version: string; botName?: string }

/** A row answered from Today leaves at once, and the count drops with it. The count comes from ONE snapshot
 *  (APPROVALS-SIMPLE-1018, needs-inline Astra r2 Medium): `rowsCount` is the owed total of the same read as `rows`, so
 *  an answered row the read still lists is taken off the count that read gave, once. When the server swaps the
 *  answered row for a new one at the same count, the badge count never loses it twice. When no answered row is listed
 *  any more (the read counted every answer) or the read had no count, the badge count is the truth. */
export function withoutAnswered<T extends { id: string }>(rows: readonly T[], count: number | undefined, answered: ReadonlySet<string> | ReadonlyMap<string, unknown>, rowsCount?: number): { rows: readonly T[]; count: number | undefined } {
  if (!answered.size) return { rows, count };
  const kept = rows.filter((row) => !answered.has(row.id));
  const listed = rows.length - kept.length;
  if (count === undefined || listed === 0 || rowsCount === undefined || !Number.isFinite(rowsCount)) return { rows: kept, count };
  return { rows: kept, count: Math.max(0, rowsCount - listed) };
}

export interface NeedsLinesInput {
  now: number;
  /** useNeedsSummary().count: the badge total, undefined while not known */
  count: number | undefined;
  /** useNeedsSummary().rows (every owed item read, with segment) */
  rows: readonly NeedsSummaryRow[];
  /** useNeedsSummary().restore */
  restore: readonly ConnectionToRestore[];
  /** useWorthALook().reconnect */
  reconnectApps: readonly ReconnectAppRow[];
  /** useWorthALook().handoffs (already busy only) */
  handoffs: readonly BusyHandoffRow[];
  routines: readonly Pick<Routine, "id">[];
  runs: readonly RoutineRun[];
  bots: readonly Pick<Bot, "id" | "name" | "threadId" | "busy" | "activity" | "turnStartedAt" | "tasks">[];
  botNames: Readonly<Record<string, string>>;
  /** lines shown before "and {n} more"; default NEEDS_LINE_CAP. Detailed passes Infinity. */
  cap?: number;
}

export interface NeedsLines {
  /** the lines shown, at most `cap` */
  lines: NeedsLine[];
  /** every line Today holds, in order ("and {n} more" expands to these) */
  all: NeedsLine[];
  /** lines past the cap */
  hidden: number;
  /** owed items (by `count`) that no line names */
  unnamed: number;
  /** hidden + unnamed: the n of "and {n} more" */
  more: number;
  /** end the list with "Open Needs you for the rest" */
  rest: boolean;
  /** "Nothing needs you": count is 0 and no line exists */
  nothing: boolean;
  /** the count is not known yet ("Checking what needs you.") */
  checking: boolean;
  /** Decide lines and Worth a look lines Today holds */
  decide: number;
  look: number;
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function sameDay(at: number, now: number): boolean {
  const a = new Date(at), b = new Date(now);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "missed"]);
const runAt = (run: RoutineRun) => run.finishedAt ?? run.scheduledFor;
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export function needsLines(input: NeedsLinesInput): NeedsLines {
  const { now } = input;
  const name = (botId: string) => input.botNames[botId] ?? "";
  const decide: NeedsLine[] = [];
  const connections: NeedsLine[] = [];
  for (const row of input.rows) {
    const target: NeedsTarget = { type: "needs", open: row.open };
    if (row.segment === "connection") {
      connections.push({ id: row.id, level: "look", kind: "connection", text: { raw: row.line }, meta: row.meta ? { raw: row.meta } : null, detail: null, act: { key: "ux.l2a.today.look.reconnectAct" }, target });
    } else if (row.segment === "approval" || row.segment === "question" || row.segment === undefined) {
      // Rows arrive oldest first; an owed row with no segment is still owed and still nameable.
      const botName = row.botId ? input.botNames[row.botId] : undefined;
      const request = row.request ? { request: { ...row.request, ...(botName ? { botName } : {}) } } : {};
      decide.push({ id: row.id, level: "decide", kind: row.segment === "question" ? "question" : "approval", text: { raw: row.line }, meta: row.meta ? { raw: row.meta } : null, detail: null, act: { key: "ux.l2a.today.act.open" }, target, ...request });
    }
  }

  // Reconnect: one source, each row keeps its own id and its own action.
  let reconnect: NeedsLine[] = connections;
  let restoreShown = 0;
  if (!reconnect.length && input.restore.length) {
    reconnect = input.restore.map((restore) => {
      restoreShown += 1;
      const stopped = restore.routines.length;
      return {
        id: `restore:${restore.id}`, level: "look" as const, kind: "restore" as const,
        // The row names no app (a run error names none), so its own sentence is the line.
        text: restore.detail ? { raw: restore.detail } : { key: "ux.l2a.today.look.failedGeneric" },
        meta: stopped > 0 && finite(restore.since) ? { key: "ux.l2a.today.look.reconnectMeta", params: { n: stopped, time: clock(restore.since) } } : null,
        detail: null,
        act: { key: "ux.l2a.today.look.reconnectAct" },
        target: restore.link ? { type: "link" as const, threadId: restore.link.threadId, messageId: restore.link.messageId } : { type: "apps" as const },
      };
    });
  }
  if (!reconnect.length) {
    const seen = new Set<string>();
    const apps = input.reconnectApps.filter((app) => {
      if (!app.slug || seen.has(app.slug)) return false;
      seen.add(app.slug);
      return true;
    });
    reconnect = apps.map((app) => ({
      id: `reconnect:${app.slug}`, level: "look" as const, kind: "reconnect" as const,
      text: { key: "ux.l2a.today.look.reconnect", params: { app: app.label || app.slug } },
      meta: null, detail: null, act: { key: "ux.l2a.today.look.reconnectAct" }, target: { type: "apps" as const },
    }));
  }

  // Failed routine: the newest terminal run of a routine today is failed or missed, and no restore row lists it.
  const restored = new Set(input.restore.flatMap((restore) => restore.routineKeys ?? []));
  const known = new Set(input.routines.map((routine) => routine.id));
  const newest = new Map<string, RoutineRun>();
  for (const run of input.runs) {
    if (!TERMINAL.has(run.status) || !finite(runAt(run)) || !sameDay(runAt(run), now) || !known.has(run.routineId)) continue;
    const held = newest.get(run.routineId);
    if (!held || runAt(run) > runAt(held)) newest.set(run.routineId, run);
  }
  const failed: NeedsLine[] = [...newest.values()]
    .filter((run) => (run.status === "failed" || run.status === "missed") && !restored.has(`routine:${run.routineId}`))
    .sort((a, b) => runAt(b) - runAt(a))
    .map((run) => {
      const error = firstLine(run.error ?? "");
      const threadId = run.executionThreadId ?? run.threadId;
      return {
        id: `failed:${run.routineId}`, level: "look" as const, kind: "failed" as const,
        text: { key: "ux.l2a.today.look.failed", params: { routine: run.routineName } },
        meta: { key: "ux.l2a.today.look.failedMeta", params: { bot: name(run.botId), time: clock(runAt(run)) } },
        detail: error ? { raw: error } : { key: "ux.l2a.today.look.failedGeneric" },
        act: { key: "ux.l2a.today.act.open" },
        target: { type: "run" as const, botId: run.botId, routineId: run.routineId, runId: run.id, ...(threadId ? { threadId } : {}) },
      };
    });

  // Quiet bot: working, and nothing new for TODAY_QUIET_MS since the later of the turn's start and the last row.
  const quietest = new Map<string, { quiet: number; threadId: string; botName: string }>();
  for (const item of workingNow(input.bots)) {
    const bot = input.bots.find((entry) => entry.id === item.botId);
    const task = bot?.tasks?.find((entry) => entry.threadId === item.threadId);
    // Explicit `activity === "working"` only: workingNow also counts a bare `busy` with no activity, which is not
    // enough to call a bot quiet.
    if (!(task?.activity === "working" || (item.threadId === bot?.threadId && bot?.activity === "working"))) continue;
    const last = task?.lastActivityAt;
    const stamps = [item.since, finite(last) && last > 0 ? last : null].filter((value): value is number => value !== null);
    if (!stamps.length) continue;
    const quiet = now - Math.max(...stamps);
    if (quiet < TODAY_QUIET_MS) continue;
    const held = quietest.get(item.botId);
    if (!held || quiet > held.quiet) quietest.set(item.botId, { quiet, threadId: item.threadId, botName: item.botName });
  }
  const quiet: NeedsLine[] = [...quietest.entries()].sort((a, b) => b[1].quiet - a[1].quiet).map(([botId, entry]) => ({
    id: `quiet:${botId}`, level: "look" as const, kind: "quiet" as const,
    text: { key: "ux.l2a.today.look.quiet", params: { bot: entry.botName || name(botId), n: Math.floor(entry.quiet / 60_000) } },
    meta: null, detail: null, act: { key: "ux.l2a.today.act.watch" }, target: { type: "chat" as const, botId, threadId: entry.threadId },
  }));

  // Waiting hand-off: the read is already busy only; one row per source, teammate and conversation.
  const handoffSeen = new Set<string>();
  const handoff: NeedsLine[] = [];
  for (const row of input.handoffs) {
    const from = name(row.sourceBotId), to = name(row.targetBotId);
    if (!from || !to) continue;
    const id = `handoff:${row.sourceBotId}:${row.targetBotId}:${row.sourceThreadId ?? ""}`;
    if (handoffSeen.has(id)) continue;
    handoffSeen.add(id);
    handoff.push({
      id, level: "look", kind: "handoff",
      text: { key: "ux.l2a.today.look.handoff", params: { from, to } },
      meta: { key: "ux.l2a.today.look.handoffMeta", params: { to } }, detail: null,
      act: { key: "ux.l2a.today.act.open" }, target: { type: "chat", botId: row.sourceBotId, ...(row.sourceThreadId ? { threadId: row.sourceThreadId } : {}) },
    });
  }

  // Spend jump: a settled run today at least 3x the median of its routine's 5 strictly earlier finite costs, and at
  // least $0.50 more. Fewer than 3 earlier costs, a zero median or a null cost never count. One row per routine.
  const costed = input.runs.filter((run) => TERMINAL.has(run.status) && finite(run.cost) && run.cost >= 0 && finite(runAt(run)));
  const jumps = new Map<string, { run: RoutineRun; usual: number }>();
  for (const run of costed) {
    if (!sameDay(runAt(run), now)) continue;
    const earlier = costed
      .filter((other) => other.routineId === run.routineId && runAt(other) < runAt(run))
      .sort((a, b) => runAt(b) - runAt(a))
      .slice(0, SPEND_HISTORY)
      .map((other) => other.cost as number);
    if (earlier.length < SPEND_HISTORY_MIN) continue;
    const usual = median(earlier);
    const cost = run.cost as number;
    // The floor in whole cents, so $0.70 against $0.20 is the full $0.50 (0.7 - 0.2 is 0.4999... in floats).
    const moreCents = Math.round(cost * 100) - Math.round(usual * 100);
    if (usual <= 0 || cost < SPEND_JUMP_RATIO * usual || moreCents < Math.round(SPEND_JUMP_FLOOR_USD * 100)) continue;
    const held = jumps.get(run.routineId);
    if (!held || cost > (held.run.cost as number)) jumps.set(run.routineId, { run, usual });
  }
  const spend: NeedsLine[] = [...jumps.values()].sort((a, b) => runAt(b.run) - runAt(a.run)).map(({ run, usual }) => ({
    id: `spendJump:${run.routineId}`, level: "look" as const, kind: "spendJump" as const,
    text: { key: "ux.l2a.today.look.spendLine", params: { routine: run.routineName, cost: formatUsd(run.cost as number) } },
    meta: { key: "ux.l2a.today.look.spendMeta", params: { bot: name(run.botId), usual: formatUsd(usual) } },
    detail: null, act: { key: "ux.l2a.today.look.spendAct" }, target: { type: "usage" as const },
  }));

  const look = [...reconnect, ...failed, ...quiet, ...handoff, ...spend];
  const all = [...decide, ...look];
  const cap = input.cap === undefined ? NEEDS_LINE_CAP : Math.max(0, input.cap);
  const lines = Number.isFinite(cap) ? all.slice(0, Math.floor(cap)) : all;
  const named = decide.length + connections.length + restoreShown;
  const count = input.count;
  const unnamed = finite(count) ? Math.max(0, count - named) : 0;
  const hidden = all.length - lines.length;
  return {
    lines, all, hidden, unnamed, more: hidden + unnamed, rest: unnamed > 0,
    nothing: count === 0 && all.length === 0,
    checking: count === undefined,
    decide: decide.length,
    look: look.length,
  };
}
