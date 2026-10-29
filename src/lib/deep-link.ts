// A link to one message: `#open=<threadId>&msg=<messageId>` (spec §3.6).
//
// There was no URL routing at all before this. The fragment is used rather
// than a path because the door serves the same shell for every path and a
// fragment never reaches a server log. Only a fragment that STARTS with
// `open=` is ours: `/enter#murage_pair_…` belongs to the door and is left
// exactly as it is.
import { openNotificationTarget, type Action } from "@/state/store";
import { DEEP_LINK_MAX_PAGES } from "@/lib/scrollback";

// `#open=bot:<id>&compose=1` opens that bot's main chat with the composer focused; `#open=<t>&compose=1[&again=<id>]` does the same for a
// thread, and `again` prefills the composer with that message's text. Nothing in a compose link ever sends (lib/compose-link.ts).
export interface DeepLinkTarget {
  threadId?: string;
  botId?: string;
  messageId?: string;
  compose?: true;
  again?: string;
}

// openNotificationTarget's routing state (bot/group id + threadId + tasks)
// is not exported, so its own third parameter's type is reused here rather
// than duplicated or widened to the full AppState.
type RoutingState = Parameters<typeof openNotificationTarget>[2];

const MAX_ID = 512;
const id = (value: string | null): value is string => value !== null && value.length > 0 && value.length <= MAX_ID;

export function parseOpenHash(hash: string): DeepLinkTarget | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.startsWith("open=")) return null;
  const params = new URLSearchParams(raw);
  const open = params.get("open");
  const messageId = params.get("msg");
  const composes = params.getAll("compose");
  const agains = params.getAll("again");
  const botOpen = open?.startsWith("bot:") === true;
  // The compose shapes are exact: anything else with a compose, bot: or again part is refused, never half-read.
  if (composes.length > 1 || (composes.length === 1 && composes[0] !== "1")) return null;
  const compose = composes.length === 1;
  if (agains.length > 1 || (agains.length === 1 && (!compose || botOpen || !id(agains[0] ?? null)))) return null;
  if (botOpen) {
    const botId = open.slice(4);
    if (!compose || messageId !== null || !id(botId)) return null;
    return { botId, compose: true };
  }
  if (!id(open)) return null;
  if (compose) {
    if (messageId !== null) return null;
    return agains.length === 1 ? { threadId: open, compose: true, again: agains[0]! } : { threadId: open, compose: true };
  }
  return id(messageId) ? { threadId: open, messageId } : { threadId: open };
}

/** The current URL without its fragment, for history.replaceState. */
export function openHashHref(pathname: string, search: string): string {
  return `${pathname}${search}`;
}

/** Targets that arrive before the first snapshot wait for it. Only the
 * newest waits: three quick taps on three notifications mean the last one. */
export function createDeepLinkQueue(open: (target: DeepLinkTarget) => void) {
  let isReady = false;
  let pending: DeepLinkTarget | null = null;
  return {
    push(target: DeepLinkTarget) {
      if (isReady) open(target);
      else pending = target;
    },
    ready() {
      if (isReady) return;
      isReady = true;
      const target = pending;
      pending = null;
      if (target) open(target);
    },
  };
}

export function openDeepLink(target: DeepLinkTarget, state: RoutingState, dispatch: (action: Action) => void): boolean {
  // A bot link opens that bot's main chat: the bot must be one this device holds.
  const threadId = target.threadId ?? state.bots.find((bot) => bot.id === target.botId)?.threadId;
  if (!threadId) return false;
  const placed = openNotificationTarget(dispatch, { ...(target.botId ? { botId: target.botId } : {}), threadId }, state);
  // focusMessage pages back through scrollback until the message is held
  // (store.tsx, the wrapped "focusMessage" case). A link walks at most
  // DEEP_LINK_MAX_PAGES, and stops sooner once the thread has nothing older;
  // either way the reader is already on the thread.
  if (placed && target.messageId) {
    dispatch({ type: "focusMessage", threadId, messageId: target.messageId, maxPages: DEEP_LINK_MAX_PAGES });
  }
  return placed;
}
