// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { wrapTabTarget } from './focus-wrap';
import { imeComposing } from './composer-enter';
import { focusTarget, returnTarget, usableFocusTarget } from './return-focus';
import { nextLayerInstance, nextLayerSequence, orderedLayers, publishLayers, registerLayer, unregisterLayer,
  type LayerEntry, type LayerKind, type LayerPhase } from './layers';
export { openLayers } from './layers';
export type { LayerKind, LayerPhase } from './layers';

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
  setAttribute?(name: string, value: string): void;
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
  target?: unknown;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  /** 229 while an IME still holds the key (Safari ends a composition with isComposing already false). */
  keyCode?: number;
  preventDefault(): void;
  stopPropagation?(): void;
}
export interface TrapFocusEvent { target: unknown }
export interface TrapDocument {
  readonly activeElement: unknown;
  readonly body?: unknown;
  readonly documentElement?: unknown;
  addEventListener(type: 'keydown', listener: (event: TrapKeyEvent) => void, capture: boolean): void;
  addEventListener(type: 'focusin', listener: (event: TrapFocusEvent) => void, capture: boolean): void;
  removeEventListener(type: 'keydown', listener: (event: TrapKeyEvent) => void, capture: boolean): void;
  removeEventListener(type: 'focusin', listener: (event: TrapFocusEvent) => void, capture: boolean): void;
  querySelector(selector: string): unknown;
}
export interface LayerContent {
  initialFocus?: TrapElement | string | null;
  onEscape?: () => void;
  holdFocus?: boolean;
}
export interface LayerOptions {
  id: string;
  name: string;
  kind: LayerKind;
  openingSequence: number;
  returnFocusTo: TrapElement | null;
  fallbackFocus?: TrapElement | string | null;
  skipReturnFocus?: boolean;
  onDismiss?: () => void;
  escapeWhileEmpty?: boolean;
  doc?: TrapDocument;
}
export interface LayerHandle {
  readonly id: string;
  readonly active: boolean;
  readonly container: TrapContainer | null;
  readonly zIndex: number | null;
  bindSurface(node: HTMLElement | null): void;
  attach(node: TrapContainer, content: LayerContent, phase: LayerPhase): void;
  detach(node: TrapContainer): void;
  setContent(content: LayerContent): void;
  keepFocusOnClose(): void;
  close(): void;
  release(): void;
  /** Capture before silent teardown; execute only after a committed owner disposal. */
  captureReturn(): () => void;
}
export interface LayerLifecycleLease {
  bind(handle: LayerHandle, captureReturn?: () => (() => void)): () => void;
}
export interface FocusTrapOptions extends LayerContent {
  lease?: LayerLifecycleLease;
  name?: string;
  kind?: LayerKind;
  returnFocusTo?: TrapElement | null;
  fallbackFocus?: TrapElement | string | null;
  skipReturnFocus?: boolean;
  doc?: TrapDocument;
}
/** Legacy one-shot release means dismissal; LayerHandle.release is a silent handoff. */
export interface FocusTrap { release(): void; readonly active: boolean }
const handles = new Map<LayerEntry, LayerImpl>();
const documents = new Map<TrapDocument, () => void>();
let restoring = 0;
function top(doc: TrapDocument): LayerImpl | undefined {
  const entries = orderedLayers(doc);
  return handles.get(entries[entries.length - 1]);
}
export function focusableWithin(container: TrapContainer): TrapElement[] {
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(element =>
    usableFocusTarget(element) && !element.getAttribute?.('tabindex')?.trim().startsWith('-'));
}
function lostFocus(doc: TrapDocument, outgoing?: TrapContainer | null): boolean {
  const focus = doc.activeElement;
  return !focus || focus === doc.body || focus === doc.documentElement || focus === outgoing
    || !usableFocusTarget(focus);
}
function guarded(doc: TrapDocument, target: unknown): boolean {
  if (top(doc)?.entry.kind === 'native' || doc.querySelector('dialog[open]')) return true;
  const root = (target as TrapElement | null)?.closest?.('[aria-modal="true"]');
  return !!root && !orderedLayers(doc).some(entry => entry.modalRoot === root);
}
/** Target-path consumers must ask before changing state or consuming the event. */
/** The open phone drawer sits above a loading or failed PAGE shell. The drawer takes the Escape on its own listener (after
 * any owner inside it), so the page shell does not count as a layer for it: it yields, and a target-path owner inside
 * the drawer (the + menu, the New chat filter) may take the key. */
