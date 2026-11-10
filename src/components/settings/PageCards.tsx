// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How a page lists its cards (SETTINGS-SHELL-CONTRACT-1019.md): data in, the shell's Simple/Advanced rule applied once,
// one "Set in Advanced" line when Simple left cards out. A page never filters for Simple itself.
import { sw } from "@/lib/settings-words";
import { setSettingsMode, type SettingsMode } from "@/lib/settings-mode";
import { visibleCards, type SettingsPageCard } from "@/lib/settings-page-contract";
import { Anchor } from "../SettingsAnchor";

/** The one line that takes a person from Simple to the rest: it flips Advanced mode on and stays on the page. */
export function SetInAdvancedLine({ count }: { count: number }) {
  return (
    <p data-set-in-advanced={count} className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-secondary">
      <span>{sw("settings.mode.moreHidden")}</span>
      <button
        type="button"
        onClick={() => setSettingsMode("advanced")}
        className="min-h-8 rounded-md px-1.5 font-medium text-ink underline underline-offset-2 hover:bg-control/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11"
      >
        {sw("settings.mode.setInAdvanced")}
      </button>
    </p>
  );
}

export function PageCards({ cards, mode }: { cards: readonly SettingsPageCard[]; mode: SettingsMode }) {
  const { shown, hidden } = visibleCards(cards, mode);
  return (
    <>
      {shown.map((card) => <Anchor key={card.id} id={card.anchor}>{card.render()}</Anchor>)}
      {hidden > 0 && <SetInAdvancedLine count={hidden} />}
    </>
  );
}
