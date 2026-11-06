// SPDX-License-Identifier: AGPL-3.0-or-later
// Test support for SMOOTH-FTS-MERGE R6 (search-merge-*.test.ts): the raw-byte residue detector, a reader of the FTS5 structure record,
// and fixtures that commit kept and deleted rows in the SAME transactions (FTS5 drops a segment whose every entry is deleted, so residue
// only exists in mixed segments).
//
// The detector (BUILDER-COMMON T13 facts): FTS5 prefix-compresses terms in a leaf page, so a trigram inside a longer word is not a
// contiguous byte run. A deleted row whose text is exactly ONE trigram whose first character no other term starts with is: e.g. `жжж`
// (d0 b6 x3). The tokenizer case-folds, so the groups are lowercase, each with its own leading character. Kept rows are ASCII.
import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export const GROUPS = ["жжж", "ффф", "щщщ"] as const;
export type Group = (typeof GROUPS)[number];
export const groupBytes = (group: Group) => Buffer.from(group, "utf8");

/** Raw index blocks of `messages_fts_data` that hold the group's bytes: what a reader of the file's index pages would find. */
export function rawBlocksWith(db: DatabaseSync, group: Group): number {
  const needle = groupBytes(group);
  let hits = 0;
  for (const row of db.prepare("SELECT block FROM messages_fts_data").all()) {
    if (row.block instanceof Uint8Array && Buffer.from(row.block).includes(needle)) hits++;
  }
  return hits;
}
/** The group's bytes anywhere in a file (the -wal, the main file): what a reader of the raw file would find. */
export function fileHas(path: string, group: Group): boolean {
  return existsSync(path) && readFileSync(path).includes(groupBytes(group));
}
/** The tombstone probe (ids >= 2^53 are tombstone pages; never read such an id as a number: node:sqlite throws ERR_OUT_OF_RANGE). */
export function tombstonePages(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 AS t FROM messages_fts_data WHERE id >= 9007199254740992 LIMIT 1").get() !== undefined;
}

/** The marker row, or undefined. */
export function markerRow(db: DatabaseSync): { done: number } | undefined {
  const row = db.prepare("SELECT done FROM transcript_index_state WHERE name = 'search_merge'").get() as { done: number } | undefined;
  return row ? { done: Number(row.done) } : undefined;
}

/** The SQLite varint (big-endian groups of 7 bits, the 9th byte whole), as FTS5's structure record uses it. */
function varint(buf: Buffer, at: number): [bigint, number] {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    const byte = buf[at + i]!;
    value = (value << 7n) | BigInt(byte & 0x7f);
    if (!(byte & 0x80)) return [value, at + i + 1];
  }
  return [(value << 8n) | BigInt(buf[at + 8]!), at + 9];
}
export interface FtsLevel { merging: number; segments: number; tombstonePages: number }
/** The levels of the index from its structure record (id 10; fts5StructureDecode: 4-byte cookie, optional V2 magic ff 00 00 01,
 * nLevel, nSegment, nWriteCounter, then per level nMerge, nSeg and each segment's fields; V2 segments add origin1, origin2,
 * nPgTombstone, nEntryTombstone, nEntry). */
export function ftsLevels(db: DatabaseSync): FtsLevel[] {
  const row = db.prepare("SELECT block FROM messages_fts_data WHERE id = 10").get() as { block?: Uint8Array } | undefined;
  if (!row?.block) return [];
  const buf = Buffer.from(row.block);
  let at = 4;
  const v2 = buf.length >= 8 && buf[4] === 0xff && buf[5] === 0 && buf[6] === 0 && buf[7] === 1;
  if (v2) at = 8;
  let n: bigint;
  [n, at] = varint(buf, at); const levels = Number(n);
  [, at] = varint(buf, at); // nSegment
  [, at] = varint(buf, at); // nWriteCounter
  const out: FtsLevel[] = [];
  for (let level = 0; level < levels; level++) {
    let merging: bigint, segs: bigint;
    [merging, at] = varint(buf, at);
    [segs, at] = varint(buf, at);
    let tombs = 0;
    for (let s = 0; s < Number(segs); s++) {
      [, at] = varint(buf, at); [, at] = varint(buf, at); [, at] = varint(buf, at); // segid, pgnoFirst, pgnoLast
      if (v2) { let t: bigint; [, at] = varint(buf, at); [, at] = varint(buf, at); [t, at] = varint(buf, at); tombs += Number(t); [, at] = varint(buf, at); [, at] = varint(buf, at); }
    }
    out.push({ merging: Number(merging), segments: Number(segs), tombstonePages: tombs });
  }
  return out;
}
export const totalSegments = (db: DatabaseSync) => ftsLevels(db).reduce((sum, level) => sum + level.segments, 0);

/** p50 / p99 / max of a list of ms (rounded to 0.01). */
export function spread(values: number[]): { n: number; p50: number; p99: number; max: number } {
  if (!values.length) return { n: 0, p50: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
  const r = (x: number) => Math.round(x * 100) / 100;
  return { n: sorted.length, p50: r(at(0.5)), p99: r(at(0.99)), max: r(sorted[sorted.length - 1]!) };
}
