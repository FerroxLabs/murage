// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { retryableLazy } from '../components/LazyBoundary';

const roots = new Map<Root, HTMLElement>();
/** jsdom contract shim only. Native cancel and geometry require Chromium. */
export function installDOMHarness(): () => void {
  const global = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const priorAct = global.IS_REACT_ACT_ENVIRONMENT;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const rects = HTMLElement.prototype.getClientRects;
  const show = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  const close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
  HTMLElement.prototype.getClientRects = function () {
    if (!this.isConnected) return [] as unknown as DOMRectList;
    for (let node: HTMLElement | null = this; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      // visibility:hidden keeps its boxes, as in Chromium: production policy (usableFocusTarget) must exclude it,
      // not this shim (Astra r3 Medium 5).
      if (node.hidden || style.display === 'none') return [] as unknown as DOMRectList;
      if (node.tagName === 'DETAILS' && !node.hasAttribute('open') && node !== this) {
        const summary = Array.from(node.children).find(child => child.tagName === 'SUMMARY');
        if (!summary?.contains(this)) return [] as unknown as DOMRectList;
      }
    }
    return [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList;
  };
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
  return () => {
    cleanup();
    HTMLElement.prototype.getClientRects = rects;
    if (show) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', show);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    if (close) Object.defineProperty(HTMLDialogElement.prototype, 'close', close);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
    global.IS_REACT_ACT_ENVIRONMENT = priorAct;
  };
}
export function mount(content: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.set(root, container);
  act(() => root.render(content));
  return {
    container,
    rerender(next: ReactNode) { act(() => root.render(next)); },
    unmount() {
      if (!roots.delete(root)) return;
      act(() => root.unmount());
      container.remove();
    },
  };
}
export function cleanup(): void {
  for (const [root, container] of roots) {
    act(() => root.unmount());
    container.remove();
  }
  roots.clear();
  document.getElementById('murage-layer-host')?.remove();
}
export function press(key: string, target: EventTarget = document.activeElement ?? document, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}
export async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}
export async function frame(): Promise<void> {
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
}
export function gate<P extends object = Record<string, never>>() {
  let resolve!: (module: { default: ComponentType<P> }) => void;
  let reject!: (error: unknown) => void;
  const load = () => new Promise<{ default: ComponentType<P> }>((yes, no) => { resolve = yes; reject = no; });
  const lazy = retryableLazy(load);
  return {
    ...lazy,
    async resolve(component: ComponentType<P>) { await act(async () => { resolve({ default: component }); }); },
    async rejectChunk() {
      await act(async () => { reject(new TypeError('Failed to fetch dynamically imported module: fixture.js')); });
    },
  };
}
