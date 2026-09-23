// A routine run that went wrong and still wants the owner's attention. One
// home so the sidebar dot, the Routines problems pill, its list and the
// server's mark-all-seen sweep count the same runs (upstream #1629).
export const ROUTINE_PROBLEM_STATUSES = ["failed", "missed"] as const;

export function isRoutineProblemRun(run: { status: string }): boolean {
  return (ROUTINE_PROBLEM_STATUSES as readonly string[]).includes(run.status);
}

/** A problem the owner has not opened or marked seen yet. */
export function isUnseenRoutineProblem(run: { status: string; seenAt?: number | null }): boolean {
  return !run.seenAt && isRoutineProblemRun(run);
}
