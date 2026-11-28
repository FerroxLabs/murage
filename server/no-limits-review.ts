// G1 (v7-v10) Move all plan, digest and recovery (C2).
// Owner: lane core (Settings v10 BUILD-PLAN §3). The plan names every record "Move all" would clear: all bots (archived too),
// routines and chats. The owner reviews that exact set; the POST carries its digest as reviewedSetId and a digest that no longer
// matches changes nothing and answers 409 with the new plan. The move is routines first, then the roster (the roster write is the
// commit point). An intent record with the reviewed digest is written before either store changes and removed after, so a restart
// finishes a move that stopped between the two stores instead of leaving one of them moved.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { NoLimitsLevel, NoLimitsPlan, NoLimitsMoveResult } from "../shared/settings-v10/no-limits-plan.ts";
import { writeFileAtomic } from "./atomic.ts";
import { explicitPermission, routineFollowsNoLimits } from "./permission-inheritance.ts";
import { botPermissionMode } from "./routine-permissions.ts";
import { refusalBody } from "./settings/refusal-refs.ts";
import type { SettingsV10Router } from "./settings/v10-router.ts";

interface PlanBot { id: string; name: string; hidden?: boolean; staged?: unknown; draftOnly?: true; autoApprove?: boolean; fullAccess?: boolean; noLimits?: boolean; permissionExplicit?: boolean; permissionRev?: number; tasks?: PlanTask[] }
interface PlanTask { threadId: string; title?: string; autoApprove?: boolean; fullAccess?: boolean; noLimits?: boolean; permissionExplicit?: boolean; permissionRev?: number }
interface PlanRoutine { id: string; name: string; botId: string; permissionMode?: NoLimitsLevel; permissionExplicit?: boolean; permissionPending?: true }
export interface NoLimitsPlanSource {
  bots(): PlanBot[];
  routines(): PlanRoutine[];
  /** True when the thread belongs to the owner (a guest chat is listed but never cleared into No limits). */
  ownerChat(threadId: string): boolean;
}

const INTENT_FILE = "no-limits-move.json";
export const noLimitsIntentFile = (dataDir: string): string => join(dataDir, INTENT_FILE);

/** The records Move all would clear, from the same predicates the status line and the inheritance writes use. */
export function buildNoLimitsPlan(source: NoLimitsPlanSource): NoLimitsPlan {
  const bots: NoLimitsPlan["bots"] = [];
  const chats: NoLimitsPlan["chats"] = [];
  const routines: NoLimitsPlan["routines"] = [];
  const all = source.bots().filter((bot) => bot.staged === undefined);
  for (const bot of all) {
    const level = botPermissionMode(bot);
    if (!bot.draftOnly && explicitPermission(bot) && level !== "unlimited") bots.push({ id: bot.id, name: bot.name, archived: bot.hidden === true, levelCleared: level });
    for (const task of bot.tasks ?? []) {
      const taskLevel = botPermissionMode(task);
      if (explicitPermission(task) && taskLevel !== "unlimited") chats.push({ id: task.threadId, name: task.title || bot.name, botId: bot.id, levelCleared: taskLevel, guest: !source.ownerChat(task.threadId) });
    }
  }
  for (const routine of source.routines()) {
    if (routineFollowsNoLimits(routine) && !routine.permissionPending) continue;
    const level = routine.permissionMode ?? "ask";
    if (level === "unlimited" && !routine.permissionPending) continue;
    routines.push({ id: routine.id, name: routine.name, botId: routine.botId, levelCleared: level, pendingApprovalWithdrawn: routine.permissionPending === true });
  }
  const sorted = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
  const plan = { bots: sorted(bots), routines: sorted(routines), chats: sorted(chats) };
  return { digest: createHash("sha256").update(JSON.stringify(plan)).digest("hex"), ...plan };
}

