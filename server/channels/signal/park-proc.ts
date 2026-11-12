import {openSync,readSync,closeSync,fstatSync,constants} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
/** Kernel pseudo-files report size zero; bound allocation and every read. */
export function readProcBytes(path:string,limit:number,deadline:number):Buffer|null {
 const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)),buffer=Buffer.alloc(limit+1);let length=0;
 try{while(length<buffer.length){if(Date.now()>deadline)return null;const n=readSync(fd,buffer,length,buffer.length-length,null);if(!n)break;length+=n;}}
 finally{closeSync(fd);}
 return length>limit?null:buffer.subarray(0,length);
}
export function parseSignalMounts(bytes:Buffer,deadline:number):string[]|null {
 if(bytes.length>1024*1024||bytes.toString('utf8').includes('\ufffd'))return null;
 const mounts:string[]=[];
 for(const line of bytes.toString('utf8').split('\n')){
  if(!line)continue;if(Date.now()>deadline||mounts.length>=65536)return null;
  const fields=line.split(' '),separator=fields.indexOf('-');if(fields.length<10||separator<6||!fields[4]||!line.includes(' - '))return null;
  const mount=fields[4].replace(/\\([0-7]{3})/g,(_match,digits:string)=>String.fromCharCode(parseInt(digits,8)));
  if(!isAbsolute(mount)||mount.includes('\0'))return null;mounts.push(resolve(mount));
 }
 return mounts.length?mounts:null;
}
export function signalMountPoints(deadline:number):string[]|null {
 const bytes=readProcBytes('/proc/self/mountinfo',1024*1024,deadline);return bytes?parseSignalMounts(bytes,deadline):null;
}

/** A PID namespace alone does not prove that argv paths use this filesystem view. */
export function sameInitialProcessRoot():boolean {
 let own:number|undefined,initial:number|undefined;
 try{
  own=openSync('/',constants.O_RDONLY|(constants.O_DIRECTORY??0));
  // Kernel-owned proc magic link: intentionally inspect PID 1's directory fd.
  initial=openSync('/proc/1/root',constants.O_RDONLY|(constants.O_DIRECTORY??0));
  const a=fstatSync(own),b=fstatSync(initial);return a.isDirectory()&&b.isDirectory()&&a.dev===b.dev&&a.ino===b.ino;
 }catch{return false;}finally{if(initial!==undefined)closeSync(initial);if(own!==undefined)closeSync(own);}
}
