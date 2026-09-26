import {createHash} from "node:crypto";
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,realpathSync} from "node:fs";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {normalizedAgePayloadHash,backupToolIdentity,asyncBackupCodesign,readBackupToolBytes} from "./backup-age-attestation.mjs";
import {resticPinForTarget} from "../shared/backup-restic-pin.mjs";
const runCodesign=args=>spawnSync("/usr/bin/codesign",args,{stdio:["ignore","pipe","pipe"],encoding:"utf8",timeout:10000,maxBuffer:65536});
const windows=()=>process.platform==="win32";
/** The pin for the platform and arch this app is running on, or null. */
const currentPin=()=>resticPinForTarget(process.platform,process.arch);
/** The packaged location a restic for this arch must resolve to on macOS. */
function macBundle(file,currentExecutable,arch){
 const resolved=realpathSync(file),resources=path.dirname(path.dirname(path.dirname(resolved))),contents=path.dirname(resources),app=path.dirname(contents),executable=realpathSync(currentExecutable);
 if(path.basename(resources)!=="Resources"||path.basename(contents)!=="Contents"||!app.endsWith(".app")||resolved!==path.join(resources,"backup-tools",arch,"restic")||!executable.startsWith(app+path.sep))return null;
 return{resolved,app};
}
/** macOS release builds re-sign restic, so its bytes change: accept the pinned
 * payload only when the tool and the running app share one Developer ID team. */
export function signedResticOwnedByCurrentApp(file,bytes,{currentExecutable=process.execPath,run=runCodesign,arch=process.arch}={}){
 const pin=resticPinForTarget("darwin",arch);if(!pin?.payloadSha256||normalizedAgePayloadHash(bytes)!==pin.payloadSha256)return false;
 try{
  const bundle=macBundle(file,currentExecutable,arch);if(!bundle)return false;
  const valid=run(["--verify","--strict","-R","=anchor apple generic",bundle.app]);if(valid.status!==0||valid.error)return false;
  const info=run(["--display","--verbose=4",bundle.app]);if(info.status!==0||info.error)return false;const team=/^TeamIdentifier=([A-Z0-9]{10})$/m.exec(String(info.stderr))?.[1];if(!team)return false;
  const tool=run(["--display","--verbose=4",bundle.resolved]);if(tool.status!==0||tool.error||/^TeamIdentifier=([A-Z0-9]{10})$/m.exec(String(tool.stderr))?.[1]!==team)return false;
  const check=run(["--verify","--strict","-R",`=anchor apple generic and certificate leaf[subject.OU] = "${team}"`,bundle.resolved]);return check.status===0&&!check.error;
 }catch{return false;}
}
/** Exact pinned upstream bytes on every platform; on macOS also the signed
 * payload. Windows has no POSIX mode bits, so only the mode check is skipped. */
export function trustedBackupResticExecutable(file){
 const pin=currentPin();if(!pin)return false;
 let fd;
 try{
  const before=lstatSync(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n||before.size>64n*1024n*1024n||(!windows()&&(before.mode&0o022n)))return false;
  const same=stat=>["dev","ino","mode","size","nlink","mtimeNs","ctimeNs"].every(key=>stat[key]===before[key]);
  fd=openSync(file,constants.O_RDONLY|(windows()?0:constants.O_NOFOLLOW));if(!same(fstatSync(fd,{bigint:true})))return false;const bytes=Buffer.alloc(Number(before.size));let offset=0;
  while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)return false;offset+=count;}
  if(!same(fstatSync(fd,{bigint:true}))||!same(lstatSync(file,{bigint:true})))return false;
  if(createHash("sha256").update(bytes).digest("hex")===pin.originalSha256)return true;
  return process.platform==="darwin"&&signedResticOwnedByCurrentApp(file,bytes);
 }catch{return false;}finally{if(fd!==undefined)closeSync(fd);}
}

export async function signedResticOwnedByCurrentAppAsync(file,bytes,{currentExecutable=process.execPath,run=asyncBackupCodesign,signal,arch=process.arch,timeoutMs}={}){
  const pin=resticPinForTarget("darwin",arch);if(!pin?.payloadSha256||normalizedAgePayloadHash(bytes)!==pin.payloadSha256)return false;
  try{
    const identity=backupToolIdentity(file,currentExecutable),unchanged=()=>identity!==null&&!signal?.aborted&&backupToolIdentity(file,currentExecutable)===identity;
    if(!unchanged())return false;
    const bundle=macBundle(file,currentExecutable,arch);if(!bundle)return false;
    const checked=async args=>{if(!unchanged())throw Error();const result=await run(args,{signal,...(timeoutMs?{timeoutMs}:{})});if(!unchanged()||result.status!==0||result.error)throw Error();return result;};
    await checked(["--verify","--strict","-R","=anchor apple generic",bundle.app]);
    const info=await checked(["--display","--verbose=4",bundle.app]),team=/^TeamIdentifier=([A-Z0-9]{10})$/m.exec(String(info.stderr))?.[1];if(!team)return false;
    const toolInfo=await checked(["--display","--verbose=4",bundle.resolved]);if(/^TeamIdentifier=([A-Z0-9]{10})$/m.exec(String(toolInfo.stderr))?.[1]!==team)return false;
    await checked(["--verify","--strict","-R",`=anchor apple generic and certificate leaf[subject.OU] = "${team}"`,bundle.resolved]);return unchanged();
  }catch{return false;}
}
export async function trustedBackupResticExecutableAsync(file,{currentExecutable=process.execPath,run=asyncBackupCodesign,signal,timeoutMs}={}){
 const pin=currentPin();if(!pin)return false;
 try{
  const identity=backupToolIdentity(file,currentExecutable);if(!identity||signal?.aborted)return false;
  const bytes=await readBackupToolBytes(file,{strictMode:!windows()});if(!bytes||signal?.aborted||backupToolIdentity(file,currentExecutable)!==identity)return false;
  const trusted=createHash("sha256").update(bytes).digest("hex")===pin.originalSha256||process.platform==="darwin"&&await signedResticOwnedByCurrentAppAsync(file,bytes,{currentExecutable,run,signal,timeoutMs});
  return Boolean(trusted&&!signal?.aborted&&backupToolIdentity(file,currentExecutable)===identity);
 }catch{return false;}
}
/** Where a packaged restic for this platform lives, beside age. */
export function packagedResticPath(resourcesPath,platform=process.platform,arch=process.arch){
 const pin=resticPinForTarget(platform,arch);if(!pin)return null;
 return (platform==="win32"?path.win32:path).join(resourcesPath,"backup-tools",arch,pin.executable);
}
