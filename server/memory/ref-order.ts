// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Equal scores order by record id, then version: never by the order an index, a cache or a scan happened to hold them
 * (msearch review round 4). Code-point order, no locale. */
export const compareRefs = (a: { id: string; version: number }, b: { id: string; version: number }) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version;
/** Best first; ties by (record id, version). */
export const byScore = (a: { id: string; version: number; score: number }, b: { id: string; version: number; score: number }) => b.score - a.score || compareRefs(a, b);
