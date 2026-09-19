import type { Bot } from "@/state/store";

/** The bot behind a message in a room. Members come first, but a room also
 * carries messages from bots that are not (or no longer) members — a
 * delegated teammate's reply, a bot removed from the room — and those must
 * still show their own avatar and name, not the default mascot. */
export function roomAuthor(id: string | undefined, members: readonly Bot[], allBots: readonly Bot[]): Bot | undefined {
  if (!id) return undefined;
  return members.find((bot) => bot.id === id) ?? allBots.find((bot) => bot.id === id);
}
