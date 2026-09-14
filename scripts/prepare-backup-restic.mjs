import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {constants,chmodSync,copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {RESTIC_ARCHIVE_SHA256,RESTIC_ARCHIVE_URL,RESTIC_ORIGINAL_SHA256} from "../shared/backup-restic-pin.mjs";
const repository=fileURLToPath(new URL("../",import.meta.url));
const licenseHash="da4cf58a2e9300d114c67b463096312368e689b9a07f0278042851b92efc6d40";
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
function read(file){const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>64*1024**2)throw Error("RESTIC_STAGE_UNSAFE_FILE");return readFileSync(file);}
/** Build-only download/decompression; never invokes restic or connects a repo. */
export async function stageBackupRestic({root=repository,target,archive}={}){
 if(target!==undefined&&target!=="darwin-arm64")throw Error("RESTIC_STAGE_UNSUPPORTED_TARGET");
 const license=join(root,"third_party","restic","LICENSE");if(digest(read(license))!==licenseHash)throw Error("RESTIC_STAGE_LICENSE_MISMATCH");
 const staging=join(root,"dist-native","backup-restic");mkdirSync(staging,{recursive:true});const destinationLicense=join(staging,"LICENSE");
 if(existsSync(destinationLicense)){if(digest(read(destinationLicense))!==licenseHash)throw Error("RESTIC_STAGE_LICENSE_MISMATCH");}else copyFileSync(license,destinationLicense,constants.COPYFILE_EXCL);
 if(target===undefined)return;
 const directory=join(staging,"arm64"),destination=join(directory,"restic");
 if(existsSync(destination)){if(digest(read(destination))!==RESTIC_ORIGINAL_SHA256)throw Error("RESTIC_STAGE_PAYLOAD_MISMATCH");chmodSync(destination,0o755);return destination;}
 let compressed;
 if(archive)compressed=read(archive);
 else{
  const response=await fetch(RESTIC_ARCHIVE_URL,{signal:AbortSignal.timeout(60000)});if(!response.ok||!response.body)throw Error("RESTIC_STAGE_DOWNLOAD_FAILED");
  const chunks=[];let size=0;for await(const part of response.body){size+=part.length;if(size>16*1024**2)throw Error("RESTIC_STAGE_DOWNLOAD_LIMIT");chunks.push(Buffer.from(part));}compressed=Buffer.concat(chunks);
 }
 if(digest(compressed)!==RESTIC_ARCHIVE_SHA256)throw Error("RESTIC_STAGE_ARCHIVE_MISMATCH");
 const bytes=execFileSync("/usr/bin/bzip2",["-dc"],{input:compressed,stdio:["pipe","pipe","pipe"],timeout:30000,maxBuffer:64*1024**2});
 if(digest(bytes)!==RESTIC_ORIGINAL_SHA256)throw Error("RESTIC_STAGE_PAYLOAD_MISMATCH");
 mkdirSync(directory,{recursive:true});writeFileSync(destination,bytes,{flag:"wx",mode:0o755,flush:true});return destination;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),explicit=args[0]?.startsWith("--target=");const target=explicit?args.shift().slice(9):process.platform==="darwin"?"darwin-arm64":undefined;
 if(args.length>1)throw Error("RESTIC_STAGE_ARGUMENTS_INVALID");await stageBackupRestic({target,archive:args[0]});
}
