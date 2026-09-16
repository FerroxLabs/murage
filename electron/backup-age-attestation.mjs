import { createHash } from "node:crypto";
import { constants,closeSync,fstatSync,lstatSync,openSync,readFileSync,realpathSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import {open} from "node:fs/promises";
import { backupAgePinForTarget } from "../shared/backup-age-pins.mjs";
export const AGE_ORIGINAL_SHA256="4012dfc2725883beafb710894af4f599b7a94f8c8e0f51f02cc96ab8df33915e";
export const AGE_PAYLOAD_SHA256="2dfd0580ed271820d1efb369fdff2d700df863493d41662da9b1b0780589118b";
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
const safeNumber=value=>value<=BigInt(Number.MAX_SAFE_INTEGER)?Number(value):NaN;

/** Only signature-tail size and the non-executable LINKEDIT size fields vary.
 * Every other byte before the single terminal signature is hashed. */
export function normalizedAgePayloadHash(bytes){
  try{
    if(bytes.length<32||bytes.length>64*1024**2||bytes.readUInt32LE(0)!==0xfeedfacf||bytes.readUInt32LE(4)!==0x0100000c||bytes.readUInt32LE(12)!==2)return null;
    const count=bytes.readUInt32LE(16),end=32+bytes.readUInt32LE(20);
    if(!count||count>256||end>bytes.length||end>1024*1024)return null;
    let cursor=32,signature=null,linkedit=null;const segments=[];
    for(let i=0;i<count;i++){
      if(cursor+8>end)return null;
      const command=bytes.readUInt32LE(cursor),size=bytes.readUInt32LE(cursor+4);
      if(size<8||size%8||cursor+size>end)return null;
      if(command===0x1d){
        if(signature||size!==16)return null;
        signature={command:cursor,offset:bytes.readUInt32LE(cursor+8),size:bytes.readUInt32LE(cursor+12)};
      }
      if(command===0x19){
        if(size<72)return null;
        const sections=bytes.readUInt32LE(cursor+64);if(size!==72+sections*80)return null;
        const offset=safeNumber(bytes.readBigUInt64LE(cursor+40)),length=safeNumber(bytes.readBigUInt64LE(cursor+48));
        if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset+length>bytes.length)return null;
        if(length)segments.push({offset,end:offset+length});
        if(bytes.toString("ascii",cursor+8,cursor+24)==="__LINKEDIT\0\0\0\0\0\0"){
          if(linkedit||sections!==0||bytes.readUInt32LE(cursor+56)!==1||bytes.readUInt32LE(cursor+60)!==1)return null;
          linkedit={command:cursor,offset:safeNumber(bytes.readBigUInt64LE(cursor+40)),size:safeNumber(bytes.readBigUInt64LE(cursor+48)),virtualSize:safeNumber(bytes.readBigUInt64LE(cursor+32))};
        }
      }
      cursor+=size;
    }
    if(cursor!==end||!signature||!linkedit||signature.offset<end||signature.size<12||signature.size>2*1024**2||signature.offset+signature.size!==bytes.length||!Number.isSafeInteger(linkedit.offset)||!Number.isSafeInteger(linkedit.size)||linkedit.offset+linkedit.size!==bytes.length||linkedit.offset>signature.offset)return null;
    segments.sort((a,b)=>a.offset-b.offset);for(let i=1;i<segments.length;i++)if(segments[i].offset<segments[i-1].end)return null;
    const payloadSize=signature.offset-linkedit.offset;
    if(!Number.isSafeInteger(linkedit.virtualSize)||linkedit.virtualSize<payloadSize||linkedit.virtualSize>linkedit.size+16384)return null;
    const tail=bytes.subarray(signature.offset);
    if(tail.readUInt32BE(0)!==0xfade0cc0)return null;
    const blobLength=tail.readUInt32BE(4),blobs=tail.readUInt32BE(8),header=12+blobs*8;
    // Apple's signer reserves tail capacity and can leave old signature bytes
    // there. It is inside this terminal LC_CODE_SIGNATURE region, not payload.
    if(!blobs||blobs>64||header>blobLength||blobLength>tail.length||tail.length-blobLength>65536)return null;
    const ranges=[{start:0,end:header}],slots=new Set();
    for(let i=0;i<blobs;i++){
      const slot=tail.readUInt32BE(12+i*8),offset=tail.readUInt32BE(16+i*8);
      if(slots.has(slot)||offset<header||offset+8>blobLength)return null;slots.add(slot);
      const length=tail.readUInt32BE(offset+4);if(length<8||offset+length>blobLength)return null;
      ranges.push({start:offset,end:offset+length});
    }
    ranges.sort((a,b)=>a.start-b.start);
    for(let i=1;i<ranges.length;i++)if(ranges[i].start<ranges[i-1].end||tail.subarray(ranges[i-1].end,ranges[i].start).some(byte=>byte!==0))return null;
    if(tail.subarray(ranges.at(-1).end,blobLength).some(byte=>byte!==0))return null;
    const payload=Buffer.from(bytes.subarray(0,signature.offset));
    payload.writeUInt32LE(0,signature.command+12);
    payload.writeBigUInt64LE(BigInt(payloadSize),linkedit.command+32);
    payload.writeBigUInt64LE(BigInt(payloadSize),linkedit.command+48);
    return digest(payload);
  }catch{return null;}
}

