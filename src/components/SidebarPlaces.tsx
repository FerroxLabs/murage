// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The place strip under "Needs you": Routines, Files, Apps and the Team map.
//
// These four used to sit behind the sidebar's "Tools" pull-up, a closed menu
// that also held the shortcuts list and What's new. Routines and Connected
// apps are daily places, and a red dot on a folded menu was the only sign a
// routine needed attention. So they are always on screen now, each with a
// label under its icon, one row of four (NAV-OVERHAUL.md 3.1). The rail
// stacks them as icon buttons with tooltips.
//
// One Tab stop for the strip, arrow keys within it: the toolbar pattern.
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { installKind } from "@/lib/sidebar-preferences";

export type SidebarPlaceKey = "routines" | "files" | "apps" | "map";

export interface SidebarPlaceItem {
  key: SidebarPlaceKey;
  /** The short word under the icon ("Apps"). */
  label: string;
  /** The full name, read out and shown as the tooltip ("Connected apps").
   *  It contains the label, so voice control still finds it by what it says. */
  name: string;
  icon: ReactNode;
  active?: boolean;
  /** One plain line on what the place is, for the tooltip. */
  tip?: string;
  /** Something here wants the person (a failed routine). */
  attention?: boolean;
  onSelect: () => void;
}

/** The name a screen reader hears, attention included. */
export function sidebarPlaceName(item: Pick<SidebarPlaceItem, "name" | "attention">): string {
  return item.attention ? t("nav.needsAttention", { name: item.name }) : item.name;
}

export function SidebarPlaces({ places, rail = false }: { places: SidebarPlaceItem[]; rail?: boolean }) {
  const [focusIndex, setFocusIndex] = useState(0);
  const stop = Math.min(focusIndex, Math.max(0, places.length - 1));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const forward = rail ? "ArrowDown" : "ArrowRight";
    const back = rail ? "ArrowUp" : "ArrowLeft";
    let next = -1;
    if (event.key === forward) next = (stop + 1) % places.length;
    else if (event.key === back) next = (stop - 1 + places.length) % places.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = places.length - 1;
    if (next < 0) return;
    event.preventDefault();
    setFocusIndex(next);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-sidebar-place]")[next]?.focus();
  };

  return (
    <div
      role="toolbar"
      aria-label={t("nav.places")}
      aria-orientation={rail ? "vertical" : "horizontal"}
      onKeyDown={onKeyDown}
      className={rail ? "flex flex-col gap-1" : "grid gap-1"}
      style={rail ? undefined : { gridTemplateColumns: `repeat(${Math.max(1, places.length)}, minmax(0, 1fr))` }}
    >
      {places.map((place, index) => {
        const name = sidebarPlaceName(place);
        return (
          <button
            key={place.key}
            type="button"
            data-sidebar-place={place.key}
            tabIndex={index === stop ? 0 : -1}
            aria-label={name}
            aria-current={place.active ? "page" : undefined}
            title={place.tip ?? place.name}
            aria-description={place.tip}
            onFocus={() => setFocusIndex(index)}
            onClick={place.onSelect}
            className={cn(
              "relative flex items-center justify-center rounded-lg transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus",
              rail ? "min-h-9 w-full px-2" : "min-h-11 min-w-0 flex-col gap-1 px-1 py-1.5",
              place.active ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
            )}
          >
            <span className={cn("relative flex", place.active && "text-accent")} aria-hidden="true">
              {place.icon}
              {place.attention && (
                <span data-sidebar-place-attention className="absolute -right-1 -top-0.5 size-2 rounded-full border border-panel bg-danger" />
              )}
            </span>
            {!rail && <span aria-hidden="true" className="max-w-full truncate text-[11px] font-medium leading-none">{place.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Set once the note below has been dismissed. */
export const NAV_MOVED_SEEN_KEY = "murage.navMovedSeen";

/** Whether to show the one-time "Tools moved" note: only to someone who used
 *  the Tools pull-up (an install that ran before 0.1.62), until dismissed. */
export function shouldShowMovedNote(storage: (Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>) | null | undefined = globalThis.localStorage): boolean {
  try {
    return Boolean(storage) && storage!.getItem(NAV_MOVED_SEEN_KEY) === null && installKind(storage) === "upgraded";
  } catch {
    return false;
  }
}

/** NAV-OVERHAUL.md 5: people who knew the Tools pull-up are told, once,
 *  where its places went. */
export function SidebarMovedNote({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div role="note" data-sidebar-moved-note className="mt-2 flex items-start gap-2 rounded-lg bg-raised/60 px-3 py-2 text-[12px] leading-relaxed text-ink-secondary">
      <p className="min-w-0 flex-1"><span className="font-medium text-ink">{t("nav.movedTitle")}.</span> {t("nav.movedNote")}</p>
      <button
        type="button"
        onClick={() => {
          try {
            globalThis.localStorage?.setItem(NAV_MOVED_SEEN_KEY, "1");
          } catch {
            // blocked storage: it comes back next launch, nothing worse
          }
          onDismiss();
        }}
        aria-label={t("nav.movedDismiss")}
        title={t("nav.movedDismiss")}
        className="-mr-1.5 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-control hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
