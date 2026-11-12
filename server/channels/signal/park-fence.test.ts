import { randomUUID } from 'node:crypto';
import { existsSync,mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,expect,test,vi } from 'vitest';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { ParkFs } from './park-fs.ts';
import { assertSignalQuiescent,beginSignalChild,publishSignalChild,exitSignalChild,type FenceProbes } from './park-fence.ts';
import { pathsFor,readControl,type ParkControl } from './park-control.ts';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>removeTempDirSync(root)));
const probes:FenceProbes={lease:()=>"fixture-lease",host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1000,discover:()=>true,alive:()=>true,start:()=> '100'};
function fixture(){const root=mkdtempSync(join(tmpdir(),'park-fence-'));roots.push(root);const io=new ParkFs(root);return{root,io,control:readControl(io)};}
function child():NonNullable<ParkControl['child']>{return{token:randomUUID(),epoch:randomUUID(),host:'fixture',boot:'boot',uptime:1,generation:3,state:'running',pid:123,start:'100'};}
for(const platform of ['linux','darwin','win32'] as const)test(`RED17 exact tracked live child refuses ${platform}`,()=>{
 const {io,control,root}=fixture();control.child=child();expect(()=>assertSignalQuiescent(io,control,{...probes,platform})).toThrow('busy');expect(existsSync(pathsFor(root).control)).toBe(false);
});
for(const platform of ['linux','win32'] as const)test(`RUN RED17 exact PID reuse permits ${platform}`,()=>{
 const {io,control}=fixture();control.child=child();expect(()=>assertSignalQuiescent(io,control,{...probes,platform,start:()=> '101'})).not.toThrow();
});
test('RED17 macOS live reused PID remains busy with plain busy verdict',()=>{
 const {io,control}=fixture();control.child=child();expect(()=>assertSignalQuiescent(io,control,{...probes,platform:'darwin',start:()=> '101'})).toThrow('busy');
});
for(const proof of ['dead','reboot','backwards'] as const)test(`RUN RED17 tracked child ${proof} proof`,()=>{
 const {io,control}=fixture();control.child=child();expect(()=>assertSignalQuiescent(io,control,{...probes,...(proof==='dead'?{alive:()=>false}:proof==='reboot'?{boot:()=> 'new-boot'}:{boot:()=>null,uptime:()=>0})})).not.toThrow();
});
for(const state of ['spawning','running'] as const)test(`RED17 uncertain ${state} null PID is fenced`,()=>{
 const {io,control}=fixture();control.child={...child(),state,pid:null};expect(()=>assertSignalQuiescent(io,control,probes)).toThrow('busy');
});
for(const platform of ['linux','darwin','win32'] as const)test(`RED31 RED33 no child record needs complete discovery ${platform}`,()=>{
 const {io,control,root}=fixture();expect(()=>assertSignalQuiescent(io,control,{...probes,platform,discover:()=>false})).toThrow('adoption');expect(existsSync(pathsFor(root).control)).toBe(false);
 const discover=vi.fn(()=>true);assertSignalQuiescent(io,control,{...probes,platform,discover});expect(discover).toHaveBeenCalledOnce();expect(control.child?.state).toBe('exited');
});
test('RED33 reboot alone does not adopt an unrecorded old-build child',()=>{
 const {io,control}=fixture();expect(()=>assertSignalQuiescent(io,control,{...probes,boot:()=> 'new-boot',discover:()=>false})).toThrow('adoption');
});
test('RED33 a previous parent exited/adopted record cannot skip complete discovery',()=>{
 const {io,control}=fixture();control.child={...child(),state:'exited'};expect(()=>assertSignalQuiescent(io,control,{...probes,discover:()=>false})).toThrow('adoption');
});
test('RED33 foreign host refuses even with reboot or complete discovery',()=>{
 const {io,control}=fixture();control.child={...child(),host:'elsewhere'};expect(()=>assertSignalQuiescent(io,control,{...probes,boot:()=> 'another'})).toThrow('busy');
});
test('RED33 crash at spawning intent stays fenced; an exact exit is retained',()=>{
 const {io}=fixture();const token=beginSignalChild(io,3,probes);expect(readControl(io).child).toMatchObject({token,state:'spawning',pid:null});
 expect(()=>assertSignalQuiescent(io,readControl(io),probes)).toThrow('busy');publishSignalChild(io,token,123,probes);expect(readControl(io).child).toMatchObject({state:'running',start:'100'});
 exitSignalChild(io,token);expect(readControl(io).child).toMatchObject({token,state:'exited',pid:123});
});
test('RED20 unsupported adoption journal save never fabricates coverage',()=>{
 const {root,control}=fixture(),io=new ParkFs(root,{sync:()=> 'unsupported'});expect(()=>assertSignalQuiescent(io,control,probes)).toThrow('durability');
});
test('RED17 unknown start identity never falls back to another probe',()=>{
 const {io,control}=fixture();control.child=child();expect(()=>assertSignalQuiescent(io,control,{...probes,start:()=>null})).toThrow('busy');
});
test('RED33 coverage is lost on lease release/reacquisition even in the same living process',()=>{
 const {io,control}=fixture();let epoch='lease-one';const discover=vi.fn(()=>true),current={...probes,lease:()=>epoch,discover};assertSignalQuiescent(io,control,current);expect(discover).toHaveBeenCalledOnce();
 epoch='lease-two';discover.mockReturnValue(false);expect(()=>assertSignalQuiescent(io,control,current)).toThrow('adoption');expect(discover).toHaveBeenCalledTimes(2);
});
test('RED33 an unowned lease cannot grant adoption or a child launch',()=>{
 const {io,control}=fixture();expect(()=>assertSignalQuiescent(io,control,{...probes,lease:()=>null})).toThrow('adoption');
});
for(const start of ['0','9223372036854775808','-1','not-a-time'])test(`RED17 malformed Windows creation FILETIME ${start} cannot clear a live child`,()=>{
 const {io,control}=fixture();control.child=child();expect(()=>assertSignalQuiescent(io,control,{...probes,platform:'win32',start:()=>start})).toThrow('busy');
});
test('RUN RED17 lease host proof accepts a renamed host in the exact same boot after proved child exit',()=>{
 const {io,control}=fixture();control.child={...child(),host:'old-host-name'};
 expect(()=>assertSignalQuiescent(io,control,{...probes,host:()=> 'new-host-name',alive:()=>false})).not.toThrow();
});
for(const probe of ['boot','uptime'] as const)test(`RED17 malformed ${probe} probe keeps tracked-child exclusion`,()=>{
 const {io,control}=fixture();control.child=child();expect(()=>assertSignalQuiescent(io,control,{...probes,start:()=> '101',...(probe==='boot'?{boot:()=> 'bad boot'}:{uptime:()=> -1})})).toThrow('busy');
});
