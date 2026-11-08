// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TrapContainer, TrapDocument } from './focus-trap';

export type LayerKind = 'page' | 'window' | 'dialog' | 'palette' | 'native';
export type LayerPhase = 'loading' | 'error' | 'loaded';
const priority: Record<LayerKind, number> = { page: 10, window: 20, dialog: 30, palette: 40, native: 50 };
export interface LayerEntry {
  id: string;
  name: string;
  kind: LayerKind;
  sequence: number;
  doc: TrapDocument;
  container: TrapContainer | null;
  modalRoot: unknown;
  surface: HTMLElement | null;
  zIndex: number | null;
}
let sequence = 0;
let instance = 0;
export const nextLayerSequence = () => ++sequence;
export const nextLayerInstance = () => ++instance;
let entries: LayerEntry[] = [];
const subscribers = new Set<() => void>();
export function subscribeLayers(listener: () => void): () => void {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}
export function orderedLayers(doc?: TrapDocument): readonly LayerEntry[] {
  return doc ? entries.filter(entry => entry.doc === doc) : entries;
}
export function publishLayers(): void {
  const ranks = new Map<TrapDocument, number>();
  for (const entry of entries) {
    const rank = ranks.get(entry.doc) ?? 0;
    entry.zIndex = entry.kind === 'native' ? null : rank + 1;
    if (entry.kind !== 'native') ranks.set(entry.doc, rank + 1);
    if (entry.surface) entry.surface.style.zIndex = entry.zIndex === null ? '' : String(entry.zIndex);
  }
  for (const listener of subscribers) listener();
}
export function registerLayer(entry: LayerEntry): void {
  if (entries.some(other => other.id === entry.id)) throw new Error(`Duplicate layer id: ${entry.id}`);
  entries = [...entries, entry].sort((a, b) => priority[a.kind] - priority[b.kind] || a.sequence - b.sequence);
  publishLayers();
}
export function unregisterLayer(entry: LayerEntry): void {
  entries = entries.filter(other => other !== entry);
  entry.surface = null;
  entry.zIndex = null;
  publishLayers();
}
export function openLayers() {
  return [...entries].reverse().map(({ id, name, kind, sequence, container, zIndex }) => ({ id, name, kind, sequence, container, zIndex }));
}
