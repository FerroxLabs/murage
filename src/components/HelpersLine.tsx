// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// A bot's helpers (sub agents), on any engine. Live: one quiet line under the
// working indicator ("3 helpers working") that opens an inline list. Settled:
// the same rows inside the turn's "Worked for" summary. No modal, nothing
// added to the conversation text.
import { useId, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { WorkingTimer } from "@/components/WorkingIndicator";
import { elapsedText, helperLine, isWorking, statusLabel, toolsText, type Subtask } from "@/lib/subtasks";

/** The rows. While a helper works its time ticks on its own; a finished one
 * shows how long it took and how many tools it used. */
export function HelperRows({ helpers, id }: { helpers: Subtask[]; id?: string }) {
  return (
    <ul id={id} aria-label={t("helpers.list.aria")} data-testid="helper-rows" className="m-0 flex list-none flex-col gap-1 p-0 pl-1">
      {helpers.map((row) => (
        <li key={row.id} data-testid="helper-row" data-status={isWorking(row) ? "working" : row.status} className="flex min-w-0 items-baseline gap-2 text-[12.5px] text-ink-secondary">
          <span className={cn("min-w-0 flex-1 truncate", row.status === "failed" && "text-danger")} title={row.label}>{row.label}</span>
          <span className="shrink-0">{statusLabel(row)}</span>
          <span className="shrink-0 tabular-nums">
            {isWorking(row) ? <WorkingTimer since={row.startedAt} /> : elapsedText(row)}
          </span>
          {!isWorking(row) && <span className="shrink-0">{toolsText(row)}</span>}
        </li>
      ))}
    </ul>
  );
}

/** While the turn runs. Renders nothing without helpers. */
export function HelpersLine({ helpers, defaultOpen = false }: { helpers: Subtask[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();
  if (helpers.length === 0) return null;
  const line = helperLine(helpers);
  return (
    <div data-testid="helpers-line" className="flex flex-col items-start gap-1 pl-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12.5px] text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ChevronRight size={12} className={open ? "rotate-90" : undefined} aria-hidden="true" />
        <span>{line}</span>
      </button>
      {/* Spoken when the line changes (a helper starts or finishes), never on a timer tick. */}
      <span role="status" aria-live="polite" className="sr-only">{line}</span>
      {open && <HelperRows helpers={helpers} id={listId} />}
    </div>
  );
}

/** A settled turn with helpers but no narration to fold: the same "Worked for"
 * pill, opening onto the rows. */
export function HelpersSummary({ label, helpers, defaultOpen = false }: { label: string; helpers: Subtask[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();
  return (
    <div data-testid="helpers-summary" className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        data-run-toggle
        className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Check size={13} className="text-success" aria-hidden="true" />
        <span>{label}</span>
        <ChevronRight size={13} className={open ? "rotate-90" : undefined} aria-hidden="true" />
      </button>
      {open && <HelperRows helpers={helpers} id={listId} />}
    </div>
  );
}
