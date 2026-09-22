/**
 * WHAT THIS CONVERSATION IS CALLED, EVERYWHERE IT IS NAMED.
 *
 * THE DEFECT. The sidebar already knew a project from a channel — the row
 * drew `Target` instead of `Users` for one — but the context menu only ever
 * asked whether it was a bot chat. So right-clicking a row under the
 * PROJECTS heading offered "Rename Channel" and "Delete Channel", and the
 * app disagreed with itself about what the thing was in the two places a
 * person looks hardest: the heading it sits under, and the menu that can
 * delete it. Being told you are about to delete a Channel, under a heading
 * that says Projects, is the moment somebody stops trusting either word.
 *
 * One function now, so the icon, the menu and the accessible names cannot
 * drift again. Sentence case throughout: it was "Rename chat" beside
 * "Rename Channel", which is the same disagreement in miniature.
 */
export function conversationNoun(group: { dm?: unknown; channelProject?: unknown }): "chat" | "project" | "channel" {
  if (group.dm) return "chat";
  // A project is a channel with a purpose attached, so this order matters:
  // asked the other way round, every project answers "channel".
  if (group.channelProject) return "project";
  return "channel";
}