const nativeCodesign=args=>spawnSync("/usr/bin/codesign",args,{stdio:["ignore","pipe","pipe"],encoding:"utf8",timeout:10000,maxBuffer:65536});
/** Injectable command runner is a test seam; production always uses codesign. */
export function signedAgeOwnedByCurrentApp(file,bytes,{currentExecutable=process.execPath,run=nativeCodesign}={}){
  if(normalizedAgePayloadHash(bytes)!==AGE_PAYLOAD_SHA256)return false;
  try{
    const resolved=realpathSync(file),resources=path.dirname(path.dirname(path.dirname(resolved))),contents=path.dirname(resources),app=path.dirname(contents);
    const executable=realpathSync(currentExecutable);
    if(path.basename(resources)!=="Resources"||path.basename(contents)!=="Contents"||!app.endsWith(".app")||resolved!==path.join(resources,"backup-tools","arm64","age")||!executable.startsWith(app+path.sep))return false;
    const verified=run(["--verify","--strict","-R","=anchor apple generic",app]);if(verified.status!==0||verified.error)return false;
    const info=run(["--display","--verbose=4",app]);if(info.status!==0||info.error)return false;
    const team=/^TeamIdentifier=([A-Z0-9]{10})$/m.exec(String(info.stderr))?.[1];if(!team)return false;
    const toolInfo=run(["--display","--verbose=4",resolved]);if(toolInfo.status!==0||toolInfo.error||/^TeamIdentifier=([A-Z0-9]{10})$/m.exec(String(toolInfo.stderr))?.[1]!==team)return false;
    const toolVerified=run(["--verify","--strict","-R",`=anchor apple generic and certificate leaf[subject.OU] = "${team}"`,resolved]);
    return toolVerified.status===0&&!toolVerified.error;
  }catch{return false;}
}
export function trustedBackupAgeExecutable(file){
  try{
    const pin=backupAgePinForTarget(process.platform,process.arch);if(!pin)return false;
    const before=lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>64*1024**2)return false;
    const fd=openSync(file,constants.O_RDONLY|(process.platform==="win32"?0:constants.O_NOFOLLOW));let bytes;
    try{const opened=fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino)return false;bytes=readFileSync(fd);}finally{closeSync(fd);}
    if(digest(bytes)===pin.executableSha256)return true;
    return process.platform==="darwin"&&process.arch==="arm64"&&signedAgeOwnedByCurrentApp(file,bytes);
  }catch{return false;}
}

