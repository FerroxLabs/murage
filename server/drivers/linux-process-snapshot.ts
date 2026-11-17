// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Local snapshot producer and bounded MCP teardown consumer owner: askcards-flake-b.
import { readdirSync, readFileSync } from 'node:fs';
import { walk, type ProcessArgs, type ProcessIdentities } from './process-tree.ts';
const SNAPSHOT_BYTES=4*1024*1024; // Preserve the ps probes' result bound.

const gone=(pid:number):boolean=>{
  try {process.kill(pid,0);return false;}
  catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}
};
function stat(pid:number):{ppid:number;start:string}|undefined {
  let text:string;
  try {text=readFileSync(`/proc/${pid}/stat`,'utf8');}
  catch(error){if(gone(pid))return;throw error;}
  const end=text.lastIndexOf(')'),fields=text.slice(end+2).trim().split(/\s+/);
  // comm can contain spaces, parentheses and newlines; only the final ')' ends it.
  if(!text.startsWith(`${pid} (`) || end<0 || !/^[A-Za-z]$/.test(fields[0]??'')
    || !/^\d+$/.test(fields[1]??'') || !Number.isSafeInteger(Number(fields[1])) || !/^\d+$/.test(fields[19]??''))throw new Error('PROCESS_SNAPSHOT_UNAVAILABLE');
  return {ppid:Number(fields[1]),start:`proc:${fields[19]}`};
}

/** No child process or queued I/O callback may decide whether a bounded stop snapshot answered. */
export function linuxDescendantIdentities(root:number):ProcessIdentities|null {
  try {
    const rows=new Map<number,{ppid:number;start:string}>();
    let bytes=0;
    for(const name of readdirSync('/proc')) {
      if(!/^[1-9]\d*$/.test(name))continue;
      const pid=Number(name),row=stat(pid);
      if(row){bytes+=name.length+String(row.ppid).length+row.start.length+3;if(bytes>SNAPSHOT_BYTES)return null;rows.set(pid,row);}
    }
    if(!rows.has(process.pid))return null;
    const found=walk([...rows].map(([pid,row])=>`${pid} ${row.ppid}`).join('\n'),root,null,null)!.found;
    return new Map([...found].map(pid=>[pid,rows.get(pid)!.start]));
  } catch {return null;}
}

/** Read identity around argv so PID reuse cannot authorize signalling another process. */
export function linuxParentsAndArgs(pids:Iterable<number>):Map<number,ProcessArgs>|null {
  const rows=new Map<number,ProcessArgs>();
  let bytes=0;
  for(const pid of new Set(pids)) {
    if(!Number.isInteger(pid)||pid<=0)continue;
    try {
      const first=stat(pid);if(!first)continue;
      const text=readFileSync(`/proc/${pid}/cmdline`,'utf8');
      bytes+=Buffer.byteLength(text)+String(pid).length+String(first.ppid).length+first.start.length+4;
      if(bytes>SNAPSHOT_BYTES)return null;
      const args=text.split('\0').filter(Boolean).join(' ');
      const last=stat(pid);if(!last)continue;
      if(first.start!==last.start)return null;
      rows.set(pid,{...last,args});
    } catch {if(!gone(pid))return null;}
  }
  return rows;
}
