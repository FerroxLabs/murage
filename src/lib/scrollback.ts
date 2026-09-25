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

export function hydratePageSize(phone: boolean): number {
  return phone ? PHONE_HYDRATE_PAGE : MESSAGE_PAGE_SIZE;
}

/** A conversation holding less than a newest page while the server has more:
 * a phone's slim boot page. A snapshot or switch always holds at least a full
 * page when there is more, so on the desktop this is never true. */
export function needsNewestPage(owner: { messages: Message[]; hasMore?: boolean }): boolean {
  return Boolean(owner.hasMore) && owner.messages.length < MESSAGE_PAGE_SIZE;
}

/** The largest page the server hands out; a jump walks back in these. */
export const MESSAGE_PAGE_MAX = 200;

/** A jump gives up after this many pages (40,000 messages) rather than
 * walking an enormous thread down one request at a time forever. */
export const MAX_JUMP_PAGES = 200;

type OlderMessagesAction =
  | { type: "loadOlderMessages"; threadId: string }
  | { type: "olderMessages"; threadId: string; generation: number; messages: Message[]; hasMore: boolean };

export interface ScrollbackPage {
  messages?: Message[];
  hasMore?: boolean;
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
        const page = await deps.request(pagePath(threadId, `limit=${MESSAGE_PAGE_SIZE}&before=${encodeURIComponent(before)}`));
        deps.dispatch({ type: "olderMessages", threadId, generation, messages: page.messages ?? [], hasMore: Boolean(page.hasMore) });
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
   * thread moved on while pages were in flight, or the walk hit its cap. */
  const loadThrough = async (threadId: string, messageId: string): Promise<JumpOutcome> => {
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
      for (let pages = 0; pages < MAX_JUMP_PAGES; pages++) {
        if (generationOf(threadId) !== generation) return "missing";
        deps.dispatch({ type: "loadOlderMessages", threadId });
        let page: ScrollbackPage;
        try {
          page = await deps.request(pagePath(threadId, `limit=${MESSAGE_PAGE_MAX}&before=${encodeURIComponent(before)}`));
        } catch (error) {
          deps.dispatch({ type: "olderMessages", threadId, generation, messages: [], hasMore: true });
          deps.onError(error);
          return "missing";
        }
        const messages = page.messages ?? [];
        deps.dispatch({ type: "olderMessages", threadId, generation, messages, hasMore: Boolean(page.hasMore) });
        if (messages.some((message) => message.id === messageId)) return "fetched";
        if (!page.hasMore || !messages[0]) return "missing";
        before = messages[0].id;
      }
      return "missing";
    });
  };

  return { loadOlder, loadThrough };
}

/** What a call should still read out: messages after the newest one it has
 * already heard (or found on screen when it started). A page of scrollback
 * prepended mid-call is history, not news, and must not be recited — the
 * held transcript only ever grows at the front through such a page, since
 * every live message is appended. */
export function unheardMessages<T extends { id: string }>(messages: readonly T[], heard: ReadonlySet<string>): T[] {
  let newestHeard = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (heard.has(messages[index]!.id)) {
      newestHeard = index;
      break;
    }
  }
  return messages.slice(newestHeard + 1).filter((message) => !heard.has(message.id));
}
