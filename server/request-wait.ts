// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Whether a request.opened event is a card the turn waits on. Every ask holds the turn's human-wait (watchdog + driver
// timers) so no timer of ours ends a turn while the owner decides. An ambient card (a held MCP server's approval) is
// not a decision the turn depends on: it must never pause the idle guard or the watchdog.
import type { RuntimeEvent } from "./contracts.ts";

export function requestHoldsHumanWait(event: Extract<RuntimeEvent, { type: "request.opened" }>): boolean {
  return event.ambient !== true;
}
