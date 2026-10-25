// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from OpenMausBot #2547, Apache-2.0 (see NOTICE).
// On a Mac the window's top edge is the view's own header, so the header has
// to move the window. A header carries `data-window-drag`; styles.css makes it
// a drag region and turns every control inside it back into a click target.

export type WindowDragProps = { "data-window-drag"?: "" };

/** Pure so a test can check both outcomes. */
export function windowDragProps(macInset: boolean): WindowDragProps {
  return macInset ? { "data-window-drag": "" } : {};
}

/** The desktop shell insets its window buttons on a Mac and nowhere else
 * (the same rule as windowChrome "mac-inset" in lib/desktop.ts). Read from the
 * shell bridge directly so a header renders in a plain node test too. */
export function isMacInset(): boolean {
  return typeof window !== "undefined" && window.muragebox?.platform === "darwin";
}

/** Spread onto a header: `<div {...useWindowDrag()}>`. Empty everywhere but a Mac window. */
export function useWindowDrag(): WindowDragProps {
  return windowDragProps(isMacInset());
}
