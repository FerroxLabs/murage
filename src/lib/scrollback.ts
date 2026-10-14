// Scrollback across the network (upstream #1527, 08b479d7).
//
// The desktop used to hydrate every message of every thread: a room with a
// few thousand messages made startup and every thread switch slow, and a
// companion over a tunnel could not buffer the response at all. The client
// now holds the newest page of each open thread and asks the server for the
// page before its oldest held message when the reader scrolls up, or when a
// jump (search hit, Inbox "Open request", a pin, a reply quote) lands on a
// message it does not hold yet.
//
// The reducer owns the state (`loadingOlder`, `transcriptGeneration`, the
// prepend); this module owns the requests, so the store and its tests share
// one implementation of "which page next, and is the answer still wanted".
import type { AppState, Message } from "@/state/store";

/** Messages per thread in a snapshot and a thread switch, and per scrollback
 * page. Larger than one transcript window's worth of new rows would ever
 * need, and matched by the server's SWITCH_FRAME_PAGE so the switch frame and
 * the switch reply hold the same rows. */
export const MESSAGE_PAGE_SIZE = 100;

/** A phone's boot page per thread (spec §6 phone mode). One row, which the
 * server widens to reach back to every open request card and the active
 * branch head (server newestPageLimit), so a phone still sees what needs it
 * and each thread's latest line, without every thread's history. `0` would
 * be settings only: no cards, no latest line, and nothing to page back from. */
export const PHONE_HYDRATE_PAGE = 1;

/** The desktop's boot page per thread: enough for the sidebar preview and a
 * first paint. A hundred rows for every bot and room made /api/bots 4.65 MB at
 * 43 bots, and twenty still 2.44 MB (p95 322 ms). The server widens a page to
 * reach every open request card and the active branch head, so a few rows hold
 * the sidebar's last line; the conversation on screen tops up to a full page
 * at once (store topUpThread, needsNewestPage) and older pages load as before. */
export const DESKTOP_HYDRATE_PAGE = 3;

export function hydratePageSize(phone: boolean): number {
  return phone ? PHONE_HYDRATE_PAGE : DESKTOP_HYDRATE_PAGE;
}

/** A conversation holding less than a newest page while the server has more:
 * a slim boot page (phone or desktop). A thread switch always holds at least a
 * full page when there is more. */
export function needsNewestPage(owner: { messages: Message[]; hasMore?: boolean }): boolean {
  return holdsPreviewRows(owner) || (Boolean(owner.hasMore) && owner.messages.length < MESSAGE_PAGE_SIZE);
}

/** The roster carries cut rows (`truncated`); only the newest page, asked for without a cursor, brings them whole. */
export const holdsPreviewRows = (owner: { messages: Message[] }): boolean => owner.messages.some((message) => message.truncated === true);

/** The largest page the server hands out; a jump walks back in these. */
export const MESSAGE_PAGE_MAX = 200;

/** A jump gives up after this many pages (40,000 messages) rather than
 * walking an enormous thread down one request at a time forever. */
export const MAX_JUMP_PAGES = 200;

/** A link someone tapped walks back only this far (1,000 messages) and then
 * leaves the reader on the thread: a crafted `msg=` must not page a phone
 * through a whole transcript over cellular (final review M5). */
export const DEEP_LINK_MAX_PAGES = 5;

type OlderMessagesAction =
  | { type: "loadOlderMessages"; threadId: string }
  | { type: "olderMessages"; threadId: string; generation: number; messages: Message[]; hasMore: boolean; olderFrom?: string | null }
  | { type: "newestMessages"; threadId: string; generation: number; messages: Message[]; hasMore: boolean; olderFrom?: string | null };

export interface ScrollbackPage {
  messages?: Message[];
  hasMore?: boolean;
  /** The next ancestor to page back to, when the page is a branch page. */
  olderFrom?: string | null;
}

export interface ScrollbackDeps {
  /** The newest state the store has rendered. */
  getState: () => Pick<AppState, "bots" | "groups" | "transcriptGeneration">;
  dispatch: (action: OlderMessagesAction) => void;
  request: (path: string) => Promise<ScrollbackPage>;
  onError: (error: unknown) => void;
  /** Resolves after the store has had a chance to render (tests pass a
   * microtask). A jump usually follows a thread switch dispatched a moment
   * earlier, and `getState` only sees it once React has committed it. */
  settle?: () => Promise<void>;
}

/** Where a jump target stands after `loadThrough`. */
export type JumpOutcome = "held" | "fetched" | "missing";

const ownerOf = (state: Pick<AppState, "bots" | "groups">, threadId: string) =>
  state.bots.find((bot) => bot.threadId === threadId) ?? state.groups.find((group) => group.threadId === threadId);

const pagePath = (threadId: string, query: string) => `/api/threads/${encodeURIComponent(threadId)}/messages?${query}`;

