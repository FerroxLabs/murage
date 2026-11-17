// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { signalMountPoints } from './park-proc.ts';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import {writeFileSync as countedWriteFileSync} from "../../counted-fs.ts";
import { lstatIdentity, fstatIdentity, type IdentityStat, type IdentityStatReader } from './file-identity.ts';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { syncParentDirectoryStatus, renameWithRetry, writeFileAtomic } from '../../atomic.ts';
import { currentUserSid, nativeUserSidScope, ownerOnlyVerdict, ownerVerdict } from '../../win-acl.ts';
import { protectWindowsParkEntries } from './park-windows-protect.ts';
import { defaultSecurityRunner, windowsSecurityPathsSync, windowsSecurityPathKey, WindowsSecurityTimeoutError, type SecurityRunner, type WindowsSecurityEntry } from './storage.ts';
import { isReusableWindowsSecurityScript, isWindowsSecuritySessionRunner, markWindowsSecuritySessionRunner, windowsSecuritySessionDebug } from './windows-security-session.ts';

export type ParkReason = 'unsafe' | 'conflict' | 'changed' | 'durability' | 'busy' | 'adoption' | 'device' | 'bound' | 'security read timed out';
export class SignalParkError extends Error {
  readonly reason: ParkReason;
  constructor(reason: ParkReason) { super(reason); this.reason=reason; }
}
/** An incomplete security adapter must fail before filesystem admission. */
export class ParkFsConfigurationError extends Error {
  readonly code = 'ERR_SIGNAL_PARK_WINDOWS_CONFIG';
  constructor() { super('Injected Windows SID requires a security runner or complete entry/protection adapters'); }
}
export function refuse(reason: ParkReason): never { throw new SignalParkError(reason); }
const durabilityFailures=new WeakSet<object>();
export function rethrowDurability(error:unknown):never { if(error!==null&&(typeof error==='object'||typeof error==='function'))durabilityFailures.add(error);throw error; }
export function parkReason(error:unknown):ParkReason {
  if(error instanceof SignalParkError&&(error.reason==='security read timed out'||error.reason==='bound'))return error.reason;
  return error!==null&&typeof error==='object'&&durabilityFailures.has(error)?'durability':error instanceof SignalParkError?error.reason:'unsafe';
}
export const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
/** A listed/required entry can disappear while SQLite closes its sidecars.
 * Refuse this attempt; never publish an incomplete manifest or relax directory
 * validation. Optional absence is handled explicitly before entering here. */
export function parkIo<T>(operation:()=>T):T {
  try{return operation();}catch(error){
    const code=(error as NodeJS.ErrnoException)?.code;
    if(code==='ENOENT'||code==='EACCES'||code==='EPERM')refuse(parkReason(error)==='durability'?'durability':code==='ENOENT'?'changed':'unsafe');
    throw error;
  }
}
// A PowerShell security projection costs 0.25–0.9 seconds on real Windows.
// This is a liveness budget; expiry never authorizes bypassing a safety check.
export const WINDOWS_PARK_DEADLINE_MS = 120_000;
export interface ParkFsOptions {
  deadline?: number; platform?: NodeJS.Platform; uid?: number;
  /** The downgrade entry point primes only its known custody paths. */
  prefetchWindowsPark?: boolean;
  /** Journal binding reads install identity; ordinary Signal admission does not. */
  prefetchWindowsInstallIdentity?: boolean;
  debug?: ParkFsDebug;
  /** Native security projection, never a permission-repair adapter. */
  windowsEntry?: (path: string) => WindowsSecurityEntry | null;
  windowsRun?: SecurityRunner;
  /** Runs after the no-follow snapshot, immediately before the ACL request.
   * Observes both injected and resident security reads without replacing them. */
  beforeWindowsRead?: (paths: readonly string[]) => void;
  windowsSid?: () => string | null;
  protectNewWindowsEntry?: (path:string) => boolean;
  protectNewWindowsEntries?: (paths:readonly string[]) => boolean;
  /** Independent call trace/fault seam; called after each completed operation. */
  after?: (operation: string, path: string) => void;
  sync?: (child: string) => 'synced' | 'unsupported';
  stat?: IdentityStatReader;
  mounts?: () => readonly string[] | null;
}
export interface ParkFsDebug { childProcesses:number;powerShellSpawns:number;securityReads:number;publishParentReads:number;protectionBatches:number }
export const parkFsDebug=():ParkFsDebug=>({childProcesses:0,powerShellSpawns:0,securityReads:0,publishParentReads:0,protectionBatches:0});
export interface ComponentManifest { present: boolean; fp: string | null; entries: number; bytes: number }
export const emptyManifest = (): ComponentManifest => ({ present: false, fp: null, entries: 0, bytes: 0 });

/** Shared no-follow, same-descriptor read. Callers validate ancestors first. */
export function readSignalFile(file: string, maxBytes = 64 * 1024 * 1024, check?: (stat: IdentityStat) => void): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatIdentity(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || stat.size < 0) refuse('unsafe');
    check?.(stat);
    // Bounded fd read rather than readFileSync, whose allocation follows a racing writer.
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) break;
      offset += n;
    }
    const end = fstatIdentity(fd);
    if (offset !== stat.size || end.size !== stat.size || end.mtimeMs !== stat.mtimeMs || end.nlink !== 1) refuse('changed');
    return bytes.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}

