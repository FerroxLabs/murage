import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {afterEach,expect,test,vi} from 'vitest';
import * as atomic from '../../atomic.ts';
import {removeTempDirSync} from '../../testing/cleanup.ts';
import {parkSignalForDowngrade,recoverSignalPark} from './park.ts';
import {setAsideConnectors} from '../../connector-set-aside.ts';
const roots:string[]=[];afterEach(()=>{vi.restoreAllMocks();roots.splice(0).forEach(root=>removeTempDirSync(root));});
const fence={lease:()=>"fixture-lease",discover:()=>true,host:()=> 'fixture',boot:()=> 'boot',uptime:()=>1};
function put(path:string,value:unknown){mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,JSON.stringify(value),{mode:0o600});}
for(const target of ['park.json','control.json','set-aside.json'])for(const phase of ['partial','fsync','rename'] as const)test(`RED38 caller/restart ${target} ${phase} retains exact failed temp`,()=>{
 const root=mkdtempSync(join(tmpdir(),'park-writer-'));roots.push(root);put(join(root,'install-id.json'),{installId:randomUUID()});put(join(root,'signal/auth/key'),'fake');
 put(join(root,'channels/signal/connection.json'),{version:1,connectionId:'one',generation:3,enabled:false,paused:true,revoking:false,binding:null,account:null});put(join(root,'connector-health.json.journal'),'fake-journal');
 const real=atomic.writeFileAtomic,failure=new Error('writer fault');let expected='',failedPath='';
 vi.spyOn(atomic,'writeFileAtomic').mockImplementation((path,data,options={})=>{
  if(!path.endsWith('/'+target))return real(path,data,options);
  expected=String(data);failedPath=path;expect(options).toMatchObject({mode:0o600,syncDir:true,keepFailedTemp:true});
  real(path,data,{...options,...(phase==='partial'?{ops:{...options.ops,write:((fd:number)=>{writeFileSync(fd,expected.slice(0,7));throw failure;}) as typeof writeFileSync}}:{}),
   ...(phase==='fsync'?{ops:{...options.ops,fsync:()=>{throw failure;}}}:{}),...(phase==='rename'?{rename:()=>{throw failure;}}:{})});
 });
 let thrown:unknown;try{if(target==='set-aside.json')setAsideConnectors(root);else parkSignalForDowngrade(root,{fence});}catch(error){thrown=error;}
 expect(thrown).toBe(failure);expect(failedPath).toBeTruthy();expect(existsSync(failedPath)).toBe(false);
 const dir=dirname(failedPath),temps=readdirSync(dir).filter(name=>name.startsWith(target+'.')&&name.endsWith('.tmp'));expect(temps).toHaveLength(1);
 const temp=join(dir,temps[0]!),bytes=readFileSync(temp);expect(bytes.toString()).toBe(phase==='partial'?expected.slice(0,7):expected);
 expect(existsSync(join(root,'signal/auth/key'))).toBe(true);expect(existsSync(join(root,'channels/signal/connection.json'))).toBe(true);
 vi.restoreAllMocks();if(target==='set-aside.json')setAsideConnectors(root);else recoverSignalPark(root,{fence});
 expect(readFileSync(temp)).toEqual(bytes); // independently kills eager caller/recovery cleanup
});
