// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Browse bots (SETTINGS-LOCKED-1019.md 2.1): the page past five bots. A filter box and one row per bot: name, role,
// then Open. A bot's own settings are its page; this is only the door to it.
import { useState } from "react";
import { Bot } from "lucide-react";
import { sw } from "@/lib/settings-words";
import { BOT_ROLE_TITLE, botRole } from "@/lib/bot-role";
import { browsableBots } from "@/lib/settings-shell-bots";

interface Row { id: string; name: string; hidden?: boolean; section?: string; chiefOfStaff?: boolean; chiefScope?: "workspace"; individual?: boolean }

/** The rows a filter keeps: a bot whose name contains every word typed, in any order, ignoring case. */
export function filterBotRows<T extends { name: string }>(bots: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return bots.filter((bot) => words.every((word) => bot.name.toLowerCase().includes(word)));
}

export function BrowseBotsPage({ bots, openId, onOpen }: { bots: readonly Row[]; openId?: string | null; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const all = browsableBots(bots, openId);
  const rows = filterBotRows(all, query);
  return (
    <div data-settings-browse-bots className="flex flex-col gap-3">
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={sw("settings.browse.filter")}
        aria-label={sw("settings.browse.filter")}
        className="min-h-9 w-full rounded-lg bg-control/70 px-3 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11"
      />
      {all.length === 0 ? <p className="text-[13px] text-ink-secondary">{sw("settings.browse.noBots")}</p> : rows.length === 0 ? <p role="status" className="text-[13px] text-ink-secondary">{sw("settings.browse.none")}</p> : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((bot) => (
            <li key={bot.id} data-settings-browse-row={bot.id} className="flex items-center gap-3 rounded-xl bg-card px-3 py-2">
              <Bot size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-ink">{bot.name}</span>
                <span className="block truncate text-[12px] text-ink-secondary">{BOT_ROLE_TITLE[botRole(bot)]}</span>
              </span>
              <button
                type="button"
                onClick={() => onOpen(bot.id)}
                aria-label={sw("settings.browse.openBot", { name: bot.name })}
                className="min-h-8 rounded-md px-2.5 text-[13px] font-medium text-ink hover:bg-control/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11"
              >
                {sw("settings.browse.open")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
