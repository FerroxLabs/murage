// The chat header's "More" menu (U0-T1). Controls the header cannot fit at
// the current container width are relocated here rather than removed, so
// every feature stays one keyboard-reachable step away at any width.
//
// WAI-ARIA menu button: Enter/Space/ArrowDown open on the first item,
// ArrowUp opens on the last; arrows, Home and End move; Escape and Tab close
// and return focus to the trigger; an outside press closes it.
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, Ellipsis } from "lucide-react";

import { cn } from "@/lib/cn";

export interface HeaderMenuItem {
  id: string;
  label: string;
  /** Secondary line, also the item's accessible description. */
  description?: string;
  icon?: ReactNode;
  /** Present for toggles: rendered as a menuitemcheckbox. */
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function ChatHeaderMenu({
  items,
  label,
  menuLabel,
  triggerRef,
}: {
  items: readonly HeaderMenuItem[];
  /** Accessible name of the trigger. */
  label: string;
  menuLabel: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const itemElements = () => [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-header-menu-item]") ?? [])];
  const close = (restore: boolean) => {
    setOpen(false);
    if (restore) triggerRef.current?.focus();
  };
  const openAt = (index: number) => {
    setActive(index);
    setOpen(true);
  };

  // Focus follows the active item while open.
  useEffect(() => {
    if (!open) return;
    itemElements()[active]?.focus();
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  // A relocation while open can shorten the list under the cursor.
  useEffect(() => {
    if (active >= items.length) setActive(Math.max(0, items.length - 1));
  }, [items.length, active]);

  const move = (delta: number) => setActive((current) => (current + delta + items.length) % items.length);

  return (
    <div ref={root} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-chat-header-more
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openAt(event.key === "ArrowDown" ? 0 : items.length - 1);
          }
        }}
        className={cn(
          "flex size-[30px] items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-focus",
          open && "bg-raised text-ink",
        )}
      >
        <Ellipsis size={18} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={list}
          id={menuId}
          role="menu"
          aria-label={menuLabel}
          aria-orientation="vertical"
          className="animate-pop-in absolute right-0 top-full z-40 mt-1 w-[min(300px,calc(100vw-16px))] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1 text-ink shadow-2xl shadow-black/40"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") move(1);
            else if (event.key === "ArrowUp") move(-1);
            else if (event.key === "Home") setActive(0);
            else if (event.key === "End") setActive(items.length - 1);
            else if (event.key === "Escape" || event.key === "Tab") close(true);
            else return;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {items.map((item, index) => {
            const descriptionId = item.description ? `${menuId}-${item.id}-detail` : undefined;
            return (
              <button
                key={item.id}
                type="button"
                data-header-menu-item={item.id}
                role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={item.checked}
                aria-disabled={item.disabled || undefined}
                aria-describedby={descriptionId}
                tabIndex={index === active ? 0 : -1}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  if (item.disabled) return;
                  // Back to the trigger first; an action that opens a dialog
                  // or the find bar then takes focus from there.
                  close(true);
                  item.onSelect();
                }}
                className={cn(
                  // The focus ring is drawn INSIDE the item: the menu clips its
                  // overflow, so an outset ring loses its top and bottom edges
                  // on the first and last rows.
                  "flex min-h-10 w-full items-start gap-2.5 px-3 py-2 text-left text-[13px] outline-none focus-visible:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus hover:bg-raised",
                  item.disabled && "cursor-default text-ink-secondary/70",
                )}
              >
                <span className="mt-px flex size-[18px] shrink-0 items-center justify-center text-ink-secondary" aria-hidden="true">
                  {item.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block break-words">{item.label}</span>
                  {item.description && (
                    <span id={descriptionId} className="mt-0.5 block break-words text-[11.5px] text-ink-secondary">
                      {item.description}
                    </span>
                  )}
                </span>
                {item.checked && <Check size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
