// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today (UX 1.0.13, lane L2A; mockup Desktop.dc.html Today board, copy
// verbatim). Pure: everything Today shows is decided here from state the app
// already holds, so each scenario is a plain test (today-model.test.ts).
//
// Status tags, in this order (plan 1.1):
//   1. the engine: "Claude signed in" / "Flux Router: allowance used up" /
//      "Offline · bots on this computer keep working"
//   2. anything unhealthy the owner must act on (Health "act")
//   3. needs: "3 things need you" / "Nothing needs you"
//   4. the month tag (L2C) and the clients tag (L6C), when they have one
//   5. apps: "4 apps connected"
//   6. quiet hours
// During first run there is exactly one tag, "Getting set up" (FIRSTRUN 1.2).
//
// Today slice (1.0.18, designs/TODAY-SLICE-1104.md sections 1 and 2). Exported for the view:
//   type TodayText = { key: string; params? } | { raw: string }   a line as a string key (design section 4,
//        `ux.l2a.today.*`) plus params, or the owner's own words (an Inbox title, a run's error); the view calls t()
//   needsTag(count, state)                 "ok" only when fresh, 0 and no line; checking when stale/unknown
//   detailedOrder(narrow)                  Detailed blocks in DOM order for the active layout (no CSS order)
//   todayEngine(fallback, engines, botEngineIds)   Fuigo first when any visible bot runs on a Fuigo engine
//   engineTag(...)                         a ready Fuigo engine reads "Fuigo on Flux Router"
//   leadLine({ ran, look, decide, next })  the lead line's parts, zero parts dropped
//   routinesRanToday(runs, now)            completed runs today (the lead line's `ran`)
//   doneToday(runs, botNames, now)         Done today rows: title = routine name, failed and missed first
import { t } from "@/lib/i18n";
import type { Connectivity } from "@/lib/connectivity";
import type { Routine, RoutineRun } from "@/lib/routines";
import type { EngineHealthRow, FluxHealthState, HealthLevel, TodayTag, TodayTone } from "@/components/shell/shell-contract";

/** What a tag does when pressed; TodayView maps each to a store action. */
export type TodayAction = "engines" | "flux" | "needs" | "health" | "apps" | "notifications" | "setup";

export interface TodayTagModel extends Omit<TodayTag, "onClick"> {
  action?: TodayAction;
}

export interface EngineReading {
  instanceId: string;
  displayName: string;
  enabled?: boolean;
  /** Fuigo signs in through Flux, so its own signed-out flag is not a problem (the server's engineRow rule). */
  driverKind?: string;
  snapshot: { state: "available" | "unavailable"; authenticated?: boolean; authUnverified?: true };
}

export interface TodayRow {
  id: string;
  botId?: string;
  threadId?: string;
  routineId?: string;
  line: string;
  meta: string;
  tone: "ok" | "bad" | "next";
}

export interface TodayInput {
  now: Date;
  ownerName: string;
  firstRun: boolean;
  connectivity: Connectivity;
  /** the engine Today names first, from GET /api/engine-health or the client's own reading */
  engine: EngineHealthRow | null;
  flux: FluxHealthState;
  needsCount: number | undefined;
  /** what the Needs you block below knows, so the head never says less than it (needsTag) */
  needsState?: NeedsTagState;
  health: { level: HealthLevel; line: string };
  monthTag: TodayTag | null;
  clientsTag: TodayTag | null;
  appsConnected: number | null;
  quiet: { active: boolean; until: string | null };
  routines: readonly Routine[];
  runs: readonly RoutineRun[];
  botNames: Readonly<Record<string, string>>;
}

export interface TodayModel {
  greeting: string;
  dateLine: string;
  firstRun: boolean;
  tags: TodayTagModel[];
  routinesToday: TodayRow[];
  finished: TodayRow[];
  /** Done today (1.0.18): replaces `routinesToday` and `finished` on the board. */
  done: DoneRow[];
}

/** A line Today shows: a string key of design section 4 (`ux.l2a.today.*`) with its params, or words that are
 *  already the owner's (an Inbox title, a run's error). The view turns a key into words with t(). */
export type TodayText = { key: string; params?: Record<string, string | number> } | { raw: string };

