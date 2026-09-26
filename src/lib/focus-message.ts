// Landing on a message: after a search hit, scroll the row into view and
// flash it. The wrapper carrying data-mid is the transcript row itself, or a
// `display: contents` step inside a run; its last child (the bubble or chip,
// after any day separator) is what gets scrolled and highlighted. The
// enclosing `.transcript-row` is marked `data-flash` for the flash, so a seen
// row's paint containment does not clip the ring (styles.css).
import { useEffect } from "react";
import { api, useStore, type Action, type AppState } from "@/state/store";
import type { SearchHit } from "@/lib/search-hit";
import { MESSAGE_PAGE_SIZE } from "@/lib/scrollback";

/** Select and prepare the exact conversation represented by a search hit. */
export async function landOnSearchHit(
  hit: SearchHit,
  state: Pick<AppState, "bots" | "groups">,
  dispatch: React.Dispatch<Action>,
): Promise<void> {
  const ownerId = hit.botId ?? hit.groupId;
  const bot = hit.botId ? state.bots.find((candidate) => candidate.id === hit.botId) : undefined;
  const group = hit.groupId ? state.groups.find((candidate) => candidate.id === hit.groupId) : undefined;
  if (!ownerId || (!bot && !group)) throw new Error("That conversation is no longer available.");

  dispatch({ type: "select", id: ownerId,threadId:hit.threadId });
  if (bot && bot.threadId !== hit.threadId) {
    // A page, like every switch; the focus below pages back to the hit.
    const result = await api(`/api/bots/${bot.id}/tasks/${hit.threadId}?messages=${MESSAGE_PAGE_SIZE}`, { method: "POST" });
    if (result?.bot) dispatch({ type: "taskSwitched", bot: result.bot });
  }
  if (group && group.threadId !== hit.threadId) {
    const result = await api(`/api/groups/${group.id}/tasks/${hit.threadId}?messages=${MESSAGE_PAGE_SIZE}`, { method: "POST" });
    if (result?.group) dispatch({ type: "groupPatched", group: result.group });
  }
  if (bot && !hit.onActivePath) {
    const branch = await api(`/api/bots/${bot.id}/active-branch`, {
      method: "POST",
      body: JSON.stringify({ messageId: hit.messageId,threadId:hit.threadId }),
    });
    if (branch?.activeLeafId) {
      dispatch({ type: "threadActive", threadId: hit.threadId, activeLeafId: branch.activeLeafId });
    }
  }
  dispatch({ type: "focusMessage", threadId: hit.threadId, messageId: hit.messageId });
}

export const FLASH_MS = 2400;
/** The attribute that draws the ring (styles.css). Not a class: the bubble's
 * className belongs to React, and the re-render that opens the transcript
 * window around the hit rewrote it within a frame, so the ring added as
 * Tailwind classes vanished before it was ever painted (0.1.60 Linux D10).
 * React leaves attributes it does not render alone. */
export const FLASH_TARGET = "data-flash-target";
const RECHECK_MS = 100;

/** Find the row for `messageId` (retrying briefly: messages may land a tick
 * after the task switch), scroll to it and flash it: `data-flash-target` on
 * the bubble, `data-flash` on its `.transcript-row` so paint containment does
 * not clip the ring. If the row is re-rendered or remounted while the flash
 * lasts, the marks are put back on the new element. `onLanded` runs once the
 * flash has begun. The returned cleanup stops the search and removes the
 * flash at once. */
export function flashMessage(
  root: Pick<ParentNode, "querySelector">,
  messageId: string,
  onLanded: () => void,
  reducedMotion: () => boolean = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
): () => void {
  let tries = 0;
  let cancelled = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  let recheck: ReturnType<typeof setInterval> | null = null;
  let target: HTMLElement | null = null;
  let row: HTMLElement | null = null;
  const find = () => {
    const wrapper = root.querySelector<HTMLElement>(`[data-mid="${CSS.escape(messageId)}"]`);
    return { wrapper, bubble: (wrapper?.lastElementChild as HTMLElement | null) ?? null };
  };
  const unmark = () => {
    target?.removeAttribute(FLASH_TARGET);
    row?.removeAttribute("data-flash");
  };
  const mark = (wrapper: HTMLElement | null, bubble: HTMLElement) => {
    if (bubble !== target) target?.removeAttribute(FLASH_TARGET);
    const nextRow = wrapper?.closest<HTMLElement>(".transcript-row") ?? null;
    if (nextRow !== row) row?.removeAttribute("data-flash");
    target = bubble;
    row = nextRow;
    row?.setAttribute("data-flash", "");
    target.setAttribute(FLASH_TARGET, "");
  };
  const attempt = () => {
    if (cancelled) return;
    const { wrapper, bubble } = find();
    if (!bubble) {
      if (tries++ < 20) retryTimer = setTimeout(attempt, 100);
      return;
    }
    mark(wrapper, bubble);
    bubble.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    onLanded();
    // A remount replaces the element; keep the ring on whatever now holds it.
    recheck = setInterval(() => {
      const again = find();
      if (again.bubble && (again.bubble !== target || !again.bubble.hasAttribute?.(FLASH_TARGET))) mark(again.wrapper, again.bubble);
    }, RECHECK_MS);
    flashTimer = setTimeout(() => {
      if (recheck) clearInterval(recheck);
      recheck = null;
      unmark();
    }, FLASH_MS);
  };
  attempt();
  return () => {
    cancelled = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (flashTimer) clearTimeout(flashTimer);
    if (recheck) clearInterval(recheck);
    unmark();
  };
}

export function useFocusMessage(threadId: string, ready: boolean) {
  const { state, dispatch } = useStore();
  const focus = state.focusMessage;
  useEffect(() => {
    if (!focus || focus.consumed || focus.threadId !== threadId || !ready) return;
    // Consume only after the target is mounted and the flash has begun.
    // `consumed` is intentionally not an effect dependency, so this active
    // flash survives the bookkeeping update while future remounts ignore it.
    return flashMessage(document, focus.messageId, () => dispatch({ type: "focusMessageConsumed", nonce: focus.nonce }));
  }, [dispatch, focus?.nonce, focus?.threadId, focus?.messageId, threadId, ready]);
}
