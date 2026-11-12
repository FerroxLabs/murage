// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The per-bot choice a bot sign-in asks first. It lives in its own file so the Inbox and the setup screen, which are
// part of the first paint, can show it without pulling in the whole Connect panel's sign-ins (src/first-paint.test.ts).
import { BOT_REQUIRED_COPY } from "@/lib/engine-login-terminal";

const button = "rounded-md bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-inset disabled:opacity-50";

/** Which bot a per-bot sign-in is for: the home's bots by name. */
export function BotChoice({ bots, onChoose, onCancel }: { bots: { id: string; name: string }[] | null; onChoose: (bot: { id: string; name: string }) => void; onCancel: () => void }) {
  return (
    <section aria-label={BOT_REQUIRED_COPY} className="flex flex-col gap-2">
      <p>{BOT_REQUIRED_COPY}</p>
      {bots === null ? <p className="text-ink-secondary">Loading the bots on this home...</p>
        : bots.length === 0 ? <p className="text-ink-secondary">This home has no bots yet. Open it and add one, then sign the engine in for it.</p>
        : (
          <div className="flex flex-wrap gap-2">
            {bots.map((bot) => <button key={bot.id} type="button" className={button} onClick={() => onChoose(bot)}>{bot.name}</button>)}
          </div>
        )}
      <div><button type="button" className={button} onClick={() => onCancel()}>Cancel</button></div>
    </section>
  );
}
