// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The phone's four tabs (UX L7 part 1; plan UX-OVERHAUL-BUILD-PLAN.md L7):
// Today, Chats, Needs you with its count, Routines. They sit at the bottom of
// the Door bundle below `md`, under the thumb: 56 px tall, 12 px labels, each
// tab a real button the full quarter wide. The same doors as the rail
// (RailDoors.tsx), so a phone and a computer never disagree on the names or
// the count. The lit tab carries aria-current="page"; the Needs you count is
// spoken in the button's name and the badge is hidden from screen readers.
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { DOOR_ICON, DOOR_LABEL, needsDoorName } from "@/components/shell/RailDoors";
import { SHELL_DOORS, type PhoneTabsProps } from "@/components/shell/shell-contract";
import { useTypingFocus } from "./typing-focus";

/** "3", "99+": the badge never grows past three characters at 12 px. */
export function phoneBadge(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function PhoneTabs({ active, needsCount, onSelect }: PhoneTabsProps) {
  const waiting = (needsCount ?? 0) > 0;
  // Android shrinks the WebView for the keyboard; a fixed bar would ride up over it.
  const typing = useTypingFocus();
  if (typing) return null;
  return (
    <nav
      aria-label={t("ux.l2a.door.navLabel")}
      data-phone-tabs
      className="flex border-t border-hairline/40 bg-panel pb-[env(safe-area-inset-bottom)]"
    >
      {SHELL_DOORS.map((door) => {
        const on = active === door;
        return (
          <button
            key={door}
            type="button"
            data-phone-tab={door}
            aria-current={on ? "page" : undefined}
            aria-label={door === "needs-you" ? needsDoorName(needsCount, false) : undefined}
            onClick={() => onSelect(door)}
            className={cn(
              "flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus",
              on ? "text-accent-text" : "text-ink-secondary",
            )}
          >
            <span className="relative">
              {DOOR_ICON[door](22)}
              {door === "needs-you" && waiting && (
                <span
                  aria-hidden="true"
                  data-phone-needs-count
                  className="absolute -right-3 -top-1.5 min-w-5 rounded-full bg-accent px-1 text-center text-[11px] font-semibold leading-[18px] text-accent-ink ring-2 ring-panel"
                >
                  {phoneBadge(needsCount ?? 0)}
                </span>
              )}
            </span>
            <span className="max-w-full truncate px-1">{t(DOOR_LABEL[door])}</span>
          </button>
        );
      })}
    </nav>
  );
}
