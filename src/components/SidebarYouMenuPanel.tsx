// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The You menu's open list (SidebarYouMenu.tsx). Its own chunk: it loads the
// first time someone opens the menu, not with the first paint.
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export interface YouMenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  /** A keyboard shortcut shown at the end of the row, such as ⌘,. */
  hint?: string;
  onSelect: () => void;
}

/** The open list, apart from the stateful shell so a test can render it. */
export function SidebarYouMenuPanel({
  items,
  id,
  onChoose,
  className,
}: {
  items: YouMenuItem[];
  id?: string;
  onChoose?: () => void;
  className?: string;
}) {
  const menu = useRef<HTMLDivElement>(null);
  // The first row takes focus as the menu appears, so arrow keys work at once.
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (event.key === "ArrowDown") next = (at + 1) % rows.length;
    else if (event.key === "ArrowUp") next = (at - 1 + rows.length) % rows.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    if (next < 0) return;
    event.preventDefault();
    rows[next]?.focus();
  };
  return (
    <div
      ref={menu}
      id={id}
      role="menu"
      aria-label={t("nav.youMenu")}
      onKeyDown={onKeyDown}
      className={cn(
        "animate-pop-in absolute bottom-full left-0 z-40 mb-1 w-60 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/50",
        className,
      )}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            onChoose?.();
            item.onSelect();
          }}
          className="flex min-h-10 w-full items-center gap-3 px-3.5 py-2 text-left max-md:min-h-11 text-[14px] text-ink hover:bg-raised/70 focus-visible:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
        >
          <span className="flex size-5 items-center justify-center text-ink-secondary" aria-hidden="true">{item.icon}</span>
          <span className="flex-1">{item.label}</span>
          {item.hint && <kbd className="shrink-0 font-sans text-[11.5px] text-ink-secondary">{item.hint}</kbd>}
        </button>
      ))}
    </div>
  );
}

export default SidebarYouMenuPanel;
