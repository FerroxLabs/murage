// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: scperf-p2 (outer supervisor + every writable scan descendant).
// Consumer owner: scperf-p2 (server immutable snapshot and separate byte source).
// Packaged platform qualification owner: MAIN.
import {createHash,createHmac,randomBytes,timingSafeEqual} from "node:crypto";
import {lstatSync,readFileSync,realpathSync,type Stats} from "node:fs";
import {dirname,join,parse} from "node:path";
import {sentinelInstallationIdOf} from "../../shared/sentinel-installation.mjs";
import {sentinelPresenceObserved} from "../sentinel-descriptor-state.ts";
import {scannerNative,type ScannerNative} from "./io-meter.ts";
import {type SentinelDescriptor,loadDescriptor,defaultOutputRoot,DESCRIPTOR_FILE,checkOwnedFile,readSmallVerified,DESCRIPTOR_MAX_BYTES} from "./paths.ts";

export const RECEIPT_BYTES=4096, REQUEST_BYTES=1024, RECEIPT_MAX_AGE_MS=180_000;
const receiptKeys=["v","installationId","descriptorDigest","entryDigest","scheduleRevision","keyId","epoch","serverNonce","runId","sequence","lossSerial","phase","issuedAtMs","totalBytes","known","mac"] as const;
const enrollmentKeys=["v","installationId","keyId","epoch"] as const;
const absenceKeys=["v","installationId","keyId","epoch","outputDigest","phase","mac"] as const;
const requestKeys=["v","installationId","serverNonce","mac"] as const;
const nonce=()=>randomBytes(16).toString("hex");
const digest=(bytes:Buffer|string)=>createHash("sha256").update(bytes).digest("hex");
const uint=(x:unknown):x is number=>typeof x==="number"&&Number.isSafeInteger(x)&&x>=0;
const hex=(x:unknown,n:number):x is string=>typeof x==="string"&&new RegExp(`^[0-9a-f]{${n}}$`).test(x);
export interface FileReceipt {
 v:1;installationId:string;descriptorDigest:string;entryDigest:string;scheduleRevision:number;keyId:string;
 epoch:string;serverNonce:string;runId:string;sequence:number;lossSerial:number;phase:"active"|"sealed"|"fault";
 issuedAtMs:number;totalBytes:number;known:boolean;mac:string;
}
interface Enrollment {v:1;installationId:string;keyId:string;epoch:string}
interface Request {v:1;installationId:string;serverNonce:string;mac:string}
function mac(key:Buffer,domain:string,payload:object):string {
 return createHmac("sha256",key).update(`murage-sentinel-io-v1/${domain}\n`).update(JSON.stringify(payload)).digest("hex");
}
function fields<T extends object>(value:T,keys:readonly string[]):Record<string,unknown> {
 return Object.fromEntries(keys.map(k=>[k,(value as Record<string,unknown>)[k]]));
}
function signed<T extends object>(value:T,keys:readonly string[],key:Buffer,domain:string):T&{mac:string} {
 const unsigned=fields(value,keys.filter(k=>k!=="mac"));
 return {...unsigned,mac:mac(key,domain,unsigned)} as T&{mac:string};
}
/** Re-encoding with the fixed key order rejects duplicate/unknown keys,
 * noncanonical UTF-8, alternate number encodings and non-space trailing bytes. */
