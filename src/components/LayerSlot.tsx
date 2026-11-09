// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { openLayer, type LayerContent, type LayerHandle, type LayerLifecycleLease, type TrapElement } from '../lib/focus-trap';
import { focusTarget, usableFocusTarget } from '../lib/return-focus';
import { nextLayerInstance, nextLayerSequence, type LayerKind, type LayerPhase } from '../lib/layers';

export interface LayerSlotOptions {
  name: string;
  kind: LayerKind;
  covers: 'always' | 'while-loading';
  opener?: TrapElement | null;
  openingSequence?: number;
  onDismiss: () => void;
  holdFocus?: boolean;
}
type Attachment = { node: HTMLElement; content: LayerContent; phase: LayerPhase };
/** Owner survives boundary replacements. An activation ends permanently on release. */
export class LayerOwner {
  readonly instance = nextLayerInstance();
  readonly opener: TrapElement | null;
  private generation = 0;
  private activation = 0;
  private openingSequence: number | undefined;
  private revision = 0;
  private mounted = false;
  private disposed = false;
  private attachment: Attachment | null = null;
  private surface: HTMLElement | null = null;
  private child: LayerHandle | null = null;
  private childReturn: (() => void) | undefined;
  private captureChildReturn: (() => (() => void)) | undefined;
  private readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.handle;
  private publish() { for (const listener of this.listeners) listener(); }
  handle: LayerHandle | null = null;
  readonly lease: LayerLifecycleLease = {
    bind: (handle, captureReturn) => {
      if (this.disposed) { handle.release(); return () => {}; }
      this.revision++;
      this.child = handle;
      this.captureChildReturn = captureReturn ?? (() => handle.captureReturn());
      this.childReturn = undefined;
      return () => {
        if (this.child !== handle) return;
        this.childReturn = this.captureChildReturn?.();
        this.captureChildReturn = undefined;
        this.child = null;
      };
    },
  };
  constructor(public options: LayerSlotOptions) {
    this.openingSequence = options.openingSequence;
    this.opener = options.opener === undefined ? typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null : options.opener;
  }
  private activate() {
    if (this.handle || !this.mounted || this.disposed) return;
    this.handle = openLayer({ id: `${this.options.name}:${this.instance}:${this.generation}:${++this.activation}`,
      name: this.options.name, kind: this.options.kind,
      openingSequence: this.openingSequence ??= nextLayerSequence(),
      returnFocusTo: this.opener, onDismiss: this.dismiss });
    this.apply();
    this.publish();
  }
  private apply() {
    const attachment = this.attachment;
    if (this.surface?.isConnected) this.handle?.bindSurface(this.surface);
    if (attachment?.node.isConnected) {
      const content = { holdFocus: this.options.holdFocus, ...attachment.content };
      if (this.handle?.container === attachment.node) this.handle.setContent(content);
      else this.handle?.attach(attachment.node, content, attachment.phase);
    }
  }
  mount() {
    this.mounted = true;
    this.disposed = false;
    this.generation++;
    this.revision++;
    if (this.options.covers === 'always' || (this.attachment && this.attachment.phase !== 'loaded')) this.activate();
    return () => {
      const restore = this.captureChildReturn?.() ?? this.handle?.captureReturn() ?? this.childReturn;
      const generation = this.generation;
      const revision = ++this.revision;
      this.mounted = false;
      this.handle?.release(); this.handle = null;
      this.child?.release(); this.child = null;
      queueMicrotask(() => {
        if (this.mounted || this.generation !== generation || this.revision !== revision || this.disposed) return;
        this.disposed = true;
        restore?.();
      });
    };
  }
  attach(node: HTMLElement, content: LayerContent, phase: LayerPhase) {
    if (this.disposed || !node.isConnected) return;
    this.revision++;
    this.attachment = { node, content, phase };
    if (phase !== 'loaded' || this.options.covers === 'always') this.activate();
    this.apply();
  }
  detach(node: HTMLElement) {
    if (this.attachment?.node !== node) return;
    this.handle?.detach(node);
    this.attachment = null;
  }
  update(node: HTMLElement, content: LayerContent) {
    if (this.attachment?.node !== node) return;
    this.attachment.content = content;
    this.handle?.setContent({ holdFocus: this.options.holdFocus, ...content });
  }
  bindSurface(node: HTMLElement | null, previous?: HTMLElement | null) {
    if (node && !node.isConnected) return;
    if (!node && previous && this.surface !== previous) return;
    this.surface = node;
    this.handle?.bindSurface(node);
  }
  loaded(root: HTMLElement) {
    if (this.disposed || this.options.covers !== 'while-loading') return;
    const revision = ++this.revision;
    const generation = this.generation;
    const activation = this.activation;
    // Layout transaction: the child's layout focus and registration have already run.
    const complete = () => {
      if (!this.mounted || this.disposed || revision !== this.revision || generation !== this.generation || activation !== this.activation) return;
      if (this.attachment && this.attachment.phase !== 'loaded' && this.attachment.node.isConnected) return;
      if (this.handle?.active && !root.contains(document.activeElement)) {
        const focused = document.activeElement as HTMLElement | null;
        if (!focused || focused === document.body || focused === document.documentElement || !usableFocusTarget(focused) || this.handle.container?.contains(focused)) {
          const target = root.querySelector<HTMLElement>('h1, h2, [data-layer-focus]') ?? root;
          target.setAttribute('tabindex', '-1');
          if (!focusTarget(target, document)) { root.setAttribute('tabindex', '-1'); focusTarget(root, document); }
        }
      }
      this.handle?.release(); this.handle = null;
      this.openingSequence = undefined;
      this.publish();
    };
    complete();
    // Initial child layout may precede the owner's mount. Token-bound retry only.
    if (!this.mounted) queueMicrotask(() => {
      if (revision + 1 === this.revision && generation + 1 === this.generation && this.mounted) this.loaded(root);
    });
  }
  dismiss = () => {
    if (this.disposed) return;
    this.disposed = true; this.revision++;
    if (this.child) {
      // Remove the covering owner before child return so it cannot resume or leak.
      this.handle?.release();
      this.child.close();
    } else this.handle?.close();
    this.handle = null; this.child = null;
    this.publish();
    this.options.onDismiss();
  };
}
const SlotContext = createContext<LayerOwner | null>(null);
export function useLayerOwner() { return useContext(SlotContext); }
export function LayerSlot({ owner, children }: { owner: LayerOwner; children?: ReactNode }) {
  useLayoutEffect(() => owner.mount(), [owner]);
  return <SlotContext.Provider value={owner}>{children}</SlotContext.Provider>;
}
export function useSlotOwner(options: LayerSlotOptions): LayerOwner {
  const [owner] = useState(() => new LayerOwner(options));
  useLayoutEffect(() => { owner.options = options; });
  return owner;
}
/** Attachment only. Never creates an owner without an explicit slot context. */
export function useLayerContainer(ref: RefObject<HTMLElement | null>, content: LayerContent = {}, phase: LayerPhase = 'loaded') {
  const owner = useLayerOwner();
  const attached = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!owner) { if (import.meta.env.DEV) console.error('useLayerContainer requires a LayerSlot'); return; }
    const node = ref.current;
    if (attached.current !== node) {
      if (attached.current) owner.detach(attached.current);
      attached.current = node;
      if (node) owner.attach(node, content, phase);
    } else if (node) owner.update(node, content);
  });
  useLayoutEffect(() => () => {
    if (attached.current) owner?.detach(attached.current);
    attached.current = null;
  }, [owner]);
  return useSyncExternalStore(owner?.subscribe ?? noSubscribe, owner?.snapshot ?? emptySnapshot, emptySnapshot);
}

const noSubscribe = () => () => {};
const emptySnapshot = () => null;
