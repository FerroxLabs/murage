// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { currentUserSid, nativeUserSidScope, ownerVerdict, ownerOnlyVerdict, parseDacl } from '../../win-acl.ts';
import { writeFileAtomic } from '../../atomic.ts';
import { lstatIdentity, type IdentityStat } from './file-identity.ts';
import { protectWindowsParkEntries } from './park-windows-protect.ts';
import { defaultSecurityRunner, windowsSecurityPathsSync, windowsSecurityPathKey, type SecurityRunner } from './storage.ts';
import { parkIo, refuse, WINDOWS_PARK_DEADLINE_MS } from './park-fs.ts';

export interface WindowsBootstrapOptions { platform?:NodeJS.Platform;run?:SecurityRunner;sid?:()=>string|null }
export const SIGNAL_WINDOWS_BOOTSTRAP_RECORD='.signal-owner-only.json';
/** One-time first-use migration of ordinary inherited user/SYSTEM/admin grants.
 * Never repairs a broad principal, foreign owner, link, or custody evidence.
 * The persistent record disables repair on every subsequent admission. */
export function bootstrapWindowsSignal(dataDir:string,options:WindowsBootstrapOptions={}):void {
  return parkIo(()=>bootstrap(dataDir,options));
}
function bootstrap(dataDir:string,options:WindowsBootstrapOptions):void {
  if((options.platform??process.platform)!=='win32')return;
  const root=resolve(dataDir),record=join(root,SIGNAL_WINDOWS_BOOTSTRAP_RECORD);
  const pathKey=(path:string)=>windowsSecurityPathKey(fs.realpathSync.native(path));
  const rootKey=pathKey(root);
  // Presence alone only disables migration; ParkFs still verifies every ACL.
  try{fs.lstatSync(record);return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  // An imported or pending custody tree is never a bootstrap candidate.
  for(const name of ['recovery-quarantine/signal-park-control','recovery-quarantine/signal-parked']){
    try{fs.lstatSync(join(root,name));return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  const deadline=Date.now()+WINDOWS_PARK_DEADLINE_MS,run=options.run??defaultSecurityRunner;
  const sid=options.sid?options.sid():currentUserSid((file,args)=>run(file,args,{env:process.env,timeout:15_000}),process.env,options.run??nativeUserSidScope);
  if(!sid)refuse('unsafe');
  const entries=new Map<string,{path:string;stat:IdentityStat}>(),paths:string[]=[],trees:string[]=[];
  // Pin every ancestor without following a reparse directory.
  const chain:string[]=[];for(let path=root;;path=dirname(path)){chain.push(path);if(dirname(path)===path)break;}
  for(const path of chain.reverse()){const stat=lstatIdentity(path);if(!stat.isDirectory()||stat.isSymbolicLink())refuse('unsafe');paths.push(path);entries.set(pathKey(path),{path,stat});}
  const snapshot=(path:string,depth=0)=>{
    if(depth>32||entries.size>=200_000||Date.now()>=deadline)refuse('bound');
    const stat=lstatIdentity(path);if(stat.isSymbolicLink()||!(stat.isDirectory()||stat.isFile())||(stat.isFile()&&stat.nlink!==1))refuse('unsafe');
    if(stat.dev!==entries.get(rootKey)!.stat.dev)refuse('device');
    entries.set(pathKey(path),{path,stat});
    if(stat.isDirectory())for(const name of fs.readdirSync(path))snapshot(join(path,name),depth+1);
  };
  for(const name of ['channels','signal','channels/signal']){
    const path=join(root,name);let stat:IdentityStat;try{stat=lstatIdentity(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    if(!stat.isDirectory()||stat.isSymbolicLink())refuse('unsafe');paths.push(path);
    if(name==='channels')entries.set(pathKey(path),{path,stat});else{trees.push(path);snapshot(path);}
  }
  // The shared installation identity is read through ParkFs when Signal parks.
  // Migrate its existing inherited DACL, without reading or replacing its bytes.
  const install=join(root,'install-id.json');
  try{const stat=lstatIdentity(install);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)refuse('unsafe');paths.push(install);entries.set(pathKey(install),{path:install,stat});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const rows=windowsSecurityPathsSync(paths,deadline,run,process.env,trees.length?trees:undefined);
  if(!rows||rows.length!==entries.size)refuse('unsafe');
  const repairs:Array<{path:string;directory:boolean}>=[];
  const prefix=rootKey.replace(/\\+$/,'')+'\\';
  for(const row of rows){
    const key=windowsSecurityPathKey(row.path),entry=entries.get(key);if(!entry||row.attributes&0x400||Boolean(row.attributes&16)!==entry.stat.isDirectory())refuse('unsafe');
    const after=lstatIdentity(entry.path),inside=key===rootKey||key.startsWith(prefix);if(entry.stat.dev!==after.dev||entry.stat.ino!==after.ino||after.isSymbolicLink()||(inside&&(entry.stat.ctimeMs!==after.ctimeMs||entry.stat.mtimeMs!==after.mtimeMs)))refuse('changed');
    if(key!==rootKey&&!key.startsWith(prefix))continue;
    if(ownerVerdict(row.sddl??'',sid)!=='ok')refuse('unsafe');
    const dacl=parseDacl(row.sddl??'');
    if(!dacl||!dacl.allow.length||dacl.allow.some(account=>![sid,'S-1-5-18','S-1-5-32-544',...(/^S-1-5-21-\d+-\d+-\d+-500$/.test(sid)?['LA']:[])].includes(account)))refuse('unsafe');
    if(ownerOnlyVerdict(row.sddl??'',sid)!=='owner-only')repairs.push({path:entry.path,directory:entry.stat.isDirectory()});
  }
  if(!protectWindowsParkEntries(repairs,sid,deadline,run))refuse('unsafe');
  // Verify the entire resulting boundary before recording success. No repair
  // ever runs again merely because a later ACL verdict fails.
  const verified=windowsSecurityPathsSync(paths,deadline,run,process.env,trees.length?trees:undefined);
  if(!verified||verified.length!==entries.size)refuse('unsafe');
  for(const row of verified){const key=windowsSecurityPathKey(row.path),entry=entries.get(key);if(!entry||row.attributes&0x400)refuse('unsafe');const stat=lstatIdentity(entry.path);if(stat.dev!==entry.stat.dev||stat.ino!==entry.stat.ino||stat.isSymbolicLink())refuse('changed');
    if((key===rootKey||key.startsWith(prefix))&&(ownerVerdict(row.sddl??'',sid)!=='ok'||ownerOnlyVerdict(row.sddl??'',sid)!=='owner-only'))refuse('unsafe');}
  writeFileAtomic(record,JSON.stringify({version:1,dev:entries.get(rootKey)!.stat.dev,ino:entries.get(rootKey)!.stat.ino}),{mode:0o600,syncDir:true,ops:{open:((path:string)=>{
    const fd=fs.openSync(path,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);
    try{if(!protectWindowsParkEntries([{path,directory:false}],sid,deadline,run))refuse('unsafe');return fd;}catch(error){fs.closeSync(fd);throw error;}
  }) as typeof fs.openSync}});
}