export interface NoLimitsMoveDeps {
  dataDir: string;
  source: NoLimitsPlanSource;
  /** routines.inheritAllPermissions: committed before the roster. */
  clearRoutines(): void;
  /** store.inheritAllPermissions: the commit point. */
  clearRoster(): void;
  /** Puts a routine back to the level the owner had set (rolls back a clear whose roster write never happened). */
  restoreRoutine(row: NoLimitsPlan["routines"][number]): void;
}
interface Intent { digest: string; plan: NoLimitsPlan; startedAt: number }
const ids = (rows: Array<{ id: string }>): Set<string> => new Set(rows.map((row) => row.id));
/** Was the commit point written? Roster-bearing plans: every reviewed bot and chat is gone from the live lower set. Routines-only plans: every reviewed routine is. */
function committed(plan: NoLimitsPlan, now: NoLimitsPlan): boolean {
  const still = (reviewed: Array<{ id: string }>, live: Array<{ id: string }>) => { const left = ids(live); return reviewed.some((row) => left.has(row.id)); };
  if (plan.bots.length || plan.chats.length) return !still(plan.bots, now.bots) && !still(plan.chats, now.chats);
  return !still(plan.routines, now.routines);
}
/** Put back the routines a move that never reached its commit point already cleared. */
function rollBack(deps: NoLimitsMoveDeps, plan: NoLimitsPlan): void {
  const lower = ids(buildNoLimitsPlan(deps.source).routines);
  for (const row of plan.routines) if (!lower.has(row.id)) deps.restoreRoutine(row);
}

export type MoveAnswer = { status: 200; body: NoLimitsMoveResult } | { status: 409; body: Record<string, unknown> };

/** Move all for a reviewed set. A changed set is a 409 with the new plan and nothing written. */
export function moveAllNoLimits(deps: NoLimitsMoveDeps, reviewedSetId: unknown, now: () => number = Date.now): MoveAnswer {
  const plan = buildNoLimitsPlan(deps.source);
  if (typeof reviewedSetId !== "string" || reviewedSetId !== plan.digest) {
    return { status: 409, body: refusalBody("PLAN_CHANGED", "The list changed after you reviewed it. Review it again.", {}, { plan }) };
  }
  writeFileAtomic(noLimitsIntentFile(deps.dataDir), JSON.stringify({ digest: plan.digest, plan, startedAt: now() } satisfies Intent));
  try {
    deps.clearRoutines();
    deps.clearRoster();
  } catch (error) {
    // The commit point is the roster write (routines for a routines-only plan): read the stores, not the error
    const after = buildNoLimitsPlan(deps.source);
    if (committed(plan, after)) { rmSync(noLimitsIntentFile(deps.dataDir), { force: true }); return { status: 200, body: { result: "moved", plan: after } }; }
    rollBack(deps, plan);
    rmSync(noLimitsIntentFile(deps.dataDir), { force: true });
    return { status: 200, body: { result: "notMoved", plan: buildNoLimitsPlan(deps.source), error: error instanceof Error ? error.message : "Move all did not finish." } };
  }
  rmSync(noLimitsIntentFile(deps.dataDir), { force: true });
  return { status: 200, body: { result: "moved", plan: buildNoLimitsPlan(deps.source) } };
}

/** At startup: an intent left behind means a move stopped. It is never finished here (the owner approved a moment in time): the
 * stores decide. Commit point written: the intent is dropped. Commit point not written: routines the move already cleared are put
 * back and the intent is dropped, so the owner reviews and moves again. Returns what it did. */
export function recoverNoLimitsMove(deps: NoLimitsMoveDeps): "none" | "already-committed" | "rolled-back" {
  const file = noLimitsIntentFile(deps.dataDir);
  if (!existsSync(file)) return "none";
  let intent: Intent | null = null;
  try { intent = JSON.parse(readFileSync(file, "utf8")) as Intent; } catch { /* a torn record has no plan to roll back */ }
  rmSync(file, { force: true });
  if (!intent || !intent.plan || !Array.isArray(intent.plan.routines)) return "rolled-back";
  if (committed(intent.plan, buildNoLimitsPlan(deps.source))) return "already-committed";
  rollBack(deps, intent.plan);
  return "rolled-back";
}

/** GET /api/permissions/no-limits/plan: the set Move all would clear, with its digest. The reviewed POST is the existing
 * POST /api/permissions/no-limits (index.ts), which calls moveAllNoLimits when the body carries reviewedSetId. */
export function registerNoLimitsReviewRoutes(router: SettingsV10Router, deps: { move?: () => NoLimitsMoveDeps | null }): void {
  router.add("core", ({ method, path, res, json, surface }) => {
    if (path !== "/api/permissions/no-limits/plan") return false;
    if (surface !== "desktop") { json(res, 404, { error: "not found" }); return true; }
    const move = deps.move?.();
    if (!move) { json(res, 503, { error: "Move all is not ready yet." }); return true; }
    if (method !== "GET") { json(res, 405, { error: "method not allowed" }); return true; }
    json(res, 200, buildNoLimitsPlan(move.source));
    return true;
  });
}
