// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One focus trap for every dialog, sheet and panel that holds the keyboard (UX overhaul slice 8). While a trap is
// active, Tab and Shift+Tab cycle through the controls inside it, focus that wanders outside (a click on the page
// behind, a script) is brought back, Escape closes it when the owner asks for that, and on release focus goes back
// to whatever opened it (through returnFocus, so an opener inside the closed phone drawer hands over to the menu
// button). Traps stack: a menu opened inside a dialog owns the keyboard until it closes, then the dialog has it again.
//
// Only the DOM calls listed in TrapDocument and TrapElement are used, so the unit tests drive it with plain objects.
import { useEffect, useRef, type RefObject } from "react";

import { wrapTabTarget } from "./focus-wrap";
import { returnFocus } from "./return-focus";

/** What counts as a control a keyboard can land on. `tabindex="-1"` is reachable by script only, so it is left out. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "summary",
  "[contenteditable=\"true\"]",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(", ");

export interface TrapElement {
  focus(options?: FocusOptions): void;
  closest(selector: string): unknown;
  getAttribute?(name: string): string | null;
  matches?(selector: string): boolean;
  getClientRects?(): { length: number };
  readonly isConnected?: boolean;
}

export interface TrapContainer extends TrapElement {
  querySelectorAll(selector: string): ArrayLike<TrapElement>;
  contains(node: unknown): boolean;
}

export interface TrapKeyEvent {
  key: string;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  preventDefault(): void;
  stopPropagation?(): void;
}

export interface TrapFocusEvent {
  target: unknown;
}

export interface TrapDocument {
  readonly activeElement: unknown;
  addEventListener(type: "keydown", listener: (event: TrapKeyEvent) => void, capture: boolean): void;
  addEventListener(type: "focusin", listener: (event: TrapFocusEvent) => void, capture: boolean): void;
  removeEventListener(type: "keydown", listener: (event: TrapKeyEvent) => void, capture: boolean): void;
  removeEventListener(type: "focusin", listener: (event: TrapFocusEvent) => void, capture: boolean): void;
  querySelector(selector: string): unknown;
}

export interface FocusTrapOptions {
  /** What takes focus first: an element, a selector inside the container, or nothing (the first control, else the
   * container itself, which needs tabindex="-1" for that). */
  initialFocus?: TrapElement | string | null;
  /** Where focus goes on release. Defaults to whatever had focus when the trap started. */
  returnFocusTo?: TrapElement | null;
  /** Called on Escape. Leave it out and Escape is not handled here (a native <dialog> already turns it into cancel). */
  onEscape?: () => void;
  /** Leave focus where it is on release, for an owner that moves it somewhere on purpose. */
  skipReturnFocus?: boolean;
  doc?: TrapDocument;
}

export interface FocusTrap {
  /** Stop trapping and give focus back. Safe to call twice. */
  release(): void;
  /** True while this trap is the one that owns the keyboard. */
  readonly active: boolean;
}

const stack: FocusTrapImpl[] = [];

/** The controls a keyboard can reach inside `container`, in document order: not disabled, not hidden, not inert. */
export function focusableWithin(container: TrapContainer): TrapElement[] {
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isReachable);
}

function isReachable(element: TrapElement): boolean {
  if (element.getAttribute?.("aria-hidden") === "true") return false;
  // the selector's alternatives are independent: a tabindex="-1" button, or a disabled one with tabindex="0" (or
  // inside a disabled fieldset), still matches one of them
  if (element.getAttribute?.("tabindex")?.trim().startsWith("-")) return false;
  if (element.matches?.(":disabled")) return false;
  if (element.closest("[inert]") || element.closest("[hidden]")) return false;
  // display:none (or a collapsed <details> body) has no boxes; an element without the method is taken as visible
  if (element.getClientRects && element.getClientRects().length === 0) return false;
  return true;
}

class FocusTrapImpl implements FocusTrap {
  private released = false;
  private readonly opener: TrapElement | null;

