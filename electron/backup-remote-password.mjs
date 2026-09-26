import {randomBytes,randomUUID} from "node:crypto";
import {constants,openSync,closeSync,lstatSync,fstatSync,readSync,realpathSync,writeFileSync,unlinkSync} from "node:fs";
import path from "node:path";
export const BACKUP_REMOTE_PASSWORDS_KEY="backupRemotePasswordReferences";
const refuse=()=>{throw Error("BACKUP_REMOTE_PASSWORD_UNAVAILABLE");};
const ref=value=>typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value);
const identity=stat=>["dev","ino","size","uid","mode","mtimeNs","ctimeNs"].map(key=>String(stat[key]));
function readFile(file,excludedRoots,uid){
 if(!Number.isSafeInteger(uid)||uid<1||typeof file!=="string"||!path.isAbsolute(file)||/[\x00-\x1f\x7f]/.test(file))refuse();
 const before=lstatSync(file,{bigint:true}),resolved=realpathSync.native(file);
 if(before.isSymbolicLink())refuse();
 for(const directory of excludedRoots){const root=realpathSync.native(directory);if(resolved===root||resolved.startsWith(root+path.sep))refuse();}
 const valid=stat=>stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n&&stat.uid===BigInt(uid)&&!(stat.mode&0o077n)&&stat.size>0n&&stat.size<=4096n;
 if(!valid(before))refuse();const fingerprint=identity(before),same=stat=>valid(stat)&&JSON.stringify(identity(stat))===JSON.stringify(fingerprint);
 const fd=openSync(resolved,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes;
 try{
  if(!same(fstatSync(fd,{bigint:true})))refuse();bytes=Buffer.alloc(Number(before.size));let offset=0;
  while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)refuse();offset+=count;}
  if(!same(fstatSync(fd,{bigint:true}))||!same(lstatSync(resolved,{bigint:true})))refuse();
  let length=bytes.length;if(bytes[length-1]===10){length--;if(bytes[length-1]===13)length--;}
  const password=bytes.subarray(0,length);if(!length||password.includes(0)||password.includes(10)||password.includes(13))refuse();
  return{path:resolved,fingerprint,password:Buffer.from(password)};
 }finally{bytes?.fill(0);closeSync(fd);}
}
export const REMOTE_PASSWORD_FILE_NAME="murage-offsite-password";
/** True when `directory` (resolved) is, or is inside, any existing root. */
function insideAny(resolved,roots){
 for(const root of roots){let real;try{real=realpathSync.native(root);}catch{continue;}if(resolved===real||resolved.startsWith(real+path.sep))return true;}
 return false;
}
/** A new owner-only file in the first usable folder, never replacing one. */
function writeNewFile(folders,excludedRoots,uid,bytes){
 for(const folder of folders){
  try{
   if(typeof folder!=="string"||!path.isAbsolute(folder))continue;
   const real=realpathSync.native(folder),stat=lstatSync(real);
   if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid||insideAny(real,excludedRoots))continue;
   for(let n=1;n<100;n++){
    const file=path.join(real,n===1?`${REMOTE_PASSWORD_FILE_NAME}.txt`:`${REMOTE_PASSWORD_FILE_NAME}-${n}.txt`);
    try{writeFileSync(file,bytes,{flag:"wx",mode:0o600,flush:true});return file;}catch(error){if(error.code!=="EEXIST")throw error;}
   }
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
export function createRemotePasswordStore({chooseFile,excludedRoots,readProtected,updateProtected,uid=process.getuid?.(),createId=randomUUID,createFolders=()=>[],createExcludedRoots=()=>[],chooseCopyFile=null}){
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
    if(!Number.isSafeInteger(uid)||uid<1)refuse();
    bytes=Buffer.from(randomBytes(32).toString("base64url")+"\n");
    const excluded=[...excludedRoots(),...(await createExcludedRoots())];
    file=writeNewFile(createFolders(),excluded,uid,bytes);
    try{selected=readFile(file,excluded,uid);}catch(error){try{unlinkSync(file);}catch{/* reported below */}throw error;}
    return{passwordRef:await register(selected),path:selected.path};
   }catch{return refuse();}finally{bytes?.fill(0);selected?.password.fill(0);}
  },
  /** A second copy where the person chooses, never inside Murage's folders or the backup folder. */
  async saveCopy(passwordRef){
   let selected,bytes;
   try{
    const saved=references(await readProtected());if(!ref(passwordRef)||!Object.hasOwn(saved,passwordRef)||typeof chooseCopyFile!=="function")refuse();
    const record=saved[passwordRef];selected=readFile(record.path,excludedRoots(),uid);if(JSON.stringify(selected.fingerprint)!==JSON.stringify(record.fingerprint))refuse();
    const target=await chooseCopyFile(path.join(path.dirname(record.path),"murage-offsite-password-copy.txt"));if(!target)return{cancelled:true};
    if(typeof target!=="string"||!path.isAbsolute(target)||/[\x00-\x1f\x7f]/.test(target))refuse();
    const folder=realpathSync.native(path.dirname(target));if(insideAny(folder,[...excludedRoots(),...(await createExcludedRoots())]))refuse();
    const destination=path.join(folder,path.basename(target));if(destination===selected.path)refuse();
    bytes=Buffer.concat([selected.password,Buffer.from("\n")]);writeFileSync(destination,bytes,{flag:"wx",mode:0o600,flush:true});
    return{saved:true,path:destination};
   }catch{return refuse();}finally{bytes?.fill(0);selected?.password.fill(0);}
  },
  async select(){
   let selected;
   try{
    const file=await chooseFile();if(!file)return null;
    selected=readFile(file,excludedRoots(),uid);const passwordRef=createId();if(!ref(passwordRef))refuse();
    await updateProtected(current=>{const saved=references(current);if(Object.keys(saved).length>=32||Object.hasOwn(saved,passwordRef))refuse();return{...current,[BACKUP_REMOTE_PASSWORDS_KEY]:JSON.stringify({...saved,[passwordRef]:{path:selected.path,fingerprint:selected.fingerprint}})};});
    return{passwordRef};
   }catch{return refuse();}finally{selected?.password.fill(0);}
  },
  async read(passwordRef){
   let selected;
   try{
    const saved=references(await readProtected());if(!ref(passwordRef)||!Object.hasOwn(saved,passwordRef))refuse();
    const record=saved[passwordRef];selected=readFile(record.path,excludedRoots(),uid);
    if(JSON.stringify(selected.fingerprint)!==JSON.stringify(record.fingerprint))refuse();return Buffer.from(selected.password);
   }catch{return refuse();}finally{selected?.password.fill(0);}
  },
 };
}
