// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A quiet dot on the controls that reveal the sidebar (the phone-width drawer button and the rail's expand button), so an update
// is never hidden just because the round button is out of sight. No popup: it only marks the control. Desktop app only.
import { indicatorShows } from "@/lib/update-card";
import { useUpdaterState } from "@/lib/updater";

export function UpdateDot() {
  const s = useUpdaterState();
  if (!s || !indicatorShows(s.status)) return null;
  return <span aria-hidden="true" data-testid="update-dot" className="pointer-events-none absolute right-1 top-1 size-2 rounded-full bg-accent ring-2 ring-[var(--color-panel,transparent)]" />;
}
