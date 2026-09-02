// The fly-out behind the token chip in the chat header.
//
// It was a `title` attribute. A native tooltip cannot be styled, cannot be
// positioned, needs about a second of MOTIONLESS hover to appear, and vanishes
// the instant the pointer moves toward it — so the breakdown it carried was,
// in practice, unreachable, and the chip's own click lands on the agent
// profile's Name field with the Usage card far below the Computer/Box/VPS
// block. This is the same content, anchored, keyboard-reachable, and able to
// hold the one link that goes anywhere useful.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import type { UsageReportLine } from "@/lib/usage";

/** Lines that carry a figure read as figures; the rest is caption. */
const FIGURE_LINES = new Set<UsageReportLine["id"]>(["turns", "breakdown", "fresh", "cost"]);

export function usageLineClass(id: UsageReportLine["id"]): string {
  // The mid-turn caveat is the one line that is a WARNING about the others,
  // so it is the one line that does not look like the others.
  if (id === "stale") return "text-warning";
  if (FIGURE_LINES.has(id)) return "tabular-nums text-ink";
  return "text-ink-secondary";
}

export function UsagePopover({
  lines,
  onAllBots,
  trigger,
  className,
}: {
  lines: readonly UsageReportLine[];
  onAllBots: () => void;
  /** The chip itself. Its own click behaviour is untouched — this component
   *  only hands it the `aria-describedby` that names the open panel. */
  trigger: (props: { describedBy: string | undefined }) => ReactNode;
  className?: string;
}) {
  const panelId = useId();
  const wrap = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);

  // Escape and outside-click are bound only while it is open, and on the
  // document rather than the wrapper: a pointer-opened panel holds no focus,
  // so a wrapper-scoped keydown would never hear the Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Back to the chip, never to nowhere — the panel may have held focus.
      if (wrap.current?.contains(document.activeElement)) {
        wrap.current.querySelector("button")?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div
      ref={wrap}
      className={cn("relative", className)}
      // The panel is a CHILD of this wrapper, so a pointer that has travelled
      // into the panel is still inside the element that owns the open state —
      // which is the whole reason a `title` could not be walked into.
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      // focusin/focusout, so the keyboard gets in without a pointer and a tab
      // out of the last control inside closes it.
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {trigger({ describedBy: open ? panelId : undefined })}
      {open && (
        <div
          id={panelId}
          // Not `role="tooltip"`: a tooltip may hold no interactive content,
          // and this one holds the way through to every bot's usage.
          role="group"
          aria-label="Usage detail"
          // `pt-2` rather than a margin: the gap between chip and panel is
          // PART of the panel, so crossing it never leaves the wrapper.
          className="absolute right-0 top-full z-50 pt-2"
        >
          <div
            className={cn(
              // Right-anchored and width-capped against the viewport, because
              // this chip sits in a cluster hard against the right edge.
              "w-[19rem] max-w-[min(19rem,calc(100vw-1.5rem))]",
              "rounded-xl border border-hairline/40 bg-panel p-3 text-left shadow-lg",
              // styles.css already stops this under `prefers-reduced-motion`;
              // saying it here too keeps the promise local to the component.
              "animate-msg-in motion-reduce:animate-none motion-reduce:transition-none",
            )}
          >
            <ul className="space-y-1 text-[12px] leading-relaxed">
              {lines.map((line) => (
                <li key={line.id} className={usageLineClass(line.id)}>
                  {line.text}
                </li>
              ))}
            </ul>
            {/* The same destination the Usage card's own link uses, so the
                chip finally leads somewhere that answers the question. */}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onAllBots();
              }}
              className="mt-2.5 rounded text-[12px] text-ink-secondary hover:text-ink focus:outline-none focus-visible:text-ink"
            >
              All bots →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
