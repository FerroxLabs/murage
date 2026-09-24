// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef } from "react";
import { openNotificationTarget, useStore } from "@/state/store";
import { openInboxLink } from "@/lib/open-inbox-link";
import type { TrayOpenTarget } from "@/types/muragebox";

const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;

/** Composer.tsx listens for this and focuses the draft once it is on screen. */
export const FOCUS_COMPOSER_EVENT = "murage:focus-composer";

/** What the menu bar / tray menu asks the window to show: an approval card,
 * a running conversation, or a bot's chat with the composer focused. */
export function useTrayIntents() {
  const { state, dispatch } = useStore();
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => window.muragebox?.tray?.onOpen((target: TrayOpenTarget) => {
    const current = latest.current;
    if (target?.kind === "approval" && id(target.threadId) && id(target.messageId)) {
      void openInboxLink({ threadId: target.threadId, messageId: target.messageId }, current, dispatch).catch(() => {
        if (id(target.botId)) openNotificationTarget(dispatch, { botId: target.botId, threadId: target.threadId }, current);
      });
    } else if (target?.kind === "conversation" && id(target.botId) && id(target.threadId)) {
      openNotificationTarget(dispatch, { botId: target.botId, threadId: target.threadId }, current);
    } else if (target?.kind === "compose" && id(target.botId) && current.bots.some(bot => bot.id === target.botId)) {
      dispatch({ type: "select", id: target.botId });
      // after the chat for that bot has rendered
      requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT, { detail: { botId: target.botId } }))));
    }
  }), [dispatch]);
}
