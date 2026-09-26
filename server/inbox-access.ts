// Who is shown which Inbox.
//
// The Inbox query has always been scoped by an explicit list of threads
// (`inbox.ts` `scope`), and the only list anyone built was the whole machine.
// So a remote door got `owner:false` and a 404: handing it the desktop's list
// would have shown a phone the hidden bots and the bot⇄bot rooms (spec §3.3,
// Astra 5).
//
// The remote list is the desktop list filtered by `visibleToCompanion`, the
// same predicate the live stream and the transcript routes use. One
// definition of "visible", asked in three places, so the Inbox can never name
// a conversation the phone's sidebar cannot open. State writes need nothing
// extra: `updateInboxState` looks the item up inside the same list, so an id
// from a hidden thread is simply not found.
//
// Who counts as the companion is decided by the private launch proof, not by
// the `x-murage-companion` marker. The marker is a request for the narrow
// answer and any local process can type it; the proof is a per-launch secret
// only the sidecar holds (`companion-authority.ts`). A request with neither
// proof gets what it always got here: nothing.
import type { IncomingHttpHeaders } from "node:http";

import { companionAuthorized } from "./companion-authority.ts";
import type { InboxAccess, InboxThread } from "./inbox.ts";
import { requestSurface, visibleToCompanion, type VisibilityStore } from "./sse-visibility.ts";

interface TitledThread { threadId: string; title?: string }

/** The slice of `Store` the roster needs. Structural, like `VisibilityStore`,
 *  so the tests can state the world without a data directory. */
export interface InboxRosterStore extends VisibilityStore {
  readonly bots: ReadonlyArray<{ id: string; name: string; threadId: string; tasks?: readonly TitledThread[] }>;
  readonly groups: ReadonlyArray<{ name: string; threadId: string; tasks?: readonly TitledThread[] }>;
}

/** Which door an Inbox request came through. `unproven` is every remote
 *  caller neither the desktop nor the companion vouched for. */
export type InboxDoor = "desktop" | "companion" | "unproven";

export function inboxDoor(
  headers: IncomingHttpHeaders,
  query: URLSearchParams | null,
  proven: (headers: IncomingHttpHeaders) => boolean = companionAuthorized,
): InboxDoor {
  if (requestSurface(headers, query) === "desktop") return "desktop";
  return proven(headers) ? "companion" : "unproven";
}

/** The two Inbox routes, and only those, that a proven companion may reach
 *  past the desktop-authority gate (`desktop-policy.ts` lists `/api/inbox` as
 *  a whole prefix). Everything else under the prefix stays desktop-only. */
export function companionInboxRoute(method: string, path: string): boolean {
  return (method === "GET" && path === "/api/inbox") || (method === "POST" && path === "/api/inbox/state");
}

/** Every thread on the machine with its Inbox label. Moved here unchanged
 *  from the two routes in `index.ts` that each spelled it out. */
export function inboxThreads(store: InboxRosterStore): InboxThread[] {
  const label = (name: string, tasks: readonly TitledThread[] | undefined, threadId: string) =>
    [name, tasks?.find(task => task.threadId === threadId)?.title].filter(Boolean).join(" · ");
  const threadIds = (record: { threadId: string; tasks?: readonly TitledThread[] }) =>
    [...new Set([record.threadId, ...(record.tasks ?? []).map(task => task.threadId)])];
  return [
    ...store.bots.flatMap(bot => threadIds(bot).map(threadId => ({ threadId, label: label(bot.name, bot.tasks, threadId), botId: bot.id }))),
    ...store.groups.flatMap(group => threadIds(group).map(threadId => ({ threadId, label: label(group.name, group.tasks, threadId) }))),
  ];
}

export function inboxAccessFor(store: InboxRosterStore, door: InboxDoor): InboxAccess {
  if (door === "unproven") return { owner: false, threads: [] };
  const threads = inboxThreads(store);
  if (door === "desktop") return { owner: true, threads };
  return { owner: true, threads: threads.filter(thread => visibleToCompanion(store, { scope: "thread", threadId: thread.threadId })) };
}
