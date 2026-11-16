// SPDX-License-Identifier: AGPL-3.0-or-later
/** Identity labels survive disabled measurement and creation before a probe installs. */
const labels = new WeakMap<object, string>();
export function labelWorkCollection<T extends object>(label: string, collection: T): T {
  labels.set(collection, label);
  return collection;
}
export function workCollectionLabel(collection: object): string | undefined { return labels.get(collection); }
