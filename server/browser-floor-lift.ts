// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// When the built-in browser may lift the pay/card/password/terms floor (MAIN 1.0.24 #1): only on the owner's own typed turn (or own-channel DM) at
// No limits, and only while the turn carries no mark (any, not only the first) from outside content: a page, the web, email, another person or bot. Guests, shared threads, webhook, peer, delegation
// and routine turns never lift it. A CAPTCHA is never lifted (BuiltinFloorGate keeps it). Owners: lane q1024-paynl owns this rule and its witness;
// MAIN owns the policy (who is at No limits); the extension path keeps its own executor rule (browser-extension-executor.ts noLimits).
import { trustOriginNow } from "./decision/trust-origin.ts";
import { observeOutsideMarks, turnOutsideMark } from "./email/external-marks.ts";

/** MAIN-RULING (Codex tip audit High 1): a web page or browser mark never lifts the floor; only the owner's own request can pass. Money pushed
 *  by outside content is the edge, so the lift holds only on a turn that carries NO outside mark of any source. There is no "structural" exception:
 *  `outside tool` is also what another party's MCP tool result is marked with (outside-wire.ts) and what every turn of an engine Murage does not see
 *  in full carries (so what it read is unknown), `cloned folder` is someone else's repository, `helper` is a sub-agent's output. A marked turn keeps
 *  the floor and that step is the owner's own. A source added later keeps the floor too, since no source is listed here. */

/** Every source marked on a thread this turn, not only the first: the live mark keeps the first source, so a page mark must not hide a later email mark.
 *  The observer runs before the row is set, so a mark that finds no live row is the turn's first and starts a fresh set (the row is cleared at turn start). */
const seenSources = new Map<string, Set<string>>();
observeOutsideMarks((threadId, source) => {
  if (!turnOutsideMark(threadId) || !seenSources.has(threadId)) seenSources.set(threadId, new Set());
  seenSources.get(threadId)!.add(source);
});

/** The mount-time and per-step decision; reads the live policy and marks, never a tool argument. */
export function builtinFloorLift(turn: { threadId: string; generation: string; botId: string }): boolean {
  try {
    const origin = trustOriginNow(turn);
    const row = turnOutsideMark(turn.threadId);
    if (!row) seenSources.delete(turn.threadId);
    const sources = new Set<string>([...(seenSources.get(turn.threadId) ?? []), ...(row ? [row.source] : [])]);
    return origin.kind === "owner-direct" && origin.noLimits && sources.size === 0;
  } catch { return false; }
}
