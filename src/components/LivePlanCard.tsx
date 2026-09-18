// The agent's task list for the running turn, as a checklist that updates in
// place. Each plan update from the engine replaces the whole list (ACP
// `plan`), so this renders exactly what it is given and keeps no history.
import { useState } from "react";
import { CheckCircle2, ChevronRight, Circle, ListChecks, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import type { AgentPlanEntry, AgentPlanStatus } from "../../shared/agent-plan";

const STATUS_LABEL: Record<AgentPlanStatus, string> = {
  pending: "Not started",
  in_progress: "In progress",
  completed: "Done",
};

function StatusMark({ status }: { status: AgentPlanStatus }) {
  const className = "mt-[3px] size-3.5 shrink-0";
  if (status === "completed") return <CheckCircle2 aria-hidden="true" className={cn(className, "text-success")} />;
  if (status === "in_progress") return <Loader2 aria-hidden="true" className={cn(className, "animate-spin text-accent")} />;
  return <Circle aria-hidden="true" className={cn(className, "text-ink-secondary/60")} />;
}

/** "2 of 5 done" — the header's one-line read of the list. */
export function planProgressLabel(entries: readonly AgentPlanEntry[]): string {
  const done = entries.filter((entry) => entry.status === "completed").length;
  return `${done} of ${entries.length} done`;
}

export function LivePlanCard({ entries }: { entries: readonly AgentPlanEntry[] }) {
  const [open, setOpen] = useState(true);
  if (entries.length === 0) return null;
  return (
    <div className="flex justify-start">
      <section
        data-testid="live-plan"
        aria-label="Plan"
        className="w-full min-w-0 max-w-[min(42rem,78%)] max-md:max-w-full rounded-2xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px]"
      >
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title={open ? "Hide plan" : "Show plan"}
          className="flex w-full items-center gap-2 py-0.5 text-left text-ink-secondary hover:text-ink"
        >
          <ListChecks size={13} className="shrink-0" />
          <span className="font-medium text-ink">Plan</span>
          <span data-testid="live-plan-progress">{planProgressLabel(entries)}</span>
          <ChevronRight size={13} className={cn("ml-auto shrink-0", open && "rotate-90")} />
        </button>
        {open ? (
          <ul className="mb-1 mt-1 flex flex-col gap-1">
            {entries.map((entry, index) => (
              <li key={index} data-status={entry.status} className="flex min-w-0 items-start gap-2">
                <StatusMark status={entry.status} />
                <span className="sr-only">{STATUS_LABEL[entry.status]}: </span>
                <span
                  className={cn(
                    "min-w-0 break-words leading-snug",
                    entry.status === "completed" && "text-ink-secondary line-through decoration-ink-secondary/50",
                    entry.status === "in_progress" && "text-ink",
                    entry.status === "pending" && "text-ink-secondary",
                  )}
                >
                  {entry.content}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
