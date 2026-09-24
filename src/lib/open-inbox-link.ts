// SPDX-License-Identifier: AGPL-3.0-or-later
import { api } from "@/state/store";
import type { Action, AppState } from "@/state/store";
import type { InboxLink } from "../../shared/inbox";
import { MESSAGE_PAGE_SIZE } from "@/lib/scrollback";
import { t } from "@/lib/i18n";

/** Open the exact persisted source of an Inbox item (or a tray menu item):
 * switch to its conversation, then page back to the message and focus it.
 * Shared by the Inbox dialog and the menu bar / tray menu. */
export async function openInboxLink(link: Pick<InboxLink, "threadId" | "messageId">, state: Pick<AppState, "bots" | "groups">, dispatch: (action: Action) => void) {
  const bot = state.bots.find(item => item.threadId === link.threadId || item.tasks?.some(task => task.threadId === link.threadId));
  const group = state.groups.find(item => item.threadId === link.threadId || item.tasks?.some(task => task.threadId === link.threadId));
  if (bot) {
    // A page, like every switch; focusMessage pages back to the request.
    const result = await api(`/api/bots/${bot.id}/tasks/${link.threadId}?messages=${MESSAGE_PAGE_SIZE}`, { method: "POST" });
    if (!result.bot || result.bot.threadId !== link.threadId) throw new Error(t("source.openError"));
    dispatch({ type: "taskSwitched", bot: result.bot });
    dispatch({ type: "select", id: bot.id, threadId: link.threadId });
  } else if (group) {
    const result = await api(`/api/groups/${group.id}/tasks/${link.threadId}?messages=${MESSAGE_PAGE_SIZE}`, { method: "POST" });
    if (!result.group || result.group.threadId !== link.threadId) throw new Error(t("source.openError"));
    dispatch({ type: "groupPatched", group: result.group });
    dispatch({ type: "select", id: group.id });
  } else throw new Error(t("inbox.conversationUnavailable"));
  if (link.messageId) dispatch({ type: "focusMessage", threadId: link.threadId, messageId: link.messageId });
}
