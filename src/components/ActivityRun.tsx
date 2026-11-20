// A folded stretch of tool chips: one row saying what ran, click to open.
//
// Collapsed by default. A search hit inside a run opens it, and a run stays
// open once the user has opened it. Failed steps never enter a folded run.
import { useEffect, useState } from "react";
import { ChevronRight, Check } from "lucide-react";
import type { Message } from "@/state/store";
import { describeInterimSteps, describeRun, describeRunRaw } from "@/lib/activity-runs";

export function ActivityRun({
  messages,
  forceOpen = false,
  children,
}: {
  messages: Message[];
  /** landing on a step inside this run — a search hit cannot scroll to a
   * row that a fold has kept out of the DOM */
  forceOpen?: boolean;
  /** the individual chips, rendered by whichever transcript owns them */
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  if (open) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex justify-start">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-expanded
            data-run-toggle
            title={describeRunRaw(messages)}
            className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control"
          >
            <ChevronRight size={13} className="rotate-90" />
            <span>{describeRun(messages)}</span>
          </button>
        </div>
        {children}
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        title={describeRunRaw(messages)}
        className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control"
      >
        <Check size={13} className="text-success" />
        <span className="max-w-[480px] truncate">{describeRun(messages)}</span>
        <ChevronRight size={13} />
      </button>
    </div>
  );
}

/** 1020: the steps a bot ran between two things it said in one turn ("Let me verify." -> searched the web ->
 * the answer), as one quiet line so the texts read as one reply. Shown with Tool calls off too; the raw names
 * are one pointer away. */
export function InterimStepsRow({ messages }: { messages: Message[] }) {
  const failed = messages.some((message) => message.tool?.ok === false);
  return (
    <div className="flex justify-start">
      <div
        role="status"
        data-testid="interim-steps-row"
        title={describeRunRaw(messages)}
        className="flex min-w-0 max-w-full items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary"
      >
        {!failed && <Check size={12} aria-hidden="true" className="shrink-0 text-success" />}
        <span className="block truncate first-letter:uppercase">{describeInterimSteps(messages)}</span>
      </div>
    </div>
  );
}
