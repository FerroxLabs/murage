// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: inventory producer — pi-roots; offline consumer — pi-roots.
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,renameSync,unlinkSync,utimesSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs';
import {RootRegistry as CarriedRegistry} from './pi-wipe-check.generated.mjs';
vi.mock('node:fs',async original=>({...await original<typeof import('node:fs')>()}));
import piPermissionGate from './pi-permission-gate.ts';
import {RootRegistry} from '../wipe/registry.ts';
import {wipeBreaker} from '../wipe-breaker.ts';
import {removeTempDirSync} from '../testing/cleanup.ts';
let dir:string,inventory:string,descriptor:string,a:string,b:string;
let registry:RootRegistry;
const header=(ready=true)=>`MURAGE-PI-ROOTS 1 ${ready?'R':'P'} ${randomUUID()}\n`;
function publish(roots:readonly string[],ready=true){const temp=inventory+'.next';writeFileSync(temp,header(ready)+JSON.stringify(roots));renameSync(temp,inventory);}
function gate(){
 vi.stubEnv('MURAGE_PI_GATE','fixture-gate');vi.stubEnv('MURAGE_PI_NO_LIMITS','1');vi.stubEnv('MURAGE_PI_WIPE_CONTEXT_FILE',descriptor);
 const handlers=new Map<string,any>();piPermissionGate({on:(name:string,fn:any)=>handlers.set(name,fn)} as never);
 let runs=0;
 return {call:async(command:string)=>{const result=await handlers.get('tool_call')({toolName:'bash',input:{command}},{cwd:join(dir,'project'),hasUI:false,ui:{}});if(!result?.block)runs++;return result?.block===true;},runs:()=>runs};
}
beforeEach(()=>{
 dir=mkdtempSync(join(tmpdir(),'pi-refresh-'));inventory=join(dir,'roots');descriptor=join(dir,'context.json');a=join(dir,'a');b=join(dir,'b');
 for(const p of [a,b,join(dir,'project')])mkdirSync(p);
 registry=new RootRegistry();publish([]);
 // The roots field is a deliberately stale launch-snapshot decoy. A consumer
 // must use the shared path. It also gives the old handler a genuine warm cache.
 writeFileSync(descriptor,JSON.stringify({context:{project:join(dir,'project')},inventoryPath:inventory,roots:[]}));
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();delete (globalThis as Record<symbol,unknown>)[Symbol.for('murage.piGate')];removeTempDirSync(dir);});
const command=(path:string)=>`rm -rf "${path}"/*`;
const approved=(text:string)=>wipeBreaker(text,{cwd:join(dir,'project'),project:join(dir,'project'),registry,platform:process.platform,env:process.env})!==null;
it('live add matches the authority after warming the same turn',async()=>{
 const g=gate();expect(await g.call('echo fixture')).toBe(false);registry.replace('task:fixture:a:cwd',[a]);publish(registry.snapshot());
 expect(approved(command(a))).toBe(true);expect(await g.call(command(a))).toBe(approved(command(a)));
});
it('live change releases A and acquires B without restarting the extension',async()=>{
 const g=gate();expect(await g.call('echo fixture')).toBe(false);registry.replace('task:fixture:a:cwd',[a]);publish(registry.snapshot());
 expect(await g.call(command(a))).toBe(true);registry.replace('task:fixture:a:cwd',[b]);publish(registry.snapshot());
 for(const path of [a,b])expect(await g.call(command(path))).toBe(approved(command(path)));
});
it('live removal retains another owner then releases the last owner',async()=>{
 const g=gate();await g.call('echo fixture');registry.replace('task:fixture:a:cwd',[a]);registry.replace('bot:fixture:cwd',[a]);publish(registry.snapshot());
 expect(await g.call(command(a))).toBe(true);registry.drop('task:fixture:a:cwd');publish(registry.snapshot());expect(await g.call(command(a))).toBe(true);
 registry.drop('bot:fixture:cwd');publish(registry.snapshot());expect(approved(command(a))).toBe(false);expect(await g.call(command(a))).toBe(false);
});
it.each(['missing','torn','oversized','malformed','pending'] as const)('warm %s inventory holds with zero subsequent runner invocations',async kind=>{
 const g=gate();expect(await g.call('echo fixture')).toBe(false);const runs=g.runs();
 if(kind==='missing')unlinkSync(inventory);
 if(kind==='torn')writeFileSync(inventory,header()+ '["unfinished');
 if(kind==='oversized')writeFileSync(inventory,Buffer.alloc(16*1024*1024+1));
 if(kind==='malformed')writeFileSync(inventory,header()+JSON.stringify([17]));
 if(kind==='pending')publish([],false);
 expect(await g.call('echo harmless')).toBe(true);expect(g.runs()).toBe(runs);
});
it('same size and equal timestamps cannot preserve a cached generation',async()=>{
 const g=gate();registry.replace('task:fixture:a:cwd',[a]);publish(registry.snapshot());expect(await g.call(command(a))).toBe(true);
 const before=statSync(inventory);registry.replace('task:fixture:a:cwd',[b]);publish(registry.snapshot());utimesSync(inventory,before.atime,before.mtime);
 expect(statSync(inventory).size).toBe(before.size);expect(await g.call(command(b))).toBe(true);expect(await g.call(command(a))).toBe(false);
});
it('missing descriptor holds even a harmless command',async()=>{unlinkSync(descriptor);expect(await gate().call('echo harmless')).toBe(true);});

