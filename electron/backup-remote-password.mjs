import {randomBytes,randomUUID} from "node:crypto";
import {constants,openSync,closeSync,lstatSync,fstatSync,readSync,realpathSync,writeFileSync,unlinkSync,mkdirSync,rmdirSync,linkSync} from "node:fs";
import path from "node:path";
import {restrictToOwner,assertPrivateToOwner,volumeKeepsAcls} from "./backup-windows-acl.mjs";
// Windows has no uid or mode bits: its files are made owner-only by ACL instead.
const posix=()=>process.platform!=="win32";
export const BACKUP_REMOTE_PASSWORDS_KEY="backupRemotePasswordReferences";
// The underlying error rides along as `cause` for the redacted log only.
const refuse=(code="BACKUP_REMOTE_PASSWORD_UNAVAILABLE",cause)=>{throw cause===undefined||cause?.message===code?Error(code):Error(code,{cause});};
// Refusals a person can act on keep their own name all the way to the window,
// instead of the bare "could not be confirmed" every one of them used to become.
const NAMED=new Set(["BACKUP_REMOTE_CONTROL_UNAVAILABLE","BACKUP_REMOTE_PASSWORD_FILE_PLACE","BACKUP_REMOTE_PASSWORD_FILE_KIND","BACKUP_REMOTE_PASSWORD_FILE_SHARED","BACKUP_REMOTE_PASSWORD_FILE_SHARED_WINDOWS","BACKUP_REMOTE_PASSWORD_FILE_FORMAT","BACKUP_REMOTE_PASSWORD_FILE_UNREADABLE"]);
const named=error=>error instanceof Error&&NAMED.has(error.message)?error.message:"BACKUP_REMOTE_PASSWORD_UNAVAILABLE";
/** Murage's own private folders, checked first: when they can't be prepared
 * the refusal says so, not that the chosen or created file was wrong. */
const roots=excludedRoots=>{try{return excludedRoots();}catch(error){return refuse("BACKUP_REMOTE_CONTROL_UNAVAILABLE",error);}};
const ref=value=>typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value);
const identity=stat=>["dev","ino","size","uid","mode","mtimeNs","ctimeNs"].map(key=>String(stat[key]));
// Windows has no mode bits: who else may open the file is in its ACL, read
// with the same owner rule the files Murage creates are held to (W-A5). A
// file in C:\Users\Public, a shared folder or one granting Users or Everyone
// is refused by name. A failure to read the ACL refuses too.
const windowsPrivate=(file,checkPrivate)=>{
 if(posix())return;
 try{checkPrivate(file);}catch(error){return refuse(error?.message==="BACKUP_WINDOWS_ACL_SHARED"?"BACKUP_REMOTE_PASSWORD_FILE_SHARED_WINDOWS":"BACKUP_REMOTE_PASSWORD_FILE_UNREADABLE",error);}
};
function readFile(file,excludedRoots,uid,checkPrivate=assertPrivateToOwner){
 if((posix()&&(!Number.isSafeInteger(uid)||uid<1))||typeof file!=="string"||!path.isAbsolute(file)||/[\x00-\x1f\x7f]/.test(file))refuse();
 let before,resolved;try{before=lstatSync(file,{bigint:true});resolved=realpathSync.native(file);}catch{return refuse("BACKUP_REMOTE_PASSWORD_FILE_UNREADABLE");}
 if(before.isSymbolicLink())refuse("BACKUP_REMOTE_PASSWORD_FILE_KIND");
 for(const directory of excludedRoots){const root=realpathSync.native(directory);if(resolved===root||resolved.startsWith(root+path.sep))refuse("BACKUP_REMOTE_PASSWORD_FILE_PLACE");}
 const plain=stat=>stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n&&stat.size>0n&&stat.size<=4096n;
 const own=stat=>!posix()||(stat.uid===BigInt(uid)&&!(stat.mode&0o077n));
 const valid=stat=>plain(stat)&&own(stat);
 if(!plain(before))refuse("BACKUP_REMOTE_PASSWORD_FILE_KIND");if(!own(before))refuse("BACKUP_REMOTE_PASSWORD_FILE_SHARED");windowsPrivate(resolved,checkPrivate);const fingerprint=identity(before),same=stat=>valid(stat)&&JSON.stringify(identity(stat))===JSON.stringify(fingerprint);
 const fd=openSync(resolved,constants.O_RDONLY|(posix()?constants.O_NOFOLLOW:0));let bytes;
 try{
  if(!same(fstatSync(fd,{bigint:true})))refuse();bytes=Buffer.alloc(Number(before.size));let offset=0;
  while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)refuse();offset+=count;}
  if(!same(fstatSync(fd,{bigint:true}))||!same(lstatSync(resolved,{bigint:true})))refuse();
  let length=bytes.length;if(bytes[length-1]===10){length--;if(bytes[length-1]===13)length--;}
  const password=bytes.subarray(0,length);if(!length||password.includes(0)||password.includes(10)||password.includes(13))refuse("BACKUP_REMOTE_PASSWORD_FILE_FORMAT");
  return{path:resolved,fingerprint,password:Buffer.from(password)};
 }finally{bytes?.fill(0);closeSync(fd);}
}
export const REMOTE_PASSWORD_FILE_NAME="murage-offsite-password";
/** True when `directory` (resolved) is, or is inside, any existing root. */
function insideAny(resolved,roots){
 for(const root of roots){let real;try{real=realpathSync.native(root);}catch{continue;}if(resolved===real||resolved.startsWith(real+path.sep))return true;}
 return false;
}
/** Writes `bytes` as a new owner-only file at one of `names` inside `folder`,
 * never replacing a file. Returns the path, or null when every name is taken.
 * POSIX: open(O_CREAT|O_EXCL, 0600) is owner-only from the first byte.
 * Windows: mode means nothing, and the file would first carry the folder's
 * inherited ACL, so a sync client or another account could open it before
 * icacls ran (K-10). Instead a new private folder is made beside the target
 * and restricted to the owner while still empty; the file is created inside
 * it (so it inherits only the owner), written, restricted and verified, then
 * hard linked to its final name (link never replaces an existing file, and
 * keeps the file's own ACL) and the staging name removed. */
