// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// APPROVAL-ONE-CARD: the composer panel is the one place to answer a card.
// The chat row's "Answer" moves focus to that panel's region, never to a
// button, so a stray Enter can never approve anything.

/** The attribute the panel's region carries (PendingApprovalPanel). */
export const APPROVAL_PANEL_ATTR = "data-approval-panel";

/** The attribute that names the request the panel shows. */
export const APPROVAL_PANEL_REQUEST_ATTR = "data-approval-request";

// The chat row's Answer names its own request: the queue that holds it
// selects that one first, so focus never lands on another request's buttons.
type SelectListener = (requestId: string) => void;
const selectListeners = new Set<SelectListener>();

/** The queue listens here and selects the named request; returns the unsubscribe. */
export function onSelectApprovalRequest(listener: SelectListener): () => void {
  selectListeners.add(listener);
  return () => { selectListeners.delete(listener); };
}

/** Select the request (when one is named) and focus the panel that shows it.
 * True when a panel was there to take focus. */
export function focusApprovalPanel(requestId?: string, root: ParentNode | undefined = globalThis.document): boolean {
  if (requestId) for (const listener of [...selectListeners]) listener(requestId);
  // A named request focuses only the panel showing it, never another one.
  const panel = requestId
    ? root?.querySelector<HTMLElement>(`[${APPROVAL_PANEL_ATTR}][${APPROVAL_PANEL_REQUEST_ATTR}="${cssEscape(requestId)}"]`)
    : root?.querySelector<HTMLElement>(`[${APPROVAL_PANEL_ATTR}]`);
  if (!panel) return false;
  panel.focus({ preventScroll: true });
  panel.scrollIntoView?.({ block: "nearest" });
  return true;
}

// The why-line sits in the panel and ends with "Stop asking for this"; the
// fold it opens belongs to that card's own buttons. This carries the press.
type FoldListener = (requestId: string) => void;
const foldListeners = new Set<FoldListener>();

/** Ask the card's buttons to open their "and stop asking" fold. */
export function openGrantFold(requestId: string): void {
  for (const listener of [...foldListeners]) listener(requestId);
}

/** The card's buttons listen here; returns the unsubscribe. */
export function onOpenGrantFold(listener: FoldListener): () => void {
  foldListeners.add(listener);
  return () => { foldListeners.delete(listener); };
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

/** The calls inertOutside uses, so tests can drive it with plain objects. */
export interface InertNode {
  readonly parentElement: InertNode | null;
  readonly children: ArrayLike<InertNode>;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** While a sheet is open, everything around it up to `stop` (the approval
 * queue) is inert, so the bar's own Run behind the sheet can't take focus or
 * a click. Returns the undo, which clears only what this call set. */
export function inertOutside(target: InertNode, stop: InertNode | null): () => void {
  const changed: InertNode[] = [];
  for (let at: InertNode | null = target; at && at !== stop && at.parentElement; at = at.parentElement) {
    for (const sibling of Array.from(at.parentElement.children)) {
      if (sibling === at || sibling.hasAttribute("inert")) continue;
      sibling.setAttribute("inert", "");
      changed.push(sibling);
    }
    if (at.parentElement === stop) break;
  }
  return () => { for (const node of changed) node.removeAttribute("inert"); };
}
