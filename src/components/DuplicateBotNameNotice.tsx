// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { distinctBotName, sameNameBots, type NamedBot } from "@/lib/duplicate-bot-names";

/** Shown in a bot's settings while another visible bot has the same name: one click renames this one. Never deletes. */
export function DuplicateBotNameNotice({ bot, bots, onRename }: { bot: NamedBot; bots: readonly NamedBot[]; onRename: (name: string) => void }) {
  if (sameNameBots(bots, bot).length === 0) return null;
  const next = distinctBotName(bots, bot.name);
  return (
    <div role="status" data-duplicate-bot-name className="mx-5 mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-inset px-3 py-2 text-[12.5px] text-ink-secondary">
      <span className="min-w-0 flex-1">{`Another bot is also named ${bot.name.trim()}.`}</span>
      <button type="button" onClick={() => onRename(next)} className="min-h-8 rounded-lg bg-control px-3 text-[12.5px] font-medium text-ink hover:bg-control-hover">
        {`Rename this one to ${next}`}
      </button>
    </div>
  );
}
