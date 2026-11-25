// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { bootstrapWindowsSignal, SIGNAL_WINDOWS_BOOTSTRAP_RECORD } from './windows-bootstrap.ts';
import { assertSignalServiceAllowed, recoverSignalPark } from './park.ts';
import * as bootstrap from './windows-bootstrap.ts';
import { randomUUID } from 'node:crypto';
import { ParkFs } from './park-fs.ts';
import { ownerOnlyVerdict, ownerVerdict } from '../../win-acl.ts';
import { windowsSecurityPathKey as key, type SecurityRunner } from './storage.ts';
const sid='S-1-5-21-1111111111-1111111111-1111111105-1001';
// Exact principal/flag shape from cireds-win/probe-service.txt, fresh ensureDirs
// On test-host, the admin token creates O:BA, with inherited grants.
const inherited=`O:BAG:S-1-5-21-1111111111-1111111111-1111111105-513D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${sid})`;
const privateSddl=`O:BAD:P(A;;FA;;;${sid})(A;;FA;;;SY)`;
const roots:string[]=[];afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))removeTempDirSync(root);});
function fixture(){
 const root=fs.mkdtempSync(join(tmpdir(),'signal-bootstrap-'));roots.push(root);const acls=new Map<string,string>();let projections=0,protections=0;
 const run:SecurityRunner=(exe,args,opts)=>{
  if(exe.endsWith('icacls.exe')){protections++;acls.set(key(String(args[0])),privateSddl);return '';}
  if(opts.env.MURAGE_SIGNAL_NEW){protections++;for(const row of JSON.parse(opts.env.MURAGE_SIGNAL_NEW))acls.set(key(row.path),privateSddl);return 'MURAGE_SIGNAL_PROTECTED';}
  projections++;const rows:unknown[]=[],seen=new Set<string>();
  const trees=new Set<string>(JSON.parse(opts.env.MURAGE_SIGNAL_TREES??'[]').map(key));
  const visit=(path:string,recurse:boolean)=>{if(seen.has(key(path)))return;seen.add(key(path));const stat=fs.lstatSync(path);rows.push({path,attributes:stat.isDirectory()?16:0,sddl:acls.get(key(path))??inherited});if(recurse&&stat.isDirectory())for(const name of fs.readdirSync(path))visit(join(path,name),true);};
  for(const path of JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS!))visit(path,trees.has(key(path))||opts.env.MURAGE_SIGNAL_TREE===path);
  return rows.map(row=>JSON.stringify(row)).join('\n');
 };
 return{root,acls,run,options:{platform:'win32' as const,run,sid:()=>sid},counts:()=>({projections,protections})};
}
test('the native fresh-install BA owner is accepted independently of inherited DACL rejection',()=>{
 expect(ownerVerdict(inherited,sid)).toBe('ok');expect(ownerOnlyVerdict(inherited,sid)).toBe('broad');expect(ownerOnlyVerdict(privateSddl,sid)).toBe('owner-only');
});
test('first use protects data-dir and Signal subtree, records success, and never re-repairs a later attack',()=>{
 const f=fixture();fs.writeFileSync(join(f.root,'install-id.json'),'{"installId":"fixture"}');fs.mkdirSync(join(f.root,'signal/auth'),{recursive:true});fs.writeFileSync(join(f.root,'signal/auth/key'),'fixture');fs.mkdirSync(join(f.root,'channels/signal'),{recursive:true});
 bootstrapWindowsSignal(f.root,f.options);expect(fs.existsSync(join(f.root,SIGNAL_WINDOWS_BOOTSTRAP_RECORD))).toBe(true);
 for(const path of [f.root,join(f.root,'install-id.json'),join(f.root,'channels'),join(f.root,'channels/signal'),join(f.root,'signal'),join(f.root,'signal/auth'),join(f.root,'signal/auth/key')])expect(ownerOnlyVerdict(f.acls.get(key(path))!,sid)).toBe('owner-only');
 expect(f.counts()).toEqual({projections:2,protections:2});const before=f.counts();
 f.acls.set(key(f.root),inherited);bootstrapWindowsSignal(f.root,f.options);expect(f.counts()).toEqual(before);
 expect(()=>new ParkFs(f.root,{platform:'win32',windowsRun:f.run,windowsSid:()=>sid})).toThrow('unsafe');
 expect(fs.readFileSync(join(f.root,'signal/auth/key'),'utf8')).toBe('fixture');
});
for(const attack of ['broad','foreign','reparse'] as const)test(`first-use ${attack} evidence refuses before any protection or record`,()=>{
 const f=fixture();if(attack==='reparse'){const target=join(f.root,'outside');fs.mkdirSync(target);fs.symlinkSync(target,join(f.root,'signal'),'junction');}
 else f.acls.set(key(f.root),attack==='broad'?inherited+'(A;;FA;;;WD)':`O:S-1-5-21-9-9-9-1001D:(A;;FA;;;${sid})`);
 expect(()=>bootstrapWindowsSignal(f.root,f.options)).toThrow('unsafe');expect(f.counts().protections).toBe(0);expect(fs.existsSync(join(f.root,SIGNAL_WINDOWS_BOOTSTRAP_RECORD))).toBe(false);
});
test('existing custody evidence is never migrated or inspected by bootstrap',()=>{
 const f=fixture();fs.mkdirSync(join(f.root,'recovery-quarantine/signal-parked'),{recursive:true});bootstrapWindowsSignal(f.root,f.options);expect(f.counts()).toEqual({projections:0,protections:0});
});

