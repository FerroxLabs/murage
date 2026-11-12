// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE WELCOME'S WORDS AND ITS RULE. The welcome is the first thing a brand-new install paints: the Murage logo, Ember
// popping in behind it, two plain lines and one button. This file holds what it says and when it may show, and nothing
// else, so the copy gate (src/lib/first-run-surfaces.ts) reaches every word.
//
// WHEN IT SHOWS. Only while the first run is live and the person has not touched the hello step: `view.firstRun` is
// true AND hello is neither done nor skipped AND no name is saved. A restored backup, a returning user and any
// workspace with a saved name never see it. "Seen" is held in memory for this session: if the person quits before
// answering hello they see the welcome once more on the next start, which costs one press. No stored key.

import type { SetupView } from "../../shared/setup";

export const FIRST_RUN_WELCOME = {
  lead: "Your own team of bots,",
  line: "doing real work on your computer.",
  start: "Get started",
} as const;

/** The foot line: the running version, nothing else. */
export function welcomeFootLine(version: string): string {
  return `Murage ${version}`;
}

/** The welcome's own timing: it fades in over this long, and fades out over this long when the person presses Get started. */
export const WELCOME_FADE_MS = 300;

/** Whether the hello step is still untouched in this view. A view without a hello step is not a first run. */
function helloUntouched(view: SetupView): boolean {
  const hello = view.steps.find((step) => step.id === "hello");
  if (!hello) return false;
  if (hello.status === "done" || hello.status === "skipped") return false;
  return true;
}

/** The welcome rule. Pure: the same view and the same seen flag always give the same answer. */
export function welcomeShouldShow(view: SetupView | null | undefined, seenThisSession: boolean): boolean {
  if (seenThisSession) return false;
  if (!view) return false;
  if (view.firstRun !== true) return false;
  if (typeof view.ownerName === "string" && view.ownerName.trim() !== "") return false;
  return helloUntouched(view);
}

let seen = false;

/** Held in memory only. */
export function welcomeSeen(): boolean {
  return seen;
}

export function markWelcomeSeen(): void {
  seen = true;
}

/** Tests own their own world; nothing in the app clears this. */
export function forgetWelcomeSeen(): void {
  seen = false;
}
