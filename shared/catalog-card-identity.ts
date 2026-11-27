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
/** Renamed apps the vendor still lists under their old slug, with different words (1.0.21: "Twitter, Inc. was an
 *  American..." sat beside "X (Twitter)"). Old slug -> the slug the person knows. One card, the known slug wins
 *  unless the person holds a connection on the old one. */
export const SAME_APP_SLUGS: Readonly<Record<string, string>> = { twitter: "x" };
const sameAppSlug = (slug: string): string | undefined => {
  const lower = slug.toLowerCase();
  return SAME_APP_SLUGS[lower] ?? (Object.values(SAME_APP_SLUGS).includes(lower) ? lower : undefined);
};
export const catalogIdentity = (card: IdentifiedCatalogCard) => {
  const same = sameAppSlug(card.slug);
  return same ? `same-app:${same}` : card.duplicateKey ?? JSON.stringify([catalogWords(card.label), catalogWords(card.blurb)]);
};
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
    if (!card.duplicateKey && !catalogWords(card.blurb) && !sameAppSlug(card.slug)) continue;
    const key = catalogIdentity(card);
    const group = groups.get(key);
    if (group) group.push(card); else groups.set(key, [card]);
  }
  const dropped = new Set<T>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const mine = group.filter(card => connected.has(card.slug));
    const known = group.find(card => sameAppSlug(card.slug) === card.slug.toLowerCase());
    const winners = mine.length ? mine : [known ?? [...group].sort(preference)[0]!];
    for (const card of group) if (!winners.includes(card)) dropped.add(card);
  }
  return cards.filter(card => !dropped.has(card));
}
