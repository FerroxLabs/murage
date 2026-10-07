// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The "You" menu: your name in the sidebar footer opens a short menu of the
// things about you and the app, instead of opening Settings a second way
// beside the gear (NAV-OVERHAUL.md 3.1). It took over what was left of the
// Tools pull-up once the four places moved to their own strip: What's new,
// Keyboard shortcuts and Teach a skill.
//
// A click opens it (no hover), arrow keys move through it, Escape and an
// outside click close it, and focus goes back to your name.
import { Suspense, useEffect, useId, useRef, useState, type Ref } from "react";
import { ChevronUp } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { InitialsAvatar } from "./Avatar";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";
import type { YouMenuItem } from "./SidebarYouMenuPanel";

export type { YouMenuItem } from "./SidebarYouMenuPanel";

const Panel = retryableLazy(() => import("./SidebarYouMenuPanel"));

export function SidebarYouMenu({
  items,
  name,
  initials,
  rail = false,
  triggerRef,
}: {
  items: YouMenuItem[];
  name: string;
  initials: string;
  rail?: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const ownTrigger = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) ownTrigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Only this menu closes; the drawer under it stays.
      event.stopPropagation();
      close(true);
    };
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={cn("relative min-w-0", !rail && "flex-1")}
      onBlur={(event) => {
        if (open && event.relatedTarget instanceof Node && !rootRef.current?.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        data-sidebar-you-trigger
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={rail ? name : undefined}
        title={t("nav.tip.you", { name })}
        ref={(element) => {
          ownTrigger.current = element;
          if (typeof triggerRef === "function") triggerRef(element);
          else if (triggerRef) (triggerRef as { current: HTMLButtonElement | null }).current = element;
        }}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex min-h-10 w-full min-w-0 items-center rounded-lg py-1.5 text-left transition-colors hover:bg-raised/60 max-md:min-h-11",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus",
          rail ? "justify-center px-2" : "gap-2.5 px-2.5",
          open && "bg-raised",
        )}
      >
        <InitialsAvatar initials={initials} size={28} />
        {!rail && <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{name}</span>}
        {!rail && <ChevronUp size={15} aria-hidden="true" className={cn("shrink-0 text-ink-secondary transition-transform", !open && "rotate-180")} />}
      </button>
      {/* Focus goes back to your name before the item runs, so whatever it
          opens (Settings, What's new) hands focus back there when it closes. */}
      {open && <LazyBoundary inline onRetry={Panel.retry} onDismiss={() => close(true)}><Suspense fallback={null}><Panel.Component items={items} id={menuId} onChoose={() => close(true)} /></Suspense></LazyBoundary>}
    </div>
  );
}