function document<T extends object>(bytes:Buffer,keys:readonly string[],limit:number,padded=false):T {
 if(bytes.length>limit||(padded&&bytes.length!==limit))throw Error("RECEIPT_LENGTH");
 const text=bytes.toString("utf8"),json=padded?text.replace(/ +$/u,""):text;
 const value=JSON.parse(json) as T;
 if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==keys.length
  ||JSON.stringify(fields(value,keys))!==json)throw Error("RECEIPT_CANONICAL");
 return value;
}
function authentic(value:object&{mac:string},keys:readonly string[],key:Buffer,domain:string):boolean {
 if(!hex(value.mac,64))return false;
 return timingSafeEqual(Buffer.from(value.mac,"hex"),Buffer.from(mac(key,domain,fields(value,keys.filter(k=>k!=="mac"))),"hex"));
}
export function encodeReceipt(value:Omit<FileReceipt,"mac">,key:Buffer):Buffer {
 const text=JSON.stringify(signed(value,receiptKeys,key,"receipt"));
 if(Buffer.byteLength(text)>RECEIPT_BYTES)throw Error("RECEIPT_LENGTH");
 const bytes=Buffer.from(text.padEnd(RECEIPT_BYTES," "),"utf8");
 decodeReceipt(bytes,key);return bytes;
}
export function decodeReceipt(bytes:Buffer,key:Buffer):FileReceipt {
 const r=document<FileReceipt>(bytes,receiptKeys,RECEIPT_BYTES,true);
 if(r.v!==1||!hex(r.installationId,32)||!hex(r.descriptorDigest,64)||!hex(r.entryDigest,64)||!uint(r.scheduleRevision)
  ||!hex(r.keyId,64)||!hex(r.epoch,32)||!hex(r.serverNonce,32)||!hex(r.runId,32)
  ||![r.sequence,r.lossSerial,r.issuedAtMs,r.totalBytes].every(uint)||!['active','sealed','fault'].includes(r.phase)
  ||typeof r.known!=="boolean"||!authentic(r,receiptKeys,key,"receipt"))throw Error("RECEIPT_INVALID");
 return Object.freeze(r);
}

type Native=Required<ScannerNative>;
function native():Native {
 const n=scannerNative();
 if(!n||!["sentinelIoAwakeMs","sentinelIoCreateRoot","sentinelIoRoot","sentinelIoOpen","sentinelIoClose","sentinelIoLock","sentinelIoRead","sentinelIoWrite","sentinelIoReplace"].every(k=>typeof n[k as keyof ScannerNative]==="function"))throw Error("RECEIPT_NATIVE_UNAVAILABLE");
 return n as Native;
}
/** Every opened file is checked on its native handle, directly under a pinned
 * private directory. The native layer owns Windows HANDLEs; no CRT fd crosses. */
/** A dangling link is present and must enter the refusing native opener.
 * Only ENOENT is missing; permission/type errors must never select legacy I/O. */
