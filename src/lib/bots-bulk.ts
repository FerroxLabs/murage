// Settings v10 A9-bots (roster): what the Bots page does with several bots. Bulk level goes through the shipped
// per-bot helpers (level-change.ts), one review and one save per bot; Move all to No limits draws its list from core's
// plan (shared/settings-v10/no-limits-plan.ts, C2) and commits only the set the owner reviewed.
import { levelName } from "@/lib/fold-words";
import { changeDirect, confirmRaise, levelAcks, previewLevel, type LevelAcks, type LevelDeps, type LevelPreview } from "@/lib/level-change";
import { permissionModeOf, type PermissionMode } from "@/lib/permission-mode";
import type { NoLimitsLevel, NoLimitsMoveResult, NoLimitsPlan } from "../../shared/settings-v10/no-limits-plan";

export const NO_LIMITS_PATH = "/api/permissions/no-limits";

type Api = (path: string, init?: RequestInit) => Promise<any>;

export interface MoveAllView {
  activeBots: number;
  archivedBots: number;
  routines: Array<{ id: string; text: string; withdrawn: boolean }>;
  chats: Array<{ id: string; text: string; guest: boolean }>;
}

/** Every row of the plan, one line each: name, bot and the level the row loses. Nothing is summed away. */
export function moveAllReview(plan: NoLimitsPlan): MoveAllView {
  const botName = (id: string) => plan.bots.find((bot) => bot.id === id)?.name ?? id;
  const line = (name: string, botId: string, level: NoLimitsLevel) => `${name} (${botName(botId)}), at ${levelName(level)}`;
  return {
    activeBots: plan.bots.filter((bot) => !bot.archived).length,
    archivedBots: plan.bots.filter((bot) => bot.archived).length,
    routines: plan.routines.map((r) => ({ id: r.id, text: line(r.name, r.botId, r.levelCleared), withdrawn: r.pendingApprovalWithdrawn })),
    chats: plan.chats.map((c) => ({ id: c.id, text: line(c.name, c.botId, c.levelCleared), guest: c.guest })),
  };
}

export type MoveAllOutcome =
  | { kind: "moved"; plan: NoLimitsPlan }
  /** The reviewed list no longer matches: nothing moved, here is the list now. */
  | { kind: "changed"; plan: NoLimitsPlan }
  | { kind: "notMoved"; plan?: NoLimitsPlan; message?: string }
  | { kind: "pending" };

export async function fetchMoveAllPlan(api: Api): Promise<NoLimitsPlan> {
  return (await api(`${NO_LIMITS_PATH}/plan`)) as NoLimitsPlan;
}

/** Commit the reviewed set. Anything that is not an explicit Moved is never shown as Moved. */
export async function commitMoveAll(api: Api, plan: NoLimitsPlan): Promise<MoveAllOutcome> {
  try {
    const answer = (await api(NO_LIMITS_PATH, { method: "POST", body: JSON.stringify({ reviewedSetId: plan.digest }) })) as NoLimitsMoveResult;
    if (answer?.result === "moved") return { kind: "moved", plan: answer.plan };
    if (answer?.result === "pending") return { kind: "pending" };
    if (answer?.result === "notMoved") return { kind: "notMoved", plan: answer.plan, ...(answer.error ? { message: answer.error } : {}) };
    return { kind: "notMoved", message: "Murage could not confirm the move." };
  } catch (cause) {
    const failure = cause as { status?: number; body?: { error?: string; plan?: NoLimitsPlan } };
    if (failure.status === 409 && failure.body?.error === "PLAN_CHANGED" && failure.body.plan) return { kind: "changed", plan: failure.body.plan };
    // Only a refusal the server sent (4xx) is a sure "nothing moved". A lost reply, a reconnect (503) or a timeout may follow a commit: Pending.
    if (typeof failure.status === "number" && failure.status >= 400 && failure.status < 500) return { kind: "notMoved", message: cause instanceof Error ? cause.message : String(cause) };
    return { kind: "pending" };
  }
}

export interface BulkLevelInput { bot: Parameters<typeof permissionModeOf>[0] & { id: string; name: string; fullAccessAcknowledgedAt?: number; noLimitsAcknowledgedAt?: number }; drivesComputer: boolean }
export interface BulkLevelReview { botId: string; name: string; previous: PermissionMode; acks: LevelAcks; /** null at Ask, which saves without a preview */ preview: LevelPreview | null }
export type BulkLevelState = "saved" | "unchanged" | "changed" | "failed";
export interface BulkLevelResult { botId: string; name: string; state: BulkLevelState; message?: string }

/** One preview per bot that is being raised, each with its own acknowledgements. Ask needs none. */
export async function reviewBulkLevel(deps: LevelDeps, inputs: BulkLevelInput[], target: PermissionMode): Promise<BulkLevelReview[]> {
  const out: BulkLevelReview[] = [];
  for (const { bot, drivesComputer } of inputs) {
    const previous = permissionModeOf(bot);
    out.push({ botId: bot.id, name: bot.name, previous, acks: levelAcks(bot, previous, target, drivesComputer), preview: target === "ask" || previous === target ? null : await previewLevel(deps, bot.id, target) });
  }
  return out;
}

/** Save each bot by itself with its own review. A bot that moved since the review is not saved: it reads "changed". */
export async function applyBulkLevel(deps: LevelDeps, reviews: BulkLevelReview[], target: PermissionMode, desktop: boolean): Promise<BulkLevelResult[]> {
  const out: BulkLevelResult[] = [];
  for (const review of reviews) {
    const base = { botId: review.botId, name: review.name };
    if (review.previous === target) { out.push({ ...base, state: "unchanged" }); continue; }
    if (review.preview) {
      const raised = await confirmRaise(deps, { botId: review.botId, target, preview: review.preview, acks: review.acks, conversations: false });
      out.push(raised.kind === "saved" || raised.kind === "apply-refused" ? { ...base, state: "saved" } : raised.kind === "stale" ? { ...base, state: "changed" } : { ...base, state: "failed", message: raised.message });
      continue;
    }
    const direct = await changeDirect(deps, { botId: review.botId, target, previous: review.previous, acks: review.acks, desktop });
    out.push(direct.kind === "saved" ? { ...base, state: "saved" } : { ...base, state: "failed", message: direct.message });
  }
  return out;
}
