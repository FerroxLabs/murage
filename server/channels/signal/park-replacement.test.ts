import {randomBytes,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {afterEach,expect,test,vi} from 'vitest';
import {removeTempDirSync} from '../../testing/cleanup.ts';
import {parkSignalForDowngrade,recoverSignalPark,assertSignalServiceAllowed} from './park.ts';
import {keepBothAndLinkAgain,replaySignalReplacements,signalReplacementInProgress,signalReplacementHold,type SignalLocalAuthority} from './park-replacement.ts';
import {pathsFor} from './park-control.ts';
import * as wipe from './wipe.ts';
const roots:string[]=[];afterEach(()=>{vi.restoreAllMocks();roots.splice(0).forEach(root=>removeTempDirSync(root));});
const fence={lease:()=>"fixture-lease",discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1};
function put(file:string,data:unknown){mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,Buffer.isBuffer(data)?data:JSON.stringify(data),{mode:0o600});}
function fixture(){const root=mkdtempSync(join(tmpdir(),'park-replace-'));roots.push(root);put(join(root,'install-id.json'),{installId:randomUUID()});
 put(join(root,'channels/signal/connection.json'),{version:1,connectionId:'old',generation:3,enabled:false,paused:true,revoking:true,binding:null,account:null});
 const key=randomBytes(32),receipt=randomBytes(32);put(join(root,'signal/auth/key'),key);put(join(root,'channels/signal/old/receipts.json'),receipt);parkSignalForDowngrade(root,{fence});
 const p=pathsFor(root),name=readdirSync(p.bundles)[0]!,dir=join(p.bundles,name),active=new Set(['old','inactive-before']),runs=new Set(['queued','running']),trace:string[]=[];
 const authority:SignalLocalAuthority={fence:()=>{trace.push('fence');},inventory:()=>({connectionIds:['old','inactive-before'],runIds:['queued','running']}),revoke:async(ids,runIds)=>{trace.push('revoke');ids.forEach(id=>active.delete(id));runIds.forEach(id=>runs.delete(id));},verify:()=>!active.size&&!runs.size,flush:async()=>{trace.push('flush');}};
 return{root,p,name,dir,key,receipt,active,runs,trace,authority};}
test('RED34 Keep both excludes unreadable old bundles and revokes people/runs without touching credential/receipt bytes',async()=>{
 const f=fixture(),wipeSpy=vi.spyOn(wipe,'wipeSignalData');put(join(f.dir,'park.json'),'{unreadable');
 const result=await keepBothAndLinkAgain(f.root,f.authority,{fence});expect(wipeSpy).not.toHaveBeenCalled();expect(result.state).toBe('ready');expect(()=>assertSignalServiceAllowed(f.root,{fence})).not.toThrow();expect(f.active.size).toBe(0);expect(f.runs.size).toBe(0);expect(f.trace).toContain('flush');
 expect(readFileSync(join(f.dir,'signal/auth/key'))).toEqual(f.key);expect(readFileSync(join(f.dir,'channels-signal/old/receipts.json'))).toEqual(f.receipt);
 const control=JSON.parse(readFileSync(f.p.control,'utf8'));expect(control.decisions[f.name]).toMatchObject({kind:'held'});expect(control.replacements).toHaveLength(1);expect(control.replacements[0].phase).toBe('ready');
 const record=JSON.parse(readFileSync(join(f.p.channel,'connection.json'),'utf8'));expect(record).toMatchObject({generation:1,binding:null,removeDeviceOnPhone:true});expect(record.connectionId).not.toBe('old');
 // Restoring readability and removing both new live components must not revive old credentials.
 removeTempDirSync(f.p.channel);expect(recoverSignalPark(f.root,{fence})).toMatchObject({state:'held',pendingReplacement:true});
 await replaySignalReplacements(f.root,f.authority,{fence});expect(existsSync(f.p.signal)).toBe(false);expect(readFileSync(join(f.dir,'signal/auth/key'))).toEqual(f.key);
});
test('RED36 ready is a permanent replay obligation, including after a second replacement and reverted stores',async()=>{
 const f=fixture();await keepBothAndLinkAgain(f.root,f.authority,{fence});await keepBothAndLinkAgain(f.root,f.authority,{fence});
 const control=JSON.parse(readFileSync(f.p.control,'utf8'));expect(control.replacements).toHaveLength(2);const latest=control.replacements[1].freshId;
 f.active.add('old');f.runs.add('queued');removeTempDirSync(f.p.channel);
 await replaySignalReplacements(f.root,f.authority,{fence});expect(f.active.size).toBe(0);expect(f.runs.size).toBe(0);expect(JSON.parse(readFileSync(join(f.p.channel,'connection.json'),'utf8')).connectionId).toBe(latest);
 expect(existsSync(join(f.dir,'signal/auth/key'))).toBe(true);
});
for(const operation of ['write','rename','metadata-rename','mkdir','barrier'] as const)test(`RED35 replacement interrupted after ${operation} resumes without restoring old auth`,async()=>{
 const f=fixture();let crashed=false;
 if(operation==='rename'){put(join(f.p.signal,'auth/live-key'),'new-fake');put(join(f.p.channel,'connection.json'),{version:1,connectionId:'live',generation:5,enabled:false,paused:true,revoking:false,binding:null,account:null});}
 try{await keepBothAndLinkAgain(f.root,f.authority,{fence,after:(op,path)=>{if(op===operation&&!crashed&&(operation!=='write'||path.endsWith('control.json'))){crashed=true;throw new Error('crash');}}});}catch{/* simulate process death */}
 expect(crashed).toBe(true);
 const control=JSON.parse(readFileSync(f.p.control,'utf8'));
 if(control.replacements.length){await replaySignalReplacements(f.root,f.authority,{fence});expect(existsSync(f.p.signal)).toBe(false);expect(f.active.size).toBe(0);expect(f.runs.size).toBe(0);}
 else await keepBothAndLinkAgain(f.root,f.authority,{fence});
 expect(readFileSync(join(f.dir,'signal/auth/key'))).toEqual(f.key);
});
test('RED30 incomplete namespace cannot authorize fresh linking',async()=>{
 const f=fixture();put(join(f.p.bundles,'unexpected'), 'kept');await expect(keepBothAndLinkAgain(f.root,f.authority,{fence})).rejects.toThrow();expect(existsSync(f.p.channel)).toBe(false);expect(existsSync(join(f.dir,'signal/auth/key'))).toBe(true);
});
test('RED34 local authority verification failure never creates a fresh connection',async()=>{
 const f=fixture();f.authority.revoke=async()=>{};await expect(keepBothAndLinkAgain(f.root,f.authority,{fence})).rejects.toThrow();expect(existsSync(f.p.channel)).toBe(false);expect(existsSync(join(f.dir,'signal/auth/key'))).toBe(true);
});
test('RED29 every conflicting old candidate is terminal before fresh connection publication',async()=>{
 const f=fixture();const second='other.g9',dir=join(f.p.bundles,second);put(join(dir,'park.json'),'unreadable journal');put(join(dir,'signal/auth/key'),Buffer.from('SECOND_FAKE_AUTH'));
 let published=false;await keepBothAndLinkAgain(f.root,f.authority,{fence,after:(op,path)=>{if(op==='write'&&path===join(f.p.channel,'connection.json')){published=true;const c=JSON.parse(readFileSync(f.p.control,'utf8'));expect(c.decisions[f.name]).toMatchObject({kind:'held'});expect(c.decisions[second]).toMatchObject({kind:'held'});}}});
 expect(published).toBe(true);removeTempDirSync(f.p.channel);await replaySignalReplacements(f.root,f.authority,{fence});expect(existsSync(f.p.signal)).toBe(false);expect(readFileSync(join(dir,'signal/auth/key'),'utf8')).toBe('SECOND_FAKE_AUTH');
});
test('RED35 replacement never overwrites its unreadable owned journal on restart',async()=>{
 const f=fixture();put(join(f.p.signal,'auth/live-key'),Buffer.from('LIVE_FAKE'));put(join(f.p.channel,'connection.json'),{version:1,connectionId:'live',generation:5,enabled:false,paused:true,revoking:false,binding:null,account:null});
 let stopped=false;try{await keepBothAndLinkAgain(f.root,f.authority,{fence,after:op=>{if(!stopped&&op==='rename'){stopped=true;throw new Error('crash');}}});}catch{}
 expect(stopped).toBe(true);const control=JSON.parse(readFileSync(f.p.control,'utf8')),name=control.replacements[0].live.bundleName,file=join(f.p.bundles,name,'park.json');writeFileSync(file,'UNREADABLE_OWNED_JOURNAL',{mode:0o600});
 expect(await replaySignalReplacements(f.root,f.authority,{fence})).toMatchObject({state:'ready'});expect(readFileSync(file,'utf8')).toBe('UNREADABLE_OWNED_JOURNAL');expect(readFileSync(join(f.p.bundles,name,'signal/auth/live-key'),'utf8')).toBe('LIVE_FAKE');
});

