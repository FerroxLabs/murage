// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rule 72 (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md): a narrowing
// denial is for something the ENGINE can rewrite on its own. The same (tool,
// text) denied NARROW_DENIALS_BEFORE_CARD times in one turn raises the card
// instead, so a model that cannot narrow surfaces to the owner. Every driver
// counts through this one table.

import { NARROW_DENIALS_BEFORE_CARD } from "../shared/scan-limits.ts";

export class NarrowDenials {
  private readonly counts = new Map<string, number>();

  /** Record one narrowing denial of (tool, text) on `turn`; true when this
   * one must go to the owner as a card instead of being delivered. */
  raiseCard(turn: string, tool: string, text: string): boolean {
    const key = JSON.stringify([turn, tool, text]);
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next >= NARROW_DENIALS_BEFORE_CARD;
  }

  /** Forget a finished turn. */
  endTurn(turn: string): void {
    const prefix = JSON.stringify([turn]).slice(0, -1);
    for (const key of this.counts.keys()) if (key.startsWith(prefix + ",")) this.counts.delete(key);
  }
}
