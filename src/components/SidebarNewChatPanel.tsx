// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "New chat": pick any bot and a fresh conversation with it opens, without finding the bot in the list first.
// Idea from OpenMaus (Apache-2.0, SidebarNewChatPanel.tsx). The list is the Chief first, then recent bots; arrow keys and
// Enter work from the filter box.
import { useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { newChatBots } from "@/lib/new-chat-bots";
import type { Bot } from "@/state/store";

export function SidebarNewChatPanel({ bots, onPick, onClose }: { bots: readonly Bot[]; onPick: (bot: Bot) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => newChatBots(bots, query), [bots, query]);
  const at = Math.min(cursor, Math.max(rows.length - 1, 0));
  const move = (next: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, next));
    setCursor(clamped);
    listRef.current?.querySelectorAll<HTMLElement>("[data-new-chat-row]")[clamped]?.scrollIntoView({ block: "nearest" });
  };
  return (
    <div data-testid="new-chat-panel">
      <div className="flex items-center gap-2 border-b border-hairline/40 px-3 pb-2 pt-1">
        <Search size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
        <input
          autoFocus
          value={query}
          onChange={(event) => { setQuery(event.target.value); setCursor(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); move(at + 1); }
            else if (event.key === "ArrowUp") { event.preventDefault(); move(at - 1); }
            else if (event.key === "Enter" && rows[at]) { event.preventDefault(); onPick(rows[at]!); }
            else if (event.key === "Escape") { event.stopPropagation(); onClose(); }
          }}
          placeholder={t("nav.newChatFilter")}
          aria-label={t("nav.newChatAria")}
          role="combobox"
          aria-expanded="true"
          aria-controls="new-chat-list"
          aria-activedescendant={rows[at] ? `new-chat-${rows[at]!.id}` : undefined}
          className="min-h-7 w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
      </div>
      <div ref={listRef} id="new-chat-list" role="listbox" aria-label={t("nav.newChatAria")} className="max-h-72 overflow-y-auto py-1">
        {rows.length === 0 && <p className="px-3.5 py-2 text-[13px] text-ink-secondary">{t("nav.newChatNone")}</p>}
        {rows.map((bot, index) => (
          <button
            key={bot.id}
            id={`new-chat-${bot.id}`}
            role="option"
            aria-selected={index === at}
            tabIndex={-1}
            type="button"
            data-new-chat-row
            onClick={() => onPick(bot)}
            onMouseMove={() => setCursor(index)}
            className={cn("flex w-full items-center gap-2.5 px-3.5 py-1.5 text-left text-[14px] text-ink", index === at ? "bg-raised/80" : "hover:bg-raised/70")}
          >
            <BotAvatar bot={bot} size={24} />
            <span className="min-w-0 flex-1 truncate">{bot.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
