// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Two bots with one name (1.0.21 polish: two "Dax (Closer)" rows in every list). Pinned is a flag on one record, so two
// rows are two bots. Murage never deletes or merges either by itself: the owner sees the clash and gets one rename.

export interface NamedBot { id: string; name: string; hidden?: boolean }

const key = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** The other visible bots that carry this bot's name (case and spacing ignored). */
export function sameNameBots<T extends NamedBot>(bots: readonly T[], bot: NamedBot): T[] {
  const name = key(bot.name);
  return name ? bots.filter((other) => other.id !== bot.id && !other.hidden && key(other.name) === name) : [];
}

/** "<name> N" for the lowest N from 2 that no bot, visible or not, already holds. */
export function distinctBotName(bots: readonly NamedBot[], name: string): string {
  const base = name.trim().replace(/\s+/g, " ");
  const taken = new Set(bots.map((bot) => key(bot.name)));
  for (let n = 2; ; n += 1) if (!taken.has(key(`${base} ${n}`))) return `${base} ${n}`;
}