test('native first-use bootstrap and private creation preserve strict DACL verdicts',async()=>{
 const {SignalPrivateWriter}=await import('./private-writer.ts');const writer=new SignalPrivateWriter();
 const root=writer.mkdtemp(join(tmpdir(),'signal-native-first-use-'));roots.push(root);
 try{
  bootstrapWindowsSignal(root);
  writer.write(join(root,'channels/signal/connection.json'),'{}');writer.append(join(root,'signal/ingress/one.ndjson'),'fixture\n');
  if(process.platform==='win32'){
   expect(fs.existsSync(join(root,SIGNAL_WINDOWS_BOOTSTRAP_RECORD))).toBe(true);
   const {currentUserSid}=await import('../../win-acl.ts');const {windowsSecurityPathsSync}=await import('./storage.ts');const sid=currentUserSid();expect(sid).not.toBeNull();
   const rows=windowsSecurityPathsSync([root,join(root,'channels'),join(root,'channels/signal'),join(root,'signal')],Date.now()+120_000,undefined,undefined,[join(root,'channels/signal'),join(root,'signal')]);
   expect(rows).not.toBeNull();for(const row of rows!)expect(ownerOnlyVerdict(row.sddl??'',sid!)).toBe('owner-only');
  }else expect(fs.existsSync(join(root,SIGNAL_WINDOWS_BOOTSTRAP_RECORD))).toBe(false);
 }finally{writer.release();}
},process.platform === 'win32' ? Math.max(60000, 150_000) : 60000);

test('startup without Signal custody returns before bootstrap can fail or touch unrelated routines',()=>{
 const f=fixture(),routines=join(f.root,'routines.json');fs.writeFileSync(routines,'UNCHANGED');
 const spy=vi.spyOn(bootstrap,'bootstrapWindowsSignal').mockImplementation(()=>{throw new Error('security tool unavailable');});
 try{expect(recoverSignalPark(f.root,{platform:'win32'})).toEqual({state:'ready'});expect(spy).not.toHaveBeenCalled();expect(fs.readFileSync(routines,'utf8')).toBe('UNCHANGED');}
 finally{spy.mockRestore();}
});
test('install identity created by connected-apps after bootstrap does not block Signal service admission',()=>{
 const f=fixture();bootstrapWindowsSignal(f.root,f.options);
 fs.writeFileSync(join(f.root,'install-id.json'),JSON.stringify({installId:randomUUID()}));
 expect(()=>assertSignalServiceAllowed(f.root,{platform:'win32',windowsRun:f.run,windowsSid:()=>sid})).not.toThrow();
 // Admission must not repair a later file, or relax the root DACL boundary.
 expect(f.acls.has(key(join(f.root,'install-id.json')))).toBe(false);
 f.acls.set(key(f.root),inherited);
 expect(()=>assertSignalServiceAllowed(f.root,{platform:'win32',windowsRun:f.run,windowsSid:()=>sid})).toThrow('unsafe');
});

test('first-use batches large custody trees below the Windows environment limit',()=>{
 const f=fixture();fs.mkdirSync(join(f.root,'signal'));
 for(let i=0;i<400;i++)fs.writeFileSync(join(f.root,'signal',`${i}-${'x'.repeat(140)}`),'fixture');
 const widths:number[]=[];
 bootstrapWindowsSignal(f.root,{...f.options,run:(exe,args,opts)=>{if(opts.env.MURAGE_SIGNAL_NEW)widths.push(opts.env.MURAGE_SIGNAL_NEW.length);return f.run(exe,args,opts);}});
 expect(widths.length).toBeGreaterThan(1);expect(Math.max(...widths)).toBeLessThanOrEqual(30_000);
 expect(fs.existsSync(join(f.root,SIGNAL_WINDOWS_BOOTSTRAP_RECORD))).toBe(true);
});
test('bootstrap snapshot keys match native expanded paths returned for Windows short-name aliases',()=>{
 const f=fixture();fs.mkdirSync(join(f.root,'signal'));fs.writeFileSync(join(f.root,'signal/key'),'fixture');
 const native=fs.realpathSync.native,originals=new Map<string,string>();let expandedRows=0;
 const expanded=(path:string)=>{const actual=String(native(path)),long=`C:\\expanded${actual.replaceAll('\\','/')}`;originals.set(long,actual);return long;};
 vi.spyOn(fs.realpathSync,'native').mockImplementation(((path:fs.PathLike)=>expanded(String(path))) as typeof fs.realpathSync.native);
 bootstrapWindowsSignal(f.root,{...f.options,run:(exe,args,opts)=>{
  if(!opts.env.MURAGE_SIGNAL_ROOTS)return f.run(exe,args,opts);
  const restore=(json:string|undefined)=>json?JSON.stringify(JSON.parse(json).map((path:string)=>originals.get(path)!)):undefined;
  const output=f.run(exe,args,{...opts,env:{...opts.env,MURAGE_SIGNAL_ROOTS:restore(opts.env.MURAGE_SIGNAL_ROOTS),MURAGE_SIGNAL_TREES:restore(opts.env.MURAGE_SIGNAL_TREES),MURAGE_SIGNAL_TREE:opts.env.MURAGE_SIGNAL_TREE?originals.get(opts.env.MURAGE_SIGNAL_TREE):undefined}});
  return output.split('\n').map(line=>{const row=JSON.parse(line);row.path=expanded(row.path);expandedRows++;return JSON.stringify(row);}).join('\n');
 }});
 expect(expandedRows).toBeGreaterThan(0);
 expect(fs.existsSync(join(f.root,SIGNAL_WINDOWS_BOOTSTRAP_RECORD))).toBe(true);
});
