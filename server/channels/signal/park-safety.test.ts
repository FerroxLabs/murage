import { randomUUID } from 'node:crypto';
import { existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,statSync,symlinkSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import {afterEach,expect,test} from 'vitest';
import {removeTempDirSync} from '../../testing/cleanup.ts';
import {ParkFs} from './park-fs.ts';
import {parkSignalForDowngrade,recoverSignalPark} from './park.ts';
import {readControl,writeControl,excludeBundle} from './park-control.ts';
import {setAsideConnectors} from '../../connector-set-aside.ts';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>removeTempDirSync(root)));
const fence={lease:()=> 'fixture-lease',discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1};
function tmp(){const root=mkdtempSync(join(tmpdir(),'park-safety-'));roots.push(root);return root;}
function put(file:string,data:unknown){mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,JSON.stringify(data),{mode:0o600});}
function seed(){const root=tmp();put(join(root,'install-id.json'),{installId:randomUUID()});put(join(root,'signal/auth/key'),'PRESERVED_FAKE');put(join(root,'channels/signal/connection.json'),{version:1,connectionId:'one',generation:3,enabled:false,paused:true,revoking:false,binding:null,account:null});return root;}
for(const location of ['signal','signal/auth','signal/auth/key','channels','channels/signal','channels/signal/connection.json','recovery-quarantine','recovery-quarantine/signal-parked','recovery-quarantine/signal-parked/one.g3','recovery-quarantine/signal-parked/one.g3/park.json','recovery-quarantine/signal-park-control','recovery-quarantine/signal-park-control/control.json'])test(`RED1 every preservation ancestor/entry refuses link ${location}`,()=>{
 const root=seed();if(location.startsWith('recovery-'))parkSignalForDowngrade(root,{fence});
 const path=join(root,location),holding=join(tmp(),'original');renameSync(path,holding);symlinkSync(holding,path,statSync(holding).isDirectory()?'dir':'file');
 const moves:string[]=[],verdict=recoverSignalPark(root,{fence,after:op=>{if(op==='rename')moves.push(op);}});
 if(location.endsWith('/park.json'))expect(readControl(new ParkFs(root)).decisions['one.g3']).toMatchObject({kind:'held',reason:'unreadable'});else expect(verdict).toMatchObject({state:'held'});expect(moves).toEqual([]);expect(existsSync(holding)).toBe(true);expect(statSync(path).ino).toBe(statSync(holding).ino);
});
for(const metadata of ['connection','park','control','park-temp','control-temp'] as const)test(`RED2 metadata hardlink ${metadata} cannot be read as authority`,()=>{
 const root=seed();let file=join(root,'channels/signal/connection.json');
 if(metadata!=='connection'){parkSignalForDowngrade(root,{fence});file=join(root,metadata.startsWith('park')?'recovery-quarantine/signal-parked/one.g3/park.json':'recovery-quarantine/signal-park-control/control.json');}
 if(metadata.endsWith('temp')){file+=`.123.${randomUUID()}.tmp`;put(file,{fake:true});}
 const bytes=readFileSync(file);linkSync(file,join(tmp(),'alias'));expect(()=>new ParkFs(root).read(file)).toThrow();expect(readFileSync(file)).toEqual(bytes);
});
test('RED22 component byte, metadata byte and directory entry caps refuse before mutation',()=>{
 const root=seed(),key=join(root,'signal/auth/key'),io=new ParkFs(root,{stat:path=>{const st=statSync(path);return path===key?Object.assign(st,{size:8*1024**3+1}):st;}});
 expect(()=>io.fingerprint(join(root,'signal'),true)).toThrow('bound');const file=join(root,'bounded.json');writeFileSync(file,Buffer.alloc(65537),{mode:0o600});expect(()=>new ParkFs(root).read(file)).toThrow();expect(()=>new ParkFs(root).list(root,1)).toThrow('bound');
});
test('RED22 full terminal ledger refuses a new exclusion without truncating old decisions',()=>{
 const root=seed(),io=new ParkFs(root),control=readControl(io);for(let i=0;i<4096;i++)control.decisions[`id-${i}.g0`]={kind:'held',reason:'conflict'};writeControl(io,control);
 expect(()=>excludeBundle(io,control,'new.g0','conflict')).toThrow();expect(Object.keys(readControl(io).decisions)).toHaveLength(4096);
});
test('RED22 connector destination cap retains every reservation and live source',()=>{
 const root=tmp(),namespace=join(root,'recovery-quarantine/connector-set-aside');for(let i=0;i<64;i++)mkdirSync(join(namespace,randomUUID()),{recursive:true,mode:0o700});put(join(root,'connector-health.json.journal'),{fake:true});
 expect(()=>setAsideConnectors(root)).toThrow('bound');expect(readdirSync(namespace)).toHaveLength(64);expect(readFileSync(join(root,'connector-health.json.journal'),'utf8')).toBe('{"fake":true}');
});
