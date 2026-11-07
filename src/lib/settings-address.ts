// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SETTINGS-UX-1011 S8: every Settings entry has an address a chat reply, a help answer, a What's new tile or a tip can
// open, and it lands exactly where a search "Open" lands.
//
//   murage://settings/app/<section>/<name>           an app card            (index id "<section>.<name>")
//   murage://settings/app/<section>                  an app page, or any of the 19 old section ids
//   murage://settings/bot/<section>/<name>           a row in the open bot's settings (index id "bot.<section>.<name>")
//   murage://settings/bot/<botId>/<section>/<name>   the same row for one named bot
//   murage://settings/<old section id>               the old ids keep working (resolveSettingsSection)
//
// Parsing is plain string work with no index and no words, so it rides with every chat. Opening reads the index on
// the press (lib/open-settings-address.ts).

export type SettingsAddress =
  | { scope: "app"; section: string; name: string | null }
  | { scope: "bot"; botId: string | null; section: string; name: string | null };

export const SETTINGS_ADDRESS_PREFIX = "murage://settings/";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** The address of an index entry. `botId` names one bot; without it a bot entry opens in the bot being viewed. */
export function settingsAddressFor(entry: { id: string; scope: "app" | "bot" }, botId?: string): string {
  if (entry.scope === "app") {
    const [section, ...rest] = entry.id.split(".");
    return `${SETTINGS_ADDRESS_PREFIX}app/${section}/${rest.join(".")}`;
  }
  const [, section, ...rest] = entry.id.split(".");
  const bot = botId ? `${encodeURIComponent(botId)}/` : "";
  return `${SETTINGS_ADDRESS_PREFIX}bot/${bot}${section}/${rest.join(".")}`;
}

/** A Settings address, or null for anything else. Never throws; a malformed address is null, never a guess. */
export function parseSettingsAddress(href: unknown): SettingsAddress | null {
  if (typeof href !== "string" || href.length > 300) return null;
  if (href.slice(0, SETTINGS_ADDRESS_PREFIX.length).toLowerCase() !== SETTINGS_ADDRESS_PREFIX) return null;
  const rest = href.slice(SETTINGS_ADDRESS_PREFIX.length).replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!rest) return null;
  let parts: string[];
  try {
    parts = rest.split("/").map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  const [scope, ...tail] = parts;
  if (scope === "app") {
    if (tail.length < 1 || tail.length > 2 || !tail.every((part) => SEGMENT.test(part))) return null;
    return { scope: "app", section: tail[0], name: tail[1] ?? null };
  }
  if (scope === "bot") {
    if (tail.length === 3) {
      const [botId, section, name] = tail;
      if (!BOT_ID.test(botId) || !SEGMENT.test(section) || !SEGMENT.test(name)) return null;
      return { scope: "bot", botId, section, name };
    }
    if (tail.length < 1 || tail.length > 2 || !tail.every((part) => SEGMENT.test(part))) return null;
    return { scope: "bot", botId: null, section: tail[0], name: tail[1] ?? null };
  }
  // An old section id on its own: "murage://settings/engines".
  if (tail.length === 0 && SEGMENT.test(scope)) return { scope: "app", section: scope, name: null };
  return null;
}
