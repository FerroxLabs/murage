import { isUnseenRoutineProblem } from "../../shared/routine-problems";

/** History survives deletion; attention only belongs to work still present. */
export function hasRoutineAttention(
  runs: readonly { status: string; seenAt?: number | null; routineId: string; botId: string; groupId?: string }[],
  routines: readonly { id: string }[],
  bots: readonly { id: string }[],
  groups: readonly { id: string }[],
): boolean {
  const routineIds = new Set(routines.map((row) => row.id));
  const botIds = new Set(bots.map((row) => row.id));
  const groupIds = new Set(groups.map((row) => row.id));
  return runs.some((run) => isUnseenRoutineProblem(run) && routineIds.has(run.routineId)
    && botIds.has(run.botId) && (!run.groupId || groupIds.has(run.groupId)));
}
