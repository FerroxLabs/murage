// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F33 (Sean 2026-11-27): the one screen a fresh install shows about Automatic mode. The server marks it pending only on a fresh
// install (server/automatic-default.ts); an upgraded install never has the mark, so it never sees this. Got it answers it for good,
// across restarts and updates.
import { useState } from "react";
import { api, useStore } from "@/state/store";
import { useDesktopSurface } from "@/lib/use-surface";

/** What still asks in Automatic, the same plain words as AUTOMATIC_ALWAYS_ASKS (server/automatic-default.ts). */
export const AUTOMATIC_ALWAYS_ASKS: readonly string[] = [
  "Deleting a lot at once, like a whole folder or drive",
  "Spending money because a web page, email or file told it to",
  "Messaging someone new, or someone other than you",
  "Posting where other people will see it",
];
// MAIN RULINGS (Sean reference 11-27): one short paragraph, a Learn more link and one Got it button, inline above the message box.
export const AUTOMATIC_NOTICE_LEAD = "Automatic is now the default.";
export const AUTOMATIC_NOTICE_BODY = "Murage checks risky actions (deleting a lot at once, money a web page, email or file pushes it to spend, messaging new people, posting where others will see it) and asks first; otherwise your bot just gets on with it. Switch a bot to Ask first any time.";
/** The help article behind Learn more (docs/automatic-mode.md). */
export const AUTOMATIC_HELP_ARTICLE: readonly string[] = [
  "Automatic lets a bot read, write and run things in its own folders and on your computer without stopping to ask you.",
  "A few things always ask, at every level, because they are hard to undo or reach other people. Reading never asks.",
  "Ask first makes a bot ask before every action that changes something. Click Automatic under the message box to switch to Ask first, or choose it in Settings for the bot.",
  "The arrow next to it, and Settings > the bot > Advanced, also have Auto (asks about more) and No limits (asks about less).",
];

/** Only a pending mark on the desktop shows it; the phone and an upgraded install never do. */
export const automaticNoticePending = (config: { automaticNotice?: { pending: boolean } } | null | undefined): boolean =>
  config?.automaticNotice?.pending === true;

/** Inline above the message box (Composer.tsx), never a modal. Learn more only opens the article; Got it is the one answer, and
 * it closes the card only once the server has stored it, so the mark is never left pending behind a closed card. */
export function AutomaticModeNotice() {
  const { state, dispatch } = useStore();
  const desktop = useDesktopSurface();
  const [article, setArticle] = useState(false);
  const [saving, setSaving] = useState(false);
  if (desktop !== true || !automaticNoticePending(state.config)) return null;
  const gotIt = async () => {
    setSaving(true);
    try {
      await api("/api/automatic-notice", { method: "POST", body: JSON.stringify({ acknowledged: true }) });
      dispatch({ type: "automaticNoticeAnswered" });
    } catch (error) {
      dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div role="region" aria-label="Automatic mode" data-automatic-notice
      className="pointer-events-auto mb-2 w-full rounded-xl border border-hairline/60 bg-card px-4 py-3 text-[13px] text-ink-secondary">
      <p><strong className="font-semibold text-ink">{AUTOMATIC_NOTICE_LEAD}</strong> {AUTOMATIC_NOTICE_BODY}{" "}
        <a href="#automatic-help" aria-expanded={article} aria-controls="automatic-help" onClick={(event) => { event.preventDefault(); setArticle((open) => !open); }}
          className="text-ink underline underline-offset-2 hover:text-accent">Learn more</a>
      </p>
      {article && (
        <div id="automatic-help" data-automatic-help className="mt-2 rounded-lg bg-inset px-3 py-2">
          {AUTOMATIC_HELP_ARTICLE.map((line, index) => (
            <div key={line}>
              <p className="mt-1">{line}</p>
              {index === 1 && <ul className="mt-1 list-disc pl-5">{AUTOMATIC_ALWAYS_ASKS.map((item) => <li key={item}>{item}</li>)}</ul>}
            </div>
          ))}
        </div>
      )}
      <button type="button" disabled={saving} onClick={() => void gotIt()}
        className="mt-2 rounded-md bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-inset disabled:opacity-60">Got it</button>
    </div>
  );
}
