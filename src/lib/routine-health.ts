import type { Routine } from "./routines";

/** What a routine's own history says about it (upstream #1564): how many
 * settled runs in a row failed, and how many scheduled occurrences were
 * skipped because a run was still going. Empty when there is nothing to say. */
export function routineHealthNotes(routine: Pick<Routine, "failureStreak" | "skippedRuns" | "lastSkippedAt">): Array<{ tone: "danger" | "muted"; text: string }> {
  const notes: Array<{ tone: "danger" | "muted"; text: string }> = [];
  const streak = routine.failureStreak ?? 0;
  if (streak > 0) notes.push({ tone: "danger", text: streak === 1 ? "The last run failed." : `The last ${streak} runs failed.` });
  const skipped = routine.skippedRuns ?? 0;
  if (skipped > 0) {
    const last = routine.lastSkippedAt == null
      ? ""
      : `, most recently ${new Date(routine.lastSkippedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
    notes.push({ tone: "muted", text: `Skipped ${skipped} scheduled ${skipped === 1 ? "time" : "times"} because a run was still going${last}.` });
  }
  return notes;
}

/** Editor help for the overlap choice. */
export function routineOverlapHelp(overlap: "skip" | "queue"): string {
  return overlap === "queue"
    ? "One scheduled run waits until the current run finishes. Later times are skipped until it starts. Run now is separate."
    : "Scheduled times are skipped while a run is still going. Run now is separate.";
}
