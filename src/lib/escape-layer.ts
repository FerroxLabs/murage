// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Who gets an Escape press. One rule for every surface, in three parts.
//
// 1. Modal layers go first and keep the key to themselves: an open dialog (native <dialog> or role=dialog with
//    aria-modal), an active focus trap (src/lib/focus-trap.ts) and the Snooze popover. Nothing under a modal layer
//    acts on the Esc, the phone drawer included. preventDefault on Escape stops a native <dialog> from closing, which
//    is why a layer underneath must never take the key while one is open (1.0.14: the drawer did, and New project
//    stayed open).
// 2. The phone drawer is the top layer otherwise. A non-modal menu or picker inside it (a bot's More actions, a
//    room menu, Move to team) is part of the drawer: one Esc closes the menu and the drawer together, as it always
//    has (intake.human.spec.ts:281). The drawer uses the key up, so a page under it (Health, All chats) stays. The
//    + menu keeps the one exception it always had: an Esc pressed inside it is its own, closes it alone and puts
//    focus back on + (intake.human.spec.ts:55); an Esc outside it closes it with the drawer.
// 3. A full page such as Health or All chats acts only when nothing at all is open on top, menus included, and
//    nobody used the key yet.
//
// Only the DOM calls listed here are used, so the unit tests drive it with plain objects.
import { DOM_MODAL_SELECTOR, activeTrapCount } from "./focus-trap";
import { imeComposing } from "./composer-enter";
import { orderedLayers } from "./layers";

/** Modal layers: the drawer steps aside for these and only these (with an active focus trap). One selector a line. */
const MODAL_WITHOUT_LAZY_SHELL = DOM_MODAL_SELECTOR;
export const MODAL_ON_TOP = [
  MODAL_WITHOUT_LAZY_SHELL,
  // HEALTH-EXIT-FOLLOWUPS: a panel over the whole app whose chunk is still loading, or failed to load or to show
  // (LazyFallback, LazyBoundary). Settings opened over Health is one: its Esc is the overlay's, Health stays.
  "[data-lazy-overlay]",
].join(", ");

/** Anything open on top that closes on Escape by itself: a modal layer, a menu, a picker. A page under them waits. */
export const OPEN_ON_TOP = [
  MODAL_ON_TOP,
  '[role="menu"]',
  "[data-room-menu]",
  "[data-section-picker]",
  "[data-bot-menu]",
  "[data-create-menu]",
].join(", ");

export interface EscapeKeyEvent {
  key: string;
  defaultPrevented: boolean;
  isComposing?: boolean;
  /** 229 marks an IME key on engines that do not set isComposing (b12's composer rule, composer-enter.ts). */
  keyCode?: number;
}

/** True when this Escape is still free for a layer underneath: nobody used it, it is not ending an IME composition,
 * no focus trap holds the keyboard and nothing is open on top. */
export function escapeIsFree(event: EscapeKeyEvent, doc: Pick<Document, "querySelector"> | undefined): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || imeComposing(event)) return false;
  if (activeTrapCount() > 0) return false;
  return !doc?.querySelector(OPEN_ON_TOP);
}

/** True when the open phone drawer takes this Escape: no modal layer or focus trap is over it and no IME composition
 * is ending. A menu inside the drawer does not hold it back, even when that menu's own handler already prevented the
 * key: the menu closes on its own listener and the drawer closes with it. */
export function drawerTakesEscape(event: EscapeKeyEvent, doc: Pick<Document, "querySelector"> | undefined): boolean {
  return escapePassesModals(event, doc);
}

/** True when this Escape is for a non-modal layer: it is Escape, no IME composition is ending, and no modal layer or
 * focus trap is open (they keep the key). The phone drawer closes on it, and the + menu on one pressed outside it. */
export function escapePassesModals(event: EscapeKeyEvent, doc: Pick<Document, "querySelector"> | undefined): boolean {
  if (event.key !== "Escape" || imeComposing(event)) return false;
  // PULLBACK-1018 Low (c): a loading or failed PAGE shell (LazyOverlay kind page: App.tsx pages, Needs you) sits under the
  // phone drawer, so the drawer keeps Escape over it. Any other layer, or any modal in the DOM, still holds the key.
  const layers = orderedLayers();
  if (layers.length > 0 && layers.every(layer => layer.kind === "page")) return !doc?.querySelector(MODAL_WITHOUT_LAZY_SHELL);
  if (activeTrapCount() > 0) return false;
  return !doc?.querySelector(MODAL_ON_TOP);
}

/** HEALTH-EXIT-FOLLOWUPS: the Esc a loading or failed panel overlay (data-lazy-overlay, the top layer) closes on: it
 * is Escape, nobody used it, it is not ending an IME composition and no focus trap holds the keyboard. */
export function overlayTakesEscape(event: EscapeKeyEvent): boolean {
  return event.key === "Escape" && !event.defaultPrevented && !imeComposing(event) && activeTrapCount() === 0;
}

/** The drawer's Esc: when it takes the key, use it up (the page under it stays) and run `close`. Returns whether it did. */
export function takeDrawerEscape(
  event: EscapeKeyEvent & { preventDefault: () => void },
  doc: Pick<Document, "querySelector"> | undefined,
  close: () => void,
): boolean {
  if (!drawerTakesEscape(event, doc)) return false;
  event.preventDefault();
  close();
  return true;
}

/** For a page underneath: when the Escape is free, use it up and run `close`. Returns whether it did. */
export function takeFreeEscape(
  event: EscapeKeyEvent & { preventDefault: () => void },
  doc: Pick<Document, "querySelector"> | undefined,
  close: () => void,
): boolean {
  if (!escapeIsFree(event, doc)) return false;
  event.preventDefault();
  close();
  return true;
}
