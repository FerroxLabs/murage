import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { parkSignalForDowngrade, recoverSignalPark } from './park.ts';
import { pathsFor } from './park-control.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>removeTempDirSync(root)));
const fence={lease:()=>"fixture-lease",discover:()=>true,host:()=> 'fixture-host',boot:()=> 'fixture-boot',uptime:()=>1000};
function put(file:string,value:unknown){mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,Buffer.isBuffer(value)?value:JSON.stringify(value),{mode:0o600});}
function fixture(auth=true) {
 const root=mkdtempSync(join(tmpdir(),'sigpark-'));roots.push(root);
 put(join(root,'install-id.json'),{installId:randomUUID()});
 const binding={connectionId:'legacy',generation:3,ownAci:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ownDeviceId:2,linkedAt:1,chiefBotId:'chief'};
 put(join(root,'channels/signal/connection.json'),{version:1,connectionId:'legacy',generation:3,enabled:true,paused:false,revoking:false,binding,account:'+15550001234'});
 for(const name of ['receipts.json','outbox.json'])put(join(root,'channels/signal/legacy',name),randomBytes(64));
 if(auth)for(const name of ['auth/deep/key','ingress/legacy.ndjson','ingress/legacy.tombstones'])put(join(root,'signal',name),randomBytes(64));
 return root;
}
for(const auth of [true,false]) test(`RUN round trip preserves both components and inodes; auth=${auth}`,()=>{
 const root=fixture(auth),p=pathsFor(root),cino=statSync(p.channel).ino,aino=auth?statSync(p.signal).ino:null,record=readFileSync(join(p.channel,'connection.json'));
 expect(parkSignalForDowngrade(root,{fence}).parked).toBe(true);
 expect(existsSync(p.signal)).toBe(false);expect(existsSync(p.channel)).toBe(false);
 const [name]=readdirSync(p.bundles);expect(statSync(join(p.bundles,name!,'channels-signal')).ino).toBe(cino);
 if(auth)expect(statSync(join(p.bundles,name!,'signal')).ino).toBe(aino);
 expect(recoverSignalPark(root,{fence})).toMatchObject({state:'ready'});
 expect(statSync(p.channel).ino).toBe(cino);if(auth)expect(statSync(p.signal).ino).toBe(aino);
 expect(readFileSync(join(p.channel,'connection.json'))).toEqual(record);expect(readdirSync(p.bundles)).toEqual([]);
 expect(JSON.parse(readFileSync(p.control,'utf8')).decisions[name!].kind).toBe('cleanup');
});
test('RED6 intent-only parking is verified restored before cleanup',()=>{
 const root=fixture(),trace:string[]=[];
 expect(()=>parkSignalForDowngrade(root,{fence,after:(op,path)=>{trace.push(op);if(op==='write'&&path.endsWith('park.json'))throw new Error('crash');}})).toThrow('crash');
 const p=pathsFor(root),[name]=readdirSync(p.bundles),states:string[]=[],unlinks:string[][]=[];
 expect(recoverSignalPark(root,{fence,after:(op,path)=>{if(op==='write'&&path.endsWith('park.json'))states.push(JSON.parse(readFileSync(path,'utf8')).state);if(op==='unlink')unlinks.push([...states]);}})).toMatchObject({state:'ready'});
 expect(name).toBeTruthy();expect(trace).not.toContain('rename');expect(unlinks.length).toBeGreaterThan(0);for(const beforeUnlink of unlinks)expect(beforeUnlink).toContain('restored');
});
for(const failAt of [1,2])test(`RED7 RED16 interrupted park rename ${failAt} resumes using actual C location`,()=>{
 const root=fixture(),p=pathsFor(root);let n=0;
 expect(()=>parkSignalForDowngrade(root,{fence,after:op=>{if(op==='rename'&&++n===failAt)throw new Error('crash');}})).toThrow('crash');
 expect(recoverSignalPark(root,{fence})).toMatchObject({state:'ready'});
 expect(existsSync(p.signal)).toBe(true);expect(existsSync(p.channel)).toBe(true);
});
test('RED11 edited bundled auth is held, with bytes retained',()=>{
 const root=fixture(),p=pathsFor(root);parkSignalForDowngrade(root,{fence});const [name]=readdirSync(p.bundles),key=join(p.bundles,name!,'signal/auth/deep/key');const data=readFileSync(key);data[0]^=1;writeFileSync(key,data);
 expect(recoverSignalPark(root,{fence})).toMatchObject({state:'held'});expect(readFileSync(key)).toEqual(data);expect(existsSync(p.signal)).toBe(false);
});
test('RED21 unexpected bookkeeping entry prevents every cleanup unlink',()=>{
 const root=fixture(),p=pathsFor(root);parkSignalForDowngrade(root,{fence});const [name]=readdirSync(p.bundles);put(join(p.bundles,name!,'keep-me'),randomBytes(10));const unlinks:string[]=[];
 expect(recoverSignalPark(root,{fence,after:(op,path)=>{if(op==='unlink')unlinks.push(path);}})).toMatchObject({state:'ready'});
 expect(unlinks).toEqual([]);expect(existsSync(join(p.bundles,name!,'park.json'))).toBe(true);expect(existsSync(join(p.bundles,name!,'keep-me'))).toBe(true);
});
test('RED31 unavailable adoption refuses before any feature write',()=>{
 const root=fixture(),p=pathsFor(root);expect(()=>parkSignalForDowngrade(root,{fence:{...fence,discover:()=>false}})).toThrow('adoption');
 expect(existsSync(p.signal)).toBe(true);expect(existsSync(p.channel)).toBe(true);expect(existsSync(p.control)).toBe(false);
});
test('RED30 new link retires verified restored bookkeeping durably without deleting unexpected evidence',async()=>{
 const root=fixture(),p=pathsFor(root);parkSignalForDowngrade(root,{fence});const [name]=readdirSync(p.bundles);put(join(p.bundles,name!,'keep-me'),'evidence');
 expect(recoverSignalPark(root,{fence})).toMatchObject({state:'ready'});
 const {assertSignalLinkAllowed}=await import('./park.ts');assertSignalLinkAllowed(root,{fence});
 expect(JSON.parse(readFileSync(p.control,'utf8')).decisions[name!]).toMatchObject({kind:'held',reason:'superseded'});expect(existsSync(join(p.bundles,name!,'keep-me'))).toBe(true);
});
test('RED20 ordinary restore after complete coverage reports its directory durability limit',()=>{
 const root=fixture(),p=pathsFor(root);parkSignalForDowngrade(root,{fence});
 expect(recoverSignalPark(root,{fence,sync:()=> 'unsupported'})).toMatchObject({state:'ready',durabilityLimited:true});expect(existsSync(p.signal)).toBe(true);expect(existsSync(p.channel)).toBe(true);
 expect(parkSignalForDowngrade(root,{fence,sync:()=> 'unsupported'})).toMatchObject({parked:true,durabilityLimited:true});expect(existsSync(p.signal)).toBe(false);expect(existsSync(p.channel)).toBe(false);
});
