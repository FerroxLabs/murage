// Landing on a message: after a search hit, scroll the row into view and
// flash it. The wrapper carrying data-mid is the transcript row itself, or a
// `display: contents` step inside a run; its last child — the bubble/chip,
// after any day separator — is what gets scrolled and highlighted. The
// enclosing `.transcript-row` is marked `data-flash` for the flash, so a seen
// row's paint containment does not clip the ring (styles.css).
import { useEffect } from "react";
import { api, useStore, type Action, type AppState } from "@/state/store";
import type { SearchHit } from "@/lib/search-hit";
import { MESSAGE_PAGE_SIZE } from "@/lib/scrollback";

const FLASH_CLASSES = ["ring-2", "ring-accent/70", "rounded-2xl", "transition-shadow"];

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

export const FLASH_MS = 1800;

/** Find the row for `messageId` (retrying briefly: messages may land a tick
 * after the task switch), scroll to it and flash it: `FLASH_CLASSES` on the
 * bubble, `data-flash` on its `.transcript-row` so paint containment does
 * not clip the ring. `onLanded` runs once the flash has begun. The returned
 * cleanup stops the search and removes the flash at once. */
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
  let target: HTMLElement | null = null;
  let row: HTMLElement | null = null;
  const attempt = () => {
    if (cancelled) return;
    const wrapper = root.querySelector<HTMLElement>(`[data-mid="${CSS.escape(messageId)}"]`);
    target = wrapper?.lastElementChild as HTMLElement | null;
    if (!target) {
      if (tries++ < 20) retryTimer = setTimeout(attempt, 100);
      return;
    }
    row = wrapper?.closest<HTMLElement>(".transcript-row") ?? null;
    row?.setAttribute("data-flash", "");
    target.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    target.classList.add(...FLASH_CLASSES);
    onLanded();
    flashTimer = setTimeout(() => {
      target?.classList.remove(...FLASH_CLASSES);
      row?.removeAttribute("data-flash");
    }, FLASH_MS);
  };
  attempt();
  return () => {
    cancelled = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (flashTimer) clearTimeout(flashTimer);
    target?.classList.remove(...FLASH_CLASSES);
    row?.removeAttribute("data-flash");
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
