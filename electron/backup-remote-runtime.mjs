import {lstatSync,mkdirSync,realpathSync,rmSync} from "node:fs";
import path from "node:path";
/** Every ancestor below a main-owned private control root is checked in place. */
export function ensureRemoteControlDirectory(control){
 const parent=path.dirname(control),anchor=path.dirname(parent),uid=process.getuid?.();
 const base=lstatSync(anchor);if(!base.isDirectory()||base.isSymbolicLink()||base.uid!==uid||(base.mode&0o022)||realpathSync.native(anchor)!==anchor)throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
 for(const directory of [parent,control]){try{mkdirSync(directory,{mode:0o700});}catch(error){if(error.code!=="EEXIST")throw error;}const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o077)||realpathSync.native(directory)!==directory)throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");}
 return control;
}
export function remoteWorkDirectory(control,remoteRef,revision){
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(remoteRef)||!Number.isSafeInteger(revision)||revision<0)throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
 const inspect=directory=>{const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)||realpathSync.native(directory)!==directory)throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");};
 ensureRemoteControlDirectory(control);inspect(control);let directory=control;
 for(const segment of ["remote",remoteRef,String(revision)]){directory=path.join(directory,segment);try{mkdirSync(directory,{mode:0o700});}catch(error){if(error.code!=="EEXIST")throw error;}inspect(directory);}
 return directory;
}
/** Removes one destination's whole private work tree after its settings are
 * gone. The path is built from the checked reference, never from a caller path. */
export function forgetRemoteWorkDirectory(control,remoteRef){
 if(typeof remoteRef!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(remoteRef))throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
 ensureRemoteControlDirectory(control);
 const parent=path.join(control,"remote"),directory=path.join(parent,remoteRef);
 if(path.dirname(directory)!==parent||!directory.startsWith(control+path.sep))throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
 let stat;try{stat=lstatSync(directory);}catch(error){if(error.code==="ENOENT")return false;throw error;}
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.())throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
 rmSync(directory,{recursive:true,force:true});return true;
}
