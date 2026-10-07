// SEC-006 Decision 1: a browser pairing (camera scan or typed code) approves low-rated cards only. The harness is
// the authority (it refuses a high-risk Allow from a browser pairing); this only decides what the page offers,
// so nobody is shown a button that cannot work.
import { useSyncExternalStore } from "react";

export type ApprovalSurface = "desktop" | "app" | "browser" | "unknown";

/** `desktop` is `useDesktopSurface()` (true desktop, false remote, undefined not asked yet); `native` is
 *  `inNativeShell()`. Unknown must offer the normal buttons: the harness still decides. */
export function approvalSurface(desktop: boolean | undefined, native: boolean): ApprovalSurface {
  if (desktop === true) return "desktop";
  if (native) return "app";
  return desktop === false ? "browser" : "unknown";
}

/** True when this page must not offer Allow for this card. A browser pairing offers it only for a card the
 *  harness rated low when it raised it (`lowRisk`, advisory); a card with no flag, any unrated kind, and any
 *  card the harness has already refused, needs the computer. */
export function allowNeedsComputer(surface: ApprovalSurface, card: { lowRisk?: unknown } | undefined, refused = false): boolean {
  if (refused) return true;
  return surface === "browser" && card?.lowRisk !== true;
}

const refusals = new Set<string>();
const listeners = new Set<() => void>();
const key = (threadId: string, requestId: string) => `${threadId}:${requestId}`;

/** The harness answered `approve_on_computer` for this request: stop offering Allow for it. */
export function markComputerOnly(threadId: string, requestId: string): void {
  if (refusals.has(key(threadId, requestId))) return;
  if (refusals.size >= 500) refusals.delete(refusals.values().next().value!);
  refusals.add(key(threadId, requestId));
  for (const listener of listeners) listener();
}
export function isComputerOnly(threadId: string, requestId: string): boolean {
  return refusals.has(key(threadId, requestId));
}
export function useComputerOnlyRefusal(threadId: string, requestId: string): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => refusals.has(key(threadId, requestId)),
    () => false,
  );
}
