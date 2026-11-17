import { privateParkTemp, parkProtocolOptions, parkFixtureMkdir as mkdirSync, parkFixtureWrite as writeFileSync } from '../../testing/signal-park-fixture.ts';
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {afterEach,expect,test,vi} from 'vitest';
import * as atomic from '../../atomic.ts';
import {removeTempDirSync} from '../../testing/cleanup.ts';
import {parkSignalForDowngrade,recoverSignalPark} from './park.ts';
import {setAsideConnectors} from '../../connector-set-aside.ts';
const roots:string[]=[];afterEach(()=>{vi.restoreAllMocks();roots.splice(0).forEach(root=>removeTempDirSync(root));});
const sid='S-1-5-21-1-2-3-1001';
const windowsOptions:import('./park-fs.ts').ParkFsOptions={platform:'win32',windowsSid:()=>sid,sync:()=> 'synced',windowsRun:(exe,_args,opts)=>{
 if(exe.endsWith('icacls.exe'))return '';
 if(opts.env.MURAGE_SIGNAL_NEW)return 'MURAGE_SIGNAL_PROTECTED';
 const rows:unknown[]=[],seen=new Set<string>(),trees=JSON.parse(opts.env.MURAGE_SIGNAL_TREES??'[]') as string[];
 const visit=(path:string,recurse:boolean)=>{
  if(seen.has(path))return;seen.add(path);const stat=lstatSync(path);
  rows.push({path,attributes:stat.isDirectory()?16:0,sddl:`O:${sid}D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)`});
  if(recurse&&stat.isDirectory())for(const name of readdirSync(path))visit(join(path,name),true);
 };
 for(const path of JSON.parse(opts.env.MURAGE_SIGNAL_ROOTS??'[]'))visit(path,trees.includes(path)||opts.env.MURAGE_SIGNAL_TREE===path);
 return rows.map(row=>JSON.stringify(row)).join('\n');
}};
const fence={lease:()=>"fixture-lease",discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1};
function put(path:string,value:unknown){mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,JSON.stringify(value),{mode:0o600});}
for(const model of ['native','win32'] as const)for(const target of ['park.json','control.json','set-aside.json'])for(const phase of ['partial','fsync','rename'] as const)test(`RED38 caller/restart ${target} ${phase} retains exact failed temp${model==='win32'?' (modeled win32)':''}`,()=>{
 const options=model==='win32'?windowsOptions:parkProtocolOptions;
 const root=privateParkTemp(join(tmpdir(),'park-writer-'));roots.push(root);put(join(root,'install-id.json'),{installId:randomUUID()});put(join(root,'signal/auth/key'),'fake');
 put(join(root,'channels/signal/connection.json'),{version:1,connectionId:'one',generation:3,enabled:false,paused:true,revoking:false,binding:null,account:null});put(join(root,'connector-health.json.journal'),'fake-journal');
 const real=atomic.writeFileAtomic,failure=new Error('writer fault');let expected='',failedPath='',attempts=0;
 vi.spyOn(atomic,'writeFileAtomic').mockImplementation((path,data,options={})=>{
  if(basename(path)!==target)return real(path,data,options);
  attempts++;expected=String(data);failedPath=path;expect(options).toMatchObject({mode:0o600,syncDir:true,keepFailedTemp:true});
  real(path,data,{...options,...(phase==='partial'?{ops:{...options.ops,write:((fd:number)=>{writeFileSync(fd,expected.slice(0,7));throw failure;}) as typeof writeFileSync}}:{}),
   ...(phase==='fsync'?{ops:{...options.ops,fsync:()=>{throw failure;}}}:{}),...(phase==='rename'?{rename:()=>{throw failure;}}:{})});
 });
 let thrown:unknown;try{if(target==='set-aside.json')setAsideConnectors(root,options);else parkSignalForDowngrade(root,{...options,fence});}catch(error){thrown=error;}
 expect(attempts).toBe(1);expect(thrown).toBe(failure);expect(failedPath).toBeTruthy();expect(existsSync(failedPath)).toBe(false);
 const dir=dirname(failedPath),temps=readdirSync(dir).filter(name=>name.startsWith(target+'.')&&name.endsWith('.tmp'));expect(temps).toHaveLength(1);
 const temp=join(dir,temps[0]!),bytes=readFileSync(temp);expect(bytes.toString()).toBe(phase==='partial'?expected.slice(0,7):expected);
 expect(existsSync(join(root,'signal/auth/key'))).toBe(true);expect(existsSync(join(root,'channels/signal/connection.json'))).toBe(true);
 vi.restoreAllMocks();if(target==='set-aside.json')setAsideConnectors(root,options);else recoverSignalPark(root,{...options,fence});
 expect(readFileSync(temp)).toEqual(bytes); // independently kills eager caller/recovery cleanup
});
