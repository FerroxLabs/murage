// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Catalog producer and marketplace consumer owner: catalog-dupes.
export interface CatalogCardIdentity {
  /** Digest of the full name and description, before display-copy edits. */
  duplicateKey?: string;
  active?: boolean;
  toolCount?: number;
}
export interface IdentifiedCatalogCard extends CatalogCardIdentity {
  slug: string;
  label: string;
  blurb: string;
}
export const catalogWords = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
export const catalogIdentity = (card: IdentifiedCatalogCard) => card.duplicateKey ?? JSON.stringify([catalogWords(card.label), catalogWords(card.blurb)]);
const nameSlug = (card: IdentifiedCatalogCard) => catalogWords(card.label).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
function preference(a: IdentifiedCatalogCard, b: IdentifiedCatalogCard): number {
  return Number(b.slug.toLowerCase() === nameSlug(b)) - Number(a.slug.toLowerCase() === nameSlug(a))
    || Number(b.active === true) - Number(a.active === true)
    || (b.toolCount ?? 0) - (a.toolCount ?? 0)
    || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}

/** Unknown inventory preserves candidates. All known connected aliases stay. */
export function collapseCatalogCards<T extends IdentifiedCatalogCard>(cards: readonly T[], connected: ReadonlySet<string> | null = new Set()): T[] {
  if (connected === null) return [...cards];
  const groups = new Map<string, T[]>();
  for (const card of cards) {
    // Legacy display-only cards may have had their description filtered out.
    // A digest proves equality even for an actually empty full description.
    if (!card.duplicateKey && !catalogWords(card.blurb)) continue;
    const key = catalogIdentity(card);
    const group = groups.get(key);
    if (group) group.push(card); else groups.set(key, [card]);
  }
  const dropped = new Set<T>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const mine = group.filter(card => connected.has(card.slug));
    const winners = mine.length ? mine : [[...group].sort(preference)[0]!];
    for (const card of group) if (!winners.includes(card)) dropped.add(card);
  }
  return cards.filter(card => !dropped.has(card));
}
