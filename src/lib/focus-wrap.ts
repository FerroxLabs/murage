// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where Tab goes inside a card that holds focus: the index to focus when Tab (or Shift+Tab) would leave the first or last
// control, or null to let the browser move as usual. Pure so the rule is testable without a DOM.
export function wrapTabTarget(count: number, activeIndex: number, shift: boolean): number | null {
  if (count <= 0) return null;
  if (activeIndex < 0) return shift ? count - 1 : 0;
  if (!shift && activeIndex === count - 1) return 0;
  if (shift && activeIndex === 0) return count - 1;
  return null;
}
