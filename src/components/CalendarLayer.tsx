// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { canHandleLayerEscape, useFocusTrap, type LayerContent } from '../lib/focus-trap';
import { LayerOwner } from './LayerSlot';
import type { LoadedLayerProps } from './LazyOverlay';
export interface CalendarLayerProps { lifecycle?: LoadedLayerProps }
/** A replacement controller, with no entry or paint surface of its own. */
export function CalendarLifetime({ children }: { children: (props: LoadedLayerProps) => ReactNode }) {
  const [owner] = useState(() => new LayerOwner({ name: 'calendar-lifetime', kind: 'page', covers: 'while-loading', onDismiss: () => {} }));
  useLayoutEffect(() => owner.mount(), [owner]);
  return children({ opener: owner.opener, lease: owner.lease, dismiss: owner.dismiss });
}
export function useCalendarLayer(ref: RefObject<HTMLElement | null>, name: string, onEscape: () => void, lifecycle?: LoadedLayerProps, initialFocus?: LayerContent['initialFocus']) {
  const layer = useFocusTrap(ref, true, { name, kind: 'page', onEscape, initialFocus, returnFocusTo: lifecycle?.opener, lease: lifecycle?.lease });
  useLayoutEffect(() => {
    const node = ref.current;
    const consumeEditable = (event: KeyboardEvent) => {
      if (!canHandleLayerEscape(layer, event)) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select, [contenteditable="true"]'))) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    node?.addEventListener('keydown', consumeEditable);
    return () => node?.removeEventListener('keydown', consumeEditable);
  }, [layer, ref]);
  return layer;
}
