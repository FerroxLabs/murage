import { CheckCheck, CircleAlert, X } from "lucide-react";
import { isUnseenRoutineProblem } from "../../../shared/routine-problems";
import type { RoutineRun } from "@/lib/routines";
import type { Bot } from "@/state/store";

/** The unseen failed and missed runs, newest first. The problems pill counts
 * exactly these, so opening the list shows every run behind the number. */
export function unseenRoutineProblems(runs: readonly RoutineRun[]): RoutineRun[] {
  return runs.filter(isUnseenRoutineProblem).sort((a, b) => (b.finishedAt ?? b.scheduledFor) - (a.finishedAt ?? a.scheduledFor));
}

const when = (at: number) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The problems filter behind the Routines pill (upstream #1629). The pill
 * used to be a bare count: failures scattered across past weeks could only
 * be cleared by finding each one on the calendar and opening it. */
export function RoutineProblemsList({ runs, bots, onClose, onOpen, onMarkAllSeen }: {
  runs: readonly RoutineRun[];
  bots: readonly Bot[];
  onClose: () => void;
  onOpen: (run: RoutineRun) => void;
  onMarkAllSeen: () => void;
}) {
  const problems = unseenRoutineProblems(runs);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Routine problems" className="w-full max-w-[520px] rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-hairline/40 px-5 py-4">
          <div className="min-w-0"><div className="text-[16px] font-semibold text-ink">Routine problems</div><div className="mt-0.5 text-[11.5px] text-ink-secondary">Failed and missed runs you have not opened yet.</div></div>
          <div className="flex shrink-0 items-center gap-1">
            {problems.length > 0 && <button type="button" onClick={onMarkAllSeen} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-ink-secondary hover:bg-raised hover:text-ink"><CheckCheck size={12} />Mark all as read</button>}
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-2 text-ink-secondary hover:bg-raised"><X size={17} /></button>
          </div>
        </div>
        <div className="max-h-[55vh] space-y-1 overflow-y-auto p-3">
          {problems.length === 0 && <p className="px-3 py-2 text-[12px] text-ink-secondary">Nothing needs a look.</p>}
          {problems.map((run) => {
            const bot = bots.find((candidate) => candidate.id === run.botId);
            return (
              <button key={run.id} type="button" onClick={() => onOpen(run)} aria-label={`Open ${run.routineName} run`} className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-raised/60">
                <CircleAlert size={15} className="mt-0.5 shrink-0 text-danger" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-ink">{run.routineName}</span>
                  <span className="mt-0.5 block truncate text-[10.5px] text-ink-secondary">{run.status === "missed" ? "Missed" : "Failed"} · {when(run.finishedAt ?? run.scheduledFor)}{bot ? ` · ${bot.name}` : ""}</span>
                  {run.error && <span className="mt-0.5 block truncate text-[10.5px] text-danger">{run.error}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
