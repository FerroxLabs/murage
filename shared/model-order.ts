// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// SEAN 1114-MODEL-ORDER. Only this module compares model rows. Callers supply
// presentation groups/priority, never conversation state. Treat lists as immutable.
export interface ModelOrderRow {
  id: string;
  label: string;
  group?: string;
  groupRank?: number;
  /** Favorites may move presentation groups without changing family freshness. */
  familyScope?: string;
  priceTier?: number;
  pricing?: { outputPerMillion?: number };
  family?: string;
  version?: readonly number[];
  /** Existing deliberate order (Flux routes, favorites, unavailable selection). */
  preserveOrder?: boolean;
  /** Prefer this copy when an id occurs twice, preserving the selected route. */
  selected?: boolean;
  /** Distinct billing accounts for an otherwise identical route. */
  identity?: string;
  /** Human account name when equal model ids are separate billing choices. */
  identityLabel?: string;
}
export type OrderedModel<T> = T & { older: boolean };
const memo = new WeakMap<readonly ModelOrderRow[], OrderedModel<ModelOrderRow>[]>();
const collator = new Intl.Collator("en", { numeric: true });
export const PRICE_BANDS = Object.freeze([
  { below: 2, band: "$" }, { below: 10, band: "$$" },
  { below: 20, band: "$$$" }, { below: 40, band: "$$$$" },
  { below: Infinity, band: "$$$$$" },
]);
export function modelPriceTier(pricing?: { outputPerMillion?: number }): number | undefined {
  const price = pricing?.outputPerMillion;
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return undefined;
  return PRICE_BANDS.findIndex(band => price < band.below) + 1;
}
/** Snapshot names are not live freshness evidence. Catalog marks are validated
 * against siblings by orderModels, including when vendor order is preserved. */
export function withoutNewestMark(label: string): string {
  return label.replace(/\s*\((?:latest|newest|current)\)/gi, "").replace(/\s*[·—-]?\s*\b(?:latest|newest)\b/gi, "").trim();
}
/** First numeric version, with any variant words on either side as the family.
 * Effort and build dates do not create a new generation. No vendor/model table. */
export function parseModelVersion(id: string): { family: string; version: readonly number[] } {
  const bare = id.toLowerCase().split("::").at(-1)!.split("/").at(-1)!.replace(/^flux-pinned-/, "");
  const match = /(?:^|[-_])(\d{1,3}(?:[.-]\d{1,3})*)(?=$|[-_])/.exec(bare);
  if (!match) return { family: id, version: [] };
  const start = match.index + (match[0].startsWith("-") || match[0].startsWith("_") ? 1 : 0);
  const number = match[1]!;
  const rest = bare.slice(start + number.length);
  const suffix = rest ? rest.replace(/[-_]\d{8}(?=$|[-_])/g, "").replace(/[-_](?:high|low|medium|minimal|thinking)$/, "") : "";
  let family = `${bare.slice(0, start)}${suffix}`;
  if (family.includes("_") || family.includes("--")) family = family.replace(/[-_]+/g, "-");
  if (family.startsWith("-")) family = family.slice(1);
  if (family.endsWith("-")) family = family.slice(0, -1);
  return { family, version: number.includes(".") || number.includes("-") ? number.split(/[.-]/).map(Number) : [Number(number)] };
}
/** Model names can sit between a route prefix and a variant suffix. Keep the
 * shared token sequence, including nonadjacent words, without a model table. */
