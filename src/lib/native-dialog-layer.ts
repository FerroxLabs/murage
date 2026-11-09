// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { openLayer, openLayers, type LayerHandle, type LayerLifecycleLease, type TrapElement } from './focus-trap';
import { nextLayerInstance, nextLayerSequence } from './layers';
import { returnTarget, usableFocusTarget } from './return-focus';

/** Native focus belongs to the browser; this hook records successful show order and owns only the existing return helper. */
export function useNativeDialogLayer(ref: RefObject<HTMLDialogElement | null>, options: { name: string; returnFocusTo?: TrapElement | null; lease?: LayerLifecycleLease; returnTo?: (target: TrapElement | null) => void }) {
  const latest = useRef(options); latest.current = options;
  const [identity] = useState(() => ({ instance: nextLayerInstance(), opener: options.returnFocusTo === undefined ? (typeof document === "undefined" ? null : document.activeElement as HTMLElement | null) : options.returnFocusTo }));
  const current = useRef<LayerHandle | null>(null), unbind = useRef<(() => void) | undefined>(undefined);
  const nodeRef = useRef<HTMLDialogElement | null>(null), offClose = useRef<(() => void) | undefined>(undefined);
  const replaying = useRef(false);
  const browserOpener = useRef<Element | null>(null);
  const generation = useRef(0), disposing = useRef(false), dismissed = useRef(false);
  const captureReturn = () => {
    const active = current.current?.active, outgoing = nodeRef.current ?? ref.current;
    const known = new Set(openLayers().map(layer => layer.id));
    const browserReturn = browserOpener.current;
    const wasInside = !!outgoing?.contains(document.activeElement);
    let used = false;
    return () => {
      if (used) return; used = true;
      if (!active || document.querySelector('dialog[open]') || openLayers().some(layer => !known.has(layer.id))) return;
      const focus = document.activeElement as HTMLElement | null;
      if (focus && focus !== document.body && focus !== document.documentElement && !outgoing?.contains(focus) && usableFocusTarget(focus) && focus !== identity.opener && !(wasInside && focus === browserReturn)) return;
      if (latest.current.returnTo) latest.current.returnTo(identity.opener);
      else returnTarget(identity.opener, document);
    };
  };
  const release = () => { unbind.current?.(); unbind.current = undefined; current.current?.release(); current.current = null; offClose.current?.(); offClose.current = undefined; nodeRef.current = null; };
  useLayoutEffect(() => {
    replaying.current = disposing.current;
    disposing.current = false;
    if (replaying.current && ref.current?.open) show();
    return () => retire();
  }, [ref, identity]);
  const retire = () => {
    const restore = captureReturn(), retired = generation.current, node = nodeRef.current;
    disposing.current = true;
    release();
    // Wait for removal/replacement to commit. Closing a still-focused native
    // node here makes the browser return to its opener during a silent handoff.
    queueMicrotask(() => {
      if (generation.current === retired && node?.open) node.close();
    });
    if (!latest.current.lease) queueMicrotask(() => { if (generation.current === retired) restore(); });
  };
  useLayoutEffect(() => {
    // A conditionally rendered native root can disappear while its component remains mounted.
    if (nodeRef.current && nodeRef.current !== ref.current) retire();
  });
  function show() {
    const node = ref.current;
    if (!node) return;
    // A live open activation stays. A registration whose node already closed is only waiting for its queued
    // close event: it retires here, so the reopen registers a fresh activation (Astra r3 Medium 4).
    if (current.current) { if (node.open && nodeRef.current === node) return; release(); }
    disposing.current = false; dismissed.current = false;
    if (!replaying.current) identity.opener = latest.current.returnFocusTo === undefined ? document.activeElement as HTMLElement | null : latest.current.returnFocusTo;
    if (!replaying.current) browserOpener.current = document.activeElement;
    replaying.current = false;
    node.showModal(); // A thrown showModal never registers.
    const opts = latest.current;
    const handle = openLayer({ id: `${opts.name}:${identity.instance}:${++generation.current}:1`, name: opts.name, kind: 'native', openingSequence: nextLayerSequence(), returnFocusTo: identity.opener, skipReturnFocus: true });
    current.current = handle;
    nodeRef.current = node;
    const activation = generation.current;
    const closed = () => {
      // Bound to its activation: a close event queued by an earlier activation never retires this one.
      if (node.open || nodeRef.current !== node || generation.current !== activation) return;
      const restore = captureReturn(); release(); if (!disposing.current) restore();
    };
    node.addEventListener('close', closed);
    offClose.current = () => node.removeEventListener('close', closed);
    handle.attach(node, {}, 'loaded');
    unbind.current = opts.lease?.bind(handle, captureReturn);
  }
  return {
    show,
    /** Hook-owned close for a controlled caller: the registration retires before the native node closes, so a
     * queued close event can neither keep a stale owner nor clear a reopen (Astra r3 Medium 4). */
    close() {
      const node = ref.current;
      if (!current.current || disposing.current) { if (node?.open) node.close(); return; }
      const restore = captureReturn();
      release();
      if (node?.open) node.close();
      restore();
    },
    dismiss(close: () => void) {
      if (disposing.current || dismissed.current) return;
      dismissed.current = true;
      const restore = captureReturn();
      release();
      if (ref.current?.open) ref.current.close();
      restore(); close();
    },
  };
}
