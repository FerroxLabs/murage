import { BookOpen, ChevronDown, ChevronRight, GripVertical, Loader2, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";

import { cn } from "@/lib/cn";
import type { TeamSettingsFocus } from "@/lib/team-manage";
import {
  sidebarAttentionLabel,
  type SidebarSectionAttention,
} from "@/lib/sidebar-attention";

export function SidebarSectionHeader({
  name,
  collapsed,
  attention,
  onToggle,
  reorderable,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
  onEditInstructions,
  onManage,
}: {
  name: string;
  collapsed: boolean;
  attention?: SidebarSectionAttention;
  onToggle?: () => void;
  reorderable: boolean;
  dragging: boolean;
  onDragStart?: (event: DragEvent<HTMLSpanElement>) => void;
  onDragEnd?: () => void;
  onMove?: (direction: -1 | 1) => void;
  /** Teams only: opens the same instructions editor as the Team map. */
  onEditInstructions?: () => void;
  /** Teams only: rename, members and lead, delete (TeamSettingsDialog). */
  onManage?: (focus: TeamSettingsFocus) => void;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const attentionLabel = attention ? sidebarAttentionLabel(attention) : "";
  const onHeaderKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!reorderable || !event.altKey) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onMove?.(-1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onMove?.(1);
    }
  };

  return (
    <div className="relative flex items-center gap-1 px-2 pb-1" data-section={name}>
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          onKeyDown={onHeaderKeyDown}
          aria-expanded={!collapsed}
          aria-keyshortcuts={reorderable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          title={
            reorderable
              ? `${collapsed ? "Expand" : "Collapse"} ${name}. Alt+Up/Down reorders it.`
              : `${collapsed ? "Expand" : "Collapse"} ${name}`
          }
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-raised/50"
        >
          <Chevron size={12} className="shrink-0 text-ink-secondary" />
          <span className="truncate text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
            {name}
          </span>
          {/* A closed section follows the same rule its rows do: a count, in
              colour, for the one thing waiting on you. Unread loses its badge
              and working turns a ring instead of holding a coloured dot —
              both are still counted in the label below. */}
          {attention && attention.waiting > 0 && (
            <span
              aria-hidden="true"
              className="min-w-4 rounded-full bg-warning/15 px-1 text-center text-[9px] font-semibold leading-4 text-warning"
            >
              {attention.waiting}
            </span>
          )}
          {attention && attention.working > 0 && (
            <Loader2
              aria-hidden="true"
              size={11}
              className="shrink-0 animate-spin text-ink-secondary"
            />
          )}
          <span className="h-px flex-1 bg-hairline/40" />
          {attentionLabel && <span className="sr-only">{attentionLabel}</span>}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5">
          <span className="truncate text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
            {name}
          </span>
          <span className="h-px flex-1 bg-hairline/40" />
        </div>
      )}
      {onEditInstructions && (
        <button
          type="button"
          onClick={onEditInstructions}
          aria-label={`Edit ${name} team instructions`}
          title="Team instructions"
          className="flex size-6 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <BookOpen size={12} />
        </button>
      )}
      {onManage && <TeamSectionMenu name={name} onManage={onManage} />}
      {reorderable && (
        <span
          aria-hidden="true"
          draggable
          title="Drag to reorder"
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className={cn(
            "flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink",
            dragging && "opacity-40",
          )}
        >
          <GripVertical size={13} />
        </span>
      )}
    </div>
  );
}

const TEAM_MENU_ITEMS: ReadonlyArray<readonly [TeamSettingsFocus, string]> = [
  ["rename", "Rename team"],
  ["members", "Manage members and lead"],
  ["delete", "Delete team"],
];

/** The team heading's "..." menu. A real menu: Enter, Space or ArrowDown
 * opens it on the first item, arrows and Home/End move, Escape closes it and
 * gives focus back to the button. The button is drawn small to fit the
 * heading but takes taps across 44px. */
function TeamSectionMenu({ name, onManage }: { name: string; onManage: (focus: TeamSettingsFocus) => void }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const items = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const close = (event: MouseEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => {
      event.preventDefault();
      list[(index + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === "Tab") setOpen(false);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`${name} team options`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Team options"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="relative flex size-6 shrink-0 items-center justify-center rounded text-ink-secondary after:absolute after:-inset-2.5 after:content-[''] hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
      >
        <MoreHorizontal size={13} />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`${name} team options`}
          onKeyDown={onMenuKeyDown}
          className="absolute right-2 top-full z-30 mt-1 w-56 rounded-xl border border-hairline/50 bg-card py-1 shadow-xl"
        >
          {TEAM_MENU_ITEMS.map(([focus, label]) => (
            <button
              key={focus}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setOpen(false);
                // Back on the button first, so the dialog returns focus here.
                buttonRef.current?.focus();
                onManage(focus);
              }}
              className={cn(
                "flex min-h-11 w-full items-center px-3.5 text-left text-[13.5px] hover:bg-raised/70 focus:bg-raised/70",
                focus === "delete" ? "text-danger" : "text-ink",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