function writeOwnerOnly(folder,names,bytes,{restrictFile,restrictDirectory,createId}){
 if(posix()){
  for(const name of names){
   const file=path.join(folder,name);
   try{writeFileSync(file,bytes,{flag:"wx",mode:0o600,flush:true});}catch(error){if(error.code==="EEXIST")continue;throw error;}
   return file;
  }
  return null;
 }
 const stage=path.join(folder,`.murage-offsite-${createId()}`);
 mkdirSync(stage); // never adopts an existing folder
 const staged=path.join(stage,"password");
 try{
  restrictDirectory(stage);
  writeFileSync(staged,bytes,{flag:"wx",flush:true});
  restrictFile(staged);
  for(const name of names){
   const file=path.join(folder,name);
   try{linkSync(staged,file);}catch(error){if(error.code==="EEXIST")continue;throw error;}
   return file;
  }
  return null;
 }finally{
  try{unlinkSync(staged);}catch{/* not written, or already gone */}
  try{rmdirSync(stage);}catch{/* left empty and owner-only; nothing secret inside */}
 }
}
/** A new owner-only file in the first usable folder, never replacing one. */
function writeNewFile(folders,excludedRoots,uid,bytes,options){
 for(const folder of folders){
  try{
   if(typeof folder!=="string"||!path.isAbsolute(folder))continue;
   const real=realpathSync.native(folder),stat=lstatSync(real);
   if(!stat.isDirectory()||stat.isSymbolicLink()||(posix()&&stat.uid!==uid)||insideAny(real,excludedRoots))continue;
   const names=[];for(let n=1;n<100;n++)names.push(n===1?`${REMOTE_PASSWORD_FILE_NAME}.txt`:`${REMOTE_PASSWORD_FILE_NAME}-${n}.txt`);
   const file=writeOwnerOnly(real,names,bytes,options);if(file)return file;
  }catch{/* try the next folder */}
 }
 return refuse();
}
function references(document){
 const raw=document[BACKUP_REMOTE_PASSWORDS_KEY];if(raw===undefined)return{};
 try{
  if(typeof raw!=="string"||Buffer.byteLength(raw)>32768)throw Error();const value=JSON.parse(raw);
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length>32)throw Error();
  for(const[key,item]of Object.entries(value)){if(!ref(key)||!item||Object.keys(item).sort().join()!=="fingerprint,path"||typeof item.path!=="string"||item.path.length>4096||!Array.isArray(item.fingerprint)||item.fingerprint.length!==7||item.fingerprint.some(part=>typeof part!=="string"||part.length>30))throw Error();}
  return value;
 }catch{return refuse();}
}
/** All file selections and encrypted-document callbacks belong to main. */
export function createRemotePasswordStore({chooseFile,excludedRoots,readProtected,updateProtected,uid=process.getuid?.(),createId=randomUUID,createFolders=()=>[],createExcludedRoots=()=>[],chooseCopyFile=null,
 restrict=file=>{if(!posix())restrictToOwner(file);},restrictDirectory=directory=>{if(!posix())restrictToOwner(directory,{directory:true});},checkPrivate=assertPrivateToOwner,stageId=randomUUID,keepsAcls=volumeKeepsAcls}){
 const written={restrictFile:restrict,restrictDirectory,createId:stageId};
 const read=(file,roots)=>readFile(file,roots,uid,checkPrivate);
 async function register(selected){
  const passwordRef=createId();if(!ref(passwordRef))refuse();
  await updateProtected(current=>{const saved=references(current);if(Object.keys(saved).length>=32||Object.hasOwn(saved,passwordRef))refuse();return{...current,[BACKUP_REMOTE_PASSWORDS_KEY]:JSON.stringify({...saved,[passwordRef]:{path:selected.path,fingerprint:selected.fingerprint}})};});
  return passwordRef;
 }
 return{
  /** Murage makes the off-site password: 32 random bytes, written once as an
   * owner-only file outside the data, settings, control and backup folders,
   * read back and registered like a chosen file. Only its path is returned. */
  async create(){
   let selected,bytes,file;
   try{
    if(posix()&&(!Number.isSafeInteger(uid)||uid<1))refuse();
    bytes=Buffer.from(randomBytes(32).toString("base64url")+"\n");
    const excluded=[...roots(excludedRoots),...(await createExcludedRoots())];
    file=writeNewFile(createFolders(),excluded,uid,bytes,written);
    try{selected=read(file,excluded);}catch(error){try{unlinkSync(file);}catch{/* reported below */}throw error;}
    return{passwordRef:await register(selected),path:selected.path};
   }catch(error){return refuse(error instanceof Error&&error.message==="BACKUP_REMOTE_CONTROL_UNAVAILABLE"?error.message:undefined,error);}finally{bytes?.fill(0);selected?.password.fill(0);}
  },
  /** A second copy where the person chooses, never inside Murage's folders or the backup folder. */
  async saveCopy(passwordRef){
   let selected,bytes;
   try{
    const saved=references(await readProtected());if(!ref(passwordRef)||!Object.hasOwn(saved,passwordRef)||typeof chooseCopyFile!=="function")refuse();
    const record=saved[passwordRef];selected=read(record.path,excludedRoots());if(JSON.stringify(selected.fingerprint)!==JSON.stringify(record.fingerprint))refuse();
    const target=await chooseCopyFile(path.join(path.dirname(record.path),"murage-offsite-password-copy.txt"));if(!target)return{cancelled:true};
    if(typeof target!=="string"||!path.isAbsolute(target)||/[\x00-\x1f\x7f]/.test(target))refuse();
    const folder=realpathSync.native(path.dirname(target));if(insideAny(folder,[...excludedRoots(),...(await createExcludedRoots())]))refuse();
    const destination=path.join(folder,path.basename(target));if(destination===selected.path)refuse();
    bytes=Buffer.concat([selected.password,Buffer.from("\n")]);
    // A USB stick (FAT32, exFAT) has no ACLs to set: the copy is written as
    // it would be on Mac or Linux there, never replacing a file. Everywhere
    // else it is born owner-only like the original.
    if(!posix()&&!keepsAcls(folder))writeFileSync(destination,bytes,{flag:"wx",flush:true});
    else{const copied=writeOwnerOnly(folder,[path.basename(target)],bytes,written);if(copied!==destination)refuse();}
    return{saved:true,path:destination};
   }catch{return refuse();}finally{bytes?.fill(0);selected?.password.fill(0);}
  },
  async select(){
   let selected;
   try{
    const excluded=roots(excludedRoots);
    const file=await chooseFile();if(!file)return null;
    selected=read(file,[...excluded,...(await createExcludedRoots())]);const passwordRef=createId();if(!ref(passwordRef))refuse();
    await updateProtected(current=>{const saved=references(current);if(Object.keys(saved).length>=32||Object.hasOwn(saved,passwordRef))refuse();return{...current,[BACKUP_REMOTE_PASSWORDS_KEY]:JSON.stringify({...saved,[passwordRef]:{path:selected.path,fingerprint:selected.fingerprint}})};});
    return{passwordRef};
   }catch(error){return refuse(named(error),error);}finally{selected?.password.fill(0);}
  },
  async read(passwordRef){
   let selected;
   try{
    const saved=references(await readProtected());if(!ref(passwordRef)||!Object.hasOwn(saved,passwordRef))refuse();
    const record=saved[passwordRef];selected=read(record.path,excludedRoots());
    if(JSON.stringify(selected.fingerprint)!==JSON.stringify(record.fingerprint))refuse();return Buffer.from(selected.password);
   }catch{return refuse();}finally{selected?.password.fill(0);}
  },
 };
}
