import {createHash} from "node:crypto";
import {constants,openSync,closeSync,fstatSync,lstatSync,readSync,realpathSync} from "node:fs";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {normalizedAgePayloadHash} from "./backup-age-attestation.mjs";
import {RESTIC_ORIGINAL_SHA256,RESTIC_PAYLOAD_SHA256} from "../shared/backup-restic-pin.mjs";
const runCodesign=args=>spawnSync("/usr/bin/codesign",args,{stdio:["ignore","pipe","pipe"],encoding:"utf8",timeout:10000,maxBuffer:65536});
export function signedResticOwnedByCurrentApp(file,bytes,{currentExecutable=process.execPath,run=runCodesign}={}){
 if(normalizedAgePayloadHash(bytes)!==RESTIC_PAYLOAD_SHA256)return false;
 try{
  const resolved=realpathSync(file),resources=path.dirname(path.dirname(path.dirname(resolved))),contents=path.dirname(resources),app=path.dirname(contents),executable=realpathSync(currentExecutable);
  if(path.basename(resources)!=="Resources"||path.basename(contents)!=="Contents"||!app.endsWith(".app")||resolved!==path.join(resources,"backup-tools","arm64","restic")||!executable.startsWith(app+path.sep))return false;
  const valid=run(["--verify","--strict","-R","anchor apple generic",app]);if(valid.status!==0||valid.error)return false;
  const info=run(["--display","--verbose=4",app]);if(info.status!==0||info.error)return false;const team=/^TeamIdentifier=([A-Z0-9]{10})$/m.exec(String(info.stderr))?.[1];if(!team)return false;
  const tool=run(["--display","--verbose=4",resolved]);if(tool.status!==0||tool.error||/^TeamIdentifier=([A-Z0-9]{10})$/m.exec(String(tool.stderr))?.[1]!==team)return false;
  const check=run(["--verify","--strict","-R",`anchor apple generic and certificate leaf[subject.OU] = "${team}"`,resolved]);return check.status===0&&!check.error;
 }catch{return false;}
}
export function trustedBackupResticExecutable(file){
 if(process.platform!=="darwin"||process.arch!=="arm64")return false;
 let fd;
 try{
  const before=lstatSync(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n||before.size>64n*1024n*1024n||(before.mode&0o022n))return false;
  const same=stat=>["dev","ino","size","mode","nlink","mtimeNs","ctimeNs"].every(key=>stat[key]===before[key]);
  fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);if(!same(fstatSync(fd,{bigint:true})))return false;const bytes=Buffer.alloc(Number(before.size));let offset=0;
  while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)return false;offset+=count;}
  if(!same(fstatSync(fd,{bigint:true}))||!same(lstatSync(file,{bigint:true})))return false;
  return createHash("sha256").update(bytes).digest("hex")===RESTIC_ORIGINAL_SHA256||signedResticOwnedByCurrentApp(file,bytes);
 }catch{return false;}finally{if(fd!==undefined)closeSync(fd);}
}
