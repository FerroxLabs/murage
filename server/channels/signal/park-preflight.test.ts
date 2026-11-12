import {randomUUID} from 'node:crypto';
import {existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import{dirname,join}from'node:path';
import{afterEach,expect,test}from'vitest';
import{removeTempDirSync}from'../../testing/cleanup.ts';
import{preserveSignalForDowngrade}from'./park-downgrade.ts';
import{ParkFs}from'./park-fs.ts';import{readControl,excludeBundle,pathsFor}from'./park-control.ts';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>removeTempDirSync(root)));
const fence={lease:()=>"fixture-lease",discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1};
function put(file:string,data:unknown){mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,JSON.stringify(data),{mode:0o600});}
function seed(){const root=mkdtempSync(join(tmpdir(),'park-preflight-'));roots.push(root);put(join(root,'install-id.json'),{installId:randomUUID()});put(join(root,'signal/auth/key'),'fake');put(join(root,'channels/signal/connection.json'),{version:1,connectionId:'one',generation:3,enabled:false,paused:true,revoking:false,binding:null,account:null});return root;}
for(const unsafe of ['invalid-record','inconsistent-binding','signal-link','auth-hardlink'] as const)test(`RED1 RED2 RED5 preflight ${unsafe} has zero feature writes`,()=>{
 const root=seed(),file=join(root,'channels/signal/connection.json');
 if(unsafe==='invalid-record')put(file,{invalid:true});
 if(unsafe==='inconsistent-binding'){const r=JSON.parse(readFileSync(file,'utf8'));r.binding={connectionId:'another',generation:3,ownAci:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ownDeviceId:2,linkedAt:1,chiefBotId:'chief'};put(file,r);}
 if(unsafe==='signal-link'){renameSync(join(root,'signal'),join(root,'real-signal'));symlinkSync(join(root,'real-signal'),join(root,'signal'));}
 if(unsafe==='auth-hardlink')linkSync(join(root,'signal/auth/key'),join(root,'signal/auth/alias'));
 const names=readdirSync(root),record=readFileSync(file);expect(()=>preserveSignalForDowngrade(root,{fence})).toThrow(/^No Signal files were moved\./);
 expect(readdirSync(root)).toEqual(names);expect(readFileSync(file)).toEqual(record);expect(existsSync(join(root,'recovery-quarantine'))).toBe(false);
});
test('RED28 unreadable bundle exclusion commits by basename without parsing its journal',()=>{
 const root=seed(),io=new ParkFs(root),p=pathsFor(root),name='one.g3';io.mkdir(join(p.bundles,name));writeFileSync(join(p.bundles,name,'park.json'),'{unreadable',{mode:0o600});
 const control=readControl(io);excludeBundle(io,control,name,'unreadable',undefined,true);
 expect(readControl(new ParkFs(root)).decisions[name]).toEqual({kind:'held',reason:'unreadable'});
 expect(readFileSync(join(p.bundles,name,'park.json'),'utf8')).toBe('{unreadable');
});
test('RED35 stale control writers refuse instead of rolling back unrelated custody fields',async()=>{
 const {writeControl}=await import('./park-control.ts');const root=seed(),io=new ParkFs(root),first=readControl(io),stale=readControl(io);
 first.decisions['one.g3']={kind:'held',reason:'conflict'};writeControl(io,first);stale.decisions['two.g1']={kind:'held',reason:'unreadable'};
 expect(()=>writeControl(io,stale)).toThrow('conflict');expect(readControl(io).decisions).toEqual({'one.g3':{kind:'held',reason:'conflict'}});
});
