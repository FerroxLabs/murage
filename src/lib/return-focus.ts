// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TrapElement } from './focus-trap';

export const FOCUS_FALLBACK_ATTRIBUTE = 'data-focus-fallback';
export interface ReturnDocument {
  readonly activeElement?: unknown;
  querySelector(selector: string): unknown;
}
/** Closed details can retain layout boxes in Chromium. Only its first summary
 * (and that summary's descendants) participates in focus navigation. */
function inClosedDetails(target: TrapElement): boolean {
  let details = target.closest('details:not([open])') as HTMLDetailsElement | null;
  while (details) {
    const summary = Array.from(details.children).find(child => child.tagName === 'SUMMARY');
    if (details !== target && !summary?.contains(target as unknown as Node)) return true;
    details = details.parentElement?.closest('details:not([open])') ?? null;
  }
  return false;
}
/** visibility:hidden or collapse keeps layout boxes in a browser but refuses focus (Astra r3 Medium 5). The
 * computed value is inherited, so the element's own style answers for its ancestors too. */
function hiddenByVisibility(target: TrapElement): boolean {
  const view = (target as unknown as { ownerDocument?: Document | null }).ownerDocument?.defaultView;
  if (!view?.getComputedStyle || !(target instanceof view.Element)) return false;
  const visibility = view.getComputedStyle(target).visibility;
  return visibility === 'hidden' || visibility === 'collapse';
}
/** Script focus may use negative tabindex, but never hidden or disabled targets. */
export function usableFocusTarget(value: unknown): value is TrapElement {
  const target = value as TrapElement | null;
  return !!target && typeof target.focus === 'function' && target.isConnected !== false
    && !target.matches?.(':disabled') && target.getAttribute?.('aria-hidden') !== 'true'
    && !target.closest('[inert]') && !target.closest('[hidden]')
    && !target.closest('[aria-hidden="true"]') && !inClosedDetails(target)
    && (!target.getClientRects || target.getClientRects().length > 0)
    && !hiddenByVisibility(target);
}
export function focusTarget(target: unknown, doc: ReturnDocument): boolean {
  if (!usableFocusTarget(target)) return false;
  target.focus();
  return 'activeElement' in doc ? doc.activeElement === target : true;
}
/** Try the opener, including the closed drawer's explicit handback. Verify the result. */
export function returnTarget(opener: TrapElement | null | undefined, doc: ReturnDocument = document): TrapElement | null {
  if (!opener || opener.isConnected === false) return null;
  const target = opener.closest('[inert]') ? doc.querySelector(`[${FOCUS_FALLBACK_ATTRIBUTE}]`) : opener;
  return focusTarget(target, doc) ? target as TrapElement : null;
}
/** Compatibility for native and non-layer callers. */
export function returnFocus(opener: Element | null | undefined, doc: Pick<Document, 'querySelector'> = document): void {
  returnTarget(opener as TrapElement | null | undefined, doc);
}
