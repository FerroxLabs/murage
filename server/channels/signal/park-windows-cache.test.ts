// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import * as atomic from '../../atomic.ts';
import { ParkFs } from './park-fs.ts';
import type { SecurityRunner } from './storage.ts';
const roots:string[]=[];
const sid='S-1-5-21-1-2-3-1001',sddl=`O:${sid}D:P(A;;FA;;;${sid})`;
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))removeTempDirSync(root);});
// ACLs are projected by the fake runner on every host. These disposable
// fake-key files need no native ACL-tool spawns to seed the counting witness.
function fixture(files=1,seed?:(root:string)=>void){
 const root=mkdtempSync(join(tmpdir(),'park-windows-cache-'));roots.push(root);
 const tree=join(root,'signal');mkdirSync(join(tree,'auth'),{recursive:true,mode:0o700});
 for(let i=0;i<files;i++)writeFileSync(join(tree,'auth',`key-${i}`),'FAKE-KEY',{mode:0o600});
 seed?.(root);
 const calls:string[][]=[];
 const run:SecurityRunner=(_exe,_args,opts)=>{
  const paths=JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS!) as string[];calls.push(paths);
  const rows:unknown[]=[],seen=new Set<string>();
  function visit(path:string,recurse:boolean){
   if(seen.has(path))return;seen.add(path);
   const stat=lstatSync(path);rows.push({path,attributes:stat.isDirectory()?16:0,sddl});
   if(recurse&&stat.isDirectory())for(const name of readdirSync(path))visit(join(path,name),true);
  }
  for(const path of paths)visit(path,opts.env.MURAGE_SIGNAL_TREE===path);
  return rows.map(row=>JSON.stringify(row)).join('\n');
 };
 const io=new ParkFs(root,{platform:'win32',windowsRun:run,windowsSid:()=>sid,protectNewWindowsEntry:()=>true,sync:()=> 'synced'});
 // These witnesses exercise changed-parent reads. Filesystem timestamps can
 // coalesce fast child mutations; make the key change explicit at each seam.
 // Unchanged-parent zero-read witnesses use the separate budget fixture.
 const event=io.event.bind(io);
 io.event=(operation,path)=>{
  if(['mkdir','temp','metadata-rename','rename','unlink','rmdir'].includes(operation)){
   const parent=dirname(path),stat=lstatSync(parent);utimesSync(parent,stat.atime,new Date(stat.mtimeMs+2000));
  }
  event(operation,path);
 };
 return{root,tree,io,calls};
}
// r11 used three reads; the fourth is the full dirty-parent batch at the final barrier.
test('parking a 200-file tree uses at most four native security spawns including pre-publish and final parent checks',()=>{
 const {root,tree,io,calls}=fixture(200),manifest=io.fingerprint(tree,true);
 io.mkdir(join(root,'bundle'));io.move(tree,join(root,'bundle/signal'),manifest,true);
 expect(io.fingerprint(join(root,'bundle/signal'),true)).toEqual(manifest);
 expect(readFileSync(join(root,'bundle/signal/auth/key-199'),'utf8')).toBe('FAKE-KEY');
 expect(calls.length).toBeLessThanOrEqual(4);
});
test('our mkdir and atomic writes batch parent checks at each publishing boundary',()=>{
 const {root,io,calls}=fixture();calls.length=0;
 const path=join(root,'control/metadata.json');
 io.options.after=op=>{if(op==='temp'||op==='metadata-rename'){const parent=join(root,'control'),stat=lstatSync(parent);utimesSync(parent,stat.atime,new Date(stat.mtimeMs+2000));}};
 io.write(path,{version:1});
 expect(io.checked(path)?.isFile()).toBe(true);expect(JSON.parse(io.read(path).toString())).toEqual({version:1});
 io.write(path,{version:2});expect(JSON.parse(io.read(path).toString())).toEqual({version:2});
 expect(calls).toEqual([[root,join(root,'control')],[join(root,'control')],[join(root,'control')],[join(root,'control')]]);
});
test('a foreign mtime change after our write drops the cache and rereads full security',()=>{
 const {root,io,calls}=fixture(),path=join(root,'metadata.json');io.write(path,{version:1});calls.length=0;
 const stat=lstatSync(path);utimesSync(path,stat.atime,new Date(stat.mtimeMs+2000));
 expect(io.checked(path)?.isFile()).toBe(true);expect(calls).toEqual([[path]]);
});
test('a foreign change to a cached parent is fully reread before our next write',()=>{
 const {root,io,calls}=fixture();const stat=lstatSync(root);utimesSync(root,stat.atime,new Date(stat.mtimeMs+2000));calls.length=0;
 const path=join(root,'metadata.json');io.write(path,{});expect(JSON.parse(io.read(path).toString())).toEqual({});expect(calls).toEqual([[root],[root],[root]]);
});
test('a foreign temp mutation forces a full security reread before our content write',()=>{
 const {root,io,calls}=fixture();calls.length=0;
 io.options.after=(op,path)=>{if(op==='temp'){const stat=lstatSync(path);utimesSync(path,stat.atime,new Date(stat.mtimeMs+2000));}};
 const path=join(root,'metadata.json');io.write(path,{});expect(JSON.parse(io.read(path).toString())).toEqual({});expect(calls).toHaveLength(2);expect(calls[0]).toHaveLength(2);expect(calls[0][1]).toBe(root);expect(calls[0][0]).toMatch(/metadata[.]json[.].*[.]tmp$/);expect(calls.slice(1)).toEqual([[root]]);
});
test('a foreign change after the write event triggers a separate full security reread',()=>{
 const {root,io,calls}=fixture();calls.length=0;
 io.options.after=(op,path)=>{if(op==='write'){const stat=lstatSync(path);utimesSync(path,stat.atime,new Date(stat.mtimeMs+2000));}};
 const path=join(root,'metadata.json');io.write(path,{});
 expect(io.checked(path)?.isFile()).toBe(true);expect(calls).toEqual([[root],[root],[path]]);
});
test('our unlink and rmdir revalidate each dirty parent in one native batch',()=>{
 const {root,io,calls}=fixture(),dir=join(root,'control'),path=join(dir,'metadata.json');
 io.write(path,{});calls.length=0;
 io.options.after=(op)=>{const parent=op==='unlink'?dir:op==='rmdir'?root:undefined;if(parent){const stat=lstatSync(parent);utimesSync(parent,stat.atime,new Date(stat.mtimeMs+2000));}};
 io.unlink(path);io.rmdir(dir);
 expect(io.checked(dir)).toBeNull();expect(io.checked(root)?.isDirectory()).toBe(true);expect(calls).toEqual([[dir],[root]]);
});
for(const attack of ['reparse','broad-acl','foreign-owner','missing','replaced-row','mtime'] as const)test(`recursive security batch still refuses ${attack} in a descendant`,()=>{
 const {tree,io}=fixture(),key=join(tree,'auth/key-0'),run=io.options.windowsRun!;
 io.options.windowsRun=(exe,args,opts)=>{
  const output=run(exe,args,opts);
  if(attack==='mtime'){const stat=lstatSync(key);utimesSync(key,stat.atime,new Date(stat.mtimeMs+2000));return output;}
  return output.split('\n').flatMap(line=>{
   const row=JSON.parse(line);if(row.path!==key)return[line];
   if(attack==='missing')return[];
   if(attack==='replaced-row')row.path=join(tree,'auth/unknown');
   if(attack==='reparse'){row.attributes|=0x400;row.sddl=null;}
   if(attack==='broad-acl')row.sddl+='(A;;FA;;;WD)';
   if(attack==='foreign-owner')row.sddl='O:S-1-5-21-9-9-9-1001D:P(A;;FA;;;S-1-5-21-9-9-9-1001)';
   return[JSON.stringify(row)];
  }).join('\n');
 };
 expect(()=>io.fingerprint(tree,true)).toThrow(attack==='mtime'?'changed':'unsafe');
});
test('a fresh pre-move read stays within its component instead of enumerating unrelated home stores',()=>{
 const {root,tree,io,calls}=fixture(1,root=>mkdirSync(join(root,'unrelated',...Array.from({length:34},(_,i)=>`d${i}`)),{recursive:true,mode:0o700}));
 const manifest=io.fingerprint(tree,true);io.mkdir(join(root,'bundle'));io.move(tree,join(root,'bundle/signal'),manifest,true);
 expect(io.fingerprint(join(root,'bundle/signal'),true)).toEqual(manifest);expect(calls).toHaveLength(4);
});
test('atomic writes refresh file timestamps after close and batch parent checks',()=>{
 const {root,io,calls}=fixture();calls.length=0;const real=atomic.writeFileAtomic;
 vi.spyOn(atomic,'writeFileAtomic').mockImplementation((path,data,opts)=>real(path,data,{...opts,rename:(from,to)=>{
  // Model NTFS publishing LastWriteTime when writeFileAtomic closes the fd.
  const stat=lstatSync(from);utimesSync(from,stat.atime,new Date(stat.mtimeMs+2000));opts!.rename!(from,to);
 }}));
 const path=join(root,'metadata.json');io.write(path,{version:1});
 expect(JSON.parse(io.read(path).toString())).toEqual({version:1});expect(calls).toEqual([[root],[root]]);
});
test('a partially cached directory batches all remaining descendants before fingerprinting',()=>{
 const {tree,io,calls}=fixture(200);io.checked(join(tree,'auth/key-0'));calls.length=0;
 const manifest=io.fingerprint(tree,true);expect(manifest.entries).toBe(202);expect(calls).toEqual([[tree]]);
 io.fingerprint(tree,true);expect(calls).toHaveLength(1);
});
test('fingerprinting the cached installation root batches its descendants once',()=>{
 const {root,io,calls}=fixture(200);calls.length=0;
 expect(io.fingerprint(root,true).entries).toBe(203);expect(calls).toEqual([[root]]);
});
test('the fresh pre-move read drops changed descendant keys and rereads their full security',()=>{
 const {root,tree,io,calls}=fixture(),manifest=io.fingerprint(tree,true),key=join(tree,'auth/key-0');
 io.mkdir(join(root,'bundle'));const stat=lstatSync(key);utimesSync(key,stat.atime,new Date(stat.mtimeMs+2000));calls.length=0;
 const to=join(root,'bundle/signal');io.move(tree,to,manifest,true);
 expect(calls).toHaveLength(3);expect(calls[0]).toEqual([tree,root]);expect(readFileSync(join(to,'auth/key-0'),'utf8')).toBe('FAKE-KEY');
});

