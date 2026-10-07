// A read-only projection of the active call's on-screen status, for the
// strip ChatView/GroupView render in their own layout (callbar-review.md
// I4, I5): "top of the main column, under the header," in normal flow,
// rather than floating fixed over the composer or the sidebar.
//
// `Call`/`GroupCall` (CallView.tsx, GroupCallView.tsx) are the only
// writers, publishing whenever their own live status changes. Everything
// else — the strip, any future consumer — only ever reads.
import { useSyncExternalStore } from "react";

export type CallBarStatus = "connecting" | "live" | "paused" | "lost";

export interface CallBarState {
  targetId: string;
  /** The call's own thread, frozen for its lifetime (CallView.tsx's
   *  threadRef) — never the bot's live `threadId`. A push for a different
   *  task of the SAME bot changes `threadId` without changing `targetId`
   *  (still that bot), so the strip must match on both to hide only on
   *  the call's own thread, not on any thread of that bot
   *  (callbar-rereview.md N3). */
  threadId: string;
  name: string;
  status: CallBarStatus;
  /** Which `dispatch` shape brings the call's own thread back into view:
   *  `switchTask` for a bot, `switchGroupTask` for a room. */
  kind: "bot" | "group";
}

let state: CallBarState | null = null;
const watchers = new Set<() => void>();

function notify() {
  for (const fn of [...watchers]) fn();
}

export function publishCallBarState(next: CallBarState | null): void {
  state = next;
  notify();
}

export function useCallBarState(): CallBarState | null {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => state,
    () => null,
  );
}
