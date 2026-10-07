// Where the call's full-screen view portals to (callbar-review.md I3).
//
// `Call`/`GroupCall` are mounted once at Shell level (App.tsx), keyed to the
// call's own target rather than the selection, so a thread switch never
// unmounts them (moss-approval-bug.md). Before this, their full-screen JSX
// rendered `absolute inset-0` against Shell's own container and covered the
// sidebar and side panels on desktop. The chat column (ChatView) and the
// room column (GroupView) each own a slot element, at the same DOM position
// their own inline overlay used to occupy; Call portals its full-screen view
// into whichever one is mounted, so it covers exactly what it covered
// before. Only one of ChatView/GroupView is ever mounted at a time, so one
// slot is enough — Shell's own `collapsed` prop (callIsSelected) already
// guarantees the mounted slot belongs to the bot or room on the call
// whenever `collapsed` is false.
import { useSyncExternalStore } from "react";

let slot: HTMLElement | null = null;
const watchers = new Set<() => void>();

function notify() {
  for (const fn of [...watchers]) fn();
}

/** ChatView/GroupView call this from a mount-only effect on their slot ref,
 *  and again with `null` on unmount. Not a ref callback: an inline one is a
 *  new function every render and would flicker the portal off and on. */
export function registerCallSlot(el: HTMLElement | null): void {
  if (slot === el) return;
  slot = el;
  notify();
}

/** The currently mounted slot, or null when no chat/room column is on
 *  screen (Routines, the team map, a workspace pane, and so on) — `Call`
 *  falls back to the bar in that case. */
export function useCallSlot(): HTMLElement | null {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => slot,
    () => null,
  );
}