/** Modals that have no layer entry: they hold Escape from the drawer and from every owner inside it (escape-layer.ts shares this). */
export const DOM_MODAL_SELECTOR = ['dialog[open]', '[role="dialog"][aria-modal="true"]', '[data-snooze-popover]'].join(', ');
/** The open phone drawer when it sits above page-only layers, else null (one rule for Escape and for Tab). */
function drawerOverPage(doc: TrapDocument): TrapContainer | null {
  const layers = orderedLayers(doc);
  if (!layers.length || !layers.every(layer => layer.kind === 'page') || doc.querySelector(DOM_MODAL_SELECTOR)) return null;
  return doc.querySelector('[data-phone-drawer-open]') as TrapContainer | null;
}
function pageUnderDrawer(doc: TrapDocument): boolean { return !!drawerOverPage(doc); }
export function canHandleLayerEscape(handle: LayerHandle | null | undefined, event: TrapKeyEvent): boolean {
  // b12's IME rule (composer-enter.ts): an Escape that ends a composition belongs to the IME, by either signal.
  if (event.key !== 'Escape' || event.defaultPrevented || imeComposing(event)) return false;
  const impl = handle instanceof LayerImpl ? handle : undefined;
  const doc = impl?.doc ?? (typeof document !== 'undefined' ? document as unknown as TrapDocument : undefined);
  if (!doc) return false;
  return (impl ? impl.active : (!top(doc) || pageUnderDrawer(doc))) && !guarded(doc, event.target ?? doc.activeElement);
}
function listen(doc: TrapDocument): void {
  if (documents.has(doc)) return;
  const escape = (event: TrapKeyEvent) => {
    const owner = top(doc); // Snapshot once: a synchronous close never redispatches.
    if (!owner || !canHandleLayerEscape(owner, event)) return;
    if (pageUnderDrawer(doc)) return;
    const callback = owner.escapeCallback();
    if (!callback) return;
    event.preventDefault();
    event.stopPropagation?.();
    callback();
  };
  const tab = (event: TrapKeyEvent) => {
    if (event.key !== 'Tab' || event.defaultPrevented || event.isComposing) return;
    const owner = top(doc);
    // The open drawer over a page shell holds Tab inside itself: the shell holds nothing, and the page behind stays out of reach.
    const drawer = drawerOverPage(doc);
    const container = drawer ?? owner?.container;
    if (!owner || !container || guarded(doc, event.target ?? doc.activeElement)) return;
    const controls = focusableWithin(container);
    const next = wrapTabTarget(controls.length, controls.indexOf(doc.activeElement as TrapElement), !!event.shiftKey);
    if (!controls.length || next !== null) {
      event.preventDefault();
      if (!controls.length) { if (!drawer) owner.focusInitial(); return; }
      // A candidate the browser refuses moves on to the next one in the same direction (Astra r3 Medium 5).
      const step = event.shiftKey ? -1 : 1;
      for (let tried = 0, at = next!; tried < controls.length; tried++, at = (at + step + controls.length) % controls.length) {
        if (focusTarget(controls[at], doc)) break;
      }
    }
  };
  const focus = (event: TrapFocusEvent) => {
    for (const entry of orderedLayers(doc)) handles.get(entry)?.observeFocus(event.target);
    const owner = top(doc);
    if (restoring || !owner?.container || guarded(doc, event.target) || pageUnderDrawer(doc)) return;
    if (owner.content.holdFocus !== false && owner.container.isConnected !== false && !owner.container.contains(event.target)) owner.focusInitial();
  };
  doc.addEventListener('keydown', escape, false);
  doc.addEventListener('keydown', tab, true);
  doc.addEventListener('focusin', focus, true);
  documents.set(doc, () => {
    doc.removeEventListener('keydown', escape, false);
    doc.removeEventListener('keydown', tab, true);
    doc.removeEventListener('focusin', focus, true);
  });
}
class LayerImpl implements LayerHandle {
  readonly doc: TrapDocument;
  readonly entry: LayerEntry;
  content: LayerContent = {};
  private ended = false;
  /** True once this layer took its initial focus (captureReturn reads it for a pending acquisition). */
  private acquired = false;
  private hasAttached = false;
  private hadFocus = false;
  private pendingFocus = false;
  private keepFocus = false;
  constructor(readonly options: LayerOptions) {
    this.doc = options.doc ?? document as unknown as TrapDocument;
    this.entry = { id: options.id, name: options.name, kind: options.kind, sequence: options.openingSequence,
      doc: this.doc, container: null, modalRoot: null, surface: null, zIndex: null };
    registerLayer(this.entry);
    handles.set(this.entry, this);
    listen(this.doc);
  }
  get id() { return this.entry.id; }
  get active() { return !this.ended && top(this.doc) === this; }
  get container() { return this.entry.container; }
  get zIndex() { return this.entry.zIndex; }
  bindSurface(node: HTMLElement | null): void {
    if (this.ended) return;
    this.entry.surface = node;
    publishLayers();
  }
  attach(node: TrapContainer, content: LayerContent, _phase: LayerPhase): void {
    if (this.ended || node.isConnected === false) return;
    if (this.container === node) { this.setContent(content); return; }
    if (this.container) this.detach(this.container);
    const first = !this.hasAttached;
    this.hasAttached = true;
    this.entry.container = node;
    this.entry.modalRoot = node.closest('[aria-modal="true"]');
    this.content = content;
    const inside = node.contains(this.doc.activeElement) && usableFocusTarget(this.doc.activeElement);
    if (inside) { this.hadFocus = true; this.acquired = true; }
    if (this.active && !guarded(this.doc, this.doc.activeElement) && !inside
      && (first || !this.acquired || this.pendingFocus || lostFocus(this.doc))) this.focusInitial();
    this.pendingFocus = false;
    publishLayers();
  }
  detach(node: TrapContainer): void {
    if (this.ended || this.container !== node) return;
    this.pendingFocus ||= this.hadFocus || node.contains(this.doc.activeElement);
    this.entry.container = null;
    this.entry.modalRoot = null;
    publishLayers();
  }
  setContent(content: LayerContent): void { if (!this.ended) this.content = content; }
  observeFocus(target: unknown): void {
    if (!this.container) return;
    if (this.container.contains(target)) this.hadFocus = true;
    else if (this.container.isConnected !== false && usableFocusTarget(target) && target !== this.doc.body && target !== this.doc.documentElement) {
      this.hadFocus = false;
      this.pendingFocus = false;
    }
  }
  focusInitial(ignoreOutgoing?: unknown): void {
    const node = this.container;
    if (!this.active || !node) return;
    const outgoingRoot = ignoreOutgoing && (this.doc.activeElement as TrapElement | null)?.closest?.('[aria-modal="true"]') === ignoreOutgoing;
    if (guarded(this.doc, this.doc.activeElement)
      && !(outgoingRoot && top(this.doc)?.entry.kind !== 'native' && !this.doc.querySelector('dialog[open]'))) return;
    if (node.contains(this.doc.activeElement) && usableFocusTarget(this.doc.activeElement)) {
      this.acquired = true;
      this.hadFocus = true;
      return;
    }
    const initial = this.content.initialFocus;
    const explicit = typeof initial === 'string' ? Array.from(node.querySelectorAll(initial)) : initial ? [initial] : [];
    for (const target of [...explicit, ...(initial === null ? [] : focusableWithin(node))]) {
      if (node.contains(target) && focusTarget(target, this.doc)) { this.acquired = true; this.hadFocus = true; return; }
    }
    node.setAttribute?.('tabindex', '-1');
    this.acquired = focusTarget(node, this.doc);
    this.hadFocus = this.acquired;
  }
  escapeCallback(): (() => void) | undefined {
    return this.container ? this.content.onEscape : this.options.escapeWhileEmpty !== false ? this.options.onDismiss : undefined;
  }
  keepFocusOnClose(): void { if (!this.ended) this.keepFocus = true; }
  private remove(): void {
    this.ended = true;
    handles.delete(this.entry);
    unregisterLayer(this.entry);
    if (!orderedLayers(this.doc).length) { documents.get(this.doc)?.(); documents.delete(this.doc); }
  }
  release(): void { if (!this.ended) this.remove(); }
  captureReturn(): () => void {
    const wasActive = this.active;
    const outgoing = this.container;
    const blocked = guarded(this.doc, this.doc.activeElement);
    const known = new Set(orderedLayers(this.doc));
    const previousFocus = this.doc.activeElement;
    const outgoingRoot = this.entry.modalRoot;
    let used = false;
    return () => {
      if (used) return;
      used = true;
      // A new committed owner supersedes this outgoing return intent.
      if (orderedLayers(this.doc).some(entry => !known.has(entry))) return;
      const currentFocus = this.doc.activeElement;
      const inOutgoingRoot = outgoingRoot && (currentFocus as TrapElement | null)?.closest?.('[aria-modal="true"]') === outgoingRoot;
      if (this.doc.querySelector('dialog[open]') || top(this.doc)?.entry.kind === 'native') return;
      if (guarded(this.doc, currentFocus) && !inOutgoingRoot) return;
      if (currentFocus !== previousFocus && !lostFocus(this.doc, outgoing) && !outgoing?.contains(currentFocus)) return;
      if (!wasActive || this.options.skipReturnFocus || this.entry.kind === 'native' || blocked) return;
      restoring++;
      try {
        const returned = !this.keepFocus && returnTarget(this.options.returnFocusTo, this.doc);
        let genericRoot = false;
        const needsRepair = () => lostFocus(this.doc, outgoing) || !!outgoing?.contains(this.doc.activeElement);
        if (!returned && needsRepair()) {
          const fallback = typeof this.options.fallbackFocus === 'string' ? this.doc.querySelector(this.options.fallbackFocus) : this.options.fallbackFocus;
          if (!focusTarget(fallback, this.doc)) {
            for (const selector of ['main', '#root']) {
              const root = this.doc.querySelector(selector) as TrapElement | null;
              root?.setAttribute?.('tabindex', '-1');
              if (focusTarget(root, this.doc)) { genericRoot = true; break; }
            }
          }
        }
        const resumed = top(this.doc);
        // Section 4 pending acquisition (Astra r3 Medium 3): a resumed layer that mounted under this one and
        // never took its initial focus takes it now, even when the return to a usable opener succeeded. A kept
        // focus (keepFocusOnClose, an accepted destination) and the native, foreign-modal and skip-return
        // exits above still win.
        const pendingAcquisition = !!resumed && !resumed.acquired && !!resumed.container && !this.keepFocus;
        if (resumed && (needsRepair() || genericRoot || pendingAcquisition)) resumed.focusInitial(this.entry.modalRoot);
      } finally { restoring--; }
    };
  }
  close(): void {
    if (this.ended) return;
    const restore = this.captureReturn();
    this.remove();
    restore();
  }
}
export function openLayer(options: LayerOptions): LayerHandle { return new LayerImpl(options); }
export function activeTrapCount(): number { return orderedLayers().length; }
export function trapFocus(container: TrapContainer, options: FocusTrapOptions = {}): FocusTrap {
  const doc = options.doc ?? document as unknown as TrapDocument;
  const handle = openLayer({ ...options, id: `trap:${nextLayerInstance()}:1:1`, name: options.name ?? 'trap',
    kind: options.kind ?? 'dialog', openingSequence: nextLayerSequence(),
    returnFocusTo: options.returnFocusTo === undefined ? doc.activeElement as TrapElement | null : options.returnFocusTo, doc });
  handle.attach(container, options, 'loaded');
  return { get active() { return handle.active; }, release: () => handle.close() };
}
/** Independent ownership: deliberately neither reads slot context nor calls useLayerContainer. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, options: Omit<FocusTrapOptions, 'doc'> = {}): LayerHandle | null {
  const latest = useRef(options);
  latest.current = options;
  const [identity] = useState(() => ({ instance: nextLayerInstance(), opener: options.returnFocusTo === undefined
    ? typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null : options.returnFocusTo }));
  const generation = useRef(0);
  const current = useRef<LayerHandle | null>(null);
  const [handle, setHandle] = useState<LayerHandle | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const opts = latest.current;
    const next = openLayer({ ...opts, id: `${opts.name ?? 'trap'}:${identity.instance}:${++generation.current}:1`,
      name: opts.name ?? 'trap', kind: opts.kind ?? 'dialog', openingSequence: nextLayerSequence(), returnFocusTo: identity.opener });
    current.current = next;
    setHandle(next);
    const unbind = opts.lease?.bind(next);
    if (ref.current) next.attach(ref.current, opts, 'loaded');
    return () => {
      const restore = next.captureReturn();
      const retired = generation.current;
      unbind?.();
      next.release();
      if (!opts.lease) queueMicrotask(() => { if (generation.current === retired) restore(); });
      if (current.current === next) current.current = null;
    };
  }, [active, identity, ref]);
  useLayoutEffect(() => {
    const next = current.current;
    if (!next) return;
    if (ref.current !== next.container) {
      if (next.container) next.detach(next.container);
      if (ref.current) next.attach(ref.current, latest.current, 'loaded');
    } else next.setContent(latest.current);
  });
  return active ? handle : null;
}
