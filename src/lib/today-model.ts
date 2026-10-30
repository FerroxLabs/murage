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
  snapshot: { state: "available" | "unavailable"; authenticated?: boolean };
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
    case "ready": return { key: "engine", tone: "ok", text: t("ux.l2a.tag.signedIn", { engine: name }), action: "engines" };
    case "signed-out": return { key: "engine", tone: "bad", text: t("ux.l2a.tag.signedOut", { engine: name }), action: "engines" };
    case "limit": return { key: "engine", tone: "warn", text: t("ux.l2a.tag.limit", { engine: name }), action: "engines" };
    case "off": return { key: "engine", tone: "warn", text: t("ux.l2a.tag.off", { engine: name }), action: "engines" };
    case "missing": return { key: "engine", tone: "bad", text: t("ux.l2a.tag.missing", { engine: name }), action: "engines" };
  }
}

export function needsTag(count: number | undefined): TodayTagModel | null {
  if (count === undefined) return null;
  const text = count === 0 ? t("ux.l2a.tag.needsNone") : count === 1 ? t("ux.l2a.tag.needsOne") : t("ux.l2a.tag.needsMany", { n: count });
  return { key: "needs", tone: "info", text, action: "needs" };
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

export function engineState(engine: EngineReading): EngineHealthRow["state"] {
  if (engine.enabled === false) return "off";
  if (engine.snapshot.state !== "available") return "missing";
  if (engine.snapshot.authenticated === false) return "signed-out";
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

export function todayModel(input: TodayInput): TodayModel {
  const greeting = greetingFor(input.now, input.ownerName);
  const dateLine = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(input.now);
  if (input.firstRun) {
    return { greeting, dateLine, firstRun: true, tags: [{ key: "setup", tone: "info", text: t("ux.l2a.tag.gettingSetUp"), action: "setup" }], routinesToday: [], finished: [] };
  }
  const tags: TodayTagModel[] = [];
  const engine = engineTag(input);
  if (engine) tags.push(engine);
  // Health "act" gets its own tag unless the engine tag already says the same thing in red.
  if (input.health.level === "act" && input.health.line && engine?.tone !== "bad") tags.push({ key: "health", tone: "bad", text: input.health.line, action: "health" });
  const needs = needsTag(input.needsCount);
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