export class ParkFs {
  readonly root: string;
  readonly rootStat: IdentityStat;
  readonly platform: NodeJS.Platform;
  readonly deadline: number;
  durabilityLimited = false;
  /** Per-operation diagnostics, including retries and every native child kind. */
  readonly debug:ParkFsDebug;
  private runWindows:SecurityRunner=(file,args,options)=>{
    this.checkWindowsConfiguration();
    const runner=this.options.windowsRun??defaultSecurityRunner;
    if(runner===defaultSecurityRunner&&process.platform==='win32'&&isReusableWindowsSecurityScript(options.input)){
      const before=windowsSecuritySessionDebug().spawns;
      try{return runner(file,args,options);}finally{const spawns=windowsSecuritySessionDebug().spawns-before;this.debug.childProcesses+=spawns;this.debug.powerShellSpawns+=spawns;}
    }
    this.debug.childProcesses++;
    if(/powershell[.]exe$/i.test(file))this.debug.powerShellSpawns++;
    return runner(file,args,options);
  };
  private work = 0;
  private mounts=new Set<string>();
  private security=new Map<string,{path:string;key:string;stat:IdentityStat;row:WindowsSecurityEntry|null}>();
  // Parent timestamps are provisional until a publishing boundary rereads
  // their DACLs. Never attribute a parent's changed key to our child mutation.
  private dirtyParents=new Map<string,string>();
  private dirtyParentStats=new Map<string,IdentityStat>();
  private queuedWindowsDirectories:string[]=[];
  private metadataReserves=new Map<string,{count:number;entries:Array<{path:string;stat:IdentityStat}>}>();
  /** Stage bounded empty journal inodes with the first protection batch. They
   * use the existing retained atomic-temp grammar and never contain secrets. */
  reserveMetadataWrites(path:string,count:number){
    if(this.platform!=='win32')return;
    if(!Number.isInteger(count)||count<1||count>8||this.metadataReserves.has(path))refuse('bound');
    this.metadataReserves.set(path,{count,entries:[]});
  }
  /** Unhandled non-link Windows reparse tags can make lstat fail before
   * native attribute inspection. Permission failures never escape as raw I/O
   * errors or authorize a missing-entry path. Only optional probes retain ENOENT;
   * a required snapshot entry disappearing invalidates this attempt. */
  private lstat(path:string,read:IdentityStatReader=this.options.stat??fs.lstatSync,optional=false):IdentityStat {
    try{return lstatIdentity(path,read);}catch(error){
      const code=(error as NodeJS.ErrnoException)?.code;
      if(code==='ENOENT'&&!optional)refuse('changed');
      if(code==='EACCES'||code==='EPERM')refuse('unsafe');
      throw error;
    }
  }
  private pathKey(path:string){return this.platform==='win32'?windowsSecurityPathKey(path):path;}
  private withinRoot(path:string){const key=this.pathKey(path),root=this.pathKey(this.root);return key===root||key.startsWith(root.replace(/[\\/]+$/,'')+(this.platform==='win32'?'\\':sep));}
  private sid:string|null|undefined;
  private securityKey(path:string,stat:IdentityStat){
    const identity=stat.dev+':'+stat.ino;
    // Shared ancestors change whenever another application creates a child
    // (including PowerShell's policy probes in TEMP). Pin their identity;
    // retain the full cache-invalidation key at the installation root and below it.
    return this.withinRoot(path)?identity+':'+stat.ctimeMs+':'+stat.mtimeMs+':'+stat.size:identity;
  }
  private readWindowsPaths(paths:readonly string[],recursiveRoot?:string|readonly string[]){
    try{
      this.options.beforeWindowsRead?.([...paths]);
      this.debug.securityReads++;
      const rows=windowsSecurityPathsSync(paths,this.deadline,this.runWindows,process.env,recursiveRoot);
      this.tick();
      if(!rows)refuse('unsafe');
      const security=new Map(rows.map(row=>[windowsSecurityPathKey(row.path),row]));
      return {size:security.size,get:(path:string)=>parkIo(()=>security.get(windowsSecurityPathKey(fs.realpathSync.native(path))))};
    }catch(error){if(Date.now()>=this.deadline)refuse('bound');if(error instanceof WindowsSecurityTimeoutError)refuse('security read timed out');throw error;}
  }
  /** Snapshot an uncached tree before one native read. Never follow links or
   * reuse an ACL after a foreign cache-key change. */
  private windowsWalk(paths:readonly string[],tree:boolean|readonly string[]=false,fresh=false,parents=new Set<string>()){
    if(this.platform!=='win32'||this.options.windowsEntry)return;
    this.tick();
    const pending=new Map<string,{path:string;stat:IdentityStat}>(),batch:string[]=[];
    const trees=new Set((Array.isArray(tree)?tree:tree?[paths[paths.length-1]!]:[]).map(path=>this.pathKey(path)));
    const recursiveRoots:string[]=[];let needsRead=fresh;
    const snapshot=(path:string,stat:IdentityStat,depth:number)=>{
      this.tick();if(depth>32||pending.size>=200_000)refuse('bound');
      if(stat.isSymbolicLink()||!(stat.isDirectory()||stat.isFile())||(stat.isFile()&&stat.nlink!==1))refuse('unsafe');
      if(this.rootStat&&stat.dev!==this.rootStat.dev)refuse('device');
      const old=this.security.get(this.pathKey(path));
      if(!old||!this.checkCached(path,old,stat))needsRead=true;
      pending.set(this.pathKey(path),{path,stat});
      if(stat.isDirectory()){const dir=parkIo(()=>fs.opendirSync(path));try{for(;;){this.tick();const ent=parkIo(()=>dir.readSync());if(!ent)break;snapshot(join(path,ent.name),this.lstat(join(path,ent.name)),depth+1);}}finally{dir.closeSync();}}
    };
    for(const path of new Map(paths.map(path=>[this.pathKey(path),path])).values()){
      let stat:IdentityStat;
      try{stat=this.lstat(path,undefined,true);}catch(error){if(absent(error)){if(fresh||parents.has(this.pathKey(path)))refuse('changed');break;}throw error;}
      if(stat.isSymbolicLink()||!(stat.isDirectory()||stat.isFile()))refuse('unsafe');
      const old=this.security.get(this.pathKey(path));
      const cached=old&&this.checkCached(path,old,stat);
      if(!fresh&&this.provisionalParent(path,stat)&&!(trees.has(this.pathKey(path))&&stat.isDirectory()))continue;
      if(old&&cached){
        if(!old.row||old.row.attributes&0x400)refuse('unsafe');
        if(!fresh&&!(trees.has(this.pathKey(path))&&stat.isDirectory()))continue;
      }
      batch.push(path);
      if(trees.has(this.pathKey(path))&&stat.isDirectory()){
        recursiveRoots.push(path);snapshot(path,stat,0);continue;
      }
      pending.set(this.pathKey(path),{path,stat});needsRead=true;
    }
    if(!pending.size||!needsRead)return;
    // Include only parents lacking current verified evidence. Our own child
    // operations never refresh a parent's key or claim its changed DACL is safe.
    for(const [key,path] of this.dirtyParents){
      const stat=this.lstat(path);this.provisionalParent(path,stat);
      const old=this.security.get(key);if(old&&this.checkCached(path,old,stat))continue;
      pending.set(key,{path,stat});if(!batch.some(item=>this.pathKey(item)===key))batch.push(path);
    }
    // PowerShell's seen set suppresses recursion for previously read parents.
    // Read the recursive root first so exact descendant parents cannot hide children.
    const readPaths=[...recursiveRoots,...batch.filter(path=>!recursiveRoots.some(root=>this.pathKey(path)===this.pathKey(root)))];
    const rows=this.readWindowsPaths(readPaths,recursiveRoots.length===1?recursiveRoots[0]:recursiveRoots.length?recursiveRoots:undefined);
    if(rows.size!==pending.size)refuse('unsafe');
    for(const {path,stat} of pending.values()){
      // Directory timestamps and size describe child/ACL activity, not the
      // identity pinned across this read. Keep the full key for later cache
      // invalidation; only regular files require a stable full key in the batch.
      const after=this.lstat(path);
      this.sameIdentity(stat,after);
      if(stat.isFile()&&this.securityKey(path,after)!==this.securityKey(path,stat))refuse('changed');
      // Check no-follow identity before realpath-based row lookup: a link swap
      // must be diagnosed before resolving the replacement's target.
      const row=rows.get(path);if(!row)refuse('unsafe');
      if(this.withinRoot(path)){
        // An unchanged cached directory had an accepted verdict. A fresh
        // reparse/shape/owner/DACL failure is a change to that evidence.
        const previous=this.security.get(this.pathKey(path));
        this.validateWindowsRow(stat,row,stat.isDirectory()&&previous?.row?'changed':'unsafe');
      }else if(row.attributes&0x400)refuse('unsafe');
    }
    // Accept new parent keys only after the whole batch passed identity and
    // full ACL checks. A partial/unsafe batch cannot authorize publication.
    for(const {path,stat} of pending.values()){
      this.security.set(this.pathKey(path),{path,key:this.securityKey(path,stat),stat,row:rows.get(path)!});
      if(parents.has(this.pathKey(path))){this.dirtyParents.delete(this.pathKey(path));this.dirtyParentStats.delete(this.pathKey(path));}
    }
  }
  private windowsRow(path:string,stat:IdentityStat){
    if(this.options.windowsEntry)return this.options.windowsEntry(path);
    const key=this.securityKey(path,stat),old=this.security.get(this.pathKey(path));
    if(old&&this.checkCached(path,old,stat))return old.row;
    this.windowsWalk([path]);
    const entry=this.security.get(this.pathKey(path));if(!entry)refuse('changed');
    // A directory can gain a child between the caller's stat and the batch
    // snapshot too. The batch supplied a fresh ACL verdict; pin identity and
    // shape at this handoff without imposing directory timestamp stability.
    if(stat.isDirectory())this.sameIdentity(stat,entry.stat);
    else if(entry.key!==key)refuse('changed');
    return entry.row;
  }
  private sameIdentity(before:IdentityStat,after:IdentityStat){
    if(after.isSymbolicLink()||before.dev!==after.dev||before.ino!==after.ino||before.isDirectory()!==after.isDirectory()||before.isFile()!==after.isFile()||(after.isFile()&&after.nlink!==1))refuse('changed');
  }
  private checkCached(path:string,old:{key:string;stat:IdentityStat},stat:IdentityStat){
    if(!this.withinRoot(path)){this.sameIdentity(old.stat,stat);return true;}
    if(old.stat.isDirectory())this.sameIdentity(old.stat,stat);
    if(old.key===this.securityKey(path,stat))return true;
    // A foreign change invalidates evidence; it never inherits the old ACL.
    this.security.delete(this.pathKey(path));return false;
  }
  private provisionalParent(path:string,stat:IdentityStat){
    const before=this.dirtyParentStats.get(this.pathKey(path));if(!before)return false;
    this.sameIdentity(before,stat);return true;
  }
  private dirtyParent(path:string){
    if(this.platform!=='win32')return;
    const key=this.pathKey(path);
    if(!this.dirtyParents.has(key))this.dirtyParentStats.set(key,this.security.get(key)?.stat??this.lstat(path));
    this.dirtyParents.set(key,path);
  }
  private validateWindowsRow(stat:IdentityStat,row:WindowsSecurityEntry|null,reason:'unsafe'|'changed'='unsafe'){
    const sid=this.userSid();
    if(!row||!sid||row.attributes&0x400||Boolean(row.attributes&16)!==stat.isDirectory()||ownerVerdict(row.sddl??'',sid)!=='ok'||ownerOnlyVerdict(row.sddl??'',sid)!=='owner-only')refuse(reason);
  }
  /** Reread only never-verified or changed parents at publication. The moved
   * component still receives its independent fresh recursive safety check. */
  private revalidateParents(extra:readonly string[]=[],tree?:string){
    if(this.platform!=='win32')return;
    const candidates=new Map([...this.dirtyParents,...extra.map(path=>[this.pathKey(path),path] as const)]);
    const parents=new Map<string,string>();
    for(const [key,path] of candidates){
      let stat:IdentityStat;try{stat=this.lstat(path);}catch(error){if(absent(error))refuse('changed');throw error;}
      this.provisionalParent(path,stat);
      const old=this.security.get(key);
      if(!old||!this.checkCached(path,old,stat))parents.set(key,path);
    }
    this.debug.publishParentReads+=parents.size;
    if(this.options.windowsEntry){
      for(const path of parents.values())this.validate(path,this.lstat(path));
      this.dirtyParents.clear();this.dirtyParentStats.clear();return;
    }
    // Keep the recursive entry last, once, without dropping any dirty parent.
    const paths=new Map(parents);if(tree){paths.delete(this.pathKey(tree));paths.set(this.pathKey(tree),tree);}
    this.windowsWalk([...paths.values()],Boolean(tree),true,new Set(parents.keys()));
    this.dirtyParents.clear();this.dirtyParentStats.clear();
  }
  /** Only the exact private file we wrote may reuse its protected DACL when
   * Windows publishes content timestamps after close. Never pass a parent. */
  private refreshOwn(path:string,written:IdentityStat){
    const stat=this.lstat(path);this.sameIdentity(written,stat);
    if(this.platform!=='win32'||this.options.windowsEntry)return;
    const old=this.security.get(this.pathKey(path));if(!old?.row)refuse('unsafe');
    this.sameIdentity(old.stat,stat);
    this.security.set(this.pathKey(path),{...old,stat,key:this.securityKey(path,stat)});
  }
  private renameOwn(from:string,to:string){
    if(this.platform!=='win32'||this.options.windowsEntry)return;
    const fromKey=this.pathKey(from),prefix=fromKey.replace(/[\\/]+$/,'')+(this.platform==='win32'?'\\':sep);
    const exact=this.security.get(fromKey);
    const moved=exact?.stat.isFile()?[exact]:[...this.security.values()].filter(old=>this.pathKey(old.path)===fromKey||this.pathKey(old.path).startsWith(prefix));
    for(const old of moved){
      const path=old.path;
      const target=to+path.slice(from.length),stat=this.lstat(target);
      this.sameIdentity(old.stat,stat);
      // Renaming the top entry changes its timestamps. Changed descendants
      // lose their cached evidence and require a full ACL read next time.
      if(this.pathKey(path)!==fromKey&&old.key!==this.securityKey(target,stat)){this.security.delete(this.pathKey(path));continue;}
      this.security.delete(this.pathKey(path));
      this.security.set(this.pathKey(target),{path:target,stat,key:this.securityKey(target,stat),row:old.row?{...old.row,path:target}:null});
    }
    this.dirtyParent(dirname(from));this.dirtyParent(dirname(to));
  }
  private protectNew(paths:readonly string[]){
    if(this.platform!=='win32')return;
    const entries=paths.map(path=>({path,stat:this.lstat(path)}));
    for(const {stat} of entries)if(stat.isSymbolicLink()||!(stat.isDirectory()||stat.isFile())||(stat.isFile()&&stat.nlink!==1))refuse('unsafe');
    const sid=this.userSid();if(!sid)refuse('unsafe');
    this.debug.protectionBatches++;
    try{
      const ok=this.options.protectNewWindowsEntries?this.options.protectNewWindowsEntries(paths):this.options.protectNewWindowsEntry?paths.every(path=>this.options.protectNewWindowsEntry!(path)):protectWindowsParkEntries(entries.map(({path,stat})=>({path,directory:stat.isDirectory()})),sid,this.deadline,this.runWindows);
      if(!ok)refuse('unsafe');
    }
    catch(error){if(Date.now()>=this.deadline)refuse('bound');if(error instanceof WindowsSecurityTimeoutError)refuse('security read timed out');throw error;}
    this.tick();
    if(this.options.windowsEntry)return;
    for(const {path,stat:before} of entries){
    const stat=this.lstat(path);this.sameIdentity(before,stat);
    // This private, newly-created inode has just received the explicit user
    // and SYSTEM grants used by windowsAclRestrict. No native reread is needed.
    const row={path,attributes:stat.isDirectory()?16:0,sddl:`O:${sid}D:P(A;;FA;;;${sid})(A;;FA;;;SY)`};
    this.security.set(this.pathKey(path),{path,key:this.securityKey(path,stat),stat,row});
    this.dirtyParent(dirname(path));
    }
  }
  private userSid(){
    if(this.sid!==undefined)return this.sid;
    if(this.options.windowsSid)return this.sid=this.options.windowsSid();
    const runner=this.options.windowsRun??defaultSecurityRunner;
    this.sid=currentUserSid((file,args)=>this.runWindows(file,args,{env:process.env,timeout:Math.max(1,Math.min(2000,this.deadline-Date.now()))}),process.env,runner===defaultSecurityRunner?nativeUserSidScope:runner);
    return this.sid;
  }
  private checkWindowsConfiguration(){
    const options=this.options;
    if(this.platform==='win32'&&options.windowsSid
      &&(!options.windowsRun||options.windowsRun===defaultSecurityRunner)
      &&!(options.windowsEntry&&(options.protectNewWindowsEntry||options.protectNewWindowsEntries)))throw new ParkFsConfigurationError();
  }
  readonly options: ParkFsOptions;
  constructor(root: string, options: ParkFsOptions = {}) {
    this.options=options;this.debug=options.debug??parkFsDebug();
    if(isWindowsSecuritySessionRunner(options.windowsRun??defaultSecurityRunner))markWindowsSecuritySessionRunner(this.runWindows);
    this.root = resolve(root); this.platform = options.platform ?? process.platform;
    this.checkWindowsConfiguration();
    this.deadline = options.deadline ?? Date.now() + (this.platform==='win32'?WINDOWS_PARK_DEADLINE_MS:25_000);
    this.tick();
    if(this.platform==='linux'){const mounts=options.mounts?options.mounts():signalMountPoints(this.deadline);this.tick();if(!mounts)refuse('unsafe');this.mounts=new Set(mounts);}
    // Ancestors outside installation can belong to root; never follow a link.
    const chain: string[] = []; let path = this.root;
    for (;;) { chain.push(path); const parent = dirname(path); if (parent === path) break; path = parent; }
    chain.reverse();
    const prefetch=this.platform==='win32'&&options.prefetchWindowsPark&&!options.windowsEntry?this.windowsParkPaths():{paths:[],trees:[]};
    this.windowsWalk([...chain,...prefetch.paths],prefetch.trees);
    for(const path of chain){this.tick();const st=this.lstat(path,fs.lstatSync);if(!st.isDirectory()||st.isSymbolicLink())refuse('unsafe');if(this.platform==='win32'){const row=this.windowsRow(path,st);if(!row||row.attributes&0x400)refuse('unsafe');}}
    const fd = parkIo(()=>fs.openSync(this.root, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)));
    try { this.rootStat = fstatIdentity(fd); } finally { fs.closeSync(fd); }
    this.validate(this.root, this.rootStat);
    for(const {path,stat} of this.security.values())if(this.withinRoot(path)&&stat.dev!==this.rootStat.dev)refuse('device');
  }
  tick() { if (++this.work > 1_000_000 || Date.now() >= this.deadline) refuse('bound'); }
  /** Batch only Signal custody paths, never unrelated installation stores. */
  private windowsParkPaths(){
    const paths:string[]=[],trees:string[]=[];
    // The shared connected-apps install identity is checked only when binding
    // a park journal. Service admission must not inspect unrelated later setup.
    for(const name of ['channels','recovery-quarantine',...(this.options.prefetchWindowsInstallIdentity?['install-id.json']:[]),'signal','channels/signal','recovery-quarantine/signal-park-control','recovery-quarantine/signal-parked']){
      const path=join(this.root,name);let stat:IdentityStat;
      try{stat=this.lstat(path,undefined,true);}catch(error){if(absent(error))continue;throw error;}
      if(stat.isSymbolicLink())refuse('unsafe');
      // Excluded/opaque bundles retain their existing classification path;
      // priming must not inspect their payloads merely to save startups.
      paths.push(path);if(stat.isDirectory()&&['signal','channels/signal','recovery-quarantine/signal-park-control'].includes(name))trees.push(path);
    }
    return{paths,trees};
  }
  event(operation: string, path: string) { this.options.after?.(operation, path); }
  validate(path: string, stat: IdentityStat, privateFile = false) {
    this.tick();
    if(path!==this.root&&this.mounts.has(path))refuse('device');
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) refuse('unsafe');
    if (this.rootStat && stat.dev !== this.rootStat.dev) refuse('device');
    if (this.platform === 'win32') {
      // Staging may proceed structurally; publication always requires the full
      // parent batch. A changed parent never retains its cached ACL evidence.
      if(!this.options.windowsEntry&&this.provisionalParent(path,stat)){
        const old=this.security.get(this.pathKey(path));if(old)this.checkCached(path,old,stat);return;
      }
      this.validateWindowsRow(stat,this.windowsRow(path,stat));
    } else {
      const uid = this.options.uid ?? process.getuid?.();
      if (uid === undefined || stat.uid !== uid || (privateFile && (stat.mode & 0o077))) refuse('unsafe');
    }
  }
  checked(path: string, privateFile = false, tree = false): IdentityStat | null {
    const full = resolve(path);
    if (!this.withinRoot(full)) refuse('unsafe');
    const names = relative(this.root, full).split(sep).filter(Boolean);
    const chain=[this.root];for(const name of names)chain.push(join(chain[chain.length-1]!,name));
    this.windowsWalk(chain,tree);
    let current = this.root;
    const rootStat = this.lstat(current);
    this.validate(current, rootStat);
    if (rootStat.dev !== this.rootStat.dev || rootStat.ino !== this.rootStat.ino) refuse('changed');
    for (let i = 0; i < names.length; i++) {
      current = join(current, names[i]!);
      let st: IdentityStat;
      try { st = this.lstat(current,undefined,true); } catch (e) { if (absent(e)) return null; throw e; }
      this.validate(current, st, i === names.length - 1 && privateFile);
      if (i < names.length - 1 && !st.isDirectory()) refuse('unsafe');
      if (i === names.length - 1) return st;
    }
    return rootStat;
  }
  list(path: string, cap: number): string[] {
    const st = this.checked(path); if (!st) return [];
    if (!st.isDirectory()) refuse('unsafe');
    const dir = parkIo(()=>fs.opendirSync(path)), names: string[] = [];
    try { for (;;) { this.tick(); const ent = parkIo(()=>dir.readSync()); if (!ent) break; if (names.length === cap) refuse('bound'); names.push(ent.name); } }
    finally { dir.closeSync(); }
    return names.sort();
  }
  read(path: string, max = 64 * 1024, privateFile = true): Buffer {
    if (!this.checked(path, privateFile)?.isFile()) refuse('unsafe');
    return parkIo(()=>readSignalFile(path, max, stat => this.validate(path, stat, privateFile)));
  }
  barrier(dir: string, required = false, publishing = true): boolean {
    if(publishing)this.revalidateParents();
    if (!this.checked(dir)?.isDirectory()) refuse('unsafe');
    let status:'synced'|'unsupported';
    try{status=this.options.sync?.(join(dir,'.barrier'))??syncParentDirectoryStatus(join(dir,'.barrier'),this.platform);}catch(error){rethrowDurability(error);}
    this.event('barrier', dir);
    if (status === 'unsupported') { this.durabilityLimited = true; if (required && this.platform !== 'win32') refuse('durability'); return false; }
    return true;
  }
  mkdir(path: string) {
    if(this.pathKey(path)===this.pathKey(this.root)){this.barrier(this.root,false,false);return;}
    if (this.checked(path)) { if (!this.checked(path)?.isDirectory()) refuse('unsafe'); this.barrier(dirname(path),false,false); return; }
    if(this.platform==='win32'){
      // The first parent is already private. Every new descendant inherits its
      // user/SYSTEM grants; batch explicit protection before validating any of
      // these entries, firing creation callbacks, or publishing metadata.
      const missing=this.createWindowsDirectories([path]);
      try{
        this.protectNew(missing);
        for(const entry of missing){this.event('mkdir',entry);this.barrier(dirname(entry),false,false);}
      }catch(error){rethrowDurability(error);}
      return;
    }
    if (this.pathKey(dirname(path)) !== this.pathKey(this.root) && !this.checked(dirname(path))) this.mkdir(dirname(path));
    fs.mkdirSync(path,{mode:0o700});try{this.protectNew([path]);this.event('mkdir',path);this.barrier(dirname(path),false,false);}catch(error){rethrowDurability(error);}
  }
  /** Stage a known empty destination with the next metadata creation batch.
   * Merely queueing it performs no mutation before the adoption fence. */
  prepareWindowsDirectories(path:string){if(this.platform==='win32')this.queuedWindowsDirectories.push(path);}
  private createWindowsDirectories(paths:readonly string[]){
    const planned=new Set<string>();
    for(const path of paths){
      let parent=path;
      while(!this.checked(parent)){planned.add(parent);parent=dirname(parent);}
      if(!this.checked(parent)?.isDirectory())refuse('unsafe');
    }
    const missing=[...planned].sort((a,b)=>a.length-b.length);
    for(const entry of missing){this.dirtyParent(dirname(entry));fs.mkdirSync(entry,{mode:0o700});}
    return missing;
  }
  /** Only reclaim this operation's unused empty allocations. The failed
   * write consumed its reserve and remains byte-for-byte intact. */
  private releaseMetadataReserves() {
    for(const pool of this.metadataReserves.values())for(const entry of pool.entries){
      try{
        const stat=this.lstat(entry.path);
        if(stat.dev===entry.stat.dev&&stat.ino===entry.stat.ino&&stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size===0){fs.unlinkSync(entry.path);this.security.delete(this.pathKey(entry.path));this.dirtyParent(dirname(entry.path));}
      }catch{/* Preserve replacements and any unexpected content. */}
    }
    this.metadataReserves.clear();
  }
  write(path: string, value: unknown, max = 64 * 1024, required = false) {
    const bytes = JSON.stringify(value); if (Buffer.byteLength(bytes) > max) refuse('bound');
    this.checked(path, true);
    const existingParent=this.platform==='win32'?this.checked(dirname(path)):null;
    const newDirs=this.platform==='win32'?this.createWindowsDirectories([...this.queuedWindowsDirectories,dirname(path)]):[];
    this.queuedWindowsDirectories=[];
    if(!newDirs.length||existingParent){this.mkdir(dirname(path));if(this.list(dirname(path),4096).length>=4096)refuse('bound');this.barrier(dirname(path),required,false);}
    let temporary:string,written:IdentityStat|undefined;
    try { writeFileAtomic(path, bytes, { mode: 0o600, syncDir: true, keepFailedTemp: true,
      ops: { open: ((tmp: string, _flags: unknown, mode?: number) => {
        temporary=tmp;
        const pool=this.metadataReserves.get(path),reserved=pool?.entries.pop();
        if(reserved){
          const stat=this.lstat(reserved.path);this.sameIdentity(reserved.stat,stat);
          if(stat.size!==0||stat.ctimeMs!==reserved.stat.ctimeMs||stat.mtimeMs!==reserved.stat.mtimeMs||stat.mode!==reserved.stat.mode)refuse('changed');
          renameWithRetry(reserved.path,tmp,(from,to)=>{
            const now=this.lstat(from);this.sameIdentity(reserved.stat,now);
            if(now.size!==0||now.ctimeMs!==reserved.stat.ctimeMs||now.mtimeMs!==reserved.stat.mtimeMs||now.mode!==reserved.stat.mode)refuse('changed');
            fs.renameSync(from,to);
          },this.platform);this.renameOwn(reserved.path,tmp);
        }
        const fd = parkIo(()=>fs.openSync(tmp, reserved?fs.constants.O_WRONLY|(fs.constants.O_NOFOLLOW??0):fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),mode));
        try {
          if(reserved){const stat=fstatIdentity(fd);this.sameIdentity(reserved.stat,stat);if(stat.size!==0)refuse('changed');}
          else {
            const batches:Array<{pool:{count:number;entries:Array<{path:string;stat:IdentityStat}>};paths:string[]}>=[];
            // A fence-control write can create the queued bundle directory.
            // Protect its empty journal inodes in that same native batch.
            for(const [target,candidate] of this.metadataReserves){
              if(candidate.count<=1||(target!==path&&!newDirs.includes(dirname(target))))continue;
              const paths:string[]=[];
              for(let i=target===path?1:0;i<candidate.count;i++){
                const reserve=`${target}.${process.pid}.${randomUUID()}.tmp`;
                const empty=parkIo(()=>fs.openSync(reserve,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY,0o600));fs.closeSync(empty);paths.push(reserve);candidate.entries.push({path:reserve,stat:this.lstat(reserve)});
              }
              batches.push({pool:candidate,paths});
            }
            this.protectNew([...newDirs,tmp,...batches.flatMap(batch=>batch.paths)]);
            for(const batch of batches){batch.pool.count=1;batch.pool.entries=batch.paths.map(path=>({path,stat:this.lstat(path)}));}
          }
          for(const entry of newDirs){this.event('mkdir',entry);this.barrier(dirname(entry),false,false);}
          if(newDirs.length&&!existingParent){if(this.list(dirname(path),4096).length>=4096)refuse('bound');this.barrier(dirname(path),required,false);}
          written=fstatIdentity(fd);
          this.validate(tmp,written,true); this.event('temp',tmp); return fd;
        }
        catch (error) { fs.closeSync(fd); throw error; }
      }) as typeof fs.openSync,
      write: ((fd: number, data: string | Uint8Array) => {
        this.checked(dirname(temporary));this.validate(temporary,fstatIdentity(fd),true);
        countedWriteFileSync(fd,data);
      }) as typeof fs.writeFileSync },
      renameHandlesRetry:true,rename: (from,to) => {
        renameWithRetry(from,to,(source,target)=>{
          this.revalidateParents();this.tick();
          this.checked(dirname(target));
          // Pin the written inode independently of the ACL cache on every
          // attempt. Windows can publish its content timestamps only on close.
          if(!written)refuse('changed');
          this.refreshOwn(source,written);this.checked(source,true);
          fs.renameSync(source,target);
        },this.platform);this.renameOwn(from,to);this.event('metadata-rename',to);
      },
    }); }catch(error){this.releaseMetadataReserves();rethrowDurability(error);}
    try{this.event('write',path);this.barrier(dirname(path),required);}catch(error){this.releaseMetadataReserves();rethrowDurability(error);}
  }
  flushFile(path:string){
    const stat=this.checked(path);if(!stat?.isFile())refuse('unsafe');
    const fd=parkIo(()=>fs.openSync(path,(this.platform==='win32'?fs.constants.O_RDWR:fs.constants.O_RDONLY)|(fs.constants.O_NOFOLLOW??0)));
    try{const same=fstatIdentity(fd);this.validate(path,same);if(same.dev!==stat.dev||same.ino!==stat.ino)refuse('changed');try{fs.fsyncSync(fd);this.event('flush',path);}catch(error){rethrowDurability(error);}}finally{fs.closeSync(fd);}
  }
  fingerprint(path: string, auth = false, flush = false): ComponentManifest {
    return parkIo(()=>this.fingerprintTree(path,auth,flush));
  }
  private fingerprintTree(path: string, auth: boolean, flush: boolean): ComponentManifest {
    // Prefetch the component even when only its directory was cached earlier.
    const root = this.checked(path,false,true); if (!root) return emptyManifest();
    const hash = createHash('sha256'); let entries = 0, bytes = 0; const directories: string[]=[];
    const add = (value: string) => { const data = Buffer.from(value); hash.update(String(data.length)).update(':').update(data); };
    const visit = (file: string, rel: string, depth: number) => {
      this.tick(); if (depth > 32 || ++entries > 200_000) refuse('bound');
      const st = this.checked(file); if (!st) refuse('changed');
      add(rel.normalize('NFC')); add(st.isDirectory() ? 'd' : 'f'); add(String(st.mode & 0o777));
      add(String(st.size));
      if (st.isDirectory()) {
        const names = this.list(file, 200_000 - entries), normalized = new Set<string>();
        for (const name of names) { const n = name.normalize('NFC'); if (normalized.has(n)) refuse('unsafe'); normalized.add(n); }
        // Sort by normalized relative path, independent of enumeration order.
        names.sort((a, b) => a.normalize('NFC') < b.normalize('NFC') ? -1 : a.normalize('NFC') > b.normalize('NFC') ? 1 : 0);
        for (const name of names) visit(join(file, name), rel ? `${rel}/${name}` : name, depth + 1);
        if (flush) directories.push(file);
      } else {
        bytes += st.size; if (bytes > 8 * 1024 ** 3) refuse('bound');
        const excluded = auth && /^(log|tmp)(\/|$)/.test(rel);
        if (!excluded) {
          // Hash in chunks on the checked fd, avoiding an 8 GiB allocation.
          const fd = parkIo(()=>fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)));
          try {
            const before = fstatIdentity(fd); this.validate(file, before);
            if (before.dev !== st.dev || before.ino !== st.ino || before.size !== st.size) refuse('changed');
            const content = createHash('sha256'), chunk = Buffer.alloc(64 * 1024); let offset = 0;
            for (;;) { this.tick(); const n = parkIo(()=>fs.readSync(fd, chunk, 0, chunk.length, offset)); if (!n) break; offset += n; if (offset > st.size) refuse('changed'); content.update(chunk.subarray(0, n)); }
            const after = fstatIdentity(fd);
            if (offset !== st.size || after.size !== st.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1) refuse('changed');
            add(content.digest('hex'));
          } finally { fs.closeSync(fd); }
        } else add('unhashed-log-or-tmp');
        if (flush) {
          const fd = parkIo(()=>fs.openSync(file, (this.platform === 'win32' ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | (fs.constants.O_NOFOLLOW ?? 0)));
          try { const now = fstatIdentity(fd); this.validate(file, now); if (now.ino !== st.ino || now.dev !== st.dev) refuse('changed'); try{fs.fsyncSync(fd);this.event('flush',file);}catch(error){rethrowDurability(error);} } finally { fs.closeSync(fd); }
        }
      }
    };
    visit(path, '', 0);
    for (const dir of directories) this.barrier(dir,false,false);
    return { present: true, fp: hash.digest('hex'), entries, bytes };
  }
  move(from: string, to: string, manifest: ComponentManifest, auth = false) {
    const st = this.checked(from); if (!st || this.checked(to)) refuse('conflict');
    if (!this.checked(dirname(to))?.isDirectory()) refuse('unsafe');
    const fp = this.fingerprint(from, auth, true); if (!equalManifest(fp, manifest)) refuse('changed');
    const again = this.checked(from); if (!again || again.ino !== st.ino || again.dev !== st.dev || this.checked(to)) refuse('changed');
    // Recheck both publishing parents and the component in one batch after
    // all flush/event seams, retaining prior keys for foreign tree changes.
    this.revalidateParents([dirname(from),dirname(to)],from);
    // Flush callbacks and the final ACL batch may accept new descendant
    // stat keys. Rehash after those seams so the rename cannot publish bytes
    // under the earlier manifest. Cached ACLs keep this free of native spawns.
    if (!equalManifest(this.fingerprint(from, auth), manifest)) refuse('changed');
    this.tick();
    let committed=false;
    try{renameWithRetry(from,to,undefined,this.platform);committed=true;this.renameOwn(from,to);this.event('rename',to);this.barrier(dirname(to));this.barrier(dirname(from));}
    catch(error){if(committed)rethrowDurability(error);if((error as NodeJS.ErrnoException)?.code==='EXDEV')refuse('device');throw error;}
  }
  unlink(path: string) {
    const st = this.checked(path, true); if (st) { if (!st.isFile()) refuse('unsafe'); fs.unlinkSync(path);try{this.security.delete(this.pathKey(path));this.dirtyParent(dirname(path));this.event('unlink',path);}catch(error){rethrowDurability(error);} }
    this.barrier(dirname(path));
  }
  rmdir(path: string) {
    if (this.checked(path)) { fs.rmdirSync(path);try{this.security.delete(this.pathKey(path));this.dirtyParent(dirname(path));this.event('rmdir',path);}catch(error){rethrowDurability(error);} }
    this.barrier(dirname(path));
  }
}
export const equalManifest = (a: ComponentManifest, b: ComponentManifest) => a.present === b.present && a.fp === b.fp && a.entries === b.entries && a.bytes === b.bytes;
export const ATOMIC_TEMP_UUID='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export function isAtomicTemp(name:string,base:string):boolean{
 if(!/^[a-z.-]+$/.test(base))return false;
 return new RegExp('^'+base.replaceAll('.','[.]')+'[.][1-9][0-9]*[.]'+ATOMIC_TEMP_UUID+'[.]tmp$').test(name);
}
