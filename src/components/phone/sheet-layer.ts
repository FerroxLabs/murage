// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A phone sheet is drawn at the end of the body, outside the popover that
// opened it, so that popover's "tap outside closes me" must not count a tap
// inside the sheet (it would close the sheet before the pick lands).
export const PHONE_SHEET_LAYER = "[data-phone-sheet-layer]";

export function inPhoneSheet(target: EventTarget | null): boolean {
  return typeof Element !== "undefined" && target instanceof Element && target.closest(PHONE_SHEET_LAYER) !== null;
}
