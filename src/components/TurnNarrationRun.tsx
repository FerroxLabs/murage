// A settled turn's finished tool steps behind one "Worked for" row. The bot's
// own progress lines stay in the transcript above the answer (E34); only the
// work folds, and opens again with one click.
import { useEffect, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { HelperRows } from "@/components/HelpersLine";
import type { Subtask } from "@/lib/subtasks";

export function TurnNarrationRun({
  label,
  title,
  forceOpen = false,
  helpers,
  children,
}: {
  label: string;
  /** hover text: the raw tool names the row holds */
  title?: string;
  forceOpen?: boolean;
  /** the turn's helpers: what each one did, shown when the summary opens */
  helpers?: Subtask[];
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-start">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          data-run-toggle
          title={title}
          className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Check size={13} className="text-success" />
          <span>{label}</span>
          <ChevronRight size={13} className={open ? "rotate-90" : undefined} />
        </button>
      </div>
      {open && helpers?.length ? <HelperRows helpers={helpers} /> : null}
      {open && children}
    </div>
  );
}
