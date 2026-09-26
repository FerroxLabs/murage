import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {constants,chmodSync,copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import yauzl from "yauzl";
import {RESTIC_LICENSE_SHA256,RESTIC_PINS} from "../shared/backup-restic-pin.mjs";
const repository=fileURLToPath(new URL("../",import.meta.url));
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
function read(file){const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>64*1024**2)throw Error("RESTIC_STAGE_UNSAFE_FILE");return readFileSync(file);}
/** The one pinned member of the Windows zip, bounded, in memory. */
function unzipMember(bytes,member){
 return new Promise((resolveBytes,reject)=>yauzl.fromBuffer(bytes,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true},(error,zip)=>{
  if(error)return reject(Error("RESTIC_STAGE_ARCHIVE_INVALID"));
  let found=null;if(zip.entryCount>16){zip.close();return reject(Error("RESTIC_STAGE_ARCHIVE_INVALID"));}
  zip.on("error",()=>reject(Error("RESTIC_STAGE_ARCHIVE_INVALID")));
  zip.on("end",()=>found?resolveBytes(found):reject(Error("RESTIC_STAGE_ARCHIVE_INCOMPLETE")));
  zip.on("entry",entry=>{
   if(entry.fileName!==member){zip.readEntry();return;}
   if(found||entry.isEncrypted()||entry.uncompressedSize<1||entry.uncompressedSize>64*1024**2){zip.close();return reject(Error("RESTIC_STAGE_ARCHIVE_INVALID"));}
   zip.openReadStream(entry,(streamError,stream)=>{
    if(streamError)return reject(Error("RESTIC_STAGE_ARCHIVE_INVALID"));
    const chunks=[];let size=0;stream.on("data",chunk=>{size+=chunk.length;chunks.push(chunk);});stream.on("error",()=>reject(Error("RESTIC_STAGE_ARCHIVE_INVALID")));
    stream.on("end",()=>{if(size!==entry.uncompressedSize)return reject(Error("RESTIC_STAGE_ARCHIVE_INVALID"));found=Buffer.concat(chunks);zip.readEntry();});
   });
  });
  zip.readEntry();
 }));
}
export function resticStagedPath(root,pin){return pin.platform==="win32"?join(root,"dist-native",pin.stagingDirectory,pin.executable):join(root,"dist-native",pin.stagingDirectory,pin.arch,pin.executable);}
/** Build-only download and decompression; never invokes restic or connects a repo. */
export async function stageBackupRestic({root=repository,target,archive,fetchArchive=url=>fetch(url,{signal:AbortSignal.timeout(60000)})}={}){
 if(target!==undefined&&!Object.hasOwn(RESTIC_PINS,target))throw Error("RESTIC_STAGE_UNSUPPORTED_TARGET");
 const license=join(root,"third_party","restic","LICENSE");if(digest(read(license))!==RESTIC_LICENSE_SHA256)throw Error("RESTIC_STAGE_LICENSE_MISMATCH");
 // Every staging root exists, with its license, so each platform's package
 // config can name its folder; targets that were not staged carry no tool.
 for(const pin of Object.values(RESTIC_PINS)){
  if(pin.platform==="win32")continue;
  const staging=join(root,"dist-native",pin.stagingDirectory);mkdirSync(staging,{recursive:true});const destinationLicense=join(staging,"LICENSE");
  if(existsSync(destinationLicense)){if(digest(read(destinationLicense))!==RESTIC_LICENSE_SHA256)throw Error("RESTIC_STAGE_LICENSE_MISMATCH");}else copyFileSync(license,destinationLicense,constants.COPYFILE_EXCL);
 }
 if(target===undefined)return;
 const pin=RESTIC_PINS[target],destination=resticStagedPath(root,pin);
 if(existsSync(destination)){if(digest(read(destination))!==pin.originalSha256)throw Error("RESTIC_STAGE_PAYLOAD_MISMATCH");if(pin.platform!=="win32")chmodSync(destination,0o755);return destination;}
 let compressed;
 if(archive)compressed=read(archive);
 else{
  const response=await fetchArchive(pin.url);if(!response.ok||!response.body)throw Error("RESTIC_STAGE_DOWNLOAD_FAILED");
  const chunks=[];let size=0;for await(const part of response.body){size+=part.length;if(size>32*1024**2)throw Error("RESTIC_STAGE_DOWNLOAD_LIMIT");chunks.push(Buffer.from(part));}compressed=Buffer.concat(chunks);
 }
 if(digest(compressed)!==pin.archiveSha256)throw Error("RESTIC_STAGE_ARCHIVE_MISMATCH");
 const bytes=pin.format==="zip"?await unzipMember(compressed,pin.member):execFileSync("/usr/bin/bzip2",["-dc"],{input:compressed,stdio:["pipe","pipe","pipe"],timeout:30000,maxBuffer:64*1024**2});
 if(digest(bytes)!==pin.originalSha256)throw Error("RESTIC_STAGE_PAYLOAD_MISMATCH");
 mkdirSync(join(destination,".."),{recursive:true});writeFileSync(destination,bytes,{flag:"wx",mode:0o755,flush:true});return destination;
}
/** The targets a package job on this host stages when none is named. */
export function defaultResticTargets(platform=process.platform,arch=process.arch){
 if(platform==="darwin")return["darwin-arm64","darwin-x64"];
 if(platform==="linux"&&arch==="x64")return["linux-x64"];
 if(platform==="win32"&&arch==="x64")return["win32-x64"];
 return[undefined];
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),explicit=args[0]?.startsWith("--target=");const targets=explicit?[args.shift().slice(9)]:defaultResticTargets();
 if(args.length>1||(args.length&&targets.length>1))throw Error("RESTIC_STAGE_ARGUMENTS_INVALID");
 for(const target of targets)await stageBackupRestic({target,archive:args[0]});
}
