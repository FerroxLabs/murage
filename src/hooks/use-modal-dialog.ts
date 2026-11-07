// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from OpenMausBot #2163, Apache-2.0 (see NOTICE).
// One focus trap for modal dialogs: focus moves in on open, Tab wraps at both
// ends, Escape closes, and focus returns to whatever opened the dialog.
// Keys are heard on the dialog element itself, so a field inside it that
// handles its own Escape can still stop the event first.
import { useEffect, useRef, type RefObject } from "react";
import { t } from "@/lib/i18n";

export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type ModalKeyAction = "close" | "confirm-close" | "wrap-to-first" | "wrap-to-last" | "none";

/** What a key press inside a modal dialog should do. Pure, for tests.
 * `position` says where focus sits among the dialog's focusable controls. */
export function modalKeyAction(
  key: string,
  shift: boolean,
  position: "first" | "last" | "middle" | "only" | "outside" | "empty",
  context: { editable?: boolean; dirty?: boolean } = {},
): ModalKeyAction {
  if (key === "Escape") {
    // Escape inside a field belongs to that field; it never throws the draft away
    if (context.editable) return "none";
    return context.dirty ? "confirm-close" : "close";
  }
  if (key !== "Tab") return "none";
  // one control: Tab and Shift+Tab both stay on it, never out behind the dialog
  if (position === "empty" || position === "outside" || position === "only") return "wrap-to-first";
  if (shift && position === "first") return "wrap-to-last";
  if (!shift && position === "last") return "wrap-to-first";
  return "none";
}

type FocusCandidate = Pick<Element, "hasAttribute" | "getAttribute" | "closest"> & { parentElement?: FocusCandidate | null };
type ShownStyle = Pick<CSSStyleDeclaration, "display" | "visibility">;

/** Whether Tab may land on `el`: not disabled, not taken out of the tab order
 * (tabindex -1, even on a button or link), not inside a hidden or inert part
 * of the dialog (a collapsed section, a page behind the current step), and
 * not hidden by a style (a `hidden` or `md:hidden` class, `display: none`
 * on it or a parent, `visibility: hidden`), which the browser skips too. */
export function tabReachable(el: FocusCandidate, styleOf?: (node: FocusCandidate) => ShownStyle | null): boolean {
  if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") return false;
  if (el.getAttribute("tabindex") === "-1") return false;
  if (el.closest("[hidden], [inert]")) return false;
  if (!styleOf) return true;
  // visibility is inherited, so the control's own value already says it; display is not
  const own = styleOf(el);
  if (own?.visibility === "hidden" || own?.visibility === "collapse") return false;
  // up to the dialog: styleOf answers null past it, where the dialog's own open state rules
  for (let node: FocusCandidate | null | undefined = el; node; node = node.parentElement) {
    const style = styleOf(node);
    if (!style) break;
    if (style.display === "none") return false;
  }
  return true;
}

function focusables(root: HTMLElement): HTMLElement[] {
  const view = root.ownerDocument.defaultView;
  const styleOf = view ? (node: FocusCandidate) => (node instanceof view.Element && root.contains(node) ? view.getComputedStyle(node) : null) : undefined;
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => tabReachable(el, styleOf));
}

/** Trap focus in `ref`'s element while mounted and call `onClose` on Escape.
 * Give the element `tabIndex={-1}` so it can hold focus when it has no control. */
export function useModalDialog(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  active = true,
  /** True when the form holds edits that closing would lose; Escape then asks first. */
  isDirty?: () => boolean,
): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;
  useEffect(() => {
    const dialog = ref.current;
    if (!active || !dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.contains(document.activeElement)) (focusables(dialog)[0] ?? dialog).focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      // only Tab and Escape do anything here; typing never pays for the style reads
      if (event.key !== "Tab" && event.key !== "Escape") return;
      const items = focusables(dialog);
      const current = document.activeElement;
      const position = items.length === 0 ? "empty"
        : !dialog.contains(current) || current === dialog ? "outside"
        : items.length === 1 && current === items[0] ? "only"
        : current === items[0] ? "first"
        : current === items[items.length - 1] ? "last" : "middle";
      const target = event.target;
      const editable = target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));
      const action = modalKeyAction(event.key, event.shiftKey, position, { editable, dirty: dirtyRef.current?.() === true });
      if (action === "none") return;
      if (action === "close" || action === "confirm-close") {
        if (event.defaultPrevented || event.isComposing) return;
        event.stopPropagation();
        if (action === "confirm-close" && !window.confirm(t("modal.discardChanges"))) return;
        closeRef.current();
        return;
      }
      event.preventDefault();
      (action === "wrap-to-last" ? items[items.length - 1] : items[0] ?? dialog)?.focus();
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [ref, active]);
}
