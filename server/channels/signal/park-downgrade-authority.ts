// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {readRoutineRunsStrict,routinesCommit} from '../../routine-runs-journal.ts';
import {ParkFs,refuse} from './park-fs.ts';
import type {ParkControl} from './park-control.ts';

/** The synchronous, leased downgrade cannot dispatch or run asynchronous replay.
 * A completed replacement may proceed only while its persisted authority is
 * retired. Reverted/unfinished stores require normal startup replay first.
 * This checks stores without modifying them or discarding transaction history.
 */
export function assertSignalDowngradeAuthority(io:ParkFs,control:ParkControl) {
 if(control.replacements.some(tx=>tx.phase!=='ready'))refuse('conflict');
 const ids=new Set(control.replacements.flatMap(tx=>tx.connectionIds)),runIds=new Set(control.replacements.flatMap(tx=>tx.runIds));
 for(const tx of control.replacements)for(const name of [...tx.oldBundles,...(tx.live?[tx.live.bundleName]:[])]){
  if(control.decisions[name]?.kind!=='held')refuse('conflict');
 }
 const file=join(io.root,'messages.db');if(!io.checked(file,true)?.isFile())refuse('conflict');
 for(const suffix of ['-wal','-shm'])if(io.checked(file+suffix))io.checked(file+suffix,true);
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
  let count=0;
  for(const row of db.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='human-binding'").iterate()){
   io.tick();if(++count>200_000)refuse('bound');
   const binding=JSON.parse(String(row.intent));
   if(binding.active&&binding.origin?.platform==='signal'&&ids.has(binding.origin.connectionId))refuse('conflict');
  }
 }finally{db.close();}
 const routines=join(io.root,'routines.json'),doc=io.checked(routines)?JSON.parse(io.read(routines,64*1024*1024).toString('utf8')):{};
 // Consume the checked bytes once. The lenient startup reader must never
 // conceal unfinished authority after a failed second read or corrupt line.
 let bytes=0;
 const journal=readRoutineRunsStrict(io.root,routinesCommit(doc),{
  list:dir=>io.list(dir,4096),
  read:file=>{const data=io.read(file,64*1024*1024);bytes+=data.length;if(bytes>64*1024*1024)refuse('bound');return data.toString('utf8');},
 });
 const runs=new Map<string,unknown>();
 const addRun=(value:unknown)=>{
  io.tick();runs.set(String((value as {id?:string}).id),value);if(runs.size>200_000)refuse('bound');
 };
 for(const value of journal)addRun(value);
 for(const value of doc.runs??[])addRun(value);
 for(const value of runs.values()){
  io.tick();const run=value as {id?:string;status?:string;channelOrigin?:{platform?:string;connectionId?:string};eventBudget?:{closed?:boolean}};
  if(!runIds.has(run.id??'')&&!(run.channelOrigin?.platform==='signal'&&ids.has(run.channelOrigin.connectionId??'')))continue;
  if(!['completed','failed','cancelled','missed'].includes(run.status??'')||(run.eventBudget&&!run.eventBudget.closed))refuse('conflict');
 }
}