it('warm unreadable inventory never reuses the last good cache',async()=>{
 const g=gate();expect(await g.call('echo fixture')).toBe(false);
 const spy=vi.spyOn(fs,'openSync').mockImplementation(()=>{throw Error('fixture read denied');});
 try{const before=g.runs();expect(await g.call('echo harmless')).toBe(true);expect(g.runs()).toBe(before);}finally{spy.mockRestore();}
});
it.each(['unsupported-version','too-many-roots','long-path','nul-path','object','bad-header'] as const)('bounded parser rejects %s after a warm check',async kind=>{
 const g=gate();expect(await g.call('echo fixture')).toBe(false);const before=g.runs();
 const body=kind==='too-many-roots'?Array(16_385).fill(a):kind==='long-path'?['/'+ 'x'.repeat(32*1024)]:kind==='nul-path'?['/fixture/\0root']:kind==='object'?{}:[];
 writeFileSync(inventory,(kind==='unsupported-version'?header().replace('ROOTS 1','ROOTS 2'):kind==='bad-header'?'invalid\n':header())+JSON.stringify(body));
 expect(await g.call('echo harmless')).toBe(true);expect(g.runs()).toBe(before);
});
it('an unchanged generation uses only bounded reads and never reconstructs roots',async()=>{
 registry.replace('task:fixture:a:cwd',[a]);publish(registry.snapshot());const g=gate();expect(await g.call(command(a))).toBe(true);
 const replace=vi.spyOn(CarriedRegistry.prototype,'replace');const reads=vi.spyOn(fs,'readSync');
 expect(await g.call('echo fixture')).toBe(false);expect(replace).not.toHaveBeenCalled();expect(reads.mock.calls.length).toBeGreaterThan(0);
 expect((reads.mock.calls as unknown as unknown[][]).every(args=>Number(args[3])<=128)).toBe(true);
});
it.each(['loading','classification'] as const)('replacement during %s holds RUN then observes the new generation',async where=>{
 const g=gate();expect(await g.call('echo fixture')).toBe(false);let changed=false;
 if(where==='loading'){
  publish([b]);const real=fs.readSync;
  vi.spyOn(fs,'readSync').mockImplementation(((...args:Parameters<typeof fs.readSync>)=>{const value=Reflect.apply(real,fs,args);if(!changed){changed=true;publish([a]);}return value;}) as typeof fs.readSync);
 }else{
  const real=CarriedRegistry.prototype.contains;
  vi.spyOn(CarriedRegistry.prototype,'contains').mockImplementation(function(this:CarriedRegistry,path:string){if(!changed){changed=true;publish([a]);}return real.call(this,path);});
 }
 expect(await g.call(command(a))).toBe(true);expect(changed).toBe(true);vi.restoreAllMocks();expect(await g.call(command(a))).toBe(true);
});
it('a slow cold rebuild holds and never installs a partial registry',async()=>{
 publish([a,b]);const real=performance.now.bind(performance);let clock=0;
 const now=vi.spyOn(performance,'now').mockImplementation(()=>clock+=300);
 try{expect(await gate().call('echo harmless')).toBe(true);}finally{now.mockRestore();expect(real()).toBeGreaterThan(0);}
});

