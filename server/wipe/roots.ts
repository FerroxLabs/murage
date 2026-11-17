// SPDX-License-Identifier: AGPL-3.0-or-later
import { Worker,MessageChannel,receiveMessageOnPort,type MessagePort } from 'node:worker_threads';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import {known} from './types.ts';
import type { PathPort, RootClass, Value, WipeContext } from './types.ts';
import { mountedRoots,platformMountSource } from './mounts.ts';
import { cleanText, toAbsolute } from './expand.ts';
import { globRegExp, globValue, type GlobSpec } from './glob.ts';
const windows=(p:string)=>/^(?:[a-z]:|\\\\|\/\/)/i.test(p);
/** Shell drive aliases are Windows-only; root-relative paths inherit the execution drive. */
function shellPath(p:string,platform:NodeJS.Platform,base?:string):string {
 if(platform!=='win32')return p;
 p=p.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/|$)/i,(_,drive:string)=>drive.toUpperCase()+':/');
 if(/^\\(?!\\)/.test(p)){
  const drive=/^([a-z]:)/i.exec(base??process.cwd())?.[1]??'C:';
  p=drive+p;
 }
 return p.replace(/^[a-z]:/i,drive=>drive.toUpperCase());
}
export function canonicalPath(p:string,platform:NodeJS.Platform=process.platform,base?:string):string {
 p=p.replace(/^[\\/]{2}[?.][\\/]UNC[\\/]/i,'\\\\').replace(/^[\\/]{2}[?.][\\/](?=[a-z]:[\\/])/i,'');
 p=shellPath(cleanText(p),platform,base);if(platform==='darwin')p=p.normalize('NFC');const win=windows(p)&&!p.startsWith('//')||platform==='win32'&&windows(p),path=win?win32:posix;
 let result=path.resolve(p).replace(/\\/g,'/').replace(/\/$/,'')||'/';if(/^[a-z]:/i.test(result))result=result[0]!.toUpperCase()+result.slice(1).toLowerCase();
 return result;
}
// Quarantine timed-out paths without disabling unrelated owners. Four workers maximum;
// a stuck path never queues another request or consumes another worker.
const pathWorkerSource=platformMountSource+String.raw`
const {workerData}=require('node:worker_threads');
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const port=workerData.port;
port.on('message',({method,path,signal})=>{
 let value=null,error,code;
 try{
  if(method==='realpath')value=fs.realpathSync.native(path);
  else if(method==='stat'||method==='lstat'){
   const stat=fs[method+'Sync'](path,{bigint:true});
   value={dev:stat.dev,ino:stat.ino,symlink:stat.isSymbolicLink()};
  }else if(method==='statfs')value={type:fs.statfsSync(path).type};
  else if(method==='isBlockDevice')value=fs.statSync(path).isBlockDevice();
  else if(method==='mountId'&&process.platform==='linux'){
   let fd;try{fd=fs.openSync(path,0x200000);value=/^mnt_id:\s*(\d+)/m.exec(fs.readFileSync('/proc/self/fdinfo/'+fd,'utf8'))?.[1]??null;}finally{if(fd!==undefined)fs.closeSync(fd);}
  }else if(method==='confirmMount'||method==='mountId'&&['darwin','win32'].includes(process.platform)){
   const roots=readMountPaths(process.platform,()=>fs.readFileSync('/proc/self/mountinfo','utf8'),(file,args)=>execFileSync(file,args,{encoding:'utf8',timeout:300}));
   value=method==='confirmMount'?roots.some(root=>root.replaceAll('\\','/').replace(/\/$/,'').toLowerCase()===path.replaceAll('\\','/').replace(/\/$/,'').toLowerCase()):mountPathId(path,roots,process.platform);
  }
 }catch(e){if(!['ENOENT','ENOTDIR','EINVAL'].includes(e.code)){error='wipe-path-probe-failed';code=e.code;}}
 port.postMessage({value,error,code});
 const done=new Int32Array(signal);Atomics.store(done,0,1);Atomics.notify(done,0);
});`;
export class BoundedPathPort implements PathPort {
 private slots:{worker:Worker;channel:MessagePort;pending?:Int32Array;path?:string;broken:boolean}[]=[];
 private closed=false;
 private degraded=false;
 private source:string;
 private timeoutMs:number;
 constructor(options:{source?:string;timeoutMs?:number}={}){this.source=options.source??pathWorkerSource;this.timeoutMs=options.timeoutMs??100;}
 private request(method:string,path:string):unknown {
  if(this.closed)throw Error('wipe-path-worker-unavailable');
  const key=mountedRoots.keyFor(path)??path.replaceAll('\\','/').split('/').filter(Boolean).slice(0,2).join('/');
  for(const slot of this.slots)if(slot.pending){
   if(Atomics.load(slot.pending,0)!==0){receiveMessageOnPort(slot.channel);slot.pending=undefined;slot.path=undefined;}
   else if(slot.path===key)throw Error('wipe-path-probe-busy');
  }
  let healthy=0;this.slots=this.slots.filter(slot=>{if(slot.broken||!slot.pending&&++healthy>4){slot.channel.close();void slot.worker.terminate();return false;}return true;});
  // A hung key owns one quarantined worker; healthy keys retain a pool of four.
  if(this.slots.filter(slot=>slot.pending).length>=16){
   if(!this.degraded){this.degraded=true;console.warn('[wipe] path probes degraded');}
   throw Error('wipe-path-probe-busy');
  }
  let slot=this.slots.find(slot=>!slot.broken&&!slot.pending);
  if(!slot){
   const {port1,port2}=new MessageChannel();
   const worker=new Worker(this.source,{eval:true,workerData:{port:port2},transferList:[port2]});
   slot={worker,channel:port1,broken:false};this.slots.push(slot);
   const created=slot;worker.on('error',()=>{created.broken=true;});worker.on('exit',()=>{created.broken=true;});
   worker.unref();port1.unref();
  }
  const done=new Int32Array(new SharedArrayBuffer(4));slot.pending=done;slot.path=key;
  slot.channel.postMessage({method,path,signal:done.buffer});
  const deadline=performance.now()+(method==='confirmMount'?300:this.timeoutMs);
  while(Atomics.load(done,0)===0){const left=deadline-performance.now();if(left<=0)throw Error('wipe-path-probe-timeout');Atomics.wait(done,0,0,left);}
  const reply=receiveMessageOnPort(slot.channel)?.message as {value:unknown;error?:string;code?:string}|undefined;
  slot.pending=undefined;slot.path=undefined;
  if(!reply)throw Error('wipe-path-worker-unavailable');
  if(reply.error)throw Object.assign(Error(reply.error),{code:reply.code});
  return reply.value;
 }
 private identity(method:string,path:string):import('./types.ts').PathStat|null {
  const stat=this.request(method,path) as {dev:bigint;ino:bigint;symlink:boolean}|null;
  return stat?{dev:stat.dev,ino:stat.ino,isSymbolicLink:()=>stat.symlink}:null;
 }
 stat(path:string){return this.identity('stat',path);}
 lstat(path:string){return this.identity('lstat',path);}
 statfs(path:string){return this.request('statfs',path) as {type:number|bigint}|null;}
 realpath(path:string){return this.request('realpath',path) as string|null;}
 confirmMount(path:string){return this.request('confirmMount',path) as boolean|null;}
 mountId(path:string){return this.request('mountId',path) as string|null;}
 isBlockDevice(path:string){return this.request('isBlockDevice',path) as boolean|null;}
 async close():Promise<void>{this.closed=true;for(const slot of this.slots)slot.channel.close();await Promise.all(this.slots.map(slot=>slot.worker.terminate()));}
}
export const systemPathPort:PathPort=new BoundedPathPort();
/** All realpath calls live here, including new registry entries. */
export function physicalPath(port:PathPort,p:string):string|null {return port.realpath(p);}
const mountConfirmCache=new WeakMap<PathPort,Set<string>>();
const identityCache=new WeakMap<PathPort,Map<string,import('./types.ts').PathStat|null>>();
const osRoots=['/etc','/usr','/var','/bin','/sbin','/boot','/lib','/lib32','/libx32','/lib64','/libexec','/opt','/System','/Library','/Applications','/Volumes','/mnt','/media','/root','C:\\Windows','C:\\Windows\\System32','C:\\Program Files','C:\\Program Files (x86)','C:\\ProgramData'];
const ancestor=(target:string,root:string)=>target===root||root.startsWith(target==='/'?'/':target+'/');
export class RootClassifier {
 private staticRoots:{path:string;kind:RootClass}[];
 private lexicalHomes:boolean;
 private data:string;
 readonly port:PathPort;
 private ctx:WipeContext;
 private registry:{protectedSubtreeChildren?(dir:string):string[];protectedChildren?(dir:string):string[];contains(p:string):boolean;containsIdentity?(stat:import('./types.ts').PathStat):boolean};
 constructor(ctx:WipeContext,registry:{protectedSubtreeChildren?(dir:string):string[];protectedChildren?(dir:string):string[];contains(p:string):boolean;containsIdentity?(stat:import('./types.ts').PathStat):boolean},lexicalHomes=false){
  this.lexicalHomes=lexicalHomes;this.ctx=ctx;this.registry=registry;
  this.port=ctx.pathPort??systemPathPort;
  const home=ctx.home??ctx.env?.HOME??ctx.env?.USERPROFILE??homedir(),data=ctx.dataDir??process.env.MURAGE_DATA_DIR??home+'/.murage';
  const parent=(p:string)=>windows(p)?win32.dirname(p):posix.dirname(p);
  const roots:[string|undefined,RootClass][]=[['/','fs-root'],[home,'home'],[parent(home),'homes-parent'],['/home','homes-parent'],['/Users','homes-parent'],['C:\\Users','homes-parent'],[data,'murage-data'],[parent(data),'murage-data'],[ctx.project??ctx.workFolder,'project-root'],...osRoots.map(p=>[p,'os-dir'] as [string,RootClass]),['/var/root','home']];
  this.staticRoots=roots.filter((r):r is [string,RootClass]=>!!r[0]).map(([p,kind])=>({path:canonicalPath(p,ctx.platform),kind}));
  // macOS top-level symlinks have stable physical aliases; never realpath every static root per check.
  if((ctx.platform??process.platform)==='darwin')this.staticRoots.push({path:'/private/etc',kind:'os-dir'},{path:'/private/var',kind:'os-dir'},{path:'/private/var/root',kind:'home'});
  this.data=canonicalPath(data,ctx.platform);
 }
 private raw(value:Value):string|undefined {
  if(value.k==='opaque'||!value.s)return;
  let s=value.s;
  if(!posix.isAbsolute(s)&&!win32.isAbsolute(s)){
   if(this.ctx.cwdOpaque)return;
   const cwd=this.ctx.cwd??this.ctx.workFolder??this.ctx.project;if(!cwd)return;
   s=cwd.replace(/[\\/]$/,'')+'/'+s;
  }
  return shellPath(s,this.ctx.platform??process.platform,this.ctx.cwd??this.ctx.workFolder??this.ctx.project??this.ctx.home);
 }
 /** Product retention uses the same roots without filesystem probes or mount refreshes. */
 classifyLexical(input:Value|string):RootClass|undefined {
  const value:Value=typeof input==='string'?known(input):input;
  if(value.k==='opaque')return;
  if(value.candidates){for(const s of value.candidates){const hit=this.classifyLexical({...value,s,candidates:undefined});if(hit)return hit;}return;}
  if(value.glob)return this.classifyGlob(value,false,true);
  let candidate=value;
  if(/^[a-z]:[^\\/]/i.test(value.s)){
   const cwd=this.ctx.cwd??this.ctx.workFolder??this.ctx.project;if(!cwd||this.ctx.cwdOpaque)return;
   const paths=toAbsolute(value,{cwd:known(cwd),platform:this.ctx.platform,home:this.ctx.home});if(!paths.length)return;candidate={...value,s:paths[0]!};
  }
  const raw=this.raw(candidate);if(raw===undefined)return;
  const target=canonicalPath(raw,this.ctx.platform);
  if(/^[a-z]:$|^\/\/[^/]+\/[^/]+$/i.test(target))return 'drive-root';
  const exact=this.staticRoots.find(root=>root.path===target);if(exact)return exact.kind;
  for(const root of this.staticRoots)if(root.kind==='os-dir'&&!root.path.startsWith('/private/')?target===root.path:ancestor(target,root.path))return root.kind;
  if(!/[*?\[\]]/.test(target)&&(/^\/(?:home|Users)\/[^/]+$/.test(target)||/^[a-z]:\/users\/[^/]+$/i.test(target)))return 'home';
  try{if(this.registry.contains(target))return 'project-root';}catch{}
 }
 private classifyGlob(value:Extract<Value,{k:'known'}>,follow:boolean,lexicalOnly=false):RootClass|undefined {
  const legacy=value.glob!;
  let spec:GlobSpec;
  if('segments' in legacy)spec=legacy as GlobSpec;
  else{
   const parsed=globValue(legacy.dir.replace(/[\\/]$/,'')+'/'+legacy.pattern,this.ctx.dialect??(this.ctx.lang==='pwsh'?'pwsh':'sh'));
   if(parsed.k!=='known')return;
   if(!parsed.glob)return lexicalOnly?this.classifyLexical(parsed):this.classify(parsed,follow);
   spec=parsed.glob as GlobSpec;
  }
  // Existing operand() rebases dir; A's new adapter rebases base as well.
  const baseValue=known(spec.dir??spec.base),cwd=this.ctx.cwd??this.ctx.workFolder??this.ctx.project;
  if(this.ctx.cwdOpaque&&!posix.isAbsolute(baseValue.s)&&!win32.isAbsolute(baseValue.s))return;
  const raw=toAbsolute(baseValue,{cwd:known(cwd??''),platform:this.ctx.platform,home:this.ctx.home})[0];if(!raw)return;
  const base=canonicalPath(raw,this.ctx.platform),segments=spec.segments;
  const memo=new Set<string>();
  const children=(parent:string):string[]=>{
   const paths=[...this.staticRoots.map(root=>root.path),...(this.registry.protectedSubtreeChildren?.(parent)??this.registry.protectedChildren?.(parent)??[])];
   const names=new Set<string>();
   for(const path of paths){const normalized=canonicalPath(path,this.ctx.platform),prefix=parent==='/'?'/':parent+'/';if(!normalized.startsWith(prefix))continue;const name=normalized.slice(prefix.length).split('/')[0];if(name)names.add(prefix+name);}
   return [...names];
  };
  const pending=[{parent:base,index:0}];
  while(pending.length){
   const {parent,index}=pending.pop()!,key=index+'\0'+parent;if(memo.has(key))continue;memo.add(key);
   if(index===segments.length){const target={...known(parent),wholeDirGlob:value.wholeDirGlob,dirsOnly:value.dirsOnly},hit=lexicalOnly?this.classifyLexical(target):this.classify(target,true);if(hit)return hit;continue;}
   const segment=segments[index]!,matcher=globRegExp(segment,spec.dialect,/^[a-z]:/i.test(parent));
   if(segment==='**'){
    for(const child of children(parent).reverse())pending.push({parent:child,index});
    pending.push({parent,index:index+1});continue;
   }
   if(!/[*?\[]/.test(segment)){pending.push({parent:canonicalPath(parent+'/'+segment,this.ctx.platform),index:index+1});continue;}
   // A wildcard over exact-case lexical home children keeps the existing text-layer guarantee.
   if(this.lexicalHomes&&index===segments.length-1&&(parent==='/home'||parent==='/Users'||/^[a-z]:\/users$/i.test(parent)))return 'home';
   for(const child of children(parent).reverse())if(matcher.test(child.slice(child.lastIndexOf('/')+1)))pending.push({parent:child,index:index+1});
  }
 }
 classify(value:Value,follow=false):RootClass|undefined {
  if(value.k==='known'&&value.candidates){
   // An ambiguous UNC share must not mask a more specific protected POSIX reading.
   let unc:RootClass|undefined;
   for(const s of value.candidates){const kind=this.classify({...value,s,candidates:undefined},follow);if(!kind)continue;if(s.startsWith('\\\\'))unc??=kind;else return kind;}
   return unc;
  }
  if(value.k==='known'&&value.glob){
   return this.classifyGlob(value,follow);
  }
  const raw=this.raw(value);if(raw===undefined)return;
  const lexical=canonicalPath(raw,this.ctx.platform);
  const staticClass=(target:string,fold=false):RootClass|undefined=>{
   const flat=fold?target.toLowerCase():target;
   if(/^[a-z]:$|^\/\/[^/]+\/[^/]+$/i.test(flat))return 'drive-root';
   const exact=this.staticRoots.find(root=>(fold?root.path.toLowerCase():root.path)===flat);if(exact)return exact.kind;
   for(const root of this.staticRoots){const path=fold?root.path.toLowerCase():root.path;if(root.kind==='os-dir'&&!path.startsWith('/private/')?flat===path:ancestor(flat,path))return root.kind;}
  };
  // Byte-exact static roots and their ancestors require no filesystem IO.
  const alias=this.ctx.platform==='darwin'&&raw!==raw.normalize('NFC');
  const direct=alias?undefined:staticClass(lexical);if(direct&&direct!=='project-root')return direct;
  let physical:string|null=null,stat:import('./types.ts').PathStat|null|undefined;
  try{stat=follow?this.port.stat?.(raw):(this.port.lstat??this.port.stat)?.call(this.port,raw);}catch{}
  if(!follow&&stat?.isSymbolicLink?.())return;
  // MAIN RULING 1114-WIPE-FIXTURE-DIRECTION item 4(b): an exact-case user home is a home even when this host
  // cannot see it (the engine may run in WSL, a container or Cloud exec).
  if(this.lexicalHomes&&stat===null&&!alias&&!/[*?\[\]]/.test(lexical)&&(/^\/(?:home|Users)\/[^/]+$/.test(lexical)||/^[a-z]:\/users\/[^/]+$/i.test(lexical)))return 'home';
  if(stat===null&&direct!=='project-root')return;
  if(!alias)try{if(this.registry.contains(lexical)||direct==='project-root')return 'project-root';}catch{}
  if(stat===null)return;
  try{
   if(stat&&this.port.stat&&['darwin','win32'].includes(this.ctx.platform??process.platform)){
    let identities=identityCache.get(this.port);if(!identities){identities=new Map();identityCache.set(this.port,identities);}
    const aliasKey=(path:string)=>(this.ctx.platform==='darwin'?path.normalize('NFC'):path).toLowerCase();
    for(const root of this.staticRoots)if(aliasKey(root.path)===aliasKey(lexical)){
     if(!identities.has(root.path))identities.set(root.path,this.port.stat(root.path));const identity=identities.get(root.path);
     if(identity&&identity.dev===stat.dev&&identity.ino===stat.ino)return root.kind;
    }
   }
   if(stat&&this.registry.containsIdentity?.(stat))return 'project-root';
  }catch{}
  // Mount inventory/confirmation failures never suppress referent resolution.
  const inventory=this.ctx.mountInventory??mountedRoots;
  if(stat&&this.port.stat)try{
   const parent=windows(raw)?win32.dirname(raw):posix.dirname(raw.replace(/[\\/]$/,''));
   const parentStat=(this.port.lstat??this.port.stat).call(this.port,parent);
   let mountChanged=false;
   if((this.ctx.platform??process.platform)==='linux'&&this.port.mountId)try{const id=this.port.mountId(raw),parentId=this.port.mountId(parent);mountChanged=id!==null&&parentId!==null&&id!==parentId;if(id!==null&&parentId===id&&inventory.has?.(lexical)){inventory.drop?.(lexical);mountConfirmCache.get(this.port)?.delete(lexical);}}catch{}
   if(mountChanged||parentStat&&parentStat.dev!==stat.dev){
    if(this.port.confirmMount&&inventory.has?.(lexical)&&mountConfirmCache.get(this.port)?.has(lexical))return 'drive-root';
    let confirmed:boolean|null;
    try{
     if(this.port.confirmMount)confirmed=this.port.confirmMount(raw);
     else if(this.port.mountId){const id=this.port.mountId(raw),up=this.port.mountId(parent);confirmed=id===null||up===null?null:id!==up;}
     else confirmed=null;
    }catch{confirmed=null;}
    if(confirmed!==false){inventory.add?.(lexical);if(confirmed===true){let cache=mountConfirmCache.get(this.port);if(!cache){cache=new Set();mountConfirmCache.set(this.port,cache);}cache.add(lexical);}return 'drive-root';}
    inventory.drop?.(lexical);
   }
  }catch{}
  try{physical=physicalPath(this.port,raw);}catch{}

  const fold=false;
  for(const target of new Set([lexical,...(physical?[canonicalPath(physical,this.ctx.platform)]:[])])){
   const staticHit=alias?undefined:staticClass(target,fold);if(staticHit)return staticHit;
   if(!/[*?\[\]]/.test(target)&&(/^\/(?:home|Users)\/[^/]+$/.test(target)||/^[a-z]:\/users\/[^/]+$/i.test(target)))return 'home';
   if((this.ctx.mountInventory??mountedRoots).contains(target))return 'drive-root';
   try{if(target!==lexical&&this.registry.contains(target))return 'project-root';}catch{/* A registry fault cannot turn readable harmless text into a card. */}
   const relative=target.startsWith(this.data+'/')?target.slice(this.data.length+1):'';
   if(/^workspaces\/[\w-]+(?:\.general|\.(?:teams|projects|rooms)\/[\w-]+)?(?:\/threads\/[\w-]+)?$/.test(relative))return 'project-root';
   if(/^workspaces(?:$|\/[\w-]+\.(?:teams|projects|rooms)$|\/[\w-]+(?:\.general|\.(?:teams|projects|rooms)\/[\w-]+)?\/threads$)/.test(relative))return 'project-root';
  }
 }
 isDevice(value:Value):boolean {
  // Item 4(e): a branch-assigned variable carries every value it may hold.
  if(value.k==='known'&&value.candidates)return value.candidates.some(s=>this.isDevice({...value,s,candidates:undefined}));
  const raw=this.raw(value);if(raw===undefined)return false;
  // /proc/<pid>/root is the filesystem root and /proc/<pid>/cwd a working directory, however the path reaches them.
  const proc=/^(.*?)\/proc\/(?:self|thread-self|\d+)\/(root|cwd)(\/.*)$/.exec(raw.replaceAll('\\','/'));
  if(proc&&canonicalPath(proc[1]||'/',this.ctx.platform)==='/'){const base=proc[2]==='root'?'':this.ctx.cwdOpaque?undefined:this.ctx.cwd??this.ctx.workFolder??this.ctx.project;if(base!==undefined)return this.isDevice(known(base.replace(/\/$/,'')+proc[3]));}
  if(/^\\\\\.\\PhysicalDrive\d+$/i.test(raw))return true;
  const s=raw.startsWith('/')?posix.resolve('/',cleanText(raw)):canonicalPath(raw,this.ctx.platform);
  if(/^\/dev\/(?:null|zero|full|random|urandom|tty[^/]*|console|ptmx|fuse|std(?:in|out|err))$|^\/dev\/(?:fd|pts|shm|mqueue|net)\//.test(s))return false;
  if(/^\/dev\/disk\/by-id\/[^/]+$/.test(s))return true;
  if(/^\/dev\/(?:r?disk\d|sd[a-z]|hd[a-z]|nvme\d|mmcblk\d|vd[a-z]|xvd[a-z]|dm-\d|md\d|loop\d)/.test(s))return true;
  let block:boolean|null;try{block=this.port.isBlockDevice(raw);}catch{block=null;}
  return block===true||block===null&&/^\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|mmcblk\d|vd[a-z]|xvd[a-z]|dm-\d|md\d|loop\d)/.test(s);
 }
}
