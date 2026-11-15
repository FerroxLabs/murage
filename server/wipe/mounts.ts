// SPDX-License-Identifier: AGPL-3.0-or-later
import { Worker } from 'node:worker_threads';
type Trie={terminal:boolean;children:Map<string,Trie>};
const node=():Trie=>({terminal:false,children:new Map()});
const key=(p:string)=>{const flat=p.replaceAll('\\','/').replace(/\/$/,'')||'/';return /^(?:[a-z]:|\/\/)/i.test(flat)?flat.toLowerCase():flat;};
/** Includes persistent filesystems and bind mounts; platform readers exclude virtual types.
 * Inventory publication is atomic; refreshes are off the admission path. */
export class MountInventory {
 private tree=node();private exact=new Set<string>();
 readonly stats={mountRefreshes:0,trieNodesTouched:0};
 private read:()=>readonly string[]|Promise<readonly string[]>;
 private refreshing:Promise<void>|undefined;
 constructor(read:()=>readonly string[]|Promise<readonly string[]>=systemMountPaths){this.read=read;}
 refresh():void|Promise<void> {
  if(this.refreshing)return this.refreshing;
  const roots=this.read();
  if(roots instanceof Promise){
   this.refreshing=roots.then(paths=>this.publish(paths)).finally(()=>{this.refreshing=undefined;});
   return this.refreshing;
  }
  this.publish(roots);
 }
 private publish(roots:readonly string[]):void {
  const tree=node(),exact=new Set<string>();
  for(const path of roots){const flat=key(path);exact.add(flat);let cursor=tree;for(const part of flat.split('/').filter(Boolean)){let next=cursor.children.get(part);if(!next){next=node();cursor.children.set(part,next);}cursor=next;}cursor.terminal=true;}
  this.tree=tree;this.exact=exact;this.stats.mountRefreshes++;
 }
 add(path:string):void {
  const flat=key(path);if(this.exact.has(flat))return;this.exact.add(flat);let cursor=this.tree;
  for(const part of flat.split('/').filter(Boolean)){let next=cursor.children.get(part);if(!next){next=node();cursor.children.set(part,next);}cursor=next;}cursor.terminal=true;this.stats.mountRefreshes++;
 }
 keyFor(path:string):string|undefined {const parts=key(path).split('/').filter(Boolean);let cursor=this.tree,prefix='',longest:string|undefined;for(const part of parts){const child=cursor.children.get(part);if(!child)break;cursor=child;prefix+='/'+part;if(cursor.terminal)longest=prefix;}return longest;}

