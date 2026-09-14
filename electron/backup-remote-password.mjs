import {randomUUID} from "node:crypto";
import {constants,openSync,closeSync,lstatSync,fstatSync,readSync,realpathSync} from "node:fs";
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
export function createRemotePasswordStore({chooseFile,excludedRoots,readProtected,updateProtected,uid=process.getuid?.(),createId=randomUUID}){
 return{
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
