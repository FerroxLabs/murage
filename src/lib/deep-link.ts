// A link to one message: `#open=<threadId>&msg=<messageId>` (spec §3.6).
//
// There was no URL routing at all before this. The fragment is used rather
// than a path because the door serves the same shell for every path and a
// fragment never reaches a server log. Only a fragment that STARTS with
// `open=` is ours: `/enter#murage_pair_…` belongs to the door and is left
// exactly as it is.
import { openNotificationTarget, type Action } from "@/state/store";

export interface DeepLinkTarget {
  threadId: string;
  messageId?: string;
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
  const threadId = params.get("open");
  const messageId = params.get("msg");
  if (!id(threadId)) return null;
  return id(messageId) ? { threadId, messageId } : { threadId };
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
  const placed = openNotificationTarget(dispatch, { threadId: target.threadId }, state);
  // focusMessage pages back through scrollback until the message is held
  // (store.tsx, the wrapped "focusMessage" case).
  if (placed && target.messageId) dispatch({ type: "focusMessage", threadId: target.threadId, messageId: target.messageId });
  return placed;
}
