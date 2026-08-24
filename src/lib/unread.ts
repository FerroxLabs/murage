export function unreadConversationCount(
  bots: Array<{ hidden?: boolean; unread?: boolean }>,
  groups: Array<{ unread?: boolean }>,
): number {
  return bots.filter((bot) => !bot.hidden && bot.unread).length + groups.filter((group) => group.unread).length;
}
