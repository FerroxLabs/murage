// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import type { Group, Message } from "@/state/store";
export function messageActor(message: Message, principal: "owner" | "person" = "owner"): NonNullable<Message["actorKind"]> {
  if (message.actorKind) return message.actorKind;
  if (message.routineRunPrompt) return "routine";
  if (message.role === "user") return principal === "owner" && message.origin !== "unproven" ? "owner" : "person";
  return "bot";
}
export function sameThreadReply(message: Message, transcript: readonly Message[]): Message | undefined {
  return message.replyToId ? transcript.find((candidate) => candidate.id === message.replyToId) : undefined;
}
export function channelReadOnlyReason(group: Pick<Group, "dm" | "readOnlyReason">): string | null {
  return group.readOnlyReason?.trim() || null;
}
export function unreadTaskLabel(task: { unreadCount?: number; unread?: boolean }): string {
  return task.unreadCount && task.unreadCount > 0 ? `${task.unreadCount > 99 ? "99+" : task.unreadCount} unread` : task.unreadCount === undefined && task.unread ? "Unread" : "";
}
