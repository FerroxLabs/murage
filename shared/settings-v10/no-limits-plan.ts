// C2 · owner: core G1 (producer, buildNoLimitsPlan) → roster A9-bots (consumer, Move all review).
// Same vocabulary as src/lib/permission-mode.ts PermissionMode.
export type NoLimitsLevel = "ask" | "auto" | "full" | "unlimited";
export interface NoLimitsPlanBot { id: string; name: string; archived: boolean; levelCleared: NoLimitsLevel | null }
export interface NoLimitsPlanRoutine { id: string; name: string; botId: string; levelCleared: NoLimitsLevel; pendingApprovalWithdrawn: boolean }
export interface NoLimitsPlanChat { id: string; name: string; botId: string; levelCleared: NoLimitsLevel; guest: boolean }
export interface NoLimitsPlan { digest: string; bots: NoLimitsPlanBot[]; routines: NoLimitsPlanRoutine[]; chats: NoLimitsPlanChat[] }
/** POST /api/permissions/no-limits body for Move all. */
export interface NoLimitsMoveRequest { reviewedSetId: string }
export type NoLimitsMoveResult =
  | { result: "moved"; plan: NoLimitsPlan }
  | { result: "notMoved"; plan: NoLimitsPlan; error?: string }
  | { result: "pending" };
/** 409 body when the reviewed digest no longer matches: carries the new plan. */
export interface NoLimitsConflict { error: "PLAN_CHANGED"; plan: NoLimitsPlan }
