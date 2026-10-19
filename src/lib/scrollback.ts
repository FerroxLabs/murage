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
import { applyTranscriptInput, legacyTranscriptInput, nextPage, wantsNewest, type SeqTranscript } from "@/state/transcript-seq";

/** Messages per thread in a snapshot and a thread switch, and per scrollback
 * page. Larger than one transcript window's worth of new rows would ever
 * need, and matched by the server's SWITCH_FRAME_PAGE so the switch frame and
 * the switch reply hold the same rows. */
export const MESSAGE_PAGE_SIZE = 100;

/** A conversation the boot roster sent without rows (`view=sidebar`), a bot whose rows predate a rehydrate, or a numbered room whose next page
 * is the newest one (ROOM-ORDER-DESIGN r8 R9 step 1: its tail unknown, its newest held row below the tail or unvouched), and whose first page
 * is not on the wire yet. The conversation on screen fetches it (store top-up effect, `loadFirstPage`). Desktop and phone boot the same way. */
export function needsFirstPage(owner: { messagesUnloaded?: true; pageStale?: true; firstPageEvents?: unknown[]; numbered?: true; tail?: number; messages?: Message[] }): boolean {
  if (owner.firstPageEvents) return false;
  if (owner.messagesUnloaded === true || owner.pageStale === true) return true;
  return owner.numbered === true && wantsNewest({ messages: owner.messages ?? [], numbered: true, tail: owner.tail });
}

/** The transcript keys transcript-seq.ts reads, of a bot or a room. */
const transcriptOf = (owner: { messages: Message[]; hasMore?: boolean; olderFrom?: string; messagesUnloaded?: true; numbered?: true; tail?: number; legacyGaps?: string[] }): SeqTranscript => ({
  messages: owner.messages, hasMore: owner.hasMore, olderFrom: owner.olderFrom, messagesUnloaded: owner.messagesUnloaded, numbered: owner.numbered, tail: owner.tail,
  legacyGaps: owner.legacyGaps,
});

/** The largest page the server hands out; a jump walks back in these. */
export const MESSAGE_PAGE_MAX = 200;

/** A jump gives up after this many pages (40,000 messages) rather than
 * walking an enormous thread down one request at a time forever. */
export const MAX_JUMP_PAGES = 200;

/** A link someone tapped walks back only this far (1,000 messages) and then
 * leaves the reader on the thread: a crafted `msg=` must not page a phone
 * through a whole transcript over cellular (final review M5). */
export const DEEP_LINK_MAX_PAGES = 5;

/** The thread page route's `view=switch` answer: the page a switch to the thread opens on (branch head, cards beside, version). */
export interface FirstPageAnswer {
  messages?: Message[];
  hasMore?: boolean;
  olderFrom?: string | null;
  openCards?: Message[];
  openCardsLeaf?: string;
  openCardsPending?: boolean;
  activeLeafId?: string | null;
  version?: string;
  /** r8 wire contract: the thread's newest number, on a numbered thread's page. */
  newestSeq?: number;
}

type OlderMessagesAction =
  | { type: "loadOlderMessages"; threadId: string }
  | { type: "olderMessages"; threadId: string; generation: number; messages: Message[]; hasMore: boolean; olderFrom?: string | null; before?: string; newestSeq?: number }
  | { type: "firstPageStarted"; threadId: string }
  | { type: "firstPage"; threadId: string; generation: number; page: FirstPageAnswer }
  | { type: "firstPageFailed"; threadId: string };

export interface ScrollbackPage {
  messages?: Message[];
  hasMore?: boolean;
  /** The next ancestor to page back to, when the page is a branch page. */
  olderFrom?: string | null;
  newestSeq?: number;
}

