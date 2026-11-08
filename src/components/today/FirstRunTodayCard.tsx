// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-L6A part 2: the one card on an empty Today while first run is going
// (UX-FIRSTRUN-SCALE-1012 sections 1.2 and 1.9). It replaces L2A's stand-in
// under the same name and props (shell-contract.ts FirstRunTodayCardProps).
//
// It reads the server's setup view, the one opinion on where setup has got to
// (src/lib/first-run.ts), and says one of three things:
// - nothing on this computer can answer yet: "Your bots need a brain first",
//   with Open setup (FIRSTRUN 1.9, the Needs you row's words);
// - otherwise: how many short cards are left, then the first result;
// - through a phone or the browser door: setup finishes on the computer.
// Its one button selects the Chief's chat, where every card lives. Never a
// trip to Settings.
import { useSetupView } from "@/components/FirstRunChrome";
import type { FirstRunTodayCardProps } from "@/components/shell/shell-contract";
import { t } from "@/lib/i18n";
import type { SetupView } from "../../../shared/setup";

export type FirstRunTodayVariant = "remote" | "bare" | "left";

export interface FirstRunTodayWords {
  variant: FirstRunTodayVariant;
  title: string;
  sub: string;
  button: string | null;
}

/** Cards left before the first result: steps other than the result itself
 *  (`flow`) that are neither done nor passed over. Null with no view yet. */
export function firstRunCardsLeft(view: Pick<SetupView, "steps"> | null): number | null {
  if (!view) return null;
  return view.steps.filter((step) => step.id !== "flow" && (step.status === "open" || step.status === "blocked")).length;
}

type WordsView = Pick<SetupView, "steps" | "nothingCanAnswer">;

/** The card's words, pure so the tests read them without a render. */
export function firstRunTodayWords(view: WordsView | null, remote: boolean): FirstRunTodayWords {
  if (remote) return { variant: "remote", title: t("ux.l2a.firstRun.title"), sub: t("ux.l2a.firstRun.remote"), button: null };
  if (view?.nothingCanAnswer === true) {
    return { variant: "bare", title: t("ux.l6a.today.bareTitle"), sub: t("ux.l6a.today.bareSub"), button: t("ux.l6a.today.open") };
  }
  const left = firstRunCardsLeft(view);
  const sub = left === null ? t("ux.l2a.firstRun.sub")
    : left === 0 ? t("ux.l6a.today.resultNext")
    : left === 1 ? t("ux.l6a.today.leftOne")
    : t("ux.l6a.today.left", { n: left });
  return { variant: "left", title: t("ux.l2a.firstRun.title"), sub, button: t("ux.l2a.firstRun.continue") };
}

export function FirstRunTodayCard({ remote, onContinueSetup }: FirstRunTodayCardProps) {
  const { view } = useSetupView();
  const words = firstRunTodayWords(view, remote);
  return (
    <section aria-labelledby="first-run-today-title" data-first-run-today={words.variant}
      className="flex flex-wrap items-center gap-3 rounded-xl border border-hairline/50 bg-panel p-4">
      <div className="min-w-0 flex-1">
        <h2 id="first-run-today-title" className="text-[15px] font-semibold text-ink">{words.title}</h2>
        <p className="mt-0.5 text-[13px] text-ink-secondary">{words.sub}</p>
      </div>
      {words.button && (
        <button type="button" onClick={onContinueSetup}
          className="min-h-11 rounded-lg bg-accent px-4 text-[14px] font-medium text-accent-ink hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          {words.button}
        </button>
      )}
    </section>
  );
}
