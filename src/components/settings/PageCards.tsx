// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How a page lists its cards (SETTINGS-SHELL-CONTRACT-1019.md): data in, the shell's Simple/Advanced rule applied once,
// one "Set in Advanced" line when Simple left cards out. A page never filters for Simple itself.
import { sw } from "@/lib/settings-words";
import { setSettingsMode, type SettingsMode } from "@/lib/settings-mode";
import { visibleCards, type SettingsPageCard } from "@/lib/settings-page-contract";
import { Anchor } from "../SettingsAnchor";

/** The line that was pressed is gone once Advanced is on, so the key focus goes to what it opened: the next frame, then a
 *  few more tries while the page lays out. Never leaves focus on the body. */
function focusSoon(find: () => HTMLElement | null | undefined): void {
  let tries = 0;
  const go = () => {
    const element = find();
    if (element && element.isConnected && (element.offsetParent !== null || element.getClientRects().length > 0)) { element.focus(); return; }
    if (++tries < 10) setTimeout(go, 50);
  };
  setTimeout(go, 0);
}

/** Where focus goes after the sidebar's line: the footer that replaces it, or the page when the footer is not shown (a phone). */
const sidebarTarget = () => document.querySelector<HTMLElement>("[data-settings-mode-footer]") ?? document.querySelector<HTMLElement>("[data-settings-page-body] [tabindex='-1']");

/** The one line that takes a person from Simple to the rest: it flips Advanced mode on and stays on the page, with the
 *  keyboard focus on `focusTarget` (the first card it revealed on a page; the mode footer for the sidebar's line). */
export function SetInAdvancedLine({ count, focusTarget = sidebarTarget }: { count: number; focusTarget?: () => HTMLElement | null | undefined }) {
  return (
    <p data-set-in-advanced={count} className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-secondary">
      <span>{sw("settings.mode.moreHidden")}</span>
      <button
        type="button"
        onClick={() => { setSettingsMode("advanced"); focusSoon(focusTarget); }}
        className="min-h-8 rounded-md px-1.5 font-medium text-ink underline underline-offset-2 hover:bg-control/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11"
      >
        {sw("settings.mode.setInAdvanced")}
      </button>
    </p>
  );
}

export function PageCards({ cards, mode }: { cards: readonly SettingsPageCard[]; mode: SettingsMode }) {
  const { shown, hidden } = visibleCards(cards, mode);
  const firstHidden = cards.find((card) => !card.simple);
  const groups: SettingsPageCard[][] = [];
  for (const card of shown) {
    const previous = groups[groups.length - 1];
    if (card.group && previous?.[0]?.group === card.group) previous.push(card);
    else groups.push([card]);
  }
  return (
    <>
      {groups.map((group) => {
        const first = group[0]!;
        const content = group.map((card) => <Anchor key={card.id} id={card.anchor}>{card.render()}</Anchor>);
        // Only the outer card surfaces are flattened; controls keep their own borders, padding and focus rings.
        return first.group ? (
          <div key={first.id} data-settings-card-group={first.group} className="divide-y divide-hairline rounded-xl bg-card [&>div]:p-4 [&>div>.bg-card]:rounded-none [&>div>.bg-card]:bg-transparent [&>div>.bg-card]:p-0">
            {content}
          </div>
        ) : content;
      })}
      {hidden > 0 && <SetInAdvancedLine count={hidden} focusTarget={() => (firstHidden ? document.getElementById(firstHidden.anchor) : null)} />}
    </>
  );
}
