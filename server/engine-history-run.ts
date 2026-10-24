// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Plan, execute, verify for the engines' history (the work conversation-deletion.ts hands to a worker thread).
//
//   planEngineHistory      reads only. One strict reader (engine-fs.ts), one planner per engine (engine-plan-*.ts). The only
//                          try in the planning path is here, once per home: a PlanError gives that home NO plan, so nothing
//                          in it is touched, and the others still get theirs.
//   executeEnginePlans     engine-exec.ts. Runs only the steps a plan lists.
//   removeEngineHistoryFiles   the whole loop inline (no saved record): plan every home, execute, then plan every home again to
//                          verify. A home is done only when a plan made after its last execute has no content step left; a
//                          step whose inputs changed is stale and its home is planned again. Three rounds, then the home is
//                          reported failed and the caller's retry schedule takes over.
//
// The service (conversation-deletion.ts) runs the same stages as separate jobs so it can save the plan before the first step
// runs and the step marks as they finish.
import { configureScopes, engineState, inScopeFolder, privateScopeHome } from "./engine-closed.ts";
import { executeEnginePlans, recoverAll } from "./engine-exec.ts";
import { configureRedo } from "./engine-redo.ts";
import { realEngineFs } from "./engine-fs.ts";
import type { DeletionEngineHome, DeletionLeftover } from "./conversation-deletion.ts";
import type { EngineDiscovery, EngineHistoryJob, EngineHistoryResult } from "./engine-history-offthread.ts";
import { planAcpEngineHistory } from "./engine-plan-acp.ts";
import { planClaudeProjects, planCodexRollouts, planFuigoSessions } from "./engine-plan-files.ts";
import { hasContentSteps, homeKey, Known, pathApiFor, PlanError, Planner, type EngineFs, type HomePlanData } from "./engine-plan-core.ts";

/** Plan / execute / verify rounds per attempt before the home is reported failed and left to the retry schedule. */
export const MAX_ENGINE_ROUNDS = 3;

function planHome(pl: Planner, home: DeletionEngineHome, job: Pick<EngineHistoryJob, "folders" | "memoryFolders" | "sessions">): void {
  const { engine } = home;
  const sessionIds = (job.sessions[engine] ?? []).filter((id) => typeof id === "string");
  if (engine === "fuigo" || engine === "grok") planFuigoSessions(pl, home.home, job.folders, job.memoryFolders);
  else if (engine === "claude") planClaudeProjects(pl, home.home, job.folders, sessionIds);
  else if (engine === "codex") planCodexRollouts(pl, home.home, job.folders, home.sqliteHome);
  else planAcpEngineHistory(pl, { engine, home: home.home, ...(home.secondary ? { secondary: home.secondary } : {}), ...(home.db ? { db: home.db } : {}) }, job.folders, sessionIds);
}

const reasonOf = (error: unknown): string => {
  const cause = error instanceof PlanError ? error.cause : error;
  return ((cause as NodeJS.ErrnoException | undefined)?.code ?? (cause instanceof Error ? cause.message : String(cause))).slice(0, 160);
};

/** Reads everything the homes' removal depends on and returns a plan per home. A home that cannot be read in full is in
 * `failedHomes` with the path that failed, has no plan, and keeps the ids it was given. Changes nothing. */
