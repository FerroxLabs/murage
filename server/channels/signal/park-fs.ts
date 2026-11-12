// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { signalMountPoints } from './park-proc.ts';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { syncParentDirectoryStatus, renameWithRetry, writeFileAtomic } from '../../atomic.ts';
import { currentUserSid, ownerOnlyVerdict, ownerVerdict, windowsAclRestrict } from '../../win-acl.ts';
import { defaultSecurityRunner, windowsSecurityEntrySync, type WindowsSecurityEntry } from './storage.ts';

export type ParkReason = 'unsafe' | 'conflict' | 'changed' | 'durability' | 'busy' | 'adoption' | 'device' | 'bound';
export class SignalParkError extends Error {
  readonly reason: ParkReason;
  constructor(reason: ParkReason) { super(reason); this.reason=reason; }
}
export function refuse(reason: ParkReason): never { throw new SignalParkError(reason); }
const durabilityFailures=new WeakSet<object>();
export function rethrowDurability(error:unknown):never { if(error!==null&&(typeof error==='object'||typeof error==='function'))durabilityFailures.add(error);throw error; }
export function parkReason(error:unknown):ParkReason { return error!==null&&typeof error==='object'&&durabilityFailures.has(error)?'durability':error instanceof SignalParkError?error.reason:'unsafe'; }
export const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
export interface ParkFsOptions {
  deadline?: number; platform?: NodeJS.Platform; uid?: number;
  /** Native security projection, never a permission-repair adapter. */
  windowsEntry?: (path: string) => WindowsSecurityEntry | null;
  windowsSid?: () => string | null;
  protectNewWindowsEntry?: (path:string) => boolean;
  /** Independent call trace/fault seam; called after each completed operation. */
  after?: (operation: string, path: string) => void;
  sync?: (child: string) => 'synced' | 'unsupported';
  stat?: (path: string) => fs.Stats;
  mounts?: () => readonly string[] | null;
}
export interface ComponentManifest { present: boolean; fp: string | null; entries: number; bytes: number }
export const emptyManifest = (): ComponentManifest => ({ present: false, fp: null, entries: 0, bytes: 0 });

/** Shared no-follow, same-descriptor read. Callers validate ancestors first. */
export function readSignalFile(file: string, maxBytes = 64 * 1024 * 1024, check?: (stat: fs.Stats) => void): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
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
    const end = fs.fstatSync(fd);
    if (offset !== stat.size || end.size !== stat.size || end.mtimeMs !== stat.mtimeMs || end.nlink !== 1) refuse('changed');
    return bytes.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}