/** One Done today row (design section 2). */
export interface DoneRow {
  id: string;
  runId: string;
  routineId: string;
  botId: string;
  /** where the run worked: `executionThreadId ?? threadId` */
  threadId?: string;
  /** the routine's name */
  title: string;
  /** failed or missed: `run.error` (first line), else `ux.l2a.today.look.failedGeneric`; completed: the output's
   *  first line, or null when it left none */
  line: TodayText | null;
  status: "completed" | "failed" | "missed";
  tone: "ok" | "bad";
  botName: string;
  /** `finishedAt ?? scheduledFor`, epoch ms, and the same as HH:MM */
  at: number;
  time: string;
}

/** "Good morning" before 12, "Good afternoon" before 18, else "Good evening". */
export function greetingFor(now: Date, ownerName: string): string {
  const h = now.getHours();
  const part = h < 12 ? 0 : h < 18 ? 1 : 2;
  const name = ownerName.trim();
  if (name) return t((["ux.l2a.today.greet.morningName", "ux.l2a.today.greet.afternoonName", "ux.l2a.today.greet.eveningName"] as const)[part], { name });
  return t((["ux.l2a.today.greet.morning", "ux.l2a.today.greet.afternoon", "ux.l2a.today.greet.evening"] as const)[part]);
}

/** The engine tag: Flux allowance first (it stops every Flux bot), then offline, then the engine itself. */
export function engineTag(input: Pick<TodayInput, "engine" | "flux" | "connectivity">): TodayTagModel | null {
  if (input.flux === "allowance-used-up") return { key: "engine", tone: "bad", text: t("ux.l2a.tag.fluxUsedUp"), action: "flux" };
  if (input.connectivity === "offline") return { key: "engine", tone: "warn", text: t("ux.l2a.tag.offline") };
  if (input.flux === "key-problem") return { key: "engine", tone: "bad", text: t("ux.l2a.tag.fluxKey"), action: "flux" };
  const engine = input.engine;
  if (!engine) return null;
  const name = engine.label;
  switch (engine.state) {
    case "ready": return { key: "engine", tone: "ok", text: engine.fuigo ? t("ux.l2a.today.tag.fuigoFlux") : t("ux.l2a.tag.signedIn", { engine: name }), action: "engines" };
    case "checking": return { key: "engine", tone: "info", text: t("ux.l2a.tag.checking", { engine: name }), action: "engines" };
    case "signed-out": return { key: "engine", tone: "bad", text: t("ux.l2a.tag.signedOut", { engine: name }), action: "engines" };
    case "limit": return { key: "engine", tone: "warn", text: t("ux.l2a.tag.limit", { engine: name }), action: "engines" };
    case "off": return { key: "engine", tone: "warn", text: t("ux.l2a.tag.off", { engine: name }), action: "engines" };
    case "missing": return { key: "engine", tone: "bad", text: t("ux.l2a.tag.missing", { engine: name }), action: "engines" };
  }
}

/** What the Needs you block knows beyond the count (TodayView passes the same values NeedsBlock gets). */
export interface NeedsTagState {
  /** the count could not be refreshed (`useNeedsSummary().stale`) */
  stale?: boolean;
  /** the lines Today holds (Decide + Worth a look, `needsLines().all.length`) */
  lines?: number;
  /** this surface reads Needs you (not the browser door): an unknown count reads "Checking" rather than nothing */
  reads?: boolean;
}

/** The head's Needs you tag, on the same conditions as NeedsBlock: "Nothing needs you" in green only when the count
 *  is fresh, 0, and no Worth a look line exists. Unknown (on a surface that reads it) or stale: the checking words in
 *  the checking tone. Count 0 with Worth a look lines: those lines, counted, in the "info" tone. */
export function needsTag(count: number | undefined, state: NeedsTagState = {}): TodayTagModel | null {
  const lines = state.lines ?? 0;
  if (count === undefined) return state.reads ? { key: "needs", tone: "info", text: t("ux.l2a.today.needsChecking"), action: "needs" } : null;
  if (state.stale) return { key: "needs", tone: "info", text: t("ux.l2a.today.needsChecking"), action: "needs" };
  const n = count > 0 ? count : lines;
  const text = n === 0 ? t("ux.l2a.tag.needsNone") : n === 1 ? t("ux.l2a.tag.needsOne") : t("ux.l2a.tag.needsMany", { n });
  // Nothing owed and nothing worth a look is good news, so it reads in the "ok" tone (1.0.18).
  return { key: "needs", tone: n === 0 ? "ok" : "info", text, action: "needs" };
}