  constructor(
    private readonly container: TrapContainer,
    private readonly options: FocusTrapOptions,
    private readonly doc: TrapDocument,
  ) {
    this.opener = options.returnFocusTo !== undefined ? options.returnFocusTo : ((doc.activeElement as TrapElement | null) ?? null);
    stack.push(this);
    doc.addEventListener("keydown", this.onKeyDown, true);
    doc.addEventListener("focusin", this.onFocusIn, true);
    this.focusInitial();
  }

  get active(): boolean {
    return !this.released && stack[stack.length - 1] === this;
  }

  private focusInitial(): void {
    const { initialFocus } = this.options;
    if (initialFocus && typeof initialFocus === "object") return initialFocus.focus();
    if (typeof initialFocus === "string") {
      const found = Array.from(this.container.querySelectorAll(initialFocus)).find(isReachable);
      if (found) return found.focus();
    }
    if (this.container.contains(this.doc.activeElement)) return;
    this.focusEdge(false);
  }

  /** Called on the trap that owns the keyboard again after the one above it closed: if focus did not come back
   * inside (the inner opener was removed, say), put it on the first control. */
  resume(): void {
    if (!this.container.contains(this.doc.activeElement)) this.focusEdge(false);
  }

  private focusEdge(last: boolean): void {
    const controls = focusableWithin(this.container);
    const target = last ? controls[controls.length - 1] : controls[0];
    (target ?? this.container).focus();
  }

  private readonly onKeyDown = (event: TrapKeyEvent): void => {
    if (!this.active || event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape" && this.options.onEscape) {
      event.preventDefault();
      event.stopPropagation?.();
      this.options.onEscape();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = focusableWithin(this.container);
    if (controls.length === 0) {
      // nothing to move to: keep the keyboard on the container rather than letting it escape to the page behind
      event.preventDefault();
      this.container.focus();
      return;
    }
    const index = controls.indexOf(this.doc.activeElement as TrapElement);
    const next = wrapTabTarget(controls.length, index, Boolean(event.shiftKey));
    if (next === null) return;
    event.preventDefault();
    controls[next].focus();
  };

  private readonly onFocusIn = (event: TrapFocusEvent): void => {
    if (!this.active || this.container.isConnected === false) return;
    if (this.container.contains(event.target)) return;
    this.focusEdge(false);
  };

  release(): void {
    if (this.released) return;
    const wasActive = this.active;
    this.released = true;
    this.doc.removeEventListener("keydown", this.onKeyDown, true);
    this.doc.removeEventListener("focusin", this.onFocusIn, true);
    const at = stack.indexOf(this);
    if (at >= 0) stack.splice(at, 1);
    // a trap under another one does not own the keyboard: closing it must not move focus out of the one on top
    if (!wasActive) return;
    if (!this.options.skipReturnFocus) returnFocus(this.opener as Element | null, this.doc as unknown as Pick<Document, "querySelector">);
    stack[stack.length - 1]?.resume();
  }
}

/** Start trapping focus inside `container`. Call release() when it closes. */
export function trapFocus(container: TrapContainer, options: FocusTrapOptions = {}): FocusTrap {
  const doc = options.doc ?? (document as unknown as TrapDocument);
  return new FocusTrapImpl(container, options, doc);
}

/** How many traps are holding the keyboard (the top one owns it). For tests and debugging. */
export function activeTrapCount(): number {
  return stack.length;
}

/** The React form: traps focus inside `ref` while `active` is true and gives it back when it turns false or unmounts.
 * When `onEscape` is given as the trap starts, the latest one is called on Escape, so a new function each render does
 * not restart the trap. */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  options: Omit<FocusTrapOptions, "doc"> = {},
): void {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const container = ref.current;
    if (!active || !container) return;
    const { initialFocus, returnFocusTo, skipReturnFocus } = latest.current;
    const trap = trapFocus(container as unknown as TrapContainer, {
      initialFocus: initialFocus as TrapElement | string | null | undefined,
      returnFocusTo,
      skipReturnFocus,
      onEscape: latest.current.onEscape ? () => latest.current.onEscape?.() : undefined,
    });
    return () => trap.release();
  }, [active, ref]);
}
