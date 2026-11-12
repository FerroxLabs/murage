// FIRSTRUN-1019 D2: "Setting up 2 more: X, Y", with a Stop on each. Mounted in Today's first-run branch and in the
// normal Calm and Detailed views alike (it is also where the queue runs from while Today is on screen).

import { FIRST_RUN_COPY, settingUpMoreLine } from "@/lib/first-run-copy";
import { jobTitle } from "@/lib/first-run-pending";
import { usePendingJobs } from "./use-pending-jobs";

export function PendingJobsLine() {
  const { ids, failed, stop, retry } = usePendingJobs();
  if (ids.length === 0) return null;
  const copy = FIRST_RUN_COPY.chat.jobs;
  const running = ids.filter((id) => !failed.has(id));
  return (
    <div data-today="pending-jobs" className="mt-5 rounded-2xl bg-card px-4 py-3 text-[14px] text-ink">
      {running.length > 0 && <p role="status">{settingUpMoreLine(running.map(jobTitle))}</p>}
      <ul className="mt-1 grid gap-1">
        {ids.map((id) => (
          <li key={id} className="flex flex-wrap items-center gap-2 text-[13px] text-ink-secondary">
            <span>{jobTitle(id)}{failed.has(id) ? ` ${copy.failed}` : ""}</span>
            {failed.has(id) && (
              <button type="button" className="min-h-8 px-1 text-accent hover:underline" onClick={() => retry(id)}>{copy.tryAgain}</button>
            )}
            <button type="button" aria-label={`${copy.stop} ${jobTitle(id)}`} className="min-h-8 px-1 text-ink-secondary hover:text-ink" onClick={() => void stop(id)}>{copy.stop}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
