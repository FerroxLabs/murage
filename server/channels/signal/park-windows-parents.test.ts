// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import * as atomic from '../../atomic.ts';
import { ParkFs } from './park-fs.ts';
import { windowsSecurityPathKey, type SecurityRunner } from './storage.ts';
const roots:string[]=[];
const sid='S-1-5-21-1-2-3-1001',sddl=`O:${sid}D:P(A;;FA;;;${sid})`;
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))removeTempDirSync(root);});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'park-windows-parents-'));roots.push(root);
 const tree=join(root,'signal');mkdirSync(tree,{mode:0o700});writeFileSync(join(tree,'key'),'FAKE-KEY',{mode:0o600});
 const acls=new Map<string,string>(),calls:string[][]=[];
 const run:SecurityRunner=(_exe,_args,opts)=>{
  const paths=JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS!) as string[];calls.push(paths);
  const rows:unknown[]=[],seen=new Set<string>();
  function visit(path:string,recurse:boolean){
   if(seen.has(path))return;seen.add(path);const stat=lstatSync(path);
   rows.push({path,attributes:stat.isDirectory()?16:0,sddl:acls.get(windowsSecurityPathKey(path))??sddl});
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
 const attack=(path:string)=>{acls.set(windowsSecurityPathKey(path),sddl+'(A;;FA;;;WD)');const stat=lstatSync(path);utimesSync(path,stat.atime,new Date(stat.mtimeMs+2000));};
 return{root,tree,io,calls,attack};
}
test('foreign parent DACL and timestamps at the write barrier refuse before metadata publication',()=>{
 const {root,io,attack}=fixture(),path=join(root,'metadata.json'),ino=lstatSync(root).ino;let fired=false,published=false,barriers=0;
 io.options.after=(op,parent)=>{if(op==='barrier'&&parent===root&&++barriers===2){fired=true;attack(root);}if(op==='metadata-rename')published=true;};
 expect(()=>io.write(path,{})).toThrow('unsafe');expect(fired).toBe(true);expect(lstatSync(root).ino).toBe(ino);
 expect(published).toBe(false);expect(existsSync(path)).toBe(false);
});
test('foreign parent DACL immediately before the atomic rename cannot be refreshed as our own write',()=>{
 const {root,io,attack}=fixture(),path=join(root,'metadata.json'),real=atomic.writeFileAtomic;
 vi.spyOn(atomic,'writeFileAtomic').mockImplementation((path,data,opts)=>real(path,data,{...opts,rename:(from,to)=>{attack(root);opts!.rename!(from,to);}}));
 expect(()=>io.write(path,{})).toThrow('unsafe');expect(existsSync(path)).toBe(false);
});
for(const parent of ['source','destination'] as const)test(`foreign ${parent} parent DACL at the move barrier refuses before component publication`,()=>{
 const {root,tree,io,attack}=fixture(),bundle=join(root,'bundle'),to=join(bundle,'signal');
 const manifest=io.fingerprint(tree,true);io.mkdir(bundle);let fired=false,published=false;
 io.options.after=(op,path)=>{if(op==='barrier'&&path===tree&&!fired){fired=true;attack(parent==='source'?root:bundle);}if(op==='rename')published=true;};
 expect(()=>io.move(tree,to,manifest,true)).toThrow();expect(fired).toBe(true);expect(published).toBe(false);
 expect(existsSync(to)).toBe(false);expect(readFileSync(join(tree,'key'),'utf8')).toBe('FAKE-KEY');
});
test('own create, write and rename changes succeed with one batch for all dirty parents per publish boundary',()=>{
 const {root,io,calls}=fixture(),path=join(root,'control/metadata.json');calls.length=0;
 io.options.after=op=>{if(op==='temp'||op==='metadata-rename'){const parent=join(root,'control'),stat=lstatSync(parent);utimesSync(parent,stat.atime,new Date(stat.mtimeMs+2000));}};
 io.write(path,{version:1});expect(JSON.parse(io.read(path).toString())).toEqual({version:1});
 expect(calls).toEqual([[root,join(root,'control')],[join(root,'control')]]);
});
test('the final barrier inspects parent DACL changes after our rename',()=>{
 const {root,io,attack}=fixture();io.options.after=op=>{if(op==='metadata-rename')attack(root);};
 expect(()=>io.write(join(root,'metadata.json'),{})).toThrow('unsafe');
});

