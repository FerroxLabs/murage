// SPDX-License-Identifier: AGPL-3.0-or-later
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { APPROVAL_OBJECTS, cancelOpenRecords } from './decision/records.ts';
import { beginWrite, endWrite, undoWrite } from './write-tx.ts';

export const DATA_DIR_NAMES_AFTER_118 = ['decision-gate.jsonl', 'decision-queues', 'restore-archives', 'restore-stuck-at', 'fence-notices'] as const;
const PRESERVE = ['decision-queues', 'restore-archives'] as const;
const fail = () => { throw Object.assign(new Error('DOWNGRADE_WORK_PENDING'), {code:'DOWNGRADE_WORK_PENDING'}); };
const has = (db:DatabaseSync, table:string) => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table);
export function assertNoDecisionContinuations(db:DatabaseSync):void {
  if (has(db, 'decision_continuations') && db.prepare('SELECT 1 FROM decision_continuations LIMIT 1').get()) fail();
}
/** Keep original queue payloads and local restore archives outside the older
 * installation before removing their unknown names. Never follow links. */
export function preservePost118Data(root:string):string|undefined {
  const present = PRESERVE.filter(name => existsSync(join(root, name)));
  if (!present.length) return;
  const destination = mkdtempSync(join(dirname(root), '.murage-application-data-preserved-'));
  const flush = (path:string) => { const fd=openSync(path, 'r'); try {fsyncSync(fd);} finally {closeSync(fd);} };
  const copy = (source:string, target:string, depth=0) => {
    const stat=lstatSync(source);
    if(stat.isSymbolicLink() || depth>64) fail();
    if(stat.isDirectory()) {
      mkdirSync(target, {mode:0o700});
      for(const name of readdirSync(source)) copy(join(source,name),join(target,name),depth+1);
    } else if(stat.isFile() && stat.nlink===1) copyFileSync(source,target);
    else fail();
    flush(target);
  };
  for(const name of present) copy(join(root,name),join(destination,name));
  flush(destination); flush(dirname(root));
  return destination;
}
export function removePost118Data(root:string):string[] {
  const removed:string[]=[];
  for(const name of DATA_DIR_NAMES_AFTER_118)if(existsSync(join(root,name))) {
    rmSync(join(root,name),{recursive:true,force:true}); removed.push(name);
  }
  return removed;
}
/** Old builds cannot read approval authority. Terminal transcript actions stay
 * visible, and durable source payloads have already been preserved separately. */
export function downgradeDecisionTables(db:DatabaseSync):void {
  beginWrite(db, 'decision_downgrade');
  try {
    assertNoDecisionContinuations(db);
    cancelOpenRecords(db, 'Cancelled (version change)');
    for(const [kind,names] of [['TRIGGER',APPROVAL_OBJECTS.triggers],['INDEX',APPROVAL_OBJECTS.indexes],['TABLE',APPROVAL_OBJECTS.tables]] as const)
      for(const name of names)db.exec(`DROP ${kind} IF EXISTS ${name}`);
    endWrite(db, 'decision_downgrade');
  } catch(error) {undoWrite(db, 'decision_downgrade'); throw error;}
}
