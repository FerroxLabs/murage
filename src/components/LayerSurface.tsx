// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { LayerHandle } from '../lib/focus-trap';
import { useLayerOwner } from './LayerSlot';

export function layerHost(doc: Document = document): HTMLElement {
  let host = doc.getElementById('murage-layer-host');
  if (!host) {
    host = doc.createElement('div'); host.id = 'murage-layer-host';
    Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '50', isolation: 'isolate', pointerEvents: 'none' });
    doc.body.append(host);
  }
  return host;
}
export function LayerSurface({ children, handle }: { children?: ReactNode; handle?: LayerHandle | null }) {
  const owner = useLayerOwner();
  const previous = useRef<HTMLDivElement | null>(null);
  const bind = useCallback((node: HTMLDivElement | null) => {
    if (handle !== undefined) handle?.bindSurface(node);
    else owner?.bindSurface(node, previous.current);
    previous.current = node;
  }, [handle, owner]);
  if (typeof document === 'undefined') return <>{children}</>;
  return createPortal(<div ref={bind} data-layer-surface="" style={{ position: 'absolute', inset: 0, pointerEvents: 'auto', isolation: 'isolate' }}>{children}</div>, layerHost());
}