for(const attack of ['broad-acl','foreign-owner','reparse','missing','identity'] as const)test(`pre-publish parent batch refuses ${attack} evidence without publishing`,()=>{
 const {root,io}=fixture(),path=join(root,'metadata.json'),run=io.options.windowsRun!;let changed=false,injected=0;
 io.options.stat=(path,options)=>{const stat=lstatSync(path,options);if(changed&&path===root){stat.ino+=1n;injected++;}return stat;};
 io.options.windowsRun=(exe,args,opts)=>{
  const output=run(exe,args,opts);if(attack==='identity'){changed=true;return output;}
  return output.split('\n').flatMap(line=>{
   const row=JSON.parse(line);if(windowsSecurityPathKey(row.path)!==windowsSecurityPathKey(root))return[line];injected++;
   if(attack==='missing')return[];
   if(attack==='reparse'){row.attributes|=0x400;row.sddl=null;}
   if(attack==='broad-acl')row.sddl+='(A;;FA;;;WD)';
   if(attack==='foreign-owner')row.sddl='O:S-1-5-21-9-9-9-1001D:P(A;;FA;;;S-1-5-21-9-9-9-1001)';
   return[JSON.stringify(row)];
  }).join('\n');
 };
 expect(()=>io.write(path,{})).toThrow(attack==='identity'?'changed':'unsafe');expect(existsSync(path)).toBe(false);expect(injected).toBeGreaterThan(0);
});
test('the combined pre-publish component read validates descendant ACLs before rename',()=>{
 const {root,tree,io}=fixture(),manifest=io.fingerprint(tree,true),to=join(root,'bundle/signal');io.mkdir(join(root,'bundle'));
 const run=io.options.windowsRun!;
 io.options.windowsRun=(exe,args,opts)=>run(exe,args,opts).split('\n').map(line=>{
  const row=JSON.parse(line);if(windowsSecurityPathKey(row.path)===windowsSecurityPathKey(join(tree,'key')))row.sddl+='(A;;FA;;;WD)';return JSON.stringify(row);
 }).join('\n');
 expect(()=>io.move(tree,to,manifest,true)).toThrow('unsafe');expect(existsSync(to)).toBe(false);
 expect(readFileSync(join(tree,'key'),'utf8')).toBe('FAKE-KEY');
});

test('a missing dirty parent cannot truncate the batch and allow an unrelated metadata publish',()=>{
 const {root,io}=fixture(),dir=join(root,'control'),child=join(dir,'empty'),path=join(root,'metadata.json');
 io.mkdir(child);rmdirSync(child);rmdirSync(dir);
 expect(()=>io.write(path,{})).toThrow('changed');expect(existsSync(path)).toBe(false);
});

for(const badAcl of [false,true])test(`a moved tree that is a dirty parent revalidates every later parent in one batch, bad ACL=${badAcl}`,()=>{
 const {root,tree,io,calls,attack}=fixture(),bundle=join(root,'bundle'),to=join(bundle,'signal');
 io.mkdir(join(tree,'empty'));io.mkdir(join(bundle,'empty'));const manifest=io.fingerprint(tree,true);
 let boundary:string[][]=[];let fired=false,published=false;
 io.options.after=(op,path)=>{
  if(op==='barrier'&&path===tree&&!fired){fired=true;calls.length=0;for(const parent of [tree,root,bundle]){const stat=lstatSync(parent);utimesSync(parent,stat.atime,new Date(stat.mtimeMs+2000));}if(badAcl)attack(bundle);}
  if(op==='rename'){published=true;boundary=calls.map(paths=>[...paths]);}
 };
 if(badAcl){expect(()=>io.move(tree,to,manifest,true)).toThrow('unsafe');boundary=calls;expect(published).toBe(false);expect(existsSync(to)).toBe(false);}
 else{io.move(tree,to,manifest,true);expect(published).toBe(true);}
 expect(fired).toBe(true);expect(boundary).toHaveLength(1);
 expect(new Set(boundary[0])).toEqual(new Set([tree,root,bundle]));expect(boundary[0]).toHaveLength(3);
});

test('dirty descendant parents never suppress recursive children in the native publication batch',()=>{
 const {root,tree,io,calls}=fixture(),auth=join(tree,'auth'),bundle=join(root,'bundle'),to=join(bundle,'signal');
 io.mkdir(join(auth,'empty'));const manifest=io.fingerprint(tree,true);io.mkdir(bundle);io.mkdir(join(bundle,'empty'));
 let boundary:string[][]=[],fired=false;
 io.options.after=(op,path)=>{if(op==='barrier'&&path===tree&&!fired){fired=true;calls.length=0;for(const parent of [auth,root,bundle]){const stat=lstatSync(parent);utimesSync(parent,stat.atime,new Date(stat.mtimeMs+2000));}}if(op==='rename')boundary=calls.map(paths=>[...paths]);};
 io.move(tree,to,manifest,true);
 expect(boundary).toHaveLength(1);expect(boundary[0][0]).toBe(tree);
 expect(new Set(boundary[0])).toEqual(new Set([tree,auth,root,bundle]));expect(boundary[0]).toHaveLength(4);
 expect(io.fingerprint(to,true)).toEqual(manifest);expect(readFileSync(join(to,'key'),'utf8')).toBe('FAKE-KEY');
});
