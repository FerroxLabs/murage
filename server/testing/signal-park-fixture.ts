// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { expect } from 'vitest';
import { currentUserSid, ownerOnlyVerdict, ownerVerdict } from '../win-acl.ts';
import { protectWindowsParkEntries } from '../channels/signal/park-windows-protect.ts';
import { defaultSecurityRunner, windowsSecurityEntrySync } from '../channels/signal/storage.ts';
import type { ParkFsOptions } from '../channels/signal/park-fs.ts';

const runAcl = (file: string, args: readonly string[]) => defaultSecurityRunner(file, args, { env: process.env, timeout: 15_000 });

const roots = new Set<string>();
const protectedEntries = new Map<string, string>();

/** Windows security requires a protected DACL on each entry, not merely safe
 * inherited grants. Only entries created by this fixture are restricted, while
 * ParkFs keeps its real SID, owner and DACL reader. Never repair test attacks. */
export function protectParkFixtureEntry(file: string): void { protectParkFixtureEntries([file]); }
function protectParkFixtureEntries(files:readonly string[],vanishedFiles:ReadonlySet<string>=new Set()):void {
  if (process.platform !== 'win32') return;
  const pending=new Map<string,{identity:string;directory:boolean}>();
  const statEntry=(entry:string)=>{
    try{return lstatSync(entry,{bigint:true});}catch(error){
      // Only a regular file observed by readdir may vanish. In particular,
      // ancestors and directories named like SQLite sidecars stay mandatory.
      if((error as NodeJS.ErrnoException)?.code==='ENOENT'&&vanishedFiles.has(entry)){protectedEntries.delete(entry);return null;}
      throw error;
    }
  };
  for(const file of files){
    const path=resolve(file);
    const root=[...roots].filter(root=>path===root||path.startsWith(root+sep)).sort((a,b)=>b.length-a.length)[0];
    if(!root)throw new Error('ACL setup outside a registered park fixture');
    const chain:string[]=[];
    for(let entry=path;;entry=dirname(entry)){chain.push(entry);if(entry===root)break;}
    for(const entry of chain.reverse()){
      const stat=statEntry(entry);if(!stat)continue;
      if(vanishedFiles.has(entry)&&!stat.isFile())throw new Error('Changed park fixture file');
      const identity=`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      if(protectedEntries.get(entry)===identity)continue;
      if(stat.isSymbolicLink()||!(stat.isFile()||stat.isDirectory()))throw new Error('Unsafe park fixture entry');
      pending.set(entry,{identity,directory:stat.isDirectory()});
    }
  }
  if(!pending.size)return;
  const sid=currentUserSid(runAcl);if(!sid)throw new Error('Windows fixture SID unavailable');
  // A last SQLite close can also win after collection but before Set-Acl.
  // Retry only when a known regular file actually disappeared; permission
  // failures and every directory failure remain fixture failures.
  for(;;){
    for(const entry of pending.keys())if(!statEntry(entry))pending.delete(entry);
    if(!pending.size)return;
    if(protectWindowsParkEntries([...pending].map(([path,entry])=>({path,directory:entry.directory})),sid,Date.now()+120_000))break;
    let vanished=false;
    for(const entry of pending.keys())if(!statEntry(entry)){pending.delete(entry);vanished=true;}
    if(!vanished)throw new Error('Windows fixture ACL setup failed');
  }
  for(const [entry,{identity}] of pending){
    const stat=statEntry(entry);if(!stat)continue;
    if(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`!==identity)throw new Error('Changed park fixture entry');
    protectedEntries.set(entry,identity);
  }
}

export const parkFixtureMkdir: typeof mkdirSync = ((...args: Parameters<typeof mkdirSync>) => {
  const result = Reflect.apply(mkdirSync, undefined, args);
  protectParkFixtureEntry(String(args[0]));
  return result;
}) as typeof mkdirSync;

export const parkFixtureWrite: typeof writeFileSync = (file, ...args) => {
  writeFileSync(file, ...args);
  if (typeof file !== 'number') protectParkFixtureEntry(String(file));
};

export const parkFixtureOpen: typeof openSync = (file, ...args) => {
  const fd = openSync(file, ...args);
  try { protectParkFixtureEntry(String(file)); return fd; }
  catch (error) { closeSync(fd); throw error; }
};
export function privateParkTemp(prefix: string): string {
  const root = mkdtempSync(prefix);
  roots.add(resolve(root));
  protectParkFixtureEntry(root);
  return root;
}

export function privateParkDirectory(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  roots.add(resolve(root));
  protectParkFixtureEntry(root);
}

/** For fixture stores created by SQLite/RoutineManager rather than put(). Call
 * only while seeding these trusted stores, before introducing any bad entries. */
export function protectParkFixtureTree(root: string): void {
  if (process.platform !== 'win32') return;
  const files:string[]=[],vanishedFiles=new Set<string>();
  const visit=(path:string)=>{files.push(path);for(const entry of readdirSync(path,{withFileTypes:true})){const file=resolve(path,entry.name);if(entry.isDirectory())visit(file);else{files.push(file);if(entry.isFile())vanishedFiles.add(file);}}};
  visit(root);protectParkFixtureEntries(files,vanishedFiles);
}

export function expectPrivateParkFile(file: string): void {
  const stat = statSync(file);
  expect(stat.isFile()).toBe(true);
  if (process.platform !== 'win32') {
    expect(stat.mode & 0o777).toBe(0o600);
    return;
  }
  // Windows mode bits cannot represent a private DACL. Inspect the native
  // descriptor instead, including ownership and the reparse attribute.
  const sid = currentUserSid(runAcl);
  expect(sid).not.toBeNull();
  const entry = windowsSecurityEntrySync(file, 15_000);
  expect(entry).not.toBeNull();
  expect(entry!.attributes & 0x400).toBe(0);
  expect(ownerVerdict(entry!.sddl ?? '', sid!)).toBe('ok');
  expect(ownerOnlyVerdict(entry!.sddl ?? '', sid!)).toBe('owner-only');
}

/** Protocol state-machine witnesses require a durable directory barrier.
 * Windows has no native directory fsync, so those witnesses supply the existing
 * sync seam. Explicit unsupported/fault options override it. The native Windows
 * durability limit is independently asserted in park-release-regressions.test.ts. Security stays real. */
export const parkProtocolOptions: ParkFsOptions = process.platform === 'win32'
  ? { sync: () => 'synced' }
  : {};