export class ParkFs {
  readonly root: string;
  readonly rootStat: fs.Stats;
  readonly platform: NodeJS.Platform;
  readonly deadline: number;
  durabilityLimited = false;
  private work = 0;
  private mounts=new Set<string>();
  private security=new Map<string,{key:string;row:WindowsSecurityEntry|null}>();
  private sid:string|null|undefined;
  private windowsRow(path:string,stat:fs.Stats){
    if(this.options.windowsEntry)return this.options.windowsEntry(path);
    const key=String(stat.dev)+':'+stat.ino+':'+stat.ctimeMs+':'+stat.mtimeMs+':'+stat.size,old=this.security.get(path);
    if(old?.key===key)return old.row;
    const row=windowsSecurityEntrySync(path,Math.max(1,Math.min(1500,this.deadline-Date.now())));this.security.set(path,{key,row});return row;
  }
  private protectNew(path:string){
    if(this.platform!=='win32')return;
    const protect=this.options.protectNewWindowsEntry??((file:string)=>windowsAclRestrict(file,(exe,args)=>defaultSecurityRunner(exe,args,{env:process.env,timeout:Math.max(1,Math.min(1500,this.deadline-Date.now()))}),process.env));
    if(!protect(path))refuse('unsafe');this.security.delete(path);
  }
  readonly options: ParkFsOptions;
  constructor(root: string, options: ParkFsOptions = {}) {
    this.options=options;
    this.root = resolve(root); this.platform = options.platform ?? process.platform;
    this.deadline = options.deadline ?? Date.now() + 25_000;
    this.tick();
    if(this.platform==='linux'){const mounts=options.mounts?options.mounts():signalMountPoints(this.deadline);this.tick();if(!mounts)refuse('unsafe');this.mounts=new Set(mounts);}
    // Ancestors outside installation can belong to root; never follow a link.
    const chain: string[] = []; let path = this.root;
    for (;;) { chain.push(path); const parent = dirname(path); if (parent === path) break; path = parent; }
    for(const path of chain.reverse()){this.tick();const st=fs.lstatSync(path);if(!st.isDirectory()||st.isSymbolicLink())refuse('unsafe');if(this.platform==='win32'){const row=this.windowsRow(path,st);if(!row||row.attributes&0x400)refuse('unsafe');}}
    const fd = fs.openSync(this.root, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try { this.rootStat = fs.fstatSync(fd); } finally { fs.closeSync(fd); }
    this.validate(this.root, this.rootStat);
  }
  tick() { if (++this.work > 1_000_000 || Date.now() > this.deadline) refuse('bound'); }
  event(operation: string, path: string) { this.options.after?.(operation, path); }
  validate(path: string, stat: fs.Stats, privateFile = false) {
    this.tick();
    if(path!==this.root&&this.mounts.has(path))refuse('device');
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) refuse('unsafe');
    if (this.rootStat && stat.dev !== this.rootStat.dev) refuse('device');
    if (this.platform === 'win32') {
      const row = this.windowsRow(path,stat);
      const sid = this.sid===undefined?(this.sid=this.options.windowsSid ? this.options.windowsSid() : currentUserSid((file, args) => defaultSecurityRunner(file, args, { env: process.env, timeout: Math.max(1,Math.min(1500,this.deadline-Date.now())) }), process.env)):this.sid;
      if (!row || !sid || row.attributes & 0x400 || Boolean(row.attributes & 16) !== stat.isDirectory() || (ownerVerdict(row.sddl ?? '', sid) !== 'ok' || ownerOnlyVerdict(row.sddl ?? '', sid) !== 'owner-only')) refuse('unsafe');
    } else {
      const uid = this.options.uid ?? process.getuid?.();
      if (uid === undefined || stat.uid !== uid || (privateFile && (stat.mode & 0o077))) refuse('unsafe');
    }
  }
  checked(path: string, privateFile = false): fs.Stats | null {
    const full = resolve(path);
    if (full !== this.root && !full.startsWith(this.root + sep)) refuse('unsafe');
    const names = relative(this.root, full).split(sep).filter(Boolean);
    let current = this.root;
    const rootStat = (this.options.stat ?? fs.lstatSync)(current);
    this.validate(current, rootStat);
    if (rootStat.dev !== this.rootStat.dev || rootStat.ino !== this.rootStat.ino) refuse('changed');
    for (let i = 0; i < names.length; i++) {
      current = join(current, names[i]!);
      let st: fs.Stats;
      try { st = (this.options.stat ?? fs.lstatSync)(current); } catch (e) { if (absent(e)) return null; throw e; }
      this.validate(current, st, i === names.length - 1 && privateFile);
      if (i < names.length - 1 && !st.isDirectory()) refuse('unsafe');
      if (i === names.length - 1) return st;
    }
    return rootStat;
  }
  list(path: string, cap: number): string[] {
    const st = this.checked(path); if (!st) return [];
    if (!st.isDirectory()) refuse('unsafe');
    const dir = fs.opendirSync(path), names: string[] = [];
    try { for (;;) { this.tick(); const ent = dir.readSync(); if (!ent) break; if (names.length === cap) refuse('bound'); names.push(ent.name); } }
    finally { dir.closeSync(); }
    return names.sort();
  }
  read(path: string, max = 64 * 1024, privateFile = true): Buffer {
    if (!this.checked(path, privateFile)?.isFile()) refuse('unsafe');
    return readSignalFile(path, max, stat => this.validate(path, stat, privateFile));
  }
  barrier(dir: string, required = false): boolean {
    if (!this.checked(dir)?.isDirectory()) refuse('unsafe');
    let status:'synced'|'unsupported';
    try{status=this.options.sync?.(join(dir,'.barrier'))??syncParentDirectoryStatus(join(dir,'.barrier'),this.platform);}catch(error){rethrowDurability(error);}
    this.event('barrier', dir);
    if (status === 'unsupported') { this.durabilityLimited = true; if (required) refuse('durability'); return false; }
    return true;
  }
  mkdir(path: string) {
    if(path===this.root){this.barrier(this.root);return;}
    if (this.checked(path)) { if (!this.checked(path)?.isDirectory()) refuse('unsafe'); this.barrier(dirname(path)); return; }
    if (dirname(path) !== this.root && !this.checked(dirname(path))) this.mkdir(dirname(path));
    fs.mkdirSync(path,{mode:0o700});try{this.event('mkdir',path);this.protectNew(path);this.barrier(dirname(path));}catch(error){rethrowDurability(error);}
  }
  write(path: string, value: unknown, max = 64 * 1024, required = false) {
    const bytes = JSON.stringify(value); if (Buffer.byteLength(bytes) > max) refuse('bound');
    this.checked(path, true); this.mkdir(dirname(path));
    if(this.list(dirname(path),4096).length>=4096)refuse('bound');this.barrier(dirname(path),required);
    try { writeFileAtomic(path, bytes, { mode: 0o600, syncDir: true, keepFailedTemp: true,
      ops: { open: ((tmp: string, _flags: unknown, mode?: number) => {
        const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),mode);
        try { this.protectNew(tmp);this.validate(tmp,fs.fstatSync(fd),true); this.event('temp',tmp); return fd; }
        catch (error) { fs.closeSync(fd); throw error; }
      }) as typeof fs.openSync },
      rename: (from,to) => { fs.renameSync(from,to); this.event('metadata-rename',to); },
    }); }catch(error){rethrowDurability(error);}
    try{this.event('write',path);this.barrier(dirname(path),required);}catch(error){rethrowDurability(error);}
  }
  flushFile(path:string){
    const stat=this.checked(path);if(!stat?.isFile())refuse('unsafe');
    const fd=fs.openSync(path,(this.platform==='win32'?fs.constants.O_RDWR:fs.constants.O_RDONLY)|(fs.constants.O_NOFOLLOW??0));
    try{const same=fs.fstatSync(fd);this.validate(path,same);if(same.dev!==stat.dev||same.ino!==stat.ino)refuse('changed');try{fs.fsyncSync(fd);this.event('flush',path);}catch(error){rethrowDurability(error);}}finally{fs.closeSync(fd);}
  }
  fingerprint(path: string, auth = false, flush = false): ComponentManifest {
    const root = this.checked(path); if (!root) return emptyManifest();
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
          const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
          try {
            const before = fs.fstatSync(fd); this.validate(file, before);
            if (before.dev !== st.dev || before.ino !== st.ino || before.size !== st.size) refuse('changed');
            const content = createHash('sha256'), chunk = Buffer.alloc(64 * 1024); let offset = 0;
            for (;;) { this.tick(); const n = fs.readSync(fd, chunk, 0, chunk.length, offset); if (!n) break; offset += n; if (offset > st.size) refuse('changed'); content.update(chunk.subarray(0, n)); }
            const after = fs.fstatSync(fd);
            if (offset !== st.size || after.size !== st.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1) refuse('changed');
            add(content.digest('hex'));
          } finally { fs.closeSync(fd); }
        } else add('unhashed-log-or-tmp');
        if (flush) {
          const fd = fs.openSync(file, (this.platform === 'win32' ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | (fs.constants.O_NOFOLLOW ?? 0));
          try { const now = fs.fstatSync(fd); this.validate(file, now); if (now.ino !== st.ino || now.dev !== st.dev) refuse('changed'); try{fs.fsyncSync(fd);this.event('flush',file);}catch(error){rethrowDurability(error);} } finally { fs.closeSync(fd); }
        }
      }
    };
    visit(path, '', 0);
    for (const dir of directories) this.barrier(dir);
    return { present: true, fp: hash.digest('hex'), entries, bytes };
  }
  move(from: string, to: string, manifest: ComponentManifest, auth = false) {
    const st = this.checked(from); if (!st || this.checked(to)) refuse('conflict');
    if (!this.checked(dirname(to))?.isDirectory()) refuse('unsafe');
    this.security.clear();
    const fp = this.fingerprint(from, auth, true); if (!equalManifest(fp, manifest)) refuse('changed');
    const again = this.checked(from); if (!again || again.ino !== st.ino || again.dev !== st.dev || this.checked(to)) refuse('changed');
    let committed=false;
    try{renameWithRetry(from,to);committed=true;this.event('rename',to);this.barrier(dirname(to));this.barrier(dirname(from));}
    catch(error){if(committed)rethrowDurability(error);if((error as NodeJS.ErrnoException)?.code==='EXDEV')refuse('device');throw error;}
  }
  unlink(path: string) {
    const st = this.checked(path, true); if (st) { if (!st.isFile()) refuse('unsafe'); fs.unlinkSync(path);try{this.event('unlink',path);}catch(error){rethrowDurability(error);} }
    this.barrier(dirname(path));
  }
  rmdir(path: string) {
    if (this.checked(path)) { fs.rmdirSync(path);try{this.event('rmdir',path);}catch(error){rethrowDurability(error);} }
    this.barrier(dirname(path));
  }
}
export const equalManifest = (a: ComponentManifest, b: ComponentManifest) => a.present === b.present && a.fp === b.fp && a.entries === b.entries && a.bytes === b.bytes;
export const ATOMIC_TEMP_UUID='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export function isAtomicTemp(name:string,base:string):boolean{
 if(!/^[a-z.-]+$/.test(base))return false;
 return new RegExp('^'+base.replaceAll('.','[.]')+'[.][1-9][0-9]*[.]'+ATOMIC_TEMP_UUID+'[.]tmp$').test(name);
}
