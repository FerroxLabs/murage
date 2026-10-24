// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One state machine for the update surface. The round button beside the account menu (UpdateIndicator) and the centred
// card (UpdateBanner) both read the updater bridge's state through useUpdaterState; the only thing they share beyond it is
// whether the card is open, which lives here. A module latch rather than a store action: neither side owns app state.
import { useSyncExternalStore } from "react";
import type { UpdaterState } from "@/types/muragebox";

let open = false;
const listeners = new Set<() => void>();

function publish(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of [...listeners]) listener();
}

export const openUpdateCard = (): void => publish(true);
export const closeUpdateCard = (): void => publish(false);

export function useUpdateCardOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    () => open,
    () => false,
  );
}

/** States that give the round button a reason to be on screen: something to do, something under way, or something wrong. */
export function indicatorShows(status: UpdaterState["status"] | undefined): boolean {
  return status === "available" || status === "downloading" || status === "downloaded" || status === "installing" || status === "deferred" || status === "handed-off" || status === "error";
}

/** The button's accessible name, by state. */
export function indicatorLabelKey(status: UpdaterState["status"]): "updates.indicatorAvailable" | "updates.indicatorBusy" | "updates.indicatorReady" | "updates.indicatorProblem" {
  if (status === "available") return "updates.indicatorAvailable";
  if (status === "downloaded" || status === "handed-off") return "updates.indicatorReady";
  if (status === "error") return "updates.indicatorProblem";
  return "updates.indicatorBusy";
}
