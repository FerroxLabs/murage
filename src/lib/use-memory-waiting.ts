// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shared "waiting for you" counts as a React hook. The live stream's
// `memory.waiting` frame (src/state/store.tsx) arrives here as a window event,
// moves the number at once, and a coalesced read of the summary follows to fill
// in the everyday count. Every surface (the Inbox card, the badge, each bot's
// Memory screen) reads the one store in src/lib/memory-review.ts.
import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/state/store";
import { MEMORY_WAITING_EVENT, applyWaitingFrame, applyWaitingSummary, getWaiting, memoryAction, subscribeWaiting, type WaitingFrame, type WaitingSnapshot } from "./memory-review";

export { MEMORY_WAITING_EVENT };

let installed = false;
let timer: ReturnType<typeof setTimeout> | undefined;

export async function refreshWaiting(): Promise<void> {
  applyWaitingSummary(await memoryAction(api, { action: "waiting-summary" }));
}
function scheduleRefresh(): void {
  clearTimeout(timer);
  timer = setTimeout(() => { void refreshWaiting().catch(() => { /* the counts already on screen stay */ }); }, 250);
}
function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(MEMORY_WAITING_EVENT, event => {
    const frame = (event as CustomEvent<WaitingFrame>).detail;
    if (!frame || typeof frame.waiting !== "number" || typeof frame.total !== "number") return;
    applyWaitingFrame(frame);
    scheduleRefresh();
  });
}

export function useMemoryWaiting(): WaitingSnapshot {
  install();
  const snapshot = useSyncExternalStore(subscribeWaiting, getWaiting, getWaiting);
  useEffect(() => { void refreshWaiting().catch(() => { /* shown as zero until the next frame */ }); }, []);
  return snapshot;
}
