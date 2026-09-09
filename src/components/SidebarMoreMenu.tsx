// Utility destinations remain grouped behind a visible Tools button.
//
// Hover alone would make them unreachable by keyboard and fragile with a
// trackpad, so: hovering opens it, a click pins it, Escape and an outside
// click close it, and the trigger is an ordinary focusable button.
import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { ChevronUp, Wrench } from "lucide-react";
import { cn } from "@/lib/cn";

export interface MoreMenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  active?: boolean;
  /** the item wants attention (a failed routine); folded items cannot show
   * their own dot, so the trigger carries one on their behalf */
  attention?: boolean;
  onSelect: () => void;
}

/** Opening is quick enough to feel like a hover, closing is slow enough to
 * forgive a diagonal path from the chevron to the menu. */
const OPEN_DELAY_MS = 80;
const CLOSE_DELAY_MS = 250;

/** The open list, split out from the stateful shell so the suite — which runs
 *  in node with no DOM to hover — can render it and assert what it says. */
export function SidebarMoreMenuPanel({
  items,
  id,
  onChoose,
}: {
  items: MoreMenuItem[];
  id?: string;
  onChoose?: () => void;
}) {
  return (
    <div
      id={id}
      role="menu"
      aria-label="Tools"
      className="animate-pop-in absolute bottom-full left-0 right-0 z-40 mb-1 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/50"
    >
      {items.map((item) => (
        <button
          key={item.key}
          role="menuitem"
          onClick={() => {
            item.onSelect();
            onChoose?.();
          }}
          className={cn(
            "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]",
            item.active ? "bg-raised text-ink" : "text-ink hover:bg-raised/70",
          )}
        >
          <span className={cn("flex size-5 items-center justify-center", item.active ? "text-accent" : "text-ink-secondary")}>
            {item.icon}
          </span>
          <span className="flex-1">{item.label}</span>
          {item.attention && <span className="size-2 rounded-full bg-danger" />}
        </button>
      ))}
    </div>
  );
}

export function SidebarMoreMenu({ items, compact = false, triggerRef }: { items: MoreMenuItem[]; compact?: boolean; triggerRef?: Ref<HTMLButtonElement> }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = useId();

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  useEffect(() => clearTimers, []);

  const hoverOpen = () => {
    if (pinned) return;
    clearTimers();
    openTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  };
  const hoverClose = () => {
    if (pinned) return;
    clearTimers();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  const close = () => {
    clearTimers();
    setPinned(false);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const attention = items.some((item) => item.attention);

  return (
    <div
      ref={rootRef}
      className="relative"
      onPointerEnter={hoverOpen}
      onPointerLeave={hoverClose}
      // a keyboard user tabbing in gets the same menu a pointer gets
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (pinned) return;
        if (!event.relatedTarget || !rootRef.current?.contains(event.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={attention ? "Tools, items need attention" : "Tools"}
        title="Tools"
        data-sidebar-more-trigger
        ref={triggerRef}
        onClick={() => {
          clearTimers();
          if (open && pinned) close();
          else {
            setPinned(true);
            setOpen(true);
          }
        }}
        className={cn(
          "relative flex min-h-9 w-full items-center gap-2.5 rounded-xl px-3 text-ink-secondary transition-colors hover:bg-raised hover:text-ink",
          compact ? "py-1.5" : "py-2",
          open ? "bg-raised text-ink" : "bg-raised/40",
        )}
      >
        <Wrench size={18} aria-hidden="true" className="shrink-0" />
        <span className="flex-1 text-left text-[14px] font-medium">Tools</span>
        {attention && !open && (
          <span data-sidebar-more-attention aria-hidden="true" className="size-2 shrink-0 rounded-full bg-danger" />
        )}
        <ChevronUp size={16} aria-hidden="true" className={cn("shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && <SidebarMoreMenuPanel items={items} id={menuId} onChoose={close} />}
    </div>
  );
}
