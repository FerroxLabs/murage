import {createHash,randomUUID} from "node:crypto";
import {constants,openSync,closeSync,readSync,writeSync,fsyncSync,lstatSync,fstatSync,readFileSync,realpathSync,mkdirSync,writeFileSync,linkSync,unlinkSync} from "node:fs";
import path from "node:path";
const fail=()=>{throw Error("BACKUP_REMOTE_EXPORT_UNCONFIRMED");};
/** Only main supplies destination/source roots. Partial copies remain unadvertised. */
export function exportRemoteBackup(copy,parent,{sourceRoot,excludedRoots,maxBytes=1024**3,createId=randomUUID}){
 let input,output;
 try{
  const receipt=copy?.receipt;if(copy?.state!=="downloaded-verified"||!/^[a-f0-9]{64}$/.test(copy.snapshotId)||!Number.isSafeInteger(receipt?.bytes)||receipt.bytes<1||receipt.bytes>maxBytes||!/^[a-f0-9]{64}$/.test(receipt.sha256))fail();
  const destination=realpathSync.native(parent),parentStat=lstatSync(parent),uid=process.getuid?.();
  if(!parentStat.isDirectory()||parentStat.isSymbolicLink()||parentStat.uid!==uid||(parentStat.mode&0o022))fail();
  for(const root of excludedRoots){const canonical=realpathSync.native(root);if(destination===canonical||destination.startsWith(canonical+path.sep))fail();}
  const source=realpathSync.native(copy.archivePath),receiptPath=realpathSync.native(copy.receiptPath),allowed=realpathSync.native(sourceRoot);
  if(!source.startsWith(allowed+path.sep)||!receiptPath.startsWith(allowed+path.sep)||path.dirname(source)!==path.dirname(receiptPath)||path.basename(source)!=="backup.age"||path.basename(receiptPath)!=="receipt.json")fail();
  const before=lstatSync(copy.archivePath,{bigint:true}),metadata=lstatSync(copy.receiptPath);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size!==BigInt(receipt.bytes)||!metadata.isFile()||metadata.isSymbolicLink()||metadata.nlink!==1||metadata.size>32768)fail();
  const text=JSON.stringify(receipt);if(readFileSync(receiptPath,"utf8")!==text)fail();
  const id=createId();if(!/^[a-f0-9-]{36}$/.test(id))fail();const directory=path.join(destination,`Murage-backup-${id}`);mkdirSync(directory,{mode:0o700});
  const partial=path.join(directory,"backup.partial"),archivePath=path.join(directory,"backup.age");
  const same=stat=>["dev","ino","size","mode","mtimeNs","ctimeNs","nlink"].every(key=>stat[key]===before[key]);
  input=openSync(source,constants.O_RDONLY|constants.O_NOFOLLOW);if(!same(fstatSync(input,{bigint:true})))fail();output=openSync(partial,"wx",0o600);
  const hash=createHash("sha256"),buffer=Buffer.alloc(65536);let count=0;
  while(count<receipt.bytes){const n=readSync(input,buffer,0,Math.min(buffer.length,receipt.bytes-count),count);if(!n)fail();hash.update(buffer.subarray(0,n));let written=0;while(written<n){const size=writeSync(output,buffer,written,n-written);if(!size)fail();written+=size;}count+=n;}
  if(!same(fstatSync(input,{bigint:true}))||!same(lstatSync(source,{bigint:true}))||hash.digest("hex")!==receipt.sha256)fail();fsyncSync(output);closeSync(output);output=undefined;
  const currentParent=lstatSync(destination);if(currentParent.dev!==parentStat.dev||currentParent.ino!==parentStat.ino)fail();
  writeFileSync(path.join(directory,"receipt.json"),text,{flag:"wx",mode:0o600,flush:true});
  linkSync(partial,archivePath);unlinkSync(partial);
  return{saved:true,archivePath,directory};
 }catch{return fail();}finally{if(input!==undefined)closeSync(input);if(output!==undefined)closeSync(output);}
}
