// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The four doors at the top of the rail (UX 1.0.13, lane L2A; mockup
// Desktop.dc.html rail, copy verbatim): Today, Chats, Needs you with its
// count, Routines. They replace the Places row (SidebarPlaces.tsx) and the old
// Needs you row and All chats button. The rail shows on every view, so a door
// is always one click away.
//
// Each door is a real button. The lit one carries aria-current="page". The
// Needs you count is spoken in the button's name ("Needs you, 3 waiting");
// the badge itself is hidden from screen readers so it is not read twice.
import type { ReactNode } from "react";
import { CalendarDays, Inbox, MessageSquare, Sun } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { SHELL_DOORS, type NeedsSummary, type ShellDoor } from "./shell-contract";

export interface RailDoorsProps {
  lit: ShellDoor | null;
  needs: Pick<NeedsSummary, "count" | "stale">;
  /** the icon-only rail: labels move into the accessible name and tooltip */
  iconsOnly?: boolean;
  /** a routine problem nobody has looked at yet: a dot on Routines */
  routinesAttention?: boolean;
  onOpen: (door: ShellDoor) => void;
}

const ICON: Record<ShellDoor, (size: number) => ReactNode> = {
  today: (size) => <Sun size={size} aria-hidden="true" />,
  chats: (size) => <MessageSquare size={size} aria-hidden="true" />,
  "needs-you": (size) => <Inbox size={size} aria-hidden="true" />,
  routines: (size) => <CalendarDays size={size} aria-hidden="true" />,
};

const LABEL = {
  today: "ux.l2a.door.today",
  chats: "ux.l2a.door.chats",
  "needs-you": "ux.l2a.door.needsYou",
  routines: "ux.l2a.door.routines",
} as const satisfies Record<ShellDoor, string>;

const TIP = {
  today: "ux.l2a.door.tip.today",
  chats: "ux.l2a.door.tip.chats",
  "needs-you": "ux.l2a.door.tip.needsYou",
  routines: "ux.l2a.door.tip.routines",
} as const satisfies Record<ShellDoor, string>;

/** "Needs you, 3 waiting" / "Needs you, nothing waiting" / "Needs you, not known yet"; "may be out of date" when stale. */
export function needsDoorName(count: number | undefined, stale: boolean): string {
  const base = count === undefined
    ? t("ux.l2a.door.needsUnknown")
    : count === 0 ? t("ux.l2a.door.needsNone") : t("ux.l2a.door.needsWaiting", { n: count });
  return stale && count !== undefined ? t("ux.l2a.door.needsStale", { label: base }) : base;
}

export function RailDoors({ lit, needs, iconsOnly = false, routinesAttention = false, onOpen }: RailDoorsProps) {
  const waiting = (needs.count ?? 0) > 0;
  return (
    <nav aria-label={t("ux.l2a.door.navLabel")} data-rail-doors className={cn("flex flex-col gap-0.5", iconsOnly && "items-center")}>
      {SHELL_DOORS.map((door) => {
        const on = lit === door;
        const label = t(LABEL[door]);
        const name = door === "needs-you"
          ? needsDoorName(needs.count, needs.stale)
          : door === "routines" && routinesAttention
            ? t("ux.l2a.door.routinesAttention", { label })
            : iconsOnly ? label : undefined;
        return (
          <button
            key={door}
            type="button"
            data-door={door}
            data-sidebar-needs-you={door === "needs-you" ? "" : undefined}
            aria-current={on ? "page" : undefined}
            aria-label={name}
            title={t(TIP[door])}
            onClick={() => onOpen(door)}
            className={cn(
              "relative flex min-h-11 items-center gap-2.5 rounded-lg text-[14px] font-medium text-ink hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
              iconsOnly ? "size-11 justify-center" : "w-full px-3",
              on && "bg-raised font-semibold",
            )}
          >
            <span className={cn("relative shrink-0", on ? "text-accent-text" : "text-ink-secondary")}>
              {ICON[door](iconsOnly ? 20 : 17)}
              {door === "routines" && routinesAttention && (
                <span aria-hidden="true" data-routines-attention className="absolute -right-1 -top-1 size-2 rounded-full bg-danger ring-2 ring-panel" />
              )}
            </span>
            {!iconsOnly && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
            {/* Zero is kept in the page for tests and tools that read the count, but shown to nobody. */}
            {door === "needs-you" && !waiting && needs.count !== undefined && <span aria-hidden="true" data-needs-you-count className="sr-only">0</span>}
            {door === "needs-you" && waiting && (
              <span
                aria-hidden="true"
                data-needs-you-count
                className={cn(
                  "min-w-5 rounded-full bg-accent px-1.5 text-center text-[12px] font-semibold leading-5 text-accent-ink",
                  iconsOnly && "absolute -right-0.5 -top-0.5",
                )}
              >
                {needs.count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
