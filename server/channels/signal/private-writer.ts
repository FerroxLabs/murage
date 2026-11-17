// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as fs from 'node:fs';
import { basename, dirname, resolve, sep, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { renameWithRetry, writeFileAtomic } from '../../atomic.ts';
import { currentUserSid, nativeUserSidScope, ownerVerdict, ownerOnlyVerdict } from '../../win-acl.ts';
import { lstatIdentity, fstatIdentity, type IdentityStat } from './file-identity.ts';
import { protectWindowsParkEntries } from './park-windows-protect.ts';
import { defaultSecurityRunner, windowsSecurityEntrySync, type SecurityRunner, type WindowsSecurityEntry } from './storage.ts';
import { isReusableWindowsSecurityScript, isWindowsSecuritySessionRunner, markWindowsSecuritySessionRunner, windowsSecuritySessionDebug, windowsSecurityRunnerSpawns } from './windows-security-session.ts';

export interface PrivateWriterOptions { platform?: NodeJS.Platform; run?: SecurityRunner; sid?: () => string | null; batchSize?: number; windowsEntry?: (path:string) => WindowsSecurityEntry | null }
const BATCH_SIZE = 128;
function unsafe():never { throw new Error('Unsafe Signal private file'); }
const same = (a:IdentityStat,b:IdentityStat) => a.dev===b.dev&&a.ino===b.ino&&a.isDirectory()===b.isDirectory()&&a.isFile()===b.isFile()&&!b.isSymbolicLink()&&(!b.isFile()||b.nlink===1);
const unchanged = (a:IdentityStat,b:IdentityStat) => same(a,b)&&a.ctimeMs===b.ctimeMs&&a.mtimeMs===b.mtimeMs&&a.size===b.size;

/** Explicitly protects NEW entries only. Existing ACLs are never repaired here. */
export class SignalPrivateWriter {
  private appendFiles=new Map<string,IdentityStat>();
  private pools=new Map<string,{parent:IdentityStat;entries:Array<{path:string;stat:IdentityStat}>}>();
  private readonly windows:boolean;
  private readonly run:SecurityRunner;
  private sid:string|null|undefined;
  private readonly options:PrivateWriterOptions;
  readonly debug={childProcesses:0,protectionBatches:0};
  constructor(options:PrivateWriterOptions={}) { this.options=options;this.windows=(options.platform??process.platform)==='win32';this.run=(file,args,opts)=>{
    const runner=options.run??defaultSecurityRunner;
    if(runner===defaultSecurityRunner&&process.platform==='win32'&&isReusableWindowsSecurityScript(opts.input)){
      const before=windowsSecuritySessionDebug().spawns;
      try{return runner(file,args,opts);}finally{this.debug.childProcesses+=windowsSecuritySessionDebug().spawns-before;}
    }
    const before=windowsSecurityRunnerSpawns(runner);
    if(before!==undefined){try{return runner(file,args,opts);}finally{this.debug.childProcesses+=(windowsSecurityRunnerSpawns(runner)??before)-before;}}
    this.debug.childProcesses++;return runner(file,args,opts);
  };
    if(isWindowsSecuritySessionRunner(options.run??defaultSecurityRunner))markWindowsSecuritySessionRunner(this.run);
  }
  private protect(paths:readonly string[]) {
    if(!this.windows||!paths.length)return;
    const entries=paths.map(path=>({path,stat:lstatIdentity(path)}));
    for(const {stat} of entries)if(stat.isSymbolicLink()||!(stat.isDirectory()||stat.isFile())||(stat.isFile()&&stat.nlink!==1))unsafe();
    this.sid??=this.options.sid?this.options.sid():currentUserSid((file,args)=>this.run(file,args,{env:process.env,timeout:15_000}),process.env,this.options.run??nativeUserSidScope);
    if(!this.sid)unsafe();
    const deadline=Date.now()+120_000;
    let batch:Array<{path:string;directory:boolean}>=[],units=2;
    const flush=()=>{if(!batch.length)return;this.debug.protectionBatches++;
      if(!protectWindowsParkEntries(batch,this.sid!,deadline,this.run))unsafe();batch=[];units=2;
    };
    for(const {path,stat} of entries){
      const entry={path,directory:stat.isDirectory()},size=JSON.stringify(entry).length+1;
      // Windows limits an individual environment value to 32767 characters.
      // Split long paths without writing any content before the whole barrier.
      if(size>30_000)unsafe();if(units+size>30_000)flush();batch.push(entry);units+=size;
    }
    flush();
    for(const {path,stat} of entries)if(!same(stat,lstatIdentity(path)))unsafe();
  }
  /** Return newly created directories so a file allocation can share their batch. */
  private directories(path:string):string[] {
    const missing:string[]=[],chain:string[]=[];
    for(let dir=resolve(path);;dir=dirname(dir)){chain.push(dir);if(dirname(dir)===dir)break;}
    for(const dir of chain.reverse()){
      let stat:IdentityStat;
      try{stat=lstatIdentity(dir);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;fs.mkdirSync(dir,{mode:0o700});missing.push(dir);stat=lstatIdentity(dir);}
      if(!stat.isDirectory()||stat.isSymbolicLink())unsafe();
    }
    return missing;
  }
  mkdir(path:string):void { this.mkdirAll([path]); }
  mkdirAll(paths:readonly string[]):void { this.protect([...new Set(paths.flatMap(path=>this.directories(path)))]); }
  /** The returned root is ours and empty: protect it before any caller can
   * populate it. An existing/imported root never enters this creation path. */
  mkdtemp(prefix:string):string {
    const path=fs.mkdtempSync(prefix),before=lstatIdentity(path);
    try{this.protect([path]);return path;}catch(error){
      try{if(same(before,lstatIdentity(path))&&fs.readdirSync(path).length===0)fs.rmdirSync(path);}catch{/* Preserve changed or populated allocations. */}
      throw Object.assign(error instanceof Error?error:new Error(String(error)),{path});
    }
  }
  /** A crash can leave only empty reserve files. Never reuse them, and never
   * reclaim content, links, current-process entries, or unrecognised names. */
  private sweepEmptyReserves(directory:string):void {
    const names=fs.readdirSync(directory);if(names.length>200_000)unsafe();
    for(const name of names){
      const match=/^(?:[.]signal-private|connection[.]json)[.]([1-9][0-9]*)[.][a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}[.]tmp$/.exec(name);
      if(!match||Number(match[1])===process.pid)continue;
      try{process.kill(Number(match[1]),0);continue;}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')continue;}
      const path=join(directory,name),stat=lstatIdentity(path);
      if(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size===0&&unchanged(stat,lstatIdentity(path)))fs.unlinkSync(path);
    }
  }
  /** Windows can publish reserve timestamps after an ACL operation. Pin the
   * allocation by identity and shape, then read its current ACL without repair. */
  private checkReserve(entry:{path:string;stat:IdentityStat}) {
    const stat=lstatIdentity(entry.path);
    if(!same(entry.stat,stat)||!stat.isFile()||stat.size!==0)unsafe();
    const row=this.options.windowsEntry?this.options.windowsEntry(entry.path):windowsSecurityEntrySync(entry.path,15_000,this.run);
    if(!this.sid||!row||row.attributes&0x400||ownerVerdict(row.sddl??'',this.sid)!=='ok'||ownerOnlyVerdict(row.sddl??'',this.sid)!=='owner-only')unsafe();
    const after=lstatIdentity(entry.path);
    if(!same(stat,after)||!after.isFile()||after.size!==0)unsafe();
  }
  private take(directory:string,newDirs:string[],base:string):{path:string;stat:IdentityStat} {
    let pool=this.pools.get(directory);
    if(pool&&!same(pool.parent,lstatIdentity(directory)))unsafe();
    if(!pool?.entries.length){
      if(!pool)this.sweepEmptyReserves(directory);
      const entries:Array<{path:string;stat:IdentityStat}>=[];
      try{
        const count=this.options.batchSize??BATCH_SIZE;if(!Number.isInteger(count)||count<1||count>256)unsafe();
        for(let i=0;i<count;i++){
          const path=join(directory,`${base==='connection.json'?base:'.signal-private'}.${process.pid}.${randomUUID()}.tmp`);
          const fd=fs.openSync(path,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);fs.closeSync(fd);
          entries.push({path,stat:lstatIdentity(path)});
        }
        this.protect([...newDirs,...entries.map(entry=>entry.path)]);
        for(const entry of entries)entry.stat=lstatIdentity(entry.path);
        pool={parent:lstatIdentity(directory),entries};this.pools.set(directory,pool);
      }catch(error){for(const entry of entries){try{const stat=lstatIdentity(entry.path);if(same(entry.stat,stat)&&stat.size===0)fs.unlinkSync(entry.path);}catch{/* Preserve changed entries and any content. */}}throw error;}
    }else this.protect(newDirs);
    const entry=pool.entries.pop()!;
    this.checkReserve(entry);
    return entry;
  }
  write(file:string,data:string|Uint8Array):void {
    if(!this.windows){fs.mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileAtomic(file,data,{mode:0o600,syncDir:true});return;}
    const directory=resolve(dirname(file)),newDirs=this.directories(directory);let used:IdentityStat|undefined;
    writeFileAtomic(file,data,{mode:0o600,syncDir:true,ops:{open:((tmp:string)=>{
      const entry=this.take(directory,newDirs,basename(file));
      renameWithRetry(entry.path,tmp,(from,to)=>{
        const stat=lstatIdentity(from);if(!same(entry.stat,stat)||!stat.isFile()||stat.size!==0)unsafe();fs.renameSync(from,to);
      },this.options.platform);
      const fd=fs.openSync(tmp,fs.constants.O_WRONLY|(fs.constants.O_NOFOLLOW??0));
      try{const stat=fstatIdentity(fd);if(!same(entry.stat,stat)||stat.size!==0||!same(stat,lstatIdentity(tmp)))unsafe();used=stat;return fd;}
      catch(error){fs.closeSync(fd);throw error;}
    }) as typeof fs.openSync},renameHandlesRetry:true,rename:(from,to)=>{
      renameWithRetry(from,to,(source,target)=>{
        if(!used||!same(used,lstatIdentity(source)))unsafe();fs.renameSync(source,target);
      },this.options.platform);
    }});
  }
  openAppend(file:string,exclusive=false):number {
    const newDirs=this.directories(dirname(file));let fd:number,before:IdentityStat|undefined;
    try{
      fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW??0),0o600);
      try{before=fstatIdentity(fd);this.protect([...newDirs,file]);before=fstatIdentity(fd);this.appendFiles.set(file,before);}catch(error){
        fs.closeSync(fd);
        // A failed empty allocation must never become an existing-file bypass
        // on retry. Preserve foreign replacements and any unexpected content.
        try{const after=lstatIdentity(file);if(before&&same(before,after)&&after.size===0)fs.unlinkSync(file);}catch{/* fail closed; later existing-file admission verifies its ACL */}
        throw error;
      }
    }catch(error){
      if(exclusive||(error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      before=lstatIdentity(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)unsafe();
      if(this.windows){
        const cached=this.appendFiles.get(file);
        if(!cached||!unchanged(cached,before)){
          this.sid??=this.options.sid?this.options.sid():currentUserSid((exe,args)=>this.run(exe,args,{env:process.env,timeout:15_000}),process.env,this.options.run??nativeUserSidScope);
          const row=windowsSecurityEntrySync(file,15_000,this.run);
          if(!this.sid||!row||row.attributes&0x400||ownerVerdict(row.sddl??'',this.sid)!=='ok'||ownerOnlyVerdict(row.sddl??'',this.sid)!=='owner-only'||!unchanged(before,lstatIdentity(file)))unsafe();
          this.appendFiles.set(file,before);
        }
      }
      fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_APPEND|(fs.constants.O_NOFOLLOW??0));
    }
    try{const stat=fstatIdentity(fd);if(!stat.isFile()||stat.nlink!==1||!before||!same(before,stat)||!same(stat,lstatIdentity(file)))unsafe();return fd;}
    catch(error){fs.closeSync(fd);throw error;}
  }
  append(file:string,data:string):void {
    const fd=this.openAppend(file);
    const before=fstatIdentity(fd);
    try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const after=lstatIdentity(file);if(!same(before,after))unsafe();
    this.appendFiles.set(file,after);
  }
  release(root?:string):void {
    for(const file of this.appendFiles.keys())if(!root||resolve(file)===resolve(root)||resolve(file).startsWith(resolve(root)+sep))this.appendFiles.delete(file);
    for(const [directory,pool] of this.pools){if(root&&directory!==resolve(root)&&!directory.startsWith(resolve(root)+sep))continue;
      for(const entry of pool.entries){try{const stat=lstatIdentity(entry.path);if(same(entry.stat,stat)&&stat.isFile()&&stat.size===0)fs.unlinkSync(entry.path);}catch{/* Never remove a replaced or changed entry. */}}
      this.pools.delete(directory);
    }
  }
}
export const signalPrivateWriter=new SignalPrivateWriter();
process.once('exit',()=>signalPrivateWriter.release());
export const writeSignalFileAtomic=(file:string,data:string|Uint8Array):void=>signalPrivateWriter.write(file,data);