export function receiptPathPresent(path:string):boolean {
 try{lstatSync(path);return true;}catch(error){return !(error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT");}
}
export class ReceiptDirectory {
 readonly api:Native;readonly root:object;readonly parent:object;readonly path:string;
 private identity:Stats;private parentIdentity:Stats;
 constructor(path:string){
  this.path=path;this.identity=lstatSync(path);this.parentIdentity=lstatSync(dirname(path));
  if(realpathSync.native(path)!==path)throw Error("RECEIPT_DIRECTORY_ALIAS");
  this.api=native();this.parent=this.api.sentinelIoRoot(dirname(path));
  try{this.root=this.api.sentinelIoRoot(path);}catch(error){this.api.sentinelIoClose(this.parent);throw error;}
  try{this.assertCurrent();}catch(error){this.close();throw error;}
 }
 close(){this.api.sentinelIoClose(this.root);this.api.sentinelIoClose(this.parent);}
 assertCurrent(){
  const root=lstatSync(this.path),parent=lstatSync(dirname(this.path));
  if(root.isSymbolicLink()||parent.isSymbolicLink()||realpathSync.native(this.path)!==this.path
   ||root.dev!==this.identity.dev||root.ino!==this.identity.ino||parent.dev!==this.parentIdentity.dev||parent.ino!==this.parentIdentity.ino)throw Error("RECEIPT_DIRECTORY_CHANGED");
  // Closed, bounded namespace; an unsafe unused replacement name also makes
  // the writer set unprovable. No directory enumeration or link resolution.
  for(const name of ["enrollment.json","key","request.json","receipt.json","writer.lock","snapshot.lock","enrollment.json.tmp","key.tmp","request.json.tmp","receipt.json.tmp","absence.json","absence.json.tmp"]){
   try{const st=lstatSync(join(this.path,name));if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw Error("RECEIPT_FILE_ALIAS");}
   catch(error){if(!error||typeof error!=="object"||!("code" in error)||error.code!=="ENOENT")throw error;}
  }
 }
 open(name:string,kind=0){this.assertCurrent();return this.api.sentinelIoOpen(this.root,name,kind);}
 read(name:string,max:number){const h=this.open(name);try{return this.api.sentinelIoRead(h,max);}finally{this.api.sentinelIoClose(h);}}
 lock(name:"writer.lock"|"snapshot.lock",exclusive:boolean):object|null {
  const h=this.open(name,1);
  if(this.api.sentinelIoLock(h,exclusive?2:1))return h;
  this.api.sentinelIoClose(h);return null;
 }
 release(h:object){this.api.sentinelIoClose(h);}
 /** A single fixed temporary file is reused; existing links and broad files are
  * refused by the native opener before truncation. Flush precedes replacement. */
 replace(name:string,bytes:Buffer){
  const temp=`${name}.tmp`;let h:object;
  try{h=this.open(temp,2);}catch{h=this.open(temp,1);}
  try{if(!this.api.sentinelIoWrite(h,bytes))throw Error("RECEIPT_WRITE");}
  finally{this.api.sentinelIoClose(h);}
  this.assertCurrent();
  if(!this.api.sentinelIoReplace(this.root,temp,name))throw Error("RECEIPT_REPLACE");
  this.assertCurrent();
 }
}
export const receiptDirectoryOf=(dataDir:string)=>join(realpathSync.native(dataDir),"sentinel-io");
function enrollment(dir:ReceiptDirectory):{value:Enrollment;key:Buffer} {
 const value=document<Enrollment>(dir.read("enrollment.json",1024),enrollmentKeys,1024),key=dir.read("key",32);
 if(value.v!==1||!hex(value.installationId,32)||!hex(value.keyId,64)||!hex(value.epoch,32)||key.length!==32||digest(key)!==value.keyId)throw Error("RECEIPT_ENROLLMENT");
 return {value,key};
}
/** A never-created output root is stronger than a missing descriptor: every
 * product launcher creates and retains that root before any writer. Once it
 * exists, a deleted descriptor cannot requalify a legacy installation. */
function virginOutput(output:string):boolean {
 let at=parse(output).root;
 for(const component of output.slice(at.length).split(/[\\/]/)){
  at=join(at,component);
  try{const st=lstatSync(at);if(!st.isDirectory()||st.isSymbolicLink())return false;}
  catch(error){return !!error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT";}
 }
 return false;
}
function coverageOutputRoot(installationId:string):string|null {
 const env=process.env,home=process.platform==="win32"?env.USERPROFILE:env.HOME;
 // Account-database homedir fallback is not evidence of the launcher's root.
 if(!env.MURAGE_SENTINEL_STATE_DIR&&!env.XDG_STATE_HOME&&!env.LOCALAPPDATA&&!home)return null;
 return defaultOutputRoot(installationId);
}
interface AbsenceProof {v:1;installationId:string;keyId:string;epoch:string;outputDigest:string;phase:"absent"|"retired";mac:string}
function absenceProof(dir:ReceiptDirectory,value:Enrollment,key:Buffer,output:string):AbsenceProof {
 const p=document<AbsenceProof>(dir.read("absence.json",1024),absenceKeys,1024);
 if(p.v!==1||p.installationId!==value.installationId||p.keyId!==value.keyId||p.epoch!==value.epoch
  ||p.outputDigest!==digest(output)||!["absent","retired"].includes(p.phase)||!authentic(p,absenceKeys,key,"absence"))throw Error("RECEIPT_ABSENCE_PROOF");
 return p;
}
function retireAbsence(dir:ReceiptDirectory,value:Enrollment,key:Buffer,output:string){
 if(!receiptPathPresent(join(dir.path,"absence.json")))return;
 const proof=absenceProof(dir,value,key,output);
 if(proof.phase==="absent")dir.replace("absence.json",Buffer.from(JSON.stringify(signed({...proof,phase:"retired"},absenceKeys,key,"absence"))));
}
/** Default boot/launcher admission. Only a newly created private barrier and a
 * never-created descriptor root can establish no writers. Existing unmarked
 * roots (even empty ones) are legacy/unknown; no missing key is repaired. */
export function prepareDefaultFileReceipts(dataDir:string,descriptor?:SentinelDescriptor):boolean {
 let dir:ReceiptDirectory|undefined,writer:object|null=null,snapshot:object|null=null;
 try{
  const canonical=realpathSync.native(dataDir),installationId=sentinelInstallationIdOf(canonical);
  const output=coverageOutputRoot(installationId);if(!output)return false;
  const path=join(canonical,"sentinel-io");
  if(!receiptPathPresent(path)){
   if(!virginOutput(output))return false;
   // Pin the parent BEFORE creating the child. Native opens reject aliases and
   // insecure directories; a competing initializer never wins by overwriting.
   const parent=native().sentinelIoRoot(canonical);
   try{if(realpathSync.native(canonical)!==canonical||!native().sentinelIoCreateRoot(path))return false;}
   finally{native().sentinelIoClose(parent);}
   dir=new ReceiptDirectory(path);
   for(const name of ["writer.lock","snapshot.lock"]){const h=dir.open(name,2);dir.release(h);}
   writer=dir.lock("writer.lock",true);snapshot=dir.lock("snapshot.lock",true);
   if(!writer||!snapshot||!virginOutput(output))return false;
   const key=randomBytes(32),value:Enrollment={v:1,installationId,keyId:digest(key),epoch:nonce()};
   dir.replace("key",key);
   dir.replace("absence.json",Buffer.from(JSON.stringify(signed({...value,outputDigest:digest(output),phase:"absent"},absenceKeys,key,"absence"))));
   // Enrollment is the commit record, published last under both leases.
   dir.replace("enrollment.json",Buffer.from(JSON.stringify(value)));
  }else{
   dir=new ReceiptDirectory(path);
   const {value,key}=enrollment(dir);if(value.installationId!==installationId)return false;
   // Validate an absence record when one exists; an ordinary enrolled receipt
   // family has already closed legacy admission and needs no absence record.
   if(receiptPathPresent(join(path,"absence.json")))absenceProof(dir,value,key,output);
  }
  if(snapshot){dir.release(snapshot);snapshot=null;}if(writer){dir.release(writer);writer=null;}
  dir.close();dir=undefined;
  if(!descriptor&&receiptPathPresent(join(output,DESCRIPTOR_FILE))){
   const loaded=loadDescriptor(join(output,DESCRIPTOR_FILE),{create:false,requireInstallationRoot:false});
   if(!loaded.ok)return false;descriptor=loaded.value;
  }
  return descriptor?provisionFileReceipts(canonical,{legacyExcluded:true,descriptor}):true;
 }catch{return false;}
 finally{if(snapshot)dir?.release(snapshot);if(writer)dir?.release(writer);dir?.close();}
}
/** Caller must have stopped/drained legacy entry points before admitting an
 * upgrade. False is the default: a missing key/enrollment is never regenerated. */
export function provisionFileReceipts(dataDir:string,options:{legacyExcluded:boolean;descriptor?:SentinelDescriptor}):boolean {
 if(!options.legacyExcluded)return false;
 const canonical=realpathSync.native(dataDir),path=join(canonical,"sentinel-io");
 if(receiptPathPresent(path)){
  try{const dir=new ReceiptDirectory(path);let writer:object|null=null,snapshot:object|null=null;
   try{
    const {value,key}=enrollment(dir);
    if(value.installationId!==sentinelInstallationIdOf(canonical))return false;
    if(receiptPathPresent(join(path,"absence.json"))&&!receiptPathPresent(join(path,"receipt.json"))){
     const output=options.descriptor?.outputRoot??defaultOutputRoot(value.installationId);
     if(!output)return false;
     absenceProof(dir,value,key,output);
     const loaded=loadDescriptor(join(output,DESCRIPTOR_FILE),{create:false,requireInstallationRoot:false});
     if(!loaded.ok)return false;
     const binding=identity(loaded.value);if(binding.installationId!==value.installationId)return false;
     writer=dir.lock("writer.lock",true);snapshot=dir.lock("snapshot.lock",true);if(!writer||!snapshot)return false;
     retireAbsence(dir,value,key,output);
     dir.replace("receipt.json",encodeReceipt({v:1,...binding,keyId:value.keyId,epoch:value.epoch,serverNonce:"0".repeat(32),runId:nonce(),sequence:0,lossSerial:0,phase:"fault",issuedAtMs:0,totalBytes:0,known:false},key));
    }
    return true;
   }finally{if(snapshot)dir.release(snapshot);if(writer)dir.release(writer);dir.close();}
  }catch{return false;}
 }
 try{
  const output=options.descriptor?.outputRoot??defaultOutputRoot(sentinelInstallationIdOf(canonical));
  const loaded=output?loadDescriptor(join(output,DESCRIPTOR_FILE),{create:false,requireInstallationRoot:false}):null;
  if(!loaded?.ok)return false;
  const binding=identity(loaded.value);
  if(binding.installationId!==sentinelInstallationIdOf(canonical)||loaded.value.outputRoot!==output)return false;
  // Native security verification is required on Windows as well. A failed
  // private-directory check leaves the installation UNKNOWN, never chmod proof.
  if(!native().sentinelIoCreateRoot(path))return false;
  const dir=new ReceiptDirectory(path);
  try{
   const key=randomBytes(32),value:Enrollment={v:1,installationId:sentinelInstallationIdOf(canonical),keyId:digest(key),epoch:nonce()};
   for(const name of ["writer.lock","snapshot.lock"]){const h=dir.open(name,2);dir.release(h);}
   dir.replace("key",key);
   dir.replace("receipt.json",encodeReceipt({v:1,...binding,keyId:value.keyId,epoch:value.epoch,serverNonce:"0".repeat(32),runId:nonce(),sequence:0,lossSerial:0,phase:"fault",issuedAtMs:0,totalBytes:0,known:false},key));
   dir.replace("enrollment.json",Buffer.from(JSON.stringify(value)));
   return true;
  }finally{dir.close();}
 }catch{return false;}
}
function identity(descriptor:SentinelDescriptor){
 const entryDigest=digest(readFileSync(descriptor.executable.entry));
 if(descriptor.executable.sha256!==entryDigest)throw Error("RECEIPT_ENTRY_DIGEST");
 const path=join(descriptor.outputRoot,DESCRIPTOR_FILE),owned=checkOwnedFile(path);
 if(!owned.ok||!owned.value)throw Error("RECEIPT_DESCRIPTOR_IDENTITY");
 const raw=readSmallVerified(path,owned.value,DESCRIPTOR_MAX_BYTES);
 if(!raw.ok)throw Error("RECEIPT_DESCRIPTOR_IDENTITY");
 return {installationId:descriptor.installationId,descriptorDigest:digest(raw.value),entryDigest,scheduleRevision:descriptor.scheduleRevision};
}
function matches(r:FileReceipt,value:Enrollment,binding:ReturnType<typeof identity>):boolean {
 return r.installationId===value.installationId&&r.installationId===binding.installationId&&r.descriptorDigest===binding.descriptorDigest&&r.entryDigest===binding.entryDigest
  &&r.scheduleRevision===binding.scheduleRevision&&r.keyId===value.keyId&&r.epoch===value.epoch;
}
function request(dir:ReceiptDirectory,value:Enrollment,key:Buffer):Request {
 const r=document<Request>(dir.read("request.json",REQUEST_BYTES),requestKeys,REQUEST_BYTES);
 if(r.v!==1||r.installationId!==value.installationId||!hex(r.serverNonce,32)||!authentic(r,requestKeys,key,"request"))throw Error("RECEIPT_REQUEST");
 return r;
}
export interface Counter {bytes:number;known:boolean}
/** Outer runs serialize admission and retain writer.lock through all children
 * and failure/publication writes. A watcher calls begin/finish on EACH cycle. */
export class SentinelFileWriter {
 private dir:ReceiptDirectory;private writer:object;private snapshot:object|null;
 private value:Enrollment;private key:Buffer;private r:FileReceipt;
 private start:Counter;private sealed=false;
 private constructor(dir:ReceiptDirectory,writer:object,snapshot:object,value:Enrollment,key:Buffer,r:FileReceipt,start:Counter){
  this.dir=dir;this.writer=writer;this.snapshot=snapshot;this.value=value;this.key=key;this.r=r;this.start=start;
 }
 static begin(descriptor:SentinelDescriptor,read:()=>Counter,now=Date.now):SentinelFileWriter|null {
  let dir:ReceiptDirectory|undefined,writer:object|null=null,snapshot:object|null=null;
  try{
   dir=new ReceiptDirectory(join(descriptor.installationRoot,"sentinel-io"));
   const {value,key}=enrollment(dir),binding=identity(descriptor);
   if(binding.installationId!==value.installationId)throw Error("RECEIPT_INSTALLATION");
   writer=dir.lock("writer.lock",true);if(!writer)throw Error("RECEIPT_BUSY");
   snapshot=dir.lock("snapshot.lock",true);if(!snapshot)throw Error("RECEIPT_BUSY");
   const start=read();
   // Provisioning writes the initial authenticated FAULT before enrollment.
   // Missing or corrupted checkpoints can therefore never reset the carry.
   const prior=decodeReceipt(dir.read("receipt.json",RECEIPT_BYTES),key);
   if(prior.installationId!==value.installationId||prior.keyId!==value.keyId||prior.epoch!==value.epoch)throw Error("RECEIPT_BINDING");
   const initial=prior.sequence===0&&prior.totalBytes===0&&prior.lossSerial===0&&prior.phase==="fault";
   const lost=(!initial&&prior.phase!=="sealed")||!matches(prior,value,binding);
   if(lost){
    value.epoch=nonce();
    dir.replace("enrollment.json",Buffer.from(JSON.stringify(value)));
   }
   let serverNonce="0".repeat(32);try{serverNonce=request(dir,value,key).serverNonce;}catch{/* no server yet: cannot qualify */}
   const r:FileReceipt={v:1,...binding,keyId:value.keyId,epoch:value.epoch,serverNonce,runId:nonce(),sequence:(prior?.sequence??0)+1,
    lossSerial:(prior?.lossSerial??0)+(lost?1:0),phase:"active",issuedAtMs:now(),totalBytes:prior?.totalBytes??0,known:false,mac:""};
   dir.replace("receipt.json",encodeReceipt(r,key));
   dir.release(snapshot);snapshot=dir.lock("snapshot.lock",false);if(!snapshot)throw Error("RECEIPT_LEASE");
   return new SentinelFileWriter(dir,writer,snapshot,value,key,r,start);
  }catch{if(snapshot)dir?.release(snapshot);if(writer)dir?.release(writer);dir?.close();return null;}
 }
 /** Descendants acquire their own kernel lease before any scan or store write.
  * If the outer dies, their lease continues to exclude the server snapshot. */
 static descendant(descriptor:SentinelDescriptor):{close():void}|null {
  let dir:ReceiptDirectory|undefined,lease:object|null=null;
  try{
   dir=new ReceiptDirectory(join(descriptor.installationRoot,"sentinel-io"));
   const {value,key}=enrollment(dir),binding=identity(descriptor);
   lease=dir.lock("snapshot.lock",false);if(!lease)throw Error("RECEIPT_BUSY");
   const r=decodeReceipt(dir.read("receipt.json",RECEIPT_BYTES),key);
   if(r.phase!=="active"||!matches(r,value,binding))throw Error("RECEIPT_NOT_ACTIVE");
   const held=dir,h=lease;let closed=false;
   return {close(){if(!closed){closed=true;held.release(h);held.close();}}};
  }catch{if(lease)dir?.release(lease);dir?.close();return null;}
 }
 finish(read:()=>Counter,childrenSealed:boolean,now=Date.now):boolean {
  if(this.sealed)return false;
  this.sealed=true;
  try{
   // No seal may precede writable descendants. A live orphan leaves ACTIVE.
   if(this.snapshot){this.dir.release(this.snapshot);this.snapshot=null;}
   this.snapshot=this.dir.lock("snapshot.lock",true);if(!this.snapshot)return false;
   const after=read(),delta=after.bytes-this.start.bytes;
   if(!uint(delta))throw Error("RECEIPT_COUNTER");
   const totalBytes=this.r.totalBytes+delta+RECEIPT_BYTES;
   if(!uint(totalBytes))throw Error("RECEIPT_OVERFLOW");
   let serverNonce=this.r.serverNonce,requestKnown=false;try{serverNonce=request(this.dir,this.value,this.key).serverNonce;requestKnown=true;}catch{/* a damaged request cannot renew an older nonce */}
   const known=after.known&&this.start.known&&childrenSealed&&requestKnown;
   this.r={...this.r,serverNonce,sequence:this.r.sequence+1,phase:known?"sealed":"fault",issuedAtMs:now(),totalBytes,known};
   // Dedicated native writer accounts this fixed final write; its reserved
   // length is included before the authenticated final is published.
   this.dir.replace("receipt.json",encodeReceipt(this.r,this.key));
   const sealed=read();
   if(!sealed.known||sealed.bytes!==after.bytes+RECEIPT_BYTES){
    this.r={...this.r,phase:"fault",known:false,sequence:this.r.sequence+1,totalBytes:Math.max(totalBytes,totalBytes+Math.max(0,sealed.bytes-after.bytes-RECEIPT_BYTES)+RECEIPT_BYTES)};
    this.dir.replace("receipt.json",encodeReceipt(this.r,this.key));return false;
   }
   return known;
  }catch{
   // A failed flush/replacement can have made SEALED visible already. While
   // still holding exclusion, invalidate it before allowing a snapshot.
   if(this.snapshot)try{
    this.r={...this.r,phase:"fault",known:false,sequence:this.r.sequence+1,totalBytes:this.r.totalBytes+RECEIPT_BYTES};
    this.dir.replace("receipt.json",encodeReceipt(this.r,this.key));
   }catch{
    // Even a failed durable FAULT must not leave an apparently valid final.
    try{const h=this.dir.open("receipt.json",1);try{this.dir.api.sentinelIoWrite(h,Buffer.alloc(0));}finally{this.dir.release(h);}}catch{/* a subsequent read/security failure stays UNKNOWN */}
   }
   return false;
  }
  finally{this.close();}
 }
 close(){if(this.snapshot){this.dir.release(this.snapshot);this.snapshot=null;}this.dir.release(this.writer);this.dir.close();}
}

export interface SentinelFileSnapshot {readonly at:number;readonly known:boolean;readonly bytes:number;readonly epoch:string|null;readonly lossSerial:number|null;readonly baseline:boolean;readonly continuity:number}
/** Constant receiver state. No archives, directory enumeration, history lookup,
 * mtimes, PID inspection, synchronous waits or per-turn control writes. */
export class SentinelFileReceiver {
 private continuity=0;private wasAbsent=false;
 private serverNonce=nonce();private challenged:string|null=null;private lost=false;
 private accepted:FileReceipt|null=null;private floor:FileReceipt|null=null;private bytes=0;private lastWall:number|null=null;private lastMono:number|null=null;
 readonly dataDir:string;readonly now:()=>number;readonly mono:()=>number;
 constructor(dataDir:string,now=Date.now,mono=()=>{try{return native().sentinelIoAwakeMs();}catch{return NaN;}}){this.dataDir=dataDir;this.now=now;this.mono=mono;}
 private challenge(dir:ReceiptDirectory,value:Enrollment,key:Buffer){
  const signature=`${value.keyId}/${value.epoch}/${this.serverNonce}`;
  if(this.challenged===signature)return;
  dir.replace("request.json",Buffer.from(JSON.stringify(signed({v:1,installationId:value.installationId,serverNonce:this.serverNonce},requestKeys,key,"request"))));
  this.challenged=signature;
 }
 sample<T>(capture:()=>T):{snapshot:SentinelFileSnapshot;process:T} {
  let dir:ReceiptDirectory|undefined,lease:object|null=null,processSample:T|undefined,captured=false;
  let wall=this.now(),monotonic=this.mono(),known=false,baseline=false;
  try{
   if(!uint(wall)||!Number.isFinite(monotonic)||monotonic<0)throw Error("RECEIPT_CLOCK");
   const canonical=realpathSync.native(this.dataDir),installationId=sentinelInstallationIdOf(canonical);
   dir=new ReceiptDirectory(join(canonical,"sentinel-io"));
   const {value,key}=enrollment(dir);
   if(value.installationId!==installationId)throw Error("RECEIPT_INSTALLATION");
   // A security/epoch boundary always gets a new unpredictable request. Old
   // authentic receipts from the previous server cannot establish a baseline.
   if(this.accepted&&this.accepted.epoch!==value.epoch){this.continuity++;this.accepted=null;this.lost=false;this.serverNonce=nonce();}
   const output=coverageOutputRoot(installationId);
   if(!output)throw Error("RECEIPT_OUTPUT");
   if(receiptPathPresent(join(dir.path,"absence.json"))&&!receiptPathPresent(join(dir.path,"receipt.json"))){
    lease=dir.lock("snapshot.lock",true);if(!lease)throw Error("RECEIPT_BUSY");
    const proof=absenceProof(dir,value,key,output);
    if(proof.phase!=="absent"||sentinelPresenceObserved()||!virginOutput(output)){
     retireAbsence(dir,value,key,output);throw Error("RECEIPT_ABSENCE_RETIRED");
    }
    dir.assertCurrent();wall=this.now();monotonic=this.mono();processSample=capture();captured=true;
    baseline=!this.wasAbsent;this.wasAbsent=true;
    return {snapshot:Object.freeze({at:wall,known:true,bytes:this.bytes,epoch:value.epoch,lossSerial:0,baseline,continuity:this.continuity}),process:processSample!};
   }
   if(this.wasAbsent){this.continuity++;this.wasAbsent=false;}
   this.challenge(dir,value,key);
   lease=dir.lock("snapshot.lock",true);if(!lease)throw Error("RECEIPT_BUSY");
   const loaded=output?loadDescriptor(join(output,DESCRIPTOR_FILE),{create:false,requireInstallationRoot:false}):null;
   if(!loaded?.ok||loaded.value.installationId!==installationId||loaded.value.outputRoot!==output)throw Error("RECEIPT_DESCRIPTOR");
   const currentRequest=request(dir,value,key);
   if(currentRequest.serverNonce!==this.serverNonce)throw Error("RECEIPT_REQUEST_REPLACED");
   const r=decodeReceipt(dir.read("receipt.json",RECEIPT_BYTES),key),binding=identity(loaded.value);
   // Timestamp the actual acquired sample, not the earlier acquisition attempt.
   wall=this.now();monotonic=this.mono();
   if(!uint(wall)||!Number.isFinite(monotonic)||monotonic<0)throw Error("RECEIPT_CLOCK");
   if(this.lastWall!==null&&this.lastMono!==null&&(wall<this.lastWall||monotonic<this.lastMono||Math.abs((wall-this.lastWall)-(monotonic-this.lastMono))>5000)){
    this.continuity++;this.accepted=null;this.serverNonce=nonce();this.lost=false;this.challenged=null;
    this.challenge(dir,value,key);
   }
   processSample=capture();captured=true;
   if(!matches(r,value,binding)||r.serverNonce!==this.serverNonce||!r.known||r.phase!=="sealed"
    ||r.issuedAtMs>wall||wall-r.issuedAtMs>RECEIPT_MAX_AGE_MS)throw Error("RECEIPT_ENDPOINT");
   // A new authentic publication echoing the fresh challenge establishes a
   // new endpoint; no prior interval is retroactively repaired.
   if(this.lost){baseline=true;this.lost=false;}
   const previous=this.accepted;
   if(previous&&(r.sequence<previous.sequence||r.totalBytes<previous.totalBytes
    ||(r.sequence===previous.sequence&&JSON.stringify(r)!==JSON.stringify(previous))))throw Error("RECEIPT_ROLLBACK");
   baseline=baseline||!previous||previous.epoch!==r.epoch||previous.lossSerial!==r.lossSerial;
   const floor=this.floor;
   if(floor&&floor.epoch===r.epoch&&floor.lossSerial===r.lossSerial){
    if(r.sequence<floor.sequence||r.totalBytes<floor.totalBytes||(r.sequence===floor.sequence&&JSON.stringify(r)!==JSON.stringify(floor)))throw Error("RECEIPT_ROLLBACK");
    const total=this.bytes+r.totalBytes-floor.totalBytes;if(!uint(total))throw Error("RECEIPT_OVERFLOW");this.bytes=total;
   }
   dir.assertCurrent();
   this.accepted=r;this.floor=r;known=true;
  }catch{
   // Preserve accepted byte floors. A failed endpoint invalidates the crossing
   // interval; authenticated fresh epoch/nonce handshake is required to recover.
   if(this.accepted){
    this.continuity++;this.lost=true;this.accepted=null;this.serverNonce=nonce();this.challenged=null;
    // Publish the challenge at the discontinuity, before a following run.
    if(dir)try{const {value,key}=enrollment(dir);this.challenge(dir,value,key);}catch{/* security failure stays UNKNOWN */}
   }
  }finally{
   if(!captured)processSample=capture();
   if(lease)dir?.release(lease);dir?.close();
   this.lastWall=wall;this.lastMono=monotonic;
  }
  return {snapshot:Object.freeze({at:wall,known,bytes:this.bytes,epoch:this.accepted?.epoch??null,lossSerial:this.accepted?.lossSerial??null,baseline,continuity:this.continuity}),process:processSample!};
 }
}
