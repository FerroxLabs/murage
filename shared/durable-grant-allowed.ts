// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 2.3.3: the one rule for which keys may be kept for
// good, on a bot, a task or a routine. A payment is never saved for good
// (Sean, 2026-10-30): its card offers the 12-hour task scope only. A browser
// stop key was never a routine grant and is not a bot one either. The shapes
// the loaders already drop (a question tool, a stale connected-app shape, a
// command tool's bare name) are refused here too, so the bot route's plan,
// the routine validator, both loaders and the card's fold read one rule.
import { isStaleGrant } from "./app-action-words.ts";
import { isExactCommandKey } from "./exact-command.ts";
import { isBareCommandGrant, isQuestionGrant } from "./grant-tool-names.ts";

export function durableGrantAllowed(key: string): boolean {
  if (typeof key !== "string" || !key) return false;
  // a stop key is judged by its kind (its place is a path or an address,
  // never a tool name): delete, message and public posts only
  if (key.startsWith("stop:")) return /^stop:(?:delete|message|public):./.test(key);
  if (isExactCommandKey(key)) return true;
  return !isQuestionGrant(key) && !isStaleGrant(key) && !isBareCommandGrant(key);
}

/** The keys of a stored list this rule keeps, and how many it dropped. */
export function withoutRefusedGrants(keys: readonly string[]): { kept: string[]; dropped: number } {
  const kept = keys.filter(durableGrantAllowed);
  return { kept, dropped: keys.length - kept.length };
}
