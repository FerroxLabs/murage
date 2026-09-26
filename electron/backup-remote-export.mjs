import {createHash,randomUUID} from "node:crypto";
import {constants,openSync,closeSync,readSync,writeSync,fsyncSync,lstatSync,fstatSync,readFileSync,realpathSync,mkdirSync,mkdtempSync,chmodSync,rmdirSync,renameSync,writeFileSync,linkSync,unlinkSync} from "node:fs";
import path from "node:path";
const fail=()=>{throw Error("BACKUP_REMOTE_EXPORT_UNCONFIRMED");};
const SHARED="BACKUP_REMOTE_DOWNLOAD_FOLDER_SHARED";
/** Whether other accounts could change `folder`, so a backup written into it
 * could be swapped while it is written: not ours, or writable by group or
 * others. Ubuntu makes ~/Documents group-writable (umask 002), which is why a
 * download there failed with only "could not be confirmed" (0.1.60 Linux D8).
 * Windows has no uid or mode bits; the folder the owner picked is theirs. */
export function downloadFolderShared(folder,{platform=process.platform,uid=process.getuid?.(),stat=lstatSync,permissions=holdsPermissions}={}){
 if(platform==="win32")return false;
 try{const s=stat(folder);return !s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||(Boolean(s.mode&0o022)&&permissions(folder));}catch{return false;}
}
/** Whether the drive holding `folder` keeps permission bits at all. exFAT and
 * FAT32 (USB sticks, SD cards) don't: macOS shows every folder on them as
 * writable by everyone and chmod changes nothing, so "other accounts could
 * change it" is a fact of the drive, not a setting the owner can fix (audit
 * W-A3). Checked by making a private folder there and reading its mode back. */
export function holdsPermissions(folder){
 let probe;
 try{probe=mkdtempSync(path.join(folder,".murage-permission-probe-"));chmodSync(probe,0o700);return (lstatSync(probe).mode&0o077)===0;}
 catch{return true;}
 finally{if(probe)try{rmdirSync(probe);}catch{/* An empty probe folder left behind is harmless. */}}
}
/** Errors link() gives on a drive without hard links (exFAT, FAT32). */
const NO_HARD_LINKS=new Set(["EPERM","ENOTSUP","EOPNOTSUPP","ENOSYS","EINVAL","EMLINK","EXDEV","EISDIR","UNKNOWN"]);
/** Only main supplies destination/source roots. Partial copies remain unadvertised. */
export function exportRemoteBackup(copy,parent,{sourceRoot,excludedRoots,maxBytes=1024**3,createId=randomUUID}){
 let input,output,directory,published=false;
 try{
  const receipt=copy?.receipt;if(copy?.state!=="downloaded-verified"||!/^[a-f0-9]{64}$/.test(copy.snapshotId)||!Number.isSafeInteger(receipt?.bytes)||receipt.bytes<1||receipt.bytes>maxBytes||!/^[a-f0-9]{64}$/.test(receipt.sha256))fail();
  const destination=realpathSync.native(parent),parentStat=lstatSync(parent),uid=process.getuid?.();
  // Windows has no uid or mode bits; the folder the owner picked is taken as theirs.
  if(!parentStat.isDirectory()||parentStat.isSymbolicLink())fail();
  if(process.platform!=="win32"&&(parentStat.uid!==uid||((parentStat.mode&0o022)&&holdsPermissions(destination))))throw Error(SHARED);
  for(const root of excludedRoots){const canonical=realpathSync.native(root);if(destination===canonical||destination.startsWith(canonical+path.sep))fail();}
  const source=realpathSync.native(copy.archivePath),receiptPath=realpathSync.native(copy.receiptPath),allowed=realpathSync.native(sourceRoot);
  if(!source.startsWith(allowed+path.sep)||!receiptPath.startsWith(allowed+path.sep)||path.dirname(source)!==path.dirname(receiptPath)||path.basename(source)!=="backup.age"||path.basename(receiptPath)!=="receipt.json")fail();
  const before=lstatSync(copy.archivePath,{bigint:true}),metadata=lstatSync(copy.receiptPath);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size!==BigInt(receipt.bytes)||!metadata.isFile()||metadata.isSymbolicLink()||metadata.nlink!==1||metadata.size>32768)fail();
  const text=JSON.stringify(receipt);if(readFileSync(receiptPath,"utf8")!==text)fail();
  const id=createId();if(!/^[a-f0-9-]{36}$/.test(id))fail();const folder=path.join(destination,`Murage-backup-${id}`);mkdirSync(folder,{mode:0o700});directory=folder;
  const partial=path.join(directory,"backup.partial"),archivePath=path.join(directory,"backup.age");
  const same=stat=>["dev","ino","size","mode","mtimeNs","ctimeNs","nlink"].every(key=>stat[key]===before[key]);
  input=openSync(source,constants.O_RDONLY|(process.platform==="win32"?0:constants.O_NOFOLLOW));if(!same(fstatSync(input,{bigint:true})))fail();output=openSync(partial,"wx",0o600);
  const hash=createHash("sha256"),buffer=Buffer.alloc(65536);let count=0;
  while(count<receipt.bytes){const n=readSync(input,buffer,0,Math.min(buffer.length,receipt.bytes-count),count);if(!n)fail();hash.update(buffer.subarray(0,n));let written=0;while(written<n){const size=writeSync(output,buffer,written,n-written);if(!size)fail();written+=size;}count+=n;}
  if(!same(fstatSync(input,{bigint:true}))||!same(lstatSync(source,{bigint:true}))||hash.digest("hex")!==receipt.sha256)fail();fsyncSync(output);closeSync(output);output=undefined;
  const currentParent=lstatSync(destination);if(currentParent.dev!==parentStat.dev||currentParent.ino!==parentStat.ino)fail();
  writeFileSync(path.join(directory,"receipt.json"),text,{flag:"wx",mode:0o600,flush:true});
  // A hard link publishes without ever replacing a file. Where the drive
  // has none (exFAT, FAT32: audit W-A3) the finished, flushed copy is renamed
  // into place inside the folder made for it just above.
  try{linkSync(partial,archivePath);unlinkSync(partial);}
  catch(error){if(!NO_HARD_LINKS.has(error?.code))throw error;
   // Reserve the name exclusively, then rename over our own reservation only
   // while it is still ours; never over another writer's file.
   const r=openSync(archivePath,"wx",0o600),mine=fstatSync(r);closeSync(r);
   const ours=()=>{try{const now=lstatSync(archivePath);return now.dev===mine.dev&&now.ino===mine.ino&&now.size===0;}catch{return false;}};
   if(!ours())fail();renameSync(partial,archivePath);}
  published=true;
  return{saved:true,archivePath,directory};
 }catch(error){if(error?.message===SHARED)throw error;return fail();}
 finally{
  if(input!==undefined)closeSync(input);if(output!==undefined)closeSync(output);
  // A failed export leaves nothing behind: only the files it made itself, in
  // the folder it made itself, are removed.
  if(!published&&directory){for(const name of ["backup.partial","receipt.json","backup.age"])try{unlinkSync(path.join(directory,name));}catch{/* not made */}try{rmdirSync(directory);}catch{/* not empty: something else is there, leave it */}}
 }
}
