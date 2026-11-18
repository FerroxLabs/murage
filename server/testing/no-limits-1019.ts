// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIM 1.0.19 test helper: what No limits does with a command the always-ask reader names. Policy (Sean 2026-11-10): the
// owner's work runs; only the wipe list stays a card (designs/NOLIM-DO-EVERYTHING-1019.md rev 3.1). Old tests pinned the
// card for every reader rule; they now say which visible wipe rules still card.
// Sean 11-12 removes the legacy plainWipe proxy exception.
import { expect } from "vitest";

export const WIPE_RULES: ReadonlySet<string> = new Set(["delete-root", "delete-home", "delete-system-folder", "disk-erase", "fork-bomb"]);
export const isWipeRule = (rule: string | null | undefined): boolean => rule !== undefined && rule !== null && WIPE_RULES.has(rule);

type Verdict = { approve: string | null; source?: string; rule?: string | null };

/** The owner's No limits turn on a command whose reader rule is `rule`: a wipe rule keeps its always-ask card; any other rule runs
 * (an allow). A parser uncertainty or bare delete word is not a wipe. */
export function expectNoLimitsOwnerOutcome(verdict: Verdict, command: string, rule: string | null | undefined, label = command): void {
  if (isWipeRule(rule)) {
    expect(verdict, `${label}: a wipe row still asks`).toMatchObject({ approve: null, source: "always-ask" });
    return;
  }
  expect(verdict.approve, `${label}: No limits runs it`).toBeTruthy();
}

/** Sean 2026-11-12 02:05Z supersedes S1-B3: protected writes run.
 * These callers describe protected writes, not root wipes; wipe controls stay explicit in their own rows. */
export function expectNoLimitsProtectedWrite(verdict: Verdict, label: string): void {
  expect(verdict.approve, `${label}: protected paths do not card at No limits`).toBeTruthy();
}