export function createScrollback(deps: ScrollbackDeps) {
  const settle = deps.settle ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
  /** One page walk per thread at a time: a scroll-triggered page and a jump
   * asking from the same oldest message would fetch the same rows twice. */
  const busy = new Map<string, Promise<unknown>>();
  /** Threads whose `busy` walk is a `loadOlder` page, which clears the
   * loading flag itself when it lands; any other walk is a jump's. */
  const paging = new Set<string>();
  const exclusive = <T>(threadId: string, task: () => Promise<T>): Promise<T> => {
    const running = task().finally(() => {
      if (busy.get(threadId) === running) busy.delete(threadId);
    });
    busy.set(threadId, running);
    return running;
  };
  const generationOf = (threadId: string) => deps.getState().transcriptGeneration[threadId] ?? 0;

  /** The page before the oldest message this client holds. A no-op while a
   * page for the thread is already on the wire. */
  const loadOlder = (threadId: string): Promise<void> | undefined => {
    const owner = ownerOf(deps.getState(), threadId);
    // Captured now: `loadOlderMessages` does not move it, so this is the
    // value the reducer compares when the answer lands.
    const generation = generationOf(threadId);
    if (busy.has(threadId)) {
      // A jump's walk holds the thread and may never answer this request
      // (a probe, a message already held): clear the flag the store set, or
      // "Load earlier" stays disabled. Our own page clears it when it lands.
      if (!paging.has(threadId)) deps.dispatch({ type: "olderMessages", threadId, generation, messages: [], hasMore: Boolean(owner?.hasMore) });
      return undefined;
    }
    deps.dispatch({ type: "loadOlderMessages", threadId });
    if (owner && holdsPreviewRows(owner)) {
      // The roster sent cut rows. Older pages only prepend, so the newest page is fetched whole and replaces them.
      paging.add(threadId);
      return exclusive(threadId, async () => {
        try {
          const page = await deps.request(pagePath(threadId, `limit=${MESSAGE_PAGE_SIZE}`));
          deps.dispatch({ type: "newestMessages", threadId, generation, messages: page.messages ?? [], hasMore: Boolean(page.hasMore), ...(page.olderFrom !== undefined ? { olderFrom: page.olderFrom } : {}) });
        } catch (error) {
          deps.dispatch({ type: "olderMessages", threadId, generation, messages: [], hasMore: Boolean(owner.hasMore) });
          deps.onError(error);
        } finally {
          paging.delete(threadId);
        }
      });
    }
    const before = owner?.messages[0]?.id;
    if (!owner?.hasMore || !before) {
      // Nothing to page back from: clear the flag rather than wait for a
      // response that is not coming.
      deps.dispatch({ type: "olderMessages", threadId, generation, messages: [], hasMore: false });
      return undefined;
    }
    paging.add(threadId);
    return exclusive(threadId, async () => {
      try {
        // A branch page is paged back along the branch's own parent links
        // (`branchFrom`); storage order says nothing about ancestry once a
        // thread has forked. Any other page is paged back by storage order.
        const cursor = owner.olderFrom && !owner.messages.some((m) => m.id === owner.olderFrom) ? owner.olderFrom : undefined;
        const page = await deps.request(pagePath(threadId, cursor
          ? `limit=${MESSAGE_PAGE_SIZE}&branchFrom=${encodeURIComponent(cursor)}`
          : `limit=${MESSAGE_PAGE_SIZE}&before=${encodeURIComponent(before)}`));
        deps.dispatch({ type: "olderMessages", threadId, generation, messages: page.messages ?? [], hasMore: Boolean(page.hasMore), ...(cursor ? { olderFrom: page.olderFrom ?? null } : {}) });
      } catch (error) {
        // Clear the flag on the way out, or scrolling up never asks again.
        deps.dispatch({ type: "olderMessages", threadId, generation, messages: [], hasMore: true });
        deps.onError(error);
      } finally {
        paging.delete(threadId);
      }
    });
  };

  /** Page back until `messageId` is held, so a jump can open a window around
   * it. The walk is contiguous — pages always continue from the oldest held
   * row — so the transcript never has a hole the reader could scroll across
   * without noticing. "missing" means the message is not in this thread, the
   * thread moved on while pages were in flight, or the walk hit its cap
 * (`maxPages`, which a deep link lowers to DEEP_LINK_MAX_PAGES). */
  const loadThrough = async (threadId: string, messageId: string, maxPages = MAX_JUMP_PAGES): Promise<JumpOutcome> => {
    // The switch that precedes most jumps has been dispatched, not rendered.
    let owner = ownerOf(deps.getState(), threadId);
    for (let tries = 0; !owner && tries < 20; tries++) {
      await settle();
      owner = ownerOf(deps.getState(), threadId);
    }
    for (let pending = busy.get(threadId); pending; pending = busy.get(threadId)) await pending.catch(() => {});
    owner = ownerOf(deps.getState(), threadId);
    if (!owner) return "missing";
    if (owner.messages.some((message) => message.id === messageId)) return "held";
    if (!owner.hasMore || !owner.messages[0]) return "missing";
    const start = owner.messages[0].id;
    return exclusive(threadId, async (): Promise<JumpOutcome> => {
      // One row first: an id from another thread (or a deleted message) must
      // not walk the whole transcript down to find out.
      try {
        await deps.request(pagePath(threadId, `around=${encodeURIComponent(messageId)}&limit=1`));
      } catch {
        return "missing";
      }
      const generation = generationOf(threadId);
      let before = start;
      // The same cursor loadOlder pages with: a branch page is walked back
      // along the branch's own parent links, so a late-stored ancestor spliced
      // in earlier in the branch is reached, and the cursor stays right.
      let cursor: string | undefined = owner.olderFrom && !owner.messages.some((m) => m.id === owner.olderFrom) ? owner.olderFrom : undefined;
      for (let pages = 0; pages < maxPages; pages++) {
        if (generationOf(threadId) !== generation) return "missing";
        deps.dispatch({ type: "loadOlderMessages", threadId });
        let page: ScrollbackPage;
        try {
          page = await deps.request(pagePath(threadId, cursor
            ? `limit=${MESSAGE_PAGE_MAX}&branchFrom=${encodeURIComponent(cursor)}`
            : `limit=${MESSAGE_PAGE_MAX}&before=${encodeURIComponent(before)}`));
        } catch (error) {
          deps.dispatch({ type: "olderMessages", threadId, generation, messages: [], hasMore: true });
          deps.onError(error);
          return "missing";
        }
        const messages = page.messages ?? [];
        deps.dispatch({ type: "olderMessages", threadId, generation, messages, hasMore: Boolean(page.hasMore), ...(cursor ? { olderFrom: page.olderFrom ?? null } : {}) });
        if (messages.some((message) => message.id === messageId)) return "fetched";
        if (!page.hasMore || !messages[0]) return "missing";
        before = messages[0].id;
        if (cursor) cursor = page.olderFrom ?? undefined;
      }
      return "missing";
    });
  };

  return { loadOlder, loadThrough };
}

