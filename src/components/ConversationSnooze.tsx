// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Snooze a conversation, see that it is snoozed, and see that a question is
// waiting in it. Rules in src/lib/thread-snooze.ts and shared/thread-snooze.ts.
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BellOff, CalendarClock, MessageCircleQuestion } from "lucide-react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { changeThreadSnooze } from "@/lib/thread-attention";
import {
  SNOOZE_MAX_MS, formatSnoozedUntil, pickedTimeToEpoch, pickedTimeValue, questionBadgeLabel, snoozePresets, type SnoozeClock,
} from "@/lib/thread-snooze";

/** A question is waiting on the owner here. Not amber: amber means "waiting
 *  on you" of any kind, and this names which kind, so a question does not
 *  hide among approvals. `labelled` puts the words on the badge itself; a row
 *  whose accessible name already says it passes false. */
export function QuestionBadge({ count, labelled = true, className }: { count: number; labelled?: boolean; className?: string }) {
  if (count <= 0) return null;
  const label = questionBadgeLabel(count);
  return (
    <span
      data-question-badge={count}
      title={label}
      {...(labelled ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full border border-accent/50 bg-accent/10 px-1 text-[10px] font-semibold leading-4 text-ink",
        className,
      )}
    >
      <MessageCircleQuestion size={11} aria-hidden="true" className="text-accent" />
      <span className="tabular-nums">{count}</span>
    </span>
  );
}

/** The small "this is snoozed" mark. Icon only in a sidebar row, whose own
 *  accessible name already says "Snoozed until ...", so there it is
 *  decoration with a tooltip; spelled out everywhere else. */
export function SnoozedMarker({ until, now = Date.now(), clock, iconOnly = false }: { until: number; now?: number; clock?: SnoozeClock; iconOnly?: boolean }) {
  const text = formatSnoozedUntil(until, now, clock);
  return (
    <span data-snoozed-until={until} title={text} aria-hidden={iconOnly ? true : undefined} className="inline-flex min-w-0 items-center gap-1 text-ink-secondary">
      <BellOff size={11} aria-hidden="true" className="shrink-0" />
      {!iconOnly && <span className="truncate">{text}</span>}
    </span>
  );
}

/** Presets, a picked time, and Unsnooze when it is already snoozed. */
export function SnoozeChoices({ threadId, name, until, blocked, onDone, now: nowOverride, clock }: {
  threadId: string;
  name: string;
  /** When it wakes, if it is snoozed now. */
  until?: number;
  /** Something is waiting on the owner here, so it cannot be snoozed. */
  blocked?: boolean;
  onDone: () => void;
  now?: number;
  clock?: SnoozeClock;
}) {
  const now = nowOverride ?? Date.now();
  const presets = snoozePresets(now, clock);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState(() => pickedTimeValue(presets[1]!.until, clock?.timeZone));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pickId = useId();
  const apply = async (next: number | null) => {
    if (saving) return;
    setSaving(true); setError(null);
    try { await changeThreadSnooze(api, threadId, next); onDone(); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : "Could not change the snooze. Try again."); }
    finally { setSaving(false); }
  };
  const pickedAt = pickedTimeToEpoch(picked, clock?.timeZone);
  const pickedProblem = pickedAt === null ? "Choose a date and time."
    : pickedAt <= now ? "Choose a time in the future."
      : pickedAt > now + SNOOZE_MAX_MS ? "Choose a time in the next 30 days." : null;
  const choice = "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40";
  return (
    <div role="group" aria-label={`Snooze ${name}`} data-snooze-choices={threadId} className="flex flex-col gap-0.5">
      {until !== undefined && (
        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[12px]">
          <SnoozedMarker until={until} now={now} clock={clock} />
          <button type="button" disabled={saving} onClick={() => void apply(null)}
            className="shrink-0 rounded-md border border-hairline/60 px-2 py-1 text-[12px] font-medium text-ink hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
            Unsnooze
          </button>
        </div>
      )}
      {blocked ? (
        <p className="px-2.5 py-2 text-[12px] text-ink-secondary">This conversation is waiting on your answer. Answer it first, then snooze it.</p>
      ) : (
        <>
          <p aria-hidden="true" className="px-2.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink-secondary">Snooze until</p>
          {presets.map(preset => (
            <button key={preset.id} type="button" disabled={saving} onClick={() => void apply(preset.until)} className={choice}
              aria-label={`Snooze for ${preset.label.toLowerCase()}, until ${preset.detail}`}>
              <span>{preset.label}</span>
              <span className="text-[12px] text-ink-secondary">{preset.detail}</span>
            </button>
          ))}
          {!picking ? (
            <button type="button" disabled={saving} onClick={() => setPicking(true)} className={choice}>
              <span>Pick a time</span>
              <CalendarClock size={14} aria-hidden="true" className="text-ink-secondary" />
            </button>
          ) : (
            <form className="flex flex-col gap-1.5 px-2.5 py-1.5" onSubmit={(event) => { event.preventDefault(); if (!pickedProblem && pickedAt !== null) void apply(pickedAt); }}>
              <label htmlFor={pickId} className="text-[12px] text-ink-secondary">Snooze until</label>
              <div className="flex items-center gap-1.5">
                <input id={pickId} type="datetime-local" autoFocus value={picked} onChange={(event) => setPicked(event.target.value)}
                  min={pickedTimeValue(now, clock?.timeZone)} max={pickedTimeValue(now + SNOOZE_MAX_MS, clock?.timeZone)}
                  aria-invalid={pickedProblem ? true : undefined}
                  className="min-w-0 flex-1 rounded-lg border border-hairline/50 bg-inset px-2 py-1.5 text-[13px] text-ink focus:border-accent/60 focus:outline-none" />
                <button type="submit" disabled={saving || Boolean(pickedProblem)}
                  className="shrink-0 rounded-lg bg-accent px-2.5 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-40">
                  Snooze
                </button>
              </div>
              {pickedProblem && picked !== "" && <p className="text-[11.5px] text-ink-secondary">{pickedProblem}</p>}
            </form>
          )}
        </>
      )}
      {error && <p role="alert" className="px-2.5 py-1.5 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

/** The same choices, floating where a sidebar menu was. */
export function SnoozePopover({ x, y, onClose, ...choices }: Parameters<typeof SnoozeChoices>[0] & { x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: MouseEvent) => { if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) onClose(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [onClose]);
  const width = Math.min(272, window.innerWidth - 16);
  const top = Math.max(8, Math.min(y, window.innerHeight - 320));
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
  return createPortal(
    <div ref={ref} role="dialog" aria-label={`Snooze ${choices.name}`} data-snooze-popover=""
      style={{ top, left, width }}
      className="fixed z-50 rounded-xl border border-hairline/50 bg-card p-1.5 shadow-2xl shadow-black/60">
      <SnoozeChoices {...choices} onDone={() => { choices.onDone(); onClose(); }} />
    </div>,
    document.body,
  );
}