 /** Integration handoff of the last atomically published mount set. */
 snapshot():readonly string[] {return [...this.exact];}
 has(path:string):boolean{return this.exact.has(key(path));}
 drop(path:string):void {if(!this.exact.has(key(path)))return;this.publish([...this.exact].filter(p=>p!==key(path)));}
 contains(path:string):boolean {
  let cursor=this.tree;this.stats.trieNodesTouched++;
  for(const part of key(path).split('/').filter(Boolean)){const next=cursor.children.get(part);if(!next)return false;cursor=next;this.stats.trieNodesTouched++;}
  return cursor.terminal||cursor.children.size>0;
 }
}
export const virtualMount=(type:string)=>/^(?:proc|sysfs|devtmpfs|devpts|tmpfs|ramfs|cgroup.*|securityfs|debugfs|tracefs|mqueue|hugetlbfs|bpf|pstore|fusectl|configfs|autofs)$/.test(type);
/** Pure platform adapters are serialized into both bounded probe workers. */
export function readMountPaths(platform:string,read:()=>string,exec:(file:string,args:string[])=>string):string[] {
 const unescape=(path:string)=>path.replace(/\\([0-7]{3})/g,(_,octal:string)=>String.fromCharCode(parseInt(octal,8)));
 if(platform==='linux')return read().split('\n').filter(Boolean).filter(row=>!virtualMount(row.split(' - ')[1]?.split(' ')[0]??'')).map(row=>unescape(row.split(' ')[4]!));
 if(platform==='darwin')return exec('/sbin/mount',[]).split('\n').flatMap(row=>{const match=/ on (.+) \(/.exec(row);return match&&!virtualMount(row.split(' (')[1]?.split(',')[0]??'')?[unescape(match[1]!)]:[];});
 if(platform==='win32')return exec('mountvol',[]).split(/\r?\n/).map(row=>row.trim()).filter(path=>/^[a-z]:[\\/]|^\\\\(?!\?)/i.test(path));
 return ['/'];
}
export function mountPathId(path:string,paths:readonly string[],platform:string):string|null {
 const normalize=(p:string)=>{const flat=p.replaceAll('\\','/').replace(/\/$/,'')||'/';return platform==='win32'?flat.toLowerCase():flat;};
 const target=normalize(path);
 return paths.map(normalize).filter(root=>target===root||target.startsWith(root==='/'?'/':root+'/')).sort((a,b)=>b.length-a.length)[0]??null;
}
export const platformMountSource=`const virtualMount=${virtualMount.toString()};const readMountPaths=${readMountPaths.toString()};const mountPathId=${mountPathId.toString()};`;
const mountWorkerSource=platformMountSource+String.raw`
const {parentPort}=require('node:worker_threads');
const {readFileSync}=require('node:fs');
const {execFileSync}=require('node:child_process');
parentPort.on('message',()=>{
 try{
  const roots=readMountPaths(process.platform,()=>readFileSync('/proc/self/mountinfo','utf8'),(file,args)=>execFileSync(file,args,{encoding:'utf8',timeout:500}));
  parentPort.postMessage({roots});
 }catch{parentPort.postMessage({error:true});}
});`;
/** One worker and one request maximum, even if a kernel filesystem call never returns. */
export class MountProbe {
 private worker:Worker|undefined;
 private pending=false;
 private broken=false;
 private accept:((value:string[])=>void)|undefined;
 private reject:((error:Error)=>void)|undefined;
 private deadline:ReturnType<typeof setTimeout>|undefined;
 private source:string;
 private timeoutMs:number;
 constructor(source=mountWorkerSource,timeoutMs=1000){this.source=source;this.timeoutMs=timeoutMs;}
 read():Promise<string[]> {
  if(this.broken||this.pending)return Promise.reject(Error('wipe-mount-probe-busy'));
  if(!this.worker){
   this.worker=new Worker(this.source,{eval:true});
   this.worker.on('message',(reply:{roots?:string[];error?:boolean})=>{
    this.pending=false;clearTimeout(this.deadline);
    if(reply.roots)this.accept?.(reply.roots);else this.reject?.(Error('wipe-mount-probe-failed'));
    this.accept=undefined;this.reject=undefined;
   });
   this.worker.on('error',()=>this.fail());this.worker.on('exit',()=>this.fail());
   this.worker.unref();
  }
  this.pending=true;
  return new Promise((resolve,reject)=>{
   this.accept=resolve;this.reject=reject;
   this.deadline=setTimeout(()=>{reject(Error('wipe-mount-probe-timeout'));this.accept=undefined;this.reject=undefined;},this.timeoutMs);
   this.deadline.unref();this.worker!.postMessage(null);
  });
 }
 private fail():void {this.broken=true;clearTimeout(this.deadline);this.reject?.(Error('wipe-mount-probe-failed'));this.accept=undefined;this.reject=undefined;}
 async close():Promise<void>{this.fail();await this.worker?.terminate();}
}
const mountProbe=new MountProbe();
export function systemMountPaths():Promise<string[]> {return mountProbe.read();}
export const mountedRoots=new MountInventory();
const refresh=()=>{try{void Promise.resolve(mountedRoots.refresh()).catch(()=>{});}catch{}};
refresh();
const timer=setInterval(refresh,60000);timer.unref();
