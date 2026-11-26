// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Like Murage so far?" A small card asking a happy owner for a GitHub star. When it may show is decided in lib/star-prompt.ts
// (local counts only, nothing sent); this file only reads the app's state for the three "not now" cases and draws the card.
// It never takes focus, so it cannot interrupt typing.
import { useEffect, useSyncExternalStore, useState } from "react";
import { createPortal } from "react-dom";
import { Star } from "lucide-react";
import { t, localeVersion, subscribeLocale } from "@/lib/i18n";
import {
  getStarState,
  isStoreBuild,
  openStarPage,
  pressNotNow,
  pressStar,
  starAllowedInStores,
  starPromptShows,
  subscribeStarState,
} from "@/lib/star-prompt";
import { pendingApprovals, openQuestions } from "@/lib/pending-approval";
import { useOwnersComputer } from "@/lib/use-surface";
import { useUpdatePopupAnchor } from "@/lib/update-card";
import { olderOpenCards, useStore, visibleMessages, type AppState } from "@/state/store";

/** A turn is running in any chat or room, or an approval or question is open in the one on screen. */
export function stateBusyFor(state: Pick<AppState, "bots" | "groups" | "selectedId">): { turnRunning: boolean; approvalOpen: boolean } {
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId);
  const group = state.groups.find((candidate) => candidate.id === state.selectedId);
  const open = bot ? olderOpenCards(bot, visibleMessages(bot)) : group ? olderOpenCards(group, group.messages) : [];
  return {
    turnRunning: state.bots.some((candidate) => candidate.busy) || state.groups.some((candidate) => Boolean(candidate.busyBotId)),
    approvalOpen: pendingApprovals(open).length > 0 || openQuestions(open).length > 0,
  };
}

export function StarPrompt() {
  useSyncExternalStore(subscribeLocale, localeVersion, localeVersion);
  const { state } = useStore();
  const desktop = useOwnersComputer();
  const footer = useUpdatePopupAnchor();
  const star = useSyncExternalStore(subscribeStarState, getStarState, getStarState);
  const [failed, setFailed] = useState(false);
  const { turnRunning, approvalOpen } = stateBusyFor(state);
  // The snooze ends while the app is open: look again at the end of it rather than waiting for the next frame.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const wait = star.snoozeUntil - Date.now();
    if (wait <= 0) { setNow(Date.now()); return; }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait + 50, 2_147_000_000));
    return () => clearTimeout(timer);
  }, [star.snoozeUntil]);
  const shows = starPromptShows(star, {
    now: Math.max(now, Date.now()),
    desktop,
    storeBuild: isStoreBuild(),
    allowInStores: starAllowedInStores(),
    turnRunning,
    approvalOpen,
  });
  if (!shows || !footer) return null;
  const starIt = async () => {
    const opened = await openStarPage();
    if (opened) { setFailed(false); pressStar(); } else setFailed(true);
  };
  return createPortal(
    <section
      aria-label={t("starPrompt.title")}
      data-testid="star-prompt"
      className="absolute bottom-full left-3 z-30 mb-2 w-[300px] max-w-[calc(100vw-1.5rem)] rounded-xl border border-hairline/40 bg-panel p-3.5 text-ink shadow-2xl shadow-black/40"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent"><Star className="size-4" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold">{t("starPrompt.title")}</div>
          <div className="mt-0.5 text-[12.5px] text-ink-secondary">{t("starPrompt.body")}</div>
          {failed && <div role="alert" className="mt-1 text-[12.5px] text-ink-secondary">{t("starPrompt.failed")}</div>}
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={() => pressNotNow()} className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink">{t("starPrompt.notNow")}</button>
        <button type="button" onClick={() => void starIt()} className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white">{t("starPrompt.star")}</button>
      </div>
    </section>,
    footer,
  );
}
