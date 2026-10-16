import { useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";
import { t } from "@/lib/i18n";

export const SCHEDULER_CHECK_MS = 30_000;

/** Checks the scheduler now and then every `everyMs`. A failed check keeps what is shown; returns the stop function. */
export function watchRoutineScheduler(load: () => Promise<boolean>, onChange: (late: boolean) => void, everyMs = SCHEDULER_CHECK_MS): () => void {
  let live = true;
  const check = async () => {
    try {
      const late = await load();
      if (live) onChange(late);
    } catch { /* keep what is shown until the next check */ }
  };
  void check();
  const timer = setInterval(() => { void check(); }, everyMs);
  return () => { live = false; clearInterval(timer); };
}

export function useRoutineSchedulerLate(load: () => Promise<boolean>): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => watchRoutineScheduler(load, setLate), [load]);
  return late;
}

/** Shown beside the problems indicator while the scheduler is behind. */
export function RoutineSchedulerNotice({ late }: { late: boolean }) {
  if (!late) return null;
  return <span role="status" data-testid="routine-scheduler-late" title={t("routines.schedulerLate.detail")} className="flex items-center gap-1.5 rounded-full bg-warning/10 px-2.5 py-1.5 text-[10.5px] text-warning"><CircleAlert size={11} />{t("routines.schedulerLate")}</span>;
}