test('RED35 ready replay revalidates live filesystem safety before granting runtime/service admission',async()=>{
 const f=fixture();await keepBothAndLinkAgain(f.root,f.authority,{fence});const outside=mkdtempSync(join(tmpdir(),'park-replay-outside-'));roots.push(outside);put(join(outside,'auth/key'),'OUTSIDE_FAKE');symlinkSync(outside,f.p.signal,'dir');
 await expect(replaySignalReplacements(f.root,f.authority,{fence})).rejects.toThrow('unsafe');expect(readFileSync(join(outside,'auth/key'),'utf8')).toBe('"OUTSIDE_FAKE"');
});

test('RED26 refused replacement preflight never claims a persisted disconnect is underway',async()=>{
 const f=fixture();put(join(f.p.bundles,'unexpected'),'kept');await expect(keepBothAndLinkAgain(f.root,f.authority,{fence})).rejects.toThrow();expect(signalReplacementInProgress(f.root,{fence})).toBe(false);
});
test('RED26 replacement progress follows committed intent and missing fresh record, not ready history alone',async()=>{
 const f=fixture();let stopped=false;try{await keepBothAndLinkAgain(f.root,f.authority,{fence,after:(op,path)=>{if(!stopped&&op==='write'&&path===f.p.control){stopped=true;throw new Error('crash');}}});}catch{}
 expect(stopped).toBe(true);expect(signalReplacementInProgress(f.root,{fence})).toBe(true);await replaySignalReplacements(f.root,f.authority,{fence});expect(signalReplacementInProgress(f.root,{fence})).toBe(false);removeTempDirSync(f.p.channel);expect(signalReplacementInProgress(f.root,{fence})).toBe(true);
});

test('RED26 replacement hold retains original post-write durability classification and committed progress',async()=>{
 const f=fixture(),failure=new Error('SAVE_BARRIER');let caught:unknown;
 try{await keepBothAndLinkAgain(f.root,f.authority,{fence,after:(op,path)=>{if(op==='write'&&path===f.p.control)throw failure;}});}catch(error){caught=error;}
 expect(caught).toBe(failure);expect(signalReplacementHold(f.root,caught,{fence})).toMatchObject({state:'held',reason:'durability',pendingReplacement:true,canKeepBoth:false});
});