export function planEngineHistory(job: EngineHistoryJob, fs: EngineFs = realEngineFs()): EngineHistoryResult {
  // A crash can leave a row cut in the middle of a value, which no plan could read: finish every journal first (engine-redo.ts). A home
  // whose journal cannot be finished now (its engine is open, or cannot be told, or the file is held) is not planned.
  const configured = new Map<string, string[]>();
  for (const home of job.homes) if (home.identities?.length) configured.set(homeKey(home.engine, home.home), [...new Set([...(configured.get(homeKey(home.engine, home.home)) ?? []), ...home.identities])]);
  // Only the homes this plan is for: with `only` (an attempt names the homes it has held), a journal of another home is not touched here.
  // A home inside an engine's scope folder that is not PRIVATE (it has login generations, or its marker does not hold) is never
  // recovered or planned: nothing in it is touched, and the next attempt names it as a leftover (conversation-deletion.ts).
  const only = job.only ? new Set(job.only) : undefined;
  const excluded = (engine: string, home: string): boolean => inScopeFolder(engine, home) && !privateScopeHome(engine, home);
  const recovery = recoverAll(Object.fromEntries(configured), [], (key) => {
    const [engine = "", home = ""] = key.split("\0");
    return (!only || only.has(key)) && !excluded(engine, home);
  });
  const plans: Record<string, HomePlanData> = {};
  const failed: string[] = [];
  const failedHomes: string[] = [];
  const reasons: Record<string, string> = {};
  const homeReasons: Record<string, string> = {};
  const homeApps: Record<string, string> = {};
  const leftovers: DeletionLeftover[] = [];
  const closedHomes: string[] = [];
  const uncheckedHomes: string[] = [];
  const discovery: EngineDiscovery = { ...(job.known ?? {}) };
  const seen = new Set<string>();
  for (const home of job.homes) {
    const key = homeKey(home.engine, home.home);
    if (seen.has(key) || (job.only && !job.only.includes(key))) continue;
    seen.add(key);
    const facts = new Known(job.known?.[key]);
    if (excluded(home.engine, home.home)) {
      failedHomes.push(key);
      if (!failed.includes(home.home)) failed.push(home.home);
      reasons[home.home] = homeReasons[key] = "held";
      continue;
    }
    const pl = new Planner(fs, facts);
    pl.synced = fs.syncedHome?.(home.home) === true;
    if (recovery.unreadable) {
      failedHomes.push(key);
      if (!failed.includes(home.home)) failed.push(home.home);
      reasons[home.home] = homeReasons[key] = recovery.unreadable;
      continue;
    }
    const unfinished = recovery.pending.find((item) => item.engine === home.engine && item.home === home.home);
    if (unfinished) {
      failedHomes.push(key);
      if (!failed.includes(home.home)) failed.push(home.home);
      reasons[home.home] = homeReasons[key] = unfinished.state === "unknown" ? "engine-unchecked" : unfinished.state === "held" ? "held" : "engine-open";
      continue;
    }
    const identities = configured.get(key) ?? [];
    const before = engineState(home.engine, home.home, { identities });
    // An engine that is open (or cannot be told) is not read at all: nothing of its home would be changed now anyway, and a read of
    // its database could make SQLite create, checkpoint or remove the -wal and -shm the engine is using. Its ids stay as they were saved.
    if (before.state !== "closed") {
      failedHomes.push(key);
      if (!failed.includes(home.home)) failed.push(home.home);
      reasons[home.home] = homeReasons[key] = before.state === "unknown" ? "engine-unchecked" : "engine-open";
      console.warn(`engine history: ${home.engine} home not read: ${before.state} by ${before.via}${"unknownBy" in before && before.unknownBy ? ` ${JSON.stringify(before.unknownBy.slice(0, 5))}` : ""}${before.holders?.length ? ` holders ${JSON.stringify(before.holders)}` : ""}`);
      if (before.app) homeApps[key] = before.app;
      continue;
    }
    try {
      planHome(pl, home, job);
    } catch (error) {
      const path = error instanceof PlanError ? error.path : home.home;
      failedHomes.push(key);
      if (!failed.includes(path)) failed.push(path);
      reasons[path] = homeReasons[key] = reasonOf(error);
      continue;
    }
    plans[key] = { engine: home.engine, home: home.home, steps: pl.steps, ...(identities.length ? { identities } : {}), ...(pl.synced ? { synced: true as const } : {}) };
    // closed before and after the plan was made: the plan describes a home no engine was writing
    const after = engineState(home.engine, home.home, { dbs: dbsOfSteps(pl.steps), identities }).state;
    if (after === "closed") closedHomes.push(key);
    else if (after === "unknown") uncheckedHomes.push(key); // "is open" only when it was seen open
    leftovers.push(...pl.leftovers);
    const saved = facts.toJSON();
    if (Object.keys(saved).length) discovery[key] = saved;
  }
  const syncedHomes = Object.entries(plans).filter(([, plan]) => plan.synced).map(([key]) => key);
  return { removed: [], failed, leftovers, discovery, plans, failedHomes, reasons, homeReasons, homeApps, closedHomes, uncheckedHomes, syncedHomes };
}

const dbsOfSteps = (steps: HomePlanData["steps"]): string[] => [...new Set(steps.flatMap((step) => (step.k === "sqlDelete" || step.k === "checkpoint" ? [step.db] : [])))];

/** Folds what an execute run settled into the saved ids: the databases whose checkpoint is verified. An execute run learns no
 * new id (it never discovers; a changed input makes the step stale and the home is planned again). */
export function applyFactsDelta(discovery: EngineDiscovery, delta: NonNullable<EngineHistoryResult["factsDelta"]>): void {
  for (const [key, change] of Object.entries(delta)) {
    const facts = new Known(discovery[key]);
    for (const [name, values] of Object.entries(change.clear)) for (const value of values) facts.get(name).delete(value);
    const saved = facts.toJSON();
    if (Object.keys(saved).length) discovery[key] = saved; else delete discovery[key];
  }
}

/** The whole loop inline: plan every home, execute, plan every home again, up to MAX_ENGINE_ROUNDS executions. A home is done
 * only when a plan made AFTER its last execute has no content step. Nothing carries over from an earlier attempt as proof. With
 * `apply` false it only plans (the result's `discovery` holds the ids a removal needs, `failed` what could not be read). */