test('RED11 Windows batched cache rereads equal-length content changes and changes the fingerprint',()=>{
 const {tree,io,calls}=fixture(),key=join(tree,'auth/key-0'),before=io.fingerprint(tree,true);
 writeFileSync(key,'NEW--KEY');const stat=lstatSync(key);utimesSync(key,stat.atime,new Date(stat.mtimeMs+2000));calls.length=0;
 expect(io.fingerprint(tree,true).fp).not.toBe(before.fp);expect(calls).toEqual([[tree]]);
});
for(const entry of ['root','directory','file'] as const)test(`a changed cached ${entry} gets a full ACL verdict instead of inherited trust`,()=>{
 const {root,tree,io,calls}=fixture(),key=join(tree,'auth/key-0');io.fingerprint(tree,true);
 const path=entry==='root'?root:entry==='directory'?join(tree,'auth'):key,stat=lstatSync(path);
 utimesSync(path,stat.atime,new Date(stat.mtimeMs+2000));calls.length=0;const run=io.options.windowsRun!;
 io.options.windowsRun=(exe,args,opts)=>run(exe,args,opts).split('\n').map(line=>{
  const row=JSON.parse(line);if(row.path===path)row.sddl+='(A;;FA;;;WD)';return JSON.stringify(row);
 }).join('\n');
 expect(()=>io.fingerprint(tree,true)).toThrow('unsafe');expect(calls).toHaveLength(1);expect(calls[0]).toContain(entry==='root'?root:tree);
});