/** Cheap identity only: no payload reads and no subprocesses on status paths. */
export function backupToolIdentity(file,currentExecutable=process.execPath){
  try{
    const resolved=realpathSync(file),executable=realpathSync(currentExecutable);
    if(resolved!==path.resolve(file))return null;
    const paths=[file,currentExecutable],resources=path.dirname(path.dirname(path.dirname(resolved))),contents=path.dirname(resources),app=path.dirname(contents);
    if(path.basename(resources)==="Resources"&&path.basename(contents)==="Contents"&&app.endsWith(".app"))paths.push(resources,contents,app);
    const entries=paths.map(name=>{const stat=lstatSync(name,{bigint:true});if(stat.isSymbolicLink())throw Error();return {path:realpathSync(name),identity:["dev","ino","mode","size","nlink","mtimeNs","ctimeNs"].map(key=>String(stat[key]))};});
    return JSON.stringify({resolved,executable,entries});
  }catch{return null;}
}
/** Bounded shared runner; cancellation never settles ahead of observed child close. */
export function asyncBackupCodesign(args,{signal,spawnCommand=spawn}={}){
  return new Promise(resolve=>{
    if(signal?.aborted){resolve({status:null,error:Error("Attestation aborted")});return;}
    let child;try{child=spawnCommand("/usr/bin/codesign",args,{stdio:["ignore","pipe","pipe"]});}catch(error){resolve({status:null,error});return;}
    let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),error;
    const stop=reason=>{error??=reason;child.kill("SIGKILL");};
    const abort=()=>stop(Error("Attestation aborted"));
    const timer=setTimeout(()=>stop(Error("Attestation timeout")),10000);
    signal?.addEventListener("abort",abort,{once:true});
    if(signal?.aborted)abort();
    child.stdout.on("data",chunk=>{if(stdout.length+chunk.length>65536)stop(Error("Attestation output limit"));else stdout=Buffer.concat([stdout,chunk]);});
    child.stderr.on("data",chunk=>{if(stderr.length+chunk.length>65536)stop(Error("Attestation output limit"));else stderr=Buffer.concat([stderr,chunk]);});
    child.once("error",failure=>{error??=failure;});
    child.once("close",status=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);resolve({status,error,stdout:stdout.toString("utf8"),stderr:stderr.toString("utf8")});});
  });
}
export async function readBackupToolBytes(file,{strictMode=false}={}){
  let handle;
  try{
    const before=lstatSync(file,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n||before.size>64n*1024n*1024n||(strictMode&&(before.mode&0o022n)))return null;
    const same=stat=>["dev","ino","mode","size","nlink","mtimeNs","ctimeNs"].every(key=>stat[key]===before[key]);
    handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    if(!same(await handle.stat({bigint:true})))return null;
    const bytes=await handle.readFile();
    return same(await handle.stat({bigint:true}))&&same(lstatSync(file,{bigint:true}))?bytes:null;
  }catch{return null;}finally{await handle?.close();}
}
export async function signedAgeOwnedByCurrentAppAsync(file,bytes,{currentExecutable=process.execPath,run=asyncBackupCodesign,signal}={}){
  if(normalizedAgePayloadHash(bytes)!==AGE_PAYLOAD_SHA256)return false;
  try{
    const identity=backupToolIdentity(file,currentExecutable),unchanged=()=>identity!==null&&!signal?.aborted&&backupToolIdentity(file,currentExecutable)===identity;
    if(!unchanged())return false;
    const resolved=realpathSync(file),resources=path.dirname(path.dirname(path.dirname(resolved))),contents=path.dirname(resources),app=path.dirname(contents),executable=realpathSync(currentExecutable);
    if(path.basename(resources)!=="Resources"||path.basename(contents)!=="Contents"||!app.endsWith(".app")||resolved!==path.join(resources,"backup-tools","arm64","age")||!executable.startsWith(app+path.sep))return false;
    const checked=async args=>{if(!unchanged())throw Error();const result=await run(args,{signal});if(!unchanged()||result.status!==0||result.error)throw Error();return result;};
    await checked(["--verify","--strict","-R","=anchor apple generic",app]);
    const info=await checked(["--display","--verbose=4",app]),team=/^TeamIdentifier=([A-Z0-9]{10})$/m.exec(String(info.stderr))?.[1];if(!team)return false;
    const toolInfo=await checked(["--display","--verbose=4",resolved]);if(/^TeamIdentifier=([A-Z0-9]{10})$/m.exec(String(toolInfo.stderr))?.[1]!==team)return false;
    await checked(["--verify","--strict","-R",`=anchor apple generic and certificate leaf[subject.OU] = "${team}"`,resolved]);return unchanged();
  }catch{return false;}
}
export async function trustedBackupAgeExecutableAsync(file,{currentExecutable=process.execPath,run=asyncBackupCodesign,signal}={}){
  if(process.platform!=="darwin")return trustedBackupAgeExecutable(file);
  try{
    const pin=backupAgePinForTarget(process.platform,process.arch),identity=backupToolIdentity(file,currentExecutable);if(!pin||!identity||signal?.aborted)return false;
    const bytes=await readBackupToolBytes(file);if(!bytes||signal?.aborted||backupToolIdentity(file,currentExecutable)!==identity)return false;
    const trusted=digest(bytes)===pin.executableSha256||process.arch==="arm64"&&await signedAgeOwnedByCurrentAppAsync(file,bytes,{currentExecutable,run,signal});
    return Boolean(trusted&&!signal?.aborted&&backupToolIdentity(file,currentExecutable)===identity);
  }catch{return false;}
}
