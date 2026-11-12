import { randomBytes,randomUUID } from 'node:crypto';
import { cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { afterEach,expect,test } from 'vitest';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { parkSignalForDowngrade,recoverSignalPark } from './park.ts';
import { pathsFor } from './park-control.ts';
import { emptyManifest, ParkFs } from './park-fs.ts';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>removeTempDirSync(root)));
const fence={lease:()=>"fixture-lease",discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1};
function put(path:string,data:unknown){mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,Buffer.isBuffer(data)?data:JSON.stringify(data),{mode:0o600});}
function seed(id='one',generation=3){
 const root=mkdtempSync(join(tmpdir(),'park-state-'));roots.push(root);put(join(root,'install-id.json'),{installId:randomUUID()});
 put(join(root,'channels/signal/connection.json'),{version:1,connectionId:id,generation,enabled:false,paused:true,revoking:false,binding:null,account:null});
 put(join(root,'signal/auth/key'),randomBytes(32));parkSignalForDowngrade(root,{fence});
 const p=pathsFor(root),name=readdirSync(p.bundles)[0]!,dir=join(p.bundles,name),file=join(dir,'park.json');return{root,p,name,dir,file,j:JSON.parse(readFileSync(file,'utf8'))};
}
for(const auth of [true,false])for(const channel of [true,false])for(const a of ['L','B','LB','-'])for(const c of ['L','B','LB','-']){
 test(`RED7 Cartesian present=${auth}/${channel} location=${a}/${c}`,()=>{
  const f=seed();
  for(const [key,present,location] of [['auth',auth,a],['channel',channel,c]] as const){
   const bundled=join(f.dir,key==='auth'?'signal':'channels-signal'),live=key==='auth'?f.p.signal:f.p.channel;
   if(!present)f.j.components[key]=emptyManifest();
   if(location==='L')renameSync(bundled,live);
   if(location==='LB')cpSync(bundled,live,{recursive:true,preserveTimestamps:true});
   if(location==='-')removeTempDirSync(bundled);
  }
  put(f.file,f.j);const moves:string[]=[];
  const result=recoverSignalPark(f.root,{fence,after:(op,path)=>{if(op==='rename')moves.push(path);}});
  const valid=(auth?(a==='L'||a==='B'):a==='-')&&(channel?(c==='L'||c==='B'):c==='-');
  if(!valid){expect(result.state).toBe('held');expect(moves).toEqual([]);}
  else if(auth&&!channel)expect(result.state).toBe('held');
  else expect(result.state).toBe('ready');
 });
}
for(const reverse of [false,true])for(const sameId of [false,true])test(`RED14 generation selection sameId=${sameId}, reverse=${reverse}`,()=>{
 const f=seed('one',reverse?1:9),g=seed(sameId?'one':'two',reverse?9:1);
 // Put the independent transaction into the same installation, rebinding only root metadata.
 const name=g.name,dir=join(f.p.bundles,name);cpSync(g.dir,dir,{recursive:true});
 const j=JSON.parse(readFileSync(join(dir,'park.json'),'utf8'));j.root=f.j.root;j.installId=f.j.installId;
 // This is a separately seeded eligible transaction; bind its manifest to its actual fixture modes.
 const io=new ParkFs(f.root);j.components={auth:io.fingerprint(join(dir,'signal'),true),channel:io.fingerprint(join(dir,'channels-signal'))};
 put(join(dir,'park.json'),j);
 const moves:string[]=[],exclusions:unknown[]=[];
 const result=recoverSignalPark(f.root,{fence,after:(op,path)=>{if(op==='rename'){
  moves.push(path);
  if(sameId){const control=JSON.parse(readFileSync(f.p.control,'utf8'));const loser=reverse?f.name:g.name;exclusions.push(control.decisions[loser]);}
 }}});
 if(!sameId){expect(result.state).toBe('held');expect(moves).toEqual([]);const control=JSON.parse(readFileSync(f.p.control,'utf8'));expect(control.decisions).toEqual({});}
 else{expect(result.state).toBe('ready');expect(moves.length).toBe(2);expect(exclusions).toHaveLength(2);for(const decision of exclusions)expect(decision).toMatchObject({kind:'held',reason:'superseded'});expect(result).toMatchObject({kept:{kind:'earlier'}});}
});
test('RED13 external terminal decision survives removal of both live components and restart',()=>{
 const f=seed();const control=JSON.parse(readFileSync(f.p.control,'utf8'));control.decisions[f.name]={kind:'held',reason:'superseded',runId:f.j.runId};put(f.p.control,control);
 expect(recoverSignalPark(f.root,{fence})).toMatchObject({state:'ready'});expect(existsSync(f.p.signal)).toBe(false);expect(existsSync(f.p.channel)).toBe(false);expect(existsSync(join(f.dir,'signal/auth/key'))).toBe(true);
});
for(const which of ['identity','inode','installId'] as const)test(`RED10 moved root binding ${which} never restores`,()=>{
 const f=seed();if(which==='identity')f.j.root.identity='f'.repeat(64);if(which==='inode')f.j.root.ino++;if(which==='installId')f.j.installId=randomUUID();put(f.file,f.j);
 expect(recoverSignalPark(f.root,{fence})).toMatchObject({state:'ready',kept:{kind:'moved'}});expect(existsSync(f.p.signal)).toBe(false);expect(existsSync(join(f.dir,'signal/auth/key'))).toBe(true);
});
for(const operation of ['unlink','rmdir'] as const)test(`RED21 cleanup restart after ${operation} uses retained control receipt`,()=>{
 const f=seed();let thrown=false;
 const first=recoverSignalPark(f.root,{fence,after:op=>{if(op===operation&&!thrown){thrown=true;throw new Error('crash');}}});expect(first.state).toBe('held');expect(thrown).toBe(true);
 expect(recoverSignalPark(f.root,{fence})).toMatchObject({state:'ready'});expect(readdirSync(f.p.bundles)).toEqual([]);expect(existsSync(f.p.signal)).toBe(true);
});
for(const state of ['parking','restored'] as const)test(`RED7 ${state} missing required components never becomes intent-only retirement`,()=>{
 const f=seed();removeTempDirSync(join(f.dir,'signal'));removeTempDirSync(join(f.dir,'channels-signal'));f.j.state=state;put(f.file,f.j);
 expect(recoverSignalPark(f.root,{fence})).toMatchObject({state:'held'});expect(existsSync(f.p.signal)).toBe(false);expect(existsSync(f.p.channel)).toBe(false);
});
test('RED10 moved intent-only live components do not start the old connection',()=>{
 const f=seed();renameSync(join(f.dir,'signal'),f.p.signal);renameSync(join(f.dir,'channels-signal'),f.p.channel);f.j.state='parking';f.j.root.ino++;put(f.file,f.j);
 expect(recoverSignalPark(f.root,{fence})).toMatchObject({state:'held'});expect(existsSync(join(f.p.signal,'auth/key'))).toBe(true);
});
test('RED10 a retained cleanup receipt cannot bless copied live credentials',()=>{
 const f=seed();expect(recoverSignalPark(f.root,{fence})).toMatchObject({state:'ready'});const control=JSON.parse(readFileSync(f.p.control,'utf8'));control.decisions[f.name].manifest.root.ino++;put(f.p.control,control);
 expect(recoverSignalPark(f.root,{fence})).toMatchObject({state:'held'});expect(existsSync(join(f.p.signal,'auth/key'))).toBe(true);
});
