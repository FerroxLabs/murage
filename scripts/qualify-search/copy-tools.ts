// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fileDigest(file:string){
  const hash=createHash('sha256'),fd=openSync(file,'r'),buffer=Buffer.alloc(1024*1024);
  try{let n:number;while((n=readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,n));return hash.digest('hex');}
  finally{closeSync(fd);}
}
export function manifest(dir: string) {
  const result: Record<string, string> = {};
  const visit = (relative: string) => {
    for (const entry of readdirSync(join(dir, relative))) {
      const name = join(relative, entry), file = join(dir, name), s = lstatSync(file);
      if (s.isSymbolicLink()) throw Error('copy gate refuses symbolic links');
      if (s.isDirectory()) visit(name);
      else if (s.isFile()) result[digest(name)] = fileDigest(file);
      else throw Error('copy gate requires ordinary files');
    }
  };
  visit(''); return Object.fromEntries(Object.entries(result).sort());
}
export function clone(source: string, target: string) {
  if (resolve(source) === resolve(target) || resolve(target).startsWith(resolve(source) + '/')) throw Error('copy target must be outside original');
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    const from = join(source, entry), to = join(target, entry), s = lstatSync(from);
    if (s.isSymbolicLink()) throw Error('copy gate refuses symbolic links');
    if (s.isDirectory()) clone(from, to);
    else if (s.isFile()) copyFileSync(from, to);
    else throw Error('copy gate requires ordinary files');
  }
}
export function needles(db: DatabaseSync, count = 50) {
  const total = Number(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='text' AND length(text)>=3").get()!.n);
  if (!total) throw Error('copy contains no searchable messages');
  let seed = 0x1019;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  return Array.from({ length: count }, () => {
    const row = db.prepare("SELECT text FROM messages WHERE kind='text' AND length(text)>=3 ORDER BY rowid LIMIT 1 OFFSET ?").get(Math.floor(random() * total))!;
    const points = [...String(row.text)], length = Math.min(points.length, 3 + Math.floor(random() * 18));
    const offset = Math.floor(random() * (points.length - length + 1));
    return points.slice(offset, offset + length).join('');
  });
}
export function shadowBytes(db: DatabaseSync) {
  return Number(db.prepare("SELECT COALESCE(SUM(pgsize),0) AS n FROM dbstat WHERE name GLOB 'messages_fts_*'").get()!.n);
}
export function sourceSize(dir: string): number {
  return readdirSync(dir).reduce((n, name) => { const file = join(dir, name); return n + (statSync(file).isDirectory() ? sourceSize(file) : statSync(file).size); }, 0);
}

// Qualification deliberately enumerates the entire FTS posting set. The public
// search page is bounded at 2,000 candidates and cannot establish set parity.
// The production grouped walker supplies LIKE and privacy checks without that
// cap; intersection with postings retains actual FTS coverage in the result.
export function completeParity(db: DatabaseSync, samples: string[], index: DatabaseSync,
  trigram: (needle: string) => string,
  query: typeof import('../../server/message-db.ts').searchMessagesWithMeta,
  maxRowid = Number.MAX_SAFE_INTEGER) {
  const lookup = db.prepare('SELECT rowid FROM messages WHERE thread_id=? AND id=?');
  return samples.map(sample => {
    const needle = sample.trim().toLowerCase();
    if (!needle) return {needleHash:digest(sample),count:0,rowidHash:digest('[]')};
    const candidates = new Set<number>();
    // Trimming a sampled three-character needle can make it unindexable.
    // Such queries use the same exhaustive LIKE/privacy walk over all rows.
    const rows = [...needle].length >= 3
      ? index.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? AND rowid<=?').iterate(trigram(needle), maxRowid)
      : db.prepare('SELECT rowid FROM messages WHERE rowid<=?').iterate(maxRowid);
    for (const row of rows) candidates.add(Number(row.rowid));
    const kept = new Set<number>();
    for (const row of db.prepare("SELECT DISTINCT thread_id FROM messages WHERE kind IN ('text','activity')").iterate()) {
      let position: {at:number;rowid:number} | undefined;
      for (;;) {
        const walk: {budget:number;walked:number;position?:{at:number;rowid:number}} = {budget:500,walked:0};
        const result = query(needle,501,String(row.thread_id),{excludeForgotten:true},position?.at,position?.rowid,walk);
        for (const hit of result.hits) {
          const id = Number(lookup.get(hit.threadId,hit.messageId)!.rowid);
          if (candidates.has(id)) kept.add(id);
        }
        if (!result.partial) break;
        if (!walk.position || (position?.at === walk.position.at && position.rowid === walk.position.rowid)) throw Error('copy parity enumeration did not advance');
        position = walk.position;
      }
    }
    const rowids = [...kept].sort((a,b)=>a-b);
    return {needleHash:digest(sample),count:rowids.length,rowidHash:digest(JSON.stringify(rowids))};
  });
}
