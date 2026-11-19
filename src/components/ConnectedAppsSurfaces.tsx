// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Connected apps sits on a card. In light, `raised` is the card's own white (styles.css), so a `bg-raised` button, tile or
// row on the card has no surface at all: "Add account" read as bare text (G9 Krug review). Everything that needs a
// surface on the card takes it from here, and `control` is the tone that shows in both themes (in dark it equals raised,
// so dark looks as it did).

/** The resting surface of each thing Connected apps draws on its card. */
export const ON_CARD = {
  button: "bg-control",
  tile: "bg-control",
  accountRow: "bg-control/45",
  search: "bg-control/70",
  tabs: "bg-control/70",
  /** A button's hover: a step past `control`, so it darkens in light (raised-hover is lighter than control there). */
  buttonHover: "hover:bg-control-hover",
} as const;

/** The small line under an account's name: its id may be cut short, its status word never is. */
export function ConnectedAccountLine({ id, status }: { id: string; status: string }) {
  return (
    <div className="mt-0.5 flex min-w-0 items-baseline gap-1 text-[10.5px] text-ink-secondary">
      {id && <span data-account-id className="min-w-0 truncate">{id}</span>}
      <span data-account-status className="shrink-0">{id ? "· " : ""}{status}</span>
    </div>
  );
}
