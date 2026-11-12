import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {DATA_DIR} from '../../config.ts';
import {closeDatabase,database} from '../../database.ts';
import {observeVerifiedHuman} from '../../human-principals.ts';
import {downgradeInstallationMemorySchema} from '../../installation-memory-downgrade.ts';
import {removeTempDirSync} from '../../testing/cleanup.ts';
import {parkSignalForDowngrade,recoverSignalPark} from './park.ts';
import {keepBothAndLinkAgain,replaySignalReplacements,type SignalLocalAuthority} from './park-replacement.ts';
import {pathsFor} from './park-control.ts';
const fence={lease:()=> 'fixture-lease',discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1};
function put(file:string,data:unknown){mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,typeof data==='string'?data:JSON.stringify(data),{mode:0o600});}
const authority=():SignalLocalAuthority=>({fence:vi.fn(),inventory:()=>({connectionIds:['old'],runIds:['old-run']}),revoke:async()=>{},verify:()=>true,flush:async()=>{}});
beforeEach(()=>{closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true,mode:0o700});});
afterEach(()=>{vi.restoreAllMocks();closeDatabase();removeTempDirSync(DATA_DIR);});
async function ready(){database();put(join(DATA_DIR,'install-id.json'),{installId:randomUUID()});put(join(DATA_DIR,'signal/auth/key'),'FAKE-OLD-AUTH');put(join(DATA_DIR,'channels/signal/connection.json'),{version:1,connectionId:'old',generation:3,enabled:false,paused:true,revoking:false,binding:null,account:null});parkSignalForDowngrade(DATA_DIR,{fence});await keepBothAndLinkAgain(DATA_DIR,authority(),{fence});return pathsFor(DATA_DIR);}
for(const target of [10,13] as const)for(const linked of [false,true])test(`AFIX H2 completed Keep both permits downgrade ${target}, linked=${linked}, retaining replay history`,async()=>{
 const p=await ready(),before=JSON.parse(readFileSync(p.control,'utf8')),old=join(p.bundles,'old.g3/signal/auth/key');
 if(linked){const binding={connectionId:'later-link',generation:1,ownAci:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ownDeviceId:2,linkedAt:1,chiefBotId:'fixture-chief'};put(join(p.signal,'auth/key'),'FAKE-NEW-AUTH');put(join(p.channel,'connection.json'),{version:1,connectionId:'later-link',generation:1,enabled:true,paused:false,revoking:false,binding,account:'+15550001234'});}
 closeDatabase();const result=downgradeInstallationMemorySchema(DATA_DIR,target,{signal:{fence}});
 expect(result.to).toBe(target);expect(existsSync(p.signal)).toBe(false);expect(existsSync(p.channel)).toBe(false);expect(readFileSync(old,'utf8')).toBe('FAKE-OLD-AUTH');
 expect(JSON.parse(readFileSync(p.control,'utf8')).replacements).toEqual(before.replacements);
 // A same-phase preservation retry must neither create a fresh record nor another bundle.
 const names=readdirSync(p.bundles);parkSignalForDowngrade(DATA_DIR,{fence});expect(readdirSync(p.bundles)).toEqual(names);expect(existsSync(p.channel)).toBe(false);
 expect(recoverSignalPark(DATA_DIR,{fence})).toMatchObject({state:'held',pendingReplacement:true});
 await replaySignalReplacements(DATA_DIR,authority(),{fence});expect(readFileSync(old,'utf8')).toBe('FAKE-OLD-AUTH');
 expect(JSON.parse(readFileSync(join(p.channel,'connection.json'),'utf8')).connectionId).toBe(linked?'later-link':before.replacements[0].freshId);
 if(linked)expect(readFileSync(join(p.signal,'auth/key'),'utf8')).toBe('FAKE-NEW-AUTH');
});
for(const reverted of ['people','queued','running','budget','pending'] as const)test(`AFIX H2 downgrade refuses ${reverted} authority without forgetting replay or moving live files`,async()=>{
 const p=await ready();
 if(reverted==='people')observeVerifiedHuman({platform:'signal',connectionId:'old',authorityId:'owner',userId:'owner'});
 else if(reverted==='pending'){const c=JSON.parse(readFileSync(p.control,'utf8'));c.replacements[0].phase='excluded';put(p.control,c);}
 else put(join(DATA_DIR,'routines.json'),{version:1,routines:[],runs:[{id:'old-run',routineId:'old-routine',channelOrigin:{platform:'signal',connectionId:'old'},status:reverted==='budget'?'completed':reverted,eventBudget:{closed:false}}]});
 closeDatabase();const bytes=readFileSync(join(p.channel,'connection.json')),mutations:string[]=[];
 expect(()=>parkSignalForDowngrade(DATA_DIR,{fence,after:op=>{if(op==='rename')mutations.push(op);}})).toThrow();
 expect(mutations).toEqual([]);expect(readFileSync(join(p.channel,'connection.json'))).toEqual(bytes);expect(JSON.parse(readFileSync(p.control,'utf8')).replacements).toHaveLength(1);
});
for(const failure of ['discovery','fence','barrier'] as const)test(`AFIX M1 early ${failure} refusal preserves permanent authority replay obligation`,async()=>{
 const p=await ready();
 if(failure==='discovery')put(join(p.bundles,'unrecognized'),'kept');
 const verdict=recoverSignalPark(DATA_DIR,{fence:failure==='fence'?{...fence,lease:()=>null}:fence,...(failure==='barrier'?{sync:()=>{throw new Error('save-failed');}}:{})});
 expect(verdict).toMatchObject({state:'held',pendingReplacement:true});
});

for(const reason of ['durability','busy','adoption'] as const)test(`AFIX M2 startup replay retains ${reason} typed hold and scheduler fence`,async()=>{
 const p=await ready();
 const {SignalParkError}=await import('./park-fs.ts'),{signalReplacementHold}=await import('./park-replacement.ts'),{SignalKeptHoldService}=await import('./kept-hold.ts');
 const source=readFileSync(new URL('../../index.ts',import.meta.url),'utf8'),start=source.indexOf('if(signalParkVerdict.state==="held"&&signalParkVerdict.pendingReplacement){');
 expect(start).toBeGreaterThan(0);
 const block=source.slice(start,source.indexOf("if(signalParkVerdict.state==='ready'&&signalParkVerdict.kept)",start));
 // Execute the production startup store-phase block with a refused replay.
 // The real wrapper supplies typed preservation state; no server/live data opens.
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
 const boot=new AsyncFunction('signalParkVerdict','DATA_DIR','replaySignalReplacements','signalLocalAuthority','signalReplacementHold',`let signalCustodyHeld=true,signalAuthorityReplayHeld=true;${block};return {verdict:signalParkVerdict,signalCustodyHeld,signalAuthorityReplayHeld};`);
 const failure=new SignalParkError(reason),replay=vi.fn(async()=>{throw failure;});
 const result=await boot({state:'held',reason:'conflict',folder:p.bundles,dualCopy:false,canKeepBoth:false,pendingReplacement:true},DATA_DIR,replay,authority,signalReplacementHold);
 expect(replay).toHaveBeenCalledOnce();expect(result.verdict).toMatchObject({state:'held',reason,pendingReplacement:true});
 expect(result.signalCustodyHeld).toBe(true);expect(result.signalAuthorityReplayHeld).toBe(true);
 expect(new SignalKeptHoldService(result.verdict).status()).toMatchObject({preservation:{progress:reason}});
});