test('a foreign DACL change on our temporary file is fully checked before content write or publication',()=>{
 const {root,io,calls}=fixture(),run=io.options.windowsRun!;let foreign:string|undefined,published=false;
 io.options.after=(op,path)=>{if(op==='temp'){foreign=path;const stat=lstatSync(path);utimesSync(path,stat.atime,new Date(stat.mtimeMs+2000));}if(op==='metadata-rename')published=true;};
 io.options.windowsRun=(exe,args,opts)=>run(exe,args,opts).split('\n').map(line=>{
  const row=JSON.parse(line);if(row.path===foreign)row.sddl+='(A;;FA;;;WD)';return JSON.stringify(row);
 }).join('\n');
 calls.length=0;expect(()=>io.write(join(root,'metadata.json'),{})).toThrow('unsafe');
 expect(published).toBe(false);expect(readFileSync(foreign!)).toHaveLength(0);expect(calls).toEqual([[foreign,root]]);
});

test('a staged parent drops changed cached ACL evidence and joins the next native batch',()=>{
 const {root,tree,io,calls}=fixture();calls.length=0;io.mkdir(join(root,'bundle'));
 const changed=lstatSync(root);utimesSync(root,changed.atime,new Date(changed.mtimeMs+2000));io.checked(root);
 expect(calls).toHaveLength(0);expect(io['security'].has(io['pathKey'](root))).toBe(false);
 const stat=lstatSync(root);utimesSync(root,stat.atime,new Date(stat.mtimeMs+2000));const run=io.options.windowsRun!;
 io.options.windowsRun=(exe,args,opts)=>run(exe,args,opts).split('\n').map(line=>{
  const row=JSON.parse(line);if(row.path===root)row.sddl+='(A;;FA;;;WD)';return JSON.stringify(row);
 }).join('\n');
 expect(()=>io.checked(join(tree,'auth/key-0'))).toThrow('unsafe');expect(calls).toHaveLength(1);
 expect(calls[0]).toEqual([tree,join(tree,'auth'),join(tree,'auth/key-0'),root]);
 expect(io['security'].has(io['pathKey'](root))).toBe(false);
});
