// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A card's DOM anchor: a deep link or a search result scrolls to it and focuses it. The page files of 1.0.3 (Bots,
// Models and engines, Tools, Devices) share this one.
import type { ReactNode } from "react";

export function Anchor({ id, children }: { id: string; children: ReactNode }) {
  return <div id={id} tabIndex={-1} className="space-y-4 outline-none">{children}</div>;
}
