// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S6 rule 13b. A bot-to-bot channel's title is stored once, at creation (comms-visibility.ts), and the owner has no rename for it, so the
// stored title is a name snapshot a bot rename cannot reach. Every render of a `dm` channel's name, to a bot and to the owner, derives it
// from the two member ids here instead.
import type { GroupRecord } from "./store.ts";

/** The title a channel shows: for a bot-to-bot channel, its two members' current names (in the order the channel was created with); for
 * any other channel, or one whose members are not both on the roster, the stored name. */
export function dmTitle(store: { bot(id: string): { name: string } | null | undefined }, group: Pick<GroupRecord, "name" | "memberIds" | "dm">): string {
  if (group.dm !== true || group.memberIds.length !== 2) return group.name;
  const names = group.memberIds.map(id => store.bot(id)?.name);
  return names.every((name): name is string => typeof name === "string" && name.length > 0) ? `${names[0]} ⇄ ${names[1]}` : group.name;
}