export interface ScrollbackDeps {
  /** The newest state the store has rendered. */
  getState: () => Pick<AppState, "bots" | "groups" | "transcriptGeneration">;
  dispatch: (action: OlderMessagesAction) => void;
  request: (path: string) => Promise<ScrollbackPage & FirstPageAnswer>;
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
  /** Threads whose `busy` walk is a first page. */
  const firstPages = new Set<string>();

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
    // r6 Q4 / r8 R9: the next page by number (the newest page, the newest gap, an unvouched run, the front); a legacy one before the oldest row.
    const ask = owner ? nextPage(transcriptOf(owner)) : undefined;
    if (!ask || "newest" in ask) {
      // Nothing to page back from, or the newest page comes first (the first-page path asks it): clear the flag rather than wait for a
      // response that is not coming.
      deps.dispatch({ type: "olderMessages", threadId, generation, messages: [], hasMore: Boolean(ask && owner?.hasMore) });
      return ask ? loadFirstPage(threadId) : undefined;
    }
    const anchor = ask;
    paging.add(threadId);
    return exclusive(threadId, async () => {
      try {
        // A branch page is paged back along the branch's own parent links
        // (`branchFrom`); storage order says nothing about ancestry once a
        // thread has forked. Any other page is paged back by storage order.
        const cursor = anchor.olderFrom;
        const page = await deps.request(pagePath(threadId, cursor
          ? `limit=${MESSAGE_PAGE_SIZE}&branchFrom=${encodeURIComponent(cursor)}`
          : `limit=${MESSAGE_PAGE_SIZE}&before=${encodeURIComponent(anchor.before)}`));
        deps.dispatch({ type: "olderMessages", threadId, generation, messages: page.messages ?? [], hasMore: Boolean(page.hasMore), before: anchor.before, ...(cursor ? { olderFrom: page.olderFrom ?? null } : {}), ...(typeof page.newestSeq === "number" ? { newestSeq: page.newestSeq } : {}) });
      } catch (error) {
        // Clear the flag on the way out, or scrolling up never asks again. An empty page leaves a gap as it was.
        deps.dispatch({ type: "olderMessages", threadId, generation, messages: [], hasMore: true, before: anchor.before });
        deps.onError(error);
      } finally {
        paging.delete(threadId);
      }
    });
  };

  /** The first page of a conversation that holds no rows yet (`needsFirstPage`): the page a switch opens on, through the thread page route with
   * `view=switch` (branch head within reach or the head's branch page, open cards beside, version). Live events for the conversation queue in
   * the reducer while it is on the wire and are replayed over the page there (`firstPage`), so nothing that lands meanwhile is lost or
   * overwritten. A failure leaves the conversation unloaded; sends are never held for it. Shares the per-thread walk, so a jump waits for it. */
  const loadFirstPage = (threadId: string): Promise<void> => {
    const pending = busy.get(threadId);
    if (pending && firstPages.has(threadId)) return pending.then(() => undefined, () => undefined);
    const owner = ownerOf(deps.getState(), threadId);
    if (!owner || !needsFirstPage(owner)) return pending ? pending.then(() => undefined, () => undefined) : Promise.resolve();
    deps.dispatch({ type: "firstPageStarted", threadId });
    // Captured after the start: the reducer compares it when the page lands, and anything that replaces the transcript meanwhile moves it.
    const generation = generationOf(threadId);
    firstPages.add(threadId);
    const run = async () => {
      try {
        const page = await deps.request(pagePath(threadId, `view=switch&limit=${MESSAGE_PAGE_SIZE}`));
        deps.dispatch({ type: "firstPage", threadId, generation, page });
      } catch (error) {
        deps.dispatch({ type: "firstPageFailed", threadId });
        deps.onError(error);
      } finally {
        firstPages.delete(threadId);
      }
    };
    // Behind any walk already running for the thread, never beside it.
    return exclusive(threadId, () => (pending ? pending.catch(() => {}).then(run) : run()));
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
    // A conversation that holds no rows yet takes its first page before the walk (the walk pages back from the oldest row held).
    if (owner && needsFirstPage(owner)) {
      await loadFirstPage(threadId);
      await settle();
      owner = ownerOf(deps.getState(), threadId);
    }
    if (!owner || owner.messagesUnloaded) return "missing";
    if (owner.messages.some((message) => message.id === messageId)) return "held";
    // The walk's own copy of the transcript, laid over page by page exactly as the reducer lays them (transcript-seq.ts), so the next page is
    // known without waiting for a render: by number for a numbered room (r6 Q4), before the oldest held row for a legacy transcript.
    const room = Array.isArray((owner as { memberIds?: unknown }).memberIds);
    let edges: SeqTranscript = transcriptOf(owner as Parameters<typeof transcriptOf>[0]);
    const anchorOf = (t: SeqTranscript) => { const ask = nextPage(t); return ask && "before" in ask ? ask : undefined; };
    if (!anchorOf(edges)) return "missing";
    return exclusive(threadId, async (): Promise<JumpOutcome> => {
      // One row first: an id from another thread (or a deleted message) must
      // not walk the whole transcript down to find out.
      try {
        await deps.request(pagePath(threadId, `around=${encodeURIComponent(messageId)}&limit=1`));
      } catch {
        return "missing";
      }
      const generation = generationOf(threadId);
      for (let pages = 0; pages < maxPages; pages++) {
        if (generationOf(threadId) !== generation) return "missing";
        // The same cursor loadOlder pages with: a branch page is walked back
        // along the branch's own parent links, so a late-stored ancestor spliced
        // in earlier in the branch is reached, and the cursor stays right.
        const anchor = anchorOf(edges);
        if (!anchor) return "missing";
        const cursor = anchor.olderFrom;
        deps.dispatch({ type: "loadOlderMessages", threadId });
        let page: ScrollbackPage;
        try {
          page = await deps.request(pagePath(threadId, cursor
            ? `limit=${MESSAGE_PAGE_MAX}&branchFrom=${encodeURIComponent(cursor)}`
            : `limit=${MESSAGE_PAGE_MAX}&before=${encodeURIComponent(anchor.before)}`));
        } catch (error) {
          deps.dispatch({ type: "olderMessages", threadId, generation, messages: [], hasMore: true, before: anchor.before });
          deps.onError(error);
          return "missing";
        }
        const messages = page.messages ?? [];
        const olderFrom = cursor ? page.olderFrom ?? null : undefined;
        const newestSeq = typeof page.newestSeq === "number" ? page.newestSeq : undefined;
        deps.dispatch({ type: "olderMessages", threadId, generation, messages, hasMore: Boolean(page.hasMore), before: anchor.before, ...(cursor ? { olderFrom } : {}), ...(newestSeq !== undefined ? { newestSeq } : {}) });
        if (messages.some((message) => message.id === messageId)) return "fetched";
        if (!messages[0]) return "missing";
        const input = { kind: "older" as const, rows: messages, newestSeq, vouched: true, hasMore: Boolean(page.hasMore), olderFrom, before: anchor.before };
        edges = room ? applyTranscriptInput(edges, input) : legacyTranscriptInput(edges, input);
      }
      return "missing";
    });
  };

  return { loadOlder, loadFirstPage, loadThrough };
}

