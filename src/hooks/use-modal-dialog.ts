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
  position: "first" | "last" | "middle" | "outside" | "empty",
  context: { editable?: boolean; dirty?: boolean } = {},
): ModalKeyAction {
  if (key === "Escape") {
    // Escape inside a field belongs to that field; it never throws the draft away
    if (context.editable) return "none";
    return context.dirty ? "confirm-close" : "close";
  }
  if (key !== "Tab") return "none";
  if (position === "empty" || position === "outside") return "wrap-to-first";
  if (shift && position === "first") return "wrap-to-last";
  if (!shift && position === "last") return "wrap-to-first";
  return "none";
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true");
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
      const items = focusables(dialog);
      const current = document.activeElement;
      const position = items.length === 0 ? "empty"
        : !dialog.contains(current) || current === dialog ? "outside"
        : current === items[0] ? "first"
        : current === items[items.length - 1] ? "last" : "middle";
      const target = event.target;
      const editable = target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));
      const action = modalKeyAction(event.key, event.shiftKey, items.length === 1 && position !== "outside" ? "last" : position, { editable, dirty: dirtyRef.current?.() === true });
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