export type DetailedBlock = "needs" | "cost" | "day" | "routines" | "working" | "done";

/** Detailed (2b) in DOM order, so the reading and tab order is the order seen. Phone, one column: Needs you, cost,
 *  Your day, routines line, Working now, Done today. Desktop, two columns row by row: Needs you | Your day,
 *  cost | routines line, Working now | Done today. */
export function detailedOrder(narrow: boolean): DetailedBlock[] {
  return narrow
    ? ["needs", "cost", "day", "routines", "working", "done"]
    : ["needs", "day", "cost", "routines", "working", "done"];
}

function strip(tag: TodayTag | null): TodayTagModel | null {
  if (!tag) return null;
  return { key: tag.key, tone: tag.tone, text: tag.text };
}

/** Pick the engine Today names: the one most visible bots use, then the first ready one, then the first at all. */
export function primaryEngine(engines: readonly EngineReading[], botEngineIds: readonly string[]): EngineHealthRow | null {
  if (engines.length === 0) return null;
  const counts = new Map<string, number>();
  for (const id of botEngineIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const used = [...engines].filter((e) => counts.has(e.instanceId)).sort((a, b) => (counts.get(b.instanceId) ?? 0) - (counts.get(a.instanceId) ?? 0));
  const pick = used[0] ?? engines.find((e) => engineState(e) === "ready") ?? engines[0];
  return { id: pick.instanceId, label: pick.displayName, state: engineState(pick), line: "" };
}

const HEALTH_RANK: Record<EngineHealthRow["state"], number> = { missing: 5, "signed-out": 5, limit: 3, off: 3, checking: 1, ready: 0 };

/** The engine the Health dot, headline and Needs you read (HEALTH-HEADLINE-FALLBACK): the worst of the chosen default
 * and every engine a bot runs on. An engine nobody chose and no bot uses never sets the level, so a missing engine that
 * is not in use cannot turn Health red. Null when there is no such engine. */
export function healthEngine(rows: readonly EngineHealthRow[], defaultId: string | null): EngineHealthRow | null {
  const counted = rows.filter((row) => row.id === defaultId || (row.usedBy ?? 0) > 0);
  let pick: EngineHealthRow | null = null;
  for (const row of counted) {
    if (!pick || HEALTH_RANK[row.state] > HEALTH_RANK[pick.state] || (HEALTH_RANK[row.state] === HEALTH_RANK[pick.state] && row.id === defaultId)) pick = row;
  }
  return pick;
}

/** Today's engine (1.0.18): Fuigo first when any visible bot runs on a Fuigo engine (driver fuigoAgent), marked
 *  `fuigo: true` so its tag reads "Fuigo on Flux Router"; otherwise `fallback` (the server's primary, or
 *  `primaryEngine`) unchanged. `serverRows` are the server's own rows when it answered, so the state stays the
 *  server's. Today only: the badge's engine reading (`useEngineReading`) is not changed by this. */
export function todayEngine(fallback: EngineHealthRow | null, engines: readonly EngineReading[], botEngineIds: readonly string[], serverRows: readonly EngineHealthRow[] | null = null): EngineHealthRow | null {
  const used = new Set(botEngineIds);
  const fuigo = engines.find((engine) => engine.driverKind === "fuigoAgent" && used.has(engine.instanceId));
  if (!fuigo) return fallback;
  const server = serverRows?.find((row) => row.id === fuigo.instanceId);
  const row = server ?? (fallback?.id === fuigo.instanceId ? fallback : null) ?? { id: fuigo.instanceId, label: fuigo.displayName, state: engineState(fuigo), line: "" };
  return { ...row, fuigo: true };
}

export function engineState(engine: EngineReading): EngineHealthRow["state"] {
  if (engine.enabled === false) return "off";
  if (engine.snapshot.state !== "available") return "missing";
  if (engine.snapshot.authenticated === false && engine.driverKind !== "fuigoAgent") return "signed-out";
  if (engine.snapshot.authUnverified === true) return "checking";
  return "ready";
}

function sameDay(a: number, now: Date): boolean {
  const d = new Date(a);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function took(run: RoutineRun): string {
  if (!run.startedAt || !run.finishedAt || run.finishedAt < run.startedAt) return "";
  const s = Math.round((run.finishedAt - run.startedAt) / 1000);
  return s < 60 ? t("ux.l2a.routines.tookSeconds", { n: s }) : t("ux.l2a.routines.tookMinutes", { n: Math.round(s / 60) });
}

/** Today's routines: what ran today (newest first), then what is still to come today. At most `limit`. */
export function routinesToday(routines: readonly Routine[], runs: readonly RoutineRun[], botNames: Readonly<Record<string, string>>, now: Date, limit = 3): TodayRow[] {
  const name = (botId: string) => botNames[botId] ?? "";
  const ran: TodayRow[] = runs
    .filter((run) => (run.status === "completed" || run.status === "failed" || run.status === "missed") && sameDay(run.finishedAt ?? run.scheduledFor, now))
    .sort((a, b) => (b.finishedAt ?? b.scheduledFor) - (a.finishedAt ?? a.scheduledFor))
    .map((run) => {
      const at = clock(run.startedAt ?? run.scheduledFor);
      const ok = run.status === "completed";
      const parts = [name(run.botId), ok ? t("ux.l2a.routines.ranAt", { time: at }) : t("ux.l2a.routines.needsLook")];
      const length = ok ? took(run) : "";
      if (length) parts.push(length);
      return { id: run.id, botId: run.botId, routineId: run.routineId, threadId: run.threadId, line: run.routineName, meta: parts.filter(Boolean).join(" · "), tone: ok ? "ok" as const : "bad" as const };
    });
  // One row per routine: the newest run says how it went today.
  const seen = new Set<string>();
  const ranOnce = ran.filter((row) => {
    if (!row.routineId) return true;
    if (seen.has(row.routineId)) return false;
    seen.add(row.routineId);
    return true;
  });
  const next: TodayRow[] = routines
    .filter((routine) => routine.enabled && routine.nextRunAt !== null && routine.nextRunAt > now.getTime() && sameDay(routine.nextRunAt, now) && !seen.has(routine.id))
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
    .map((routine) => ({ id: `next:${routine.id}`, botId: routine.botId, routineId: routine.id, threadId: routine.threadId, line: routine.name, meta: [name(routine.botId), t("ux.l2a.routines.at", { time: clock(routine.nextRunAt ?? 0) })].filter(Boolean).join(" · "), tone: "next" as const }));
  return [...ranOnce, ...next].slice(0, limit);
}

/** Finished in the background: completed runs in the last day that left a result, newest first. */
export function finishedInBackground(runs: readonly RoutineRun[], botNames: Readonly<Record<string, string>>, now: Date, limit = 3): TodayRow[] {
  const dayAgo = now.getTime() - 24 * 3_600_000;
  return runs
    .filter((run) => run.status === "completed" && (run.finishedAt ?? 0) >= dayAgo && (run.output ?? "").trim().length > 0)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, limit)
    .map((run) => ({
      id: `done:${run.id}`,
      botId: run.botId,
      threadId: run.threadId,
      routineId: run.routineId,
      line: firstLine(run.output ?? "") || run.routineName,
      meta: [botNames[run.botId] ?? "", clock(run.finishedAt ?? run.scheduledFor)].filter(Boolean).join(" · "),
      tone: "ok" as const,
    }));
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((part) => part.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? "";
  return line.length > 90 ? `${line.slice(0, 89).trimEnd()}…` : line;
}

/** The lead line's numbers (design section 2): routines that ran today, Worth a look rows, decisions owed, and the
 *  next run today (from `dayTimeline`). */
export interface LeadInput {
  ran: number;
  look: number;
  decide: number;
  next: { name: string; at: number } | null;
}

/** "Today: {ran} routines ran, {look} worth a look. {decide} to decide. Next: {name} at {time}." as parts in that
 *  order, each part at 0 dropped (the view joins them). With nothing ran, to look at or to decide, the one quiet
 *  part, then Next when there is one. */
export function leadLine(input: LeadInput): TodayText[] {
  const parts: TodayText[] = [];
  const count = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  const ran = count(input.ran), look = count(input.look), decide = count(input.decide);
  if (ran) parts.push({ key: "ux.l2a.today.lead.ran", params: { n: ran } });
  if (look) parts.push({ key: "ux.l2a.today.lead.look", params: { n: look } });
  if (decide) parts.push({ key: "ux.l2a.today.lead.decide", params: { n: decide } });
  if (!parts.length) parts.push({ key: "ux.l2a.today.lead.quiet" });
  if (input.next && Number.isFinite(input.next.at)) parts.push({ key: "ux.l2a.today.lead.next", params: { name: input.next.name, time: clock(input.next.at) } });
  return parts;
}

/** How many routine runs completed today (the viewer's day): the lead line's `ran`. */
export function routinesRanToday(runs: readonly RoutineRun[], now: Date): number {
  return runs.filter((run) => run.status === "completed" && sameDay(run.finishedAt ?? run.scheduledFor, now)).length;
}

/** Done today (design section 2): runs `completed`, `failed` or `missed` whose `finishedAt ?? scheduledFor` is today.
 *  Title = the routine's name. Failed and missed first, then newest first. No cap: the view decides. */
export function doneToday(runs: readonly RoutineRun[], botNames: Readonly<Record<string, string>>, now: Date): DoneRow[] {
  const rows: DoneRow[] = [];
  for (const run of runs) {
    if (run.status !== "completed" && run.status !== "failed" && run.status !== "missed") continue;
    const at = run.finishedAt ?? run.scheduledFor;
    if (!Number.isFinite(at) || !sameDay(at, now)) continue;
    const ok = run.status === "completed";
    const error = firstLine(run.error ?? "");
    const output = firstLine(run.output ?? "");
    const line: TodayText | null = ok ? (output ? { raw: output } : null) : error ? { raw: error } : { key: "ux.l2a.today.look.failedGeneric" };
    const threadId = run.executionThreadId ?? run.threadId;
    rows.push({
      id: `done:${run.id}`, runId: run.id, routineId: run.routineId, botId: run.botId, ...(threadId ? { threadId } : {}),
      title: run.routineName, line, status: run.status, tone: ok ? "ok" : "bad", botName: botNames[run.botId] ?? "", at, time: clock(at),
    });
  }
  return rows.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1) || b.at - a.at);
}