it('an extension reload reuses a completed registry and still refreshes its generation',async()=>{
 publish([b]);const first=gate();expect(await first.call('echo fixture')).toBe(false);
 const replace=vi.spyOn(CarriedRegistry.prototype,'replace');
 const handlers=new Map<string,any>();piPermissionGate({on:(name:string,fn:any)=>handlers.set(name,fn)} as never);
 const call=async(command:string)=>(await handlers.get('tool_call')({toolName:'bash',input:{command}},{cwd:join(dir,'project'),hasUI:false,ui:{}}))?.block===true;
 expect(await call('echo fixture')).toBe(false);expect(replace).not.toHaveBeenCalled();
 publish([a]);expect(await call(command(a))).toBe(true);expect(replace).toHaveBeenCalled();
});

it('invalid UTF-8 holds even when replacement decoding would produce a JSON string',async()=>{
 const g=gate();expect(await g.call('echo fixture')).toBe(false);
 writeFileSync(inventory,Buffer.concat([Buffer.from(header()+'["/fixture/'),Buffer.from([0xff]),Buffer.from('"]')]));
 expect(await g.call('echo harmless')).toBe(true);
});
it('generation headers refresh even when every metadata field collides',async()=>{
 publish([a]);const g=gate();expect(await g.call(command(a))).toBe(true);const frozen=statSync(inventory);
 const stat=fs.statSync;
 vi.spyOn(fs,'statSync').mockImplementation(((...args:Parameters<typeof fs.statSync>)=>args[0]===inventory?frozen:Reflect.apply(stat,fs,args)) as typeof fs.statSync);
 vi.spyOn(fs,'fstatSync').mockImplementation((()=>frozen) as unknown as typeof fs.fstatSync);
 publish([b]);expect(await g.call(command(b))).toBe(true);expect(await g.call(command(a))).toBe(false);
});

it('the path budget counts encoded bytes before reconstructing roots',async()=>{
 const g=gate();expect(await g.call('echo fixture')).toBe(false);
 publish(['/'+ '\n'.repeat(17_000)]);expect(await g.call('echo harmless')).toBe(true);
});

// Independent baseline witnesses: seed the launch transport BEFORE warming;
// change/removal must reach their own verdict rather than fail on an earlier add.
it.each(['add','change','remove'] as const)('baseline witness live %s reaches its own mutation verdict',async kind=>{
 if(kind!=='add')registry.replace('task:fixture:a:cwd',[a]);publish(registry.snapshot());
 writeFileSync(descriptor,JSON.stringify({context:{project:join(dir,'project')},inventoryPath:inventory,roots:registry.snapshot()}));
 const g=gate();expect(await g.call('echo warm')).toBe(false);
 expect(await g.call(command(a))).toBe(kind!=='add');
 if(kind==='remove')registry.drop('task:fixture:a:cwd');else registry.replace('task:fixture:a:cwd',[kind==='add'?a:b]);
 publish(registry.snapshot());
 const target=kind==='change'?b:a;expect(approved(command(target))).toBe(kind!=='remove');
 expect(await g.call(command(target))).toBe(approved(command(target)));
 if(kind==='change')expect(await g.call(command(a))).toBe(approved(command(a)));
});