export function removeEngineHistoryFiles(homes: DeletionEngineHome[], folders: string[], memoryFolders: string[], sessions: EngineHistoryJob["sessions"], known: EngineDiscovery = {}, apply = true, fs: EngineFs = realEngineFs()): EngineHistoryResult {
  const base = { homes, folders, memoryFolders, sessions };
  if (!apply) return planEngineHistory({ ...base, kind: "plan", known }, fs);
  const keys = [...new Set(homes.map((home) => homeKey(home.engine, home.home)))];
  const removed: string[] = [];
  const failed: string[] = [];
  const leftovers: DeletionLeftover[] = [];
  const reasons: Record<string, string> = {};
  const homeReasons: Record<string, string> = {};
  const homeApps: Record<string, string> = {};
  const discovery: EngineDiscovery = { ...known };
  const done = new Set<string>(), stuck = new Set<string>(), executed = new Set<string>();
  const closed = new Set<string>(), synced = new Set<string>();
  let active: Record<string, HomePlanData> = {};
  for (let round = 0; round <= MAX_ENGINE_ROUNDS; round++) {
    // Every home that is not stuck is planned again each round, so the last plan covers all of them.
    const only = keys.filter((key) => !stuck.has(key));
    active = {};
    done.clear();
    if (only.length) {
      const planned = planEngineHistory({ ...base, kind: "plan", known: discovery, only }, fs);
      Object.assign(discovery, planned.discovery);
      Object.assign(reasons, planned.reasons);
      Object.assign(homeReasons, planned.homeReasons);
      Object.assign(homeApps, planned.homeApps);
      for (const path of planned.failed) if (!failed.includes(path)) failed.push(path);
      leftovers.push(...planned.leftovers);
      for (const key of planned.failedHomes ?? []) stuck.add(key);
      closed.clear();
      for (const key of planned.closedHomes ?? []) closed.add(key);
      for (const key of planned.syncedHomes ?? []) synced.add(key);
      const unchecked = new Set(planned.uncheckedHomes ?? []);
      for (const [key, plan] of Object.entries(planned.plans ?? {})) {
        if (executed.has(key) ? !hasContentSteps(plan) : plan.steps.length === 0) {
          // A home that was changed is finished only when the plan that shows nothing left was made while its engine was closed.
          if (executed.has(key) && !closed.has(key)) { stuck.add(key); homeReasons[key] ??= unchecked.has(key) ? "engine-unchecked" : "engine-open"; } else done.add(key);
        } else active[key] = plan;
      }
    }
    if (round === MAX_ENGINE_ROUNDS || !Object.keys(active).length) break;
    const ran = executeEnginePlans(active);
    removed.push(...ran.removed);
    Object.assign(homeApps, ran.homeApps);
    for (const path of ran.failed) if (!failed.includes(path)) failed.push(path);
    Object.assign(reasons, ran.reasons);
    Object.assign(homeReasons, ran.homeReasons);
    applyFactsDelta(discovery, ran.factsDelta);
    for (const key of Object.keys(active)) {
      executed.add(key);
      if (ran.failedHomes.includes(key)) stuck.add(key);
    }
  }
  // A home that still has content to remove after the last round is not done, and says so with its folder.
  const failedHomes: string[] = [];
  for (const home of homes) {
    const key = homeKey(home.engine, home.home);
    if (!stuck.has(key) && !done.has(key)) homeReasons[key] ??= "changed";
    if (stuck.has(key) || !done.has(key)) { if (!failedHomes.includes(key)) failedHomes.push(key); if (!failed.includes(home.home)) failed.push(home.home); }
  }
  return { removed, failed, leftovers, discovery, reasons, homeReasons, homeApps, failedHomes, syncedHomes: [...synced] };
}

/** One engine-history job, as the worker runs it. `onStep` hears each plan step as it finishes. */
export function runEngineHistoryJob(job: EngineHistoryJob, onStep?: (key: string, index: number) => void): EngineHistoryResult {
  configureRedo(job.redoDir);
  configureScopes(job.nativeDir);
  if (job.kind === "recover") {
    const configured: Record<string, string[]> = {};
    for (const home of job.homes) if (home.identities?.length) configured[homeKey(home.engine, home.home)] = home.identities;
    // Before any hold (the start-up pass): a journal of a home inside an engine's scope folder is finished only by an attempt, after
    // Murage's own engine processes on it are held and while the scope is in that attempt's `only`.
    const allow = job.skipScopes ? (key: string) => { const [engine = "", home = ""] = key.split("\0"); return !inScopeFolder(engine, home); } : undefined;
    // and the empty private lock folders a killed Murage left next to Claude Code's history (never Claude's own lock)
    const done = recoverAll(configured, job.homes.filter((item) => item.engine === "claude").map((item) => pathApiFor(item.home).join(item.home, "history.jsonl")), allow);
    return { removed: [], failed: done.pending.map((item) => item.home), leftovers: [], failedHomes: done.pending.map((item) => homeKey(item.engine as DeletionEngineHome["engine"], item.home)) };
  }
  if (job.kind === "plan") return planEngineHistory(job);
  if (job.kind === "execute") {
    const ran = executeEnginePlans(job.plans ?? {}, onStep);
    return { removed: ran.removed, failed: ran.failed, leftovers: [], failedHomes: ran.failedHomes, staleHomes: ran.staleHomes, reasons: ran.reasons, homeReasons: ran.homeReasons, homeApps: ran.homeApps, factsDelta: ran.factsDelta };
  }
  return removeEngineHistoryFiles(job.homes, job.folders, job.memoryFolders, job.sessions, job.known ?? {}, true);
}