export function todayModel(input: TodayInput): TodayModel {
  const greeting = greetingFor(input.now, input.ownerName);
  const dateLine = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(input.now);
  if (input.firstRun) {
    return { greeting, dateLine, firstRun: true, tags: [{ key: "setup", tone: "info", text: t("ux.l2a.tag.gettingSetUp"), action: "setup" }], routinesToday: [], finished: [], done: [] };
  }
  const tags: TodayTagModel[] = [];
  const engine = engineTag(input);
  if (engine) tags.push(engine);
  // Health "act" gets its own tag unless the engine tag already says the same thing in red.
  if (input.health.level === "act" && input.health.line && engine?.tone !== "bad") tags.push({ key: "health", tone: "bad", text: input.health.line, action: "health" });
  const needs = needsTag(input.needsCount, input.needsState);
  if (needs) tags.push(needs);
  for (const extra of [strip(input.monthTag), strip(input.clientsTag)]) if (extra) tags.push(extra);
  if (input.appsConnected !== null && input.appsConnected > 0) {
    tags.push({ key: "apps", tone: "ok", text: input.appsConnected === 1 ? t("ux.l2a.tag.appsOne") : t("ux.l2a.tag.appsMany", { n: input.appsConnected }), action: "apps" });
  }
  if (input.quiet.active) tags.push({ key: "quiet", tone: "neutral", text: input.quiet.until ? t("ux.l2a.tag.quietUntil", { time: input.quiet.until }) : t("ux.l2a.tag.quiet"), action: "notifications" });
  return {
    greeting,
    dateLine,
    firstRun: false,
    tags,
    routinesToday: routinesToday(input.routines, input.runs, input.botNames, input.now),
    finished: finishedInBackground(input.runs, input.botNames, input.now),
    done: doneToday(input.runs, input.botNames, input.now),
  };
}

/** Tone to a dot class (theme tokens; colour is never the only signal, the tag text says it). */
export const TONE_DOT: Record<TodayTone, string> = {
  ok: "bg-success",
  info: "bg-accent",
  warn: "bg-warning",
  bad: "bg-danger",
  neutral: "bg-ink-secondary/60",
};
