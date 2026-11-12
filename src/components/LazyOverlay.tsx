// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { LayerLifecycleLease, TrapElement } from '../lib/focus-trap';
import { LayerSlot, useSlotOwner, type LayerOwner, type LayerSlotOptions } from './LayerSlot';
import { LazyBoundary } from './LazyBoundary';
import { LazyFallback } from './LazyFallback';

export interface LoadedLayerProps {
  opener: TrapElement | null;
  lease: LayerLifecycleLease;
  dismiss: () => void;
}
export interface LazyOverlayProps extends LayerSlotOptions {
  children?: ReactNode | ((props: LoadedLayerProps) => ReactNode);
  onRetry: () => void;
  fallback?: ReactNode;
  reload?: () => void;
}
// A page takes the whole main slot (NEEDSYOU-FULLWIDTH-1019). This wrapper sits between the main slot's flex row and the
// page's own root, so with no class of its own it sized to its content: the page stopped at its content width and the rest
// of the window was empty (every `kind: 'page'` view, 1.0.18). A page's wrapper is now the flex child that fills the slot
// and hands its width and height on to the page's root. Dialogs, windows and palettes keep the plain wrapper.
const PAGE_WRAP = 'flex h-full min-h-0 min-w-0 flex-1 flex-col';
function LoadedCommit({ owner, page, children }: { owner: LayerOwner; page?: boolean; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (ref.current) owner.loaded(ref.current); });
  return <div ref={ref} data-lazy-page={page ? '' : undefined} className={page ? PAGE_WRAP : undefined}>{children}</div>;
}
export function LazyOverlay({ children, onRetry, fallback, reload, ...options }: LazyOverlayProps) {
  const owner = useSlotOwner(options);
  const content = typeof children === 'function' ? children({ opener: owner.opener, lease: owner.lease, dismiss: owner.dismiss }) : children;
  // Only an always-covering owner may show nothing while it loads (its registered empty owner keeps Esc). Any
  // other loading view, a caller's own included, goes through the attached dismissible shell (Astra r3 Medium 8).
  const shell = fallback === null && options.covers === 'always'
    ? null
    : <LazyFallback onDismiss={owner.dismiss}>{fallback ?? undefined}</LazyFallback>;
  return <LayerSlot owner={owner}>
    <LazyBoundary onRetry={onRetry} onDismiss={owner.dismiss} reload={reload}>
      <Suspense fallback={shell}><LoadedCommit owner={owner} page={options.kind === 'page'}>{content}</LoadedCommit></Suspense>
    </LazyBoundary>
  </LayerSlot>;
}