/** What a call should still read out: every message it has not heard that
 * reached the client after the oldest one it has (the transcript it found on
 * screen when it started, plus what it heard since). Position is taken in
 * `arrival` order, the thread's held rows as they reached the client: a page
 * of scrollback prepended mid-call lands in front of everything, so it is
 * history, not news, and is never recited, while a live message is always
 * added behind what the client already held. In the transcript a live
 * message can still sit anywhere: text a Fuigo hosted tool row interrupted
 * is saved in front of that row once its response completes (Store
 * insertMessageBefore), even in front of the oldest row a phone's one-row
 * boot page held. That text is news too; whether a later reply was already
 * said is the caller's choice (see heardReplyAfter). Without `arrival` the
 * transcript order stands in for it. */
export function unheardMessages<T extends { id: string }>(
  messages: readonly T[],
  heard: ReadonlySet<string>,
  arrival: readonly { id: string }[] = messages,
): T[] {
  let oldestHeard = -1;
  for (let index = 0; index < arrival.length; index++) {
    if (heard.has(arrival[index]!.id)) {
      oldestHeard = index;
      break;
    }
  }
  const live = new Set<string>();
  for (let index = oldestHeard + 1; index < arrival.length; index++) live.add(arrival[index]!.id);
  return messages.filter((message) => live.has(message.id) && !heard.has(message.id));
}

/** What a call counts as already heard when it starts: every row on screen
 * and every other row the thread already holds. A lead-in saved in front of a
 * row the client has not loaded is held but not yet on screen; loading the
 * older page mid-call joins it to the transcript at a storage position after
 * the rows the call heard, so without this it would be recited as news. Only
 * rows that reach the client live during the call may be narrated. */
export function callStartHeard(visible: readonly { id: string }[], held: readonly { id: string }[]): Set<string> {
  const heard = new Set<string>();
  for (const message of visible) heard.add(message.id);
  for (const message of held) heard.add(message.id);
  return heard;
}

/** True when a message the call already heard, and that `isReply` accepts,
 * sits after `message` in the transcript. A call says only the newest reply
 * of a burst; text saved in front of an answer that was already spoken is
 * the lead-in to that answer, and reading it out afterwards would put the
 * conversation out of order. With no later reply heard, the inserted text is
 * the only answer the person gets, so it is said. */
export function heardReplyAfter<T extends { id: string }>(
  messages: readonly T[],
  heard: ReadonlySet<string>,
  message: T,
  isReply: (candidate: T) => boolean,
): boolean {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index < 0) return false;
  for (let later = index + 1; later < messages.length; later++) {
    const candidate = messages[later]!;
    if (heard.has(candidate.id) && isReply(candidate)) return true;
  }
  return false;
}
