import {lstatSync,mkdirSync,realpathSync,rmSync} from "node:fs";
import path from "node:path";
import {restrictToOwner} from "./backup-windows-acl.mjs";
// POSIX: owner uid and 0700 are checked in place on every use. Windows has
// neither, so the "remote" tree is created with an owner-only ACL
// (backup-windows-acl.mjs) that everything below it inherits: the per-run
// SSH key folders and the job journals.
const posix=()=>process.platform!=="win32";
const owned=stat=>!posix()||stat.uid===process.getuid?.();
const privateMode=stat=>!posix()||!(stat.mode&0o077);
function makeDirectory(directory,{restrict=false,platform}={}){
 let created=false;try{mkdirSync(directory,{mode:0o700});created=true;}catch(error){if(error.code!=="EEXIST")throw error;}
 if(created&&restrict&&!posix())(platform?.restrictToOwner??restrictToOwner)(directory,{directory:true});
}
/** Every ancestor below a main-owned private control root is checked in place. */
export function ensureRemoteControlDirectory(control){
 const parent=path.dirname(control),anchor=path.dirname(parent);
 const base=lstatSync(anchor);if(!base.isDirectory()||base.isSymbolicLink()||!owned(base)||(posix()&&(base.mode&0o022))||realpathSync.native(anchor)!==anchor)throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
 for(const directory of [parent,control]){makeDirectory(directory);const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||!owned(stat)||!privateMode(stat)||realpathSync.native(directory)!==directory)throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");}
 return control;
}
export function remoteWorkDirectory(control,remoteRef,revision,platform){
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(remoteRef)||!Number.isSafeInteger(revision)||revision<0)throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
 const inspect=directory=>{const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||!owned(stat)||!privateMode(stat)||realpathSync.native(directory)!==directory)throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");};
 ensureRemoteControlDirectory(control);inspect(control);let directory=control;
 for(const segment of ["remote",remoteRef,String(revision)]){directory=path.join(directory,segment);makeDirectory(directory,{restrict:segment==="remote",platform});inspect(directory);}
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
 if(!stat.isDirectory()||stat.isSymbolicLink()||!owned(stat))throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
 rmSync(directory,{recursive:true,force:true});return true;
}
/** The folder that holds Murage's data folder, when other accounts can change
 * it: off-site keys and journals would sit beside it, so they are refused.
 * Null when it is private (or on Windows, where the tree is ACL-protected). */
export function remoteControlSharedFolder(control){
 if(!posix())return null;
 const anchor=path.dirname(path.dirname(control));
 try{const stat=lstatSync(anchor);return !stat.isDirectory()||stat.isSymbolicLink()||!owned(stat)||(stat.mode&0o022)?anchor:null;}catch{return anchor;}
}