function sharedTokens(a: readonly string[], b: readonly string[]): string[] {
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  const common: string[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { common.push(a[i]!); i++; j++; }
    else if (lengths[i + 1]![j]! > lengths[i]![j + 1]!) i++;
    else j++;
  }
  return common;
}
function compareVersion(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (b[i] ?? 0) - (a[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

/** Pure and O(n log n) on the list only; repeated reads of the same list are O(1).
 * A majority unpriced means the vendor's whole group order wins. In an ordered
 * group, unpriced rows retain relative input order after priced rows in each
 * current/older section. Only the newest remaining version of each family is
 * eligible; among eligible rows price wins, including equal-version variants. */
export function orderModels<T extends ModelOrderRow>(rows: readonly T[]): OrderedModel<T>[] {
  const cached = memo.get(rows);
  if (cached) return cached as OrderedModel<T>[];
  type Entry = { row: T; index: number; scope: string; family: string; version: readonly number[]; tier?: number; superseded: boolean; label: string };
  const groups = new Map<string, { rank: number; index: number; entries: Map<string, Entry> }>();
  rows.forEach((row, index) => {
    const groupKey = row.group ?? "";
    let group = groups.get(groupKey);
    if (!group) { group = { rank: row.groupRank ?? 0, index, entries: new Map() }; groups.set(groupKey, group); }
    const key = row.identity ?? row.id;
    const prior = group.entries.get(key);
    if (prior && !row.selected) return;
    const parsed = parseModelVersion(row.id);
    group.entries.set(key, { row, index: prior?.index ?? index, scope: row.familyScope ?? groupKey, family: row.family ?? parsed.family,
      version: row.version ?? parsed.version, tier: row.priceTier ?? modelPriceTier(row.pricing), superseded: false, label: row.label });
  });
  const newestByScope = new Map<string, Map<string, Entry>>();
  for (const group of groups.values()) for (const entry of group.entries.values()) {
    let newest = newestByScope.get(entry.scope);
    if (!newest) { newest = new Map(); newestByScope.set(entry.scope, newest); }
    const previous = newest.get(entry.family);
    if (!previous || compareVersion(entry.version, previous.version) < 0) newest.set(entry.family, entry);
  }
  const output: OrderedModel<T>[] = [];
  for (const group of [...groups.values()].sort((a, b) => a.rank - b.rank || a.index - b.index)) {
    const entries = [...group.entries.values()];
    const preserve = entries.some(entry => entry.row.preserveOrder) || entries.filter(entry => entry.tier === undefined).length > entries.length / 2;
    for (const entry of entries) {
      entry.superseded = compareVersion(entry.version, newestByScope.get(entry.scope)!.get(entry.family)!.version) > 0;
      if (entry.superseded) entry.label = withoutNewestMark(entry.label);
    }
    // Strip shared id tokens to expose the actual distinction first. Account
    // names describe billing choices; technical route ids remain on the row.
    const names = new Map<string, Entry[]>();
    for (const entry of entries) { const name = names.get(entry.label) ?? []; name.push(entry); names.set(entry.label, name); }
    const usedNames = new Set([...names.entries()].filter(([, same]) => same.length === 1).map(([name]) => name));
    for (const same of names.values()) if (same.length > 1) {
      const tokens = same.map(entry => entry.row.id.split(/[-_/]+/));
      let prefix = 0, suffix = 0;
      while (tokens.every(parts => parts[prefix] !== undefined && parts[prefix] === tokens[0]![prefix])) prefix++;
      while (tokens.every(parts => parts.length - suffix > prefix && parts.at(-1 - suffix) === tokens[0]!.at(-1 - suffix))) suffix++;
      const common = tokens.reduce((sequence, parts) => sharedTokens(sequence, parts));
      const fragments = tokens.map(parts => {
        let next = 0;
        return parts.filter(part => part === common[next] ? (next++, false) : true);
      });
      // If removing common words loses a meaningful rearrangement, retain the
      // differing middle span instead (e.g. a-x versus x-a).
      const fragmentIds = new Map<string, string>();
      const ambiguous = fragments.some((parts, index) => {
        const key = parts.join(" "), id = same[index]!.row.id, prior = fragmentIds.get(key);
        fragmentIds.set(key, id);
        return prior !== undefined && prior !== id;
      });
      const idCounts = new Map<string, number>();
      for (const entry of same) idCounts.set(entry.row.id, (idCounts.get(entry.row.id) ?? 0) + 1);
      for (const [index, entry] of same.entries()) {
        const sameId = idCounts.get(entry.row.id)! > 1;
        const parts = tokens[index]!;
        const variant = (ambiguous ? parts.slice(prefix, parts.length - suffix) : fragments[index]!).join(" ") || (prefix ? "base" : "direct");
        let distinction = variant;
        if (sameId) {
          const account = entry.row.identityLabel ?? entry.row.identity ?? variant;
          distinction = idCounts.size > 1 ? `${variant} · ${account}` : account;
        }
        let label = `${distinction} · ${entry.label}`;
        // A provider can itself publish a derived name. Keep that rare collision
        // deterministic without renaming unrelated rows or exposing counters.
        if (usedNames.has(label)) label = `${distinction} · ${entry.row.identity ?? entry.row.id} · ${entry.label}`;
        while (usedNames.has(label)) label = `${distinction} · ${label}`;
        entry.label = label;
        usedNames.add(label);
      }
    }
    const append = (entry: Entry, older: boolean) => output.push({ ...entry.row, label: entry.label, older });
    if (preserve) { entries.forEach(entry => append(entry, false)); continue; }
    for (const older of [false, true]) {
      const section = entries.filter(entry => entry.superseded === older);
      const compare = (a: Entry, b: Entry) => b.tier! - a.tier! || compareVersion(a.version, b.version) || collator.compare(a.label, b.label) || a.index - b.index;
      const byPrice = section.filter(entry => entry.tier !== undefined).sort(compare);
      const lastVersion = new Map<string, readonly number[]>();
      const inVersionOrder = byPrice.every(entry => {
        const previous = lastVersion.get(entry.family);
        lastVersion.set(entry.family, entry.version);
        return !previous || compareVersion(previous, entry.version) <= 0;
      });
      // Usually price order already respects version order. Avoid allocating
      // cohorts and heap nodes for that common case.
      if (inVersionOrder) {
        byPrice.forEach(entry => append(entry, older));
        section.filter(entry => entry.tier === undefined).forEach(entry => append(entry, older));
        continue;
      }
      const pricedFamilies = new Map<string, Entry[]>();
      for (const entry of byPrice) { const family = pricedFamilies.get(entry.family) ?? []; family.push(entry); pricedFamilies.set(entry.family, family); }
      // A price decrease can make a newer version cheaper than an older one.
      // Expose one version cohort per family and merge eligible rows by price.
      type Cohort = { entries: Entry[]; remaining: number; next?: Cohort };
      const ready: Array<{ entry: Entry; cohort: Cohort }> = [];
      const push = (item: typeof ready[number]) => {
        let i = ready.length; ready.push(item);
        while (i > 0) {
          const parent = (i - 1) >> 1;
          if (compare(ready[parent]!.entry, item.entry) <= 0) break;
          ready[i] = ready[parent]!; i = parent;
        }
        ready[i] = item;
      };
      const expose = (cohort: Cohort) => cohort.entries.forEach(entry => push({ entry, cohort }));
      for (const family of pricedFamilies.values()) {
        family.sort((a, b) => compareVersion(a.version, b.version) || compare(a, b));
        let first: Cohort | undefined, last: Cohort | undefined;
        for (const entry of family) {
          if (!last || compareVersion(last.entries[0]!.version, entry.version)) {
            const cohort: Cohort = { entries: [], remaining: 0 };
            if (last) last.next = cohort; else first = cohort;
            last = cohort;
          }
          last.entries.push(entry); last.remaining++;
        }
        expose(first!);
      }
      while (ready.length) {
        const item = ready[0]!, tail = ready.pop()!;
        if (ready.length) {
          let i = 0;
          while (i * 2 + 1 < ready.length) {
            let child = i * 2 + 1;
            if (child + 1 < ready.length && compare(ready[child + 1]!.entry, ready[child]!.entry) < 0) child++;
            if (compare(tail.entry, ready[child]!.entry) <= 0) break;
            ready[i] = ready[child]!; i = child;
          }
          ready[i] = tail;
        }
        append(item.entry, older);
        if (--item.cohort.remaining === 0 && item.cohort.next) expose(item.cohort.next);
      }
      section.filter(entry => entry.tier === undefined).forEach(entry => append(entry, older));
    }
  }
  memo.set(rows, output);
  return output;
}
