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
function LoadedCommit({ owner, children }: { owner: LayerOwner; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (ref.current) owner.loaded(ref.current); });
  return <div ref={ref}>{children}</div>;
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
      <Suspense fallback={shell}><LoadedCommit owner={owner}>{content}</LoadedCommit></Suspense>
    </LazyBoundary>
  </LayerSlot>;
}