/** How long the store waits before asking for a conversation's first page again after a failed GET: 1 s, 2 s, 4 s ... at most 30 s. */
export const firstPageRetryDelayMs = (failures: number): number => Math.min(1000 * 2 ** Math.max(0, failures - 1), 30_000);

/**
 * The store's first-page top-up (StoreProvider): the conversation on screen that holds no rows yet (`needsFirstPage`) is asked for its
 * first page once per (thread, transcript generation), so a dead link does not loop. A page that comes back failed leaves the
 * conversation unloaded; it is then asked for again after a growing wait (`firstPageRetryDelayMs`), never at once, and never while a
 * page is on the wire, so "Loading messages" is always a page being fetched and not a request that was given up on. Opening the
 * thread again, or the window coming back into view or online (`forget`), asks at once.
 */
export function createFirstPageTopUp(deps: { ask: (threadId: string) => void; later: (run: () => void, ms: number) => () => void }) {
  let asked = "";
  let cancelRetry: (() => void) | undefined;
  const failures = new Map<string, number>();
  const forget = () => {
    asked = "";
    cancelRetry?.();
    cancelRetry = undefined;
  };
  return {
    forget,
    /** One review per render of the top-up effect: `threadId` null when nothing on screen needs its first page, `busy` while one is on
     * the wire. `wake` re-runs the review once the wait is over. */
    review(threadId: string | null, generation: number, busy: boolean, wake: () => void): void {
      if (!threadId) { failures.clear(); return; }
      if (busy) return;
      const key = `${threadId}:${generation}`;
      if (asked !== key) {
        asked = key;
        deps.ask(threadId);
        return;
      }
      if (cancelRetry) return;
      const count = (failures.get(key) ?? 0) + 1;
      failures.set(key, count);
      const cancel = deps.later(() => { cancelRetry = undefined; asked = ""; wake(); }, firstPageRetryDelayMs(count));
      cancelRetry = () => cancel();
    },
  };
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
