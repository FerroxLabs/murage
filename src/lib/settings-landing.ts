// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SETTINGS-UX-1011 S4: a search result (or any opener that names a card) lands on the control itself, not on the
// card around it. The page's Advanced is opened by SettingsModal before the card mounts; this opens any other closed
// fold, focuses the card's control and marks the card for two seconds (a static ring, so reduced motion needs nothing
// more).
//
// No guessing (designs/UX-L3A2-LANDING-1017.md): every registered card names its own control with
// `data-setting-control="<its anchor id>"`, and the registry test holds exactly one per anchor. The landing reads that
// one mark and nothing else; with no usable mark it lands on the card.
//
// Written against the few DOM members it reads, so the tests can hand it plain stand-ins.

export interface LandingElement {
  tagName: string;
  parentElement: LandingElement | null;
  /** The document the card is in (a real element always has one); the landing looks up marks and focus there. */
  ownerDocument?: Document | null;
  id?: string;
  open?: boolean;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  focus(options?: FocusOptions): void;
  scrollIntoView?(options?: ScrollIntoViewOptions): void;
  classList: { add(...tokens: string[]): void; remove(...tokens: string[]): void };
}

/** Where the marks are looked up: the document the card is in. */
export interface LandingRoot {
  querySelectorAll(selector: string): ArrayLike<LandingElement>;
}

/** The attribute a card puts on its own control; its value is the card's anchor id. */
export const CONTROL_ATTRIBUTE = "data-setting-control";
/** The one selector a landing uses for a card. Anchor ids are plain (letters, digits, dashes); anything else finds
 *  nothing rather than being escaped into a guess. */
export function controlSelector(anchorId: string): string | null {
  return /^[A-Za-z][\w-]*$/.test(anchorId) ? `[${CONTROL_ATTRIBUTE}="${anchorId}"]` : null;
}
/** How long a landing keeps looking for a control that has not rendered yet (a lazy page still loading). */
export const LANDING_RETRY_MS = 1500;
const RETRY_STEP_MS = 100;

/** The ring a landed card wears, and the attribute tests and screen checks read while it shows. */
export const LANDED_RING = ["rounded-xl", "ring-2", "ring-accent"] as const;
export const LANDED_ATTRIBUTE = "data-setting-landed";
export const LANDED_MS = 2000;

const isFold = (node: LandingElement) => node.tagName === "DETAILS";

/** Opens every closed `<details>` fold the element sits in (and the element itself when it is one), outermost first,
 *  so a control inside a closed fold can be seen and focused. Returns how many it opened. */
export function openFoldsAround(element: LandingElement): number {
  const closed: LandingElement[] = [];
  for (let node: LandingElement | null = element; node; node = node.parentElement) {
    if (isFold(node) && !node.open) closed.push(node);
  }
  for (const fold of closed.reverse()) fold.open = true;
  return closed.length;
}

/** A marked control a person can use: enabled, not inside a disabled `<fieldset>` (which disables every control in
 *  it), and not inside anything `hidden` (closed folds are opened, so they do not count). */
function usable(control: LandingElement): boolean {
  if (control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true") return false;
  for (let node: LandingElement | null = control; node; node = node.parentElement) {
    if (node.hasAttribute("hidden")) return false;
    if (node !== control && node.tagName === "FIELDSET" && node.hasAttribute("disabled")) return false;
  }
  return true;
}

/** The control a landing focuses: the ONE element marked with this card's anchor id, when it is usable; else the
 *  card. Two marks for one card break the invariant: DOM order never decides, the card itself takes the landing. */
export function landingControl(anchor: LandingElement, root: LandingRoot): LandingElement {
  const selector = anchor.id ? controlSelector(anchor.id) : null;
  if (!selector) return anchor;
  const marks = Array.from(root.querySelectorAll(selector));
  if (marks.length > 1 && import.meta.env?.DEV) console.warn(`settings: ${marks.length} controls marked for ${anchor.id}; landing on the card`);
  return marks.length === 1 && usable(marks[0]) ? marks[0] : anchor;
}

export interface LandingDeps {
  root?: LandingRoot;
  /** Runs once after the next paint; Settings focuses its own dialog as it mounts, so focus is taken back once. */
  afterPaint?: (run: () => void) => void;
  later?: (run: () => void, ms: number) => void;
  activeElement?: () => unknown;
}

function focusControl(control: LandingElement) {
  openFoldsAround(control);
  control.focus({ preventScroll: true });
}

/** Lands on a card: opens the folds around it, scrolls it into view, focuses its marked control and marks the card.
 *  Returns the element that took focus. */
export function landOnSetting(anchor: LandingElement, deps: LandingDeps = {}): LandingElement {
  // Read lazily: injected deps never touch a document, and a real card reads its own.
  const doc = () => anchor.ownerDocument ?? document;
  const root = deps.root ?? doc();
  const afterPaint = deps.afterPaint ?? ((run) => requestAnimationFrame(run));
  const later = deps.later ?? ((run, ms) => window.setTimeout(run, ms));
  const activeElement = deps.activeElement ?? (() => doc().activeElement);
  openFoldsAround(anchor);
  anchor.scrollIntoView?.({ block: "start" });
  const control = landingControl(anchor, root);
  // The card itself takes focus when its control is not there (read-only, disabled, or not rendered yet).
  if (control === anchor && !anchor.hasAttribute("tabindex")) anchor.setAttribute("tabindex", "-1");
  focusControl(control);
  afterPaint(() => { if (activeElement() !== control) control.focus({ preventScroll: true }); });
  // A lazy page can mount its anchor before its control: keep looking for the same mark for a short while, and move
  // focus to it once it renders, unless the person has moved focus since.
  // A read-only card marks its anchor itself: that is the landing, nothing to wait for.
  if (control === anchor && anchor.getAttribute(CONTROL_ATTRIBUTE) !== anchor.id) {
    const retry = (left: number) => later(() => {
      if (activeElement() !== anchor) return;
      const found = landingControl(anchor, root);
      if (found !== anchor) focusControl(found);
      else if (left > RETRY_STEP_MS) retry(left - RETRY_STEP_MS);
    }, RETRY_STEP_MS);
    retry(LANDING_RETRY_MS);
  }
  anchor.classList.add(...LANDED_RING);
  anchor.setAttribute(LANDED_ATTRIBUTE, "");
  later(() => { anchor.classList.remove(...LANDED_RING); anchor.removeAttribute(LANDED_ATTRIBUTE); }, LANDED_MS);
  return control;
}
