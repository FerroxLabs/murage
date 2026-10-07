// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What an approval card shows of the action it asks about. The card's box
// wraps and scrolls, so the whole command fits; the bound only stops a
// runaway argument from filling the store, and a cut is marked.
export const APPROVAL_SUMMARY_MAX = 4_000;

export function approvalSummary(text: string): string {
  if (text.length <= APPROVAL_SUMMARY_MAX) return text;
  let end = APPROVAL_SUMMARY_MAX;
  // never split an emoji in half
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  return `${text.slice(0, end)}…[truncated, ${text.length - end} characters more]`;
}

/** True when `approvalSummary` cut this text: it ends in its truncation marker. */
export function approvalSummaryIsCut(text: string | undefined): boolean {
  return Boolean(text && /…\[truncated, \d+ characters more\]$/.test(text));
}
