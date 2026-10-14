// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { api } from "@/state/store";
import { findTask, isTruncated, type TaskHolder } from "@/lib/task-window";

type Owner = { id: string; threadId: string } & TaskHolder<{ threadId: string }>;

/** Whose conversation a thread is. The rows held answer first; a bot or
 * channel whose window leaves tasks out may own a thread that is not in them,
 * and the server says (`GET /api/threads/:id/owner`). null: nobody this
 * client can see. */
export async function ownerOfThread(
  state: { bots: readonly Owner[]; groups: readonly Owner[] },
  threadId: string,
  fetchOwner: (threadId: string) => Promise<{ botId?: string; groupId?: string }> = (id) => api(`/api/threads/${encodeURIComponent(id)}/owner`),
): Promise<{ bot?: Owner; group?: Owner } | null> {
  const holds = (owner: Owner) => owner.threadId === threadId || findTask(owner, threadId) !== undefined;
  const bot = state.bots.find(holds);
  const group = state.groups.find(holds);
  if (bot || group) return { bot, group };
  if (!state.bots.some(isTruncated) && !state.groups.some(isTruncated)) return null;
  try {
    const answer = await fetchOwner(threadId);
    const owner = answer.botId ? { bot: state.bots.find((item) => item.id === answer.botId) } : { group: state.groups.find((item) => item.id === answer.groupId) };
    return owner.bot || owner.group ? owner : null;
  } catch {
    return null;
  }
}
