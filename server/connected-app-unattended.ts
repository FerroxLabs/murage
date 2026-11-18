import { delegatedTurnUnattended } from "./browser-extension-integration.ts";

/** A connected-app action runs unattended when its turn is marked unattended or is a live routine run (or started from one),
 * or when the turn carries captured routine authority: a routine peer or a wake of the owner's routine, even with
 * `unattended: false` and a thread that is not a live routine's. */
export function connectedAppTurnUnattended(
  deps: Parameters<typeof delegatedTurnUnattended>[0] & { routineAuthority: (threadId: string) => boolean },
  threadId?: string | null,
): boolean {
  return Boolean(threadId) && (delegatedTurnUnattended(deps, threadId) || deps.routineAuthority(threadId as string));
}
