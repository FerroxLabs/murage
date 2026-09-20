// "Needs you" — the one row for everything waiting on the person.
//
// Approvals used to live inside the sidebar's "Tools" pull-up, under two
// menu entries ("Pending approvals" and "Inbox") that opened the same dialog.
// A question your bot is waiting on is not a utility, and it was not visible
// without opening a menu. So it gets its own row, at the top of the sidebar,
// with its own count, and one destination.
//
// The count is the Inbox's own `needsYou` number, so the row and the view it
// opens always say the same thing.
import { BellDot } from "lucide-react";

import { cn } from "@/lib/cn";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

export interface SidebarNeedsYouProps {
  density: SidebarDensity;
  /** `undefined` until the first snapshot lands. */
  count?: number;
  /** the last snapshot could not be refreshed; the number may be old */
  stale?: boolean;
  onOpen: () => void;
}

/** "Needs you, 3" / "Needs you, not known yet", plus the staleness when the
 * count could not be confirmed. Exported so the label has one definition. */
export function needsYouLabel(count: number | undefined, stale: boolean): string {
  return `Needs you, ${count ?? "not known yet"}${stale ? ", may be out of date" : ""}`;
}

export function SidebarNeedsYou({ density, count, stale = false, onOpen }: SidebarNeedsYouProps) {
  const iconOnly = density === "icons";
  const waiting = (count ?? 0) > 0;
  return (
    <button
      type="button"
      data-sidebar-needs-you
      onClick={onOpen}
      aria-label={needsYouLabel(count, stale)}
      title={iconOnly ? needsYouLabel(count, stale) : "Needs you"}
      className={cn(
        "flex min-h-10 w-full items-center rounded-xl py-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus",
        iconOnly ? "justify-center gap-1 px-2" : "gap-3 px-3",
        waiting ? "bg-accent/10 text-ink hover:bg-accent/15" : "text-ink hover:bg-raised/50",
      )}
    >
      <BellDot size={20} aria-hidden="true" className={cn("shrink-0", waiting ? "text-accent" : "text-ink-secondary")} />
      <span className={cn("flex-1 text-[14px] font-medium", iconOnly && "hidden")}>Needs you</span>
      <span
        data-pending-approval-count
        data-needs-you-count
        aria-hidden="true"
        className={cn(
          "shrink-0 text-[12px] tabular-nums",
          iconOnly ? "" : "rounded-full px-2 py-0.5",
          waiting ? "bg-accent/15 text-accent" : "text-ink-secondary",
        )}
      >
        {count ?? "?"}
        {stale && count !== undefined ? " ?" : ""}
      </span>
    </button>
  );
}
